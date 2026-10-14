from datetime import timedelta

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_authenticated_client
from app.core.config import get_settings
from app.core.exceptions import UpstoxAPIError
from app.core.time_utils import today_ist
from app.db.base import get_db
from app.engine import live_trading
from app.engine.candle import candles_from_upstox
from app.engine.strategy import generate_signal
from app.services.upstox_client import UpstoxClient

# Only /evaluate (which can OPEN a new real position) is gated behind
# LIVE_TRADING_ENABLED. /reconcile, /stop-all, /resume, /positions, /status
# and /preflight are intentionally NEVER gated by that flag: you must always
# be able to check on, reconcile, or flatten real positions/orders — even
# ones opened before you disabled the switch — regardless of its state.
router = APIRouter(prefix="/live", tags=["live-trading"])

_LOOKBACK_DAYS = {"days": 150, "weeks": 700, "months": 2200}


@router.get("/status")
def status(db: Session = Depends(get_db)):
    settings = get_settings()
    account = live_trading.get_or_create_account(db)
    today = live_trading.get_today_risk_state(db)
    return {
        "live_trading_enabled": settings.live_trading_enabled,
        "trading_halted": account.trading_halted,
        "daily_loss_limit_halted": today.loss_limit_halted,
        "realized_pnl_today": today.realized_pnl,
        "open_positions": [live_trading.position_dict(p) for p in live_trading.get_open_positions(db)],
        "order_product": settings.live_order_product,
        "algo_name_configured": bool(settings.upstox_algo_name),
    }


@router.get("/preflight")
async def preflight(client: UpstoxClient = Depends(get_authenticated_client)):
    """Read-only check of the compliance prerequisites for live order
    placement: whether a static IP is registered with Upstox, and whether an
    Algo Name is configured on this deployment. It cannot verify that the
    machine actually making requests matches the registered IP — Upstox
    enforces that itself when an order is placed.
    """
    settings = get_settings()
    try:
        ip_response = await client.get_static_ips()
        ip_data = ip_response.get("data", {})
    except UpstoxAPIError as exc:
        ip_data = {"error": exc.message}

    return {
        "live_trading_enabled": settings.live_trading_enabled,
        "registered_static_ips": ip_data,
        "algo_name_configured": settings.upstox_algo_name,
        "order_rate_guard_seconds": settings.live_duplicate_guard_seconds,
        "note": (
            "Upstox rejects all order placement/cancel/exit-all calls that don't originate "
            "from a registered static IP. Verify registered_static_ips matches the IP this "
            "backend actually makes outbound requests from before relying on this."
        ),
    }


@router.get("/positions")
def positions(db: Session = Depends(get_db)):
    return [live_trading.position_dict(p) for p in live_trading.get_open_positions(db)]


@router.post("/evaluate")
async def evaluate(
    instrument_key: str = Query(...),
    unit: str = Query("days", pattern="^(days|weeks|months)$"),
    interval: int = Query(1, ge=1),
    db: Session = Depends(get_db),
    client: UpstoxClient = Depends(get_authenticated_client),
):
    if not get_settings().live_trading_enabled:
        raise HTTPException(status_code=403, detail="Live trading is disabled (LIVE_TRADING_ENABLED is not set)")

    to_date = today_ist().isoformat()
    from_date = (today_ist() - timedelta(days=_LOOKBACK_DAYS.get(unit, 150))).isoformat()

    try:
        candle_response = await client.get_historical_candles(instrument_key, unit, interval, to_date, from_date)
        ltp_response = await client.get_ltp([instrument_key])
    except UpstoxAPIError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    raw_candles = candle_response.get("data", {}).get("candles", [])
    if not raw_candles:
        raise HTTPException(status_code=502, detail="Upstox returned no candle data for this instrument/range")

    current_price = _extract_ltp(ltp_response, instrument_key)
    if current_price is None:
        raise HTTPException(status_code=502, detail="Could not determine current price from Upstox LTP response")

    candles = candles_from_upstox(raw_candles)
    sig = generate_signal(candles, instrument_key)

    result = await live_trading.evaluate_and_execute_signal(db, client, sig, current_price)
    return {"signal_action": sig.action, **result}


@router.post("/reconcile")
async def reconcile(
    instrument_key: str | None = Query(None),
    db: Session = Depends(get_db),
    client: UpstoxClient = Depends(get_authenticated_client),
):
    if instrument_key:
        return {"results": await live_trading.reconcile_instrument(db, client, instrument_key)}
    return {"results": await live_trading.reconcile_all(db, client)}


@router.post("/stop-all")
async def stop_all(
    confirm: str = Body(..., embed=True),
    db: Session = Depends(get_db),
    client: UpstoxClient = Depends(get_authenticated_client),
):
    expected = get_settings().live_stop_all_confirmation_phrase
    if confirm != expected:
        raise HTTPException(status_code=400, detail=f'Send {{"confirm": "{expected}"}} exactly to execute this.')
    return await live_trading.emergency_stop_all(db, client)


@router.post("/resume")
def resume(db: Session = Depends(get_db)):
    live_trading.resume_trading(db)
    return {"trading_halted": False}


def _extract_ltp(response: dict, instrument_key: str) -> float | None:
    data = response.get("data", {})
    for key, value in data.items():
        if isinstance(value, dict):
            last_price = value.get("last_price") or value.get("ltp")
            token = value.get("instrument_token") or value.get("instrument_key") or key
            if last_price is not None and (token == instrument_key or key == instrument_key):
                return float(last_price)
    return None

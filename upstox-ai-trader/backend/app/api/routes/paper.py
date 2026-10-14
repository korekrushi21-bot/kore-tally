from datetime import timedelta

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_authenticated_client, get_optional_upstox_client
from app.core.exceptions import UpstoxAPIError
from app.core.time_utils import today_ist
from app.db.base import get_db
from app.engine import paper_trading
from app.engine.candle import candles_from_upstox
from app.engine.strategy import generate_signal
from app.services.upstox_client import UpstoxClient

router = APIRouter(prefix="/paper", tags=["paper-trading"])

_LOOKBACK_DAYS = {"days": 150, "weeks": 700, "months": 2200}


@router.get("/account")
async def account(
    db: Session = Depends(get_db), client: UpstoxClient | None = Depends(get_optional_upstox_client)
):
    open_positions = paper_trading.get_open_positions(db)
    mark_prices: dict[str, float] = {}

    if client and open_positions:
        instrument_keys = sorted({p.instrument_key for p in open_positions})
        try:
            response = await client.get_ltp(instrument_keys)
            mark_prices = _parse_ltp_response(response)
        except UpstoxAPIError:
            pass  # fall back to entry-price marking below; this endpoint must not hard-fail

    return paper_trading.get_account_snapshot(db, mark_prices)


@router.get("/positions")
def positions(db: Session = Depends(get_db)):
    return [paper_trading.position_dict(p) for p in paper_trading.get_open_positions(db)]


@router.get("/trades")
def trades(limit: int = Query(50, ge=1, le=500), db: Session = Depends(get_db)):
    return [paper_trading.position_dict(p) for p in paper_trading.get_closed_positions(db, limit=limit)]


@router.post("/evaluate")
async def evaluate(
    instrument_key: str = Query(...),
    unit: str = Query("days", pattern="^(days|weeks|months)$"),
    interval: int = Query(1, ge=1),
    db: Session = Depends(get_db),
    client: UpstoxClient = Depends(get_authenticated_client),
):
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

    current_price = _parse_ltp_response(ltp_response).get(instrument_key)
    if current_price is None:
        raise HTTPException(status_code=502, detail="Could not determine current price from Upstox LTP response")

    exits = paper_trading.check_exits(db, instrument_key, current_price)

    candles = candles_from_upstox(raw_candles)
    sig = generate_signal(candles, instrument_key)
    entry_result = paper_trading.evaluate_and_execute_signal(db, sig, current_price)

    return {"exits": exits, "signal_action": sig.action, "entry_result": entry_result}


@router.post("/positions/{position_id}/close")
def close_position(position_id: int, price: float = Body(..., embed=True), db: Session = Depends(get_db)):
    try:
        return paper_trading.close_position_manual(db, position_id, price)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/stop-all")
def stop_all(prices: dict[str, float] = Body(default={}), db: Session = Depends(get_db)):
    closed = paper_trading.emergency_stop_all(db, prices)
    return {"positions_closed": closed}


@router.post("/resume")
def resume(db: Session = Depends(get_db)):
    paper_trading.resume_trading(db)
    return {"trading_halted": False}


def _parse_ltp_response(response: dict) -> dict[str, float]:
    """Upstox's documented LTP response shape has drifted between v3 doc
    revisions (community reports disagree on the exact field names), so this
    defensively looks for `last_price` under a few plausible key spots
    instead of assuming one fixed schema.
    """
    data = response.get("data", {})
    prices: dict[str, float] = {}
    for key, value in data.items():
        if isinstance(value, dict):
            last_price = value.get("last_price") or value.get("ltp")
            instrument_key = value.get("instrument_token") or value.get("instrument_key") or key
            if last_price is not None:
                prices[instrument_key] = float(last_price)
    return prices

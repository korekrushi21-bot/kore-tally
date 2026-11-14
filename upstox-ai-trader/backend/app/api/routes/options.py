"""Options (F&O) endpoints: contract lookup, signal preview, paper trading and
backtesting. Paper/backtest only — there is deliberately no live option order
placement. See app/engine/options.py for how underlying signals map to options.
"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_authenticated_client
from app.api.routes.paper import _parse_ltp_response
from app.core.config import get_settings
from app.core.exceptions import UpstoxAPIError
from app.core.time_utils import today_ist
from app.db.base import get_db
from app.engine import options, paper_trading
from app.engine.candle import candles_from_upstox
from app.engine.option_backtest import run_option_backtest
from app.engine.risk import AccountSnapshot, RiskManager
from app.engine.strategy import generate_signal
from app.services.upstox_client import UpstoxClient

router = APIRouter(prefix="/options", tags=["options"])

_SIGNAL_LOOKBACK_DAYS = {"days": 150, "weeks": 700, "months": 2200}
# Calendar days of underlying history fetched BEFORE from_date in an options
# backtest, so the strategy has its 60-bar warm-up before the first tradable bar.
_BACKTEST_WARMUP_DAYS = {"days": 150, "hours": 45, "minutes": 10}


@router.get("/contracts")
async def contracts(
    underlying_key: str = Query(..., description='Underlying, e.g. "NSE_EQ|INE020B01018" or "NSE_INDEX|Nifty 50"'),
    expiry_date: date | None = Query(None),
    client: UpstoxClient = Depends(get_authenticated_client),
):
    parsed = await _fetch_contracts(client, underlying_key, expiry_date)
    expiries = sorted({c.expiry for c in parsed})
    return {
        "underlying_key": underlying_key,
        "expiries": [e.isoformat() for e in expiries],
        "contracts": [paper_trading.option_contract_dict(c) for c in sorted(parsed, key=lambda c: (c.expiry, c.strike, c.option_type))],
    }


@router.get("/signal")
async def signal_preview(
    underlying_key: str = Query(...),
    unit: str = Query("days", pattern="^(days|weeks|months)$"),
    interval: int = Query(1, ge=1),
    strike_offset: int = Query(0, ge=-10, le=10, description="0 = ATM, +n = n strikes OTM, -n = n strikes ITM"),
    expiry_date: date | None = Query(None, description="Default: nearest expiry with enough days left"),
    db: Session = Depends(get_db),
    client: UpstoxClient = Depends(get_authenticated_client),
):
    """Read-only: what option trade the current underlying signal would
    produce, and how the risk engine would size it. Places nothing.
    """
    ctx = await _build_trade_context(client, underlying_key, unit, interval, strike_offset, expiry_date)
    if ctx["contract"] is None:
        return _no_contract_response(ctx)

    sig, contract, premium, spot = ctx["signal"], ctx["contract"], ctx["premium"], ctx["spot"]
    settings = get_settings()
    delta = options.estimate_delta(
        premium, spot, contract.strike, contract.expiry, today_ist(), contract.option_type, settings.option_risk_free_rate
    )
    account = paper_trading.get_or_create_account(db)
    today = paper_trading.get_today_risk_state(db)
    open_positions = paper_trading.get_open_positions(db)
    decision = RiskManager().evaluate_option(
        sig,
        AccountSnapshot(
            capital=account.starting_capital,
            open_positions_count=len(open_positions),
            has_open_position_in_instrument=bool(paper_trading.open_option_keys(db, underlying_key)),
            daily_realized_pnl=today.realized_pnl,
            trading_halted=account.trading_halted,
            daily_loss_limit_halted=today.loss_limit_halted,
        ),
        premium,
        delta,
        contract.lot_size,
    )
    premium_stop = premium_target = None
    if delta:
        premium_stop, premium_target = options.premium_levels(premium, delta, sig.entry_price, sig.stop_loss, sig.target)

    return {
        "signal": paper_trading.signal_dict(sig),
        "spot": spot,
        "contract": paper_trading.option_contract_dict(contract),
        "days_to_expiry": (contract.expiry - today_ist()).days,
        "premium": premium,
        "delta": round(delta, 3) if delta is not None else None,
        "estimated_premium_stop": premium_stop,
        "estimated_premium_target": premium_target,
        "breakeven_at_expiry": round(
            contract.strike + premium if contract.option_type == "CE" else contract.strike - premium, 2
        ),
        "risk": {
            "approved": decision.approved,
            "lots": decision.lots,
            "quantity": decision.quantity,
            "max_loss_amount": decision.max_loss_amount,
            "premium_outlay": round(decision.quantity * premium, 2),
            "reasons": decision.reasons,
        },
    }


@router.post("/paper/evaluate")
async def paper_evaluate(
    underlying_key: str = Query(...),
    unit: str = Query("days", pattern="^(days|weeks|months)$"),
    interval: int = Query(1, ge=1),
    strike_offset: int = Query(0, ge=-10, le=10),
    expiry_date: date | None = Query(None),
    db: Session = Depends(get_db),
    client: UpstoxClient = Depends(get_authenticated_client),
):
    """Checks exits on open option paper positions for this underlying, then
    opens a new one if the signal and risk engine allow it. Paper only.
    """
    held_keys = paper_trading.open_option_keys(db, underlying_key)
    exits: list[dict] = []
    if held_keys:
        try:
            ltp = _parse_ltp_response(await client.get_ltp([underlying_key, *held_keys]))
        except UpstoxAPIError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
        spot_now = ltp.get(underlying_key)
        if spot_now is not None:
            exits = paper_trading.check_option_exits(db, underlying_key, spot_now, ltp)

    try:
        ctx = await _build_trade_context(client, underlying_key, unit, interval, strike_offset, expiry_date)
    except HTTPException as exc:
        if not exits:
            raise
        # Exits above are already committed — never hide them behind a failed entry lookup.
        return {"exits": exits, "signal_action": None, "entry_result": {"action": "error", "reasons": [exc.detail]}}
    if ctx["contract"] is None:
        return {"exits": exits, **_no_contract_response(ctx)}

    entry = paper_trading.evaluate_and_execute_option_signal(
        db, ctx["signal"], ctx["contract"], ctx["premium"], spot=ctx["spot"]
    )
    return {"exits": exits, "signal_action": ctx["signal"].action, "entry_result": entry}


@router.get("/backtest")
async def backtest(
    underlying_key: str = Query(...),
    expiry_date: date = Query(..., description="Expiry of a currently-listed contract"),
    strike: float = Query(..., gt=0),
    from_date: date = Query(...),
    to_date: date = Query(...),
    unit: str = Query("days", pattern="^(days|hours|minutes)$"),
    interval: int = Query(1, ge=1),
    train_end_date: date | None = Query(None),
    starting_capital: float | None = Query(None, gt=0),
    client: UpstoxClient = Depends(get_authenticated_client),
):
    if from_date >= to_date:
        raise HTTPException(status_code=400, detail="from_date must be before to_date")
    if train_end_date and not (from_date <= train_end_date < to_date):
        raise HTTPException(status_code=400, detail="train_end_date must fall strictly within [from_date, to_date)")

    listed = await _fetch_contracts(client, underlying_key, expiry_date)
    call = next((c for c in listed if c.option_type == "CE" and c.strike == strike and c.expiry == expiry_date), None)
    put = next((c for c in listed if c.option_type == "PE" and c.strike == strike and c.expiry == expiry_date), None)
    if call is None or put is None:
        raise HTTPException(
            status_code=404,
            detail=f"No listed CE+PE pair at strike {strike:g} for expiry {expiry_date.isoformat()} "
            "(only currently-listed contracts can be backtested)",
        )

    warmup_from = from_date - timedelta(days=_BACKTEST_WARMUP_DAYS[unit])
    underlying = await _candles(client, underlying_key, unit, interval, to_date, warmup_from)
    call_candles = await _candles(client, call.instrument_key, unit, interval, to_date, from_date, allow_empty=True)
    put_candles = await _candles(client, put.instrument_key, unit, interval, to_date, from_date, allow_empty=True)
    if len(underlying) < 61:
        raise HTTPException(status_code=400, detail=f"Only {len(underlying)} underlying candles; need at least 61")
    if not call_candles and not put_candles:
        raise HTTPException(status_code=502, detail="Upstox returned no candles for either option in this range")

    settings = get_settings()
    capital = starting_capital or settings.paper_trading_starting_capital
    result = run_option_backtest(
        underlying, call, call_candles, put, put_candles, capital,
        rate=settings.option_risk_free_rate,
        min_days_to_expiry=settings.option_min_days_to_expiry,
        train_end_date=train_end_date,
        trade_from=from_date,
    )
    return {
        "underlying_key": underlying_key,
        "call": paper_trading.option_contract_dict(call),
        "put": paper_trading.option_contract_dict(put),
        "candles_used": {"underlying": len(underlying), "call": len(call_candles), "put": len(put_candles)},
        "starting_capital": result.starting_capital,
        "ending_capital": result.ending_capital,
        "rejected_signal_count": result.rejected_signal_count,
        "metrics": result.metrics,
        "trades": [
            {
                "contract": t.instrument_key,
                "side": t.side,
                "entry_date": t.entry_date,
                "entry_price": t.entry_price,
                "exit_date": t.exit_date,
                "exit_price": t.exit_price,
                "exit_reason": t.exit_reason,
                "quantity": t.quantity,
                "planned_risk_reward": t.planned_risk_reward,
                "costs": t.costs,
                "realized_pnl": t.realized_pnl,
                "period": t.period,
            }
            for t in result.trades
        ],
        "equity_curve": [{"date": d, "equity": e} for d, e in result.equity_curve],
    }


# --- helpers -------------------------------------------------------------------

async def _fetch_contracts(client: UpstoxClient, underlying_key: str, expiry_date: date | None) -> list[options.OptionContract]:
    try:
        response = await client.get_option_contracts(underlying_key, expiry_date.isoformat() if expiry_date else None)
    except UpstoxAPIError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    parsed = options.parse_contracts(response)
    if not parsed:
        raise HTTPException(status_code=404, detail="Upstox returned no option contracts for this underlying/expiry")
    return parsed


async def _candles(client, instrument_key, unit, interval, to_date: date, from_date: date, allow_empty=False):
    try:
        response = await client.get_historical_candles(instrument_key, unit, interval, to_date.isoformat(), from_date.isoformat())
    except UpstoxAPIError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    raw = response.get("data", {}).get("candles", [])
    if not raw and not allow_empty:
        raise HTTPException(status_code=502, detail=f"Upstox returned no candle data for {instrument_key}")
    return candles_from_upstox(raw)


async def _build_trade_context(client, underlying_key, unit, interval, strike_offset, expiry_date) -> dict:
    today = today_ist()
    candles = await _candles(
        client, underlying_key, unit, interval, today, today - timedelta(days=_SIGNAL_LOOKBACK_DAYS[unit])
    )
    sig = generate_signal(candles, underlying_key)
    option_type = options.option_type_for_signal(sig.action)
    ctx = {"signal": sig, "contract": None, "premium": None, "spot": None, "reason": None}
    if option_type is None:
        ctx["reason"] = "Underlying signal is NO_TRADE, so there is no option to pick"
        return ctx

    try:
        spot = _parse_ltp_response(await client.get_ltp([underlying_key])).get(underlying_key)
    except UpstoxAPIError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    spot = spot or sig.entry_price
    ctx["spot"] = spot

    listed = await _fetch_contracts(client, underlying_key, expiry_date)
    contract, reason = options.select_contract(
        listed, option_type, spot, today, get_settings().option_min_days_to_expiry, strike_offset, expiry_date
    )
    if contract is None:
        ctx["reason"] = reason
        return ctx

    try:
        premium = _parse_ltp_response(await client.get_ltp([contract.instrument_key])).get(contract.instrument_key)
    except UpstoxAPIError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    if premium is None:
        raise HTTPException(status_code=502, detail=f"Could not get a premium for {contract.trading_symbol or contract.instrument_key}")

    ctx.update(contract=contract, premium=premium)
    return ctx


def _no_contract_response(ctx: dict) -> dict:
    return {
        "signal": paper_trading.signal_dict(ctx["signal"]),
        "signal_action": ctx["signal"].action,
        "contract": None,
        "entry_result": {"action": "no_trade", "reasons": [ctx["reason"]]},
    }

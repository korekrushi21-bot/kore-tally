from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import get_authenticated_client
from app.core.config import get_settings
from app.core.exceptions import UpstoxAPIError
from app.engine.backtest import run_backtest
from app.engine.candle import candles_from_upstox
from app.services.upstox_client import UpstoxClient

router = APIRouter(prefix="/backtest", tags=["backtest"])


@router.get("/run")
async def run(
    instrument_key: str = Query(..., description='e.g. "NSE_EQ|INE002A01018"'),
    from_date: date = Query(..., description="Start of the historical range to fetch (YYYY-MM-DD)"),
    to_date: date = Query(..., description="End of the historical range to fetch (YYYY-MM-DD)"),
    unit: str = Query("days", pattern="^(days|weeks|months)$"),
    interval: int = Query(1, ge=1),
    train_end_date: date | None = Query(
        None, description="Optional cutoff: trades up to this date are tagged 'train', after it 'test'"
    ),
    starting_capital: float | None = Query(None, gt=0),
    client: UpstoxClient = Depends(get_authenticated_client),
):
    if from_date >= to_date:
        raise HTTPException(status_code=400, detail="from_date must be before to_date")
    if train_end_date and not (from_date <= train_end_date < to_date):
        raise HTTPException(status_code=400, detail="train_end_date must fall strictly within [from_date, to_date)")

    try:
        response = await client.get_historical_candles(
            instrument_key, unit, interval, to_date.isoformat(), from_date.isoformat()
        )
    except UpstoxAPIError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    raw_candles = response.get("data", {}).get("candles", [])
    if not raw_candles:
        raise HTTPException(status_code=502, detail="Upstox returned no candle data for this instrument/range")

    candles = candles_from_upstox(raw_candles)
    if len(candles) < 61:
        raise HTTPException(
            status_code=400,
            detail=f"Only {len(candles)} candles in range; need at least 61 to run a backtest "
            "(60 for warm-up + 1 to act on). Widen from_date/to_date.",
        )

    capital = starting_capital or get_settings().paper_trading_starting_capital
    result = run_backtest(candles, instrument_key, capital, train_end_date=train_end_date)

    return {
        "instrument_key": result.instrument_key,
        "candles_used": len(candles),
        "starting_capital": result.starting_capital,
        "ending_capital": result.ending_capital,
        "rejected_signal_count": result.rejected_signal_count,
        "metrics": result.metrics,
        "trades": [
            {
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
        "equity_curve": [{"date": point_date, "equity": point_equity} for point_date, point_equity in result.equity_curve],
    }

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import get_authenticated_client
from app.core.exceptions import UpstoxAPIError
from app.core.time_utils import today_ist
from app.engine.candle import candles_from_upstox
from app.engine.strategy import generate_signal
from app.services.upstox_client import UpstoxClient

router = APIRouter(prefix="/strategy", tags=["strategy"])

# How many calendar days of history to request per candle unit, to comfortably
# clear MIN_CANDLES (60) worth of actual trading bars.
_LOOKBACK_DAYS = {"days": 150, "weeks": 700, "months": 2200}


@router.get("/signal")
async def signal(
    instrument_key: str = Query(..., description='e.g. "NSE_EQ|INE002A01018"'),
    unit: str = Query("days", pattern="^(days|weeks|months)$"),
    interval: int = Query(1, ge=1),
    client: UpstoxClient = Depends(get_authenticated_client),
):
    to_date = today_ist().isoformat()
    from_date = (today_ist() - timedelta(days=_LOOKBACK_DAYS.get(unit, 150))).isoformat()

    try:
        response = await client.get_historical_candles(instrument_key, unit, interval, to_date, from_date)
    except UpstoxAPIError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    raw_candles = response.get("data", {}).get("candles", [])
    if not raw_candles:
        raise HTTPException(status_code=502, detail="Upstox returned no candle data for this instrument/range")

    candles = candles_from_upstox(raw_candles)
    result = generate_signal(candles, instrument_key)

    return {
        "instrument_key": result.instrument_key,
        "action": result.action,
        "entry_price": result.entry_price,
        "stop_loss": result.stop_loss,
        "target": result.target,
        "risk_reward": result.risk_reward,
        "strength": result.strength,
        "reasons": result.reasons,
        "invalidation": result.invalidation,
        "data_timestamp": result.data_timestamp,
        "is_stale": result.is_stale,
        "generated_at": result.generated_at,
        "candles_used": len(candles),
    }

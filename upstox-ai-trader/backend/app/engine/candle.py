from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Candle:
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float


def candles_from_upstox(raw_candles: list[list]) -> list[Candle]:
    """Upstox candle rows are [timestamp, open, high, low, close, volume, open_interest],
    newest first. Returns oldest-first, which every indicator in this package assumes.
    """
    parsed = [
        Candle(
            timestamp=datetime.fromisoformat(row[0]),
            open=float(row[1]),
            high=float(row[2]),
            low=float(row[3]),
            close=float(row[4]),
            volume=float(row[5]),
        )
        for row in raw_candles
    ]
    parsed.sort(key=lambda c: c.timestamp)
    return parsed

"""Pure-Python technical indicators. No pandas/numpy dependency on purpose —
keeps the dependency set small and every function trivially unit-testable.

Every series function returns a list the same length as its input, with
`None` for indices that don't yet have enough history ("warm-up" period).
"""
from app.engine.candle import Candle


def sma(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    for i in range(period - 1, len(values)):
        out[i] = sum(values[i - period + 1 : i + 1]) / period
    return out


def ema(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) < period:
        return out
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    multiplier = 2 / (period + 1)
    prev = seed
    for i in range(period, len(values)):
        prev = (values[i] - prev) * multiplier + prev
        out[i] = prev
    return out


def rsi(closes: list[float], period: int = 14) -> list[float | None]:
    """Wilder's RSI."""
    out: list[float | None] = [None] * len(closes)
    if len(closes) <= period:
        return out

    gains = [max(closes[i] - closes[i - 1], 0.0) for i in range(1, len(closes))]
    losses = [max(closes[i - 1] - closes[i], 0.0) for i in range(1, len(closes))]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    out[period] = _rsi_from_averages(avg_gain, avg_loss)

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        out[i + 1] = _rsi_from_averages(avg_gain, avg_loss)
    return out


def _rsi_from_averages(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def macd(
    closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[list[float | None], list[float | None], list[float | None]]:
    ema_fast = ema(closes, fast)
    ema_slow = ema(closes, slow)
    macd_line: list[float | None] = [
        (f - s) if f is not None and s is not None else None for f, s in zip(ema_fast, ema_slow)
    ]

    # EMA of the MACD line, computed only over its non-None tail.
    first_valid = next((i for i, v in enumerate(macd_line) if v is not None), None)
    signal_line: list[float | None] = [None] * len(closes)
    histogram: list[float | None] = [None] * len(closes)
    if first_valid is not None:
        tail = [v for v in macd_line[first_valid:]]  # type: ignore[misc]
        signal_tail = ema(tail, signal)  # type: ignore[arg-type]
        for offset, value in enumerate(signal_tail):
            idx = first_valid + offset
            signal_line[idx] = value
            if value is not None:
                histogram[idx] = macd_line[idx] - value  # type: ignore[operator]
    return macd_line, signal_line, histogram


def vwap(candles: list[Candle]) -> list[float | None]:
    """Cumulative VWAP over the given series (intended for an intraday series;
    for multi-day series it's a running VWAP since the first candle, not a
    per-day reset — note this when interpreting daily-candle results).
    """
    out: list[float | None] = []
    cum_pv = 0.0
    cum_vol = 0.0
    for c in candles:
        typical_price = (c.high + c.low + c.close) / 3
        cum_pv += typical_price * c.volume
        cum_vol += c.volume
        out.append(cum_pv / cum_vol if cum_vol > 0 else None)
    return out


def atr(candles: list[Candle], period: int = 14) -> list[float | None]:
    if len(candles) < 2:
        return [None] * len(candles)

    true_ranges: list[float] = [candles[0].high - candles[0].low]
    for i in range(1, len(candles)):
        c, prev = candles[i], candles[i - 1]
        true_ranges.append(max(c.high - c.low, abs(c.high - prev.close), abs(c.low - prev.close)))

    out: list[float | None] = [None] * len(candles)
    if len(true_ranges) < period:
        return out

    avg = sum(true_ranges[:period]) / period
    out[period - 1] = avg
    for i in range(period, len(true_ranges)):
        avg = (avg * (period - 1) + true_ranges[i]) / period
        out[i] = avg
    return out


def rolling_support_resistance(candles: list[Candle], lookback: int = 20) -> tuple[float | None, float | None]:
    """Support/resistance for the MOST RECENT bar, based on the `lookback`
    bars strictly before it (never includes the current bar — avoids
    look-ahead bias when this is reused by the backtester later).
    """
    if len(candles) <= lookback:
        return None, None
    window = candles[-lookback - 1 : -1]
    return min(c.low for c in window), max(c.high for c in window)


def detect_trend(ema_fast: float | None, ema_mid: float | None, ema_slow: float | None) -> str:
    if ema_fast is None or ema_mid is None or ema_slow is None:
        return "unknown"
    if ema_fast > ema_mid > ema_slow:
        return "uptrend"
    if ema_fast < ema_mid < ema_slow:
        return "downtrend"
    return "sideways"


def detect_breakout(
    candles: list[Candle], lookback: int = 20, volume_multiplier: float = 1.5
) -> tuple[bool, bool]:
    """Returns (breakout, breakdown) for the most recent bar: price closing
    beyond the prior `lookback`-bar range, confirmed by volume.
    """
    if len(candles) <= lookback:
        return False, False
    window = candles[-lookback - 1 : -1]
    resistance = max(c.high for c in window)
    support = min(c.low for c in window)
    avg_volume = sum(c.volume for c in window) / len(window)

    last = candles[-1]
    volume_confirmed = avg_volume > 0 and last.volume >= avg_volume * volume_multiplier
    breakout = last.close > resistance and volume_confirmed
    breakdown = last.close < support and volume_confirmed
    return breakout, breakdown


def volatility_regime(atr_series: list[float | None], lookback: int = 50) -> str:
    """Classifies the latest ATR relative to its own recent history."""
    history = [v for v in atr_series[-lookback:] if v is not None]
    if len(history) < 5 or atr_series[-1] is None:
        return "unknown"
    latest = atr_series[-1]
    avg = sum(history) / len(history)
    if avg == 0:
        return "unknown"
    ratio = latest / avg
    if ratio >= 1.3:
        return "high"
    if ratio <= 0.7:
        return "low"
    return "normal"

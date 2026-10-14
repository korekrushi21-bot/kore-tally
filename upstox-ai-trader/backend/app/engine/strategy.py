from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from app.engine import indicators
from app.engine.candle import Candle

MIN_CANDLES = 60
_STALE_AFTER = timedelta(days=5)  # loose bound to tolerate weekends/holidays on daily candles


@dataclass
class Signal:
    instrument_key: str
    action: str  # "BUY" | "SELL" | "NO_TRADE"
    entry_price: float | None = None
    stop_loss: float | None = None
    target: float | None = None
    risk_reward: float | None = None
    strength: float = 0.0  # 0-100
    reasons: list[str] = field(default_factory=list)
    invalidation: list[str] = field(default_factory=list)
    data_timestamp: datetime | None = None
    is_stale: bool = False
    generated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


def generate_signal(candles: list[Candle], instrument_key: str) -> Signal:
    if len(candles) < MIN_CANDLES:
        return Signal(
            instrument_key=instrument_key,
            action="NO_TRADE",
            reasons=[f"Only {len(candles)} candles available; need at least {MIN_CANDLES} for reliable signals"],
        )

    last = candles[-1]
    is_stale = _is_stale(last.timestamp)

    closes = [c.close for c in candles]
    ema9 = indicators.ema(closes, 9)
    ema21 = indicators.ema(closes, 21)
    ema50 = indicators.ema(closes, 50)
    rsi14 = indicators.rsi(closes, 14)
    macd_line, macd_signal, macd_hist = indicators.macd(closes)
    atr14 = indicators.atr(candles, 14)
    vwap_series = indicators.vwap(candles)
    support, resistance = indicators.rolling_support_resistance(candles, 20)
    breakout, breakdown = indicators.detect_breakout(candles, 20)
    trend = indicators.detect_trend(ema9[-1], ema21[-1], ema50[-1])
    regime = indicators.volatility_regime(atr14, 50)

    bullish_reasons: list[str] = []
    bearish_reasons: list[str] = []
    score = 0

    if trend == "uptrend":
        score += 1
        bullish_reasons.append(f"EMA9 ({ema9[-1]:.2f}) > EMA21 ({ema21[-1]:.2f}) > EMA50 ({ema50[-1]:.2f}): bullish trend alignment")
    elif trend == "downtrend":
        score -= 1
        bearish_reasons.append(f"EMA9 ({ema9[-1]:.2f}) < EMA21 ({ema21[-1]:.2f}) < EMA50 ({ema50[-1]:.2f}): bearish trend alignment")

    r = rsi14[-1]
    r_prev = rsi14[-2] if len(rsi14) > 1 else None
    if r is not None and r_prev is not None:
        if r > 55 and r > r_prev and r < 80:
            score += 1
            bullish_reasons.append(f"RSI {r:.1f} rising, bullish momentum without being overbought")
        elif r < 45 and r < r_prev and r > 20:
            score -= 1
            bearish_reasons.append(f"RSI {r:.1f} falling, bearish momentum without being oversold")
        elif r >= 80:
            bearish_reasons.append(f"RSI {r:.1f} overbought — upside momentum may be exhausted")
        elif r <= 20:
            bullish_reasons.append(f"RSI {r:.1f} oversold — downside momentum may be exhausted")

    m, ms, mh = macd_line[-1], macd_signal[-1], macd_hist[-1]
    mh_prev = macd_hist[-2] if len(macd_hist) > 1 else None
    if m is not None and ms is not None and mh is not None:
        if m > ms and (mh_prev is None or mh > mh_prev):
            score += 1
            bullish_reasons.append("MACD line above signal line with expanding histogram: bullish momentum confirmed")
        elif m < ms and (mh_prev is None or mh < mh_prev):
            score -= 1
            bearish_reasons.append("MACD line below signal line with expanding negative histogram: bearish momentum confirmed")

    vw = vwap_series[-1]
    if vw is not None:
        if last.close > vw:
            score += 1
            bullish_reasons.append(f"Price {last.close:.2f} trading above VWAP {vw:.2f}: buyers in control")
        else:
            score -= 1
            bearish_reasons.append(f"Price {last.close:.2f} trading below VWAP {vw:.2f}: sellers in control")

    if breakout:
        score += 1
        bullish_reasons.append(f"Breakout above {resistance:.2f} (20-bar resistance) confirmed by volume")
    elif breakdown:
        score -= 1
        bearish_reasons.append(f"Breakdown below {support:.2f} (20-bar support) confirmed by volume")

    threshold = 3
    action = "NO_TRADE"
    if score >= threshold:
        action = "BUY"
    elif score <= -threshold:
        action = "SELL"

    strength = min(100.0, abs(score) / 6 * 100)

    if action == "NO_TRADE" or atr14[-1] is None:
        return Signal(
            instrument_key=instrument_key,
            action="NO_TRADE",
            strength=strength,
            reasons=bullish_reasons + bearish_reasons or ["No strategy had enough conviction either way"],
            data_timestamp=last.timestamp,
            is_stale=is_stale,
        )

    entry = last.close
    atr_value = atr14[-1]

    if action == "BUY":
        structural_stop = support if support is not None else entry - 1.5 * atr_value
        atr_stop = entry - 1.5 * atr_value
        stop_loss = max(structural_stop, atr_stop) if structural_stop < entry else atr_stop
        risk_per_unit = entry - stop_loss
        target = entry + 2 * risk_per_unit
        reasons, invalidation = bullish_reasons, bearish_reasons + [f"Price closing back below stop-loss {stop_loss:.2f} invalidates this signal"]
    else:  # SELL
        structural_stop = resistance if resistance is not None else entry + 1.5 * atr_value
        atr_stop = entry + 1.5 * atr_value
        stop_loss = min(structural_stop, atr_stop) if structural_stop > entry else atr_stop
        risk_per_unit = stop_loss - entry
        target = entry - 2 * risk_per_unit
        reasons, invalidation = bearish_reasons, bullish_reasons + [f"Price closing back above stop-loss {stop_loss:.2f} invalidates this signal"]

    if risk_per_unit <= 0:
        return Signal(
            instrument_key=instrument_key,
            action="NO_TRADE",
            strength=strength,
            reasons=["Computed stop-loss was not on the correct side of entry — skipping an unsafe signal"],
            data_timestamp=last.timestamp,
            is_stale=is_stale,
        )

    risk_reward = abs(target - entry) / risk_per_unit

    reasons.append(f"Volatility regime: {regime} (ATR14={atr_value:.2f})")

    return Signal(
        instrument_key=instrument_key,
        action=action,
        entry_price=entry,
        stop_loss=round(stop_loss, 2),
        target=round(target, 2),
        risk_reward=round(risk_reward, 2),
        strength=round(strength, 1),
        reasons=reasons,
        invalidation=invalidation,
        data_timestamp=last.timestamp,
        is_stale=is_stale,
    )


def _is_stale(data_timestamp: datetime) -> bool:
    ts = data_timestamp if data_timestamp.tzinfo else data_timestamp.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - ts > _STALE_AFTER

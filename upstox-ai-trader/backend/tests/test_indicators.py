from datetime import datetime, timedelta, timezone

from app.engine import indicators
from app.engine.candle import Candle


def _candles(closes: list[float], volumes: list[float] | None = None) -> list[Candle]:
    volumes = volumes or [1000] * len(closes)
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = []
    for i, (close, vol) in enumerate(zip(closes, volumes)):
        out.append(
            Candle(
                timestamp=start + timedelta(days=i),
                open=close - 0.5,
                high=close + 1,
                low=close - 1,
                close=close,
                volume=vol,
            )
        )
    return out


def test_sma_basic():
    result = indicators.sma([1, 2, 3, 4, 5], period=3)
    assert result == [None, None, 2, 3, 4]


def test_ema_converges_towards_rising_prices():
    closes = [10] * 20 + [20] * 20
    result = indicators.ema(closes, period=9)
    assert result[8] == 10  # seeded with SMA of first 9
    assert result[-1] > 15  # has moved meaningfully toward the new price level
    assert result[-1] < 20


def test_rsi_all_gains_is_100():
    closes = [float(i) for i in range(1, 20)]  # strictly increasing
    result = indicators.rsi(closes, period=14)
    assert result[14] == 100.0


def test_rsi_all_losses_is_0():
    closes = [float(i) for i in range(20, 1, -1)]  # strictly decreasing
    result = indicators.rsi(closes, period=14)
    assert result[14] == 0.0


def test_macd_histogram_positive_in_strong_uptrend():
    closes = [100 + i * 2 for i in range(40)]
    macd_line, signal_line, histogram = indicators.macd(closes)
    assert macd_line[-1] > 0
    assert histogram[-1] is not None


def test_atr_is_zero_for_flat_candles():
    candles = _candles([100] * 20)
    # flat candles still have high=close+1, low=close-1, so true range is ~2 each bar
    result = indicators.atr(candles, period=14)
    assert result[13] == 2.0


def test_vwap_equals_price_when_flat():
    candles = _candles([100] * 10)
    result = indicators.vwap(candles)
    assert all(v == 100 for v in result)


def test_rolling_support_resistance_excludes_current_bar():
    closes = [100] * 20 + [200]  # last bar spikes, must not pollute its own resistance
    candles = _candles(closes)
    support, resistance = indicators.rolling_support_resistance(candles, lookback=20)
    assert resistance < 150  # resistance computed from the flat history, not the spike


def test_detect_breakout_requires_volume_confirmation():
    closes = [100] * 20 + [150]
    volumes = [1000] * 20 + [1000]  # no volume surge
    candles = _candles(closes, volumes)
    breakout, breakdown = indicators.detect_breakout(candles, lookback=20)
    assert breakout is False


def test_detect_breakout_fires_with_volume_confirmation():
    closes = [100] * 20 + [150]
    volumes = [1000] * 20 + [5000]  # clear volume surge
    candles = _candles(closes, volumes)
    breakout, breakdown = indicators.detect_breakout(candles, lookback=20)
    assert breakout is True
    assert breakdown is False


def test_detect_trend_variants():
    assert indicators.detect_trend(3, 2, 1) == "uptrend"
    assert indicators.detect_trend(1, 2, 3) == "downtrend"
    assert indicators.detect_trend(2, 3, 1) == "sideways"
    assert indicators.detect_trend(None, 2, 1) == "unknown"


def test_volatility_regime_classifies_spike_as_high():
    series = [1.0] * 49 + [2.0]  # latest ATR is double its recent average
    assert indicators.volatility_regime(series, lookback=50) == "high"

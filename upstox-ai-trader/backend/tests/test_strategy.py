from datetime import datetime, timedelta, timezone

from app.engine.candle import Candle
from app.engine.strategy import MIN_CANDLES, generate_signal


def _candles(closes: list[float], volumes: list[float] | None = None, start=None) -> list[Candle]:
    volumes = volumes or [1000] * len(closes)
    start = start or (datetime.now(timezone.utc) - timedelta(days=len(closes) - 1))
    return [
        Candle(timestamp=start + timedelta(days=i), open=c - 0.3, high=c + 0.6, low=c - 0.6, close=c, volume=v)
        for i, (c, v) in enumerate(zip(closes, volumes))
    ]


def test_strong_uptrend_with_volume_breakout_generates_buy():
    closes = [100 + i * 0.8 for i in range(70)]
    volumes = [1000] * 69 + [4000]  # breakout bar confirmed by volume
    signal = generate_signal(_candles(closes, volumes), "TEST")

    assert signal.action == "BUY"
    assert signal.entry_price == closes[-1]
    assert signal.stop_loss < signal.entry_price
    assert signal.target > signal.entry_price
    assert signal.risk_reward == 2.0
    assert signal.strength > 0
    assert not signal.is_stale


def test_strong_downtrend_with_volume_breakdown_generates_sell():
    closes = [200 - i * 0.8 for i in range(70)]
    volumes = [1000] * 69 + [4000]
    signal = generate_signal(_candles(closes, volumes), "TEST")

    assert signal.action == "SELL"
    assert signal.stop_loss > signal.entry_price
    assert signal.target < signal.entry_price
    assert signal.risk_reward == 2.0


def test_choppy_sideways_market_gives_no_trade():
    import math

    closes = [100 + 2 * math.sin(i / 2) for i in range(70)]
    signal = generate_signal(_candles(closes), "TEST")
    assert signal.action == "NO_TRADE"


def test_insufficient_history_gives_no_trade():
    closes = [100 + i for i in range(MIN_CANDLES - 10)]
    signal = generate_signal(_candles(closes), "TEST")
    assert signal.action == "NO_TRADE"
    assert "candles available" in signal.reasons[0]


def test_old_data_is_flagged_stale_but_signal_is_still_computed():
    # Staleness is surfaced on the signal; it's the risk engine's job (not the
    # strategy engine's) to refuse to act on it — see test_risk.py.
    closes = [100 + i * 0.8 for i in range(70)]
    volumes = [1000] * 69 + [4000]
    old_candles = _candles(closes, volumes, start=datetime(2020, 1, 1, tzinfo=timezone.utc))
    signal = generate_signal(old_candles, "TEST")
    assert signal.is_stale is True
    assert signal.action == "BUY"

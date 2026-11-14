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


# --- indices: no volume data -------------------------------------------------
# Upstox reports volume 0 for indices like NIFTY, so VWAP and the
# volume-confirmed breakout can't vote. A signal still needs 3 confirming
# indicators, out of the 4 that remain.

def _index_up():
    return [200 + (0.3 * i + 0.005 * i * i) + (0.8 if i % 2 else -0.8) for i in range(70)]


def _index_down():
    return [200 - (0.3 * i + 0.005 * i * i) + (0.8 if i % 2 == 0 else -0.8) for i in range(70)]


def test_index_uptrend_without_volume_produces_buy_out_of_four():
    signal = generate_signal(_candles(_index_up(), [0] * 70), "NSE_INDEX|Nifty 50")
    assert signal.action == "BUY"
    assert signal.strength == 75.0  # 3 of 4, not 3 of 6
    assert any("No volume data" in r for r in signal.reasons)
    assert not any("trading above VWAP" in r or "trading below VWAP" in r for r in signal.reasons)
    assert signal.stop_loss < signal.entry_price < signal.target


def test_index_downtrend_without_volume_produces_sell():
    signal = generate_signal(_candles(_index_down(), [0] * 70), "NSE_INDEX|Nifty 50")
    assert signal.action == "SELL"
    assert signal.strength == 75.0


def test_choppy_flat_index_stays_no_trade():
    # With a 2-of-4 bar this produced a BUY; the bar stays at 3 indicators.
    closes = [100 + (0.5 if i % 2 else -0.5) for i in range(70)]
    signal = generate_signal(_candles(closes, [0] * 70), "NSE_INDEX|Nifty 50")
    assert signal.action == "NO_TRADE"
    assert any("No volume data" in r for r in signal.reasons)


def test_stock_with_volume_gets_no_index_note():
    closes = [100 + i * 0.8 for i in range(70)]
    signal = generate_signal(_candles(closes), "NSE_EQ|TEST")
    assert not any("No volume data" in r for r in signal.reasons)

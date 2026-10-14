import math
from datetime import date, datetime, timedelta, timezone

from app.engine.backtest import BacktestTrade, _check_exit, _close_trade, _compute_metrics, run_backtest
from app.engine.candle import Candle


def _candles(closes: list[float], volumes: list[float] | None = None, start=None) -> list[Candle]:
    volumes = volumes or [1000] * len(closes)
    start = start or datetime(2024, 1, 1, tzinfo=timezone.utc)
    return [
        Candle(timestamp=start + timedelta(days=i), open=c - 0.3, high=c + 0.6, low=c - 0.6, close=c, volume=v)
        for i, (c, v) in enumerate(zip(closes, volumes))
    ]


# ---- pure helper functions -------------------------------------------------


def test_check_exit_buy_prefers_stop_loss_when_both_in_range():
    position = {"side": "BUY", "stop_loss": 95.0, "target": 105.0}
    bar = Candle(timestamp=datetime.now(timezone.utc), open=100, high=106, low=94, close=100, volume=1000)
    reason, price = _check_exit(position, bar)
    assert reason == "stop_loss"
    assert price == 95.0


def test_check_exit_sell_prefers_stop_loss_when_both_in_range():
    position = {"side": "SELL", "stop_loss": 105.0, "target": 95.0}
    bar = Candle(timestamp=datetime.now(timezone.utc), open=100, high=106, low=94, close=100, volume=1000)
    reason, price = _check_exit(position, bar)
    assert reason == "stop_loss"
    assert price == 105.0


def test_check_exit_no_exit_when_price_stays_in_range():
    position = {"side": "BUY", "stop_loss": 90.0, "target": 110.0}
    bar = Candle(timestamp=datetime.now(timezone.utc), open=100, high=102, low=98, close=100, volume=1000)
    reason, price = _check_exit(position, bar)
    assert reason is None


def test_close_trade_tags_train_and_test_periods():
    position = {
        "side": "BUY",
        "entry_date": datetime(2024, 1, 1, tzinfo=timezone.utc),
        "entry_price": 100.0,
        "stop_loss": 98.0,
        "target": 104.0,
        "quantity": 10,
        "planned_risk_reward": 2.0,
    }
    before_cutoff = _close_trade(position, "X", datetime(2024, 1, 5, tzinfo=timezone.utc), 104.0, "target", date(2024, 6, 1))
    assert before_cutoff.period == "train"

    position["entry_date"] = datetime(2024, 7, 1, tzinfo=timezone.utc)
    after_cutoff = _close_trade(position, "X", datetime(2024, 7, 5, tzinfo=timezone.utc), 104.0, "target", date(2024, 6, 1))
    assert after_cutoff.period == "test"


# ---- metrics ----------------------------------------------------------------


def _trade(pnl: float, planned_rr: float = 2.0, cost: float = 5.0) -> BacktestTrade:
    now = datetime.now(timezone.utc)
    return BacktestTrade(
        instrument_key="X",
        side="BUY",
        entry_date=now,
        entry_price=100.0,
        exit_date=now,
        exit_price=100.0,
        exit_reason="target",
        quantity=1,
        planned_risk_reward=planned_rr,
        costs=cost,
        realized_pnl=pnl,
        period="all",
    )


def test_metrics_on_empty_trade_list():
    metrics = _compute_metrics([])
    assert metrics["total_trades"] == 0
    assert metrics["profit_factor"] is None


def test_metrics_win_rate_and_profit_factor():
    trades = [_trade(100), _trade(100), _trade(-50)]
    metrics = _compute_metrics(trades)
    assert metrics["total_trades"] == 3
    assert metrics["win_rate"] == round(2 / 3, 4)
    assert metrics["gross_profit"] == 200
    assert metrics["gross_loss"] == 50
    assert metrics["profit_factor"] == 4.0
    assert metrics["net_pnl"] == 150


def test_metrics_max_drawdown_tracks_peak_to_trough():
    # cumulative: 100, 200, 150, 50, 150 -> peak 200, trough 50 -> drawdown 150
    trades = [_trade(100), _trade(100), _trade(-50), _trade(-100), _trade(100)]
    metrics = _compute_metrics(trades)
    assert metrics["max_drawdown_amount"] == 150.0
    assert metrics["max_drawdown_pct"] == round(150 / 200, 4)


def test_metrics_profit_factor_is_none_with_no_losses():
    metrics = _compute_metrics([_trade(100), _trade(50)])
    assert metrics["profit_factor"] is None
    assert metrics["gross_loss"] == 0


# ---- full engine, structural invariants -------------------------------------


def _uptrend_with_breakout_volume(n=400, start=None):
    closes = [100 + i * 0.5 + 10 * math.sin(i / 15) for i in range(n)]
    volumes = [1000] * n
    for i in range(20, n, 15):
        volumes[i] = 5000
    return _candles(closes, volumes, start=start)


def test_run_backtest_produces_only_sequential_non_overlapping_trades():
    candles = _uptrend_with_breakout_volume()
    result = run_backtest(candles, "TEST", 100_000.0)

    assert len(result.trades) > 0
    for prev, nxt in zip(result.trades, result.trades[1:]):
        assert nxt.entry_date >= prev.exit_date  # never two positions open at once

    assert result.equity_curve[0][1] == 100_000.0
    expected_ending = 100_000.0 + sum(t.realized_pnl for t in result.trades)
    assert round(result.ending_capital, 2) == round(expected_ending, 2)


def test_run_backtest_never_looks_beyond_the_requested_candles():
    # Truncating the series shouldn't change any trade that happened before the cut.
    full = _uptrend_with_breakout_volume(n=300)
    truncated = full[:250]

    result_full = run_backtest(full, "TEST", 100_000.0)
    result_truncated = run_backtest(truncated, "TEST", 100_000.0)

    trades_before_cut = [t for t in result_full.trades if t.exit_date <= truncated[-1].timestamp]
    assert [(t.entry_date, t.realized_pnl) for t in trades_before_cut] == [
        (t.entry_date, t.realized_pnl) for t in result_truncated.trades
    ]


def test_run_backtest_tags_train_and_test_when_split_given():
    candles = _uptrend_with_breakout_volume(n=400)
    cutoff = candles[200].timestamp.date()
    result = run_backtest(candles, "TEST", 100_000.0, train_end_date=cutoff)

    assert any(t.period == "train" for t in result.trades)
    assert any(t.period == "test" for t in result.trades)
    assert result.metrics["train"]["total_trades"] + result.metrics["test"]["total_trades"] == len(result.trades)


def test_run_backtest_with_insufficient_candles_opens_nothing():
    candles = _candles([100 + i for i in range(40)])
    result = run_backtest(candles, "TEST", 100_000.0)
    assert result.trades == []
    assert result.ending_capital == 100_000.0

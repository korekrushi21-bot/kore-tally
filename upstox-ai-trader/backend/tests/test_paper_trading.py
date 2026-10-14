from app.engine import paper_trading
from app.engine.strategy import Signal


def _buy_signal(entry=100.0, stop=98.0, target=104.0, instrument="TEST") -> Signal:
    return Signal(
        instrument_key=instrument,
        action="BUY",
        entry_price=entry,
        stop_loss=stop,
        target=target,
        risk_reward=2.0,
        strength=60.0,
        is_stale=False,
    )


def test_evaluate_and_execute_opens_a_position(db_session):
    result = paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(), current_price=100.0)
    assert result["action"] == "opened"
    assert result["position"]["status"] == "OPEN"
    assert result["position"]["quantity"] > 0

    open_positions = paper_trading.get_open_positions(db_session)
    assert len(open_positions) == 1


def test_no_trade_signal_is_passed_through_untouched(db_session):
    no_trade = Signal(instrument_key="TEST", action="NO_TRADE", reasons=["nothing interesting"])
    result = paper_trading.evaluate_and_execute_signal(db_session, no_trade, current_price=100.0)
    assert result == {"action": "no_trade", "reasons": ["nothing interesting"]}


def test_exit_at_stop_loss_realizes_a_loss(db_session):
    paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(), current_price=100.0)
    closed = paper_trading.check_exits(db_session, "TEST", current_price=97.0)  # below stop_loss of 98
    assert len(closed) == 1
    assert closed[0]["exit_reason"] == "stop_loss"
    assert closed[0]["realized_pnl"] < 0
    assert paper_trading.get_open_positions(db_session) == []


def test_exit_at_target_realizes_a_gain(db_session):
    paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(), current_price=100.0)
    closed = paper_trading.check_exits(db_session, "TEST", current_price=105.0)  # above target of 104
    assert closed[0]["exit_reason"] == "target"
    assert closed[0]["realized_pnl"] > 0


def test_second_signal_on_same_instrument_is_rejected_as_averaging_down(db_session):
    paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(), current_price=100.0)
    result = paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(), current_price=100.0)
    assert result["action"] == "rejected"
    assert any("averaging down" in r for r in result["reasons"])


def test_daily_loss_limit_halts_new_entries_after_breach(db_session):
    # Force a large loss relative to the 100,000 starting capital / 1.5% limit (-1500).
    account = paper_trading.get_or_create_account(db_session)
    assert account.starting_capital == 100_000.0

    paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(entry=100.0, stop=90.0, target=120.0), current_price=100.0)
    # Risk budget 500 / risk-per-unit 10 = 50 shares; forcing exit far below stop to produce a big loss.
    paper_trading.check_exits(db_session, "TEST", current_price=50.0)

    today = paper_trading.get_today_risk_state(db_session)
    assert today.realized_pnl < 0
    assert today.loss_limit_halted is True

    result = paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(instrument="OTHER"), current_price=100.0)
    assert result["action"] == "rejected"
    assert any("daily loss limit" in r.lower() for r in result["reasons"])


def test_emergency_stop_all_closes_everything_and_blocks_new_trades(db_session):
    paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(instrument="A"), current_price=100.0)
    paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(instrument="B"), current_price=100.0)
    assert len(paper_trading.get_open_positions(db_session)) == 2

    closed = paper_trading.emergency_stop_all(db_session, {"A": 101.0, "B": 99.0})
    assert len(closed) == 2
    assert paper_trading.get_open_positions(db_session) == []

    result = paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(instrument="C"), current_price=100.0)
    assert result["action"] == "rejected"
    assert any("halted" in r for r in result["reasons"])


def test_resume_trading_clears_the_halt(db_session):
    paper_trading.emergency_stop_all(db_session, {})
    paper_trading.resume_trading(db_session)
    result = paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(), current_price=100.0)
    assert result["action"] == "opened"


def test_account_snapshot_reports_unrealized_pnl_from_mark_price(db_session):
    paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(), current_price=100.0)
    snapshot = paper_trading.get_account_snapshot(db_session, mark_prices={"TEST": 103.0})
    assert snapshot["unrealized_pnl"] > 0
    assert snapshot["open_positions"][0]["mark_price"] == 103.0


def test_get_closed_positions_returns_only_closed_ordered_most_recent_first(db_session):
    paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(instrument="A"), current_price=100.0)
    paper_trading.check_exits(db_session, "A", current_price=105.0)
    paper_trading.evaluate_and_execute_signal(db_session, _buy_signal(instrument="B"), current_price=100.0)
    paper_trading.check_exits(db_session, "B", current_price=97.0)

    closed = paper_trading.get_closed_positions(db_session)
    assert [p.instrument_key for p in closed] == ["B", "A"]
    assert all(p.status == "CLOSED" for p in closed)

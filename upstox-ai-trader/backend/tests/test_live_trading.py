import pytest

from app.engine import live_trading
from app.engine.strategy import Signal
from tests.fake_upstox_client import FakeUpstoxClient, rejected_error


def _buy_signal(entry=100.0, stop=98.0, target=104.0, instrument="NSE_EQ|TEST") -> Signal:
    return Signal(
        instrument_key=instrument, action="BUY", entry_price=entry, stop_loss=stop,
        target=target, risk_reward=2.0, strength=60.0, is_stale=False,
    )


def test_require_enabled_raises_when_disabled(db_session):
    with pytest.raises(live_trading.LiveTradingDisabled):
        live_trading.require_enabled()


@pytest.mark.asyncio
async def test_evaluate_raises_when_disabled(db_session):
    fake = FakeUpstoxClient()
    with pytest.raises(live_trading.LiveTradingDisabled):
        await live_trading.evaluate_and_execute_signal(db_session, fake, _buy_signal(), 100.0)


@pytest.mark.asyncio
async def test_no_trade_signal_passes_through(db_session, live_enabled):
    fake = FakeUpstoxClient()
    no_trade = Signal(instrument_key="X", action="NO_TRADE", reasons=["nothing interesting"])
    result = await live_trading.evaluate_and_execute_signal(db_session, fake, no_trade, 100.0)
    assert result["action"] == "no_trade"
    assert fake.placed_orders == []


@pytest.mark.asyncio
async def test_happy_path_opens_position_with_real_protective_orders(db_session, live_enabled):
    fake = FakeUpstoxClient()
    result = await live_trading.evaluate_and_execute_signal(db_session, fake, _buy_signal(), 100.0)

    assert result["action"] == "opened"
    assert result["stop_order_id"] is not None
    assert result["target_order_id"] is not None
    assert result["protective_order_failures"] == []

    # Entry (MARKET), stop-loss (SL-M), and target (LIMIT) — three real orders placed.
    assert len(fake.placed_orders) == 3
    order_types = {o["order_type"] for o in fake.placed_orders}
    assert order_types == {"MARKET", "SL-M", "LIMIT"}

    positions = live_trading.get_open_positions(db_session)
    assert len(positions) == 1
    assert positions[0].stop_order_id == result["stop_order_id"]
    assert positions[0].target_order_id == result["target_order_id"]


@pytest.mark.asyncio
async def test_entry_placement_failure_is_surfaced_not_silently_dropped(db_session, live_enabled):
    fake = FakeUpstoxClient()
    fake.raise_on_place = rejected_error()
    result = await live_trading.evaluate_and_execute_signal(db_session, fake, _buy_signal(), 100.0)

    assert result["action"] == "entry_failed"
    assert "rejected" in result["reasons"][0].lower()
    assert live_trading.get_open_positions(db_session) == []


@pytest.mark.asyncio
async def test_unconfirmed_entry_does_not_open_a_position_or_place_protective_orders(db_session, live_enabled):
    fake = FakeUpstoxClient()
    fake.force_market_status = "open"  # never confirms "complete" within the poll window
    result = await live_trading.evaluate_and_execute_signal(db_session, fake, _buy_signal(), 100.0)

    assert result["action"] == "entry_unconfirmed"
    assert live_trading.get_open_positions(db_session) == []
    # Only the entry order was placed — no SL/target against an unconfirmed fill.
    assert len(fake.placed_orders) == 1


@pytest.mark.asyncio
async def test_duplicate_entry_within_guard_window_is_rejected(db_session, live_enabled):
    fake = FakeUpstoxClient()
    fake.force_market_status = "open"  # first call leaves no open position, but DOES record a LiveOrder

    first = await live_trading.evaluate_and_execute_signal(db_session, fake, _buy_signal(), 100.0)
    assert first["action"] == "entry_unconfirmed"

    second = await live_trading.evaluate_and_execute_signal(db_session, fake, _buy_signal(), 100.0)
    assert second["action"] == "rejected"
    assert any("already placed" in r for r in second["reasons"])
    assert len(fake.placed_orders) == 1  # the duplicate was never sent to Upstox


@pytest.mark.asyncio
async def test_risk_engine_rejection_places_no_orders(db_session, live_enabled):
    fake = FakeUpstoxClient()
    fake.funds_response = {"data": {"equity": {"available_margin": 1.0}}}  # too small for even 1 share
    result = await live_trading.evaluate_and_execute_signal(db_session, fake, _buy_signal(), 100.0)

    assert result["action"] == "rejected"
    assert fake.placed_orders == []


@pytest.mark.asyncio
async def test_available_capital_falls_back_when_funds_call_fails(db_session, live_enabled):
    fake = FakeUpstoxClient()
    fake.raise_on_funds = rejected_error()
    capital, note = await live_trading._available_capital(fake)
    assert capital > 0
    assert note is not None


@pytest.mark.asyncio
async def test_reconcile_closes_position_on_target_hit_and_cancels_stop_loss(db_session, live_enabled):
    fake = FakeUpstoxClient()
    opened = await live_trading.evaluate_and_execute_signal(db_session, fake, _buy_signal(), 100.0)
    stop_id, target_id = opened["stop_order_id"], opened["target_order_id"]

    fake.set_status(target_id, "complete", average_price=104.0, filled_quantity=opened["quantity"])
    results = await live_trading.reconcile_instrument(db_session, fake, "NSE_EQ|TEST")

    assert results[0]["status"] == "closed"
    assert results[0]["exit_reason"] == "target"
    assert results[0]["realized_pnl"] > 0
    assert stop_id in fake.cancelled_order_ids
    assert live_trading.get_open_positions(db_session) == []


@pytest.mark.asyncio
async def test_reconcile_closes_position_on_stop_loss_hit_and_cancels_target(db_session, live_enabled):
    fake = FakeUpstoxClient()
    opened = await live_trading.evaluate_and_execute_signal(db_session, fake, _buy_signal(), 100.0)
    stop_id, target_id = opened["stop_order_id"], opened["target_order_id"]

    fake.set_status(stop_id, "complete", average_price=98.0, filled_quantity=opened["quantity"])
    results = await live_trading.reconcile_instrument(db_session, fake, "NSE_EQ|TEST")

    assert results[0]["exit_reason"] == "stop_loss"
    assert results[0]["realized_pnl"] < 0
    assert target_id in fake.cancelled_order_ids


@pytest.mark.asyncio
async def test_reconcile_leaves_position_open_when_neither_leg_has_filled(db_session, live_enabled):
    fake = FakeUpstoxClient()
    await live_trading.evaluate_and_execute_signal(db_session, fake, _buy_signal(), 100.0)
    results = await live_trading.reconcile_instrument(db_session, fake, "NSE_EQ|TEST")
    assert results[0]["status"] == "still_open"
    assert len(live_trading.get_open_positions(db_session)) == 1


@pytest.mark.asyncio
async def test_emergency_stop_all_flattens_account_and_halts(db_session, live_enabled):
    fake = FakeUpstoxClient()
    await live_trading.evaluate_and_execute_signal(db_session, fake, _buy_signal(), 100.0)
    assert len(live_trading.get_open_positions(db_session)) == 1

    await live_trading.emergency_stop_all(db_session, fake)

    assert fake.cancel_all_called is True
    assert fake.exit_all_called is True
    assert live_trading.get_open_positions(db_session) == []
    assert live_trading.get_or_create_account(db_session).trading_halted is True


@pytest.mark.asyncio
async def test_halted_account_rejects_new_entries(db_session, live_enabled):
    fake = FakeUpstoxClient()
    await live_trading.emergency_stop_all(db_session, fake)

    result = await live_trading.evaluate_and_execute_signal(db_session, fake, _buy_signal(), 100.0)
    assert result["action"] == "rejected"
    assert any("halted" in r for r in result["reasons"])


def test_resume_clears_halt(db_session):
    account = live_trading.get_or_create_account(db_session)
    account.trading_halted = True
    db_session.commit()

    live_trading.resume_trading(db_session)
    assert live_trading.get_or_create_account(db_session).trading_halted is False

from app.engine.risk import AccountSnapshot, RiskConfig, RiskDecision, RiskManager
from app.engine.strategy import Signal


def _signal(**overrides) -> Signal:
    base = dict(
        instrument_key="TEST",
        action="BUY",
        entry_price=100.0,
        stop_loss=98.0,
        target=104.0,
        risk_reward=2.0,
        strength=60.0,
        is_stale=False,
    )
    base.update(overrides)
    return Signal(**base)


def _account(**overrides) -> AccountSnapshot:
    base = dict(
        capital=100_000.0,
        open_positions_count=0,
        has_open_position_in_instrument=False,
        daily_realized_pnl=0.0,
        trading_halted=False,
        daily_loss_limit_halted=False,
    )
    base.update(overrides)
    return AccountSnapshot(**base)


def _config(**overrides) -> RiskConfig:
    base = dict(
        max_risk_per_trade_pct=0.005,
        max_daily_loss_pct=0.015,
        max_open_positions=3,
        min_risk_reward=2.0,
        allow_averaging_down=False,
    )
    base.update(overrides)
    return RiskConfig(**base)


def test_position_size_matches_spec_formula():
    manager = RiskManager(_config())
    # risk budget = 100000 * 0.005 = 500; risk per unit = 100-98 = 2 -> 250 shares
    assert manager.position_size(100_000.0, entry_price=100.0, stop_loss=98.0) == 250


def test_approved_trade_within_all_limits():
    decision = RiskManager(_config()).evaluate(_signal(), _account())
    assert decision.approved is True
    assert decision.quantity == 250
    assert decision.max_loss_amount == 500.0


def test_rejects_when_trading_halted():
    decision = RiskManager(_config()).evaluate(_signal(), _account(trading_halted=True))
    assert decision.approved is False
    assert any("halted" in r for r in decision.reasons)


def test_rejects_when_daily_loss_limit_already_halted():
    decision = RiskManager(_config()).evaluate(_signal(), _account(daily_loss_limit_halted=True))
    assert decision.approved is False


def test_rejects_stale_signal():
    decision = RiskManager(_config()).evaluate(_signal(is_stale=True), _account())
    assert decision.approved is False
    assert any("stale" in r for r in decision.reasons)


def test_rejects_signal_without_stop_loss():
    decision = RiskManager(_config()).evaluate(_signal(stop_loss=None), _account())
    assert decision.approved is False


def test_rejects_below_minimum_risk_reward():
    decision = RiskManager(_config(min_risk_reward=3.0)).evaluate(_signal(risk_reward=2.0), _account())
    assert decision.approved is False
    assert any("risk:reward" in r.lower() for r in decision.reasons)


def test_rejects_when_max_open_positions_reached():
    decision = RiskManager(_config(max_open_positions=3)).evaluate(
        _signal(), _account(open_positions_count=3)
    )
    assert decision.approved is False
    assert any("max" in r.lower() for r in decision.reasons)


def test_rejects_averaging_down_on_existing_instrument():
    decision = RiskManager(_config()).evaluate(_signal(), _account(has_open_position_in_instrument=True))
    assert decision.approved is False
    assert any("averaging down" in r for r in decision.reasons)


def test_allows_averaging_down_when_explicitly_enabled():
    decision = RiskManager(_config(allow_averaging_down=True)).evaluate(
        _signal(), _account(has_open_position_in_instrument=True)
    )
    assert decision.approved is True


def test_rejects_when_daily_loss_limit_breached_by_realized_pnl():
    # -1.5% of 100,000 = -1500
    decision = RiskManager(_config(max_daily_loss_pct=0.015)).evaluate(
        _signal(), _account(daily_realized_pnl=-1500.0)
    )
    assert decision.approved is False
    assert any("daily limit" in r.lower() or "loss" in r.lower() for r in decision.reasons)


def test_rejects_when_position_size_rounds_to_zero():
    # Risk budget too small relative to stop distance for even 1 share.
    decision = RiskManager(_config(max_risk_per_trade_pct=0.0001)).evaluate(_signal(), _account(capital=1000.0))
    assert decision.approved is False
    assert any("rounds to zero" in r for r in decision.reasons)

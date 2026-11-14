from datetime import date, datetime, timedelta, timezone

import pytest

from app.engine import options, paper_trading
from app.engine.candle import Candle
from app.engine.option_backtest import run_option_backtest
from app.engine.risk import AccountSnapshot, RiskConfig, RiskManager
from app.engine.strategy import Signal

TODAY = date(2026, 11, 6)
UNDERLYING = "NSE_EQ|INE020B01018"


def _contract_rows():
    rows = []
    for expiry in ("2026-11-24", "2026-12-29", "2026-11-07"):
        for strike in (280, 285, 290, 295, 300):
            for typ in ("CE", "PE"):
                rows.append({
                    "instrument_key": f"NSE_FO|{expiry}-{strike}-{typ}",
                    "underlying_key": UNDERLYING,
                    "instrument_type": typ,
                    "strike_price": strike,
                    "expiry": expiry,
                    "lot_size": 1575,
                    "trading_symbol": f"RECLTD {strike} {typ} {expiry}",
                })
    rows.append({"instrument_type": "FUT", "expiry": "2026-11-24"})  # ignored
    return {"status": "success", "data": rows}


def _contracts():
    return options.parse_contracts(_contract_rows())


def _signal(action="BUY", entry=290.0, stop=284.0, target=302.0, rr=2.0):
    return Signal(instrument_key=UNDERLYING, action=action, entry_price=entry, stop_loss=stop, target=target, risk_reward=rr)


def _snapshot(capital=1_000_000.0, **overrides):
    values = dict(
        capital=capital, open_positions_count=0, has_open_position_in_instrument=False,
        daily_realized_pnl=0.0, trading_halted=False, daily_loss_limit_halted=False,
    )
    values.update(overrides)
    return AccountSnapshot(**values)


def _risk(**overrides):
    values = dict(max_risk_per_trade_pct=0.01, max_daily_loss_pct=0.03, max_open_positions=3, min_risk_reward=2.0)
    values.update(overrides)
    return RiskManager(RiskConfig(**values))


# --- contract parsing & selection ---------------------------------------------

def test_parse_contracts_skips_non_options_and_parses_fields():
    parsed = _contracts()
    assert len(parsed) == 30
    first = parsed[0]
    assert first.expiry == date(2026, 11, 24)
    assert first.lot_size == 1575
    assert first.option_type in ("CE", "PE")


def test_select_atm_skips_expiry_too_close():
    contract, reason = options.select_contract(_contracts(), "CE", 291.2, TODAY, min_days_to_expiry=3)
    assert reason is None
    assert contract.expiry == date(2026, 11, 24)  # 2026-11-07 is only 1 day away
    assert contract.strike == 290


def test_strike_offset_direction_differs_for_calls_and_puts():
    ce, _ = options.select_contract(_contracts(), "CE", 291.0, TODAY, 3, strike_offset=1)
    pe, _ = options.select_contract(_contracts(), "PE", 291.0, TODAY, 3, strike_offset=1)
    assert ce.strike == 295  # OTM call = higher strike
    assert pe.strike == 285  # OTM put = lower strike


def test_explicit_expiry_too_close_is_refused():
    contract, reason = options.select_contract(_contracts(), "CE", 291.0, TODAY, 3, expiry=date(2026, 11, 7))
    assert contract is None
    assert "1 day" in reason


def test_offset_outside_listed_strikes_is_refused():
    contract, reason = options.select_contract(_contracts(), "CE", 291.0, TODAY, 3, strike_offset=5)
    assert contract is None and "outside" in reason


# --- pricing -------------------------------------------------------------------

def test_implied_vol_round_trips_black_scholes():
    years = 18 / 365
    price = options.bs_price(290, 295, years, 0.065, 0.32, "CE")
    assert options.implied_vol(price, 290, 295, years, 0.065, "CE") == pytest.approx(0.32, abs=1e-4)


def test_atm_delta_is_about_half_and_put_delta_is_positive_magnitude():
    expiry = TODAY + timedelta(days=18)
    ce_price = options.bs_price(290, 290, 18 / 365, 0.065, 0.3, "CE")
    pe_price = options.bs_price(290, 290, 18 / 365, 0.065, 0.3, "PE")
    assert 0.45 < options.estimate_delta(ce_price, 290, 290, expiry, TODAY, "CE", 0.065) < 0.6
    assert 0.4 < options.estimate_delta(pe_price, 290, 290, expiry, TODAY, "PE", 0.065) < 0.55


def test_premium_below_intrinsic_gives_no_delta():
    # A 280 call with spot 300 is worth at least 20; a 5.0 quote is stale/bad.
    assert options.estimate_delta(5.0, 300, 280, TODAY + timedelta(days=10), TODAY, "CE", 0.065) is None


def test_underlying_exit_rule_for_calls_and_puts():
    assert options.underlying_exit_reason("CE", 283, 292, stop=284, target=302) == "stop_loss"
    assert options.underlying_exit_reason("CE", 290, 303, stop=284, target=302) == "target"
    assert options.underlying_exit_reason("CE", 283, 303, stop=284, target=302) == "stop_loss"  # both: stop first
    assert options.underlying_exit_reason("PE", 285, 297, stop=296, target=278) == "stop_loss"
    assert options.underlying_exit_reason("PE", 277, 290, stop=296, target=278) == "target"
    assert options.underlying_exit_reason("PE", 285, 290, stop=296, target=278) is None


# --- risk sizing in lots ---------------------------------------------------------

def test_option_sizing_in_whole_lots():
    # risk/unit = 0.5 delta * 6 pts = 3.0; per lot 4725; budget 10,000 -> 2 lots
    decision = _risk().evaluate_option(_signal(), _snapshot(), premium=8.0, delta=0.5, lot_size=1575)
    assert decision.approved
    assert decision.lots == 2
    assert decision.quantity == 3150
    assert decision.max_loss_amount == pytest.approx(9450.0)


def test_one_lot_too_risky_is_rejected_with_amounts():
    decision = _risk().evaluate_option(_signal(), _snapshot(capital=100_000), premium=8.0, delta=0.5, lot_size=1575)
    assert not decision.approved
    assert "per-trade risk budget" in decision.reasons[0]


def test_loss_per_unit_is_capped_at_premium():
    # delta*distance = 0.9*20 = 18 > premium 5 -> loss capped at 5/unit = 7875/lot
    sig = _signal(entry=290, stop=270, target=330)
    decision = _risk().evaluate_option(sig, _snapshot(), premium=5.0, delta=0.9, lot_size=1575)
    assert decision.lots == 1
    assert decision.max_loss_amount == pytest.approx(7875.0)


def test_premium_cap_limits_lots():
    decision = _risk(option_max_premium_pct=0.01).evaluate_option(
        _signal(), _snapshot(), premium=8.0, delta=0.5, lot_size=1575
    )
    assert not decision.approved
    assert "premium cap" in decision.reasons[0]


def test_missing_delta_and_halts_are_rejected():
    assert not _risk().evaluate_option(_signal(), _snapshot(), 8.0, None, 1575).approved
    halted = _risk().evaluate_option(_signal(), _snapshot(trading_halted=True), 8.0, 0.5, 1575)
    assert not halted.approved and "halted" in halted.reasons[0]


# --- paper trading -----------------------------------------------------------------

def _ce_contract(strike=290, expiry=date(2026, 11, 24)):
    return options.OptionContract(f"NSE_FO|CE{strike}", UNDERLYING, "CE", strike, expiry, 1575, f"RECLTD {strike} CE")


@pytest.fixture()
def big_account(db_session):
    account = paper_trading.get_or_create_account(db_session)
    account.starting_capital = 2_000_000.0
    db_session.commit()
    return account


def _fair_premium(spot, strike, expiry, typ="CE", vol=0.3):
    return round(options.bs_price(spot, strike, (expiry - TODAY).days / 365, 0.065, vol, typ), 2)


def test_buy_signal_opens_a_call_sized_in_lots(db_session, big_account):
    contract = _ce_contract()
    premium = _fair_premium(290, 290, contract.expiry)
    result = paper_trading.evaluate_and_execute_option_signal(
        db_session, _signal(), contract, premium, spot=290, as_of=TODAY
    )
    assert result["action"] == "opened", result
    pos = result["position"]
    assert pos["side"] == "BUY"
    assert pos["quantity"] % 1575 == 0 and pos["quantity"] > 0
    assert pos["option"]["option_type"] == "CE"
    assert pos["option"]["underlying_stop"] == 284.0
    assert pos["stop_loss"] < pos["entry_price"] < pos["target"]


def test_sell_signal_with_a_call_is_refused(db_session, big_account):
    result = paper_trading.evaluate_and_execute_option_signal(
        db_session, _signal(action="SELL", stop=296, target=278), _ce_contract(), 8.0, spot=290, as_of=TODAY
    )
    assert result["action"] == "rejected"
    assert "PE" in result["reasons"][0]


def test_contract_too_close_to_expiry_is_refused(db_session, big_account):
    contract = _ce_contract(expiry=TODAY + timedelta(days=1))
    result = paper_trading.evaluate_and_execute_option_signal(
        db_session, _signal(), contract, _fair_premium(290, 290, contract.expiry), spot=290, as_of=TODAY
    )
    assert result["action"] == "rejected"
    assert any("expires in 1 day" in r for r in result["reasons"])


def test_option_exits_follow_the_underlying_not_the_premium(db_session, big_account):
    contract = _ce_contract()
    premium = _fair_premium(290, 290, contract.expiry)
    paper_trading.evaluate_and_execute_option_signal(db_session, _signal(), contract, premium, spot=290, as_of=TODAY)

    # Premium crashing does not trigger the equity-style exit check...
    assert paper_trading.check_exits(db_session, contract.instrument_key, 0.5) == []
    # ...and an underlying still between stop and target keeps it open.
    assert paper_trading.check_option_exits(db_session, UNDERLYING, 289.0, {contract.instrument_key: 7.0}, as_of=TODAY) == []
    # Unknown option price: never close at a guess.
    assert paper_trading.check_option_exits(db_session, UNDERLYING, 303.0, {}, as_of=TODAY) == []

    closed = paper_trading.check_option_exits(db_session, UNDERLYING, 303.0, {contract.instrument_key: 15.0}, as_of=TODAY)
    assert len(closed) == 1
    assert closed[0]["exit_reason"] == "target"
    assert closed[0]["realized_pnl"] > 0


def test_option_position_is_closed_on_expiry_day(db_session, big_account):
    contract = _ce_contract()
    premium = _fair_premium(290, 290, contract.expiry)
    paper_trading.evaluate_and_execute_option_signal(db_session, _signal(), contract, premium, spot=290, as_of=TODAY)
    closed = paper_trading.check_option_exits(
        db_session, UNDERLYING, 291.0, {contract.instrument_key: 1.2}, as_of=contract.expiry
    )
    assert closed[0]["exit_reason"] == "expiry"
    assert closed[0]["realized_pnl"] < 0


def test_second_option_on_same_underlying_is_blocked(db_session, big_account):
    contract = _ce_contract()
    premium = _fair_premium(290, 290, contract.expiry)
    paper_trading.evaluate_and_execute_option_signal(db_session, _signal(), contract, premium, spot=290, as_of=TODAY)
    again = paper_trading.evaluate_and_execute_option_signal(
        db_session, _signal(), _ce_contract(strike=295), premium, spot=290, as_of=TODAY
    )
    assert again["action"] == "rejected"
    assert any("already open" in r for r in again["reasons"])


# --- backtest -------------------------------------------------------------------------

def _bars(start: datetime, closes: list[float], spread=0.6, volumes=None):
    out = []
    for i, close in enumerate(closes):
        vol = volumes[i] if volumes else 1000
        out.append(Candle(start + timedelta(days=i), close - 0.3, close + spread, close - spread, close, vol))
    return out


def test_option_backtest_trades_the_call_on_an_uptrend_and_books_target():
    start = datetime(2026, 7, 1, tzinfo=timezone.utc)
    n = 90
    closes = [200 + i * 0.8 for i in range(n)]
    volumes = [1000] * n
    volumes[60] = 4000  # volume-confirmed breakout on the first tradable bar
    underlying = _bars(start, closes, volumes=volumes)
    expiry = (start + timedelta(days=n + 5)).date()
    strike = 250.0

    def option_series(typ):
        series = []
        for i, bar in enumerate(underlying):
            days = (expiry - bar.timestamp.date()).days
            price = round(options.bs_price(bar.close, strike, days / 365, 0.065, 0.3, typ), 2)
            hi = round(options.bs_price(bar.high, strike, days / 365, 0.065, 0.3, typ), 2)
            lo = round(options.bs_price(bar.low, strike, days / 365, 0.065, 0.3, typ), 2)
            if typ == "PE":
                hi, lo = lo, hi
            series.append(Candle(bar.timestamp, price, hi, lo, price, 500))
        return series

    call = options.OptionContract("NSE_FO|C", UNDERLYING, "CE", strike, expiry, 100, "TEST 250 CE")
    put = options.OptionContract("NSE_FO|P", UNDERLYING, "PE", strike, expiry, 100, "TEST 250 PE")
    result = run_option_backtest(
        underlying, call, option_series("CE"), put, option_series("PE"),
        starting_capital=1_000_000, rate=0.065, min_days_to_expiry=3,
        risk_config=RiskConfig(0.01, 0.03, 3, 2.0),
    )
    assert result.trades, result
    assert all(t.side == "BUY CE" for t in result.trades)
    assert all(t.quantity % 100 == 0 for t in result.trades)
    assert result.trades[0].exit_reason == "target"
    assert result.trades[0].realized_pnl > 0
    assert result.metrics["all"]["total_trades"] == len(result.trades)

from datetime import date, datetime, timedelta, timezone

from app.engine import options
from app.engine.candle import Candle
from app.engine.option_picker import PickerConfig, candidate_strikes, min_days_needed, plan_option_trade
from app.engine.risk import RiskConfig, RiskManager
from app.engine.strategy import Signal

TODAY = date(2026, 11, 14)
DATA_DAY = date(2026, 11, 13)
UNDERLYING = "NSE_EQ|PAYTM"
NEAR, FAR = date(2026, 11, 23), date(2026, 12, 29)
SPOT = 1940.0
CFG = PickerConfig(capital=100_000, rate=0.065)
BIG = PickerConfig(capital=2_000_000, rate=0.065)  # room for a lot under the premium cap


def _contracts(lot=725):
    out = []
    for expiry in (NEAR, FAR):
        for strike in range(1800, 2101, 20):
            for typ in ("CE", "PE"):
                out.append(options.OptionContract(
                    f"NSE_FO|{expiry:%m%d}{strike}{typ}", UNDERLYING, typ, float(strike), expiry, lot,
                    f"PAYTM {strike} {typ} {expiry:%d %b}",
                ))
    return out


def _signal(action="BUY"):
    if action == "BUY":
        return Signal(UNDERLYING, "BUY", entry_price=SPOT, stop_loss=1845.0, target=2130.0, risk_reward=2.0)
    return Signal(UNDERLYING, "SELL", entry_price=SPOT, stop_loss=2035.0, target=1750.0, risk_reward=2.0)


def _priced(contracts, day=DATA_DAY, volume=1000, vol=0.45):
    """Black-Scholes closes for every contract, as one daily candle on `day`."""
    ts = datetime(day.year, day.month, day.day, tzinfo=timezone(timedelta(hours=5, minutes=30)))
    out = {}
    for c in contracts:
        px = round(options.bs_price(SPOT, c.strike, (c.expiry - day).days / 365, 0.065, vol, c.option_type), 2)
        out[c.instrument_key] = [Candle(ts, px, px, px, px, volume)]
    return out


def _risk(pct=0.01):
    return RiskManager(RiskConfig(max_risk_per_trade_pct=pct, max_daily_loss_pct=0.03, max_open_positions=3, min_risk_reward=2.0))


def test_expiry_must_cover_the_usual_holding_period():
    assert min_days_needed(None, CFG) == 7
    assert min_days_needed(14, CFG) == 24  # 1.5 x 14 + 3
    plan = plan_option_trade(_signal(), SPOT, DATA_DAY, _contracts(), _priced(_contracts()), 14, TODAY, BIG, _risk(0.5))
    assert plan.contract["expiry"] == FAR.isoformat()  # 23 Nov is only 9 days away


def test_buy_picks_an_itm_call_with_delta_near_065():
    plan = plan_option_trade(_signal(), SPOT, DATA_DAY, _contracts(), _priced(_contracts()), 5, TODAY, BIG, _risk(0.5))
    assert plan.status == "ok"
    assert plan.contract["option_type"] == "CE"
    assert plan.contract["strike"] <= SPOT  # ATM or in-the-money
    assert 0.5 < plan.delta < 0.8
    assert plan.quantity == plan.lots * 725 and plan.lots >= 1
    assert plan.breakeven == round(plan.contract["strike"] + plan.premium, 2)
    assert plan.exit_by == date.fromisoformat(plan.contract["expiry"]) - timedelta(days=2)


def test_sell_signal_buys_a_put_and_itm_put_has_higher_strike():
    plan = plan_option_trade(_signal("SELL"), SPOT, DATA_DAY, _contracts(), _priced(_contracts()), 5, TODAY, BIG, _risk(0.5))
    assert plan.contract["option_type"] == "PE"
    assert plan.contract["strike"] >= SPOT - 20


def test_itm_candidates_go_down_for_calls_and_up_for_puts():
    calls = [c.strike for c in candidate_strikes(_contracts(), "CE", NEAR, 1940)]
    puts = [c.strike for c in candidate_strikes(_contracts(), "PE", NEAR, 1940)]
    assert calls == [1940, 1920, 1900]
    assert puts == [1940, 1960, 1980]


def test_one_lot_over_the_risk_limit_suggests_zero_lots_with_numbers():
    plan = plan_option_trade(_signal(), SPOT, DATA_DAY, _contracts(), _priced(_contracts()), 5, TODAY, CFG, _risk(0.01))
    assert plan.status == "too_big"
    assert plan.lots == 0 and plan.quantity == 0
    assert plan.one_lot_risk > plan.risk_budget == 1000.0
    assert "per-trade risk budget" in plan.reason


def test_contracts_that_did_not_trade_on_the_signal_day_are_skipped():
    stale = _priced(_contracts(), day=DATA_DAY - timedelta(days=3))
    plan = plan_option_trade(_signal(), SPOT, DATA_DAY, _contracts(), stale, 5, TODAY, CFG, _risk(0.5))
    assert plan.status == "no_contract"
    assert all(c.get("skipped") for c in plan.candidates)

    no_volume = _priced(_contracts(), volume=0)
    assert plan_option_trade(_signal(), SPOT, DATA_DAY, _contracts(), no_volume, 5, TODAY, CFG, _risk(0.5)).status == "no_contract"


def test_no_eligible_expiry():
    plan = plan_option_trade(_signal(), SPOT, DATA_DAY, _contracts(), {}, 60, TODAY, CFG, _risk(0.5))
    assert plan.status == "no_contract"
    assert "days away" in plan.reason


def test_plan_gives_entry_limit_and_exit_prices_for_a_call():
    plan = plan_option_trade(_signal(), SPOT, DATA_DAY, _contracts(), _priced(_contracts()), 5, TODAY, BIG, _risk(0.5))
    entry, exit_ = plan.entry, plan.exit
    assert entry["limit_premium"] == round(plan.premium * 1.05, 2)
    assert entry["stock_low"] == 1845.0  # the stock's stop
    assert entry["stock_high"] == round(SPOT + 0.25 * (2130 - SPOT), 2)  # 25% of the way to target
    assert exit_["stop_stock"] == 1845.0 and exit_["target_stock"] == 2130.0
    assert 0 < exit_["stop_premium_est"] < plan.premium < exit_["target_premium_est"]
    assert exit_["stop_pnl_per_lot_est"] < 0 < exit_["target_pnl_per_lot_est"]
    assert "implied volatility" in exit_["estimate_method"]


def test_put_entry_window_runs_downward():
    plan = plan_option_trade(_signal("SELL"), SPOT, DATA_DAY, _contracts(), _priced(_contracts()), 5, TODAY, BIG, _risk(0.5))
    assert plan.entry["stock_high"] == 2035.0  # the stop is above for a SELL signal
    assert plan.entry["stock_low"] == round(SPOT - 0.25 * (SPOT - 1750), 2)
    assert plan.exit["stop_premium_est"] < plan.premium < plan.exit["target_premium_est"]

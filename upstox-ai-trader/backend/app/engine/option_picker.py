"""Turns a stock's BUY/SELL signal into one concrete option trade: which
contract (expiry + strike), how many lots, and the exit plan. Rule-based and
deliberately conservative; every rule is stated in the result so the person
can check it rather than trust it.

Rules
-----
1. Type: BUY signal -> buy a CALL (CE); SELL signal -> buy a PUT (PE). Options
   are only ever bought, never written (see app/engine/options.py).
2. Expiry: the nearest one that leaves enough time for the trade. "Enough" =
   at least 1.5x the average number of days this strategy held trades on this
   stock in its backtest, plus the 3-day expiry buffer, and never fewer than
   `min_days_to_expiry`. A signal sized for a 3-week swing should not ride on
   an option that expires in 9 days.
3. Strike: ATM, 1 strike ITM and 2 strikes ITM are priced; the one whose delta
   is closest to 0.65 wins. In-the-money options lose a smaller share of their
   price to time decay and track the stock more closely than OTM ones.
4. Liquidity: a candidate is used only if it traded (volume > 0) on the same
   day as the stock data the signal used. No trades = no reliable price.
5. Size: whole lots from the risk engine (`RiskManager.evaluate_option`),
   i.e. the same per-trade risk % and premium cap as paper trading. If even
   one lot is over the limit the result says so, with the numbers, and
   suggests zero lots instead of rounding up.
6. Exit plan: the stock's own stop-loss/target (as in paper trading and the
   options backtest), or `exit_days_before_expiry` days before expiry,
   whichever comes first.
7. Entry: a LIMIT buy at most `max_chase_pct` above the previous close
   premium, and only while the stock is still between its stop and a point
   25% of the way to its target. Past that, the reward left no longer
   justifies the same risk (risk:reward falls below ~1.5).
8. Premium at the stop / target is an estimate: Black-Scholes repricing at
   the option's own implied volatility, as if the stock got there today.
   The stock price is the real trigger; the option will usually be worth a
   bit less than this by then because of time decay.

Prices are the option's previous daily close (the scan runs before the open),
not a live quote; expect the actual fill to differ.
"""
import math
from dataclasses import dataclass, field
from datetime import date

from app.engine import options
from app.engine.candle import Candle
from app.engine.risk import AccountSnapshot, RiskManager
from app.engine.strategy import Signal

TARGET_DELTA = 0.65
ITM_STEPS = (0, 1, 2)  # 0 = ATM, then 1 and 2 strikes in-the-money


@dataclass
class PickerConfig:
    capital: float
    rate: float
    min_days_to_expiry: int = 7
    expiry_buffer_days: int = 3
    exit_days_before_expiry: int = 2
    holding_multiplier: float = 1.5
    max_chase_pct: float = 0.05
    entry_window_fraction: float = 0.25


@dataclass
class OptionTradePlan:
    status: str  # "ok" | "too_big" | "no_contract"
    reason: str = ""
    contract: dict | None = None
    premium: float | None = None
    premium_date: date | None = None
    delta: float | None = None
    lots: int = 0
    quantity: int = 0
    premium_outlay: float = 0.0
    max_loss: float = 0.0
    one_lot_risk: float = 0.0
    risk_budget: float = 0.0
    capital_needed_for_one_lot: float = 0.0
    breakeven: float | None = None
    days_to_expiry: int | None = None
    exit_by: date | None = None
    entry: dict | None = None
    exit: dict | None = None
    rules: list[str] = field(default_factory=list)
    candidates: list[dict] = field(default_factory=list)


def min_days_needed(avg_holding_days: float | None, config: PickerConfig) -> int:
    holding = avg_holding_days or 0
    return max(config.min_days_to_expiry, math.ceil(holding * config.holding_multiplier) + config.expiry_buffer_days)


def choose_expiry(contracts: list[options.OptionContract], option_type: str, today: date, days_needed: int) -> date | None:
    expiries = sorted({c.expiry for c in contracts if c.option_type == option_type and (c.expiry - today).days >= days_needed})
    return expiries[0] if expiries else None


def candidate_strikes(contracts, option_type: str, expiry: date, spot: float) -> list[options.OptionContract]:
    of_expiry = sorted((c for c in contracts if c.option_type == option_type and c.expiry == expiry), key=lambda c: c.strike)
    if not of_expiry:
        return []
    atm = min(range(len(of_expiry)), key=lambda i: abs(of_expiry[i].strike - spot))
    direction = -1 if option_type == "CE" else 1  # ITM call = lower strike; ITM put = higher strike
    picked = []
    for step in ITM_STEPS:
        i = atm + direction * step
        if 0 <= i < len(of_expiry):
            picked.append(of_expiry[i])
    return picked


def plan_option_trade(
    signal: Signal,
    spot: float,
    data_date: date,
    contracts: list[options.OptionContract],
    option_candles: dict[str, list[Candle]],
    avg_holding_days: float | None,
    today: date,
    config: PickerConfig,
    risk_manager: RiskManager | None = None,
) -> OptionTradePlan:
    """`option_candles` maps candidate instrument_key -> its daily candles
    (fetched by the caller for the contracts `candidate_strikes` returns).
    """
    option_type = options.option_type_for_signal(signal.action)
    if option_type is None:
        return OptionTradePlan(status="no_contract", reason="No BUY/SELL signal")

    days_needed = min_days_needed(avg_holding_days, config)
    expiry = choose_expiry(contracts, option_type, today, days_needed)
    rules = [
        f"{'CALL' if option_type == 'CE' else 'PUT'} because the stock signal is {signal.action}",
        f"Expiry needs ≥ {days_needed} days (backtest held trades ~{avg_holding_days or 0:.0f} days on this stock)",
    ]
    if expiry is None:
        return OptionTradePlan(status="no_contract", reason=f"No listed expiry is {days_needed}+ days away", rules=rules)

    scored = []
    candidates_info = []
    for contract in candidate_strikes(contracts, option_type, expiry, spot):
        bars = option_candles.get(contract.instrument_key) or []
        last = bars[-1] if bars else None
        info = {"trading_symbol": contract.trading_symbol, "strike": contract.strike}
        if last is None or last.timestamp.date() != data_date or last.volume <= 0 or last.close <= 0:
            info["skipped"] = "no trades on the signal day"
            candidates_info.append(info)
            continue
        delta = options.estimate_delta(last.close, spot, contract.strike, contract.expiry, data_date, option_type, config.rate)
        info.update(premium=last.close, delta=round(delta, 3) if delta else None, volume=last.volume)
        candidates_info.append(info)
        if delta:
            scored.append((abs(delta - TARGET_DELTA), contract, last, delta))

    rules.append(f"Strike: of ATM / 1 ITM / 2 ITM, the one with delta closest to {TARGET_DELTA} that traded on {data_date}")
    if not scored:
        return OptionTradePlan(
            status="no_contract",
            reason=f"None of the candidate strikes for {expiry} traded on {data_date}",
            rules=rules,
            candidates=candidates_info,
        )

    _, contract, bar, delta = min(scored, key=lambda s: s[0])
    premium = bar.close
    risk_manager = risk_manager or RiskManager()
    decision = risk_manager.evaluate_option(
        signal,
        AccountSnapshot(
            capital=config.capital,
            open_positions_count=0,
            has_open_position_in_instrument=False,
            daily_realized_pnl=0.0,
            trading_halted=False,
            daily_loss_limit_halted=False,
        ),
        premium,
        delta,
        contract.lot_size,
    )
    loss_per_unit = min(premium, delta * abs(signal.entry_price - signal.stop_loss))
    one_lot_risk = round(loss_per_unit * contract.lot_size, 2)
    risk_budget = round(config.capital * risk_manager.config.max_risk_per_trade_pct, 2)
    breakeven = contract.strike + premium if option_type == "CE" else contract.strike - premium
    exit_by = date.fromordinal(contract.expiry.toordinal() - config.exit_days_before_expiry)
    rules.append(
        f"Size: risk ≤ {risk_manager.config.max_risk_per_trade_pct:.1%} of ₹{config.capital:,.0f} per trade, "
        f"premium ≤ {risk_manager.config.option_max_premium_pct:.0%} of capital"
    )
    rules.append(
        f"Exit when the stock closes beyond its stop {signal.stop_loss} / target {signal.target}, or by {exit_by}"
    )
    entry, exit_plan = _entry_exit_levels(signal, contract, option_type, premium, data_date, exit_by, config)
    rules.append(
        f"Entry: limit ≤ ₹{entry['limit_premium']} (previous close + {config.max_chase_pct:.0%}), only while the "
        f"stock is between {entry['stock_low']} and {entry['stock_high']}"
    )

    plan = OptionTradePlan(
        status="ok" if decision.approved else "too_big",
        reason="" if decision.approved else "; ".join(decision.reasons),
        contract={
            "instrument_key": contract.instrument_key,
            "trading_symbol": contract.trading_symbol,
            "option_type": option_type,
            "strike": contract.strike,
            "expiry": contract.expiry.isoformat(),
            "lot_size": contract.lot_size,
        },
        premium=premium,
        premium_date=bar.timestamp.date(),
        delta=round(delta, 3),
        lots=decision.lots if decision.approved else 0,
        quantity=decision.quantity if decision.approved else 0,
        premium_outlay=round((decision.quantity if decision.approved else 0) * premium, 2),
        max_loss=decision.max_loss_amount if decision.approved else 0.0,
        one_lot_risk=one_lot_risk,
        risk_budget=risk_budget,
        capital_needed_for_one_lot=round(one_lot_risk / risk_manager.config.max_risk_per_trade_pct, -3),
        breakeven=round(breakeven, 2),
        days_to_expiry=(contract.expiry - today).days,
        exit_by=exit_by,
        entry=entry,
        exit=exit_plan,
        rules=rules,
        candidates=candidates_info,
    )
    return plan


def _entry_exit_levels(signal, contract, option_type, premium, data_date, exit_by, config) -> tuple[dict, dict]:
    entry_px, stop_px, target_px = signal.entry_price, signal.stop_loss, signal.target
    window = config.entry_window_fraction * (target_px - entry_px)  # negative for SELL signals
    stock_low, stock_high = sorted((stop_px, entry_px + window))

    years = options.years_to_expiry(contract.expiry, data_date)
    iv = options.implied_vol(premium, entry_px, contract.strike, years, config.rate, option_type)
    if iv is not None:
        stop_premium = options.bs_price(stop_px, contract.strike, years, config.rate, iv, option_type)
        target_premium = options.bs_price(target_px, contract.strike, years, config.rate, iv, option_type)
        method = f"Black-Scholes at implied volatility {iv:.0%}"
    else:
        delta = options.estimate_delta(premium, entry_px, contract.strike, contract.expiry, data_date, option_type, config.rate) or 0.5
        stop_premium, target_premium = options.premium_levels(premium, delta, entry_px, stop_px, target_px)
        method = "delta approximation (implied volatility could not be solved)"

    stop_premium = round(max(0.05, stop_premium), 2)
    target_premium = round(target_premium, 2)
    lot = contract.lot_size
    entry = {
        "limit_premium": round(premium * (1 + config.max_chase_pct), 2),
        "reference_premium": premium,
        "stock_low": round(stock_low, 2),
        "stock_high": round(stock_high, 2),
    }
    exit_plan = {
        "stop_stock": stop_px,
        "stop_premium_est": stop_premium,
        "stop_pnl_per_lot_est": round((stop_premium - premium) * lot, 2),
        "target_stock": target_px,
        "target_premium_est": target_premium,
        "target_pnl_per_lot_est": round((target_premium - premium) * lot, 2),
        "exit_by": exit_by.isoformat(),
        "estimate_method": method,
    }
    return entry, exit_plan

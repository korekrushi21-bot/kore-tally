"""Options backtester: signals from the UNDERLYING's candles, P&L from the real
historical candles of one CE and one PE contract (same strike and expiry).

It reuses `generate_signal`, `RiskManager.evaluate_option` and the exit rule
in app/engine/options.py, which are the same code paths options paper trading
uses, so the two cannot drift apart.

Fill assumptions (deliberately conservative, see README):
  * Entry: at the option candle's CLOSE on the bar that generated the signal,
    plus slippage. If that option has no candle on that bar (no trades), the
    signal is skipped and counted as rejected.
  * Stop-loss exit (underlying range touched the stop): at the option candle's
    LOW for that bar, i.e. the worst premium printed in that bar.
  * Target exit: at the option candle's CLOSE (not its high), so targets are
    never credited with the best print.
  * If the option has no candle on an exit bar, the position stays open until
    the next bar where it does.
  * Expiry: any position still open on/after expiry day is closed at that
    bar's option close.
No new entries are taken within `min_days_to_expiry` days of expiry.

Only currently-listed contracts can be backtested: Upstox's standard historical
candle API serves active instruments; expired contracts need its separate
expired-instruments API, which this app does not use.
"""
from dataclasses import replace
from datetime import date

from app.core.time_utils import IST
from app.engine import costs, options
from app.engine.backtest import BacktestResult, BacktestTrade, _compute_metrics
from app.engine.candle import Candle
from app.engine.risk import AccountSnapshot, RiskConfig, RiskManager
from app.engine.strategy import MIN_CANDLES, generate_signal


def run_option_backtest(
    underlying_candles: list[Candle],
    call_contract: options.OptionContract,
    call_candles: list[Candle],
    put_contract: options.OptionContract,
    put_candles: list[Candle],
    starting_capital: float,
    rate: float,
    min_days_to_expiry: int,
    train_end_date: date | None = None,
    risk_config: RiskConfig | None = None,
    trade_from: date | None = None,
) -> BacktestResult:
    """`underlying_candles` should start well before `trade_from` so the
    strategy has its 60-bar warm-up; no entries are taken before `trade_from`.
    """
    risk_manager = RiskManager(risk_config)
    contracts = {"CE": call_contract, "PE": put_contract}
    option_bars = {
        "CE": {c.timestamp: c for c in call_candles},
        "PE": {c.timestamp: c for c in put_candles},
    }
    expiry = call_contract.expiry

    open_position: dict | None = None
    trades: list[BacktestTrade] = []
    equity = starting_capital
    equity_curve = [(underlying_candles[MIN_CANDLES - 1].timestamp, equity)] if len(underlying_candles) >= MIN_CANDLES else []
    daily_state: dict[date, dict] = {}
    rejected_count = 0

    for i in range(MIN_CANDLES, len(underlying_candles)):
        bar = underlying_candles[i]
        bar_date = bar.timestamp.astimezone(IST).date()
        today = daily_state.setdefault(bar_date, {"realized_pnl": 0.0, "halted": False})

        if open_position is not None:
            option_bar = option_bars[open_position["option_type"]].get(bar.timestamp)
            if option_bar is not None:
                if bar_date >= expiry:
                    reason, price = "expiry", option_bar.close
                else:
                    reason = options.underlying_exit_reason(
                        open_position["option_type"], bar.low, bar.high,
                        open_position["underlying_stop"], open_position["underlying_target"],
                    )
                    price = option_bar.low if reason == "stop_loss" else option_bar.close
                if reason:
                    trade = _close(open_position, bar.timestamp, price, reason, train_end_date)
                    trades.append(trade)
                    today["realized_pnl"] += trade.realized_pnl
                    equity += trade.realized_pnl
                    equity_curve.append((bar.timestamp, equity))
                    if today["realized_pnl"] < 0 and abs(today["realized_pnl"]) / starting_capital >= risk_manager.config.max_daily_loss_pct:
                        today["halted"] = True
                    open_position = None

        if open_position is not None or today["halted"]:
            continue
        if trade_from is not None and bar_date < trade_from:
            continue
        if (expiry - bar_date).days < min_days_to_expiry:
            continue

        signal = generate_signal(underlying_candles[: i + 1], call_contract.underlying_key)
        option_type = options.option_type_for_signal(signal.action)
        if option_type is None:
            continue

        option_bar = option_bars[option_type].get(bar.timestamp)
        if option_bar is None or option_bar.close <= 0:
            rejected_count += 1
            continue

        contract = contracts[option_type]
        premium = option_bar.close
        delta = options.estimate_delta(premium, bar.close, contract.strike, expiry, bar_date, option_type, rate)
        decision = risk_manager.evaluate_option(
            replace(signal, is_stale=False),  # staleness is a wall-clock check, meaningless on history
            AccountSnapshot(
                capital=starting_capital,
                open_positions_count=0,
                has_open_position_in_instrument=False,
                daily_realized_pnl=today["realized_pnl"],
                trading_halted=False,
                daily_loss_limit_halted=today["halted"],
            ),
            premium,
            delta,
            contract.lot_size,
        )
        if not decision.approved:
            rejected_count += 1
            continue

        open_position = {
            "contract": contract,
            "option_type": option_type,
            "entry_date": bar.timestamp,
            "entry_price": costs.apply_slippage(premium, "BUY", is_entry=True),
            "quantity": decision.quantity,
            "underlying_stop": signal.stop_loss,
            "underlying_target": signal.target,
            "planned_risk_reward": signal.risk_reward,
        }

    if open_position is not None:
        last = _last_option_bar(option_bars[open_position["option_type"]])
        if last is not None:
            trade = _close(open_position, last.timestamp, last.close, "end_of_data", train_end_date)
            trades.append(trade)
            equity += trade.realized_pnl
            equity_curve.append((last.timestamp, equity))

    metrics = {
        "all": _compute_metrics(trades),
        "train": _compute_metrics([t for t in trades if t.period == "train"]) if train_end_date else None,
        "test": _compute_metrics([t for t in trades if t.period == "test"]) if train_end_date else None,
    }
    return BacktestResult(
        instrument_key=call_contract.underlying_key,
        starting_capital=starting_capital,
        ending_capital=round(equity, 2),
        trades=trades,
        equity_curve=equity_curve,
        rejected_signal_count=rejected_count,
        metrics=metrics,
    )


def _last_option_bar(bars: dict) -> Candle | None:
    return bars[max(bars)] if bars else None


def _close(position: dict, exit_date, exit_price: float, reason: str, train_end_date: date | None) -> BacktestTrade:
    exit_fill = costs.apply_slippage(exit_price, "BUY", is_entry=False)
    gross = (exit_fill - position["entry_price"]) * position["quantity"]
    cost = costs.estimate_round_trip_cost(position["entry_price"], exit_fill, position["quantity"])
    period = "all"
    if train_end_date is not None:
        period = "train" if position["entry_date"].astimezone(IST).date() <= train_end_date else "test"
    contract: options.OptionContract = position["contract"]
    return BacktestTrade(
        instrument_key=contract.trading_symbol or contract.instrument_key,
        side=f"BUY {position['option_type']}",
        entry_date=position["entry_date"],
        entry_price=round(position["entry_price"], 2),
        exit_date=exit_date,
        exit_price=round(exit_fill, 2),
        exit_reason=reason,
        quantity=position["quantity"],
        planned_risk_reward=position["planned_risk_reward"],
        costs=cost,
        realized_pnl=round(gross - cost, 2),
        period=period,
    )

"""Bar-by-bar backtester. Deliberately reuses the exact same `generate_signal`
and `RiskManager` used by live/paper trading (app/engine/strategy.py,
app/engine/risk.py) so a backtest can never drift from what the app would
actually do — a common and dangerous source of backtest/live mismatch.

Look-ahead bias: at bar i, the strategy only ever sees `candles[: i + 1]`
(indicators.py's own rolling windows already exclude the current bar from
support/resistance and breakout calculations too). Exits are checked against
bars strictly after entry. Nothing here ever reads a future bar.

Survivorship bias: this engine backtests ONE instrument at a time, chosen by
the caller. It cannot detect or correct for a human picking only
instruments/periods that happened to perform well — that responsibility
stays with whoever chooses what to backtest.

Known simplifications (see README): entries execute at the close of the bar
that generated the signal (same convention as live/paper trading, not a
backtest-only shortcut); when both target and stop-loss fall inside the same
bar's high/low range, the stop-loss is assumed to have hit first (the
conservative, standard assumption, since intrabar sequencing is unknown from
daily/weekly candles); the equity curve is a step function updated only on
realized trade closes, not continuously mark-to-market.
"""
from dataclasses import dataclass, field, replace
from datetime import date, datetime

from app.core.time_utils import IST
from app.engine import costs
from app.engine.candle import Candle
from app.engine.risk import AccountSnapshot, RiskConfig, RiskManager
from app.engine.strategy import MIN_CANDLES, generate_signal


@dataclass
class BacktestTrade:
    instrument_key: str
    side: str
    entry_date: datetime
    entry_price: float
    exit_date: datetime
    exit_price: float
    exit_reason: str
    quantity: int
    planned_risk_reward: float
    costs: float
    realized_pnl: float
    period: str  # "train" | "test" | "all" (when no split requested)


@dataclass
class BacktestResult:
    instrument_key: str
    starting_capital: float
    ending_capital: float
    trades: list[BacktestTrade] = field(default_factory=list)
    equity_curve: list[tuple[datetime, float]] = field(default_factory=list)
    rejected_signal_count: int = 0
    metrics: dict = field(default_factory=dict)


def run_backtest(
    candles: list[Candle],
    instrument_key: str,
    starting_capital: float,
    train_end_date: date | None = None,
    risk_config: RiskConfig | None = None,
) -> BacktestResult:
    risk_manager = RiskManager(risk_config)

    open_position: dict | None = None
    trades: list[BacktestTrade] = []
    equity = starting_capital
    equity_curve: list[tuple[datetime, float]] = (
        [(candles[MIN_CANDLES - 1].timestamp, equity)] if len(candles) >= MIN_CANDLES else []
    )
    daily_state: dict[date, dict] = {}
    rejected_count = 0

    for i in range(MIN_CANDLES, len(candles)):
        window = candles[: i + 1]
        bar = candles[i]
        bar_date = bar.timestamp.astimezone(IST).date()
        today = daily_state.setdefault(bar_date, {"realized_pnl": 0.0, "halted": False})

        if open_position is not None:
            exit_reason, exit_price = _check_exit(open_position, bar)
            if exit_reason:
                trade = _close_trade(open_position, instrument_key, bar.timestamp, exit_price, exit_reason, train_end_date)
                trades.append(trade)
                today["realized_pnl"] += trade.realized_pnl
                equity += trade.realized_pnl
                equity_curve.append((bar.timestamp, equity))
                if today["realized_pnl"] < 0 and abs(today["realized_pnl"]) / starting_capital >= risk_manager.config.max_daily_loss_pct:
                    today["halted"] = True
                open_position = None

        if open_position is None and not today["halted"]:
            signal = generate_signal(window, instrument_key)
            if signal.action in ("BUY", "SELL"):
                # Staleness is a live/paper-trading freshness check (vs wall-clock
                # now); it's meaningless when deliberately replaying history.
                decision = risk_manager.evaluate(
                    replace(signal, is_stale=False),
                    AccountSnapshot(
                        capital=starting_capital,
                        open_positions_count=0,
                        has_open_position_in_instrument=False,
                        daily_realized_pnl=today["realized_pnl"],
                        trading_halted=False,
                        daily_loss_limit_halted=today["halted"],
                    ),
                )
                if decision.approved:
                    entry_fill = costs.apply_slippage(signal.entry_price, signal.action, is_entry=True)
                    open_position = {
                        "side": signal.action,
                        "entry_date": bar.timestamp,
                        "entry_price": entry_fill,
                        "stop_loss": signal.stop_loss,
                        "target": signal.target,
                        "quantity": decision.quantity,
                        "planned_risk_reward": signal.risk_reward,
                    }
                else:
                    rejected_count += 1

    if open_position is not None:
        trade = _close_trade(open_position, instrument_key, candles[-1].timestamp, candles[-1].close, "end_of_data", train_end_date)
        trades.append(trade)
        equity += trade.realized_pnl
        equity_curve.append((candles[-1].timestamp, equity))

    metrics = {
        "all": _compute_metrics(trades),
        "train": _compute_metrics([t for t in trades if t.period == "train"]) if train_end_date else None,
        "test": _compute_metrics([t for t in trades if t.period == "test"]) if train_end_date else None,
    }

    return BacktestResult(
        instrument_key=instrument_key,
        starting_capital=starting_capital,
        ending_capital=round(equity, 2),
        trades=trades,
        equity_curve=equity_curve,
        rejected_signal_count=rejected_count,
        metrics=metrics,
    )


def _check_exit(position: dict, bar: Candle) -> tuple[str | None, float | None]:
    """Conservative assumption: if a single bar's range contains both the
    stop-loss and the target, the stop-loss is assumed hit first.
    """
    if position["side"] == "BUY":
        if bar.low <= position["stop_loss"]:
            return "stop_loss", position["stop_loss"]
        if bar.high >= position["target"]:
            return "target", position["target"]
    else:
        if bar.high >= position["stop_loss"]:
            return "stop_loss", position["stop_loss"]
        if bar.low <= position["target"]:
            return "target", position["target"]
    return None, None


def _close_trade(
    position: dict, instrument_key: str, exit_date: datetime, exit_price: float, exit_reason: str, train_end_date: date | None
) -> BacktestTrade:
    exit_fill = costs.apply_slippage(exit_price, position["side"], is_entry=False)
    direction = 1 if position["side"] == "BUY" else -1
    gross_pnl = (exit_fill - position["entry_price"]) * position["quantity"] * direction
    cost = costs.estimate_round_trip_cost(position["entry_price"], exit_fill, position["quantity"])
    realized_pnl = gross_pnl - cost

    period = "all"
    if train_end_date is not None:
        period = "train" if position["entry_date"].astimezone(IST).date() <= train_end_date else "test"

    return BacktestTrade(
        instrument_key=instrument_key,
        side=position["side"],
        entry_date=position["entry_date"],
        entry_price=round(position["entry_price"], 2),
        exit_date=exit_date,
        exit_price=round(exit_fill, 2),
        exit_reason=exit_reason,
        quantity=position["quantity"],
        planned_risk_reward=position["planned_risk_reward"],
        costs=cost,
        realized_pnl=round(realized_pnl, 2),
        period=period,
    )


def _compute_metrics(trades: list[BacktestTrade]) -> dict:
    if not trades:
        return {
            "total_trades": 0,
            "win_rate": 0.0,
            "net_pnl": 0.0,
            "gross_profit": 0.0,
            "gross_loss": 0.0,
            "profit_factor": None,
            "avg_win": 0.0,
            "avg_loss": 0.0,
            "avg_planned_risk_reward": 0.0,
            "total_costs": 0.0,
            "max_drawdown_amount": 0.0,
            "max_drawdown_pct": 0.0,
        }

    wins = [t for t in trades if t.realized_pnl > 0]
    losses = [t for t in trades if t.realized_pnl <= 0]
    gross_profit = sum(t.realized_pnl for t in wins)
    gross_loss = abs(sum(t.realized_pnl for t in losses))

    cumulative = 0.0
    peak = 0.0
    max_drawdown_amount = 0.0
    max_drawdown_pct = 0.0
    for t in trades:
        cumulative += t.realized_pnl
        peak = max(peak, cumulative)
        drawdown = peak - cumulative
        max_drawdown_amount = max(max_drawdown_amount, drawdown)
        if peak > 0:
            max_drawdown_pct = max(max_drawdown_pct, drawdown / peak)

    return {
        "total_trades": len(trades),
        "win_rate": round(len(wins) / len(trades), 4),
        "net_pnl": round(sum(t.realized_pnl for t in trades), 2),
        "gross_profit": round(gross_profit, 2),
        "gross_loss": round(gross_loss, 2),
        "profit_factor": round(gross_profit / gross_loss, 2) if gross_loss > 0 else None,
        "avg_win": round(gross_profit / len(wins), 2) if wins else 0.0,
        "avg_loss": round(-gross_loss / len(losses), 2) if losses else 0.0,
        "avg_planned_risk_reward": round(sum(t.planned_risk_reward for t in trades) / len(trades), 2),
        "total_costs": round(sum(t.costs for t in trades), 2),
        "max_drawdown_amount": round(max_drawdown_amount, 2),
        "max_drawdown_pct": round(max_drawdown_pct, 4),
    }

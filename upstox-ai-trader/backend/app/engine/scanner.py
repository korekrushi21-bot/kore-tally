"""Morning scanner: runs the strategy over every F&O stock and backtests it on
that same stock, so each signal comes with evidence of how this exact rule set
has actually done on that stock.

For each stock:
  * signal   - `generate_signal` on the last ~150 calendar days of daily
               candles, the same window the dashboard's Strategy Signal uses, so
               a stock's scan result matches what "Get Signal" shows.
  * backtest - `run_backtest` (same strategy + risk engine as paper trading)
               over the last `backtest_years` years.
  * verdict  - a plain summary of that backtest: "supports", "mixed",
               "against" or "too_few" trades to judge.

These are rule-based signals, not recommendations. The verdict is shown next
to every signal precisely so a BUY on a stock where the strategy has lost money
historically is visibly marked as such.
"""
import asyncio
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.exceptions import UpstoxAPIError
from app.db.models import ScanOptionPlan, ScanResult, ScanResultStats, ScanRun
from app.engine import indicators, option_picker
from app.engine.backtest import run_backtest
from app.engine.candle import Candle, candles_from_upstox
from app.engine.options import OptionContract
from app.engine.strategy import MIN_CANDLES, Signal, generate_signal

SIGNAL_WINDOW_DAYS = 150
VERDICT_RANK = {"supports": 0, "mixed": 1, "too_few": 2, "against": 3, "": 4}


@dataclass
class ScanConfig:
    backtest_years: int = 2
    starting_capital: float = 100_000.0
    max_concurrency: int = 3
    min_seconds_between_requests: float = 0.25
    min_trades_for_verdict: int = 5
    supports_profit_factor: float = 1.3
    option_rate: float = 0.065
    # Risk engine for option sizing uses the app's own risk settings; this is the
    # capital those percentages apply to.
    option_capital: float | None = None


@dataclass
class StockOutcome:
    action: str
    strength: float = 0.0
    last_close: float | None = None
    data_date: date | None = None
    signal: dict = field(default_factory=dict)
    backtest: dict = field(default_factory=dict)
    verdict: str = ""
    error: str | None = None
    signal_obj: Signal | None = None
    avg_holding_days: float | None = None
    option_plan: dict | None = None
    stats: dict | None = None


def backtest_verdict(metrics: dict, config: ScanConfig) -> str:
    trades = metrics.get("total_trades", 0)
    if trades < config.min_trades_for_verdict:
        return "too_few"
    pf = metrics.get("profit_factor")
    net = metrics.get("net_pnl", 0.0)
    if pf is None:  # no losing trades at all
        return "supports" if net > 0 else "mixed"
    if pf >= config.supports_profit_factor and net > 0:
        return "supports"
    if pf >= 1.0:
        return "mixed"
    return "against"


def analyse_stock(candles: list[Candle], instrument_key: str, config: ScanConfig) -> StockOutcome:
    if len(candles) <= MIN_CANDLES:
        return StockOutcome(action="NO_TRADE", error=f"Only {len(candles)} candles available")

    last = candles[-1]
    cutoff = last.timestamp - timedelta(days=SIGNAL_WINDOW_DAYS)
    recent = [c for c in candles if c.timestamp >= cutoff]
    sig = generate_signal(recent, instrument_key)

    result = run_backtest(candles, instrument_key, config.starting_capital)
    metrics = result.metrics["all"]
    held = [(t.exit_date - t.entry_date).days for t in result.trades]
    avg_holding_days = sum(held) / len(held) if held else None

    return StockOutcome(
        action=sig.action,
        strength=sig.strength,
        last_close=last.close,
        data_date=last.timestamp.date(),
        signal={
            "entry_price": sig.entry_price,
            "stop_loss": sig.stop_loss,
            "target": sig.target,
            "risk_reward": sig.risk_reward,
            "reasons": sig.reasons,
        },
        backtest=metrics,
        verdict=backtest_verdict(metrics, config),
        signal_obj=sig,
        avg_holding_days=avg_holding_days,
        stats=movement_stats(candles),
    )


MOVE_WINDOW = 20


def movement_stats(candles: list[Candle]) -> dict:
    """How fast a stock usually moves: ATR14 as % of the last close, the mean
    absolute daily % change over the last 20 sessions, and the last session's
    % change."""
    last = candles[-1]
    atr_series = indicators.atr(candles, 14)
    atr_pct = atr_series[-1] / last.close * 100 if atr_series[-1] and last.close else None
    closes = [c.close for c in candles[-(MOVE_WINDOW + 1):]]
    moves = [abs(b - a) / a * 100 for a, b in zip(closes, closes[1:]) if a]
    day = (closes[-1] - closes[-2]) / closes[-2] * 100 if len(closes) >= 2 and closes[-2] else None
    return {
        "atr_pct": round(atr_pct, 2) if atr_pct is not None else None,
        "avg_move_pct": round(sum(moves) / len(moves), 2) if moves else None,
        "last_day_change_pct": round(day, 2) if day is not None else None,
    }


class _Throttle:
    def __init__(self, min_interval: float):
        self._min_interval = min_interval
        self._lock = asyncio.Lock()
        self._last = 0.0

    async def wait(self):
        async with self._lock:
            loop = asyncio.get_running_loop()
            delay = self._last + self._min_interval - loop.time()
            if delay > 0:
                await asyncio.sleep(delay)
            self._last = loop.time()


async def _fetch_candles(client, instrument_key: str, to_day: date, from_day: date, throttle: _Throttle) -> list[Candle]:
    for attempt in range(3):
        await throttle.wait()
        try:
            response = await client.get_historical_candles(
                instrument_key, "days", 1, to_day.isoformat(), from_day.isoformat()
            )
            return candles_from_upstox(response.get("data", {}).get("candles", []))
        except UpstoxAPIError as exc:
            if exc.status_code == 429 and attempt < 2:  # rate limited: back off and retry
                await asyncio.sleep(2 * (attempt + 1))
                continue
            raise
    return []


async def _option_plan(
    client, outcome: StockOutcome, contracts: list[OptionContract], today: date, config: ScanConfig, throttle
) -> dict:
    """Prices the candidate strikes from their daily candles (public data, no
    login) and asks option_picker for one concrete trade. Tries the first two
    eligible expiries in case nothing traded in the nearer one.
    """
    sig = outcome.signal_obj
    picker_config = option_picker.PickerConfig(
        capital=config.option_capital or config.starting_capital, rate=config.option_rate
    )
    option_type = "CE" if sig.action == "BUY" else "PE"
    days_needed = option_picker.min_days_needed(outcome.avg_holding_days, picker_config)
    expiries = sorted({c.expiry for c in contracts if c.option_type == option_type and (c.expiry - today).days >= days_needed})
    plan = None
    for expiry in expiries[:2]:
        of_expiry = [c for c in contracts if c.expiry == expiry]
        candles: dict[str, list[Candle]] = {}
        for contract in option_picker.candidate_strikes(of_expiry, option_type, expiry, outcome.last_close):
            try:
                candles[contract.instrument_key] = await _fetch_candles(
                    client, contract.instrument_key, today, outcome.data_date - timedelta(days=10), throttle
                )
            except UpstoxAPIError:
                candles[contract.instrument_key] = []
        plan = option_picker.plan_option_trade(
            sig, outcome.last_close, outcome.data_date, of_expiry, candles, outcome.avg_holding_days, today, picker_config
        )
        if plan.status != "no_contract":
            break
    if plan is None:
        plan = option_picker.plan_option_trade(
            sig, outcome.last_close, outcome.data_date, [], {}, outcome.avg_holding_days, today, picker_config
        )
    return plan_to_dict(plan)


def plan_to_dict(plan) -> dict:
    return {
        "status": plan.status,
        "reason": plan.reason,
        "contract": plan.contract,
        "premium": plan.premium,
        "premium_date": plan.premium_date.isoformat() if plan.premium_date else None,
        "delta": plan.delta,
        "lots": plan.lots,
        "quantity": plan.quantity,
        "premium_outlay": plan.premium_outlay,
        "max_loss": plan.max_loss,
        "one_lot_risk": plan.one_lot_risk,
        "risk_budget": plan.risk_budget,
        "capital_needed_for_one_lot": plan.capital_needed_for_one_lot,
        "breakeven": plan.breakeven,
        "days_to_expiry": plan.days_to_expiry,
        "exit_by": plan.exit_by.isoformat() if plan.exit_by else None,
        "entry": plan.entry,
        "exit": plan.exit,
        "rules": plan.rules,
        "candidates": plan.candidates,
    }


async def run_scan(
    db: Session,
    client,
    universe: list[dict],
    today: date,
    trigger: str = "manual",
    config: ScanConfig | None = None,
    run: ScanRun | None = None,
    options_by_underlying: dict[str, list[OptionContract]] | None = None,
) -> ScanRun:
    config = config or ScanConfig()
    if run is None:
        run = ScanRun(trigger=trigger, status="RUNNING")
        db.add(run)
    run.universe_size = len(universe)
    db.commit()

    from_day = today - timedelta(days=365 * config.backtest_years + SIGNAL_WINDOW_DAYS)
    throttle = _Throttle(config.min_seconds_between_requests)
    semaphore = asyncio.Semaphore(config.max_concurrency)

    async def scan_one(stock: dict) -> tuple[dict, StockOutcome]:
        async with semaphore:
            try:
                candles = await _fetch_candles(client, stock["instrument_key"], today, from_day, throttle)
                outcome = analyse_stock(candles, stock["instrument_key"], config)
                contracts = (options_by_underlying or {}).get(stock["instrument_key"])
                if outcome.action in ("BUY", "SELL") and contracts:
                    try:
                        outcome.option_plan = await _option_plan(client, outcome, contracts, today, config, throttle)
                    except Exception as exc:  # a pricing failure must not lose the stock signal
                        outcome.option_plan = {"status": "no_contract", "reason": f"{type(exc).__name__}: {exc}"[:200]}
                return stock, outcome
            except UpstoxAPIError as exc:
                return stock, StockOutcome(action="ERROR", error=f"Upstox {exc.status_code}: {exc.message}"[:256])
            except Exception as exc:  # one bad stock must not kill the whole scan
                return stock, StockOutcome(action="ERROR", error=f"{type(exc).__name__}: {exc}"[:256])

    try:
        outcomes = await asyncio.gather(*(scan_one(s) for s in universe))
        data_dates = []
        for stock, outcome in outcomes:
            row = _result_row(run.id, stock, outcome)
            db.add(row)
            if outcome.option_plan is not None or outcome.stats is not None:
                db.flush()
            if outcome.option_plan is not None:
                db.add(ScanOptionPlan(result_id=row.id, plan=outcome.option_plan))
            if outcome.stats is not None:
                db.add(ScanResultStats(result_id=row.id, **outcome.stats))
            if outcome.action == "ERROR":
                run.error_count += 1
            else:
                run.scanned_count += 1
            if outcome.data_date:
                data_dates.append(outcome.data_date)
        run.data_date = max(data_dates) if data_dates else None
        run.status = "DONE" if run.scanned_count else "FAILED"
        if not run.scanned_count:
            run.message = "No stock could be scanned; see per-stock errors"
    except Exception as exc:
        run.status = "FAILED"
        run.message = f"{type(exc).__name__}: {exc}"[:512]
    run.finished_at = datetime.now(timezone.utc)
    db.commit()
    return run


def _result_row(run_id: int, stock: dict, outcome: StockOutcome) -> ScanResult:
    sig, bt = outcome.signal, outcome.backtest
    return ScanResult(
        run_id=run_id,
        instrument_key=stock["instrument_key"],
        symbol=stock.get("symbol", ""),
        name=stock.get("name", ""),
        lot_size=stock.get("lot_size", 0),
        last_close=outcome.last_close,
        action=outcome.action,
        strength=outcome.strength,
        entry_price=sig.get("entry_price"),
        stop_loss=sig.get("stop_loss"),
        target=sig.get("target"),
        risk_reward=sig.get("risk_reward"),
        reasons=sig.get("reasons"),
        bt_trades=bt.get("total_trades", 0),
        bt_win_rate=bt.get("win_rate"),
        bt_profit_factor=bt.get("profit_factor"),
        bt_net_pnl=bt.get("net_pnl"),
        bt_max_drawdown_pct=bt.get("max_drawdown_pct"),
        bt_verdict=outcome.verdict,
        error=outcome.error,
    )


STALE_RUN_AFTER = timedelta(minutes=20)  # a full scan normally takes about 2 minutes


def clear_stale_runs(db: Session, now: datetime | None = None, max_age: timedelta = STALE_RUN_AFTER) -> int:
    """Marks scans stuck at RUNNING (process killed, PC shut down, console
    window closed) as FAILED, so they can't block every later scan forever.
    Returns how many were cleared."""
    now = now or datetime.now(timezone.utc)
    cleared = 0
    for run in db.scalars(select(ScanRun).where(ScanRun.status == "RUNNING")):
        started = run.started_at if run.started_at.tzinfo else run.started_at.replace(tzinfo=timezone.utc)
        if now - started > max_age:
            run.status = "FAILED"
            run.finished_at = now
            run.message = "Interrupted: the scan process stopped before finishing (window closed or PC shut down?)"
            cleared += 1
    if cleared:
        db.commit()
    return cleared


def latest_run(db: Session) -> ScanRun | None:
    return db.scalar(select(ScanRun).order_by(ScanRun.id.desc()).limit(1))


def latest_done_run(db: Session) -> ScanRun | None:
    return db.scalar(select(ScanRun).where(ScanRun.status == "DONE").order_by(ScanRun.id.desc()).limit(1))


def option_plans(db: Session, run_id: int) -> dict[int, dict]:
    rows = db.execute(
        select(ScanOptionPlan.result_id, ScanOptionPlan.plan)
        .join(ScanResult, ScanResult.id == ScanOptionPlan.result_id)
        .where(ScanResult.run_id == run_id)
    )
    return {result_id: plan for result_id, plan in rows}


def result_stats(db: Session, run_id: int) -> dict[int, dict]:
    rows = db.execute(
        select(ScanResultStats)
        .join(ScanResult, ScanResult.id == ScanResultStats.result_id)
        .where(ScanResult.run_id == run_id)
    ).scalars()
    return {
        s.result_id: {
            "atr_pct": s.atr_pct,
            "avg_move_pct": s.avg_move_pct,
            "last_day_change_pct": s.last_day_change_pct,
        }
        for s in rows
    }


def ranked_results(db: Session, run_id: int) -> list[ScanResult]:
    rows = list(db.scalars(select(ScanResult).where(ScanResult.run_id == run_id)))
    return sorted(
        rows,
        key=lambda r: (
            0 if r.action in ("BUY", "SELL") else 1,
            VERDICT_RANK.get(r.bt_verdict, 4),
            -(r.strength or 0),
            -(r.bt_profit_factor if r.bt_profit_factor is not None else 99),
            r.symbol,
        ),
    )

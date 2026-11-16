"""Morning scan endpoints. A scan runs in the background (it makes ~200
candle requests, about a minute); the dashboard polls /scan/latest.
"""
import asyncio
import time

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.exceptions import NotAuthenticatedError, TokenExpiredError
from app.core.time_utils import today_ist
from app.db import base as db_base
from app.db.base import get_db
from app.db.models import ScanRun
from app.api.deps import get_authenticated_client
from app.engine import market_context, scanner
from app.services.auth_service import get_active_session, get_decrypted_token
from app.core.config import get_settings
from app.services.instruments import load_fno_data
from app.services.upstox_client import UpstoxClient

router = APIRouter(prefix="/scan", tags=["scan"])

_scan_lock = asyncio.Lock()


def scan_client(db: Session) -> UpstoxClient:
    """Uses the logged-in session when there is one; otherwise an anonymous
    client, which is enough for the public candle data the scan needs.
    """
    try:
        return UpstoxClient(access_token=get_decrypted_token(get_active_session(db)))
    except (NotAuthenticatedError, TokenExpiredError):
        return UpstoxClient(access_token=None)


async def execute_scan(run_id: int, trigger: str, limit: int | None = None) -> None:
    db = db_base.SessionLocal()
    try:
        run = db.get(ScanRun, run_id)
        try:
            fno = await load_fno_data(today_ist())
        except Exception as exc:
            run.status, run.message = "FAILED", f"Could not load the F&O stock list: {exc}"[:512]
            db.commit()
            return
        universe = fno.universe[:limit] if limit else fno.universe
        settings = get_settings()
        config = scanner.ScanConfig()
        config.option_capital = settings.paper_trading_starting_capital
        config.option_rate = settings.option_risk_free_rate
        await scanner.run_scan(
            db, scan_client(db), universe, today_ist(), trigger=trigger, run=run,
            config=config, options_by_underlying=fno.options,
        )
    finally:
        db.close()


@router.post("/run")
async def start_scan(background: BackgroundTasks, limit: int | None = None, db: Session = Depends(get_db)):
    if not _scan_lock.locked():
        scanner.clear_stale_runs(db)
    if _scan_lock.locked() or db.scalar(select(ScanRun).where(ScanRun.status == "RUNNING").limit(1)):
        raise HTTPException(status_code=409, detail="A scan is already running")
    run = ScanRun(trigger="manual", status="RUNNING")
    db.add(run)
    db.commit()
    db.refresh(run)

    async def _job():
        async with _scan_lock:
            await execute_scan(run.id, "manual", limit)

    background.add_task(_job)
    return run_dict(run)


@router.get("/latest")
def latest(db: Session = Depends(get_db)):
    """Results of the newest FINISHED scan, so a scan that is running (or was
    killed) never blanks the list. `in_progress` / `latest_attempt` describe a
    newer run that hasn't finished or failed. Stuck runs are cleared here too,
    so a killed scan doesn't show "running" until someone clicks Scan now.
    """
    if not _scan_lock.locked():
        scanner.clear_stale_runs(db)
    newest = scanner.latest_run(db)
    if newest is None:
        return {"run": None, "in_progress": None, "latest_attempt": None, "results": []}
    shown = scanner.latest_done_run(db) or newest
    newer = newest if newest.id != shown.id else None
    plans = scanner.option_plans(db, shown.id)
    return {
        "run": run_dict(shown),
        "in_progress": run_dict(newer) if newer is not None and newer.status == "RUNNING" else None,
        "latest_attempt": run_dict(newer) if newer is not None else None,
        "results": [result_dict(r, plans.get(r.id)) for r in scanner.ranked_results(db, shown.id)]
        if shown.status == "DONE"
        else [],
    }


_context_cache: dict = {}
_CONTEXT_TTL_SECONDS = 600


@router.get("/context")
async def context(db: Session = Depends(get_db), client: UpstoxClient = Depends(get_authenticated_client)):
    """Upstox Smartlist ranks + latest news for the latest scan's BUY/SELL
    stocks. Needs the daily login (both Upstox APIs require it). Cached for
    10 minutes per scan run to stay well inside Upstox's rate limits.
    """
    run = scanner.latest_done_run(db)
    if run is None:
        return {"run_id": None, "stocks": {}, "smartlist_timestamp": None, "errors": []}
    cached = _context_cache.get(run.id)
    if cached and time.monotonic() - cached[0] < _CONTEXT_TTL_SECONDS:
        return cached[1]

    keys = [r.instrument_key for r in scanner.ranked_results(db, run.id) if r.action in ("BUY", "SELL")]
    fno = await load_fno_data(today_ist())
    result = {"run_id": run.id, **await market_context.fetch_context(client, keys, fno.future_to_underlying or {})}
    _context_cache.clear()
    _context_cache[run.id] = (time.monotonic(), result)
    return result


@router.get("/runs")
def runs(db: Session = Depends(get_db)):
    rows = db.scalars(select(ScanRun).order_by(ScanRun.id.desc()).limit(30))
    return [run_dict(r) for r in rows]


def run_dict(run: ScanRun) -> dict:
    return {
        "id": run.id,
        "status": run.status,
        "trigger": run.trigger,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "universe_size": run.universe_size,
        "scanned_count": run.scanned_count,
        "error_count": run.error_count,
        "data_date": run.data_date.isoformat() if run.data_date else None,
        "message": run.message,
    }


def result_dict(r, option_plan: dict | None = None) -> dict:
    return {
        "instrument_key": r.instrument_key,
        "symbol": r.symbol,
        "name": r.name,
        "lot_size": r.lot_size,
        "last_close": r.last_close,
        "action": r.action,
        "strength": r.strength,
        "entry_price": r.entry_price,
        "stop_loss": r.stop_loss,
        "target": r.target,
        "risk_reward": r.risk_reward,
        "reasons": r.reasons or [],
        "backtest": {
            "trades": r.bt_trades,
            "win_rate": r.bt_win_rate,
            "profit_factor": r.bt_profit_factor,
            "net_pnl": r.bt_net_pnl,
            "max_drawdown_pct": r.bt_max_drawdown_pct,
            "verdict": r.bt_verdict,
        },
        "error": r.error,
        "option_plan": option_plan,
    }

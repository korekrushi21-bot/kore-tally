"""Morning scan endpoints. A scan runs in the background (it makes ~200
candle requests, about a minute); the dashboard polls /scan/latest.
"""
import asyncio

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.exceptions import NotAuthenticatedError, TokenExpiredError
from app.core.time_utils import today_ist
from app.db import base as db_base
from app.db.base import get_db
from app.db.models import ScanRun
from app.engine import scanner
from app.services.auth_service import get_active_session, get_decrypted_token
from app.services.instruments import load_fno_universe
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
            universe = await load_fno_universe(today_ist())
        except Exception as exc:
            run.status, run.message = "FAILED", f"Could not load the F&O stock list: {exc}"[:512]
            db.commit()
            return
        if limit:
            universe = universe[:limit]
        await scanner.run_scan(db, scan_client(db), universe, today_ist(), trigger=trigger, run=run)
    finally:
        db.close()


@router.post("/run")
async def start_scan(background: BackgroundTasks, limit: int | None = None, db: Session = Depends(get_db)):
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
    run = scanner.latest_run(db)
    if run is None:
        return {"run": None, "results": []}
    return {"run": run_dict(run), "results": [result_dict(r) for r in scanner.ranked_results(db, run.id)]}


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


def result_dict(r) -> dict:
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
    }

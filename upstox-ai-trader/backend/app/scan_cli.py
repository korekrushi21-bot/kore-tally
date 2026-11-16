"""Command-line entry point for the morning scan, used by Windows Task Scheduler.

    cd upstox-ai-trader\\backend
    .venv\\Scripts\\python -m app.scan_cli

Runs one full scan into the same database the dashboard reads, and appends a
one-line summary to backend/logs/scan.log. The backend server does not need to
be running. No Upstox login is needed: the daily candles it uses are public.
"""
import asyncio
import sys
from datetime import datetime
from pathlib import Path

from app.api.routes.scan import execute_scan
from app.db.base import Base, SessionLocal, engine
from app.db.models import ScanRun
from app.engine.scanner import clear_stale_runs

_LOG = Path(__file__).resolve().parents[1] / "logs" / "scan.log"


def main() -> int:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        cleared = clear_stale_runs(db)
        if cleared:
            _log(f"cleared {cleared} stale RUNNING scan(s)")
        if db.query(ScanRun).filter(ScanRun.status == "RUNNING").first():
            _log("skipped: another scan is marked RUNNING")
            return 1
        run = ScanRun(trigger="scheduled", status="RUNNING")
        db.add(run)
        db.commit()
        run_id = run.id
    finally:
        db.close()

    asyncio.run(execute_scan(run_id, "scheduled"))

    db = SessionLocal()
    try:
        run = db.get(ScanRun, run_id)
        _log(
            f"run {run.id}: {run.status}, scanned {run.scanned_count}/{run.universe_size}, "
            f"errors {run.error_count}, data date {run.data_date}, {run.message or ''}"
        )
        return 0 if run.status == "DONE" else 2
    finally:
        db.close()


def _log(line: str) -> None:
    _LOG.parent.mkdir(parents=True, exist_ok=True)
    with _LOG.open("a", encoding="utf-8") as f:
        f.write(f"{datetime.now().isoformat(timespec='seconds')} {line}\n")
    print(line)


if __name__ == "__main__":
    sys.exit(main())

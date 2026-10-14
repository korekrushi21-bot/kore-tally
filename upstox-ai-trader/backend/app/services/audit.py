from sqlalchemy.orm import Session

from app.db.models import AuditLog


def record(db: Session, event_type: str, detail: dict | None = None) -> None:
    db.add(AuditLog(event_type=event_type, detail=detail or {}))
    db.commit()

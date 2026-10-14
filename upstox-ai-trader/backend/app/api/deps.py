from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.exceptions import NotAuthenticatedError, TokenExpiredError
from app.db.base import get_db
from app.db.models import BrokerSession
from app.services.auth_service import get_active_session, get_decrypted_token
from app.services.upstox_client import UpstoxClient


def get_authenticated_client(db: Session = Depends(get_db)) -> UpstoxClient:
    try:
        session: BrokerSession = get_active_session(db)
    except NotAuthenticatedError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except TokenExpiredError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    return UpstoxClient(access_token=get_decrypted_token(session))


def get_optional_upstox_client(db: Session = Depends(get_db)) -> UpstoxClient | None:
    """Like get_authenticated_client, but returns None instead of raising
    when there's no valid session — for endpoints that can still do
    something useful (e.g. mark positions at last-known entry price) without
    a live connection.
    """
    try:
        session: BrokerSession = get_active_session(db)
    except (NotAuthenticatedError, TokenExpiredError):
        return None
    return UpstoxClient(access_token=get_decrypted_token(session))

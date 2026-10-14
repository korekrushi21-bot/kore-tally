from datetime import datetime, timezone
from urllib.parse import urlencode

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.crypto import decrypt, encrypt
from app.core.exceptions import NotAuthenticatedError, TokenExpiredError
from app.core.state_token import issue_state, verify_state
from app.core.time_utils import upstox_token_expiry
from app.db.models import BrokerSession
from app.services import audit
from app.services.upstox_client import UpstoxClient


def build_authorization_url() -> tuple[str, str]:
    """Returns (authorization_url, state). The caller is responsible for
    handing `state` back to the client (e.g. as the only thing round-tripped
    through the redirect) so verify_state can check it on callback.
    """
    settings = get_settings()
    state = issue_state()
    params = {
        "client_id": settings.upstox_client_id,
        "redirect_uri": settings.upstox_redirect_uri,
        "response_type": "code",
        "state": state,
    }
    url = f"{settings.upstox_api_base}/v2/login/authorization/dialog?{urlencode(params)}"
    return url, state


async def complete_login(db: Session, code: str, state: str) -> BrokerSession:
    if not verify_state(state):
        audit.record(db, "auth.state_invalid")
        raise ValueError("Invalid or expired OAuth state parameter")

    client = UpstoxClient()
    token_response = await client.exchange_authorization_code(code)

    access_token = token_response.get("access_token")
    if not access_token:
        audit.record(db, "auth.token_exchange_failed", {"response_keys": list(token_response.keys())})
        raise ValueError("Upstox did not return an access_token")

    now = datetime.now(timezone.utc)
    expires_at = upstox_token_expiry(now)

    # Only one active session in this single-user app: deactivate any prior one.
    db.query(BrokerSession).filter(BrokerSession.is_active.is_(True)).update({"is_active": False})

    session = BrokerSession(
        upstox_user_id=str(token_response.get("user_id", "unknown")),
        upstox_user_name=token_response.get("user_name"),
        access_token_encrypted=encrypt(access_token),
        token_generated_at=now,
        token_expires_at=expires_at,
        is_active=True,
    )
    db.add(session)
    db.commit()
    db.refresh(session)

    audit.record(db, "auth.login_success", {"upstox_user_id": session.upstox_user_id})
    return session


def get_active_session(db: Session) -> BrokerSession:
    session = db.scalar(
        select(BrokerSession).where(BrokerSession.is_active.is_(True)).order_by(BrokerSession.id.desc())
    )
    if session is None:
        raise NotAuthenticatedError("No Upstox session has been connected yet")

    if datetime.now(timezone.utc) >= session.token_expires_at.replace(tzinfo=timezone.utc):
        audit.record(db, "auth.token_expired", {"upstox_user_id": session.upstox_user_id})
        raise TokenExpiredError(
            "Access token expired at 03:30 IST. Upstox requires a fresh manual login — "
            "automated re-authentication is against Upstox policy."
        )
    return session


def get_decrypted_token(session: BrokerSession) -> str:
    return decrypt(session.access_token_encrypted)


def disconnect(db: Session) -> None:
    session = db.scalar(select(BrokerSession).where(BrokerSession.is_active.is_(True)))
    if session is None:
        return
    session.is_active = False
    db.commit()
    audit.record(db, "auth.disconnected", {"upstox_user_id": session.upstox_user_id})

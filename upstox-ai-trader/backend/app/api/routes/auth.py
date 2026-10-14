from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.core.exceptions import NotAuthenticatedError, TokenExpiredError
from app.db.base import get_db
from app.services import auth_service

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/login")
def login():
    url, _state = auth_service.build_authorization_url()
    # `state` is self-contained (signed + timestamped), so nothing needs to
    # be stored server-side between the redirect out and the callback in.
    return RedirectResponse(url)


@router.get("/callback")
async def callback(code: str, state: str, db: Session = Depends(get_db)):
    try:
        await auth_service.complete_login(db, code=code, state=state)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return HTMLResponse(
        "<html><body><h3>Upstox account connected.</h3>"
        "<p>You can close this tab and return to the app.</p></body></html>"
    )


@router.get("/status")
def status(db: Session = Depends(get_db)):
    try:
        session = auth_service.get_active_session(db)
    except NotAuthenticatedError:
        return {"connected": False}
    except TokenExpiredError as exc:
        return {"connected": False, "reason": str(exc)}

    return {
        "connected": True,
        "upstox_user_id": session.upstox_user_id,
        "token_generated_at": session.token_generated_at,
        "token_expires_at": session.token_expires_at,
    }


@router.post("/disconnect")
def disconnect(db: Session = Depends(get_db)):
    auth_service.disconnect(db)
    return {"connected": False}

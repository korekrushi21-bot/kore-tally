"""Signs/verifies the OAuth2 `state` parameter so the callback can detect CSRF
or a forged redirect, without needing server-side session storage.
"""
import hashlib
import hmac
import secrets
import time

from app.core.config import get_settings

_MAX_AGE_SECONDS = 600  # state must be redeemed within 10 minutes


def issue_state() -> str:
    nonce = secrets.token_urlsafe(16)
    timestamp = str(int(time.time()))
    payload = f"{nonce}.{timestamp}"
    signature = _sign(payload)
    return f"{payload}.{signature}"


def verify_state(state: str) -> bool:
    try:
        nonce, timestamp, signature = state.split(".")
    except ValueError:
        return False

    payload = f"{nonce}.{timestamp}"
    expected_signature = _sign(payload)
    if not hmac.compare_digest(expected_signature, signature):
        return False

    age = time.time() - int(timestamp)
    return 0 <= age <= _MAX_AGE_SECONDS


def _sign(payload: str) -> str:
    key = get_settings().session_secret.encode()
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
_EXPIRY_TIME = time(hour=3, minute=30)


def today_ist() -> date:
    return datetime.now(timezone.utc).astimezone(IST).date()


def upstox_token_expiry(generated_at_utc: datetime) -> datetime:
    """Upstox access tokens always expire at 03:30 IST on the next occurrence
    of that time strictly after generation (Upstox does not issue refresh
    tokens; re-authentication is a manual, once-daily user action).
    Returns the expiry as a UTC-aware datetime.
    """
    generated_at_ist = generated_at_utc.astimezone(IST)
    candidate = generated_at_ist.replace(
        hour=_EXPIRY_TIME.hour, minute=_EXPIRY_TIME.minute, second=0, microsecond=0
    )
    if candidate <= generated_at_ist:
        candidate += timedelta(days=1)
    return candidate.astimezone(ZoneInfo("UTC"))

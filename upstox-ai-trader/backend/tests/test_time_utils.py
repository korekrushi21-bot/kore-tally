from datetime import datetime
from zoneinfo import ZoneInfo

from app.core.time_utils import upstox_token_expiry

IST = ZoneInfo("Asia/Kolkata")


def test_evening_token_expires_next_morning():
    generated = datetime(2026, 1, 10, 20, 0, tzinfo=IST)  # 8 PM
    expiry = upstox_token_expiry(generated).astimezone(IST)
    assert expiry.date().isoformat() == "2026-01-11"
    assert (expiry.hour, expiry.minute) == (3, 30)


def test_token_just_before_cutoff_expires_same_morning():
    generated = datetime(2026, 1, 10, 2, 30, tzinfo=IST)
    expiry = upstox_token_expiry(generated).astimezone(IST)
    assert expiry.date().isoformat() == "2026-01-10"
    assert (expiry.hour, expiry.minute) == (3, 30)


def test_token_just_after_cutoff_expires_next_day():
    generated = datetime(2026, 1, 10, 4, 0, tzinfo=IST)
    expiry = upstox_token_expiry(generated).astimezone(IST)
    assert expiry.date().isoformat() == "2026-01-11"
    assert (expiry.hour, expiry.minute) == (3, 30)

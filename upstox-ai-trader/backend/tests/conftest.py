import os

os.environ.setdefault("UPSTOX_CLIENT_ID", "test_client_id")
os.environ.setdefault("UPSTOX_CLIENT_SECRET", "test_client_secret")
os.environ.setdefault("UPSTOX_REDIRECT_URI", "http://localhost:8000/auth/callback")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("TOKEN_ENCRYPTION_KEY", "4EOLNVpd54w-s1lTavg3zjYF1yp8bSRMVZ4kb9iJlVk=")
os.environ.setdefault("SESSION_SECRET", "test-session-secret")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base, get_db
from app.main import app


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def client(db_session):
    def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def live_enabled(monkeypatch):
    """Flips LIVE_TRADING_ENABLED on and speeds up fill-polling for the
    duration of a test. Settings is process-wide and lru_cache'd, so this
    clears that cache on both sides of the test to avoid leaking into
    unrelated tests.
    """
    from app.core.config import get_settings

    monkeypatch.setenv("LIVE_TRADING_ENABLED", "true")
    monkeypatch.setenv("LIVE_ENTRY_FILL_POLL_INTERVAL_SECONDS", "0.01")
    monkeypatch.setenv("LIVE_ENTRY_FILL_POLL_ATTEMPTS", "2")
    monkeypatch.setenv("LIVE_DUPLICATE_GUARD_SECONDS", "10")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()

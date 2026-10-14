import math
from datetime import datetime, timedelta, timezone

import respx
from httpx import Response

from app.core.state_token import issue_state


def _connect(client):
    with respx.mock:
        respx.post("https://api.upstox.com/v2/login/authorization/token").mock(
            return_value=Response(200, json={"access_token": "secret-token-abc", "user_id": "ABCD1234"})
        )
        state = issue_state()
        client.get(f"/auth/callback?code=auth-code-xyz&state={state}")


def _raw_candles(n=400, start=None):
    start = start or (datetime.now(timezone.utc) - timedelta(days=n))
    rows = []
    for i in range(n):
        close = 100 + i * 0.5 + 10 * math.sin(i / 15)
        volume = 5000 if i % 15 == 0 else 1000
        ts = (start + timedelta(days=i)).isoformat()
        rows.append([ts, close - 0.3, close + 0.6, close - 0.6, close, volume, 0])
    rows.reverse()
    return rows


def test_backtest_requires_auth(client):
    response = client.get(
        "/backtest/run",
        params={"instrument_key": "NSE_EQ|TEST", "from_date": "2024-01-01", "to_date": "2025-01-01"},
    )
    assert response.status_code == 401


def test_backtest_rejects_bad_date_range(client):
    _connect(client)
    response = client.get(
        "/backtest/run",
        params={"instrument_key": "NSE_EQ|TEST", "from_date": "2025-01-01", "to_date": "2024-01-01"},
    )
    assert response.status_code == 400


def test_backtest_rejects_train_end_date_outside_range(client):
    _connect(client)
    response = client.get(
        "/backtest/run",
        params={
            "instrument_key": "NSE_EQ|TEST",
            "from_date": "2024-01-01",
            "to_date": "2024-06-01",
            "train_end_date": "2025-01-01",
        },
    )
    assert response.status_code == 400


def test_backtest_runs_end_to_end_and_returns_metrics(client):
    _connect(client)
    with respx.mock:
        respx.get(url__startswith="https://api.upstox.com/v3/historical-candle/").mock(
            return_value=Response(200, json={"status": "success", "data": {"candles": _raw_candles()}})
        )
        response = client.get(
            "/backtest/run",
            params={"instrument_key": "NSE_EQ|TEST", "from_date": "2024-01-01", "to_date": "2025-06-01"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["metrics"]["all"]["total_trades"] > 0
    assert len(body["trades"]) == body["metrics"]["all"]["total_trades"]
    assert body["equity_curve"][0]["equity"] == body["starting_capital"]


def test_backtest_too_few_candles_is_rejected(client):
    _connect(client)
    with respx.mock:
        respx.get(url__startswith="https://api.upstox.com/v3/historical-candle/").mock(
            return_value=Response(200, json={"status": "success", "data": {"candles": _raw_candles(n=30)}})
        )
        response = client.get(
            "/backtest/run",
            params={"instrument_key": "NSE_EQ|TEST", "from_date": "2024-01-01", "to_date": "2024-02-01"},
        )
    assert response.status_code == 400

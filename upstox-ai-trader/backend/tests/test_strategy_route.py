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


def _raw_uptrend_candles(n=70):
    start = datetime.now(timezone.utc) - timedelta(days=n - 1)
    rows = []
    for i in range(n):
        close = 100 + i * 0.8
        volume = 4000 if i == n - 1 else 1000
        ts = (start + timedelta(days=i)).isoformat()
        rows.append([ts, close - 0.3, close + 0.6, close - 0.6, close, volume, 0])
    rows.reverse()  # Upstox returns newest first
    return rows


def test_signal_requires_auth(client):
    response = client.get("/strategy/signal", params={"instrument_key": "NSE_EQ|TEST"})
    assert response.status_code == 401


def test_signal_endpoint_returns_buy_for_strong_uptrend(client):
    _connect(client)

    with respx.mock:
        respx.get(url__startswith="https://api.upstox.com/v3/historical-candle/").mock(
            return_value=Response(200, json={"status": "success", "data": {"candles": _raw_uptrend_candles()}})
        )
        response = client.get("/strategy/signal", params={"instrument_key": "NSE_EQ|TEST"})

    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "BUY"
    assert body["risk_reward"] == 2.0
    assert body["candles_used"] == 70


def test_signal_endpoint_surfaces_empty_candle_response(client):
    _connect(client)

    with respx.mock:
        respx.get(url__startswith="https://api.upstox.com/v3/historical-candle/").mock(
            return_value=Response(200, json={"status": "success", "data": {"candles": []}})
        )
        response = client.get("/strategy/signal", params={"instrument_key": "NSE_EQ|TEST"})

    assert response.status_code == 502

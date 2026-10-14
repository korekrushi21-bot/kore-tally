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
    rows.reverse()
    return rows


def _ltp_response(instrument_key: str, price: float) -> dict:
    return {"status": "success", "data": {instrument_key: {"last_price": price, "instrument_token": instrument_key}}}


def test_account_with_no_positions_and_no_connection(client):
    response = client.get("/paper/account")
    assert response.status_code == 200
    body = response.json()
    assert body["open_positions"] == []
    assert body["net_equity"] == body["starting_capital"]


def test_evaluate_opens_a_position_from_real_signal_pipeline(client):
    _connect(client)

    with respx.mock:
        respx.get(url__startswith="https://api.upstox.com/v3/historical-candle/").mock(
            return_value=Response(200, json={"status": "success", "data": {"candles": _raw_uptrend_candles()}})
        )
        respx.get("https://api.upstox.com/v3/market-quote/ltp").mock(
            return_value=Response(200, json=_ltp_response("NSE_EQ|TEST", 155.2))
        )
        response = client.post("/paper/evaluate", params={"instrument_key": "NSE_EQ|TEST"})

    assert response.status_code == 200
    body = response.json()
    assert body["signal_action"] == "BUY"
    assert body["entry_result"]["action"] == "opened"

    positions = client.get("/paper/positions").json()
    assert len(positions) == 1
    assert positions[0]["instrument_key"] == "NSE_EQ|TEST"


def test_account_marks_open_position_using_live_ltp(client):
    _connect(client)
    with respx.mock:
        respx.get(url__startswith="https://api.upstox.com/v3/historical-candle/").mock(
            return_value=Response(200, json={"status": "success", "data": {"candles": _raw_uptrend_candles()}})
        )
        respx.get("https://api.upstox.com/v3/market-quote/ltp").mock(
            return_value=Response(200, json=_ltp_response("NSE_EQ|TEST", 155.2))
        )
        client.post("/paper/evaluate", params={"instrument_key": "NSE_EQ|TEST"})

    with respx.mock:
        respx.get("https://api.upstox.com/v3/market-quote/ltp").mock(
            return_value=Response(200, json=_ltp_response("NSE_EQ|TEST", 160.0))
        )
        response = client.get("/paper/account")

    body = response.json()
    assert body["open_positions"][0]["mark_price"] == 160.0


def test_stop_all_then_resume(client):
    _connect(client)
    with respx.mock:
        respx.get(url__startswith="https://api.upstox.com/v3/historical-candle/").mock(
            return_value=Response(200, json={"status": "success", "data": {"candles": _raw_uptrend_candles()}})
        )
        respx.get("https://api.upstox.com/v3/market-quote/ltp").mock(
            return_value=Response(200, json=_ltp_response("NSE_EQ|TEST", 155.2))
        )
        client.post("/paper/evaluate", params={"instrument_key": "NSE_EQ|TEST"})

    stop_response = client.post("/paper/stop-all", json={"NSE_EQ|TEST": 155.2})
    assert stop_response.status_code == 200
    assert len(stop_response.json()["positions_closed"]) == 1
    assert client.get("/paper/positions").json() == []

    resume_response = client.post("/paper/resume")
    assert resume_response.json() == {"trading_halted": False}


def test_trades_endpoint_lists_closed_positions(client):
    _connect(client)
    with respx.mock:
        respx.get(url__startswith="https://api.upstox.com/v3/historical-candle/").mock(
            return_value=Response(200, json={"status": "success", "data": {"candles": _raw_uptrend_candles()}})
        )
        respx.get("https://api.upstox.com/v3/market-quote/ltp").mock(
            return_value=Response(200, json=_ltp_response("NSE_EQ|TEST", 155.2))
        )
        client.post("/paper/evaluate", params={"instrument_key": "NSE_EQ|TEST"})

    assert client.get("/paper/trades").json() == []  # nothing closed yet

    client.post("/paper/stop-all", json={"NSE_EQ|TEST": 160.0})
    trades = client.get("/paper/trades").json()
    assert len(trades) == 1
    assert trades[0]["status"] == "CLOSED"
    assert trades[0]["exit_reason"] == "emergency_stop"

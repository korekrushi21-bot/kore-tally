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


def test_status_reports_disabled_by_default(client):
    body = client.get("/live/status").json()
    assert body["live_trading_enabled"] is False
    assert body["open_positions"] == []


def test_evaluate_refuses_when_disabled(client):
    _connect(client)
    response = client.post("/live/evaluate", params={"instrument_key": "NSE_EQ|TEST"})
    assert response.status_code == 403


def test_evaluate_requires_auth_even_when_enabled(client, live_enabled):
    response = client.post("/live/evaluate", params={"instrument_key": "NSE_EQ|TEST"})
    assert response.status_code == 401


def test_evaluate_places_real_orders_end_to_end(client, live_enabled):
    _connect(client)
    with respx.mock:
        respx.get(url__startswith="https://api.upstox.com/v3/historical-candle/").mock(
            return_value=Response(200, json={"status": "success", "data": {"candles": _raw_uptrend_candles()}})
        )
        respx.get("https://api.upstox.com/v3/market-quote/ltp").mock(
            return_value=Response(200, json=_ltp_response("NSE_EQ|TEST", 155.2))
        )
        respx.get("https://api.upstox.com/v3/user/get-funds-and-margin").mock(
            return_value=Response(200, json={"data": {"equity": {"available_margin": 100000.0}}})
        )
        place_route = respx.post("https://api-hft.upstox.com/v3/order/place").mock(
            return_value=Response(200, json={"data": {"order_ids": ["ORD1"]}})
        )
        respx.get("https://api.upstox.com/v2/order/details").mock(
            return_value=Response(200, json={"data": {"status": "complete", "average_price": 155.2, "filled_quantity": 3}})
        )
        response = client.post("/live/evaluate", params={"instrument_key": "NSE_EQ|TEST"})

    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "opened"
    assert place_route.call_count == 3  # entry + stop-loss + target

    positions = client.get("/live/positions").json()
    assert len(positions) == 1
    assert positions[0]["instrument_key"] == "NSE_EQ|TEST"


def test_stop_all_requires_exact_confirmation_phrase(client, live_enabled):
    _connect(client)
    bad = client.post("/live/stop-all", json={"confirm": "yes please"})
    assert bad.status_code == 400

    with respx.mock:
        respx.delete("https://api.upstox.com/v2/order/multi/cancel").mock(return_value=Response(200, json={"status": "success"}))
        respx.post("https://api.upstox.com/v2/order/positions/exit").mock(
            return_value=Response(200, json={"status": "success", "data": {"order_ids": []}})
        )
        good = client.post("/live/stop-all", json={"confirm": "STOP ALL LIVE TRADING"})

    assert good.status_code == 200
    status = client.get("/live/status").json()
    assert status["trading_halted"] is True


def test_resume_clears_halt(client, live_enabled):
    _connect(client)
    with respx.mock:
        respx.delete("https://api.upstox.com/v2/order/multi/cancel").mock(return_value=Response(200, json={"status": "success"}))
        respx.post("https://api.upstox.com/v2/order/positions/exit").mock(
            return_value=Response(200, json={"status": "success", "data": {"order_ids": []}})
        )
        client.post("/live/stop-all", json={"confirm": "STOP ALL LIVE TRADING"})

    client.post("/live/resume")
    assert client.get("/live/status").json()["trading_halted"] is False


def test_preflight_surfaces_registered_static_ips(client, live_enabled):
    _connect(client)
    with respx.mock:
        respx.get("https://api.upstox.com/v2/user/ip").mock(
            return_value=Response(200, json={"data": {"primary_ip": "203.0.113.10", "secondary_ip": None}})
        )
        response = client.get("/live/preflight")

    assert response.status_code == 200
    assert response.json()["registered_static_ips"]["primary_ip"] == "203.0.113.10"

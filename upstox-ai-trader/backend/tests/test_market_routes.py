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


def test_market_profile_requires_auth(client):
    response = client.get("/market/profile")
    assert response.status_code == 401


def test_market_profile_proxies_upstox_response(client):
    _connect(client)

    with respx.mock:
        route = respx.get("https://api.upstox.com/v2/user/profile").mock(
            return_value=Response(200, json={"status": "success", "data": {"user_name": "Test User"}})
        )
        response = client.get("/market/profile")

    assert route.called
    request = route.calls.last.request
    assert request.headers["authorization"] == "Bearer secret-token-abc"
    assert response.status_code == 200
    assert response.json()["data"]["user_name"] == "Test User"


def test_market_holdings_surfaces_upstox_error(client):
    _connect(client)

    with respx.mock:
        respx.get("https://api.upstox.com/v2/portfolio/long-term-holdings").mock(
            return_value=Response(500, json={"message": "upstream error"})
        )
        response = client.get("/market/holdings")

    assert response.status_code == 500

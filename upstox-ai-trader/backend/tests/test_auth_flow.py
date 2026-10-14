import respx
from httpx import Response

from app.core.state_token import issue_state
from app.services import auth_service


def test_login_redirects_to_upstox_dialog(client):
    response = client.get("/auth/login", follow_redirects=False)
    assert response.status_code in (302, 307)
    location = response.headers["location"]
    assert location.startswith("https://api.upstox.com/v2/login/authorization/dialog")
    assert "client_id=test_client_id" in location
    assert "state=" in location


def test_status_when_never_connected(client):
    response = client.get("/auth/status")
    assert response.status_code == 200
    assert response.json() == {"connected": False}


@respx.mock
def test_callback_exchanges_code_and_stores_encrypted_token(client):
    respx.post("https://api.upstox.com/v2/login/authorization/token").mock(
        return_value=Response(200, json={"access_token": "secret-token-abc", "user_id": "ABCD1234"})
    )

    state = issue_state()
    response = client.get(f"/auth/callback?code=auth-code-xyz&state={state}")
    assert response.status_code == 200

    status = client.get("/auth/status").json()
    assert status["connected"] is True
    assert status["upstox_user_id"] == "ABCD1234"


def test_callback_rejects_invalid_state(client):
    response = client.get("/auth/callback?code=auth-code-xyz&state=not-a-valid-signature")
    assert response.status_code == 400


def test_disconnect_clears_session(client, db_session):
    respx_mock = respx.mock
    with respx_mock:
        respx_mock.post("https://api.upstox.com/v2/login/authorization/token").mock(
            return_value=Response(200, json={"access_token": "secret-token-abc", "user_id": "ABCD1234"})
        )
        state = issue_state()
        client.get(f"/auth/callback?code=auth-code-xyz&state={state}")

    assert client.get("/auth/status").json()["connected"] is True

    client.post("/auth/disconnect")
    assert client.get("/auth/status").json() == {"connected": False}


def test_stored_token_is_encrypted_at_rest(client, db_session):
    with respx.mock:
        respx.post("https://api.upstox.com/v2/login/authorization/token").mock(
            return_value=Response(200, json={"access_token": "super-secret-value", "user_id": "ABCD1234"})
        )
        state = issue_state()
        client.get(f"/auth/callback?code=auth-code-xyz&state={state}")

    session = auth_service.get_active_session(db_session)
    assert "super-secret-value" not in session.access_token_encrypted
    assert auth_service.get_decrypted_token(session) == "super-secret-value"

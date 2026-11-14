from datetime import timedelta

import respx
from httpx import Response

from app.core.time_utils import today_ist
from app.engine import options, paper_trading
from tests.test_paper_routes import _connect, _raw_uptrend_candles

UNDERLYING = "NSE_EQ|TEST"
SPOT = 155.2


def _contracts_response():
    expiry = (today_ist() + timedelta(days=20)).isoformat()
    rows = []
    for strike in (145, 150, 155, 160, 165):
        for typ in ("CE", "PE"):
            rows.append({
                "instrument_key": f"NSE_FO|{strike}{typ}",
                "underlying_key": UNDERLYING,
                "instrument_type": typ,
                "strike_price": strike,
                "expiry": expiry,
                "lot_size": 500,
                "trading_symbol": f"TEST {strike} {typ}",
            })
    return {"status": "success", "data": rows}


def _ltp_side_effect(premium):
    def handler(request):
        keys = request.url.params["instrument_key"].split(",")
        prices = {UNDERLYING: SPOT, "NSE_FO|155CE": premium}
        data = {k: {"last_price": prices[k], "instrument_token": k} for k in keys if k in prices}
        return Response(200, json={"status": "success", "data": data})
    return handler


def _fair_premium():
    return round(options.bs_price(SPOT, 155, 20 / 365, 0.065, 0.3, "CE"), 2)


def _mock_market(premium):
    respx.get(url__startswith="https://api.upstox.com/v3/historical-candle/").mock(
        return_value=Response(200, json={"status": "success", "data": {"candles": _raw_uptrend_candles()}})
    )
    respx.get("https://api.upstox.com/v2/option/contract").mock(return_value=Response(200, json=_contracts_response()))
    respx.get("https://api.upstox.com/v3/market-quote/ltp").mock(side_effect=_ltp_side_effect(premium))


def _raise_capital(db_session):
    account = paper_trading.get_or_create_account(db_session)
    account.starting_capital = 2_000_000.0
    db_session.commit()


def test_contracts_lists_expiries(client):
    _connect(client)
    with respx.mock:
        respx.get("https://api.upstox.com/v2/option/contract").mock(return_value=Response(200, json=_contracts_response()))
        body = client.get("/options/contracts", params={"underlying_key": UNDERLYING}).json()
    assert len(body["expiries"]) == 1
    assert len(body["contracts"]) == 10


def test_signal_preview_picks_atm_call_and_places_nothing(client, db_session):
    _connect(client)
    _raise_capital(db_session)
    with respx.mock:
        _mock_market(_fair_premium())
        response = client.get("/options/signal", params={"underlying_key": UNDERLYING})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["signal"]["action"] == "BUY"
    assert body["contract"]["instrument_key"] == "NSE_FO|155CE"
    assert 0.3 < body["delta"] < 0.8
    assert body["risk"]["quantity"] % 500 == 0
    assert body["breakeven_at_expiry"] == round(155 + _fair_premium(), 2)
    assert client.get("/paper/positions").json() == []


def test_paper_evaluate_opens_then_exits_on_underlying_target(client, db_session):
    _connect(client)
    _raise_capital(db_session)
    with respx.mock:
        _mock_market(_fair_premium())
        body = client.post("/options/paper/evaluate", params={"underlying_key": UNDERLYING}).json()
    assert body["entry_result"]["action"] == "opened", body
    position = body["entry_result"]["position"]
    assert position["option"]["option_type"] == "CE"

    target = position["option"]["underlying_target"]
    global SPOT
    original = SPOT
    SPOT = target + 1
    try:
        with respx.mock:
            _mock_market(_fair_premium() * 2)
            body = client.post("/options/paper/evaluate", params={"underlying_key": UNDERLYING}).json()
    finally:
        SPOT = original
    assert len(body.get("exits", [])) == 1, body
    assert body["exits"][0]["exit_reason"] == "target"


def test_option_routes_require_login(client):
    assert client.get("/options/signal", params={"underlying_key": UNDERLYING}).status_code == 401

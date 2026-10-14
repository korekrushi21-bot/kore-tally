import pytest
import respx
from httpx import Response

from app.services.upstox_client import UpstoxClient


@pytest.mark.asyncio
@respx.mock
async def test_get_ltp_encodes_and_joins_instrument_keys():
    route = respx.get("https://api.upstox.com/v3/market-quote/ltp").mock(
        return_value=Response(200, json={"status": "success", "data": {}})
    )
    client = UpstoxClient(access_token="tok")
    await client.get_ltp(["NSE_EQ|INE002A01018", "NSE_EQ|INE669E01016"])

    request = route.calls.last.request
    assert request.url.params["instrument_key"] == "NSE_EQ|INE002A01018,NSE_EQ|INE669E01016"
    assert request.headers["authorization"] == "Bearer tok"


@pytest.mark.asyncio
@respx.mock
async def test_get_historical_candles_builds_expected_path():
    route = respx.get(
        "https://api.upstox.com/v3/historical-candle/NSE_EQ%7CINE002A01018/days/1/2026-01-10/2026-01-01"
    ).mock(return_value=Response(200, json={"status": "success", "data": {"candles": []}}))

    client = UpstoxClient(access_token="tok")
    await client.get_historical_candles("NSE_EQ|INE002A01018", "days", 1, "2026-01-10", "2026-01-01")
    assert route.called


@pytest.mark.asyncio
@respx.mock
async def test_get_historical_candles_without_from_date():
    route = respx.get("https://api.upstox.com/v3/historical-candle/NSE_EQ%7CINE002A01018/days/1/2026-01-10").mock(
        return_value=Response(200, json={"status": "success", "data": {"candles": []}})
    )
    client = UpstoxClient(access_token="tok")
    await client.get_historical_candles("NSE_EQ|INE002A01018", "days", 1, "2026-01-10")
    assert route.called


@pytest.mark.asyncio
@respx.mock
async def test_get_intraday_candles_builds_expected_path():
    route = respx.get(
        "https://api.upstox.com/v3/historical-candle/intraday/NSE_EQ%7CINE002A01018/minutes/5"
    ).mock(return_value=Response(200, json={"status": "success", "data": {"candles": []}}))
    client = UpstoxClient(access_token="tok")
    await client.get_intraday_candles("NSE_EQ|INE002A01018", "minutes", 5)
    assert route.called

"""Thin wrapper around the official Upstox REST endpoints actually used by
this app. Every call is read-only in this phase (no order placement).

Endpoints verified against upstox.com/developer/api-documentation as of
Oct 2026:
  - Auth:        POST /v2/login/authorization/token
  - Profile:     GET  /v2/user/profile
  - Holdings:    GET  /v2/portfolio/long-term-holdings
  - Positions:   GET  /v2/portfolio/short-term-positions
  - Funds:       GET  /v3/user/get-funds-and-margin   (Api-Version: 3.0)
  - Order book:  GET  /v2/order/retrieve-all
  - Order detail: GET /v2/order/details?order_id=...
  - LTP:         GET  /v3/market-quote/ltp?instrument_key=...
  - Historical candles: GET /v3/historical-candle/{instrument_key}/{unit}/{interval}/{to_date}[/{from_date}]
  - Intraday candles:   GET /v3/historical-candle/intraday/{instrument_key}/{unit}/{interval}
    `unit` is one of "minutes" | "days" | "weeks" | "months"; `interval` is an
    integer multiple of that unit. Candle data for the CURRENT trading day
    only comes from the intraday endpoint, not the historical one.

Order-placement endpoints (used by the live-trading phase; see app/engine/live_trading.py
for the safety rails around these — this client is a dumb wrapper with none of them):
  - Place order:    POST   api-hft.upstox.com/v3/order/place
  - Cancel order:    DELETE api-hft.upstox.com/v3/order/cancel?order_id=...
  - Cancel all open orders: DELETE api.upstox.com/v2/order/multi/cancel
  - Exit all positions:     POST   api.upstox.com/v2/order/positions/exit
  - Get/update registered static IPs: GET/PUT api.upstox.com/v2/user/ip

IMPORTANT — SEBI/Upstox compliance (verified against Upstox's developer docs, Oct 2026):
Since 1 Apr 2026, Upstox requires every place/cancel/exit-all-positions call to originate
from a registered static IP (`/v2/user/ip`), or it is rejected. Algo order flow above 10
orders/second must be registered with SEBI via the exchange; at or below that rate, no
registration is required (Upstox's own "Regular Algo" rate limit is 10/sec). This app's
live-trading engine rate-limits itself well under that threshold by design.
"""
from urllib.parse import quote

import httpx

from app.core.config import get_settings
from app.core.exceptions import UpstoxAPIError


HFT_API_BASE = "https://api-hft.upstox.com"


class UpstoxClient:
    def __init__(self, access_token: str | None = None):
        self._settings = get_settings()
        self._access_token = access_token

    async def exchange_authorization_code(self, code: str) -> dict:
        url = f"{self._settings.upstox_api_base}/v2/login/authorization/token"
        data = {
            "code": code,
            "client_id": self._settings.upstox_client_id,
            "client_secret": self._settings.upstox_client_secret,
            "redirect_uri": self._settings.upstox_redirect_uri,
            "grant_type": "authorization_code",
        }
        headers = {"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"}
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(url, data=data, headers=headers)
        return self._parse(response)

    async def get_profile(self) -> dict:
        return await self._get("/v2/user/profile")

    async def get_holdings(self) -> dict:
        return await self._get("/v2/portfolio/long-term-holdings")

    async def get_positions(self) -> dict:
        return await self._get("/v2/portfolio/short-term-positions")

    async def get_funds_and_margin(self) -> dict:
        return await self._get("/v3/user/get-funds-and-margin", extra_headers={"Api-Version": "3.0"})

    async def get_order_book(self) -> dict:
        return await self._get("/v2/order/retrieve-all")

    async def get_order_details(self, order_id: str) -> dict:
        return await self._get("/v2/order/details", params={"order_id": order_id})

    async def get_ltp(self, instrument_keys: list[str]) -> dict:
        return await self._get("/v3/market-quote/ltp", params={"instrument_key": ",".join(instrument_keys)})

    async def get_historical_candles(
        self, instrument_key: str, unit: str, interval: int, to_date: str, from_date: str | None = None
    ) -> dict:
        key = quote(instrument_key, safe="")
        path = f"/v3/historical-candle/{key}/{unit}/{interval}/{to_date}"
        if from_date:
            path += f"/{from_date}"
        return await self._get(path)

    async def get_intraday_candles(self, instrument_key: str, unit: str, interval: int) -> dict:
        key = quote(instrument_key, safe="")
        return await self._get(f"/v3/historical-candle/intraday/{key}/{unit}/{interval}")

    async def get_static_ips(self) -> dict:
        return await self._get("/v2/user/ip")

    async def update_static_ips(self, primary_ip: str, secondary_ip: str | None = None) -> dict:
        body = {"primary_ip": primary_ip}
        if secondary_ip:
            body["secondary_ip"] = secondary_ip
        return await self._request("PUT", "/v2/user/ip", json_body=body)

    async def place_order(
        self,
        instrument_token: str,
        quantity: int,
        product: str,
        order_type: str,
        transaction_type: str,
        validity: str = "DAY",
        price: float = 0,
        trigger_price: float = 0,
        disclosed_quantity: int = 0,
        tag: str | None = None,
        algo_name: str | None = None,
    ) -> dict:
        body = {
            "quantity": quantity,
            "product": product,
            "validity": validity,
            "price": price,
            "instrument_token": instrument_token,
            "order_type": order_type,
            "transaction_type": transaction_type,
            "disclosed_quantity": disclosed_quantity,
            "trigger_price": trigger_price,
        }
        if tag:
            body["tag"] = tag[:40]
        extra_headers = {"X-Algo-Name": algo_name} if algo_name else None
        return await self._request("POST", "/v3/order/place", json_body=body, base=HFT_API_BASE, extra_headers=extra_headers)

    async def cancel_order(self, order_id: str) -> dict:
        return await self._request("DELETE", "/v3/order/cancel", params={"order_id": order_id}, base=HFT_API_BASE)

    async def cancel_all_orders(self, segment: str | None = None, tag: str | None = None) -> dict:
        params = {k: v for k, v in {"segment": segment, "tag": tag}.items() if v}
        return await self._request("DELETE", "/v2/order/multi/cancel", params=params)

    async def exit_all_positions(self, segment: str | None = None, tag: str | None = None) -> dict:
        params = {k: v for k, v in {"segment": segment, "tag": tag}.items() if v}
        return await self._request("POST", "/v2/order/positions/exit", params=params, json_body={})

    async def _get(self, path: str, params: dict | None = None, extra_headers: dict | None = None) -> dict:
        return await self._request("GET", path, params=params, extra_headers=extra_headers)

    async def _request(
        self,
        method: str,
        path: str,
        params: dict | None = None,
        json_body: dict | None = None,
        extra_headers: dict | None = None,
        base: str | None = None,
    ) -> dict:
        if not self._access_token:
            raise UpstoxAPIError(401, "No access token supplied to UpstoxClient")
        url = f"{base or self._settings.upstox_api_base}{path}"
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._access_token}",
            **(extra_headers or {}),
        }
        if json_body is not None:
            headers["Content-Type"] = "application/json"
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.request(method, url, params=params, json=json_body, headers=headers)
        return self._parse(response)

    @staticmethod
    def _parse(response: httpx.Response) -> dict:
        try:
            body = response.json()
        except ValueError:
            body = {"raw": response.text}
        if response.status_code >= 400:
            message = body.get("errors") or body.get("message") or body
            raise UpstoxAPIError(response.status_code, str(message))
        return body

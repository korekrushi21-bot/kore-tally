"""A hand-rolled test double for UpstoxClient's order-placement surface.

Used instead of respx for live_trading engine unit tests because the engine
makes several sequential, state-dependent calls (place entry -> poll status
-> place protective legs -> later reconcile) that are much easier to drive
and assert on through a stateful fake than through URL-matched HTTP mocks.
Route-level tests still use respx, for parity with the rest of the suite.
"""
from app.core.exceptions import UpstoxAPIError


class FakeUpstoxClient:
    def __init__(self):
        self.orders: dict[str, dict] = {}
        self.placed_orders: list[dict] = []
        self.cancelled_order_ids: list[str] = []
        self.funds_response = {"data": {"equity": {"available_margin": 100_000.0}}}
        self.cancel_all_called = False
        self.exit_all_called = False
        self.raise_on_place: Exception | None = None
        self.raise_on_funds: Exception | None = None
        self.force_market_status: str | None = None
        self._next_id = 1000

    def _new_id(self) -> str:
        self._next_id += 1
        return str(self._next_id)

    async def get_funds_and_margin(self) -> dict:
        if self.raise_on_funds:
            raise self.raise_on_funds
        return self.funds_response

    async def place_order(self, **kwargs) -> dict:
        if self.raise_on_place:
            raise self.raise_on_place
        order_id = self._new_id()
        self.placed_orders.append({"order_id": order_id, **kwargs})
        # MARKET entries fill immediately in this fake; protective legs (SL-M/LIMIT)
        # stay resting ("open") until a test explicitly triggers them, same as reality.
        if kwargs.get("order_type") == "MARKET":
            default_status = self.force_market_status or "complete"
        else:
            default_status = "open"
        self.orders[order_id] = {
            "status": default_status,
            "average_price": kwargs.get("price") or kwargs.get("trigger_price") or 100.0,
            "filled_quantity": kwargs["quantity"] if default_status == "complete" else 0,
        }
        return {"data": {"order_ids": [order_id]}}

    async def get_order_details(self, order_id: str) -> dict:
        info = self.orders.get(order_id, {"status": "open", "average_price": None, "filled_quantity": 0})
        return {"data": {"status": info["status"], "average_price": info.get("average_price"), "filled_quantity": info.get("filled_quantity")}}

    async def cancel_order(self, order_id: str) -> dict:
        self.cancelled_order_ids.append(order_id)
        if order_id in self.orders:
            self.orders[order_id]["status"] = "cancelled"
        return {"status": "success", "data": {"order_id": order_id}}

    async def cancel_all_orders(self, segment=None, tag=None) -> dict:
        self.cancel_all_called = True
        return {"status": "success", "data": {}}

    async def exit_all_positions(self, segment=None, tag=None) -> dict:
        self.exit_all_called = True
        return {"status": "success", "data": {"order_ids": []}}

    async def get_static_ips(self) -> dict:
        return {"data": {"primary_ip": "203.0.113.10", "secondary_ip": None}}

    def set_status(self, order_id: str, status: str, average_price: float | None = None, filled_quantity: int | None = None):
        entry = self.orders.setdefault(order_id, {})
        entry["status"] = status
        if average_price is not None:
            entry["average_price"] = average_price
        if filled_quantity is not None:
            entry["filled_quantity"] = filled_quantity


def rejected_error() -> UpstoxAPIError:
    return UpstoxAPIError(400, "Order rejected: insufficient margin")

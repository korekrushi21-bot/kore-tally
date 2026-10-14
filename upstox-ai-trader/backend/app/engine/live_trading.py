"""Real-money order placement, gated behind multiple independent safety
rails. Read this whole docstring before touching this file.

Why a stop-loss here is a REAL exchange order, not app logic: once an entry
fills, this engine immediately places a real SL-M order and a real LIMIT
order at the target on the exchange itself. If this app crashes, loses
network, or the host machine is off, the stop-loss still protects the
position — because the exchange is holding it, not this process. This is
the single most important property of this module; do not "simplify" it
into app-side price monitoring.

Why there's no OCO product: Upstox's place-order API does not support the
OCO product type, so the stop-loss and target legs are two independent
orders. This engine emulates OCO itself: `reconcile_position` polls both
legs and, the moment either one completes, cancels the other. Until a
reconcile call happens after a fill, BOTH orders technically still sit on
the exchange — if target fills first and this app is offline for a while,
the stale stop-loss order remains resting at a price that no longer makes
sense for a position that's already closed. Call /live/reconcile regularly
while any live position is open.

Why entries are MARKET-only here: this keeps the fill-confirmation flow
sound (a MARKET order during market hours fills or fails quickly; a LIMIT
entry could sit unfilled indefinitely with ambiguous partial-fill states).
LIMIT entries are not supported by this phase.

Compliance this module assumes (see README): a static IP registered with
Upstox (`/v2/user/ip`) or every order call is rejected outright; order
throughput kept well under the 10/sec "Regular Algo" threshold so this
usage does not require SEBI algo registration.
"""
import asyncio
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.exceptions import UpstoxAPIError
from app.core.time_utils import today_ist
from app.db.models import LiveAccount, LiveDailyRiskState, LiveOrder, LivePosition
from app.engine import costs
from app.engine.risk import AccountSnapshot, RiskManager
from app.engine.strategy import Signal
from app.services import audit
from app.services.upstox_client import UpstoxClient

ORDER_TAG = "upstox-ai-trader"


class LiveTradingDisabled(Exception):
    pass


def require_enabled() -> None:
    if not get_settings().live_trading_enabled:
        raise LiveTradingDisabled(
            "Live trading is disabled. Set LIVE_TRADING_ENABLED=true in backend/.env and "
            "restart the backend to enable it — this cannot be turned on from the API."
        )


def get_or_create_account(db: Session) -> LiveAccount:
    account = db.scalar(select(LiveAccount).limit(1))
    if account is None:
        account = LiveAccount()
        db.add(account)
        db.commit()
        db.refresh(account)
    return account


def get_today_risk_state(db: Session) -> LiveDailyRiskState:
    today = today_ist()
    state = db.scalar(select(LiveDailyRiskState).where(LiveDailyRiskState.trading_date == today))
    if state is None:
        state = LiveDailyRiskState(trading_date=today)
        db.add(state)
        db.commit()
        db.refresh(state)
    return state


def get_open_positions(db: Session, instrument_key: str | None = None) -> list[LivePosition]:
    stmt = select(LivePosition).where(LivePosition.status == "OPEN")
    if instrument_key:
        stmt = stmt.where(LivePosition.instrument_key == instrument_key)
    return list(db.scalars(stmt))


def _recent_duplicate_order_exists(db: Session, instrument_key: str) -> bool:
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=get_settings().live_duplicate_guard_seconds)
    stmt = (
        select(LiveOrder)
        .where(LiveOrder.instrument_key == instrument_key)
        .where(LiveOrder.role == "ENTRY")
        .where(LiveOrder.placed_at >= cutoff)
        .limit(1)
    )
    return db.scalar(stmt) is not None


async def evaluate_and_execute_signal(
    db: Session, client: UpstoxClient, signal: Signal, current_price: float
) -> dict:
    require_enabled()

    reconciled = await reconcile_instrument(db, client, signal.instrument_key)

    if signal.action not in ("BUY", "SELL"):
        return {"action": "no_trade", "reasons": signal.reasons, "reconciled": reconciled}

    account = get_or_create_account(db)
    today = get_today_risk_state(db)

    if account.trading_halted:
        return {"action": "rejected", "reasons": ["Live trading is halted (emergency stop)"], "reconciled": reconciled}

    open_positions = get_open_positions(db)
    has_existing = any(p.instrument_key == signal.instrument_key for p in open_positions)

    if not has_existing and _recent_duplicate_order_exists(db, signal.instrument_key):
        return {
            "action": "rejected",
            "reasons": [f"An entry order was already placed on {signal.instrument_key} in the last "
                        f"{get_settings().live_duplicate_guard_seconds}s — refusing to duplicate it"],
            "reconciled": reconciled,
        }

    capital, funds_note = await _available_capital(client)

    snapshot = AccountSnapshot(
        capital=capital,
        open_positions_count=len(open_positions),
        has_open_position_in_instrument=has_existing,
        daily_realized_pnl=today.realized_pnl,
        trading_halted=account.trading_halted,
        daily_loss_limit_halted=today.loss_limit_halted,
    )
    decision = RiskManager().evaluate(signal, snapshot)
    if not decision.approved:
        audit.record(
            db, "live.signal_rejected",
            {"instrument_key": signal.instrument_key, "action": signal.action, "reasons": decision.reasons},
        )
        return {"action": "rejected", "reasons": decision.reasons, "reconciled": reconciled, "funds_note": funds_note}

    result = await _place_entry_and_protect(db, client, signal, decision.quantity)
    result["reconciled"] = reconciled
    result["funds_note"] = funds_note
    return result


async def _available_capital(client: UpstoxClient) -> tuple[float, str | None]:
    """Upstox's v3 funds-and-margin response shape isn't fully documented
    (see app/services/upstox_client.py), so this defensively scans for a
    plausible "available margin" figure instead of assuming one fixed key.
    Falls back to the configured paper-trading capital figure as a
    conservative stand-in if nothing recognizable is found — never silently
    treats "unknown" as "unlimited".
    """
    settings = get_settings()
    try:
        response = await client.get_funds_and_margin()
    except UpstoxAPIError as exc:
        return settings.paper_trading_starting_capital, f"Could not fetch live funds ({exc.message}); using configured fallback capital for sizing"

    data = response.get("data", {})
    candidates = []

    def _walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if isinstance(value, (int, float)) and "margin" in key.lower() and "available" in key.lower():
                    candidates.append(float(value))
                _walk(value)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    _walk(data)
    if candidates:
        return min(candidates), None
    return settings.paper_trading_starting_capital, "Could not identify an available-margin field in Upstox's funds response; using configured fallback capital for sizing — verify against your real account"


async def _place_entry_and_protect(db: Session, client: UpstoxClient, signal: Signal, quantity: int) -> dict:
    settings = get_settings()
    try:
        place_response = await client.place_order(
            instrument_token=signal.instrument_key,
            quantity=quantity,
            product=settings.live_order_product,
            order_type="MARKET",
            transaction_type=signal.action,
            tag=ORDER_TAG,
            algo_name=settings.upstox_algo_name,
        )
    except UpstoxAPIError as exc:
        audit.record(db, "live.entry_placement_failed", {"instrument_key": signal.instrument_key, "error": exc.message})
        return {"action": "entry_failed", "reasons": [f"Order placement failed: {exc.message}"]}

    order_ids = place_response.get("data", {}).get("order_ids", [])
    if not order_ids:
        audit.record(db, "live.entry_placement_no_order_id", {"instrument_key": signal.instrument_key, "response": place_response})
        return {"action": "entry_failed", "reasons": ["Upstox accepted the request but returned no order_id"]}

    entry_order_id = order_ids[0]
    entry_order = LiveOrder(
        upstox_order_id=entry_order_id,
        instrument_key=signal.instrument_key,
        role="ENTRY",
        side=signal.action,
        quantity=quantity,
        order_type="MARKET",
        status="PENDING",
    )
    db.add(entry_order)
    db.commit()
    audit.record(db, "live.entry_submitted", {"order_id": entry_order_id, "instrument_key": signal.instrument_key, "quantity": quantity})

    fill = await _poll_for_fill(client, entry_order_id)
    entry_order.status = fill["status"]
    entry_order.average_price = fill.get("average_price")
    entry_order.last_checked_at = datetime.now(timezone.utc)
    db.commit()

    if fill["status"] != "COMPLETE":
        audit.record(db, "live.entry_not_confirmed", {"order_id": entry_order_id, "status": fill["status"]})
        return {
            "action": "entry_unconfirmed",
            "order_id": entry_order_id,
            "status": fill["status"],
            "reasons": [
                "Entry order was not confirmed filled within the poll window. It may still fill — "
                "call /live/reconcile shortly to check again before assuming it failed."
            ],
        }

    filled_quantity = fill.get("filled_quantity") or quantity
    entry_price = fill.get("average_price") or signal.entry_price

    position = LivePosition(
        instrument_key=signal.instrument_key,
        side=signal.action,
        quantity=filled_quantity,
        entry_order_id=entry_order_id,
        entry_price=entry_price,
        stop_loss=signal.stop_loss,
        target=signal.target,
        status="OPEN",
    )
    db.add(position)
    db.commit()
    db.refresh(position)
    entry_order.position_id = position.id
    db.commit()

    audit.record(db, "live.position_opened", {
        "position_id": position.id, "instrument_key": position.instrument_key,
        "side": position.side, "quantity": position.quantity, "entry_price": position.entry_price,
    })

    protect_result = await _place_protective_orders(db, client, position)
    return {"action": "opened", "position_id": position.id, "entry_order_id": entry_order_id,
            "entry_price": entry_price, "quantity": filled_quantity, **protect_result}


async def _poll_for_fill(client: UpstoxClient, order_id: str) -> dict:
    settings = get_settings()
    last_status = "PENDING"
    for _ in range(settings.live_entry_fill_poll_attempts):
        try:
            detail = (await client.get_order_details(order_id)).get("data", {})
        except UpstoxAPIError:
            await asyncio.sleep(settings.live_entry_fill_poll_interval_seconds)
            continue
        status = _normalize_status(detail.get("status", ""))
        if status in ("COMPLETE", "REJECTED", "CANCELLED"):
            return {"status": status, "average_price": detail.get("average_price"), "filled_quantity": detail.get("filled_quantity")}
        last_status = status
        await asyncio.sleep(settings.live_entry_fill_poll_interval_seconds)
    return {"status": last_status}


def _normalize_status(raw: str) -> str:
    s = raw.lower()
    if "complete" in s:
        return "COMPLETE"
    if "reject" in s:
        return "REJECTED"
    if "cancel" in s:
        return "CANCELLED"
    return "OPEN"


async def _place_protective_orders(db: Session, client: UpstoxClient, position: LivePosition) -> dict:
    settings = get_settings()
    exit_side = "SELL" if position.side == "BUY" else "BUY"
    failures = []

    try:
        sl_response = await client.place_order(
            instrument_token=position.instrument_key, quantity=position.quantity,
            product=settings.live_order_product, order_type="SL-M",
            transaction_type=exit_side, trigger_price=position.stop_loss,
            tag=ORDER_TAG, algo_name=settings.upstox_algo_name,
        )
        stop_order_id = sl_response.get("data", {}).get("order_ids", [None])[0]
        if stop_order_id:
            position.stop_order_id = stop_order_id
            db.add(LiveOrder(upstox_order_id=stop_order_id, position_id=position.id, instrument_key=position.instrument_key,
                              role="STOP_LOSS", side=exit_side, quantity=position.quantity, order_type="SL-M", status="OPEN"))
        else:
            failures.append("stop-loss order: no order_id returned")
    except UpstoxAPIError as exc:
        failures.append(f"stop-loss order failed: {exc.message}")

    try:
        target_response = await client.place_order(
            instrument_token=position.instrument_key, quantity=position.quantity,
            product=settings.live_order_product, order_type="LIMIT",
            transaction_type=exit_side, price=position.target,
            tag=ORDER_TAG, algo_name=settings.upstox_algo_name,
        )
        target_order_id = target_response.get("data", {}).get("order_ids", [None])[0]
        if target_order_id:
            position.target_order_id = target_order_id
            db.add(LiveOrder(upstox_order_id=target_order_id, position_id=position.id, instrument_key=position.instrument_key,
                              role="TARGET", side=exit_side, quantity=position.quantity, order_type="LIMIT", status="OPEN"))
        else:
            failures.append("target order: no order_id returned")
    except UpstoxAPIError as exc:
        failures.append(f"target order failed: {exc.message}")

    if failures:
        position.stop_loss_placement_failed = not position.stop_order_id
        audit.record(db, "live.protective_order_failure", {"position_id": position.id, "failures": failures})

    db.commit()
    return {
        "stop_order_id": position.stop_order_id,
        "target_order_id": position.target_order_id,
        "protective_order_failures": failures,
    }


async def reconcile_instrument(db: Session, client: UpstoxClient, instrument_key: str) -> list[dict]:
    return [await _reconcile_position(db, client, p) for p in get_open_positions(db, instrument_key)]


async def reconcile_all(db: Session, client: UpstoxClient) -> list[dict]:
    return [await _reconcile_position(db, client, p) for p in get_open_positions(db)]


async def _reconcile_position(db: Session, client: UpstoxClient, position: LivePosition) -> dict:
    stop_status = await _check_order_status(client, position.stop_order_id) if position.stop_order_id else None
    target_status = await _check_order_status(client, position.target_order_id) if position.target_order_id else None

    exit_reason = None
    exit_price = None
    cancel_order_id = None

    if stop_status and stop_status["status"] == "COMPLETE":
        exit_reason, exit_price, cancel_order_id = "stop_loss", stop_status.get("average_price") or position.stop_loss, position.target_order_id
    elif target_status and target_status["status"] == "COMPLETE":
        exit_reason, exit_price, cancel_order_id = "target", target_status.get("average_price") or position.target, position.stop_order_id

    if exit_reason is None:
        return {"position_id": position.id, "status": "still_open"}

    if cancel_order_id:
        try:
            await client.cancel_order(cancel_order_id)
        except UpstoxAPIError as exc:
            audit.record(db, "live.cancel_counterpart_failed", {"position_id": position.id, "order_id": cancel_order_id, "error": exc.message})

    direction = 1 if position.side == "BUY" else -1
    gross_pnl = (exit_price - position.entry_price) * position.quantity * direction
    cost = costs.estimate_round_trip_cost(position.entry_price, exit_price, position.quantity)
    realized_pnl = gross_pnl - cost

    position.status = "CLOSED"
    position.exit_price = round(exit_price, 2)
    position.exit_reason = exit_reason
    position.costs = cost
    position.realized_pnl = round(realized_pnl, 2)
    position.closed_at = datetime.now(timezone.utc)

    today = get_today_risk_state(db)
    today.realized_pnl += position.realized_pnl
    today.trades_closed_count += 1
    settings = get_settings()
    if today.realized_pnl < 0:
        reference_capital, _ = await _available_capital(client)
        if abs(today.realized_pnl) / reference_capital >= settings.risk_max_daily_loss_pct:
            today.loss_limit_halted = True
            audit.record(db, "live.daily_loss_limit_hit", {"realized_pnl_today": today.realized_pnl})

    db.commit()
    audit.record(db, "live.position_closed", {
        "position_id": position.id, "exit_reason": exit_reason,
        "exit_price": position.exit_price, "realized_pnl": position.realized_pnl,
    })
    return {"position_id": position.id, "status": "closed", "exit_reason": exit_reason, "realized_pnl": position.realized_pnl}


async def _check_order_status(client: UpstoxClient, order_id: str) -> dict | None:
    try:
        detail = (await client.get_order_details(order_id)).get("data", {})
    except UpstoxAPIError:
        return None
    return {"status": _normalize_status(detail.get("status", "")), "average_price": detail.get("average_price")}


async def emergency_stop_all(db: Session, client: UpstoxClient) -> dict:
    """Flattens the ENTIRE Upstox account — every open order and position,
    not just ones this app placed. This is deliberately account-wide: an
    emergency stop that left the user's other manual positions exposed
    would defeat the purpose of a panic button.
    """
    account = get_or_create_account(db)
    errors = []
    try:
        cancel_response = await client.cancel_all_orders()
    except UpstoxAPIError as exc:
        cancel_response, errors = None, errors + [f"cancel_all_orders failed: {exc.message}"]

    try:
        exit_response = await client.exit_all_positions()
    except UpstoxAPIError as exc:
        exit_response, errors = None, errors + [f"exit_all_positions failed: {exc.message}"]

    for position in get_open_positions(db):
        position.status = "CLOSED"
        position.exit_reason = "emergency_stop"
        position.closed_at = datetime.now(timezone.utc)

    account.trading_halted = True
    db.commit()
    audit.record(db, "live.emergency_stop", {"errors": errors})
    return {"cancel_response": cancel_response, "exit_response": exit_response, "errors": errors}


def resume_trading(db: Session) -> None:
    account = get_or_create_account(db)
    account.trading_halted = False
    db.commit()
    audit.record(db, "live.resumed", {})


def position_dict(position: LivePosition) -> dict:
    return {
        "id": position.id,
        "instrument_key": position.instrument_key,
        "side": position.side,
        "quantity": position.quantity,
        "entry_price": position.entry_price,
        "stop_loss": position.stop_loss,
        "target": position.target,
        "stop_order_id": position.stop_order_id,
        "target_order_id": position.target_order_id,
        "stop_loss_placement_failed": position.stop_loss_placement_failed,
        "status": position.status,
        "exit_price": position.exit_price,
        "exit_reason": position.exit_reason,
        "realized_pnl": position.realized_pnl,
    }

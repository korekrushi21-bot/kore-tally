from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.time_utils import today_ist
from app.db.models import DailyRiskState, PaperAccount, PaperPosition
from app.engine import costs
from app.engine.risk import AccountSnapshot, RiskManager
from app.engine.strategy import Signal
from app.services import audit


def get_or_create_account(db: Session) -> PaperAccount:
    account = db.scalar(select(PaperAccount).limit(1))
    if account is None:
        account = PaperAccount(starting_capital=get_settings().paper_trading_starting_capital)
        db.add(account)
        db.commit()
        db.refresh(account)
    return account


def get_today_risk_state(db: Session) -> DailyRiskState:
    today = today_ist()
    state = db.scalar(select(DailyRiskState).where(DailyRiskState.trading_date == today))
    if state is None:
        state = DailyRiskState(trading_date=today)
        db.add(state)
        db.commit()
        db.refresh(state)
    return state


def get_open_positions(db: Session, instrument_key: str | None = None) -> list[PaperPosition]:
    stmt = select(PaperPosition).where(PaperPosition.status == "OPEN")
    if instrument_key:
        stmt = stmt.where(PaperPosition.instrument_key == instrument_key)
    return list(db.scalars(stmt))


def get_closed_positions(db: Session, limit: int = 50) -> list[PaperPosition]:
    stmt = (
        select(PaperPosition)
        .where(PaperPosition.status == "CLOSED")
        .order_by(PaperPosition.closed_at.desc())
        .limit(limit)
    )
    return list(db.scalars(stmt))


def evaluate_and_execute_signal(db: Session, signal: Signal, current_price: float) -> dict:
    if signal.action not in ("BUY", "SELL"):
        return {"action": "no_trade", "reasons": signal.reasons}

    account = get_or_create_account(db)
    today = get_today_risk_state(db)
    open_positions = get_open_positions(db)
    has_existing = any(p.instrument_key == signal.instrument_key for p in open_positions)

    snapshot = AccountSnapshot(
        capital=account.starting_capital,
        open_positions_count=len(open_positions),
        has_open_position_in_instrument=has_existing,
        daily_realized_pnl=today.realized_pnl,
        trading_halted=account.trading_halted,
        daily_loss_limit_halted=today.loss_limit_halted,
    )

    decision = RiskManager().evaluate(signal, snapshot)
    if not decision.approved:
        audit.record(
            db,
            "paper.signal_rejected",
            {"instrument_key": signal.instrument_key, "action": signal.action, "reasons": decision.reasons},
        )
        return {"action": "rejected", "reasons": decision.reasons, "signal": signal_dict(signal)}

    fill_price = costs.apply_slippage(current_price, signal.action, is_entry=True)
    position = PaperPosition(
        instrument_key=signal.instrument_key,
        side=signal.action,
        quantity=decision.quantity,
        entry_price=round(fill_price, 2),
        stop_loss=signal.stop_loss,
        target=signal.target,
        status="OPEN",
    )
    db.add(position)
    db.commit()
    db.refresh(position)

    audit.record(
        db,
        "paper.position_opened",
        {
            "position_id": position.id,
            "instrument_key": position.instrument_key,
            "side": position.side,
            "quantity": position.quantity,
            "entry_price": position.entry_price,
            "max_loss_amount": decision.max_loss_amount,
        },
    )
    return {"action": "opened", "position": position_dict(position), "max_loss_amount": decision.max_loss_amount}


def check_exits(db: Session, instrument_key: str, current_price: float) -> list[dict]:
    closed = []
    for position in get_open_positions(db, instrument_key=instrument_key):
        exit_reason = None
        if position.side == "BUY":
            if current_price <= position.stop_loss:
                exit_reason = "stop_loss"
            elif current_price >= position.target:
                exit_reason = "target"
        else:  # SELL
            if current_price >= position.stop_loss:
                exit_reason = "stop_loss"
            elif current_price <= position.target:
                exit_reason = "target"

        if exit_reason:
            closed.append(_close_position(db, position, current_price, exit_reason))
    return closed


def close_position_manual(db: Session, position_id: int, current_price: float, reason: str = "manual") -> dict:
    position = db.get(PaperPosition, position_id)
    if position is None or position.status != "OPEN":
        raise ValueError("No open position with that id")
    return _close_position(db, position, current_price, reason)


def emergency_stop_all(db: Session, price_lookup: dict[str, float] | None = None) -> list[dict]:
    price_lookup = price_lookup or {}
    account = get_or_create_account(db)
    closed = [
        _close_position(db, position, price_lookup.get(position.instrument_key, position.entry_price), "emergency_stop")
        for position in get_open_positions(db)
    ]
    account.trading_halted = True
    db.commit()
    audit.record(db, "paper.emergency_stop", {"positions_closed": len(closed)})
    return closed


def resume_trading(db: Session) -> None:
    account = get_or_create_account(db)
    account.trading_halted = False
    db.commit()
    audit.record(db, "paper.resumed", {})


def get_account_snapshot(db: Session, mark_prices: dict[str, float] | None = None) -> dict:
    mark_prices = mark_prices or {}
    account = get_or_create_account(db)
    today = get_today_risk_state(db)
    open_positions = get_open_positions(db)

    unrealized_pnl = 0.0
    position_dicts = []
    for p in open_positions:
        mark = mark_prices.get(p.instrument_key, p.entry_price)
        direction = 1 if p.side == "BUY" else -1
        pnl = (mark - p.entry_price) * p.quantity * direction
        unrealized_pnl += pnl
        position_dicts.append({**position_dict(p), "mark_price": mark, "unrealized_pnl": round(pnl, 2)})

    all_time_realized = _sum_all_realized_pnl(db)
    settings = get_settings()
    daily_loss_budget = account.starting_capital * settings.risk_max_daily_loss_pct

    return {
        "starting_capital": account.starting_capital,
        "net_equity": round(account.starting_capital + all_time_realized + unrealized_pnl, 2),
        "realized_pnl_all_time": round(all_time_realized, 2),
        "realized_pnl_today": round(today.realized_pnl, 2),
        "unrealized_pnl": round(unrealized_pnl, 2),
        "daily_risk_utilization_pct": round(max(0.0, -today.realized_pnl) / daily_loss_budget * 100, 1)
        if daily_loss_budget > 0
        else 0.0,
        "trading_halted": account.trading_halted,
        "daily_loss_limit_halted": today.loss_limit_halted,
        "open_positions": position_dicts,
    }


def _close_position(db: Session, position: PaperPosition, current_price: float, exit_reason: str) -> dict:
    exit_fill = costs.apply_slippage(current_price, position.side, is_entry=False)
    direction = 1 if position.side == "BUY" else -1
    gross_pnl = (exit_fill - position.entry_price) * position.quantity * direction
    cost = costs.estimate_round_trip_cost(position.entry_price, exit_fill, position.quantity)
    realized_pnl = gross_pnl - cost

    position.status = "CLOSED"
    position.exit_price = round(exit_fill, 2)
    position.exit_reason = exit_reason
    position.costs = cost
    position.realized_pnl = round(realized_pnl, 2)
    position.closed_at = datetime.now(timezone.utc)

    today = get_today_risk_state(db)
    today.realized_pnl += position.realized_pnl
    today.trades_closed_count += 1

    account = get_or_create_account(db)
    settings = get_settings()
    if today.realized_pnl < 0 and abs(today.realized_pnl) / account.starting_capital >= settings.risk_max_daily_loss_pct:
        today.loss_limit_halted = True
        audit.record(db, "paper.daily_loss_limit_hit", {"realized_pnl_today": today.realized_pnl})

    db.commit()
    audit.record(
        db,
        "paper.position_closed",
        {
            "position_id": position.id,
            "exit_reason": exit_reason,
            "exit_price": position.exit_price,
            "realized_pnl": position.realized_pnl,
        },
    )
    return position_dict(position)


def _sum_all_realized_pnl(db: Session) -> float:
    closed = db.scalars(select(PaperPosition).where(PaperPosition.status == "CLOSED"))
    return sum(p.realized_pnl or 0.0 for p in closed)


def position_dict(position: PaperPosition) -> dict:
    return {
        "id": position.id,
        "instrument_key": position.instrument_key,
        "side": position.side,
        "quantity": position.quantity,
        "entry_price": position.entry_price,
        "stop_loss": position.stop_loss,
        "target": position.target,
        "status": position.status,
        "exit_price": position.exit_price,
        "exit_reason": position.exit_reason,
        "realized_pnl": position.realized_pnl,
    }


def signal_dict(signal: Signal) -> dict:
    return {
        "instrument_key": signal.instrument_key,
        "action": signal.action,
        "entry_price": signal.entry_price,
        "stop_loss": signal.stop_loss,
        "target": signal.target,
        "risk_reward": signal.risk_reward,
        "strength": signal.strength,
        "reasons": signal.reasons,
    }

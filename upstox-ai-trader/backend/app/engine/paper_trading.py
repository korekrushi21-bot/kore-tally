from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.time_utils import today_ist
from app.db.models import DailyRiskState, PaperAccount, PaperOptionLeg, PaperPosition
from app.engine import costs, options
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


def evaluate_and_execute_option_signal(
    db: Session,
    signal: Signal,
    contract: options.OptionContract,
    premium: float,
    spot: float | None = None,
    as_of: date | None = None,
) -> dict:
    """Turns an UNDERLYING signal into a bought CE (BUY signal) or PE (SELL
    signal) paper position, sized in whole lots. See app/engine/options.py.
    """
    if signal.action not in ("BUY", "SELL"):
        return {"action": "no_trade", "reasons": signal.reasons}
    expected_type = options.option_type_for_signal(signal.action)
    if contract.option_type != expected_type:
        return {
            "action": "rejected",
            "reasons": [f"A {signal.action} signal trades a {expected_type}, not a {contract.option_type}"],
            "signal": signal_dict(signal),
        }

    as_of = as_of or today_ist()
    settings = get_settings()
    days_left = (contract.expiry - as_of).days
    delta = options.estimate_delta(
        premium, spot or signal.entry_price or 0, contract.strike, contract.expiry, as_of, contract.option_type,
        settings.option_risk_free_rate,
    )

    account = get_or_create_account(db)
    today = get_today_risk_state(db)
    open_positions = get_open_positions(db)
    snapshot = AccountSnapshot(
        capital=account.starting_capital,
        open_positions_count=len(open_positions),
        has_open_position_in_instrument=any(
            p.option_leg is not None and p.option_leg.underlying_key == signal.instrument_key for p in open_positions
        ),
        daily_realized_pnl=today.realized_pnl,
        trading_halted=account.trading_halted,
        daily_loss_limit_halted=today.loss_limit_halted,
    )

    decision = RiskManager().evaluate_option(signal, snapshot, premium, delta, contract.lot_size)
    if days_left < settings.option_min_days_to_expiry:
        decision.approved = False
        decision.reasons.append(
            f"Contract expires in {days_left} day(s); the minimum is {settings.option_min_days_to_expiry}"
        )

    contract_info = option_contract_dict(contract)
    if not decision.approved:
        audit.record(
            db,
            "paper.option_signal_rejected",
            {"underlying_key": signal.instrument_key, "contract": contract.instrument_key, "reasons": decision.reasons},
        )
        return {
            "action": "rejected",
            "reasons": decision.reasons,
            "signal": signal_dict(signal),
            "contract": contract_info,
            "premium": premium,
            "delta": round(delta, 3) if delta is not None else None,
        }

    fill_price = costs.apply_slippage(premium, "BUY", is_entry=True)
    premium_stop, premium_target = options.premium_levels(
        fill_price, delta, signal.entry_price, signal.stop_loss, signal.target
    )
    position = PaperPosition(
        instrument_key=contract.instrument_key,
        side="BUY",  # options are only ever bought, never written
        quantity=decision.quantity,
        entry_price=round(fill_price, 2),
        stop_loss=premium_stop,
        target=premium_target,
        status="OPEN",
    )
    position.option_leg = PaperOptionLeg(
        underlying_key=signal.instrument_key,
        option_type=contract.option_type,
        strike=contract.strike,
        expiry=contract.expiry,
        lot_size=contract.lot_size,
        lots=decision.lots,
        trading_symbol=contract.trading_symbol,
        underlying_entry=signal.entry_price,
        underlying_stop=signal.stop_loss,
        underlying_target=signal.target,
        entry_delta=round(delta, 4),
    )
    db.add(position)
    db.commit()
    db.refresh(position)

    audit.record(
        db,
        "paper.option_position_opened",
        {
            "position_id": position.id,
            "contract": contract.instrument_key,
            "trading_symbol": contract.trading_symbol,
            "lots": decision.lots,
            "quantity": position.quantity,
            "entry_premium": position.entry_price,
            "max_loss_amount": decision.max_loss_amount,
        },
    )
    return {
        "action": "opened",
        "position": position_dict(position),
        "contract": contract_info,
        "max_loss_amount": decision.max_loss_amount,
        "delta": round(delta, 3),
    }


def check_option_exits(
    db: Session,
    underlying_key: str,
    underlying_price: float,
    option_prices: dict[str, float],
    as_of: date | None = None,
) -> list[dict]:
    """Closes open option positions on this underlying when the underlying
    crosses the signal's stop/target, or on/after expiry day. Positions whose
    option price is unknown right now are left open (never closed at a guess).
    """
    as_of = as_of or today_ist()
    closed = []
    for position in get_open_positions(db):
        leg = position.option_leg
        if leg is None or leg.underlying_key != underlying_key:
            continue
        price = option_prices.get(position.instrument_key)
        if price is None:
            continue
        if as_of >= leg.expiry:
            reason = "expiry"
        else:
            reason = options.underlying_exit_reason(
                leg.option_type, underlying_price, underlying_price, leg.underlying_stop, leg.underlying_target
            )
        if reason:
            closed.append(_close_position(db, position, price, reason))
    return closed


def open_option_keys(db: Session, underlying_key: str) -> list[str]:
    return [
        p.instrument_key
        for p in get_open_positions(db)
        if p.option_leg is not None and p.option_leg.underlying_key == underlying_key
    ]


def option_contract_dict(contract: options.OptionContract) -> dict:
    return {
        "instrument_key": contract.instrument_key,
        "underlying_key": contract.underlying_key,
        "option_type": contract.option_type,
        "strike": contract.strike,
        "expiry": contract.expiry.isoformat(),
        "lot_size": contract.lot_size,
        "trading_symbol": contract.trading_symbol,
    }


def check_exits(db: Session, instrument_key: str, current_price: float) -> list[dict]:
    closed = []
    for position in get_open_positions(db, instrument_key=instrument_key):
        if position.option_leg is not None:
            continue  # option exits are driven by the underlying — see check_option_exits
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
        "risk_per_trade_pct": settings.risk_max_per_trade_pct,
        "max_open_positions": settings.risk_max_open_positions,
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
        "option": _option_leg_dict(position.option_leg),
    }


def _option_leg_dict(leg: PaperOptionLeg | None) -> dict | None:
    if leg is None:
        return None
    return {
        "underlying_key": leg.underlying_key,
        "option_type": leg.option_type,
        "strike": leg.strike,
        "expiry": leg.expiry.isoformat(),
        "lot_size": leg.lot_size,
        "lots": leg.lots,
        "trading_symbol": leg.trading_symbol,
        "underlying_entry": leg.underlying_entry,
        "underlying_stop": leg.underlying_stop,
        "underlying_target": leg.underlying_target,
        "entry_delta": leg.entry_delta,
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

from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, Float, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class BrokerSession(Base):
    """One row per Upstox login. Only ever one active row at a time in this
    single-user app; the access token is stored encrypted and is never
    exposed via any API response.
    """

    __tablename__ = "broker_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    upstox_user_id: Mapped[str] = mapped_column(String(64))
    upstox_user_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    access_token_encrypted: Mapped[str] = mapped_column(String(2048))
    token_generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    token_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AuditLog(Base):
    """Append-only record of auth and data-access events. Never stores raw
    tokens or secrets — only event metadata.
    """

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    event_type: Mapped[str] = mapped_column(String(64))
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PaperAccount(Base):
    """Single-row simulated trading account. `trading_halted` is the
    persistent emergency-stop kill switch (manual resume required); it is
    distinct from DailyRiskState.loss_limit_halted, which auto-resets every
    new trading day.
    """

    __tablename__ = "paper_account"

    id: Mapped[int] = mapped_column(primary_key=True)
    starting_capital: Mapped[float] = mapped_column(Float)
    trading_halted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PaperPosition(Base):
    __tablename__ = "paper_positions"

    id: Mapped[int] = mapped_column(primary_key=True)
    instrument_key: Mapped[str] = mapped_column(String(64))
    side: Mapped[str] = mapped_column(String(8))  # BUY | SELL
    quantity: Mapped[int] = mapped_column(Integer)
    entry_price: Mapped[float] = mapped_column(Float)
    stop_loss: Mapped[float] = mapped_column(Float)
    target: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(8), default="OPEN")  # OPEN | CLOSED
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    exit_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    costs: Mapped[float | None] = mapped_column(Float, nullable=True)
    realized_pnl: Mapped[float | None] = mapped_column(Float, nullable=True)


class DailyRiskState(Base):
    """One row per trading day (IST). Tracks realized P&L for the day and
    whether the daily loss limit has halted new entries — resets naturally
    each day since it's keyed by date.
    """

    __tablename__ = "daily_risk_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    trading_date: Mapped[date] = mapped_column(Date, unique=True)
    realized_pnl: Mapped[float] = mapped_column(Float, default=0.0)
    trades_closed_count: Mapped[int] = mapped_column(Integer, default=0)
    loss_limit_halted: Mapped[bool] = mapped_column(Boolean, default=False)


class LiveAccount(Base):
    """Single-row real-money trading account marker. `trading_halted` is the
    persistent emergency-stop kill switch for LIVE trading specifically —
    separate from PaperAccount.trading_halted, so stopping one never silently
    stops (or masks the state of) the other.
    """

    __tablename__ = "live_account"

    id: Mapped[int] = mapped_column(primary_key=True)
    trading_halted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class LiveOrder(Base):
    """Every order this app has ever placed with Upstox — entry, stop-loss,
    and target legs each get their own row. This is the source of truth for
    duplicate-order prevention and for reconciling fills; it is never
    inferred from LivePosition alone.
    """

    __tablename__ = "live_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    upstox_order_id: Mapped[str] = mapped_column(String(64))
    position_id: Mapped[int | None] = mapped_column(nullable=True)
    instrument_key: Mapped[str] = mapped_column(String(64))
    role: Mapped[str] = mapped_column(String(16))  # ENTRY | STOP_LOSS | TARGET | EMERGENCY_EXIT
    side: Mapped[str] = mapped_column(String(8))  # BUY | SELL
    quantity: Mapped[int] = mapped_column(Integer)
    order_type: Mapped[str] = mapped_column(String(8))  # MARKET | LIMIT | SL | SL-M
    status: Mapped[str] = mapped_column(String(16), default="PENDING")  # PENDING|OPEN|COMPLETE|CANCELLED|REJECTED
    placed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    average_price: Mapped[float | None] = mapped_column(Float, nullable=True)


class LivePosition(Base):
    """A real position this app opened and is tracking. `realized_pnl` on
    close is this app's own estimate (entry/exit fill prices minus the
    approximate cost model) — always reconcile against your actual Upstox
    contract notes/ledger for the figure that matters for taxes or real
    accounting.
    """

    __tablename__ = "live_positions"

    id: Mapped[int] = mapped_column(primary_key=True)
    instrument_key: Mapped[str] = mapped_column(String(64))
    side: Mapped[str] = mapped_column(String(8))
    quantity: Mapped[int] = mapped_column(Integer)
    entry_order_id: Mapped[str] = mapped_column(String(64))
    entry_price: Mapped[float] = mapped_column(Float)
    stop_loss: Mapped[float] = mapped_column(Float)
    target: Mapped[float] = mapped_column(Float)
    stop_order_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    target_order_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    stop_loss_placement_failed: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(8), default="OPEN")  # OPEN | CLOSED
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    exit_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    costs: Mapped[float | None] = mapped_column(Float, nullable=True)
    realized_pnl: Mapped[float | None] = mapped_column(Float, nullable=True)


class LiveDailyRiskState(Base):
    """Same shape as DailyRiskState, kept as a separate table so live and
    paper daily-loss tracking can never cross-contaminate. Only reflects
    P&L from trades THIS app placed — it has no visibility into trades you
    place manually elsewhere on the same Upstox account.
    """

    __tablename__ = "live_daily_risk_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    trading_date: Mapped[date] = mapped_column(Date, unique=True)
    realized_pnl: Mapped[float] = mapped_column(Float, default=0.0)
    trades_closed_count: Mapped[int] = mapped_column(Integer, default=0)
    loss_limit_halted: Mapped[bool] = mapped_column(Boolean, default=False)

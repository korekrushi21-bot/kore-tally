from datetime import date, datetime

from sqlalchemy import JSON, Boolean, Date, DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

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

    # Set only for option positions; None for plain equity positions.
    option_leg: Mapped["PaperOptionLeg | None"] = relationship(
        back_populates="position", uselist=False, lazy="selectin", cascade="all, delete-orphan"
    )


class PaperOptionLeg(Base):
    """Option-specific details of a PaperPosition (a separate table, so the
    existing paper_positions schema needs no migration). The position's own
    stop_loss/target hold delta-projected PREMIUM levels for display; exits are
    driven by the underlying_* levels stored here — see app/engine/options.py.
    """

    __tablename__ = "paper_option_legs"

    id: Mapped[int] = mapped_column(primary_key=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("paper_positions.id"), unique=True)
    underlying_key: Mapped[str] = mapped_column(String(64))
    option_type: Mapped[str] = mapped_column(String(2))  # CE | PE
    strike: Mapped[float] = mapped_column(Float)
    expiry: Mapped[date] = mapped_column(Date)
    lot_size: Mapped[int] = mapped_column(Integer)
    lots: Mapped[int] = mapped_column(Integer)
    trading_symbol: Mapped[str] = mapped_column(String(64), default="")
    underlying_entry: Mapped[float] = mapped_column(Float)
    underlying_stop: Mapped[float] = mapped_column(Float)
    underlying_target: Mapped[float] = mapped_column(Float)
    entry_delta: Mapped[float] = mapped_column(Float)

    position: Mapped[PaperPosition] = relationship(back_populates="option_leg")


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


class ScanRun(Base):
    """One morning-scan pass over the F&O stock universe."""

    __tablename__ = "scan_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="RUNNING")  # RUNNING | DONE | FAILED
    trigger: Mapped[str] = mapped_column(String(16), default="manual")  # manual | scheduled
    universe_size: Mapped[int] = mapped_column(Integer, default=0)
    scanned_count: Mapped[int] = mapped_column(Integer, default=0)
    error_count: Mapped[int] = mapped_column(Integer, default=0)
    data_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    message: Mapped[str | None] = mapped_column(String(512), nullable=True)


class ScanResult(Base):
    """Signal + backtest summary for one stock in one scan run."""

    __tablename__ = "scan_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("scan_runs.id"), index=True)
    instrument_key: Mapped[str] = mapped_column(String(64))
    symbol: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(128), default="")
    lot_size: Mapped[int] = mapped_column(Integer, default=0)
    last_close: Mapped[float | None] = mapped_column(Float, nullable=True)
    action: Mapped[str] = mapped_column(String(8))  # BUY | SELL | NO_TRADE | ERROR
    strength: Mapped[float] = mapped_column(Float, default=0.0)
    entry_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    stop_loss: Mapped[float | None] = mapped_column(Float, nullable=True)
    target: Mapped[float | None] = mapped_column(Float, nullable=True)
    risk_reward: Mapped[float | None] = mapped_column(Float, nullable=True)
    reasons: Mapped[list | None] = mapped_column(JSON, nullable=True)
    bt_trades: Mapped[int] = mapped_column(Integer, default=0)
    bt_win_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    bt_profit_factor: Mapped[float | None] = mapped_column(Float, nullable=True)
    bt_net_pnl: Mapped[float | None] = mapped_column(Float, nullable=True)
    bt_max_drawdown_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    bt_verdict: Mapped[str] = mapped_column(String(16), default="")  # supports | mixed | against | too_few
    error: Mapped[str | None] = mapped_column(String(256), nullable=True)


class ScanOptionPlan(Base):
    """The concrete option trade suggested for one scan result (a separate
    table so scan_results needs no migration)."""

    __tablename__ = "scan_option_plans"

    id: Mapped[int] = mapped_column(primary_key=True)
    result_id: Mapped[int] = mapped_column(ForeignKey("scan_results.id"), unique=True, index=True)
    plan: Mapped[dict] = mapped_column(JSON)

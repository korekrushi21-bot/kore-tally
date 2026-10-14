import math
from dataclasses import dataclass, field

from app.core.config import get_settings
from app.engine.strategy import Signal


@dataclass
class RiskConfig:
    max_risk_per_trade_pct: float
    max_daily_loss_pct: float
    max_open_positions: int
    min_risk_reward: float
    allow_averaging_down: bool = False

    @classmethod
    def from_settings(cls) -> "RiskConfig":
        s = get_settings()
        return cls(
            max_risk_per_trade_pct=s.risk_max_per_trade_pct,
            max_daily_loss_pct=s.risk_max_daily_loss_pct,
            max_open_positions=s.risk_max_open_positions,
            min_risk_reward=s.risk_min_reward_ratio,
            allow_averaging_down=s.risk_allow_averaging_down,
        )


@dataclass
class AccountSnapshot:
    capital: float
    open_positions_count: int
    has_open_position_in_instrument: bool
    daily_realized_pnl: float
    trading_halted: bool
    daily_loss_limit_halted: bool


@dataclass
class RiskDecision:
    approved: bool
    quantity: int = 0
    max_loss_amount: float = 0.0
    reasons: list[str] = field(default_factory=list)


class RiskManager:
    def __init__(self, config: RiskConfig | None = None):
        self.config = config or RiskConfig.from_settings()

    def position_size(self, capital: float, entry_price: float, stop_loss: float) -> int:
        risk_per_unit = abs(entry_price - stop_loss)
        if risk_per_unit <= 0:
            return 0
        max_risk_amount = capital * self.config.max_risk_per_trade_pct
        return math.floor(max_risk_amount / risk_per_unit)

    def evaluate(self, signal: Signal, account: AccountSnapshot) -> RiskDecision:
        reasons: list[str] = []

        if account.trading_halted:
            return RiskDecision(approved=False, reasons=["Trading is halted (emergency stop is active)"])

        if account.daily_loss_limit_halted:
            return RiskDecision(approved=False, reasons=["Daily loss limit already reached — no new trades until next session"])

        if signal.action not in ("BUY", "SELL"):
            return RiskDecision(approved=False, reasons=["Not an actionable signal"])

        if signal.is_stale:
            return RiskDecision(approved=False, reasons=["Market data is stale — refusing to trade on it"])

        if not signal.stop_loss or not signal.entry_price:
            return RiskDecision(approved=False, reasons=["Signal has no valid stop-loss — every trade must have one"])

        if signal.risk_reward is None or signal.risk_reward < self.config.min_risk_reward:
            reasons.append(
                f"Risk:reward {signal.risk_reward} is below the minimum {self.config.min_risk_reward}:1"
            )

        if account.open_positions_count >= self.config.max_open_positions:
            reasons.append(f"Already at the max of {self.config.max_open_positions} simultaneous positions")

        if account.has_open_position_in_instrument and not self.config.allow_averaging_down:
            reasons.append("A position in this instrument is already open — averaging down is disabled")

        if account.daily_realized_pnl < 0:
            loss_pct = abs(account.daily_realized_pnl) / account.capital
            if loss_pct >= self.config.max_daily_loss_pct:
                reasons.append(
                    f"Today's realized loss ({loss_pct:.2%}) has reached the daily limit "
                    f"({self.config.max_daily_loss_pct:.2%})"
                )

        quantity = self.position_size(account.capital, signal.entry_price, signal.stop_loss)
        if quantity < 1:
            reasons.append("Computed position size rounds to zero for this capital/risk% and stop distance")

        if reasons:
            return RiskDecision(approved=False, quantity=quantity, reasons=reasons)

        max_loss_amount = quantity * abs(signal.entry_price - signal.stop_loss)
        return RiskDecision(approved=True, quantity=quantity, max_loss_amount=round(max_loss_amount, 2))

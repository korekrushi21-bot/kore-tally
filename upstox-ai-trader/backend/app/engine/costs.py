"""Approximate Indian equity trading cost model, used only to make PAPER
P&L realistic. These are NOT real brokerage/tax figures — they are
configurable approximations (see Settings) and must never be used to bill
or represent a real trade's actual cost. Real costs vary by broker,
instrument, product type, and change with regulation.
"""
from app.core.config import get_settings


def estimate_round_trip_cost(entry_price: float, exit_price: float, quantity: int) -> float:
    settings = get_settings()
    turnover = (entry_price + exit_price) * quantity
    brokerage = 2 * settings.cost_brokerage_per_order
    charges = turnover * settings.cost_pct_charges
    return round(brokerage + charges, 2)


def apply_slippage(price: float, side: str, is_entry: bool) -> float:
    """Market-order fills are assumed to happen `slippage_bps` worse than the
    last quoted price, in the direction that hurts the trade.
    """
    settings = get_settings()
    factor = settings.slippage_bps / 10_000
    buy_side = side == "BUY"
    worse_direction = buy_side if is_entry else not buy_side
    return price * (1 + factor) if worse_direction else price * (1 - factor)

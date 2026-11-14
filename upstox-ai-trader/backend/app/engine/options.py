"""Index/stock OPTIONS support (F&O), for paper trading and backtesting only.

How a signal becomes an option trade
------------------------------------
The strategy (`generate_signal`) always runs on the UNDERLYING's candles (e.g.
RECLTD or NIFTY), never on the option's own premium chart:

  * BUY  signal on the underlying -> BUY a CALL (CE)
  * SELL signal on the underlying -> BUY a PUT  (PE)

This app only ever BUYS options. It never writes/sells them: an option buyer's
worst case is the premium paid, while an option seller's loss is open-ended,
which this risk engine is not designed to bound.

Exits are driven by the UNDERLYING crossing the signal's own stop-loss/target
(the same levels the equity path uses), and P&L is booked on the option premium.
The same rule is used by paper trading and by the options backtester, so the
two cannot silently diverge.

Position sizing
---------------
Options move roughly `delta` rupees per rupee of underlying move. The expected
premium loss per unit if the underlying runs to its stop is therefore about
`delta * |entry - stop|`, capped at the premium itself (a bought option cannot
lose more than what was paid). Delta is computed with Black-Scholes from the
option's own market price (implied volatility solved by bisection), so paper
trading and backtests both use exactly the same estimate, with no dependency on
broker-supplied greeks.

This is a first-order estimate: it ignores gamma and, importantly, theta (time
decay). A position held for days can lose more than this estimate even if the
underlying never reaches the stop. The expiry guard (`option_min_days_to_expiry`)
and forced exit on expiry day exist to limit exactly that.
"""
import math
from dataclasses import dataclass
from datetime import date, datetime


@dataclass(frozen=True)
class OptionContract:
    instrument_key: str
    underlying_key: str
    option_type: str  # "CE" | "PE"
    strike: float
    expiry: date
    lot_size: int
    trading_symbol: str = ""


def parse_contracts(response: dict) -> list[OptionContract]:
    """Parses GET /v2/option/contract. `expiry` is documented as YYYY-MM-DD; an
    epoch-milliseconds value is also accepted defensively.
    """
    contracts: list[OptionContract] = []
    for row in response.get("data") or []:
        if not isinstance(row, dict):
            continue
        option_type = row.get("instrument_type")
        expiry = _parse_expiry(row.get("expiry"))
        if option_type not in ("CE", "PE") or expiry is None:
            continue
        try:
            contracts.append(
                OptionContract(
                    instrument_key=row["instrument_key"],
                    underlying_key=row.get("underlying_key", ""),
                    option_type=option_type,
                    strike=float(row["strike_price"]),
                    expiry=expiry,
                    lot_size=int(row["lot_size"]),
                    trading_symbol=row.get("trading_symbol", ""),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return contracts


def _parse_expiry(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000).date()
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def option_type_for_signal(action: str) -> str | None:
    return {"BUY": "CE", "SELL": "PE"}.get(action)


def select_contract(
    contracts: list[OptionContract],
    option_type: str,
    spot: float,
    today: date,
    min_days_to_expiry: int,
    strike_offset: int = 0,
    expiry: date | None = None,
) -> tuple[OptionContract | None, str | None]:
    """Picks a contract: the requested expiry (or the nearest one with at least
    `min_days_to_expiry` days left), then the strike nearest to spot (ATM),
    shifted by `strike_offset` strikes. Positive offset = further out-of-the-money
    (higher strike for CE, lower for PE); negative = in-the-money.
    Returns (contract, None) or (None, reason).
    """
    of_type = [c for c in contracts if c.option_type == option_type]
    if not of_type:
        return None, f"No {option_type} contracts available for this underlying"

    if expiry is not None:
        chosen_expiry = expiry
        if not any(c.expiry == expiry for c in of_type):
            return None, f"No {option_type} contracts for expiry {expiry.isoformat()}"
    else:
        eligible = sorted({c.expiry for c in of_type if (c.expiry - today).days >= min_days_to_expiry})
        if not eligible:
            return None, f"Every available expiry is less than {min_days_to_expiry} days away"
        chosen_expiry = eligible[0]

    days_left = (chosen_expiry - today).days
    if days_left < min_days_to_expiry:
        return None, (
            f"Expiry {chosen_expiry.isoformat()} is only {days_left} day(s) away; the minimum is "
            f"{min_days_to_expiry} (time decay accelerates sharply near expiry)"
        )

    strikes = sorted({c.strike for c in of_type if c.expiry == chosen_expiry})
    atm_index = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
    step = strike_offset if option_type == "CE" else -strike_offset
    index = atm_index + step
    if not 0 <= index < len(strikes):
        return None, f"Strike offset {strike_offset} is outside the listed strikes for this expiry"

    strike = strikes[index]
    contract = next(c for c in of_type if c.expiry == chosen_expiry and c.strike == strike)
    return contract, None


# --- Black-Scholes (European, no dividends) ----------------------------------

def _norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_price(spot: float, strike: float, years: float, rate: float, vol: float, option_type: str) -> float:
    if years <= 0 or vol <= 0:
        intrinsic = spot - strike if option_type == "CE" else strike - spot
        return max(0.0, intrinsic)
    d1 = (math.log(spot / strike) + (rate + 0.5 * vol * vol) * years) / (vol * math.sqrt(years))
    d2 = d1 - vol * math.sqrt(years)
    if option_type == "CE":
        return spot * _norm_cdf(d1) - strike * math.exp(-rate * years) * _norm_cdf(d2)
    return strike * math.exp(-rate * years) * _norm_cdf(-d2) - spot * _norm_cdf(-d1)


def bs_delta(spot: float, strike: float, years: float, rate: float, vol: float, option_type: str) -> float:
    d1 = (math.log(spot / strike) + (rate + 0.5 * vol * vol) * years) / (vol * math.sqrt(years))
    return _norm_cdf(d1) if option_type == "CE" else _norm_cdf(d1) - 1


def implied_vol(premium: float, spot: float, strike: float, years: float, rate: float, option_type: str) -> float | None:
    """Bisection between 1% and 500% annualised vol. Returns None when the
    premium is outside what any volatility in that range can produce (e.g. a
    premium below intrinsic value, which happens with stale/illiquid quotes).
    """
    low, high = 0.01, 5.0
    if not (bs_price(spot, strike, years, rate, low, option_type) <= premium <= bs_price(spot, strike, years, rate, high, option_type)):
        return None
    for _ in range(100):
        mid = (low + high) / 2
        if bs_price(spot, strike, years, rate, mid, option_type) < premium:
            low = mid
        else:
            high = mid
    return (low + high) / 2


def years_to_expiry(expiry: date, as_of: date) -> float:
    # Expiry-day positions are force-closed, so never model less than one day left.
    return max((expiry - as_of).days, 1) / 365


def estimate_delta(
    premium: float, spot: float, strike: float, expiry: date, as_of: date, option_type: str, rate: float
) -> float | None:
    """Absolute delta (0..1), or None if no implied vol fits the premium."""
    if premium <= 0 or spot <= 0 or strike <= 0:
        return None
    years = years_to_expiry(expiry, as_of)
    vol = implied_vol(premium, spot, strike, years, rate, option_type)
    if vol is None:
        return None
    return abs(bs_delta(spot, strike, years, rate, vol, option_type))


def premium_levels(premium: float, delta: float, underlying_entry: float, underlying_stop: float, underlying_target: float) -> tuple[float, float]:
    """Delta-projected premium at the underlying's stop and target. For display
    and sizing only: exits are triggered by the underlying, not these numbers.
    """
    stop = max(0.05, premium - delta * abs(underlying_entry - underlying_stop))
    target = premium + delta * abs(underlying_target - underlying_entry)
    return round(stop, 2), round(target, 2)


def underlying_exit_reason(option_type: str, underlying_low: float, underlying_high: float, stop: float, target: float) -> str | None:
    """CE positions came from a BUY signal (stop below, target above); PE from a
    SELL signal (stop above, target below). If one bar's range touches both,
    the stop is assumed hit first, same as the equity backtester.
    """
    if option_type == "CE":
        if underlying_low <= stop:
            return "stop_loss"
        if underlying_high >= target:
            return "target"
    else:
        if underlying_high >= stop:
            return "stop_loss"
        if underlying_low <= target:
            return "target"
    return None

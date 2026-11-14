"""F&O stock universe and option contracts for the morning scan.

Source: Upstox's public beginning-of-day instrument file
  https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz
(verified Nov 2026: a JSON list; F&O futures have segment "NSE_FO",
instrument_type "FUT", underlying_type "EQUITY", underlying_key "NSE_EQ|<ISIN>";
options have instrument_type "CE"/"PE", strike_price, lot_size, trading_symbol
and expiry as epoch milliseconds).

The file is public, so unlike Upstox's option-contract API it needs no login,
which is what lets the 9:00 scan work before the daily OAuth login. It is
downloaded at most once per day and cached in backend/data/.
"""
import gzip
import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import httpx

from app.engine.options import OptionContract, parse_contracts

INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz"
_DATA_DIR = Path(__file__).resolve().parents[2] / "data"


@dataclass
class FnoData:
    universe: list[dict]
    options: dict[str, list[OptionContract]]  # underlying_key -> contracts
    future_to_underlying: dict[str, str] = None  # "NSE_FO|..." future -> "NSE_EQ|..." stock


def parse_fno_universe(instruments: list[dict]) -> list[dict]:
    names = {
        row["instrument_key"]: row.get("name", "")
        for row in instruments
        if row.get("segment") == "NSE_EQ" and "instrument_key" in row
    }
    universe: dict[str, dict] = {}
    for row in instruments:
        if (
            row.get("segment") == "NSE_FO"
            and row.get("instrument_type") == "FUT"
            and row.get("underlying_type") == "EQUITY"
            and row.get("underlying_key")
        ):
            key = row["underlying_key"]
            universe.setdefault(
                key,
                {
                    "instrument_key": key,
                    "symbol": row.get("underlying_symbol", ""),
                    "name": names.get(key, ""),
                    "lot_size": int(row.get("lot_size") or 0),
                },
            )
    return sorted(universe.values(), key=lambda r: r["symbol"])


def parse_stock_options(instruments: list[dict], underlying_keys: set[str]) -> dict[str, list[OptionContract]]:
    rows = [
        row
        for row in instruments
        if row.get("segment") == "NSE_FO"
        and row.get("instrument_type") in ("CE", "PE")
        and row.get("underlying_key") in underlying_keys
    ]
    by_underlying: dict[str, list[OptionContract]] = {}
    for contract in parse_contracts({"data": rows}):
        by_underlying.setdefault(contract.underlying_key, []).append(contract)
    return by_underlying


async def _instrument_rows(today: date, force_refresh: bool) -> list[dict]:
    cache = _DATA_DIR / f"NSE-{today.isoformat()}.json.gz"
    if force_refresh or not cache.exists():
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.get(INSTRUMENTS_URL)
            response.raise_for_status()
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        for old in _DATA_DIR.glob("NSE-*.json.gz"):  # keep only today's copy
            old.unlink(missing_ok=True)
        cache.write_bytes(response.content)
    return json.loads(gzip.decompress(cache.read_bytes()))


async def load_fno_data(today: date, force_refresh: bool = False) -> FnoData:
    rows = await _instrument_rows(today, force_refresh)
    universe = parse_fno_universe(rows)
    if not universe:
        raise RuntimeError("Upstox instrument file contained no F&O stock futures")
    options = parse_stock_options(rows, {u["instrument_key"] for u in universe})
    futures = {
        row["instrument_key"]: row["underlying_key"]
        for row in rows
        if row.get("segment") == "NSE_FO" and row.get("instrument_type") == "FUT" and row.get("underlying_key")
    }
    return FnoData(universe=universe, options=options, future_to_underlying=futures)


async def load_fno_universe(today: date, force_refresh: bool = False) -> list[dict]:
    return (await load_fno_data(today, force_refresh)).universe

"""F&O stock universe for the morning scan.

Source: Upstox's public beginning-of-day instrument file
  https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz
(verified Nov 2026: a JSON list; F&O futures have segment "NSE_FO",
instrument_type "FUT", underlying_type "EQUITY", underlying_key "NSE_EQ|<ISIN>").

The universe is every equity that currently has a listed stock future, which is
the same set of stocks that have stock options. It is cached on disk and
refreshed at most once per day.
"""
import gzip
import json
from datetime import date
from pathlib import Path

import httpx

INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz"
_CACHE_FILE = Path(__file__).resolve().parents[2] / "data" / "fno_universe.json"


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


async def load_fno_universe(today: date, force_refresh: bool = False) -> list[dict]:
    if not force_refresh and _CACHE_FILE.exists():
        cached = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        if cached.get("date") == today.isoformat() and cached.get("universe"):
            return cached["universe"]

    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.get(INSTRUMENTS_URL)
        response.raise_for_status()
    universe = parse_fno_universe(json.loads(gzip.decompress(response.content)))
    if not universe:
        raise RuntimeError("Upstox instrument file contained no F&O stock futures")

    _CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    _CACHE_FILE.write_text(json.dumps({"date": today.isoformat(), "universe": universe}), encoding="utf-8")
    return universe

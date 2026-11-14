import asyncio
from datetime import date, datetime, timedelta, timezone

from app.core.exceptions import UpstoxAPIError
from app.db.models import ScanRun
from app.engine import scanner
from app.engine.scanner import ScanConfig, analyse_stock, backtest_verdict, ranked_results, run_scan
from app.services.instruments import parse_fno_universe
from tests.test_strategy import _candles

TODAY = date(2026, 11, 14)


def _uptrend_rows(n=400, end=datetime(2026, 11, 13, tzinfo=timezone.utc)):
    rows = []
    for i in range(n):
        close = 100 + i * 0.5 + (1.5 if i % 2 else -1.5)
        volume = 4000 if i == n - 1 else 1000
        ts = (end - timedelta(days=n - 1 - i)).isoformat()
        rows.append([ts, close - 0.3, close + 1.0, close - 1.0, close, volume, 0])
    rows.reverse()  # Upstox returns newest first
    return rows


class FakeCandleClient:
    def __init__(self, responses: dict):
        self.responses = responses
        self.calls: list[str] = []

    async def get_historical_candles(self, instrument_key, unit, interval, to_date, from_date=None):
        self.calls.append(instrument_key)
        value = self.responses[instrument_key]
        if isinstance(value, list) and value and isinstance(value[0], Exception):
            exc = value.pop(0)
            raise exc
        if isinstance(value, Exception):
            raise value
        return {"status": "success", "data": {"candles": value}}


FAST = ScanConfig(min_seconds_between_requests=0.0)


# --- universe ---------------------------------------------------------------------

def test_parse_fno_universe_keeps_only_equity_futures_once():
    rows = [
        {"segment": "NSE_EQ", "instrument_key": "NSE_EQ|A", "name": "ALPHA LTD"},
        {"segment": "NSE_FO", "instrument_type": "FUT", "underlying_type": "EQUITY",
         "underlying_key": "NSE_EQ|A", "underlying_symbol": "ALPHA", "lot_size": 500},
        {"segment": "NSE_FO", "instrument_type": "FUT", "underlying_type": "EQUITY",
         "underlying_key": "NSE_EQ|A", "underlying_symbol": "ALPHA", "lot_size": 500},  # next month
        {"segment": "NSE_FO", "instrument_type": "FUT", "underlying_type": "INDEX",
         "underlying_key": "NSE_INDEX|Nifty 50", "underlying_symbol": "NIFTY", "lot_size": 75},
        {"segment": "NSE_FO", "instrument_type": "CE", "underlying_type": "EQUITY",
         "underlying_key": "NSE_EQ|B", "underlying_symbol": "BETA", "lot_size": 100},
    ]
    universe = parse_fno_universe(rows)
    assert universe == [{"instrument_key": "NSE_EQ|A", "symbol": "ALPHA", "name": "ALPHA LTD", "lot_size": 500}]


# --- verdict -------------------------------------------------------------------------

def test_backtest_verdicts():
    cfg = ScanConfig()
    assert backtest_verdict({"total_trades": 3, "profit_factor": 3.0, "net_pnl": 100}, cfg) == "too_few"
    assert backtest_verdict({"total_trades": 10, "profit_factor": 1.6, "net_pnl": 900}, cfg) == "supports"
    assert backtest_verdict({"total_trades": 10, "profit_factor": 1.1, "net_pnl": 90}, cfg) == "mixed"
    assert backtest_verdict({"total_trades": 19, "profit_factor": 0.73, "net_pnl": -1991}, cfg) == "against"
    assert backtest_verdict({"total_trades": 6, "profit_factor": None, "net_pnl": 500}, cfg) == "supports"


# --- per-stock analysis ------------------------------------------------------------------

def test_analyse_stock_uses_recent_window_for_signal_and_full_history_for_backtest():
    from app.engine.candle import candles_from_upstox

    candles = candles_from_upstox(_uptrend_rows())
    outcome = analyse_stock(candles, "NSE_EQ|A", FAST)
    assert outcome.action in ("BUY", "SELL", "NO_TRADE")
    assert outcome.last_close == candles[-1].close
    assert outcome.data_date == candles[-1].timestamp.date()
    assert outcome.backtest["total_trades"] >= 0
    assert outcome.verdict in ("supports", "mixed", "against", "too_few")


def test_analyse_stock_with_too_little_history_is_no_trade_with_reason():
    outcome = analyse_stock(_candles([100 + i for i in range(30)]), "NSE_EQ|NEW", FAST)
    assert outcome.action == "NO_TRADE"
    assert "30 candles" in outcome.error


# --- full scan -----------------------------------------------------------------------------

def _universe(*keys):
    return [{"instrument_key": k, "symbol": k.split("|")[1], "name": "", "lot_size": 100} for k in keys]


def test_run_scan_saves_every_stock_and_isolates_failures(db_session):
    client = FakeCandleClient({
        "NSE_EQ|A": _uptrend_rows(),
        "NSE_EQ|B": UpstoxAPIError(400, "Invalid instrument key"),
        "NSE_EQ|C": _uptrend_rows(),
    })
    run = asyncio.run(run_scan(db_session, client, _universe("NSE_EQ|A", "NSE_EQ|B", "NSE_EQ|C"), TODAY, config=FAST))

    assert run.status == "DONE"
    assert run.universe_size == 3
    assert run.scanned_count == 2
    assert run.error_count == 1
    assert run.data_date == date(2026, 11, 13)

    rows = ranked_results(db_session, run.id)
    assert len(rows) == 3
    errored = next(r for r in rows if r.symbol == "B")
    assert errored.action == "ERROR" and "Invalid instrument key" in errored.error
    assert rows[-1].action in ("NO_TRADE", "ERROR")  # actionable signals sort first


def test_rate_limited_request_is_retried(db_session, monkeypatch):
    async def no_sleep(_):
        return None

    monkeypatch.setattr(scanner.asyncio, "sleep", no_sleep)
    client = FakeCandleClient({"NSE_EQ|A": [UpstoxAPIError(429, "Too many requests")]})
    rows = _uptrend_rows()

    async def flaky(instrument_key, unit, interval, to_date, from_date=None):
        client.calls.append(instrument_key)
        if len(client.calls) == 1:
            raise UpstoxAPIError(429, "Too many requests")
        return {"data": {"candles": rows}}

    client.get_historical_candles = flaky
    run = asyncio.run(run_scan(db_session, client, _universe("NSE_EQ|A"), TODAY, config=FAST))
    assert len(client.calls) == 2
    assert run.scanned_count == 1 and run.error_count == 0


def test_scan_where_everything_fails_is_marked_failed(db_session):
    client = FakeCandleClient({"NSE_EQ|A": UpstoxAPIError(401, "Unauthorized")})
    run = asyncio.run(run_scan(db_session, client, _universe("NSE_EQ|A"), TODAY, config=FAST))
    assert run.status == "FAILED"
    assert run.message


def test_ranking_puts_backtest_supported_signals_first(db_session):
    from app.db.models import ScanResult

    run = ScanRun(status="DONE")
    db_session.add(run)
    db_session.commit()
    for symbol, action, verdict, strength in [
        ("WEAK", "BUY", "against", 100.0),
        ("NONE", "NO_TRADE", "supports", 0.0),
        ("GOOD", "SELL", "supports", 50.0),
        ("MID", "BUY", "mixed", 67.0),
    ]:
        db_session.add(ScanResult(run_id=run.id, instrument_key=f"NSE_EQ|{symbol}", symbol=symbol,
                                  action=action, strength=strength, bt_verdict=verdict))
    db_session.commit()
    assert [r.symbol for r in ranked_results(db_session, run.id)] == ["GOOD", "MID", "WEAK", "NONE"]


# --- routes ---------------------------------------------------------------------------------

def test_latest_with_no_scans(client):
    assert client.get("/scan/latest").json() == {"run": None, "results": []}


def test_scan_route_runs_in_background_without_login(client, db_session, monkeypatch):
    from app.api.routes import scan as scan_route
    from app.db import base as db_base

    async def fake_universe(today, force_refresh=False):
        return _universe("NSE_EQ|A")

    monkeypatch.setattr(scan_route, "load_fno_universe", fake_universe)
    monkeypatch.setattr(db_base, "SessionLocal", lambda: _NonClosingSession(db_session))
    fake = FakeCandleClient({"NSE_EQ|A": _uptrend_rows()})
    monkeypatch.setattr(scan_route, "scan_client", lambda db: fake)
    monkeypatch.setattr(scanner, "ScanConfig", lambda: FAST)

    started = client.post("/scan/run")
    assert started.status_code == 200, started.text

    body = client.get("/scan/latest").json()
    assert body["run"]["status"] == "DONE"
    assert body["run"]["scanned_count"] == 1
    assert body["results"][0]["symbol"] == "A"
    assert "verdict" in body["results"][0]["backtest"]


def test_anonymous_scan_client_when_not_logged_in(db_session):
    from app.api.routes.scan import scan_client

    assert scan_client(db_session)._access_token is None


class _NonClosingSession:
    """Lets the background job share the test's in-memory session."""

    def __init__(self, session):
        self._s = session

    def close(self):
        pass

    def __getattr__(self, name):
        return getattr(self._s, name)

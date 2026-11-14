import asyncio

from app.engine.market_context import buildup, fetch_context, news_items, smartlist_tags

FUT_MAP = {"NSE_FO|59032": "NSE_EQ|PAYTM", "NSE_FO|54762": "NSE_EQ|HERO"}

# Shapes copied from live Upstox responses (Nov 2026), trimmed.
OI_GAINERS = {
    "status": "success",
    "data": {
        "asset_type": "STOCK",
        "category": "OI_GAINERS",
        "time_stamp": 1794635270467,
        "metric_key": "open_interest",
        "smartlist": [
            {"instrument_key": "NSE_FO|59032", "price": {"current": 309.1, "change_pct": -3.24},
             "metric": {"current": 6057000.0, "previous": 1137000.0, "change_pct": 432.72}},
            {"instrument_key": "NSE_FO|99999", "price": {"change_pct": 1.0}, "metric": {"change_pct": 50.0}},
            {"instrument_key": "NSE_FO|54762", "price": {"current": 5177.0, "change_pct": 3.69},
             "metric": {"change_pct": 227.27}},
        ],
    },
}
NEWS = {
    "status": "success",
    "data": {
        "NSE_EQ|PAYTM": [
            {"heading": "Older", "summary": "", "article_link": "https://upstox.com/a", "published_time": 1794563889688},
            {"heading": "Paytm hits record high", "summary": "RBI nod", "article_link": "https://upstox.com/b",
             "published_time": 1794578538940},
        ]
    },
}


def test_buildup_readings():
    assert buildup(2.0, 10.0) == "Long buildup"
    assert buildup(-2.0, 10.0) == "Short buildup"
    assert buildup(2.0, -10.0) == "Short covering"
    assert buildup(-2.0, -10.0) == "Long unwinding"
    assert buildup(None, 10.0) is None


def test_smartlist_tags_map_futures_to_stocks_with_rank_and_reading():
    tags = smartlist_tags({"OI_GAINERS": OI_GAINERS}, FUT_MAP)
    assert set(tags) == {"NSE_EQ|PAYTM", "NSE_EQ|HERO"}  # unknown future skipped
    paytm = tags["NSE_EQ|PAYTM"][0]
    assert paytm["rank"] == 1 and paytm["label"] == "OI gainers"
    assert paytm["reading"] == "Short buildup"  # price down, OI up
    assert tags["NSE_EQ|HERO"][0]["rank"] == 3
    assert tags["NSE_EQ|HERO"][0]["reading"] == "Long buildup"


def test_price_lists_carry_no_oi_reading():
    price_list = {"data": {"metric_key": "change_pct", "smartlist": OI_GAINERS["data"]["smartlist"]}}
    tags = smartlist_tags({"PRICE_GAINERS": price_list}, FUT_MAP)
    assert tags["NSE_EQ|PAYTM"][0]["reading"] is None


def test_news_items_newest_first_and_limited():
    items = news_items(NEWS, limit=1)
    assert [n["heading"] for n in items["NSE_EQ|PAYTM"]] == ["Paytm hits record high"]
    assert items["NSE_EQ|PAYTM"][0]["link"] == "https://upstox.com/b"


class FakeClient:
    def __init__(self):
        self.news_batches: list[list[str]] = []

    async def get_futures_smartlist(self, asset_type, category, page_size=50, page_number=1):
        if category == "MOST_ACTIVE":
            raise RuntimeError("Upstox 500")
        return OI_GAINERS if category == "OI_GAINERS" else {"data": {"smartlist": []}}

    async def get_news(self, keys, page_size=100):
        self.news_batches.append(keys)
        return NEWS


def test_fetch_context_batches_news_by_30_and_reports_errors():
    client = FakeClient()
    keys = ["NSE_EQ|PAYTM"] + [f"NSE_EQ|X{i}" for i in range(40)]
    ctx = asyncio.run(fetch_context(client, keys, FUT_MAP))
    assert [len(b) for b in client.news_batches] == [30, 11]
    assert ctx["stocks"]["NSE_EQ|PAYTM"]["smartlists"][0]["category"] == "OI_GAINERS"
    assert ctx["stocks"]["NSE_EQ|PAYTM"]["news"][0]["heading"] == "Paytm hits record high"
    assert ctx["stocks"]["NSE_EQ|X0"] == {"smartlists": [], "news": []}
    assert any("MOST_ACTIVE" in e for e in ctx["errors"])
    assert ctx["smartlist_timestamp"] is not None


def test_context_route_requires_login(client):
    assert client.get("/scan/context").status_code == 401


def test_same_stock_in_one_list_twice_keeps_best_rank():
    two_months = {"data": {"metric_key": "change_pct", "smartlist": [
        {"instrument_key": "NSE_FO|1", "price": {"change_pct": 5.0}, "metric": {}},
        {"instrument_key": "NSE_FO|2", "price": {"change_pct": 4.9}, "metric": {}},
    ]}}
    tags = smartlist_tags({"PRICE_GAINERS": two_months}, {"NSE_FO|1": "NSE_EQ|A", "NSE_FO|2": "NSE_EQ|A"})
    assert [(t["category"], t["rank"]) for t in tags["NSE_EQ|A"]] == [("PRICE_GAINERS", 1)]

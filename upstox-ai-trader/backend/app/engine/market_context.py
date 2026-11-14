"""Upstox's own market context for the scan's signals: where each stock ranks
in Upstox's stock-futures Smartlists, and its latest news.

Upstox has no API for its in-app research/advisory ideas, so this uses the
official data it does publish (both need the daily login):

  * Smartlists (GET /v2/market/smartlist/futures, asset_type=STOCK): ranked
    lists of stock futures. Membership in the top `page_size` of a list is
    reported with the rank, price change and open-interest change.
  * News (GET /v2/news): recent headlines per stock, with links.

From a future's price change and open-interest change, the usual F&O reading
is attached ("long buildup" = price up and OI up, etc.). That reading is a
standard description of positioning, not a forecast.
"""
from datetime import datetime, timezone

SMARTLIST_CATEGORIES = ("OI_GAINERS", "OI_LOSERS", "PRICE_GAINERS", "PRICE_LOSERS", "MOST_ACTIVE", "TOP_TRADED")
CATEGORY_LABEL = {
    "OI_GAINERS": "OI gainers",
    "OI_LOSERS": "OI losers",
    "PRICE_GAINERS": "Price gainers",
    "PRICE_LOSERS": "Price losers",
    "MOST_ACTIVE": "Most active",
    "TOP_TRADED": "Top traded",
}
NEWS_BATCH = 30  # Upstox maximum instrument keys per /v2/news call
NEWS_PER_STOCK = 3


def buildup(price_change_pct: float | None, oi_change_pct: float | None) -> str | None:
    if price_change_pct is None or oi_change_pct is None or price_change_pct == 0 or oi_change_pct == 0:
        return None
    if price_change_pct > 0:
        return "Long buildup" if oi_change_pct > 0 else "Short covering"
    return "Short buildup" if oi_change_pct > 0 else "Long unwinding"


def smartlist_tags(responses: dict[str, dict], future_to_underlying: dict[str, str]) -> dict[str, list[dict]]:
    """`responses` maps category -> raw smartlist response. Returns
    underlying stock key -> list of tags."""
    tags: dict[str, list[dict]] = {}
    for category, response in responses.items():
        data = (response or {}).get("data") or {}
        metric_key = data.get("metric_key")
        for rank, row in enumerate(data.get("smartlist") or [], start=1):
            stock = future_to_underlying.get(row.get("instrument_key", ""))
            if not stock:
                continue
            if any(t["category"] == category for t in tags.get(stock, [])):
                continue  # a later-month future of the same stock; keep the best rank only
            price = row.get("price") or {}
            metric = row.get("metric") or {}
            price_pct = price.get("change_pct")
            oi_pct = metric.get("change_pct") if metric_key == "open_interest" else None
            tags.setdefault(stock, []).append(
                {
                    "category": category,
                    "label": CATEGORY_LABEL.get(category, category),
                    "rank": rank,
                    "price_change_pct": price_pct,
                    "metric_key": metric_key,
                    "metric_change_pct": metric.get("change_pct"),
                    "reading": buildup(price_pct, oi_pct),
                }
            )
    for stock_tags in tags.values():
        stock_tags.sort(key=lambda t: t["rank"])
    return tags


def news_items(response: dict, limit: int = NEWS_PER_STOCK) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    data = (response or {}).get("data") or {}
    if not isinstance(data, dict):
        return out
    for key, items in data.items():
        rows = []
        for item in items or []:
            published = item.get("published_time")
            rows.append(
                {
                    "heading": item.get("heading", ""),
                    "summary": item.get("summary", ""),
                    "link": item.get("article_link"),
                    "published_at": datetime.fromtimestamp(published / 1000, tz=timezone.utc).isoformat()
                    if isinstance(published, (int, float))
                    else None,
                }
            )
        rows.sort(key=lambda r: r["published_at"] or "", reverse=True)
        out[key] = rows[:limit]
    return out


async def fetch_context(client, stock_keys: list[str], future_to_underlying: dict[str, str]) -> dict:
    """One Smartlist call per category and one news call per 30 stocks. A
    failing call is reported in `errors` instead of failing the whole view."""
    errors: list[str] = []
    responses: dict[str, dict] = {}
    for category in SMARTLIST_CATEGORIES:
        try:
            responses[category] = await client.get_futures_smartlist("STOCK", category, page_size=50)
        except Exception as exc:
            errors.append(f"Smartlist {category}: {exc}"[:200])
    tags = smartlist_tags(responses, future_to_underlying)

    news: dict[str, list[dict]] = {}
    for i in range(0, len(stock_keys), NEWS_BATCH):
        batch = stock_keys[i : i + NEWS_BATCH]
        try:
            news.update(news_items(await client.get_news(batch)))
        except Exception as exc:
            errors.append(f"News: {exc}"[:200])

    return {
        "stocks": {key: {"smartlists": tags.get(key, []), "news": news.get(key, [])} for key in stock_keys},
        "smartlist_timestamp": _smartlist_time(responses),
        "errors": errors,
    }


def _smartlist_time(responses: dict[str, dict]) -> str | None:
    for response in responses.values():
        ts = ((response or {}).get("data") or {}).get("time_stamp")
        if isinstance(ts, (int, float)):
            return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat()
    return None

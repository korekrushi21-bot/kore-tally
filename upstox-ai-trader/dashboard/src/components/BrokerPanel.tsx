import { useState } from "react";
import { api, ApiError } from "../api";

type Tab = "holdings" | "positions" | "funds" | "orders";

const FETCHERS: Record<Tab, () => Promise<unknown>> = {
  holdings: api.marketHoldings,
  positions: api.marketPositions,
  funds: api.marketFunds,
  orders: api.marketOrders,
};

const LABELS: Record<Tab, string> = {
  holdings: "Holdings",
  positions: "Broker Positions",
  funds: "Funds & Margin",
  orders: "Open Orders",
};

export function BrokerPanel({ connected }: { connected: boolean }) {
  const [tab, setTab] = useState<Tab>("orders");
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(next: Tab) {
    setTab(next);
    setLoading(true);
    setError(null);
    try {
      setData(await FETCHERS[next]());
    } catch (e) {
      setData(null);
      setError(e instanceof ApiError ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  if (!connected) {
    return <p className="muted">Connect your Upstox account above to see real holdings, positions, funds, and orders.</p>;
  }

  return (
    <div>
      <div className="row">
        {(Object.keys(LABELS) as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "primary" : ""} onClick={() => load(t)}>
            {LABELS[t]}
          </button>
        ))}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {loading && <p className="muted">Loading…</p>}
      {!loading && data !== null && (
        <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem", maxHeight: 300, overflow: "auto" }}>
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
      {!loading && data === null && !error && <p className="muted">Click a tab to load real Upstox data.</p>}
    </div>
  );
}

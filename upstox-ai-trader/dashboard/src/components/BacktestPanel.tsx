import { useState } from "react";
import type { BacktestMetrics, BacktestResult } from "../types";
import { api, ApiError } from "../api";
import { EquityCurveChart } from "./EquityCurveChart";

function MetricsTable({ title, metrics }: { title: string; metrics: BacktestMetrics | null }) {
  if (!metrics) return null;
  if (metrics.total_trades === 0) {
    return (
      <div>
        <strong>{title}</strong>
        <p className="muted">No trades in this period.</p>
      </div>
    );
  }
  return (
    <div>
      <strong>{title}</strong>
      <div className="grid">
        <div className="stat">
          <div className="label">Trades</div>
          <div className="value">{metrics.total_trades}</div>
        </div>
        <div className="stat">
          <div className="label">Win Rate</div>
          <div className="value">{(metrics.win_rate * 100).toFixed(1)}%</div>
        </div>
        <div className="stat">
          <div className="label">Net P&amp;L</div>
          <div className={`value ${metrics.net_pnl >= 0 ? "text-green" : "text-red"}`}>
            {metrics.net_pnl.toFixed(2)}
          </div>
        </div>
        <div className="stat">
          <div className="label">Profit Factor</div>
          <div className="value">{metrics.profit_factor?.toFixed(2) ?? "∞"}</div>
        </div>
        <div className="stat">
          <div className="label">Max Drawdown</div>
          <div className="value text-red">
            {metrics.max_drawdown_amount.toFixed(0)} ({(metrics.max_drawdown_pct * 100).toFixed(1)}%)
          </div>
        </div>
        <div className="stat">
          <div className="label">Avg Win / Loss</div>
          <div className="value">
            <span className="text-green">{metrics.avg_win.toFixed(0)}</span> /{" "}
            <span className="text-red">{metrics.avg_loss.toFixed(0)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function BacktestPanel({ connected }: { connected: boolean }) {
  const [instrumentKey, setInstrumentKey] = useState("NSE_EQ|INE002A01018");
  const [fromDate, setFromDate] = useState("2022-01-01");
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [trainEndDate, setTrainEndDate] = useState("");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.runBacktest({
        instrumentKey,
        fromDate,
        toDate,
        trainEndDate: trainEndDate || undefined,
      });
      setResult(r);
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError ? e.message : "Backtest failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {!connected && <p className="muted">Connect your Upstox account above to fetch real historical candles.</p>}
      <div className="row">
        <input value={instrumentKey} onChange={(e) => setInstrumentKey(e.target.value)} style={{ width: 200 }} />
        <label className="muted">
          From <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </label>
        <label className="muted">
          To <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
        <label className="muted">
          Train/test split <input type="date" value={trainEndDate} onChange={(e) => setTrainEndDate(e.target.value)} />
        </label>
        <button className="primary" disabled={!connected || busy} onClick={run}>
          {busy ? "Running…" : "Run Backtest"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {result && (
        <div>
          <p className="muted">
            {result.candles_used} candles · ending capital{" "}
            <strong className={result.ending_capital >= result.starting_capital ? "text-green" : "text-red"}>
              {result.ending_capital.toLocaleString("en-IN")}
            </strong>{" "}
            (from {result.starting_capital.toLocaleString("en-IN")}) · {result.rejected_signal_count} signals
            rejected by the risk engine
          </p>

          <EquityCurveChart points={result.equity_curve} />

          <div className="two-col" style={{ marginTop: 12 }}>
            <MetricsTable title="Overall" metrics={result.metrics.all} />
            {result.metrics.train && <MetricsTable title="Train" metrics={result.metrics.train} />}
          </div>
          {result.metrics.test && (
            <div style={{ marginTop: 12 }}>
              <MetricsTable title="Test (out-of-sample)" metrics={result.metrics.test} />
            </div>
          )}

          <details style={{ marginTop: 12 }}>
            <summary>All {result.trades.length} trades</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Side</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Reason</th>
                    <th>P&amp;L</th>
                    <th>Period</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.map((t, i) => (
                    <tr key={i}>
                      <td>
                        <span className={`pill ${t.side === "BUY" ? "green" : "red"}`}>{t.side}</span>
                      </td>
                      <td>
                        {new Date(t.entry_date).toLocaleDateString()} @ {t.entry_price.toFixed(2)}
                      </td>
                      <td>
                        {new Date(t.exit_date).toLocaleDateString()} @ {t.exit_price.toFixed(2)}
                      </td>
                      <td>{t.exit_reason}</td>
                      <td className={t.realized_pnl >= 0 ? "text-green" : "text-red"}>{t.realized_pnl.toFixed(2)}</td>
                      <td>{t.period}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BacktestVerdict, ScanLatest, ScanResultDTO } from "../types";
import { api, ApiError } from "../api";

const VERDICT_LABEL: Record<BacktestVerdict, { text: string; pill: string; help: string }> = {
  supports: {
    text: "Backtest: profitable",
    pill: "green",
    help: "On this stock the strategy made money over 2 years (profit factor ≥ 1.3, at least 5 trades).",
  },
  mixed: {
    text: "Backtest: break-even",
    pill: "amber",
    help: "Profit factor between 1.0 and 1.3: roughly break-even after costs.",
  },
  against: {
    text: "Backtest: lost money",
    pill: "red",
    help: "On this stock the strategy lost money over 2 years.",
  },
  too_few: {
    text: "Backtest: too few trades",
    pill: "neutral",
    help: "Fewer than 5 backtest trades. Often because one share's risk is too large for the per-trade risk limit.",
  },
  "": { text: "—", pill: "neutral", help: "" },
};

type Filter = "supported" | "all_signals" | "everything";

function pct(n: number | null | undefined, digits = 0) {
  return n === null || n === undefined ? "—" : `${(n * 100).toFixed(digits)}%`;
}

export function MorningScanPanel() {
  const [data, setData] = useState<ScanLatest | null>(null);
  const [filter, setFilter] = useState<Filter>("supported");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.scanLatest());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load the latest scan");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const running = data?.run?.status === "RUNNING";
  useEffect(() => {
    if (!running) return;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [running, load]);

  async function scanNow() {
    setStarting(true);
    setError(null);
    try {
      await api.scanRun();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not start a scan");
    } finally {
      setStarting(false);
    }
  }

  const results = data?.results ?? [];
  const signals = useMemo(() => results.filter((r) => r.action === "BUY" || r.action === "SELL"), [results]);
  const supported = useMemo(() => signals.filter((r) => r.backtest.verdict === "supports"), [signals]);
  const losingStocks = useMemo(() => results.filter((r) => r.backtest.verdict === "against").length, [results]);
  const shown = filter === "supported" ? supported : filter === "all_signals" ? signals : results;
  const run = data?.run;

  return (
    <div>
      <p className="muted">
        Every morning the app runs the strategy on all F&amp;O stocks and backtests it on each one over the last 2
        years. These are <strong>rule-based signals, not recommendations</strong>: nothing here is a promise of profit,
        and no order is placed. Each signal shows how the same rules did on that stock in the past.
      </p>

      <div className="row">
        <button className="primary" disabled={starting || running} onClick={scanNow}>
          {running ? "Scanning…" : "Scan now"}
        </button>
        {run && (
          <span className="muted">
            {run.status === "RUNNING"
              ? `Scanning ${run.universe_size || ""} stocks… (about a minute)`
              : `Last scan: ${new Date(run.finished_at ?? run.started_at).toLocaleString()} (${run.trigger}) · data up to ${
                  run.data_date ?? "—"
                } · ${run.scanned_count}/${run.universe_size} stocks${run.error_count ? ` · ${run.error_count} errors` : ""}`}
          </span>
        )}
        {!run && <span className="muted">No scan yet. Click “Scan now”, or wait for the 9:00 scheduled scan.</span>}
      </div>

      {run?.status === "FAILED" && <div className="error-banner">Scan failed: {run.message}</div>}
      {error && <div className="error-banner">{error}</div>}

      {run?.status === "DONE" && (
        <>
          <div className="grid" style={{ marginBottom: 10 }}>
            <div className="stat">
              <div className="label">BUY / SELL signals today</div>
              <div className="value">{signals.length}</div>
            </div>
            <div className="stat">
              <div className="label">…with a profitable backtest</div>
              <div className="value text-green">{supported.length}</div>
            </div>
            <div className="stat">
              <div className="label">Stocks where the strategy lost money</div>
              <div className="value text-red">
                {losingStocks} of {results.length}
              </div>
            </div>
          </div>

          {losingStocks > results.length / 2 && (
            <div className="error-banner" style={{ background: "var(--amber-bg)", color: "var(--amber)" }}>
              On most stocks this strategy lost money in backtests. With {results.length} stocks tested, a handful
              will look profitable by chance alone, so treat even “profitable” ones with caution and paper-trade first.
            </div>
          )}

          <div className="row">
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter">
              <option value="supported">Signals with a profitable backtest ({supported.length})</option>
              <option value="all_signals">All BUY/SELL signals ({signals.length})</option>
              <option value="everything">Every stock scanned ({results.length})</option>
            </select>
          </div>

          {shown.length === 0 ? (
            <p className="muted">Nothing in this view today.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Stock</th>
                    <th>Signal</th>
                    <th>Close</th>
                    <th>Entry / Stop / Target</th>
                    <th>Backtest (2y)</th>
                    <th>Win rate</th>
                    <th>Profit factor</th>
                    <th>Lot</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <ScanRow
                      key={r.instrument_key}
                      r={r}
                      expanded={expanded === r.instrument_key}
                      onToggle={() => setExpanded(expanded === r.instrument_key ? null : r.instrument_key)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ScanRow({ r, expanded, onToggle }: { r: ScanResultDTO; expanded: boolean; onToggle: () => void }) {
  const verdict = VERDICT_LABEL[r.backtest.verdict] ?? VERDICT_LABEL[""];
  const actionPill = r.action === "BUY" ? "green" : r.action === "SELL" ? "red" : r.action === "ERROR" ? "amber" : "neutral";
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer" }} title="Click for the reasons">
        <td>
          <strong>{r.symbol}</strong>
          <div className="muted">{r.name}</div>
        </td>
        <td>
          <span className={`pill ${actionPill}`}>{r.action}</span>
          {r.action !== "NO_TRADE" && r.action !== "ERROR" && <div className="muted">strength {r.strength.toFixed(0)}</div>}
        </td>
        <td>{r.last_close?.toFixed(2) ?? "—"}</td>
        <td>
          {r.entry_price ? (
            <>
              {r.entry_price.toFixed(2)} / <span className="text-red">{r.stop_loss?.toFixed(2)}</span> /{" "}
              <span className="text-green">{r.target?.toFixed(2)}</span>
            </>
          ) : (
            "—"
          )}
        </td>
        <td>
          <span className={`pill ${verdict.pill}`} title={verdict.help}>
            {verdict.text}
          </span>
          <div className="muted">
            {r.backtest.trades} trades · {r.backtest.net_pnl !== null ? `₹${r.backtest.net_pnl.toFixed(0)}` : "—"}
          </div>
        </td>
        <td>{pct(r.backtest.win_rate)}</td>
        <td>{r.backtest.profit_factor?.toFixed(2) ?? (r.backtest.trades ? "no losses" : "—")}</td>
        <td>{r.lot_size || "—"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} style={{ background: "var(--bg)" }}>
            {r.error && <p className="text-red">{r.error}</p>}
            <ul className="reasons">
              {r.reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
            <p className="muted">
              {verdict.help} Max drawdown {pct(r.backtest.max_drawdown_pct, 1)} on ₹1 lakh test capital. Check the
              chart yourself before acting.
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

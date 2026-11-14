import { useCallback, useEffect, useMemo, useState } from "react";
import type { BacktestVerdict, NewsItem, OptionPlanDTO, ScanContext, ScanLatest, ScanResultDTO, SmartlistTag } from "../types";
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

export function MorningScanPanel({ connected }: { connected: boolean }) {
  const [data, setData] = useState<ScanLatest | null>(null);
  const [filter, setFilter] = useState<Filter>("supported");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [context, setContext] = useState<ScanContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);

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
  const doneRunId = data?.run?.status === "DONE" ? data.run.id : null;
  useEffect(() => {
    if (!connected || doneRunId === null || context?.run_id === doneRunId) return;
    api
      .scanContext()
      .then((c) => {
        setContext(c);
        setContextError(null);
      })
      .catch((e) => setContextError(e instanceof ApiError ? e.message : "Could not load Upstox news/smartlists"));
  }, [connected, doneRunId, context?.run_id]);
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

          {!connected && (
            <p className="muted">Log in to Upstox to also see each stock's Upstox Smartlist ranks and latest news.</p>
          )}
          {contextError && <div className="error-banner">Upstox news/smartlists: {contextError}</div>}
          {context && context.errors.length > 0 && (
            <p className="muted">Some Upstox data could not be loaded: {context.errors.join("; ")}</p>
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
                    <th>Option trade (rules)</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <ScanRow
                      key={r.instrument_key}
                      r={r}
                      context={context?.stocks[r.instrument_key]}
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

function ScanRow({
  r,
  context,
  expanded,
  onToggle,
}: {
  r: ScanResultDTO;
  context?: { smartlists: SmartlistTag[]; news: NewsItem[] };
  expanded: boolean;
  onToggle: () => void;
}) {
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
          {context?.smartlists.slice(0, 2).map((t) => (
            <div key={t.category} className="muted" title="Upstox stock-futures Smartlist">
              #{t.rank} {t.label}
              {t.reading ? ` · ${t.reading}` : ""}
            </div>
          ))}
          {context && context.news.length > 0 && <div className="muted">📰 {context.news.length} news</div>}
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
        <td>
          <OptionSummary plan={r.option_plan} />
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} style={{ background: "var(--bg)" }}>
            {r.error && <p className="text-red">{r.error}</p>}
            {r.option_plan && <OptionPlanDetail plan={r.option_plan} />}
            {context && <UpstoxContext context={context} />}
            <strong>Why the stock signal:</strong>
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

function rupees(n: number | null | undefined) {
  return n === null || n === undefined ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`;
}

function OptionSummary({ plan }: { plan: OptionPlanDTO | null }) {
  if (!plan) return <span className="muted">—</span>;
  if (plan.status === "no_contract" || !plan.contract) return <span className="muted">No liquid contract</span>;
  return (
    <div>
      <strong>{plan.contract.trading_symbol}</strong>
      <div className="muted">
        @ {plan.premium?.toFixed(2)} · lot {plan.contract.lot_size}
      </div>
      {plan.status === "ok" ? (
        <span className="pill green">
          {plan.lots} lot{plan.lots === 1 ? "" : "s"} fits your limit
        </span>
      ) : (
        <span className="pill amber" title={plan.reason}>
          0 lots: 1 lot risks {rupees(plan.one_lot_risk)}
        </span>
      )}
    </div>
  );
}

function OptionPlanDetail({ plan }: { plan: OptionPlanDTO }) {
  const c = plan.contract;
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <strong>Option trade by the app's rules</strong>
      {plan.status === "no_contract" || !c ? (
        <p className="muted">{plan.reason}</p>
      ) : (
        <>
          <p>
            <strong>
              BUY {plan.status === "ok" ? `${plan.lots} lot(s) = ${plan.quantity}` : "0 lots"} × {c.trading_symbol}
            </strong>{" "}
            at about ₹{plan.premium?.toFixed(2)} (closing price on {plan.premium_date}; the live price at 9:15 will differ)
          </p>
          {plan.status === "too_big" && (
            <div className="error-banner" style={{ background: "var(--amber-bg)", color: "var(--amber)" }}>
              Not sized: one lot ({c.lot_size} units) risks about {rupees(plan.one_lot_risk)} if the stock hits its stop,
              against your limit of {rupees(plan.risk_budget)} per trade. The risk engine does not round up to one lot.
              {plan.capital_needed_for_one_lot
                ? ` One lot would fit with about ${rupees(plan.capital_needed_for_one_lot)} of capital at your current risk %.`
                : ""}
            </div>
          )}
          {plan.entry && plan.exit && <EntryExitTable plan={plan} />}
          <div className="grid">
            <div className="stat">
              <div className="label">Cost of 1 lot</div>
              <div className="value">{rupees((plan.premium ?? 0) * c.lot_size)}</div>
            </div>
            <div className="stat">
              <div className="label">Delta (est.)</div>
              <div className="value">{plan.delta?.toFixed(2)}</div>
            </div>
            <div className="stat">
              <div className="label">Breakeven at expiry</div>
              <div className="value">{plan.breakeven?.toFixed(2)}</div>
            </div>
            <div className="stat">
              <div className="label">Days to expiry</div>
              <div className="value">{plan.days_to_expiry}</div>
            </div>
            <div className="stat">
              <div className="label">Exit by</div>
              <div className="value">{plan.exit_by}</div>
            </div>
          </div>
          <ul className="reasons">
            {plan.rules.map((rule, i) => (
              <li key={i}>{rule}</li>
            ))}
          </ul>
          <p className="muted">
            Strikes compared:{" "}
            {plan.candidates
              .map((x) => (x.skipped ? `${x.strike} (${x.skipped})` : `${x.strike} @ ${x.premium} Δ${x.delta ?? "?"}`))
              .join(" · ")}
          </p>
        </>
      )}
    </div>
  );
}

function EntryExitTable({ plan }: { plan: OptionPlanDTO }) {
  const entry = plan.entry!;
  const exit = plan.exit!;
  const stock = plan.contract?.trading_symbol.split(" ")[0] ?? "Stock";
  return (
    <div className="table-wrap" style={{ marginBottom: 10 }}>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>{stock} share price (trigger)</th>
            <th>Option premium</th>
            <th>P&amp;L per lot (est.)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <span className="pill green">Entry</span>
            </td>
            <td>
              only while between {entry.stock_low.toFixed(2)} and {entry.stock_high.toFixed(2)}
            </td>
            <td>
              <strong>LIMIT ≤ ₹{entry.limit_premium.toFixed(2)}</strong>
              <div className="muted">previous close ₹{entry.reference_premium.toFixed(2)}</div>
            </td>
            <td>—</td>
          </tr>
          <tr>
            <td>
              <span className="pill red">Stop-loss exit</span>
            </td>
            <td>closes below/beyond {exit.stop_stock.toFixed(2)}</td>
            <td>≈ ₹{exit.stop_premium_est.toFixed(2)}</td>
            <td className="text-red">{rupees(exit.stop_pnl_per_lot_est)}</td>
          </tr>
          <tr>
            <td>
              <span className="pill green">Target exit</span>
            </td>
            <td>reaches {exit.target_stock.toFixed(2)}</td>
            <td>≈ ₹{exit.target_premium_est.toFixed(2)}</td>
            <td className="text-green">+{rupees(exit.target_pnl_per_lot_est)}</td>
          </tr>
          <tr>
            <td>
              <span className="pill neutral">Time exit</span>
            </td>
            <td colSpan={3}>exit by {exit.exit_by} at whatever the price is, if neither level is hit</td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        The share price is the real trigger. Option premiums at stop/target are estimates ({exit.estimate_method}, as if
        the share got there today); with time decay the option will usually be worth somewhat less by then.
      </p>
    </div>
  );
}

function UpstoxContext({ context }: { context: { smartlists: SmartlistTag[]; news: NewsItem[] } }) {
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <strong>From Upstox</strong>
      {context.smartlists.length === 0 ? (
        <p className="muted">Not in the top 50 of any Upstox stock-futures Smartlist today.</p>
      ) : (
        <ul className="reasons">
          {context.smartlists.map((t) => (
            <li key={t.category}>
              Smartlist <strong>{t.label}</strong>: rank #{t.rank}
              {t.price_change_pct !== null ? ` · price ${t.price_change_pct > 0 ? "+" : ""}${t.price_change_pct.toFixed(2)}%` : ""}
              {t.metric_key === "open_interest" && t.metric_change_pct !== null
                ? ` · open interest ${t.metric_change_pct > 0 ? "+" : ""}${t.metric_change_pct.toFixed(1)}%`
                : ""}
              {t.reading ? ` → ${t.reading}` : ""}
            </li>
          ))}
        </ul>
      )}
      {context.news.length > 0 && (
        <>
          <strong>Latest news</strong>
          <ul className="reasons">
            {context.news.map((n, i) => (
              <li key={i}>
                {n.link ? (
                  <a href={n.link} target="_blank" rel="noreferrer">
                    {n.heading}
                  </a>
                ) : (
                  n.heading
                )}
                {n.published_at && <span className="muted"> · {new Date(n.published_at).toLocaleString()}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted">
        Buildup readings (long/short buildup, short covering, long unwinding) describe how futures positions changed in
        the last session. They are not a forecast.
      </p>
    </div>
  );
}

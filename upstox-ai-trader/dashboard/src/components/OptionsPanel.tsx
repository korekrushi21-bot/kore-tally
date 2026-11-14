import { useMemo, useState } from "react";
import type {
  OptionBacktestResult,
  OptionContractDTO,
  OptionEvaluateResult,
  OptionSignalPreview,
} from "../types";
import { api, ApiError } from "../api";
import { EquityCurveChart } from "./EquityCurveChart";
import { MetricsTable } from "./BacktestPanel";

const STRIKE_OFFSETS = [
  { value: -2, label: "2 strikes ITM" },
  { value: -1, label: "1 strike ITM" },
  { value: 0, label: "ATM" },
  { value: 1, label: "1 strike OTM" },
  { value: 2, label: "2 strikes OTM" },
];

function rupees(n: number | null | undefined, digits = 0) {
  if (n === null || n === undefined) return "—";
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function errorText(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback;
}

export function OptionsPanel({ connected, onTraded }: { connected: boolean; onTraded: () => void }) {
  const [underlyingKey, setUnderlyingKey] = useState("NSE_EQ|INE020B01018");
  const [contracts, setContracts] = useState<OptionContractDTO[]>([]);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState(""); // "" = auto
  const [strikeOffset, setStrikeOffset] = useState(0);
  const [preview, setPreview] = useState<OptionSignalPreview | null>(null);
  const [evaluateResult, setEvaluateResult] = useState<OptionEvaluateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run<T>(fn: () => Promise<T>, fallback: string): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorText(e, fallback));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadContracts() {
    const res = await run(() => api.optionContracts(underlyingKey), "Failed to load option contracts");
    if (res) {
      setContracts(res.contracts);
      setExpiries(res.expiries);
      setExpiry("");
    }
  }

  const params = { underlyingKey, strikeOffset, expiryDate: expiry || undefined };

  async function getPreview() {
    setEvaluateResult(null);
    const res = await run(() => api.optionSignal(params), "Failed to get option signal");
    setPreview(res);
  }

  async function paperTrade() {
    const res = await run(() => api.optionPaperEvaluate(params), "Failed to evaluate option trade");
    if (res) {
      setEvaluateResult(res);
      onTraded();
    }
  }

  return (
    <div>
      <p className="muted">
        Signal comes from the <strong>underlying</strong> share/index chart. A BUY signal buys a CALL (CE), a SELL
        signal buys a PUT (PE). Options are only ever bought here, never sold or written. Exits trigger when the
        underlying hits the signal's stop-loss or target, and positions are closed on expiry day. Paper trading and
        backtests only: no real option orders are placed.
      </p>
      {!connected && <p className="muted">Connect your Upstox account above to use options.</p>}

      <div className="row">
        <input
          type="text"
          value={underlyingKey}
          onChange={(e) => setUnderlyingKey(e.target.value)}
          placeholder="NSE_EQ|INE020B01018 or NSE_INDEX|Nifty 50"
          style={{ width: 260 }}
          aria-label="Underlying instrument key"
        />
        <button disabled={!connected || busy} onClick={loadContracts}>
          Load expiries
        </button>
        <select value={expiry} onChange={(e) => setExpiry(e.target.value)} aria-label="Expiry">
          <option value="">Expiry: auto (nearest safe)</option>
          {expiries.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <select value={strikeOffset} onChange={(e) => setStrikeOffset(Number(e.target.value))} aria-label="Strike">
          {STRIKE_OFFSETS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <button className="primary" disabled={!connected || busy} onClick={getPreview}>
          Preview option trade
        </button>
        <button disabled={!connected || busy} onClick={paperTrade}>
          Evaluate &amp; Paper-Trade option
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {preview && <PreviewView preview={preview} />}

      {evaluateResult && (
        <div className="card" style={{ marginTop: 10, background: "var(--bg)" }}>
          <strong>Risk engine decision:</strong> {evaluateResult.entry_result.action}
          {evaluateResult.entry_result.position?.option && (
            <p>
              Bought {evaluateResult.entry_result.position.option.lots} lot(s) of{" "}
              <strong>{evaluateResult.entry_result.position.option.trading_symbol}</strong> @{" "}
              {evaluateResult.entry_result.position.entry_price.toFixed(2)} · max planned loss{" "}
              {rupees(evaluateResult.entry_result.max_loss_amount)}
            </p>
          )}
          {evaluateResult.entry_result.reasons && (
            <ul className="reasons">
              {evaluateResult.entry_result.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {evaluateResult.exits.length > 0 && (
            <p className="muted">{evaluateResult.exits.length} open option position(s) on this underlying were closed first.</p>
          )}
        </div>
      )}

      <OptionBacktest connected={connected} underlyingKey={underlyingKey} contracts={contracts} expiries={expiries} />
    </div>
  );
}

function PreviewView({ preview }: { preview: OptionSignalPreview }) {
  const action = preview.signal.action;
  return (
    <div>
      <div className="row">
        <span className={`pill ${action === "BUY" ? "green" : action === "SELL" ? "red" : "neutral"}`}>
          Underlying: {action}
        </span>
        {preview.contract && <span className="pill neutral">{preview.contract.trading_symbol || preview.contract.instrument_key}</span>}
        {preview.risk && (
          <span className={`pill ${preview.risk.approved ? "green" : "amber"}`}>
            {preview.risk.approved ? "Risk engine: would trade" : "Risk engine: would NOT trade"}
          </span>
        )}
      </div>

      {!preview.contract && (
        <ul className="reasons">
          {(preview.entry_result?.reasons ?? preview.signal.reasons).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      {preview.contract && preview.risk && (
        <>
          <div className="grid" style={{ marginBottom: 10 }}>
            <Stat label="Spot" value={preview.spot?.toFixed(2)} />
            <Stat label="Premium" value={preview.premium?.toFixed(2)} />
            <Stat label="Delta (est.)" value={preview.delta?.toFixed(2) ?? "—"} />
            <Stat label="Days to expiry" value={String(preview.days_to_expiry)} />
            <Stat label="Breakeven at expiry" value={preview.breakeven_at_expiry?.toFixed(2)} />
            <Stat
              label="Underlying stop / target"
              value={`${preview.signal.stop_loss?.toFixed(2)} / ${preview.signal.target?.toFixed(2)}`}
            />
            <Stat
              label="Premium at stop / target (est.)"
              value={`${preview.estimated_premium_stop?.toFixed(2) ?? "—"} / ${preview.estimated_premium_target?.toFixed(2) ?? "—"}`}
            />
            <Stat
              label="Size"
              value={`${preview.risk.lots} lot(s) · ${preview.risk.quantity} qty`}
            />
            <Stat label="Premium outlay" value={rupees(preview.risk.premium_outlay)} />
            <Stat label="Planned max loss" value={rupees(preview.risk.max_loss_amount)} />
          </div>
          {preview.risk.reasons.length > 0 && (
            <ul className="reasons bad">
              {preview.risk.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          <p className="muted">
            Premium levels are a delta estimate. Time decay (theta) can lower the premium further, even if the
            underlying never reaches the stop.
          </p>
          <strong>Why (underlying signal):</strong>
          <ul className="reasons">
            {preview.signal.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value ?? "—"}</div>
    </div>
  );
}

function OptionBacktest({
  connected,
  underlyingKey,
  contracts,
  expiries,
}: {
  connected: boolean;
  underlyingKey: string;
  contracts: OptionContractDTO[];
  expiries: string[];
}) {
  const [expiry, setExpiry] = useState("");
  const [strike, setStrike] = useState("");
  const [fromDate, setFromDate] = useState(() => new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [unit, setUnit] = useState("days");
  const [interval, setBarInterval] = useState(1);
  const [result, setResult] = useState<OptionBacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const strikes = useMemo(
    () => [...new Set(contracts.filter((c) => c.expiry === expiry).map((c) => c.strike))].sort((a, b) => a - b),
    [contracts, expiry]
  );

  async function runBacktest() {
    if (!expiry || !strike) {
      setError("Pick an expiry and strike first (click “Load expiries” above)");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.optionBacktest({ underlyingKey, expiryDate: expiry, strike: Number(strike), fromDate, toDate, unit, interval })
      );
    } catch (e) {
      setResult(null);
      setError(errorText(e, "Option backtest failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <h2>Options backtest</h2>
      <p className="muted">
        Uses the real price history of one listed CE and PE (same strike and expiry). Upstox only serves history for
        contracts that are still listed, so the range is limited to that contract's life. Use hours or minutes for
        more bars.
      </p>
      <div className="row">
        <select value={expiry} onChange={(e) => { setExpiry(e.target.value); setStrike(""); }} aria-label="Backtest expiry">
          <option value="">Expiry…</option>
          {expiries.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <select value={strike} onChange={(e) => setStrike(e.target.value)} aria-label="Backtest strike">
          <option value="">Strike…</option>
          {strikes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label="From date" />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} aria-label="To date" />
        <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Candle unit">
          <option value="days">days</option>
          <option value="hours">hours</option>
          <option value="minutes">minutes</option>
        </select>
        <input
          type="number"
          min={1}
          value={interval}
          onChange={(e) => setBarInterval(Math.max(1, Number(e.target.value) || 1))}
          style={{ width: 60 }}
          aria-label="Interval"
        />
        <button className="primary" disabled={!connected || busy} onClick={runBacktest}>
          Run options backtest
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {result && (
        <div>
          <p className="muted">
            {result.call.trading_symbol} / {result.put.trading_symbol} · candles: underlying{" "}
            {result.candles_used.underlying}, CE {result.candles_used.call}, PE {result.candles_used.put} · ending
            capital{" "}
            <strong className={result.ending_capital >= result.starting_capital ? "text-green" : "text-red"}>
              {result.ending_capital.toLocaleString("en-IN")}
            </strong>{" "}
            (from {result.starting_capital.toLocaleString("en-IN")}) · {result.rejected_signal_count} signals rejected
          </p>
          <EquityCurveChart points={result.equity_curve} />
          <div style={{ marginTop: 12 }}>
            <MetricsTable title="Overall" metrics={result.metrics.all} />
          </div>
          <details style={{ marginTop: 12 }}>
            <summary>All {result.trades.length} trades</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Qty</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Reason</th>
                    <th>P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.map((t, i) => (
                    <tr key={i}>
                      <td>
                        <span className={`pill ${t.side === "BUY CE" ? "green" : "red"}`}>{t.side}</span> {t.contract}
                      </td>
                      <td>{t.quantity}</td>
                      <td>
                        {new Date(t.entry_date).toLocaleString()} @ {t.entry_price.toFixed(2)}
                      </td>
                      <td>
                        {new Date(t.exit_date).toLocaleString()} @ {t.exit_price.toFixed(2)}
                      </td>
                      <td>{t.exit_reason}</td>
                      <td className={t.realized_pnl >= 0 ? "text-green" : "text-red"}>{t.realized_pnl.toFixed(2)}</td>
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

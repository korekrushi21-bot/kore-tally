import { useState } from "react";
import type { EvaluateResult, Signal } from "../types";
import { api, ApiError } from "../api";

function actionPillClass(action: string) {
  if (action === "BUY") return "green";
  if (action === "SELL") return "red";
  return "neutral";
}

export function SignalPanel({ connected, onTraded }: { connected: boolean; onTraded: () => void }) {
  const [instrumentKey, setInstrumentKey] = useState("NSE_EQ|INE002A01018");
  const [signal, setSignal] = useState<Signal | null>(null);
  const [evaluateResult, setEvaluateResult] = useState<EvaluateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function getSignal() {
    setBusy(true);
    setError(null);
    setEvaluateResult(null);
    try {
      setSignal(await api.signal(instrumentKey));
    } catch (e) {
      setSignal(null);
      setError(e instanceof ApiError ? e.message : "Failed to get signal");
    } finally {
      setBusy(false);
    }
  }

  async function evaluateAndTrade() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.paperEvaluate(instrumentKey);
      setEvaluateResult(result);
      onTraded();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to evaluate");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {!connected && <p className="muted">Connect your Upstox account above to fetch real market data for signals.</p>}
      <div className="row">
        <input
          type="text"
          value={instrumentKey}
          onChange={(e) => setInstrumentKey(e.target.value)}
          placeholder="NSE_EQ|INE002A01018"
          style={{ width: 220 }}
        />
        <button className="primary" disabled={!connected || busy} onClick={getSignal}>
          Get Signal
        </button>
        <button disabled={!connected || busy} onClick={evaluateAndTrade}>
          Evaluate &amp; Paper-Trade
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {signal && (
        <div>
          <div className="row">
            <span className={`pill ${actionPillClass(signal.action)}`}>{signal.action}</span>
            <span>Strength: {signal.strength.toFixed(0)}/100</span>
            {signal.is_stale && <span className="pill amber">⚠ Stale data</span>}
          </div>
          {signal.action !== "NO_TRADE" && (
            <div className="grid" style={{ marginBottom: 10 }}>
              <div className="stat">
                <div className="label">Entry</div>
                <div className="value">{signal.entry_price?.toFixed(2)}</div>
              </div>
              <div className="stat">
                <div className="label">Stop-loss</div>
                <div className="value">{signal.stop_loss?.toFixed(2)}</div>
              </div>
              <div className="stat">
                <div className="label">Target</div>
                <div className="value">{signal.target?.toFixed(2)}</div>
              </div>
              <div className="stat">
                <div className="label">Risk:Reward</div>
                <div className="value">1:{signal.risk_reward?.toFixed(1)}</div>
              </div>
            </div>
          )}
          <strong>Why:</strong>
          <ul className="reasons">
            {signal.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          {signal.invalidation.length > 0 && (
            <>
              <strong>Would invalidate this:</strong>
              <ul className="reasons bad">
                {signal.invalidation.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {evaluateResult && (
        <div className="card" style={{ marginTop: 10, background: "var(--bg)" }}>
          <strong>Risk engine decision:</strong> {evaluateResult.entry_result.action}
          {evaluateResult.entry_result.reasons && (
            <ul className="reasons">
              {evaluateResult.entry_result.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {evaluateResult.exits.length > 0 && (
            <p className="muted">{evaluateResult.exits.length} existing position(s) closed on this instrument first.</p>
          )}
        </div>
      )}
    </div>
  );
}

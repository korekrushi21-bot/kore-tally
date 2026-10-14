import { useEffect, useState } from "react";
import type { LiveEvaluateResult, LivePreflight, LiveStatus } from "../types";
import { api, ApiError } from "../api";

const CONFIRM_PHRASE = "STOP ALL LIVE TRADING";

export function LiveTradingPanel({ connected }: { connected: boolean }) {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [preflight, setPreflight] = useState<LivePreflight | null>(null);
  const [armed, setArmed] = useState(false);
  const [instrumentKey, setInstrumentKey] = useState("NSE_EQ|INE002A01018");
  const [evaluateResult, setEvaluateResult] = useState<LiveEvaluateResult | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setStatus(await api.liveStatus());
    } catch {
      /* backend unreachable */
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (connected && status?.live_trading_enabled && !preflight) {
      api.livePreflight().then(setPreflight).catch(() => {});
    }
  }, [connected, status?.live_trading_enabled, preflight]);

  async function evaluate() {
    setBusy(true);
    setError(null);
    try {
      setEvaluateResult(await api.liveEvaluate(instrumentKey));
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Live evaluate failed");
    } finally {
      setBusy(false);
    }
  }

  async function stopAll() {
    setBusy(true);
    setError(null);
    try {
      await api.liveStopAll(confirmText);
      setConfirmText("");
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Stop-all failed");
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    setBusy(true);
    setError(null);
    try {
      await api.liveResume();
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Resume failed");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <p className="muted">Loading live trading status…</p>;

  if (!status.live_trading_enabled) {
    return (
      <div>
        <span className="pill neutral">Live trading disabled</span>
        <p className="muted" style={{ marginTop: 8 }}>
          This backend has live trading turned off (the safe default). To enable it, set{" "}
          <code>LIVE_TRADING_ENABLED=true</code> in <code>backend/.env</code> and restart the backend — it cannot be
          turned on from this dashboard or any API call. See the README for the Upstox static-IP and algo-rate
          prerequisites first.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="row">
        {status.trading_halted ? (
          <span className="pill red">⛔ Live trading halted</span>
        ) : (
          <span className="pill amber">⚠ Live trading ARMED and enabled</span>
        )}
        {status.daily_loss_limit_halted && <span className="pill amber">Daily loss limit reached</span>}
      </div>

      {preflight && (
        <div className="stat" style={{ marginTop: 8, marginBottom: 8 }}>
          <div className="label">Compliance preflight (verify this yourself before trading)</div>
          <div style={{ fontSize: "0.82rem", marginTop: 4 }}>
            Registered static IPs: <code>{JSON.stringify(preflight.registered_static_ips)}</code>
            <br />
            Algo name configured: {preflight.algo_name_configured ?? "— none —"}
          </div>
        </div>
      )}

      {!armed ? (
        <div className="row">
          <label className="row" style={{ marginBottom: 0 }}>
            <input type="checkbox" onChange={(e) => setArmed(e.target.checked)} />
            <span className="muted">
              I understand actions below place real orders with real money on my Upstox account.
            </span>
          </label>
        </div>
      ) : (
        <>
          <div className="row">
            <input value={instrumentKey} onChange={(e) => setInstrumentKey(e.target.value)} style={{ width: 200 }} />
            <button disabled={!connected || busy} onClick={evaluate}>
              Evaluate &amp; Place Live Order
            </button>
          </div>

          {error && <div className="error-banner">{error}</div>}

          {evaluateResult && (
            <div className="card" style={{ background: "var(--bg)" }}>
              <strong>Result:</strong> {evaluateResult.action}
              {evaluateResult.reasons && (
                <ul className="reasons">
                  {evaluateResult.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              {evaluateResult.protective_order_failures && evaluateResult.protective_order_failures.length > 0 && (
                <p className="text-red">
                  ⚠ Protective order failure — this position may not have a real stop-loss or target resting on the
                  exchange. Check manually: {evaluateResult.protective_order_failures.join("; ")}
                </p>
              )}
            </div>
          )}

          <table style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Entry</th>
                <th>Stop</th>
                <th>Target</th>
                <th>Protected</th>
              </tr>
            </thead>
            <tbody>
              {status.open_positions.map((p) => (
                <tr key={p.id}>
                  <td>{p.instrument_key}</td>
                  <td>{p.side}</td>
                  <td>{p.quantity}</td>
                  <td>{p.entry_price.toFixed(2)}</td>
                  <td>{p.stop_loss.toFixed(2)}</td>
                  <td>{p.target.toFixed(2)}</td>
                  <td>{p.stop_loss_placement_failed ? <span className="pill red">NO STOP</span> : <span className="pill green">OK</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="row" style={{ marginTop: 12 }}>
            {status.trading_halted ? (
              <button className="primary" disabled={busy} onClick={resume}>
                Resume Live Trading
              </button>
            ) : (
              <>
                <input
                  placeholder={CONFIRM_PHRASE}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  style={{ width: 220 }}
                />
                <button className="danger" disabled={busy || confirmText !== CONFIRM_PHRASE} onClick={stopAll}>
                  ⛔ Stop All Live Trading (flattens entire account)
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

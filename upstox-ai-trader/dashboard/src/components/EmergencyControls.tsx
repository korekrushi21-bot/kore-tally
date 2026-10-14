import { useState } from "react";
import { api, ApiError } from "../api";

export function EmergencyControls({ tradingHalted, onChanged }: { tradingHalted: boolean; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function stopAll() {
    setBusy(true);
    setError(null);
    try {
      await api.paperStopAll({});
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to stop trading");
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    setBusy(true);
    setError(null);
    try {
      await api.paperResume();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to resume trading");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row" style={{ marginBottom: 0 }}>
      {error && <div className="error-banner">{error}</div>}
      {tradingHalted ? (
        <button className="primary" disabled={busy} onClick={resume}>
          Resume Trading
        </button>
      ) : confirming ? (
        <>
          <span className="muted">Close every open paper position and halt new trades?</span>
          <button className="danger" disabled={busy} onClick={stopAll}>
            Yes, stop everything
          </button>
          <button disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button className="danger" onClick={() => setConfirming(true)}>
          ⛔ Emergency Stop All
        </button>
      )}
    </div>
  );
}

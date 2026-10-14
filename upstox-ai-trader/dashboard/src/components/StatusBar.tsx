import type { AuthStatus } from "../types";
import { api } from "../api";

export function StatusBar({ status, onDisconnect }: { status: AuthStatus | null; onDisconnect: () => void }) {
  const connected = status?.connected ?? false;

  return (
    <div className="row" style={{ marginBottom: 0 }}>
      {connected ? (
        <span className="pill green">● Connected ({status?.upstox_user_id})</span>
      ) : (
        <span className="pill red">● Not connected</span>
      )}
      {connected && status?.token_expires_at && (
        <span className="muted">token expires {new Date(status.token_expires_at).toLocaleString()}</span>
      )}
      {!connected && status?.reason && <span className="muted">{status.reason}</span>}
      {connected ? (
        <button onClick={onDisconnect}>Disconnect</button>
      ) : (
        <button className="primary" onClick={() => (window.location.href = api.loginUrl())}>
          Connect Upstox Account
        </button>
      )}
    </div>
  );
}

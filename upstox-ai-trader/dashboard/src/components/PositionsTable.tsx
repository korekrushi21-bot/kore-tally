import { useState } from "react";
import type { PaperPositionDTO } from "../types";
import { api, ApiError } from "../api";

export function PositionsTable({
  positions,
  onChanged,
}: {
  positions: PaperPositionDTO[];
  onChanged: () => void;
}) {
  const [closingId, setClosingId] = useState<number | null>(null);
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function closePosition(id: number) {
    const parsed = Number(price);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter a valid close price first");
      return;
    }
    try {
      await api.paperClosePosition(id, parsed);
      setClosingId(null);
      setPrice("");
      setError(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to close position");
    }
  }

  if (positions.length === 0) return <p className="muted">No open paper positions.</p>;

  return (
    <div className="table-wrap">
      {error && <div className="error-banner">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Side</th>
            <th>Qty</th>
            <th>Entry</th>
            <th>Stop</th>
            <th>Target</th>
            <th>Mark</th>
            <th>Unrealized P&amp;L</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.id}>
              <td>{p.instrument_key}</td>
              <td>
                <span className={`pill ${p.side === "BUY" ? "green" : "red"}`}>{p.side}</span>
              </td>
              <td>{p.quantity}</td>
              <td>{p.entry_price.toFixed(2)}</td>
              <td>{p.stop_loss.toFixed(2)}</td>
              <td>{p.target.toFixed(2)}</td>
              <td>{p.mark_price?.toFixed(2) ?? "—"}</td>
              <td className={(p.unrealized_pnl ?? 0) >= 0 ? "text-green" : "text-red"}>
                {p.unrealized_pnl?.toFixed(2) ?? "—"}
              </td>
              <td>
                {closingId === p.id ? (
                  <span className="row" style={{ marginBottom: 0 }}>
                    <input
                      type="number"
                      placeholder="price"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      style={{ width: 90 }}
                    />
                    <button className="primary" onClick={() => closePosition(p.id)}>
                      Confirm
                    </button>
                    <button onClick={() => setClosingId(null)}>Cancel</button>
                  </span>
                ) : (
                  <button onClick={() => setClosingId(p.id)}>Close</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

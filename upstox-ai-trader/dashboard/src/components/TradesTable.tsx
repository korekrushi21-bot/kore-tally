import type { PaperPositionDTO } from "../types";

export function TradesTable({ trades }: { trades: PaperPositionDTO[] }) {
  if (trades.length === 0) return <p className="muted">No closed trades yet.</p>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Side</th>
            <th>Qty</th>
            <th>Entry</th>
            <th>Exit</th>
            <th>Reason</th>
            <th>Realized P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id}>
              <td>{t.instrument_key}</td>
              <td>
                <span className={`pill ${t.side === "BUY" ? "green" : "red"}`}>{t.side}</span>
              </td>
              <td>{t.quantity}</td>
              <td>{t.entry_price.toFixed(2)}</td>
              <td>{t.exit_price?.toFixed(2) ?? "—"}</td>
              <td>{t.exit_reason}</td>
              <td className={(t.realized_pnl ?? 0) >= 0 ? "text-green" : "text-red"}>
                {t.realized_pnl?.toFixed(2) ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

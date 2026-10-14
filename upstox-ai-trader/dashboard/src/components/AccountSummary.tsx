import type { PaperAccount } from "../types";

function money(n: number) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function SignedStat({ label, value }: { label: string; value: number }) {
  const cls = value > 0 ? "text-green" : value < 0 ? "text-red" : "";
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value ${cls}`}>
        {value >= 0 ? "+" : ""}
        {money(value)}
      </div>
    </div>
  );
}

export function AccountSummary({ account }: { account: PaperAccount | null }) {
  if (!account) return <p className="muted">Loading account…</p>;

  return (
    <>
      <div className="grid">
        <div className="stat">
          <div className="label">Starting Capital</div>
          <div className="value">₹{money(account.starting_capital)}</div>
        </div>
        <div className="stat">
          <div className="label">Net Equity</div>
          <div className="value">₹{money(account.net_equity)}</div>
        </div>
        <SignedStat label="Realized P&amp;L (Today)" value={account.realized_pnl_today} />
        <SignedStat label="Realized P&amp;L (All-time)" value={account.realized_pnl_all_time} />
        <SignedStat label="Unrealized P&amp;L" value={account.unrealized_pnl} />
        <div className="stat">
          <div className="label">Daily Risk Used</div>
          <div className={`value ${account.daily_risk_utilization_pct >= 100 ? "text-red" : ""}`}>
            {account.daily_risk_utilization_pct.toFixed(1)}%
          </div>
        </div>
      </div>
      <div className="row" style={{ marginTop: 12, marginBottom: 0 }}>
        {account.trading_halted && <span className="pill red">⛔ Trading halted (emergency stop)</span>}
        {account.daily_loss_limit_halted && <span className="pill amber">⚠ Daily loss limit reached</span>}
        {!account.trading_halted && !account.daily_loss_limit_halted && (
          <span className="pill green">Trading active</span>
        )}
      </div>
    </>
  );
}

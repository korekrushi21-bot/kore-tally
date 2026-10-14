import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { AuthStatus, PaperAccount, PaperPositionDTO } from "./types";
import { StatusBar } from "./components/StatusBar";
import { AccountSummary } from "./components/AccountSummary";
import { PositionsTable } from "./components/PositionsTable";
import { TradesTable } from "./components/TradesTable";
import { EmergencyControls } from "./components/EmergencyControls";
import { BrokerPanel } from "./components/BrokerPanel";
import { SignalPanel } from "./components/SignalPanel";
import { BacktestPanel } from "./components/BacktestPanel";
import { LiveTradingPanel } from "./components/LiveTradingPanel";

const POLL_INTERVAL_MS = 15_000;

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [account, setAccount] = useState<PaperAccount | null>(null);
  const [trades, setTrades] = useState<PaperPositionDTO[]>([]);

  const refresh = useCallback(async () => {
    try {
      setAuthStatus(await api.authStatus());
    } catch {
      setAuthStatus({ connected: false });
    }
    try {
      setAccount(await api.paperAccount());
    } catch {
      /* backend unreachable; leave last known state */
    }
    try {
      setTrades(await api.paperTrades());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  async function disconnect() {
    await api.disconnect();
    refresh();
  }

  const connected = authStatus?.connected ?? false;

  return (
    <>
      <div className="app-header">
        <div>
          <h1>Upstox AI Smart Trader</h1>
          <div className="subtitle">Paper trading by default. Live trading exists but is off unless explicitly enabled.</div>
        </div>
        <StatusBar status={authStatus} onDisconnect={disconnect} />
      </div>

      <div className="card">
        <h2>Paper Account</h2>
        <AccountSummary account={account} />
        <div style={{ marginTop: 12 }}>
          <EmergencyControls tradingHalted={account?.trading_halted ?? false} onChanged={refresh} />
        </div>
      </div>

      <div className="two-col">
        <div className="card">
          <h2>Open Positions</h2>
          <PositionsTable positions={account?.open_positions ?? []} onChanged={refresh} />
        </div>
        <div className="card">
          <h2>Completed Trades</h2>
          <TradesTable trades={trades} />
        </div>
      </div>

      <div className="card">
        <h2>Broker Account (live Upstox data, read-only)</h2>
        <BrokerPanel connected={connected} />
      </div>

      <div className="card">
        <h2>Strategy Signal</h2>
        <SignalPanel connected={connected} onTraded={refresh} />
      </div>

      <div className="card">
        <h2>Backtest</h2>
        <BacktestPanel connected={connected} />
      </div>

      <div className="card live-card">
        <h2>⚠ Live Trading — real money, real orders</h2>
        <LiveTradingPanel connected={connected} />
      </div>
    </>
  );
}

export default App;

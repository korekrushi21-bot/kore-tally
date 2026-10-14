export interface AuthStatus {
  connected: boolean;
  upstox_user_id?: string;
  token_generated_at?: string;
  token_expires_at?: string;
  reason?: string;
}

export interface PaperPositionDTO {
  id: number;
  instrument_key: string;
  side: "BUY" | "SELL";
  quantity: number;
  entry_price: number;
  stop_loss: number;
  target: number;
  status: "OPEN" | "CLOSED";
  exit_price: number | null;
  exit_reason: string | null;
  realized_pnl: number | null;
  mark_price?: number;
  unrealized_pnl?: number;
}

export interface PaperAccount {
  starting_capital: number;
  net_equity: number;
  realized_pnl_all_time: number;
  realized_pnl_today: number;
  unrealized_pnl: number;
  daily_risk_utilization_pct: number;
  trading_halted: boolean;
  daily_loss_limit_halted: boolean;
  open_positions: PaperPositionDTO[];
}

export interface Signal {
  instrument_key: string;
  action: "BUY" | "SELL" | "NO_TRADE";
  entry_price: number | null;
  stop_loss: number | null;
  target: number | null;
  risk_reward: number | null;
  strength: number;
  reasons: string[];
  invalidation: string[];
  data_timestamp: string | null;
  is_stale: boolean;
  generated_at: string;
  candles_used: number;
}

export interface EvaluateResult {
  exits: PaperPositionDTO[];
  signal_action: string;
  entry_result: {
    action: "opened" | "rejected" | "no_trade";
    position?: PaperPositionDTO;
    max_loss_amount?: number;
    reasons?: string[];
    signal?: Record<string, unknown>;
  };
}

export interface BacktestMetrics {
  total_trades: number;
  win_rate: number;
  net_pnl: number;
  gross_profit: number;
  gross_loss: number;
  profit_factor: number | null;
  avg_win: number;
  avg_loss: number;
  avg_planned_risk_reward: number;
  total_costs: number;
  max_drawdown_amount: number;
  max_drawdown_pct: number;
}

export interface BacktestTradeDTO {
  side: "BUY" | "SELL";
  entry_date: string;
  entry_price: number;
  exit_date: string;
  exit_price: number;
  exit_reason: string;
  quantity: number;
  planned_risk_reward: number;
  costs: number;
  realized_pnl: number;
  period: "train" | "test" | "all";
}

export interface BacktestResult {
  instrument_key: string;
  candles_used: number;
  starting_capital: number;
  ending_capital: number;
  rejected_signal_count: number;
  metrics: { all: BacktestMetrics; train: BacktestMetrics | null; test: BacktestMetrics | null };
  trades: BacktestTradeDTO[];
  equity_curve: { date: string; equity: number }[];
}

export type UpstoxPassthrough = { status: string; data: unknown };

export interface LivePositionDTO {
  id: number;
  instrument_key: string;
  side: "BUY" | "SELL";
  quantity: number;
  entry_price: number;
  stop_loss: number;
  target: number;
  stop_order_id: string | null;
  target_order_id: string | null;
  stop_loss_placement_failed: boolean;
  status: "OPEN" | "CLOSED";
  exit_price: number | null;
  exit_reason: string | null;
  realized_pnl: number | null;
}

export interface LiveStatus {
  live_trading_enabled: boolean;
  trading_halted: boolean;
  daily_loss_limit_halted: boolean;
  realized_pnl_today: number;
  open_positions: LivePositionDTO[];
  order_product: string;
  algo_name_configured: boolean;
}

export interface LivePreflight {
  live_trading_enabled: boolean;
  registered_static_ips: Record<string, unknown>;
  algo_name_configured: string | null;
  order_rate_guard_seconds: number;
  note: string;
}

export interface LiveEvaluateResult {
  signal_action: string;
  action: string;
  reasons?: string[];
  position_id?: number;
  entry_order_id?: string;
  entry_price?: number;
  quantity?: number;
  stop_order_id?: string;
  target_order_id?: string;
  protective_order_failures?: string[];
  reconciled?: unknown[];
  funds_note?: string | null;
}

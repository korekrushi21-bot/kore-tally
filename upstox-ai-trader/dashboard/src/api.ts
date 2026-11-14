import type {
  AuthStatus,
  BacktestResult,
  EvaluateResult,
  LiveEvaluateResult,
  LivePositionDTO,
  LivePreflight,
  LiveStatus,
  OptionBacktestResult,
  OptionContractsResponse,
  OptionEvaluateResult,
  OptionSignalPreview,
  PaperAccount,
  PaperPositionDTO,
  ScanLatest,
  ScanRunDTO,
  Signal,
  UpstoxPassthrough,
} from "./types";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8010";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(res.status, body.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface OptionTradeParams {
  underlyingKey: string;
  strikeOffset: number;
  expiryDate?: string;
  unit?: string;
  interval?: number;
}

function optionTradeQuery(p: OptionTradeParams) {
  const qs = new URLSearchParams({
    underlying_key: p.underlyingKey,
    strike_offset: String(p.strikeOffset),
    unit: p.unit ?? "days",
    interval: String(p.interval ?? 1),
  });
  if (p.expiryDate) qs.set("expiry_date", p.expiryDate);
  return qs.toString();
}

export const api = {
  baseUrl: BASE_URL,

  authStatus: () => request<AuthStatus>("/auth/status"),
  disconnect: () => request<{ connected: boolean }>("/auth/disconnect", { method: "POST" }),
  loginUrl: () => `${BASE_URL}/auth/login`,

  marketProfile: () => request<UpstoxPassthrough>("/market/profile"),
  marketHoldings: () => request<UpstoxPassthrough>("/market/holdings"),
  marketPositions: () => request<UpstoxPassthrough>("/market/positions"),
  marketFunds: () => request<UpstoxPassthrough>("/market/funds"),
  marketOrders: () => request<UpstoxPassthrough>("/market/orders"),

  signal: (instrumentKey: string, unit = "days", interval = 1) =>
    request<Signal>(
      `/strategy/signal?instrument_key=${encodeURIComponent(instrumentKey)}&unit=${unit}&interval=${interval}`
    ),

  paperAccount: () => request<PaperAccount>("/paper/account"),
  paperPositions: () => request<PaperPositionDTO[]>("/paper/positions"),
  paperTrades: (limit = 50) => request<PaperPositionDTO[]>(`/paper/trades?limit=${limit}`),
  paperEvaluate: (instrumentKey: string, unit = "days", interval = 1) =>
    request<EvaluateResult>(
      `/paper/evaluate?instrument_key=${encodeURIComponent(instrumentKey)}&unit=${unit}&interval=${interval}`,
      { method: "POST" }
    ),
  paperClosePosition: (id: number, price: number) =>
    request<PaperPositionDTO>(`/paper/positions/${id}/close`, {
      method: "POST",
      body: JSON.stringify({ price }),
    }),
  paperStopAll: (prices: Record<string, number> = {}) =>
    request<{ positions_closed: PaperPositionDTO[] }>("/paper/stop-all", {
      method: "POST",
      body: JSON.stringify(prices),
    }),
  paperResume: () => request<{ trading_halted: boolean }>("/paper/resume", { method: "POST" }),

  runBacktest: (params: {
    instrumentKey: string;
    fromDate: string;
    toDate: string;
    unit?: string;
    interval?: number;
    trainEndDate?: string;
    startingCapital?: number;
  }) => {
    const qs = new URLSearchParams({
      instrument_key: params.instrumentKey,
      from_date: params.fromDate,
      to_date: params.toDate,
      unit: params.unit ?? "days",
      interval: String(params.interval ?? 1),
    });
    if (params.trainEndDate) qs.set("train_end_date", params.trainEndDate);
    if (params.startingCapital) qs.set("starting_capital", String(params.startingCapital));
    return request<BacktestResult>(`/backtest/run?${qs.toString()}`);
  },

  optionContracts: (underlyingKey: string) =>
    request<OptionContractsResponse>(`/options/contracts?underlying_key=${encodeURIComponent(underlyingKey)}`),
  optionSignal: (p: OptionTradeParams) => request<OptionSignalPreview>(`/options/signal?${optionTradeQuery(p)}`),
  optionPaperEvaluate: (p: OptionTradeParams) =>
    request<OptionEvaluateResult>(`/options/paper/evaluate?${optionTradeQuery(p)}`, { method: "POST" }),
  optionBacktest: (p: {
    underlyingKey: string;
    expiryDate: string;
    strike: number;
    fromDate: string;
    toDate: string;
    unit: string;
    interval: number;
    trainEndDate?: string;
    startingCapital?: number;
  }) => {
    const qs = new URLSearchParams({
      underlying_key: p.underlyingKey,
      expiry_date: p.expiryDate,
      strike: String(p.strike),
      from_date: p.fromDate,
      to_date: p.toDate,
      unit: p.unit,
      interval: String(p.interval),
    });
    if (p.trainEndDate) qs.set("train_end_date", p.trainEndDate);
    if (p.startingCapital) qs.set("starting_capital", String(p.startingCapital));
    return request<OptionBacktestResult>(`/options/backtest?${qs.toString()}`);
  },

  scanLatest: () => request<ScanLatest>("/scan/latest"),
  scanRun: () => request<ScanRunDTO>("/scan/run", { method: "POST" }),

  liveStatus: () => request<LiveStatus>("/live/status"),
  livePreflight: () => request<LivePreflight>("/live/preflight"),
  livePositions: () => request<LivePositionDTO[]>("/live/positions"),
  liveEvaluate: (instrumentKey: string, unit = "days", interval = 1) =>
    request<LiveEvaluateResult>(
      `/live/evaluate?instrument_key=${encodeURIComponent(instrumentKey)}&unit=${unit}&interval=${interval}`,
      { method: "POST" }
    ),
  liveReconcile: (instrumentKey?: string) =>
    request<{ results: unknown[] }>(`/live/reconcile${instrumentKey ? `?instrument_key=${encodeURIComponent(instrumentKey)}` : ""}`, {
      method: "POST",
    }),
  liveStopAll: (confirm: string) =>
    request<{ errors: string[] }>("/live/stop-all", { method: "POST", body: JSON.stringify({ confirm }) }),
  liveResume: () => request<{ trading_halted: boolean }>("/live/resume", { method: "POST" }),
};

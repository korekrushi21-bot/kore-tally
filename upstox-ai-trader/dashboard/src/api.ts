import type {
  AuthStatus,
  BacktestResult,
  EvaluateResult,
  LiveEvaluateResult,
  LivePositionDTO,
  LivePreflight,
  LiveStatus,
  PaperAccount,
  PaperPositionDTO,
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

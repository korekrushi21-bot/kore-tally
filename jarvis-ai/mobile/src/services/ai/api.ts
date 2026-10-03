import NetInfo from '@react-native-community/netinfo';
import { getAccessCode, getDeviceId, getToken, setToken } from '../../storage/secure';
import { AppError } from '../../utils';
import type { AgriResult, ClientAction, Product, Source, ToolEvent } from '../../types';

let baseUrl = '';
export function setBackendUrl(u: string) { baseUrl = u.trim().replace(/\/+$/, ''); }
export const getBackendUrl = () => baseUrl;

/** HTTPS only. Plain http is permitted only for localhost during development builds. */
function checkUrl() {
  if (!baseUrl) throw new AppError('unconfigured');
  const ok = baseUrl.startsWith('https://') || (__DEV__ && /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?/.test(baseUrl));
  if (!ok) throw new AppError('unconfigured', 'HTTPS required');
}

export async function isOnline() {
  const s = await NetInfo.fetch();
  return s.isConnected !== false && s.isInternetReachable !== false;
}

interface Opts { method?: string; body?: unknown; signal?: AbortSignal; token?: string; timeoutMs?: number }

async function rawFetch(path: string, opts: Opts): Promise<any> {
  checkUrl();
  if (!(await isOnline())) throw new AppError('offline');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60000);
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const res = await fetch(baseUrl + path, {
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) throw new AppError('auth');
    if (!res.ok) throw new AppError('ai_down');
    return await res.json();
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (opts.signal?.aborted) throw new AppError('cancelled');
    throw new AppError('ai_down');
  } finally { clearTimeout(timer); }
}

async function login(): Promise<string> {
  const code = await getAccessCode();
  if (!code) throw new AppError('unconfigured');
  const r = await rawFetch('/api/auth/device', { method: 'POST', body: { accessCode: code, deviceId: await getDeviceId() } });
  await setToken(r.token);
  return r.token;
}

/** Authenticated request: logs in lazily, re-logs-in once on 401/403. */
export async function api(path: string, opts: Opts = {}) {
  let token = (await getToken()) ?? (await login());
  try { return await rawFetch(path, { ...opts, token }); }
  catch (e) {
    if (e instanceof AppError && e.code === 'auth') {
      token = await login();
      return rawFetch(path, { ...opts, token });
    }
    throw e;
  }
}

export interface ChatReply { reply: string; sources: Source[]; toolEvents: ToolEvent[]; actions: ClientAction[]; language: string }

export const chat = (body: {
  messages: { role: 'user' | 'assistant'; content: string }[];
  language: string; assistantName: string; memories: string[];
  location?: { lat: number; lon: number; name?: string };
  provider?: string; model?: string; timezone?: string;
}, signal?: AbortSignal): Promise<ChatReply> => api('/api/chat', { method: 'POST', body, signal });

export const analyzeCrop = (body: { imageBase64: string; mimeType: string; language: string; note?: string }, signal?: AbortSignal): Promise<AgriResult> =>
  api('/api/agri/analyze', { method: 'POST', body, signal, timeoutMs: 90000 });

export const webSearch = (q: string, language: string, signal?: AbortSignal): Promise<{ summary: string; sources: Source[] }> =>
  api('/api/search', { method: 'POST', body: { q, language }, signal });

export const listProducts = (q = '', category = ''): Promise<{ products: Product[]; categories: string[] }> =>
  api(`/api/shop/products?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}`);

export const announcements = (): Promise<{ items: { id: number; title: string; body: string }[] }> => api('/api/announcements');

export async function backendStatus(): Promise<'online' | 'offline' | 'unconfigured' | 'auth' | 'down'> {
  try { checkUrl(); } catch { return 'unconfigured'; }
  if (!(await isOnline())) return 'offline';
  try { await api('/api/health'); return 'online'; }
  catch (e) { return e instanceof AppError && e.code === 'auth' ? 'auth' : 'down'; }
}

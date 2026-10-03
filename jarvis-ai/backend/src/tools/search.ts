import { config } from '../config.js';

export interface SearchResult { title: string; url: string; snippet: string; published?: string }

/** Web search via Tavily (https://tavily.com). Requires SEARCH_API_KEY. */
export async function searchWeb(query: string, opts: { news?: boolean; max?: number; signal?: AbortSignal } = {}): Promise<{ answer?: string; results: SearchResult[]; retrievedAt: string }> {
  if (!config.searchApiKey) throw new Error('search not configured');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST', signal: opts.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.searchApiKey}` },
    body: JSON.stringify({ query, max_results: opts.max ?? 5, include_answer: true, topic: opts.news ? 'news' : 'general', search_depth: 'basic' }),
  });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const j: any = await res.json();
  return {
    answer: j.answer,
    retrievedAt: new Date().toISOString(),
    results: (j.results ?? []).filter((r: any) => typeof r.url === 'string' && r.url.startsWith('https://')).map((r: any) => ({
      title: String(r.title ?? ''), url: r.url, snippet: String(r.content ?? '').slice(0, 500), published: r.published_date,
    })),
  };
}

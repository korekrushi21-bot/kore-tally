import { config } from '../config.js';

export interface SearchResult { title: string; url: string; snippet: string; published?: string }
export interface SearchOutput { answer?: string; results: SearchResult[]; retrievedAt: string; provider: string; note?: string }

const UA = { 'User-Agent': 'JARVIS-AI/1.0 (personal assistant)' };
const decode = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
const https = (u: string) => u.startsWith('https://') || (u.startsWith('http://') && config.searxngUrl.startsWith('http://') && u.startsWith(config.searxngUrl));

/** 1) SearXNG — self-hosted, free, real web results. Set SEARXNG_URL (JSON format must be enabled on the instance). */
async function searxng(q: string, signal?: AbortSignal): Promise<SearchOutput> {
  const r = await fetch(`${config.searxngUrl}/search?q=${encodeURIComponent(q)}&format=json`, { signal, headers: UA });
  if (!r.ok) throw new Error(`searxng ${r.status}`);
  const j: any = await r.json();
  return { provider: 'searxng', retrievedAt: new Date().toISOString(), results: (j.results ?? []).slice(0, 6).map((x: any) => ({ title: String(x.title ?? ''), url: String(x.url ?? ''), snippet: String(x.content ?? '').slice(0, 400), published: x.publishedDate })).filter((x: SearchResult) => x.url.startsWith('http')) };
}

/** 2) Tavily — optional; has a free tier but needs a (free) key. */
async function tavily(q: string, news: boolean, signal?: AbortSignal): Promise<SearchOutput> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.searchApiKey}` },
    body: JSON.stringify({ query: q, max_results: 5, include_answer: false, topic: news ? 'news' : 'general' }),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const j: any = await res.json();
  return { provider: 'tavily', retrievedAt: new Date().toISOString(), results: (j.results ?? []).filter((r: any) => String(r.url).startsWith('https://')).map((r: any) => ({ title: String(r.title ?? ''), url: r.url, snippet: String(r.content ?? '').slice(0, 400), published: r.published_date })) };
}

/** 3) Google News public RSS — free, no key, recent headlines with dates (headlines only, not full articles). */
export async function newsRss(q: string, signal?: AbortSignal, lang = 'en-IN', gl = 'IN'): Promise<SearchOutput> {
  const ceid = `${gl}:${lang.split('-')[0]}`;
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${lang}&gl=${gl}&ceid=${ceid}`, { signal, headers: UA });
  if (!r.ok) throw new Error(`news ${r.status}`);
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map((m) => {
    const g = (tag: string) => decode(m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? '');
    return { title: g('title'), url: g('link'), snippet: g('source') ? `Source: ${g('source')}` : '', published: g('pubDate') };
  }).filter((x) => x.url.startsWith('https://'));
  return { provider: 'google-news-rss', retrievedAt: new Date().toISOString(), results: items, note: 'Recent news headlines only (no article text).' };
}

/** 4) Wikipedia — free, official API. Encyclopedic background, NOT real-time information. */
async function wikipedia(q: string, signal?: AbortSignal, lang = 'en'): Promise<SearchOutput> {
  const r = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=4&format=json&origin=*`, { signal, headers: UA });
  if (!r.ok) throw new Error(`wiki ${r.status}`);
  const j: any = await r.json();
  return {
    provider: 'wikipedia', retrievedAt: new Date().toISOString(),
    note: 'Wikipedia is background knowledge, not live data (no current prices/news).',
    results: (j.query?.search ?? []).map((x: any) => ({ title: String(x.title), url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(x.title).replace(/ /g, '_'))}`, snippet: decode(String(x.snippet ?? '')) })),
  };
}

export function searchConfigured() { return !!(config.searxngUrl || config.searchApiKey); }
const detectWikiLang = (q: string) => (/[ऀ-ॿ]/.test(q) ? 'mr' : 'en');

/**
 * Free search chain: SearXNG (if set) > Tavily (if key) > Google News RSS (news-like queries) > Wikipedia.
 * The returned `provider`/`note` tell the model (and user) how fresh/complete the data is.
 */
export async function searchWeb(query: string, opts: { news?: boolean; signal?: AbortSignal } = {}): Promise<SearchOutput> {
  const errs: string[] = [];
  const tries: (() => Promise<SearchOutput>)[] = [];
  if (config.searxngUrl) tries.push(() => searxng(query, opts.signal));
  if (config.searchApiKey) tries.push(() => tavily(query, !!opts.news, opts.signal));
  const newsLike = opts.news || /(news|latest|today|price|rate|rates|भाव|बाजार|बातम्या|खबर|आज|ताजा|मंडी|mandi|bhav)/i.test(query);
  if (newsLike) tries.push(() => newsRss(query, opts.signal));
  tries.push(() => wikipedia(query, opts.signal, detectWikiLang(query)));
  for (const t of tries) {
    try { const r = await t(); if (r.results.length) return r; } catch (e) { errs.push(e instanceof Error ? e.message : 'err'); }
  }
  throw new Error('search unavailable');
}

import { db } from '../database/db.js';
import type { ToolDef } from '../ai/types.js';
import { calculate } from './calc.js';
import { searchWeb, type SearchResult } from './search.js';

export interface ToolContext {
  userId: number; timezone: string;
  location?: { lat: number; lon: number; name?: string };
  sources: { title: string; url: string }[];
  signal?: AbortSignal;
}

const str = { type: 'string' };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

/** Tools executed on the server (they return real data to the model). */
export const SERVER_TOOLS: ToolDef[] = [
  { name: 'searchWeb', description: 'Search the web for CURRENT information (prices, news, market rates, medicine info). Always use for anything time-sensitive.', parameters: obj({ query: str }, ['query']) },
  { name: 'getNews', description: 'Get recent news headlines about a topic.', parameters: obj({ topic: str }, ['topic']) },
  { name: 'getWeather', description: 'Get current weather and forecast. Provide a city name, or omit to use the device location if shared.', parameters: obj({ city: str, days: { type: 'number' } }) },
  { name: 'getTime', description: 'Get the current date and time (optionally for an IANA timezone).', parameters: obj({ timezone: str }) },
  { name: 'calculate', description: 'Evaluate an arithmetic expression exactly. E.g. "25000*18/100". Use for ALL maths.', parameters: obj({ expression: str }, ['expression']) },
  { name: 'searchProducts', description: 'Look up products in the Kore Krushi Seva Kendra shop catalogue (availability comes ONLY from this tool).', parameters: obj({ query: str, category: str }) },
];

/** Tools that act on the user's phone. The server cannot run them: they become confirmation cards in the app. */
export const CLIENT_TOOLS: ToolDef[] = [
  { name: 'createReminder', description: 'Create a reminder notification at a specific time.', parameters: obj({ title: str, whenIso: { type: 'string', description: 'Local ISO 8601 datetime, resolved from the current time' } }, ['title', 'whenIso']) },
  { name: 'createCalendarEvent', description: 'Add a calendar event.', parameters: obj({ title: str, startIso: str, endIso: str, notes: str }, ['title', 'startIso']) },
  { name: 'createNote', description: 'Save a note in the app.', parameters: obj({ text: str }, ['text']) },
  { name: 'openApp', description: 'Open an app: phone, whatsapp, safari, maps, settings, photos, calendar, clock, shortcuts, messages, reminders.', parameters: obj({ app: str }, ['app']) },
  { name: 'makePhoneCall', description: 'Call a contact by name or number. Requires user confirmation.', parameters: obj({ contact: str }, ['contact']) },
  { name: 'sendMessage', description: 'Prepare a WhatsApp/SMS message to a contact. Requires user confirmation; the user presses Send.', parameters: obj({ contact: str, text: str, channel: { type: 'string', enum: ['whatsapp', 'sms'] } }, ['contact', 'text']) },
  { name: 'setAlarm', description: 'Set an alarm (iOS cannot do this directly; the app opens Clock).', parameters: obj({ timeIso: str, label: str }, ['timeIso']) },
  { name: 'cameraScan', description: 'Open the crop photo scanner so the user can photograph a plant for disease/pest analysis.', parameters: obj({}) },
];
export const CLIENT_TOOL_NAMES = new Set(CLIENT_TOOLS.map((t) => t.name));

const WMO = (c: number) => c === 0 ? 'clear' : c <= 3 ? 'partly cloudy' : c <= 48 ? 'fog' : c <= 57 ? 'drizzle' : c <= 67 ? 'rain' : c <= 77 ? 'snow' : c <= 82 ? 'rain showers' : 'thunderstorm';

async function weather(args: any, ctx: ToolContext) {
  let { lat, lon } = ctx.location ?? {} as { lat?: number; lon?: number };
  let place = ctx.location?.name ?? 'device location';
  if (args.city) {
    const g: any = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(args.city)}&count=1`, { signal: ctx.signal })).json();
    const r = g.results?.[0];
    if (!r) return { error: `City "${args.city}" not found` };
    lat = r.latitude; lon = r.longitude; place = [r.name, r.admin1].filter(Boolean).join(', ');
  }
  if (lat == null || lon == null) return { error: 'No location. Ask the user for a city name.' };
  const days = Math.min(Math.max(Number(args.days) || 3, 1), 7);
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=${days}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,weather_code`;
  const j: any = await (await fetch(u, { signal: ctx.signal })).json();
  if (!j.current) return { error: 'Weather service returned no data' };
  return {
    place, source: 'Open-Meteo', observedAt: j.current.time,
    current: { tempC: j.current.temperature_2m, humidityPct: j.current.relative_humidity_2m, windKmh: j.current.wind_speed_10m, condition: WMO(j.current.weather_code) },
    daily: j.daily.time.map((d: string, i: number) => ({ date: d, maxC: j.daily.temperature_2m_max[i], minC: j.daily.temperature_2m_min[i], rainChancePct: j.daily.precipitation_probability_max[i], rainMm: j.daily.precipitation_sum[i], condition: WMO(j.daily.weather_code[i]) })),
  };
}

function summarize(r: Awaited<ReturnType<typeof searchWeb>>, ctx: ToolContext) {
  r.results.forEach((x: SearchResult) => { if (!ctx.sources.find((s) => s.url === x.url)) ctx.sources.push({ title: x.title, url: x.url }); });
  return { retrievedAt: r.retrievedAt, answer: r.answer, results: r.results.map((x) => ({ title: x.title, url: x.url, published: x.published, snippet: x.snippet })) };
}

export function searchProducts(query = '', category = '') {
  const like = `%${query.trim()}%`;
  return db.prepare(
    `SELECT p.id, p.name, COALESCE(c.name,'') AS category, p.description, p.unit, p.price, p.in_stock AS inStock, p.stock_qty AS stockQty, p.updated_at AS updatedAt
     FROM products p LEFT JOIN categories c ON c.id=p.category_id
     WHERE (p.name LIKE ? OR p.description LIKE ? OR c.name LIKE ?) AND (?='' OR c.name LIKE ?)
     ORDER BY p.name LIMIT 30`,
  ).all(like, like, like, category, `%${category}%`).map((r: any) => ({ ...r, inStock: !!r.inStock }));
}

/** Runs a server tool. Always returns JSON-serialisable data; failures become {error} so the model reports them honestly. */
export async function runServerTool(name: string, args: Record<string, any>, ctx: ToolContext): Promise<unknown> {
  const t0 = Date.now(); let ok = true;
  try {
    switch (name) {
      case 'searchWeb': return summarize(await searchWeb(String(args.query ?? ''), { signal: ctx.signal }), ctx);
      case 'getNews': return summarize(await searchWeb(String(args.topic ?? ''), { news: true, signal: ctx.signal }), ctx);
      case 'getWeather': return await weather(args, ctx);
      case 'getTime': {
        const tz = args.timezone || ctx.timezone || 'UTC';
        try { return { now: new Date().toLocaleString('en-IN', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }), timezone: tz, iso: new Date().toISOString() }; }
        catch { return { error: 'Unknown timezone' }; }
      }
      case 'calculate': return { expression: args.expression, result: calculate(String(args.expression ?? '')) };
      case 'searchProducts': return { source: 'shop database', products: searchProducts(args.query, args.category) };
      default: ok = false; return { error: `Unknown tool ${name}` };
    }
  } catch (e) {
    ok = false;
    return { error: e instanceof Error && /not configured/.test(e.message) ? 'This tool is not configured on the server.' : 'Tool failed.' };
  } finally {
    db.prepare('INSERT INTO tool_logs(user_id,tool,ok,ms) VALUES (?,?,?,?)').run(ctx.userId, name, ok ? 1 : 0, Date.now() - t0);
  }
}

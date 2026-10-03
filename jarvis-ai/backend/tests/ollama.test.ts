import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

// ---- fake Ollama server ----
let tagsModels = [{ name: 'qwen2.5:3b', size: 2e9 }, { name: 'nomic-embed-text', size: 3e8 }];
let nativeTools = true;
const chatLog: any[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: tagsModels }));
    if (req.url === '/api/version') return res.end(JSON.stringify({ version: '9.9.9' }));
    if (req.url === '/api/chat') {
      const j = JSON.parse(body); chatLog.push(j);
      const last = j.messages[j.messages.length - 1];
      if (j.tools && !nativeTools) { res.statusCode = 400; return res.end(JSON.stringify({ error: `registry.ollama.ai/${j.model} does not support tools` })); }
      const askedCalc = j.messages.some((m: any) => m.role === 'user' && /25000/.test(m.content) && !/tool result/.test(m.content));
      const haveResult = last.role === 'tool' || (last.role === 'user' && /\[tool result/.test(last.content));
      if (askedCalc && !haveResult) {
        if (nativeTools) return res.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'calculate', arguments: { expression: '25000*18/100' } } }] } }));
        return res.end(JSON.stringify({ message: { role: 'assistant', content: '<tool_call>{"name":"calculate","arguments":{"expression":"25000*18/100"}}</tool_call>' } }));
      }
      if (haveResult) return res.end(JSON.stringify({ message: { role: 'assistant', content: `The answer is ${/4500/.test(last.content) ? '4500' : 'unknown'}.` } }));
      return res.end(JSON.stringify({ message: { role: 'assistant', content: 'Hello, I am JARVIS.' } }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
const fakePort = (fake.address() as any).port;

process.env.JWT_SECRET = 'y'.repeat(40);
process.env.APP_ACCESS_CODE = 'ollama-test-code';
process.env.DATABASE_PATH = ':memory:';
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${fakePort}`;
process.env.AI_PROVIDER = 'ollama';
process.env.AI_API_KEY = '';
process.env.AI_MODEL = '';

const { buildApp } = await import('../src/app.js');
const { cachedOllama } = await import('../src/ai/index.js');

describe('local AI (Ollama) flow — no API key anywhere', () => {
  let server: http.Server; let base = ''; let token = '';
  beforeAll(async () => {
    await new Promise<void>((r) => { server = buildApp().listen(0, () => r()); });
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    token = ((await (await fetch(base + '/api/auth/device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessCode: 'ollama-test-code', deviceId: 'device-ollama-1' }) })).json()) as any).token;
  });
  afterAll(() => { server.close(); fake.close(); });
  const get = (p: string) => fetch(base + p, { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json() as Promise<any>);
  const chat = (q: string) => fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ messages: [{ role: 'user', content: q }], language: 'en' }) });

  it('detects Ollama, lists chat models (not embeddings) and auto-picks the preferred lightweight one', async () => {
    const s = await get('/api/ai/status');
    expect(s.connected).toBe(true);
    expect(s.ollama).toMatchObject({ running: true, version: '9.9.9', hint: null });
    expect(s.ollama.models.map((m: any) => m.name)).toEqual(['qwen2.5:3b']);
    expect(s.selected).toMatchObject({ provider: 'ollama', model: 'qwen2.5:3b' });
    expect(s.cloud).toMatchObject({ openai: false, anthropic: false });
  });

  it('plain chat works and sends NO tools for a message that needs none', async () => {
    chatLog.length = 0;
    const r = await chat('hello there');
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).reply).toBe('Hello, I am JARVIS.');
    expect(chatLog[0].tools).toBeUndefined();
  });

  it('native tool calling: calculate tool runs on the server and the model answers from the result', async () => {
    const r = await (await chat('What is 25000 * 18 / 100?')).json() as any;
    expect(r.reply).toBe('The answer is 4500.');
    expect(r.toolEvents[0]).toMatchObject({ tool: 'calculate', status: 'done' });
  });

  it('models without native tool support still work through prompt-based tools', async () => {
    nativeTools = false;
    chatLog.length = 0;
    const r = await (await chat('What is 25000 * 18 / 100 please?')).json() as any;
    expect(r.reply).toBe('The answer is 4500.');
    expect(r.toolEvents[0]).toMatchObject({ tool: 'calculate', status: 'done' });
    expect(chatLog.some((c) => c.messages[0].content.includes('<tool_call>'))).toBe(true);
    nativeTools = true;
  });

  it('phone actions are only proposed for confirmation, never executed', async () => {
    // fake model replies plain text here; verifying the route does not claim anything was done
    const r = await (await chat('hello again')).json() as any;
    expect(r.actions).toEqual([]);
  });

  it('crop analysis says vision is unavailable when no vision model is installed (no fake analysis)', async () => {
    const r = await fetch(base + '/api/agri/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ imageBase64: 'A'.repeat(200), mimeType: 'image/jpeg', language: 'mr' }) });
    expect(r.status).toBe(501);
    expect(((await r.json()) as any).error).toBe('vision_unavailable');
  });

  it('reports a helpful state when Ollama is running but has no model', async () => {
    tagsModels = []; await cachedOllama(true);
    const s = await get('/api/ai/status');
    expect(s.connected).toBe(false);
    expect(s.ollama.hint).toBe('no_model');
    const r = await chat('hello');
    expect(r.status).toBe(503);
    tagsModels = [{ name: 'qwen2.5:3b', size: 2e9 }]; await cachedOllama(true);
  });

  it('reports Ollama not reachable when the server is down', async () => {
    fake.close(); fake.closeAllConnections?.();
    await cachedOllama(true);
    const s = await get('/api/ai/status');
    expect(s.connected).toBe(false);
    expect(s.ollama.running).toBe(false);
    expect((await chat('hello')).status).toBe(503);
  });
});

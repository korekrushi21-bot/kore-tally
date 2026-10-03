// Live end-to-end check against your real local Ollama model (backend must be running).
//   node tests/live-ollama.mjs            # all questions
//   node tests/live-ollama.mjs "your question" [mr|hi|en]
import fs from 'node:fs';

const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/\s+#.*$/, '').trim()]; }));
const base = process.env.JARVIS_URL ?? `http://localhost:${env.PORT || 8787}`;

const { token } = await (await fetch(`${base}/api/auth/device`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessCode: env.APP_ACCESS_CODE, deviceId: 'live-test-device' }) })).json();
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
const st = await (await fetch(`${base}/api/ai/status`, { headers: H })).json();
console.log(`AI status: connected=${st.connected} model=${st.selected?.model} ollama.running=${st.ollama.running}`);

async function ask(q, language = 'en') {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: H, signal: AbortSignal.timeout(280000), body: JSON.stringify({ messages: [{ role: 'user', content: q }], language, assistantName: 'JARVIS', timezone: 'Asia/Kolkata' }) });
    const j = await r.json();
    console.log(`Q: ${q}   [${Math.round((Date.now() - t0) / 1000)}s, HTTP ${r.status}]`);
    console.log(`A: ${j.reply ?? JSON.stringify(j)}`);
    console.log(`tools: ${(j.toolEvents ?? []).map((t) => `${t.tool}:${t.status}${t.summary ? ' (' + t.summary + ')' : ''}`).join(', ')}`);
    console.log(`actions: ${(j.actions ?? []).map((a) => `${a.tool} ${JSON.stringify(a.args)}`).join(' | ')}\n`);
  } catch (e) { console.log(`Q: ${q}  FAILED: ${e.message}\n`); }
}

if (process.argv[2]) await ask(process.argv[2], process.argv[3]);
else {
  await ask('Remind me tomorrow at 8 am to call Dad.', 'en');
  await ask('आज सोलापूरमध्ये हवामान कसं आहे?', 'mr');
}

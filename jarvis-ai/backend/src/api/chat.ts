import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { cachedOllama, cloudConfigured, getProvider, primaryProvider, resolveAi } from '../ai/index.js';
import { config } from '../config.js';
import { systemPrompt } from '../ai/prompts.js';
import type { ChatMsg } from '../ai/types.js';
import { CLIENT_TOOL_NAMES, runServerTool, selectTools, type ToolContext } from '../tools/index.js';
import { allowedRoots } from '../tools/pc.js';
import { db } from '../database/db.js';

export const chatRouter = Router();

const Body = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).min(1).max(30),
  language: z.string().max(8).default('auto'),
  assistantName: z.string().max(40).default('JARVIS'),
  memories: z.array(z.string().max(500)).max(50).default([]),
  location: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), name: z.string().max(100).optional() }).optional(),
  provider: z.string().max(20).optional(),
  model: z.string().max(80).optional(),
  timezone: z.string().max(60).default('Asia/Kolkata'),
});

const MAX_STEPS = 5;
const SUMMARY: Record<string, (a: any) => string> = {
  createReminder: (a) => `Set reminder “${a.title}” for ${a.whenIso}?`,
  createCalendarEvent: (a) => `Add “${a.title}” to calendar at ${a.startIso}?`,
  createNote: (a) => `Save note: “${String(a.text).slice(0, 60)}”?`,
  openApp: (a) => `Open ${a.app}?`,
  makePhoneCall: (a) => `Call ${a.contact}?`,
  sendMessage: (a) => `Send ${a.channel === 'sms' ? 'SMS' : 'WhatsApp message'} to ${a.contact}: “${String(a.text).slice(0, 80)}”?`,
  setAlarm: (a) => `Set alarm for ${a.timeIso}?`,
  cameraScan: () => 'Open the crop scanner?',
};
const SENSITIVE = new Set(['makePhoneCall', 'sendMessage']);

chatRouter.post('/chat', async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'bad_request' });
  const b = parsed.data;
  const lastForLang = [...b.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const r0 = await resolveAi({ provider: b.provider, model: b.model, devanagari: /[\u0900-\u097F]/.test(lastForLang) || b.language === 'mr' || b.language === 'hi' });
  if (!r0.ok) return res.status(503).json({ error: 'ai_not_configured', reason: r0.reason });
  const { provider, model } = r0;

  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); }); // client cancelled
  const ctx: ToolContext = { userId: req.userId!, timezone: b.timezone, location: b.location, sources: [], signal: ctrl.signal, pcAllowed: false };
  const ai = getProvider(provider);
  const lastUserText = [...b.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  // Read-only PC tools: only for requests that come from this PC itself (not via a tunnel/proxy) and only with local AI,
  // so file contents never leave the machine.
  const viaProxy = !!req.headers['x-forwarded-for'] || !!req.headers['forwarded'];
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
  const pcAllowed = config.pcReadEnabled && provider === 'ollama' && loopback && !viaProxy && allowedRoots().length > 0;
  const tools = selectTools(lastUserText, pcAllowed);
  ctx.pcAllowed = pcAllowed;
  const sys = systemPrompt({ name: b.assistantName, language: b.language, memories: b.memories, timezone: b.timezone, hasLocation: !!b.location, toolNames: tools.map((t) => t.name) });
  const msgs: ChatMsg[] = b.messages.map((m) => (m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content }));
  const toolEvents: { tool: string; status: 'done' | 'error'; summary: string }[] = [];
  const actions: any[] = [];

  try {
    let text = '';
    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await ai.complete({ system: sys, messages: msgs, tools, model, maxTokens: 220, signal: ctrl.signal }); // voice replies are short
      text = r.text;
      if (!r.toolCalls.length) break;
      msgs.push({ role: 'assistant', content: r.text, toolCalls: r.toolCalls });
      for (const tc of r.toolCalls) {
        if (CLIENT_TOOL_NAMES.has(tc.name)) {
          actions.push({ id: crypto.randomUUID(), tool: tc.name, args: tc.args, summary: SUMMARY[tc.name]?.(tc.args) ?? tc.name, requiresConfirmation: true });
          msgs.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: JSON.stringify({ status: 'proposed', note: 'Shown to the user for confirmation. NOT executed yet. Do not claim it is done.' }) });
          if (SENSITIVE.has(tc.name)) toolEvents.push({ tool: tc.name, status: 'done', summary: 'awaiting your confirmation' });
        } else {
          const out: any = await runServerTool(tc.name, tc.args, ctx);
          toolEvents.push({ tool: tc.name, status: out?.error ? 'error' : 'done', summary: out?.error ?? '' });
          msgs.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: JSON.stringify(out).slice(0, 12000) });
        }
      }
      if (step === MAX_STEPS - 1) text = text || 'I could not finish that request.';
    }
    if (!text.trim()) text = actions.length ? 'Please confirm the action below.' : 'Sorry, I could not produce an answer.';
    res.json({ reply: text, sources: ctx.sources.slice(0, 6), toolEvents, actions, language: b.language });
  } catch (e) {
    if (ctrl.signal.aborted) return; // client went away
    console.error('chat error:', e instanceof Error ? e.message : 'unknown'); // never log user content
    res.status(502).json({ error: 'ai_unavailable' });
  }
});

chatRouter.get('/health', async (_req, res) => {
  const r = await resolveAi();
  res.json({ ok: true, aiReady: r.ok, provider: r.ok ? r.provider : primaryProvider(), model: r.ok ? r.model : null });
});

/** AI status for Settings and "Test AI connection": Ollama installed/running/models + optional cloud flags. */
chatRouter.get('/ai/status', async (_req, res) => {
  const ollama = await cachedOllama(true);
  const r = await resolveAi();
  const hint = ollama.running
    ? (ollama.models.length ? null : 'no_model')
    : ollama.installed ? 'not_running' : ollama.installed === false ? 'not_installed' : 'unreachable';
  res.json({
    provider: primaryProvider(), selected: r.ok ? { provider: r.provider, model: r.model, fallback: r.usedFallback } : null,
    connected: r.ok,
    ollama: { baseUrl: ollama.baseUrl, installed: ollama.installed, running: ollama.running, version: ollama.version ?? null, models: ollama.models, hint },
    cloud: { openai: cloudConfigured('openai'), anthropic: cloudConfigured('anthropic'), custom: cloudConfigured('custom'), fallback: config.fallbackProvider || null },
    search: { searxng: !!config.searxngUrl, tavily: !!config.searchApiKey },
  });
});

chatRouter.get('/announcements', (_req, res) => {
  res.json({ items: db.prepare('SELECT id,title,body FROM announcements WHERE active=1 ORDER BY id DESC LIMIT 5').all() });
});

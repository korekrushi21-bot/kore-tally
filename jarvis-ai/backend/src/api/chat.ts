import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { activeConfig, getProvider, providerConfigured } from '../ai/index.js';
import { systemPrompt } from '../ai/prompts.js';
import type { ChatMsg } from '../ai/types.js';
import { CLIENT_TOOL_NAMES, CLIENT_TOOLS, SERVER_TOOLS, runServerTool, type ToolContext } from '../tools/index.js';
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
  const { provider, model } = activeConfig({ provider: b.provider, model: b.model });
  if (!providerConfigured(provider)) return res.status(503).json({ error: 'ai_not_configured' });

  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); }); // client cancelled
  const ctx: ToolContext = { userId: req.userId!, timezone: b.timezone, location: b.location, sources: [], signal: ctrl.signal };
  const ai = getProvider(provider);
  const sys = systemPrompt({ name: b.assistantName, language: b.language, memories: b.memories, timezone: b.timezone, hasLocation: !!b.location });
  const msgs: ChatMsg[] = b.messages.map((m) => (m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content }));
  const toolEvents: { tool: string; status: 'done' | 'error'; summary: string }[] = [];
  const actions: any[] = [];

  try {
    let text = '';
    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await ai.complete({ system: sys, messages: msgs, tools: [...SERVER_TOOLS, ...CLIENT_TOOLS], model, signal: ctrl.signal });
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

chatRouter.get('/health', (_req, res) => {
  const { provider, model } = activeConfig();
  res.json({ ok: true, provider, model, aiConfigured: providerConfigured(provider) });
});

chatRouter.get('/announcements', (_req, res) => {
  res.json({ items: db.prepare('SELECT id,title,body FROM announcements WHERE active=1 ORDER BY id DESC LIMIT 5').all() });
});

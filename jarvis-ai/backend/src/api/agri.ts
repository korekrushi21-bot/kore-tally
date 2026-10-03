import { Router } from 'express';
import { z } from 'zod';
import { activeConfig, getProvider, providerConfigured } from '../ai/index.js';
import { agriPrompt } from '../ai/prompts.js';
import { config } from '../config.js';
import { db } from '../database/db.js';
import { searchWeb } from '../tools/search.js';

export const agriRouter = Router();

const Body = z.object({
  imageBase64: z.string().min(100).max(7_000_000),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  language: z.string().max(8).default('mr'),
  note: z.string().max(500).optional(),
});

const KINDS = ['crop', 'disease', 'pest', 'weed', 'deficiency', 'healthy', 'unclear'];
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).slice(0, 8) : []);

agriRouter.post('/agri/analyze', async (req, res) => {
  const p = Body.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'bad_request' });
  const { provider, model } = activeConfig();
  if (!providerConfigured(provider)) return res.status(503).json({ error: 'ai_not_configured' });
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

  const notes = (db.prepare('SELECT title, body FROM agri_notes ORDER BY id DESC LIMIT 10').all() as { title: string; body: string }[]).map((n) => `${n.title}: ${n.body}`.slice(0, 500));
  try {
    const r = await getProvider(provider).complete({
      system: agriPrompt(p.data.language, notes), model: config.visionModel || model, maxTokens: 1200, signal: ctrl.signal,
      json: provider !== 'anthropic',
      messages: [{ role: 'user', content: `Analyse this plant photo.${p.data.note ? ' Farmer note: ' + p.data.note : ''} Respond with JSON only.`, images: [{ base64: p.data.imageBase64, mimeType: p.data.mimeType }] }],
    });
    const json = r.text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('no json');
    const o = JSON.parse(json);
    const result = {
      kind: KINDS.includes(o.kind) ? o.kind : 'unclear',
      cropGuess: String(o.cropGuess ?? ''), finding: String(o.finding ?? ''),
      confidence: ['low', 'medium', 'high'].includes(o.confidence) ? o.confidence : 'low',
      confidencePercent: Math.min(90, Math.max(0, Number(o.confidencePercent) || 0)), // never claim certainty
      symptoms: arr(o.symptoms), possibleCauses: arr(o.possibleCauses), nextSteps: arr(o.nextSteps),
      treatmentNotes: String(o.treatmentNotes ?? ''),
      disclaimer: 'ही प्राथमिक AI ओळख आहे. प्रत्यक्ष शेतातील परिस्थिती आणि तज्ज्ञ सल्ल्याने निर्णय घ्या.',
    };
    db.prepare('INSERT INTO agriculture_scans(user_id,kind,confidence) VALUES (?,?,?)').run(req.userId, result.kind, result.confidence);
    res.json(result);
  } catch (e) {
    if (ctrl.signal.aborted) return;
    console.error('agri error:', e instanceof Error ? e.message : 'unknown');
    res.status(502).json({ error: 'ai_unavailable' });
  }
});

const SearchBody = z.object({ q: z.string().min(2).max(300), language: z.string().max(8).default('auto') });
agriRouter.post('/search', async (req, res) => {
  const p = SearchBody.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'bad_request' });
  try {
    const r = await searchWeb(p.data.q);
    res.json({ summary: r.answer ?? (r.results[0]?.snippet || 'No results found.'), sources: r.results.map((x) => ({ title: x.title, url: x.url })), retrievedAt: r.retrievedAt });
  } catch (e) {
    if (e instanceof Error && /not configured/.test(e.message)) return res.status(503).json({ error: 'search_not_configured' });
    res.status(502).json({ error: 'search_unavailable' });
  }
});

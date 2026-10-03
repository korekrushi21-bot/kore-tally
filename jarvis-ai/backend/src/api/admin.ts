import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAdmin, signAdmin } from '../auth/middleware.js';
import { activeConfig, providerConfigured } from '../ai/index.js';
import { db, getSetting, setSetting, verifyAdmin } from '../database/db.js';

export const adminRouter = Router();

adminRouter.post('/login', rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }), (req, res) => {
  const p = z.object({ username: z.string().max(60), password: z.string().max(200) }).safeParse(req.body);
  if (!p.success || !verifyAdmin(p.data.username, p.data.password)) return res.status(401).json({ error: 'invalid_credentials' });
  res.json({ token: signAdmin(p.data.username) });
});

adminRouter.use(requireAdmin);

const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

adminRouter.get('/stats', (_req, res) => {
  res.json({
    users: n('SELECT COUNT(*) n FROM users'),
    activeLast7d: n("SELECT COUNT(*) n FROM users WHERE last_seen > datetime('now','-7 days')"),
    disabled: n('SELECT COUNT(*) n FROM users WHERE disabled=1'),
    requests: n('SELECT COALESCE(SUM(request_count),0) n FROM users'),
    toolCalls: n('SELECT COUNT(*) n FROM tool_logs'),
    toolFailures: n('SELECT COUNT(*) n FROM tool_logs WHERE ok=0'),
    scans: n('SELECT COUNT(*) n FROM agriculture_scans'),
    products: n('SELECT COUNT(*) n FROM products'),
    note: 'Conversation content is stored only on users’ devices; the server and admins cannot read it.',
  });
});

// ---- users (metadata only) ----
adminRouter.get('/users', (_req, res) => {
  res.json({ users: db.prepare('SELECT id, created_at AS createdAt, last_seen AS lastSeen, disabled, request_count AS requests FROM users ORDER BY last_seen DESC LIMIT 200').all() });
});
adminRouter.post('/users/:id/disabled', (req, res) => {
  const v = z.object({ disabled: z.boolean() }).safeParse(req.body);
  if (!v.success) return res.status(400).json({ error: 'bad_request' });
  db.prepare('UPDATE users SET disabled=? WHERE id=?').run(v.data.disabled ? 1 : 0, Number(req.params.id));
  res.json({ ok: true });
});

// ---- AI configuration (keys are env-only, never exposed) ----
adminRouter.get('/ai', (_req, res) => {
  const a = activeConfig();
  res.json({ ...a, configured: { openai: providerConfigured('openai'), anthropic: providerConfigured('anthropic'), custom: providerConfigured('custom') } });
});
adminRouter.put('/ai', (req, res) => {
  const v = z.object({ provider: z.enum(['openai', 'anthropic', 'custom']), model: z.string().max(80) }).safeParse(req.body);
  if (!v.success) return res.status(400).json({ error: 'bad_request' });
  setSetting('ai.provider', v.data.provider); setSetting('ai.model', v.data.model);
  res.json({ ok: true, current: getSetting('ai.provider') });
});

// ---- announcements ----
adminRouter.get('/announcements', (_req, res) => res.json({ items: db.prepare('SELECT * FROM announcements ORDER BY id DESC').all() }));
adminRouter.post('/announcements', (req, res) => {
  const v = z.object({ title: z.string().min(1).max(120), body: z.string().max(1000) }).safeParse(req.body);
  if (!v.success) return res.status(400).json({ error: 'bad_request' });
  db.prepare('INSERT INTO announcements(title,body) VALUES (?,?)').run(v.data.title, v.data.body);
  res.json({ ok: true });
});
adminRouter.delete('/announcements/:id', (req, res) => { db.prepare('DELETE FROM announcements WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });

// ---- agriculture reference notes ----
adminRouter.get('/agri-notes', (_req, res) => res.json({ items: db.prepare('SELECT * FROM agri_notes ORDER BY id DESC').all() }));
adminRouter.post('/agri-notes', (req, res) => {
  const v = z.object({ title: z.string().min(1).max(120), body: z.string().min(1).max(1000) }).safeParse(req.body);
  if (!v.success) return res.status(400).json({ error: 'bad_request' });
  db.prepare('INSERT INTO agri_notes(title,body) VALUES (?,?)').run(v.data.title, v.data.body);
  res.json({ ok: true });
});
adminRouter.delete('/agri-notes/:id', (req, res) => { db.prepare('DELETE FROM agri_notes WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });

// ---- shop products ----
const Product = z.object({
  name: z.string().min(1).max(160), category: z.string().max(60).default(''), description: z.string().max(1000).default(''),
  unit: z.string().max(40).default(''), price: z.number().nonnegative().nullable().default(null),
  inStock: z.boolean().default(false), stockQty: z.number().int().nonnegative().nullable().default(null),
});
function categoryId(name: string): number | null {
  const t = name.trim(); if (!t) return null;
  db.prepare('INSERT OR IGNORE INTO categories(name) VALUES (?)').run(t);
  return (db.prepare('SELECT id FROM categories WHERE name=?').get(t) as { id: number }).id;
}
adminRouter.get('/products', (_req, res) => {
  res.json({ products: db.prepare(`SELECT p.id,p.name,COALESCE(c.name,'') category,p.description,p.unit,p.price,p.in_stock inStock,p.stock_qty stockQty,p.updated_at updatedAt FROM products p LEFT JOIN categories c ON c.id=p.category_id ORDER BY p.name`).all() });
});
adminRouter.post('/products', (req, res) => {
  const v = Product.safeParse(req.body); if (!v.success) return res.status(400).json({ error: 'bad_request' });
  const d = v.data;
  const r = db.prepare('INSERT INTO products(name,category_id,description,unit,price,in_stock,stock_qty) VALUES (?,?,?,?,?,?,?)').run(d.name, categoryId(d.category), d.description, d.unit, d.price, d.inStock ? 1 : 0, d.stockQty);
  res.json({ ok: true, id: r.lastInsertRowid });
});
adminRouter.put('/products/:id', (req, res) => {
  const v = Product.safeParse(req.body); if (!v.success) return res.status(400).json({ error: 'bad_request' });
  const d = v.data;
  db.prepare("UPDATE products SET name=?,category_id=?,description=?,unit=?,price=?,in_stock=?,stock_qty=?,updated_at=datetime('now') WHERE id=?").run(d.name, categoryId(d.category), d.description, d.unit, d.price, d.inStock ? 1 : 0, d.stockQty, Number(req.params.id));
  res.json({ ok: true });
});
adminRouter.delete('/products/:id', (req, res) => { db.prepare('DELETE FROM products WHERE id=?').run(Number(req.params.id)); res.json({ ok: true }); });

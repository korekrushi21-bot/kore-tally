import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { db } from './database/db.js';
import { requireUser, safeEqual, signUser } from './auth/middleware.js';
import { chatRouter } from './api/chat.js';
import { agriRouter } from './api/agri.js';
import { shopRouter } from './api/shop.js';
import { adminRouter } from './api/admin.js';

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], connectSrc: ["'self'", 'https://api.open-meteo.com', 'https://geocoding-api.open-meteo.com'], imgSrc: ["'self'", 'data:', 'blob:'], fontSrc: ["'self'", 'data:'], mediaSrc: ["'self'", 'blob:'], upgradeInsecureRequests: config.isProd ? [] : null } } }));
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false })); // native app needs no CORS
  app.use(express.json({ limit: '9mb' })); // compressed crop photos as base64
  // HTTPS only in production (behind a TLS-terminating proxy)
  if (config.isProd) app.use((req, res, next) => (req.secure ? next() : res.status(426).json({ error: 'https_required' })));

  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const heavy = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => (req.userId ? 'u' + req.userId : ipKeyGenerator(req.ip ?? '')) });

  app.post('/api/auth/device', rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }), (req, res) => {
    const p = z.object({ accessCode: z.string().max(200), deviceId: z.string().min(8).max(80) }).safeParse(req.body);
    if (!p.success || !config.accessCode || !safeEqual(p.data.accessCode, config.accessCode)) return res.status(401).json({ error: 'unauthorized' });
    db.prepare('INSERT OR IGNORE INTO users(device_id) VALUES (?)').run(p.data.deviceId);
    const u = db.prepare('SELECT id, disabled FROM users WHERE device_id=?').get(p.data.deviceId) as { id: number; disabled: number };
    if (u.disabled) return res.status(403).json({ error: 'forbidden' });
    res.json({ token: signUser(u.id), expiresIn: 30 * 86400 });
  });

  app.use('/api', limiter, requireUser);
  app.use('/api/chat', heavy);
  app.use('/api/agri', heavy);
  app.use('/api', chatRouter);
  app.use('/api', agriRouter);
  app.use('/api', shopRouter);

  app.use('/admin/api', adminRouter);
  app.use('/admin', express.static(path.resolve('public'), { index: 'admin.html' }));

  // Desktop app: the Expo web build (see scripts/build-desktop.ps1) is served from ./web at the site root.
  const webDir = path.resolve('web');
  if (fs.existsSync(path.join(webDir, 'index.html'))) {
    app.use(express.static(webDir));
    app.get(/^\/(?!api\/|admin).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
  }

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('unhandled:', err instanceof Error ? err.message : 'unknown');
    res.status(500).json({ error: 'server_error' });
  });
  return app;
}

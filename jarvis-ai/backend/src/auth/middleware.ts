import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../database/db.js';

export interface UserClaims { sub: number; role: 'user' }
export interface AdminClaims { sub: string; role: 'admin' }

declare module 'express-serve-static-core' {
  interface Request { userId?: number; admin?: string }
}

export const safeEqual = (a: string, b: string) => {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

export const signUser = (id: number) => jwt.sign({ sub: id, role: 'user' } satisfies UserClaims, config.jwtSecret, { expiresIn: '30d' });
export const signAdmin = (u: string) => jwt.sign({ sub: u, role: 'admin' } satisfies AdminClaims, config.jwtSecret, { expiresIn: '2h' });

function bearer(req: Request) {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : '';
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  try {
    const c = jwt.verify(bearer(req), config.jwtSecret) as Partial<UserClaims>;
    if (c.role !== 'user' || typeof c.sub !== 'number') throw new Error('role');
    const u = db.prepare('SELECT disabled FROM users WHERE id=?').get(c.sub) as { disabled: number } | undefined;
    if (!u || u.disabled) return res.status(403).json({ error: 'forbidden' });
    db.prepare("UPDATE users SET last_seen=datetime('now'), request_count=request_count+1 WHERE id=?").run(c.sub);
    req.userId = c.sub;
    next();
  } catch { res.status(401).json({ error: 'unauthorized' }); }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const c = jwt.verify(bearer(req), config.jwtSecret) as Partial<AdminClaims>;
    if (c.role !== 'admin' || typeof c.sub !== 'string') throw new Error('role');
    req.admin = c.sub;
    next();
  } catch { res.status(401).json({ error: 'unauthorized' }); }
}

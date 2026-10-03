import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { SCHEMA } from './schema.js';

export function openDb(file = config.dbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export const db = openDb();

export function seedAdmin() {
  if (!config.adminPasswordHash) return;
  const row = db.prepare('SELECT 1 FROM authorized_admins WHERE username=?').get(config.adminUsername);
  if (!row) db.prepare('INSERT INTO authorized_admins(username,password_hash) VALUES (?,?)').run(config.adminUsername, config.adminPasswordHash);
  else db.prepare('UPDATE authorized_admins SET password_hash=? WHERE username=?').run(config.adminPasswordHash, config.adminUsername);
}

export const getSetting = (key: string): string | undefined =>
  (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
export const setSetting = (key: string, value: string) =>
  db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);

export const verifyAdmin = (u: string, p: string) => {
  const row = db.prepare('SELECT password_hash FROM authorized_admins WHERE username=?').get(u) as { password_hash: string } | undefined;
  // compare against a dummy hash when the user is unknown to keep timing similar
  const hash = row?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  return bcrypt.compareSync(p, hash) && !!row;
};

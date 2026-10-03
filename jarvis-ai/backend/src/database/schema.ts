/**
 * Server-side schema (SQLite). Conversations, messages, memories, tasks, reminders and personal settings
 * live ON THE DEVICE by design (privacy: the server — and therefore admins — never see them).
 * The server stores only account/usage metadata, shop data and non-content logs.
 * See docs/DATABASE.md for the full logical model including the on-device collections.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL UNIQUE,          -- random per-install id, no PII
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (            -- server-wide key/value (AI config overrides etc.)
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_logs (           -- metadata only: NO arguments, NO user content
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, tool TEXT NOT NULL, ok INTEGER NOT NULL, ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agriculture_scans (   -- metadata only: image is never stored
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, kind TEXT, confidence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agri_notes (          -- admin-managed reference info injected into agri prompts
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS authorized_admins (
  username TEXT PRIMARY KEY, password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  description TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  price REAL,                                     -- NULL = unknown
  in_stock INTEGER NOT NULL DEFAULT 0,
  stock_qty INTEGER,                              -- NULL = unknown
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id);

CREATE TABLE IF NOT EXISTS shop_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL      -- e.g. shop_name, phone, address
);
INSERT OR IGNORE INTO shop_settings(key,value) VALUES ('shop_name','Kore Krushi Seva Kendra');
`;

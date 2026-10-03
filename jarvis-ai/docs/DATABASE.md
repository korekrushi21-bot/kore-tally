# Database schema

Privacy rule: personal content stays **on the phone**. The server (and admins) store only what is needed to run the service.

## Server (SQLite) — `backend/src/database/schema.ts`
| Table | Purpose | Notable columns |
|---|---|---|
| users | one row per app install (no PII) | device_id, last_seen, disabled, request_count |
| settings | server-wide AI config override | key, value |
| tool_logs | usage/failure metadata, **no arguments or content** | user_id, tool, ok, ms |
| agriculture_scans | scan metadata only, **image never stored** | kind, confidence |
| agri_notes | admin-curated reference notes fed into agri prompts | title, body |
| announcements | admin messages shown to users | title, body, active |
| authorized_admins | admin accounts | username, bcrypt password_hash |
| categories / products | Kore Krushi catalogue | price & stock_qty NULL = unknown |
| shop_settings | shop name, phone, address | key, value |

## On device (AsyncStorage / Keychain) — `mobile/src/storage`
| Collection | Contents |
|---|---|
| settings | language, voice, speed, theme, wake word, backend URL … |
| conversations (+ messages) | last 100 conversations, 60 messages each, incl. tool events/sources |
| memories | only text the user explicitly saved |
| tasks / reminders | tasks with due date + scheduled notification id |
| notes | free-text notes |
| Keychain (`expo-secure-store`) | JWT, access code, device id |

The spec’s `users, conversations, messages, memories, tasks, reminders, settings, tool_logs, agriculture_scans` collections therefore map as: server = users, settings, tool_logs, agriculture_scans; device = conversations, messages, memories, tasks, reminders, settings. This is deliberate so admins cannot read private content.

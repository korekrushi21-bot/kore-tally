# JARVIS AI — personal voice assistant (Android phone + desktop)

Original branding/UI. One React Native (Expo, TypeScript) codebase gives an **Android app** and a **desktop web app** (Chrome/Edge, installable as a desktop app), plus a secure Node backend. Marathi · Hindi · English.
The app name is configurable: `mobile/app.json → expo.extra.appName` (users also rename the assistant in Settings).

```
jarvis-ai/
├─ mobile/                 Expo app (no API keys inside)
│  └─ src/ components · screens · navigation · hooks · config · types · utils · storage
│     └─ services/ ai · speech · tts · weather · agriculture · phone · calendar · tools
└─ backend/                Express + SQLite, holds all keys
   ├─ src/ api · ai (OpenAI / Anthropic / Custom providers) · tools · auth · database
   ├─ public/ admin panel (/admin)
   └─ tests/
```
Architecture: `Android app / desktop web app → HTTPS → your backend (JWT) → AI provider / Tavily search / Open-Meteo`.

## What works vs. what is honest-limited

| Area | Status |
|---|---|
| Home core (idle/listening/thinking/speaking animations, waveform, status), typed input, chat, history | ✅ Implemented |
| STT Marathi/Hindi/English with “recognized text” preview (3 s auto-send, editable) | ✅ via `expo-speech-recognition` (Android recognizer / Web Speech). **Phone needs a dev build, not Expo Go** |
| TTS with voice, speed, volume, on/off | ✅ on-device system voices (`expo-speech`). Cloud TTS: **Requires integration** (`TTS_API_KEY` reserved) |
| Wake word “Hey JARVIS” | ⚠️ **Foreground only** (app or browser tab open). Always-on background wake word would need a native Android foreground service plus an on-device wake-word engine (e.g. Porcupine): **Requires integration**, not built. Alternatives: mic button, `jarvisai://listen` shortcut/routine, widget (**Requires integration**) |
| AI chat + tool calling (OpenAI / Anthropic / custom OpenAI-compatible) | ✅ server-side tool loop |
| Web search + news (sources shown, retrieval time) | ✅ Tavily (needs `SEARCH_API_KEY`) |
| Weather (current, hourly, 7-day, manual city) | ✅ Open-Meteo, free, no key |
| Reminders (local notification), Calendar events, Notes, Tasks | ✅ on-device |
| Call / WhatsApp / SMS | ✅ always behind a Confirm button; message is pre-filled, **you** press Send in the target app |
| Open Phone/WhatsApp/Browser/Maps/Settings/Calendar/Clock/Messages | ✅ public links & intents. No public Camera-app link → in-app camera used |
| Set alarm | ✅ real alarm on Android; reminder on desktop |
| Agriculture photo analysis (compressed upload, confidence ≤ 90 %, mandatory disclaimer, no invented doses) | ✅ needs a vision-capable model |
| Kore Krushi catalogue (DB-backed; unknown price/stock shown as unknown) | ✅ admin-managed |
| Admin panel (users, AI config, products, agri notes, announcements, stats) | ✅ `/admin`; admins cannot see conversations because the server never stores them |
| Streaming token-by-token replies | ❌ Not implemented — replies are returned whole (cancel button works) |
| Offline | ✅ banner; notes/tasks/memory/settings/history work; AI/search fail honestly |

Privacy by design: conversations, memories, notes, tasks live **on the device** (AsyncStorage); credentials in the Android Keystore (`expo-secure-store`). The server stores only device-id accounts, usage counters, tool-call metadata (no arguments), shop data. Location is used transiently, never stored. Photos are never stored.

## 1 · Services & keys

| Service | Why | Get it | Configure | Cost (approx.) |
|---|---|---|---|---|
| OpenAI **or** Anthropic | the AI brain + vision | platform.openai.com / console.anthropic.com | `backend/.env` `AI_API_KEY` / `ANTHROPIC_API_KEY` | pay-per-use, typically ₹0.1–1 per chat turn on small models; photos cost more |
| Tavily | web search & news | tavily.com | `SEARCH_API_KEY` | free tier ~1000 searches/mo, then paid |
| Open-Meteo | weather | none | — | free (non-commercial) |
| Google Play Console (only to publish) | Play Store release | play.google.com/console | EAS submit | US$25 one-time; sideloading the APK is free |
| Hosting with HTTPS | backend | Render / Railway / Fly / a VPS + Caddy | see §6 | ~US$0–7/mo |

## 2 · Backend setup
```bash
cd backend
cp .env.example .env        # fill JWT_SECRET, APP_ACCESS_CODE, AI_API_KEY, SEARCH_API_KEY, ADMIN_*
npm install
npm run hash -- "my admin password"   # paste output into ADMIN_PASSWORD_HASH
npm run dev                 # http://localhost:8787  (admin: /admin)
npm test && npm run typecheck
```
API (all `/api/*` need `Authorization: Bearer <jwt>` except auth):
`POST /api/auth/device` · `GET /api/health` · `POST /api/chat` · `POST /api/agri/analyze` · `POST /api/search` · `GET /api/shop/products` · `GET /api/announcements` · admin: `/admin/api/*`.

## 3 · App setup, run & build
Requires Node 20+. Android builds need Android Studio (local) or EAS cloud builds.
```bash
cd mobile
npm install
```
Set `backendUrl` in `app.json` (or later in the app: Settings → AI). The Android emulator reaches your PC at `http://10.0.2.2:8787` (allowed in dev builds only); real phones need an `https://` URL (deployed server or a tunnel such as Cloudflare Tunnel / ngrok).

**Desktop (Windows/macOS/Linux) — runs in the browser, no native build:**
```bash
npx expo start --web                     # dev at http://localhost:8081
npx expo export --platform web           # static site in dist/ -> host on any HTTPS static host
```
Use Chrome or Edge (Web Speech API for voice input; Firefox/Safari lack it, so type instead). Click the install icon in the address bar to install it as a desktop app. localhost counts as a secure context so the mic works in dev; production must be HTTPS. The backend must allow the site origin: set `CORS_ORIGINS=https://your-web-host`.

**Android phone:**
```bash
npx expo prebuild --platform android      # generates android/ with the permissions in app.json
npx expo run:android                      # emulator or USB-connected phone (USB debugging on)
# or cloud build, no Android Studio:
npm i -g eas-cli && eas login && eas build:configure
eas build --platform android --profile preview      # APK you can sideload
eas build --platform android --profile production   # AAB for Google Play
```
`expo-speech-recognition` is a native module, so **Expo Go will not work on the phone**; use `run:android` or an EAS development build (`--profile development`, then `npx expo start --dev-client`).

### Android permissions (already in `app.json`)
RECORD_AUDIO, CAMERA, location, calendar, contacts, POST_NOTIFICATIONS, SCHEDULE_EXACT_ALARM, SET_ALARM. Runtime permissions are requested only when a feature is first used. Speech recognition needs the Google app / speech service (Marathi/Hindi voice-typing packs can be downloaded for offline use).

### Entry points instead of "always listening"
Deep link `jarvisai://listen` starts listening. Use it from a home-screen shortcut, Tasker / Samsung Routines / Google Assistant routine, or pin the desktop web app.

### Platform differences
| Feature | Android | Desktop web |
|---|---|---|
| Voice in/out | Google speech / system TTS | Chrome/Edge Web Speech |
| Alarm | real alarm via SET_ALARM intent | becomes a reminder (tab must stay open) |
| Reminders | scheduled notifications (even when app closed) | browser notification only while the tab is open |
| Calendar events / Contacts | yes | unavailable (give a phone number instead of a contact name) |
| Call / WhatsApp / SMS | dialer / WhatsApp / SMS app prefilled | `tel:` handler / `wa.me` link |
| Camera scan | in-app camera | file chooser (webcam capture not implemented) |
| Secrets storage | Android Keystore | browser localStorage (weaker) |

## 4 · Testing
- `cd backend && npm test` — calculator (incl. injection attempts), auth, rate-limit-safe flows, admin flow, user disabling, honest “AI not configured”.
- `cd mobile && npx tsc --noEmit && npx expo-doctor && npx expo export --platform android --platform web` — type-check, config check, full Android + web bundle compile (all pass). **The app has not been run on a physical device or emulator yet.**
- Manual checklist on device: mic permission denied → friendly message; airplane mode → “Internet connection unavailable.”; ask “25000 चं 18 टक्के किती?” (uses calculate tool); “उद्या सकाळी 8 वाजता आठवण करून दे” → confirmation card → reminder appears; “राहुलला WhatsApp message पाठव …” → Confirm → WhatsApp opens pre-filled; crop photo → result shows confidence ≤ 90 % + disclaimer.

## 5 · Kore Krushi products
Open `https://<backend>/admin`, sign in, add products (price/stock may be left blank = “unknown”). The assistant reads them only through the `searchProducts` tool and is instructed never to invent availability.

## 6 · Deployment (backend)
1. Any Node 20+ host with persistent disk (SQLite file `DATABASE_PATH`) — Render/Railway/Fly/VPS.
2. `npm ci && npm run build && npm start` with `NODE_ENV=production`; the server refuses non-HTTPS requests in production (terminate TLS at the platform/Caddy/nginx and forward `X-Forwarded-Proto`).
3. Set every env var from `.env.example` in the host’s secret store; never commit `.env`.
4. Back up the SQLite file; rotate `APP_ACCESS_CODE`/`JWT_SECRET` if leaked (all tokens become invalid).
5. Change the Android `package` (`com.example.jarvisai`) in `app.json` before publishing; host the web build over HTTPS and add its origin to `CORS_ORIGINS`.

## 7 · Security notes / known gaps
- Done: no keys in app; HTTPS enforced in app (HTTP only to localhost in dev builds) and in prod server; Keychain storage; JWT user/admin roles, bcrypt admin password, timing-safe access-code check, per-IP/user rate limits, zod validation, helmet+CSP, admin UI uses `textContent` only; tool calls logged without arguments; calls/messages/reminders/events/notes always need an explicit tap (client-enforced, not trusted from server); passwords/PINs/OTP/card text refused for memory.
- Gaps to know about: shared access code = one tier of trust for all your devices (no per-user accounts); no certificate pinning; AsyncStorage data is not encrypted beyond OS app-sandbox protection; image prompt-injection (text inside a photo) is mitigated by prompt rules only; streaming and cloud TTS/STT are not implemented; home-screen widget not implemented; no automated UI tests for the app.

## 8 · Troubleshooting
| Symptom | Fix |
|---|---|
| “Backend is not configured” | Settings → AI: URL must be `https://…`, enter access code |
| “Access code rejected” | Must equal `APP_ACCESS_CODE`; tokens reset on “Save” |
| Mic does nothing in Expo Go (phone) | Build a dev client (§3) |
| Mic blocked on desktop | Use Chrome/Edge over https or localhost; allow the mic via the address-bar lock icon |
| Phone can't reach backend | Needs `https://`; `localhost` means the phone itself; emulator uses `10.0.2.2` |
| Marathi recognized as gibberish | Settings → Language: choose मराठी (Auto can only guess for typed text); download the Marathi voice-typing pack in Google app settings |
| No Marathi TTS voice | Android Settings → Text-to-speech output → install Marathi/Hindi voice data; otherwise the system falls back to a default voice (cloud TTS = Requires integration) |
| Search says unavailable | `SEARCH_API_KEY` missing/invalid |
| Wake word stops | Expected: the OS ends recognition sessions and in background; it restarts while app is foreground |
| `better-sqlite3` install error | Use Node 20/22 LTS; on Windows install build tools if no prebuilt binary |
| WhatsApp doesn’t open | Not installed (desktop uses the wa.me web link) |

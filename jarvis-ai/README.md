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
Architecture: `Android app / desktop web app → HTTPS → your backend (JWT) → Ollama (local AI, default) / optional cloud AI`, plus free weather (Open-Meteo), free news/Wikipedia search, and your own product database.

**Zero mandatory cost:** the default AI is a local open model served by [Ollama](https://ollama.com). No OpenAI/Anthropic key is needed anywhere. Cloud AI exists only as an optional, clearly-labelled extra.

## What works vs. what is honest-limited

| Area | Status |
|---|---|
| Home core (idle/listening/thinking/speaking animations, waveform, status), typed input, chat, history | ✅ Implemented |
| STT Marathi/Hindi/English with “recognized text” preview (3 s auto-send, editable) | ✅ via `expo-speech-recognition` (Android recognizer / Web Speech). **Phone needs a dev build, not Expo Go** |
| TTS with voice, speed, volume, on/off | ✅ on-device system voices (`expo-speech`). Cloud TTS: **Requires integration** (`TTS_API_KEY` reserved) |
| Wake word “Hey JARVIS” | ⚠️ **Foreground only** (app or browser tab open). Always-on background wake word would need a native Android foreground service plus an on-device wake-word engine (e.g. Porcupine): **Requires integration**, not built. Alternatives: mic button, `jarvisai://listen` shortcut/routine, widget (**Requires integration**) |
| AI chat + tool calling | ✅ **Local Ollama by default** (native tools, or prompt-based tools for models without them, e.g. Gemma 3). Optional: OpenAI / Anthropic / custom OpenAI-compatible. Auto-detects Ollama, installed models, and shows setup steps |
| Web search + news (sources shown, retrieval time) | ✅ free chain with no key: Google News RSS (headlines) + Wikipedia (background, **not live**). Real web search: free self-hosted SearXNG, or Tavily free tier (optional). The local model only summarises what was retrieved |
| Weather (current, hourly, 7-day, manual city) | ✅ Open-Meteo, free, no key |
| Reminders (local notification), Calendar events, Notes, Tasks | ✅ on-device |
| Call / WhatsApp / SMS | ✅ always behind a Confirm button; message is pre-filled, **you** press Send in the target app |
| Open Phone/WhatsApp/Browser/Maps/Settings/Calendar/Clock/Messages | ✅ public links & intents. No public Camera-app link → in-app camera used |
| Set alarm | ✅ real alarm on Android; reminder on desktop |
| Agriculture photo analysis (compressed upload, confidence ≤ 90 %, mandatory disclaimer, no invented doses) | ✅ needs a vision-capable model. Local: `ollama pull gemma3:4b` (or `llama3.2-vision`); small local vision models are less accurate than cloud ones. With none installed the app says **“Vision AI requires an external provider”** and shows nothing invented |
| Kore Krushi catalogue (DB-backed; unknown price/stock shown as unknown) | ✅ admin-managed |
| Admin panel (users, AI config, products, agri notes, announcements, stats) | ✅ `/admin`; admins cannot see conversations because the server never stores them |
| Streaming token-by-token replies | ❌ Not implemented — replies are returned whole (cancel button works) |
| Offline | ✅ banner; notes/tasks/memory/settings/history work; AI/search fail honestly |

Privacy by design: conversations, memories, notes, tasks live **on the device** (AsyncStorage); credentials in the Android Keystore (`expo-secure-store`). The server stores only device-id accounts, usage counters, tool-call metadata (no arguments), shop data. Location is used transiently, never stored. Photos are never stored.

## 1 · What to install on Windows (all free)

| Install | Why | Where |
|---|---|---|
| **Node.js 20 or 22 LTS** | runs the backend and the desktop web app | nodejs.org |
| **Ollama** | runs the AI model locally | ollama.com/download |
| **One model** (about 2–4 GB) | the actual AI | in a terminal: `ollama pull qwen2.5:3b` (recommended: lightweight, understands Hindi/Marathi reasonably, supports tools). Alternatives already tested here: `gemma3:4b` (also reads images) |
| Chrome or Edge | desktop voice input | already installed on most PCs |
| (Android only, optional) Android Studio or an Expo EAS account | build the phone app | see §3 |

You need about 8 GB RAM for a 3–4 B model. A GPU is **not** required but makes replies faster; on CPU-only PCs a reply can take from several seconds to a minute or more, and the first message after idle is slowest (model load). Smaller models (`qwen2.5:1.5b`, `llama3.2:1b`) are faster but less capable.

**No paid key anywhere.** Everything below is optional:

| Optional service | Why | Cost |
|---|---|---|
| SearXNG (self-hosted) or Tavily | real web search instead of news-RSS + Wikipedia | SearXNG free; Tavily has a free tier with a monthly limit and needs a free account key |
| Cloud AI (OpenAI / Anthropic / a free-tier OpenAI-compatible host) | faster/better answers, vision on phones without your PC | **Optional Paid Service** (some vendors have free tiers with rate limits that can change; check theirs). Disabled unless you set `AI_FALLBACK_PROVIDER` / choose it in Settings |

### Android without your PC running
A local 3–4 B model cannot realistically run inside a normal Android app (RAM/battery), and this project does not embed one (**Requires integration**, e.g. llama.cpp bindings). Choose one in Settings → AI → Backend:
1. **Your Windows JARVIS server** — reachable from the phone over your Wi-Fi (LAN IP, needs `https` in release builds) or anywhere via a tunnel / Tailscale. PC must be on.
2. **A server that is always on** (a small VPS, or an old PC) running the same backend + Ollama. Cost: your own hardware or hosting.
3. **Cloud fallback** on an always-on backend: set `AI_FALLBACK_PROVIDER=custom` with a free-tier OpenAI-compatible endpoint in `AI_BASE_URL` (+ its free key), so chat works when Ollama is unreachable. Free tiers have rate/usage limits.
Without any server the phone app still works offline for maths, time, weather (needs internet), notes and reminders.

### Voice (free)
Speech-to-text and text-to-speech use the free system engines: Android’s speech recognizer / TTS, and Chrome/Edge’s Web Speech API on desktop. Note: Chrome’s and many Android recognizers send audio to Google’s servers (free, but not local); Android can use offline language packs. Fully local Whisper/Piper voice is **Requires integration** and not built.

## 2 · Backend setup
```bash
cd backend
cp .env.example .env        # fill JWT_SECRET and APP_ACCESS_CODE (+ ADMIN_*). No AI key needed.
ollama pull qwen2.5:3b      # once, downloads the free model
npm install
npm run hash -- "my admin password"   # paste output into ADMIN_PASSWORD_HASH
npm run dev                 # http://localhost:8787  (admin: /admin). The log shows whether Ollama + a model were found
npm test && npm run typecheck
```
API (all `/api/*` need `Authorization: Bearer <jwt>` except auth):
`POST /api/auth/device` · `GET /api/health` · `GET /api/ai/status` (Ollama installed/running/models) · `POST /api/chat` · `POST /api/agri/analyze` · `POST /api/search` · `GET /api/shop/products` · `GET /api/announcements` · admin: `/admin/api/*`.

## 3 · App setup, run & build
Requires Node 20+. Android builds need Android Studio (local) or EAS cloud builds.
```bash
cd mobile
npm install
```
Set `backendUrl` in `app.json` (or later in the app: Settings → AI). The Android emulator reaches your PC at `http://10.0.2.2:8787` (allowed in dev builds only); real phones need an `https://` URL (deployed server or a tunnel such as Cloudflare Tunnel / ngrok).

**Desktop PC app (Windows) — one click:**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1        # once (and after code changes): builds web app + backend
powershell -ExecutionPolicy Bypass -File scripts\create-desktop-shortcut.ps1   # optional: puts "JARVIS AI" on your Desktop
```
Then double-click **`JARVIS.cmd`** (or the Desktop shortcut). It starts Ollama (if installed), the backend, and opens JARVIS in its own Edge/Chrome app window at `http://localhost:8787/` (the backend serves the app itself, so no CORS setup). First run: Settings → AI → enter the access code from `backend/.env` → Save backend. `scripts\stop-jarvis.ps1` stops the backend.
Voice input needs Chrome/Edge (Web Speech API; Edge/Chrome send the audio to Microsoft/Google’s free speech service). Keep `NODE_ENV` unset for local use (production mode demands HTTPS).

*Developer mode (hot reload):* `cd mobile; npx expo start --web` and set `CORS_ORIGINS=http://localhost:8081` in `backend/.env`.

**Android phone:**
```powershell
# Local APK build with Android Studio's bundled Java + SDK (what produced the APK in this project):
cd mobile
npx expo prebuild --platform android --no-install
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd android; .\gradlew.bat assembleRelease          # -> app\build\outputs\apk\release\app-release.apk
# install on a USB-connected phone (USB debugging on):  adb install -r app\build\outputs\apk\release\app-release.apk
# or run straight onto a device/emulator:  npx expo run:android
# or cloud build, no Android Studio:
npm i -g eas-cli && eas login && eas build:configure
eas build --platform android --profile preview      # APK you can sideload
eas build --platform android --profile production   # AAB for Google Play
```
`expo-speech-recognition` is a native module, so **Expo Go will not work on the phone**; install the APK (above) or use an EAS development build.

**Pointing the phone at your PC:** the release APK only allows `https://` backends (plus `http://localhost`). To use your PC’s Ollama from the phone, expose the backend over HTTPS with a tunnel (e.g. Cloudflare Tunnel or Tailscale Funnel) and enter that URL + access code in Settings → AI. The PC must be on. The APK is signed with the default debug key (fine for personal sideloading; create your own keystore before publishing to Google Play).

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
- `cd backend && npm test` — calculator (incl. injection attempts), auth, admin flow, user disabling; **Ollama flow against a fake Ollama server** (detection, model pick, native + prompt-based tool calls, no-model / not-running / no-vision states).
- Live check against your real Ollama: start the backend, then `node tests/live-ollama.mjs`.
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
| “Local AI is not ready” | Settings → AI → *Test AI connection* tells you which step is missing: install Ollama, start it, or `ollama pull qwen2.5:3b` |
| Replies take very long | CPU-only PC: use a smaller model (`qwen2.5:1.5b`), close other apps, keep Ollama running (first reply loads the model) |
| Model ignores tools / answers oddly | very small models are weaker; try `qwen2.5:3b` or `qwen2.5:7b` |
| Search results look generic | without SearXNG/Tavily only news RSS + Wikipedia are used (stated in the result); set `SEARXNG_URL` for real web search |
| “Vision AI requires an external provider” | `ollama pull gemma3:4b` (or `llama3.2-vision`), or configure optional cloud AI |
| Wake word stops | Expected: the OS ends recognition sessions and in background; it restarts while app is foreground |
| `better-sqlite3` install error | Use Node 20/22 LTS; on Windows install build tools if no prebuilt binary |
| WhatsApp doesn’t open | Not installed (desktop uses the wa.me web link) |

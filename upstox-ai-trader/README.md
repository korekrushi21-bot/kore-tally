# Upstox AI Smart Trader

An AI-assisted algorithmic trading application for the Indian stock market,
built on the official Upstox API. **This is capital-at-risk software** —
it defaults to paper trading, and live order execution stays disabled until
you explicitly configure and enable it in a later phase.

## Current phases built

### Phase 1 — Upstox OAuth + authorized data fetch
- Secure OAuth2 login against the real Upstox API (`/v2/login/authorization/...`)
- Encrypted-at-rest storage of the access token, with an audit log of auth events
- Authorized **read-only** data fetch: profile, holdings, positions, funds & margin, order book

### Phase 2 — strategy engine, risk engine, paper trading
- **Indicators** (`app/engine/indicators.py`): EMA(9/21/50), RSI(14), MACD(12/26/9), VWAP,
  ATR(14), rolling support/resistance, trend detection, volume-confirmed breakout/breakdown,
  volatility regime — pure Python, no pandas/numpy, each independently unit-tested.
- **Strategy engine** (`app/engine/strategy.py`): combines the indicators into a
  BUY/SELL/NO_TRADE `Signal` with entry, stop-loss, target, risk:reward, a 0-100 strength
  score, a plain-language explanation of agreeing/disagreeing indicators, an invalidation
  condition, and a staleness flag based on the data's own timestamp.
- **Risk engine** (`app/engine/risk.py`): enforces the spec's defaults — 0.5% max risk per
  trade, 1.5% max daily loss, 3 max simultaneous positions, minimum 1:2 risk:reward, no
  averaging down — and computes position size as `risk_budget / |entry - stop_loss|`. All
  configurable via `.env` (see below); the backend enforces these regardless of any UI.
- **Paper trading engine** (`app/engine/paper_trading.py`): simulates fills (with slippage)
  and exits (with an approximate Indian equity cost model), tracks a simulated account and
  daily realized P&L, auto-halts new entries once the daily loss limit is hit, and has an
  **emergency stop-all** (closes every open paper position and halts trading until you call
  `/paper/resume`). No real money or real orders are ever touched by this phase.
- New endpoints: `GET /strategy/signal`, `GET /paper/account`, `GET /paper/positions`,
  `POST /paper/evaluate`, `POST /paper/positions/{id}/close`, `POST /paper/stop-all`,
  `POST /paper/resume`.

### Phase 3 — backtesting engine
- **Backtester** (`app/engine/backtest.py`): walks real historical candles bar-by-bar and
  reuses the *exact same* `generate_signal` and `RiskManager` code as paper trading — a
  backtest can never silently drift from what the app would actually do live. At bar `i`
  the strategy only ever sees `candles[:i+1]`; exits are checked only against bars strictly
  after entry — no look-ahead bias. Entries execute at the signal bar's close price, exits
  at stop-loss/target (if both fall in the same bar's range, stop-loss is assumed to have
  hit first — the standard conservative assumption), with the same slippage and cost model
  as paper trading.
- Reports: win rate, profit factor, net P&L, gross profit/loss, average win/loss, average
  planned risk:reward, total costs, max drawdown (amount and %), and a step-wise equity curve.
- Optional **train/test split**: pass `train_end_date` and every trade is tagged `train` or
  `test`, with metrics reported for each separately — so you can sanity-check a strategy
  out-of-sample instead of only eyeballing performance over the whole window.
- New endpoint: `GET /backtest/run`.

### Phase 4 — dashboard
- **React + TypeScript dashboard** (`dashboard/`, built with Vite, no UI framework
  dependency) — a single-page, card-based, mobile-friendly view covering every panel from
  the original spec: paper account summary (capital, net equity, realized/unrealized/net
  P&L, daily risk utilization) with clear green/red indicators, open paper positions (with
  a manual close action), completed trades, a read-only live Broker Account panel
  (holdings/positions/funds/order book via `/market/*`, only populated once connected), a
  Strategy Signal panel (enter an instrument key, see the signal with its full explanation,
  or evaluate it through the risk engine into a paper trade), a Backtest panel (date range +
  optional train/test split, metrics tables, an inline SVG equity-curve chart, full trade
  list), and emergency stop-all/resume controls (with a confirmation step). Polls the
  backend every 15s for live-ish updates — no WebSocket yet, since Upstox's own streaming
  API wasn't in scope for this phase.
- Runs on **http://localhost:5180** by default; talks to the backend via `VITE_API_BASE_URL`.

### Phase 5 — live order placement (real money)
- **Live trading engine** (`app/engine/live_trading.py`) — off by default
  (`LIVE_TRADING_ENABLED=false`), reuses the same `generate_signal` and `RiskManager` as
  paper trading and the backtester, and adds everything specific to real orders: real
  available-funds check (`/market/funds`), duplicate-order prevention, MARKET entry orders
  with fill confirmation polled before anything else happens, and — critically — **the
  stop-loss and target are placed as real orders on the exchange** (SL-M and LIMIT)
  immediately after a confirmed fill, so a position stays protected even if this app goes
  offline. Since Upstox doesn't support OCO, the engine emulates it: `/live/reconcile`
  polls both legs and cancels whichever didn't fill the moment the other one does.
- **Emergency stop-all** (`POST /live/stop-all`) cancels every open order and exits every
  open position on the **entire Upstox account** — not just ones this app placed — and
  requires an exact confirmation phrase in the request body. There's also a dashboard-level
  arming checkbox before any live control is even clickable.
- New endpoints: `GET /live/status`, `GET /live/preflight`, `GET /live/positions`,
  `POST /live/evaluate`, `POST /live/reconcile`, `POST /live/stop-all`, `POST /live/resume`.
- **Read the "Live trading" section below in full before touching any of this.**

### Important Upstox behavior this app is built around
- Upstox does **not** issue refresh tokens. Access tokens always expire at
  **03:30 IST**, and Upstox explicitly discourages automating daily
  re-login for compliance/regulatory reasons. So reconnecting is a manual,
  once-daily user action — there is no background auto-refresh in this app,
  by design.
- The access token is encrypted at rest (Fernet) and is never returned by
  any API response or logged.

## 1. Register your app with Upstox

1. Go to the [Upstox Developer Console](https://account.upstox.com/developer/apps) and create an app.
2. Set its **Redirect URI** to exactly match what you'll run locally, e.g. `http://localhost:8010/auth/callback`.
3. Note the **API Key** (= `client_id`) and **API Secret** (= `client_secret`).

## 2. Configure environment

```bash
cd backend
cp .env.example .env
```

Fill in `.env`:
- `UPSTOX_CLIENT_ID`, `UPSTOX_CLIENT_SECRET`, `UPSTOX_REDIRECT_URI` — from step 1
- `TOKEN_ENCRYPTION_KEY` — generate with:
  ```bash
  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  ```
- `SESSION_SECRET` — any long random string, e.g.:
  ```bash
  python -c "import secrets; print(secrets.token_urlsafe(32))"
  ```
- `DATABASE_URL` — leave as the Postgres URL if using docker-compose, or switch to
  `sqlite:///./upstox_trader.db` for a zero-setup local run without Docker.

Never commit `.env` — it's already in `.gitignore`.

## 3. Run it

### Option A — plain Python (SQLite)
```bash
cd backend
python -m venv .venv
.venv/Scripts/activate      # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8010
```

### Option B — Docker Compose (Postgres + backend)
```bash
docker compose up --build
```

Then open **http://localhost:8010/static/index.html** (both run options serve on 8010).

## 4. Run the dashboard

```bash
cd dashboard
cp .env.example .env    # only needed if your backend runs somewhere other than localhost:8010
npm install
npm run dev
```

Open **http://localhost:5180**. It talks to the backend over CORS (already allowed in
`.env.example`'s `CORS_ALLOW_ORIGINS`).

## 5. Try the flow

1. Click **Connect Upstox Account** → you're redirected to Upstox's real login/consent screen.
2. Log in and approve → Upstox redirects back to `/auth/callback`, which exchanges the code
   for an access token and stores it encrypted.
3. Click **Get Profile / Holdings / Positions / Funds & Margin / Get Order Book** to confirm
   authorized data fetch works.
4. Enter a real instrument key (format `EXCHANGE_SEGMENT|ISIN`, e.g. `NSE_EQ|INE002A01018` —
   look these up in Upstox's
   [instrument master file](https://upstox.com/developer/api-documentation/instruments))
   and click **Get Signal** to see the strategy engine's output against real historical
   candles, or **Evaluate & Paper-Trade** to also run it through the risk engine and open a
   simulated position if approved. Do this from the dashboard (step 4), or the static test
   page's own instrument field.
5. In the dashboard, watch the **Paper Account** card for simulated P&L, use **Emergency
   Stop All** to flatten every open paper position and halt trading (then **Resume
   Trading** to lift the halt), and use the **Backtest** panel to run a historical test with
   an optional train/test split and see the equity curve + metrics.
6. Live trading stays off until you've read the **⚠ Live trading** section below in full
   and set `LIVE_TRADING_ENABLED=true` yourself — the dashboard's Live Trading card tells
   you plainly when it's off, and shows nothing actionable until you also tick its local
   "I understand" checkbox.
7. Click **Disconnect** to invalidate the local session. Tomorrow (after 03:30 IST), the
   token expires on its own and you'll need to click Connect again — this is expected
   Upstox behavior, not a bug.

### Configuring risk limits

All risk/paper-trading defaults live in `.env` (see `.env.example`) and match the original
spec: `RISK_MAX_PER_TRADE_PCT=0.005`, `RISK_MAX_DAILY_LOSS_PCT=0.015`,
`RISK_MAX_OPEN_POSITIONS=3`, `RISK_MIN_REWARD_RATIO=2.0`, `RISK_ALLOW_AVERAGING_DOWN=false`,
plus `PAPER_TRADING_STARTING_CAPITAL`, `COST_BROKERAGE_PER_ORDER`, `COST_PCT_CHARGES`, and
`SLIPPAGE_BPS` for the paper P&L cost model. These are enforced server-side, not just
suggested defaults — the risk engine rejects any simulated trade that violates them.

## ⚠ Live trading (real money) — read this before enabling

Live trading is **off by default** and cannot be turned on from the API or dashboard —
only by setting `LIVE_TRADING_ENABLED=true` in `backend/.env` and restarting the backend.
Everything in this section only matters once you've decided to do that.

### Regulatory prerequisites (verified against Upstox's developer docs, Oct 2026)

1. **A registered static IP.** Since 1 Apr 2026, Upstox rejects every order
   place/modify/cancel/exit-all call that doesn't originate from a static IP you've
   registered via the developer console or `GET`/`PUT /v2/user/ip` (this app exposes the
   GET side at `GET /live/preflight`). If your backend runs from home broadband, a mobile
   connection, or a cloud instance without a static IP, **live orders will be rejected
   outright** until you fix this — it is not optional and this app cannot work around it.
2. **Algo order-rate threshold.** SEBI requires exchange registration for any algorithm
   placing more than 10 orders/second; below that, no registration is needed (Upstox's own
   "Regular Algo" rate limit is 10/sec, 500/min). This app's usage pattern (one evaluate
   call at a time, human- or externally-scheduled) stays far under that threshold by
   design — there is no autonomous loop in this codebase that could run away and breach it.
3. **X-Algo-Name header**, only if you've registered this app as an Algo App in Upstox's
   developer console (Algo Apps settings) — set `UPSTOX_ALGO_NAME` to the configured name.
   Leave it blank if you haven't; most individual retail use doesn't require this.

**This app cannot verify any of the above for you.** `/live/preflight` shows what static
IP Upstox has registered for your account — confirm it actually matches the machine
running this backend before placing a single order.

### How a position is actually protected

1. `/live/evaluate` reconciles any existing position on the instrument first, then — if
   approved by the risk engine — places a **MARKET** entry order and polls Upstox
   (`LIVE_ENTRY_FILL_POLL_ATTEMPTS` × `LIVE_ENTRY_FILL_POLL_INTERVAL_SECONDS`, default 5×1s)
   until it's confirmed filled. Nothing protective happens against an unconfirmed fill.
2. The instant the fill is confirmed, it places a real **SL-M** order at the stop-loss and
   a real **LIMIT** order at the target — both resting on the exchange. This is why the
   stop-loss still works even if this app crashes or the host machine is off.
3. Because Upstox's place-order API doesn't support OCO, these two legs are independent
   orders. **You must call `POST /live/reconcile` regularly** while any live position is
   open — it's what notices one leg has filled and cancels the other. Until that happens,
   both orders technically still sit on the exchange.
4. If placing either protective leg fails (network blip, rejection, etc.), the position is
   now open with **no stop-loss**. This is surfaced loudly — `stop_loss_placement_failed`
   on the position, a red "NO STOP" badge in the dashboard, and an audit log entry — never
   silently swallowed. Treat it as requiring your immediate manual attention on Upstox.

### Emergency stop

`POST /live/stop-all` with body `{"confirm": "STOP ALL LIVE TRADING"}` (exact phrase, also
configurable via `LIVE_STOP_ALL_CONFIRMATION_PHRASE`) cancels **every open order** and
exits **every open position on the account** — deliberately account-wide, not scoped to
what this app placed, because a panic button that left other exposure untouched would
defeat the point. `/live/stop-all`, `/live/resume`, `/live/reconcile`, `/live/positions`,
`/live/status`, and `/live/preflight` all work regardless of `LIVE_TRADING_ENABLED` — only
`/live/evaluate` (which can open a new position) is gated by that flag — so you can always
check on or flatten real positions even after disabling the master switch.

### What this phase does not do

- No scheduler, cron, or background loop places orders on its own. Every live order traces
  back to a `/live/evaluate` call you (or something you explicitly set up) made. This was a
  deliberate choice given the regulatory and capital-risk stakes — build your own polling
  loop only once you've tested extensively and understand exactly what it will do.
- LIMIT entries aren't supported — MARKET only, to keep the fill-confirmation flow sound.
- Real P&L shown by this app (`realized_pnl` on `LivePosition`) is this app's own estimate
  from fill prices and the approximate cost model — always reconcile against your actual
  Upstox contract notes/ledger for anything that matters (taxes, real accounting).
- This has never been tested against a real Upstox account or real money — only against a
  mocked Upstox API (see Tests below). Start with the smallest possible quantity, during
  market hours, and watch it closely before trusting it with anything larger.

## Tests

```bash
cd backend
pytest
```

Tests mock all Upstox HTTP calls (via `respx`) — nothing hits the real Upstox API or
requires real credentials to run.

## Project layout

```
backend/
  app/
    core/      settings, crypto, OAuth state signing, IST token-expiry math, exceptions
    db/        SQLAlchemy models (BrokerSession, AuditLog, PaperAccount, PaperPosition,
               DailyRiskState, LiveAccount, LiveOrder, LivePosition, LiveDailyRiskState)
    services/  auth_service (OAuth orchestration), upstox_client (REST wrapper), audit
    engine/    indicators, strategy (signal generation), risk (RiskManager), costs,
               paper_trading, backtest, live_trading (real orders, gated off by default)
    api/       FastAPI routes: /auth/*, /market/*, /strategy/*, /paper/*, /backtest/*, /live/*
    static/    manual smoke-test page
  tests/       pytest suite, Upstox calls mocked with respx; engine logic tested with synthetic data
  requirements.txt, Dockerfile, .env.example
dashboard/
  src/
    api.ts, types.ts   typed fetch wrapper + shared types for every backend endpoint
    components/        StatusBar, AccountSummary, PositionsTable, TradesTable, BrokerPanel,
                        SignalPanel, BacktestPanel, EquityCurveChart (plain inline SVG, no chart lib),
                        EmergencyControls, LiveTradingPanel (gated, red-bordered, arm checkbox)
    App.tsx            page layout + 15s polling
  vite.config.ts (dev server on :5180), .env.example
docker-compose.yml   Postgres + backend
```

## Known limitations & assumptions (Phase 2)

- **LTP response shape**: Upstox's own v3 LTP docs have reportedly drifted from what the
  API actually returns (community reports disagree on field names). `_parse_ltp_response`
  in `app/api/routes/paper.py` is defensive about this, but verify it against a real
  response once you have live credentials, and adjust if Upstox's shape differs.
- **VWAP** is a running cumulative value over whatever candle series you pass in — it does
  **not** reset per trading day. For a multi-day daily-candle series this is not a
  textbook intraday VWAP; treat it as a longer-horizon mean-price reference until a
  per-day-reset version is added.
- **Cost model** (`app/engine/costs.py`) is a configurable approximation for paper P&L
  only — not real brokerage/STT/exchange-charge figures, and must never be treated as such.
- **Daily loss halt** (`DailyRiskState.loss_limit_halted`) resets automatically on IST date
  rollover. The **emergency stop-all** halt (`PaperAccount.trading_halted`) does not — it
  persists until you explicitly call `/paper/resume`.
- No instrument search/lookup is built yet — you supply a known instrument key directly.

## Known limitations & assumptions (Phase 3)

- The backtester trades **one instrument at a time**; it can't detect survivorship bias
  from a human cherry-picking which instruments/periods to backtest — that's on the user.
- The equity curve is a step function updated only on realized trade closes, not a
  continuous intrabar mark-to-market curve — fine for drawdown-on-realized-trades, but
  don't read it as a tick-by-tick equity chart.
- `max_open_positions` (3) is a portfolio-level limit from the original spec; this
  single-instrument backtester can only ever hold 0 or 1 position in that one instrument,
  so that particular limit isn't meaningfully exercised until multi-instrument backtesting
  exists.
- Backtest results are not persisted — each `/backtest/run` call is stateless; comparing
  past runs means re-running them (see Phase 4 limitations below for the dashboard's take).

## Known limitations & assumptions (Phase 4)

- **No WebSocket / real-time push** — the dashboard polls the backend every 15 seconds.
  Upstox does offer a WebSocket market-data feed, but wiring it up (and a push channel from
  backend to dashboard) wasn't in scope for this phase.
- **Broker Account panel shows raw JSON** — holdings/positions/funds/order book are Upstox's
  own response shapes, displayed as formatted JSON rather than bespoke tables, to avoid
  guessing at field layouts before testing against a real account.
- **Backtest results aren't saved** — each run is client-side state only; refreshing the
  page loses it. No history/comparison view yet.
- Dashboard and backend CORS are wired for **localhost only** (`:5180` ↔ `:8010`); deploying
  either one elsewhere means updating `CORS_ALLOW_ORIGINS` and `VITE_API_BASE_URL`.

## Known limitations & assumptions (Phase 5)

- **No continuous/automated polling** — see "What this phase does not do" above. This is
  by design, not an oversight.
- **Funds-check is best-effort.** Upstox's v3 funds-and-margin response schema isn't fully
  documented (see Phase 2 limitations); `_available_capital` scans for a plausibly-named
  "available margin" field and falls back to the configured paper-trading capital figure if
  it can't find one — verify this against your real account before relying on it for sizing.
- **Daily live-loss tracking only sees trades this app placed.** If you also trade manually
  on the same Upstox account, `LiveDailyRiskState` has no visibility into that activity.
- **`exit_all_positions` can't close equity delivery ("D") positions** — only intraday
  ones, which is why `LIVE_ORDER_PRODUCT` defaults to `"I"`. If you change that default,
  the emergency stop-all's position-exit leg may not be able to flatten everything.
- Never tested against a real Upstox account — see the warning above.

## Security notes

- Access tokens are encrypted at rest (Fernet) and never appear in API
  responses, logs, or the frontend.
- `/auth/status` returns only the Upstox user id and token expiry — never
  the token itself.
- Every login, disconnect, and token-expiry event is written to an
  append-only audit log (`audit_log` table), without ever storing the raw
  token.
- CORS is restricted to the configured local origin.

## Status

All five phases from the original spec are built: OAuth, strategy/risk/paper trading,
backtesting, dashboard, and gated live order placement. Live trading stays off
(`LIVE_TRADING_ENABLED=false`) until you deliberately enable it — see the Live Trading
section above first. Natural next steps if you want to keep going: real instrument
search/lookup (right now you supply instrument keys directly), persisted backtest runs,
a WebSocket-based live feed instead of 15s polling, and genuinely exercising this against
a real (small, carefully watched) Upstox account.

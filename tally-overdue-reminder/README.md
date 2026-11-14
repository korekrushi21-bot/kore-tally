# Overdue Reminders (Tally)

Pulls each customer's outstanding balance from Tally (live, read-only — this
app never writes anything back to Tally), works out which of their bills are
still unpaid and since when, and calculates interest **per bill** once its
due date has passed (default 2% per month, simple, pro-rated by days).
Also shows the most recent rate you charged that customer per product
(incl. GST) and what was on each recent invoice, so you have what you need
to write a reminder. **No message is sent automatically** — you copy the
generated text and send it yourself via WhatsApp/SMS/email. Product/purchase
**rates are for your eyes only** in the app — the generated customer-facing
messages never include a rate or price per item, only totals owed, dates and
interest.

## Why due dates and bill-wise interest are computed, not read from Tally

Tally supports per-bill due dates via "bill-wise details", but plenty of
businesses (this one included) just track a running balance per customer
instead — there's no bill-wise data to read. So this app reconstructs an
estimate itself, in two steps:

1. **Due date per bill**: `dueDate = bill date + creditPeriodDays`. This is
   a policy you set (`interest.creditPeriodDays` in `backend/config.json`),
   not a fact from Tally.
2. **Which bills are still outstanding**: a customer's current balance is
   usually less than everything ever invoiced to them (they've paid some of
   it), but Tally doesn't say *which* bills that payment covered. This app
   assumes the standard **FIFO** rule — payments clear the **oldest** bill
   first — and walks each customer's invoices oldest→newest, marking bills
   paid off until it runs out of "paid" amount to allocate. Whatever's left
   unpaid on each bill is what shows in the **"Interest breakdown by bill"**
   table, each with its own due date and interest. If a customer had a
   balance before this Tally data even starts, that shows as an "Opening
   balance" entry anchored at the earliest date found in your data; if the
   traced bills don't quite add up to the live balance (rounding, or a
   Journal-entry charge with no invoice), the gap shows as one "Other
   charges" line so the numbers still foot exactly to the real balance.

This means the **interest breakdown is an estimate**, not a fact read from
Tally — it's clearly labelled as such in the app. The **total balance and
total interest** are always exactly right (traced to Tally's live numbers);
it's only the *split across individual bills* that's a FIFO assumption.

## Cloud backup for "last synced data" when the PC is off

The app lives on this PC only - when it's off (or Tally's closed, or
Tailscale's down), your phone can't reach it, full stop. To soften that,
every live `/api/overdue` load also pushes a snapshot (throttled to once
per 5 minutes) to a private GitHub Gist, configured in `backend/config.json`
under `"sync"`. If your phone can't reach the PC at all, it automatically
falls back to that last snapshot instead of showing nothing, with a clear
"⚠ showing last synced data from &lt;time&gt;" banner - see `gist-sync.js`
and `loadFromCloudSnapshot()` in `frontend/app.js`.

When the PC can't be reached the app shows, within a few seconds, whichever
is newer: the cloud snapshot, or the copy the phone itself saved the last
time it loaded live (`localStorage`). It also paints the phone's saved copy
immediately on every open, so the screen is never blank while connecting.

**Opening the app while the PC is off** needs one more piece: the app's own
files (HTML/JS/CSS) are served by the PC, so with the PC off there's nothing
to load - a blank page. `frontend/sw.js` (a service worker) fixes that by
keeping a copy of those files on the phone, but browsers only allow service
workers over **HTTPS** (or localhost), not over a plain `http://` address.
So this only takes effect once the app is reached via an HTTPS address
(e.g. Tailscale's `https://<pc-name>.<tailnet>.ts.net`, set up with
`tailscale serve`), and the phone has opened the app once that way.
The app's files hold no data, so they're served without a login (see
**Login** below) - which is also what lets the phone keep its own copy.

**Already set up on this PC:** `tailscale serve --bg 4000` publishes the app
at `https://desktop-ajrqb0i.tailf087c0.ts.net` (tailnet only, no `:4000`).
Undo with `tailscale serve --https=443 off`.

**Real limits on this:**
- **The gist bypasses the app's login.** GitHub only requires no
  authentication to *read* a secret gist if you have its exact ID, and that
  ID is sent to the browser (harmless on its own, but combined with the
  gist being readable-by-link) means anyone who gets hold of that ID can
  see the last-synced customer data without your app password. It's not
  publicly listed or searchable, so this is "obscurity," not real access
  control - acceptable for a personal backup, but worth knowing. Never
  commit `backend/config.json` (already gitignored) since it holds the
  GitHub token that can *write* to that gist.

## Run it (with sample data, no Tally needed)

```bash
cd backend
npm install
npm start
```

Then open http://localhost:4000 — it asks for the password (see **Login**
below), then it starts in mock-data mode (see
`backend/config.json`) so you can try the dashboard immediately with sample
customers.

## Auto-start on login (already set up on this PC)

`backend/run-forever.bat` restarts the server automatically if it ever
crashes, and a copy of `backend/run-hidden.vbs` in your Windows **Startup**
folder (`shell:startup`) launches it - with no visible console window -
every time you log in. This only needed your normal user account, no admin
rights, since Task Scheduler on this machine required elevation this
session didn't have.

**What this does *not* cover**: the PC has to be on and awake, and Tally
has to be open, for the app to actually work - this just makes sure the
Node server itself is always running and self-heals if it dies. To stop it
running at login, delete `OverdueReminderServer.vbs` from the Startup
folder; to stop it right now, end the `node.exe` process in Task Manager
(it will restart itself within ~5 seconds unless you also close the
`run-forever.bat`/`cmd.exe` process, or delete the Startup entry first).

## Login

The data (every `/api/...` route) sits behind a password screen inside the
app, since it shows customer financial data. It's a normal password field,
not the browser's pop-up: that pop-up doesn't work reliably in an iPhone
Home Screen app or alongside a service worker. The app's HTML/CSS/JS are
public (they contain no data). After a correct password the server sets a
signed, HttpOnly cookie valid for a year, so you only log in once per
device. Ten wrong attempts lock login for ten minutes. The password is in
`backend/config.json`:

```json
"auth": { "password": "change-this-password" }
```

Restart the backend after changing it - that also signs every device out.
To remove the login entirely (not recommended), delete the `auth` block.

The offline copy the phone keeps (saved data, cloud snapshot) can be viewed
without logging in, same as anything already on the phone; the phone's own
lock screen is what protects it.

## Connect to your real Tally

This only ever sends Tally `TALLYREQUEST=Export` (read) requests — never
`Import` — so it cannot add, edit, or delete anything in your Tally company.

1. In Tally, open the company you want to use, then enable its HTTP server:
   - **TallyPrime**: `F1` (Help) → `Settings` → `Connectivity` → set
     "Tally acts as" to **Server** (or **Both**) and note the **Port**
     (default `9000`).
   - **Tally.ERP 9**: `Gateway of Tally` → `F12: Configure` →
     `Advanced Configuration` → enable the ODBC/data server option and note
     the port shown at the bottom-right of the Tally window.
   - Leave Tally open on that company while the backend is running — it
     answers XML requests only while it's up.

2. Edit `backend/config.json`:
   ```json
   {
     "tally": { "host": "localhost", "port": 9000, "company": "" },
     "interest": { "ratePercentPerMonth": 2, "creditPeriodDays": 30, "salesLookbackDays": 3650 },
     "useMockData": false
   }
   ```
   Leave `"company": ""` if Tally only has one company open — the app then
   just uses whichever company is currently active. Set it only if you run
   multiple companies at once and need to target a specific one.

3. Restart the backend (`npm start`) and refresh the page.

### If customers or products show up empty/wrong

Tally's exact XML field names vary a little between versions and how your
data is entered. Hit these while `useMockData` is `false` to see Tally's raw
response and compare it against what `backend/tally-client.js` expects:

- `http://localhost:4000/api/debug/tally-raw` — customer balances XML
- `http://localhost:4000/api/debug/tally-raw?which=vouchers` — recent sales vouchers XML

If a field is named differently in your response, adjust the corresponding
`parseCustomerBalances` / `parseSalesVouchers` function in
`backend/tally-client.js`.

## Known limitations

- **Due dates and the bill-wise split are computed, not Tally data** — see
  above. All customers get the same credit period; there's no per-customer
  override yet. The FIFO assumption behind the bill-wise breakdown can be
  wrong if you actually apply payments against specific invoices rather
  than oldest-first — the total interest would still be roughly right, but
  which bill it's attributed to might not be.
- Only balances under the **Sundry Debtors** group (including its
  sub-groups) are treated as customers.
- **GST% on product rates** is estimated per voucher (total tax ledgers ÷
  total item value on that invoice), not read per line item. Accurate when
  an invoice uses one GST slab for everything on it (the common case), but
  can be off for invoices mixing multiple GST rates.
- Only Sales vouchers from the last `salesLookbackDays` (default 3650, i.e.
  ~10 years) are looked at - in practice this should cover any customer who
  has ever had a Sales invoice.
- Some customers carry a balance with **no Sales voucher behind it at all**
  (e.g. an old balance carried forward as an opening balance, before this
  Tally data was entered). For those there's no purchase date to count 30
  days from, so the app falls back to the earliest Sales voucher date found
  anywhere in your data (i.e. "the start of what's in Tally") + the credit
  period. The dashboard marks these as "No invoice on file (old balance)" so
  you can tell them apart from a real recent purchase.
- Interest is **simple interest, pro-rated daily** off a monthly rate
  (`balance × rate% × days_overdue / 30`).

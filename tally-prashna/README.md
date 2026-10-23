# Tally Prashna

A desktop window where you ask questions about your Tally data in Marathi,
English or a mix, and get the answer. Example:
*"urea without bill konta v konchya ac var aahe"*.

## Tally la kahi hot nahi (read-only)

- Every request is `TALLYREQUEST=Export` (read). There is no Import (write)
  request anywhere in the code, so it cannot add, change or delete any data.
- No TDL file is installed or saved into Tally. Each request carries a small
  inline collection definition that only tells Tally which fields to send
  back. Tally discards it once it has answered.
- The server listens on `127.0.0.1` only, so no other PC or phone on the
  network can open it.

## How it answers

| Mode | When | What it understands |
|---|---|---|
| **AI (Claude)** | An API key is in `config.json` and the "AI" box is ticked | Any question, in any wording |
| **Offline search** | No key, AI switched off, or AI unreachable (no internet or credit): the app falls back to this automatically | Item/party names plus keywords: *without bill / challan / delivery*, *balance / baki*, *stock / satha*, *sales / kharedi*, *ya mahinyat / ya varshi / aaj* |

Both modes use the same search code (`queries.js`), so the numbers are the
same either way. Rewording the question, changing the order, spelling it
differently (urea / yuriya / युरिया) or writing in Devanagari all give the
same answer. In AI mode, only the search results for that question are sent
to Anthropic, never the whole company.

### "Without bill" means

Voucher types whose base type is **Delivery Note, Receipt Note, Rejections
In/Out or Material In/Out** (so custom types like "Delivery Challan" count
too), plus any type with *challan / without bill / kachi* in its name.

**Bill baki qty** (not yet billed) is worked out from Tally's **Tracking
No.**, the delivery note you pick when you make the Sales/Purchase invoice.
If an entry was made without a tracking number, its status shows as
**"mahit nahi"** and the whole quantity is counted as pending.

## Setup (first time)

1. **Enable Tally's HTTP server** (TallyPrime: `F1 Help → Settings →
   Connectivity → Tally acts as: Server/Both`, Port `9000`). If the Overdue
   Reminder app already works, this is already done.
2. Edit `config.json` (it is created from `config.example.json` on first
   start):
   - `tally.port`: Tally's port (usually 9000)
   - `tally.company`: leave `""` if only one company is open
   - `anthropicApiKey`: your key from console.anthropic.com for AI mode.
     Leave it `""` to use offline search only.
   - `defaultLookbackDays`: how far back to search when no date is given
     (730 = 2 years)
3. Double-click **`Tally Prashna.vbs`**. The server starts hidden and the app
   opens in its own window.

Tally must be open while you use the app. After entering new data in
Tally, press **⟳ Refresh** in the app (it also refreshes on its own every 2
minutes).

## Adding a spelling for offline mode

If a product name isn't recognised, add it to `ALIASES` at the top of
`offline.js`, for example `"झिंक": "zinc"`.

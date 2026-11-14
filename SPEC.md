# Voice-Controlled Billing System for TallyPrime 7.1

## Project Overview

A voice-controlled billing assistant that integrates with TallyPrime 7.1 via its XML HTTP gateway (port 9000). The system operates in a **strictly limited scope**: voice commands may ONLY perform two actions — (1) creating/saving a NEW voucher of one of four types — **Sales, Purchase, Credit Note, Debit Note** — through the defined draft → read-back → spoken-confirmation flow, and (2) reading back ledger information on request. Voice must NEVER be used to edit, delete, cancel, or modify any existing ledger, voucher, or master data, and must never create masters (ledgers, stock items, groups).

The same engine (`voucher_service.py`) serves two front-ends: the stand-alone voice assistant (`main.py`) and **JARVIS** (`jarvis-ai`, via the local `billing_service.py` API). See "Voucher Types" and "Jarvis Integration" below.

---

## Architecture

### Core Components

1. **Wake Word Detector** - Detects "टॅली सुरू कर" to activate the system
2. **Speech-to-Text Engine** - Whisper-based STT supporting Marathi, Hindi, English
3. **Tally XML Gateway Client** - HTTP client for TallyPrime XML gateway (port 9000)
4. **Fuzzy Matcher** - Matches spoken names against live Tally ledger/stock lists
4. **Billing Workflow Engine** - Manages the step-by-step billing session
5. **Text-to-Speech** - Marathi TTS for read-back confirmations
6. **Session Manager** - Handles activation, timeout, and cleanup

### Data Flow

```
[Wake Word] → [Active Session] → [STT] → [Command Parser] → [Fuzzy Match] → [Confirm] → [Tally XML Write]
                    ↓                                    ↓
              [Timeout/Complete]                    [Read-Back TTS]
```

---

## Wake Word

- **Phrase**: "टॅली सुरू कर" (Tally suru kar) — fixed, single phrase
- **Detection**: Offline Whisper model with hotword bias
- **Behavior**: System stays idle/asleep until wake phrase detected
- **Activation**: On detection, plays confirmation beep and enters active session

---

## Session Management

### States
- **IDLE**: Listening only for wake word
- **ACTIVE**: Processing billing/inquiry commands
- **CONFIRMING**: Awaiting explicit confirmation ("बरोबर" / "हो")

### Timeouts
- **Inactivity timeout**: 20 seconds of silence → return to IDLE
- **Session max duration**: 5 minutes → force return to IDLE
- **Auto-sleep**: After bill completion or ledger inquiry answered

### Session Data
```python
{
    "state": "IDLE|ACTIVE|CONFIRMING",
    "mode": "BILLING|INQUIRY",
    "party": None,           # Confirmed ledger name
    "items": [],             # List of {item, qty, rate, amount}
    "step": "PARTY|ITEM|QUANTITY|CONFIRM|FINALIZE",
    "last_activity": timestamp,
    "wake_detected": timestamp
}
```

---

## Speech-to-Text

### Engine
- **Model**: `faster-whisper` (CPU optimized)
- **Languages**: Marathi (`mr`), Hindi (`hi`), English (`en`) — auto-detect
- **Model size**: `small` or `medium` for accuracy/speed balance

### Configuration
```python
voice_config = {
    "model": "small",
    "device": "cpu",
    "compute_type": "int8",
    "sample_rate": 16000,
    "record_seconds": 5.0,
    "language": "auto",
    "input_device": None,
    "wake_record_seconds": 3.0
}
```

### Prompts & Hotwords
- **Initial prompt**: Marathi business/accounting terms
- **Hotwords**: "बिल", "सेल्स", "पार्टी", "माल", "नग", "दर", "रक्कम", "बरोबर", "हो", "रद्द", "बाकी", "स्टॉक"

---

## Tally XML Gateway Client

### Endpoint
- **URL**: `http://127.0.0.1:9000`
- **Method**: POST
- **Content-Type**: `text/xml; charset=utf-8`

### Read Operations (Export)
- `get_ledgers()` — List all ledger names with groups
- `get_stock_items()` — List all stock items with rates
- `get_voucher_types()` — List voucher types
- `get_party_outstanding(party_name)` — Get ledger balance

### Write Operation (Import) — **create one new voucher, nothing else**
- `VoucherService.confirm(draft_id)` — posts ONE new voucher of type Sales / Purchase / Credit Note / Debit Note via XML `Import Data` (report `Vouchers`, `ACTION="Create"`).
- Every message passes `voucher_xml.assert_create_only` first: exactly one `VOUCHER` with `ACTION="Create"`, no alter/delete/cancel, no master data.
- A draft is single-use and expires (10 min), so a repeated "yes" cannot post a bill twice. If the connection drops mid-post the outcome is *unknown* and the draft is never re-sent automatically.

### XML Request Format (Read)
```xml
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CollectionName</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CollectionName" ISMODIFY="No">
            <TYPE>Ledger|StockItem|VoucherType</TYPE>
            <FETCH>NAME,PARENT,CLOSINGBALANCE,CLOSINGRATE,BASEUNITS</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
```

### XML Request Format (Write - Sales Voucher)
```xml
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>All Masters</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>Company Name</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <VOUCHER REMOTEID="" ACTION="Create">
            <DATE>20241215</DATE>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <VOUCHERNUMBER></VOUCHERNUMBER>
            <PARTYLEDGERNAME>Customer Name</PARTYLEDGERNAME>
            <NARRATION>Voice billing entry</NARRATION>
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>Item Name</STOCKITEMNAME>
              <ACTUALQTY>10 PCS</ACTUALQTY>
              <RATE>500/PCS</RATE>
              <AMOUNT>5000</AMOUNT>
            </ALLINVENTORYENTRIES.LIST>
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>Customer Name</LEDGERNAME>
              <AMOUNT>-5000</AMOUNT>
            </LEDGERENTRIES.LIST>
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>Sales Account</LEDGERNAME>
              <AMOUNT>5000</AMOUNT>
            </LEDGERENTRIES.LIST>
          </VOUCHER>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>
```

---

## Fuzzy Matching

### Algorithm
- **Normalization**: NFKC Unicode normalization, casefold, remove non-word chars
- **Variants**: Original, reversed word order, rotated word order
- **Transliteration**: Devanagari → ITRANS (if `indic-transliteration` available)
- **Scoring**: `difflib.SequenceMatcher.ratio()`
- **Threshold**: 0.74 (configurable)
- **Ambiguity gap**: 0.05 — if top 2 scores within gap, return ambiguous

### Match Result
```python
{
    "status": "matched|not_found|ambiguous",
    "name": "Exact Tally Name",
    "score": 0.92,
    "matches": [{"name": "...", "score": 0.92}, ...]  # if ambiguous
}
```

### Confirmation Flow
1. If `matched` → proceed
2. If `ambiguous` → TTS reads top 3 matches → ask user to speak full name
3. If `not_found` → TTS says "जुळले नाही, पुन्हा बोला" → re-listen

---

## Billing Workflow

### Step-by-Step Flow

```
STEP 1: PARTY (Customer)
  User: "राम ट्रेडर्स"
  System: Fuzzy match against ledgers (Sundry Debtors group)
  System: "राम ट्रेडर्स निवडले. आता मालाचे नाव बोला."

STEP 2: ITEM
  User: "युरिया 45 किलो"
  System: Fuzzy match against stock items
  System: Fetch last sale rate from Tally
  System: "युरिया 45 किलो, दर 300 रुपये किलो. नग बोला."

STEP 3: QUANTITY
  User: "दोन"
  System: Parse number → 2
  System: "नग 2. युरिया 45 किलो, 2 नग, दर 300, रक्कम 600 रुपये. बरोबर असल्यास हो म्हणा."

STEP 4: CONFIRM LINE
  User: "बरोबर" / "हो"
  System: Add to bill items list
  System: "आइटम जोडले. पुढचे मालाचे नाव बोला किंवा 'बिल बनव' म्हणा."

STEP 5: REPEAT or FINALIZE
  User: "डीएपी 50 किलो" → repeat steps 2-4
  User: "बिल बनव" → go to final summary

STEP 6: FINAL SUMMARY
  System TTS: "ग्राहक: राम ट्रेडर्स. आइटम: युरिया 45 किलो 2 नग दर 300, डीएपी 50 किलो 1 नग दर 1200. एकूण रक्कम 1800 रुपये. बिल सेव्ह करायचा असल्यास हो म्हणा."

STEP 7: FINAL CONFIRMATION
  User: "हो" / "बरोबर"
  System: POST XML to Tally → Create Sales Voucher
  System: "बिल तयार झाला. व्हाउचर नंबर 123."

STEP 8: COMPLETE
  System: Return to IDLE state
```

### Voice Commands Recognized

| Intent | Marathi Phrases | English |
|--------|----------------|---------|
| Wake | "टॅली सुरू कर" | — |
| Party | "ग्राहक [नाम]", "पार्टी [नाम]" | "customer [name]" |
| Item | "माल [नाम]", "आइटम [नाम]" | "item [name]" |
| Quantity | "[संख्या] नग", "Qty [number]" | "quantity [number]" |
| Confirm line | "बरोबर", "हो", "ठीक आहे" | "yes", "ok", "confirm" |
| Reject line | "नाही", "रद्द", "चुकीचे" | "no", "cancel" |
| Finalize | "बिल बनव", "बिल सेव्ह करा", "फायनल" | "create bill", "save bill" |
| Inquiry | "[नाम] बाकी", "[नाम] स्टॉक" | "[name] balance", "[name] stock" |
| Cancel session | "रद्द", "बंद करा", "बाहेर पडा" | "cancel", "exit" |

---

## Text-to-Speech

### Engine
- **Library**: `edge-tts` (Microsoft Neural Voices)
- **Voice**: `mr-IN-AarohiNeural` (Marathi female)
- **Fallback**: `hi-IN-SwaraNeural` (Hindi), `en-IN-NeerjaNeural` (English)
- **Rate**: +0% (normal)
- **Output**: MP3 played via Windows MediaPlayer (PowerShell)

### Read-Back Templates
```python
TEMPLATES = {
    "party_confirmed": "{party_name} निवडले. आता मालाचे नाव बोला.",
    "item_confirmed": "{item_name} निवडले. दर {rate} रुपये. नग बोला.",
    "line_summary": "{item_name} {qty} नग दर {rate} रक्कम {amount} रुपये. बरोबर असल्यास हो म्हणा.",
    "item_added": "आइटम जोडले. पुढचे मालाचे नाव बोला किंवा 'बिल बनव' म्हणा.",
    "final_summary": "ग्राहक: {party}. {items_summary}. एकूण रक्कम {total} रुपये. बिल सेव्ह करायचा असल्यास हो म्हणा.",
    "bill_created": "बिल तयार झाला. व्हाउचर नंबर {voucher_no}.",
    "bill_failed": "बिल सेव्ह करताना त्रुटी: {error}.",
    "not_found": "{label} जुळले नाही. पूर्ण नाव पुन्हा बोला.",
    "ambiguous": "{label} साठी एकापेक्षा जास्त नावे आहेत: {choices}. पूर्ण नाव बोला.",
    "inquiry_result": "{name} चे बाकी {amount} रुपये आहे.",
    "stock_result": "{name} चा स्टॉक {qty} {unit} आहे.",
}
```

---

## Security & Safety

### Read-Only Guard
- All Tally queries use `TALLYREQUEST=Export` only
- SQL queries (if ODBC used) validated: only `SELECT`/`WITH` allowed
- Forbidden: `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP`, `CREATE`, etc.

### Write Operation Restrictions
- **ONLY** `VoucherService.confirm()` permitted via voice (new Sales / Purchase / Credit Note / Debit Note voucher)
- No master creation/modification
- No voucher editing/deletion
- No GST/config changes
- Explicit final confirmation required before write

### Error Handling
- Tally connection errors → clear message, no silent retry
- XML parse errors → log and report
- Speech recognition failures → "पुन्हा बोला" prompt
- Fuzzy match failures → guide user to speak full name

---

## Configuration

### config.json
```json
{
  "tally": {
    "host": "127.0.0.1",
    "port": 9000,
    "company": ""
  },
  "voice": {
    "model": "small",
    "device": "cpu",
    "compute_type": "int8",
    "sample_rate": 16000,
    "record_seconds": 5.0,
    "wake_record_seconds": 3.0,
    "language": "auto",
    "input_device": null
  },
  "matching": {
    "threshold": 0.74,
    "ambiguity_gap": 0.05
  },
  "session": {
    "inactivity_timeout_seconds": 20,
    "max_session_seconds": 300
  },
  "tts": {
    "voice": "mr-IN-AarohiNeural",
    "rate": "+0%"
  },
  "voucher": {
    "sales_voucher_type": "Sales",
    "sales_ledger": "Sales Account"
  },
  "wake_word": "टॅली सुरू कर",
  "mode": "VOICE_BILLING",
  "writes_enabled": true
}
```

---

## File Structure

```
voice-billing/
├── config.json
├── main.py                 # Entry point
├── wake_detector.py        # Wake word detection
├── stt_engine.py           # Speech-to-text (Whisper)
├── tts_engine.py           # Text-to-speech (edge-tts)
├── tally_client.py         # Tally XML HTTP gateway client
├── fuzzy_matcher.py        # Fuzzy matching logic
├── billing_workflow.py     # Billing session state machine
├── command_parser.py       # Voice command parsing
├── session_manager.py      # Session lifecycle management
├── utils.py                # Helpers (normalize, logging)
├── logs/                   # Audio logs, draft bills
└── requirements.txt
```

---

## Dependencies

```txt
faster-whisper>=1.0.0
edge-tts>=6.0.0
sounddevice>=0.4.6
numpy>=1.24.0
scipy>=1.10.0
requests>=2.31.0
indic-transliteration>=1.1.5
pyodbc>=5.0.0  # optional, for ODBC fallback
```

---

## Testing Checklist

- [ ] Wake word detection accuracy (>95% in quiet env)
- [ ] STT accuracy for Marathi/Hindi/English mixed speech
- [ ] Fuzzy matching: exact, typo, partial, transliterated names
- [ ] Billing flow: complete 3-item bill with confirmations
- [ ] Final summary read-back accuracy
- [ ] Tally XML write: voucher created with correct data
- [ ] Error handling: Tally offline, network timeout, XML errors
- [ ] Session timeout: auto-sleep after 20s silence
- [ ] Safety: No write operations except final confirmed bill
- [ ] First live bill of each of the 4 types checked in Tally by the owner (ledgers, GST lines, stock effect), then cancelled/kept by hand
- [ ] Multi-language: Marathi, Hindi, English commands work

---

## Acceptance Criteria

1. **Wake word** "टॅली सुरू कर" activates system from idle
2. **Party selection** via voice with fuzzy match + confirmation
3. **Item entry** via voice with auto rate fetch + confirmation
4. **Quantity** parsed from speech (Marathi/Hindi/English numbers)
5. **Line confirmation** required before adding to bill
6. **Final summary** read back with total before save
7. **Explicit final confirmation** before XML POST to Tally
8. **Only new-voucher creation** (Sales, Purchase, Credit Note, Debit Note) as write operation
9. **Ledger inquiry** (balance/stock) read-only via voice
10. **Auto-sleep** after completion or 20s inactivity
11. **Clear error messages** for all failure modes

---

## Voucher Types

| Type | Party (group) | Item ledger (group) | Party | Item ledger / GST | Stock |
|------|---------------|---------------------|-------|-------------------|-------|
| Sales | Sundry Debtors | Sales Accounts | Dr | Cr | out |
| Purchase | Sundry Creditors | Purchase Accounts | Cr | Dr | in |
| Credit Note (sales return) | Sundry Debtors | Sales Accounts | Cr | Dr | in |
| Debit Note (purchase return) | Sundry Creditors | Purchase Accounts | Dr | Cr | out |

- Spoken names are fuzzy-matched against Tally (party only within its group). Ambiguous or unknown names are never guessed.
- A missing rate is filled from the **last sale rate** (Sales / Credit Note) or **last purchase rate** (Purchase / Debit Note) — a rate given to the same party wins. A spoken rate more than 50 % away from the last one produces a warning in the read-back.
- GST: item GST % comes from the stock item master; if Tally has none the assistant **asks** (it never guesses). CGST+SGST, or IGST when the party's state differs from `gst.company_state`. Tax ledgers are auto-found under *Duties & Taxes* or set in `config.json` (`gst.ledgers`).
- Every ledger used must already exist in Tally; if not, the draft is refused with the list of available ledgers (no master is ever created).
- Each step is appended to `logs/vouchers.jsonl` (draft, saved, rejected, error).

## Jarvis Integration

```
JARVIS (voice/chat)  ──prepareTallyVoucher──▶  billing_service.py (127.0.0.1:4300, token)  ──read-only──▶ Tally
        │                                              │
        └──── owner says "हो" (next message) ─confirmTallyVoucher──▶ confirm(): ONE new voucher ─Import─▶ Tally
```

- `jarvis-ai/backend/src/tools/tally.ts` holds the gate: a draft can be saved only (a) from a **later** request than the one that created it, (b) when the owner's **own** latest message is a plain yes (whole word; any "नाही/नको/रद्द" wins), (c) once. The model cannot confirm by itself.
- The bill read-back and the save result are spoken **verbatim** from the billing service (a small local model never paraphrases amounts).
- Billing works only for requests from the PC itself (no tunnel/proxy), because the JARVIS app also has shop-customer users. Off unless `TALLY_BILLING_ENABLED=true` in `jarvis-ai/backend/.env`.
- `billing_service.py` accepts only requests carrying `X-Billing-Token` (file `billing_token.txt`, created on first run) and no `Origin` header, so a web page cannot call it.
- `scripts/start-jarvis.ps1` starts the billing service when billing is enabled.

## Findings from the owner's Tally (read-only look, 15 Oct 2026) and what the engine does about them

- **Sales ledger depends on the item**: GST Fertilizer Sale / GST Pesticides Sales / GST Seed Sale / GST Others Sale. Each line posts to the ledger that item was last sold with (history), else by stock group (`voucher_types.sales.item_ledger_by_group`). Credit notes use the same ledgers. Purchase = `Purchase A/c`, debit note = `Purchase Return`.
- **Cash bills are common** (~21 % of recent sales name `Cash`, which sits under Cash-in-Hand): Cash is accepted as party for all four types.
- **Bills are rounded to the rupee through `R/o`** (Indirect Expenses; rounding up is a credit on a sales bill). `rounding` in config.
- **One CGST / SGST / IGST ledger each** (no Output/Input split): mixed slabs are added into one line per ledger, as in the owner's vouchers.
- **GST %** = item master, else its stock group (FERTILIZERS 5, Pesticides 18, Meliorate 12), else `gst.default_by_group` (SEEDS: 0 - seed-only sales carry no GST lines), else the assistant asks.
- **Batch-wise items (180 of 858) are refused** (`billing.batch_policy: refuse`) because the batch cannot be chosen by voice; set `primary` to post them on "Primary Batch". Items with unit "Not Applicable" (e.g. cash deposits) are refused.
- Tally stores rates **without GST**. A spoken rate is taken as that rate unless `billing.spoken_rate_includes_gst` is true (or Jarvis passes `rateIncludesGst`), in which case it is divided by (1 + GST %).
- Not yet confirmed by a real Import: Tally's acceptance of the XML (batch block, GST classification). Verify with one supervised bill per type.

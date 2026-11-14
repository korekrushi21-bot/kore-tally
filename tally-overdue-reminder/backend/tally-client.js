// Talks to Tally's built-in XML/HTTP server (Gateway of Tally must be open,
// with the HTTP server enabled - see ../README.md for the one-time setup).
// Every request below uses TALLYREQUEST=Export - this module only ever reads
// data out of Tally, it never sends an Import request, so it cannot modify
// anything in your Tally company.
//
// ARCHITECTURE NOTE: this was originally built around Tally's per-bill
// "bill-wise details" (a due date per invoice). Verified against a real
// TallyPrime company, that feature isn't in use here - ledgers carry a
// running balance with no bill-wise breakup. So instead: each customer's
// outstanding is their ledger CLOSINGBALANCE (one number), and "due date" is
// derived as (date of their most recent Sales invoice) + a configurable
// credit period in days (see config.json: interest.creditPeriodDays). This
// is a policy you apply, not something read from Tally.
//
// NOTE ON ACCURACY: Tally's exact XML tag names can differ a little between
// Tally.ERP 9 and TallyPrime. The requests/field-mapping below were checked
// against a live TallyPrime response. Use GET /api/debug/tally-raw (see
// server.js) if a field comes back empty/misnamed on your install.

const xml2js = require("xml2js");

function buildUrl(tallyConfig) {
  return `http://${tallyConfig.host}:${tallyConfig.port}`;
}

async function postToTally(tallyConfig, requestXml) {
  let res;
  try {
    res = await fetch(buildUrl(tallyConfig), {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: requestXml,
    });
  } catch {
    // Node's raw message here is just "fetch failed" - say what it means.
    const err = new Error(
      `Tally is not reachable at ${tallyConfig.host}:${tallyConfig.port} - is Tally open with its HTTP server enabled?`
    );
    err.code = "TALLY_UNREACHABLE";
    throw err;
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tally responded with HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// An empty <SVCURRENTCOMPANY></SVCURRENTCOMPANY> tag makes Tally look for a
// company literally named "" and silently return zero results - so when no
// company is configured, omit the tag entirely and let Tally use whichever
// company is currently open.
function staticVariablesXml(company, extra = "") {
  const companyTag = company ? `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>` : "";
  return `<STATICVARIABLES>${companyTag}${extra}</STATICVARIABLES>`;
}

// Ledgers under Sundry Debtors, including ones nested in sub-groups (e.g.
// customers grouped by village/area) - CHILDOF alone only matches direct
// children, BELONGSTO=Yes makes it recurse into sub-groups too.
function buildCustomerBalancesRequestXml(company) {
  return `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CustomerBalancesCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${staticVariablesXml(company)}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CustomerBalancesCollection" ISMODIFY="No">
            <TYPE>Ledger</TYPE>
            <CHILDOF>Sundry Debtors</CHILDOF>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>NAME, CLOSINGBALANCE, OPENINGBALANCE, LEDGERMOBILE, LEDGERPHONE</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

// All vouchers of one type (Sales or Purchase) in the lookback window (see
// config.json: interest.salesLookbackDays), across every party, in one
// request. Sales vouchers feed: each customer's most-recent-purchase date
// (for the due-date policy above), recent sale rates incl. GST, and the
// itemised "what did they buy" list for reminders. Purchase vouchers feed
// the purchase-rate side of the Item Rate lookup.
function buildVouchersRequestXml(company, voucherTypeName, fromDateYmd, toDateYmd) {
  const dateRangeVars = `<SVFROMDATE>${fromDateYmd}</SVFROMDATE><SVTODATE>${toDateYmd}</SVTODATE>`;
  return `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>VouchersCollection</ID>
  </HEADER>
  <BODY>
    <DESC>
      ${staticVariablesXml(company, dateRangeVars)}
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="VouchersCollection" ISMODIFY="No">
            <TYPE>Voucher</TYPE>
            <FILTER>IsTypeFilter</FILTER>
            <FETCH>DATE, PARTYLEDGERNAME, VOUCHERNUMBER, ALLINVENTORYENTRIES.LIST</FETCH>
            <FETCH>ALLINVENTORYENTRIES.STOCKITEMNAME, ALLINVENTORYENTRIES.RATE, ALLINVENTORYENTRIES.AMOUNT, ALLINVENTORYENTRIES.ACTUALQTY</FETCH>
            <FETCH>LEDGERENTRIES.LIST, LEDGERENTRIES.LEDGERNAME, LEDGERENTRIES.AMOUNT</FETCH>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="IsTypeFilter">$VoucherTypeName = "${escapeXml(voucherTypeName)}"</SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

// Tally emits numeric character references for control characters (e.g.
// "&#4;" as its internal "Not Applicable" placeholder) that are illegal in
// XML 1.0 and make strict parsers choke - drop any &#N;/&#xN; that points at
// a C0 control character (other than tab/LF/CR, which are legal).
function stripInvalidXmlEntities(xmlText) {
  return xmlText.replace(/&#x?[0-9a-fA-F]+;/g, (match) => {
    const isHex = /^&#x/i.test(match);
    const codeStr = match.slice(isHex ? 3 : 2, -1);
    const code = parseInt(codeStr, isHex ? 16 : 10);
    const isLegalControlChar = code === 9 || code === 10 || code === 13;
    const isControlChar = code < 32;
    return isControlChar && !isLegalControlChar ? "" : match;
  });
}

async function parseXml(xmlText) {
  return xml2js.parseStringPromise(stripInvalidXmlEntities(xmlText), {
    explicitArray: false,
    mergeAttrs: true,
    trim: true,
  });
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// With mergeAttrs:true, a leaf tag that has BOTH an attribute (Tally puts a
// TYPE="..." on almost every value field) AND text content parses to
// {_: "the text", TYPE: "..."} instead of a plain string - only bare
// attributes (like a LEDGER's NAME="...") merge cleanly to a plain string.
// Every value read from a Tally field below goes through this so both
// shapes work.
function textOf(node) {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "object") return node._;
  return node;
}

// Tally dates come back as YYYYMMDD.
function parseTallyDate(tallyDateStr) {
  const s = String(tallyDateStr).trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
}

function toYmd(date) {
  return date.toISOString().slice(0, 10);
}

function addDaysYmd(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toYmd(d);
}

function parseCustomerBalances(parsed) {
  const ledgers = asArray(parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.LEDGER);
  const customers = [];
  for (const ledger of ledgers) {
    const customerName = ledger.NAME || ledger.$?.NAME;
    const balance = Number(textOf(ledger.CLOSINGBALANCE) || 0);
    if (!customerName || !balance) continue; // skip nil/settled accounts
    const openingBalance = Number(textOf(ledger.OPENINGBALANCE) || 0);
    // Tally's XML export writes Debit balances as negative numbers, so a
    // Sundry Debtor who owes us has balance < 0; a positive one is an advance.
    // `owes` keeps that sign (balance itself stays absolute, as before).
    const mobile = textOf(ledger.LEDGERMOBILE) || textOf(ledger.LEDGERPHONE) || null;
    customers.push({
      customerName,
      balance: Math.abs(balance),
      openingBalance: Math.abs(openingBalance),
      owes: balance < 0,
      mobile: mobile ? String(mobile).trim() : null,
    });
  }
  return customers;
}

// Approximates the GST% for a voucher from its tax ledger entries (any
// ledger named CGST/SGST/IGST/GST) against the taxable (item) amount. This
// is a voucher-level average, not a per-item rate - fine when a voucher has
// one tax slab for all items (the common case, e.g. one GST-rated product
// category per invoice), but can be off for invoices mixing multiple GST
// rates. Flagged in README as a known limitation.
function estimateVoucherGstPercent(voucher, itemsTotal) {
  if (!itemsTotal) return null;
  const ledgerEntries = asArray(voucher.LEDGERENTRIES?.LIST || voucher["LEDGERENTRIES.LIST"]);
  let taxTotal = 0;
  for (const entry of ledgerEntries) {
    const name = String(textOf(entry.LEDGERNAME) || "").toUpperCase();
    if (/\b(CGST|SGST|IGST|GST|CESS)\b/.test(name)) {
      taxTotal += Math.abs(Number(textOf(entry.AMOUNT) || 0));
    }
  }
  if (!taxTotal) return null;
  return Math.round((taxTotal / itemsTotal) * 1000) / 10; // one decimal place
}

// Tally often formats RATE as "210.00/PCS" - strip the unit suffix.
function parseRateField(rateStr) {
  if (rateStr === undefined || rateStr === null) return null;
  const num = parseFloat(String(rateStr).split("/")[0]);
  return Number.isFinite(num) ? num : null;
}

// ACTUALQTY comes back like "20.00 Nos" (occasionally negative for outward
// stock movement) - split the leading number from the unit label.
function parseQtyField(qtyStr) {
  if (qtyStr === undefined || qtyStr === null) return { qty: null, unit: null };
  const m = /^(-?[\d.]+)\s*(.*)$/.exec(String(qtyStr).trim());
  if (!m) return { qty: null, unit: null };
  return { qty: Math.abs(parseFloat(m[1])), unit: m[2] || null };
}

function parseVoucherItems(voucher, gstPercent) {
  const entries = asArray(voucher.ALLINVENTORYENTRIES?.LIST || voucher["ALLINVENTORYENTRIES.LIST"]);
  return entries
    .filter((e) => textOf(e.STOCKITEMNAME))
    .map((e) => {
      const rate = parseRateField(textOf(e.RATE));
      const { qty, unit } = parseQtyField(textOf(e.ACTUALQTY));
      return {
        productName: textOf(e.STOCKITEMNAME),
        qty,
        unit,
        rate,
        gstPercent,
        rateInclGst: rate != null && gstPercent != null
          ? Math.round(rate * (1 + gstPercent / 100) * 100) / 100
          : null,
        amount: Math.abs(Number(textOf(e.AMOUNT) || 0)),
      };
    });
}

// The party's own ledger entry inside a voucher carries the full invoice
// value (items + GST) as it actually hit their account - more reliable than
// re-summing items + estimated tax, and needed to match invoices against a
// ledger's running balance.
function partyLedgerAmount(voucher, partyName) {
  const ledgerEntries = asArray(voucher.LEDGERENTRIES?.LIST || voucher["LEDGERENTRIES.LIST"]);
  const entry = ledgerEntries.find((e) => textOf(e.LEDGERNAME) === partyName);
  return entry ? Math.abs(Number(textOf(entry.AMOUNT) || 0)) : null;
}

// Normalizes the raw <VOUCHER> nodes into one flat, easy-to-query shape.
// `partyName` is whichever ledger is on the other side of the transaction -
// the customer for a Sales voucher, the supplier for a Purchase voucher.
function parseVouchers(parsed) {
  const vouchers = asArray(parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER);
  return vouchers
    .map((voucher) => {
      const dateStr = textOf(voucher.DATE);
      const parsedDate = dateStr ? parseTallyDate(dateStr) : null;
      const date = parsedDate ? toYmd(parsedDate) : null;
      const entries = asArray(voucher.ALLINVENTORYENTRIES?.LIST || voucher["ALLINVENTORYENTRIES.LIST"]);
      const itemsTotal = entries.reduce((sum, e) => sum + Math.abs(Number(textOf(e.AMOUNT) || 0)), 0);
      const gstPercent = estimateVoucherGstPercent(voucher, itemsTotal);
      const partyName = textOf(voucher.PARTYLEDGERNAME);
      const partyAmount = partyLedgerAmount(voucher, partyName);
      return {
        partyName,
        voucherNumber: textOf(voucher.VOUCHERNUMBER) || null,
        date,
        // Total invoice value including GST; falls back to the items+tax
        // sum if the party ledger entry couldn't be matched for some reason.
        total: partyAmount != null ? partyAmount : Math.round((itemsTotal + itemsTotal * ((gstPercent || 0) / 100)) * 100) / 100,
        items: parseVoucherItems(voucher, gstPercent),
      };
    })
    .filter((v) => v.partyName && v.date);
}

// Fetching every voucher of a type is the expensive call here, and several
// features need it - cache it briefly (rather than one fetch per click) so
// a burst of UI activity doesn't hammer Tally. Auto-refresh on the frontend
// runs every 30s, so a shorter TTL keeps this in step with that. Sales and
// Purchase are cached separately (different cache key).
const VOUCHER_CACHE_TTL_MS = 20_000;
const voucherCacheByType = new Map(); // voucherTypeName -> { key, timestamp, vouchers }

async function getVouchers(tallyConfig, voucherTypeName, lookbackDays) {
  const toDate = toYmd(new Date());
  const fromDate = addDaysYmd(toDate, -lookbackDays);
  const cacheKey = `${tallyConfig.host}:${tallyConfig.port}:${tallyConfig.company}:${fromDate}:${toDate}`;
  const cached = voucherCacheByType.get(voucherTypeName);

  if (cached && cached.key === cacheKey && Date.now() - cached.timestamp < VOUCHER_CACHE_TTL_MS) {
    return cached.vouchers;
  }

  const requestXml = buildVouchersRequestXml(tallyConfig.company, voucherTypeName, fromDate, toDate);
  const responseXml = await postToTally(tallyConfig, requestXml);
  const parsed = await parseXml(responseXml);
  const vouchers = parseVouchers(parsed);

  voucherCacheByType.set(voucherTypeName, { key: cacheKey, timestamp: Date.now(), vouchers });
  return vouchers;
}

function groupVouchersByParty(vouchers) {
  const map = new Map();
  for (const v of vouchers) {
    if (!map.has(v.partyName)) map.set(v.partyName, []);
    map.get(v.partyName).push(v);
  }
  for (const list of map.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));
  return map;
}

// Tally doesn't track which specific bill(s) make up a customer's current
// balance here (no bill-wise details - see module header), so this
// approximates it with the standard FIFO assumption: whatever's been paid
// off cleared the OLDEST debt first. Walks the customer's opening balance
// (if any, anchored at `openingDate`) then each Sales invoice oldest to
// newest, treats (everything traced - current balance) as "paid off"
// starting from the oldest entry, and returns whatever's left unpaid on
// each entry - each with its own date, so interest can be computed per
// bill instead of once on the lump balance. If the traced total doesn't
// reach the actual balance (e.g. a Journal-based charge with no invoice
// behind it, or GST-estimate rounding), the shortfall becomes one extra
// "Other charges" entry so the bills still sum to the balance exactly.
function allocateBillsFifo(customer, invoices, openingDate) {
  const entries = [];
  if (customer.openingBalance) {
    entries.push({ label: "Opening balance", date: openingDate, voucherNumber: null, amount: customer.openingBalance });
  }
  for (const inv of invoices) {
    entries.push({ label: `Bill ${inv.voucherNumber || "-"}`, date: inv.date, voucherNumber: inv.voucherNumber, amount: inv.total });
  }

  const totalTraced = entries.reduce((sum, e) => sum + e.amount, 0);
  let paidOff = totalTraced - customer.balance;

  const bills = [];
  for (const entry of entries) {
    const cleared = Math.min(entry.amount, Math.max(paidOff, 0));
    paidOff -= cleared;
    const outstanding = Math.round((entry.amount - cleared) * 100) / 100;
    if (outstanding > 0.005) bills.push({ ...entry, amount: outstanding });
  }

  const tracedOutstanding = bills.reduce((sum, b) => sum + b.amount, 0);
  const shortfall = Math.round((customer.balance - tracedOutstanding) * 100) / 100;
  if (shortfall > 0.005) {
    const lastDate = entries.length ? entries[entries.length - 1].date : openingDate;
    bills.push({ label: "Other charges (untracked)", date: lastDate, voucherNumber: null, amount: shortfall });
  }

  return bills;
}

// One row per customer with a non-zero balance: their outstanding amount
// (from Tally, live), their most recent purchase date, an overall due date
// (for the summary card), and a FIFO-estimated bill-wise breakdown (see
// allocateBillsFifo) so interest can be shown per bill. Some customers
// carry a balance with no Sales voucher behind it at all (an old balance
// carried forward from before this data was entered) - for those there's
// no purchase date to anchor to, so we fall back to the earliest Sales
// voucher date found anywhere in the data (effectively "the start of what
// we can see in Tally") + creditPeriodDays, so they still get a due date
// instead of being silently left off the overdue list.
async function fetchOverdueCustomers(tallyConfig, creditPeriodDays, lookbackDays) {
  const [balancesXml, vouchers] = await Promise.all([
    (async () => {
      const requestXml = buildCustomerBalancesRequestXml(tallyConfig.company);
      const responseXml = await postToTally(tallyConfig, requestXml);
      return parseXml(responseXml);
    })(),
    getVouchers(tallyConfig, "Sales", lookbackDays),
  ]);

  const customers = parseCustomerBalances(balancesXml);
  const vouchersByCustomer = groupVouchersByParty(vouchers);

  let earliestVoucherDate = null;
  for (const v of vouchers) {
    if (!earliestVoucherDate || v.date < earliestVoucherDate) earliestVoucherDate = v.date;
  }

  return customers.map((c) => {
    const custVouchers = vouchersByCustomer.get(c.customerName) || [];
    const lastSaleDate = custVouchers.length ? custVouchers[custVouchers.length - 1].date : null;
    const dueDateAnchor = lastSaleDate || earliestVoucherDate;
    const bills = allocateBillsFifo(c, custVouchers, earliestVoucherDate).map((b) => ({
      ...b,
      dueDate: b.date ? addDaysYmd(b.date, creditPeriodDays) : null,
    }));
    return {
      ...c,
      lastSaleDate,
      dueDate: dueDateAnchor ? addDaysYmd(dueDateAnchor, creditPeriodDays) : null,
      bills,
    };
  });
}

async function fetchRecentProductRates(tallyConfig, customerLedgerName, lookbackDays) {
  const vouchers = await getVouchers(tallyConfig, "Sales", lookbackDays);
  const rates = new Map(); // stockItemName -> latest {rate, gstPercent, rateInclGst, voucherDate}

  for (const v of vouchers) {
    if (v.partyName !== customerLedgerName) continue;
    for (const item of v.items) {
      const existing = rates.get(item.productName);
      if (!existing || v.date > existing.voucherDate) {
        rates.set(item.productName, { ...item, voucherDate: v.date });
      }
    }
  }

  return Array.from(rates.values()).map(({ productName, rate, gstPercent, rateInclGst, voucherDate }) => ({
    productName,
    rate,
    gstPercent,
    rateInclGst,
    voucherDate,
  }));
}

// Most recent rate per product across a list of vouchers, keeping track of
// which party (customer for Sales, supplier for Purchase) it was last
// transacted with. Shared by the two "Item Rate" lookups below.
function latestRatesByProduct(vouchers) {
  const rates = new Map(); // stockItemName -> latest {..., voucherDate, lastParty}

  for (const v of vouchers) {
    for (const item of v.items) {
      const existing = rates.get(item.productName);
      if (!existing || v.date > existing.voucherDate) {
        rates.set(item.productName, { ...item, voucherDate: v.date, lastParty: v.partyName });
      }
    }
  }

  return Array.from(rates.values()).sort((a, b) => a.productName.localeCompare(b.productName));
}

// Most recent rate for every product sold to anyone, for the standalone
// "Item Rate" lookup (not scoped to one customer).
async function fetchAllProductRates(tallyConfig, lookbackDays) {
  const vouchers = await getVouchers(tallyConfig, "Sales", lookbackDays);
  return latestRatesByProduct(vouchers).map(
    ({ productName, rate, gstPercent, rateInclGst, voucherDate, lastParty }) => ({
      productName,
      rate,
      gstPercent,
      rateInclGst,
      voucherDate,
      lastCustomer: lastParty,
    })
  );
}

// Most recent rate you *paid* for every product, from Purchase vouchers -
// the "khareedi rate" (purchase rate) side of the Item Rate lookup.
async function fetchAllProductPurchaseRates(tallyConfig, lookbackDays) {
  const vouchers = await getVouchers(tallyConfig, "Purchase", lookbackDays);
  return latestRatesByProduct(vouchers).map(
    ({ productName, rate, gstPercent, rateInclGst, voucherDate, lastParty }) => ({
      productName,
      rate,
      gstPercent,
      rateInclGst,
      voucherDate,
      supplier: lastParty,
    })
  );
}

// Every invoice on file for one customer (within salesLookbackDays, which
// defaults to ~10 years - effectively "all of them"), newest first, each
// with its line items - used for "what did they buy" in a reminder without
// exposing rates, and for showing the customer's full bill history.
async function fetchRecentInvoices(tallyConfig, customerLedgerName, lookbackDays) {
  const vouchers = await getVouchers(tallyConfig, "Sales", lookbackDays);
  return vouchers
    .filter((v) => v.partyName === customerLedgerName)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

// For debugging against a real Tally: returns the raw XML response text
// unmodified, so you can inspect actual tag names in your Tally version.
async function fetchRaw(tallyConfig, which, lookbackDays) {
  if (which === "vouchers" || which === "purchase-vouchers") {
    const toDate = toYmd(new Date());
    const fromDate = addDaysYmd(toDate, -lookbackDays);
    const voucherTypeName = which === "purchase-vouchers" ? "Purchase" : "Sales";
    return postToTally(tallyConfig, buildVouchersRequestXml(tallyConfig.company, voucherTypeName, fromDate, toDate));
  }
  return postToTally(tallyConfig, buildCustomerBalancesRequestXml(tallyConfig.company));
}

module.exports = {
  fetchOverdueCustomers,
  fetchRecentProductRates,
  fetchAllProductRates,
  fetchAllProductPurchaseRates,
  fetchRecentInvoices,
  fetchRaw,
  allocateBillsFifo,
  addDaysYmd,
  getVouchers,
};

// Read-only access to Tally's XML/HTTP server. Every request here is
// TALLYREQUEST=Export - this module never sends an Import request, so it
// cannot add, change or delete anything in your Tally company.
//
// The collections used (Voucher, Ledger, Group, StockItem, VoucherType with
// inline TDL) work on both TallyPrime and Tally.ERP 9.

const xml2js = require("xml2js");

const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map(); // key -> { at, value }

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function clearCache() {
  cache.clear();
}

async function postToTally(tallyConfig, requestXml) {
  let res;
  try {
    res = await fetch(`http://${tallyConfig.host}:${tallyConfig.port}`, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: requestXml,
    });
  } catch {
    const err = new Error(
      `Tally ${tallyConfig.host}:${tallyConfig.port} var sapadla nahi - Tally chalu aahe ka ani HTTP server (port ${tallyConfig.port}) on aahe ka te bagha.`
    );
    err.code = "TALLY_UNREACHABLE";
    throw err;
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Tally ne HTTP ${res.status} dila: ${text.slice(0, 300)}`);
  return text;
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// An empty <SVCURRENTCOMPANY/> makes Tally look for a company named "" and
// return nothing - omit it so Tally uses whichever company is open.
function staticVars(company, extra = "") {
  const companyTag = company ? `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>` : "";
  return `<STATICVARIABLES>${companyTag}${extra}</STATICVARIABLES>`;
}

function collectionRequest(company, name, type, fetchLines, extraVars = "", extraTdl = "") {
  return `<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${name}</ID></HEADER>
  <BODY><DESC>
    ${staticVars(company, extraVars)}
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="${name}" ISMODIFY="No">
        <TYPE>${type}</TYPE>
        ${fetchLines.map((f) => `<FETCH>${f}</FETCH>`).join("\n        ")}
      </COLLECTION>
      ${extraTdl}
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`;
}

// Tally emits &#4; etc. (control characters) that are illegal in XML 1.0.
function stripInvalidXmlEntities(xmlText) {
  return xmlText.replace(/&#x?[0-9a-fA-F]+;/g, (m) => {
    const isHex = /^&#x/i.test(m);
    const code = parseInt(m.slice(isHex ? 3 : 2, -1), isHex ? 16 : 10);
    return code < 32 && code !== 9 && code !== 10 && code !== 13 ? "" : m;
  });
}

async function requestCollection(tallyConfig, xml, nodeName) {
  const text = await postToTally(tallyConfig, xml);
  const parsed = await xml2js.parseStringPromise(stripInvalidXmlEntities(text), {
    explicitArray: false,
    mergeAttrs: true,
    trim: true,
  });
  return asArray(parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION?.[nodeName]);
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// A leaf with both an attribute and text parses to {_: text, TYPE: ...}.
function textOf(node) {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "object") return node._;
  return node;
}

function num(node) {
  const n = parseFloat(String(textOf(node) ?? "0").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// "20.00 Bag" / "-20 Nos" -> { qty: 20, unit: "Bag" }. Sign is dropped;
// direction comes from the voucher type instead.
function parseQty(node) {
  const m = /^(-?[\d.,]+)\s*(.*)$/.exec(String(textOf(node) ?? "").trim());
  if (!m) return { qty: 0, unit: "" };
  return { qty: Math.abs(parseFloat(m[1].replace(/,/g, ""))) || 0, unit: m[2] || "" };
}

function parseRate(node) {
  const n = parseFloat(String(textOf(node) ?? "").split("/")[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function tallyDate(d) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(textOf(d) ?? "").trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function ymdToTally(ymd) {
  return ymd.replace(/-/g, "");
}

function listOf(node, key) {
  return asArray(node[`${key}.LIST`] || node[key]?.LIST);
}

// ---------- masters ----------

async function getVoucherTypes(cfg) {
  return cached(`vt:${cfg.company}`, async () => {
    const rows = await requestCollection(
      cfg,
      collectionRequest(cfg.company, "PrashnaVchTypes", "VoucherType", ["NAME, PARENT"]),
      "VOUCHERTYPE"
    );
    const parentOf = new Map(rows.map((r) => [r.NAME, textOf(r.PARENT) || ""]));
    // Walk up the chain to the built-in base type (e.g. "Delivery Challan"
    // -> "Delivery Note").
    const baseOf = (name) => {
      let cur = name;
      for (let i = 0; i < 10; i++) {
        const p = parentOf.get(cur);
        if (!p || p === cur) return cur;
        cur = p;
      }
      return cur;
    };
    return rows.map((r) => ({ name: r.NAME, parent: textOf(r.PARENT) || "", baseType: baseOf(r.NAME) }));
  });
}

async function getGroups(cfg) {
  return cached(`grp:${cfg.company}`, async () => {
    const rows = await requestCollection(
      cfg,
      collectionRequest(cfg.company, "PrashnaGroups", "Group", ["NAME, PARENT"]),
      "GROUP"
    );
    return rows.map((r) => ({ name: r.NAME, parent: textOf(r.PARENT) || "" }));
  });
}

async function getLedgers(cfg) {
  return cached(`led:${cfg.company}`, async () => {
    const [rows, groups] = await Promise.all([
      requestCollection(
        cfg,
        collectionRequest(cfg.company, "PrashnaLedgers", "Ledger", ["NAME, PARENT, OPENINGBALANCE, CLOSINGBALANCE"]),
        "LEDGER"
      ),
      getGroups(cfg),
    ]);
    const groupParent = new Map(groups.map((g) => [g.name, g.parent]));
    const groupChain = (g) => {
      const chain = [];
      let cur = g;
      for (let i = 0; cur && i < 15; i++) {
        chain.push(cur);
        const p = groupParent.get(cur);
        if (!p || p === cur || p === "Primary") break;
        cur = p;
      }
      return chain;
    };
    return rows.map((r) => {
      const group = textOf(r.PARENT) || "";
      return {
        name: r.NAME,
        group,
        groupChain: groupChain(group),
        // Tally XML: negative = Debit, positive = Credit.
        opening: num(r.OPENINGBALANCE),
        closing: num(r.CLOSINGBALANCE),
      };
    });
  });
}

async function getStockItems(cfg) {
  return cached(`stk:${cfg.company}`, async () => {
    const rows = await requestCollection(
      cfg,
      collectionRequest(cfg.company, "PrashnaStock", "StockItem", ["NAME, PARENT, BASEUNITS, CLOSINGBALANCE, CLOSINGVALUE, CLOSINGRATE"]),
      "STOCKITEM"
    );
    return rows.map((r) => {
      const { qty, unit } = parseQty(r.CLOSINGBALANCE);
      const signed = String(textOf(r.CLOSINGBALANCE) ?? "").trim().startsWith("-") ? -qty : qty;
      return {
        name: r.NAME,
        group: textOf(r.PARENT) || "",
        unit: unit || textOf(r.BASEUNITS) || "",
        closingQty: signed,
        closingValue: Math.abs(num(r.CLOSINGVALUE)),
        closingRate: parseRate(r.CLOSINGRATE),
      };
    });
  });
}

// ---------- vouchers ----------

// Tally sends the same lines under both ALL...ENTRIES and ...ENTRIES on
// some vouchers - use the ALL list when present, else the other.
function preferred(v, key) {
  const all = listOf(v, `ALL${key}`);
  return all.length ? all : listOf(v, key);
}

function parseInventory(v) {
  const entries = preferred(v, "INVENTORYENTRIES");
  return entries
    .filter((e) => textOf(e.STOCKITEMNAME))
    .map((e) => {
      const { qty, unit } = parseQty(e.ACTUALQTY || e.BILLEDQTY);
      const tracking = listOf(e, "BATCHALLOCATIONS")
        .map((b) => ({ trackingNumber: textOf(b.TRACKINGNUMBER) || "", qty: parseQty(b.ACTUALQTY || b.BILLEDQTY).qty }))
        .filter((b) => b.trackingNumber && !/^not applicable$/i.test(b.trackingNumber));
      return {
        item: textOf(e.STOCKITEMNAME),
        qty,
        unit,
        rate: parseRate(e.RATE),
        amount: Math.abs(num(e.AMOUNT)),
        tracking,
      };
    });
}

function parseLedgerEntries(v) {
  return preferred(v, "LEDGERENTRIES")
    .filter((e) => textOf(e.LEDGERNAME))
    .map((e) => ({ ledger: textOf(e.LEDGERNAME), amount: num(e.AMOUNT) }));
}

async function getVouchers(cfg, fromYmd, toYmd) {
  return cached(`vch:${cfg.company}:${fromYmd}:${toYmd}`, async () => {
    const rows = await requestCollection(
      cfg,
      collectionRequest(
        cfg.company,
        "PrashnaVouchers",
        "Voucher",
        [
          "DATE, VOUCHERTYPENAME, VOUCHERNUMBER, PARTYLEDGERNAME, NARRATION, REFERENCE, ISCANCELLED, ISOPTIONAL",
          "ALLINVENTORYENTRIES.LIST, ALLINVENTORYENTRIES.STOCKITEMNAME, ALLINVENTORYENTRIES.ACTUALQTY, ALLINVENTORYENTRIES.BILLEDQTY, ALLINVENTORYENTRIES.RATE, ALLINVENTORYENTRIES.AMOUNT",
          "ALLINVENTORYENTRIES.BATCHALLOCATIONS.LIST, ALLINVENTORYENTRIES.BATCHALLOCATIONS.TRACKINGNUMBER, ALLINVENTORYENTRIES.BATCHALLOCATIONS.ACTUALQTY",
          "INVENTORYENTRIES.LIST, INVENTORYENTRIES.STOCKITEMNAME, INVENTORYENTRIES.ACTUALQTY, INVENTORYENTRIES.RATE, INVENTORYENTRIES.AMOUNT",
          "ALLLEDGERENTRIES.LIST, ALLLEDGERENTRIES.LEDGERNAME, ALLLEDGERENTRIES.AMOUNT",
          "LEDGERENTRIES.LIST, LEDGERENTRIES.LEDGERNAME, LEDGERENTRIES.AMOUNT",
        ],
        `<SVFROMDATE>${ymdToTally(fromYmd)}</SVFROMDATE><SVTODATE>${ymdToTally(toYmd)}</SVTODATE>`
      ),
      "VOUCHER"
    );
    return rows
      .filter((v) => String(textOf(v.ISCANCELLED) || "No") !== "Yes" && String(textOf(v.ISOPTIONAL) || "No") !== "Yes")
      .map((v) => {
        const ledgerEntries = parseLedgerEntries(v);
        const items = parseInventory(v);
        const party = textOf(v.PARTYLEDGERNAME) || "";
        // GST factor for the whole bill: (items + GST tax ledgers) / items.
        // Only tax ledgers count, so hamali / freight / round-off on the
        // bill don't inflate item rates. A bill mixing GST slabs gets an
        // average factor.
        const itemsTotal = items.reduce((s, it) => s + it.amount, 0);
        const taxTotal = ledgerEntries
          .filter((e) => /\b(cgst|sgst|utgst|igst|gst|cess)\b/i.test(e.ledger) && !/sale|purchase/i.test(e.ledger))
          .reduce((s, e) => s + Math.abs(e.amount), 0);
        const ratio = itemsTotal ? (itemsTotal + taxTotal) / itemsTotal : 1;
        const gstFactor = ratio <= 1.3 ? ratio : 1;
        return {
          gstFactor,
          date: tallyDate(v.DATE),
          type: textOf(v.VOUCHERTYPENAME) || v.VCHTYPE || "",
          number: textOf(v.VOUCHERNUMBER) || "",
          party: party || (ledgerEntries[0] && ledgerEntries[0].ledger) || "",
          narration: textOf(v.NARRATION) || "",
          reference: textOf(v.REFERENCE) || "",
          items,
          ledgerEntries,
        };
      })
      // Tally normally applies SVFROMDATE/SVTODATE itself; filter again in
      // case a version or TDL setting ignores them.
      .filter((v) => v.date && v.date >= fromYmd && v.date <= toYmd);
  });
}

module.exports = {
  getVoucherTypes,
  getGroups,
  getLedgers,
  getStockItems,
  getVouchers,
  clearCache,
  postToTally,
};

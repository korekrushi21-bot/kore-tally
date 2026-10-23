// Search functions over Tally data. Used both by the Claude AI mode (as
// tools) and by the offline keyword mode, so both give the same numbers.

const tally = require("./tally");

// Built-in Tally voucher types that move goods without a bill (invoice).
// Custom types like "Delivery Challan" are caught via their base type.
const WITHOUT_BILL_BASE = {
  "Delivery Note": "out",
  "Rejections Out": "out",
  "Material Out": "out",
  "Receipt Note": "in",
  "Rejections In": "in",
  "Material In": "in",
};
const WITHOUT_BILL_NAME_RE = /challan|chalan|without\s*bill|w\/?o\s*bill|kach+i|rough/i;

const MAX_ROWS = 200;

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ]+/g, "");
}

// "urea" matches "UREA 45 KG"; "ram patil" matches "Patil Ram Shankar".
// `query` may also be a list of exact names (offline mode passes the names
// it already matched).
function matches(name, query) {
  if (!query) return true;
  if (Array.isArray(query)) return query.includes(name);
  const n = norm(name);
  if (n.includes(norm(query))) return true;
  const words = String(query).toLowerCase().split(/\s+/).map(norm).filter(Boolean);
  return words.length > 1 && words.every((w) => n.includes(w));
}

// "dhanraj patil" also matches "Dhanraj Biradar(Raosaheb Patil)" - the Patil in the brackets is
// somebody else's name, and so is a Patil that only shows up in the village after the comma. When
// some of the rows match on the plain name itself, keep only those, so the obvious answer doesn't
// come with lookalikes. If none do, nothing is dropped - "pandurang khatake" still finds
// "Pandurang Patil(Khatake),Bolegaon".
function preferDirectNames(rows, query, getName) {
  if (!query || Array.isArray(query) || rows.length < 2) return rows;
  const qWords = String(query).toLowerCase().split(/\s+/).map(norm).filter(Boolean);
  if (qWords.length < 2) return rows;
  const plain = (n) => norm(String(n).split(",")[0].replace(/\([^)]*\)/g, " "));
  const direct = rows.filter((r) => {
    const p = plain(getName(r));
    return qWords.every((w) => p.includes(w));
  });
  return direct.length ? direct : rows;
}

// The same narrowing for voucher searches: a typed-in party name is turned into the exact party
// names it should mean, so one customer's search doesn't pull in a lookalike's vouchers.
function partyFilter(vouchers, party, withLedgers = false) {
  if (!party || Array.isArray(party)) return party;
  const pool = new Set();
  for (const v of vouchers) {
    if (v.party) pool.add(v.party);
    if (withLedgers) for (const e of v.ledgerEntries) if (e.ledger) pool.add(e.ledger);
  }
  const names = [...pool].filter((n) => matches(n, party));
  if (names.length < 2) return party;
  const kept = preferDirectNames(
    names.map((name) => ({ name })),
    party,
    (r) => r.name
  ).map((r) => r.name);
  return kept.length === names.length ? party : kept;
}

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgoYmd(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateRange(cfg, from, to) {
  return {
    from: from || daysAgoYmd(cfg.defaultLookbackDays || 730),
    to: to || todayYmd(),
  };
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

async function voucherTypeInfo(cfg) {
  const types = await tally.getVoucherTypes(cfg);
  const info = new Map();
  for (const t of types) {
    let withoutBill = null;
    if (WITHOUT_BILL_BASE[t.baseType]) withoutBill = WITHOUT_BILL_BASE[t.baseType];
    else if (WITHOUT_BILL_NAME_RE.test(t.name)) withoutBill = /receipt|in\b|inward/i.test(t.name) ? "in" : "out";
    info.set(t.name, { ...t, withoutBill });
  }
  return info;
}

// ---------- tools ----------

async function listNames(cfg, { kind, contains }) {
  let names;
  if (kind === "items") names = (await tally.getStockItems(cfg)).map((i) => i.name);
  else if (kind === "ledgers") names = (await tally.getLedgers(cfg)).map((l) => l.name);
  else if (kind === "groups") names = (await tally.getGroups(cfg)).map((g) => g.name);
  else if (kind === "voucher_types") {
    const info = await voucherTypeInfo(cfg);
    return {
      voucherTypes: [...info.values()]
        .filter((t) => matches(t.name, contains))
        .map((t) => ({ name: t.name, baseType: t.baseType, withoutBill: Boolean(t.withoutBill) })),
    };
  } else throw new Error(`Unknown kind: ${kind}`);
  const hits = names.filter((n) => matches(n, contains)).sort();
  return { count: hits.length, names: hits.slice(0, 300), truncated: hits.length > 300 };
}

// Goods given/received without a bill (Delivery Note, Receipt Note, challan
// etc.), with how much of each has since been billed. Billing is matched
// through Tally's tracking number (the "Tracking No." chosen when a Sales /
// Purchase invoice is made against a delivery/receipt note).
async function withoutBill(cfg, { item, party, from, to, pendingOnly }) {
  const range = dateRange(cfg, from, to);
  const [info, vouchers] = await Promise.all([voucherTypeInfo(cfg), tally.getVouchers(cfg, range.from, range.to)]);
  party = partyFilter(vouchers, party);

  // tracking number + party + item -> qty billed on Sales/Purchase invoices
  const billed = new Map();
  for (const v of vouchers) {
    const t = info.get(v.type);
    if (!t || !["Sales", "Purchase", "Credit Note", "Debit Note"].includes(t.baseType)) continue;
    for (const it of v.items) {
      for (const tr of it.tracking) {
        const key = `${tr.trackingNumber}|${v.party}|${it.item}`;
        billed.set(key, (billed.get(key) || 0) + (tr.qty || it.qty));
      }
    }
  }

  const rows = [];
  for (const v of vouchers) {
    const t = info.get(v.type);
    if (!t || !t.withoutBill) continue;
    if (!matches(v.party, party)) continue;
    for (const it of v.items) {
      if (!matches(it.item, item)) continue;
      let billedQty = null;
      let status = "mahit nahi (tracking no. nahi)";
      if (it.tracking.length) {
        billedQty = 0;
        for (const tr of it.tracking) billedQty += billed.get(`${tr.trackingNumber}|${v.party}|${it.item}`) || 0;
        billedQty = Math.min(billedQty, it.qty);
        status = billedQty <= 0 ? "bill baki" : billedQty >= it.qty ? "bill zala" : "ardhavat bill";
      }
      const pendingQty = billedQty === null ? it.qty : round(it.qty - billedQty, 3);
      if (pendingOnly && billedQty !== null && pendingQty <= 0) continue;
      rows.push({
        date: v.date,
        voucherType: v.type,
        direction: t.withoutBill === "in" ? "aavak (mal aala)" : "javak (mal dila)",
        voucherNo: v.number,
        party: v.party,
        item: it.item,
        qty: it.qty,
        unit: it.unit,
        rate: it.rate,
        amount: it.amount,
        billedQty,
        pendingQty,
        status,
        narration: v.narration,
      });
    }
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.party.localeCompare(b.party) || a.voucherNo.localeCompare(b.voucherNo));

  // party + item totals
  const summaryMap = new Map();
  for (const r of rows) {
    const key = `${r.party}|${r.item}|${r.direction}`;
    const s = summaryMap.get(key) || { party: r.party, item: r.item, direction: r.direction, unit: r.unit, entries: 0, qty: 0, pendingQty: 0, amount: 0 };
    s.entries += 1;
    s.qty = round(s.qty + r.qty, 3);
    s.pendingQty = round(s.pendingQty + r.pendingQty, 3);
    s.amount = round(s.amount + r.amount);
    summaryMap.set(key, s);
  }
  const summary = [...summaryMap.values()].sort(
    (a, b) => b.pendingQty - a.pendingQty || a.party.localeCompare(b.party) || a.item.localeCompare(b.item)
  );

  const withoutBillTypes = [...info.values()].filter((t) => t.withoutBill).map((t) => t.name);
  return {
    dateRange: range,
    withoutBillVoucherTypes: withoutBillTypes,
    summaryByPartyAndItem: summary,
    entryCount: rows.length,
    entries: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS,
  };
}

async function searchVouchers(cfg, { item, party, voucherType, text, from, to, limit }) {
  const range = dateRange(cfg, from, to);
  const vouchers = await tally.getVouchers(cfg, range.from, range.to);
  party = partyFilter(vouchers, party, true);
  const max = Math.min(limit || 100, MAX_ROWS);
  const hits = [];
  for (const v of vouchers) {
    if (voucherType && !matches(v.type, voucherType)) continue;
    if (party && !matches(v.party, party) && !v.ledgerEntries.some((e) => matches(e.ledger, party))) continue;
    if (text && !matches(`${v.narration} ${v.reference} ${v.number}`, text)) continue;
    const items = item ? v.items.filter((it) => matches(it.item, item)) : v.items;
    if (item && !items.length) continue;
    hits.push({
      date: v.date,
      voucherType: v.type,
      voucherNo: v.number,
      party: v.party,
      narration: v.narration,
      items: items.map(({ item, qty, unit, rate, amount }) => ({ item, qty, unit, rate, amount })),
      ledgerEntries: v.ledgerEntries.map((e) => ({ ledger: e.ledger, amount: Math.abs(e.amount), drCr: e.amount < 0 ? "Dr" : "Cr" })),
    });
  }
  hits.sort((a, b) => (a.date < b.date ? 1 : -1));

  // quick totals per voucher type for the matched item
  const totals = {};
  for (const h of hits) {
    const t = (totals[h.voucherType] ||= { vouchers: 0, qty: 0, amount: 0 });
    t.vouchers += 1;
    for (const it of h.items) {
      t.qty = round(t.qty + it.qty, 3);
      t.amount = round(t.amount + it.amount);
    }
  }
  return { dateRange: range, matchCount: hits.length, totalsByVoucherType: totals, vouchers: hits.slice(0, max), truncated: hits.length > max };
}

// Estimated profit on sales, the way the shop counts it: rate sold to the
// customer (incl. GST) minus the item's purchase rate (incl. GST, average
// over Purchase bills). Items never purchased in the data fall back to
// Tally's stock valuation rate (which is excl. GST); if that's missing too
// they're listed as "no cost".
async function profit(cfg, { party, item, from, to }) {
  const range = dateRange(cfg, from, to);
  const costRange = dateRange(cfg); // purchases over the full lookback, not just the sales period
  const [info, sales, purchases, stock] = await Promise.all([
    voucherTypeInfo(cfg),
    tally.getVouchers(cfg, range.from, range.to),
    tally.getVouchers(cfg, costRange.from, range.to),
    tally.getStockItems(cfg),
  ]);
  party = partyFilter(sales, party);

  const buy = new Map(); // item -> { qty, amount }
  for (const v of purchases) {
    const t = info.get(v.type);
    if (!t || t.baseType !== "Purchase") continue;
    for (const it of v.items) {
      if (!it.qty || !it.amount) continue;
      const b = buy.get(it.item) || { qty: 0, amount: 0 };
      b.qty += it.qty;
      b.amount += it.amount * v.gstFactor; // incl. GST
      buy.set(it.item, b);
    }
  }
  const stockRate = new Map(stock.map((s) => [s.name, s.closingRate]));

  const rows = new Map(); // item -> totals
  const vouchers = new Set();
  for (const v of sales) {
    const t = info.get(v.type);
    const sign = t && t.baseType === "Sales" ? 1 : t && t.baseType === "Credit Note" ? -1 : 0; // credit note = sales return
    if (!sign) continue;
    if (!matches(v.party, party)) continue;
    for (const it of v.items) {
      if (!matches(it.item, item) || !it.qty) continue;
      vouchers.add(`${v.type}#${v.number}`);
      const r = rows.get(it.item) || { item: it.item, unit: it.unit, qty: 0, saleAmount: 0, exclAmount: 0 };
      r.qty += sign * it.qty;
      r.saleAmount += sign * it.amount * v.gstFactor; // incl. GST
      r.exclAmount += sign * it.amount;
      rows.set(it.item, r);
    }
  }

  let totalSale = 0;
  let totalCost = 0;
  const noCost = [];
  const out = [];
  for (const r of rows.values()) {
    const b = buy.get(r.item);
    let costRate = b && b.qty ? b.amount / b.qty : null;
    let costSource = "kharedi sarasari";
    if (costRate == null && stockRate.get(r.item) > 0) {
      // Tally's stock rate is excl. GST - add the same GST % this item
      // carried on its sale bills (same item, same slab).
      const itemGst = r.exclAmount ? r.saleAmount / r.exclAmount : 1;
      costRate = stockRate.get(r.item) * itemGst;
      costSource = "Tally stock rate + GST (kharedi bill nahi)";
    }
    const row = {
      item: r.item,
      unit: r.unit,
      qty: round(r.qty, 3),
      saleAmount: round(r.saleAmount),
      saleRate: r.qty ? round(r.saleAmount / r.qty) : null,
      costRate: costRate == null ? null : round(costRate),
      costSource: costRate == null ? "kharedi rate nahi" : costSource,
      cost: costRate == null ? null : round(costRate * r.qty),
      profit: costRate == null ? null : round(r.saleAmount - costRate * r.qty),
    };
    row.marginPercent = row.profit != null && row.saleAmount ? round((row.profit / row.saleAmount) * 100, 1) : null;
    if (row.profit == null) noCost.push(r.item);
    else {
      totalSale += row.saleAmount;
      totalCost += row.cost;
    }
    out.push(row);
  }
  out.sort((a, b) => (b.profit ?? -Infinity) - (a.profit ?? -Infinity) || a.item.localeCompare(b.item));

  return {
    dateRange: range,
    voucherCount: vouchers.size,
    totalSaleWithCost: round(totalSale),
    totalCost: round(totalCost),
    totalProfit: round(totalSale - totalCost),
    marginPercent: totalSale ? round(((totalSale - totalCost) / totalSale) * 100, 1) : null,
    itemsWithoutCost: noCost,
    note: "Nafa = customer la vikalela rate (GST sahit) - kharedi sarasari rate (GST sahit). GST pratyek bill chya ekun rakmevarun ghetla. Sales return (Credit Note) vaja kele.",
    items: out.slice(0, MAX_ROWS),
    truncated: out.length > MAX_ROWS,
  };
}

// What an item is bought and sold at, incl. GST. Average over the period plus
// the latest bill on each side, and Tally's own stock rate for comparison.
async function itemRates(cfg, { item, party, from, to }) {
  const range = dateRange(cfg, from, to);
  const [info, vouchers, stock] = await Promise.all([
    voucherTypeInfo(cfg),
    tally.getVouchers(cfg, range.from, range.to),
    tally.getStockItems(cfg),
  ]);
  party = partyFilter(vouchers, party);

  const rows = new Map();
  const rowFor = (name, unit) => {
    if (!rows.has(name)) {
      rows.set(name, {
        item: name,
        unit,
        purchase: { qty: 0, amount: 0, last: null },
        sale: { qty: 0, amount: 0, last: null },
      });
    }
    return rows.get(name);
  };

  for (const v of vouchers) {
    const t = info.get(v.type);
    const side = t && t.baseType === "Purchase" ? "purchase" : t && t.baseType === "Sales" ? "sale" : null;
    if (!side) continue;
    if (!matches(v.party, party)) continue;
    for (const it of v.items) {
      if (!matches(it.item, item) || !it.qty || !it.amount) continue;
      const s = rowFor(it.item, it.unit)[side];
      const amount = Math.abs(it.amount) * v.gstFactor; // incl. GST
      s.qty += Math.abs(it.qty);
      s.amount += amount;
      if (!s.last || v.date > s.last.date) {
        s.last = { date: v.date, rate: round(amount / Math.abs(it.qty), 2), party: v.party, voucherNo: v.number };
      }
    }
  }

  const stockRate = new Map(stock.map((s) => [s.name, s.closingRate]));
  const stockQty = new Map(stock.map((s) => [s.name, s.closingQty]));
  // Items that were never bought or sold in the period still have a Tally rate worth showing.
  for (const s of stock) if (matches(s.name, item) && !rows.has(s.name)) rowFor(s.name, s.unit);

  const out = [...rows.values()]
    .map((r) => ({
      item: r.item,
      unit: r.unit,
      purchaseRate: r.purchase.qty ? round(r.purchase.amount / r.purchase.qty, 2) : null,
      lastPurchaseRate: r.purchase.last ? r.purchase.last.rate : null,
      lastPurchaseDate: r.purchase.last ? r.purchase.last.date : null,
      lastPurchaseParty: r.purchase.last ? r.purchase.last.party : null,
      purchaseQty: round(r.purchase.qty, 3),
      saleRate: r.sale.qty ? round(r.sale.amount / r.sale.qty, 2) : null,
      lastSaleRate: r.sale.last ? r.sale.last.rate : null,
      lastSaleDate: r.sale.last ? r.sale.last.date : null,
      lastSaleParty: r.sale.last ? r.sale.last.party : null,
      saleQty: round(r.sale.qty, 3),
      tallyStockRate: round(stockRate.get(r.item) || 0, 2),
      closingQty: stockQty.has(r.item) ? stockQty.get(r.item) : null,
    }))
    .sort((a, b) => (b.saleQty + b.purchaseQty) - (a.saleQty + a.purchaseQty) || a.item.localeCompare(b.item));

  return {
    dateRange: range,
    note: "Sarv rate GST sahit (bill chya rakmevarun). Tally stock rate GST shivay aahe.",
    count: out.length,
    items: out.slice(0, MAX_ROWS),
    truncated: out.length > MAX_ROWS,
  };
}

async function ledgerBalances(cfg, { name, group, nonZeroOnly }) {
  const ledgers = await tally.getLedgers(cfg);
  const rows = preferDirectNames(
    ledgers.filter((l) => matches(l.name, name)),
    name,
    (l) => l.name
  )
    .filter((l) => !group || l.groupChain.some((g) => matches(g, group)))
    .filter((l) => !nonZeroOnly || Math.abs(l.closing) > 0.005)
    .map((l) => ({
      ledger: l.name,
      group: l.group,
      closingBalance: round(Math.abs(l.closing)),
      drCr: l.closing < 0 ? "Dr (yene)" : l.closing > 0 ? "Cr (dene)" : "",
      openingBalance: round(Math.abs(l.opening)),
    }))
    .sort((a, b) => b.closingBalance - a.closingBalance);
  const totalDr = round(rows.filter((r) => r.drCr.startsWith("Dr")).reduce((s, r) => s + r.closingBalance, 0));
  const totalCr = round(rows.filter((r) => r.drCr.startsWith("Cr")).reduce((s, r) => s + r.closingBalance, 0));
  return { count: rows.length, totalDr, totalCr, ledgers: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

async function stockSummary(cfg, { name, group, negativeOnly }) {
  const items = await tally.getStockItems(cfg);
  const rows = items
    .filter((i) => matches(i.name, name))
    .filter((i) => !group || matches(i.group, group))
    .filter((i) => !negativeOnly || i.closingQty < 0)
    .map((i) => ({ item: i.name, group: i.group, closingQty: i.closingQty, unit: i.unit, closingValue: round(i.closingValue), rate: i.closingRate }));
  return { count: rows.length, items: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

// Money received (jama / vasuli): the Receipt vouchers in the period. Per voucher the amount is what was credited to
// the party ledger(s); the Dr side tells whether it came in as cash or bank. Read-only, like every query here.
async function collections(cfg, { party, from, to, voucherType }) {
  const range = dateRange(cfg, from, to);
  const vouchers = await tally.getVouchers(cfg, range.from, range.to);
  const type = voucherType || "Receipt";
  const rows = [];
  for (const v of vouchers) {
    if (!matches(v.type, type)) continue;
    if (party && !matches(v.party, party) && !v.ledgerEntries.some((e) => matches(e.ledger, party))) continue;
    const credits = v.ledgerEntries.filter((e) => e.amount > 0);      // Cr side = who paid us
    const debits = v.ledgerEntries.filter((e) => e.amount < 0);       // Dr side = where it went (cash / bank)
    const amount = round(credits.reduce((s, e) => s + e.amount, 0));
    rows.push({
      date: v.date, voucherNo: v.number, voucherType: v.type, amount,
      from: credits.map((e) => e.ledger).join(", ") || v.party,
      into: debits.map((e) => e.ledger).join(", "),
      narration: v.narration,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  const byParty = {};
  const byAccount = {};
  for (const r of rows) {
    byParty[r.from] = round((byParty[r.from] || 0) + r.amount);
    byAccount[r.into] = round((byAccount[r.into] || 0) + r.amount);
  }
  const total = round(rows.reduce((s, r) => s + r.amount, 0));
  return { dateRange: range, voucherType: type, count: rows.length, totalAmount: total, byAccount, byParty, vouchers: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

module.exports = { listNames, withoutBill, searchVouchers, profit, itemRates, ledgerBalances, stockSummary, collections, matches, norm, todayYmd };

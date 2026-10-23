const chat = document.getElementById("chat");
const form = document.getElementById("askForm");
const input = document.getElementById("question");
const useAi = document.getElementById("useAi");
const tallyStatus = document.getElementById("tallyStatus");
const history = []; // text-only Q/A for AI follow-up questions

// Chat is kept in this PC's browser storage so a refresh (F5) doesn't wipe
// it. Only the last MAX_SAVED messages are kept. Storage can be missing or
// blocked - then the app just works without saving.
const STORE_KEY = "tallyPrashnaChat";
const MAX_SAVED = 60;

function saveChat() {
  const msgs = [...chat.querySelectorAll(".msg:not(.intro)")]
    .filter((m) => !m.querySelector(".thinking"))
    .map((m) => ({ cls: m.className, question: m.dataset.question || null, html: m.innerHTML }))
    .slice(-MAX_SAVED);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ msgs, history: history.slice(-12) }));
  } catch {}
}

function restoreChat() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch {}
  if (!saved || !Array.isArray(saved.msgs)) return;
  for (const m of saved.msgs) {
    const div = document.createElement("div");
    div.className = m.cls;
    div.innerHTML = m.html;
    if (m.question) div.dataset.question = m.question;
    chat.appendChild(div);
  }
  if (Array.isArray(saved.history)) history.push(...saved.history);
  chat.scrollTop = chat.scrollHeight;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const inrMoney = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function money(n) {
  if (n == null) return "";
  return (n < 0 ? "−₹" : "₹") + inrMoney.format(Math.abs(n));
}
function qty(n, unit) {
  return n == null ? "" : `${inr.format(n)} ${esc(unit || "")}`;
}
function dmy(ymd) {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-");
  return `${d}-${m}-${y}`;
}

// Minimal, safe markdown: tables, **bold**, lists, paragraphs.
function renderMarkdown(md) {
  const lines = esc(md).split("\n");
  let html = "";
  let i = 0;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      html += "<table><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr>";
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        html += "<tr>" + cells(lines[i]).map((c) => {
          const isNum = /^[₹\d.,\s-]+[a-zA-Z.]*$/.test(c) && /\d/.test(c);
          return `<td${isNum ? ' class="num"' : ""}>${inline(c)}</td>`;
        }).join("") + "</tr>";
        i++;
      }
      html += "</table>";
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      html += "<ul>";
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        html += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`;
        i++;
      }
      html += "</ul>";
      continue;
    }
    if (/^#{1,4}\s/.test(line)) html += `<h4>${inline(line.replace(/^#+\s/, ""))}</h4>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
    i++;
  }
  return html;
}

// `total` (optional): { columnLabel: html } - rendered as a bold last row,
// with "Ekun" in the first column.
function table(headers, rows, total) {
  let foot = "";
  if (total) {
    foot =
      '<tr class="total">' +
      headers.map((h, i) => `<td${h.num ? ' class="num"' : ""}>${h.label in total ? total[h.label] : i === 0 ? "Ekun" : ""}</td>`).join("") +
      "</tr>";
  }
  return (
    "<table><tr>" + headers.map((h) => `<th>${esc(h.label)}</th>`).join("") + "</tr>" +
    rows.map((r) => "<tr>" + headers.map((h) => `<td${h.num ? ' class="num"' : ""}>${h.fmt ? h.fmt(r) : esc(r[h.key])}</td>`).join("") + "</tr>").join("") +
    foot +
    "</table>"
  );
}

function sum(rows, fn) {
  return Math.round(rows.reduce((s, r) => s + (fn(r) || 0), 0) * 100) / 100;
}

// Quantities can only be added up when every row has the same unit.
function qtyTotal(rows, qtyFn, unitFn) {
  const units = new Set(rows.map(unitFn));
  return units.size === 1 ? qty(sum(rows, qtyFn), [...units][0]) : "";
}

// Offline results come back as data - lay them out as tables here.
function renderOffline(out) {
  const r = out.result;
  const u = out.understood || {};
  let html = `<div class="meta">Samajle: ${esc(u.intent)}${u.item ? " · item: <b>" + esc(u.item) + "</b>" : ""}${u.party ? " · party: <b>" + esc(u.party) + "</b>" : ""}</div>`;

  if (out.kind === "help") return html + `<p>${esc(r.message)}</p>`;

  if (out.kind === "withoutBill") {
    if (!r.entryCount) {
      return html + `<p>Without bill entry sapadli nahi (${dmy(r.dateRange.from)} te ${dmy(r.dateRange.to)}).</p>` +
        `<div class="meta">Without-bill voucher types: ${esc(r.withoutBillVoucherTypes.join(", ") || "ekhi nahi")}</div>`;
    }
    html += `<p><b>${r.summaryByPartyAndItem.length}</b> party/item madhe <b>${r.entryCount}</b> without-bill entries sapadlya.</p>`;
    html += "<h4>Party nusar</h4>" + table(
      [
        { label: "Party (A/c)", key: "party" },
        { label: "Item", key: "item" },
        { label: "Prakar", key: "direction" },
        { label: "Entries", key: "entries", num: true },
        { label: "Ekun qty", num: true, fmt: (x) => qty(x.qty, x.unit) },
        { label: "Bill baki qty", num: true, fmt: (x) => qty(x.pendingQty, x.unit) },
        { label: "Rakkam", num: true, fmt: (x) => money(x.amount) },
      ],
      r.summaryByPartyAndItem,
      {
        Entries: sum(r.summaryByPartyAndItem, (x) => x.entries),
        "Ekun qty": qtyTotal(r.summaryByPartyAndItem, (x) => x.qty, (x) => x.unit),
        "Bill baki qty": qtyTotal(r.summaryByPartyAndItem, (x) => x.pendingQty, (x) => x.unit),
        Rakkam: money(sum(r.summaryByPartyAndItem, (x) => x.amount)),
      }
    );
    html += "<h4>Entries</h4>" + table(
      [
        { label: "Date", fmt: (x) => dmy(x.date) },
        { label: "Voucher", fmt: (x) => `${esc(x.voucherType)} #${esc(x.voucherNo)}` },
        { label: "Party", key: "party" },
        { label: "Item", key: "item" },
        { label: "Qty", num: true, fmt: (x) => qty(x.qty, x.unit) },
        { label: "Rate", num: true, fmt: (x) => money(x.rate) },
        { label: "Sthiti", key: "status" },
        { label: "Narration", key: "narration" },
      ],
      r.entries,
      r.truncated ? null : { Qty: qtyTotal(r.entries, (x) => x.qty, (x) => x.unit) }
    );
    if (r.entries.some((e) => e.billedQty === null)) {
      html += `<div class="meta warn">"mahit nahi" = Tally madhe tracking no. vaparla nahi, mhanun bill zala ki nahi he kalat nahi.</div>`;
    }
    if (r.truncated) html += `<div class="meta">Pahilya ${r.entries.length} entries dakhavlya.</div>`;
    return html + `<div class="meta">Kalavadhi: ${dmy(r.dateRange.from)} te ${dmy(r.dateRange.to)}</div>`;
  }

  if (out.kind === "profit") {
    if (!r.items.length) return html + `<p>Vikri sapadli nahi (${dmy(r.dateRange.from)} te ${dmy(r.dateRange.to)}).</p>`;
    html += `<p>Ekun andaje nafa: <b>${money(r.totalProfit)}</b>${r.marginPercent != null ? ` (${r.marginPercent}%)` : ""} · vikri ${money(r.totalSaleWithCost)} − kharedi ${money(r.totalCost)} · ${r.voucherCount} bills</p>`;
    html += table(
      [
        { label: "Item", key: "item" },
        { label: "Qty", num: true, fmt: (x) => qty(x.qty, x.unit) },
        { label: "Vikri rate (GST sahit)", num: true, fmt: (x) => money(x.saleRate) },
        { label: "Kharedi rate (GST sahit)", num: true, fmt: (x) => (x.costRate == null ? "—" : money(x.costRate) + (/^Tally/.test(x.costSource) ? " ✱" : "")) },
        { label: "Vikri", num: true, fmt: (x) => money(x.saleAmount) },
        { label: "Nafa", num: true, fmt: (x) => (x.profit == null ? "—" : money(x.profit)) },
        { label: "%", num: true, fmt: (x) => (x.marginPercent == null ? "" : x.marginPercent + "%") },
      ],
      r.items,
      {
        Qty: qtyTotal(r.items, (x) => x.qty, (x) => x.unit),
        Vikri: money(sum(r.items, (x) => x.saleAmount)),
        Nafa: money(r.totalProfit),
        "%": r.marginPercent == null ? "" : r.marginPercent + "%",
      }
    );
    if (r.items.some((x) => /^Tally/.test(x.costSource))) html += `<div class="meta warn">✱ = hya itemcha kharedi bill Tally madhe nahi, mhanun Tally cha stock rate + GST vaparla (andaj).</div>`;
    if (r.itemsWithoutCost.length) html += `<div class="meta warn">Kharedi rate nahi, mhanun nafa madhe dharle nahi: ${esc(r.itemsWithoutCost.join(", "))}</div>`;
    return html + `<div class="meta">${esc(r.note)} Kalavadhi: ${dmy(r.dateRange.from)} te ${dmy(r.dateRange.to)}</div>`;
  }

  if (out.kind === "rate") {
    if (!r.count) return html + "<p>Item sapadla nahi.</p>";
    const rate = (v) => (v == null ? "—" : money(v));
    const last = (v, d) => (v == null ? "—" : `${money(v)}<br><span class="meta">${dmy(d)}</span>`);
    const noBuy = r.items.filter((x) => x.purchaseRate == null).map((x) => x.item);
    return html + table(
      [
        { label: "Item", key: "item" },
        { label: "Kharedi rate", num: true, fmt: (x) => rate(x.purchaseRate) },
        { label: "Shevatchi kharedi", num: true, fmt: (x) => last(x.lastPurchaseRate, x.lastPurchaseDate) },
        { label: "Vikri rate", num: true, fmt: (x) => rate(x.saleRate) },
        { label: "Shevatchi vikri", num: true, fmt: (x) => last(x.lastSaleRate, x.lastSaleDate) },
        { label: "Tally rate", num: true, fmt: (x) => rate(x.tallyStockRate || null) },
        { label: "Shillak", num: true, fmt: (x) => (x.closingQty == null ? "—" : qty(x.closingQty, x.unit)) },
      ],
      r.items,
      null
    ) + `<div class="meta">${esc(r.note)} Sarasari rate kalavadhi: ${dmy(r.dateRange.from)} te ${dmy(r.dateRange.to)}.${
      r.items.length === 1 && r.items[0].lastSaleParty ? " Shevatchi vikri: " + esc(r.items[0].lastSaleParty) + "." : ""
    }${r.items.length === 1 && r.items[0].lastPurchaseParty ? " Shevatchi kharedi: " + esc(r.items[0].lastPurchaseParty) + "." : ""}</div>${
      noBuy.length ? `<div class="meta warn">Hya itemche kharedi bill ya kalavadhit nahi, mhanun fakt Tally cha stock rate (GST shivay) dakhavla: ${esc(noBuy.join(", "))}</div>` : ""
    }`;
  }

  if (out.kind === "stock") {
    const isMinus = u.intent === "minus stock";
    if (!r.count) return html + (isMinus ? "<p>Ekhi item minus stock madhe nahi. ✓</p>" : "<p>Item sapadla nahi.</p>");
    if (isMinus) html += `<p><b>${r.count}</b> items cha stock minus aahe.</p>`;
    return html + table(
      [
        { label: "Item", key: "item" },
        { label: "Group", key: "group" },
        { label: "Shillak qty", num: true, fmt: (x) => qty(x.closingQty, x.unit) },
        { label: "Kimmat", num: true, fmt: (x) => money(x.closingValue) },
      ],
      r.items,
      r.items.length > 1 && !r.truncated
        ? {
            Group: `${r.items.length} items`,
            "Shillak qty": qtyTotal(r.items, (x) => x.closingQty, (x) => x.unit),
            Kimmat: money(sum(r.items, (x) => x.closingValue)),
          }
        : null
    );
  }

  if (out.kind === "balance") {
    if (!r.count) return html + "<p>Ledger sapadla nahi.</p>";
    return html + table(
      [
        { label: "Ledger", key: "ledger" },
        { label: "Group", key: "group" },
        { label: "Balance", num: true, fmt: (x) => money(x.closingBalance) },
        { label: "Dr/Cr", key: "drCr" },
      ],
      r.ledgers,
      r.ledgers.length > 1
        ? (() => {
            const net = Math.round((r.totalDr - r.totalCr) * 100) / 100;
            return { Group: `${r.count} ledgers`, Balance: money(Math.abs(net)), "Dr/Cr": net > 0 ? "Dr (yene)" : net < 0 ? "Cr (dene)" : "" };
          })()
        : null
    ) + `<div class="meta">Ekun Dr (yene): ${money(r.totalDr)} · Ekun Cr (dene): ${money(r.totalCr)}</div>`;
  }

  if (out.kind === "vouchers") {
    if (!r.matchCount) return html + `<p>Voucher sapadla nahi (${dmy(r.dateRange.from)} te ${dmy(r.dateRange.to)}).</p>`;
    const totals = Object.entries(r.totalsByVoucherType).map(([type, t]) => ({ type, ...t }));
    html += "<h4>Ekun</h4>" + table(
      [
        { label: "Voucher type", key: "type" },
        { label: "Vouchers", key: "vouchers", num: true },
        { label: "Qty", num: true, fmt: (x) => inr.format(x.qty) },
        { label: "Rakkam", num: true, fmt: (x) => money(x.amount) },
      ],
      totals,
      totals.length > 1 ? { Vouchers: sum(totals, (x) => x.vouchers), Rakkam: money(sum(totals, (x) => x.amount)) } : null
    );
    const flat = [];
    for (const v of r.vouchers) {
      if (!v.items.length) flat.push({ ...v, item: "", q: "", amt: v.ledgerEntries[0] ? v.ledgerEntries[0].amount : null });
      for (const it of v.items) flat.push({ ...v, item: it.item, q: qty(it.qty, it.unit), rate: it.rate, amt: it.amount });
    }
    html += "<h4>Vouchers</h4>" + table(
      [
        { label: "Date", fmt: (x) => dmy(x.date) },
        { label: "Voucher", fmt: (x) => `${esc(x.voucherType)} #${esc(x.voucherNo)}` },
        { label: "Party", key: "party" },
        { label: "Item", key: "item" },
        { label: "Qty", num: true, fmt: (x) => x.q },
        { label: "Rakkam", num: true, fmt: (x) => money(x.amt) },
      ],
      flat,
      r.truncated ? null : { Rakkam: money(sum(flat, (x) => x.amt)) }
    );
    if (r.truncated) html += `<div class="meta">Pahile ${r.vouchers.length} vouchers dakhavle (ekun ${r.matchCount}).</div>`;
    return html;
  }
  return html;
}

function addMsg(cls, html) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.innerHTML = html;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

async function ask(question) {
  addMsg("user", esc(question));
  const pending = addMsg("bot", '<span class="thinking">Tally madhe shodhat aahe…</span>');
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, mode: useAi.checked ? "ai" : "offline", history }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);

    let html = "";
    if (out.aiError) html += `<div class="meta warn">AI chalu nahi (${esc(out.aiError.slice(0, 160))}) - offline search ne uttar dile.</div>`;
    if (out.mode === "ai") {
      html += renderMarkdown(out.answer);
      history.push({ role: "user", content: question }, { role: "assistant", content: out.answer });
    } else {
      html += renderOffline(out);
    }
    pending.innerHTML = `<div class="answer">${html}</div><div class="actions"><button type="button" class="print-one">🖨 Print</button></div>`;
    pending.dataset.question = question;
    setTallyPill(true);
  } catch (err) {
    pending.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    loadStatus();
  }
  saveChat();
  chat.scrollTop = chat.scrollHeight;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  ask(q);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

chat.addEventListener("click", (e) => {
  if (e.target.matches(".examples button")) ask(e.target.textContent);
  if (e.target.matches(".print-one")) {
    const msg = e.target.closest(".msg");
    printBlocks([{ question: msg.dataset.question, html: msg.querySelector(".answer").innerHTML }]);
  }
});

// Prints through a hidden frame with its own plain black-on-white layout,
// so dark mode and the chat chrome never end up on paper.
function printBlocks(blocks) {
  const now = new Date();
  const stamp = `${now.toLocaleDateString("en-IN")} ${now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
  const body = blocks
    .map((b) => `<section><div class="q">Prashna: ${esc(b.question)}</div>${b.html}</section>`)
    .join("");
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Tally Prashna</title><style>
    body { font: 12px/1.45 "Segoe UI", "Nirmala UI", sans-serif; color: #000; margin: 12mm; }
    h1 { font-size: 16px; margin: 0 0 2px; } .stamp { color: #444; margin-bottom: 10px; }
    section { margin-bottom: 16px; page-break-inside: auto; }
    .q { font-weight: 600; font-size: 13px; margin-bottom: 4px; border-bottom: 1px solid #000; padding-bottom: 2px; }
    table { border-collapse: collapse; width: 100%; margin: 6px 0; }
    th, td { border: 1px solid #555; padding: 3px 6px; text-align: left; vertical-align: top; }
    th { background: #eee; } td.num { text-align: right; white-space: nowrap; }
    tr.total td { font-weight: 700; border-top: 2px solid #000; background: #f4f4f4; }
    tr { page-break-inside: avoid; } thead { display: table-header-group; }
    h4 { margin: 8px 0 3px; font-size: 13px; } .meta { color: #444; font-size: 11px; } p { margin: 3px 0; }
  </style></head><body><h1>Tally Prashna</h1><div class="stamp">${esc(stamp)}</div>${body}</body></html>`);
  doc.close();
  // Repeat table headers on every printed page.
  for (const t of doc.querySelectorAll("table")) {
    const first = t.querySelector("tr");
    if (first && first.querySelector("th")) {
      const thead = doc.createElement("thead");
      thead.appendChild(first);
      t.insertBefore(thead, t.firstChild);
    }
  }
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 1000);
}

document.getElementById("printAllBtn").addEventListener("click", () => {
  const blocks = [...chat.querySelectorAll(".msg.bot[data-question]")].map((m) => ({
    question: m.dataset.question,
    html: m.querySelector(".answer").innerHTML,
  }));
  if (!blocks.length) return alert("Print karnyasathi ajun ekhi uttar nahi.");
  printBlocks(blocks);
});

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await fetch("/api/refresh", { method: "POST" });
  loadStatus();
});

function setTallyPill(ok, error) {
  tallyStatus.textContent = ok ? "Tally jodle ✓" : "Tally band";
  tallyStatus.className = `pill ${ok ? "ok" : "bad"}`;
  tallyStatus.title = error || "";
}

async function loadStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    setTallyPill(s.tallyOk, s.tallyError);
    // Only set the AI box once, so the 30s re-check doesn't undo the user's choice.
    if (useAi.dataset.init !== "1" || useAi.disabled === s.aiAvailable) useAi.checked = s.aiAvailable;
    useAi.dataset.init = "1";
    useAi.disabled = !s.aiAvailable;
    useAi.parentElement.title = s.aiAvailable ? "AI chalu - kontahi prashna vichara" : "config.json madhe API key nahi - offline search vaparla jail";
  } catch {
    tallyStatus.textContent = "Server band";
    tallyStatus.className = "pill bad";
  }
}
document.getElementById("clearBtn").addEventListener("click", () => {
  if (!confirm("Sagali juni chat pusun takaychi?")) return;
  chat.querySelectorAll(".msg:not(.intro)").forEach((m) => m.remove());
  history.length = 0;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {}
});

restoreChat();
loadStatus();
// Re-check every 30s so the pill follows Tally being opened/closed.
setInterval(loadStatus, 30000);

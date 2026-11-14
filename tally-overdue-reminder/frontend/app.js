const statusEl = document.getElementById("status");
const modeBadge = document.getElementById("mode-badge");
const listEl = document.getElementById("customer-list");
const emptyStateEl = document.getElementById("empty-state");
const searchBox = document.getElementById("search-box");
const refreshBtn = document.getElementById("refresh-btn");
const cardTemplate = document.getElementById("customer-card-template");
const priorityCardTemplate = document.getElementById("priority-card-template");
const greetingEl = document.getElementById("greeting");

const pageTitleEl = document.getElementById("page-title");
const homeView = document.getElementById("home-view");
const customersView = document.getElementById("customers-view");
const itemsView = document.getElementById("items-view");
const itemsStatusEl = document.getElementById("items-status");
const itemSearchBox = document.getElementById("item-search-box");
const itemsBody = document.getElementById("items-body");
const itemsEmptyEl = document.getElementById("items-empty");

const statOutstandingEl = document.getElementById("stat-outstanding");
const statOutstandingSubEl = document.getElementById("stat-outstanding-sub");
const statInterestEl = document.getElementById("stat-interest");
const statInterestSubEl = document.getElementById("stat-interest-sub");
const statOverdueCountEl = document.getElementById("stat-overdue-count");
const statTotalCountEl = document.getElementById("stat-total-count");
const statMaxDaysEl = document.getElementById("stat-max-days");
const priorityListEl = document.getElementById("priority-list");
const priorityEmptyEl = document.getElementById("priority-empty");
const filterChipEl = document.getElementById("filter-chip");
const clearFilterBtn = document.getElementById("clear-filter-btn");

let interestRatePercentPerMonth = 2;
let creditPeriodDays = 30;
let gistId = null; // set from /api/config - where the last-synced cloud snapshot lives
let allCustomers = []; // full list from the last /api/overdue response
let allProducts = []; // full list from the last /api/products response
let itemsLoaded = false;
let currentView = "home";
let statusFilter = "all"; // "all" | "overdue" - set by tapping a dashboard mini-stat
const expandedCustomers = new Set(); // survives auto-refresh so open details stay open
const AUTO_REFRESH_MS = 30000;
let isLoading = false;
let refreshTimer = null;

const AVATAR_COLORS = ["#b91c1c", "#12395b", "#b45309", "#15803d", "#7c3aed", "#0e7490"];

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function setGreeting() {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "शुभ सकाळ 🙏" : hour < 17 ? "शुभ दुपार 🙏" : "शुभ संध्याकाळ 🙏";
  greetingEl.textContent = greeting;
}

function openWhatsApp(text) {
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
}

const loginOverlay = document.getElementById("login-overlay");
const loginForm = document.getElementById("login-form");
const loginPassword = document.getElementById("login-password");
const loginError = document.getElementById("login-error");

// Only shown when the PC answered but said we're not logged in. If the PC
// can't be reached at all the saved data is shown instead, no login needed.
function showLogin() {
  if (!loginOverlay.hidden) return;
  loginOverlay.hidden = false;
  loginPassword.focus();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  try {
    const res = await fetchWithTimeout("/api/login", 8000, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: loginPassword.value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "चुकीचा password");
    }
    loginPassword.value = "";
    loginOverlay.hidden = true;
    loadConfig();
    loadOverdue();
    if (currentView === "items") loadItemRates();
  } catch (err) {
    loginError.textContent = err.name === "AbortError" || err instanceof TypeError ? "PC शी संपर्क होत नाही" : err.message;
    loginError.hidden = false;
  }
});

function formatMoney(n) {
  return "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateTime(isoTimestamp) {
  if (!isoTimestamp) return "-";
  return new Date(isoTimestamp).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// Everything below that touches localStorage is best-effort: it lets the app
// show something useful when the PC is off, but must never break the app if
// storage is full or blocked.
const CACHE_KEYS = { config: "overdue.config", data: "overdue.lastData" };

function saveLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable - offline cache is optional */
  }
}

function loadLocal(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

// Without a timeout, an unreachable PC (off, Tailscale down) can leave the
// screen empty for a minute or more before the browser gives up.
async function fetchWithTimeout(url, ms, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function applyConfig(cfg) {
  interestRatePercentPerMonth = cfg.interestRatePercentPerMonth;
  creditPeriodDays = cfg.creditPeriodDays;
  gistId = cfg.gistId;
  modeBadge.textContent = cfg.useMockData
    ? "Mock data mode — connect Tally in backend/config.json"
    : `Live Tally — ${cfg.tallyCompany || "(no company set)"}`;
}

async function loadConfig() {
  try {
    const res = await fetchWithTimeout("/api/config", 5000);
    if (res.status === 401) {
      showLogin();
      return;
    }
    const cfg = await res.json();
    if (!res.ok) throw new Error(cfg.error || "config unavailable");
    saveLocal(CACHE_KEYS.config, cfg);
    applyConfig(cfg);
  } catch {
    // PC unreachable - keep whatever config this phone saved last time
    // (needs the gist ID to reach the cloud backup).
  }
}

// Paints whatever this phone saved last time straight away, so the screen is
// never blank while the live request is still in flight (or failing).
function primeFromLocalCache() {
  const cfg = loadLocal(CACHE_KEYS.config);
  if (cfg) applyConfig(cfg);
  const saved = loadLocal(CACHE_KEYS.data);
  if (saved && saved.data && Array.isArray(saved.data.customers)) {
    allCustomers = saved.data.customers;
    applyFilter();
    renderDashboard();
    setStatus(`Showing data saved on this phone from ${formatDateTime(saved.savedAt)} — connecting…`, false);
  }
}

async function loadOverdue() {
  if (isLoading) return;
  isLoading = true;
  refreshBtn.disabled = true;
  try {
    let res;
    try {
      res = await fetchWithTimeout("/api/overdue", 12000);
    } catch (networkErr) {
      // Couldn't reach the PC at all (off, Tailscale down, etc.) - fall
      // back to the last snapshot synced to the cloud while it was up.
      await loadFromCloudSnapshot();
      return;
    }
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      if (data.code === "TALLY_UNREACHABLE") {
        // The PC is fine, Tally itself is closed - same idea: show the last data.
        await loadFromCloudSnapshot("Tally is not reachable (is Tally open?)");
        return;
      }
      throw new Error(data.error || "Failed to load");
    }
    saveLocal(CACHE_KEYS.data, { savedAt: new Date().toISOString(), data });
    allCustomers = data.customers;
    applyFilter();
    renderDashboard();
    setStatus(
      `Updated as of ${formatDate(data.asOf)} · ${data.customers.length} customer(s), ${data.overdueCount} overdue (${creditPeriodDays}-day credit period) · auto-refreshes every ${AUTO_REFRESH_MS / 1000}s`,
      false
    );
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  } finally {
    refreshBtn.disabled = false;
    isLoading = false;
  }
}

// PC unreachable: show whichever is newer - the cloud snapshot the PC pushed
// while it was up, or the copy this phone saved the last time it loaded live.
async function loadFromCloudSnapshot(reason = "Cannot reach the PC right now") {
  const local = loadLocal(CACHE_KEYS.data);
  let cloud = null;
  let cloudError = null;

  if (gistId) {
    try {
      const res = await fetchWithTimeout(`https://api.github.com/gists/${gistId}`, 8000);
      if (!res.ok) throw new Error(`cloud backup responded with ${res.status}`);
      const gist = await res.json();
      cloud = JSON.parse(gist.files["overdue-snapshot.json"].content);
    } catch (err) {
      cloudError = err;
    }
  }

  const cloudTime = cloud ? new Date(cloud.syncedAt).getTime() : 0;
  const localTime = local ? new Date(local.savedAt).getTime() : 0;

  if (cloud && cloudTime >= localTime) {
    allCustomers = cloud.customers;
    applyFilter();
    renderDashboard();
    setStatus(`⚠ ${reason} — showing last synced data from ${formatDateTime(cloud.syncedAt)}.`, true);
  } else if (local) {
    allCustomers = local.data.customers;
    applyFilter();
    renderDashboard();
    setStatus(`⚠ ${reason} — showing data saved on this phone from ${formatDateTime(local.savedAt)}.`, true);
  } else if (!gistId) {
    setStatus(`${reason}, and no cloud backup is configured.`, true);
  } else {
    setStatus(`${reason}, and could not load the cloud backup: ${cloudError.message}`, true);
  }
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    loadOverdue();
    if (currentView === "items") loadItemRates();
  }, AUTO_REFRESH_MS);
}

function showView(view, filter) {
  currentView = view;
  homeView.hidden = view !== "home";
  customersView.hidden = view !== "customers";
  itemsView.hidden = view !== "items";
  pageTitleEl.textContent =
    view === "customers" ? "ग्राहक यादी" : view === "items" ? "Item Rate" : "थकबाकी व्यवस्थापन";
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  if (view === "customers") {
    statusFilter = filter || "all";
    filterChipEl.hidden = statusFilter !== "overdue";
    applyFilter();
  }
  if (view === "items" && !itemsLoaded) loadItemRates();
}

document.querySelectorAll(".nav-tab, [data-view-target]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view || btn.dataset.viewTarget, btn.dataset.filter));
});

clearFilterBtn.addEventListener("click", () => {
  statusFilter = "all";
  filterChipEl.hidden = true;
  applyFilter();
});

async function loadItemRates() {
  itemsStatusEl.textContent = "Loading...";
  itemsStatusEl.classList.remove("error");
  try {
    const res = await fetch("/api/products");
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load");
    allProducts = data.products;
    itemsLoaded = true;
    applyItemFilter();
    itemsStatusEl.textContent = `${data.products.length} product(s) · auto-refreshes every ${AUTO_REFRESH_MS / 1000}s`;
  } catch (err) {
    itemsStatusEl.textContent = `Error: ${err.message}`;
    itemsStatusEl.classList.add("error");
  }
}

function applyItemFilter() {
  const query = itemSearchBox.value.trim().toLowerCase();
  const filtered = query
    ? allProducts.filter((p) => p.productName.toLowerCase().includes(query))
    : allProducts;
  renderItems(filtered, query);
}

function renderItems(products, query) {
  itemsBody.innerHTML = "";

  if (products.length === 0) {
    itemsEmptyEl.hidden = false;
    itemsEmptyEl.textContent = query
      ? `No product matches "${itemSearchBox.value.trim()}".`
      : "No product rate data found.";
    return;
  }

  itemsEmptyEl.hidden = true;
  for (const p of products) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(p.productName)}</td>
      <td class="num">${p.purchaseRateInclGst != null ? formatMoney(p.purchaseRateInclGst) : "-"}</td>
      <td>${escapeHtml(p.supplier || "-")}</td>
      <td>${formatDate(p.purchaseDate)}</td>
      <td class="num">${p.saleRateInclGst != null ? formatMoney(p.saleRateInclGst) : "-"}</td>
      <td>${escapeHtml(p.lastCustomer || "-")}</td>
      <td>${formatDate(p.saleDate)}</td>
    `;
    itemsBody.appendChild(tr);
  }
}

itemSearchBox.addEventListener("input", applyItemFilter);

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function applyFilter() {
  const query = searchBox.value.trim().toLowerCase();
  let filtered = statusFilter === "overdue" ? allCustomers.filter((c) => c.overdueDays > 0) : allCustomers;
  if (query) filtered = filtered.filter((c) => c.customerName.toLowerCase().includes(query));
  render(filtered, query);
}

function render(customers, query) {
  listEl.innerHTML = "";

  if (customers.length === 0) {
    emptyStateEl.hidden = false;
    emptyStateEl.textContent = query
      ? `No customer matches "${searchBox.value.trim()}".`
      : "No customers with an outstanding balance found.";
    return;
  }

  emptyStateEl.hidden = true;
  for (const customer of customers) {
    listEl.appendChild(buildCustomerCard(customer));
  }
}

searchBox.addEventListener("input", applyFilter);

function renderDashboard() {
  const overdue = allCustomers.filter((c) => c.overdueDays > 0);
  const totalOutstanding = overdue.reduce((sum, c) => sum + c.balance, 0);
  const totalInterest = overdue.reduce((sum, c) => sum + c.interest, 0);
  const maxDays = overdue.reduce((max, c) => Math.max(max, c.overdueDays), 0);

  statOutstandingEl.textContent = formatMoney(totalOutstanding);
  statOutstandingSubEl.textContent = `${overdue.length} ग्राहक • एकूण येणे बाकी`;
  statInterestEl.textContent = formatMoney(totalInterest);
  statInterestSubEl.textContent = `${interestRatePercentPerMonth}%/महिना`;
  statOverdueCountEl.textContent = overdue.length;
  statTotalCountEl.textContent = allCustomers.length;
  statMaxDaysEl.textContent = maxDays;

  const priority = [...overdue].sort((a, b) => b.overdueDays - a.overdueDays || b.balance - a.balance).slice(0, 8);
  priorityListEl.innerHTML = "";
  if (priority.length === 0) {
    priorityEmptyEl.hidden = false;
    priorityEmptyEl.textContent = "सध्या कुणीही थकीत नाही.";
    return;
  }
  priorityEmptyEl.hidden = true;
  for (const customer of priority) {
    priorityListEl.appendChild(buildPriorityCard(customer));
  }
}

function buildPriorityCard(customer) {
  const node = priorityCardTemplate.content.cloneNode(true);
  const avatar = node.querySelector(".priority-avatar");
  avatar.textContent = customer.customerName.trim().charAt(0).toUpperCase();
  avatar.style.background = avatarColor(customer.customerName);

  node.querySelector(".priority-name").textContent = customer.customerName;
  node.querySelector(".priority-sub").textContent = customer.lastSaleDate
    ? `शेवटची खरेदी ${formatDate(customer.lastSaleDate)}`
    : "जुनी शिल्लक बाकी";
  node.querySelector(".priority-amount").textContent = formatMoney(customer.totalPayable);
  node.querySelector(".priority-days").textContent = `${customer.overdueDays} दिवस थकीत`;

  node.querySelector(".priority-btn-message").addEventListener("click", () => {
    openWhatsApp(buildReminderMessage(customer));
  });

  const copyBtn = node.querySelector(".priority-btn-copy");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(buildReminderMessage(customer));
      copyBtn.textContent = "✓ कॉपी झालं";
      setTimeout(() => (copyBtn.textContent = "📋 कॉपी करा"), 1500);
    } catch {
      /* clipboard unavailable - ignore, user can still use the Details view */
    }
  });

  node.querySelector(".priority-btn-details").addEventListener("click", () => {
    expandedCustomers.add(customer.customerName);
    searchBox.value = customer.customerName;
    showView("customers");
  });

  return node;
}

function buildCustomerCard(customer) {
  const node = cardTemplate.content.cloneNode(true);
  const card = node.querySelector(".customer-card");

  card.querySelector(".customer-name").textContent = customer.customerName;
  const lastPurchaseText = customer.lastSaleDate
    ? `Last purchase ${formatDate(customer.lastSaleDate)}`
    : "No invoice on file (old balance)";
  const dueText = customer.overdueDays > 0
    ? `${customer.overdueDays} days overdue`
    : "within credit period";
  card.querySelector(".customer-meta").textContent =
    `${lastPurchaseText} · due ${formatDate(customer.dueDate)} · ${dueText}`;
  card.classList.toggle("not-overdue", customer.overdueDays === 0);
  card.querySelector(".outstanding").textContent = formatMoney(customer.balance);
  card.querySelector(".interest").textContent = formatMoney(customer.interest);
  card.querySelector(".payable").textContent = formatMoney(customer.totalPayable);

  const billsBody = card.querySelector(".bills-body");
  for (const bill of customer.bills || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(bill.label)}</td>
      <td>${formatDate(bill.date)}</td>
      <td class="num">${formatMoney(bill.amount)}</td>
      <td>${formatDate(bill.dueDate)}</td>
      <td class="num">${bill.overdueDays}</td>
      <td class="num">${formatMoney(bill.interest)}</td>
    `;
    billsBody.appendChild(tr);
  }

  const invoicesBody = card.querySelector(".invoices-body");
  const invoicesEmpty = card.querySelector(".invoices-empty");

  const detailsEl = card.querySelector(".customer-details");
  const toggleBtn = card.querySelector(".details-toggle");
  const reminderText = card.querySelector(".reminder-text");
  const copyBtn = card.querySelector(".copy-btn");
  const messageBtn = card.querySelector(".message-btn");

  let detailsLoaded = false;

  async function openDetails() {
    detailsEl.hidden = false;
    toggleBtn.textContent = "Hide";
    expandedCustomers.add(customer.customerName);
    reminderText.value = buildReminderMessage(customer);

    if (!detailsLoaded) {
      detailsLoaded = true;
      invoicesBody.innerHTML = "";
      await loadInvoices(customer, invoicesBody, invoicesEmpty);
    }
  }

  function closeDetails() {
    detailsEl.hidden = true;
    toggleBtn.textContent = "Details";
    expandedCustomers.delete(customer.customerName);
  }

  toggleBtn.addEventListener("click", () => {
    if (detailsEl.hidden) openDetails();
    else closeDetails();
  });

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(reminderText.value);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "कॉपी करा"), 1500);
    } catch {
      reminderText.select();
    }
  });

  messageBtn.addEventListener("click", () => openWhatsApp(reminderText.value));

  // Balances change on every refresh - if this customer's details were open
  // before the refresh that rebuilt this card, reopen them with fresh data
  // instead of leaving it collapsed.
  if (expandedCustomers.has(customer.customerName)) {
    openDetails();
  }

  return node;
}

async function loadInvoices(customer, invoicesBody, invoicesEmpty) {
  try {
    const res = await fetch(`/api/customer/${encodeURIComponent(customer.customerName)}/invoices`);
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load invoices");

    if (data.invoices.length === 0) {
      invoicesEmpty.hidden = false;
    } else {
      invoicesEmpty.hidden = true;
      for (const invoice of data.invoices) {
        const { mainRow, itemsRow } = buildInvoiceRow(customer, invoice);
        invoicesBody.appendChild(mainRow);
        invoicesBody.appendChild(itemsRow);
      }
    }
  } catch (err) {
    invoicesEmpty.hidden = false;
    invoicesEmpty.textContent = `Could not load invoices: ${err.message}`;
  }
}

function buildInvoiceRow(customer, invoice) {
  const mainRow = document.createElement("tr");
  mainRow.innerHTML = `
    <td>${escapeHtml(invoice.voucherNumber || "-")}</td>
    <td>${formatDate(invoice.date)}</td>
    <td><button class="secondary-btn invoice-items-toggle">Items</button></td>
  `;

  const itemsRow = document.createElement("tr");
  itemsRow.className = "invoice-items-row";
  itemsRow.hidden = true;
  const itemsCell = document.createElement("td");
  itemsCell.colSpan = 3;
  itemsCell.innerHTML = `
    <table class="invoice-items-table">
      <thead><tr><th>Product</th><th>Qty</th><th>Rate</th><th>GST %</th><th>Rate incl. GST</th><th>Amount</th></tr></thead>
      <tbody class="invoice-items-body"></tbody>
    </table>
    <textarea class="invoice-share-text" rows="6" readonly></textarea>
    <button class="secondary-btn invoice-share-copy">Copy this invoice's message</button>
  `;
  itemsRow.appendChild(itemsCell);

  const toggleBtn = mainRow.querySelector(".invoice-items-toggle");
  const itemsBody = itemsCell.querySelector(".invoice-items-body");
  const shareText = itemsCell.querySelector(".invoice-share-text");
  const shareCopyBtn = itemsCell.querySelector(".invoice-share-copy");

  let rendered = false;

  toggleBtn.addEventListener("click", () => {
    const willShow = itemsRow.hidden;
    itemsRow.hidden = !willShow;
    toggleBtn.textContent = willShow ? "Hide" : "Items";
    if (willShow && !rendered) {
      rendered = true;
      for (const item of invoice.items) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHtml(item.productName)}</td>
          <td class="num">${item.qty != null ? item.qty + (item.unit ? " " + item.unit : "") : "-"}</td>
          <td class="num">${item.rate != null ? formatMoney(item.rate) : "-"}</td>
          <td class="num">${item.gstPercent != null ? item.gstPercent + "%" : "-"}</td>
          <td class="num">${item.rateInclGst != null ? formatMoney(item.rateInclGst) : "-"}</td>
          <td class="num">${formatMoney(item.amount)}</td>
        `;
        itemsBody.appendChild(tr);
      }
      shareText.value = buildInvoiceShareMessage(customer, invoice);
    }
  });

  shareCopyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(shareText.value);
      shareCopyBtn.textContent = "Copied!";
      setTimeout(() => (shareCopyBtn.textContent = "Copy this invoice's message"), 1500);
    } catch {
      shareText.select();
    }
  });

  return { mainRow, itemsRow };
}

// Customer-facing text - lists what was bought (name + qty) but never the
// rate/price per item. Rates stay in the app's items table for your own use.
function buildInvoiceShareMessage(customer, invoice) {
  const lines = [];
  lines.push(`प्रिय ${customer.customerName},`);
  lines.push("");
  lines.push(`दि. ${formatDate(invoice.date)} रोजीच्या बिलात (क्र. ${invoice.voucherNumber || "-"}) खालील वस्तू घेतल्या होत्या:`);
  lines.push("");
  for (const item of invoice.items) {
    const qtyText = item.qty != null ? ` - ${item.qty}${item.unit ? " " + item.unit : ""}` : "";
    lines.push(`- ${item.productName}${qtyText}`);
  }
  lines.push("");
  lines.push("धन्यवाद.");
  return lines.join("\n");
}

// Customer-facing text - deliberately excludes product rates/pricing. Rates
// are for your own reference in the app only (see the products table above).
function buildReminderMessage(customer) {
  const lines = [];
  lines.push(`प्रिय ${customer.customerName},`);
  lines.push("");
  const purchaseText = customer.lastSaleDate
    ? `शेवटची खरेदी ${formatDate(customer.lastSaleDate)}, देय दिनांक ${formatDate(customer.dueDate)}`
    : `देय दिनांक ${formatDate(customer.dueDate)}`;

  if (customer.overdueDays > 0) {
    lines.push(`आपल्या खात्यावर ${formatMoney(customer.balance)} रक्कम थकीत आहे (${purchaseText}).`);
    const overdueBills = (customer.bills || []).filter((b) => b.overdueDays > 0);
    if (overdueBills.length > 1) {
      lines.push("");
      lines.push("थकीत रक्कम खालीलप्रमाणे:");
      for (const bill of overdueBills) {
        lines.push(
          `- ${bill.label} (दि. ${formatDate(bill.date)}): ${formatMoney(bill.amount)}, थकीत दिवस ${bill.overdueDays}`
        );
      }
    }
    // No interest in the customer message (owner's choice) - interest is
    // still shown inside the app for your own reference.
    lines.push("");
    lines.push(`थकीत दिवस: ${customer.overdueDays}`);
    lines.push("");
    lines.push("कृपया लवकरात लवकर रक्कम भरावी.");
  } else {
    lines.push(`आपल्या खात्यावर ${formatMoney(customer.balance)} रक्कम बाकी आहे (${purchaseText}).`);
    lines.push("ही रक्कम अजून देय दिनांकाच्या आतच आहे.");
  }
  lines.push("");
  lines.push("धन्यवाद.");

  return lines.join("\n");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

refreshBtn.addEventListener("click", () => {
  if (currentView === "items") loadItemRates();
  else loadOverdue();
});

// Lets the app shell (HTML/CSS/JS) open even when the PC is off - only
// available over HTTPS (or localhost), so on a plain-HTTP address this is
// simply skipped and the app works as before.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// Saves the shell files into the same cache the service worker reads from
// (name must match CACHE in sw.js) straight from the page, using the login
// this page already has. Relying on the service worker to cache them on its
// own needs a second visit, and its background fetches may not carry the
// login at all - so on a first visit the phone would end up with no copy.
async function cacheShell() {
  if (!("caches" in window)) return;
  const cache = await caches.open("overdue-shell-v1");
  for (const url of ["/", "/style.css", "/app.js"]) {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) await cache.put(url, res);
  }
}
cacheShell().catch(() => {});

setGreeting();
showView("home");
primeFromLocalCache();
loadConfig();
loadOverdue();
startAutoRefresh();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const config = require("./config.json");
const tallyClient = require("./tally-client");
const mockData = require("./mock-data");
const gistSync = require("./gist-sync");
const callReminder = require("./call-reminder");
const { calcInterest, todayIso } = require("./interest");

// For testing without touching live Tally: USE_MOCK_DATA=1 node server.js
if (process.env.USE_MOCK_DATA === "1") config.useMockData = true;

const app = express();
const PORT = process.env.PORT || 4000;
const CONFIG_PATH = path.join(__dirname, "config.json");

// Constant-time compare so a wrong guess can't be timed to leak how many
// characters matched.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Login is an in-app password screen backed by a signed cookie, not the
// browser's Basic Auth pop-up: that pop-up doesn't work reliably inside an
// iPhone Home Screen app or alongside a service worker, and it forced every
// static file behind a login, which stopped the phone from keeping its own
// copy of the app. Now the app's files (HTML/CSS/JS - no data in them) are
// public and only the /api routes, which carry the customer data, need the
// login. The password lives in config.json ("auth.password"); changing it
// signs everyone out.
const SESSION_COOKIE = "overdue_session";
const SESSION_DAYS = 365;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const loginFailures = new Map(); // ip -> { count, resetAt }

function sessionKey() {
  return crypto.createHash("sha256").update(`overdue-reminder|${config.auth.password}`).digest();
}

function signToken(expiryMs) {
  const mac = crypto.createHmac("sha256", sessionKey()).update(String(expiryMs)).digest("hex");
  return `${expiryMs}.${mac}`;
}

function tokenValid(token) {
  if (!token) return false;
  const [expiry, mac] = token.split(".");
  const expiryMs = Number(expiry);
  if (!Number.isFinite(expiryMs) || !mac || expiryMs < Date.now()) return false;
  return safeEqual(mac, signToken(expiryMs).split(".")[1]);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function authConfigured() {
  return Boolean(config.auth && config.auth.password);
}

app.post("/api/login", express.json({ limit: "1kb" }), (req, res) => {
  const now = Date.now();
  const entry = loginFailures.get(req.ip);
  if (entry && entry.resetAt > now && entry.count >= LOGIN_MAX_FAILURES) {
    return res.status(429).json({ error: "खूप वेळा चुकीचा password - काही मिनिटांनी पुन्हा प्रयत्न करा." });
  }

  const supplied = req.body && typeof req.body.password === "string" ? req.body.password : "";
  if (!authConfigured() || !safeEqual(supplied, config.auth.password)) {
    const fresh = entry && entry.resetAt > now ? entry : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    fresh.count += 1;
    loginFailures.set(req.ip, fresh);
    return res.status(401).json({ error: "चुकीचा password" });
  }

  loginFailures.delete(req.ip);
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const token = signToken(now + SESSION_DAYS * 24 * 60 * 60 * 1000);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_DAYS * 24 * 60 * 60}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
  );
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (!authConfigured()) {
    console.warn("WARNING: backend/config.json has no auth.password - the data API is unprotected.");
    return next();
  }
  if (tokenValid(readCookie(req, SESSION_COOKIE))) return next();
  res.status(401).json({ error: "Login required", code: "UNAUTHENTICATED" });
});

app.use(express.static(path.join(__dirname, "..", "frontend")));

const { creditPeriodDays, salesLookbackDays } = config.interest;

async function getCustomers() {
  if (config.useMockData) {
    return mockData.getMockCustomers().map((c) => {
      const invoices = mockData.getMockInvoices(c.customerName).map((inv) => ({
        voucherNumber: inv.voucherNumber,
        date: inv.date,
        total: inv.items.reduce((sum, it) => sum + it.amount * (1 + (it.gstPercent || 0) / 100), 0),
      }));
      const openingDate = c.lastSaleDate;
      const bills = tallyClient
        .allocateBillsFifo({ ...c, openingBalance: 0 }, invoices, openingDate)
        .map((b) => ({ ...b, dueDate: b.date ? tallyClient.addDaysYmd(b.date, creditPeriodDays) : null }));
      return {
        ...c,
        dueDate: c.lastSaleDate ? tallyClient.addDaysYmd(c.lastSaleDate, creditPeriodDays) : null,
        bills,
      };
    });
  }
  return tallyClient.fetchOverdueCustomers(config.tally, creditPeriodDays, salesLookbackDays);
}

async function getProductRates(customerName) {
  if (config.useMockData) return mockData.getMockProductRates(customerName);
  return tallyClient.fetchRecentProductRates(config.tally, customerName, salesLookbackDays);
}

async function getInvoices(customerName) {
  if (config.useMockData) return mockData.getMockInvoices(customerName);
  return tallyClient.fetchRecentInvoices(config.tally, customerName, salesLookbackDays);
}

async function getAllProductRates() {
  if (config.useMockData) return mockData.getMockAllProductRates();
  return tallyClient.fetchAllProductRates(config.tally, salesLookbackDays);
}

async function getAllProductPurchaseRates() {
  if (config.useMockData) return mockData.getMockAllProductPurchaseRates();
  return tallyClient.fetchAllProductPurchaseRates(config.tally, salesLookbackDays);
}

app.get("/api/config", (req, res) => {
  res.json({
    interestRatePercentPerMonth: config.interest.ratePercentPerMonth,
    creditPeriodDays,
    useMockData: config.useMockData,
    tallyCompany: config.tally.company,
    // Safe to expose: a secret gist's content is only reachable if you
    // already have this ID, and it never carries the GitHub token itself.
    gistId: config.sync && config.sync.gistId ? config.sync.gistId : null,
  });
});

// Pushes the latest overdue snapshot to a private GitHub Gist so the phone
// can show "last synced data" even when this PC (and the live server) is
// off - see gist-sync.js. Throttled so a burst of dashboard refreshes
// doesn't spam the GitHub API; fire-and-forget so it never slows down the
// response to the frontend.
const GIST_PUSH_INTERVAL_MS = 5 * 60 * 1000;
let lastGistPushAt = 0;

function pushSnapshotToGist(overdueResponse) {
  const sync = config.sync;
  if (!sync || !sync.githubToken || config.useMockData) return;
  if (Date.now() - lastGistPushAt < GIST_PUSH_INTERVAL_MS) return;
  lastGistPushAt = Date.now();

  // Mobile numbers stay on this PC - they are not needed in the cloud copy.
  const customers = overdueResponse.customers.map(({ mobile, ...rest }) => rest);
  const content = JSON.stringify({ ...overdueResponse, customers, syncedAt: new Date().toISOString() });

  (async () => {
    try {
      if (!sync.gistId) {
        const gistId = await gistSync.createGist(sync.githubToken, content);
        config.sync.gistId = gistId;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        console.log("Created GitHub Gist for cloud backup:", gistId);
      } else {
        await gistSync.updateGist(sync.githubToken, sync.gistId, content);
      }
    } catch (err) {
      lastGistPushAt = 0; // allow retrying on the next request instead of waiting a full interval
      console.warn("Cloud snapshot sync failed:", err.message);
    }
  })();
}

async function buildOverdue() {
  const customers = await getCustomers();
  const asOf = todayIso();

  // Every customer with an outstanding balance, not just overdue ones -
  // sorted by outstanding amount, highest first. Interest is computed per
  // bill (see allocateBillsFifo) and summed, not once on the lump balance,
  // so an old unpaid bill accrues more than a recent one even though
  // they're part of the same running account.
  const result = customers
    .map((c) => {
      const bills = (c.bills || []).map((b) => {
        const { overdueDays, interest } = calcInterest(b.amount, b.dueDate, config.interest.ratePercentPerMonth, asOf);
        return { ...b, amount: round2(b.amount), overdueDays, interest: round2(interest) };
      });
      const interest = round2(bills.reduce((sum, b) => sum + b.interest, 0));
      const overdueDays = bills.reduce((max, b) => Math.max(max, b.overdueDays), 0);
      return {
        customerName: c.customerName,
        balance: round2(c.balance),
        owes: c.owes !== false,
        mobile: c.mobile || null,
        lastSaleDate: c.lastSaleDate,
        dueDate: c.dueDate,
        overdueDays,
        interest,
        totalPayable: round2(c.balance + interest),
        bills,
      };
    })
    .sort((a, b) => b.balance - a.balance);

  const overdueCount = result.filter((c) => c.overdueDays > 0).length;
  return { asOf, creditPeriodDays, overdueCount, customers: result };
}

app.get("/api/overdue", async (req, res) => {
  try {
    const response = await buildOverdue();
    pushSnapshotToGist(response);
    res.json(response);
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code });
  }
});

app.get("/api/customer/:name/products", async (req, res) => {
  try {
    const products = await getProductRates(req.params.name);
    res.json({ customerName: req.params.name, products });
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code });
  }
});

app.get("/api/customer/:name/invoices", async (req, res) => {
  try {
    const invoices = await getInvoices(req.params.name);
    res.json({ customerName: req.params.name, invoices });
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const [saleRates, purchaseRates] = await Promise.all([getAllProductRates(), getAllProductPurchaseRates()]);

    const byName = new Map();
    for (const p of saleRates) {
      byName.set(p.productName, {
        productName: p.productName,
        saleRate: p.rate,
        saleGstPercent: p.gstPercent,
        saleRateInclGst: p.rateInclGst,
        saleDate: p.voucherDate,
        lastCustomer: p.lastCustomer,
      });
    }
    for (const p of purchaseRates) {
      const existing = byName.get(p.productName) || { productName: p.productName };
      existing.purchaseRate = p.rate;
      existing.purchaseGstPercent = p.gstPercent;
      existing.purchaseRateInclGst = p.rateInclGst;
      existing.purchaseDate = p.voucherDate;
      existing.supplier = p.supplier;
      byName.set(p.productName, existing);
    }

    const products = Array.from(byName.values()).sort((a, b) => a.productName.localeCompare(b.productName));
    res.json({ products });
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code });
  }
});

// Raw Tally XML passthrough for debugging field names against your real
// Tally install. Not used by the frontend.
app.get("/api/debug/tally-raw", async (req, res) => {
  if (config.useMockData) {
    return res.status(400).json({ error: "Set useMockData to false in config.json first." });
  }
  try {
    const which = ["vouchers", "purchase-vouchers"].includes(req.query.which) ? req.query.which : "balances";
    const raw = await tallyClient.fetchRaw(config.tally, which, salesLookbackDays);
    res.type("text/xml").send(raw);
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code });
  }
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

callReminder.mount(app, { config, getOverdue: buildOverdue, configPath: CONFIG_PATH });

app.listen(PORT, () => {
  console.log(`Tally overdue reminder running at http://localhost:${PORT}`);
  console.log(`Mode: ${config.useMockData ? "MOCK DATA" : "LIVE TALLY (" + config.tally.host + ":" + config.tally.port + ")"}`);
});

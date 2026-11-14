// Recorded reminder calls for overdue customers.
//
// mount(app, { config, getOverdue }) adds:
//   GET  /api/calls            - status, every customer with their call state, recent log
//   POST /api/calls/enabled    - { enabled } master ON/OFF switch
//   POST /api/calls/contact    - { customerName, enabled?, phone? } per-customer ON/OFF + number
//   POST /api/calls/test       - one call to calls.testNumber (your own phone) to hear the message
//   POST /api/calls/whatsapp   - { customerName } notes that you opened a WhatsApp reminder for them
//   POST /api/calls/mode       - { mode: "manual" | "auto" }
//   GET  /api/calls/push-key, POST /api/calls/push-subscribe | push-unsubscribe | push-test
//                              - reminders to YOUR phone (see notify.js)
//   POST /api/calls/result     - { customerName, status } manual mode: you called from your phone,
//                                this records the outcome (only accepted when that customer is due)
// and starts a loop that checks once a minute who is due a call (rules: schedule.js).
//
// All /api routes are behind the app's login (see server.js).

const express = require("express");
const store = require("./store");
const providers = require("./providers");
const notify = require("./notify");
const { effectiveRules, decide, normalizeMobile, localYmd } = require("./schedule");

const TICK_MS = 60 * 1000;
const CUSTOMER_CACHE_MS = 10 * 60 * 1000;
const MAX_CALLS_PER_TICK = 5;
const PENDING_TIMEOUT_MS = 15 * 60 * 1000;
// Owner reminders: a new "call now" batch at most every 10 min; if calls are
// still waiting, a nudge every hour.
const NEW_DUE_MIN_GAP_MS = 10 * 60 * 1000;
const STILL_DUE_GAP_MS = 60 * 60 * 1000;

function mount(app, { config, getOverdue, configPath }) {
  const cfg = () => config.calls || {};
  const rules = () => effectiveRules(cfg());
  const pushKey = notify.setup(config, configPath);

  let cache = { at: 0, customers: null };
  let lastError = null;
  let lastTickAt = null;
  let ticking = false;

  async function customers(force = false) {
    if (!force && cache.customers && Date.now() - cache.at < CUSTOMER_CACHE_MS) return cache.customers;
    const { customers: list } = await getOverdue();
    cache = { at: Date.now(), customers: list };
    return list;
  }

  function newAttempt(customerName, phone, provider = cfg().provider || "dry-run", status = "pending") {
    const attempt = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, customerName, phone, at: new Date().toISOString(), status, sid: null, provider };
    store.load().attempts.push(attempt);
    store.save();
    return attempt;
  }

  async function placeCall(attempt) {
    try {
      const { sid, status } = await providers.startCall(cfg(), attempt.phone);
      attempt.sid = sid;
      attempt.status = status;
      lastError = null;
    } catch (err) {
      attempt.status = "failed";
      attempt.error = err.message;
      lastError = `${new Date().toLocaleString("en-IN")}: ${err.message}`;
      console.warn("Reminder call failed:", err.message);
    }
    store.save();
  }

  async function pollPending() {
    const st = store.load();
    for (const a of st.attempts.filter((x) => x.status === "pending")) {
      if (Date.now() - new Date(a.at).getTime() > PENDING_TIMEOUT_MS) {
        a.status = "failed";
        a.error = "No result from provider within 15 minutes";
        continue;
      }
      if (!a.sid) continue;
      try {
        a.status = await providers.checkCall(cfg(), a.sid);
      } catch (err) {
        lastError = `${new Date().toLocaleString("en-IN")}: ${err.message}`;
      }
    }
    store.save();
  }

  function nameList(list) {
    const shown = list.slice(0, 4).map((x) => x.name + (x.retry ? " (आधी उचलला नाही)" : ""));
    return shown.join(", ") + (list.length > 4 ? ` आणि आणखी ${list.length - 4}` : "");
  }

  // Manual mode: tell the owner's phone who to call now.
  async function ownerNotifyTick(list, now) {
    const st = store.load();
    const ns = (st.notifyState = st.notifyState || { seen: {} });
    const r = rules();
    const today = localYmd(now);

    const due = [];
    for (const customer of list) {
      const contact = st.contacts[customer.customerName];
      if (!contact || !contact.enabled) continue;
      const attempts = store.attemptsFor(customer.customerName);
      if (!decide({ customer, contact, attempts, rules: r, now }).call) continue;
      const triedToday = attempts.filter((a) => localYmd(new Date(a.at)) === today).length;
      due.push({ name: customer.customerName, key: `${today}#${triedToday}`, retry: triedToday > 0 });
    }

    const fresh = due.filter((d) => ns.seen[d.name] !== d.key);
    const sinceLast = Date.now() - (ns.lastSentAt || 0);
    let payload = null;
    if (fresh.length && sinceLast >= NEW_DUE_MIN_GAP_MS) {
      const firstToday = ns.morningDate !== today;
      payload = {
        title: firstToday ? `🌅 आज ${due.length} ग्राहकांना कॉल करायचा आहे` : `📞 आता कॉल करा (${fresh.length})`,
        body: nameList(firstToday ? due : fresh),
        tag: "calls-due",
      };
      ns.morningDate = today;
      for (const d of fresh) ns.seen[d.name] = d.key;
    } else if (due.length && sinceLast >= STILL_DUE_GAP_MS) {
      payload = { title: `⏰ अजून ${due.length} कॉल बाकी आहेत`, body: nameList(due), tag: "calls-due" };
    }

    // End-of-day summary, once, a few minutes after the calling window closes.
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (!payload && nowMin >= r.windowEnd + 5 && ns.summaryDate !== today && now.getDay() !== 0) {
      ns.summaryDate = today;
      const calls = st.attempts.filter((a) => a.provider === "manual" && localYmd(new Date(a.at)) === today);
      const wa = (st.messages || []).filter((m) => localYmd(new Date(m.at)) === today).length;
      if (calls.length || wa) {
        const answered = calls.filter((a) => a.status === "answered").length;
        payload = {
          title: "📋 आजचा हिशोब",
          body: `${calls.length} कॉल केले (${answered} उचलले, ${calls.length - answered} नाही) · ${wa} WhatsApp पाठवले`,
          tag: "calls-summary",
        };
      }
      store.save();
    }

    if (!payload) return;
    ns.lastSentAt = Date.now();
    store.save();
    const sent = await notify.sendAll({ ...payload, url: "/calls.html" });
    console.log(`Owner reminder "${payload.title}" sent to ${sent} phone(s)`);
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    lastTickAt = new Date().toISOString();
    try {
      await pollPending();
      const st = store.load();
      if (st.mode !== "auto") {
        if (notify.count()) await ownerNotifyTick(await customers(), new Date());
        return;
      }
      if (!st.enabled) return;

      const list = await customers();
      const now = new Date();
      let placed = 0;
      for (const customer of list) {
        if (placed >= MAX_CALLS_PER_TICK) break;
        const contact = st.contacts[customer.customerName];
        if (!contact || !contact.enabled) continue;
        const d = decide({ customer, contact, attempts: store.attemptsFor(customer.customerName), rules: rules(), now });
        if (!d.call) continue;
        const attempt = newAttempt(customer.customerName, d.phone);
        await placeCall(attempt);
        placed += 1;
      }
    } catch (err) {
      lastError = `${new Date().toLocaleString("en-IN")}: ${err.message}`;
      console.warn("Call reminder tick failed:", err.message);
    } finally {
      ticking = false;
    }
  }

  const router = express.Router();
  router.use(express.json({ limit: "10kb" }));

  router.get("/", async (req, res) => {
    const st = store.load();
    let list = [];
    let tallyError = null;
    try {
      list = await customers(req.query.refresh === "1");
    } catch (err) {
      tallyError = err.message;
    }
    const now = new Date();
    const r = rules();
    const rows = list
      .filter((c) => c.owes !== false)
      .map((c) => {
        const contact = st.contacts[c.customerName] || { enabled: false, phone: "" };
        const attempts = store.attemptsFor(c.customerName);
        const d = decide({ customer: c, contact: { ...contact, enabled: true }, attempts, rules: r, now });
        return {
          customerName: c.customerName,
          balance: c.balance,
          interest: c.interest || 0,
          totalPayable: c.totalPayable || c.balance,
          overdueDays: c.overdueDays,
          lastWhatsApp: ((st.messages || []).filter((m) => m.customerName === c.customerName).at(-1) || {}).at || null,
          tallyMobile: c.mobile || null,
          phone: contact.phone || "",
          effectivePhone: normalizeMobile(contact.phone || c.mobile),
          enabled: Boolean(contact.enabled),
          due: Boolean(contact.enabled && d.call),
          status: contact.enabled ? (d.call ? (st.mode === "manual" ? "आता कॉल करा" : "पुढच्या मिनिटात कॉल") : d.reason) : "बंद (OFF)",
          nextAt: d.nextAt ? d.nextAt.toISOString() : null,
          lastAttempt: attempts.at(-1) || null,
          totalAttempts: attempts.length,
        };
      });
    res.json({
      mode: st.mode,
      enabled: st.enabled,
      shopName: cfg().shopName || "कोरे कृषी सेवा केंद्र, शिरूर अनंतपाळ",
      interestRatePercentPerMonth: (config.interest || {}).ratePercentPerMonth || 0,
      provider: cfg().provider || "dry-run",
      rules: r,
      testNumberSet: Boolean(normalizeMobile(cfg().testNumber)),
      pushPhones: notify.count(),
      lastTickAt,
      lastError,
      tallyError,
      customers: rows,
      log: st.attempts.slice(-60).reverse(),
    });
  });

  router.post("/enabled", (req, res) => {
    const st = store.load();
    st.enabled = Boolean(req.body && req.body.enabled);
    store.save();
    res.json({ enabled: st.enabled });
    if (st.enabled) tick();
  });

  router.get("/push-key", (req, res) => res.json({ key: pushKey, phones: notify.count() }));

  router.post("/push-subscribe", (req, res) => {
    try {
      const phones = notify.addSubscription(req.body && req.body.subscription);
      res.json({ ok: true, phones });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post("/push-unsubscribe", (req, res) => {
    if (req.body && req.body.endpoint) notify.removeSubscription(String(req.body.endpoint));
    res.json({ ok: true, phones: notify.count() });
  });

  router.post("/push-test", async (req, res) => {
    const sent = await notify.sendAll({ title: "🔔 थकबाकी ॲप", body: "सूचना चालू आहेत. कॉल करायची वेळ झाली की इथे कळवू.", url: "/calls.html", tag: "test" });
    res.json({ sent });
  });

  router.post("/whatsapp", (req, res) => {
    const { customerName, phone: rawPhone } = req.body || {};
    if (!customerName || typeof customerName !== "string") return res.status(400).json({ error: "customerName required" });
    const st = store.load();
    st.messages = st.messages || [];
    const phone = normalizeMobile(rawPhone) || null;
    st.messages.push({ customerName, phone, at: new Date().toISOString(), channel: "whatsapp" });
    store.save();
    res.json({ ok: true });
  });

  router.post("/mode", (req, res) => {
    const mode = req.body && req.body.mode;
    if (!["manual", "auto"].includes(mode)) return res.status(400).json({ error: "mode must be manual or auto" });
    const st = store.load();
    st.mode = mode;
    store.save();
    res.json({ mode });
  });

  router.post("/result", async (req, res) => {
    const { customerName, status } = req.body || {};
    if (!["answered", "no_answer", "busy"].includes(status)) return res.status(400).json({ error: "status must be answered, no_answer or busy" });
    const st = store.load();
    let list;
    try {
      list = await customers();
    } catch (err) {
      return res.status(502).json({ error: `Tally: ${err.message}` });
    }
    const customer = list.find((c) => c.customerName === customerName);
    if (!customer) return res.status(404).json({ error: "ग्राहक सापडला नाही" });
    const contact = st.contacts[customerName];
    const d = decide({ customer, contact, attempts: store.attemptsFor(customerName), rules: rules(), now: new Date() });
    // Also blocks a double-tap from logging the same call twice.
    if (!d.call) return res.status(409).json({ error: `आत्ता नोंद करता येणार नाही: ${d.reason}` });
    const attempt = newAttempt(customerName, d.phone, "manual", status);
    res.json({ attempt });
  });

  router.post("/contact", (req, res) => {
    const { customerName, enabled, phone } = req.body || {};
    if (!customerName || typeof customerName !== "string") return res.status(400).json({ error: "customerName required" });
    const st = store.load();
    const contact = st.contacts[customerName] || { enabled: false, phone: "" };
    if (phone !== undefined) {
      const p = String(phone).trim();
      if (p && !normalizeMobile(p)) return res.status(400).json({ error: "चुकीचा मोबाईल नंबर (10 अंकी, 6-9 ने सुरू)" });
      contact.phone = p;
    }
    if (enabled !== undefined) contact.enabled = Boolean(enabled);
    st.contacts[customerName] = contact;
    store.save();
    res.json({ ok: true, contact });
  });

  router.post("/test", async (req, res) => {
    const phone = normalizeMobile(cfg().testNumber);
    if (!phone) return res.status(400).json({ error: "config.json मध्ये calls.testNumber (तुमचा स्वतःचा नंबर) भरा" });
    const attempt = newAttempt("TEST (स्वतःचा नंबर)", phone);
    await placeCall(attempt);
    res.json({ attempt });
  });

  app.use("/api/calls", router);

  setInterval(tick, TICK_MS);
  setTimeout(tick, 5000);
  return { tick, ownerNotifyTick };
}

module.exports = { mount };

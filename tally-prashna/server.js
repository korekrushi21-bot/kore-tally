const fs = require("fs");
const path = require("path");
const express = require("express");
const tally = require("./tally");
const offline = require("./offline");
const ai = require("./ai");

const CONFIG_PATH = process.env.TALLY_PRASHNA_CONFIG || path.join(__dirname, "config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  fs.copyFileSync(path.join(__dirname, "config.example.json"), CONFIG_PATH);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

function tallyCfg() {
  return {
    host: config.tally.host,
    port: config.tally.port,
    company: config.tally.company,
    defaultLookbackDays: config.defaultLookbackDays,
    anthropicApiKey: config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
  };
}

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", async (req, res) => {
  const cfg = tallyCfg();
  let tallyOk = false;
  let tallyError = null;
  try {
    await tally.getVoucherTypes(cfg);
    tallyOk = true;
  } catch (err) {
    tallyError = err.message;
  }
  res.json({ tallyOk, tallyError, aiAvailable: Boolean(cfg.anthropicApiKey), company: cfg.company || null });
});

app.post("/api/refresh", (req, res) => {
  tally.clearCache();
  res.json({ ok: true });
});

// Direct, read-only search tools for JARVIS: the caller (an AI) picks the search and its filters itself, so it can
// answer any question (expenses, payments, cash/bank balance, day book, a party's statement...). Only these
// read-only functions from queries.js can be called; nothing here writes to Tally.
const queries = require("./queries");
const TOOLS = ["listNames", "withoutBill", "searchVouchers", "profit", "itemRates", "ledgerBalances", "stockSummary", "collections"];

app.post("/api/tool", async (req, res) => {
  const name = String((req.body && req.body.name) || "");
  if (!TOOLS.includes(name)) return res.status(400).json({ error: "unknown tool", tools: TOOLS });
  const args = req.body.args && typeof req.body.args === "object" ? req.body.args : {};
  try {
    res.json({ tool: name, result: await queries[name](tallyCfg(), args) });
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code });
  }
});

app.post("/api/ask", async (req, res) => {
  const question = String((req.body && req.body.question) || "").trim().slice(0, 1000);
  if (!question) return res.status(400).json({ error: "Prashna rikama aahe" });
  const cfg = tallyCfg();
  const wantAi = req.body.mode !== "offline" && Boolean(cfg.anthropicApiKey);

  try {
    if (wantAi) {
      const history = Array.isArray(req.body.history)
        ? req.body.history
            .slice(-6)
            .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
            .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
        : [];
      try {
        const out = await ai.ask(cfg, question, history);
        return res.json({ mode: "ai", ...out });
      } catch (err) {
        // Tally is down - no point falling back, offline needs Tally too.
        if (err.code === "TALLY_UNREACHABLE") throw err;
        // AI unavailable (no credit, no internet, bad key): answer offline.
        const out = await offline.ask(cfg, question);
        return res.json({ mode: "offline", aiError: err.message, ...out });
      }
    }
    const out = await offline.ask(cfg, question);
    res.json({ mode: "offline", ...out });
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code });
  }
});

const PORT = config.port || 4100;
// 127.0.0.1 only - this PC can open it, nothing else on the network can.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Tally Prashna: http://127.0.0.1:${PORT}`);
  console.log(`Tally: ${config.tally.host}:${config.tally.port} | AI: ${tallyCfg().anthropicApiKey ? "on" : "off (offline search)"}`);
});

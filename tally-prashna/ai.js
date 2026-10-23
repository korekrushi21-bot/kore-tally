// Claude AI mode: Claude reads the question (Marathi / English / mixed),
// calls the read-only search tools in queries.js, and writes the answer.
// Only the search results for that question are sent to Anthropic - never
// the whole Tally company.

const Anthropic = require("@anthropic-ai/sdk");
const queries = require("./queries");

const MODEL = "claude-opus-5";
const MAX_TOOL_ROUNDS = 8;

const dateProps = {
  from: { type: "string", description: "Start date YYYY-MM-DD (optional; default about last 2 years)" },
  to: { type: "string", description: "End date YYYY-MM-DD (optional; default today)" },
};

const tools = [
  {
    name: "list_names",
    description:
      "List exact names from Tally masters so you can match what the user typed (e.g. 'युरिया' or 'urea' -> 'UREA 45 KG', a party nickname -> full ledger name). Use this first when unsure of spelling.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["items", "ledgers", "groups", "voucher_types"] },
        contains: { type: "string", description: "Part of the name to filter by (English letters work best). Omit to list all." },
      },
      required: ["kind"],
    },
  },
  {
    name: "without_bill",
    description:
      "Goods given or received WITHOUT a bill - Delivery Note, Receipt Note, Delivery Challan, Rejections, Material In/Out and similar voucher types. Returns a per party+item summary with pending (not yet billed) qty, plus each entry. Billed/pending status comes from Tally tracking numbers; status 'mahit nahi' means no tracking number was used so billing cannot be confirmed.",
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string", description: "Stock item name or part of it" },
        party: { type: "string", description: "Party ledger name or part of it" },
        pendingOnly: { type: "boolean", description: "Only entries not yet fully billed" },
        ...dateProps,
      },
    },
  },
  {
    name: "search_vouchers",
    description:
      "Search any vouchers (Sales, Purchase, Receipt, Payment, Journal, Delivery Note...) by item, party, voucher type or narration text. Returns matching vouchers with items and ledger entries, plus totals per voucher type.",
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string" },
        party: { type: "string", description: "Party or any ledger in the voucher" },
        voucherType: { type: "string" },
        text: { type: "string", description: "Search narration / reference / voucher number" },
        limit: { type: "integer", description: "Max vouchers to return (default 100, max 200)" },
        ...dateProps,
      },
    },
  },
  {
    name: "profit",
    description:
      "Profit (nafa) on sales, per item, the way the shop counts it: rate sold to the customer incl. GST minus the item's average purchase rate incl. GST. Filter by party (customer) and/or item and date range. Sales returns (Credit Notes) are subtracted. Items with no purchase rate are listed separately.",
    input_schema: {
      type: "object",
      properties: {
        party: { type: "string", description: "Customer ledger name or part of it" },
        item: { type: "string" },
        ...dateProps,
      },
    },
  },
  {
    name: "item_rates",
    description:
      "What an item is bought and sold at (rate / bhav / dar), incl. GST: average purchase rate and average sale rate over the period, the latest purchase and latest sale bill with its date and party, plus Tally's own stock valuation rate (excl. GST) and closing qty. Filter by item and optionally by party.",
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string", description: "Item name or part of it" },
        party: { type: "string", description: "Only bills of this party (supplier or customer)" },
        ...dateProps,
      },
    },
  },
  {
    name: "ledger_balances",
    description: "Current closing balance of ledgers (party outstanding, bank, cash, expenses...). Dr = receivable (yene), Cr = payable (dene).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Ledger name or part of it" },
        group: { type: "string", description: "Group, e.g. 'Sundry Debtors', 'Sundry Creditors' (includes sub-groups)" },
        nonZeroOnly: { type: "boolean" },
      },
    },
  },
  {
    name: "stock_summary",
    description: "Current closing stock (qty, value) of stock items.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Item name or part of it" },
        group: { type: "string", description: "Stock group" },
        negativeOnly: { type: "boolean", description: "Only items with minus (negative) stock" },
      },
    },
  },
];

const toolFns = {
  list_names: queries.listNames,
  without_bill: queries.withoutBill,
  search_vouchers: queries.searchVouchers,
  profit: queries.profit,
  item_rates: queries.itemRates,
  ledger_balances: queries.ledgerBalances,
  stock_summary: queries.stockSummary,
};

function systemPrompt() {
  return `You answer questions about the user's Tally accounting data for their agri-input shop (fertilisers like urea, DAP, seeds, pesticides). Today is ${queries.todayYmd()}.

You can only READ Tally through the tools. Never claim to have changed anything.

- The user usually writes Marathi in English letters (e.g. "urea without bill konta v konchya ac var aahe"), sometimes Devanagari or English. Reply in the same language and script the user used.
- "Without bill", "bina bill", "challan", "delivery" means the without_bill tool. "Konchya a/c var" = which party ledger.
- Item and party names in Tally are usually in English capitals. If a search returns nothing, use list_names to find the right spelling and search again before saying nothing was found.
- Base every number on tool results. Do not guess. If the data cannot answer the question, say so plainly.
- Consistency matters most: the same question asked in different words, word order or spelling ("urea without bill konachya nave", "bina bill urea kuthe dila", "युरिया चलन कोणाच्या खात्यावर") must get the same answer. So: always call the tools fresh for every question (never reuse numbers from earlier messages), search with the broad base word ("urea", not "urea 45kg") so every matching item is included, and when several items/parties match, include all of them rather than picking one.
- Always use this fixed answer format: one line with the direct answer (totals), then a markdown table. For without-bill questions the table columns are exactly: Party (A/c) | Item | Qty | Bill baki qty | Date | Voucher. Sort rows by party name, then date. Show amounts as ₹ with Indian digit grouping and dates as DD-MM-YYYY.
- If billed/pending status is "mahit nahi", say briefly that no tracking number was used in Tally, so the list shows every without-bill entry, not only the unbilled ones.`;
}

async function runTool(cfg, name, input) {
  const fn = toolFns[name];
  if (!fn) return { error: `Unknown tool ${name}` };
  try {
    return await fn(cfg, input || {});
  } catch (err) {
    return { error: err.message };
  }
}

async function ask(cfg, question, history = []) {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const messages = [...history, { role: "user", content: question }];
  const toolLog = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: systemPrompt(),
      tools,
      messages,
      output_config: { effort: "medium" },
      // If Claude Opus 5 declines a request, the API retries it on a
      // fallback model instead of returning a refusal.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") {
      return { answer: "Maaf kara, ya prashnache uttar deta aale nahi.", toolLog };
    }

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const answer = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { answer: answer || "(uttar rikame aale)", toolLog };
    }

    const results = await Promise.all(
      toolUses.map(async (tu) => {
        const result = await runTool(cfg, tu.name, tu.input);
        toolLog.push({ tool: tu.name, input: tu.input });
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
          ...(result && result.error ? { is_error: true } : {}),
        };
      })
    );
    messages.push({ role: "user", content: results });
  }
  return { answer: "Khup vela shodhle pan uttar poorna zale nahi - prashna jara specific vichara.", toolLog };
}

module.exports = { ask };

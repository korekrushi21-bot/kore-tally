// Offline mode: no AI, nothing leaves the PC. Picks out item / party names
// and a few keywords from the question and runs the matching search.
// Understands simple questions like:
//   "urea without bill"        "urea challan konchya ac var"
//   "patil balance"            "dap stock"         "urea sales"

const tally = require("./tally");
const queries = require("./queries");

const INTENTS = [
  { key: "collection", re: /\bjama\b|\bjamaa\b|collection|vasul|vasuli|receipts?(?!\s*note)|paise\s*(aale|ale|milale)|जमा|वसुल|पावती|पैसे\s*(आले|मिळाले)/i },
  { key: "profit", re: /profit|nafa|nafa|fayda|faida|munafa|margin|नफा|फायदा|मुनाफा/i },
  { key: "withoutBill", re: /without|w\/o|bina|vina|bill\s*nahi|bill\s*nasle|challan|chalan|delivery|receipt\s*note|विना|बिना|बिल\s*नाही|चलन|डिलिव्हरी/i },
  { key: "rate", re: /\brates?\b|\bbhav\b|\bbhaav\b|\bprice\b|\bkimmat\b|\bkimat\b|\bdar\b|(^|\s)(दर|भाव|किंमत|किमत)(\s|$)/i },
  { key: "balance", re: /balance|baki|baaki|outstanding|yene|yena|yaych|dene|dyaych|udhar|debtor|creditor|बाकी|येणे|देणे|उधार|बॅलन्स|याय/i },
  { key: "stock", re: /stock|satha|saatha|shillak|godown|साठा|स्टॉक|शिल्लक/i },
  { key: "sales", re: /sale|sell|vikri|vikla|विक्री|विकले/i },
  { key: "purchase", re: /purchase|kharedi|kharidi|खरेदी/i },
];

const STOP = new Set(
  "the and kay kaay kiti konta konti konte kontya konchya konachya kona kon var vr ac a/c account aahe ahe aahet ahet sanga sang dakhva dya madhe mdhe tally cha chi che la ne ka te to ti ya he bill without bina vina nahi challan delivery note receipt balance baki stock sale sales purchase kharedi vikri total list show all sarv kuthe kiti aaj today mahina mahinyat mahine varsh varshi month year chalu nave khatyavar dila dile ghetla minus negative mainas dakhava dakhwa sarvat jast kami yaychi yaychya dyaychi dyaychya konachi konacha sundry debtors creditors minus negative mainas dakhava dakhwa sell selling sold sales sale profit nafa fayda faida munafa margin mala mla zale zala jhala chya madhun milala kamavla rate rates bhav bhaav price kimmat kimat dar दर भाव किंमत किमत".split(" ")
);

// Common ways the same product gets written -> how it's usually named in
// Tally. Add your own here if a name isn't being recognised.
const ALIASES = {
  "युरिया": "urea", yuriya: "urea", uriya: "urea", yuria: "urea", uria: "urea",
  "डीएपी": "dap", "डी.ए.पी": "dap", dap: "dap",
  "पोटॅश": "potash", "पोटाश": "potash", mop: "potash",
  "सुफला": "suphala", sufala: "suphala",
  "एसएसपी": "ssp", "सिंगल": "ssp",
  "बियाणे": "seed", biyane: "seed", "बी": "seed",
};

// Rough Devanagari -> English letters, so "पाटील" can still find "PATIL".
const DEV = {
  "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ट": "t", "ठ": "th",
  "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n", "प": "p", "फ": "ph",
  "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "ळ": "l", "व": "v", "श": "sh", "ष": "sh",
  "स": "s", "ह": "h", "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "े": "e", "ै": "ai", "ो": "o",
  "ौ": "au", "ं": "n", "ॅ": "e", "ॉ": "o", "्": "",
};
function devToLatin(w) {
  return [...w].map((c) => (c in DEV ? DEV[c] : c)).join("");
}

// Sound-alike key so spelling variants compare equal:
// "urea" / "yuriya" / "uria" -> "uria", "patil" / "pateel" -> "patil".
function soundKey(w) {
  return devToLatin(String(w).toLowerCase())
    .replace(/[^a-z0-9]/g, "")
    .replace(/^y(?=[aeiou])/, "")
    .replace(/ee|ea|ie|e|iy/g, "i")
    .replace(/oo|ou/g, "u")
    .replace(/w/g, "v")
    .replace(/sh|z/g, "s")
    .replace(/ph|f/g, "f")
    .replace(/([a-z])h/g, "$1")
    .replace(/ya$/, "a")
    .replace(/(.)\1+/g, "$1");
}

function words(q) {
  const out = [];
  for (const raw of q.toLowerCase().split(/[^a-z0-9ऀ-ॿ.]+/)) {
    const w = raw.replace(/\.+$/, "");
    if (!w || STOP.has(w)) continue;
    if (ALIASES[w]) out.push(ALIASES[w]);
    else if (w.length >= 3 || /[ऀ-ॿ]/.test(w)) out.push(w);
  }
  return [...new Set(out)];
}

// True if `word` from the question matches some part of a Tally name,
// either literally or by sound (spelling variants, Devanagari).
function wordMatchesName(name, word) {
  const n = queries.norm(name);
  const w = queries.norm(word);
  if (w.length >= 3 && n.includes(w)) return true;
  const key = soundKey(word);
  if (key.length < 3) return false;
  const consonants = (k) => k.replace(/[aeiou]/g, "");
  const wc = consonants(key);
  return String(name)
    .split(/[^A-Za-z0-9]+/)
    .some((part) => {
      if (part.length < 3) return false;
      const pk = soundKey(part);
      if (pk.startsWith(key)) return true;
      // Marathi names are spelled with different vowels ("Dhanraj" / "Dhanaraj", "Rajendra" / "Rajendar"):
      // same first letter and exactly the same consonants in the same order counts as the same word.
      return key.length >= 4 && wc.length >= 3 && pk[0] === key[0] && consonants(pk) === wc;
    });
}

// Names in Tally that match a word from the question, best first.
function findNames(names, qWords) {
  const hits = new Map();
  for (const name of names) {
    for (const w of qWords) {
      if (wordMatchesName(name, w)) hits.set(name, (hits.get(name) || 0) + w.length);
    }
  }
  return [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

// The question word that matched, used as the filter (so "urea" matches
// every UREA item, not just the first one). Returns the matching names too,
// because a sound-alike word ("yuriya") won't literally match the names.
function bestWord(names, qWords) {
  let best = null;
  for (const w of qWords) {
    const matched = names.filter((n) => wordMatchesName(n, w));
    if (!matched.length) continue;
    if (!best || w.length > best.word.length) best = { word: w, names: matched };
  }
  if (!best || best.names.length < 2 || qWords.length < 2) return best;

  // Ledger names look like "Person Name(alias),Village". A question word that only shows up in the
  // village ("Dhanraj Kore,Patilwadi") or inside the brackets ("Dhanraj Biradar(Raosaheb Patil)")
  // must not count as much as the person's own name. So narrow down part by part, closest first:
  // the plain name, then the name with its brackets, then the whole thing with the village. As soon
  // as one part has names holding two or more of the question's words, only those are kept - that is
  // how "dhanraj patil" gives just "Dhanraj Patil,Dhamangaon".
  const hits = (text) => qWords.filter((w) => wordMatchesName(text, w)).length;
  const parts = [
    (n) => String(n).split(",")[0].replace(/\([^)]*\)/g, " "), // Dhanraj Biradar
    (n) => String(n).split(",")[0], // Dhanraj Biradar(Raosaheb Patil)
    (n) => String(n), // Dhanraj Biradar(Raosaheb Patil),Village
  ];
  for (const part of parts) {
    const scores = best.names.map((n) => hits(part(n)));
    const top = Math.max(...scores);
    if (top > 1) {
      best.names = best.names.filter((n, i) => scores[i] === top);
      break;
    }
  }
  return best;
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "aaj", "ya mahinyat", "ya varshi" etc. -> a from-date. Year = financial
// year (1 April).
function periodFrom(q) {
  const now = new Date();
  if (/\b(aaj|aj|today)\b|आज/i.test(q)) return ymd(now);
  if (/ya\s*mahin|is\s*mahin|chalu\s*mahin|this\s*month|या\s*महिन/i.test(q)) return ymd(new Date(now.getFullYear(), now.getMonth(), 1));
  if (/ya\s*varsh|chalu\s*varsh|this\s*year|या\s*वर्ष/i.test(q)) {
    const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return ymd(new Date(fyYear, 3, 1));
  }
  return undefined;
}

async function ask(cfg, question) {
  const qWords = words(question);
  const from = periodFrom(question);
  const intent = (INTENTS.find((i) => i.re.test(question)) || {}).key;

  const [items, ledgers] = await Promise.all([tally.getStockItems(cfg), tally.getLedgers(cfg)]);
  const itemNames = items.map((i) => i.name);
  const ledgerNames = ledgers.map((l) => l.name);

  const itemMatch = findNames(itemNames, qWords).length ? bestWord(itemNames, qWords) : null;
  // Every word that belongs to the item's own name is out of the party search - otherwise
  // "bio r 303 500ml" would also pick up a supplier called "... Biotech" from its "bio".
  const partyWords = qWords.filter((w) => !(itemMatch && itemMatch.names.some((n) => wordMatchesName(n, w))));
  const partyMatch = findNames(ledgerNames, partyWords).length ? bestWord(ledgerNames, partyWords) : null;

  // Filters are the exact Tally names that matched, so "urea", "yuriya"
  // and "युरिया" all run the very same search.
  const itemWord = itemMatch ? itemMatch.names : null;
  const partyWord = partyMatch ? partyMatch.names : null;

  const understood = {
    intent: intent || "search",
    item: itemMatch ? `${itemMatch.word} → ${itemMatch.names.slice(0, 5).join(", ")}${itemMatch.names.length > 5 ? "…" : ""}` : null,
    party: partyMatch ? `${partyMatch.word} → ${partyMatch.names.slice(0, 5).join(", ")}${partyMatch.names.length > 5 ? "…" : ""}` : null,
  };

  if (intent === "collection") {
    // "aaj kiti jama zale" - money received in the period (default today), all parties or the one named
    const r = await queries.collections(cfg, { party: partyWord, from: from || ymd(new Date()) });
    return { understood, kind: "collection", result: r };
  }
  if (intent === "profit") {
    const r = await queries.profit(cfg, { party: partyWord, item: itemWord, from });
    return { understood, kind: "profit", result: r };
  }
  if (intent === "rate") {
    const r = await queries.itemRates(cfg, { item: itemWord, party: partyWord, from });
    return { understood, kind: "rate", result: r };
  }
  if (intent === "withoutBill") {
    const r = await queries.withoutBill(cfg, { item: itemWord, party: partyWord, from });
    return { understood, kind: "withoutBill", result: r };
  }
  const negative = /minus|negative|mainas|उणे|मायनस|ऋण/i.test(question);
  if (intent === "stock" || (negative && !partyWord) || (!intent && itemWord && !partyWord && /kiti|stock/.test(question))) {
    if (negative) understood.intent = "minus stock";
    const r = await queries.stockSummary(cfg, { name: itemWord, negativeOnly: negative });
    return { understood, kind: "stock", result: r };
  }
  if (intent === "balance") {
    // No party named: "yene / yaychi" = customers who owe us (Sundry
    // Debtors), "dene / dyaychi" = suppliers we owe (Sundry Creditors).
    let group;
    if (!partyWord) {
      group = /dene|dena|dyaych|dyaych|देणे|द्याय|creditor|supplier/i.test(question) ? "Sundry Creditors" : "Sundry Debtors";
      understood.party = `sarv ${group}`;
    }
    const r = await queries.ledgerBalances(cfg, { name: partyWord, group, nonZeroOnly: !partyWord });
    return { understood, kind: "balance", result: r };
  }
  if (itemWord || partyWord) {
    const voucherType = intent === "sales" ? "Sales" : intent === "purchase" ? "Purchase" : undefined;
    const r = await queries.searchVouchers(cfg, { item: itemWord, party: partyWord, voucherType, from, limit: 100 });
    return { understood, kind: "vouchers", result: r };
  }
  return {
    understood,
    kind: "help",
    result: {
      message:
        "Prashnatil item kinva party che naav Tally madhe sapadle nahi. Naav English akshrat lihun paha - udaharan: 'urea without bill', 'patil balance', 'dap stock', 'urea sales'.",
    },
  };
}

module.exports = { ask, bestWord, words };

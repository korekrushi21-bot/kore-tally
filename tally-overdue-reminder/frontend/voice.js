// Voice questions about Tally data (Marathi / Hindi / English). Read-only: it only
// calls GET /api/overdue and GET /api/products, and never sends anything to Tally.
// Speech-to-text is the browser's own (Chrome/Edge) and needs internet; the Tally
// data itself never leaves this PC - only your voice goes to the browser's speech service.

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const micBtn = $("mic");

// ---------- data (cached briefly) ----------
let cache = { at: 0, customers: [], products: [] };
async function loadData() {
  if (Date.now() - cache.at < 60_000) return cache;
  const [o, p] = await Promise.all([fetch("/api/overdue"), fetch("/api/products")]);
  if (!o.ok) throw new Error("Tally कडून डेटा मिळाला नाही (Tally उघडे आहे का?)");
  const overdue = await o.json();
  const prods = p.ok ? await p.json() : { products: [] };
  cache = { at: Date.now(), customers: overdue.customers || [], products: prods.products || [] };
  return cache;
}

// ---------- phonetic matching: Devanagari and Roman names compare by consonant skeleton ----------
const CONS = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ट": "t", "ठ": "th",
  "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n", "प": "p", "फ": "f",
  "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "ळ": "l", "व": "v", "श": "sh", "ष": "sh",
  "स": "s", "ह": "h", "क्ष": "ksh", "ज्ञ": "dny",
};
const VOWELS = { "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ऋ": "ru", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o" };
const MATRAS = { "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ृ": "ru" };

function devToRoman(s) {
  let out = "";
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const pair = c + (chars[i + 1] === "्" ? "" : "");
    if (c === "क" && chars[i + 1] === "्" && chars[i + 2] === "ष") { out += "ksh"; i += 2; if (!matraNext(chars, i)) out += "a"; continue; }
    if (c === "ज" && chars[i + 1] === "्" && chars[i + 2] === "ञ") { out += "dny"; i += 2; if (!matraNext(chars, i)) out += "a"; continue; }
    if (CONS[c]) {
      out += CONS[c];
      const n = chars[i + 1];
      if (n === "़") i++;
      if (chars[i + 1] === "्") { i++; continue; }           // virama: no inherent vowel
      if (!MATRAS[chars[i + 1]]) out += "a";
    } else if (MATRAS[c]) out += MATRAS[c];
    else if (VOWELS[c]) out += VOWELS[c];
    else if (c === "ं" || c === "ँ") out += "n";
    else if (c === "ः") out += "h";
    else if (c === "्" || c === "़") { /* ignore */ }
    else out += c;
  }
  return out;
}
function matraNext(chars, i) { return !!MATRAS[chars[i + 1]]; }

function skeleton(word) {
  let s = /[ऀ-ॿ]/.test(word) ? devToRoman(word) : word;
  s = s.toLowerCase().replace(/[^a-z]/g, "");
  s = s.replace(/ph/g, "f").replace(/w/g, "v").replace(/z/g, "j").replace(/x/g, "ks").replace(/q/g, "k")
       .replace(/ch/g, "C").replace(/c/g, "k").replace(/sh/g, "s")
       .replace(/([tdbgkj])h/g, "$1").replace(/f/g, "p");
  s = s.replace(/[aeiouyh]/g, "").replace(/(.)\1+/g, "$1");
  return s;
}
function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
function sim(a, b) {
  if (!a || !b) return 0;
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}

// ---------- language helpers ----------
const SUFFIXES = ["च्या", "चे", "चा", "ची", "चं", "कडे", "कडून", "ला", "ने", "ना"];
const STOP = new Set(`किती कीती बाकी आहे आहेत येणे थकबाकी थकित आउटस्टँडिंग आउटस्टॅंडिंग बॅलन्स बॅलेन्स सांग सांगा दाखव दाखवा मला काय कोण कोणाचे
  कडे चे चा ची च्या चं ला ने ना भाव रेट दर किंमत पैसे रुपये रुपया आज सध्या अजून का ki kitna kitne hai hain baki bakaya balance outstanding batao bata
  bolo rate price the of is what how much show tell me ka ke ki ko se ला का के की को है हैं कितना कितने बाकि बकाया बताओ बताइए`.split(/\s+/));

function words(text) {
  return text.replace(/[?.,!।"'()]/g, " ").split(/\s+/).filter(Boolean);
}
function stripSuffix(w) {
  if (!/[ऀ-ॿ]/.test(w)) return w;
  for (const suf of SUFFIXES) if (w.length > suf.length + 1 && w.endsWith(suf)) return w.slice(0, -suf.length);
  return w;
}
function contentWords(text) {
  return words(text).map(stripSuffix).filter((w) => !STOP.has(w) && !STOP.has(w.toLowerCase()));
}
const has = (text, re) => re.test(text.toLowerCase());

// Score a name (customer / product) against the spoken words: every spoken word must
// find a similar-sounding word in the name; short/noisy matches are rejected.
function scoreName(spoken, name) {
  const q = spoken.map(skeleton).filter(Boolean);
  const n = words(name).map(skeleton).filter(Boolean);
  if (!q.length || !n.length) return 0;
  let total = 0;
  for (const w of q) total += Math.max(...n.map((x) => (x === w ? 1 : sim(w, x))));
  const coverage = total / q.length;
  const extra = 1 - Math.min(0.15, 0.03 * Math.max(0, n.length - q.length)); // prefer tighter matches
  return coverage * extra;
}
function bestMatches(alternatives, items, nameOf, limit = 3) {
  const scored = items.map((it) => {
    let best = 0;
    for (const alt of alternatives) best = Math.max(best, scoreName(contentWords(alt), nameOf(it)));
    return { it, score: best };
  }).filter((x) => x.score >= 0.6).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------- answers ----------
const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const dmy = (iso) => (iso ? iso.split("-").reverse().join("-") : "-");

async function answer(alts) {
  const text = alts[0];
  const { customers, products } = await loadData();

  if (has(text, /भाव|रेट|दर\b|किंमत|किमत|कीमत|price|rate|भाव/)) {
    const m = bestMatches(alts, products, (p) => p.productName, 1)[0];
    if (!m) return "हा माल सापडला नाही. नाव पुन्हा सांगा.";
    const p = m.it;
    const parts = [`${p.productName}`];
    if (p.saleRate != null) parts.push(`विक्री भाव: ${inr(p.saleRate)}${p.saleRateInclGst != null ? ` (GST सह ${inr(p.saleRateInclGst)})` : ""}, शेवटचे ${p.lastCustomer || "-"} ला ${dmy(p.saleDate)}`);
    if (p.purchaseRate != null) parts.push(`खरेदी भाव: ${inr(p.purchaseRate)}${p.supplier ? `, ${p.supplier} कडून` : ""}`);
    return parts.join("\n");
  }

  if (has(text, /सर्वात|सगळ्यात|टॉप|top|जास्त|सबसे|biggest|highest/)) {
    const top = customers.slice(0, 5);
    if (!top.length) return "कोणाचेही बाकी नाही.";
    return "सर्वात जास्त बाकी:\n" + top.map((c, i) => `${i + 1}. ${c.customerName} - ${inr(c.balance)}`).join("\n");
  }

  if (has(text, /जण|लोक|ग्राहक|पार्टी|party|parties|customers|कितने लोग|कितनी पार्टी/) && has(text, /किती|कितने|कितनी|how many/)) {
    const overdue = customers.filter((c) => c.overdueDays > 0).length;
    return `बाकी असलेले ${customers.length} जण, त्यापैकी ${overdue} जणांची मुदत उलटली आहे.`;
  }

  if (has(text, /एकूण|टोटल|total|सगळ्यांचे|सर्वांचे|सबका|कुल/)) {
    const sum = customers.reduce((s, c) => s + c.balance, 0);
    const interest = customers.reduce((s, c) => s + (c.interest || 0), 0);
    return `एकूण बाकी: ${inr(sum)} (${customers.length} जणांकडे)\nएकूण व्याज: ${inr(interest)}`;
  }

  const hits = bestMatches(alts, customers, (c) => c.customerName, 3);
  if (!hits.length) return "नाव सापडले नाही, किंवा त्यांचे बाकी शून्य आहे. पुन्हा सांगा.";
  const [first, second] = hits;
  if (second && first.score - second.score < 0.08) {
    return "कोणाबद्दल विचारताय?\n" + hits.map((h) => `• ${h.it.customerName} - ${inr(h.it.balance)}`).join("\n") + "\nपूर्ण नाव सांगा.";
  }
  const c = first.it;
  let out = `${c.customerName}\nबाकी: ${inr(c.balance)}`;
  if (c.overdueDays > 0) out += `\nव्याज: ${inr(c.interest)} (${c.overdueDays} दिवस थकित)\nव्याजासह एकूण: ${inr(c.totalPayable)}`;
  else out += "\nअजून मुदतीत आहे.";
  if (c.lastSaleDate) out += `\nशेवटची खरेदी: ${dmy(c.lastSaleDate)}`;
  return out;
}

// ---------- UI ----------
function addCard(q, a) {
  const card = document.createElement("div");
  card.className = "card";
  const qe = document.createElement("div"); qe.className = "q"; qe.textContent = "🗣 " + q;
  const ae = document.createElement("div"); ae.className = "a"; ae.textContent = a;
  card.append(qe, ae);
  $("log").prepend(card);
}
function say(text) {
  if (!$("speak").checked || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/₹/g, "रुपये ").replace(/\n/g, ". "));
  const want = $("lang").value;
  const voices = speechSynthesis.getVoices();
  const v = voices.find((x) => x.lang === want) || voices.find((x) => x.lang === "hi-IN") || voices.find((x) => x.lang.startsWith("en-IN"));
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = want;
  speechSynthesis.speak(u);
}
async function ask(alts) {
  if (!alts[0] || !alts[0].trim()) return;
  statusEl.textContent = "शोधत आहे…";
  let a;
  try { a = await answer(alts); } catch (e) { a = "⚠ " + e.message; }
  addCard(alts[0], a);
  say(a);
  statusEl.textContent = "माइकवर दाबा आणि बोला";
}

$("typed").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("text").value.trim();
  $("text").value = "";
  ask([t]);
});

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
micBtn.addEventListener("click", () => {
  if (!SR) { statusEl.textContent = "हा browser बोलणे ओळखत नाही. Chrome किंवा Edge वापरा, किंवा खाली लिहा."; return; }
  if (rec) { rec.stop(); return; }
  rec = new SR();
  rec.lang = $("lang").value;
  rec.maxAlternatives = 3;
  rec.interimResults = true;
  let finalAlts = null;
  rec.onstart = () => { micBtn.classList.add("on"); statusEl.textContent = "ऐकत आहे…"; };
  rec.onresult = (ev) => {
    const r = ev.results[ev.results.length - 1];
    statusEl.textContent = "“" + r[0].transcript + "”";
    if (r.isFinal) finalAlts = Array.from(r).map((x) => x.transcript);
  };
  rec.onerror = (ev) => {
    const msg = { "not-allowed": "माइक वापरायला परवानगी द्या.", "no-speech": "काही ऐकू आले नाही. पुन्हा प्रयत्न करा.", "network": "इंटरनेट लागते (speech ओळखण्यासाठी)." };
    statusEl.textContent = msg[ev.error] || "त्रुटी: " + ev.error;
  };
  rec.onend = () => {
    micBtn.classList.remove("on");
    rec = null;
    if (finalAlts) ask(finalAlts);
  };
  rec.start();
});

if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => {};
loadData().catch((e) => { statusEl.textContent = "⚠ " + e.message; });

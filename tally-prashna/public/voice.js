// Voice for Tally Prashna: speak your question (mic) and hear the answer.
// Front-end only: it never talks to Tally. It reuses the existing question box and the existing /api/ask call,
// so Tally still receives only read (Export) requests. Uses the browser's built-in speech (Edge / Chrome).
(() => {
  const form = document.getElementById("askForm");
  const input = document.getElementById("question");
  const micBtn = document.getElementById("micBtn");
  const langSel = document.getElementById("voiceLang");
  const speakOn = document.getElementById("speakOn");
  const handsFree = document.getElementById("handsFree");
  const stopBtn = document.getElementById("stopSpeakBtn");
  const msg = document.getElementById("voiceMsg");
  if (!form || !micBtn) return;

  // ---- remembered choices (storage may be blocked: then defaults are used) ----
  const KEY = "tallyPrashnaVoice";
  let prefs = { lang: "mr", speak: true, handsFree: false };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch {}
  langSel.value = prefs.lang; speakOn.checked = prefs.speak; handsFree.checked = prefs.handsFree;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ lang: langSel.value, speak: speakOn.checked, handsFree: handsFree.checked })); } catch {} };
  [langSel, speakOn, handsFree].forEach((el) => el.addEventListener("change", () => { save(); if (el === langSel) pickVoice(); }));
  const say = (t) => { msg.textContent = t || ""; };

  const LOCALE = { mr: "mr-IN", hi: "hi-IN", en: "en-IN" };
  const L = (lang, en, mr, hi) => (lang === "mr" ? mr : lang === "hi" ? hi : en);

  // ---- remember the raw answer data from /api/ask (read-only copy) ----
  let lastOut = null;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await realFetch(...args);
    try {
      if (String(args[0]).includes("/api/ask")) lastOut = await res.clone().json();
    } catch {}
    return res;
  };

  // ---- spoken wording (fixed templates: same question -> same spoken answer) ----
  const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
  const rs = (n) => `${inr.format(Math.round(Number(n || 0) * 100) / 100)} ${"रुपये"}`;
  const qn = (n, u) => `${inr.format(Math.round(Number(n || 0) * 100) / 100)}${u ? " " + u : ""}`;
  const dmy = (d) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : d || "");
  const TOP = 5;

  function spokenText(out, lang) {
    if (!out) return "";
    if (out.mode === "ai" && out.answer) return String(out.answer).replace(/[*_`#>|]/g, " ").replace(/\s+/g, " ").slice(0, 700);
    const r = out.result || {};
    switch (out.kind) {
      case "balance": {
        if (!r.count) return L(lang, "I could not find that ledger.", "ते खाते सापडले नाही.", "यह खाता नहीं मिला।");
        const side = (x) => (String(x.drCr).toLowerCase().startsWith("dr") ? L(lang, "to receive", "येणे", "लेना") : L(lang, "to pay", "देणे", "देना"));
        if ((r.ledgers || []).length === 1) { const x = r.ledgers[0]; return `${x.ledger}: ${rs(Math.abs(x.closingBalance))} ${side(x)}.`; }
        if ((r.ledgers || []).length <= 3) return r.ledgers.map((x) => `${x.ledger}: ${rs(Math.abs(x.closingBalance))} ${side(x)}`).join("; ") + ".";
        const top = [...(r.ledgers || [])].sort((a, b) => Math.abs(b.closingBalance) - Math.abs(a.closingBalance)).slice(0, TOP).map((x) => `${x.ledger} ${rs(Math.abs(x.closingBalance))}`).join("; ");
        // Many people share the name: do not read them all out. Give the count, the totals, the top 3 and ask for the full name.
        const top3 = [...(r.ledgers || [])].sort((a, b) => Math.abs(b.closingBalance) - Math.abs(a.closingBalance)).slice(0, 3).map((x) => `${x.ledger} ${rs(Math.abs(x.closingBalance))}`).join("; ");
        return L(lang, `${r.count} ledgers match. Total to receive ${rs(r.totalDr)}, total to pay ${rs(r.totalCr)}. Largest three: ${top3}. Please say the full name to hear one person.`,
          `${r.count} खाती जुळतात. एकूण येणे ${rs(r.totalDr)}, एकूण देणे ${rs(r.totalCr)}. सर्वात मोठी तीन: ${top3}. एका व्यक्तीसाठी पूर्ण नाव सांगा.`,
          `${r.count} खाते मिलते हैं। कुल लेना ${rs(r.totalDr)}, कुल देना ${rs(r.totalCr)}। सबसे बड़े तीन: ${top3}। एक व्यक्ति के लिए पूरा नाम बोलें।`);
      }
      case "stock": {
        const minus = (out.understood || {}).intent === "minus stock";
        if (!r.count) return minus ? L(lang, "No item has negative stock.", "एकाही वस्तूचा साठा उणे नाही.", "किसी वस्तु का स्टॉक माइनस नहीं है।") : L(lang, "I could not find that item.", "ती वस्तू सापडली नाही.", "यह वस्तु नहीं मिली।");
        const rows = (r.items || []).slice(0, TOP).map((x) => `${x.item}: ${qn(x.closingQty, x.unit)}, ${rs(x.closingValue)}`).join("; ");
        const head = minus ? L(lang, `${r.count} items have negative stock. `, `${r.count} वस्तूंचा साठा उणे आहे. `, `${r.count} वस्तुओं का स्टॉक माइनस है। `) : "";
        return head + rows + (r.count > TOP ? L(lang, ` and ${r.count - TOP} more.`, ` आणि ${r.count - TOP} आणखी.`, ` और ${r.count - TOP} अन्य।`) : ".");
      }
      case "withoutBill": {
        if (!r.entryCount) return L(lang, "No without-bill entries found.", "विदाउट बिल नोंदी सापडल्या नाहीत.", "विदाउट बिल एंट्री नहीं मिली।");
        const groups = (r.summaryByPartyAndItem || []);
        const rows = groups.slice(0, TOP).map((x) => `${x.party}, ${x.item}: ${qn(x.qty, x.unit)}` + (x.pendingQty != null ? L(lang, `, bill pending ${qn(x.pendingQty, x.unit)}`, `, बिल बाकी ${qn(x.pendingQty, x.unit)}`, `, बिल बाकी ${qn(x.pendingQty, x.unit)}`) : "")).join("; ");
        return L(lang, `${r.entryCount} without-bill entries in ${groups.length} groups. ${rows}.`, `${groups.length} गटांमध्ये ${r.entryCount} विदाउट बिल नोंदी. ${rows}.`, `${groups.length} समूहों में ${r.entryCount} विदाउट बिल एंट्री। ${rows}।`);
      }
      case "profit": {
        if (!(r.items || []).length) return L(lang, "No sales found for that period.", "त्या कालावधीत विक्री सापडली नाही.", "उस अवधि में बिक्री नहीं मिली।");
        const m = r.marginPercent != null ? ` (${r.marginPercent}%)` : "";
        return L(lang, `Estimated profit ${rs(r.totalProfit)}${m}: sales ${rs(r.totalSaleWithCost)}, purchase cost ${rs(r.totalCost)}, ${r.voucherCount} bills. This is an estimate.`,
          `अंदाजे नफा ${rs(r.totalProfit)}${m}: विक्री ${rs(r.totalSaleWithCost)}, खरेदी खर्च ${rs(r.totalCost)}, ${r.voucherCount} बिले. हा अंदाज आहे.`,
          `अनुमानित मुनाफा ${rs(r.totalProfit)}${m}: बिक्री ${rs(r.totalSaleWithCost)}, खरीद लागत ${rs(r.totalCost)}, ${r.voucherCount} बिल। यह अनुमान है।`);
      }
      case "vouchers": {
        if (!r.matchCount) return L(lang, "No vouchers found.", "व्हाउचर सापडले नाहीत.", "वाउचर नहीं मिले।");
        const tot = Object.entries(r.totalsByVoucherType || {}).map(([t, v]) => `${t}: ${v.vouchers} ${L(lang, "vouchers", "व्हाउचर", "वाउचर")}, ${rs(v.amount)}`).join("; ");
        return L(lang, `${r.matchCount} vouchers, ${dmy((r.dateRange || {}).from)} to ${dmy((r.dateRange || {}).to)}. ${tot}.`, `${r.matchCount} व्हाउचर, ${dmy((r.dateRange || {}).from)} ते ${dmy((r.dateRange || {}).to)}. ${tot}.`, `${r.matchCount} वाउचर, ${dmy((r.dateRange || {}).from)} से ${dmy((r.dateRange || {}).to)}। ${tot}।`);
      }
      case "help": return String(r.message || "");
      default: return "";
    }
  }
  window.__tpSpokenText = spokenText; // for testing

  // ---- speaking ----
  let voice = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices();
    const want = LOCALE[langSel.value];
    // Marathi voice if installed, otherwise a Hindi voice (reads Devanagari well), otherwise any English voice.
    voice = vs.find((v) => v.lang === want) || (langSel.value === "mr" ? vs.find((v) => v.lang === "hi-IN") : null) || vs.find((v) => v.lang.startsWith(want.slice(0, 2))) || vs.find((v) => v.lang.startsWith("en")) || null;
  }
  if ("speechSynthesis" in window) { speechSynthesis.onvoiceschanged = pickVoice; pickVoice(); }

  function speak(text, onDone) {
    if (!text || !("speechSynthesis" in window)) { onDone && onDone(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice ? voice.lang : LOCALE[langSel.value];
    if (voice) u.voice = voice;
    u.onend = () => { stopBtn.hidden = true; onDone && onDone(); };
    u.onerror = () => { stopBtn.hidden = true; };
    stopBtn.hidden = false;
    speechSynthesis.speak(u);
  }
  const stopSpeaking = () => { try { speechSynthesis.cancel(); } catch {} stopBtn.hidden = true; };
  stopBtn.addEventListener("click", stopSpeaking);

  // ---- after each answer, read it out (wraps the existing ask(); nothing else changes) ----
  const origAsk = window.ask;
  window.ask = async function (question) {
    lastOut = null;
    await origAsk(question);
    const text = lastOut ? spokenText(lastOut, langSel.value) : "";
    const again = () => { if (handsFree.checked) listen(); };
    if (speakOn.checked && text) speak(text, again); else again();
  };

  // ---- listening ----
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  function listen() {
    if (!SR) { say("हा browser बोलून विचारायला मदत करत नाही. Edge किंवा Chrome वापरा."); return; }
    if (rec) { try { rec.stop(); } catch {} return; } // tap again = stop
    stopSpeaking();
    rec = new SR();
    rec.lang = LOCALE[langSel.value];
    rec.interimResults = true;
    rec.continuous = false;
    let heard = "", failed = false;
    rec.onstart = () => { micBtn.classList.add("on"); say("ऐकत आहे… बोला"); };
    rec.onresult = (e) => {
      let t = "";
      for (const r of e.results) t += r[0].transcript;
      heard = t.trim(); input.value = heard;
    };
    rec.onerror = (e) => {
      failed = true;
      const m = { "not-allowed": "माइकची परवानगी बंद आहे. Edge मध्ये या पत्त्यासाठी Microphone → Allow करा (वर पत्त्याजवळचा 🔒 icon).", "service-not-allowed": "माइकची परवानगी बंद आहे. Edge मध्ये Microphone → Allow करा.", "no-speech": "काही ऐकू आलं नाही. पुन्हा 🎙 दाबून बोला.", "audio-capture": "माइक सापडला नाही.", network: "बोलणं ओळखण्यासाठी इंटरनेट लागतं (Edge/Chrome चा speech service). इंटरनेट तपासा.", "language-not-supported": "ही भाषा येथे उपलब्ध नाही; दुसरी भाषा निवडा." }[e.error];
      say(m || "माइकमध्ये अडचण आली.");
      if (e.error !== "no-speech") handsFree.checked = false;
    };
    rec.onend = () => {
      micBtn.classList.remove("on");
      rec = null;
      if (failed) return;
      const t = (heard || "").trim();
      if (!t) { say("काही ऐकू आलं नाही. पुन्हा 🎙 दाबून बोला."); return; }
      say("");
      form.requestSubmit(); // same path as typing + Enter: the question box already holds the recognized text
    };
    try { rec.start(); } catch { rec = null; say("माइक सुरू करता आला नाही."); }
  }
  micBtn.addEventListener("click", () => listen());
  say(SR ? "" : "हा browser बोलून विचारायला मदत करत नाही. Edge किंवा Chrome वापरा.");
})();

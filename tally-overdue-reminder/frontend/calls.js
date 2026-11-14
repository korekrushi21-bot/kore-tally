const $ = (id) => document.getElementById(id);
let data = null;

const STATUS_MR = {
  pending: "⏳ चालू",
  answered: "✅ उचलला",
  no_answer: "📵 उचलला नाही",
  busy: "🔴 बिझी",
  failed: "⚠ अयशस्वी",
  dry_run: "🧪 चाचणी (कॉल गेला नाही)",
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function money(n) {
  return "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}
function when(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("mr-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function hm(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  if (res.status === 401) {
    location.href = "/"; // login lives on the main page
    throw new Error("login");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function load(refresh) {
  $("sub").textContent = "loading...";
  try {
    data = await api(`/api/calls${refresh ? "?refresh=1" : ""}`);
    render();
  } catch (err) {
    if (err.message !== "login") showErrors([err.message]);
  }
}

function showErrors(list) {
  $("errors").innerHTML = list.filter(Boolean).map((e) => `<div class="err">${esc(e)}</div>`).join("");
}

function render() {
  const d = data;
  showErrors([d.tallyError && `Tally: ${d.tallyError}`, d.lastError && `शेवटची अडचण: ${d.lastError}`]);

  const manual = d.mode === "manual";
  $("mode-manual").classList.toggle("active", manual);
  $("mode-auto").classList.toggle("active", !manual);
  $("manual-card").hidden = !manual;
  $("auto-card").hidden = manual;
  $("script-title").textContent = manual ? "ग्राहकाशी काय बोलायचं" : "रेकॉर्ड करायचा संदेश (Exotel मध्ये हा आवाज टाकायचा)";
  if (manual) renderDue();

  $("master").classList.toggle("on", d.enabled);
  $("master-label").textContent = d.enabled ? "चालू" : "बंद";
  const dry = d.provider === "dry-run";
  $("provider").textContent = dry ? "चाचणी मोड - खरा कॉल जात नाही" : `${d.provider} - खरे कॉल`;
  $("provider").className = `badge ${dry ? "b-dry" : "b-live"}`;
  $("sub").textContent = manual
    ? `📱 मोबाईलवरून कॉल · आता ${d.customers.filter((c) => c.due).length} कॉल बाकी`
    : `🤖 ${d.enabled ? "🟢 चालू" : "⚪ बंद"} · ${dry ? "चाचणी मोड" : "खरे कॉल"} · शेवटची तपासणी ${when(d.lastTickAt) || "-"}`;

  const r = d.rules;
  $("rules").innerHTML = [
    `वेळ: फक्त ${hm(r.windowStart)} ते ${hm(r.windowEnd)}${r.skipSundays ? ", रविवारी नाही" : ""}`,
    `एक दिवसाआड कॉल (दर ${r.dayGap} दिवसांनी)`,
    `कॉल न उचलल्यास त्या दिवशी जास्तीत जास्त ${r.maxAttemptsPerDay} प्रयत्न, किमान ${r.minGapMinutes / 60} तासांच्या अंतराने`,
    `कॉल उचलला की त्या दिवशी पुढचे कॉल बंद`,
    `बाकी ${money(r.minBalance)} पेक्षा कमी झाली${r.onlyOverdue ? " किंवा मुदत संपली नसेल" : ""} तर कॉल नाही - पैसे भरले की आपोआप थांबतात`,
  ].map((t) => `<li>${esc(t)}</li>`).join("");
  $("test").disabled = !d.testNumberSet;
  if (!d.testNumberSet) $("test-msg").textContent = "config.json मध्ये calls.testNumber भरा";

  renderList();

  $("log").innerHTML = d.log.length
    ? d.log.map((a) => `<tr><td>${esc(when(a.at))}</td><td>${esc(a.customerName)}</td><td>${esc(a.phone)}</td><td>${esc(STATUS_MR[a.status] || a.status)}${a.provider === "manual" ? " 📱" : ""}${a.error ? `<div class="muted">${esc(a.error)}</div>` : ""}</td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">अजून एकही कॉल नाही</td></tr>`;
}

// Customer-facing WhatsApp text. Balance only - no interest (owner's choice)
// and never item rates.
function reminderText(c) {
  const lines = [
    `नमस्कार ${c.customerName},`,
    "",
    `${data.shopName} येथून आपल्या बाकीची आठवण:`,
    "",
    `बाकी रक्कम: ${money(c.balance)}`,
  ];
  if (c.overdueDays > 0) lines.push(`थकीत दिवस: ${c.overdueDays}`);
  lines.push("", "कृपया लवकरात लवकर केंद्रावर येऊन आपली बाकी जमा करावी.", "", "धन्यवाद.");
  return lines.join("\n");
}

function waLink(c) {
  return `https://wa.me/91${c.effectivePhone}?text=${encodeURIComponent(reminderText(c))}`;
}

function waInfo(c) {
  if (!c.lastWhatsApp) return "";
  const sameDay = new Date(c.lastWhatsApp).toDateString() === new Date().toDateString();
  return sameDay ? "💬 आज WhatsApp पाठवला" : `💬 शेवटचा WhatsApp: ${when(c.lastWhatsApp)}`;
}

function wireWhatsApp(container, list) {
  container.querySelectorAll("a.wabtn").forEach((a) => {
    a.onclick = () => {
      const c = list[Number(a.dataset.i)];
      // Fire-and-forget log; the link itself opens WhatsApp.
      api("/api/calls/whatsapp", { customerName: c.customerName, phone: c.effectivePhone }).then(() => setTimeout(load, 1500)).catch(() => {});
    };
  });
}

function renderDue() {
  const due = data.customers.filter((c) => c.due);
  $("due-count").textContent = `(${due.length})`;
  $("due-list").innerHTML = due.length
    ? due.map((c, i) => `
      <div class="due" data-i="${i}">
        <div class="row">
          <div class="grow"><div class="name">${esc(c.customerName)}</div>
            <div class="muted">${c.overdueDays} दिवस थकीत · आतापर्यंत ${c.totalAttempts} कॉल${c.lastAttempt ? ` · शेवटचा: ${esc(when(c.lastAttempt.at))} ${esc(STATUS_MR[c.lastAttempt.status] || "")}` : ""}</div></div>
          <div class="amt">${money(c.balance)}</div>
        </div>
        <div class="row" style="gap:8px">
          <a class="callbtn grow" href="tel:+91${esc(c.effectivePhone)}">📞 कॉल करा</a>
          <a class="callbtn wabtn grow" data-i="${i}" href="${esc(waLink(c))}" target="_blank" rel="noopener">💬 WhatsApp</a>
        </div>
        <div class="muted">${esc(c.effectivePhone)}${waInfo(c) ? ` · ${esc(waInfo(c))}` : ""}</div>
        <div class="results">
          <button class="ans" data-s="answered">✅ उचलला</button>
          <button data-s="no_answer">📵 उचलला नाही</button>
          <button data-s="busy">🔴 बिझी / बंद</button>
        </div>
      </div>`).join("")
    : `<div class="empty-ok">✔ आत्ता कोणालाही कॉल करायचा बाकी नाही.</div>`;
  wireWhatsApp($("due-list"), due);
  $("due-list").querySelectorAll(".due").forEach((el) => {
    const c = due[Number(el.dataset.i)];
    el.querySelectorAll(".results button").forEach((b) => {
      b.onclick = async () => {
        el.querySelectorAll("button").forEach((x) => (x.disabled = true));
        try {
          await api("/api/calls/result", { customerName: c.customerName, status: b.dataset.s });
          await load();
        } catch (err) {
          alert(err.message);
          await load();
        }
      };
    });
  });

  const today = new Date().toDateString();
  const later = data.customers
    .filter((c) => c.enabled && !c.due && c.nextAt && new Date(c.nextAt).toDateString() === today)
    .sort((a, b) => a.nextAt.localeCompare(b.nextAt));
  $("later").innerHTML = later.length
    ? "आज नंतर: " + later.map((c) => `${esc(c.customerName)} (${esc(new Date(c.nextAt).toLocaleTimeString("mr-IN", { hour: "2-digit", minute: "2-digit" }))})`).join(", ")
    : "";
}

function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const onlyOn = $("only-on").checked;
  const rows = data.customers.filter((c) => (!q || c.customerName.toLowerCase().includes(q)) && (!onlyOn || c.enabled));
  const onCount = data.customers.filter((c) => c.enabled).length;
  $("count").textContent = `(${onCount} चालू / ${data.customers.length})`;

  $("list").innerHTML = rows.length
    ? rows.map((c, i) => `
      <div class="cust" data-i="${i}">
        <div class="row">
          <div class="grow">
            <div class="name">${esc(c.customerName)}</div>
            <div class="muted">${c.overdueDays > 0 ? `${c.overdueDays} दिवस थकीत` : "मुदतीत"} · Tally नंबर: ${esc(c.tallyMobile || "नाही")} · एकूण कॉल: ${c.totalAttempts}</div>
          </div>
          <div class="amt">${money(c.balance)}</div>
        </div>
        <div class="row" style="margin-top:6px">
          <input class="phone" inputmode="numeric" placeholder="${esc(c.tallyMobile ? "Tally चा नंबर" : "मोबाईल नंबर")}" value="${esc(c.phone)}">
          <button class="btn save">जतन</button>
          ${c.effectivePhone ? `<a class="btn wabtn" data-i="${i}" href="${esc(waLink(c))}" target="_blank" rel="noopener" style="text-decoration:none">💬</a>` : ""}
          <span class="grow"></span>
          <button class="switch ${c.enabled ? "on" : ""}" aria-label="कॉल चालू/बंद"></button>
        </div>
        <div class="status-line">${waInfo(c) ? `${esc(waInfo(c))} · ` : ""}${esc(c.status)}${c.effectivePhone ? ` · ${esc(c.effectivePhone)}` : ""}${c.lastAttempt ? ` · शेवटचा: ${esc(when(c.lastAttempt.at))} ${esc(STATUS_MR[c.lastAttempt.status] || "")}` : ""}</div>
      </div>`).join("")
    : `<div class="muted">कोणी नाही</div>`;

  wireWhatsApp($("list"), rows);
  $("list").querySelectorAll(".cust").forEach((el) => {
    const c = rows[Number(el.dataset.i)];
    el.querySelector(".switch").onclick = () => update({ customerName: c.customerName, enabled: !c.enabled });
    el.querySelector(".save").onclick = () => update({ customerName: c.customerName, phone: el.querySelector(".phone").value });
  });
}

async function update(body) {
  try {
    await api("/api/calls/contact", body);
    await load();
  } catch (err) {
    alert(err.message);
  }
}

$("master").onclick = async () => {
  const turnOn = !data.enabled;
  if (turnOn && !confirm(data.provider === "dry-run" ? "चाचणी मोड चालू करायचा? (खरा कॉल जाणार नाही)" : "खरे कॉल सुरू करायचे? चालू असलेल्या ग्राहकांना नियमांप्रमाणे कॉल जातील.")) return;
  try {
    await api("/api/calls/enabled", { enabled: turnOn });
    await load();
  } catch (err) {
    alert(err.message);
  }
};
$("test").onclick = async () => {
  $("test-msg").textContent = "कॉल लावत आहे...";
  try {
    const { attempt } = await api("/api/calls/test", {});
    $("test-msg").textContent = STATUS_MR[attempt.status] || attempt.status;
    await load();
  } catch (err) {
    $("test-msg").textContent = err.message;
  }
};
async function setMode(mode) {
  try {
    await api("/api/calls/mode", { mode });
    await load();
  } catch (err) {
    alert(err.message);
  }
}
$("mode-manual").onclick = () => setMode("manual");
$("mode-auto").onclick = () => setMode("auto");
$("refresh").onclick = () => load(true);
$("search").oninput = renderList;
$("only-on").onchange = renderList;

// ---- Owner notifications (Web Push) ----
function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function refreshPushUi() {
  const msg = $("push-msg");
  if (!pushSupported) {
    $("push-on").hidden = true;
    msg.textContent = isIos && !isStandalone
      ? "iPhone वर सूचना फक्त Home Screen वरच्या 'थकबाकी' ॲपमधून चालतात. Safari मधून नाही - Home Screen वरचं ॲप उघडा आणि इथे परत या."
      : "या browser मध्ये सूचना चालत नाहीत.";
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  const on = Boolean(sub) && Notification.permission === "granted";
  $("push-on").textContent = on ? "🔕 सूचना बंद करा" : "🔔 सूचना चालू करा";
  $("push-test").hidden = !on;
  if (Notification.permission === "denied") {
    msg.textContent = "सूचना ब्लॉक आहेत. iPhone: Settings → Notifications → थकबाकी → Allow Notifications चालू करा.";
  } else {
    msg.textContent = on
      ? "✅ या फोनवर सूचना चालू आहेत: सकाळी आजची यादी, कॉलची वेळ झाली की नावं, आणि संध्याकाळी हिशोब."
      : "कोणाला कॉल करायचा, कोणी उचलला नव्हता - याच्या सूचना मोबाईलवर येतील.";
  }
}

$("push-on").onclick = async () => {
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing && Notification.permission === "granted") {
      await api("/api/calls/push-unsubscribe", { endpoint: existing.endpoint });
      await existing.unsubscribe();
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("सूचनांना परवानगी दिली नाही.");
      const { key } = await api("/api/calls/push-key");
      const sub = existing || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) }));
      await api("/api/calls/push-subscribe", { subscription: sub.toJSON() });
    }
  } catch (err) {
    alert(err.message);
  }
  refreshPushUi();
};

$("push-test").onclick = async () => {
  try {
    const { sent } = await api("/api/calls/push-test", {});
    $("push-msg").textContent = sent ? "चाचणी सूचना पाठवली - काही सेकंदात येईल." : "सूचना पाठवता आली नाही - पुन्हा 🔔 चालू करा.";
  } catch (err) {
    alert(err.message);
  }
};

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then(refreshPushUi).catch(() => {});
} else {
  refreshPushUi();
}

load();
setInterval(() => load(), 60000);

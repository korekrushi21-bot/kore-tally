// Places the actual call. Two providers:
//
//   "dry-run" (default) - places NO call. Records the attempt as "dry_run"
//                         and treats it as not answered, so you can watch
//                         the retry / every-other-day schedule work for real
//                         before spending money or bothering anyone.
//   "exotel"            - Exotel "connect call to flow" API: Exotel dials the
//                         customer and plays the recorded-message flow
//                         (App) you built in the Exotel dashboard.
//
// NOTE: the Exotel code follows Exotel's published v1 API but has NOT been
// run against a real Exotel account yet - test with calls.testNumber first.

async function startCall(cfg, phone) {
  const provider = cfg.provider || "dry-run";
  if (provider === "dry-run") return { sid: null, status: "dry_run" };
  if (provider === "exotel") return exotelStart(cfg.exotel || {}, phone);
  throw new Error(`Unknown call provider "${provider}"`);
}

// Returns a final status ("answered" | "no_answer" | "busy" | "failed") or
// "pending" while the call is still ringing / in progress.
async function checkCall(cfg, sid) {
  if (cfg.provider === "exotel") return exotelStatus(cfg.exotel || {}, sid);
  return "failed";
}

function exotelBase(ex) {
  for (const k of ["sid", "apiKey", "apiToken", "callerId", "appId"]) {
    if (!ex[k]) throw new Error(`config.json calls.exotel.${k} is empty`);
  }
  const host = ex.subdomain || "api.exotel.com";
  const auth = Buffer.from(`${ex.apiKey}:${ex.apiToken}`).toString("base64");
  return { url: `https://${host}/v1/Accounts/${encodeURIComponent(ex.sid)}`, headers: { Authorization: `Basic ${auth}` } };
}

async function exotelStart(ex, phone) {
  const { url, headers } = exotelBase(ex);
  const body = new URLSearchParams({
    From: `0${phone}`,
    CallerId: ex.callerId,
    Url: `http://my.exotel.com/${ex.sid}/exoml/start_voice/${ex.appId}`,
    CallType: "trans",
    TimeLimit: "120",
    TimeOut: "40",
  });
  const res = await fetch(`${url}/Calls/connect.json`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Exotel HTTP ${res.status}: ${text.slice(0, 300)}`);
  const sid = JSON.parse(text)?.Call?.Sid;
  if (!sid) throw new Error(`Exotel gave no call id: ${text.slice(0, 300)}`);
  return { sid, status: "pending" };
}

async function exotelStatus(ex, sid) {
  const { url, headers } = exotelBase(ex);
  const res = await fetch(`${url}/Calls/${encodeURIComponent(sid)}.json`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Exotel HTTP ${res.status}: ${text.slice(0, 300)}`);
  const call = JSON.parse(text)?.Call || {};
  switch (call.Status) {
    case "completed":
      return "answered";
    case "no-answer":
      return "no_answer";
    case "busy":
      return "busy";
    case "failed":
    case "canceled":
      return "failed";
    default:
      return "pending"; // queued / ringing / in-progress
  }
}

module.exports = { startCall, checkCall };

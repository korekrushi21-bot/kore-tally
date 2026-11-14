// Push notifications to the OWNER's phone (never to customers) - "call these
// people now", "X didn't pick up this morning, try again", end-of-day summary.
//
// Uses standard Web Push: the phone's home-screen app subscribes once
// (🔔 button on calls.html), we keep that subscription in call-data.json and
// send through Apple's / Google's push service. VAPID keys are generated on
// first run and saved in config.json ("push").
//
// iPhone: works only for the app added to the Home Screen (iOS 16.4+), not
// in a normal Safari tab. The PC must be on for anything to be sent.

const fs = require("fs");
const webpush = require("web-push");
const store = require("./store");

function setup(config, configPath) {
  config.push = config.push || {};
  if (!config.push.vapidPublicKey || !config.push.vapidPrivateKey) {
    const keys = webpush.generateVAPIDKeys();
    config.push.vapidPublicKey = keys.publicKey;
    config.push.vapidPrivateKey = keys.privateKey;
    // In test runs (USE_MOCK_DATA=1) the in-memory config has test overrides
    // (mock mode, test password) - never write those back to the real file.
    if (process.env.USE_MOCK_DATA !== "1") {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log("Generated push notification keys in config.json");
    }
  }
  // Subject identifies the sender to the push service; the app's own address is enough.
  webpush.setVapidDetails(config.push.subject || "https://desktop-ajrqb0i.tailf087c0.ts.net", config.push.vapidPublicKey, config.push.vapidPrivateKey);
  return config.push.vapidPublicKey;
}

function subs() {
  const st = store.load();
  st.pushSubs = st.pushSubs || [];
  return st.pushSubs;
}

function addSubscription(sub) {
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error("invalid subscription");
  }
  const list = subs();
  const i = list.findIndex((s) => s.endpoint === sub.endpoint);
  const entry = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, addedAt: new Date().toISOString() };
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  store.save();
  return list.length;
}

function removeSubscription(endpoint) {
  const st = store.load();
  st.pushSubs = subs().filter((s) => s.endpoint !== endpoint);
  store.save();
}

// payload: { title, body, url?, tag? }. Returns how many phones got it.
async function sendAll(payload) {
  const list = subs().slice();
  let ok = 0;
  for (const sub of list) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 * 60 });
      ok += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) removeSubscription(sub.endpoint); // phone unsubscribed / app removed
      else console.warn("Push failed:", err.statusCode || "", err.message);
    }
  }
  return ok;
}

module.exports = { setup, addSubscription, removeSubscription, sendAll, count: () => subs().length };

// Call-reminder state on disk (one JSON file, next to config.json):
//   { enabled, contacts: { [customerName]: { enabled, phone } }, attempts: [...] }
// Written atomically (temp file + rename) so a crash mid-write can't corrupt it.

const fs = require("fs");
const path = require("path");

const FILE = process.env.CALL_DATA_FILE || path.join(__dirname, "..", "call-data.json");
const KEEP_DAYS = 120;

function empty() {
  // mode "manual": the app lists who is due and you call from your own phone,
  //                then tap the result. "auto": the provider in config.json
  //                (dry-run / exotel) places the calls by itself.
  return { mode: "manual", enabled: false, contacts: {}, attempts: [], messages: [] };
}

let state = null;

function load() {
  if (state) return state;
  try {
    state = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("call-data.json unreadable, starting fresh:", err.message);
    state = empty();
  }
  return state;
}

function save() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  state.attempts = state.attempts.filter((a) => new Date(a.at).getTime() >= cutoff);
  state.messages = (state.messages || []).filter((m) => new Date(m.at).getTime() >= cutoff);
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

function attemptsFor(customerName) {
  return load().attempts.filter((a) => a.customerName === customerName);
}

module.exports = { load, save, attemptsFor, FILE };

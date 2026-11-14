// Run: node call-reminder/test-schedule.js
const assert = require("assert");
const { effectiveRules, decide, normalizeMobile } = require("./schedule");

const rules = effectiveRules({});
const customer = { customerName: "A", balance: 5000, owes: true, overdueDays: 40, mobile: "98220 11111" };
const contact = { enabled: true, phone: "" };
const at = (s) => new Date(s); // local time
const tue = "2026-11-10"; // Tuesday

let n = 0;
function check(name, fn) {
  fn();
  n += 1;
  console.log("ok -", name);
}

check("hard caps cannot be loosened by config", () => {
  const r = effectiveRules({ maxAttemptsPerDay: 30, minGapMinutes: 30, dayGap: 0, window: { start: "06:00", end: "22:00" } });
  assert.equal(r.maxAttemptsPerDay, 4);
  assert.equal(r.minGapMinutes, 180);
  assert.equal(r.dayGap, 2);
  assert.equal(r.windowStart, 9 * 60);
  assert.equal(r.windowEnd, 19 * 60);
});

check("mobile normalisation", () => {
  assert.equal(normalizeMobile("+91 98220 11111"), "9822011111");
  assert.equal(normalizeMobile("09765022222"), "9765022222");
  assert.equal(normalizeMobile("98220 11111 / 97650 22222"), "9822011111");
  assert.equal(normalizeMobile("02385-123456"), null); // landline
  assert.equal(normalizeMobile("12345"), null);
});

check("off / no phone / paid / advance / not overdue -> no call", () => {
  const base = { attempts: [], rules, now: at(`${tue}T11:00`) };
  assert.equal(decide({ ...base, customer, contact: { enabled: false } }).call, false);
  assert.equal(decide({ ...base, customer: { ...customer, mobile: null }, contact }).call, false);
  assert.equal(decide({ ...base, customer: { ...customer, balance: 100 }, contact }).call, false);
  assert.equal(decide({ ...base, customer: { ...customer, owes: false }, contact }).call, false);
  assert.equal(decide({ ...base, customer: { ...customer, overdueDays: 0 }, contact }).call, false);
});

check("time window and Sunday", () => {
  const base = { customer, contact, attempts: [], rules };
  assert.equal(decide({ ...base, now: at(`${tue}T09:59`) }).call, false);
  assert.equal(decide({ ...base, now: at(`${tue}T10:00`) }).call, true);
  assert.equal(decide({ ...base, now: at(`${tue}T19:00`) }).call, true); // 7 PM is the last slot
  assert.equal(decide({ ...base, now: at(`${tue}T19:01`) }).call, false);
  assert.equal(decide({ ...base, now: at("2026-11-08T11:00") }).call, false); // Sunday
});

check("no answer: retry only after 3 hours, max 4 per day", () => {
  const attempts = [{ at: at(`${tue}T10:00`).toISOString(), status: "no_answer" }];
  assert.equal(decide({ customer, contact, attempts, rules, now: at(`${tue}T12:59`) }).call, false);
  assert.equal(decide({ customer, contact, attempts, rules, now: at(`${tue}T13:00`) }).call, true);
  const four = ["10:00", "13:00", "16:00", "18:30"].map((t) => ({ at: at(`${tue}T${t}`).toISOString(), status: "no_answer" }));
  assert.equal(decide({ customer, contact, attempts: four, rules, now: at(`${tue}T18:59`) }).call, false);
});

check("simulate a full Tuesday of no answers: exactly 4 calls, 3h apart", () => {
  const attempts = [];
  for (let m = 0; m < 24 * 60; m++) {
    const now = at(`${tue}T00:00`);
    now.setMinutes(m);
    if (decide({ customer, contact, attempts, rules, now }).call) attempts.push({ at: now.toISOString(), status: "no_answer" });
  }
  const times = attempts.map((a) => new Date(a.at).toTimeString().slice(0, 5));
  assert.deepEqual(times, ["10:00", "13:00", "16:00", "19:00"]);
});

check("answered: no more calls that day", () => {
  const attempts = [{ at: at(`${tue}T10:00`).toISOString(), status: "answered" }];
  assert.equal(decide({ customer, contact, attempts, rules, now: at(`${tue}T15:00`) }).call, false);
});

check("every other day: Tue call -> Wed none -> Thu yes", () => {
  const attempts = [{ at: at(`${tue}T10:00`).toISOString(), status: "answered" }];
  assert.equal(decide({ customer, contact, attempts, rules, now: at("2026-11-11T11:00") }).call, false);
  assert.equal(decide({ customer, contact, attempts, rules, now: at("2026-11-12T10:00") }).call, true);
});

check("pending call blocks a new one", () => {
  const attempts = [{ at: at("2026-11-09T10:00").toISOString(), status: "pending" }];
  assert.equal(decide({ customer, contact, attempts, rules, now: at(`${tue}T11:00`) }).call, false);
});

check("simulate 14 days, never answers: calls only on alternate non-Sundays", () => {
  const attempts = [];
  const days = new Set();
  for (let d = 0; d < 14; d++) {
    for (let m = 0; m < 24 * 60; m += 5) {
      const now = new Date(`${tue}T00:00`);
      now.setDate(now.getDate() + d);
      now.setMinutes(m);
      if (decide({ customer, contact, attempts, rules, now }).call) {
        attempts.push({ at: now.toISOString(), status: "no_answer" });
        days.add(now.toDateString());
      }
    }
  }
  const perDay = {};
  for (const a of attempts) perDay[new Date(a.at).toDateString()] = (perDay[new Date(a.at).toDateString()] || 0) + 1;
  console.log("    ", perDay);
  assert.ok(Object.values(perDay).every((c) => c <= 4));
  assert.ok(![...days].some((s) => s.startsWith("Sun")));
  assert.ok(attempts.length <= 7 * 4);
});

console.log(`\n${n} checks passed`);

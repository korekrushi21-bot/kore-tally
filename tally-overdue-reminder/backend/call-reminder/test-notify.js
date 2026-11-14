// Run: node call-reminder/test-notify.js   (no network, no real config written)
process.env.USE_MOCK_DATA = "1";
process.env.CALL_DATA_FILE = require("path").join(require("os").tmpdir(), `notify-test-${process.pid}.json`);
const assert = require("assert");
const notify = require("./notify");
const store = require("./store");
const { mount } = require("./index");

const sent = [];
notify.sendAll = async (p) => (sent.push(p), 1);
notify.count = () => 1;

const customers = [
  { customerName: "A", balance: 5000, owes: true, overdueDays: 40, mobile: "9822011111" },
  { customerName: "B", balance: 7000, owes: true, overdueDays: 50, mobile: "9822022222" },
  { customerName: "C", balance: 9000, owes: true, overdueDays: 60, mobile: "9822033333" },
];
const fakeApp = { use() {} };
const config = { calls: {}, interest: { ratePercentPerMonth: 2 }, push: {} };
const { ownerNotifyTick } = mount(fakeApp, { config, getOverdue: async () => ({ customers }), configPath: "unused" });

const st = store.load();
st.contacts = { A: { enabled: true }, B: { enabled: true }, C: { enabled: false } };

let clock;
const realNow = Date.now;
Date.now = () => clock.getTime();
async function at(iso) {
  clock = new Date(iso);
  const before = sent.length;
  await ownerNotifyTick(customers, clock);
  return sent.slice(before);
}
const record = (name, iso, status) => { st.attempts.push({ customerName: name, phone: "x", at: new Date(iso).toISOString(), status, provider: "manual" }); };

(async () => {
  const day = "2026-11-10"; // Tuesday
  let out = await at(`${day}T09:30`);
  assert.equal(out.length, 0, "nothing before 10:00");

  out = await at(`${day}T10:00`);
  assert.equal(out.length, 1);
  assert.match(out[0].title, /आज 2 ग्राहकांना/);
  assert.ok(!out[0].body.includes("C"), "switched-off customer not listed");
  console.log("ok - 10:00 morning list:", out[0].title, "|", out[0].body);

  out = await at(`${day}T10:30`);
  assert.equal(out.length, 0, "no repeat within the hour");

  record("A", `${day}T10:40`, "no_answer");
  record("B", `${day}T10:45`, "answered");
  out = await at(`${day}T11:10`);
  assert.equal(out.length, 0, "nobody due after both were called");

  out = await at(`${day}T13:45`);
  assert.equal(out.length, 1);
  assert.match(out[0].title, /आता कॉल करा \(1\)/);
  assert.match(out[0].body, /A \(आधी उचलला नाही\)/);
  console.log("ok - retry reminder:", out[0].title, "|", out[0].body);

  out = await at(`${day}T14:30`);
  assert.equal(out.length, 0);
  out = await at(`${day}T14:50`);
  assert.equal(out.length, 1);
  assert.match(out[0].title, /अजून 1 कॉल बाकी/);
  console.log("ok - hourly nudge:", out[0].title);

  out = await at(`${day}T19:10`);
  assert.equal(out.length, 1);
  assert.match(out[0].title, /आजचा हिशोब/);
  console.log("ok - evening summary:", out[0].body);
  out = await at(`${day}T19:40`);
  assert.equal(out.length, 0, "summary only once");

  out = await at("2026-11-11T11:00"); // Wed: A had no call-day gap issue? A was called Tue -> not due Wed
  assert.equal(out.length, 0, "every-other-day: nothing on Wednesday");

  Date.now = realNow;
  require("fs").rmSync(process.env.CALL_DATA_FILE, { force: true });
  console.log("\nall notify checks passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

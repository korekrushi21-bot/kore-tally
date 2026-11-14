// Decides who gets a recorded reminder call right now. Pure functions only -
// no I/O - so the rules can be unit-tested (see test-schedule.js).
//
// The rules (and their hard caps, which config can tighten but never loosen):
//   - Only customers you switched ON, with a valid mobile number, who still
//     owe at least `minBalance` (and are overdue, if `onlyOverdue`).
//   - Calls only inside the daily window (default 10:00-19:00, never wider
//     than 09:00-19:00), and never on Sunday if `skipSundays`.
//   - "Every other day": after a day on which a customer was called, they
//     are not called again until `dayGap` days later (min 2).
//   - On a call day: up to `maxAttemptsPerDay` tries (max 4), at least
//     `minGapMinutes` apart (min 180). Once a call is answered, no more
//     calls that day.
//   - A call still in progress (status pending) blocks a new one.

const HARD = {
  maxAttemptsPerDay: 4,
  minGapMinutes: 180,
  minDayGap: 2,
  earliest: "09:00",
  latest: "19:00",
};

function hm(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Applies the hard caps to whatever is in config.json.
function effectiveRules(cfg = {}) {
  const win = cfg.window || {};
  let start = hm(win.start) ?? hm("10:00");
  let end = hm(win.end) ?? hm("19:00");
  start = Math.max(start, hm(HARD.earliest));
  end = Math.min(end, hm(HARD.latest));
  return {
    windowStart: start,
    windowEnd: end,
    maxAttemptsPerDay: clamp(cfg.maxAttemptsPerDay ?? 4, 1, HARD.maxAttemptsPerDay),
    minGapMinutes: Math.max(cfg.minGapMinutes ?? 180, HARD.minGapMinutes),
    dayGap: Math.max(cfg.dayGap ?? 2, HARD.minDayGap),
    skipSundays: cfg.skipSundays !== false,
    minBalance: Math.max(Number(cfg.minBalance ?? 500), 1),
    onlyOverdue: cfg.onlyOverdue !== false,
  };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(n) || lo));
}

function localYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysBetween(ymdA, ymdB) {
  const a = new Date(`${ymdA}T00:00:00`);
  const b = new Date(`${ymdB}T00:00:00`);
  return Math.round((b - a) / 86400000);
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function fmtHm(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// Indian mobile numbers only: 10 digits starting 6-9, optional +91/91/0 prefix.
function normalizeMobile(raw) {
  if (!raw) return null;
  // Tally's mobile field sometimes holds two numbers ("98xxx / 97xxx") - take the first.
  const first = String(raw).split(/[,/;]| or /i)[0];
  let digits = first.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return digits;
}

// attempts: this customer's attempt log, oldest first:
//   { at: ISO string, status: "pending"|"answered"|"no_answer"|"busy"|"failed"|"dry_run" }
// Returns { call: boolean, reason: string, nextAt?: Date }
function decide({ customer, contact, attempts, rules, now }) {
  if (!contact || !contact.enabled) return { call: false, reason: "बंद (OFF)" };

  const phone = normalizeMobile(contact.phone || customer.mobile);
  if (!phone) return { call: false, reason: "मोबाईल नंबर नाही / चुकीचा" };
  if (!customer.owes) return { call: false, reason: "बाकी नाही (जमा / advance)" };
  if (customer.balance < rules.minBalance) return { call: false, reason: `बाकी ₹${rules.minBalance} पेक्षा कमी` };
  if (rules.onlyOverdue && !(customer.overdueDays > 0)) return { call: false, reason: "अजून मुदत संपलेली नाही" };

  if (attempts.some((a) => a.status === "pending")) return { call: false, reason: "कॉल चालू आहे" };

  const today = localYmd(now);
  const todays = attempts.filter((a) => localYmd(new Date(a.at)) === today);
  const nowMin = minutesOfDay(now);

  // Not a call day? (a previous call day was too recent)
  if (todays.length === 0) {
    const prevDays = attempts.map((a) => localYmd(new Date(a.at))).filter((d) => d < today);
    const lastDay = prevDays.length ? prevDays.sort().at(-1) : null;
    if (lastDay && daysBetween(lastDay, today) < rules.dayGap) {
      const next = new Date(`${lastDay}T00:00:00`);
      next.setDate(next.getDate() + rules.dayGap);
      next.setHours(Math.floor(rules.windowStart / 60), rules.windowStart % 60, 0, 0);
      return { call: false, reason: "आज कॉलचा दिवस नाही (एक दिवसाआड)", nextAt: next, phone };
    }
  }

  if (rules.skipSundays && now.getDay() === 0) return { call: false, reason: "रविवार - कॉल नाही", phone };
  if (nowMin < rules.windowStart) return { call: false, reason: `वेळ ${fmtHm(rules.windowStart)} नंतर`, phone };
  if (nowMin > rules.windowEnd) return { call: false, reason: `आजची वेळ संपली (${fmtHm(rules.windowEnd)})`, phone };

  if (todays.some((a) => a.status === "answered")) return { call: false, reason: "आज कॉल उचलला - पुढचा कॉल एक दिवसाआड", phone };
  if (todays.length >= rules.maxAttemptsPerDay) return { call: false, reason: `आजचे ${rules.maxAttemptsPerDay} प्रयत्न पूर्ण`, phone };

  if (todays.length) {
    const last = new Date(todays.at(-1).at);
    const nextAt = new Date(last.getTime() + rules.minGapMinutes * 60000);
    if (now < nextAt) {
      if (minutesOfDay(nextAt) > rules.windowEnd || localYmd(nextAt) !== today) {
        return { call: false, reason: "आजची वेळ संपली", phone };
      }
      return { call: false, reason: `पुढचा प्रयत्न ${fmtHm(minutesOfDay(nextAt))} ला`, nextAt, phone };
    }
  }

  return { call: true, reason: "कॉल करायचा", phone };
}

module.exports = { HARD, effectiveRules, decide, normalizeMobile, localYmd, fmtHm };

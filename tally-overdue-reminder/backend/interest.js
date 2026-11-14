// Simple interest at `ratePercentPerMonth`, pro-rated by the number of days
// past the due date (days overdue / 30 * rate). No interest before the due
// date, and nothing compounds.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysOverdue(dueDateStr, asOfDateStr) {
  if (!dueDateStr) return 0;
  const due = new Date(`${dueDateStr}T00:00:00`);
  const asOf = new Date(`${asOfDateStr}T00:00:00`);
  const diffDays = Math.floor((asOf - due) / MS_PER_DAY);
  return Math.max(0, diffDays);
}

function calcInterest(amount, dueDateStr, ratePercentPerMonth, asOfDateStr = todayIso()) {
  const overdueDays = daysOverdue(dueDateStr, asOfDateStr);
  if (overdueDays === 0) {
    return { overdueDays: 0, interest: 0 };
  }
  const interest = amount * (ratePercentPerMonth / 100) * (overdueDays / 30);
  return { overdueDays, interest: Math.round(interest * 100) / 100 };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { calcInterest, daysOverdue, todayIso };

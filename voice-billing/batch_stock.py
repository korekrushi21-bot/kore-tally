"""Batch-wise stock for bills: work out which batches have stock, and pick batches for an outgoing item.

Pure logic, no Tally calls (the caller supplies the data), so it can be tested with made-up data.

Rules (the owner's words: item, quantity and batch number should come from Tally automatically):
  * Current stock of a batch = its opening balance (stock-item master) + every inward - every outward in the vouchers.
  * The batch totals MUST add up to Tally's own closing balance of the item. If they do not, nothing is guessed: the
    bill is refused with the reason (a missing voucher type is the usual cause).
  * Batches picked for an outgoing item: FEFO = earliest expiry first; no expiry = oldest first (FIFO); expired batches
    are never used; a quantity that does not fit one batch is split over several; not enough stock = refused.
  * The owner can name a batch ("batch 124"); then only that batch is used, and it must have enough stock.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, Iterable, List, Optional

QTY_TOLERANCE = 0.0005
_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


class BatchError(Exception):
    """A batch problem the owner should hear about. `code` is machine readable, `message` is Marathi."""

    def __init__(self, code: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details or {}


@dataclass
class BatchBalance:
    batch: str
    godown: str = ""
    qty: float = 0.0
    expiry: Optional[date] = None
    first_in: Optional[date] = None     # oldest inward date, for FIFO when there is no expiry
    inward: float = field(default=0.0, repr=False)


def parse_expiry(text: Any) -> Optional[date]:
    """Tally writes expiry in several shapes ('30-Jun-27', '30-Jun-2027', '20270630', '30-06-2027', 'Jun-27')."""
    s = str(text or "").strip()
    if not s:
        return None
    m = re.fullmatch(r"(\d{4})(\d{2})(\d{2})", s)
    if m:
        return _safe_date(int(m[1]), int(m[2]), int(m[3]))
    m = re.fullmatch(r"(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{2,4})", s)
    if m and m[2].lower() in _MONTHS:
        return _safe_date(_year(m[3]), _MONTHS[m[2].lower()], int(m[1]))
    m = re.fullmatch(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})", s)
    if m:
        return _safe_date(_year(m[3]), int(m[2]), int(m[1]))
    m = re.fullmatch(r"([A-Za-z]{3})[A-Za-z]*[-/ ](\d{2,4})", s)       # month-year only: valid to the end of that month
    if m and m[1].lower() in _MONTHS:
        y, mo = _year(m[2]), _MONTHS[m[1].lower()]
        return _safe_date(y + (mo == 12), 1 if mo == 12 else mo + 1, 1, minus_day=True)
    return None


def _year(text: str) -> int:
    y = int(text)
    return y + 2000 if y < 100 else y


def _safe_date(y: int, m: int, d: int, minus_day: bool = False) -> Optional[date]:
    try:
        out = date(y, m, d)
    except ValueError:
        return None
    if minus_day:
        from datetime import timedelta
        out -= timedelta(days=1)
    return out


def compute_batch_balances(openings: Iterable[Dict[str, Any]], movements: Iterable[Dict[str, Any]], opening_date: Optional[date] = None) -> List[BatchBalance]:
    """openings: {batch, godown, qty, expiry?}; movements: {date, inward (bool), batch, godown, qty, expiry?}.
    Cancelled / optional vouchers must already be removed by the caller."""
    book: Dict[tuple, BatchBalance] = {}

    def get(batch: str, godown: str) -> BatchBalance:
        key = (batch.strip().lower(), (godown or "").strip().lower())
        if key not in book:
            book[key] = BatchBalance(batch=batch.strip(), godown=(godown or "").strip())
        return book[key]

    for o in openings:
        b = get(o["batch"], o.get("godown", ""))
        b.qty += float(o["qty"])
        b.expiry = b.expiry or parse_expiry(o.get("expiry"))
        if o["qty"] > 0 and opening_date:
            b.first_in = min(b.first_in, opening_date) if b.first_in else opening_date
    for mv in movements:
        b = get(mv["batch"], mv.get("godown", ""))
        q = float(mv["qty"])
        b.qty += q if mv["inward"] else -q
        if mv["inward"]:
            b.inward += q
            b.expiry = b.expiry or parse_expiry(mv.get("expiry"))
            d = mv.get("date")
            if d:
                b.first_in = min(b.first_in, d) if b.first_in else d
    return list(book.values())


def check_total(balances: List[BatchBalance], closing_qty: float, item: str = "") -> None:
    total = round(sum(b.qty for b in balances), 4)
    if abs(total - round(closing_qty, 4)) > QTY_TOLERANCE:
        raise BatchError(
            "batch_mismatch",
            f"'{item}' चे batch-निहाय एकूण ({total:g}) Tally च्या शिल्लकेशी ({closing_qty:g}) जुळत नाही; "
            "म्हणून batch निवडलेला नाही. हे बिल Tally मध्ये हाताने करा.",
            {"batch_total": total, "tally_closing": closing_qty},
        )


def allocate(balances: List[BatchBalance], qty: float, today: date, wanted_batch: Optional[str] = None, item: str = "") -> List[Dict[str, Any]]:
    """Pick batches for an OUTGOING quantity. Returns [{batch, godown, quantity, expiry, available}] (sum = qty)."""
    qty = round(float(qty), 4)
    usable = [b for b in balances if b.qty > QTY_TOLERANCE and not (b.expiry and b.expiry < today)]

    if wanted_batch:
        w = str(wanted_batch).strip().lower()
        chosen = [b for b in balances if b.batch.lower() == w]
        if not chosen:
            have = ", ".join(sorted({b.batch for b in balances if b.qty > QTY_TOLERANCE})[:8]) or "काहीही नाही"
            raise BatchError("batch_not_found", f"'{item}' चा batch '{wanted_batch}' सापडला नाही. उपलब्ध batch: {have}.")
        usable = [b for b in chosen if b.qty > QTY_TOLERANCE and not (b.expiry and b.expiry < today)]
        if not usable:
            raise BatchError("batch_unusable", f"'{item}' चा batch '{wanted_batch}' मध्ये शिल्लक नाही किंवा तो expire झाला आहे.")

    def order(b: BatchBalance):
        far = date.max
        return (b.expiry or far, b.first_in or far, b.batch.lower(), b.godown.lower())   # FEFO, then FIFO

    usable.sort(key=order)
    available = round(sum(b.qty for b in usable), 4)
    if qty - available > QTY_TOLERANCE:
        raise BatchError("insufficient_stock", f"'{item}' चा वापरता येण्याजोगा साठा {available:g} आहे, तुम्ही {qty:g} सांगितले.",
                         {"available": available, "wanted": qty})

    left, out = qty, []
    for b in usable:
        if left <= QTY_TOLERANCE:
            break
        take = round(min(b.qty, left), 4)
        out.append({"batch": b.batch, "godown": b.godown, "quantity": take,
                    "expiry": b.expiry.isoformat() if b.expiry else "", "available": round(b.qty, 4)})
        left = round(left - take, 4)
    return out


def split_amount(total: float, quantities: List[float]) -> List[float]:
    """Split a line amount over batch quantities; rounded to paise, the last batch takes the remainder."""
    whole = sum(quantities)
    parts = [round(total * q / whole, 2) for q in quantities[:-1]]
    parts.append(round(total - sum(parts), 2))
    return parts

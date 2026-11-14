"""The four voucher types voice billing may create, and how each one posts in Tally.

Accounting sides (Dr/Cr) and stock direction per type:

  sales        party Dr | sales ledger Cr    | stock goes OUT
  purchase     party Cr | purchase ledger Dr | stock comes IN
  credit_note  party Cr | sales ledger Dr    | stock comes IN   (sales return)
  debit_note   party Dr | purchase ledger Cr | stock goes OUT   (purchase return)

Output/input GST ledgers always sit on the same side as the item ledger.
"""
import re
from dataclasses import dataclass
from typing import Optional

from utils import normalize


@dataclass(frozen=True)
class VoucherSpec:
    key: str
    tally_type: str
    label_mr: str
    party_group: str
    party_label_mr: str
    ledger_group: str
    ledger_default: str
    party_is_debit: bool
    stock_in: bool
    rate_source: str  # "sales" or "purchase": whose last rate prefills a missing rate
    gst_side: str     # "output" or "input"
    # Cash sales / purchases name the Cash ledger as the party, and Cash is not under Sundry Debtors/Creditors.
    party_extra_groups: tuple = ("Cash-in-Hand",)


VOUCHER_SPECS = {
    "sales": VoucherSpec(
        "sales", "Sales", "सेल्स बिल", "Sundry Debtors", "ग्राहक",
        "Sales Accounts", "Sales Account", True, False, "sales", "output",
    ),
    "purchase": VoucherSpec(
        "purchase", "Purchase", "परचेस बिल", "Sundry Creditors", "सप्लायर",
        "Purchase Accounts", "Purchase Account", False, True, "purchase", "input",
    ),
    "credit_note": VoucherSpec(
        "credit_note", "Credit Note", "क्रेडिट नोट", "Sundry Debtors", "ग्राहक",
        "Sales Accounts", "Sales Account", False, True, "sales", "output",
    ),
    "debit_note": VoucherSpec(
        "debit_note", "Debit Note", "डेबिट नोट", "Sundry Creditors", "सप्लायर",
        "Purchase Accounts", "Purchase Account", True, False, "purchase", "input",
    ),
}

# Order matters: the return notes are checked before plain sales/purchase.
_PATTERNS = (
    ("credit_note", ("क्रेडिट नोट", "क्रेडीट नोट", "credit note", "सेल्स रिटर्न", "विक्री परतावा", "sales return")),
    ("debit_note", ("डेबिट नोट", "debit note", "परचेस रिटर्न", "खरेदी परतावा", "purchase return")),
    ("purchase", ("परचेस", "खरेदी बिल", "खरेदी", "purchase")),
    ("sales", ("सेल्स", "सेल बिल", "विक्री", "sales", "sale bill", "sale")),
)


def detect_voucher_type(text: str) -> Optional[str]:
    clean = normalize(text)
    compact = re.sub(r"\s+", "", clean)
    for key, phrases in _PATTERNS:
        for phrase in phrases:
            p = normalize(phrase)
            if p in clean or re.sub(r"\s+", "", p) in compact:
                return key
    return None


def get_spec(key: str) -> VoucherSpec:
    try:
        return VOUCHER_SPECS[key]
    except KeyError:
        raise ValueError(f"Unsupported voucher type: {key!r}") from None

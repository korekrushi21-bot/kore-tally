"""Receipt / Payment drafts and XML, against the made-up FakeTally from test_batches (never touches Tally).
Run:  python -m unittest test_money -v
"""
import tempfile
import unittest
import xml.etree.ElementTree as ET

from tally_client import Ledger
from test_batches import CONFIG, FakeTally
from voucher_service import VoucherError, VoucherService
from voucher_types import get_spec
from voucher_xml import assert_create_only, build_import_xml


class MoneyTally(FakeTally):
    def get_ledgers_under(self, group):
        extra = {"Cash-in-Hand": [Ledger("Cash", group, -5000)], "Bank Accounts": [Ledger("SBI Bank", group, -90000)],
                 "Bank OD A/c": [], "Sundry Creditors": [Ledger("Vithal Fertilizer", group, 21470)]}
        return extra.get(group) or super().get_ledgers_under(group)

    def get_ledgers(self):
        return [Ledger("Real Party", "Sundry Debtors", -1200.0), Ledger("Vithal Fertilizer", "Sundry Creditors", 21470.0),
                Ledger("Electricity Bill", "Indirect Expenses", 0.0), Ledger("Cash", "Cash-in-Hand", -5000.0),
                Ledger("SBI Bank", "Bank Accounts", -90000.0), Ledger("R/o", "x", 0)]


CFG = {**CONFIG, "voucher_types": {**CONFIG["voucher_types"], "receipt": {"enabled": True}, "payment": {"enabled": True}},
       "money": {"max_amount": 200000}}


def svc():
    return VoucherService(MoneyTally(), CFG, tempfile.mkdtemp())


def entries(xml):
    v = ET.fromstring(xml).find(".//VOUCHER")
    return v, {e.findtext("LEDGERNAME"): e for e in v.findall("ALLLEDGERENTRIES.LIST")}


class Money(unittest.TestCase):
    def test_receipt_party_cr_cash_dr_with_on_account_bill(self):
        s = svc()
        view = s.draft_money("receipt", "real party", 1500)
        self.assertEqual((view["party"], view["account"], view["total"]), ("Real Party", "Cash", 1500.0))
        self.assertIn("1,500", view["say"]); self.assertIn("येणे", " ".join(view["warnings"]))
        xml = build_import_xml("", get_spec("receipt"), s._drafts[view["draft_id"]])
        assert_create_only(xml)
        v, e = entries(xml)
        self.assertEqual(v.attrib["VCHTYPE"], "Receipt")
        self.assertEqual(e["Real Party"].findtext("AMOUNT"), "1500.00")          # Cr = positive
        self.assertEqual(e["Real Party"].findtext("ISDEEMEDPOSITIVE"), "No")
        self.assertEqual(e["Real Party"].findtext("BILLALLOCATIONS.LIST/BILLTYPE"), "On Account")
        self.assertEqual(e["Cash"].findtext("AMOUNT"), "-1500.00")               # Dr = negative
        self.assertIsNone(e["Cash"].find("BANKALLOCATIONS.LIST"))

    def test_payment_to_supplier_from_bank(self):
        s = svc()
        view = s.draft_money("payment", "vithal", 21470, account="sbi")
        xml = build_import_xml("", get_spec("payment"), s._drafts[view["draft_id"]])
        assert_create_only(xml)
        v, e = entries(xml)
        self.assertEqual(e["Vithal Fertilizer"].findtext("AMOUNT"), "-21470.00")  # party Dr
        self.assertEqual(e["SBI Bank"].findtext("AMOUNT"), "21470.00")           # bank Cr
        self.assertEqual(e["SBI Bank"].findtext("BANKALLOCATIONS.LIST/TRANSACTIONTYPE"), "Others")

    def test_expense_payment_has_no_bill_allocation(self):
        s = svc()
        view = s.draft_money("payment", "electricity bill", 800)
        _, e = entries(build_import_xml("", get_spec("payment"), s._drafts[view["draft_id"]]))
        self.assertIsNone(e["Electricity Bill"].find("BILLALLOCATIONS.LIST"))

    def test_cash_or_bank_cannot_be_the_party_and_limits_hold(self):
        s = svc()
        with self.assertRaises(VoucherError):
            s.draft_money("receipt", "Cash", 100)                       # Cash is the account, never the party
        with self.assertRaises(VoucherError) as cm:
            s.draft_money("receipt", "real party", 500000)
        self.assertEqual(cm.exception.code, "amount_too_large")
        with self.assertRaises(VoucherError):
            s.draft_money("receipt", "real party", 0)
        with self.assertRaises(VoucherError):
            s.draft_money("sales", "real party", 100)                   # not a money voucher

    def test_writes_off_refuses(self):
        s = VoucherService(MoneyTally(), {**CFG, "writes_enabled": False}, tempfile.mkdtemp())
        with self.assertRaises(VoucherError) as cm:
            s.draft_money("payment", "vithal", 10)
        self.assertEqual(cm.exception.code, "writes_disabled")


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""Tests for batch-wise bills, with MADE-UP data only (nothing here talks to Tally).   Run:  python -m unittest test_batches -v"""
import tempfile
import unittest
import xml.etree.ElementTree as ET
from datetime import date

from batch_stock import BatchBalance, BatchError, allocate, check_total, compute_batch_balances, parse_expiry, split_amount
from tally_client import Ledger, StockItem
from voucher_service import VoucherError, VoucherService
from voucher_types import get_spec
from voucher_xml import assert_create_only, build_import_xml

TODAY = date.today()
FY = date(TODAY.year if TODAY.month >= 4 else TODAY.year - 1, 4, 1)


class Parse(unittest.TestCase):
    def test_expiry_shapes(self):
        self.assertEqual(parse_expiry("30-Jun-27"), date(2027, 6, 30))
        self.assertEqual(parse_expiry("30-Jun-2027"), date(2027, 6, 30))
        self.assertEqual(parse_expiry("20270630"), date(2027, 6, 30))
        self.assertEqual(parse_expiry("30-06-2027"), date(2027, 6, 30))
        self.assertEqual(parse_expiry("Jun-27"), date(2027, 6, 30))          # month only = valid to the end of the month
        self.assertEqual(parse_expiry("Dec-27"), date(2027, 12, 31))
        self.assertIsNone(parse_expiry("")); self.assertIsNone(parse_expiry("nonsense")); self.assertIsNone(parse_expiry("31-Feb-27"))


class Stock(unittest.TestCase):
    def test_balance_is_opening_plus_inward_minus_outward(self):
        openings = [{"batch": "A1", "godown": "G", "qty": 19}]
        moves = [
            {"date": FY, "inward": False, "batch": "A1", "godown": "G", "qty": 3},                       # sold 3
            {"date": FY, "inward": True, "batch": "B2", "godown": "G", "qty": 10, "expiry": "30-Jun-27"},  # bought a new batch
            {"date": FY, "inward": False, "batch": "B2", "godown": "G", "qty": 4},
        ]
        by = {b.batch: b for b in compute_batch_balances(openings, moves, FY)}
        self.assertEqual((by["A1"].qty, by["B2"].qty), (16, 6))
        self.assertEqual(by["B2"].expiry, date(2027, 6, 30))
        check_total(list(by.values()), 22, "item")

    def test_totals_that_do_not_match_tallys_closing_are_refused(self):
        b = compute_batch_balances([{"batch": "A1", "godown": "", "qty": 19}], [], FY)
        with self.assertRaises(BatchError) as cm:
            check_total(b, 16, "UREA")
        self.assertEqual(cm.exception.code, "batch_mismatch")
        self.assertIn("हाताने", cm.exception.message)


class Allocation(unittest.TestCase):
    def balances(self):
        return [BatchBalance("OLD", "G", 5, date.today().replace(year=TODAY.year + 1), date(2024, 5, 1)),
                BatchBalance("SOON", "G", 4, date.today().replace(year=TODAY.year + 1) if False else date(TODAY.year + 1, 1, 15), date(2026, 1, 1)),
                BatchBalance("NOEXP", "G", 9, None, date(2025, 1, 1)),
                BatchBalance("EXPIRED", "G", 50, date(TODAY.year - 1, 1, 1), date(2023, 1, 1)),
                BatchBalance("EMPTY", "G", 0, date(TODAY.year + 2, 1, 1), date(2022, 1, 1))]

    def test_earliest_expiry_first_and_expired_never_used(self):
        out = allocate(self.balances(), 7, TODAY)
        self.assertEqual([(o["batch"], o["quantity"]) for o in out], [("SOON", 4), ("OLD", 3)])   # SOON expires before OLD
        self.assertTrue(all(o["batch"] not in ("EXPIRED", "EMPTY") for o in out))
        self.assertAlmostEqual(sum(o["quantity"] for o in out), 7)

    def test_no_expiry_goes_last_and_uses_oldest_first(self):
        out = allocate([BatchBalance("N2", "", 5, None, date(2026, 3, 1)), BatchBalance("N1", "", 5, None, date(2025, 3, 1))], 6, TODAY)
        self.assertEqual([(o["batch"], o["quantity"]) for o in out], [("N1", 5), ("N2", 1)])

    def test_not_enough_stock_is_refused_with_the_usable_total(self):
        with self.assertRaises(BatchError) as cm:
            allocate(self.balances(), 100, TODAY, item="UREA")
        self.assertEqual(cm.exception.code, "insufficient_stock"); self.assertEqual(cm.exception.details["available"], 18)

    def test_owner_names_a_batch(self):
        self.assertEqual(allocate(self.balances(), 2, TODAY, "old")[0]["batch"], "OLD")
        with self.assertRaises(BatchError) as cm:
            allocate(self.balances(), 6, TODAY, "OLD")                 # OLD only has 5
        self.assertEqual(cm.exception.code, "insufficient_stock")
        with self.assertRaises(BatchError) as cm:
            allocate(self.balances(), 1, TODAY, "EXPIRED")
        self.assertEqual(cm.exception.code, "batch_unusable")
        with self.assertRaises(BatchError) as cm:
            allocate(self.balances(), 1, TODAY, "NOPE")
        self.assertEqual(cm.exception.code, "batch_not_found")

    def test_amount_split_keeps_the_total_exact(self):
        parts = split_amount(100.0, [1, 1, 1])
        self.assertEqual(round(sum(parts), 2), 100.0)


class Xml(unittest.TestCase):
    def line(self, batches):
        return {"name": "ITEM B", "unit": "Nos", "quantity": 5, "rate": 100.0, "amount": 500.0, "ledger": "GST Pesticides Sales", "batches": batches}

    def build(self, items):
        spec = get_spec("sales")
        v = {"date": TODAY.strftime("%Y%m%d"), "party": "Cash", "narration": "t", "items": items, "taxes": [], "total": sum(i["amount"] for i in items)}
        xml = build_import_xml("", spec, v)
        assert_create_only(xml)
        return ET.fromstring(xml)

    def test_batch_item_uses_real_batch_names_and_split_amounts(self):
        root = self.build([self.line([{"batch": "124", "godown": "Shirur", "quantity": 3, "expiry": ""}, {"batch": "130", "godown": "Shirur", "quantity": 2, "expiry": ""}])])
        rows = root.findall(".//ALLINVENTORYENTRIES.LIST/BATCHALLOCATIONS.LIST")
        self.assertEqual([r.findtext("BATCHNAME") for r in rows], ["124", "130"])
        self.assertEqual([r.findtext("GODOWNNAME") for r in rows], ["Shirur", "Shirur"])
        self.assertEqual([r.findtext("ACTUALQTY").strip() for r in rows], ["3 Nos", "2 Nos"])
        self.assertEqual([float(r.findtext("AMOUNT")) for r in rows], [300.0, 200.0])      # same sign convention as the item line
        self.assertEqual(float(root.find(".//ALLINVENTORYENTRIES.LIST/AMOUNT").text), 500.0)
        self.assertNotIn("Primary Batch", ET.tostring(root, encoding="unicode"))

    def test_normal_item_still_uses_primary_batch(self):
        root = self.build([{**self.line(None), "batches": None}])
        self.assertEqual(root.findtext(".//BATCHALLOCATIONS.LIST/BATCHNAME"), "Primary Batch")


class FakeTally:
    """Made-up Tally with one batch item (UREA B) and one normal item."""
    company = ""

    def __init__(self, closing=22.0, moves=None):
        self.closing = closing
        self.moves = moves if moves is not None else [
            {"item": "ITEM B", "date": FY, "inward": False, "batch": "124", "godown": "G1", "qty": 3, "expiry": "", "type": "Sales"},
            {"item": "ITEM B", "date": FY, "inward": True, "batch": "130", "godown": "G1", "qty": 6, "expiry": "30-Jun-27", "type": "Purchase"},
        ]
        self.requested = []

    def get_ledgers_under(self, group):
        return {"Sundry Debtors": [Ledger("Real Party", group, 0)], "Sundry Creditors": [Ledger("Real Party", group, 0)], "Cash-in-Hand": [Ledger("Cash", group, 0)],
                "Sales Accounts": [Ledger("GST Pesticides Sales", group, 0), Ledger("GST Others Sale", group, 0)],
                "Purchase Accounts": [Ledger("Purchase A/c", group, 0)],
                "Duties & Taxes": [Ledger("CGST", group, 0), Ledger("SGST", group, 0)]}.get(group, [])

    def get_godowns(self): return ["G1", "G2"]
    def get_ledgers(self): return [Ledger("R/o", "x", 0), Ledger("Real Party", "x", 0)]
    def get_stock_items(self):
        return [StockItem("ITEM B", "Pesticides", "Nos", self.closing, 0, 100.0, True), StockItem("ITEM N", "FERTILIZERS", "Bag", 50, 0, 10.0, False)]
    def get_stock_groups(self): return {"pesticides": ("", 18.0), "fertilizers": ("", 5.0)}
    def get_last_item_ledger(self, *a, **k): return None
    def get_item_gst_percent(self): return {}
    def get_last_rate(self, name, kind, party=None, lb=730):
        from tally_client import LastRate
        return LastRate(rate=100.0 if name == "ITEM B" else 10.0, date="20260901", party="Real Party", voucher_number="1", same_party=True)
    def get_last_purchase_info(self, *a, **k): return None
    def get_ledger_states(self): return {}
    def get_company_gst(self): return {}
    def get_party_gst(self): return {}
    def get_batch_openings(self, item): return [{"batch": "124", "godown": "G1", "qty": 19.0, "expiry": ""}] if item == "ITEM B" else []
    def get_stock_movements(self, vtype, start, end):
        self.requested.append((vtype, start, end))
        return [m for m in self.moves if m["type"] == vtype and start <= m["date"] <= end]


CONFIG = {
    "writes_enabled": True,
    "voucher_types": {
        **{k: {"enabled": True, "item_ledger_by_group": {"Pesticides": "GST Pesticides Sales", "*": "GST Others Sale", "FERTILIZERS": "GST Others Sale"}}
           for k in ("sales", "credit_note")},
        **{k: {"enabled": True, "item_ledger": "Purchase A/c"} for k in ("purchase", "debit_note")}},
    "gst": {"enabled": False}, "rounding": {"enabled": False},
    "billing": {"batch_policy": "auto", "draft_ttl_seconds": 600},
}


class GodownRule(unittest.TestCase):
    def draft(self, items):
        svc = VoucherService(FakeTally(), CONFIG, tempfile.mkdtemp())
        return svc, svc.draft("sales", "real party", items)

    def test_missing_godown_is_asked_with_the_choices(self):
        with self.assertRaises(VoucherError) as cm:
            self.draft([{"name": "item n", "quantity": 1}])
        self.assertEqual(cm.exception.code, "godown_missing")
        self.assertIn("G1", cm.exception.message); self.assertIn("G2", cm.exception.message)

    def test_unknown_godown_is_refused(self):
        with self.assertRaises(VoucherError):
            self.draft([{"name": "item n", "quantity": 1, "godown": "Nowhere"}])

    def test_normal_item_gets_its_godown_in_the_xml(self):
        svc, view = self.draft([{"name": "item n", "quantity": 1, "godown": "g2"}])
        xml = build_import_xml("", get_spec("sales"), svc._drafts[view["draft_id"]])
        self.assertEqual(ET.fromstring(xml).findtext(".//BATCHALLOCATIONS.LIST/GODOWNNAME"), "G2")
        self.assertEqual(ET.fromstring(xml).findtext(".//BATCHALLOCATIONS.LIST/BATCHNAME"), "Primary Batch")

    def test_batch_item_only_takes_batches_of_the_chosen_godown(self):
        svc, view = self.draft([{"name": "item b", "quantity": 2, "godown": "G1"}])
        self.assertTrue(all(b["godown"] == "G1" for b in view["items"][0]["batches"]))
        with self.assertRaises(VoucherError) as cm:
            self.draft([{"name": "item b", "quantity": 2, "godown": "G2"}])
        self.assertEqual(cm.exception.code, "insufficient_stock")


class Service(unittest.TestCase):
    def svc(self, tally=None, policy="auto"):
        cfg = {**CONFIG, "billing": {**CONFIG["billing"], "batch_policy": policy}}
        return VoucherService(tally or FakeTally(), cfg, tempfile.mkdtemp())

    def draft(self, svc, items, vtype="sales"):
        return svc.draft(vtype, "real party", [{"godown": "G1", **i} for i in items])

    def test_voice_bill_with_a_batch_item_picks_the_batch_from_tally_data(self):
        # batch 124 has 16 left, batch 130 has 6 (expiry 2027): FEFO picks 130 first, then 124
        view = self.draft(self.svc(), [{"name": "item b", "quantity": 8}])
        line = view["items"][0]
        self.assertEqual([(b["batch"], b["quantity"]) for b in line["batches"]], [("130", 6.0), ("124", 2.0)])
        self.assertAlmostEqual(line["amount"], 800.0)
        self.assertIn("batch 130 6", view["say"]); self.assertIn("batch 124 2", view["say"])

    def test_owner_can_name_the_batch(self):
        view = self.draft(self.svc(), [{"name": "item b", "quantity": 5, "batch": "124"}])
        self.assertEqual([(b["batch"], b["quantity"]) for b in view["items"][0]["batches"]], [("124", 5.0)])

    def test_normal_items_are_unaffected_and_get_no_batches(self):
        view = self.draft(self.svc(), [{"name": "item n", "quantity": 2}, {"name": "item b", "quantity": 1}])
        self.assertEqual(view["items"][0]["batches"], []); self.assertEqual(len(view["items"][1]["batches"]), 1)

    def test_mismatch_with_tallys_closing_stock_refuses_instead_of_guessing(self):
        with self.assertRaises(VoucherError) as cm:
            self.draft(self.svc(FakeTally(closing=99.0)), [{"name": "item b", "quantity": 1}])
        self.assertEqual(cm.exception.code, "batch_mismatch")

    def test_not_enough_stock_is_refused(self):
        with self.assertRaises(VoucherError) as cm:
            self.draft(self.svc(), [{"name": "item b", "quantity": 500}])
        self.assertEqual(cm.exception.code, "insufficient_stock")

    def test_old_behaviour_is_still_available(self):
        with self.assertRaises(VoucherError) as cm:
            self.draft(self.svc(policy="refuse"), [{"name": "item b", "quantity": 1}])
        self.assertEqual(cm.exception.code, "batch_item")

    def test_purchase_of_a_batch_item_needs_the_batch_from_the_owner(self):
        with self.assertRaises(VoucherError) as cm:
            self.draft(self.svc(), [{"name": "item b", "quantity": 5, "rate": 90}], "purchase")
        self.assertEqual(cm.exception.code, "batch_required")
        view = self.draft(self.svc(), [{"name": "item b", "quantity": 5, "rate": 90, "batch": "NEW9"}], "purchase")
        self.assertEqual(view["items"][0]["batches"][0]["batch"], "NEW9")

    def test_history_is_read_further_back_only_when_the_totals_do_not_match(self):
        old = date(FY.year - 1, 7, 1)
        t = FakeTally(closing=16.0, moves=[{"item": "ITEM B", "date": old, "inward": False, "batch": "124", "godown": "G1", "qty": 3, "expiry": "", "type": "Sales"}])
        self.draft(self.svc(t), [{"name": "item b", "quantity": 1}])
        self.assertTrue(any(s < FY for _, s, _ in t.requested))          # needed last year's sale to reach Tally's 16
        t2 = FakeTally()
        self.draft(self.svc(t2), [{"name": "item b", "quantity": 1}])
        self.assertFalse(any(s < FY for _, s, _ in t2.requested))        # current year was enough: no extra reading

    def test_only_read_requests_are_used_by_the_batch_code(self):
        with open("voucher_service.py", encoding="utf-8") as fh:
            src = fh.read()
        seg = src[src.index("def _batch_balances"):src.index("# ---------- GST ----------")]
        self.assertNotIn("post_import", seg)
        with open("tally_client.py", encoding="utf-8") as fh:
            tc = fh.read()
        seg2 = tc[tc.index("def get_batch_openings"):tc.index("def _listof")]
        self.assertNotIn("post_import", seg2); self.assertNotIn("Import", seg2)


if __name__ == "__main__":
    unittest.main(verbosity=2)

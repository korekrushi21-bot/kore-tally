"""Offline tests for the new commands. Uses fake data only - never connects to Tally."""
import unittest

import command_parser
import tally_readonly
import voice_helper
from tally_readonly import TallyReadOnly, summarize_receivables

WAKE = "ओके टॅली"


def parse(text):
    return command_parser.parse_command(f"{WAKE} {text}", WAKE)


class FakeTally(TallyReadOnly):
    """Overrides query() with canned rows; the sub-group case mimics customers grouped by village."""
    GROUPS = [
        {"$Name": "Sundry Debtors", "$Parent": ""},
        {"$Name": "Village A", "$Parent": "Sundry Debtors"},
        {"$Name": "Hamlet A1", "$Parent": "Village A"},
        {"$Name": "Sundry Creditors", "$Parent": ""},
    ]
    LEDGERS = [
        {"$Name": "Ramesh", "$Parent": "Sundry Debtors", "$_ClosingBalance": "-5000"},
        {"$Name": "Suresh", "$Parent": "Village A", "$_ClosingBalance": "-12000.50"},
        {"$Name": "Ganesh", "$Parent": "Hamlet A1", "$_ClosingBalance": "-800"},
        {"$Name": "Advance Paid Customer", "$Parent": "Sundry Debtors", "$_ClosingBalance": "300"},
        {"$Name": "Settled", "$Parent": "Sundry Debtors", "$_ClosingBalance": "0"},
        {"$Name": "Supplier X", "$Parent": "Sundry Creditors", "$_ClosingBalance": "-99999"},
        {"$Name": "Cash", "$Parent": "Cash-in-Hand", "$_ClosingBalance": "-77777"},
    ]

    def __init__(self):
        super().__init__({})

    def query(self, key, params=()):
        return {"group_parents": self.GROUPS, "ledger_parents": self.LEDGERS}[key]


class ParserTests(unittest.TestCase):
    def kind(self, text):
        return parse(text)["kind"]

    def test_total(self):
        for text in ("एकूण बाकी किती", "टोटल बाकी सांगा", "सगळ्यांची बाकी किती आहे", "total outstanding"):
            self.assertEqual(self.kind(text), "total_outstanding", text)

    def test_top(self):
        for text in ("सर्वात जास्त बाकी कोणाची", "सगळ्यात जास्त बाकी कोणाची आहे", "सर्वाधिक बाकी"):
            self.assertEqual(self.kind(text), "top_outstanding", text)

    def test_customer_names_are_not_hijacked(self):
        for name in ("सर्वेश", "रमेश", "टोटल एग्रो"):
            r = parse(f"{name} यांची बाकी")
            self.assertEqual(r["kind"], "party_outstanding", name)
        self.assertEqual(parse("रमेश यांची बाकी")["subject"], "रमेश")

    def test_existing_commands_unchanged(self):
        self.assertEqual(self.kind("आजची विक्री"), "today_sales")
        self.assertEqual(self.kind("आजची खरेदी"), "today_purchases")
        self.assertEqual(self.kind("वर्ग बाकी दाखवा"), "category_outstanding")
        self.assertEqual(self.kind("एकूण वर्ग बाकी"), "category_outstanding")


class DataTests(unittest.TestCase):
    def test_debtors_only_including_subgroups(self):
        names = {n for n, _ in FakeTally().debtor_balances()}
        self.assertEqual(names, {"Ramesh", "Suresh", "Ganesh", "Advance Paid Customer", "Settled"})

    def test_summary(self):
        s = summarize_receivables(FakeTally().debtor_balances())
        self.assertAlmostEqual(s["total"], 5000 + 12000.5 + 800)
        self.assertEqual(s["count"], 3)
        self.assertEqual([n for n, _ in s["top"]], ["Suresh", "Ramesh", "Ganesh"])
        self.assertEqual((s["advance_count"], s["advance_total"]), (1, 300))

    def test_group_cycle_does_not_hang(self):
        t = FakeTally()
        t.GROUPS = [{"$Name": "A", "$Parent": "B"}, {"$Name": "B", "$Parent": "A"}]
        t.LEDGERS = [{"$Name": "X", "$Parent": "A", "$_ClosingBalance": "-1"}]
        self.assertEqual(t.debtor_balances(), [])

    def test_queries_are_read_only(self):
        for sql in tally_readonly._DEFAULT_QUERIES.values():
            tally_readonly.assert_read_only_sql(sql)


class AnswerTests(unittest.TestCase):
    def setUp(self):
        self._orig = voice_helper.TallyReadOnly
        voice_helper.TallyReadOnly = lambda config: FakeTally()
        FakeTally.__enter__ = lambda self: self
        FakeTally.__exit__ = lambda self, *a: None

    def tearDown(self):
        voice_helper.TallyReadOnly = self._orig

    def ask(self, text):
        parsed = parse(text)
        return voice_helper.format_result(parsed, {"result_fields": {}}, {})

    def test_total_answer(self):
        self.assertEqual(self.ask("एकूण बाकी किती"), "एकूण येणे बाकी 17,800.50 रुपये आहे, 3 ग्राहकांकडे.")

    def test_top_answer(self):
        self.assertEqual(
            self.ask("सर्वात जास्त बाकी कोणाची"),
            "सर्वात जास्त बाकी: 1. Suresh, 12,000.50 रुपये; 2. Ramesh, 5,000.00 रुपये; 3. Ganesh, 800.00 रुपये.",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

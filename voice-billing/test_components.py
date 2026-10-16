import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from utils import (
    normalize, variants, match_name, extract_number,
    is_confirmation, is_rejection, is_finalize, is_cancel_session,
    parse_quantity_and_item, format_currency
)
from command_parser import CommandParser


def test_normalize():
    print("Testing normalize...")
    assert normalize("  राम  ट्रेडर्स  ") == "राम ट्रेडर्स"
    assert normalize("RAM TRADERS") == "ram traders"
    assert normalize("राम-ट्रेडर्स") == "राम ट्रेडर्स"
    print("  [OK] normalize")


def test_variants():
    print("Testing variants...")
    v = variants("राम ट्रेडर्स")
    assert "राम ट्रेडर्स" in v
    assert "ट्रेडर्स राम" in v
    v2 = variants("Amistar Top 100ml")
    assert "amistar top 100ml" in v2
    print("  [OK] variants")


def test_match_name():
    print("Testing match_name...")
    names = ["राम ट्रेडर्स", "श्याम एंटरप्राइजेज", "Amistar Top 100ml", "Urea 45kg"]
    result = match_name("राम ट्रेडर्स", names)
    assert result["status"] == "matched"
    assert result["name"] == "राम ट्रेडर्स"

    result = match_name("राम ट्रेडर", names)
    assert result["status"] == "matched"
    assert result["name"] == "राम ट्रेडर्स"

    result = match_name("अमिस्टार टॉप", names)
    assert result["status"] == "matched"
    assert result["name"] == "Amistar Top 100ml"

    result = match_name("अज्ञात", names)
    assert result["status"] == "not_found"
    print("  [OK] match_name")


def test_extract_number():
    print("Testing extract_number...")
    assert extract_number("दोन") == 2
    assert extract_number("तीन") == 3
    assert extract_number("पाच") == 5
    assert extract_number("दहा") == 10
    assert extract_number("शंभर") == 100
    assert extract_number("two") == 2
    assert extract_number("five") == 5
    assert extract_number("10") == 10
    assert extract_number("2.5") == 2.5
    assert extract_number("नग दोन") == 2
    print("  [OK] extract_number")


def test_confirmation():
    print("Testing confirmation detection...")
    assert is_confirmation("हो")
    assert is_confirmation("बरोबर")
    assert is_confirmation("ठीक आहे")
    assert is_confirmation("yes")
    assert is_confirmation("ok")
    assert is_confirmation("confirm")
    assert not is_confirmation("नाही")
    print("  [OK] confirmation")


def test_rejection():
    print("Testing rejection detection...")
    assert is_rejection("नाही")
    assert is_rejection("नको")
    assert is_rejection("रद्द")
    assert is_rejection("cancel")
    assert is_rejection("no")
    assert not is_rejection("हो")
    print("  [OK] rejection")


def test_finalize():
    print("Testing finalize detection...")
    assert is_finalize("बिल बनव")
    assert is_finalize("बिल सेव्ह करा")
    assert is_finalize("फायनल")
    assert is_finalize("create bill")
    assert not is_finalize("हो")
    print("  [OK] finalize")


def test_cancel_session():
    print("Testing cancel session detection...")
    assert is_cancel_session("रद्द")
    assert is_cancel_session("बंद करा")
    assert is_cancel_session("बाहेर पडा")
    assert is_cancel_session("exit")
    assert is_cancel_session("quit")
    assert not is_cancel_session("हो")
    print("  [OK] cancel_session")


def test_parse_quantity_and_item():
    print("Testing parse_quantity_and_item...")
    item, qty = parse_quantity_and_item("युरिया 45 किलो दोन नग")
    assert qty == 2
    assert "युरिया" in item

    item, qty = parse_quantity_and_item("दोन नग")
    assert qty == 2
    assert item is None or item == ""

    item, qty = parse_quantity_and_item("तीन नग डीएपी")
    assert qty == 3
    assert "डीएपी" in item
    print("  [OK] parse_quantity_and_item")


def test_format_currency():
    print("Testing format_currency...")
    assert format_currency(1000) == "1,000.00"
    assert format_currency(1234567.89) == "1,234,567.89"
    assert format_currency(0) == "0.00"
    print("  [OK] format_currency")


def test_command_parser():
    print("Testing command_parser...")
    parser = CommandParser("टॅली सुरू कर")

    result = parser.parse("टॅली सुरू कर", session_active=False)
    assert result["wake_detected"] is True
    assert result["status"] == "ok"

    result = parser.parse("टॅली सुरू कर ग्राहक राम ट्रेडर्स", session_active=False)
    assert result["wake_detected"] is True
    assert "राम ट्रेडर्स" in result["payload"]

    result = parser.parse("ग्राहक राम ट्रेडर्स", session_active=True)
    assert result["wake_detected"] is False
    assert result["status"] == "ok"

    result = parser.parse("राम ट्रेडर्स", session_active=False)
    assert result["status"] == "ignored"

    intent = parser.classify_intent("ग्राहक राम ट्रेडर्स")
    assert intent["intent"] == "BILLING"

    intent = parser.classify_intent("राम ट्रेडर्स बाकी")
    assert intent["intent"] == "BALANCE_INQUIRY"

    intent = parser.classify_intent("युरिया स्टॉक")
    assert intent["intent"] == "STOCK_INQUIRY"

    intent = parser.classify_intent("रद्द")
    assert intent["intent"] == "CANCEL_SESSION"
    print("  [OK] command_parser")


def run_all_tests():
    print("Running component tests...\n")
    test_normalize()
    test_variants()
    test_match_name()
    test_extract_number()
    test_confirmation()
    test_rejection()
    test_finalize()
    test_cancel_session()
    test_parse_quantity_and_item()
    test_format_currency()
    test_command_parser()
    print("\n[ALL TESTS PASSED]")


if __name__ == "__main__":
    run_all_tests()
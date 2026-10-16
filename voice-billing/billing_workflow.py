import re
import time
import logging
from enum import Enum
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field
from utils import (
    match_name, extract_number, is_confirmation, is_rejection,
    is_finalize, is_cancel_session,
)
from tally_client import TallyClient, Ledger
from voucher_service import VoucherService, VoucherError
from voucher_types import detect_voucher_type, get_spec

PARTY_ASK = {"sales": "ग्राहकाचे", "credit_note": "ग्राहकाचे", "purchase": "सप्लायरचे", "debit_note": "सप्लायरचे"}
RATE_WORDS = r"(?:दर|रेट|rate)"


class SessionState(Enum):
    IDLE = "IDLE"
    ACTIVE = "ACTIVE"
    CONFIRMING = "CONFIRMING"
    FINALIZING = "FINALIZING"


class BillingStep(Enum):
    TYPE = "TYPE"
    PARTY = "PARTY"
    ITEM = "ITEM"
    RATE = "RATE"
    GST = "GST"
    QUANTITY = "QUANTITY"
    CONFIRM_LINE = "CONFIRM_LINE"
    FINALIZE = "FINALIZE"


@dataclass
class BillItem:
    name: str
    quantity: float
    rate: float
    unit: str
    amount: float
    gst_percent: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "quantity": self.quantity,
            "rate": self.rate,
            "unit": self.unit,
            "amount": self.amount,
            "gst_percent": self.gst_percent,
        }


@dataclass
class BillingSession:
    state: SessionState = SessionState.IDLE
    mode: str = "BILLING"  # BILLING or INQUIRY
    voucher_type: Optional[str] = None
    party: Optional[str] = None
    items: List[BillItem] = field(default_factory=list)
    step: BillingStep = BillingStep.TYPE
    last_activity: float = field(default_factory=time.time)
    wake_detected_at: float = field(default_factory=time.time)
    outstanding_party: bool = False
    stock_pack_choice: bool = False
    pending_item_name: Optional[str] = None
    pending_unit: Optional[str] = None
    pending_rate: Optional[float] = None
    pending_gst: Optional[float] = None
    pending_quantity: Optional[float] = None
    draft_id: Optional[str] = None

    def reset(self):
        self.state = SessionState.IDLE
        self.mode = "BILLING"
        self.voucher_type = None
        self.party = None
        self.items.clear()
        self.step = BillingStep.TYPE
        self.last_activity = time.time()
        self.outstanding_party = False
        self.stock_pack_choice = False
        self.clear_pending()
        self.draft_id = None

    def clear_pending(self):
        self.pending_item_name = None
        self.pending_unit = None
        self.pending_rate = None
        self.pending_gst = None
        self.pending_quantity = None

    def touch(self):
        self.last_activity = time.time()

    def is_expired(self, timeout: float = 20.0) -> bool:
        return time.time() - self.last_activity > timeout


class BillingWorkflow:
    def __init__(self, tally: TallyClient, config: dict, log_dir: str):
        self.tally = tally
        self.config = config
        self.log_dir = log_dir
        self.service = VoucherService(tally, config, log_dir)
        self.session = BillingSession()
        self.matching_threshold = config.get("matching", {}).get("threshold", 0.74)
        self.matching_ambiguity_gap = config.get("matching", {}).get("ambiguity_gap", 0.05)
        self.session_timeout = config.get("session", {}).get("inactivity_timeout_seconds", 20.0)
        self.lookback = config.get("purchase_lookup", {}).get("lookback_days", 730)

    # ---------- session ----------

    def _timeout(self) -> float:
        """The long final read-back plus the user's answer takes longer than the normal 20 s of silence."""
        if self.session.step == BillingStep.FINALIZE:
            return max(self.session_timeout, 60.0)
        return self.session_timeout

    def handle_wake(self, initial_text: str = "") -> str:
        self._drop_draft()
        self.session.reset()
        self.session.state = SessionState.ACTIVE
        self.session.wake_detected_at = time.time()
        self.session.touch()
        key = detect_voucher_type(initial_text) if initial_text else None
        if key:
            return "टॅली सुरू. " + self._select_type(key)
        return "टॅली सुरू. कोणते बिल? सेल्स, परचेस, क्रेडिट नोट की डेबिट नोट?"

    def handle_command(self, text: str) -> str:
        if self.session.state == SessionState.IDLE:
            return ""

        if self.session.is_expired(self._timeout()):
            self._drop_draft()
            self.session.reset()
            return "सत्र टाइमआउट. पुन्हा 'टॅली सुरू कर' म्हणा."
        self.session.touch()

        if is_cancel_session(text):
            self._drop_draft()
            self.session.reset()
            return "सत्र रद्द केले. टॅली मध्ये काहीही सेव्ह झालेले नाही."

        if self.session.mode == "INQUIRY":
            return self._handle_inquiry(text)
        if self.session.outstanding_party:
            return self._handle_outstanding_followup(text)
        if self.session.stock_pack_choice:
            return self._handle_stock_pack_followup(text)
        return self._handle_billing_step(text)

    def _drop_draft(self) -> None:
        if self.session.draft_id:
            self.service.cancel(self.session.draft_id)
            self.session.draft_id = None

    def _handle_billing_step(self, text: str) -> str:
        step = self.session.step
        handlers = {
            BillingStep.TYPE: self._handle_type_step,
            BillingStep.PARTY: self._handle_party_step,
            BillingStep.ITEM: self._handle_item_step,
            BillingStep.RATE: self._handle_rate_step,
            BillingStep.GST: self._handle_gst_step,
            BillingStep.QUANTITY: self._handle_quantity_step,
            BillingStep.CONFIRM_LINE: self._handle_confirm_line_step,
            BillingStep.FINALIZE: self._handle_finalize_step,
        }
        handler = handlers.get(step)
        return handler(text) if handler else "अनपेक्षित अवस्था."

    # ---------- steps ----------

    def _select_type(self, key: str) -> str:
        spec = get_spec(key)
        if not self.service.writes_allowed(key):
            return f"{spec.label_mr} तयार करणे सध्या बंद आहे. दुसरा प्रकार सांगा."
        self.session.voucher_type = key
        self.session.step = BillingStep.PARTY
        return f"{spec.label_mr}. {PARTY_ASK[key]} नाव बोला."

    def _handle_type_step(self, text: str) -> str:
        key = detect_voucher_type(text)
        if key:
            return self._select_type(key)
        clean = text.lower()
        if "बाकी" in clean or "balance" in clean or "स्टॉक" in clean or "stock" in clean:
            self.session.mode = "INQUIRY"
            return self._handle_inquiry(text)
        return "कोणते बिल? सेल्स, परचेस, क्रेडिट नोट की डेबिट नोट?"

    def _handle_party_step(self, text: str) -> str:
        spec = get_spec(self.session.voucher_type)
        try:
            party = self.service.resolve_party(spec, text.strip())
        except VoucherError as e:
            return e.message
        self.session.party = party
        self.session.step = BillingStep.ITEM
        return f"{party} निवडले. आता मालाचे नाव बोला."

    def _handle_item_step(self, text: str) -> str:
        if is_finalize(text):
            return self._make_draft()

        spec = get_spec(self.session.voucher_type)
        try:
            item = self.service.resolve_item(text.strip())
        except VoucherError as e:
            return e.message

        self.session.pending_item_name = item.name
        self.session.pending_unit = item.unit or "Nos"
        self._print_purchase_info(item.name)

        last = self.tally.get_last_rate(item.name, spec.rate_source, self.session.party, self.lookback)
        if last is None:
            self.session.step = BillingStep.RATE
            return f"{item.name} निवडले. मागचा दर सापडला नाही. दर सांगा."
        self.session.pending_rate = last.rate
        return self._after_rate(f"{item.name} निवडले. दर {last.rate:,.2f} रुपये {item.unit}.")

    def _after_rate(self, prefix: str) -> str:
        """Next question once the line rate is known: GST % if Tally can't tell us, else the quantity."""
        spec = get_spec(self.session.voucher_type)
        if self.config.get("gst", {}).get("enabled", False) and self.session.pending_gst is None:
            try:
                self.session.pending_gst = self.service.item_gst_percent(
                    self.session.pending_item_name, None, spec, self.session.party)
            except VoucherError as e:
                if e.code == "gst_unknown":
                    self.session.step = BillingStep.GST
                    return f"{prefix} {e.message}"
                raise
        self.session.step = BillingStep.QUANTITY
        return f"{prefix} नग बोला. दर वेगळा हवा तर 'दर' आणि आकडा म्हणा."

    def _print_purchase_info(self, item_name: str) -> None:
        """Console-only reference for the operator; never spoken (TTS), so the customer never hears it."""
        try:
            info = self.tally.get_last_purchase_info(item_name, self.lookback)
        except Exception as e:
            logging.warning(f"Purchase price lookup failed for {item_name}: {e}")
            return

        if info is None:
            print(f"   [फक्त तुमच्यासाठी] {item_name}: अलीकडची खरेदी नोंद सापडली नाही.")
            return

        shown_date = info.date
        if len(info.date) == 8 and info.date.isdigit():
            shown_date = f"{info.date[6:8]}-{info.date[4:6]}-{info.date[0:4]}"

        if info.gst_percent:
            incl_rate = info.rate * (1 + info.gst_percent / 100)
            print(
                f"   [फक्त तुमच्यासाठी] {item_name} खरेदी किंमत: {info.rate:,.2f} + "
                f"GST {info.gst_percent:g}% = {incl_rate:,.2f} "
                f"(शेवटची खरेदी {shown_date}, बिल क्र. {info.voucher_number})"
            )
        else:
            print(
                f"   [फक्त तुमच्यासाठी] {item_name} खरेदी किंमत: {info.rate:,.2f} (GST वेगळा दिसला नाही) "
                f"(शेवटची खरेदी {shown_date}, बिल क्र. {info.voucher_number})"
            )

    def _handle_rate_step(self, text: str) -> str:
        rate = extract_number(text)
        if rate is None or rate <= 0:
            return "दराचा आकडा स्पष्ट ऐकू आला नाही. फक्त दर पुन्हा बोला."
        self.session.pending_rate = rate
        return self._after_rate(f"दर {rate:,.2f} रुपये.")

    def _handle_gst_step(self, text: str) -> str:
        gst = extract_number(text)
        if gst is None or not 0 <= gst <= 40:
            return "GST टक्के स्पष्ट ऐकू आले नाहीत. फक्त टक्के बोला (नसेल तर शून्य)."
        self.session.pending_gst = gst
        self.session.step = BillingStep.QUANTITY
        return f"GST {gst:g} टक्के. नग बोला."

    @staticmethod
    def _split_rate(text: str):
        """('दहा नग दर तीनशे') -> ('दहा नग', 300.0). Rate is None when no 'दर' part is spoken."""
        m = re.search(rf"{RATE_WORDS}\s*(.+)$", text, re.IGNORECASE)
        if not m:
            return text, None
        rate = extract_number(m.group(1))
        return text[:m.start()].strip(), rate

    def _handle_quantity_step(self, text: str) -> str:
        qty_text, rate = self._split_rate(text)
        if rate is not None and rate > 0:
            self.session.pending_rate = rate
        quantity = extract_number(qty_text)
        if quantity is None or quantity <= 0:
            if rate is not None:
                return f"दर {self.session.pending_rate:,.2f}. नग बोला."
            return "आकडा स्पष्ट ऐकू आला नाही. कृपया फक्त अंक पुन्हा बोला."

        if self.session.pending_item_name is None or self.session.pending_rate is None:
            return "माहिती गमावली. पुन्हा सुरू करा."

        self.session.pending_quantity = quantity
        self.session.step = BillingStep.CONFIRM_LINE
        return self._line_summary()

    def _line_summary(self) -> str:
        s = self.session
        amount = s.pending_quantity * s.pending_rate
        return (
            f"{s.pending_item_name} {s.pending_quantity:g} {s.pending_unit} "
            f"दर {s.pending_rate:,.2f} रक्कम {amount:,.2f} रुपये. बरोबर असल्यास हो म्हणा."
        )

    def _handle_confirm_line_step(self, text: str) -> str:
        if is_rejection(text):
            self.session.clear_pending()
            self.session.step = BillingStep.ITEM
            return "रद्द केले. पुढचे मालाचे नाव बोला."

        _, new_rate = self._split_rate(text)
        if new_rate is not None and new_rate > 0 and not is_confirmation(text):
            self.session.pending_rate = new_rate
            return self._line_summary()

        if not is_confirmation(text):
            return "कन्फर्मेशन मिळाले नाही. 'हो' किंवा 'बरोबर' म्हणा किंवा 'नाही' म्हणून रद्द करा."

        s = self.session
        if s.pending_item_name is None or s.pending_quantity is None or s.pending_rate is None:
            return "माहिती गमावली. पुन्हा सुरू करा."

        s.items.append(BillItem(
            name=s.pending_item_name,
            quantity=s.pending_quantity,
            rate=s.pending_rate,
            unit=s.pending_unit or "Nos",
            amount=round(s.pending_quantity * s.pending_rate, 2),
            gst_percent=s.pending_gst,
        ))
        s.clear_pending()
        s.step = BillingStep.ITEM
        return "आइटम जोडले. पुढचे मालाचे नाव बोला किंवा 'बिल बनव' म्हणा."

    def _make_draft(self) -> str:
        s = self.session
        if not s.items:
            return "आधी किमान एक माल जोडा."
        raw_items = [
            {"name": i.name, "quantity": i.quantity, "rate": i.rate,
             **({"gst_percent": i.gst_percent} if i.gst_percent is not None else {})}
            for i in s.items
        ]
        try:
            draft = self.service.draft(s.voucher_type, s.party, raw_items, source="voice")
        except VoucherError as e:
            return e.message
        s.draft_id = draft["draft_id"]
        s.step = BillingStep.FINALIZE
        return draft["say"]

    def _handle_finalize_step(self, text: str) -> str:
        if is_rejection(text):
            self._drop_draft()
            self.session.step = BillingStep.ITEM
            return "बिल सेव्ह केले नाही. आणखी माल सांगा, किंवा 'रद्द' म्हणून बाहेर पडा."

        if not is_confirmation(text):
            return "फायनल कन्फर्मेशन मिळाले नाही. 'हो' म्हणून बिल सेव्ह करा किंवा 'नाही' म्हणा."

        draft_id = self.session.draft_id
        try:
            result = self.service.confirm(draft_id)
        except VoucherError as e:
            if e.code in ("draft_expired", "outcome_unknown"):
                self.session.draft_id = None
                self.session.step = BillingStep.ITEM
            return e.message
        self.session.reset()
        return result["say"]

    # ---------- inquiries ----------

    def _handle_inquiry(self, text: str) -> str:
        clean = text.strip()
        if "बाकी" in clean or "balance" in clean.lower():
            return self._handle_balance_inquiry(clean)
        elif "स्टॉक" in clean or "stock" in clean.lower():
            return self._handle_stock_inquiry(clean)
        return "बाकी किंवा स्टॉक म्हणा."

    def _handle_balance_inquiry(self, text: str) -> str:
        clean = text.strip()
        for prefix in ["बाकी", "balance", "यांची बाकी", "ची बाकी", "चा बाकी"]:
            clean = clean.replace(prefix, "").strip()

        if not clean:
            self.session.outstanding_party = True
            return "ग्राहकाचे पूर्ण नाव बोला."

        ledgers = self.tally.get_ledgers()
        ledger_names = [l.name for l in ledgers]
        result = match_name(clean, ledger_names, self.matching_threshold, self.matching_ambiguity_gap)

        if result["status"] == "not_found":
            return "ग्राहक जुळला नाही. पूर्ण नाव पुन्हा बोला."
        if result["status"] == "ambiguous":
            choices = ", ".join(m["name"] for m in result["matches"][:3])
            return f"एकापेक्षा जास्त ग्राहक: {choices}. पूर्ण नाव बोला."

        balance = self.tally.get_party_outstanding(result["name"])
        if balance is None:
            return "बाकी मिळाली नाही."

        self.session.reset()
        if balance < 0:
            return f"{result['name']} यांच्याकडून घ्यायची बाकी {abs(balance):,.2f} रुपये आहे."
        elif balance > 0:
            return f"{result['name']} यांच्या खात्यावर जमा {balance:,.2f} रुपये आहे."
        return f"{result['name']} यांची बाकी शून्य आहे."

    def _handle_stock_inquiry(self, text: str) -> str:
        clean = text.strip()
        for prefix in ["स्टॉक", "stock", "चा स्टॉक", "ची स्टॉक", "साठा"]:
            clean = clean.replace(prefix, "").strip()

        if not clean:
            return "मालाचे नाव बोला."

        stock_items = self.tally.get_stock_items()
        item_names = [item.name for item in stock_items]
        result = match_name(clean, item_names, self.matching_threshold, self.matching_ambiguity_gap)

        if result["status"] == "not_found":
            return "माल जुळले नाही. पूर्ण नाव पुन्हा बोला."
        if result["status"] == "ambiguous":
            if "amistar top" in clean.lower():
                self.session.stock_pack_choice = True
                return "Amistar Top चे packing सांगा: 100 ML की 200 ML?"
            choices = ", ".join(m["name"] for m in result["matches"][:3])
            return f"एकापेक्षा जास्त माल: {choices}. पूर्ण नाव बोला."

        matched_item = next(item for item in stock_items if item.name == result["name"])
        self.session.reset()
        return f"{matched_item.name} चा स्टॉक {matched_item.closing_qty:g} {matched_item.unit} आहे."

    def _handle_outstanding_followup(self, text: str) -> str:
        self.session.outstanding_party = False
        return self._handle_balance_inquiry(text)

    def _handle_stock_pack_followup(self, text: str) -> str:
        clean = text.lower()
        is_100 = any(w in clean for w in ["100", "शंभर", "hundred", "one zero zero", "सौ"])
        is_200 = any(w in clean for w in ["200", "दोनशे", "two hundred", "two zero zero"])

        if is_100 == is_200:
            return "Packing स्पष्ट सांगा: फक्त 100 ML किंवा 200 ML म्हणा."

        self.session.stock_pack_choice = False
        item_name = "Amistar Top 100ml" if is_100 else "Amistar Top 200ml"

        stock_items = self.tally.get_stock_items()
        matched = next((item for item in stock_items if item.name.lower() == item_name.lower()), None)

        if not matched:
            return "Packing स्टॉक मिळाला नाही."

        self.session.reset()
        return f"{matched.name} चा स्टॉक {matched.closing_qty:g} {matched.unit} आहे."

    def check_session_timeout(self) -> bool:
        if self.session.state != SessionState.IDLE and self.session.is_expired(self._timeout()):
            self._drop_draft()
            self.session.reset()
            return True
        return False

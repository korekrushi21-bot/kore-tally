import re
from typing import Dict, Any, Optional
from utils import normalize


class CommandParser:
    def __init__(self, wake_word: str = "टॅली सुरू कर"):
        self.wake_word = wake_word
        self.wake_variants = tuple(map(normalize, (
            wake_word,
            "टॅली सुरू कर",
            "टॅली सुरु कर",
            "टेली सुरू कर",
            "टाली सुरू कर",
            "tally suru kar",
            "tally start",
            "hey tally",
        )))

    def parse(self, text: str, session_active: bool = False) -> Dict[str, Any]:
        clean = normalize(text)
        matched_wake = None

        for variant in self.wake_variants:
            if variant in clean:
                matched_wake = variant
                break

        if not matched_wake:
            compact_clean = re.sub(r"[^a-z0-9\u0900-\u097f]+", "", clean)
            for variant in self.wake_variants:
                compact_var = re.sub(r"[^a-z0-9\u0900-\u097f]+", "", variant)
                if compact_var in compact_clean:
                    matched_wake = variant
                    break

        if matched_wake:
            payload = clean.replace(matched_wake, "", 1).strip()
            return {
                "status": "ok",
                "wake_detected": True,
                "payload": payload,
                "original": text,
            }

        if session_active:
            return {
                "status": "ok",
                "wake_detected": False,
                "payload": clean,
                "original": text,
            }

        return {
            "status": "ignored",
            "reason": "wake_word_missing",
            "original": text,
        }

    def classify_intent(self, payload: str) -> Dict[str, Any]:
        clean = payload.strip()

        billing_keywords = (
            "बिल", "bill", "सेल्स", "sales", "विक्री", "बिल बनव", "बिल सेव्ह",
            "ग्राहक", "पार्टी", "party", "customer", "माल", "आइटम", "item",
            "नग", "qty", "quantity", "दर", "rate", "रक्कम", "amount",
            "बरोबर", "हो", "confirm", "फायनल", "finalize"
        )

        inquiry_keywords = (
            "बाकी", "balance", "outstanding", "येणे", "देणे",
            "स्टॉक", "stock", "साठा", "शिल्लक"
        )

        cancel_keywords = (
            "रद्द", "cancel", "बंद करा", "बाहेर पडा", "exit", "quit"
        )

        if any(k in clean for k in cancel_keywords):
            return {"intent": "CANCEL_SESSION", "confidence": 0.9}

        if any(k in clean for k in billing_keywords):
            return {"intent": "BILLING", "confidence": 0.8}

        if any(k in clean for k in inquiry_keywords):
            if "बाकी" in clean or "balance" in clean or "outstanding" in clean:
                return {"intent": "BALANCE_INQUIRY", "confidence": 0.85}
            if "स्टॉक" in clean or "stock" in clean or "साठा" in clean:
                return {"intent": "STOCK_INQUIRY", "confidence": 0.85}

        return {"intent": "UNKNOWN", "confidence": 0.3}

    def extract_entities(self, payload: str, intent: str) -> Dict[str, Any]:
        clean = payload.strip()
        entities = {}

        if intent in ("BALANCE_INQUIRY", "STOCK_INQUIRY"):
            subject = clean
            for prefix in ("बाकी", "balance", "outstanding", "यांची बाकी", "ची बाकी", "चा बाकी",
                           "स्टॉक", "stock", "चा स्टॉक", "ची स्टॉक", "साठा"):
                subject = subject.replace(prefix, "").strip()
            entities["subject"] = subject

        return entities


def detect_wake_phrase(text: str, wake_word: str = "टॅली सुरू कर") -> bool:
    parser = CommandParser(wake_word)
    result = parser.parse(text, session_active=False)
    return result.get("wake_detected", False)
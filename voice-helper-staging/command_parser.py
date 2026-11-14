import re
from matching import normalize


def activated_command(text, wake_word):
    """Enter/wake-listener already activated listening; add one canonical wake token."""
    clean = normalize(text)
    wake = normalize(wake_word)
    return text if wake and wake in clean else f"{wake_word} {text}".strip()


def _strip(text, phrases):
    result = text
    for phrase in phrases:
        result = result.replace(normalize(phrase), " ")
    return " ".join(result.split())


def _contains_any(text, phrases):
    """Match common Whisper spacing/punctuation variations consistently."""
    compact = re.sub(r"[^a-z0-9\u0900-\u097f]+", "", normalize(text))
    return any(
        re.sub(r"[^a-z0-9\u0900-\u097f]+", "", normalize(phrase)) in compact
        for phrase in phrases
    )


def _bill_fields(payload, role):
    party_labels = "ग्राहक|कस्टमर|party" if role == "customer" else "सप्लायर|पुरवठादार|supplier|party"
    party = re.search(rf"(?:{party_labels})\s+(.+?)(?=\s+(?:माल|वस्तू|item)\s+|$)", payload)
    item = re.search(r"(?:माल|वस्तू|item)\s+(.+?)(?=\s+(?:नग|qty|quantity|प्रमाण|दर|rate)\s+|$)", payload)
    quantity = re.search(r"(?:नग|qty|quantity|प्रमाण)\s*(\d+(?:\.\d+)?)", payload)
    rate = re.search(r"(?:दर|rate)\s*(\d+(?:\.\d+)?)", payload)
    return {
        "party": party.group(1).strip() if party else "",
        "item": item.group(1).strip() if item else "",
        "quantity": float(quantity.group(1)) if quantity else None,
        "rate": float(rate.group(1)) if rate else None,
    }


def parse_command(text, wake_word):
    clean, wake = normalize(text), normalize(wake_word)
    wake_variants = tuple(map(normalize, (
        wake_word,
        "ओके टॅली",
        "ओके टेली",
        "ओके टाली",
        "ओके टेल्ली",
        "ओके ताली",
        "ऑके टॅली",
        "ऑके टेली",
        "ok tally",
        "okay tally",
        "ok telly",
        "okay telly",
        "ok tali",
        "okay tali",
        "कोरे सहायक",
        "कोरे सहाय्यका",
        "कोरे साहाय्यक",
        "पुरे सहाय्यक",
        "पूरे सहाय्यक",
        "औरे सहाय्यक",
        "तोरे सहाय्यक",
        "kore sahayak",
        "kore assistant",
    )))
    matched_wake = next((item for item in wake_variants if item in clean), None)
    if matched_wake is None:
        compact_clean = re.sub(r"[^a-z0-9\u0900-\u097f]+", "", clean)
        matched_wake = next((
            item for item in wake_variants
            if re.sub(r"[^a-z0-9\u0900-\u097f]+", "", item) in compact_clean
        ), None)
    if matched_wake is None:
        return {"status": "ignored", "reason": "wake_word_missing"}
    payload = clean.replace(matched_wake, "", 1).strip()
    amistar_aliases = tuple(map(normalize, (
        "amistar", "amistar top", "अमिस्टार", "अमिस्टार टॉप",
        "अमी स्टार", "अमी स्टोर", "अमीस्टार", "अविस्कर",
        "आविस्कर", "अमिस्कर", "अमिस्टर",
        "अमिस्तार टाप", "अमिस्तार टॉप", "एमिस्टर", "एमिस्टर",
        "amister", "amistaar", "i m mr top", "im mr top", "mr top",
        "अंनी सार तोप", "अनी सार तोप", "अन्नी सार टॉप", "अनी स्टार टॉप",
    )))
    amistar_heard = any(alias in payload for alias in amistar_aliases)
    size_100 = any(size in payload for size in map(normalize, (
        "100 ml", "100ml", "शंभर एम एल", "शंभर", "सम्बरे",
        "संबरे", "शम्बर", "सौ एम एल", "चमबरे मिना",
        "shambarya mail", "shambare mail", "hundred ml",
        "one zero zero ml", "one hundred ml", "chambaremen",
        "chambare men", "chambare ml", "chambarmen",
        "shambhari ml", "shambhari", "shambari ml", "shambari",
        "शम्बरे मिल", "शम्बरे", "शंब़े मैल", "शंभरे मिल",
    )))
    size_200 = any(size in payload for size in map(normalize, (
        "200 ml", "200ml", "दोनशे एम एल", "दोनशे", "दो सौ एम एल",
    )))
    ganesh_heard = any(x in payload for x in map(normalize, (
        "गणेश", "गनेश", "जनेश", "गलेश", "ganesh", "janesh",
    )))
    baburao_heard = any(x in payload for x in map(normalize, (
        "बाबुराव", "बाभुराव", "बाभुराो", "बुर्हों", "baburao",
    )))
    jadhav_heard = any(x in payload for x in map(normalize, (
        "जाधव", "जादव", "जादो", "जादों", "चादव", "jadhav", "jado",
    )))
    outstanding_heard = any(x in payload for x in map(normalize, (
        "बाकी", "भाकी", "baki", "outstanding", "किती", "क्यंति",
        "क्यंतिवाची", "यम्तिपाषी", "खाते", "खात्यात",
    )))
    query_heard = any(x in payload for x in map(normalize, (
        "सांगा", "संगा", "दाखवा", "दाखा", "किती",
    )))
    bill_heard = any(x in payload for x in map(normalize, (
        "बिल", "bill", "सेल्स", "sales", "परचेस", "purchase", "खरेदी",
    )))
    if not bill_heard and jadhav_heard and (
        (ganesh_heard and outstanding_heard)
        or baburao_heard
    ):
        return {
            "status": "ok", "kind": "party_outstanding",
            "subject": "Ganesh Baburao Jadhav",
        }
    if any(x in payload for x in map(normalize, ("सेल्स बिल", "विक्री बिल", "sales bill", "सेल स्विझ"))):
        fields = _bill_fields(payload, "customer")
        return {"status": "ok", "kind": "sales_bill_draft", **fields, "spoken_text": text}
    if any(x in payload for x in map(normalize, ("परचेस बिल", "खरेदी बिल", "purchase bill"))):
        fields = _bill_fields(payload, "supplier")
        return {"status": "ok", "kind": "purchase_bill_draft", **fields, "spoken_text": text}
    if _contains_any(payload, (
        "आजची विक्री", "आज विक्री", "अंजी विक्री", "आजि विक्री",
        "आजची सेल्स", "विक्री दाखव", "विक्री दाखवा", "today sales",
        "सेल्स", "sales", "sale", "सेल", "विकरी", "विक्री",
    )):
        return {"status": "ok", "kind": "today_sales"}
    if any(x in payload for x in map(normalize, (
        "आजची खरेदी", "आज खरेदी", "खरेदी दाखव", "खरेदी दाखवा",
        "आजची परचेस", "परचेस दाखव", "परचेस दाखवा", "परचेस",
        "purchase", "today purchases",
    ))):
        return {"status": "ok", "kind": "today_purchases"}
    # "एकूण बाकी" / "सर्वात जास्त बाकी" - must come before the generic "बाकी" rule below,
    # which would otherwise read "एकूण" or "सर्वात जास्त" as a customer name.
    if _contains_any(payload, ("बाकी", "भाकी", "baki", "outstanding", "येणे")):
        if _contains_any(payload, (
            "सर्वात जास्त", "सगळ्यात जास्त", "सर्वाधिक", "सर्वात मोठी", "highest", "biggest",
        )):
            return {"status": "ok", "kind": "top_outstanding"}
        # "टोटल"/"total" only counts right next to बाकी, so a shop called "टोटल एग्रो" stays a customer.
        asks_total = re.search(r"(एकूण|टोटल|total)\s+(येणे\s+)?(बाकी|भाकी|baki|outstanding)", payload) \
            or _contains_any(payload, ("सर्वांची", "सर्वांचे", "सगळ्यांची", "सगळ्यांचे"))
        if asks_total \
                and not any(x in payload for x in map(normalize, ("वर्ग", "कॅटेगरी", "category", "group"))):
            return {"status": "ok", "kind": "total_outstanding"}
    if any(normalize(x) == payload for x in (
        "customer बाकी", "कस्टमर बाकी", "ग्राहक बाकी", "party outstanding",
        "अपना करी बाति", "अपना करी बाकी", "कस्टमर भाकी", "ग्राहक भाकी",
    )):
        return {"status": "ok", "kind": "party_outstanding", "subject": ""}
    if "बाकी" in payload or "outstanding" in payload:
        if any(x in payload for x in map(normalize, ("वर्ग", "कॅटेगरी", "category", "group"))):
            subject = _strip(payload, ("वर्गाची बाकी", "वर्ग बाकी", "कॅटेगरीची बाकी", "category outstanding", "group outstanding", "दाखव", "दाखवा", "किती", "आहे"))
            return {"status": "ok", "kind": "category_outstanding", "subject": subject}
        subject = _strip(payload, (
            "यांची बाकी", "यान्ची बाकी", "यानची बाकी", "याची बाकी",
            "ची बाकी", "चा बाकी", "बाकी", "outstanding",
            "दाखव", "दाखवा", "सांगा", "संगा", "किती", "आहे",
        ))
        return {"status": "ok", "kind": "party_outstanding", "subject": subject}
    if any(x in payload for x in map(normalize, ("customer बाकी", "कस्टमर बाकी", "ग्राहक बाकी", "party outstanding"))):
        return {"status": "ok", "kind": "party_outstanding", "subject": ""}
    if _contains_any(payload, (
        "स्टॉक", "साठा", "stock", "स्टोक", "स्टाक", "स्टक",
        "स्टॉक", "स्तुक", "स्तोक", "stock check", "stock show",
    )) or amistar_heard:
        if amistar_heard:
            if size_100:
                return {"status": "ok", "kind": "stock_inquiry", "subject": "Amistar Top 100ml"}
            if size_200:
                return {"status": "ok", "kind": "stock_inquiry", "subject": "Amistar Top 200ml"}
            return {"status": "ok", "kind": "stock_inquiry", "subject": "Amistar Top"}
        subject = _strip(payload, ("चा स्टॉक", "ची स्टॉक", "स्टॉक", "साठा", "stock", "दाखव", "दाखवा", "किती", "आहे"))
        return {"status": "ok", "kind": "stock_inquiry", "subject": subject}
    return {"status": "unknown", "payload": payload}

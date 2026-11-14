import re
import unicodedata
import logging
import json
from pathlib import Path
from datetime import datetime
from difflib import SequenceMatcher
from typing import Optional, List, Dict, Any, Tuple

try:
    from indic_transliteration import sanscript
    from indic_transliteration.sanscript import transliterate
    HAS_INDIC = True
except ImportError:
    HAS_INDIC = False
    sanscript = None
    transliterate = None


ALIASES = {
    "amistar top": ["amistar", "amistar top", "अमिस्टार", "अमिस्टार टॉप",
                     "अमी स्टार", "अमी स्टोर", "अमीस्टार", "अविस्कर",
                     "आविस्कर", "अमिस्कर", "अमिस्टर",
                     "अमिस्तार टाप", "अमिस्तार टॉप", "एमिस्टर", "एमिस्टर",
                     "amister", "amistaar", "i m mr top", "im mr top", "mr top",
                     "अंनी सार तोप", "अनी सार तोप", "अन्नी सार टॉप", "अनी स्टार टॉप"],
    "urea 45kg": ["युरिया", "yuriya", "uriya", "yuria", "uria",
                   "urea", "yuriy", "यूरिया"],
    "dap": ["डीएपी", "डी.ए.पी", "dap"],
    "potash": ["पोटॅश", "पोटाश", "mop"],
    "suphala": ["सुफला", "sufala"],
    "ssp": ["एसएसपी", "सिंगल", "ssp"],
    "seed": ["बियाणे", "biyane", "बी", "seed"],
}


def expand_with_aliases(name: str) -> set:
    normalized = normalize(name)
    result = {normalized}
    for canonical, alias_list in ALIASES.items():
        if normalized == normalize(canonical) or normalized in [normalize(a) for a in alias_list]:
            result.add(normalize(canonical))
            for alias in alias_list:
                result.add(normalize(alias))
    return result


def ensure_utf8_streams() -> None:
    """Windows background launchers can hand us a cp1252 console; printing Marathi would then crash the session."""
    import sys
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def setup_logging(log_dir: Path) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=log_dir / "voice_billing.log",
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        encoding="utf-8",
    )
    console = logging.StreamHandler()
    console.setLevel(logging.INFO)
    console.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
    logging.getLogger().addHandler(console)


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return " ".join(re.findall(r"[\w\u0900-\u097f.]+", value))


def variants(name: str) -> set:
    parts = normalize(name).split()
    if not parts:
        return {""}
    result = {" ".join(parts)}
    if len(parts) >= 2:
        result.add(" ".join(reversed(parts)))
        result.add(" ".join(parts[-1:] + parts[:-1]))
    if HAS_INDIC and any("\u0900" <= ch <= "\u097f" for ch in str(name)):
        latin = normalize(transliterate(str(name), sanscript.DEVANAGARI, sanscript.ITRANS))
        latin_parts = latin.split()
        if latin:
            result.add(latin)
        if len(latin_parts) >= 2:
            result.add(" ".join(reversed(latin_parts)))
            result.add(" ".join(latin_parts[-1:] + latin_parts[:-1]))
    result.update(expand_with_aliases(name))
    return result


_DEV_VOWEL_SIGNS = {
    "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "े": "e", "ै": "e", "ो": "o", "ौ": "o",
    "ॉ": "o", "ॅ": "a", "ृ": "r", "ं": "n", "ँ": "n", "ः": "h", "्": "",
}
_DEV_LETTERS = {
    "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ए": "e", "ऐ": "e", "ओ": "o", "औ": "o",
    "ऑ": "o", "ऍ": "a", "ॲ": "a", "ऋ": "r",
    "क": "k", "ख": "k", "ग": "g", "घ": "g", "ङ": "n", "च": "ch", "छ": "ch", "ज": "j", "झ": "j", "ञ": "n",
    "ट": "t", "ठ": "t", "ड": "d", "ढ": "d", "ण": "n", "त": "t", "थ": "t", "द": "d", "ध": "d", "न": "n",
    "प": "p", "फ": "f", "ब": "b", "भ": "b", "म": "m", "य": "y", "र": "r", "ल": "l", "ळ": "l", "व": "v",
    "श": "s", "ष": "s", "स": "s", "ह": "h",
}


def phonetic_key(value: str) -> str:
    """Rough consonant skeleton of how a name SOUNDS, so Marathi speech ("कॅश", "युरिया चंबळ") can be matched
    to the English spelling in Tally ("Cash", "Urea Chambal"). Vowels are dropped on purpose: Devanagari and
    English disagree about them far more than about consonants."""
    out = []
    for ch in unicodedata.normalize("NFC", str(value or "")):
        if ch in _DEV_VOWEL_SIGNS:
            out.append(_DEV_VOWEL_SIGNS[ch])
        elif ch in _DEV_LETTERS:
            out.append(_DEV_LETTERS[ch])
        elif "\u0900" <= ch <= "\u097f":
            continue
        else:
            out.append(ch.lower())
    text = "".join(out)
    text = re.sub(r"[^a-z]", "", text)
    for old, new in (("ph", "f"), ("ck", "k"), ("sh", "s"), ("ch", "C"), ("x", "ks"), ("q", "k"), ("z", "j"), ("w", "v")):
        text = text.replace(old, new)
    text = re.sub(r"c(?=[eiy])", "s", text)  # soft c
    text = text.replace("c", "k")
    text = text.replace("C", "c")
    text = text.replace("h", "").replace("m", "n")
    text = re.sub(r"[aeiouy]", "", text)
    return re.sub(r"(.)\1+", r"\1", text)


def match_name(query: str, names: List[str], threshold: float = 0.74, ambiguity_gap: float = 0.05) -> Dict[str, Any]:
    qvars = variants(query)
    query_parts = normalize(query).split()
    is_single_word = len(query_parts) == 1
    
    scored = []
    for name in names:
        name_vars = variants(name)
        name_parts = normalize(name).split()
        
        # Full variant matching
        score = max(SequenceMatcher(None, q, c).ratio() for q in qvars for c in name_vars)
        
        # Sound-alike matching (Devanagari speech vs English names in Tally), slightly discounted.
        qkey, nkey = phonetic_key(query), phonetic_key(name)
        if len(qkey) >= 2 and len(nkey) >= 2:
            sound = SequenceMatcher(None, qkey, nkey).ratio()
            if sound >= 0.9:  # near-identical sound only: one missing consonant in a short name is a different name
                score = max(score, 0.95 * sound)

        # Partial matching: if query is single word, check against each word of the name
        if is_single_word and len(name_parts) > 1:
            for q in qvars:
                for part in name_parts:
                    part_score = SequenceMatcher(None, q, part).ratio()
                    if part_score > score:
                        score = part_score
        
        if score >= threshold:
            scored.append({"name": str(name), "score": round(score, 3)})
    
    scored.sort(key=lambda x: (-x["score"], normalize(x["name"])))
    if not scored:
        return {"status": "not_found", "matches": []}
    close = [x for x in scored if scored[0]["score"] - x["score"] <= ambiguity_gap]
    normalized = {}
    for item in close:
        normalized.setdefault(normalize(item["name"]), []).append(item)
    if len(close) > 1:
        return {"status": "ambiguous", "matches": close}
    return {"status": "matched", **scored[0]}


_NUM_WORDS = {
    # Marathi
    "शून्य": 0, "एक": 1, "दोन": 2, "तीन": 3, "चार": 4, "पाच": 5, "सहा": 6, "सात": 7, "आठ": 8, "नऊ": 9,
    "दहा": 10, "अकरा": 11, "बारा": 12, "तेरा": 13, "चौदा": 14, "पंधरा": 15, "सोळा": 16, "सत्रा": 17,
    "अठरा": 18, "एकोणीस": 19, "वीस": 20, "एकवीस": 21, "बावीस": 22, "तेवीस": 23, "चोवीस": 24, "पंचवीस": 25,
    "तीस": 30, "चाळीस": 40, "पन्नास": 50, "साठ": 60, "सत्तर": 70, "ऐंशी": 80, "नव्वद": 90,
    "शंभर": 100, "दोनशे": 200, "तीनशे": 300, "चारशे": 400, "पाचशे": 500, "सहाशे": 600, "सातशे": 700,
    "आठशे": 800, "नऊशे": 900, "हजार": 1000,
    # Hindi
    "दो": 2, "पांच": 5, "पाँच": 5, "छह": 6, "छः": 6, "नौ": 9, "दस": 10, "बारह": 12, "बीस": 20, "पचास": 50,
    "सौ": 100, "सो": 100, "दोसौ": 200, "तीनसौ": 300, "चारसौ": 400, "पांचसौ": 500, "हज़ार": 1000,
    "एकोवीस": 21, "सव्वीस": 26, "सत्तावीस": 27, "अठ्ठावीस": 28, "एकोणतीस": 29, "एकतीस": 31, "बत्तीस": 32,
    "तेहेतीस": 33, "चौतीस": 34, "पैंतीस": 35, "सहत्तीस": 36, "सदतीस": 37, "अडतीस": 38, "एकोणचाळीस": 39,
    "इक्कीस": 21, "बाईस": 22, "तेईस": 23, "चौबीस": 24, "पच्चीस": 25, "छब्बीस": 26, "सत्ताईस": 27, "अट्ठाईस": 28,
    "उनतीस": 29, "इकतीस": 31, "तेंतीस": 33, "चौंतीस": 34, "छत्तीस": 36, "सैंतीस": 37, "अड़तीस": 38,
    "उनतालीस": 39, "चालीस": 40, "अस्सी": 80, "नब्बे": 90, "तेरह": 13, "चौदह": 14, "पंद्रह": 15, "सोलह": 16,
    "सत्रह": 17, "अठारह": 18, "उन्नीस": 19,
    # English
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30,
    "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90, "hundred": 100,
    "thousand": 1000,
}
_HUNDRED_SUFFIXES = {"शे", "शेकडा"}


def extract_number(text: str) -> Optional[float]:
    """First number in the speech: digits ("2.5", "300रुपये") or number words ("तीनशे पन्नास" = 350)."""
    tokens = [t.strip(".") for t in normalize(text).split()]
    run: List[float] = []
    for tok in tokens:
        if re.fullmatch(r"\d+(?:\.\d+)?", tok):
            if run:
                break
            return float(tok)
        lead = re.match(r"^(\d+(?:\.\d+)?)", tok)
        if lead and not run:
            return float(lead.group(1))
        if tok in _NUM_WORDS:
            run.append(float(_NUM_WORDS[tok]))
        elif tok in _HUNDRED_SUFFIXES and run:
            run[-1] *= 100  # "तीन शे" spoken as two words
        elif run:
            break
    return sum(run) if run else None


_CONFIRM_TOKENS = {
    "हो", "होय", "बरोबर", "ठीक", "सही", "हां", "हाँ", "हा", "yes", "ok", "okay", "confirm", "haan",
}
_REJECT_TOKENS = {
    "नाही", "नको", "रद्द", "कॅन्सल", "कैन्सल", "cancel", "no", "नहीं", "गलत", "चुकीचे", "बदला", "change", "नवीन", "पुन्हा",
}


def _tokens(text: str) -> List[str]:
    return [t.strip(".") for t in normalize(text).split()]


def is_confirmation(text: str) -> bool:
    """Whole-word match, and any rejection word wins ("बरोबर नाही" is NOT a yes)."""
    tokens = set(_tokens(text))
    return bool(tokens & _CONFIRM_TOKENS) and not tokens & _REJECT_TOKENS


def is_rejection(text: str) -> bool:
    return bool(set(_tokens(text)) & _REJECT_TOKENS)


def is_finalize(text: str) -> bool:
    clean = normalize(text)
    finalize_words = {
        "बिल बनव", "बिल सेव्ह", "बिल सेव्ह करा", "फायनल", "finalize",
        "create bill", "save bill", "बिल तयार", "बिल करा", "समाप्त"
    }
    return any(word in clean for word in finalize_words)


def is_cancel_session(text: str) -> bool:
    clean = normalize(text)
    cancel_words = {
        "रद्द", "बंद करा", "बाहेर पडा", "एग्जिट", "exit", "quit", "कॅन्सल",
        "cancel session", "सत्र रद्द", "बिल रद्द"
    }
    return any(word in clean for word in cancel_words)


def parse_quantity_and_item(text: str) -> Tuple[Optional[str], Optional[float]]:
    clean = normalize(text)
    marathi_digits = {
        "शून्य": 0, "एक": 1, "दोन": 2, "तीन": 3, "चार": 4,
        "पाच": 5, "सहा": 6, "सात": 7, "आठ": 8, "नऊ": 9,
        "दहा": 10, "बारा": 12, "तेरा": 13, "चौदा": 14, "पंधरा": 15,
        "सोळा": 16, "सत्रा": 17, "अठरा": 18, "एकोणीस": 19, "वीस": 20,
        "एकोवीस": 21, "बावीस": 22, "तेवीस": 23, "चोवीस": 24, "पंचवीस": 25,
        "सव्वीस": 26, "सत्तावीस": 27, "अठ्ठावीस": 28, "एकोणतीस": 29, "तीस": 30,
        "एकतीस": 31, "बत्तीस": 32, "तेहेतीस": 33, "चौतीस": 34, "पैंतीस": 35,
        "सहत्तीस": 36, "सदतीस": 37, "अडतीस": 38, "एकोणचाळीस": 39, "चाळीस": 40,
        "पचास": 50, "साठ": 60, "सत्तर": 70, "अशी": 80, "नव्वद": 90, "शंभर": 100
    }
    hindi_digits = {
        "शून्य": 0, "एक": 1, "दो": 2, "तीन": 3, "चार": 4,
        "पांच": 5, "छह": 6, "सात": 7, "आठ": 8, "नौ": 9,
        "दस": 10, "बारह": 12, "तेरह": 13, "चौदह": 14, "पंद्रह": 15,
        "सोलह": 16, "सत्रह": 17, "अठारह": 18, "उन्नीस": 19, "बीस": 20,
        "इक्कीस": 21, "बाईस": 22, "तेईस": 23, "चौबीस": 24, "पच्चीस": 25,
        "छब्बीस": 26, "सत्ताईस": 27, "अट्ठाईस": 28, "उनतीस": 29, "तीस": 30,
        "इकतीस": 31, "बत्तीस": 32, "तेंतीस": 33, "चौंतीस": 34, "पैंतीस": 35,
        "छत्तीस": 36, "सैंतीस": 37, "अड़तीस": 38, "उनतालीस": 39, "चालीस": 40,
        "पचास": 50, "साठ": 60, "सत्तर": 70, "अस्सी": 80, "नब्बे": 90, "सौ": 100
    }
    english_digits = {
        "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4,
        "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
        "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
        "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
        "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30,
        "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
        "eighty": 80, "ninety": 90, "hundred": 100,
    }

    qty_words = ["नग", "qty", "quantity", "प्रमाण"]
    all_digits = {**marathi_digits, **hindi_digits, **english_digits}

    found_qty = None
    found_qty_word = None
    for word, value in all_digits.items():
        if word in clean:
            for qword in qty_words:
                if qword in clean:
                    idx_word = clean.find(word)
                    idx_qty = clean.find(qword)
                    if abs(idx_word - idx_qty) < 15:
                        found_qty = float(value)
                        found_qty_word = word
                        break
            if found_qty is None:
                if word == clean.strip() or clean.startswith(word + " ") or clean.endswith(" " + word):
                    found_qty = float(value)
                    found_qty_word = word
            if found_qty is not None:
                break

    if found_qty is None:
        match = re.search(r"\b(\d+(?:\.\d+)?)\s*(?:नग|qty|quantity|प्रमाण)\b", clean)
        if match:
            found_qty = float(match.group(1))

    item_name = text
    if found_qty is not None and found_qty_word:
        item_name = re.sub(rf"\b{re.escape(found_qty_word)}\b", "", text, flags=re.IGNORECASE).strip()
        item_name = re.sub(r"\b(नग|qty|quantity|प्रमाण)\b", "", item_name, flags=re.IGNORECASE).strip()
        item_name = re.sub(r"\b(\d+(?:\.\d+)?)\s*(?:किलो|kg|किलोग्राम|लिटर|litre|liter|लीटर)\b", "", item_name, flags=re.IGNORECASE).strip()
    elif found_qty is not None:
        num_str = str(int(found_qty)) if found_qty == int(found_qty) else str(found_qty)
        item_name = re.sub(rf"\b{re.escape(num_str)}\b", "", text).strip()
        item_name = re.sub(r"\b(नग|qty|quantity|प्रमाण)\b", "", item_name, flags=re.IGNORECASE).strip()
        item_name = re.sub(r"\b(\d+(?:\.\d+)?)\s*(?:किलो|kg|किलोग्राम|लिटर|litre|liter|लीटर)\b", "", item_name, flags=re.IGNORECASE).strip()
    return item_name.strip() if item_name.strip() else None, found_qty


def format_currency(amount: float) -> str:
    return f"{amount:,.2f}"


def save_draft(log_dir: Path, draft: Dict[str, Any]) -> Dict[str, Any]:
    folder = Path(log_dir)
    folder.mkdir(parents=True, exist_ok=True)
    record = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "status": "DRAFT_ONLY_MANUAL_SAVE_REQUIRED",
        "tally_write_performed": False,
        "voucher_saved": False,
        **draft,
    }
    with (folder / "bill_drafts.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


class ReadOnlyGuard:
    FORBIDDEN = re.compile(
        r"\b(insert|update|delete|merge|replace|alter|drop|create|truncate|grant|revoke|call|exec(?:ute)?|import|backup|restore)\b",
        re.IGNORECASE,
    )

    @classmethod
    def assert_read_only_sql(cls, sql: str) -> str:
        clean = (sql or "").strip()
        if not re.match(r"^(select|with)\b", clean, re.IGNORECASE):
            raise ValueError("फक्त SELECT/WITH query परवानगी आहे.")
        if ";" in clean.rstrip(";") or cls.FORBIDDEN.search(clean):
            raise ValueError("असुरक्षित किंवा multi-statement query नाकारली.")
        return clean.rstrip(";")
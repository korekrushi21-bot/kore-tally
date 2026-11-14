import re
import unicodedata
from difflib import SequenceMatcher

try:
    from indic_transliteration import sanscript
    from indic_transliteration.sanscript import transliterate
except ImportError:
    sanscript = None
    transliterate = None


def normalize(value):
    value = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return " ".join(re.findall(r"[\w\u0900-\u097f]+", value))


def variants(name):
    parts = normalize(name).split()
    if not parts:
        return {""}
    result = {" ".join(parts)}
    if len(parts) >= 2:
        result.add(" ".join(reversed(parts)))
        result.add(" ".join(parts[-1:] + parts[:-1]))
    if transliterate and any("\u0900" <= ch <= "\u097f" for ch in str(name)):
        latin = normalize(transliterate(str(name), sanscript.DEVANAGARI, sanscript.ITRANS))
        latin_parts = latin.split()
        if latin:
            result.add(latin)
        if len(latin_parts) >= 2:
            result.add(" ".join(reversed(latin_parts)))
            result.add(" ".join(latin_parts[-1:] + latin_parts[:-1]))
    return result


def match_name(query, names, threshold=0.74, ambiguity_gap=0.05):
    qvars = variants(query)
    scored = []
    for name in names:
        score = max(SequenceMatcher(None, q, c).ratio() for q in qvars for c in variants(name))
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

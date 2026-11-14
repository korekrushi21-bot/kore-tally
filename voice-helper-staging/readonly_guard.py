import re


class UnsafeQueryError(RuntimeError):
    pass


_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|merge|replace|alter|drop|create|truncate|grant|revoke|call|exec(?:ute)?|import|backup|restore)\b",
    re.IGNORECASE,
)


def assert_read_only_sql(sql: str) -> str:
    clean = (sql or "").strip()
    if not re.match(r"^(select|with)\b", clean, re.IGNORECASE):
        raise UnsafeQueryError("फक्त SELECT/WITH query परवानगी आहे.")
    if ";" in clean.rstrip(";") or _FORBIDDEN.search(clean):
        raise UnsafeQueryError("असुरक्षित किंवा multi-statement query नाकारली.")
    return clean.rstrip(";")

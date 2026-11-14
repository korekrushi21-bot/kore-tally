import json
import os
import subprocess
import winreg
from pathlib import Path

import httpx


ALLOWED_KINDS = {
    "today_sales",
    "today_purchases",
    "party_outstanding",
    "stock_inquiry",
    "category_outstanding",
    "sales_bill_draft",
    "purchase_bill_draft",
}


def _api_key():
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if key:
        return key
    # Auto helper may already be running when the user creates the key. Read the
    # per-user Windows setting without copying it into config or log files.
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as handle:
            value, _ = winreg.QueryValueEx(handle, "OPENAI_API_KEY")
            return str(value).strip()
    except OSError:
        pass
    encrypted = Path(__file__).resolve().parent / "secrets" / "openai_key.dpapi"
    if not encrypted.is_file():
        return ""
    script = (
        "Add-Type -AssemblyName System.Security; "
        "$b=[Convert]::FromBase64String((Get-Content -LiteralPath '"
        + str(encrypted).replace("'", "''")
        + "' -Raw)); $p=[Security.Cryptography.ProtectedData]::Unprotect("
        "$b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); "
        "try{[Text.Encoding]::UTF8.GetString($p)}finally{[Array]::Clear($p,0,$p.Length)}"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", script],
            capture_output=True, text=True, timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _validated(value):
    if not isinstance(value, dict) or value.get("status") != "ok":
        return {"status": "unknown", "reason": "model_rejected"}
    kind = value.get("kind")
    if kind not in ALLOWED_KINDS:
        return {"status": "unknown", "reason": "kind_not_allowed"}

    result = {"status": "ok", "kind": kind}
    if kind in {"party_outstanding", "stock_inquiry", "category_outstanding"}:
        subject = str(value.get("subject", "")).strip()[:160]
        if not subject:
            return {"status": "unknown", "reason": "subject_missing"}
        result["subject"] = subject
    elif kind in {"sales_bill_draft", "purchase_bill_draft"}:
        result.update({
            "party": str(value.get("party", "")).strip()[:160],
            "item": str(value.get("item", "")).strip()[:160],
            "quantity": None,
            "rate": None,
            "spoken_text": str(value.get("spoken_text", ""))[:500],
        })
        for field in ("quantity", "rate"):
            raw = value.get(field)
            if raw is not None:
                try:
                    number = float(raw)
                    if 0 < number <= 10000000:
                        result[field] = number
                except (TypeError, ValueError):
                    pass
    return result


def understand_command(spoken_text, config):
    settings = config.get("openai", {})
    if not settings.get("enabled", False):
        return {"status": "unknown", "reason": "disabled"}
    key = _api_key()
    if not key:
        return {"status": "unknown", "reason": "key_missing"}

    system = (
        "You convert one Marathi/English Tally voice command to strict JSON. "
        "Never execute anything. Allowed kind values only: today_sales, "
        "today_purchases, party_outstanding, stock_inquiry, category_outstanding, "
        "sales_bill_draft, purchase_bill_draft. Final save, delete, alter, create "
        "master, GST change, backup change, reminder sending, and every unsupported "
        "request must return {\"status\":\"unknown\"}. For inquiries include subject. "
        "For bill drafts include party, item, quantity, rate; use null when missing. "
        "Output one JSON object only, without markdown."
    )
    payload = {
        "model": settings.get("model", "gpt-4.1-mini"),
        "input": [
            {"role": "system", "content": system},
            {"role": "user", "content": str(spoken_text)[:500]},
        ],
        "temperature": 0,
        "max_output_tokens": 220,
    }
    with httpx.Client(timeout=float(settings.get("timeout_seconds", 15))) as client:
        response = client.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {key}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()

    text = data.get("output_text", "")
    if not text:
        chunks = []
        for item in data.get("output", []):
            for content in item.get("content", []):
                if content.get("type") == "output_text":
                    chunks.append(content.get("text", ""))
        text = "".join(chunks)
    try:
        parsed = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return {"status": "unknown", "reason": "invalid_json"}
    if isinstance(parsed, dict) and parsed.get("kind") in {"sales_bill_draft", "purchase_bill_draft"}:
        parsed["spoken_text"] = spoken_text
    return _validated(parsed)

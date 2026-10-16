"""One engine for Sales / Purchase / Credit Note / Debit Note, shared by the voice assistant and by Jarvis.

Flow: draft() resolves names and rates against Tally (read-only) and returns a read-back; confirm() posts that
exact draft to Tally as ONE new voucher. A draft is single-use and expires, so a repeated "yes" can never post
the same bill twice. Nothing is posted unless the caller explicitly calls confirm().
"""
import json
import logging
import math
import re
import secrets
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from batch_stock import BatchError, allocate, check_total, compute_batch_balances
from utils import match_name
from voucher_types import VOUCHER_SPECS, VoucherSpec, get_spec
from voucher_xml import assert_create_only, build_import_xml, parse_import_response

MAX_LINE_AMOUNT = 10_000_000.0
RATE_DEVIATION_WARN = 0.5  # warn when a spoken rate is >50% away from the last rate


class VoucherError(Exception):
    """A problem the speaker can fix. `code` is stable for programs, `message` is Marathi for the user."""

    def __init__(self, code: str, message: str, candidates: Optional[List[str]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.candidates = candidates or []

    def to_dict(self) -> Dict[str, Any]:
        out = {"ok": False, "error_code": self.code, "message": self.message}
        if self.candidates:
            out["candidates"] = self.candidates
        return out


def _inr(value: float) -> str:
    return f"{value:,.2f}"


class VoucherService:
    def __init__(self, tally, config: dict, log_dir: str):
        self.tally = tally
        self.config = config
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        matching = config.get("matching", {})
        self.threshold = matching.get("threshold", 0.74)
        self.gap = matching.get("ambiguity_gap", 0.05)
        self.draft_ttl = float(config.get("billing", {}).get("draft_ttl_seconds", 600))
        self.lookback = int(config.get("purchase_lookup", {}).get("lookback_days", 730))
        self._drafts: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    # ---------- settings ----------

    def _type_settings(self, key: str) -> Dict[str, Any]:
        return self.config.get("voucher_types", {}).get(key, {})

    def writes_allowed(self, key: str) -> bool:
        return bool(self.config.get("writes_enabled")) and bool(self._type_settings(key).get("enabled", False))

    def _gst_settings(self) -> Dict[str, Any]:
        return self.config.get("gst", {})

    # ---------- name resolution ----------

    def _resolve(self, label_mr: str, spoken: str, names: List[str]) -> str:
        if not str(spoken or "").strip():
            raise VoucherError("missing_name", f"{label_mr} सांगितले नाही.")
        exact = [n for n in names if n.lower() == str(spoken).strip().lower()]
        if len(exact) == 1:
            return exact[0]
        result = match_name(str(spoken), names, self.threshold, self.gap)
        if result["status"] == "not_found":
            raise VoucherError("not_found", f"{label_mr} '{spoken}' जुळले नाही. पूर्ण नाव पुन्हा सांगा.")
        if result["status"] == "ambiguous":
            choices = [m["name"] for m in result["matches"][:5]]
            raise VoucherError("ambiguous", f"{label_mr}साठी एकापेक्षा जास्त नावे आहेत: {', '.join(choices)}. पूर्ण नाव सांगा.", choices)
        return result["name"]

    def resolve_party(self, spec: VoucherSpec, spoken: str) -> str:
        names = [l.name for l in self.tally.get_ledgers_under(spec.party_group)]
        if not names:
            raise VoucherError("no_party_group", f"Tally मध्ये '{spec.party_group}' खाली कोणतेही खाते सापडले नाही.")
        for extra in spec.party_extra_groups:  # "रोख" (Cash) is a valid party for cash bills
            names += [l.name for l in self.tally.get_ledgers_under(extra) if l.name not in names]
        return self._resolve(spec.party_label_mr, spoken, names)

    def resolve_item(self, spoken: str) -> Any:
        """The Tally stock item (name, unit...) that best matches the spoken name."""
        items = {s.name: s for s in self.tally.get_stock_items()}
        return items[self._resolve("माल", spoken, list(items))]

    def _group_chain(self, group: str) -> List[str]:
        """The stock group and its parents, nearest first (e.g. Meliorate Organics -> FERTILIZERS)."""
        known = {k.lower(): v for k, v in self.tally.get_stock_groups().items()}
        chain: List[str] = []
        current = (group or "").strip()
        while current and current.lower() not in {c.lower() for c in chain}:
            chain.append(current)
            current = known.get(current.lower(), ("", None))[0]
        return chain

    def resolve_line_ledger(self, spec: VoucherSpec, stock_item: Any) -> str:
        """The sales / purchase ledger this item posts to, validated against Tally."""
        settings = self._type_settings(spec.key)
        names = [l.name for l in self.tally.get_ledgers_under(spec.ledger_group)]
        by_group = {k.lower(): v for k, v in (settings.get("item_ledger_by_group") or {}).items()}
        if by_group:
            # Items are sometimes filed under a different stock group than their sales ledger (e.g. a fertiliser inside
            # SEEDS), so the ledger the owner really used for THIS item last time beats the group rule.
            used = self.tally.get_last_item_ledger(stock_item.name, "Sales", self.lookback)
            hit = next((n for n in names if used and n.lower() == used.lower()), None)
            if hit:
                return hit
        configured = ""
        for group in self._group_chain(stock_item.group):
            if group.lower() in by_group:
                configured = by_group[group.lower()]
                break
        configured = configured or by_group.get("*", "") or settings.get("item_ledger") or ""
        if configured:
            hit = next((n for n in names if n.lower() == configured.lower()), None)
            if hit:
                return hit
            raise VoucherError("ledger_missing", f"Tally मध्ये '{configured}' खाते '{spec.ledger_group}' खाली सापडले नाही. config.json तपासा.", names[:8])
        if len(names) == 1:
            return names[0]
        raise VoucherError("ledger_choice", f"'{stock_item.name}' साठी कोणते खाते वापरायचे ते config.json (voucher_types.{spec.key}.item_ledger_by_group) मध्ये ठरवा.", names[:8])

    def _existing_ledger(self, name: str) -> str:
        for l in self.tally.get_ledgers():
            if l.name.lower() == name.lower():
                return l.name
        raise VoucherError("ledger_missing", f"Tally मध्ये '{name}' खाते सापडले नाही. config.json तपासा.")

    # ---------- batches ----------

    BATCH_VOUCHER_TYPES = ["Sales", "Purchase", "Credit Note", "Debit Note", "Receipt Note", "Delivery Note", "Stock Journal"]

    def _batch_balances(self, item: Any):
        """Current stock per batch of one item, rebuilt from Tally's own data and checked against its closing balance.
        Starts with this financial year; if the totals do not match it looks one year further back (the master batch
        openings are as of the books' beginning), up to `batch.max_years_back` years. Never guesses."""
        cfg = self.config.get("batch", {}) or {}
        types = cfg.get("voucher_types") or self.BATCH_VOUCHER_TYPES
        max_back = int(cfg.get("max_years_back", 2))
        today = date.today()
        fy_year = today.year if today.month >= 4 else today.year - 1
        openings = self.tally.get_batch_openings(item.name)
        moves: List[Dict[str, Any]] = []
        last_error: Optional[BatchError] = None
        for k in range(max_back + 1):
            start = date(fy_year - k, 4, 1)
            end = today if k == 0 else date(fy_year - k + 1, 3, 31)
            for t in types:
                moves += [m for m in self.tally.get_stock_movements(t, start, end) if m["item"].lower() == item.name.lower()]
            balances = compute_batch_balances(openings, moves, start)
            try:
                check_total(balances, item.closing_qty, item.name)
                return balances
            except BatchError as err:
                last_error = err
        raise last_error  # type: ignore[misc]

    def _pick_batches(self, spec: VoucherSpec, item: Any, qty: float, wanted: Optional[str], on: date, warnings: List[str]) -> List[Dict[str, Any]]:
        """Batches for one bill line of a batch-wise item."""
        if spec.stock_in:   # purchase / sales return: stock comes IN, so the owner has to give the batch (and expiry)
            if not wanted:
                raise VoucherError("batch_required", f"'{item.name}' ला batch लागतो; {spec.label_mr} साठी batch क्रमांक सांगा.")
            return [{"batch": str(wanted).strip(), "godown": "", "quantity": qty, "expiry": ""}]
        try:
            picks = allocate(self._batch_balances(item), qty, on, wanted, item.name)
        except BatchError as err:
            raise VoucherError(err.code, err.message) from None
        for p in picks:
            if p.get("expiry"):
                days = (date.fromisoformat(p["expiry"]) - on).days
                if days <= 60:
                    warnings.append(f"{item.name}: batch {p['batch']} {days} दिवसांत expire होतो ({p['expiry']}).")
        return picks

    # ---------- GST ----------

    def _tax_ledger(self, spec: VoucherSpec, head: str, half_rate: float) -> str:
        """Name of the CGST / SGST / IGST ledger to use for this voucher side."""
        configured = (self._gst_settings().get("ledgers", {}).get(spec.gst_side, {}) or {}).get(head, "")
        candidates = [l.name for l in self.tally.get_ledgers_under("Duties & Taxes") if head.upper() in l.name.upper()]
        if configured:
            hit = next((n for n in candidates if n.lower() == configured.lower()), None)
            if hit:
                return hit
            raise VoucherError("tax_ledger_missing", f"Tally मध्ये '{configured}' कर-खाते सापडले नाही. config.json तपासा.", candidates[:8])
        side_word = "output" if spec.gst_side == "output" else "input"
        narrowed = [n for n in candidates if side_word in n.lower()] or candidates
        if len(narrowed) > 1:
            by_rate = [n for n in narrowed if re.search(rf"(?<![\d.]){re.escape(f'{half_rate:g}')}(?![\d.])", n)]
            narrowed = by_rate or narrowed
        if len(narrowed) == 1:
            return narrowed[0]
        raise VoucherError("tax_ledger_choice", f"{head} चे कर-खाते निश्चित करता आले नाही; config.json (gst.ledgers.{spec.gst_side}.{head}) मध्ये ठरवा.", narrowed[:8])

    def item_gst_percent(self, name: str, spoken: Optional[float], spec: VoucherSpec, party: str) -> float:
        if spoken is not None:
            return float(spoken)
        master = self.tally.get_item_gst_percent().get(name)
        if master is not None:
            return float(master)
        item = next((i for i in self.tally.get_stock_items() if i.name == name), None)
        chain = self._group_chain(item.group) if item else []
        groups = {k.lower(): v for k, v in self.tally.get_stock_groups().items()}
        for group in chain:  # items inherit GST from their stock group
            inherited = groups.get(group.lower(), ("", None))[1]
            if inherited is not None:
                return float(inherited)
        defaults = {k.lower(): v for k, v in (self._gst_settings().get("default_by_group") or {}).items()}
        for group in chain:
            if group.lower() in defaults:
                return float(defaults[group.lower()])
        last = self.tally.get_last_purchase_info(name, self.lookback) if spec.rate_source == "purchase" else None
        if last is not None and last.gst_percent is not None:
            return float(last.gst_percent)
        raise VoucherError("gst_unknown", f"'{name}' चा GST % Tally मध्ये सापडला नाही. GST टक्के सांगा (नसेल तर 0).")

    def _compute_taxes(self, spec: VoucherSpec, party: str, lines: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        gst = self._gst_settings()
        if not gst.get("enabled", False):
            return []
        company_state = (gst.get("company_state") or "").strip().lower()
        party_state = (self.tally.get_ledger_states().get(party) or "").strip().lower()
        interstate = bool(company_state and party_state and company_state != party_state)

        by_rate: Dict[float, float] = {}
        for ln in lines:
            by_rate[ln["gst_percent"]] = by_rate.get(ln["gst_percent"], 0.0) + ln["amount"]

        taxes: List[Dict[str, Any]] = []
        for rate, taxable in sorted(by_rate.items()):
            if rate <= 0:
                continue
            if interstate:
                taxes.append({"head": "IGST", "rate": rate, "ledger": self._tax_ledger(spec, "IGST", rate), "amount": round(taxable * rate / 100, 2)})
            else:
                half = rate / 2
                part = round(taxable * half / 100, 2)
                taxes.append({"head": "CGST", "rate": half, "ledger": self._tax_ledger(spec, "CGST", half), "amount": part})
                taxes.append({"head": "SGST", "rate": half, "ledger": self._tax_ledger(spec, "SGST", half), "amount": part})
        # The owner's vouchers carry ONE line per tax ledger, so slabs (5 % + 18 %) are added into a single CGST / SGST line.
        merged: Dict[str, Dict[str, Any]] = {}
        for tax in taxes:
            if tax["ledger"] in merged:
                merged[tax["ledger"]]["amount"] = round(merged[tax["ledger"]]["amount"] + tax["amount"], 2)
                merged[tax["ledger"]]["rate"] = None
            else:
                merged[tax["ledger"]] = dict(tax)
        return list(merged.values())

    def _gst_header(self, party: str) -> Dict[str, str]:
        """GST header of a voucher (registration, place of supply, party type). A GST-registered company's
        vouchers carry these; without them Tally accepts nothing ("Exceptions: 1" on import)."""
        if not self._gst_settings().get("enabled", False):
            return {}
        company = self.tally.get_company_gst()
        info = self.tally.get_party_gst().get(party, {})
        company_state = company.get("state") or self._gst_settings().get("company_state", "")
        party_state = info.get("state") or company_state
        registered = bool(info.get("gstin"))
        return {
            "registration": company.get("registration", ""), "company_gstin": company.get("gstin", ""),
            "CMPGSTIN": company.get("gstin", ""), "CMPGSTSTATE": company_state,
            "GSTREGISTRATIONTYPE": info.get("type") or ("Regular" if registered else "Unregistered/Consumer"),
            "PARTYGSTIN": info.get("gstin", ""), "PLACEOFSUPPLY": party_state, "STATENAME": party_state,
            "COUNTRYOFRESIDENCE": "India", "CONSIGNEESTATENAME": party_state, "PARTYNAME": party, "BASICBUYERNAME": party,
        }

    # ---------- draft ----------

    def draft(self, voucher_type: str, party: str, items: List[Dict[str, Any]],
              narration: str = "", voucher_date: Optional[str] = None, source: str = "voice",
              rate_includes_gst: Optional[bool] = None) -> Dict[str, Any]:
        spec = get_spec(voucher_type)
        if not self.writes_allowed(spec.key):
            raise VoucherError("writes_disabled", f"{spec.label_mr} तयार करणे सध्या बंद आहे (config.json मध्ये चालू करा).")
        if not items:
            raise VoucherError("no_items", "बिलामध्ये एकही माल नाही.")
        if len(items) > 30:
            raise VoucherError("too_many_items", "एका बिलात जास्तीत जास्त 30 माल घेता येतात.")

        party_name = self.resolve_party(spec, party)
        v_date = self._parse_date(voucher_date)

        stock = {s.name: s for s in self.tally.get_stock_items()}
        stock_names = list(stock)
        warnings: List[str] = []
        lines: List[Dict[str, Any]] = []
        gst_on = bool(self._gst_settings().get("enabled", False))
        batch_policy = self.config.get("billing", {}).get("batch_policy", "refuse")
        default_incl = bool(self.config.get("billing", {}).get("spoken_rate_includes_gst", False)) if rate_includes_gst is None else bool(rate_includes_gst)

        for raw in items:
            name = self._resolve("माल", raw.get("name", ""), stock_names)
            qty = self._number(raw.get("quantity"), "नग")
            unit = stock[name].unit
            if not unit or "not applicable" in unit.lower():
                raise VoucherError("not_stock_item", f"'{name}' हा मोजला जाणारा माल नाही; हे बिल Tally मध्ये हाताने करा.")
            batches = None
            if stock[name].batch_wise:
                if batch_policy != "auto":
                    raise VoucherError("batch_item", f"'{name}' ला batch लागतो; batch निवडावा लागतो म्हणून हा माल Tally मध्ये हाताने करा.")
                batches = self._pick_batches(spec, stock[name], qty, raw.get("batch"), v_date, warnings)
            line_ledger = self.resolve_line_ledger(spec, stock[name])
            gst_percent = self.item_gst_percent(name, raw.get("gst_percent"), spec, party_name) if gst_on else 0.0

            if raw.get("rate") is not None:
                rate = self._number(raw.get("rate"), "दर")
                if bool(raw.get("rate_includes_gst", default_incl)) and gst_percent:
                    rate = round(rate / (1 + gst_percent / 100), 2)  # Tally stores the rate without GST
                rate_source = "spoken"
                last = self.tally.get_last_rate(name, spec.rate_source, party_name, self.lookback)
                if last and abs(rate - last.rate) / last.rate > RATE_DEVIATION_WARN:
                    warnings.append(f"{name}: सांगितलेला दर {_inr(rate)} हा शेवटच्या दरापेक्षा ({_inr(last.rate)}) खूप वेगळा आहे.")
            else:
                last = self.tally.get_last_rate(name, spec.rate_source, party_name, self.lookback)
                if last is None:
                    raise VoucherError("rate_missing", f"'{name}' चा मागचा दर सापडला नाही. दर सांगा.")
                rate = last.rate
                rate_source = "last_same_party" if last.same_party else "last_any_party"

            amount = round(qty * rate, 2)
            if amount > MAX_LINE_AMOUNT:
                raise VoucherError("amount_too_large", f"{name} ची रक्कम {_inr(amount)} खूप मोठी आहे; नग/दर तपासा.")
            lines.append({"name": name, "unit": unit, "quantity": qty, "rate": rate, "rate_source": rate_source,
                          "amount": amount, "gst_percent": gst_percent, "ledger": line_ledger, "batches": batches})

        taxes = self._compute_taxes(spec, party_name, lines)
        taxable = round(sum(l["amount"] for l in lines), 2)
        tax_total = round(sum(t["amount"] for t in taxes), 2)
        total = round(taxable + tax_total, 2)
        if total <= 0:
            raise VoucherError("zero_total", "बिलाची एकूण रक्कम शून्य आहे.")

        round_off = None
        rounding = self.config.get("rounding", {})
        if rounding.get("enabled"):  # this business rounds every bill to the rupee through the R/o ledger
            ledger = self._existing_ledger(rounding.get("ledger", "R/o"))
            rounded = float(math.floor(total + 0.5))
            diff = round(rounded - total, 2)
            if abs(diff) >= 0.005:
                round_off = {"ledger": ledger, "amount": diff}
                total = rounded

        draft_id = secrets.token_hex(8)
        record = {
            "draft_id": draft_id, "voucher_type": spec.key, "tally_type": spec.tally_type,
            "party": party_name, "date": v_date.strftime("%Y%m%d"), "gst_header": self._gst_header(party_name),
            "narration": narration.strip() or f"Voice billing ({source})",
            "items": lines, "taxes": taxes, "round_off": round_off, "taxable_total": taxable, "tax_total": tax_total,
            "total": total, "warnings": warnings, "status": "drafted", "created_at": time.time(), "source": source,
        }
        with self._lock:
            self._purge()
            self._drafts[draft_id] = record
        self._audit("draft", record)
        return self.public_view(record)

    # ---------- confirm / cancel ----------

    def confirm(self, draft_id: str) -> Dict[str, Any]:
        with self._lock:
            self._purge()
            record = self._drafts.get(draft_id)
            if record is None:
                raise VoucherError("draft_expired", "हा ड्राफ्ट सापडला नाही किंवा वेळ संपली. बिल पुन्हा सांगा. काहीही सेव्ह झालेले नाही.")
            if record["status"] == "saved":
                return {"ok": True, "already_saved": True, "voucher_number": record.get("voucher_number", ""),
                        "say": f"हे बिल आधीच सेव्ह झाले आहे{self._number_phrase(record.get('voucher_number', ''))}."}
            if record["status"] == "posting":
                raise VoucherError("busy", "हे बिल सध्या सेव्ह होत आहे. थोडे थांबा.")
            if record["status"] == "unknown":
                raise VoucherError("outcome_unknown", "या बिलाचा निकाल कळला नाही. आधी Tally मध्ये बिल तयार झाले का ते तपासा; नसेल तर बिल नव्याने सांगा.")
            spec = get_spec(record["voucher_type"])
            if not self.writes_allowed(spec.key):
                raise VoucherError("writes_disabled", f"{spec.label_mr} तयार करणे सध्या बंद आहे.")
            record["status"] = "posting"

        try:
            xml = build_import_xml(self.tally.company, spec, record)
            assert_create_only(xml)
        except Exception as exc:
            with self._lock:
                record["status"] = "drafted"
            self._audit("blocked", record, error=str(exc))
            logging.exception("Voucher XML blocked")
            raise VoucherError("blocked", "सुरक्षा तपासणीत बिल थांबवले. काहीही सेव्ह झालेले नाही.") from exc

        raw_response = ""
        try:
            raw_response = self.tally.post_import(xml)
            result = parse_import_response(raw_response)
        except Exception as exc:
            # The request may have reached Tally before failing, so a retry could create a duplicate.
            with self._lock:
                record["status"] = "unknown"
            self._audit("post_error", record, error=str(exc))
            logging.exception("Voucher post failed")
            raise VoucherError("post_failed", f"Tally शी संपर्क तुटला: {str(exc)[:150]}. बिल तयार झाले का ते Tally मध्ये तपासा; नसेल तर नव्याने सांगा.") from exc

        if not result.success:
            with self._lock:
                record["status"] = "drafted"
            self._audit("rejected", record, error=result.failure_text(), tally_response=raw_response[:2000])
            raise VoucherError("tally_rejected", f"Tally ने बिल सेव्ह केले नाही: {result.failure_text()}")

        number = self.tally.find_voucher_number(spec.tally_type, result.last_vch_id)
        with self._lock:
            record["status"] = "saved"
            record["voucher_number"] = number
        self._audit("saved", record, last_vch_id=result.last_vch_id, voucher_number=number)
        return {"ok": True, "voucher_number": number, "last_vch_id": result.last_vch_id, "total": record["total"],
                "say": f"{spec.label_mr} सेव्ह झाले{self._number_phrase(number)}. {record['party']}, एकूण {_inr(record['total'])} रुपये."}

    def cancel(self, draft_id: str) -> Dict[str, Any]:
        with self._lock:
            record = self._drafts.get(draft_id)
            if record and record["status"] == "drafted":
                del self._drafts[draft_id]
                self._audit("cancelled", record)
        return {"ok": True, "say": "बिल रद्द केले. Tally मध्ये काहीही सेव्ह झालेले नाही."}

    # ---------- presentation ----------

    def public_view(self, record: Dict[str, Any]) -> Dict[str, Any]:
        spec = get_spec(record["voucher_type"])
        return {
            "ok": True, "draft_id": record["draft_id"], "voucher_type": spec.key, "label": spec.label_mr,
            "party": record["party"], "date": record["date"],
            "items": [{**{k: l[k] for k in ("name", "unit", "quantity", "rate", "rate_source", "amount", "gst_percent", "ledger")},
                       "batches": l.get("batches") or []} for l in record["items"]],
            "round_off": record["round_off"]["amount"] if record.get("round_off") else 0.0,
            "taxes": [{"head": t["head"], "rate": t["rate"], "ledger": t["ledger"], "amount": t["amount"]} for t in record["taxes"]],
            "taxable_total": record["taxable_total"], "tax_total": record["tax_total"], "total": record["total"],
            "warnings": record["warnings"], "expires_in_seconds": int(self.draft_ttl),
            "say": self.read_back(record),
        }

    def read_back(self, record: Dict[str, Any]) -> str:
        spec = get_spec(record["voucher_type"])
        def batch_text(l: Dict[str, Any]) -> str:
            if not l.get("batches"):
                return ""
            return " (" + ", ".join(f"batch {b['batch']} {b['quantity']:g}" + (f" expiry {b['expiry']}" if b.get("expiry") else "")
                                   for b in l["batches"]) + ")"

        lines = "; ".join(
            f"{l['name']} {l['quantity']:g} {l['unit']}{batch_text(l)} दर {_inr(l['rate'])}"
            + ("" if l["rate_source"] == "spoken" else " (मागचा दर)")
            for l in record["items"]
        )
        tax = f", GST {_inr(record['tax_total'])} (दर GST वगळून)" if record["tax_total"] else ""
        warn = (" सूचना: " + " ".join(record["warnings"])) if record["warnings"] else ""
        return (f"{spec.label_mr}: {spec.party_label_mr} {record['party']}. {lines}. "
                f"रक्कम {_inr(record['taxable_total'])}{tax}, एकूण {_inr(record['total'])} रुपये.{warn} "
                "सेव्ह करायचे असल्यास हो म्हणा.")

    # ---------- helpers ----------

    @staticmethod
    def _number_phrase(number: str) -> str:
        return f". व्हाउचर नंबर {number}" if number else ""

    @staticmethod
    def _number(value: Any, label: str) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise VoucherError("bad_number", f"{label} स्पष्ट आकडा सांगा.") from None
        if not (0 < number <= 10_000_000):
            raise VoucherError("bad_number", f"{label} शून्यापेक्षा मोठा आणि वाजवी असला पाहिजे.")
        return number

    @staticmethod
    def _parse_date(value: Optional[str]) -> date:
        today = date.today()
        if not value:
            return today
        try:
            parsed = datetime.strptime(str(value).replace("-", ""), "%Y%m%d").date()
        except ValueError:
            raise VoucherError("bad_date", "तारीख समजली नाही (YYYY-MM-DD).") from None
        if parsed > today:
            raise VoucherError("bad_date", "भविष्यातील तारखेचे बिल करता येत नाही.")
        if parsed < today - timedelta(days=400):
            raise VoucherError("bad_date", "तारीख खूप जुनी आहे.")
        return parsed

    def _purge(self) -> None:
        now = time.time()
        for key, rec in list(self._drafts.items()):
            if rec["status"] == "posting":
                continue
            # Saved/unknown drafts are kept a day so a late repeated "yes" is answered truthfully, not as "expired".
            keep = 86400 if rec["status"] in ("saved", "unknown") else self.draft_ttl
            if now - rec["created_at"] > keep:
                del self._drafts[key]

    def _audit(self, event: str, record: Dict[str, Any], **extra: Any) -> None:
        entry = {
            "time": datetime.now().isoformat(timespec="seconds"), "event": event, "draft_id": record["draft_id"],
            "voucher_type": record["voucher_type"], "party": record["party"], "total": record["total"],
            "source": record.get("source"), "items": [(l["name"], l["quantity"], l["rate"]) for l in record["items"]],
            "tally_write_performed": event == "saved", **extra,
        }
        try:
            with (self.log_dir / "vouchers.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            logging.exception("Could not write voucher audit log")


VOUCHER_KEYS = tuple(VOUCHER_SPECS)

import re
import time
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from typing import List, Dict, Any, Optional, Callable
import logging
from dataclasses import dataclass


@dataclass
class Ledger:
    name: str
    parent: str
    closing_balance: float


@dataclass
class StockItem:
    name: str
    group: str
    unit: str
    closing_qty: float
    closing_value: float
    closing_rate: Optional[float]
    batch_wise: bool = False


@dataclass
class Group:
    name: str
    parent: str


@dataclass
class PurchaseInfo:
    rate: float
    gst_percent: Optional[float]
    date: str
    voucher_number: str


@dataclass
class LastRate:
    rate: float
    date: str
    party: str
    voucher_number: str
    same_party: bool


class TallyClient:
    """Read-only helpers (Export) plus `post_import`, which only the voucher service may call
    after `voucher_xml.assert_create_only` has approved the message."""

    def __init__(self, host: str = "127.0.0.1", port: int = 9000, company: str = "",
                 timeout: int = 10, cache_ttl: float = 120.0):
        self.host = host
        self.port = port
        self.company = company
        self.timeout = timeout
        self.cache_ttl = cache_ttl
        self.base_url = f"http://{host}:{port}"
        self._cache: Dict[str, Any] = {}

    # ---------- transport ----------

    def _post_raw(self, envelope: str, timeout: Optional[float] = None) -> str:
        req = Request(
            self.base_url,
            data=envelope.encode("utf-8"),
            headers={"Content-Type": "text/xml; charset=utf-8"},
            method="POST",
        )
        try:
            with urlopen(req, timeout=timeout or self.timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except HTTPError as e:
            raise ConnectionError(f"Tally HTTP error {e.code}: {e.read().decode('utf-8', errors='replace')[:300]}")
        except URLError as e:
            raise ConnectionError(f"Tally unreachable at {self.base_url}: {e.reason}")

    def _post_xml(self, envelope: str) -> str:
        xml_text = self._post_raw(envelope)

        xml_text = re.sub(
            r"(<\/?)([A-Za-z_][\w.-]*):",
            lambda m: f"{m.group(1)}{m.group(2)}_",
            xml_text,
        )

        def valid_char_ref(match):
            token = match.group(1)
            value = int(token[1:], 16) if token.lower().startswith("x") else int(token)
            return match.group(0) if value in (9, 10, 13) or value >= 32 else ""

        xml_text = re.sub(r"&#(x[0-9A-Fa-f]+|\d+);", valid_char_ref, xml_text)
        xml_text = "".join(ch for ch in xml_text if ch in "\t\n\r" or ord(ch) >= 32)
        return xml_text

    def post_import(self, envelope: str) -> str:
        """Send an already-validated voucher Import. Caches are dropped because balances and stock changed."""
        from voucher_xml import assert_create_only
        assert_create_only(envelope)
        try:
            return self._post_raw(envelope, timeout=max(self.timeout, 30))
        finally:
            self.clear_cache()

    # ---------- cache ----------

    def _cached(self, key: str, loader: Callable[[], Any]) -> Any:
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < self.cache_ttl:
            return hit[1]
        value = loader()
        self._cache[key] = (time.monotonic(), value)
        return value

    def clear_cache(self):
        self._cache.clear()

    # ---------- generic collection export ----------

    def _parse_collection(self, xml_text: str, object_type: str) -> List[ET.Element]:
        root = ET.fromstring(xml_text)
        tag = object_type.replace(" ", "").upper()
        return root.findall(f".//{tag}")

    def _make_collection_request(self, collection_name: str, object_type: str, fetch_fields: List[str],
                                 extra_vars: str = "", extra_tdl: str = "", filters: Optional[List[str]] = None) -> str:
        fetch_lines = "\n        ".join(f"<FETCH>{f}</FETCH>" for f in fetch_fields)
        filter_lines = "".join(f"<FILTER>{f}</FILTER>" for f in (filters or []))
        company_tag = f"<SVCURRENTCOMPANY>{self.company}</SVCURRENTCOMPANY>" if self.company else ""
        return f"""<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>{collection_name}</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>{company_tag}{extra_vars}<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="{collection_name}" ISMODIFY="No">
<TYPE>{object_type}</TYPE>
{filter_lines}
{fetch_lines}
</COLLECTION>
{extra_tdl}
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>"""

    # ---------- masters ----------

    def get_ledgers(self) -> List[Ledger]:
        def load():
            xml = self._make_collection_request("VoiceBillingLedgers", "Ledger", ["NAME", "PARENT", "CLOSINGBALANCE"])
            rows = self._parse_collection(self._post_xml(xml), "Ledger")
            ledgers = []
            for item in rows:
                name = item.attrib.get("NAME") or item.findtext("NAME", "")
                if name:
                    ledgers.append(Ledger(
                        name=name,
                        parent=item.findtext("PARENT", ""),
                        closing_balance=self._parse_amount(item.findtext("CLOSINGBALANCE", "0")),
                    ))
            return ledgers
        return self._cached("ledgers", load)

    def get_groups(self) -> List[Group]:
        def load():
            xml = self._make_collection_request("VoiceBillingGroups", "Group", ["NAME", "PARENT"])
            rows = self._parse_collection(self._post_xml(xml), "Group")
            groups = []
            for item in rows:
                name = item.attrib.get("NAME") or item.findtext("NAME", "")
                if name:
                    groups.append(Group(name=name, parent=item.findtext("PARENT", "")))
            return groups
        return self._cached("groups", load)

    def get_ledgers_under(self, group_name: str) -> List[Ledger]:
        """Every ledger in `group_name`, including ledgers in its sub-groups (e.g. customers grouped by village)."""
        group_parent = {g.name.lower().strip(): g.parent.lower().strip() for g in self.get_groups()}
        target = group_name.lower().strip()

        def under(group: str) -> bool:
            seen = set()
            current = group.lower().strip()
            while current and current not in seen:
                if current == target:
                    return True
                seen.add(current)
                current = group_parent.get(current, "")
            return False

        return [l for l in self.get_ledgers() if under(l.parent)]

    def get_ledger_states(self) -> Dict[str, str]:
        """ledger name -> state name, where Tally has one. Empty on any problem (callers treat as unknown)."""
        def load():
            try:
                xml = self._make_collection_request("VoiceBillingLedgerStates", "Ledger", ["NAME", "LEDSTATENAME"])
                rows = self._parse_collection(self._post_xml(xml), "Ledger")
            except Exception as e:
                logging.warning(f"Ledger states unavailable: {e}")
                return {}
            out = {}
            for item in rows:
                name = item.attrib.get("NAME") or item.findtext("NAME", "")
                state = (item.findtext("LEDSTATENAME", "") or "").strip()
                if name and state:
                    out[name] = state
            return out
        return self._cached("ledger_states", load)

    def get_company_gst(self) -> Dict[str, str]:
        """The company's GST registration as printed on its own recent Sales vouchers (name, GSTIN, state)."""
        def load():
            today = date.today()
            xml = self._make_collection_request(
                "VoiceBillingCompanyGst", "Voucher",
                ["DATE, VOUCHERTYPENAME, GSTREGISTRATION, CMPGSTIN, CMPGSTSTATE, STATENAME"],
                extra_vars=f"<SVFROMDATE>{(today - timedelta(days=45)).strftime('%Y%m%d')}</SVFROMDATE><SVTODATE>{today.strftime('%Y%m%d')}</SVTODATE>",
                extra_tdl='<SYSTEM TYPE="Formulae" NAME="VbCoFilter">$VoucherTypeName = "Sales"</SYSTEM>', filters=["VbCoFilter"])
            for v in self._parse_collection(self._post_xml(xml), "Voucher"):
                reg = v.find("GSTREGISTRATION")
                name = (reg.text or "").strip() if reg is not None else ""
                gstin = (v.findtext("CMPGSTIN", "") or "").strip()
                if name and gstin:
                    return {"registration": name, "gstin": gstin,
                            "state": (v.findtext("CMPGSTSTATE", "") or v.findtext("STATENAME", "") or "").strip()}
            return {}
        return self._cached("company_gst", load)

    def get_party_gst(self) -> Dict[str, Dict[str, str]]:
        """ledger name -> {type, gstin, state}, from the ledger's GST registration details (latest applicable)."""
        def load():
            try:
                xml = self._make_collection_request("VoiceBillingPartyGst", "Ledger",
                                                    ["NAME", "LEDGSTREGDETAILS.LIST", "LEDSTATENAME"])
                rows = self._parse_collection(self._post_xml(xml), "Ledger")
            except Exception as e:
                logging.warning(f"Party GST details unavailable: {e}")
                return {}
            today = date.today().strftime("%Y%m%d")
            out = {}
            for r in rows:
                name = r.attrib.get("NAME") or r.findtext("NAME", "")
                if not name:
                    continue
                best = None
                for d in r.findall("LEDGSTREGDETAILS.LIST"):
                    applicable = (d.findtext("APPLICABLEFROM", "") or "").strip()
                    if applicable and applicable > today:
                        continue
                    if best is None or applicable >= best[0]:
                        best = (applicable, d)
                d = best[1] if best else None
                out[name] = {
                    "type": (d.findtext("GSTREGISTRATIONTYPE", "") or "").strip() if d is not None else "",
                    "gstin": (d.findtext("GSTIN", "") or "").strip() if d is not None else "",
                    "state": ((d.findtext("PLACEOFSUPPLY", "") if d is not None else "") or r.findtext("LEDSTATENAME", "") or "").strip(),
                }
            return out
        return self._cached("party_gst", load)

    def get_stock_items(self) -> List[StockItem]:
        def load():
            xml = self._make_collection_request(
                "VoiceBillingStock", "StockItem",
                ["NAME", "PARENT", "BASEUNITS", "CLOSINGBALANCE", "CLOSINGVALUE", "CLOSINGRATE", "ISBATCHWISEON"],
            )
            rows = self._parse_collection(self._post_xml(xml), "StockItem")
            items = []
            for item in rows:
                name = item.attrib.get("NAME") or item.findtext("NAME", "")
                if name:
                    items.append(StockItem(
                        name=name,
                        group=(item.findtext("PARENT", "") or "").strip(),
                        unit=(item.findtext("BASEUNITS", "") or "").strip(),
                        closing_qty=self._parse_qty(item.findtext("CLOSINGBALANCE", "0")),
                        closing_value=abs(self._parse_amount(item.findtext("CLOSINGVALUE", "0"))),
                        closing_rate=self._parse_rate(item.findtext("CLOSINGRATE", "")),
                        batch_wise=(item.findtext("ISBATCHWISEON", "") or "").strip() == "Yes",
                    ))
            return items
        return self._cached("stock_items", load)

    def get_item_gst_percent(self) -> Dict[str, Optional[float]]:
        """stock item name -> total GST % from the item master (None when the master has no usable GST details)."""
        def load():
            xml = self._make_collection_request("VoiceBillingStockGst", "StockItem", ["NAME", "GSTDETAILS.LIST"])
            rows = self._parse_collection(self._post_xml(xml), "StockItem")
            today = date.today().strftime("%Y%m%d")
            out: Dict[str, Optional[float]] = {}
            for item in rows:
                name = item.attrib.get("NAME") or item.findtext("NAME", "")
                if not name:
                    continue
                best = None  # (applicable_from, percent)
                for details in item.findall("GSTDETAILS.LIST"):
                    applicable = (details.findtext("APPLICABLEFROM", "") or "").strip()
                    percent = self._gst_percent_from_details(details)
                    if percent is None or (applicable and applicable > today):
                        continue
                    if best is None or applicable >= best[0]:
                        best = (applicable, percent)
                out[name] = best[1] if best else None
            return out
        return self._cached("item_gst", load)

    def get_stock_groups(self) -> Dict[str, Any]:
        """stock group name -> (parent group name, GST % set on the group or None). Items inherit from their group."""
        def load():
            xml = self._make_collection_request("VoiceBillingStockGroups", "StockGroup", ["NAME", "PARENT", "GSTDETAILS.LIST"])
            rows = self._parse_collection(self._post_xml(xml), "StockGroup")
            today = date.today().strftime("%Y%m%d")
            out = {}
            for g in rows:
                name = (g.attrib.get("NAME") or g.findtext("NAME", "") or "").strip()
                if not name:
                    continue
                best = None
                for details in g.findall("GSTDETAILS.LIST"):
                    applicable = (details.findtext("APPLICABLEFROM", "") or "").strip()
                    percent = self._gst_percent_from_details(details)
                    if percent is None or (applicable and applicable > today):
                        continue
                    if best is None or applicable >= best[0]:
                        best = (applicable, percent)
                parent = (g.findtext("PARENT", "") or "").strip()
                out[name] = (parent if parent.lower() != "primary" else "", best[1] if best else None)
            return out
        return self._cached("stock_groups", load)

    @staticmethod
    def _gst_percent_from_details(details: ET.Element) -> Optional[float]:
        taxability = (details.findtext("TAXABILITY", "") or "").strip().lower()
        if taxability in ("exempt", "nil rated", "non-gst", "non gst"):
            return 0.0
        heads: Dict[str, float] = {}
        for rate in details.findall(".//RATEDETAILS.LIST"):
            head = (rate.findtext("GSTRATEDUTYHEAD", "") or "").strip().upper()
            try:
                value = float((rate.findtext("GSTRATE", "") or "").strip())
            except ValueError:
                continue
            heads[head] = value
        if "IGST" in heads and heads["IGST"] > 0:
            return heads["IGST"]
        cgst = heads.get("CGST")
        sgst = heads.get("SGST/UTGST", heads.get("SGST"))
        if cgst is not None and sgst is not None:
            return cgst + sgst
        return heads.get("IGST")

    # ---------- voucher history (rates) ----------

    def _fetch_vouchers(self, voucher_type_name: str, lookback_days: int) -> List[Dict[str, Any]]:
        def load():
            today = date.today()
            from_date = today - timedelta(days=lookback_days)
            extra_vars = (
                f"<SVFROMDATE>{from_date.strftime('%Y%m%d')}</SVFROMDATE>"
                f"<SVTODATE>{today.strftime('%Y%m%d')}</SVTODATE>"
            )
            safe_type = voucher_type_name.replace('"', "")
            extra_tdl = f'<SYSTEM TYPE="Formulae" NAME="VbTypeFilter">$VoucherTypeName = "{safe_type}"</SYSTEM>'
            xml = self._make_collection_request(
                "VoiceBillingVouchers", "Voucher",
                [
                    "DATE, VOUCHERTYPENAME, VOUCHERNUMBER, PARTYLEDGERNAME, ISCANCELLED, ISOPTIONAL",
                    "ALLINVENTORYENTRIES.LIST",  # whole entry: also carries the accounting allocation (sales ledger)
                    "INVENTORYENTRIES.LIST",
                    "ALLLEDGERENTRIES.LIST, ALLLEDGERENTRIES.LEDGERNAME, ALLLEDGERENTRIES.AMOUNT",
                    "LEDGERENTRIES.LIST, LEDGERENTRIES.LEDGERNAME, LEDGERENTRIES.AMOUNT",
                ],
                extra_vars=extra_vars, extra_tdl=extra_tdl, filters=["VbTypeFilter"],
            )
            rows = self._parse_collection(self._post_xml(xml), "Voucher")

            vouchers = []
            for v in rows:
                if (v.findtext("ISCANCELLED", "No") or "No").strip() == "Yes":
                    continue
                if (v.findtext("ISOPTIONAL", "No") or "No").strip() == "Yes":
                    continue

                items = []
                for e in self._listof(v, "INVENTORYENTRIES"):
                    name = e.attrib.get("STOCKITEMNAME") or e.findtext("STOCKITEMNAME", "")
                    if not name:
                        continue
                    allocation = e.find("ACCOUNTINGALLOCATIONS.LIST")
                    items.append({
                        "name": name,
                        "rate": self._parse_rate(e.findtext("RATE", "")) or 0.0,
                        "amount": abs(self._parse_amount(e.findtext("AMOUNT", "0"))),
                        "ledger": (allocation.findtext("LEDGERNAME", "") or "").strip() if allocation is not None else "",
                    })

                ledger_entries = []
                for e in self._listof(v, "LEDGERENTRIES"):
                    lname = e.attrib.get("LEDGERNAME") or e.findtext("LEDGERNAME", "")
                    if lname:
                        ledger_entries.append({"name": lname, "amount": self._parse_amount(e.findtext("AMOUNT", "0"))})

                items_total = sum(it["amount"] for it in items)
                tax_total = sum(
                    abs(le["amount"]) for le in ledger_entries
                    if re.search(r"\b(cgst|sgst|utgst|igst|gst|cess)\b", le["name"], re.IGNORECASE)
                    and not re.search(r"sale|purchase", le["name"], re.IGNORECASE)
                )
                ratio = (items_total + tax_total) / items_total if items_total else 1.0
                gst_percent = round((ratio - 1) * 100, 2) if 1.0 < ratio <= 1.3 else None

                vouchers.append({
                    "date": v.findtext("DATE", ""),
                    "type": v.findtext("VOUCHERTYPENAME", ""),
                    "number": v.findtext("VOUCHERNUMBER", ""),
                    "party": v.findtext("PARTYLEDGERNAME", ""),
                    "items": items,
                    "gst_percent": gst_percent,
                })
            return vouchers
        return self._cached(f"vouchers:{voucher_type_name}:{lookback_days}", load)

    # ---------- batch-wise stock (READ ONLY; same request shapes as the code above) ----------

    def get_batch_openings(self, item_name: str) -> List[Dict[str, Any]]:
        """Opening batch rows (batch, godown, qty, expiry) of ONE stock item, from its master. One small request."""
        name = item_name.replace('"', "")

        def load():
            extra_tdl = f'<SYSTEM TYPE="Formulae" NAME="VbOneItem">$Name = "{name}"</SYSTEM>'
            xml = self._make_collection_request(
                "VoiceBillingBatchOpening", "Stock Item",
                ["NAME, ISBATCHWISEON, OPENINGBALANCE, CLOSINGBALANCE", "BATCHALLOCATIONS.LIST"],
                extra_tdl=extra_tdl, filters=["VbOneItem"])
            rows: List[Dict[str, Any]] = []
            for si in self._parse_collection(self._post_xml(xml), "StockItem"):
                if (si.attrib.get("NAME") or si.findtext("NAME") or "") != item_name:
                    continue
                for b in si.findall("BATCHALLOCATIONS.LIST"):
                    batch = (b.findtext("BATCHNAME") or "").strip()
                    if batch:
                        rows.append({"batch": batch, "godown": (b.findtext("GODOWNNAME") or "").strip(),
                                     "qty": self._parse_qty(b.findtext("OPENINGBALANCE", "")),
                                     "expiry": (b.findtext("EXPIRYPERIOD") or "").strip()})
            return rows
        return self._cached(f"batchopen:{item_name}", load)

    def get_stock_movements(self, voucher_type_name: str, from_date: date, to_date: date) -> List[Dict[str, Any]]:
        """Every stock line of one voucher type between two dates, one row per batch allocation:
        {item, date, inward, batch, godown, qty, expiry, type}. Cancelled and optional vouchers are left out."""
        def load():
            extra_vars = (f"<SVFROMDATE>{from_date.strftime('%Y%m%d')}</SVFROMDATE>"
                          f"<SVTODATE>{to_date.strftime('%Y%m%d')}</SVTODATE>")
            safe_type = voucher_type_name.replace('"', "")
            extra_tdl = f'<SYSTEM TYPE="Formulae" NAME="VbTypeFilter">$VoucherTypeName = "{safe_type}"</SYSTEM>'
            xml = self._make_collection_request(
                "VoiceBillingMoves", "Voucher",
                ["DATE, VOUCHERTYPENAME, VOUCHERNUMBER, ISCANCELLED, ISOPTIONAL",
                 "ALLINVENTORYENTRIES.LIST", "INVENTORYENTRIES.LIST"],
                extra_vars=extra_vars, extra_tdl=extra_tdl, filters=["VbTypeFilter"])
            out: List[Dict[str, Any]] = []
            for v in self._parse_collection(self._post_xml(xml), "Voucher"):
                if (v.findtext("ISCANCELLED", "No") or "No").strip() == "Yes":
                    continue
                if (v.findtext("ISOPTIONAL", "No") or "No").strip() == "Yes":
                    continue
                raw_date = (v.findtext("DATE") or "").strip()
                try:
                    vdate = date(int(raw_date[0:4]), int(raw_date[4:6]), int(raw_date[6:8]))
                except ValueError:
                    vdate = None
                for e in self._listof(v, "INVENTORYENTRIES"):
                    item = (e.attrib.get("STOCKITEMNAME") or e.findtext("STOCKITEMNAME") or "").strip()
                    if not item:
                        continue
                    inward = (e.findtext("ISDEEMEDPOSITIVE", "No") or "No").strip() == "Yes"
                    for b in e.findall("BATCHALLOCATIONS.LIST"):
                        qty = self._parse_qty(b.findtext("ACTUALQTY", "") or b.findtext("BILLEDQTY", ""))
                        if qty:
                            out.append({"item": item, "date": vdate, "inward": inward,
                                        "batch": (b.findtext("BATCHNAME") or "").strip(),
                                        "godown": (b.findtext("GODOWNNAME") or "").strip(), "qty": abs(qty),
                                        "expiry": (b.findtext("EXPIRYPERIOD") or "").strip(),
                                        "type": voucher_type_name})
            return out
        return self._cached(f"moves:{voucher_type_name}:{from_date}:{to_date}", load)

    def _listof(self, element: ET.Element, key: str) -> List[ET.Element]:
        all_list = element.findall(f"ALL{key}.LIST")
        return all_list if all_list else element.findall(f"{key}.LIST")

    def get_last_rate(self, item_name: str, kind: str, party: Optional[str] = None,
                      lookback_days: int = 730) -> Optional[LastRate]:
        """Most recent rate used for `item_name` on a Sales ("sales") or Purchase ("purchase") voucher.
        A rate given to the same party wins over a more recent one given to someone else."""
        type_name = "Sales" if kind == "sales" else "Purchase"
        best_any = best_party = None
        for v in self._fetch_vouchers(type_name, lookback_days):
            for item in v["items"]:
                if item["name"].lower() != item_name.lower() or item["rate"] <= 0:
                    continue
                if best_any is None or v["date"] > best_any[0]["date"]:
                    best_any = (v, item)
                if party and v["party"].lower() == party.lower() and (best_party is None or v["date"] > best_party[0]["date"]):
                    best_party = (v, item)
        pick = best_party or best_any
        if pick is None:
            return None
        v, item = pick
        return LastRate(rate=item["rate"], date=v["date"], party=v["party"], voucher_number=v["number"],
                        same_party=best_party is not None)

    def get_last_item_ledger(self, item_name: str, voucher_type_name: str, lookback_days: int = 730) -> Optional[str]:
        """The sales / purchase ledger this item was posted to on its most recent voucher of that type."""
        best = None
        for v in self._fetch_vouchers(voucher_type_name, lookback_days):
            for item in v["items"]:
                if item["name"].lower() == item_name.lower() and item["ledger"]:
                    if best is None or v["date"] > best[0]:
                        best = (v["date"], item["ledger"])
        return best[1] if best else None

    def get_last_purchase_info(self, item_name: str, lookback_days: int = 730) -> Optional[PurchaseInfo]:
        best = None
        for v in self._fetch_vouchers("Purchase", lookback_days):
            for item in v["items"]:
                if item["name"].lower() == item_name.lower():
                    if best is None or v["date"] > best[0]["date"]:
                        best = (v, item)
        if best is None:
            return None
        voucher, item = best
        return PurchaseInfo(rate=item["rate"], gst_percent=voucher["gst_percent"],
                            date=voucher["date"], voucher_number=voucher["number"])

    def find_voucher_number(self, voucher_type_name: str, master_id: str) -> str:
        """Voucher number of the voucher with this MASTERID (used to read back a number Tally just assigned)."""
        if not master_id.isdigit():
            return ""
        today = date.today()
        extra_vars = (
            f"<SVFROMDATE>{(today - timedelta(days=366)).strftime('%Y%m%d')}</SVFROMDATE>"
            f"<SVTODATE>{today.strftime('%Y%m%d')}</SVTODATE>"
        )
        extra_tdl = f'<SYSTEM TYPE="Formulae" NAME="VbIdFilter">$MasterId = {master_id}</SYSTEM>'
        try:
            xml = self._make_collection_request(
                "VoiceBillingVoucherById", "Voucher", ["VOUCHERNUMBER, MASTERID"],
                extra_vars=extra_vars, extra_tdl=extra_tdl, filters=["VbIdFilter"],
            )
            rows = self._parse_collection(self._post_xml(xml), "Voucher")
        except Exception as e:
            logging.warning(f"Voucher number lookup failed: {e}")
            return ""
        return (rows[0].findtext("VOUCHERNUMBER", "") or "").strip() if rows else ""

    # ---------- balances / stock (inquiries) ----------

    def get_party_outstanding(self, party_name: str) -> Optional[float]:
        for ledger in self.get_ledgers():
            if ledger.name.lower() == party_name.lower():
                return ledger.closing_balance
        return None

    # ---------- parsing helpers ----------

    def _parse_amount(self, text: str) -> float:
        if not text:
            return 0.0
        text = text.replace(",", "").replace("₹", "").strip()
        credit = text.lower().endswith("cr")
        text = text.removesuffix("Cr").removesuffix("CR").removesuffix("Dr").removesuffix("DR").strip()
        match = re.search(r"[-+]?\d+(?:\.\d+)?", text)
        number = float(match.group()) if match else 0.0
        return -abs(number) if credit else number

    def _parse_qty(self, text: str) -> float:
        if not text:
            return 0.0
        match = re.search(r"(-?[\d.,]+)", text.replace(",", ""))
        return float(match.group(1)) if match else 0.0

    def _parse_rate(self, text: str) -> Optional[float]:
        if not text:
            return None
        match = re.search(r"([\d.,]+)", text.split("/")[0].replace(",", ""))
        return float(match.group(1)) if match else None

    def test_connection(self) -> bool:
        try:
            self.get_ledgers()
            return True
        except Exception as e:
            logging.error(f"Tally connection test failed: {e}")
            return False

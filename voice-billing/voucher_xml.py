"""Builds and checks the Tally XML for creating ONE new voucher. Pure functions, no network.

Voice billing may only ever CREATE a new voucher. `assert_create_only` is the last gate before
anything is posted to Tally: it rejects any message that is not exactly one voucher with ACTION="Create"
(so no alter / delete / cancel, and no ledger / stock-item / group master can be created or changed).
"""
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Any, Dict, List
from xml.sax.saxutils import escape

from voucher_types import VoucherSpec
from batch_stock import split_amount


class UnsafeVoucherError(RuntimeError):
    pass


def _esc(value: Any) -> str:
    return escape(str(value), {'"': "&quot;"})


def money(value: float) -> str:
    return f"{value:.2f}"


def build_import_xml(company: str, spec: VoucherSpec, v: Dict[str, Any]) -> str:
    """`v` keys: date (YYYYMMDD), party, narration, items[{name, unit, quantity, rate, amount, ledger}],
    taxes[{ledger, amount}], round_off {ledger, amount (may be negative)} optional, total.
    Amounts are positive (except round_off); this function applies the Dr/Cr signs."""
    # Debit is the negative side in Tally XML. Stock coming in means the item ledger is debited, the party credited.
    item_side_debit = spec.stock_in
    sign_item = -1.0 if item_side_debit else 1.0
    sign_party = -1.0 if spec.party_is_debit else 1.0
    item_flag = "Yes" if item_side_debit else "No"
    party_flag = "Yes" if spec.party_is_debit else "No"

    inventory = []
    for it in v["items"]:
        amt = money(sign_item * it["amount"])
        batches = it.get("batches") or []
        if batches:
            # batch-wise item: one allocation per real batch (quantity and amount split; the last batch takes the paise)
            parts = split_amount(it["amount"], [b["quantity"] for b in batches])
            batch_xml = "".join(f"""
       <BATCHALLOCATIONS.LIST>{(chr(10) + '        <GODOWNNAME>' + _esc(b.get('godown') or it.get('godown') or v.get('default_godown')) + '</GODOWNNAME>') if (b.get('godown') or it.get('godown') or v.get('default_godown')) else ''}
        <BATCHNAME>{_esc(b['batch'])}</BATCHNAME>
        <INDENTNO>Not Applicable</INDENTNO>
        <ORDERNO>Not Applicable</ORDERNO>
        <TRACKINGNUMBER>Not Applicable</TRACKINGNUMBER>
        <BATCHDISCOUNT>0</BATCHDISCOUNT>
        <AMOUNT>{money(sign_item * part)}</AMOUNT>
        <ACTUALQTY> {b['quantity']:g} {_esc(it['unit'])}</ACTUALQTY>
        <BILLEDQTY> {b['quantity']:g} {_esc(it['unit'])}</BILLEDQTY>
        <BATCHRATE>{money(it['rate'])}/{_esc(it['unit'])}</BATCHRATE>
       </BATCHALLOCATIONS.LIST>""" for b, part in zip(batches, parts))
        else:
            godown_xml = (chr(10) + '        <GODOWNNAME>' + _esc(it.get('godown') or v.get('default_godown')) + '</GODOWNNAME>') if (it.get('godown') or v.get('default_godown')) else ''
            batch_xml = f"""
       <BATCHALLOCATIONS.LIST>{godown_xml}
        <BATCHNAME>Primary Batch</BATCHNAME>
        <INDENTNO>Not Applicable</INDENTNO>
        <ORDERNO>Not Applicable</ORDERNO>
        <TRACKINGNUMBER>Not Applicable</TRACKINGNUMBER>
        <BATCHDISCOUNT>0</BATCHDISCOUNT>
        <AMOUNT>{amt}</AMOUNT>
        <ACTUALQTY> {it['quantity']:g} {_esc(it['unit'])}</ACTUALQTY>
        <BILLEDQTY> {it['quantity']:g} {_esc(it['unit'])}</BILLEDQTY>
        <BATCHRATE>{money(it['rate'])}/{_esc(it['unit'])}</BATCHRATE>
       </BATCHALLOCATIONS.LIST>"""
        inventory.append(f"""
      <ALLINVENTORYENTRIES.LIST>
       <STOCKITEMNAME>{_esc(it['name'])}</STOCKITEMNAME>
       <ISDEEMEDPOSITIVE>{item_flag}</ISDEEMEDPOSITIVE>
       <ISLASTDEEMEDPOSITIVE>{item_flag}</ISLASTDEEMEDPOSITIVE>
       <RATE>{money(it['rate'])}/{_esc(it['unit'])}</RATE>
       <DISCOUNT>0</DISCOUNT>
       <AMOUNT>{amt}</AMOUNT>
       <ACTUALQTY> {it['quantity']:g} {_esc(it['unit'])}</ACTUALQTY>
       <BILLEDQTY> {it['quantity']:g} {_esc(it['unit'])}</BILLEDQTY>{batch_xml}
       <ACCOUNTINGALLOCATIONS.LIST>
        <LEDGERNAME>{_esc(it['ledger'])}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>{item_flag}</ISDEEMEDPOSITIVE>
        <ISLASTDEEMEDPOSITIVE>{item_flag}</ISLASTDEEMEDPOSITIVE>
        <AMOUNT>{amt}</AMOUNT>
       </ACCOUNTINGALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST>""")

    ledgers = [f"""
      <LEDGERENTRIES.LIST>
       <LEDGERNAME>{_esc(v['party'])}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>{party_flag}</ISDEEMEDPOSITIVE>
       <ISLASTDEEMEDPOSITIVE>{party_flag}</ISLASTDEEMEDPOSITIVE>
       <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
       <AMOUNT>{money(sign_party * v['total'])}</AMOUNT>
      </LEDGERENTRIES.LIST>"""]
    for tax in v.get("taxes", []):
        ledgers.append(f"""
      <LEDGERENTRIES.LIST>
       <LEDGERNAME>{_esc(tax['ledger'])}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>{item_flag}</ISDEEMEDPOSITIVE>
       <ISLASTDEEMEDPOSITIVE>{item_flag}</ISLASTDEEMEDPOSITIVE>
       <AMOUNT>{money(sign_item * tax['amount'])}</AMOUNT>
      </LEDGERENTRIES.LIST>""")

    ro = v.get("round_off")
    if ro and abs(ro["amount"]) >= 0.005:
        ledgers.append(f"""
      <LEDGERENTRIES.LIST>
       <LEDGERNAME>{_esc(ro['ledger'])}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>{item_flag if ro['amount'] > 0 else ('No' if item_flag == 'Yes' else 'Yes')}</ISDEEMEDPOSITIVE>
       <AMOUNT>{money(sign_item * ro['amount'])}</AMOUNT>
      </LEDGERENTRIES.LIST>""")

    header = v.get("gst_header") or {}
    header_xml = ""
    if header:
        parts = []
        if header.get("registration"):
            parts.append(f'\n      <GSTREGISTRATION TAXTYPE="GST" TAXREGISTRATION="{_esc(header.get("company_gstin", ""))}">{_esc(header["registration"])}</GSTREGISTRATION>')
        for tag in ("CMPGSTIN", "CMPGSTSTATE", "GSTREGISTRATIONTYPE", "PARTYGSTIN", "PLACEOFSUPPLY", "STATENAME",
                    "COUNTRYOFRESIDENCE", "CONSIGNEESTATENAME", "PARTYNAME", "BASICBUYERNAME"):
            if header.get(tag):
                parts.append(f"\n      <{tag}>{_esc(header[tag])}</{tag}>")
        header_xml = "".join(parts)

    company_tag = f"<SVCURRENTCOMPANY>{_esc(company)}</SVCURRENTCOMPANY>" if company else ""
    return f"""<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
    <STATICVARIABLES>{company_tag}</STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="{_esc(spec.tally_type)}" ACTION="Create" OBJVIEW="Invoice Voucher View">
      <DATE>{v['date']}</DATE>
      <EFFECTIVEDATE>{v['date']}</EFFECTIVEDATE>
      <VOUCHERTYPENAME>{_esc(spec.tally_type)}</VOUCHERTYPENAME>
      <PARTYLEDGERNAME>{_esc(v['party'])}</PARTYLEDGERNAME>
      <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
      <ISINVOICE>Yes</ISINVOICE>
      <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
      <VOUCHERNUMBERSERIES>Default</VOUCHERNUMBERSERIES>{header_xml}
      <NARRATION>{_esc(v.get('narration', ''))}</NARRATION>{''.join(inventory)}{''.join(ledgers)}
     </VOUCHER>
    </TALLYMESSAGE>
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>"""


def assert_create_only(xml_text: str) -> str:
    """Raise unless `xml_text` is an Import of exactly one new voucher and nothing else."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise UnsafeVoucherError(f"XML is not well-formed: {exc}") from exc
    if root.tag != "ENVELOPE":
        raise UnsafeVoucherError("Not a Tally envelope.")
    if (root.findtext("HEADER/TALLYREQUEST") or "").strip() != "Import Data":
        raise UnsafeVoucherError("Only 'Import Data' of vouchers is allowed.")
    if (root.findtext("BODY/IMPORTDATA/REQUESTDESC/REPORTNAME") or "").strip() != "Vouchers":
        raise UnsafeVoucherError("Only the Vouchers report may be imported.")
    messages = root.findall("BODY/IMPORTDATA/REQUESTDATA/TALLYMESSAGE")
    if len(messages) != 1:
        raise UnsafeVoucherError("Exactly one TALLYMESSAGE is allowed.")
    children = list(messages[0])
    if len(children) != 1 or children[0].tag != "VOUCHER":
        raise UnsafeVoucherError("Only one VOUCHER is allowed (no masters).")
    voucher = children[0]
    if voucher.attrib.get("ACTION") != "Create":
        raise UnsafeVoucherError('Voucher ACTION must be "Create".')
    if re.search(r"<(LEDGER|STOCKITEM|GROUP|UNIT|COMPANY|VOUCHERTYPE)[\s>]", xml_text):
        raise UnsafeVoucherError("Master data in the message is not allowed.")
    return xml_text


@dataclass
class ImportResult:
    created: int = 0
    altered: int = 0
    deleted: int = 0
    errors: int = 0
    cancelled: int = 0
    ignored: int = 0
    last_vch_id: str = ""
    line_errors: List[str] = field(default_factory=list)
    recognised: bool = False

    @property
    def success(self) -> bool:
        return (self.recognised and self.created == 1 and self.errors == 0
                and self.altered == 0 and self.deleted == 0 and self.cancelled == 0)

    def failure_text(self) -> str:
        if self.line_errors:
            return "; ".join(self.line_errors)[:300]
        if not self.recognised:
            return "Tally ने अपेक्षित उत्तर दिले नाही."
        if self.created == 0 and self.errors == 0:
            return "Tally ने काहीही तयार केले नाही."
        return "Tally ने व्हाउचर नाकारले (Tally मध्ये तपासा)."


def _tag_int(text: str, tag: str) -> int:
    m = re.search(rf"<{tag}>\s*(-?\d+)\s*</{tag}>", text)
    return int(m.group(1)) if m else 0


def parse_import_response(text: str) -> ImportResult:
    recognised = "<RESPONSE>" in text or "<CREATED>" in text
    line_errors = [re.sub(r"\s+", " ", m).strip() for m in re.findall(r"<LINEERROR>(.*?)</LINEERROR>", text, re.S)]
    last = re.search(r"<LASTVCHID>\s*(\d+)\s*</LASTVCHID>", text)
    return ImportResult(
        created=_tag_int(text, "CREATED"), altered=_tag_int(text, "ALTERED"),
        deleted=_tag_int(text, "DELETED"), errors=_tag_int(text, "ERRORS"),
        cancelled=_tag_int(text, "CANCELLED"), ignored=_tag_int(text, "IGNORED"),
        last_vch_id=last.group(1) if last else "", line_errors=line_errors, recognised=recognised,
    )

from datetime import date
import re
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
import pyodbc
from readonly_guard import assert_read_only_sql
from matching import match_name


# Used when config.json has no entry for these keys, so the live config needs no edit.
_DEFAULT_QUERIES = {
    "ledger_parents": "SELECT $Name, $Parent, $_ClosingBalance FROM Ledger",
    "group_parents": "SELECT $Name, $Parent FROM Groups",
}


class TallyReadOnly:
    def __init__(self, config):
        self.config = config
        self.conn = None
        self.backend = "odbc"

    def __enter__(self):
        dsn = self.config["odbc"]["dsn"]
        timeout = int(self.config["odbc"].get("timeout_seconds", 5))
        try:
            self.conn = pyodbc.connect(
                f"DSN={dsn}", timeout=timeout,
                autocommit=False, readonly=True,
            )
        except pyodbc.Error:
            # TallyPrime can expose read-only XML exports on the same port even
            # when its optional Windows ODBC driver/DSN is not registered.
            self.backend = "xml"
        return self

    def __exit__(self, *_):
        if self.conn:
            self.conn.rollback()
            self.conn.close()

    def query(self, key, params=()):
        if self.backend == "xml":
            return self._xml_query(key, params)
        sql = assert_read_only_sql(self.config["queries"].get(key) or _DEFAULT_QUERIES[key])
        if params and self.config["odbc"].get("parameter_mode") == "escaped_literal":
            for value in params:
                if "?" not in sql:
                    raise ValueError("Query parameter count mismatch")
                sql = sql.replace("?", _sql_literal(value), 1)
            if "?" in sql:
                raise ValueError("Query parameter count mismatch")
            params = ()
        cursor = self.conn.cursor()
        rows = cursor.execute(sql, tuple(params)).fetchall()
        columns = [x[0] for x in cursor.description]
        return [dict(zip(columns, row)) for row in rows]

    def _xml_query(self, key, params=()):
        definitions = {
            "stock_names": ("Stock Item", "$Name", "$_ClosingBalance"),
            "stock_value": ("Stock Item", "$Name", "$_ClosingBalance"),
            "ledger_names": ("Ledger", "$Name", "$_ClosingBalance"),
            "party_outstanding": ("Ledger", "$Name", "$_ClosingBalance"),
            "group_names": ("Group", "$Name", "$_ClosingBalance"),
            "category_outstanding": ("Group", "$Name", "$_ClosingBalance"),
            "today_vouchers": ("Voucher", "$Name", "$Amount"),
            "ledger_parents": ("Ledger", "$Name", "$_ClosingBalance"),
            "group_parents": ("Group", "$Name", "$Parent"),
        }
        if key not in definitions:
            raise KeyError(f"Unsupported read-only XML query: {key}")
        object_type, _, _ = definitions[key]
        collection = "VoiceHelperReadOnly"
        fetch = "Name,ClosingBalance"
        if key in ("ledger_parents", "group_parents"):
            fetch = "Name,Parent,ClosingBalance"
        if key == "today_vouchers":
            fetch = "Date,VoucherTypeName,Amount"
        envelope = (
            "<ENVELOPE><HEADER><VERSION>1</VERSION>"
            "<TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>"
            f"<ID>{collection}</ID></HEADER><BODY><DESC>"
            "<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            "</STATICVARIABLES><TDL><TDLMESSAGE>"
            f"<COLLECTION NAME=\"{collection}\" ISMODIFY=\"No\">"
            f"<TYPE>{object_type}</TYPE><FETCH>{fetch}</FETCH>"
            "</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>"
        ).encode("utf-8")
        request = Request(
            "http://127.0.0.1:9000", data=envelope,
            headers={"Content-Type": "text/xml; charset=utf-8"},
            method="POST",
        )
        timeout = int(self.config["odbc"].get("timeout_seconds", 5))
        with urlopen(request, timeout=timeout) as response:
            xml_text = response.read().decode("utf-8", errors="replace")
        # Some Tally extensions emit UDF: prefixed elements without declaring
        # an XML namespace. Neutralize only the prefix separator so the
        # read-only export remains parseable.
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
        xml_text = "".join(
            ch for ch in xml_text
            if ch in "\t\n\r" or ord(ch) >= 32
        )
        root = ET.fromstring(xml_text)
        rows = []
        for item in root.findall(f".//{object_type.replace(' ', '').upper()}"):
            if key == "today_vouchers":
                row = {
                    "$Date": item.findtext("DATE", ""),
                    "$VoucherTypeName": item.findtext("VOUCHERTYPENAME", ""),
                    "$Amount": item.findtext("AMOUNT", ""),
                }
            else:
                row = {
                    "$Name": item.attrib.get("NAME") or item.findtext("NAME", ""),
                    "$_ClosingBalance": item.findtext("CLOSINGBALANCE", ""),
                    "$Parent": item.findtext("PARENT", ""),
                }
            rows.append(row)
        if params:
            wanted = str(params[0])
            field = "$VoucherTypeName" if key == "today_vouchers" else "$Name"
            rows = [r for r in rows if str(r.get(field, "")).casefold() == wanted.casefold()]
        return rows

    def today_total(self, kind):
        voucher_type = self.config["voucher_types"][kind]
        # This Tally ODBC build exposes $Date as a date but does not match date
        # literals in WHERE. Read the selected voucher type and filter locally.
        rows = self.query("today_vouchers", (voucher_type,))
        today = date.today()
        rows = [row for row in rows if _as_date(row.get("$Date")) == today]
        amount_field = self.config["result_fields"]["amount"]
        raw_amounts = [row.get(amount_field) for row in rows]
        total = sum(abs(_number(value)) for value in raw_amounts) if any(value not in (None, "") for value in raw_amounts) else None
        return {"count": len(rows), "total": total, "rows": rows}

    def named_value(self, list_query, value_query, subject, value_field):
        names_field = self.config["result_fields"]["name"]
        names = [r.get(names_field) for r in self.query(list_query) if r.get(names_field)]
        result = match_name(subject, names, self.config["matching"]["threshold"], self.config["matching"]["ambiguity_gap"])
        if result["status"] != "matched":
            return result
        rows = self.query(value_query, (result["name"],))
        return {**result, "rows": rows, "value": sum(_number(r.get(value_field)) for r in rows)}

    def debtor_balances(self, root="Sundry Debtors"):
        """[(ledger name, closing balance)] for every ledger under `root`, sub-groups included."""
        parents = {}
        for row in self.query("group_parents"):
            name = str(row.get("$Name") or "").strip().casefold()
            if name:
                parents[name] = str(row.get("$Parent") or "").strip().casefold()
        target = root.casefold()

        def under_root(group):
            seen = set()
            while group and group not in seen:
                if group == target:
                    return True
                seen.add(group)
                group = parents.get(group, "")
            return False

        balances = []
        for row in self.query("ledger_parents"):
            name = str(row.get("$Name") or "").strip()
            if name and under_root(str(row.get("$Parent") or "").strip().casefold()):
                balances.append((name, _number(row.get("$_ClosingBalance"))))
        return balances

    def resolve_name(self, list_query, subject):
        names_field = self.config["result_fields"]["name"]
        names = [r.get(names_field) for r in self.query(list_query) if r.get(names_field)]
        return match_name(
            subject,
            names,
            self.config["matching"]["threshold"],
            self.config["matching"]["ambiguity_gap"],
        )


def summarize_receivables(balances, top_n=3):
    """Same sign rule as party_outstanding: a negative balance is money to receive."""
    owed = sorted(((n, -v) for n, v in balances if v < 0), key=lambda x: -x[1])
    advances = [v for _, v in balances if v > 0]
    return {
        "total": sum(v for _, v in owed),
        "count": len(owed),
        "top": owed[:top_n],
        "advance_total": sum(advances),
        "advance_count": len(advances),
    }


def _number(value):
    if value is None:
        return 0.0
    text = str(value).replace(",", "").replace("₹", "").strip()
    credit = text.lower().endswith("cr")
    text = text.removesuffix("Cr").removesuffix("CR").removesuffix("Dr").removesuffix("DR").strip()
    match = re.search(r"[-+]?\d+(?:\.\d+)?", text)
    number = float(match.group()) if match else 0.0
    return -abs(number) if credit else number


def _as_date(value):
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    for fmt in ("%Y%m%d", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            return date.fromisoformat(text) if fmt == "%Y-%m-%d" else __import__("datetime").datetime.strptime(text, fmt).date()
        except ValueError:
            pass
    return None


def _sql_literal(value):
    # Tally's ODBC driver reports zero parameter markers for '?'. Values are therefore
    # quoted here; embedded quotes are doubled and never become SQL syntax.
    if isinstance(value, date):
        value = value.strftime("%Y%m%d")
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"

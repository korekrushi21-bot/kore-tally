"""Local billing API for Jarvis. Listens on 127.0.0.1 only and needs the shared token in X-Billing-Token.

  GET  /health
  POST /draft    {voucher_type, party, items:[{name, quantity, rate?, gst_percent?}], narration?, date?}
  POST /confirm  {draft_id}
  POST /cancel   {draft_id}

/draft only reads Tally. Only /confirm writes, and only the exact draft that /draft returned (one new voucher).
"""
import json
import logging
import os
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from tally_client import TallyClient
from utils import setup_logging, ensure_utf8_streams
from voucher_service import VoucherError, VoucherService
from voucher_types import VOUCHER_SPECS

ROOT = Path(__file__).resolve().parent
MAX_BODY = 64 * 1024


def load_token() -> str:
    env = os.environ.get("TALLY_BILLING_TOKEN", "").strip()
    if env:
        return env
    path = ROOT / "billing_token.txt"
    if not path.exists():
        path.write_text(secrets.token_hex(24), encoding="utf-8")
    return path.read_text(encoding="utf-8").strip()


def make_handler(service: VoucherService, tally: TallyClient, token: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "BillingService"

        def log_message(self, fmt, *args):  # keep request details (names, amounts) out of the console
            logging.info("%s %s", self.command, self.path)

        def _send(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _authorised(self) -> bool:
            # A browser tab on any website could try to call localhost; browsers always send Origin, our caller never does.
            if self.headers.get("Origin"):
                return False
            sent = self.headers.get("X-Billing-Token", "")
            return secrets.compare_digest(sent.encode("utf-8"), token.encode("utf-8"))

        def do_GET(self):
            if not self._authorised():
                return self._send(401, {"ok": False, "error_code": "unauthorised"})
            if self.path != "/health":
                return self._send(404, {"ok": False, "error_code": "not_found"})
            connected = tally.test_connection()
            self._send(200, {
                "ok": True, "tally_connected": connected,
                "voucher_types": {k: service.writes_allowed(k) for k in VOUCHER_SPECS},
            })

        def do_POST(self):
            if not self._authorised():
                return self._send(401, {"ok": False, "error_code": "unauthorised"})
            if self.path not in ("/draft", "/confirm", "/cancel"):
                return self._send(404, {"ok": False, "error_code": "not_found"})
            if "application/json" not in (self.headers.get("Content-Type") or ""):
                return self._send(400, {"ok": False, "error_code": "bad_request"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= MAX_BODY:
                    raise ValueError("size")
                data = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("shape")
            except (ValueError, UnicodeDecodeError):
                return self._send(400, {"ok": False, "error_code": "bad_request"})

            try:
                if self.path == "/draft":
                    items = data.get("items")
                    if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
                        raise VoucherError("bad_request", "माल यादी समजली नाही.")
                    result = service.draft(
                        str(data.get("voucher_type", "")), str(data.get("party", "")), items,
                        narration=str(data.get("narration", ""))[:200], voucher_date=data.get("date"), source="jarvis",
                        rate_includes_gst=data.get("rate_includes_gst"),
                    )
                elif self.path == "/confirm":
                    result = service.confirm(str(data.get("draft_id", "")))
                else:
                    result = service.cancel(str(data.get("draft_id", "")))
                self._send(200, result)
            except VoucherError as err:
                self._send(200, err.to_dict())
            except ValueError as err:  # unsupported voucher type
                self._send(200, {"ok": False, "error_code": "bad_request", "message": str(err)})
            except ConnectionError as err:
                logging.warning("Tally unreachable: %s", err)
                self._send(200, {"ok": False, "error_code": "tally_unreachable",
                                 "message": "Tally उघडे नाही किंवा HTTP सर्व्हर चालू नाही. काहीही सेव्ह झालेले नाही."})
            except Exception:
                logging.exception("Unexpected billing error")
                self._send(500, {"ok": False, "error_code": "internal", "message": "अनपेक्षित त्रुटी. काहीही सेव्ह झाले नसेल तर पुन्हा प्रयत्न करा."})

    return Handler


def main():
    ensure_utf8_streams()
    config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    log_dir = ROOT / "logs"
    setup_logging(log_dir)
    tcfg = config["tally"]
    tally = TallyClient(tcfg["host"], tcfg["port"], tcfg.get("company", ""), tcfg.get("timeout", 10))
    service = VoucherService(tally, config, str(log_dir))
    token = load_token()

    port = int(config.get("billing_service", {}).get("port", 4300))
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(service, tally, token))
    print(f"Billing service on http://127.0.0.1:{port}  (Tally write: {'ON' if config.get('writes_enabled') else 'OFF'})")
    print(f"Token file: {ROOT / 'billing_token.txt'}  (Jarvis reads the same token)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())

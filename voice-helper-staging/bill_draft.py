import json
from datetime import datetime
from pathlib import Path


def save_draft(root, draft):
    """Save a local proposal only. This function never writes to Tally."""
    folder = Path(root) / "logs"
    folder.mkdir(exist_ok=True)
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

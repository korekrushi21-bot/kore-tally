"""PC Cleaner core: finds junk (temp files, caches, crash dumps) in a fixed list of
safe folders and removes it. Nothing outside those folders is ever touched.

CLI:
    python cleaner.py                 # dry run: only shows what would be removed
    python cleaner.py --clean         # actually remove
    python cleaner.py --clean --recycle-bin --quiet
"""
import argparse
import ctypes
import glob
import os
import stat
import subprocess
import tempfile
import time
from ctypes import wintypes
from dataclasses import dataclass
from datetime import datetime

LOCAL = os.environ.get("LOCALAPPDATA", "")
WINDIR = os.environ.get("WINDIR", r"C:\Windows")
LOG_DIR = os.path.join(LOCAL, "pc-cleaner")
LOG_FILE = os.path.join(LOG_DIR, "log.txt")


# Files that look like user data are never deleted from folders marked `protect`.
PROTECTED_EXT = frozenset((
    ".doc", ".docx", ".xls", ".xlsx", ".xlsm", ".csv", ".pdf", ".ppt", ".pptx", ".txt", ".rtf",
    ".odt", ".ods", ".xml", ".json", ".db", ".sqlite", ".mdb", ".accdb", ".bak", ".zip", ".rar",
    ".7z", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp", ".svg", ".psd", ".ai",
    ".mp4", ".mov", ".avi", ".mkv", ".mp3", ".wav", ".m4a", ".epub", ".dwg", ".key", ".pages",
    ".py", ".js", ".html", ".css", ".java", ".c", ".cpp", ".sql", ".md", ".ini", ".cfg", ".env",
    ".900", ".tsf", ".tdl", ".001", ".1800",  # Tally data, backups and TDL
))
# Cleaning is only ever allowed inside these two trees; Documents, Desktop, Downloads,
# other drives, etc. are never touched, even if a pattern above were edited by mistake.
ALLOWED_TREES = tuple(os.path.normcase(os.path.realpath(p)) for p in (LOCAL, WINDIR) if p)


def _is_allowed_root(root):
    root = os.path.normcase(os.path.realpath(root))
    return any(root == t or root.startswith(t + os.sep) for t in ALLOWED_TREES)


@dataclass(frozen=True)
class Target:
    key: str
    label: str
    patterns: tuple  # glob patterns; every match is a root folder to clean
    min_age_hours: int  # files newer than this are left alone (they may be in use)
    default_on: bool = True
    protect: bool = False  # keep files that look like user data


TARGETS = (
    Target("user_temp", "User temp files (old, non-document only)", (tempfile.gettempdir(),),
           168, default_on=False, protect=True),
    Target("win_temp", "Windows temp files (needs admin for full effect)",
           (os.path.join(WINDIR, "Temp"),), 168, default_on=False, protect=True),
    Target("crash", "Crash dumps and error reports", (
        os.path.join(LOCAL, "CrashDumps"),
        os.path.join(LOCAL, "Microsoft", "Windows", "WER", "ReportArchive"),
        os.path.join(LOCAL, "Microsoft", "Windows", "WER", "ReportQueue"),
    ), 0),
    Target("chrome", "Chrome cache", tuple(
        os.path.join(LOCAL, "Google", "Chrome", "User Data", "*", d)
        for d in ("Cache", "Code Cache", "GPUCache")), 72),
    Target("edge", "Edge cache", tuple(
        os.path.join(LOCAL, "Microsoft", "Edge", "User Data", "*", d)
        for d in ("Cache", "Code Cache", "GPUCache")), 72),
    Target("firefox", "Firefox cache",
           (os.path.join(LOCAL, "Mozilla", "Firefox", "Profiles", "*", "cache2"),), 72),
)


@dataclass
class Result:
    files: int = 0
    bytes: int = 0
    skipped: int = 0  # locked, too new, or unreadable


def _is_reparse(entry):
    # Never follow symlinks/junctions: they can point outside the whitelisted folders.
    try:
        attrs = entry.stat(follow_symlinks=False).st_file_attributes
    except (OSError, AttributeError):
        return True
    return bool(attrs & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _walk(root, cutoff, dry_run, res, protect=False):
    try:
        entries = list(os.scandir(root))
    except OSError:
        return
    for e in entries:
        if _is_reparse(e):
            continue
        if e.is_dir(follow_symlinks=False):
            _walk(e.path, cutoff, dry_run, res, protect)
            if not dry_run:
                try:
                    os.rmdir(e.path)  # only succeeds when the folder is empty
                except OSError:
                    pass
            continue
        try:
            st = e.stat(follow_symlinks=False)
        except OSError:
            res.skipped += 1
            continue
        if st.st_mtime > cutoff or (protect and os.path.splitext(e.name)[1].lower() in PROTECTED_EXT):
            res.skipped += 1
            continue
        if not dry_run:
            try:
                try:
                    os.remove(e.path)
                except PermissionError:
                    os.chmod(e.path, stat.S_IWRITE)  # read-only attribute
                    os.remove(e.path)
            except OSError:
                res.skipped += 1  # in use by another program
                continue
        res.files += 1
        res.bytes += st.st_size


def scan_target(target, dry_run=True):
    res = Result()
    cutoff = time.time() - target.min_age_hours * 3600
    for pattern in target.patterns:
        for root in glob.glob(pattern):
            if os.path.isdir(root) and _is_allowed_root(root):
                _walk(root, cutoff, dry_run, res, target.protect)
    return res


class _RBInfo(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("i64Size", ctypes.c_longlong),
                ("i64NumItems", ctypes.c_longlong)]


def recycle_bin_info():
    info = _RBInfo()
    info.cbSize = ctypes.sizeof(info)
    if ctypes.windll.shell32.SHQueryRecycleBinW(None, ctypes.byref(info)) == 0:
        return Result(files=info.i64NumItems, bytes=info.i64Size)
    return Result()


def empty_recycle_bin():
    # 7 = no confirmation dialog, no progress UI, no sound. Permanent!
    ctypes.windll.shell32.SHEmptyRecycleBinW(None, None, 7)


def flush_dns():
    subprocess.run(["ipconfig", "/flushdns"], capture_output=True,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def run(keys, recycle_bin=False, dry_run=True):
    """Scan or clean the given target keys. Returns {key: Result}."""
    out = {t.key: scan_target(t, dry_run) for t in TARGETS if t.key in keys}
    if recycle_bin:
        out["recycle_bin"] = recycle_bin_info()
        if not dry_run:
            empty_recycle_bin()
    if not dry_run:
        flush_dns()
        log(out)
    return out


def log(results):
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        freed = sum(r.bytes for r in results.values())
        files = sum(r.files for r in results.values())
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{datetime.now():%Y-%m-%d %H:%M} cleaned {files} files, {fmt(freed)}\n")
    except OSError:
        pass


def fmt(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--clean", action="store_true", help="really delete (default is dry run)")
    ap.add_argument("--recycle-bin", action="store_true", help="also empty the Recycle Bin (permanent)")
    ap.add_argument("--quiet", action="store_true", help="no output (for scheduled runs)")
    args = ap.parse_args()

    results = run({t.key for t in TARGETS if t.default_on}, args.recycle_bin, dry_run=not args.clean)
    if args.quiet:
        return
    verb = "Removed" if args.clean else "Would remove"
    labels = {t.key: t.label for t in TARGETS} | {"recycle_bin": "Recycle Bin"}
    for key, r in results.items():
        print(f"{labels[key]:<52} {r.files:>6} files  {fmt(r.bytes):>9}  (skipped {r.skipped})")
    print(f"\n{verb}: {sum(r.files for r in results.values())} files, "
          f"{fmt(sum(r.bytes for r in results.values()))}")
    if not args.clean:
        print("Dry run only. Nothing was deleted. Add --clean to delete.")


if __name__ == "__main__":
    main()

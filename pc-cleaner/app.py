"""PC Cleaner GUI. Run: pythonw app.py  (or python app.py)"""
import threading
import tkinter as tk
from tkinter import messagebox, ttk

import cleaner


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("PC Cleaner")
        self.geometry("520x420")
        self.resizable(False, False)

        ttk.Label(self, text="Clean junk files", font=("Segoe UI", 15, "bold")).pack(pady=(14, 2))
        ttk.Label(self, text="Only safe temp/cache folders. Files in use are skipped.",
                  foreground="#666").pack()

        box = ttk.Frame(self, padding=14)
        box.pack(fill="x")
        self.vars, self.size_labels = {}, {}
        rows = [(t.key, t.label, t.default_on) for t in cleaner.TARGETS]
        rows.append(("recycle_bin", "Recycle Bin (permanent, cannot undo)", False))
        for i, (key, label, on) in enumerate(rows):
            self.vars[key] = tk.BooleanVar(value=on)
            ttk.Checkbutton(box, text=label, variable=self.vars[key]).grid(row=i, column=0, sticky="w", pady=3)
            self.size_labels[key] = ttk.Label(box, text="-", width=12, anchor="e")
            self.size_labels[key].grid(row=i, column=1, padx=(12, 0))
        box.columnconfigure(0, weight=1)

        self.total = ttk.Label(self, text="", font=("Segoe UI", 11, "bold"))
        self.total.pack(pady=8)

        btns = ttk.Frame(self)
        btns.pack()
        self.scan_btn = ttk.Button(btns, text="Scan", command=lambda: self.start(dry_run=True))
        self.scan_btn.pack(side="left", padx=6)
        self.clean_btn = ttk.Button(btns, text="Clean now", command=self.confirm_clean)
        self.clean_btn.pack(side="left", padx=6)

        self.status = ttk.Label(self, text="Press Scan to see how much junk you have.", foreground="#666")
        self.status.pack(pady=10)

    def selected(self):
        return {k for k, v in self.vars.items() if v.get() and k != "recycle_bin"}, self.vars["recycle_bin"].get()

    def confirm_clean(self):
        _, rb = self.selected()
        msg = "Delete the selected junk files now?"
        if rb:
            msg += "\n\nThe Recycle Bin will be emptied permanently."
        if messagebox.askyesno("Confirm", msg):
            self.start(dry_run=False)

    def start(self, dry_run):
        keys, rb = self.selected()
        self.scan_btn.state(["disabled"])
        self.clean_btn.state(["disabled"])
        self.status.config(text="Scanning..." if dry_run else "Cleaning...")
        threading.Thread(target=self.work, args=(keys, rb, dry_run), daemon=True).start()

    def work(self, keys, rb, dry_run):
        results = cleaner.run(keys, rb, dry_run)
        self.after(0, self.done, results, dry_run)

    def done(self, results, dry_run):
        for key, r in results.items():
            self.size_labels[key].config(text=cleaner.fmt(r.bytes))
        total = sum(r.bytes for r in results.values())
        self.total.config(text=f"{'Can free' if dry_run else 'Freed'}: {cleaner.fmt(total)}")
        self.status.config(text="Scan finished." if dry_run else "Done. Some files in use were skipped.")
        self.scan_btn.state(["!disabled"])
        self.clean_btn.state(["!disabled"])


if __name__ == "__main__":
    App().mainloop()

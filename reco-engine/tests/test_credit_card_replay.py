#!/usr/bin/env python3
"""
test_credit_card_replay.py — leave-one-month-out replay of the credit card
classifier against the accountant's OWN booked working files.

Why leave-one-out: seeding the directory from all 12 months and then scoring
those same months is circular — it measures memorisation, not accuracy. For each
month M the directory is rebuilt from every month EXCEPT M, so the score answers
the question that actually matters: *given the history up to now, how much of
NEXT month books itself correctly?*

Ground truth is the accountant's Working sheet (narration → the ledger they
booked). This isolates CLASSIFICATION accuracy from PDF extraction accuracy —
extraction is the PDF → Bank Statement agent's job and is verified separately.

Usage:
    python3 tests/test_credit_card_replay.py "<folder>" --coa <coa.txt>
"""
import os
import re
import sys
import glob
import argparse
from collections import defaultdict

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, ".."))

from recon.credit_card_booking import (            # noqa: E402
    CardClassifier, merchant_key, extract_keys, _norm_ledger,
    _BANK_CHARGE_RE, _PAYMENT_RE,
)
sys.path.insert(0, os.path.join(_HERE, "..", "tools"))
from build_cc_seed import find_table, month_order   # noqa: E402


def load_months(folder):
    """[(order, label, [(narration, ledger), ...])] from every booked working sheet."""
    import openpyxl
    months = []
    for path in sorted(glob.glob(os.path.join(folder, "*", "*.xlsx"))):
        label = os.path.basename(os.path.dirname(path))
        order = month_order(label)
        rows = []
        try:
            wb = openpyxl.load_workbook(path, data_only=True)
        except Exception:
            continue
        for ws in wb.worksheets:
            hrow, idx = find_table(ws)
            if not idx:
                continue
            i_narr = idx.get("transaction details", 1)
            i_dr, i_cr = idx["debit"], idx["credit"]
            for row in ws.iter_rows(min_row=hrow + 1, values_only=True):
                if len(row) <= max(i_dr, i_cr, i_narr):
                    continue
                narr, dr, cr = row[i_narr], row[i_dr], row[i_cr]
                if not narr or (not dr and not cr):
                    continue
                narr = str(narr)
                if _PAYMENT_RE.search(narr):
                    continue
                dr_s, cr_s = str(dr or "").strip(), str(cr or "").strip()
                ledger = dr_s if "credit card" not in cr_s.lower() else cr_s
                if "credit card" in ledger.lower():
                    ledger = cr_s if "credit card" in dr_s.lower() else dr_s
                if not ledger:
                    continue
                rows.append((narr, ledger.strip()))
        if rows:
            months.append((order, label, rows))
    return sorted(months)


def build_directory(months, exclude_order):
    """Mine a directory from every month except `exclude_order`."""
    observed = defaultdict(list)
    for order, _label, rows in months:
        if order == exclude_order:
            continue
        for narr, ledger in rows:
            if _norm_ledger(ledger) == "suspense" or _BANK_CHARGE_RE.search(narr):
                continue
            for kt, key in extract_keys(narr):
                observed[(kt, key)].append((order, ledger))
    return [{"key_type": kt, "key_value": k, "ledger": max(v)[1]}
            for (kt, k), v in observed.items()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--coa", help="newline-delimited ledger names")
    ap.add_argument("--llm", action="store_true", help="enable the L3 Claude layer")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    coa = []
    if args.coa and os.path.exists(args.coa):
        with open(args.coa, encoding="utf-8") as fh:
            coa = [l.strip() for l in fh if l.strip()]

    llm = None
    if args.llm:
        from recon.credit_card_booking import make_llm_batch_resolver
        llm = make_llm_batch_resolver(coa)
        print("L3 Claude layer:", "ENABLED" if llm else "no credential — DISABLED")

    months = load_months(args.folder)
    if not months:
        print("No booked working sheets found.", file=sys.stderr)
        return 1

    print(f"COA ledgers: {len(coa)}   months with booked rows: {len(months)}\n")
    print(f"{'month':22s} {'rows':>5s} {'match':>6s} {'rate':>7s}   layers")
    print("-" * 86)

    tot = hit = 0
    layer_tally = defaultdict(int)
    mismatches = []

    for order, label, rows in months:
        directory = build_directory(months, exclude_order=order)
        clf = CardClassifier(coa=coa, directory=directory,
                             card_ledger="Yes Bank Credit Card", llm=llm)
        m_hit = 0
        m_layers = defaultdict(int)
        outcomes = clf.classify_all([n for n, _ in rows])
        for (narr, truth), res in zip(rows, outcomes):
            got = res["ledger"]
            m_layers[res["layer"]] += 1
            layer_tally[res["layer"]] += 1
            if _norm_ledger(got) == _norm_ledger(truth):
                m_hit += 1
            else:
                mismatches.append((label, narr[:66], truth, got, res["layer"]))
        tot += len(rows)
        hit += m_hit
        rate = 100.0 * m_hit / len(rows)
        layers = " ".join(f"{k}={v}" for k, v in sorted(m_layers.items()))
        print(f"{label:22s} {len(rows):5d} {m_hit:6d} {rate:6.1f}%   {layers}")

    print("-" * 86)
    print(f"{'TOTAL':22s} {tot:5d} {hit:6d} {100.0 * hit / tot:6.1f}%")
    print("\nlayer usage: " + "  ".join(f"{k}={v}" for k, v in sorted(layer_tally.items())))
    if llm is not None and getattr(llm, "stats", None):
        st = llm.stats
        tok_in = sum((u.get("prompt_tokens") or u.get("input_tokens") or 0) for u in st["usage"])
        cache_r = sum((u.get("cache_read_input_tokens") or 0) for u in st["usage"])
        cache_w = sum((u.get("cache_creation_input_tokens") or 0) for u in st["usage"])
        print(f"LLM: {st['calls']} calls  input_tokens={tok_in}  "
              f"cache_write={cache_w}  cache_read={cache_r}")

    if mismatches:
        print(f"\nmismatches ({len(mismatches)}):")
        for label, narr, truth, got, layer in mismatches:
            print(f"  [{label}] {narr}")
            print(f"      expected {truth!r}")
            print(f"      got      {got!r}   (via {layer})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

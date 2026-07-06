#!/usr/bin/env python3
"""
test_pdf_bank.py — Regression harness for the PDF → Bank Statement extractor.

Runs every fixture in tests/fixtures/bank_pdf/ through extract_bank_statement()
and self-checks each one against the statement's OWN printed totals and/or
running-balance continuity (no manual answer keys needed).

Usage:
    python3 tests/test_pdf_bank.py                # summary table + PASS/FAIL
    python3 tests/test_pdf_bank.py --debug         # + column detection dump per file
    python3 tests/test_pdf_bank.py ICICI           # only fixtures whose name matches

A fixture PASSES when validation.verified is True (totals matched OR balance
reconciled). Financially critical == amounts/balance reconcile; description
text quality is reported but not asserted.
"""
import os
import sys
import glob

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from recon.pdf_bank_extractor import extract_bank_statement  # noqa: E402

FIX_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "bank_pdf")


def _fmt(v):
    return f"{v:,.2f}" if isinstance(v, (int, float)) else str(v)


def run(debug=False, name_filter=None):
    pdfs = sorted(glob.glob(os.path.join(FIX_DIR, "*.pdf")) +
                  glob.glob(os.path.join(FIX_DIR, "*.PDF")))
    if name_filter:
        pdfs = [p for p in pdfs if name_filter.lower() in os.path.basename(p).lower()]
    if not pdfs:
        print(f"No fixtures in {FIX_DIR}")
        return 1

    results = []
    for path in pdfs:
        base = os.path.basename(path)
        try:
            with open(path, "rb") as fh:
                data = extract_bank_statement(fh.read())
        except Exception as e:
            print(f"\n### {base}: EXTRACTION CRASHED: {e}")
            import traceback
            traceback.print_exc()
            results.append((base, "CRASH", 0, None))
            continue

        val = data.get("validation", {})
        verified = val.get("verified")
        method = val.get("verify_method")
        n = data.get("transaction_count", 0)

        print("\n" + "=" * 100)
        print(f"### {base}")
        print(f"  Bank: {data.get('bank_name') or '?'}   Account: {data.get('account_no') or '?'}"
              f"   Period: {data.get('period_from')}–{data.get('period_to')}")
        cols = data.get("columns")
        if cols:
            print(f"  Columns ({len(cols)}): {cols}")
        print(f"  Rows: {n}")
        print(f"  Debit : computed={_fmt(val.get('computed_total_debit'))}  "
              f"pdf={_fmt(val.get('pdf_total_debit'))}")
        print(f"  Credit: computed={_fmt(val.get('computed_total_credit'))}  "
              f"pdf={_fmt(val.get('pdf_total_credit'))}")
        print(f"  Opening={_fmt(val.get('opening_balance'))}  Closing={_fmt(val.get('closing_balance'))}")
        print(f"  Balance continuity: {val.get('balance_rows_checked')} checked, "
              f"{val.get('balance_mismatches')} mismatches")
        print(f"  >>> verified={verified}  method={method}")

        if debug:
            print("  --- first 12 rows ---")
            for t in data.get("transactions", [])[:12]:
                if "cells" in t:  # dynamic-column format
                    print("   ", {k: (v[:40] if isinstance(v, str) else v) for k, v in t["cells"].items()})
                else:
                    print(f"    {t.get('date'):<12} D={_fmt(t.get('debit'))} C={_fmt(t.get('credit'))} "
                          f"B={_fmt(t.get('balance'))}  {str(t.get('description'))[:60]}")

        results.append((base, "PASS" if verified else "FAIL", n, method))

    print("\n" + "=" * 100)
    print("SUMMARY")
    fails = 0
    for base, status, n, method in results:
        mark = "✅" if status == "PASS" else "❌"
        print(f"  {mark} {status:<5} {base:<32} rows={n:<5} method={method}")
        if status != "PASS":
            fails += 1
    print(f"\n{len(results) - fails}/{len(results)} passed")
    return 1 if fails else 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    debug = "--debug" in sys.argv
    sys.exit(run(debug=debug, name_filter=args[0] if args else None))

#!/usr/bin/env python3
"""
test_cc_key_parity.py — the Node controller and the Python agent MUST derive
identical directory keys.

Why this test exists: creditCardController.js WRITES the keys that
credit_card_booking.py READS. If the two implementations drift by even one
character, every correction a reviewer makes is stored under a key the
classifier never looks up — the learning loop silently stops working while
appearing to succeed. That is not hypothetical: the first version of the JS
regex lost the curly-quote acquirer separator, so 'PYU"FIipkart' produced
'PYU FIIPKART' in Node and 'FIIPKART' in Python, on 10 of 371 real narrations.

Runs the real narrations from a folder of statements (or a built-in sample)
through both implementations and diffs them.

Usage:
    python3 tests/test_cc_key_parity.py [folder-of-statements]
"""
import os
import sys
import json
import glob
import subprocess

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, ".."))
from recon.credit_card_booking import merchant_key, extract_keys   # noqa: E402

_CONTROLLER = os.path.join(
    _HERE, "..", "..", "new-backend", "src", "controllers", "creditCardController.js")

# Used when no statement folder is given — covers every transform that differs
# between the two languages: acquirer prefixes (straight AND curly separators),
# the M/S. prefix, ref tails, forex continuation lines, merchant categories,
# location/legal noise tokens, and OCR damage.
SAMPLES = [
    'RAZ*Shopify Commerce S Mumbai IND - Ref No: MT250930249000010013100',
    'RAZ”Shopify Commerce S Bangalore IND - Ref No: MT260370367000010003227',
    'PYU”FIipkart Bengaluru IND - Ref No: MT260160305000010000244',
    'PYU*FIipkart Bengaluru IND - Ref No: MT260160305000010000243',
    'RAZ“MacroIix Bangalore IND - Ref No: MT252680251000010007883',
    'M/S. BVC TRADEPORT Mumbai IND - Ref No: MT260140275000010025672',
    'PAY*BIGFOOT RETAIL SOL https://www.s IND - Ref No: MT250850251000010007126',
    'Easebuzz*SHOPFLO SouthWestDelh  IND - Ref No: MT251140302000010020887',
    'HELIUM10.COM  IRVINE CA - Ref No: MT260150456000010001807 15/01/26 129.00 USD',
    'BSESR MUMBAI MAH - Ref No: MT250890269000010003405 Utiity Services',
    'RAZ*Shiprocket Private Gurgaon IND - Ref No: MT250850251000010015189 Transportation Services',
    'FOREIGN CURRENCY  MARKUP FEE - Ref No: MT260150456000010001807',
    'GOODS & SERVICES TAX - GST @ 18%',
    'AMAZON PAY INDIA Pvt L Bangalore IND - Ref No: MT260200278000010028047',
]


def narrations_from(folder):
    import openpyxl
    out = set()
    for path in sorted(glob.glob(os.path.join(folder, "*", "*.xlsx"))):
        try:
            wb = openpyxl.load_workbook(path, data_only=True)
        except Exception:
            continue
        for ws in wb.worksheets:
            for row in ws.iter_rows(min_row=1, max_row=250, values_only=True):
                for v in row:
                    if isinstance(v, str) and "Ref No" in v and len(v) > 25:
                        out.add(" ".join(v.split()))
    return sorted(out)


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else None
    narrations = narrations_from(folder) if folder and os.path.isdir(folder) else SAMPLES
    if not narrations:
        narrations = SAMPLES

    expected = {n: {"mk": merchant_key(n),
                    "keys": [list(k) for k in extract_keys(n)]} for n in narrations}

    node_script = """
const path = process.argv[1], data = JSON.parse(process.argv[2]);
const { merchantKey, extractKeys } = require(path);
const out = {};
for (const n of Object.keys(data)) {
  out[n] = { mk: merchantKey(n), keys: extractKeys(n).map(k => [k.key_type, k.key_value]) };
}
process.stdout.write('@@JSON@@' + JSON.stringify(out));
"""
    proc = subprocess.run(
        ["node", "-e", node_script, os.path.abspath(_CONTROLLER), json.dumps(expected)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print("node failed:\n", proc.stderr[:2000], file=sys.stderr)
        return 2
    marker = proc.stdout.find("@@JSON@@")          # skip dotenv/other stdout noise
    if marker < 0:
        print("no JSON from node:\n", proc.stdout[:800], file=sys.stderr)
        return 2
    got = json.loads(proc.stdout[marker + len("@@JSON@@"):])

    mk_bad = keys_bad = 0
    for n, exp in expected.items():
        g = got.get(n) or {}
        if g.get("mk") != exp["mk"]:
            mk_bad += 1
            if mk_bad <= 8:
                print(f"  merchantKey  py={exp['mk']!r}  js={g.get('mk')!r}\n     <- {n[:70]}")
        if g.get("keys") != exp["keys"]:
            keys_bad += 1
            if keys_bad <= 5:
                print(f"  extractKeys\n     py={exp['keys']}\n     js={g.get('keys')}")

    print(f"\nnarrations: {len(narrations)}   merchantKey mismatches: {mk_bad}   "
          f"extractKeys mismatches: {keys_bad}")
    ok = mk_bad == 0 and keys_bad == 0
    print("PARITY PASS — Node writes exactly the keys Python reads" if ok else "PARITY FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

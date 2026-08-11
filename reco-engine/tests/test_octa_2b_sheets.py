"""OCTA sheet-detection regression harness for GSTR-2B vs Books (+ multistate).

Locks parse counts + money totals across OCTA and GST-portal 2B files so the
OCTA sheet-scan fix cannot silently change the portal path.

Run:  python3.14 octa_harness.py            # print current results
      python3.14 octa_harness.py --check    # compare against BASELINE, exit 1 on drift
"""
import os
import sys

ENGINE = "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation/reco-engine"
sys.path.insert(0, ENGINE)

from recon.gstr_2b_books import parse_gstr2b, _is_octa_format  # noqa: E402
from recon.gstr_2b_books_multistate import (  # noqa: E402
    reconcile_gstr2b_vs_books_multistate,
)

DL = "/Users/dhavalchauhan/Downloads/"

CASES = [
    ("DRIPS-octa",        DL + "GSTR2B-DRIPS FOODS PRIVATE LIMITED-Apr 2025-Mar 2026.xlsx"),
    ("BIGLIL-octa",       DL + "GSTR2B-BIGLILPEOPLE PRIVATE LIMITED-Karnataka-Apr 2025-Mar 2026.xlsx"),
    ("KYOREN-octa-cover", DL + "GSTR2B-KYOREN LABS PRIVATE LIMITED-Maharashtra-Apr 2025-Mar 2026.xlsx"),
    ("PORTAL-HR",         DL + "GSTR1 Vs Books/HR102024_06AAECF7751Q1Z0_GSTR2B_21042025.xlsx"),
    ("PORTAL-TN",         DL + "GSTR1 Vs Books/TN102024_33AAECF7751Q1Z3_GSTR2B_23042025.xlsx"),
    ("PORTAL-UP",         DL + "GSTR1 Vs Books/UP102024_09AAECF7751Q1ZU_GSTR2B_23042025 (1).xlsx"),
]


def measure(path):
    """Parse one 2B file and summarise it. Also runs the multistate wrapper to
    confirm the base-module fix propagates through it."""
    data = open(path, "rb").read()
    recs = parse_gstr2b(data)
    ms_recs, _, _ = reconcile_gstr2b_vs_books_multistate([data], [], [])
    return {
        "octa": _is_octa_format(data),
        "n": len(recs),
        "n_multistate": len(ms_recs),
        "taxable": round(sum(r.taxable_value for r in recs), 2),
        "tax": round(sum(r.igst + r.cgst + r.sgst + r.cess for r in recs), 2),
        "crn": sum(1 for r in recs if r.doc_type == "CRN"),
        "dbn": sum(1 for r in recs if r.doc_type == "DBN"),
        "no_gstin": sum(1 for r in recs if not r.supplier_gstin),
        "no_date": sum(1 for r in recs if not r.doc_date),
    }


def run():
    out = {}
    for name, path in CASES:
        if not os.path.exists(path):
            print(f"  SKIP {name}: file not found")
            continue
        try:
            out[name] = measure(path)
        except Exception as e:
            out[name] = {"error": f"{type(e).__name__}: {e}"}
    return out


# Locked from the pre-fix run. KYOREN was the only case the OCTA sheet-scan fix was
# allowed to change (0 -> 138); every other case must stay byte-identical.
BASELINE = {
    "DRIPS-octa":        {"octa": True,  "n": 2155, "n_multistate": 2155, "taxable": 62683607.41, "tax": 9171778.27, "crn": 123, "dbn": 2,  "no_gstin": 2, "no_date": 0},
    "BIGLIL-octa":       {"octa": True,  "n": 1431, "n_multistate": 1431, "taxable": 59692101.46, "tax": 7352157.5,  "crn": 103, "dbn": 12, "no_gstin": 0, "no_date": 0},
    "KYOREN-octa-cover": {"octa": True,  "n": 138,  "n_multistate": 138,  "taxable": 3708942.2,   "tax": 592544.13,  "crn": 1,   "dbn": 2,  "no_gstin": 0, "no_date": 0},
    "PORTAL-HR":         {"octa": False, "n": 53,   "n_multistate": 53,   "taxable": 17835704.76, "tax": 3207546.91, "crn": 3,   "dbn": 0,  "no_gstin": 0, "no_date": 0},
    "PORTAL-TN":         {"octa": False, "n": 7,    "n_multistate": 7,    "taxable": 8854640.0,   "tax": 1593834.88, "crn": 1,   "dbn": 0,  "no_gstin": 0, "no_date": 0},
    "PORTAL-UP":         {"octa": False, "n": 11,   "n_multistate": 11,   "taxable": 3972605.32,  "tax": 647136.56,  "crn": 2,   "dbn": 0,  "no_gstin": 0, "no_date": 0},
}

def check_party_sim():
    """Lock the CN<->DN party-name matching used by Pass 2.5.

    A GST legal name must link to the shortened Tally ledger name the client books
    under, without letting unrelated vendors through."""
    from recon.gstr_2b_books import _party_sim

    should_match = [
        # ledger name drops words the legal name carries
        ("vdbs consultancy Services Private Limited", "VDBS-Consultant"),
        ("RADCOM PACKAGING PRIVATE LIMITED", "Radcom Packaging"),
        # legal-form spelling variants
        ("AMAZON SELLER SERVICES PRIVATE LIMITED", "AMAZON SELLER SERVICES PVT LTD"),
        ("AIR INDIA LIMITED", "Air India Limited"),
    ]
    should_not = [
        ("RADCOM PACKAGING PRIVATE LIMITED", "AIR INDIA LIMITED"),
        ("GIG PRODUCTION PVT LTD", "GOOGLE INDIA PVT LTD"),
        # a shared generic word is not a shared identity
        ("ADARSH INDUSTRIES", "BAJAJ INDUSTRIES"),
        ("A2Z BOX PRIVATE LIMITED", "COLOUR BOX"),
        # coincidental prefix: international / internet
        ("ABHAYA INTERNATIONAL LLP", "FLIPKART INTERNET PRIVATE LIMITED"),
        ("IKEA INDIA PRIVATE LIMITED", "IDEA INDIA PRIVATE LIMITED"),
        # same leading word, different company
        ("vdbs consultancy Services Private Limited", "VDBS Traders"),
        # same corporate group, distinct legal entities
        ("AIR INDIA CHARTERS LIMITED", "AIR INDIA EXPRESS LIMITED"),
    ]
    bad = []
    for a, b in should_match:
        if _party_sim(a, b) < 0.5:
            bad.append(f"  SHOULD match but scored {_party_sim(a, b):.2f}: {a!r} vs {b!r}")
    for a, b in should_not:
        if _party_sim(a, b) >= 0.5:
            bad.append(f"  SHOULD NOT match but scored {_party_sim(a, b):.2f}: {a!r} vs {b!r}")
    return bad


if __name__ == "__main__":
    res = run()
    for name, r in res.items():
        print(f"{name:20s} {r}")

    if "--check" in sys.argv:
        party_bad = check_party_sim()
        print()
        if party_bad:
            print("PARTY-NAME MATCHING FAILURES:")
            print("\n".join(party_bad))
            sys.exit(1)
        print("OK - party-name (CN<->DN) matching behaves")

    if "--check" in sys.argv and BASELINE:
        drift = []
        for name, exp in BASELINE.items():
            got = res.get(name)
            if got != exp:
                drift.append(f"  {name}\n    expected {exp}\n    got      {got}")
        print()
        if drift:
            print("DRIFT DETECTED:")
            print("\n".join(drift))
            sys.exit(1)
        print(f"OK - all {len(BASELINE)} cases match baseline")

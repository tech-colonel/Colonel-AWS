import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from classify import extract_payee_keys

CASES = [
    ("NEFT/000368456767/UTIB/Busybees Logistics Solution", "busybees logistics solution"),
    ("NEFT/N092242963338667/PEPPERFRY LIMITED/HDFC/00024",  "pepperfry limited"),
    ("NEFT/CMS4059809711/NDX P2P PRIVATE LIMITED  LENDER",  "ndx p2p private limited lender"),
    ("RTGS/UTIBH24093331602/RAZORPAY SOFTWARE PRIVATE LI",  "razorpay software private li"),
    ("IMPS 409317366881 FROM SNOOZE HUB COMFORT S",         "snooze hub comfort s"),
]
def test_neft_slash_payee():
    for narr, expect in CASES:
        keys = extract_payee_keys(narr)
        assert keys.get("neft_name") == expect, f"{narr!r} -> {keys.get('neft_name')!r} != {expect!r}"
    # existing behavior preserved: phone + vpa still extracted
    assert extract_payee_keys("UPI/409/FLOPES/7989617179@YBL").get("vpa") == "7989617179@ybl"
    assert extract_payee_keys("IMPS 999 FROM 9876543210 ABC").get("phone") == "9876543210"
    # NEFT numeric ref must NOT become a key
    assert not any(v == "000368456767" for v in extract_payee_keys(CASES[0][0]).values())
    print("test_neft_slash_payee PASS")


def test_imps_from_junk_token_filtering():
    # IMPS-FROM trailing text that is purely numeric must NOT become neft_name
    # (it's an account number, not a payee) -- but the phone key must still
    # be extracted from that same 10-digit number.
    keys = extract_payee_keys("IMPS 409317366881 FROM 9998887771")
    assert not keys.get("neft_name"), f"expected no neft_name, got {keys.get('neft_name')!r}"
    assert keys.get("phone") == "9998887771"

    # IMPS-FROM trailing text with an embedded bank-code+account-number token
    # (e.g. "UTIB0001234") must have that token dropped, keeping only the name.
    keys2 = extract_payee_keys("IMPS 409 FROM UTIB0001234 RAJESH KUMAR")
    assert keys2.get("neft_name") == "rajesh kumar", keys2.get("neft_name")

    print("test_imps_from_junk_token_filtering PASS")


def test_slash_neft_single_word_payee_not_dropped():
    # A legitimate longer single-word payee must NOT be misclassified as a
    # bank code (old regex ^[A-Z]{4}[A-Z0-9]*$ would have wrongly dropped it).
    keys = extract_payee_keys("NEFT/000/RAZORPAY")
    assert keys.get("neft_name") == "razorpay", keys.get("neft_name")
    print("test_slash_neft_single_word_payee_not_dropped PASS")


def test_neft_ref_not_phone_key():
    # NEFT reference like 'CMS4059809711' must NOT become a phone key.
    # The 10-digit tail "4059809711" does not start with [6-9] so it fails the constraint.
    # Existing tests ensure neft_name is still extracted correctly.
    keys = extract_payee_keys('NEFT/CMS4059809711/NDX P2P PRIVATE LIMITED  LENDER')
    assert 'phone' not in keys or keys.get('phone') != '4059809711', \
        f"NEFT ref should NOT leak as phone key, got {keys.get('phone')!r}"
    assert keys.get('neft_name') == 'ndx p2p private limited lender', \
        f"neft_name extraction broken, got {keys.get('neft_name')!r}"

    # But real Indian mobiles starting with [6-9] MUST still work
    keys2 = extract_payee_keys('IMPS 999 FROM 9876543210 ABC')
    assert keys2.get('phone') == '9876543210', f"Expected phone 9876543210, got {keys2.get('phone')!r}"

    keys3 = extract_payee_keys('UPI/409/FLOPES/7989617179@YBL')
    assert keys3.get('phone') == '7989617179', f"Expected phone 7989617179, got {keys3.get('phone')!r}"

    print("test_neft_ref_not_phone_key PASS")


def test_shared_fixtures_parity():
    """Assert the SHARED fixture file — the same cases tests/test_payee_keys_parity.js
    runs against the JS writer. This file is the READER; if the two disagree, every
    correction is stored under a key the classifier never looks up (which is exactly how
    598 learned Urban Plant entries came to match 0 of 261 rows)."""
    import json
    fixtures_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 'payee_key_fixtures.json')
    with open(fixtures_path, 'r', encoding='utf-8') as fh:
        fixtures = json.load(fh)

    identity = ('phone', 'vpa', 'name', 'neft_name')
    failures = []
    for case in fixtures['cases']:
        got = extract_payee_keys(case['narration'])
        actual = {k: got[k] for k in identity if got.get(k)}
        want = case.get('keys') or {}
        if actual != want:
            failures.append(f"  {case['narration']}\n"
                            f"    want {want}\n    got  {actual}\n    why  {case['why']}")
    assert not failures, ("shared payee-key fixtures failed (JS writer / Python reader "
                          "would disagree):\n" + "\n".join(failures))
    print(f"test_shared_fixtures_parity PASS ({len(fixtures['cases'])} cases)")


if __name__ == "__main__":
    test_neft_slash_payee()
    test_imps_from_junk_token_filtering()
    test_slash_neft_single_word_payee_not_dropped()
    test_neft_ref_not_phone_key()
    test_shared_fixtures_parity()
    print("ALL PASS")

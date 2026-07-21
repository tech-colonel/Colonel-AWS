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
if __name__ == "__main__":
    test_neft_slash_payee(); print("ALL PASS")

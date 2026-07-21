import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from bank_reco import parse_tally, parse_tally_opening, parse_bank_output, normalize_party, party_matches

TALLY = "/Users/dhavalchauhan/Dhaval/Bank RECO/Bank Statement Apr 24-25 Tally.xls"

def _make_universal_fixture(tmp_path="/tmp/bank_reco_fixture.xlsx"):
    import openpyxl
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Bank Statement"
    ws.append(["Txn Date","Description","Chq / Ref No.","Debit","Credit","Balance","Type","Ledger Name","Confidence"])
    ws.append(["02-04-2024","NEFT/000/Busybees Logistics Solution","", 518708.32, "", 100.0, "Payment", "Busybees Logistics Solutions Pvt.Ltd.", "High"])
    ws.append(["01-04-2024","NEFT/PEPPERFRY LIMITED","", "", 26612.21, 200.0, "Receipt", "Peprfry Sales", "High"])
    wb.save(tmp_path); return tmp_path

def test_parse_tally_basic():
    rows = parse_tally(TALLY)
    assert len(rows) > 100, f"expected many rows, got {len(rows)}"
    # every row has a direction and exactly one nonzero amount
    for r in rows[:50]:
        assert r["direction"] in ("in", "out")
        assert (r["debit"] > 0) != (r["credit"] > 0), r
        assert r["party"], f"empty party: {r}"
    # opening balance is parsed and positive
    ob = parse_tally_opening(TALLY)
    assert ob and ob > 0, ob
    # verify that all parties contain at least one alphabetic character (footer rows excluded)
    for r in rows:
        assert any(c.isalpha() for c in r["party"]), f"party has no alphabetic chars: {r['party']}"
    # verify no summary/footer label leaked into parsed rows as a fabricated transaction
    for r in rows:
        p = r["party"].lower()
        assert "closing balance" not in p, f"Closing Balance row leaked into parsed output: {r}"
        assert "opening balance" not in p, f"Opening Balance row leaked into parsed output: {r}"
        assert "grand total" not in p, f"Grand Total row leaked into parsed output: {r}"
    # the specific phantom transaction must be gone
    assert not any(r["party"].strip().lower() == "closing balance" for r in rows), \
        "phantom 'Closing Balance' transaction present in parsed output"
    print("test_parse_tally_basic PASS")

def test_parse_bank_output():
    p = _make_universal_fixture()
    rows = parse_bank_output(p)
    assert len(rows) == 2, rows
    assert rows[0]["direction"] == "out" and rows[0]["debit"] == 518708.32
    assert rows[1]["direction"] == "in" and rows[1]["credit"] == 26612.21
    assert rows[1]["ledger"] == "Peprfry Sales"
    print("test_parse_bank_output PASS")

def test_party_normalize_and_match():
    assert normalize_party("Busybees Logistics Solutions Pvt.Ltd.-Delhi") == normalize_party("Busybees Logistics Solutions Pvt Ltd")
    assert party_matches("Peprfry Sales", "peprfry sales")
    assert party_matches("Flo Sleep Solutions ( Gurgaon )", "Flo Sleep Solutions (Gurgaon)")
    assert not party_matches("Bank Charges", "Worker Salary Payable")
    print("test_party_normalize_and_match PASS")

if __name__ == "__main__":
    test_parse_tally_basic()
    test_parse_bank_output()
    test_party_normalize_and_match()
    print("ALL PASS")

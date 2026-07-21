import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from bank_reco import parse_tally, parse_tally_opening, parse_bank_output, normalize_party, party_matches, reconcile
import datetime as dt

def test_bracket_and_alias_matching():
    assert party_matches("Aurorax Private Limited (BharatX)", "Bharat X")      # bracket + de-space
    assert party_matches("Aurorax Private Limited (BharatX)", "Aurorax Private Limited")  # one company, name w/o bracket
    assert party_matches("Instakart Services Pvt. Ltd. - COD", "E Kart COD")   # alias group
    assert party_matches("Amazon Seller Receipt", "AMAZON_IN")                 # alias group
    assert not party_matches("Bank Charges", "Worker Salary Payable")          # no over-match
    print("test_bracket_and_alias_matching PASS")

def test_busybees_delhi_tag_still_matches_untagged():
    assert party_matches("Busybees Logistics Solutions Pvt.Ltd.-Delhi", "Busybees Logistics Solutions Pvt.Ltd.")
    print("test_busybees_delhi_tag_still_matches_untagged PASS")

def test_distinguishing_branch_tags_block_full_match():
    # Different branches of the SAME parent must NOT full-match, even though the stripped
    # base name collapses to one string -- this is the over-merge bug being fixed.
    assert not party_matches("Flo Sleep Solutions (Vasai)", "Flo Sleep Solutions (Hyderabad)")
    assert not party_matches("Flo Sleep Solutions (Medchal)", "Flo Sleep Solutions (HYD)")
    assert not party_matches("Flo Sleep Solutions (Chennai)", "Flo Sleep Solutions (BLR)")
    print("test_distinguishing_branch_tags_block_full_match PASS")

def test_partial_tier():
    tally = [{"date": dt.datetime(2024,4,2),"party":"Some Unknown Vendor","narration":"","vch_type":"","vch_no":"V9","debit":0.0,"credit":5000.0,"direction":"out","row":50}]
    bank  = [{"txn_date": dt.datetime(2024,4,2),"description":"x","chq_ref":"","debit":5000.0,"credit":0.0,"balance":0,"type":"Payment","ledger":"Totally Different Name","confidence":"High","direction":"out","row":9}]
    r = reconcile(tally, bank)
    assert r["counts"]["matched"] == 0
    assert r["counts"]["partial"] == 1, r["counts"]
    assert r["counts"]["bank_only"] == 0 and r["counts"]["tally_only"] == 0
    print("test_partial_tier PASS")

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

def test_reconcile_buckets():
    tally = [
        {"date": dt.datetime(2024,4,2), "party":"Busybees Logistics Solutions Pvt Ltd","narration":"","vch_type":"","vch_no":"V1","debit":0.0,"credit":518708.32,"direction":"out","row":11},
        {"date": dt.datetime(2024,4,1), "party":"Peprfry Sales","narration":"","vch_type":"","vch_no":"V2","debit":26612.21,"credit":0.0,"direction":"in","row":12},
        {"date": dt.datetime(2024,4,9), "party":"Ghost Vendor","narration":"","vch_type":"","vch_no":"V3","debit":0.0,"credit":999.0,"direction":"out","row":13},
    ]
    bank = [
        {"txn_date": dt.datetime(2024,4,3),"description":"x","chq_ref":"","debit":518708.32,"credit":0.0,"balance":0,"type":"Payment","ledger":"Busybees Logistics Solutions Pvt.Ltd.-Delhi","confidence":"High","direction":"out","row":2},
        {"txn_date": dt.datetime(2024,4,1),"description":"y","chq_ref":"","debit":0.0,"credit":26612.21,"balance":0,"type":"Receipt","ledger":"Peprfry Sales","confidence":"High","direction":"in","row":3},
        {"txn_date": dt.datetime(2024,4,5),"description":"charge","chq_ref":"","debit":500.0,"credit":0.0,"balance":0,"type":"Payment","ledger":"Bank Charges","confidence":"High","direction":"out","row":4},
    ]
    res = reconcile(tally, bank)
    assert res["counts"]["matched"] == 2, res["counts"]
    assert res["counts"]["bank_only"] == 1, res["counts"]      # Bank Charges
    assert res["counts"]["tally_only"] == 1, res["counts"]     # Ghost Vendor
    # Busybees: dates differ (4/2 vs 4/3) -> date_changed True, new_date = bank txn date
    busy = [m for m in res["matched"] if "usybees" in m["tally"]["party"]][0]
    assert busy["date_changed"] and busy["new_date"].date() == dt.date(2024,4,3)
    # Peprfry: same date -> not changed
    pep = [m for m in res["matched"] if m["tally"]["party"] == "Peprfry Sales"][0]
    assert not pep["date_changed"]
    assert res["counts"]["date_updated"] == 1
    print("test_reconcile_buckets PASS")

if __name__ == "__main__":
    test_parse_tally_basic()
    test_parse_bank_output()
    test_party_normalize_and_match()
    test_reconcile_buckets()
    test_bracket_and_alias_matching()
    test_busybees_delhi_tag_still_matches_untagged()
    test_distinguishing_branch_tags_block_full_match()
    test_partial_tier()
    print("ALL PASS")

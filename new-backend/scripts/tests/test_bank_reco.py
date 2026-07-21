import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from bank_reco import parse_tally, parse_tally_opening

TALLY = "/Users/dhavalchauhan/Dhaval/Bank RECO/Bank Statement Apr 24-25 Tally.xls"

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
    print("test_parse_tally_basic PASS")

if __name__ == "__main__":
    test_parse_tally_basic()
    print("ALL PASS")

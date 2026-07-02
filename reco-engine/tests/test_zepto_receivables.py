import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from recon.zepto_receivables import norm_po, norm_inv, dn_ref_to_invoice

def test_normalizers_and_dn_transform():
    assert norm_po(" p4143483 ") == "P4143483"
    assert norm_po(3100356806) == "3100356806"      # int -> str, no ".0"
    assert norm_po(3100356806.0) == "3100356806"    # float-like -> no ".0"
    assert norm_inv(" inv26-27/000007 ") == "INV26-27/000007"
    assert dn_ref_to_invoice("V26-27/000007_QD") == "INV26-27/000007"
    assert dn_ref_to_invoice("V26-27/000007_PD") == "INV26-27/000007"
    assert dn_ref_to_invoice("V25-26/001331_QD") == "INV25-26/001331"
    print("test_normalizers_and_dn_transform OK")

if __name__ == "__main__":
    test_normalizers_and_dn_transform()
    print("ALL TESTS PASSED")

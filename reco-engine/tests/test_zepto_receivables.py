import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from io import BytesIO
from recon.zepto_receivables import (norm_po, norm_inv, dn_ref_to_invoice,
                                     _read_csv, _find_header, _rows_as_dicts, _get, _norm_key,
                                     parse_zepto_payment, parse_grn, grn_gate)

def test_normalizers_and_dn_transform():
    assert norm_po(" p4143483 ") == "P4143483"
    assert norm_po(3100356806) == "3100356806"      # int -> str, no ".0"
    assert norm_po(3100356806.0) == "3100356806"    # float-like -> no ".0"
    assert norm_inv(" inv26-27/000007 ") == "INV26-27/000007"
    assert dn_ref_to_invoice("V26-27/000007_QD") == "INV26-27/000007"
    assert dn_ref_to_invoice("V26-27/000007_PD") == "INV26-27/000007"
    assert dn_ref_to_invoice("V25-26/001331_QD") == "INV25-26/001331"
    print("test_normalizers_and_dn_transform OK")

def test_csv_header_detection_and_getter():
    csv_bytes = (b"Some Title,,,\r\n"
                 b"Type/Description,Ref Id,Doc No,Amount,TDS,Payment Amount\r\n"
                 b",,,,,427313.6\r\n"
                 b"Invoice,INV26-27/000254,1900241884,36954.02,35.19,36918.83\r\n")
    grid = _read_csv(csv_bytes)
    h = _find_header(grid, ["ref id", "amount", "payment amount"])
    assert h == 1
    rows = _rows_as_dicts(grid, h)
    # summary row (blank Type) + one invoice row
    assert len(rows) == 2
    inv = rows[1]
    assert _get(inv, ["Type/Description"]) == "Invoice"
    assert _get(inv, ["ref id"]) == "INV26-27/000254"   # alias lookup is case-insensitive
    assert _get(inv, ["Payment Amount"]) == "36918.83"
    print("test_csv_header_detection_and_getter OK")

def _xlsx(sheets: dict) -> bytes:
    from openpyxl import Workbook
    wb = Workbook(); wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(title=name)
        for r in rows:
            ws.append(r)
    buf = BytesIO(); wb.save(buf); return buf.getvalue()

def test_zepto_payment_and_grn_gate():
    pay = _xlsx({"Zepto Payment track": [
        ["Zepto Payment track PO Number", "Invoice Number", "Cities", "Delivery Date", "GRN"],
        ["P4143483", "INV26-27/000101", "Jaipur", "01/04/2026", "GrnCode1"],
        ["P4143483", "INV26-27/000101", "Jaipur", "01/04/2026", "GrnCode1"],  # dup PO
        ["3100356806", "INV24-25/000297", "Pune", "22/10/2024", "GrnCodeX"],  # legacy, no GRN
        ["P9999999", "INV26-27/000999", "Delhi", "05/04/2026", ""],           # not in GRN
    ]})
    payments = parse_zepto_payment(pay)
    assert {p["po"] for p in payments} == {"P4143483", "3100356806", "P9999999"} or len(payments) == 4
    grn_csv = (b"GRN ID,PO ID,Created On,Status\r\n"
               b"GrnCode1,P4143483,4/2/2026 16:20,CONFIRMED\r\n"
               b"GrnCode2,P4143483,4/3/2026 10:00,CONFIRMED\r\n")   # PO with 2 GRNs
    grn = parse_grn([grn_csv])
    assert "P4143483" in grn and "P9999999" not in grn
    kept = grn_gate(payments, grn)
    kept_pos = [k["po"] for k in kept]
    assert kept_pos == ["P4143483"]                 # unique + only GRN-matched
    assert kept[0]["invoice_number"] == "INV26-27/000101"
    print("test_zepto_payment_and_grn_gate OK")

if __name__ == "__main__":
    test_normalizers_and_dn_transform()
    test_csv_header_detection_and_getter()
    test_zepto_payment_and_grn_gate()
    print("ALL TESTS PASSED")

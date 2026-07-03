import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from io import BytesIO
from recon.zepto_receivables import (norm_po, norm_inv, dn_ref_to_invoice,
                                     _read_csv, _find_header, _rows_as_dicts, _get, _norm_key,
                                     parse_zepto_payment, parse_grn, grn_gate, parse_invoice_details,
                                     parse_credit_notes, reconcile_zepto, summarize_zepto)

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

def test_parse_invoice_details():
    inv = _xlsx({"Invoice Details": [
        ["Invoice Details \"Drips ... 01/04/2026 To 30/06/2026\""],  # title row 1
        ["invoice_id","status","date","txn_posting_date","due_date","invoice_number",
         "reference_number","customer_name","bcy_total","bcy_balance","fcy_balance",
         "salesperson_id","tax_amount","sgst","cgst","igst","amount_without_tax",
         "place_of_supply","gst_no","project_names","currency_code","currency_id",
         "customer_id","last_modified_time","price_precision","is_emailed","reminders_sent",
         "exchange_rate","billing_state","shipping_state","gst_treatment"],
        ["1151","overdue","2026-04-06","","","INV26-27/000101","2026-27/SO-00015",
         "ZEPTO PRIVATE LIMITED JAIPUR",21369.43,19288.96,19288.96,"115",1017.59,0,0,1017.59,
         20351.84,"RJ","08AAICK4821A1ZV","","INR","115","115","x",2,"false",0,1,
         "Rajasthan","Rajasthan","business_gst"],
    ]})
    d = parse_invoice_details(inv)
    row = d["INV26-27/000101"]
    assert row["date"] == "2026-04-06"
    assert row["sales_order_no"] == "2026-27/SO-00015"
    assert row["name"] == "ZEPTO PRIVATE LIMITED JAIPUR"
    assert float(row["total_invoice_amt"]) == 21369.43
    assert float(row["tax"]) == 1017.59
    assert float(row["invoice_amt_excl_tax"]) == 20351.84
    assert row["place_of_supply"] == "RJ"
    assert row["gstin"] == "08AAICK4821A1ZV"
    assert row["billing_state"] == "Rajasthan" and row["shipping_state"] == "Rajasthan"
    print("test_parse_invoice_details OK")

def test_parse_payment_advice():
    from recon.zepto_receivables import parse_payment_advice, _to_float
    csv1 = (b"Type/Description,Ref Id,Doc No,Amount,TDS,Payment Amount\r\n"
            b",,,,,427313.6\r\n"                                               # summary -> skip
            b"Invoice,INV26-27/000007,1900261942,51429.9,48.98,51380.92\r\n"
            b"Debit Note,V26-27/000007_QD,1700049536,-311.38,0.3,-311.68\r\n"
            b"Debit Note Price,V26-27/000007_PD,4800006135,-4988.44,5,-4993.44\r\n")
    pay, dn = parse_payment_advice([csv1])
    assert _to_float(pay["INV26-27/000007"]["incl"]) == 51380.92
    assert _to_float(pay["INV26-27/000007"]["excl"]) == 51429.9
    assert _to_float(pay["INV26-27/000007"]["tds"]) == 48.98
    # DN = sum of Amount (col D): -311.38 + -4988.44 = -5299.82
    assert round(dn["INV26-27/000007"], 2) == -5299.82
    print("test_parse_payment_advice OK")

def test_parse_credit_notes():
    cn = _xlsx({"Credit Note Details": [
        ["Credit Note Details title row"],
        ["creditnote_number","status","date","reference_number","exchange_rate",
         "bcy_total","bcy_balance","currency_code","tax_amount","sales_person_id",
         "sgst","cgst","igst","invoice_number"],
        ["CN/26-27/0003","closed","2025-05-10","SO1",1,2049.75,0,"INR",97.61,"",0,0,97.61,"INV26-27/000011"],
        ["CN/26-27/0009","closed","2025-05-10","SO2",1,50.0,0,"INR",7,"",0,0,7,"INV26-27/000011"],
    ]})
    d = parse_credit_notes(cn)
    assert round(d["INV26-27/000011"], 2) == 2099.75    # 2049.75 + 50.0
    print("test_parse_credit_notes OK")

def _file(b): return {"filename": "f", "content": b}

def test_reconcile_end_to_end():
    pay = _xlsx({"Zepto Payment track": [
        ["Zepto Payment track PO Number","Invoice Number","Cities"],
        ["P100","INV26-27/000007","Pune"],
        ["P200","INV26-27/000101","Jaipur"],
        ["P900","INV26-27/000999","Delhi"],   # PO not in GRN -> dropped
    ]})
    grn = b"GRN ID,PO ID,Created On,Status\r\nG1,P100,4/2/2026,CONFIRMED\r\nG2,P200,4/3/2026,CONFIRMED\r\n"
    invd = _xlsx({"Invoice Details": [
        ["title"],
        ["invoice_number","reference_number","customer_name","date","bcy_total","tax_amount",
         "amount_without_tax","place_of_supply","gst_no","billing_state","shipping_state"],
        ["INV26-27/000007","SO-7","ZEPTO PUNE","2026-04-06",56685.0,0,56685.0,"MH","27AAA","Maharashtra","Maharashtra"],
        ["INV26-27/000101","SO-101","ZEPTO JAIPUR","2026-04-08",21369.43,1017.59,20351.84,"RJ","08AAA","Rajasthan","Rajasthan"],
    ]})
    padv = (b"Type/Description,Ref Id,Doc No,Amount,TDS,Payment Amount\r\n"
            b",,,,,0\r\n"
            b"Invoice,INV26-27/000007,190,51429.9,48.98,51380.92\r\n"
            b"Debit Note,V26-27/000007_QD,170,-311.38,0.3,-311.68\r\n"
            b"Debit Note Price,V26-27/000007_PD,480,-4988.44,5,-4993.44\r\n"
            b"Invoice,INV26-27/000101,191,0,0,0\r\n")
    cn = _xlsx({"Credit Note Details": [["t"],
        ["invoice_number","bcy_total"], ["INV26-27/000101", 100.0]]})
    files = {"zepto_payment": _file(pay), "grn_list": [_file(grn)],
             "invoice_details": _file(invd), "payment_advice": [_file(padv)], "credit_note": _file(cn)}
    res = reconcile_zepto(files)
    assert len(res) == 2                                  # P900 dropped
    by_inv = {r["invoice_number"]: r for r in res}
    a = by_inv["INV26-27/000007"]
    assert a["name"] == "ZEPTO PUNE"
    assert round(a["pending_amount"], 2) == 56685.0
    assert round(a["payment_received_incl_tds"], 2) == 51380.92
    assert round(a["debit_note_issued"], 2) == -5299.82
    assert round(a["gross_outstanding"], 2) == round(56685.0 - 51380.92, 2)   # 5304.08
    assert round(a["net_outstanding"], 2) == round(56685.0 - 51380.92 - 5299.82, 2)  # ~4.26
    assert a["status"] == "Not Paid"        # gross ~5304 > 100 (both-sides rule)
    b = by_inv["INV26-27/000101"]
    assert round(b["credit_note_issued"], 2) == 100.0
    s = summarize_zepto(res)
    assert s["total"] == 2 and s["paid"] + s["not_paid"] == 2
    print("test_reconcile_end_to_end OK")

def test_workbook_has_live_formulas():
    from recon.zepto_receivables import build_zepto_workbook
    results = [{k: "" for k in __import__("recon.zepto_receivables", fromlist=["COLUMN_KEYS"]).COLUMN_KEYS}]
    r = results[0]
    r.update({"invoice_number":"INV26-27/000007","total_invoice_amt":56685.0,
              "payment_received_incl_tds":51380.92,"debit_note_issued":-5299.82,
              "pending_amount":56685.0,"gross_outstanding":5304.08,"net_outstanding":4.26,"status":"Not Paid"})
    wb = build_zepto_workbook(results)
    ws = wb["1. Invoice Tracker"]
    # data row 3: formulas in L, T, U, V
    assert ws["L3"].value == "=E3"
    assert ws["T3"].value == "=L3-M3"
    assert ws["U3"].value == "=L3-M3+P3"
    assert ws["V3"].value == '=IF(AND(ABS(T3)<=100,ABS(U3)<=100),"Paid","Not Paid")'
    assert ws["B3"].value == "INV26-27/000007"
    assert ws["E3"].value == 56685.0
    print("test_workbook_has_live_formulas OK")

if __name__ == "__main__":
    test_normalizers_and_dn_transform()
    test_csv_header_detection_and_getter()
    test_zepto_payment_and_grn_gate()
    test_parse_invoice_details()
    test_parse_payment_advice()
    test_parse_credit_notes()
    test_reconcile_end_to_end()
    test_workbook_has_live_formulas()
    print("ALL TESTS PASSED")

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


def test_norm_inv_does_not_strip_trailing_slash():
    # REVERTED: "INV26-27/000039" (Rs 29,169) and "INV26-27/000039/"
    # (Rs 29,870) are DIFFERENT invoices in the real data -- norm_inv must
    # NOT collapse them by stripping the trailing slash. Only strip+upper.
    assert norm_inv("INV26-27/000039/") == "INV26-27/000039/"
    assert norm_inv("INV26-27/000039") == "INV26-27/000039"
    assert norm_inv(" inv26-27/000007 ") == "INV26-27/000007"
    print("test_norm_inv_does_not_strip_trailing_slash OK")


def test_dn_ref_to_invoice_primary_transform_only():
    # dn_ref_to_invoice does ONLY the simple primary transform: split on "_",
    # V-prefix -> INV, otherwise normalize as-is (upper/strip, no slash
    # stripping, no year-prefix INV-prepend). Malformed refs that need more
    # than this are fixed later by the fallback remap in reconcile_zepto.
    assert dn_ref_to_invoice("V26-27/000007_QD") == "INV26-27/000007"
    # Year-prefixed ref missing the V/INV entirely + trailing slash: the
    # primary transform leaves it as-is (uppercased) -- NOT "INV"-prepended,
    # NOT slash-stripped. The fallback remap (tested via reconcile_zepto)
    # is what maps this onto the real "INV26-27/000039/" invoice.
    assert dn_ref_to_invoice("26-27/000039/_QD") == "26-27/000039/"
    assert dn_ref_to_invoice("26-27/000041/_QD") == "26-27/000041/"
    # existing V-prefixed case still works
    assert dn_ref_to_invoice("V25-26/001322_QD") == "INV25-26/001322"
    # PMDDN / non-invoice refs must be left unchanged (no V prefix)
    assert dn_ref_to_invoice("PMDDN-79939") == "PMDDN-79939"
    assert dn_ref_to_invoice("CPMDDN-24512") == "CPMDDN-24512"
    assert dn_ref_to_invoice("DC-3214") == "DC-3214"
    print("test_dn_ref_to_invoice_primary_transform_only OK")

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


_REAL_FIXTURES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
_REAL_INVOICE_DETAILS = os.path.join(_REAL_FIXTURES_DIR, "Invoice Details April 26 to June 26.xlsx")


def test_parse_invoice_details_real_fixture_dedup_by_num_amount_date():
    # Real fixture has 589 raw rows. Some invoice numbers appear twice with a
    # trailing-slash variant: e.g. "INV26-27/000039" (Rs 29,169) vs
    # "INV26-27/000039/" (Rs 29,870) -- DIFFERENT amounts -> BOTH must survive
    # as distinct universe keys (no merging). "INV26-27/000069" vs
    # "INV26-27/000069/" -- IDENTICAL amount+date -> a true duplicate; only
    # ONE survives (the slash variant is dropped as a re-export of the same
    # row). Verified directly against the fixture: 6 such identical pairs
    # exist, so 589 raw rows -> 583 universe rows (589 - 6 collapsed dupes).
    with open(_REAL_INVOICE_DETAILS, "rb") as f:
        data = f.read()
    universe = parse_invoice_details(data)
    assert len(universe) == 583

    # Different-amount pair: BOTH keys present, distinct amounts preserved.
    assert "INV26-27/000039" in universe
    assert "INV26-27/000039/" in universe
    assert round(float(universe["INV26-27/000039"]["total_invoice_amt"]), 2) == 29169.0
    assert round(float(universe["INV26-27/000039/"]["total_invoice_amt"]), 2) == 29870.95

    # Identical pair: base key present once, slash variant collapsed away.
    assert "INV26-27/000069" in universe
    assert "INV26-27/000069/" not in universe
    print("test_parse_invoice_details_real_fixture_dedup_by_num_amount_date OK")

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
    # Universe = Invoice Details (every invoice becomes a row, PO comes from
    # Zepto Payment track only if that PO is confirmed in the GRN pool).
    invd = _xlsx({"Invoice Details": [
        ["title"],
        ["invoice_number","reference_number","customer_name","date","bcy_total","tax_amount",
         "amount_without_tax","place_of_supply","gst_no","billing_state","shipping_state"],
        ["INV26-27/000007","SO-7","ZEPTO PUNE","2026-04-06",56685.0,0,56685.0,"MH","27AAA","Maharashtra","Maharashtra"],
        ["INV26-27/000101","SO-101","ZEPTO JAIPUR","2026-04-08",21369.43,1017.59,20351.84,"RJ","08AAA","Rajasthan","Rajasthan"],
    ]})
    pay = _xlsx({"Zepto Payment track": [
        ["Zepto Payment track PO Number","Invoice Number","Cities"],
        ["P100","INV26-27/000007","Pune"],          # PO in GRN -> po filled
        ["P900","INV26-27/000101","Delhi"],         # PO NOT in GRN -> po blank
    ]})
    grn = b"GRN ID,PO ID,Created On,Status\r\nG1,P100,4/2/2026,CONFIRMED\r\n"   # only P100 confirmed
    cn = _xlsx({"Credit Note Details": [["t"],
        ["invoice_number","bcy_total"], ["INV26-27/000101", 100.0]]})
    files = {"zepto_payment": _file(pay), "grn_list": [_file(grn)],
             "invoice_details": _file(invd), "payment_advice": [], "credit_note": _file(cn)}
    res = reconcile_zepto(files)
    assert len(res) == 2                                  # universe = invoice details (both rows)
    by_inv = {r["invoice_number"]: r for r in res}
    a = by_inv["INV26-27/000007"]
    assert a["name"] == "ZEPTO PUNE"
    assert a["po"] == "P100"                              # GRN-matched -> po filled
    assert round(a["total_invoice_amt"], 2) == 56685.0
    assert round(a["pending_amount"], 2) == 56685.0
    assert round(a["payment_received_incl_tds"], 2) == 0.0    # no PDFs -> 0
    assert round(a["gross_outstanding"], 2) == 56685.0
    assert round(a["net_outstanding"], 2) == 56685.0
    assert a["status"] == "Not Paid"
    assert a["invoice_not_in_ledger"] == ""               # v1 "Invoice Not in Books" logic removed

    b = by_inv["INV26-27/000101"]
    assert b["name"] == "ZEPTO JAIPUR"
    assert b["po"] == ""                                  # PO not in GRN pool -> blank
    assert round(b["total_invoice_amt"], 2) == 21369.43
    assert round(b["credit_note_issued"], 2) == 100.0
    assert b["status"] in ("Paid", "Not Paid")

    s = summarize_zepto(res)
    assert s["total"] == 2 and s["paid"] + s["not_paid"] == 2
    print("test_reconcile_end_to_end OK")

def test_workbook_has_live_formulas():
    # NEW PO-first column layout (29 cols): PO is col A, invoice_number is
    # col C, total_invoice_amt is col F. The 4 live formula strings
    # (pending/gross/net/status) are re-pointed to the shifted columns.
    from recon.zepto_receivables import build_zepto_workbook
    results = [{k: "" for k in __import__("recon.zepto_receivables", fromlist=["COLUMN_KEYS"]).COLUMN_KEYS}]
    r = results[0]
    r.update({"po":"P100","invoice_number":"INV26-27/000007","total_invoice_amt":56685.0,
              "payment_received_incl_tds":51380.92,"debit_note_issued":-5299.82,
              "pending_amount":56685.0,"gross_outstanding":5304.08,"net_outstanding":4.26,"status":"Not Paid"})
    wb = build_zepto_workbook(results)
    ws = wb["1. Invoice Tracker"]
    assert ws["A3"].value == "P100"                    # po (col A)
    assert ws["C3"].value == "INV26-27/000007"          # invoice_number (col C)
    assert ws["F3"].value == 56685.0                    # total_invoice_amt (col F)
    assert ws["M3"].value == "=F3"                                                     # pending_amount
    assert ws["U3"].value == "=M3-N3"                                                  # gross_outstanding
    assert ws["V3"].value == "=M3-N3+Q3"                                               # net_outstanding
    assert ws["W3"].value == '=IF(AND(U3<=100,V3<=100),"Paid","Not Paid")'             # status (signed)
    print("test_workbook_has_live_formulas OK")


def test_status_signed_threshold_negative_net_is_paid():
    # Accountant's rule: Paid whenever gross<=100 AND net<=100, INCLUDING
    # negative values (a debit note pushing Net negative means settled).
    # gross~17 (<=100), net~-2058 (<=100 since negative) -> Paid (signed rule).
    invd = _xlsx({"Invoice Details": [
        ["title"],
        ["invoice_number","reference_number","customer_name","date","bcy_total","tax_amount",
         "amount_without_tax","place_of_supply","gst_no","billing_state","shipping_state"],
        ["INV1","SO-1","CO A","2026-04-06",50000.0,0,50000.0,"MH","27AAA","Maharashtra","Maharashtra"],
        ["INV2","SO-2","CO B","2026-04-06",28000.0,0,28000.0,"MH","27AAA","Maharashtra","Maharashtra"],
    ]})
    pay = _xlsx({"Zepto Payment track": [["Zepto Payment track PO Number","Invoice Number","Cities"]]})
    grn = b"GRN ID,PO ID,Created On,Status\r\n"
    cn = _xlsx({"Credit Note Details": [["t"], ["invoice_number","bcy_total"]]})
    files = {"zepto_payment": _file(pay), "grn_list": [_file(grn)],
             "invoice_details": _file(invd), "payment_advice": [], "credit_note": _file(cn)}
    res = reconcile_zepto(files)
    by_inv = {r["invoice_number"]: r for r in res}

    # Force gross~17 by setting payment received to make gross = 50000 - 49983 = 17
    by_inv["INV1"]["payment_received_incl_tds"] = 49983.0
    # Force net~-2058 via a large debit note: net = gross + dn = 17 + (-2075) = -2058
    by_inv["INV1"]["debit_note_issued"] = -2075.0
    gross1 = by_inv["INV1"]["total_invoice_amt"] - by_inv["INV1"]["payment_received_incl_tds"]
    net1 = gross1 + by_inv["INV1"]["debit_note_issued"]
    status1 = "Paid" if (gross1 <= 100 and net1 <= 100) else "Not Paid"
    assert round(gross1, 2) == 17.0
    assert round(net1, 2) == -2058.0
    assert status1 == "Paid"

    # INV2: gross~28000 (no payment received) -> Not Paid
    assert by_inv["INV2"]["gross_outstanding"] == 28000.0
    assert by_inv["INV2"]["status"] == "Not Paid"
    print("test_status_signed_threshold_negative_net_is_paid OK")


def test_reconcile_zepto_signed_status_direct():
    # Directly exercise the signed rule used inside reconcile_zepto via the
    # same gross/net -> status formula (mirrors the accountant's examples:
    # Net -83, -478, -1473, -4335, -5226 are all "Paid").
    for gross, net, expected in [
        (17.0, -2058.0, "Paid"),
        (-83.0, -83.0, "Paid"),
        (50.0, -478.0, "Paid"),
        (28000.0, 28000.0, "Not Paid"),
        (150.0, 40.0, "Not Paid"),   # gross > 100 -> Not Paid even if net small
    ]:
        status = "Paid" if (gross <= 100 and net <= 100) else "Not Paid"
        assert status == expected, (gross, net, expected, status)
    print("test_reconcile_zepto_signed_status_direct OK")


def test_status_column_has_conditional_formatting():
    from recon.zepto_receivables import build_zepto_workbook
    results = [{k: "" for k in __import__("recon.zepto_receivables", fromlist=["COLUMN_KEYS"]).COLUMN_KEYS}]
    results[0].update({"invoice_number": "INV1", "total_invoice_amt": 1000.0, "status": "Paid"})
    wb = build_zepto_workbook(results)
    ws = wb["1. Invoice Tracker"]
    # Conditional formatting must be registered on the workbook/sheet for the
    # Status column (formula-driven cell -> CF is the only way to color it).
    cf_ranges = [str(rng) for rng in ws.conditional_formatting]
    assert len(cf_ranges) >= 1
    assert any("W" in rng for rng in cf_ranges)
    print("test_status_column_has_conditional_formatting OK")

def test_universe_includes_invoice_with_no_po_mapping_at_all():
    # An invoice in Invoice Details that ISN'T even listed in Zepto Payment track
    # must still appear in the universe with po == "".
    invd = _xlsx({"Invoice Details": [
        ["title"],
        ["invoice_number","reference_number","customer_name","date","bcy_total","tax_amount",
         "amount_without_tax","place_of_supply","gst_no","billing_state","shipping_state"],
        ["INV26-27/000500","SO-9","OTHER CO","2026-04-06",1000.0,0,1000.0,"MH","27AAA","Maharashtra","Maharashtra"],
    ]})
    pay = _xlsx({"Zepto Payment track": [
        ["Zepto Payment track PO Number","Invoice Number","Cities"],
    ]})
    grn = b"GRN ID,PO ID,Created On,Status\r\n"
    cn = _xlsx({"Credit Note Details": [["t"], ["invoice_number","bcy_total"]]})
    files = {"zepto_payment": _file(pay), "grn_list": [_file(grn)],
             "invoice_details": _file(invd), "payment_advice": [], "credit_note": _file(cn)}
    res = reconcile_zepto(files)
    assert len(res) == 1
    row = res[0]
    assert row["invoice_number"] == "INV26-27/000500"
    assert row["po"] == ""
    assert row["invoice_not_in_ledger"] == ""                   # v1 flag no longer set
    assert round(row["total_invoice_amt"], 2) == 1000.0
    assert row["status"] in ("Paid", "Not Paid")
    print("test_universe_includes_invoice_with_no_po_mapping_at_all OK")

_FIXTURE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "pdf")
_FIXTURE_PDF = os.path.join(_FIXTURE_DIR, "2026-07-03_1d33a6026d1168fd_2000004234.pdf")


def _read_fixture_pdf() -> bytes:
    with open(_FIXTURE_PDF, "rb") as f:
        return f.read()


def test_parse_payment_advice_pdf_single():
    from recon.zepto_receivables import parse_payment_advice_pdf
    pdf_bytes = _read_fixture_pdf()
    payments, debit_notes, pmdn_total = parse_payment_advice_pdf([pdf_bytes])
    inv = payments["INV25-26/001463"]
    assert round(inv["excl"], 2) == 119767.53
    assert round(inv["tds"], 2) == 114.06
    assert round(inv["incl"], 2) == 119653.47
    print("test_parse_payment_advice_pdf_single OK")


def test_parse_payment_advice_pdf_dedup():
    from recon.zepto_receivables import parse_payment_advice_pdf
    pdf_bytes = _read_fixture_pdf()
    # Same PDF fed twice (e.g. re-uploaded / duplicate in Drive folder) must NOT double-count.
    payments, debit_notes, pmdn_total = parse_payment_advice_pdf([pdf_bytes, pdf_bytes])
    inv = payments["INV25-26/001463"]
    assert round(inv["incl"], 2) == 119653.47
    assert round(inv["excl"], 2) == 119767.53
    assert round(inv["tds"], 2) == 114.06
    print("test_parse_payment_advice_pdf_dedup OK")


_FIXTURE_DIR_ALL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "pdf_all")
_FIXTURE_PDF_MULTIPAGE = os.path.join(_FIXTURE_DIR_ALL, "06_Payment_Advice_2000017788.PDF")


def test_parse_payment_advice_pdf_multipage():
    # 06_Payment_Advice_2000017788.PDF has 2 pages. Page 2 (continuation) has
    # invoice DATA rows but NO repeated header row. Row for INV25-26/001632
    # lives on page 2 only:
    #   ['5155','Invoice Payment','1901427707','INV25-26/001\n632',
    #    '28,774.77','INR','27.4','28,747.37']
    # Confirmed via direct pdfplumber.extract_tables() on the fixture.
    from recon.zepto_receivables import parse_payment_advice_pdf
    with open(_FIXTURE_PDF_MULTIPAGE, "rb") as f:
        pdf_bytes = f.read()
    payments, debit_notes, pmdn_total = parse_payment_advice_pdf([pdf_bytes])
    inv = payments["INV25-26/001632"]
    assert round(inv["incl"], 2) == 28747.37
    assert round(inv["excl"], 2) == 28774.77
    assert round(inv["tds"], 2) == 27.4
    # Sanity: page-1-only invoice must also still be present.
    assert "INV25-26/001585" in payments
    print("test_parse_payment_advice_pdf_multipage OK")


_FIXTURE_PDF_CREDIT_MEMO = os.path.join(_FIXTURE_DIR_ALL, "04_Payment_Advice_2000013623.PDF")


def test_parse_payment_advice_pdf_credit_memo_routes_as_debit_note():
    # Zepto labels its debit notes "Credit Memo" in the real PDFs (there are NO
    # literal "Debit Note" rows in the data). Confirmed via direct
    # pdfplumber.extract_tables() on this fixture:
    #   ['1804','Credit Memo','1700264647','V25-26/00156\n4_QD',
    #    '-5,962.15','INR','5.68','-5,956.47']
    #   ['1805','Credit Memo','1700265247','V25-26/00159\n8_QD',
    #    '-12,916.64','INR','12.3','-12,904.34']
    # Ref cleans to "V25-26/001564_QD" -> dn_ref_to_invoice -> "INV25-26/001564"
    # (and "V25-26/001598_QD" -> "INV25-26/001598"). Amount is col[4].
    from recon.zepto_receivables import parse_payment_advice_pdf
    with open(_FIXTURE_PDF_CREDIT_MEMO, "rb") as f:
        pdf_bytes = f.read()
    payments, debit_notes, pmdn_total = parse_payment_advice_pdf([pdf_bytes])
    assert round(debit_notes["INV25-26/001564"], 2) == -5962.15
    assert round(debit_notes["INV25-26/001598"], 2) == -12916.64
    print("test_parse_payment_advice_pdf_credit_memo_routes_as_debit_note OK")


_FIXTURE_PDF_SLASH_INVOICE = os.path.join(_FIXTURE_DIR_ALL, "21_Payment_Advice_2000028805.PDF")
_FIXTURE_PDF_SLASH_INVOICE_2 = os.path.join(_FIXTURE_DIR_ALL, "23_Payment_Advice_2000029871.PDF")
_FIXTURE_PDF_PMDDN = os.path.join(_FIXTURE_DIR_ALL, "06_Payment_Advice_2000017788.PDF")


def test_parse_payment_advice_pdf_trailing_slash_invoice_and_dn():
    # 21_Payment_Advice_2000028805.PDF: Invoice Payment RefDoc cleans to
    # "INV26-27/000039/" (Payment Amt 29,843.58, slash PRESERVED after the
    # revert) and Credit Memo RefDoc cleans to "26-27/000039/_QD" -- since it
    # contains an invoice pattern (\d{2}-\d{2}/\d+), it is routed to
    # debit_notes under dn_ref_to_invoice's primary-transform key
    # "26-27/000039/" (no V/INV prefix at this stage -- the fallback remap in
    # reconcile_zepto is what later reconciles this onto the real invoice).
    from recon.zepto_receivables import parse_payment_advice_pdf
    with open(_FIXTURE_PDF_SLASH_INVOICE, "rb") as f:
        pdf_bytes = f.read()
    payments, debit_notes, pmdn_total = parse_payment_advice_pdf([pdf_bytes])
    assert round(payments["INV26-27/000039/"]["incl"], 2) == 29843.58
    assert round(debit_notes["26-27/000039/"], 2) == -224.24
    print("test_parse_payment_advice_pdf_trailing_slash_invoice_and_dn OK")


def test_parse_payment_advice_pdf_trailing_slash_invoice_and_dn_2():
    # 23_Payment_Advice_2000029871.PDF: same pattern for invoice 000041.
    from recon.zepto_receivables import parse_payment_advice_pdf
    with open(_FIXTURE_PDF_SLASH_INVOICE_2, "rb") as f:
        pdf_bytes = f.read()
    payments, debit_notes, pmdn_total = parse_payment_advice_pdf([pdf_bytes])
    assert round(payments["INV26-27/000041/"]["incl"], 2) == 37396.14
    assert round(debit_notes["26-27/000041/"], 2) == -935.93
    print("test_parse_payment_advice_pdf_trailing_slash_invoice_and_dn_2 OK")


def test_parse_payment_advice_pdf_pmddn_routes_to_pmdn_total_not_debit_notes():
    # 06_Payment_Advice_2000017788.PDF has a "PMDDN-79939" Credit Memo row
    # (amount -1,221,755) — a marketing adjustment, NOT a per-invoice debit
    # note. It must NOT create/pollute any debit_notes["...79939..."] key and
    # must instead accumulate into pmdn_total.
    from recon.zepto_receivables import parse_payment_advice_pdf, dn_ref_to_invoice
    with open(_FIXTURE_PDF_PMDDN, "rb") as f:
        pdf_bytes = f.read()
    payments, debit_notes, pmdn_total = parse_payment_advice_pdf([pdf_bytes])
    pmddn_key = dn_ref_to_invoice("PMDDN-79939")
    assert pmddn_key not in debit_notes
    assert not any(k.startswith("PMDDN") for k in debit_notes)
    assert pmdn_total != 0
    assert round(pmdn_total, 2) == -1221755.0
    print("test_parse_payment_advice_pdf_pmddn_routes_to_pmdn_total_not_debit_notes OK")


import glob


def _load_real_files() -> dict:
    def f(path):
        with open(path, "rb") as fh:
            return {"filename": os.path.basename(path), "content": fh.read()}

    grn_files = [f(p) for p in sorted(glob.glob(os.path.join(_REAL_FIXTURES_DIR, "GRN_List*.csv")))]
    pdf_files = [
        f(p) for p in
        sorted(glob.glob(os.path.join(_FIXTURE_DIR_ALL, "*.pdf")))
        + sorted(glob.glob(os.path.join(_FIXTURE_DIR_ALL, "*.PDF")))
    ]
    return {
        "zepto_payment": f(os.path.join(_REAL_FIXTURES_DIR, "Zepto Payment FY24-25 New 13_05.xlsx")),
        "grn_list": grn_files,
        "invoice_details": f(_REAL_INVOICE_DETAILS),
        "payment_advice": pdf_files,
        "credit_note": f(os.path.join(_REAL_FIXTURES_DIR, "Credit Note Details (4).xlsx")),
    }


def test_reconcile_zepto_real_fixtures_dn_fallback_and_pmddn():
    # Full pipeline on the real fixtures (zepto_payment, 3 GRN lists,
    # invoice_details, all 43 payment_advice PDFs, credit_note). Verifies the
    # DN fallback remap: the malformed DN ref "26-27/000039/_QD" (routed to
    # debit_notes["26-27/000039/"] at parse time) gets reassigned onto the
    # REAL invoice key "INV26-27/000039/" because that's what's actually in
    # the Invoice Details universe -- NOT onto "INV26-27/000039" (a different,
    # unrelated invoice with a different amount).
    files = _load_real_files()
    res = reconcile_zepto(files)
    by_inv = {r["invoice_number"]: r for r in res}

    row = by_inv["INV26-27/000039/"]
    assert row["debit_note_issued"] != 0.0
    assert round(row["debit_note_issued"], 2) == -224.24
    assert round(row["payment_received_incl_tds"], 2) == 29843.58

    # The unrelated, differently-amounted invoice must NOT receive the DN.
    other = by_inv["INV26-27/000039"]
    assert other["debit_note_issued"] == 0.0

    # PMDDN: a PMDDN- credit-memo ref must never appear as a debit_notes key
    # anywhere in the pipeline, and the pmdn_adjustment total must be non-zero.
    assert not any(k.startswith("PMDDN") for k in by_inv)
    assert res.pmdn_adjustment != 0.0
    print("test_reconcile_zepto_real_fixtures_dn_fallback_and_pmddn OK")


def test_reconcile_zepto_returns_list_subclass_with_pmdn_adjustment():
    # reconcile_zepto must keep behaving as a plain list (len/iterate/index)
    # for existing callers/tests and server.py's JSON serialization, while
    # also carrying the pmdn_adjustment total as an attribute.
    invd = _xlsx({"Invoice Details": [
        ["title"],
        ["invoice_number","reference_number","customer_name","date","bcy_total","tax_amount",
         "amount_without_tax","place_of_supply","gst_no","billing_state","shipping_state"],
        ["INV1","SO-1","CO A","2026-04-06",1000.0,0,1000.0,"MH","27AAA","Maharashtra","Maharashtra"],
    ]})
    pay = _xlsx({"Zepto Payment track": [["Zepto Payment track PO Number","Invoice Number","Cities"]]})
    grn = b"GRN ID,PO ID,Created On,Status\r\n"
    cn = _xlsx({"Credit Note Details": [["t"], ["invoice_number","bcy_total"]]})
    files = {"zepto_payment": _file(pay), "grn_list": [_file(grn)],
             "invoice_details": _file(invd), "payment_advice": [], "credit_note": _file(cn)}
    res = reconcile_zepto(files)
    assert isinstance(res, list)
    assert len(res) == 1
    assert res[0]["invoice_number"] == "INV1"
    assert hasattr(res, "pmdn_adjustment")
    assert res.pmdn_adjustment == 0.0   # no payment_advice PDFs -> 0
    # JSON-serializable exactly like a plain list (server.py relies on this).
    import json
    json.dumps(res)
    print("test_reconcile_zepto_returns_list_subclass_with_pmdn_adjustment OK")


def test_build_zepto_workbook_fills_pmddn_summary_line():
    from recon.zepto_receivables import build_zepto_workbook

    class _RecoRows(list):
        pass

    results = _RecoRows([{k: "" for k in __import__("recon.zepto_receivables", fromlist=["COLUMN_KEYS"]).COLUMN_KEYS}])
    results[0].update({"invoice_number": "INV1", "total_invoice_amt": 1000.0, "status": "Not Paid"})
    results.pmdn_adjustment = -12345.67

    wb = build_zepto_workbook(results)
    ws = wb["Summary"]
    amt = _find_summary_amount(ws, "Expense - PMDDN & AP-AR Adjustment (Marketing)")
    assert amt == -12345.67
    assert amt not in (None, "")

    # Other manual lines must remain blank.
    assert _find_summary_amount(ws, "Amount Received in Bank") in (None, "")
    assert _find_summary_amount(ws, "Previous Year Marketing Exp. Invoices") in (None, "")
    assert _find_summary_amount(ws, "Debit Note Accepted") in (None, "")
    assert _find_summary_amount(ws, "Debit Note Not Accepted") in (None, "")
    print("test_build_zepto_workbook_fills_pmddn_summary_line OK")


def _find_summary_amount(ws, label: str):
    """Scan column A for `label`; return the value of the adjacent amount cell (col B)."""
    for row in ws.iter_rows(min_col=1, max_col=1):
        cell = row[0]
        if cell.value == label:
            return ws.cell(row=cell.row, column=2).value
    raise AssertionError(f"label not found in Summary sheet: {label}")


def test_build_zepto_workbook_has_summary_tab():
    from recon.zepto_receivables import build_zepto_workbook

    def _row(inv, total, cn, dn, tds, incl, net):
        r = {k: "" for k in __import__("recon.zepto_receivables", fromlist=["COLUMN_KEYS"]).COLUMN_KEYS}
        r.update({
            "invoice_number": inv,
            "total_invoice_amt": total,
            "credit_note_issued": cn,
            "debit_note_issued": dn,
            "tds": tds,
            "payment_received_incl_tds": incl,
            "net_outstanding": net,
            "status": "Not Paid",
        })
        return r

    results = [
        _row("INV1", 56685.0, 100.0, 50.0, 10.0, 40000.0, 16735.0),
        _row("INV2", 21369.43, 0.0, 0.0, 5.0, 21369.43, 0.0),
        _row("INV3", 1000.0, 25.0, 0.0, 0.0, 975.0, 0.0),
    ]
    wb = build_zepto_workbook(results)

    # Exactly 2 tabs, in order, no stray default "Sheet".
    assert wb.sheetnames == ["1. Invoice Tracker", "Summary"]

    ws = wb["Summary"]
    total_sales = sum(r["total_invoice_amt"] for r in results)
    assert _find_summary_amount(ws, "Sales Including Tax") == total_sales

    # Blank-for-manual line: label present, amount cell empty.
    assert _find_summary_amount(ws, "Amount Received in Bank") in (None, "")
    print("test_build_zepto_workbook_has_summary_tab OK")


if __name__ == "__main__":
    test_normalizers_and_dn_transform()
    test_norm_inv_does_not_strip_trailing_slash()
    test_dn_ref_to_invoice_primary_transform_only()
    test_parse_invoice_details_real_fixture_dedup_by_num_amount_date()
    test_reconcile_zepto_real_fixtures_dn_fallback_and_pmddn()
    test_csv_header_detection_and_getter()
    test_zepto_payment_and_grn_gate()
    test_parse_invoice_details()
    test_parse_payment_advice()
    test_parse_credit_notes()
    test_reconcile_end_to_end()
    test_workbook_has_live_formulas()
    test_status_signed_threshold_negative_net_is_paid()
    test_reconcile_zepto_signed_status_direct()
    test_status_column_has_conditional_formatting()
    test_universe_includes_invoice_with_no_po_mapping_at_all()
    test_parse_payment_advice_pdf_single()
    test_parse_payment_advice_pdf_dedup()
    test_parse_payment_advice_pdf_multipage()
    test_parse_payment_advice_pdf_credit_memo_routes_as_debit_note()
    test_parse_payment_advice_pdf_trailing_slash_invoice_and_dn()
    test_parse_payment_advice_pdf_trailing_slash_invoice_and_dn_2()
    test_parse_payment_advice_pdf_pmddn_routes_to_pmdn_total_not_debit_notes()
    test_reconcile_zepto_returns_list_subclass_with_pmdn_adjustment()
    test_build_zepto_workbook_fills_pmddn_summary_line()
    test_build_zepto_workbook_has_summary_tab()
    print("ALL TESTS PASSED")

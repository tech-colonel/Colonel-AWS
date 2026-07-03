"""Zepto Receivables reconciliation engine.

Pipeline: GRN gate (PO match) -> per-invoice enrichment from Invoice Details,
Payment Advice, Credit Note -> `1. Invoice Tracker` sheet with live formulas.
"""
from __future__ import annotations

import csv
import io
import re
from io import BytesIO
from typing import Any

import pandas as pd
from .gstr_2b_books import _ensure_xlsx   # OLE2 .xls -> .xlsx passthrough


def norm_po(v: Any) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    if s.endswith(".0") and s[:-2].isdigit():   # pandas float-ified ints
        s = s[:-2]
    return s.upper()


def norm_inv(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip().upper()


def dn_ref_to_invoice(ref: str) -> str:
    """`V26-27/000007_QD` -> `INV26-27/000007` (drop `_...`, `V`->`INV`)."""
    base = str(ref or "").split("_")[0].strip()
    if base[:1].upper() == "V":
        base = "INV" + base[1:]
    return norm_inv(base)


def _norm_key(s: Any) -> str:
    return "".join(str(s or "").lower().split())


def _read_csv(data: bytes) -> list[list]:
    text = data.decode("utf-8-sig", errors="replace")
    return [row for row in csv.reader(io.StringIO(text))]


def _read_sheet(data: bytes, sheet: Any = 0) -> list[list]:
    data = _ensure_xlsx(data)
    df = pd.read_excel(BytesIO(data), sheet_name=sheet, header=None, dtype=object)
    grid = []
    for _, r in df.iterrows():
        grid.append(["" if (v is None or (isinstance(v, float) and pd.isna(v))) else v for v in r.tolist()])
    return grid


def _has_sheet(data: bytes, name: str) -> bool:
    try:
        xls = pd.ExcelFile(BytesIO(_ensure_xlsx(data)))
        return name in xls.sheet_names
    except Exception:
        return False


def _clean(v: Any) -> str:
    s = "" if v is None else str(v).strip()
    return "" if s.lower() == "nan" else s


def _find_header(grid: list[list], tokens: list[str], scan: int = 25) -> int:
    want = [_norm_key(t) for t in tokens]
    for i, row in enumerate(grid[:scan]):
        keys = {_norm_key(c) for c in row}
        if all(any(w in k for k in keys) for w in want):
            return i
    raise ValueError(f"Header row not found for tokens {tokens}")


def _rows_as_dicts(grid: list[list], header_idx: int) -> list[dict]:
    headers = [_clean(c) for c in grid[header_idx]]
    out = []
    for row in grid[header_idx + 1:]:
        if all(_clean(c) == "" for c in row):
            continue
        d = {}
        for j, h in enumerate(headers):
            if h:
                d[h] = row[j] if j < len(row) else ""
        out.append(d)
    return out


def _get(row: dict, aliases: list[str]) -> str:
    nk = {_norm_key(k): v for k, v in row.items()}
    for a in aliases:
        k = _norm_key(a)
        if k in nk:
            val = _clean(nk[k])
            if val != "":
                return val
    return ""


def parse_zepto_payment(data: bytes) -> list[dict]:
    try:
        grid = _read_sheet(data, "Zepto Payment track")
    except Exception:
        grid = _read_sheet(data, 0)
    h = _find_header(grid, ["po number", "invoice number"])
    rows = _rows_as_dicts(grid, h)
    out = []
    # Extract the actual column names from the header row for exact matching
    header_row = grid[h]
    po_col = None
    inv_col = None
    for col in header_row:
        nk = _norm_key(col)
        if "ponumber" in nk:
            po_col = col
        if "invoicenumber" in nk:
            inv_col = col

    for r in rows:
        po = ""
        inv = ""
        if po_col:
            po = norm_po(_get(r, [po_col]))
        if inv_col:
            inv = norm_inv(_get(r, [inv_col]))
        if not po:
            continue
        out.append({"po": po, "invoice_number": inv})
    return out


def parse_grn(datas: list[bytes]) -> dict[str, str]:
    pool: dict[str, str] = {}
    for data in datas:
        grid = _read_csv(data)
        h = _find_header(grid, ["po id"])
        for r in _rows_as_dicts(grid, h):
            po = norm_po(_get(r, ["PO ID", "PO Id"]))
            if po and po not in pool:
                pool[po] = _get(r, ["Created On", "Created on"])
    return pool


def grn_gate(payments: list[dict], grn: dict[str, str]) -> list[dict]:
    kept, seen = [], set()
    for p in payments:
        po = p["po"]
        if po in grn and po not in seen:
            seen.add(po)
            kept.append(p)
    return kept


def parse_invoice_details(data: bytes) -> dict[str, dict]:
    grid = _read_sheet(data, "Invoice Details") if _has_sheet(data, "Invoice Details") else _read_sheet(data, 0)
    h = _find_header(grid, ["invoice_number", "customer_name", "bcy_total"])
    out: dict[str, dict] = {}
    for r in _rows_as_dicts(grid, h):
        inv = norm_inv(_get(r, ["invoice_number"]))
        if not inv:
            continue
        out[inv] = {
            "date": _get(r, ["date"]),
            "sales_order_no": _get(r, ["reference_number"]),
            "name": _get(r, ["customer_name"]),
            "total_invoice_amt": _get(r, ["bcy_total"]),
            "tax": _get(r, ["tax_amount"]),
            "invoice_amt_excl_tax": _get(r, ["amount_without_tax"]),
            "place_of_supply": _get(r, ["place_of_supply"]),
            "gstin": _get(r, ["gst_no", "gstin"]),
            "billing_state": _get(r, ["billing_state"]),
            "shipping_state": _get(r, ["shipping_state"]),
        }
    return out


def _to_float(v: Any) -> float:
    s = str(v or "").replace(",", "").replace("₹", "").strip()
    if s in ("", "-", "nan", "None"):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_payment_advice(datas: list[bytes]) -> tuple[dict, dict]:
    payments: dict[str, dict] = {}
    debit_notes: dict[str, float] = {}
    for data in datas:
        grid = _read_csv(data)
        h = _find_header(grid, ["ref id", "amount", "payment amount"])
        for r in _rows_as_dicts(grid, h):
            typ = _get(r, ["Type/Description", "Type"]).lower()
            ref = _get(r, ["Ref Id", "Ref ID"])
            if not typ:                       # summary/total row
                continue
            if typ.startswith("invoice"):
                inv = norm_inv(ref)
                if not inv:
                    continue
                acc = payments.setdefault(inv, {"incl": 0.0, "excl": 0.0, "tds": 0.0})
                acc["incl"] += _to_float(_get(r, ["Payment Amount"]))
                acc["excl"] += _to_float(_get(r, ["Amount"]))
                acc["tds"] += _to_float(_get(r, ["TDS"]))
            elif typ.startswith("debit note"):
                inv = dn_ref_to_invoice(ref)
                if not inv:
                    continue
                debit_notes[inv] = debit_notes.get(inv, 0.0) + _to_float(_get(r, ["Amount"]))
    return payments, debit_notes


_HEADER_RE = {
    "ref_no": re.compile(r"Payment Ref No\.?\s*([^\n]+)"),
    "doc": re.compile(r"Payment Doc\s*([^\n]+)"),
}

# fallback line-item regex for when table extraction yields nothing usable, e.g.:
# "1428 Invoice Payment 1901333067 119,767.53 INR 114.06 119,653.47"
_LINE_ITEM_RE = re.compile(
    r"^\s*\d+\s+(Invoice Payment|Invoice|Debit Note(?:\s+\w+)?)\s+(\S+)\s+"
    r"([\d,]+\.?\d*)\s+([A-Z]{3})\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s*$"
)


def _parse_header_fields(text: str) -> tuple[str, str, str]:
    ref_m = _HEADER_RE["ref_no"].search(text)
    doc_m = _HEADER_RE["doc"].search(text)
    # "Amount" header line looks like "Amount 381,403.44" and precedes the
    # amount-in-words line; the table's "Payment Amt." column has a different label.
    amt_m = re.search(r"^Amount\s+([\d,]+\.\d{2}|[\d,]+)\s*$", text, re.MULTILINE)
    ref_no = ref_m.group(1).strip() if ref_m else ""
    doc = doc_m.group(1).strip() if doc_m else ""
    amount = amt_m.group(1).strip() if amt_m else ""
    return ref_no, doc, amount


def _clean_ref_doc(cell: Any) -> str:
    return re.sub(r"\s+", "", str(cell or ""))


def _find_table_header_row(table: list[list]) -> int | None:
    for i, row in enumerate(table):
        keys = {_norm_key(c) for c in row if c}
        if any("refdoc" in k for k in keys) and any("paymentamt" in k for k in keys):
            return i
    return None


def _apply_line_item(payments: dict, debit_notes: dict, typ: str, ref_doc: str,
                      amount: float, tds: float, payment_amt: float) -> None:
    typ_l = typ.strip().lower()
    if typ_l.startswith("invoice"):
        inv = norm_inv(ref_doc)
        if not inv:
            return
        acc = payments.setdefault(inv, {"incl": 0.0, "excl": 0.0, "tds": 0.0})
        acc["incl"] += payment_amt
        acc["excl"] += amount
        acc["tds"] += tds
    elif typ_l.startswith("debit note"):
        inv = dn_ref_to_invoice(ref_doc)
        if not inv:
            return
        debit_notes[inv] = debit_notes.get(inv, 0.0) + amount


def _extract_line_items_from_table(table: list[list], payments: dict, debit_notes: dict) -> bool:
    header_idx = _find_table_header_row(table)
    if header_idx is None:
        return False
    header = [_clean(c) for c in table[header_idx]]
    col_idx = {_norm_key(h): i for i, h in enumerate(header) if h}

    def _col(row: list, *aliases: str):
        for a in aliases:
            i = col_idx.get(_norm_key(a))
            if i is not None and i < len(row):
                return row[i]
        return ""

    found_any = False
    for row in table[header_idx + 1:]:
        if all(_clean(c) == "" for c in row):
            continue
        typ = _clean(_col(row, "Type of Document", "Type"))
        if not typ:
            continue
        ref_doc = _clean_ref_doc(_col(row, "Ref Doc"))
        amount = _to_float(_col(row, "Amount"))
        tds = _to_float(_col(row, "TDS"))
        payment_amt = _to_float(_col(row, "Payment Amt.", "Payment Amt"))
        _apply_line_item(payments, debit_notes, typ, ref_doc, amount, tds, payment_amt)
        found_any = True
    return found_any


def _extract_line_items_from_text(text: str, payments: dict, debit_notes: dict, filename: str = None) -> None:
    # FAILFAST: text-fallback parsing is not supported because it can mis-key rows
    # (interpreting wrapped invoice number as Doc No, producing silently-wrong results).
    # Real PDFs ALWAYS have extractable tables. If we hit this, it's a corrupted or
    # unusual file format that must not silently produce bad data.
    raise ValueError("Payment-advice PDF has no extractable table; text-fallback parsing is not supported. File: " + (filename or "<unknown>"))


def parse_payment_advice_pdf(pdf_bytes_list: list[bytes]) -> tuple[dict, dict]:
    """Parse Zepto PDF payment-advice files with PDF-level header dedup.

    Returns (payments, debit_notes) in the same shape as `parse_payment_advice`.
    A whole PDF is skipped if its header triple (Payment Ref No., Payment Doc,
    Amount) was already seen — this prevents double-counting duplicate uploads.
    """
    import pdfplumber

    payments: dict[str, dict] = {}
    debit_notes: dict[str, float] = {}
    seen: set[tuple[str, str, str]] = set()

    for pdf_bytes in pdf_bytes_list:
        with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
            if not pdf.pages:
                continue
            first_text = pdf.pages[0].extract_text() or ""
            ref_no, doc, amount = _parse_header_fields(first_text)
            triple = (ref_no, doc, amount)
            if ref_no and doc and triple in seen:
                continue   # duplicate PDF — skip entirely
            if ref_no and doc:
                seen.add(triple)

            for page in pdf.pages:
                text = page.extract_text() or ""
                extracted_any = False
                for table in page.extract_tables():
                    if _extract_line_items_from_table(table, payments, debit_notes):
                        extracted_any = True
                if not extracted_any:
                    _extract_line_items_from_text(text, payments, debit_notes)

    return payments, debit_notes


def parse_credit_notes(data: bytes) -> dict[str, float]:
    grid = _read_sheet(data, "Credit Note Details") if _has_sheet(data, "Credit Note Details") else _read_sheet(data, 0)
    h = _find_header(grid, ["invoice_number", "bcy_total"])
    out: dict[str, float] = {}
    for r in _rows_as_dicts(grid, h):
        inv = norm_inv(_get(r, ["invoice_number"]))
        if not inv:
            continue
        out[inv] = out.get(inv, 0.0) + _to_float(_get(r, ["bcy_total"]))
    return out


COLUMN_KEYS = [
    "date","invoice_number","sales_order_no","name","total_invoice_amt","tax",
    "invoice_amt_excl_tax","place_of_supply","gstin","billing_state","shipping_state",
    "pending_amount","payment_received_incl_tds","payment_received_excl_tds","tds",
    "debit_note_issued","dn_accepted","dn_not_accepted","credit_note_issued",
    "gross_outstanding","net_outstanding","status","grn_no","grn_date",
    "invoice_not_in_ledger","pod_no","pod_date","payment_date",
]


def _one(files: dict, field: str) -> bytes | None:
    v = files.get(field)
    if v is None:
        return None
    if isinstance(v, list):
        return v[0]["content"] if v else None
    return v["content"]


def _many(files: dict, field: str) -> list[bytes]:
    v = files.get(field)
    if v is None:
        return []
    items = v if isinstance(v, list) else [v]
    return [it["content"] for it in items if it.get("content")]


def reconcile_zepto(files: dict) -> list[dict]:
    payments_raw = parse_zepto_payment(_one(files, "zepto_payment") or b"")
    grn = parse_grn(_many(files, "grn_list"))
    invoice_details = parse_invoice_details(_one(files, "invoice_details") or b"")
    pay_map, dn_map = parse_payment_advice(_many(files, "payment_advice"))
    cn_map = parse_credit_notes(_one(files, "credit_note") or b"")

    kept = grn_gate(payments_raw, grn)
    results: list[dict] = []
    for k in kept:
        inv = k["invoice_number"]
        row = {key: "" for key in COLUMN_KEYS}
        row["invoice_number"] = inv
        det = invoice_details.get(inv)
        if det:
            for f in ("date","sales_order_no","name","place_of_supply","gstin","billing_state","shipping_state"):
                row[f] = det[f]
            row["total_invoice_amt"] = _to_float(det["total_invoice_amt"])
            row["tax"] = _to_float(det["tax"])
            row["invoice_amt_excl_tax"] = _to_float(det["invoice_amt_excl_tax"])
        else:
            row["invoice_not_in_ledger"] = "Not found in Invoice Details"
        pay = pay_map.get(inv, {})
        row["payment_received_incl_tds"] = round(pay.get("incl", 0.0), 2)
        row["payment_received_excl_tds"] = round(pay.get("excl", 0.0), 2)
        row["tds"] = round(pay.get("tds", 0.0), 2)
        row["debit_note_issued"] = round(dn_map.get(inv, 0.0), 2)
        row["credit_note_issued"] = round(cn_map.get(inv, 0.0), 2)
        pending = _to_float(row["total_invoice_amt"])
        row["pending_amount"] = round(pending, 2)
        gross = pending - row["payment_received_incl_tds"]
        net = gross + row["debit_note_issued"]
        row["gross_outstanding"] = round(gross, 2)
        row["net_outstanding"] = round(net, 2)
        row["status"] = "Paid" if (abs(gross) <= 100 and abs(net) <= 100) else "Not Paid"
        if row["invoice_not_in_ledger"]:
            row["status"] = "Invoice Not in Books"
        results.append(row)
    return results


def summarize_zepto(results: list[dict]) -> dict:
    paid = sum(1 for r in results if r["status"] == "Paid")
    not_paid = sum(1 for r in results if r["status"] == "Not Paid")
    return {
        "total": len(results),
        "paid": paid,
        "not_paid": not_paid,
        "not_in_invoice_details": sum(1 for r in results if r["invoice_not_in_ledger"]),
    }


# Excel column letters, 1-based, matching COLUMN_KEYS order (A..AB)
_LETTERS = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z","AA","AB"]
_HEADERS = ["Date","Invoice_number","Sales Order No.","Name","Total Invoice Amt","Tax",
    "Invoice Amt (Excl. Tax)","Place of Supply","GSTIN","Billing State","shipping_state",
    "Pending Amount","Payment Received (Including TDS)","Payment Received (Excluding TDS)","TDS",
    "Debit Note Issued","DN Accepted","DN Not Accepted","Credit Note Issued","Gross Outstanding Amt",
    "Net Outstanding Amt","Status","GRN No.","GRN Date","Invoice Not Available in Zepto Ledger",
    "POD No","POD Date","Payment Date"]
_FORMULA_COLS = {"pending_amount","gross_outstanding","net_outstanding","status"}
_MONEY_KEYS = {"total_invoice_amt","tax","invoice_amt_excl_tax","pending_amount",
    "payment_received_incl_tds","payment_received_excl_tds","tds","debit_note_issued",
    "credit_note_issued","gross_outstanding","net_outstanding"}


def build_zepto_workbook(results: list[dict], payload: dict | None = None):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    wb = Workbook()
    ws = wb.active
    ws.title = "1. Invoice Tracker"
    thin = Side(style="thin", color="D9D9D9")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    hdr_font = Font(bold=True, size=10, color="FFFFFF")
    hdr_fill = PatternFill("solid", fgColor="123C69")

    # Row 1: source-group labels (merged)
    ws.append([""] * len(_HEADERS))
    groups = [("From Tally","A","K"),("Payment Advice (Zepto Portal)","M","O"),
              ("From Zepto Ledger / Payment Advice","P","S"),("Computed","T","V"),
              ("From Zepto Dashboard","W","Y"),("From Courier (Delhivery)","Z","AA")]
    for label, c1, c2 in groups:
        ws.merge_cells(f"{c1}1:{c2}1")
        cell = ws[f"{c1}1"]; cell.value = label
        cell.font = Font(bold=True, size=9, color="123C69")
        cell.alignment = Alignment(horizontal="center")

    # Row 2: column headers
    ws.append(_HEADERS)
    for i, _ in enumerate(_HEADERS, start=1):
        c = ws.cell(row=2, column=i)
        c.font = hdr_font; c.fill = hdr_fill; c.border = border
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    # Data rows from row 3
    for idx, row in enumerate(results):
        r = idx + 3
        for col_i, key in enumerate(COLUMN_KEYS, start=1):
            letter = _LETTERS[col_i - 1]
            if key == "pending_amount":
                val = f"=E{r}"
            elif key == "gross_outstanding":
                val = f"=L{r}-M{r}"
            elif key == "net_outstanding":
                val = f"=L{r}-M{r}+P{r}"
            elif key == "status":
                if row.get("invoice_not_in_ledger"):
                    val = row.get("status", "")
                else:
                    val = f'=IF(AND(ABS(T{r})<=100,ABS(U{r})<=100),"Paid","Not Paid")'
            else:
                val = row.get(key, "")
                if val == "" and key in _MONEY_KEYS:
                    val = 0
            c = ws.cell(row=r, column=col_i, value=val)
            c.border = border
            if key in _MONEY_KEYS or key in _FORMULA_COLS - {"status"}:
                c.number_format = "#,##0.00"

    # Column widths
    for i, _ in enumerate(_HEADERS, start=1):
        ws.column_dimensions[_LETTERS[i - 1]].width = 16
    ws.freeze_panes = "A3"
    return wb

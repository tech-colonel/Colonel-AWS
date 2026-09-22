#!/usr/bin/env python3
"""
Shopify M Brands — Sales Working generator.

Implements the "SHOPIFY SALES PROCESS - M BRANDS" SOP: turns the raw Shopify
order export into the Sales Working workbook the accountant builds by hand
each month — same three sheets (Source, Stock Master, Sales-<Month>), same
column layout, same live Excel formulas (VLOOKUP/IF/SUBTOTAL) — so the output
stays auditable/editable in Excel exactly like the hand-built reference
("Shopify Sales Working July 26.xlsx"). Formulas are written, not
precomputed values: open in Excel and press F9 (or just let AutoCalc run) to
see the numbers, same as the reference already requires.

Source (state -> Debtor/Inv-no map) and Stock Master (SKU -> Stock Name) are
slow-changing master data, not derivable from the raw report — they're
carried forward verbatim from a template working file (normally last
month's own output), with only the Inv no. column's month suffix refreshed.

Usage:
    python3 build_sales_working.py \
        --input "<raw Shopify report>.xlsx" \
        --template "<last month's Working file>.xlsx" \
        --output "<new Working file>.xlsx" \
        --month-num 7 --month-label "July 26"
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

import openpyxl
from openpyxl.utils import get_column_letter

EXPORT_STATES = {"texas", "new south wales"}
MAHARASHTRA = "maharashtra"

# Fields located by header name in the raw report. 'order_id_num' takes the
# LAST cell literally named 'Order id' — the raw export lists the order id
# twice: first the text '#NNNN' id, second the bare numeric id that the
# working paper's formulas key off (Exceptional order id, export lookups).
FIELD_ALIASES: dict[str, list[str]] = {
    "order_id_num": ["order id"],
    "lineitem_sku": ["lineitem sku"],
    "lineitem_qty": ["lineitem quantity"],
    "cost_price": ["cost price"],
    "lineitem_price": ["lineitem price"],
    "discount_amount": ["discount amount"],
    "shipping_province": ["shipping province name"],
    "status": ["status"],
    "delivery_status": ["delivery status"],
    "exceptional_order_id": ["exceptional order id", "execptional order id"],
}

COMPUTED_HEADERS = [
    "Invoice Value", "GST Rate", "Taxable Value", "Rate", "Voucher Type",
    "Debtor", "Sales Ledger", "Invoice Number", "Stock Name as per Tally",
    "Output IGST", "Output CGST", "Output SGST", "Cost", "Cost x Qty",
]
# Columns that get a =SUBTOTAL(9, ...) roll-up in row 1, matching the
# reference working paper (quantity + every money column).
SUBTOTAL_INPUT_FIELDS = {"lineitem_qty"}
SUBTOTAL_COMPUTED_HEADERS = {
    "Invoice Value", "Taxable Value", "Output IGST", "Output CGST",
    "Output SGST", "Cost", "Cost x Qty",
}

_HEADER_SCAN_ROWS = 5


def _norm(s) -> str:
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def _find_header_row(ws) -> int:
    """1-based row index of the header row — scans the first few rows for
    the densest row that also contains an 'Order id' cell, in case a future
    export adds a title/filter row above the real header (mirrors the
    header-locating convention used elsewhere in this repo's reco engine)."""
    best_row, best_score = 1, -1
    for row in ws.iter_rows(min_row=1, max_row=_HEADER_SCAN_ROWS):
        cells = [_norm(c.value) for c in row]
        if "order id" not in cells:
            continue
        score = sum(1 for c in cells if c)
        if score > best_score:
            best_row, best_score = row[0].row, score
    return best_row


def _find_field_columns(headers: list[str]) -> dict[str, int]:
    """0-based column index per field (into `headers`)."""
    norm_headers = [_norm(h) for h in headers]
    found: dict[str, int] = {}
    for field, aliases in FIELD_ALIASES.items():
        matches = [i for i, h in enumerate(norm_headers) if h in aliases]
        if not matches:
            raise ValueError(
                f"Could not find a column for '{field}' (looked for {aliases}) "
                f"among headers: {headers}"
            )
        found[field] = matches[-1] if field == "order_id_num" else matches[0]
    return found


def _last_nonblank_row(ws, col_letter: str, min_row: int = 2) -> int:
    last = min_row
    for cell in ws[col_letter]:
        if cell.row >= min_row and cell.value not in (None, ""):
            last = cell.row
    return last


def _copy_sheet_values(src_ws, dst_ws) -> None:
    for row in src_ws.iter_rows():
        for cell in row:
            new_cell = dst_ws.cell(row=cell.row, column=cell.column, value=cell.value)
            if cell.has_style:
                new_cell.number_format = cell.number_format
    for col_letter, dim in src_ws.column_dimensions.items():
        dst_ws.column_dimensions[col_letter].width = dim.width


def _refresh_inv_no_suffix(source_ws, month_num: int) -> None:
    """Rewrites the trailing '-MM' month suffix in the 'Inv no.' column
    (D) to the new month, leaving the Debtor names / state map untouched."""
    suffix = f"-{month_num:02d}"
    for row in source_ws.iter_rows(min_row=2, min_col=4, max_col=4):
        cell = row[0]
        if isinstance(cell.value, str) and re.search(r"-\d{2}$", cell.value):
            cell.value = re.sub(r"-\d{2}$", suffix, cell.value)


def build(input_path: Path, template_path: Path, output_path: Path,
          month_num: int, month_label: str) -> dict:
    wb_in = openpyxl.load_workbook(input_path, data_only=True)
    ws_in = wb_in.worksheets[0]

    header_row_idx = _find_header_row(ws_in)
    raw_headers = [c.value for c in ws_in[header_row_idx]]
    # Trim trailing blank columns and whitespace; fix the export's own typo
    # so the working paper's header reads cleanly.
    while raw_headers and (raw_headers[-1] is None or str(raw_headers[-1]).strip() == ""):
        raw_headers.pop()
    headers = [
        "Exceptional order id" if _norm(h) == "execptional order id" else str(h).strip()
        for h in raw_headers
    ]
    field_cols = _find_field_columns(headers)
    fill_idx = {field_cols["shipping_province"], field_cols["status"], field_cols["delivery_status"]}
    exceptional_idx = field_cols["exceptional_order_id"]

    n_input_cols = len(headers)
    in_letters = [get_column_letter(i + 1) for i in range(n_input_cols)]

    data_rows = list(ws_in.iter_rows(min_row=header_row_idx + 1, max_row=ws_in.max_row, values_only=True))
    # Drop fully-blank trailing rows.
    while data_rows and all(v in (None, "") for v in data_rows[-1][:n_input_cols]):
        data_rows.pop()

    n_data_rows = len(data_rows)
    last_row = 2 + n_data_rows  # data starts row 3

    computed_letters = {
        name: get_column_letter(n_input_cols + 1 + j)
        for j, name in enumerate(COMPUTED_HEADERS)
    }

    def L(field: str) -> str:
        return in_letters[field_cols[field]]

    def C(header: str) -> str:
        return computed_letters[header]

    # -----------------------------------------------------------------
    # Template: carry forward Source + Stock Master verbatim.
    # -----------------------------------------------------------------
    wb_tpl = openpyxl.load_workbook(template_path, data_only=False)
    if "Source" not in wb_tpl.sheetnames or "Stock Master" not in wb_tpl.sheetnames:
        raise ValueError(f"{template_path}: template is missing 'Source' and/or 'Stock Master' sheet")

    out_wb = openpyxl.Workbook()
    out_wb.remove(out_wb.active)

    source_ws = out_wb.create_sheet("Source")
    _copy_sheet_values(wb_tpl["Source"], source_ws)
    _refresh_inv_no_suffix(source_ws, month_num)
    source_last_row = _last_nonblank_row(source_ws, "B")
    export_last_row = max(_last_nonblank_row(source_ws, "F"), 2)

    stock_ws = out_wb.create_sheet("Stock Master")
    _copy_sheet_values(wb_tpl["Stock Master"], stock_ws)
    stock_last_row = _last_nonblank_row(stock_ws, "A")

    # -----------------------------------------------------------------
    # Sales-<month label> sheet
    # -----------------------------------------------------------------
    sales_ws = out_wb.create_sheet(f"Sales-{month_label}")

    # Row 1 — SUBTOTAL roll-ups.
    for field in SUBTOTAL_INPUT_FIELDS:
        letter = L(field)
        sales_ws[f"{letter}1"] = f"=SUBTOTAL(9,{letter}3:{letter}{last_row})"
    for header in SUBTOTAL_COMPUTED_HEADERS:
        letter = C(header)
        sales_ws[f"{letter}1"] = f"=SUBTOTAL(9,{letter}3:{letter}{last_row})"

    # Row 2 — headers.
    for j, h in enumerate(headers):
        sales_ws.cell(row=2, column=j + 1, value=h)
    for j, h in enumerate(COMPUTED_HEADERS):
        sales_ws.cell(row=2, column=n_input_cols + 1 + j, value=h)

    created_at_idx = next((i for i, h in enumerate(headers) if _norm(h) == "created at"), None)

    # Rows 3.. — data.
    for i, raw_row in enumerate(data_rows):
        r = 3 + i
        prev_r = r - 1

        # --- copy-through / fill-down / recompute input columns ---
        for j in range(n_input_cols):
            letter = in_letters[j]
            if j == exceptional_idx:
                sales_ws[f"{letter}{r}"] = f'={L("order_id_num")}{r}&"-C"'
                continue
            val = raw_row[j] if j < len(raw_row) else None
            if j in fill_idx and val in (None, ""):
                sales_ws[f"{letter}{r}"] = f"={letter}{prev_r}" if r > 3 else None
            else:
                sales_ws[f"{letter}{r}"] = val

        if created_at_idx is not None:
            sales_ws[f"{in_letters[created_at_idx]}{r}"].number_format = "yyyy-mm-dd h:mm:ss"

        # --- computed columns (live formulas, per SOP) ---
        province = f'{L("shipping_province")}{r}'
        delivery = f'{L("delivery_status")}{r}'
        gst_rate = f'{C("GST Rate")}{r}'
        taxable = f'{C("Taxable Value")}{r}'
        voucher_type = f'{C("Voucher Type")}{r}'
        cost_cell = f'{C("Cost")}{r}'

        sales_ws[f'{C("Invoice Value")}{r}'] = f'={L("lineitem_price")}{r}-{L("discount_amount")}{r}'
        sales_ws[f'{C("GST Rate")}{r}'] = f'=IF({C("Invoice Value")}{r}>2500,"18","5")'
        sales_ws[f'{C("Taxable Value")}{r}'] = f"={C('Invoice Value')}{r}/({gst_rate}+100)*100"
        sales_ws[f'{C("Rate")}{r}'] = f'=IFERROR({taxable}/{L("lineitem_qty")}{r},0)'
        sales_ws[f'{C("Voucher Type")}{r}'] = (
            f'=IF(OR({delivery}="DELIVERED",{delivery}="IN TRANSIT",{delivery}="PENDING"),'
            f'IF({taxable}<0,"Credit Note","Sales"),"")'
        )
        sales_ws[f'{C("Debtor")}{r}'] = (
            f'=IF({voucher_type}="","",IFERROR(VLOOKUP({province},Source!$B$2:$D${source_last_row},2,0),""))'
        )
        sales_ws[f'{C("Sales Ledger")}{r}'] = (
            f'=IF({voucher_type}="","",IF(OR({province}="Texas",{province}="New South Wales"),'
            f'"Export Shopify Sales",IF({gst_rate}="18","Shopify Sales @18%","Shopify Sales @5%")))'
        )
        sales_ws[f'{C("Invoice Number")}{r}'] = (
            f'=IF({voucher_type}="","",IF(OR({province}="Texas",{province}="New South Wales"),'
            f'IFERROR(VLOOKUP({L("order_id_num")}{r},Source!$F$2:$G${export_last_row},2,0),"")'
            f'&IF({taxable}<0,"CN",""),'
            f'IFERROR(VLOOKUP({province},Source!$B$2:$D${source_last_row},3,0),"")'
            f'&IF({gst_rate}="18","A","")&IF({taxable}<0,"CN","")))'
        )
        sales_ws[f'{C("Stock Name as per Tally")}{r}'] = (
            f'=IF({voucher_type}="","",IFERROR(VLOOKUP({L("lineitem_sku")}{r},'
            f"'Stock Master'!$A$2:$B${stock_last_row},2,0),\"\"))"
        )
        sales_ws[f'{C("Output IGST")}{r}'] = (
            f'=IF({voucher_type}="","",IF(OR(OR({province}="Texas",{province}="New South Wales"),'
            f'{province}="Maharashtra"),0,{taxable}*{gst_rate}%))'
        )
        cgst_sgst = (
            f'=IF({voucher_type}="","",IF(AND(NOT(OR({province}="Texas",{province}="New South Wales")),'
            f'{province}="Maharashtra"),{taxable}*{gst_rate}%/2,0))'
        )
        sales_ws[f'{C("Output CGST")}{r}'] = cgst_sgst
        sales_ws[f'{C("Output SGST")}{r}'] = cgst_sgst
        sales_ws[f'{C("Cost")}{r}'] = (
            f'=IF({voucher_type}="","",IF({voucher_type}="Credit Note",'
            f'-{L("cost_price")}{r},{L("cost_price")}{r}))'
        )
        sales_ws[f'{C("Cost x Qty")}{r}'] = f'=IF({cost_cell}="","",{cost_cell}*{L("lineitem_qty")}{r})'

    output_path.parent.mkdir(parents=True, exist_ok=True)
    out_wb.save(output_path)

    return {
        "rows": n_data_rows,
        "sheet": f"Sales-{month_label}",
        "source_rows": source_last_row - 1,
        "stock_master_rows": stock_last_row - 1,
        "output": str(output_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", required=True, type=Path, help="Raw Shopify order export (.xlsx)")
    parser.add_argument("--template", required=True, type=Path,
                         help="A previous Sales Working file to carry the Source/Stock Master sheets forward from")
    parser.add_argument("--output", required=True, type=Path, help="Path to write the new Sales Working file to")
    parser.add_argument("--month-num", required=True, type=int, help="Numeric month (1-12), used for the Inv no. suffix")
    parser.add_argument("--month-label", required=True, help='Sheet-name label, e.g. "July 26"')
    args = parser.parse_args()

    result = build(args.input, args.template, args.output, args.month_num, args.month_label)
    print(f"Wrote {result['rows']} data rows to sheet '{result['sheet']}' in {result['output']}")
    print(f"  Source: {result['source_rows']} state rows carried forward")
    print(f"  Stock Master: {result['stock_master_rows']} SKU rows carried forward")


if __name__ == "__main__":
    main()

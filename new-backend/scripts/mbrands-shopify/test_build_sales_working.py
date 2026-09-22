#!/usr/bin/env python3
"""
Numeric test for build_sales_working.py.

openpyxl never evaluates formulas (and this box has no Excel/LibreOffice to
recalc with), so the earlier structural diff only proved the GENERATED
formula strings are byte-identical to the hand-built reference. This script
independently re-implements the same formula semantics in Python, runs them
over the full raw report, and prints real numbers — the SUBTOTAL row's
column sums plus QA stats (unmatched SKUs/states, voucher-type breakdown) —
so the output can actually be sanity-checked instead of trusted on faith.

Usage:
    python3 test_build_sales_working.py \
        --input "<raw Shopify report>.xlsx" \
        --template "<Sales Working file with Source/Stock Master>.xlsx"
"""
from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

import openpyxl


def norm(s) -> str:
    return str(s or "").strip().lower()


def safe_float(v) -> tuple[float, bool]:
    """Returns (value, ok). ok=False for a literal error string like '#N/A'
    sitting in the raw report — in real Excel that would make the Cost /
    Cost x Qty formulas (no IFERROR wrapper, per the reference) resolve to
    #N/A too, and break the column's SUBTOTAL. Treated as 0 here so the test
    can still report a total, but flagged separately."""
    if v in (None, ""):
        return 0.0, True
    try:
        return float(v), True
    except (TypeError, ValueError):
        return 0.0, False


def run(input_path: Path, template_path: Path) -> None:
    wb_in = openpyxl.load_workbook(input_path, data_only=True)
    ws_in = wb_in.worksheets[0]
    headers = [str(c.value).strip() if c.value else "" for c in ws_in[1]]
    idx = {norm(h): i for i, h in enumerate(headers)}

    wb_tpl = openpyxl.load_workbook(template_path, data_only=False)
    source_ws = wb_tpl["Source"]
    stock_ws = wb_tpl["Stock Master"]

    # State (full name, lowercased) -> Debtor, Inv-no-base
    state_map: dict[str, tuple[str, str]] = {}
    for row in source_ws.iter_rows(min_row=2, min_col=2, max_col=4, values_only=True):
        state, debtor, inv_no = row
        if state:
            state_map[norm(state)] = (debtor, inv_no)

    sku_map: dict[str, str] = {}
    for row in stock_ws.iter_rows(min_row=2, min_col=1, max_col=2, values_only=True):
        sku, name = row
        if sku:
            sku_map[norm(sku)] = name

    EXPORT_STATES = {"texas", "new south wales"}
    DELIVERY_COUNTED = {"delivered", "in transit", "pending"}

    sums = Counter()
    voucher_type_counts = Counter()
    unmatched_states: Counter = Counter()
    unmatched_skus: Counter = Counter()
    debtor_lookup_fail = 0
    n_rows = 0
    bad_cost_price_rows: list[str] = []

    for row in ws_in.iter_rows(min_row=2, values_only=True):
        n_rows += 1
        price = float(row[idx["lineitem price"]] or 0)
        discount = float(row[idx["discount amount"]] or 0)
        qty = float(row[idx["lineitem quantity"]] or 0)
        cost_price, cost_price_ok = safe_float(row[idx["cost price"]])
        if not cost_price_ok:
            bad_cost_price_rows.append(str(row[1]))
        province = str(row[idx["shipping province name"]] or "").strip()
        delivery_status = str(row[idx["delivery status"]] or "").strip().lower()
        sku = row[idx["lineitem sku"]]

        invoice_value = price - discount
        gst_rate = 18 if invoice_value > 2500 else 5
        taxable_value = invoice_value / (gst_rate + 100) * 100

        sums["lineitem_qty"] += qty
        sums["invoice_value"] += invoice_value
        sums["taxable_value"] += taxable_value

        voucher_type = ""
        if delivery_status in DELIVERY_COUNTED:
            voucher_type = "Credit Note" if taxable_value < 0 else "Sales"
        voucher_type_counts[voucher_type or "(blank)"] += 1

        if voucher_type == "":
            continue  # every downstream column is blank -> contributes 0

        province_n = norm(province)
        is_export = province_n in EXPORT_STATES

        if province_n not in state_map and not is_export:
            unmatched_states[province] += 1
        if province_n not in state_map:
            debtor_lookup_fail += 1

        sku_n = norm(sku)
        if sku_n not in sku_map:
            unmatched_skus[sku] += 1

        if is_export:
            igst = cgst = sgst = 0.0
        elif province_n == "maharashtra":
            cgst = sgst = taxable_value * gst_rate / 2 / 100
            igst = 0.0
        else:
            igst = taxable_value * gst_rate / 100
            cgst = sgst = 0.0

        cost = -cost_price if voucher_type == "Credit Note" else cost_price
        cost_x_qty = cost * qty

        sums["output_igst"] += igst
        sums["output_cgst"] += cgst
        sums["output_sgst"] += sgst
        sums["cost"] += cost
        sums["cost_x_qty"] += cost_x_qty

    print(f"Rows processed: {n_rows}")
    print()
    print("Voucher Type breakdown (rows):")
    for k, v in voucher_type_counts.most_common():
        print(f"  {k:14s} {v}")
    print()
    print("SUBTOTAL column sums (what row 1's =SUBTOTAL(9,...) formulas resolve to):")
    print(f"  Lineitem quantity : {sums['lineitem_qty']:,.0f}")
    print(f"  Invoice Value     : {sums['invoice_value']:,.2f}")
    print(f"  Taxable Value     : {sums['taxable_value']:,.2f}")
    print(f"  Output IGST       : {sums['output_igst']:,.2f}")
    print(f"  Output CGST       : {sums['output_cgst']:,.2f}")
    print(f"  Output SGST       : {sums['output_sgst']:,.2f}")
    print(f"  Cost              : {sums['cost']:,.2f}")
    print(f"  Cost x Qty        : {sums['cost_x_qty']:,.2f}")
    print()
    total_gst = sums["output_igst"] + sums["output_cgst"] + sums["output_sgst"]
    taxable_plus_gst = sums["taxable_value"] + total_gst
    print(f"  Taxable + total GST (IGST+CGST+SGST) = {taxable_plus_gst:,.2f}")
    print(f"  vs. Invoice Value total               = {sums['invoice_value']:,.2f}")
    print("  (won't match exactly: Invoice Value total includes voucher-type-blank rows"
          " — cancelled/RTO/refunded orders — that carry no GST)")
    print()
    print(f"Debtor VLOOKUP would fail (state not in Source map) on {debtor_lookup_fail} counted rows")
    if unmatched_states:
        print("  Unmatched shipping states:", dict(unmatched_states))
    print(f"Stock Name VLOOKUP would fail (SKU not in Stock Master) on {sum(unmatched_skus.values())} counted rows"
          f" ({len(unmatched_skus)} distinct SKUs)")
    if unmatched_skus:
        for sku, n in unmatched_skus.most_common(10):
            print(f"    {sku!r}: {n} rows")
    if bad_cost_price_rows:
        print()
        print(f"Cost price is a literal error string (e.g. '#N/A') in the raw report on "
              f"{len(bad_cost_price_rows)} row(s) — in real Excel the Cost/Cost x Qty formulas "
              f"(no IFERROR wrapper) would show #N/A there too, and SUBTOTAL over that column "
              f"would break: {bad_cost_price_rows}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--template", required=True, type=Path)
    args = parser.parse_args()
    run(args.input, args.template)


if __name__ == "__main__":
    main()

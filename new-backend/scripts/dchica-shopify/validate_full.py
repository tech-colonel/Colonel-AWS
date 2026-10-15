# Column-by-column sum validation for every in-scope generated sheet against the
# hand-built reference workbook. For numeric columns: compares SUM(generated) vs
# SUM(expected) with delta/%. For non-numeric columns: compares distinct-value sets.
#
# Sheet name mapping (generated -> expected):
#   Working                -> Total sales breakdown (P) With
#   Product Type            -> Product Type
#   HSN Code                -> HSN Code
#   Shipping Product Type   -> Shipping Product Type
#   GSTR HSN                -> GSTR HSN   (real Excel PivotTable — read cached values)
#   GSTR B2C                -> GSTR B2C   (real Excel PivotTable — read cached values)
import openpyxl

GEN = "/Users/apple/Documents/Colonel-AWS/new-backend/scripts/dchica-shopify/output_generated.xlsx"
EXP = "/Users/apple/Documents/Colonel-AWS/test files receivables/shopify dchica/Total sales breakdown (P) With Order Name Jul-26 Working.xlsx"

wb_gen = openpyxl.load_workbook(GEN, read_only=True, data_only=True)
wb_exp = openpyxl.load_workbook(EXP, read_only=True, data_only=True)


def is_number(v):
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return True
    if v is None or v == '':
        return False
    try:
        float(str(v).replace(',', ''))
        return True
    except (TypeError, ValueError):
        return False


def to_num(v):
    if v is None or v == '':
        return 0.0
    try:
        return float(str(v).replace(',', ''))
    except (TypeError, ValueError):
        return 0.0


def load_sheet(wb, name, header_row, data_start_row):
    ws = wb[name]
    header = [c.value for c in next(ws.iter_rows(min_row=header_row, max_row=header_row))]
    rows = list(ws.iter_rows(min_row=data_start_row, values_only=True))
    # drop fully-empty trailing rows
    while rows and all(v is None for v in rows[-1]):
        rows.pop()
    return header, rows


def report_sheet(label, gen_header, gen_rows, exp_header, exp_rows, ignore_cols=(), categorical_cols=()):
    print(f"\n{'='*90}\nSHEET: {label}\n{'='*90}")
    print(f"  generated rows: {len(gen_rows)}   expected rows: {len(exp_rows)}"
          f"  {'✓' if len(gen_rows)==len(exp_rows) else '✗ ROW COUNT MISMATCH'}")

    common_cols = [c for c in gen_header if c in exp_header and c not in ignore_cols]
    only_in_gen = [c for c in gen_header if c not in exp_header]
    only_in_exp = [c for c in exp_header if c not in gen_header and c not in ignore_cols]
    if only_in_gen:
        print(f"  columns only in generated: {only_in_gen}")
    if only_in_exp:
        print(f"  columns only in expected:  {only_in_exp}")

    gi = {c: gen_header.index(c) for c in common_cols}
    ei = {c: exp_header.index(c) for c in common_cols}

    print(f"\n  {'Column':<28}{'Gen Sum':>18}{'Exp Sum':>18}{'Delta':>14}{'Delta%':>10}  Match")
    for c in common_cols:
        gcol = [r[gi[c]] for r in gen_rows]
        ecol = [r[ei[c]] for r in exp_rows]
        numeric = (c not in categorical_cols) and (any(is_number(v) for v in ecol) or any(is_number(v) for v in gcol))
        if numeric:
            gsum = sum(to_num(v) for v in gcol)
            esum = sum(to_num(v) for v in ecol)
            delta = gsum - esum
            pct = (delta / esum * 100) if esum else (0.0 if gsum == 0 else float('inf'))
            ok = abs(delta) <= max(0.5, abs(esum) * 1e-6)
            mark = '✓' if ok else '✗'
            print(f"  {c:<28}{gsum:>18,.2f}{esum:>18,.2f}{delta:>14,.2f}{pct:>9.3f}%  {mark}")
        else:
            gset = set(str(v).strip() for v in gcol if v not in (None, ''))
            eset = set(str(v).strip() for v in ecol if v not in (None, ''))
            only_g = gset - eset
            only_e = eset - gset
            ok = not only_g and not only_e
            mark = '✓' if ok else '✗'
            print(f"  {c:<28}{'(distinct: ' + str(len(gset)) + ')':>18}"
                  f"{'(distinct: ' + str(len(eset)) + ')':>18}{'':>14}{'':>10}  {mark}")
            if only_g:
                sample = sorted(only_g)[:10]
                print(f"      values only in generated ({len(only_g)}): {sample}")
            if only_e:
                sample = sorted(only_e)[:10]
                print(f"      values only in expected  ({len(only_e)}): {sample}")


# ── 1. Working <-> Total sales breakdown (P) With  ───────────────────────────
gh, grows = load_sheet(wb_gen, 'Working', 1, 2)
eh, erows = load_sheet(wb_exp, 'Total sales breakdown (P) With ', 4, 5)
report_sheet('Working  <->  Total sales breakdown (P) With ', gh, grows, eh, erows)

# ── 2. Product Type ────────────────────────────────────────────────────────
gh, grows = load_sheet(wb_gen, 'Product Type', 1, 2)
eh, erows = load_sheet(wb_exp, 'Product Type', 1, 2)
report_sheet('Product Type', gh, grows, eh, erows)

# ── 3. HSN Code ─────────────────────────────────────────────────────────────
gh, grows = load_sheet(wb_gen, 'HSN Code', 1, 2)
eh, erows = load_sheet(wb_exp, 'HSN Code', 1, 2)
report_sheet('HSN Code', gh, grows, eh, erows)

# ── 4. Shipping Product Type ────────────────────────────────────────────────
gh, grows = load_sheet(wb_gen, 'Shipping Product Type', 1, 2)
eh, erows = load_sheet(wb_exp, 'Shipping Product Type', 2, 3)
report_sheet('Shipping Product Type', gh, grows, eh, erows)

# ── 5 & 6. GSTR HSN / GSTR B2C — real Excel PivotTables in the expected file.
# Cached pivot output sits at fixed offsets inside the sheet (location ref from
# the pivotTable XML: GSTR HSN -> A6:G16, GSTR B2C -> A6:F86). Header is on
# row 7 (row 6 is the page-filter block), data starts row 8, with a trailing
# "Grand Total" row we treat as a normal data row (it is just another summed row).
for label, sheet, row_key_cols in [
    ('GSTR HSN', 'GSTR HSN', ['HSN Code', 'GST Rate']),
    ('GSTR B2C', 'GSTR B2C', ['GST Rate', 'Shipping region']),
]:
    ws = wb_exp[sheet]
    all_rows = list(ws.iter_rows(min_row=1, values_only=True))
    # find the header row: first row containing 'Sum of Taxable' as a cell value
    # (its row-label cells are already the real column names, e.g. 'HSN Code').
    header_row_idx = next(i for i, r in enumerate(all_rows) if 'Sum of Taxable' in r)
    exp_header = list(all_rows[header_row_idx])
    exp_rows_raw = all_rows[header_row_idx + 1:]
    while exp_rows_raw and all(v is None for v in exp_rows_raw[-1]):
        exp_rows_raw.pop()
    # drop the synthetic "Grand Total" summary row — the generated groupBy output
    # has no such row, so it isn't a real group to compare row-for-row.
    exp_rows = [r for r in exp_rows_raw if r[0] != 'Grand Total']

    gh_out, grows = load_sheet(wb_gen, sheet, 1, 2)
    report_sheet(label, gh_out, grows, exp_header, exp_rows, categorical_cols=row_key_cols)

print(f"\n{'='*90}\nDone.\n{'='*90}")

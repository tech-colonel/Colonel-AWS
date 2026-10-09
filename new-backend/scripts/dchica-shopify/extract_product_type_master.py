# Extracts the standalone "Product Type" master sheet (SKU -> Product type, headers:
# "SKU", "Product type") from the expected/reference workbook, verbatim. This is a
# DIFFERENT master from sku_master.json: sku_master.json holds the coarse SKU -> Product
# Type mapping actually used by the Working-sheet HSN/GST lookups (derived from the
# completed working sheet, since the raw "Product Type" sheet's categories don't match
# the coarse categories used for HSN/GST — see extract_masters.py's comment). This
# script instead dumps the raw "Product Type" sheet as-is so the "Product Type" output
# sheet can be validated against the reference file's own master dump, byte for byte.
import json
import openpyxl

BASE = "/Users/apple/Documents/Colonel-AWS/test files receivables/shopify dchica"
XL = f"{BASE}/Total sales breakdown (P) With Order Name Jul-26 Working.xlsx"
OUT = "/Users/apple/Documents/Colonel-AWS/new-backend/scripts/dchica-shopify/product_type_master.json"

wb = openpyxl.load_workbook(XL, read_only=True, data_only=True)
ws = wb['Product Type']
rows = []
for row in ws.iter_rows(min_row=2, values_only=True):
    sku, pt = row[0], row[1]
    if sku is None and pt is None:
        continue
    rows.append({"SKU": sku, "Product type": pt})

with open(OUT, "w") as f:
    json.dump(rows, f, indent=2)

print("wrote", len(rows), "rows to", OUT)

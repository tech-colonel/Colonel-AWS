"""Independent readers for Amazon MTR CSVs and Settlement ledger TSVs (Koparo).

Traps handled:
  - Dotted dates DD.MM.YYYY parsed explicitly (never month-first).
  - Settlement row 1 is a file header (total-amount, no transaction-type) -> dropped by
    position, NOT by blank transaction-type (standalone FBA storage rows are also blank).
  - Revised settlements: same settlement-id under a new report id -> keep highest report id.
  - Decimal only, never float.
"""
import csv, os, re, glob
from decimal import Decimal
from datetime import datetime, date

MTR_DIR = "/Users/dhavalchauhan/Downloads/KOPARO MTR"
LEDGER_DIR = ("/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation/"
              "new-backend/outputs/amazon-ledgers/Koparo")

ZERO = Decimal("0")


def D(v):
    if v is None:
        return ZERO
    v = str(v).strip().replace(",", "")
    if v == "" or v == "-":
        return ZERO
    try:
        return Decimal(v)
    except Exception:
        return ZERO


def parse_dotted(v):
    """'19.06.2026' / '19.06.2026 13:02:55 UTC' -> date. DD.MM.YYYY, explicit."""
    if not v:
        return None
    m = re.match(r"^\s*(\d{2})\.(\d{2})\.(\d{4})", str(v))
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return date(y, mo, d)


def parse_mtr_date(v):
    """MTR mixes TWO formats in the same dataset. Both parsed explicitly, never
    month-first:
      'YYYY-MM-DD HH:MM:SS'  (Apr B2C, Jun B2C, Jul)
      'DD-MM-YYYY HH:MM'     (Apr B2B, Jun B2B, Aug, stock transfers)
    """
    if not v:
        return None
    v = str(v).strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", v)
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.match(r"^(\d{2})-(\d{2})-(\d{4})", v)
    if m:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    m = re.match(r"^(\d{2})\.(\d{2})\.(\d{4})", v)
    if m:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    return None


parse_iso = parse_mtr_date


def open_mtr(path):
    """Some MTR exports carry a 2-row preamble (a totals row + a blank row) BEFORE the
    real header. Find the header row by content instead of assuming line 1."""
    with open(path, newline="", encoding="utf-8-sig") as fh:
        lines = fh.readlines()
    hdr = 0
    for i, ln in enumerate(lines[:10]):
        if ln.lstrip('"').startswith(("Seller Gstin", "Gstin Of Receiver")):
            hdr = i
            break
    return csv.DictReader(lines[hdr:]), hdr


# ----------------------------------------------------------------- MTR

def mtr_files():
    out = {"b2b": [], "b2c": [], "stock": []}
    for p in sorted(glob.glob(os.path.join(MTR_DIR, "*.csv"))):
        n = os.path.basename(p).upper()
        if "STOCK_TRANSFER" in n:
            out["stock"].append(p)
        elif "MTR_B2B" in n:
            out["b2b"].append(p)
        elif "MTR_B2C" in n:
            out["b2c"].append(p)
    return out


def read_mtr(kind):
    """kind in b2b|b2c. Yields dicts with normalised numerics.

    MTR sign convention (verified): on Refund rows Invoice Amount / Tax Exclusive Gross /
    Total Tax Amount / the tax columns are NEGATIVE, but 'Principal Amount' stays POSITIVE.
    We therefore derive a signed principal from 'Principal Amount Basis' (tax-exclusive,
    correctly signed) and keep the raw fields too.
    """
    rows = []
    for p in mtr_files()[kind]:
        rd, _hdr = open_mtr(p)
        if True:
            for r in rd:
                tt = (r.get("Transaction Type") or "").strip()
                if not tt:
                    continue
                sign = Decimal("-1") if tt in ("Refund", "Cancel") and D(r.get("Invoice Amount")) < 0 else Decimal("1")
                rows.append({
                    "src_file": os.path.basename(p),
                    "kind": kind,
                    "txn_type": tt,
                    "order_id": (r.get("Order Id") or "").strip(),
                    "sku": (r.get("Sku") or "").strip(),
                    "qty": D(r.get("Quantity")),
                    "order_date": parse_iso(r.get("Order Date")),
                    "shipment_date": parse_iso(r.get("Shipment Date")),
                    "invoice_date": parse_iso(r.get("Invoice Date")),
                    "invoice_amount": D(r.get("Invoice Amount")),
                    "tax_excl_gross": D(r.get("Tax Exclusive Gross")),
                    "total_tax": D(r.get("Total Tax Amount")),
                    "principal_incl": D(r.get("Principal Amount")),          # TAX-INCLUSIVE, unsigned on refunds
                    "principal_excl": D(r.get("Principal Amount Basis")),    # tax-exclusive, signed
                    "shipping_incl": D(r.get("Shipping Amount")),
                    "shipping_excl": D(r.get("Shipping Amount Basis")),
                    "promo_disc": D(r.get("Item Promo Discount")),
                    "ship_promo_disc": D(r.get("Shipping Promo Discount")),
                    "ship_promo_tax": D(r.get("Shipping Promo Tax")),
                    "ship_tax_tot": D(r.get("Shipping Cgst Tax")) + D(r.get("Shipping Sgst Tax")) + D(r.get("Shipping Igst Tax")) + D(r.get("Shipping Utgst Tax")),
                    "cgst": D(r.get("Cgst Tax")), "sgst": D(r.get("Sgst Tax")),
                    "igst": D(r.get("Igst Tax")), "utgst": D(r.get("Utgst Tax")),
                    "ship_cgst": D(r.get("Shipping Cgst Tax")), "ship_sgst": D(r.get("Shipping Sgst Tax")),
                    "ship_igst": D(r.get("Shipping Igst Tax")), "ship_utgst": D(r.get("Shipping Utgst Tax")),
                    "ship_from_state": (r.get("Ship From State") or "").strip(),
                    "ship_to_state": (r.get("Ship To State") or "").strip(),
                    "bill_to_gstin": (r.get("Customer Bill To Gstid") or "").strip(),
                    "channel": (r.get("Fulfillment Channel") or "").strip(),
                    "_sign": sign,
                })
    return rows


def read_stock_transfer():
    rows = []
    for p in mtr_files()["stock"]:
        rd, _hdr = open_mtr(p)
        if True:
            for r in rd:
                if not (r.get("Order Id") or "").strip() and not (r.get("Transaction Id") or "").strip():
                    continue
                rows.append({
                    "src_file": os.path.basename(p),
                    "txn_type": (r.get("Transaction Type") or "").strip(),
                    "order_id": (r.get("Order Id") or "").strip(),
                    "txn_id": (r.get("Transaction Id") or "").strip(),
                    "invoice_date": parse_iso(r.get("Invoice Date")),
                    "invoice_value": D(r.get("Invoice Value")),
                    "taxable_value": D(r.get("Taxable Value")),
                    "sku": (r.get("Sku") or "").strip(),
                    "qty": D(r.get("Quantity")),
                })
    return rows


# ------------------------------------------------------- SETTLEMENT

def settlement_file_map():
    """report_id -> (path, settlement_id). Dedupes revised settlements."""
    seen = {}       # settlement_id -> (report_id, path)
    dropped = []
    for p in sorted(glob.glob(os.path.join(LEDGER_DIR, "settlement_ledger_*.tsv"))):
        report_id = os.path.basename(p).split("_")[-1].split(".")[0]
        with open(p, newline="", encoding="utf-8-sig") as fh:
            rd = csv.DictReader(fh, delimiter="\t")
            first = next(rd, None)
        if first is None:
            continue
        sid = (first.get("settlement-id") or "").strip()
        if sid in seen:
            prev_rid, prev_p = seen[sid]
            if int(report_id) > int(prev_rid):
                dropped.append((sid, prev_rid, os.path.basename(prev_p)))
                seen[sid] = (report_id, p)
            else:
                dropped.append((sid, report_id, os.path.basename(p)))
        else:
            seen[sid] = (report_id, p)
    return seen, dropped


def read_settlement():
    keep, dropped = settlement_file_map()
    rows = []
    headers = []
    for sid, (rid, p) in sorted(keep.items()):
        with open(p, newline="", encoding="utf-8-sig") as fh:
            rd = csv.DictReader(fh, delimiter="\t")
            for i, r in enumerate(rd):
                if i == 0:
                    # positional file-header row: carries total-amount, no transaction-type
                    headers.append({
                        "settlement_id": sid, "report_id": rid,
                        "start": parse_dotted(r.get("settlement-start-date")),
                        "end": parse_dotted(r.get("settlement-end-date")),
                        "deposit": parse_dotted(r.get("deposit-date")),
                        "total_amount": D(r.get("total-amount")),
                        "file": os.path.basename(p),
                    })
                    continue
                rows.append({
                    "settlement_id": sid, "report_id": rid,
                    "txn_type": (r.get("transaction-type") or "").strip(),
                    "order_id": (r.get("order-id") or "").strip(),
                    "adjustment_id": (r.get("adjustment-id") or "").strip(),
                    "amount_type": (r.get("amount-type") or "").strip(),
                    "amount_desc": (r.get("amount-description") or "").strip(),
                    "amount": D(r.get("amount")),
                    "posted_date": parse_dotted(r.get("posted-date")),
                    "sku": (r.get("sku") or "").strip(),
                    "qty": D(r.get("quantity-purchased")),
                })
    return rows, headers, dropped

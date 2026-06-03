"""GSTR-1 vs Books Reconciliation Engine.

SOP Summary
-----------
1. Read Tally Sales Register (+ Credit Note Register if separate).
2. Read Amazon Ready-to-File Report.
3. In the Books dataset, detect and remove summarised Amazon entries
   ("Amazon Intra-State Sales", "Amazon Inter-State Sales" ledger rows).
   Replace them with invoice-level data from the Amazon report.
4. Read GSTR-1 export — B2B and B2C are on separate sheets.
5. Monthly summary check: compare Books totals vs GSTR-1 totals month-wise.
6. B2B detail: invoice-level match by buyer GSTIN + invoice number.
7. B2C detail: state-wise + rate-wise aggregated match.
8. Classify all differences and build output payload.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from io import BytesIO, StringIO
from typing import Any

import pandas as pd
from openpyxl import load_workbook

from .core import json_safe, normalize_doc_no, parse_date, round_money
from .parsers import normalize_header

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Field alias tables
# ---------------------------------------------------------------------------

TALLY_ALIASES = {
    "doc_no": [
        "invoice no", "invoice no.", "invoice number", "ref no", "ref no.",
        "ref. no.", "ref. no", "voucher no", "voucher no.", "bill no", "bill no.", "no.",
    ],
    "doc_date": ["date", "invoice date", "voucher date", "bill date"],
    "party_name": ["particulars", "party name", "ledger name", "name"],
    "buyer_gstin": ["gstin", "gstin/uin", "gstin of party", "gst no", "gst number"],
    "place_of_supply": ["place of supply", "state", "state name", "pos"],
    "tax_rate": ["rate", "tax rate", "gst rate", "rate %", "rate(%)"],
    "taxable_value": [
        "taxable value", "taxable amount", "assessable value", "net amount",
        "taxable val", "taxable",
    ],
    "cgst": ["cgst", "central tax", "cgst amount"],
    "sgst": ["sgst", "sgst/utgst", "state tax", "utgst", "sgst amount", "sgst/utgst amount"],
    "igst": ["igst", "integrated tax", "igst amount"],
    "cess": ["cess", "cess amount"],
    "invoice_value": ["total", "invoice value", "total amount", "gross amount", "amount"],
    "doc_type": ["voucher type", "type", "doc type", "vch type"],
}

AMAZON_ALIASES = {
    "doc_no": [
        "invoice number", "tax invoice number", "invoice no", "invoice no.",
        "tax invoice no", "shipment id",
    ],
    "doc_date": ["invoice date", "date", "tax invoice date", "shipment date"],
    "party_name": [
        "bill-to name", "buyer name", "customer name", "ship-to name",
        "recipient name", "buyer",
    ],
    "buyer_gstin": [
        "bill-to gstin", "buyer gstin", "gstin", "customer gstin",
        "recipient gstin", "gstin of recipient",
    ],
    "place_of_supply": [
        "ship-to state", "place of supply", "state", "state name",
        "shipping state", "destination state",
    ],
    "state_code": ["state code", "ship-to state code", "pos code"],
    "tax_rate": ["tax rate", "gst rate", "rate", "rate(%)"],
    "taxable_value": ["taxable value", "net sales", "taxable amount", "taxable"],
    "cgst": ["cgst", "central tax", "cgst amount"],
    "sgst": ["sgst", "sgst/utgst", "state tax", "sgst amount"],
    "igst": ["igst", "integrated tax", "igst amount"],
    "cess": ["cess", "cess amount"],
    "invoice_value": ["invoice value", "total value", "gross", "total amount"],
    "invoice_type": ["invoice type", "type", "transaction type"],
}

GSTR1_B2B_ALIASES = {
    "doc_no": ["invoice number", "invoice no.", "invoice no", "document number", "no."],
    "doc_date": ["invoice date", "date of invoice", "date", "invoice dt"],
    "party_name": [
        "receiver name", "trade/legal name", "trade name", "legal name",
        "recipient name", "buyer name",
    ],
    "buyer_gstin": [
        "gstin of recipient", "recipient gstin", "gstin", "buyer gstin",
        "gstin/uin of recipient",
    ],
    "place_of_supply": ["place of supply", "pos", "state"],
    "tax_rate": ["rate", "tax rate", "applicable % of tax rate", "gst rate"],
    "taxable_value": ["taxable value", "taxable value (rs.)", "taxable"],
    "cgst": ["cgst amount", "central tax amount", "cgst"],
    "sgst": ["sgst/utgst amount", "state tax amount", "sgst", "utgst amount"],
    "igst": ["igst amount", "integrated tax amount", "igst"],
    "cess": ["cess amount", "cess"],
    "invoice_value": ["invoice value", "total invoice value", "invoice value (rs.)"],
    "doc_type": ["invoice type", "document type", "type"],
}

GSTR1_B2C_ALIASES = {
    "place_of_supply": ["place of supply", "pos", "state", "state name"],
    "tax_rate": ["applicable % of tax rate", "rate", "tax rate", "gst rate", "rate(%)"],
    "taxable_value": ["taxable value", "taxable"],
    "cgst": ["cgst amount", "central tax", "cgst"],
    "sgst": ["sgst/utgst amount", "state tax", "sgst", "utgst"],
    "igst": ["igst amount", "integrated tax", "igst"],
    "cess": ["cess amount", "cess"],
    "invoice_value": ["total invoice value", "invoice value"],
    "b2c_type": ["type", "b2c type"],
}

# ---------------------------------------------------------------------------
# Amazon summary detection keywords (Tally ledger names)
# ---------------------------------------------------------------------------
AMAZON_SUMMARY_KEYWORDS = (
    "amazon intra", "amazon inter", "amazon sale", "amazon seller",
    "amazon b2b", "amazon b2c", "amazon ecommerce",
)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class SalesRecord:
    source: str          # "Books", "Amazon", "GSTR-1 B2B", "GSTR-1 B2C"
    row_id: str
    month: str
    doc_date: str
    doc_no: str
    normalized_doc_no: str
    doc_type: str        # "INV" or "CRN"
    party_name: str
    buyer_gstin: str     # populated for B2B; empty for B2C
    place_of_supply: str
    tax_rate: float
    taxable_value: float
    cgst: float
    sgst: float
    igst: float
    cess: float
    invoice_value: float
    is_b2b: bool
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def total_tax(self) -> float:
        return round_money(self.cgst + self.sgst + self.igst + self.cess)

    def as_dict(self) -> dict[str, Any]:
        result = json_safe(asdict(self))
        result["total_tax"] = self.total_tax
        return result


@dataclass
class B2BRecoResult:
    category: str
    confidence: int
    books: SalesRecord | None
    gstr1: SalesRecord | None
    mismatch_fields: list[str]
    suggested_action: str
    explanation: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "confidence": self.confidence,
            "books": self.books.as_dict() if self.books else None,
            "gstr1": self.gstr1.as_dict() if self.gstr1 else None,
            "mismatch_fields": self.mismatch_fields,
            "suggested_action": self.suggested_action,
            "explanation": self.explanation,
            "reco_level": "B2B",
        }


@dataclass
class B2CRecoResult:
    category: str
    month: str
    place_of_supply: str
    tax_rate: float
    books_taxable: float
    gstr1_taxable: float
    books_cgst: float
    gstr1_cgst: float
    books_sgst: float
    gstr1_sgst: float
    books_igst: float
    gstr1_igst: float
    diff_taxable: float
    diff_cgst: float
    diff_sgst: float
    diff_igst: float
    suggested_action: str

    def as_dict(self) -> dict[str, Any]:
        return json_safe({
            "category": self.category,
            "month": self.month,
            "place_of_supply": self.place_of_supply,
            "tax_rate": self.tax_rate,
            "books_taxable": self.books_taxable,
            "gstr1_taxable": self.gstr1_taxable,
            "books_cgst": self.books_cgst,
            "gstr1_cgst": self.gstr1_cgst,
            "books_sgst": self.books_sgst,
            "gstr1_sgst": self.gstr1_sgst,
            "books_igst": self.books_igst,
            "gstr1_igst": self.gstr1_igst,
            "diff_taxable": self.diff_taxable,
            "diff_cgst": self.diff_cgst,
            "diff_sgst": self.diff_sgst,
            "diff_igst": self.diff_igst,
            "suggested_action": self.suggested_action,
            "reco_level": "B2C",
        })


@dataclass
class MonthlySummaryRow:
    month: str
    books_taxable: float
    gstr1_taxable: float
    books_cgst: float
    gstr1_cgst: float
    books_sgst: float
    gstr1_sgst: float
    books_igst: float
    gstr1_igst: float
    diff_taxable: float
    diff_cgst: float
    diff_sgst: float
    diff_igst: float
    status: str   # "Matched" / "Difference"

    def as_dict(self) -> dict[str, Any]:
        return json_safe(asdict(self))


# ---------------------------------------------------------------------------
# Upload reader
# ---------------------------------------------------------------------------

def read_gstr1_vs_books_uploads(
    files: dict[str, dict],
) -> tuple[list[SalesRecord], list[SalesRecord], list[SalesRecord]]:
    """Read uploaded files and return (books_records, gstr1_b2b, gstr1_b2c)."""
    tally_file = files.get("tally_sales")
    amazon_file = files.get("amazon")
    gstr1_file = files.get("gstr1")

    if not tally_file:
        raise ValueError("Upload the Tally Sales Register file.")
    if not gstr1_file:
        raise ValueError("Upload the GSTR-1 export file.")

    tally_records = _read_tally(tally_file)
    logger.info("Tally: %d raw records", len(tally_records))

    amazon_records: list[SalesRecord] = []
    if amazon_file and amazon_file.get("content"):
        amazon_records = _read_amazon(amazon_file)
        logger.info("Amazon: %d records", len(amazon_records))

    books_records = _merge_amazon_into_books(tally_records, amazon_records)
    logger.info("Books after Amazon merge: %d records", len(books_records))

    gstr1_b2b, gstr1_b2c = _read_gstr1(gstr1_file)
    logger.info("GSTR-1 B2B: %d, B2C: %d", len(gstr1_b2b), len(gstr1_b2c))

    if not books_records:
        raise ValueError("No sales records found in Tally file. Check column headers.")
    if not gstr1_b2b and not gstr1_b2c:
        raise ValueError("No records found in GSTR-1 file. Check that it has B2B and/or B2C sheets.")

    return books_records, gstr1_b2b, gstr1_b2c


# ---------------------------------------------------------------------------
# File readers
# ---------------------------------------------------------------------------

def _read_tally(file_info: dict) -> list[SalesRecord]:
    filename = file_info["filename"]
    data = file_info["content"]
    suffix = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""

    if suffix in {"xlsx", "xlsm"}:
        rows = _excel_to_rows(data)
    elif suffix == "csv":
        rows = pd.read_csv(StringIO(data.decode("utf-8-sig", errors="replace"))).fillna("").to_dict(orient="records")
    else:
        raise ValueError(f"Unsupported Tally file type: {filename}")

    records = []
    for idx, row in enumerate(rows, 1):
        getter = _build_getter(row, TALLY_ALIASES)
        party = str(getter("party_name") or "").strip()
        doc_no = str(getter("doc_no") or "").strip()
        taxable = round_money(getter("taxable_value"))
        invoice_val = round_money(getter("invoice_value"))

        if not party and not doc_no and not taxable and not invoice_val:
            continue
        if party.lower() in ("total", "grand total", "particulars", "name", ""):
            if not doc_no and not taxable:
                continue

        raw_type = str(getter("doc_type") or "").lower()
        doc_type = "CRN" if any(k in raw_type for k in ("credit", "cn ", "crn", "c/n")) else "INV"

        date_raw = getter("doc_date")
        doc_date = parse_date(date_raw)

        records.append(SalesRecord(
            source="Books",
            row_id=f"TALLY-{idx}",
            month=_month_from_date(doc_date),
            doc_date=doc_date,
            doc_no=doc_no,
            normalized_doc_no=normalize_doc_no(doc_no),
            doc_type=doc_type,
            party_name=party,
            buyer_gstin=_clean_gstin(getter("buyer_gstin")),
            place_of_supply=_normalize_state(str(getter("place_of_supply") or "")),
            tax_rate=_parse_rate(getter("tax_rate")),
            taxable_value=taxable,
            cgst=round_money(getter("cgst")),
            sgst=round_money(getter("sgst")),
            igst=round_money(getter("igst")),
            cess=round_money(getter("cess")),
            invoice_value=invoice_val,
            is_b2b=bool(_clean_gstin(getter("buyer_gstin"))),
            raw={str(k): v for k, v in row.items()},
        ))
    return records


def _read_amazon(file_info: dict) -> list[SalesRecord]:
    filename = file_info["filename"]
    data = file_info["content"]
    suffix = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""

    if suffix in {"xlsx", "xlsm"}:
        rows = _excel_to_rows(data)
    elif suffix == "csv":
        rows = pd.read_csv(StringIO(data.decode("utf-8-sig", errors="replace"))).fillna("").to_dict(orient="records")
    else:
        raise ValueError(f"Unsupported Amazon file type: {filename}")

    records = []
    for idx, row in enumerate(rows, 1):
        getter = _build_getter(row, AMAZON_ALIASES)
        doc_no = str(getter("doc_no") or "").strip()
        taxable = round_money(getter("taxable_value"))
        if not doc_no and not taxable:
            continue

        inv_type = str(getter("invoice_type") or "").upper()
        doc_type = "CRN" if any(k in inv_type for k in ("CREDIT", "REFUND", "RETURN")) else "INV"
        buyer_gstin = _clean_gstin(getter("buyer_gstin"))

        date_raw = getter("doc_date")
        doc_date = parse_date(date_raw)

        records.append(SalesRecord(
            source="Amazon",
            row_id=f"AMZ-{idx}",
            month=_month_from_date(doc_date),
            doc_date=doc_date,
            doc_no=doc_no,
            normalized_doc_no=normalize_doc_no(doc_no),
            doc_type=doc_type,
            party_name=str(getter("party_name") or "Amazon Customer").strip(),
            buyer_gstin=buyer_gstin,
            place_of_supply=_normalize_state(str(getter("place_of_supply") or "")),
            tax_rate=_parse_rate(getter("tax_rate")),
            taxable_value=taxable,
            cgst=round_money(getter("cgst")),
            sgst=round_money(getter("sgst")),
            igst=round_money(getter("igst")),
            cess=round_money(getter("cess")),
            invoice_value=round_money(getter("invoice_value")),
            is_b2b=bool(buyer_gstin),
            raw={str(k): v for k, v in row.items()},
        ))
    return records


def _read_gstr1(file_info: dict) -> tuple[list[SalesRecord], list[SalesRecord]]:
    filename = file_info["filename"]
    data = file_info["content"]
    suffix = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""

    if suffix not in {"xlsx", "xlsm"}:
        raise ValueError("GSTR-1 export must be an Excel file (.xlsx or .xlsm).")

    wb = load_workbook(BytesIO(data), data_only=True, read_only=True)
    b2b_records: list[SalesRecord] = []
    b2c_records: list[SalesRecord] = []

    for sheet in wb.worksheets:
        name = normalize_header(sheet.title)
        rows_raw = list(sheet.iter_rows(values_only=True))
        if not rows_raw:
            continue

        if _sheet_is_b2b(name):
            logger.info("GSTR-1 B2B sheet: '%s'", sheet.title)
            b2b_records.extend(_parse_gstr1_b2b_sheet(rows_raw, sheet.title))
        elif _sheet_is_b2c(name):
            logger.info("GSTR-1 B2C sheet: '%s'", sheet.title)
            b2c_records.extend(_parse_gstr1_b2c_sheet(rows_raw, sheet.title))

    return b2b_records, b2c_records


def _sheet_is_b2b(name: str) -> bool:
    return any(h in name for h in ("b2b", "b 2 b", "business to business", "b2ba"))


def _sheet_is_b2c(name: str) -> bool:
    # Avoid matching b2b when checking b2c
    if _sheet_is_b2b(name):
        return False
    return any(h in name for h in ("b2c", "b 2 c", "business to consumer", "b2cl", "b2cs"))


def _parse_gstr1_b2b_sheet(rows_raw: list[tuple], sheet_title: str) -> list[SalesRecord]:
    all_aliases: set[str] = set()
    for aliases in GSTR1_B2B_ALIASES.values():
        for a in aliases:
            all_aliases.add(normalize_header(a))

    header_idx = _find_header_row(rows_raw, all_aliases, min_score=3)
    if header_idx is None:
        logger.warning("B2B sheet '%s': no header detected", sheet_title)
        return []

    headers = [str(v or "") for v in rows_raw[header_idx]]
    records = []
    for i, row in enumerate(rows_raw[header_idx + 1:], 1):
        if not any(v is not None and str(v).strip() for v in row):
            continue
        raw = {headers[j]: row[j] if j < len(row) else "" for j in range(len(headers))}
        getter = _build_getter(raw, GSTR1_B2B_ALIASES)

        buyer_gstin = _clean_gstin(getter("buyer_gstin"))
        doc_no = str(getter("doc_no") or "").strip()
        if not buyer_gstin and not doc_no:
            continue

        raw_type = str(getter("doc_type") or "").lower()
        doc_type = "CRN" if any(k in raw_type for k in ("credit", "cr", "cn")) else "INV"
        date_raw = getter("doc_date")
        doc_date = parse_date(date_raw)

        records.append(SalesRecord(
            source="GSTR-1 B2B",
            row_id=f"G1B2B-{sheet_title}-{i}",
            month=_month_from_date(doc_date),
            doc_date=doc_date,
            doc_no=doc_no,
            normalized_doc_no=normalize_doc_no(doc_no),
            doc_type=doc_type,
            party_name=str(getter("party_name") or "").strip(),
            buyer_gstin=buyer_gstin,
            place_of_supply=_normalize_state(str(getter("place_of_supply") or "")),
            tax_rate=_parse_rate(getter("tax_rate")),
            taxable_value=round_money(getter("taxable_value")),
            cgst=round_money(getter("cgst")),
            sgst=round_money(getter("sgst")),
            igst=round_money(getter("igst")),
            cess=round_money(getter("cess")),
            invoice_value=round_money(getter("invoice_value")),
            is_b2b=True,
            raw={str(k): v for k, v in raw.items()},
        ))
    logger.info("  B2B sheet '%s': %d records", sheet_title, len(records))
    return records


def _parse_gstr1_b2c_sheet(rows_raw: list[tuple], sheet_title: str) -> list[SalesRecord]:
    all_aliases: set[str] = set()
    for aliases in GSTR1_B2C_ALIASES.values():
        for a in aliases:
            all_aliases.add(normalize_header(a))

    header_idx = _find_header_row(rows_raw, all_aliases, min_score=2)
    if header_idx is None:
        logger.warning("B2C sheet '%s': no header detected", sheet_title)
        return []

    headers = [str(v or "") for v in rows_raw[header_idx]]
    records = []
    for i, row in enumerate(rows_raw[header_idx + 1:], 1):
        if not any(v is not None and str(v).strip() for v in row):
            continue
        raw = {headers[j]: row[j] if j < len(row) else "" for j in range(len(headers))}
        getter = _build_getter(raw, GSTR1_B2C_ALIASES)

        taxable = round_money(getter("taxable_value"))
        state = _normalize_state(str(getter("place_of_supply") or ""))
        if not taxable and not state:
            continue

        records.append(SalesRecord(
            source="GSTR-1 B2C",
            row_id=f"G1B2C-{sheet_title}-{i}",
            month="",         # B2C rows are already period-scoped; no date column typically
            doc_date="",
            doc_no="",
            normalized_doc_no="",
            doc_type="INV",
            party_name="",
            buyer_gstin="",
            place_of_supply=state,
            tax_rate=_parse_rate(getter("tax_rate")),
            taxable_value=taxable,
            cgst=round_money(getter("cgst")),
            sgst=round_money(getter("sgst")),
            igst=round_money(getter("igst")),
            cess=round_money(getter("cess")),
            invoice_value=round_money(getter("invoice_value")),
            is_b2b=False,
            raw={str(k): v for k, v in raw.items()},
        ))
    logger.info("  B2C sheet '%s': %d records", sheet_title, len(records))
    return records


# ---------------------------------------------------------------------------
# Amazon merge
# ---------------------------------------------------------------------------

def _merge_amazon_into_books(
    tally_records: list[SalesRecord],
    amazon_records: list[SalesRecord],
) -> list[SalesRecord]:
    """Remove summarised Amazon ledger rows from Tally; inject Amazon invoice-level rows."""
    if not amazon_records:
        return tally_records

    filtered = [r for r in tally_records if not _is_amazon_summary_row(r)]
    removed = len(tally_records) - len(filtered)
    logger.info("Amazon merge: removed %d summarised Amazon rows, injecting %d invoice-level rows",
                removed, len(amazon_records))
    return filtered + amazon_records


def _is_amazon_summary_row(record: SalesRecord) -> bool:
    name = record.party_name.lower()
    # Match "Amazon Intra-State Sales", "Amazon Inter-State Sales", etc.
    return any(kw in name for kw in AMAZON_SUMMARY_KEYWORDS)


# ---------------------------------------------------------------------------
# Reconciliation engines
# ---------------------------------------------------------------------------

def reconcile_monthly_summary(
    books: list[SalesRecord],
    gstr1_b2b: list[SalesRecord],
    gstr1_b2c: list[SalesRecord],
    tolerance: float = 1.0,
) -> list[MonthlySummaryRow]:
    """Month-wise aggregated comparison between Books and GSTR-1."""
    def _agg(records: list[SalesRecord]) -> dict[str, dict[str, float]]:
        acc: dict[str, dict[str, float]] = defaultdict(lambda: {
            "taxable": 0.0, "cgst": 0.0, "sgst": 0.0, "igst": 0.0,
        })
        for r in records:
            m = r.month or "Unknown"
            sign = -1 if r.doc_type == "CRN" else 1
            acc[m]["taxable"] += sign * r.taxable_value
            acc[m]["cgst"] += sign * r.cgst
            acc[m]["sgst"] += sign * r.sgst
            acc[m]["igst"] += sign * r.igst
        return acc

    books_agg = _agg(books)
    gstr1_agg = _agg(gstr1_b2b + gstr1_b2c)
    all_months = sorted(set(books_agg) | set(gstr1_agg), key=_month_sort_key)

    rows = []
    for month in all_months:
        b = books_agg.get(month, {"taxable": 0.0, "cgst": 0.0, "sgst": 0.0, "igst": 0.0})
        g = gstr1_agg.get(month, {"taxable": 0.0, "cgst": 0.0, "sgst": 0.0, "igst": 0.0})
        dt = round_money(b["taxable"] - g["taxable"])
        dc = round_money(b["cgst"] - g["cgst"])
        ds = round_money(b["sgst"] - g["sgst"])
        di = round_money(b["igst"] - g["igst"])
        status = "Matched" if all(abs(d) <= tolerance for d in (dt, dc, ds, di)) else "Difference"
        rows.append(MonthlySummaryRow(
            month=month,
            books_taxable=round_money(b["taxable"]),
            gstr1_taxable=round_money(g["taxable"]),
            books_cgst=round_money(b["cgst"]),
            gstr1_cgst=round_money(g["cgst"]),
            books_sgst=round_money(b["sgst"]),
            gstr1_sgst=round_money(g["sgst"]),
            books_igst=round_money(b["igst"]),
            gstr1_igst=round_money(g["igst"]),
            diff_taxable=dt, diff_cgst=dc, diff_sgst=ds, diff_igst=di,
            status=status,
        ))
    return rows


def reconcile_b2b(
    books: list[SalesRecord],
    gstr1_b2b: list[SalesRecord],
    tolerance: float = 1.0,
) -> list[B2BRecoResult]:
    """Invoice-level B2B match: GSTIN + normalised invoice number."""
    books_b2b = [r for r in books if r.is_b2b]
    results: list[B2BRecoResult] = []
    matched_books: set[int] = set()
    matched_gstr1: set[int] = set()

    # Index GSTR-1 B2B by (gstin, doc_no) and by doc_no alone
    idx_by_uid: dict[tuple[str, str], list[int]] = defaultdict(list)
    idx_by_docno: dict[str, list[int]] = defaultdict(list)
    for j, r in enumerate(gstr1_b2b):
        if r.buyer_gstin and r.normalized_doc_no:
            idx_by_uid[(r.buyer_gstin, r.normalized_doc_no)].append(j)
        if r.normalized_doc_no:
            idx_by_docno[r.normalized_doc_no].append(j)

    # Pass 1: exact GSTIN + invoice number match
    for i, b_rec in enumerate(books_b2b):
        uid = (b_rec.buyer_gstin, b_rec.normalized_doc_no)
        if not b_rec.buyer_gstin or not b_rec.normalized_doc_no:
            continue
        candidates = [j for j in idx_by_uid.get(uid, []) if j not in matched_gstr1]
        if not candidates:
            continue
        best_j = min(candidates, key=lambda j: abs(b_rec.taxable_value - gstr1_b2b[j].taxable_value))
        g_rec = gstr1_b2b[best_j]
        mismatches = _amount_mismatches(b_rec, g_rec, tolerance)
        category = "Matched" if not mismatches else "Amount Mismatch"
        confidence = 100 if not mismatches else 80
        results.append(B2BRecoResult(
            category=category,
            confidence=confidence,
            books=b_rec,
            gstr1=g_rec,
            mismatch_fields=mismatches,
            suggested_action=(
                "Report is clean for this invoice." if not mismatches
                else "Review tax amounts — check rate, taxable value, or credit note treatment."
            ),
            explanation=(
                "GSTIN and invoice number match within tolerance." if not mismatches
                else f"GSTIN and invoice matched, but {', '.join(mismatches)} differ beyond tolerance."
            ),
        ))
        matched_books.add(i)
        matched_gstr1.add(best_j)

    # Pass 2: invoice number only (GSTIN missing or mismatched)
    for i, b_rec in enumerate(books_b2b):
        if i in matched_books or not b_rec.normalized_doc_no:
            continue
        candidates = [j for j in idx_by_docno.get(b_rec.normalized_doc_no, []) if j not in matched_gstr1]
        if not candidates:
            continue
        best_j = min(candidates, key=lambda j: abs(b_rec.taxable_value - gstr1_b2b[j].taxable_value))
        g_rec = gstr1_b2b[best_j]
        mismatches = _amount_mismatches(b_rec, g_rec, tolerance)
        gstin_ok = b_rec.buyer_gstin == g_rec.buyer_gstin
        if not gstin_ok:
            mismatches = ["buyer_gstin"] + mismatches
        results.append(B2BRecoResult(
            category="GSTIN Mismatch" if not gstin_ok else ("Matched" if not mismatches else "Amount Mismatch"),
            confidence=70,
            books=b_rec,
            gstr1=g_rec,
            mismatch_fields=mismatches,
            suggested_action="Verify buyer GSTIN in books and GSTR-1 — possible wrong GSTIN entry.",
            explanation="Invoice matched by number only; GSTIN or amounts differ.",
        ))
        matched_books.add(i)
        matched_gstr1.add(best_j)

    # Pass 3: unmatched books B2B → Missing in GSTR-1
    for i, b_rec in enumerate(books_b2b):
        if i in matched_books:
            continue
        results.append(B2BRecoResult(
            category="Missing in GSTR-1",
            confidence=0,
            books=b_rec,
            gstr1=None,
            mismatch_fields=["not_in_gstr1"],
            suggested_action="Check if invoice was reported in GSTR-1 or needs to be added via amendment.",
            explanation="Invoice found in books but not in GSTR-1 B2B.",
        ))

    # Pass 4: unmatched GSTR-1 B2B → Missing in Books
    for j, g_rec in enumerate(gstr1_b2b):
        if j in matched_gstr1:
            continue
        results.append(B2BRecoResult(
            category="Missing in Books",
            confidence=0,
            books=None,
            gstr1=g_rec,
            mismatch_fields=["not_in_books"],
            suggested_action="Check if this invoice exists in books under a different number or period.",
            explanation="Invoice reported in GSTR-1 but not found in books.",
        ))

    logger.info("B2B reco: %d results", len(results))
    return results


def reconcile_b2c(
    books: list[SalesRecord],
    gstr1_b2c: list[SalesRecord],
    tolerance: float = 1.0,
) -> list[B2CRecoResult]:
    """State + rate aggregated B2C match."""
    books_b2c = [r for r in books if not r.is_b2b]

    def _agg(records: list[SalesRecord]) -> dict[tuple[str, float], dict[str, float]]:
        acc: dict[tuple[str, float], dict[str, float]] = defaultdict(
            lambda: {"taxable": 0.0, "cgst": 0.0, "sgst": 0.0, "igst": 0.0}
        )
        for r in records:
            key = (_normalize_state(r.place_of_supply), r.tax_rate)
            sign = -1 if r.doc_type == "CRN" else 1
            acc[key]["taxable"] += sign * r.taxable_value
            acc[key]["cgst"] += sign * r.cgst
            acc[key]["sgst"] += sign * r.sgst
            acc[key]["igst"] += sign * r.igst
        return acc

    books_agg = _agg(books_b2c)
    gstr1_agg = _agg(gstr1_b2c)
    all_keys = sorted(set(books_agg) | set(gstr1_agg))

    results = []
    for state, rate in all_keys:
        b = books_agg.get((state, rate), {"taxable": 0.0, "cgst": 0.0, "sgst": 0.0, "igst": 0.0})
        g = gstr1_agg.get((state, rate), {"taxable": 0.0, "cgst": 0.0, "sgst": 0.0, "igst": 0.0})
        dt = round_money(b["taxable"] - g["taxable"])
        dc = round_money(b["cgst"] - g["cgst"])
        ds = round_money(b["sgst"] - g["sgst"])
        di = round_money(b["igst"] - g["igst"])

        if all(abs(d) <= tolerance for d in (dt, dc, ds, di)):
            category = "Matched"
            action = "B2C reporting matches books for this state and rate."
        elif dt > tolerance:
            category = "Under-reported in GSTR-1"
            action = "Books show higher sales than GSTR-1. Amend GSTR-1 or check if entries were missed."
        elif dt < -tolerance:
            category = "Over-reported in GSTR-1"
            action = "GSTR-1 shows higher sales than books. Verify and amend if needed."
        else:
            category = "Tax Mismatch"
            action = "Taxable values match but tax amounts differ. Check rate application."

        results.append(B2CRecoResult(
            category=category,
            month="",
            place_of_supply=state,
            tax_rate=rate,
            books_taxable=round_money(b["taxable"]),
            gstr1_taxable=round_money(g["taxable"]),
            books_cgst=round_money(b["cgst"]),
            gstr1_cgst=round_money(g["cgst"]),
            books_sgst=round_money(b["sgst"]),
            gstr1_sgst=round_money(g["sgst"]),
            books_igst=round_money(b["igst"]),
            gstr1_igst=round_money(g["igst"]),
            diff_taxable=dt, diff_cgst=dc, diff_sgst=ds, diff_igst=di,
            suggested_action=action,
        ))

    logger.info("B2C reco: %d state+rate buckets", len(results))
    return results


def summarize_gstr1_reco(
    b2b_results: list[B2BRecoResult],
    b2c_results: list[B2CRecoResult],
    monthly: list[MonthlySummaryRow],
) -> dict[str, int]:
    summary: dict[str, int] = {}
    for r in b2b_results:
        key = f"B2B: {r.category}"
        summary[key] = summary.get(key, 0) + 1
    for r in b2c_results:
        key = f"B2C: {r.category}"
        summary[key] = summary.get(key, 0) + 1
    summary["Monthly: Matched"] = sum(1 for m in monthly if m.status == "Matched")
    summary["Monthly: Difference"] = sum(1 for m in monthly if m.status == "Difference")
    return {k: v for k, v in summary.items() if v > 0}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _excel_to_rows(data: bytes) -> list[dict[str, Any]]:
    """Read all sheets, auto-detect header row, return flat list of dicts."""
    wb = load_workbook(BytesIO(data), data_only=True, read_only=True)
    all_rows: list[dict[str, Any]] = []
    all_aliases: set[str] = set()
    for aliases in {**TALLY_ALIASES, **AMAZON_ALIASES}.values():
        for a in aliases:
            all_aliases.add(normalize_header(a))

    for sheet in wb.worksheets:
        rows_raw = list(sheet.iter_rows(values_only=True))
        if not rows_raw:
            continue
        header_idx = _find_header_row(rows_raw, all_aliases, min_score=2)
        if header_idx is None:
            continue
        headers = [str(v or f"col_{i}") for i, v in enumerate(rows_raw[header_idx])]
        for row in rows_raw[header_idx + 1:]:
            if not any(v is not None and str(v).strip() for v in row):
                continue
            all_rows.append({headers[i]: row[i] if i < len(row) else "" for i in range(len(headers))})
    return all_rows


def _find_header_row(
    rows: list[tuple], aliases: set[str], min_score: int = 2
) -> int | None:
    best_idx, best_score = None, 0
    for idx, row in enumerate(rows[:30]):
        score = sum(1 for v in row if normalize_header(v) in aliases)
        if score > best_score:
            best_score, best_idx = score, idx
    return best_idx if best_score >= min_score else None


def _build_getter(row: dict[str, Any], aliases: dict[str, list[str]]):
    norm_map = {normalize_header(k): v for k, v in row.items()}

    def get(field_name: str) -> Any:
        for alias in aliases.get(field_name, []):
            key = normalize_header(alias)
            if key in norm_map and norm_map[key] not in (None, ""):
                return norm_map[key]
        return ""
    return get


def _clean_gstin(value: Any) -> str:
    text = re.sub(r"[^0-9A-Za-z]", "", str(value or "")).upper().strip()
    return text if len(text) == 15 else ""


def _normalize_state(value: str) -> str:
    return value.strip().title()


def _parse_rate(value: Any) -> float:
    text = re.sub(r"[^0-9.]", "", str(value or ""))
    try:
        return round(float(text), 2) if text else 0.0
    except ValueError:
        return 0.0


def _month_from_date(iso_date: str) -> str:
    if not iso_date or "-" not in iso_date:
        return "Unknown"
    try:
        return datetime.fromisoformat(iso_date).strftime("%B")
    except Exception:
        return "Unknown"


_FY_MONTH_ORDER = [
    "April", "May", "June", "July", "August", "September",
    "October", "November", "December", "January", "February", "March", "Unknown",
]


def _month_sort_key(month: str) -> int:
    try:
        return _FY_MONTH_ORDER.index(month)
    except ValueError:
        return 99


def _amount_mismatches(b: SalesRecord, g: SalesRecord, tolerance: float) -> list[str]:
    mismatches = []
    checks = {
        "taxable_value": (b.taxable_value, g.taxable_value),
        "cgst": (b.cgst, g.cgst),
        "sgst": (b.sgst, g.sgst),
        "igst": (b.igst, g.igst),
    }
    for field_name, (bv, gv) in checks.items():
        if abs(round_money(bv) - round_money(gv)) > tolerance:
            mismatches.append(field_name)
    return mismatches

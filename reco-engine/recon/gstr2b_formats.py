"""
gstr2b_formats.py — GSTR-2B layouts the engine does not already know.

Known layouts are read deterministically and never touch this module's AI path:

  portal    the GST-portal download (B2B / B2BA / B2B-CDNR / B2B-CDNRA tabs,
            merged two/three-row header from row 5)        gstr_2b_books._read_gstr2b_sheet
  combined  the same tabs merged into one file (one header row, a "Month"
            column, data straight under it)                 gstr_2b_books._read_gstr2b_sheet
  octa      OCTA's flat single-sheet export                 gstr_2b_books._parse_gstr2b_octa

Anything else is a NEW layout. For those — and only those — this module:

  1. looks the layout up in format_templates/gstr2b_<signature>.json. A layout is
     ever worked out once: every later file of the same shape reads the saved
     template and makes NO API call.
  2. otherwise asks Gemini ONCE which column holds which field (header rows + a few
     sample rows only), then checks the answer deterministically (GSTIN pattern,
     dates parse, amounts are numbers, tax/taxable gives a real GST rate).
  3. reads the file with that mapping, then asks Gemini a SECOND time to compare a
     handful of the extracted records against their source rows. A failed check
     gets one re-map with the problems fed back; still failing -> a clear error,
     never a silent half-read.
  4. saves the template as "pending". The UI tells the accountant this is a new
     layout and asks whether the output is right: Yes -> "confirmed"; No -> the
     accountant corrects the columns and re-runs with them (no API), and that
     corrected mapping is what gets saved.

Nothing here changes how portal / combined / OCTA files are read.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from datetime import datetime
from io import BytesIO
from typing import Any

from .core import parse_date, round_money

logger = logging.getLogger(__name__)

TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "format_templates")
_PREFIX = "gstr2b_"

_GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$")
_GSTIN_ANY = re.compile(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]")
_DATE_CELL_RE = re.compile(r"^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$|^\d{4}-\d{2}-\d{2}")
_MONEY_CELL_RE = re.compile(r"^\(?-?[\d,]*\d(\.\d+)?\)?$")
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Fields a 2B record is built from. REQUIRED must be mapped for a layout to count.
FIELDS = [
    "supplier_gstin", "supplier_name", "doc_no", "doc_date", "doc_type",
    "taxable_value", "igst", "cgst", "sgst", "cess", "invoice_value", "original_doc_no",
]
REQUIRED = ["supplier_gstin", "doc_no", "doc_date", "taxable_value"]
FIELD_LABELS = {
    "supplier_gstin": "Supplier GSTIN", "supplier_name": "Trade/Legal name",
    "doc_no": "Invoice / note number", "doc_date": "Invoice / note date",
    "doc_type": "Document type", "taxable_value": "Taxable value",
    "igst": "Integrated tax (IGST)", "cgst": "Central tax (CGST)",
    "sgst": "State/UT tax (SGST)", "cess": "Cess", "invoice_value": "Invoice value",
    "original_doc_no": "Original invoice number (amendments)",
}
# The header each field is re-emitted under, so gstr_2b_books.parse_gstr2b reads a
# learned row with exactly the same code (and the same column aliases) as a portal row.
CANONICAL_HEADER = {
    "supplier_gstin": "GSTIN of supplier",
    "supplier_name":  "Trade/Legal name",
    "doc_no":         "Invoice number",
    "doc_type":       "Invoice type",
    "doc_date":       "Invoice Date",
    "taxable_value":  "Taxable Value (₹)",
    "igst":           "Integrated Tax(₹)",
    "cgst":           "Central Tax(₹)",
    "sgst":           "State/UT Tax(₹)",
    "cess":           "Cess(₹)",
    "invoice_value":  "Invoice Value(₹)",
}
# What kind of rows a sheet holds -> the portal tab label its records report under
# (Pass 5 pairs originals with amendments by that label).
KIND_LABEL = {
    "invoices": "B2B", "mixed": "B2B", "notes": "B2B-CDNR",
    "amendments": "B2BA", "note_amendments": "B2B-CDNRA",
}
_GST_RATES = (0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40)


class Gstr2bFormatError(ValueError):
    """The 2B file could not be read. The message is shown to the accountant as-is."""


def ai_enabled() -> bool:
    return str(os.environ.get("GSTR2B_AI_COLUMNS", "1")).strip().lower() not in ("0", "false", "no", "off")


# ---------------------------------------------------------------------------
# Cell helpers
# ---------------------------------------------------------------------------

def _s(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v != v:        # NaN
        return ""
    if isinstance(v, datetime):
        return v.strftime("%d/%m/%Y")
    s = str(v).strip()
    return "" if s.lower() in ("nan", "none", "nat") else s


def _is_data_cell(v: Any) -> bool:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return True
    if isinstance(v, datetime):
        return True
    s = _s(v)
    if not s:
        return False
    u = s.upper()
    return bool(_GSTIN_RE.match(u) or _DATE_CELL_RE.match(s) or _MONEY_CELL_RE.match(s.replace(" ", "")))


def _is_label(v: Any) -> bool:
    """A header-ish text cell: has letters, no digits (so titles carrying a month,
    year or GSTIN do not make two files of the same layout look different)."""
    s = _s(v)
    return bool(s) and bool(re.search(r"[A-Za-z]", s)) and not re.search(r"\d", s)


def _norm(s: Any) -> str:
    return " ".join(_s(s).lower().split())


def _money(v: Any) -> float:
    """round_money plus the spellings other exports use: (1,234.00), 1,234 Cr, ₹ 12."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return round_money(v)
    s = _s(v)
    if not s:
        return 0.0
    neg = s.startswith("(") and s.endswith(")")
    s = re.sub(r"(?i)\b(cr|dr|inr|rs\.?)\b", "", s).replace("₹", "").strip("() ")
    val = round_money(s)
    return -abs(val) if neg else val


def _is_number(v: Any) -> bool:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v == v
    s = _s(v)
    if not s:
        return True        # blank amount = 0, fine
    s2 = re.sub(r"(?i)\b(cr|dr|inr|rs\.?)\b", "", s).replace("₹", "").replace(",", "").strip("() ")
    try:
        float(s2)
        return True
    except ValueError:
        return s2 in ("-", "")


_EXTRA_DATE_FORMATS = ("%d-%b-%Y", "%d %b %Y", "%d-%b-%y", "%d/%b/%Y", "%b %d, %Y",
                       "%d-%B-%Y", "%d %B %Y", "%Y/%m/%d", "%d.%m.%y")


def _date_iso(v: Any) -> str:
    if isinstance(v, datetime):
        return v.date().isoformat()
    iso = parse_date(v)
    if _ISO_RE.match(iso or ""):
        return iso
    s = _s(v)
    for fmt in _EXTRA_DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return ""


# ---------------------------------------------------------------------------
# Workbook sampling + signature
# ---------------------------------------------------------------------------

def _load_sheets(data: bytes, max_rows: int | None = None) -> dict[str, list[list[Any]]]:
    import openpyxl
    wb = openpyxl.load_workbook(BytesIO(data), read_only=True, data_only=True)
    out: dict[str, list[list[Any]]] = {}
    try:
        for ws in wb.worksheets:
            rows = []
            for i, r in enumerate(ws.iter_rows(values_only=True)):
                if max_rows is not None and i >= max_rows:
                    break
                rows.append(list(r))
            # trim fully-empty trailing columns
            width = 0
            for r in rows:
                for j in range(len(r) - 1, -1, -1):
                    if _s(r[j]):
                        width = max(width, j + 1)
                        break
            out[ws.title] = [r[:width] + [None] * (width - len(r[:width])) for r in rows]
    finally:
        wb.close()
    return out


def _first_data_row(rows: list[list[Any]], start: int = 0) -> int | None:
    """First row holding a GSTIN (the anchor every 2B row carries)."""
    for i in range(start, len(rows)):
        if any(_GSTIN_RE.match(_s(v).upper()) for v in rows[i]):
            return i
    return None


def sheet_has_gstin_table(rows: list[list[Any]]) -> bool:
    """>= 3 rows with a GSTIN in the SAME column — an invoice table, not a cover
    sheet that merely prints the taxpayer's own GSTIN once."""
    per_col: dict[int, int] = {}
    for r in rows:
        for j, v in enumerate(r):
            if _GSTIN_RE.match(_s(v).upper()):
                per_col[j] = per_col.get(j, 0) + 1
    return any(c >= 3 for c in per_col.values())


def _header_rows_above_data(rows: list[list[Any]]) -> list[list[Any]]:
    """The header band of a GSTIN table: up to 3 rows directly above the first data
    row that carry at least two label cells. Title / address / period lines (one
    cell each, or text with digits) are left out, so they never change the key."""
    first = _first_data_row(rows)
    if first is None:
        return []
    band = []
    for i in range(first - 1, max(-1, first - 4), -1):
        if sum(1 for v in rows[i] if _is_label(v)) >= 2:
            band.insert(0, rows[i])
    return band


def layout_signature(data: bytes) -> str:
    """Same layout -> same key, whatever the company, month or cover sheets: for each
    sheet that holds a GSTIN table, its name (digits dropped) plus the column labels
    in the header band directly above the data."""
    sheets = _load_sheets(data, max_rows=60)
    parts = []
    for name, rows in sheets.items():
        if not sheet_has_gstin_table(rows):
            continue
        labels = [_norm(v) for r in _header_rows_above_data(rows) for v in r if _is_label(v)]
        parts.append(re.sub(r"\d", "", _norm(name)) + "=" + "|".join(labels))
    return hashlib.sha256("||".join(sorted(parts)).encode("utf-8")).hexdigest()[:20]


def obviously_not_2b(data: bytes) -> str | None:
    """Files that are plainly something else, recognised without any API call:
    a Tally register (Voucher Type + Voucher No./Particulars) or one of our own
    reconciliation outputs (Remark / Suggested action columns)."""
    try:
        sheets = _load_sheets(data, max_rows=60)
    except Exception:
        return None
    for rows in sheets.values():
        if not sheet_has_gstin_table(rows):
            continue
        labels = {_norm(v) for r in _header_rows_above_data(rows) for v in r if _s(v)}
        if "voucher type" in labels and labels & {"voucher no.", "voucher no", "particulars"}:
            return "a Tally register (it has Voucher Type / Voucher No. columns)"
        if any(l.startswith("remark 1") or l.startswith("suggested action") for l in labels):
            return "a reconciliation output, not the GSTR-2B itself"
    return None


def entity_gstin_from_workbook(data: bytes) -> str:
    """The taxpayer's own GSTIN when a file's title states it, e.g. 'GSTR-2B Combined -
    Apr-2025 to Mar-2026 (GSTIN 27AAQCM9664F1ZS)'. Only cells that say 'GSTIN' AND
    carry exactly one GSTIN-shaped value count, in the first rows of the first sheets."""
    try:
        sheets = _load_sheets(data, max_rows=6)
    except Exception:
        return ""
    for rows in list(sheets.values())[:3]:
        for r in rows:
            for v in r:
                s = _s(v).upper()
                if "GSTIN" in s:
                    found = _GSTIN_ANY.findall(s)
                    if len(found) == 1:
                        return found[0]
    return ""


# ---------------------------------------------------------------------------
# Template store
# ---------------------------------------------------------------------------

def _path(sig: str) -> str:
    return os.path.join(TEMPLATE_DIR, f"{_PREFIX}{re.sub(r'[^0-9a-f]', '', sig)}.json")


def load_template(sig: str) -> dict | None:
    try:
        with open(_path(sig), encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def save_template(tmpl: dict) -> None:
    os.makedirs(TEMPLATE_DIR, exist_ok=True)
    tmp = _path(tmpl["signature"]) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(tmpl, fh, indent=2, ensure_ascii=False, default=str)
    os.replace(tmp, _path(tmpl["signature"]))


def confirm_template(sig: str, accept: bool) -> dict:
    """The accountant's answer to 'is this output right?'.
    Yes -> the layout is saved for good. No -> a pending template is dropped (a
    confirmed one is never deleted from here)."""
    tmpl = load_template(sig)
    if not tmpl:
        return {"ok": False, "error": "This layout is not on record any more — run the file again."}
    if accept:
        tmpl["status"] = "confirmed"
        tmpl["confirmed_at"] = datetime.now().isoformat(timespec="seconds")
        save_template(tmpl)
        return {"ok": True, "status": "confirmed", "signature": sig}
    if tmpl.get("status") == "confirmed":
        return {"ok": True, "status": "confirmed", "signature": sig, "note": "already confirmed; kept"}
    try:
        os.remove(_path(sig))
    except OSError:
        pass
    return {"ok": True, "status": "discarded", "signature": sig}


# ---------------------------------------------------------------------------
# Reading a file with a mapping
# ---------------------------------------------------------------------------

def _col(sheet_map: dict, field: str) -> int | None:
    c = (sheet_map.get("columns") or {}).get(field)
    return c if isinstance(c, int) and c >= 0 else None


def _doc_type_text(value: Any, sheet_map: dict) -> str:
    """Normalise the file's own document-type spelling to what parse_gstr2b reads."""
    s = _norm(value)
    kind = sheet_map.get("kind", "invoices")
    credit = {_norm(x) for x in (sheet_map.get("credit_values") or [])}
    debit = {_norm(x) for x in (sheet_map.get("debit_values") or [])}
    if s and s in credit:
        return "Credit Note"
    if s and s in debit:
        return "Debit Note"
    u = s.upper()
    if "CREDIT" in u or u in ("CN", "CRN", "C"):
        return "Credit Note"
    if "DEBIT" in u or u in ("DN", "DBN", "D"):
        return "Debit Note"
    if kind in ("notes", "note_amendments") and not s:
        return "Credit Note"
    return "Regular"


def rows_for_label(sheets: dict[str, list[list[Any]]], template: dict, label: str) -> list[dict]:
    """Rows of every mapped sheet whose kind reports under ``label``, re-keyed to the
    portal headers so parse_gstr2b builds records from them exactly as it would from
    a portal tab. '_src_sheet' keeps the real tab name for tracing."""
    out: list[dict] = []
    for sm in template.get("sheets") or []:
        if not sm.get("use", True) or KIND_LABEL.get(sm.get("kind", "invoices"), "B2B") != label:
            continue
        rows = sheets.get(sm.get("sheet"))
        if not rows:
            continue
        hdr = int(sm.get("header_row", 0))
        headers = rows[hdr] if hdr < len(rows) else []
        gcol = _col(sm, "supplier_gstin")
        last_gstin = ""
        for ri in range(hdr + 1, len(rows)):
            r = rows[ri]
            def cell(field):
                c = _col(sm, field)
                return r[c] if c is not None and c < len(r) else None
            gstin = _s(cell("supplier_gstin")).upper().replace(" ", "")
            if gstin and not _GSTIN_RE.match(gstin):
                continue                       # a sub-total / footer line
            if not gstin and gcol is not None:
                # merged supplier cell — same forward-fill the portal reader does,
                # but only onto a row that carries a document of its own
                if not _s(cell("doc_no")):
                    continue
                gstin = last_gstin
            if not gstin:
                continue
            last_gstin = gstin
            doc_type = _doc_type_text(cell("doc_type"), sm)
            amounts = {f: _money(cell(f)) for f in
                       ("taxable_value", "igst", "cgst", "sgst", "cess", "invoice_value")}
            if doc_type == "Credit Note":
                # parse_gstr2b negates credit notes itself; hand it magnitudes so a file
                # that already prints them negative is not flipped back to positive.
                amounts = {k: abs(v) for k, v in amounts.items()}
            row = {
                CANONICAL_HEADER["supplier_gstin"]: gstin,
                CANONICAL_HEADER["supplier_name"]: _s(cell("supplier_name")),
                CANONICAL_HEADER["doc_no"]: _s(cell("doc_no")),
                CANONICAL_HEADER["doc_type"]: doc_type,
                CANONICAL_HEADER["doc_date"]: _date_iso(cell("doc_date")),
                **{CANONICAL_HEADER[k]: v for k, v in amounts.items()},
            }
            if _col(sm, "original_doc_no") is not None:
                row["Original invoice number"] = _s(cell("original_doc_no"))
            # keep the rest of the source row under its own headers (raw / tracing)
            for j, v in enumerate(r):
                h = _s(headers[j]) if j < len(headers) else ""
                if h and h not in row and _s(v):
                    row[h] = v
            row["_sheet"] = sm.get("sheet")
            row["_src_sheet"] = sm.get("sheet")
            row["_src_row"] = ri + 1
            out.append(row)
    return out


def _count_rows(sheets, template) -> dict[str, int]:
    counts: dict[str, int] = {}
    for label in sorted(set(KIND_LABEL.values())):
        n = len(rows_for_label(sheets, template, label))
        if n:
            counts[label] = n
    return counts


# ---------------------------------------------------------------------------
# Deterministic checks
# ---------------------------------------------------------------------------

def check_mapping(sheets: dict[str, list[list[Any]]], template: dict) -> list[str]:
    """Problems with a mapping, in plain words. Empty list = passes."""
    problems: list[str] = []
    used = [sm for sm in (template.get("sheets") or []) if sm.get("use", True)]
    if not used:
        return ["no sheet was identified as holding GSTR-2B invoices"]
    total = 0
    for sm in used:
        name = sm.get("sheet")
        rows = sheets.get(name)
        if rows is None:
            problems.append(f"sheet '{name}' does not exist in the file")
            continue
        if sm.get("kind") not in KIND_LABEL:
            problems.append(f"sheet '{name}': unknown kind '{sm.get('kind')}'")
        hdr = sm.get("header_row")
        if not isinstance(hdr, int) or hdr < 0 or hdr >= len(rows):
            problems.append(f"sheet '{name}': header row {hdr} is outside the sheet")
            continue
        missing = [FIELD_LABELS[f] for f in REQUIRED if _col(sm, f) is None]
        if missing:
            problems.append(f"sheet '{name}': no column for {', '.join(missing)}")
            continue
        if not any(_col(sm, f) is not None for f in ("igst", "cgst", "sgst")):
            problems.append(f"sheet '{name}': no tax column (IGST/CGST/SGST) mapped")
        width = max((len(r) for r in rows), default=0)
        bad_idx = [f for f in FIELDS if _col(sm, f) is not None and _col(sm, f) >= width]
        if bad_idx:
            problems.append(f"sheet '{name}': column index out of range for {', '.join(bad_idx)}")
            continue
        body = [r for r in rows[hdr + 1:] if any(_s(v) for v in r)]
        gcol = _col(sm, "supplier_gstin")
        g_rows = [r for r in body if _GSTIN_RE.match(_s(r[gcol]).upper().replace(" ", ""))]
        if not g_rows:
            problems.append(f"sheet '{name}': the GSTIN column (col {gcol}) holds no GSTINs")
            continue
        total += len(g_rows)
        n = len(g_rows)

        def share(pred) -> float:
            return sum(1 for r in g_rows if pred(r)) / n

        c = _col(sm, "doc_no")
        if share(lambda r: bool(_s(r[c]))) < 0.9:
            problems.append(f"sheet '{name}': invoice-number column (col {c}) is mostly blank")
        c = _col(sm, "doc_date")
        if share(lambda r: bool(_date_iso(r[c]))) < 0.9:
            problems.append(f"sheet '{name}': date column (col {c}) mostly does not hold dates")
        for f in ("taxable_value", "igst", "cgst", "sgst", "cess", "invoice_value"):
            c = _col(sm, f)
            if c is not None and share(lambda r: _is_number(r[c])) < 0.95:
                problems.append(f"sheet '{name}': {FIELD_LABELS[f]} column (col {c}) is not numeric")
        # tax / taxable should be a real GST rate on most rows
        ct = _col(sm, "taxable_value")
        tax_cols = [_col(sm, f) for f in ("igst", "cgst", "sgst") if _col(sm, f) is not None]
        rated = plausible = 0
        for r in g_rows:
            tv = abs(_money(r[ct]))
            tx = abs(sum(_money(r[c]) for c in tax_cols))
            if tv > 0 and tx > 0:
                rated += 1
                pct = tx / tv * 100
                if any(abs(pct - g) <= max(0.35, g * 0.03) for g in _GST_RATES):
                    plausible += 1
        if rated >= 5 and plausible / rated < 0.6:
            problems.append(f"sheet '{name}': tax ÷ taxable value is not a GST rate on most rows "
                            f"({plausible}/{rated}) — taxable or tax columns look wrong")
        ci = _col(sm, "invoice_value")
        if ci is not None:
            ok = sum(1 for r in g_rows if abs(_money(r[ci])) + 1 >= abs(_money(r[ct])))
            if ok / n < 0.8:
                problems.append(f"sheet '{name}': invoice value is below taxable value on most rows")
    if not problems and total == 0:
        problems.append("no invoice rows found")
    return problems


# ---------------------------------------------------------------------------
# Gemini: map, then verify
# ---------------------------------------------------------------------------

def _sheet_preview(rows: list[list[Any]], n_data: int = 4) -> tuple[list, int | None]:
    first = _first_data_row(rows)
    top = rows[: (first if first is not None else min(len(rows), 10))]
    top = top[-10:]                                  # the rows nearest the data
    offset = (first if first is not None else len(top)) - len(top)
    data = rows[first:first + n_data] if first is not None else []
    shown = []
    for i, r in enumerate(top + data):
        shown.append({"row": offset + i, "cells": [_s(v)[:40] for v in r]})
    return shown, first


def _mapping_prompt(sheets: dict, feedback: list[str] | None) -> str:
    blocks = []
    for name, rows in sheets.items():
        if not sheet_has_gstin_table(rows[:400]):
            continue
        shown, _ = _sheet_preview(rows)
        blocks.append({"sheet": name, "rows": shown})
    fb = ""
    if feedback:
        fb = ("\nA previous attempt was checked and FAILED for these reasons — fix them:\n- "
              + "\n- ".join(feedback[:12]) + "\n")
    return (
        "You are reading an Indian GST 'GSTR-2B' (inward supplies / purchase ITC) Excel export in a "
        "layout we have not seen. Below, for each sheet that contains supplier GSTINs, are the header "
        "rows and a few data rows. 'row' is the 0-based row index; cells are listed in order, so the "
        "0-based position in 'cells' is the column index.\n\n"
        f"{json.dumps(blocks, ensure_ascii=False)}\n{fb}\n"
        "First decide whether this could be a GSTR-2B. Any list of INWARD supplier documents with, per "
        "row, the supplier GSTIN, document number, date, taxable value and tax amounts counts — "
        "whatever the file or sheet is titled and whichever software produced it. Answer "
        "is_gstr2b=false ONLY when you are sure it is something else: a sales / outward register, a "
        "bank statement, a ledger, or a report with no per-document tax amounts.\n"
        "Return JSON:\n"
        '{"is_gstr2b":true|false,"looks_like":"<what the file is, a few words>",'
        '"sheets":[{"sheet":"<name>","use":true|false,"header_row":<row index of the row whose '
        'labels name the data columns (the LAST header row if there are several)>,'
        '"kind":"invoices"|"notes"|"amendments"|"note_amendments"|"mixed",'
        '"columns":{"supplier_gstin":i,"supplier_name":i|null,"doc_no":i,"doc_date":i,'
        '"doc_type":i|null,"taxable_value":i,"igst":i|null,"cgst":i|null,"sgst":i|null,'
        '"cess":i|null,"invoice_value":i|null,"original_doc_no":i|null},'
        '"credit_values":["<exact doc-type texts meaning credit note>"],'
        '"debit_values":["<exact doc-type texts meaning debit note>"]}]}\n'
        "Rules: use=false for summary/cover/ISD/import sheets. 'mixed' = invoices and credit/debit "
        "notes in one sheet told apart by a doc-type column. For amendment sheets doc_no is the "
        "ORIGINAL invoice number and original_doc_no is null unless both are present, in which case "
        "doc_no = original and original_doc_no = revised. Tax columns are the tax AMOUNTS, not rates. "
        "Use null when a column does not exist. Never invent columns."
    )


def _verify_prompt(samples: list[dict]) -> str:
    return (
        "We extracted GSTR-2B records from an Excel file using a column mapping. For each sample "
        "below, 'source' is the original row (header -> value) and 'extracted' is what we read. "
        "Check every extracted field against the source row: right GSTIN, supplier name, document "
        "number, date (ISO yyyy-mm-dd; source may be dd/mm/yyyy), document type, taxable value and "
        "each tax amount.\n"
        "Our conventions — these are CORRECT, never report them: doc_type is normalised to "
        "Invoice / Credit Note / Debit Note whatever code the source uses (e.g. 'CN', 'CRN', 'C'); "
        "credit-note amounts are negative in 'extracted' whether or not the source prints a minus; "
        "a blank source amount is 0; number formatting (commas, 2 decimals) and date format differ. "
        "Report ONLY a real mismatch in meaning: wrong column, wrong value, wrong sign on an invoice, "
        "swapped CGST/IGST, name or number from another row.\n\n"
        f"{json.dumps(samples, ensure_ascii=False, default=str)}\n\n"
        'Return JSON: {"ok": true|false, "problems": ["<field>: <what is wrong>", ...]}. '
        "ok=true only if every sample is extracted correctly."
    )


def _ai_map(sheets: dict, feedback: list[str] | None, calls: list) -> dict | None:
    from . import gemini_client
    reply = gemini_client.generate_json(_mapping_prompt(sheets, feedback), max_tokens=4096, timeout=90)
    calls.append("map")
    if isinstance(reply, dict) and reply.get("is_gstr2b") is False:
        return {"not_gstr2b": str(reply.get("looks_like") or "a different kind of file")[:80]}
    if not isinstance(reply, dict) or not isinstance(reply.get("sheets"), list):
        return None
    clean = []
    for sm in reply["sheets"]:
        if not isinstance(sm, dict) or not sm.get("use", True):
            continue
        cols = {}
        for f in FIELDS:
            v = (sm.get("columns") or {}).get(f)
            cols[f] = int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else None
        clean.append({
            "sheet": str(sm.get("sheet", "")),
            "use": True,
            "header_row": int(sm["header_row"]) if isinstance(sm.get("header_row"), (int, float)) else -1,
            "kind": str(sm.get("kind") or "invoices"),
            "columns": cols,
            "credit_values": [str(x) for x in (sm.get("credit_values") or [])][:10],
            "debit_values": [str(x) for x in (sm.get("debit_values") or [])][:10],
        })
    return {"sheets": clean}


_DOC_WORDS = {"INV": "Invoice", "CRN": "Credit Note", "DBN": "Debit Note"}


def _verification_samples(sheets: dict, template: dict, parse_rows) -> list[dict]:
    """~6 records spread across the file (incl. a note when there is one), each
    beside its untouched source row."""
    samples = []
    for label in ("B2B", "B2B-CDNR", "B2BA", "B2B-CDNRA"):
        rows = rows_for_label(sheets, template, label)
        if not rows:
            continue
        picks = sorted({0, len(rows) // 2, len(rows) - 1})
        notes = [i for i, r in enumerate(rows) if r.get("Invoice type") != "Regular"]
        if notes:
            picks = sorted(set(picks) | {notes[0]})
        for i in picks[:4]:
            row = rows[i]
            src_sheet = sheets[row["_src_sheet"]]
            sm = next(s for s in template["sheets"] if s["sheet"] == row["_src_sheet"])
            hdr = src_sheet[sm["header_row"]]
            src = src_sheet[row["_src_row"] - 1]
            source = {(_s(hdr[j]) or f"col{j}"): _s(v) for j, v in enumerate(src) if _s(v)}
            rec = parse_rows([row], label)
            if not rec:
                continue
            r = rec[0]
            z = lambda v: round(v, 2) + 0.0          # -0.0 -> 0.0
            samples.append({"source": source, "extracted": {
                "supplier_gstin": r.supplier_gstin, "supplier_name": r.supplier_name,
                "doc_no": r.doc_no, "doc_date": r.doc_date,
                "doc_type": _DOC_WORDS.get(r.doc_type, r.doc_type),
                "taxable_value": z(r.taxable_value), "igst": z(r.igst), "cgst": z(r.cgst),
                "sgst": z(r.sgst), "cess": z(r.cess), "invoice_value": z(r.invoice_value)}})
    return samples[:8]


def _ai_verify(sheets, template, parse_rows, calls) -> tuple[bool, list[str]]:
    from . import gemini_client
    samples = _verification_samples(sheets, template, parse_rows)
    if not samples:
        return False, ["nothing could be extracted to verify"]
    reply = gemini_client.generate_json(_verify_prompt(samples), max_tokens=2048, timeout=90)
    calls.append("verify")
    if not isinstance(reply, dict) or "ok" not in reply:
        return False, ["the AI check did not answer"]
    probs = [str(p) for p in (reply.get("problems") or [])][:12]
    return bool(reply.get("ok")) and not probs, probs


# ---------------------------------------------------------------------------
# Entry point used by gstr_2b_books.parse_gstr2b
# ---------------------------------------------------------------------------

def _public_sheet_info(sheets, template) -> list[dict]:
    out = []
    for sm in template.get("sheets") or []:
        rows = sheets.get(sm.get("sheet")) or []
        hdr = sm.get("header_row", 0)
        headers = rows[hdr] if isinstance(hdr, int) and 0 <= hdr < len(rows) else []
        out.append({
            "sheet": sm.get("sheet"), "kind": sm.get("kind"), "header_row": hdr,
            "headers": [{"index": j, "label": _s(h) or f"Column {j + 1}"} for j, h in enumerate(headers)],
            "columns": [{"field": f, "label": FIELD_LABELS[f], "index": _col(sm, f),
                         "header": (_s(headers[_col(sm, f)]) if _col(sm, f) is not None
                                    and _col(sm, f) < len(headers) else None),
                         "required": f in REQUIRED} for f in FIELDS],
            "credit_values": sm.get("credit_values") or [],
            "debit_values": sm.get("debit_values") or [],
        })
    return out


def apply_override(data: bytes, override: dict) -> bool:
    """Save the accountant's corrected columns for this file's layout (pending, until
    they say the output is right). Checked like any mapping; raises a readable
    Gstr2bFormatError if the corrected columns still cannot read the file. Returns
    False when the correction was made for a different layout."""
    if not override or not override.get("sheets"):
        return False
    sig = layout_signature(data)
    if override.get("signature") and override["signature"] != sig:
        return False
    sheets = _load_sheets(data)
    clean = []
    for sm in override["sheets"]:
        cols = {}
        for f in FIELDS:
            v = (sm.get("columns") or {}).get(f)
            cols[f] = int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else None
        clean.append({"sheet": str(sm.get("sheet", "")), "use": True,
                      "header_row": int(sm.get("header_row", 0)),
                      "kind": str(sm.get("kind") or "invoices"), "columns": cols,
                      "credit_values": [str(x) for x in (sm.get("credit_values") or [])][:10],
                      "debit_values": [str(x) for x in (sm.get("debit_values") or [])][:10]})
    template = {"sheets": clean}
    problems = check_mapping(sheets, template)
    if problems:
        raise Gstr2bFormatError(
            "The corrected columns still don't read this GSTR-2B file: " + "; ".join(problems[:4]))
    prev = load_template(sig) or {}
    template.update({"version": 1, "signature": sig, "status": "pending", "source": "user",
                     "created_at": prev.get("created_at") or datetime.now().isoformat(timespec="seconds"),
                     "corrected_at": datetime.now().isoformat(timespec="seconds"),
                     "verification": {"ai": None, "note": "columns set by the accountant"}})
    save_template(template)
    return True


def resolve_new_layout(data: bytes, parse_rows, override: dict | None = None,
                       reason: str = "") -> tuple[dict, dict[str, list[dict]], dict]:
    """Work out an unknown layout (saved template -> accountant's correction -> Gemini).

    ``parse_rows(rows, label)`` is gstr_2b_books' own record builder, used for the
    AI verification so the check sees exactly what the reconciliation will see.

    Returns (template, {label: rows}, info). Raises Gstr2bFormatError with a message
    fit for the accountant when the file cannot be read reliably."""
    sheets = _load_sheets(data)
    sig = layout_signature(data)
    calls: list[str] = []
    template = None
    verification = None

    # 1) the accountant's correction is saved beforehand by apply_override()

    # 2) a layout already on record — no API call
    if template is None:
        saved = load_template(sig)
        if saved and not check_mapping(sheets, saved):
            template = saved

    # 3) new layout — Gemini maps, we check, Gemini verifies
    if template is None:
        if not ai_enabled():
            raise Gstr2bFormatError(
                "This GSTR-2B file isn't in a layout we recognise (GST portal download, OCTA, or the "
                "Combined workbook), and AI column-reading is switched off. " + reason)
        not_2b = obviously_not_2b(data)
        if not_2b:
            raise Gstr2bFormatError(
                f"This doesn't look like a GSTR-2B file — it looks like {not_2b}. "
                "Please upload the GSTR-2B (GST-portal download, OCTA or Combined) in the GSTR-2B slot.")
        from . import gemini_client
        if not gemini_client.available():
            raise Gstr2bFormatError(
                "This GSTR-2B file isn't in a layout we recognise (GST portal download, OCTA, or the "
                "Combined workbook), and the AI reader is not configured (no GEMINI_API_KEY). " + reason)
        feedback: list[str] | None = None
        started = time.time()
        for attempt in range(3):
            cand = _ai_map(sheets, feedback, calls)
            if cand is None:
                feedback = ["the reply was not valid JSON in the requested shape"]
                continue
            if cand.get("not_gstr2b"):
                raise Gstr2bFormatError(
                    f"This doesn't look like a GSTR-2B file — it looks like {cand['not_gstr2b']}. "
                    "Please upload the GSTR-2B (GST-portal download, OCTA or Combined) in the GSTR-2B slot.")
            problems = check_mapping(sheets, cand)
            if problems:
                logger.info("GSTR-2B new layout %s attempt %d failed checks: %s", sig, attempt + 1, problems)
                feedback = problems
                continue
            ok, probs = _ai_verify(sheets, cand, parse_rows, calls)
            if ok:
                template = cand
                verification = {"ai": "passed", "attempts": attempt + 1}
                break
            logger.info("GSTR-2B new layout %s attempt %d failed AI verification: %s", sig, attempt + 1, probs)
            feedback = ["after reading with that mapping, a check of the output found: " + p for p in probs]
        if template is None:
            raise Gstr2bFormatError(
                "This GSTR-2B file is in a new layout and we could not read it reliably, so nothing was "
                "reconciled. What went wrong: " + "; ".join((feedback or ["no usable reading"])[:4])
                + ". Please upload the GST-portal download, or send us this file.")
        template.update({"version": 1, "signature": sig, "status": "pending", "source": "gemini",
                         "created_at": datetime.now().isoformat(timespec="seconds"),
                         "verification": verification,
                         "seconds": round(time.time() - started, 1)})
        save_template(template)

    by_label = {label: rows_for_label(sheets, template, label)
                for label in ("B2B", "B2BA", "B2B-CDNR", "B2B-CDNRA")}
    info = {
        "format": "new",
        "signature": sig,
        "status": template.get("status", "pending"),
        "source": template.get("source", "gemini"),
        "ai_calls": len(calls),
        "verification": template.get("verification"),
        "sheets": _public_sheet_info(sheets, template),
        "rows": {k: len(v) for k, v in by_label.items() if v},
    }
    return template, by_label, info


def saved_rows_for(data: bytes) -> tuple[dict, dict[str, list[dict]]] | None:
    """Rows of a file whose layout is already on record — never calls the API.
    Used by the Proof sheet / export rebuild, which re-read the source file."""
    try:
        sig = layout_signature(data)
        tmpl = load_template(sig)
        if not tmpl:
            return None
        sheets = _load_sheets(data)
        if check_mapping(sheets, tmpl):
            return None
        return tmpl, {label: rows_for_label(sheets, tmpl, label)
                      for label in ("B2B", "B2BA", "B2B-CDNR", "B2B-CDNRA")}
    except Exception:
        return None


def workbook_has_unread_gstin_table(data: bytes) -> bool:
    """True when some sheet holds a real GSTIN table — i.e. the file does contain 2B
    data even though no known layout read it."""
    try:
        return any(sheet_has_gstin_table(rows[:400]) for rows in _load_sheets(data, max_rows=400).values())
    except Exception:
        return False

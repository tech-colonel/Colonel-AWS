"""
GSTR-2B vs Books reconciliation.

Handles:
  - GSTR-2B portal Excel: two-row header at rows 4+5, data from row 6
  - Purchase Register / Debit Note Register: 6-row Tally preamble, header row 6, data from row 7+

Matching strategy:
  - Primary key: normalised invoice/note number (no GSTIN because Tally doesn't export GSTIN)
  - Amount tolerances applied to taxable_value, igst, cgst, sgst
  - Remarks: "Matched", "In 2B but not in the books" (only 2B), "Need to 2B" (only Books),
              "Amount Mismatch" (both sides but amounts differ)
"""
from __future__ import annotations

import re
from io import BytesIO
from typing import Any

import pandas as pd

from .core import (
    NormalizedInvoice,
    MatchResult,
    normalize_doc_no,
    parse_date,
    round_money,
    amount_equal,
    summarize,
)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ALLOWED_SHEETS = {"B2B", "B2BA", "B2B-CDNR", "B2B-CDNRA"}
# Ordered so originals (B2B, B2B-CDNR) are parsed before amendments (B2BA, B2B-CDNRA).
# This ensures the original entry is first in the records list and gets matched with Books
# first in Pass 1 — leaving the amendment entry (B2BA/B2B-CDNRA) unmatched as expected.
ALLOWED_SHEETS_ORDER = ["B2B", "B2B-CDNR", "B2BA", "B2B-CDNRA"]

# ── IMS (Invoice Management System) export ───────────────────────────────────
# The third recognised 2B layout, after the GST portal and OCTA. Its rows carry the
# same two-row header and the same columns as the portal, so B2B/B2BA already parse
# unchanged — but credit/debit notes live on their OWN sheets (B2B-CN / B2B-DN)
# rather than a shared B2B-CDNR, and are named per note type:
#   • the portal's B2B-CDNR holds both, distinguished by a "Note type" column;
#   • IMS splits them, so there is NO such column — its type column reads the SUPPLY
#     type ("Regular"), which would otherwise be read as an ordinary invoice and
#     leave every credit note positive instead of negative.
# The sheet name is therefore the authority for doc_type on these sheets, and each
# is reported under the canonical portal label so Pass 5 and the amendment/original
# pairing keep working untouched.
IMS_SHEET_DOC_TYPE = {"B2B-CN": "CRN", "B2B-CNA": "CRN",
                      "B2B-DN": "DBN", "B2B-DNA": "DBN"}
IMS_SHEET_CANONICAL = {"B2B-CN": "B2B-CDNR", "B2B-CNA": "B2B-CDNRA",
                       "B2B-DN": "B2B-CDNR", "B2B-DNA": "B2B-CDNRA"}
# Originals before amendments, matching ALLOWED_SHEETS_ORDER's reasoning.
IMS_SHEETS_ORDER = ["B2B-CN", "B2B-DN", "B2B-CNA", "B2B-DNA"]
IMS_SHEETS = set(IMS_SHEETS_ORDER)
# Summary/dashboard tabs — record counts only, no invoice rows. Never parsed.
IMS_SUMMARY_SHEETS = {"All other ITC", "Import of Goods"}

GST_STATE_CODES: dict[str, str] = {
    "01": "Jammu & Kashmir",        "02": "Himachal Pradesh",
    "03": "Punjab",                 "04": "Chandigarh",
    "05": "Uttarakhand",            "06": "Haryana",
    "07": "Delhi",                  "08": "Rajasthan",
    "09": "Uttar Pradesh",          "10": "Bihar",
    "11": "Sikkim",                 "12": "Arunachal Pradesh",
    "13": "Nagaland",               "14": "Manipur",
    "15": "Mizoram",                "16": "Tripura",
    "17": "Meghalaya",              "18": "Assam",
    "19": "West Bengal",            "20": "Jharkhand",
    "21": "Odisha",                 "22": "Chhattisgarh",
    "23": "Madhya Pradesh",         "24": "Gujarat",
    "25": "Daman & Diu",            "26": "Dadra & Nagar Haveli",
    "27": "Maharashtra",            "28": "Andhra Pradesh",
    "29": "Karnataka",              "30": "Goa",
    "31": "Lakshadweep",            "32": "Kerala",
    "33": "Tamil Nadu",             "34": "Puducherry",
    "35": "Andaman & Nicobar",      "36": "Telangana",
    "37": "Andhra Pradesh (New)",   "38": "Ladakh",
    "97": "Other Territory",        "99": "Centre Jurisdiction",
}

# Matches the 15-character Indian GSTIN format: 2 digits + 5 letters + 4 digits + letter + alphanum + Z + alphanum
_GSTIN_RE = re.compile(r'^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$')


def _extract_gstin(rec) -> str:
    """Return GSTIN from a NormalizedInvoice: try supplier_gstin first, then scan raw dict."""
    direct = str(_get_val(rec, "supplier_gstin", "") or "").strip().upper()
    if direct and _GSTIN_RE.match(direct):
        return direct
    raw = _get_val(rec, "raw", {})
    if isinstance(raw, dict):
        for v in raw.values():
            v_str = str(v or "").strip().upper()
            if _GSTIN_RE.match(v_str):
                return v_str
    return ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _norm_gstin(v: Any) -> str:
    """Normalise a GSTIN string to 15-char uppercase alphanumeric (strips spaces/dashes)."""
    return re.sub(r"[^0-9A-Z]", "", str(v or "").upper().strip())


def convert_xls_to_xlsx(xls_bytes: bytes) -> bytes:
    import pandas as pd
    from io import BytesIO
    xls_file = pd.ExcelFile(BytesIO(xls_bytes), engine="xlrd")
    xlsx_buffer = BytesIO()
    with pd.ExcelWriter(xlsx_buffer, engine="openpyxl") as writer:
        for sheet_name in xls_file.sheet_names:
            df = xls_file.parse(sheet_name, header=None)
            df.to_excel(writer, sheet_name=sheet_name, index=False, header=False)
    xlsx_buffer.seek(0)
    return xlsx_buffer.read()


def _ensure_xlsx(data: bytes) -> bytes:
    if data and data.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        try:
            return convert_xls_to_xlsx(data)
        except Exception as e:
            print(f"Error converting legacy .xls to .xlsx: {e}")
    return data



def _norm(text: Any) -> str:
    s = str(text or "").strip().lower()
    s = re.sub(r"[\n\r\t]+", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _build_getter(row: dict[str, Any], col_map: dict[str, list[str]]):
    norm_row = {_norm(k): v for k, v in row.items()}

    def get(field: str) -> Any:
        for alias in col_map.get(field, []):
            key = _norm(alias)
            if key in norm_row and str(norm_row[key]).strip() not in ("", "nan"):
                return norm_row[key]
        return ""

    return get


# ---------------------------------------------------------------------------
# GSTR-2B Parser
# ---------------------------------------------------------------------------

GSTR2B_COL_MAP: dict[str, list[str]] = {
    "supplier_gstin":  ["gstin of supplier", "gstin"],
    "supplier_name":   ["trade/legal name", "trade name", "legal name"],
    # IMS names its note columns in full ("Credit Note number") where the portal
    # says "Note number", so both spellings are listed. Portal aliases stay FIRST so
    # a portal file keeps resolving exactly as before.
    "doc_no":          ["invoice number", "note number", "invoice no", "note no",
                        "credit note number", "debit note number"],
    "doc_type":        ["invoice type", "note type", "type"],
    "doc_date":        ["invoice date", "note date", "date",
                        "credit note date", "debit note date"],
    "taxable_value":   ["taxable value (₹)", "taxable value"],
    "igst":            ["integrated tax (₹)", "integrated tax(₹)", "integrated tax"],
    "cgst":            ["central tax (₹)", "central tax(₹)", "central tax"],
    "sgst":            ["state/ut tax (₹)", "state/ut tax(₹)", "state/ut tax"],
    "cess":            ["cess (₹)", "cess(₹)", "cess"],
    "invoice_value":   ["invoice value (₹)", "invoice value(₹)", "invoice value",
                        "note value (₹)", "note value(₹)",
                        "credit note value(₹)", "credit note value (₹)",
                        "debit note value(₹)", "debit note value (₹)"],
}


_DATE_CELL_RE = re.compile(r"^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$")
_MONEY_CELL_RE = re.compile(r"^-?[\d,]*\d\.\d{1,2}$")


def _find_header_band_end(raw: Any) -> int:
    """Return the 0-based index of the first DATA row.

    Most 2B tabs carry two header rows (4 and 5) with data from row 6. The
    AMENDMENT tabs do not: B2BA / B2B-CDNRA (portal) and B2B-CNA / B2B-DNA (IMS)
    add a third row, because an 'Original Details' / 'Revised Details' band sits
    ABOVE the real column labels. Assuming two rows there made the genuine
    sub-header row look like data, and pushed every tax column under a generic
    'Revised Details_N' key that the column map cannot resolve — so amended
    invoices were reported with their taxable value but ZERO tax.

    The depth is read from the data rather than hardcoded: the first row holding a
    GSTIN, a date or a money value is the first data row. Header rows carry only
    labels, so this leaves the ordinary two-row tabs at 6 exactly as before."""
    for i in range(4, min(len(raw), 10)):
        for v in raw.iloc[i]:
            s = str(v).strip()
            if not s or s.lower() == "nan":
                continue
            if _GSTIN_RE.match(s.upper()) or _DATE_CELL_RE.match(s) or _MONEY_CELL_RE.match(s):
                return i
    return 6


def _read_gstr2b_sheet(data: bytes, sheet_name: str) -> list[dict[str, Any]]:
    """
    GSTR-2B sheets carry a merged header band starting at row index 4 — two rows on
    the ordinary tabs, three on the amendment tabs. Data starts after it.
    """
    raw = pd.read_excel(BytesIO(data), sheet_name=sheet_name, header=None, dtype=object)
    if len(raw) < 7:
        return []

    band_end = _find_header_band_end(raw)
    header_rows = [
        [str(v).strip() if str(v) != "nan" else "" for v in raw.iloc[i]]
        for i in range(4, max(band_end, 5))
    ]

    # Forward-fill the TOP row only — group headers span merged cells.
    last = ""
    row4_filled = []
    for v in header_rows[0]:
        if v:
            last = v
        row4_filled.append(last)

    # Name each column by its DEEPEST label, falling back to the group header.
    # On a two-row tab this is the old "prefer sub-header" rule unchanged; on a
    # three-row amendment tab it reaches past the Original/Revised band to the real
    # label ('Central Tax(₹)') instead of stopping at it.
    combined = []
    seen: dict[str, int] = {}
    for col in range(len(row4_filled)):
        name = ""
        for depth in range(len(header_rows) - 1, 0, -1):
            if col < len(header_rows[depth]) and header_rows[depth][col]:
                name = header_rows[depth][col]
                break
        if not name:
            name = row4_filled[col]
        count = seen.get(name, 0)
        seen[name] = count + 1
        combined.append(f"{name}_{count}" if count else name)

    data_rows = raw.iloc[band_end:].copy()
    data_rows.columns = combined
    data_rows = data_rows.dropna(how="all")

    # GSTR-2B portal exports merge supplier GSTIN and name cells across all invoices
    # for the same supplier — pandas reads merged cells as NaN after the first row.
    # Forward-fill those columns so every invoice row carries its supplier info.
    gstin_aliases = {"gstin of supplier", "gstin"}
    name_aliases = {"trade/legal name", "trade name", "legal name"}
    for col in data_rows.columns:
        if _norm(col) in gstin_aliases or _norm(col) in name_aliases:
            data_rows[col] = data_rows[col].replace("", pd.NA).ffill()

    rows = data_rows.fillna("").to_dict(orient="records")
    for row in rows:
        row["_sheet"] = sheet_name
    return rows


# ---------------------------------------------------------------------------
# OCTA GSTR-2B flat-format support
# (single sheet, one header row at the top, one row per invoice — NOT the portal
#  multi-sheet B2B/B2BA/CDNR layout). Detected and parsed separately; the portal
#  path below is left completely unchanged.)
# ---------------------------------------------------------------------------

GSTR2B_OCTA_COL_MAP: dict[str, list[str]] = {
    "supplier_gstin":  ["supplier gstin"],
    "supplier_name":   ["supplier name"],
    "tally_name":      ["as per tally name"],
    "doc_no":          ["doc no", "document number", "invoice number"],
    "doc_type":        ["doc type", "document type"],
    "doc_date":        ["doc date", "document date"],
    "taxable_value":   ["item taxable value", "taxable value"],
    "igst":            ["igst", "integrated tax"],
    "cgst":            ["cgst", "central tax"],
    "sgst":            ["sgst", "state/ut tax"],
    "cess":            ["cess"],
    "invoice_value":   ["doc value", "document value"],
    "reverse_charge":  ["reverse charge"],
    "place_of_supply": ["place of supply"],
    "is_amendment":    ["is amendment"],
    "original_doc_no": ["original doc no", "original document number"],
}

# Signature headers that uniquely identify the OCTA export vs the GST portal export.
_OCTA_SIGNATURE = ("item taxable value", "supplier gstin")


def _find_octa_header_idx(raw) -> int:
    """Return the 0-based index of the OCTA header row, or -1 if not an OCTA sheet."""
    for idx in range(min(15, len(raw))):
        cells = {_norm(v) for v in raw.iloc[idx]}
        if all(sig in cells for sig in _OCTA_SIGNATURE):
            return idx
    return -1


def _find_octa_sheet_name(data: bytes) -> str | None:
    """Return the name of the sheet carrying the OCTA data, or None if not OCTA.

    The data sheet is NOT reliably the first sheet: older OCTA exports are a bare
    single 'Purchase' sheet, while newer ones prepend an 'Overview' cover sheet and
    append an 'ISD' sheet. Probing only sheet 0 makes those newer exports fall
    through to the GST-portal parser, which finds no B2B/CDNR tabs and yields zero
    records. Scan every sheet instead; only the first 15 rows are read per sheet,
    which is all _find_octa_header_idx() inspects."""
    try:
        # Context-managed: this runs several times per reconciliation (detection,
        # parsing, and each sheet-copy path), and an unclosed workbook handle would
        # sit on the heap until GC on a box that is already memory-tight.
        with pd.ExcelFile(BytesIO(data)) as xl:
            for name in xl.sheet_names:
                try:
                    probe = xl.parse(name, header=None, dtype=object, nrows=15)
                except Exception:
                    continue
                if _find_octa_header_idx(probe) >= 0:
                    return name
    except Exception:
        return None
    return None


def _is_octa_format(data: bytes) -> bool:
    """True when any sheet carries the OCTA signature headers."""
    return _find_octa_sheet_name(data) is not None


def _read_octa_sheet(data: bytes) -> list[dict[str, Any]]:
    """Read the OCTA flat sheet into row dicts (sheet and header detected dynamically)."""
    sheet_name = _find_octa_sheet_name(data)
    if sheet_name is None:
        return []
    raw = pd.read_excel(BytesIO(data), sheet_name=sheet_name, header=None, dtype=object)
    header_idx = _find_octa_header_idx(raw)
    if header_idx < 0:
        return []
    raw_headers = [str(v).strip() if str(v) != "nan" else f"_col{i}"
                   for i, v in enumerate(raw.iloc[header_idx])]
    seen: dict[str, int] = {}
    headers = []
    for h in raw_headers:
        count = seen.get(h, 0)
        seen[h] = count + 1
        headers.append(f"{h}_{count}" if count else h)
    data_rows = raw.iloc[header_idx + 1:].copy()
    data_rows.columns = headers
    data_rows = data_rows.dropna(how="all")
    return data_rows.fillna("").to_dict(orient="records")


def _parse_gstr2b_octa(data: bytes) -> list[NormalizedInvoice]:
    """Parse the OCTA flat GSTR-2B export into NormalizedInvoice records.

    Mirrors parse_gstr2b's NormalizedInvoice construction. Credit Notes are stored
    PRE-SIGNED (negative) in OCTA, so values are normalised with -abs() for CRN —
    never re-negated like the portal path (which receives positive CN values)."""
    records: list[NormalizedInvoice] = []
    index = 0
    for row in _read_octa_sheet(data):
        get = _build_getter(row, GSTR2B_OCTA_COL_MAP)
        gstin = str(get("supplier_gstin") or "").strip().upper()
        if not _GSTIN_RE.match(gstin):
            gstin = ""
        doc_no = str(get("doc_no") or "").strip()
        # Skip blank / summary / footer-total rows (no GSTIN and no Doc No).
        if not gstin and not doc_no:
            continue

        doc_type_raw = str(get("doc_type") or "").upper()
        if "CREDIT" in doc_type_raw or "CN" in doc_type_raw:
            doc_type = "CRN"
        elif "DEBIT" in doc_type_raw or "DN" in doc_type_raw:
            doc_type = "DBN"
        else:
            doc_type = "INV"

        taxable = round_money(get("taxable_value"))
        igst = round_money(get("igst"))
        cgst = round_money(get("cgst"))
        sgst = round_money(get("sgst"))
        cess = round_money(get("cess"))
        invoice_value = round_money(get("invoice_value"))

        # OCTA pre-signs Credit Notes negative — force consistent CN sign without
        # double-negating (robust whether source value is signed or not).
        if doc_type == "CRN":
            taxable, igst, cgst, sgst, cess, invoice_value = (
                -abs(taxable), -abs(igst), -abs(cgst),
                -abs(sgst), -abs(cess), -abs(invoice_value),
            )

        # Enrich-only: OCTA already maps each supplier to its Tally ledger name
        # ("As per Tally Name", e.g. "SIMK LABELS PRIVATE LIMITED (Maharashtra)").
        # Use it as supplier_name so Pass-2 name similarity and the Vendor Summary
        # common name align with the Tally Books side. Matching itself is unchanged
        # (still keyed on invoice number). Portal name kept in raw for reference.
        portal_name = str(get("supplier_name") or "").strip()
        tally_name  = str(get("tally_name") or "").strip()
        supplier_name = tally_name or portal_name

        # Amendments: OCTA flags them inline (Is Amendment + Original Doc No) rather
        # than via separate B2BA/CDNRA sheets. Map onto the sheet labels Pass-5's
        # amendment detection expects so those remarks fire.
        is_amendment = str(get("is_amendment") or "").strip().lower() in ("yes", "true", "1")
        if doc_type == "CRN":
            sheet_label = "B2B-CDNRA" if is_amendment else "B2B-CDNR"
        else:
            sheet_label = "B2BA" if is_amendment else "B2B"

        index += 1
        rec = NormalizedInvoice(
            source="GSTR-2B",
            row_id=f"GSTR2B-OCTA-{index}",
            supplier_gstin=gstin,
            supplier_name=supplier_name,
            doc_type=doc_type,
            doc_no=doc_no,
            normalized_doc_no=normalize_doc_no(doc_no),
            doc_date=parse_date(get("doc_date")),
            taxable_value=taxable,
            igst=igst,
            cgst=cgst,
            sgst=sgst,
            cess=cess,
            invoice_value=invoice_value,
            sheet_name=sheet_label,
            raw={str(k): v for k, v in row.items() if not str(k).startswith("_")},
        )
        rec.raw["_tally_name"] = tally_name
        rec.raw["_octa_portal_name"] = portal_name
        records.append(rec)
    return records


def parse_gstr2b(data: bytes) -> list[NormalizedInvoice]:
    data = _ensure_xlsx(data)
    # OCTA flat-format export uses a single sheet with inline columns — detect and
    # route to its dedicated parser. The GST portal multi-sheet logic below is
    # left completely unchanged.
    if _is_octa_format(data):
        return _parse_gstr2b_octa(data)
    records: list[NormalizedInvoice] = []
    index = 0

    # Portal sheets first, then the IMS note sheets. A portal file simply has no
    # B2B-CN/B2B-DN tabs and an IMS file no B2B-CDNR, so the extra names cost a
    # failed lookup and change nothing for either.
    for sheet in ALLOWED_SHEETS_ORDER + IMS_SHEETS_ORDER:
        try:
            rows = _read_gstr2b_sheet(data, sheet)
        except Exception:
            continue

        # On an IMS note sheet the sheet name IS the document type (there is no
        # "Note type" column to read), and the row is reported under the portal's
        # sheet label so downstream sheet-name logic needs no IMS special case.
        forced_type = IMS_SHEET_DOC_TYPE.get(sheet)
        sheet_label = IMS_SHEET_CANONICAL.get(sheet, sheet)

        for row in rows:
            get = _build_getter(row, GSTR2B_COL_MAP)
            gstin = str(get("supplier_gstin") or "").strip().upper()
            # Fallback: scan all row values for a GSTIN-format string
            if not gstin or not _GSTIN_RE.match(gstin):
                gstin = ""
                for _v in row.values():
                    _vs = str(_v or "").strip().upper()
                    if _GSTIN_RE.match(_vs):
                        gstin = _vs
                        break
            doc_no = str(get("doc_no") or "").strip()
            if not gstin and not doc_no:
                continue

            if forced_type:
                # IMS note sheet — the sheet name decides. Its type column carries the
                # SUPPLY type ("Regular"), which would otherwise fall through to INV
                # and leave the note positive instead of negative.
                doc_type = forced_type
            else:
                doc_type_raw = str(get("doc_type") or "").upper()
                if "CREDIT" in doc_type_raw or "CN" in doc_type_raw:
                    doc_type = "CRN"
                elif "DEBIT" in doc_type_raw or "DN" in doc_type_raw:
                    doc_type = "DBN"
                else:
                    doc_type = "INV"

            taxable = round_money(get("taxable_value"))
            igst = round_money(get("igst"))
            cgst = round_money(get("cgst"))
            sgst = round_money(get("sgst"))
            cess = round_money(get("cess"))
            invoice_value = round_money(get("invoice_value"))

            if doc_type == "CRN":
                taxable = -taxable
                igst = -igst
                cgst = -cgst
                sgst = -sgst
                cess = -cess
                invoice_value = -invoice_value

            index += 1
            records.append(NormalizedInvoice(
                source="GSTR-2B",
                row_id=f"GSTR2B-{sheet}-{index}",   # keeps the true source tab for tracing
                supplier_gstin=gstin,
                supplier_name=str(get("supplier_name") or "").strip(),
                doc_type=doc_type,
                doc_no=doc_no,
                normalized_doc_no=normalize_doc_no(doc_no),
                doc_date=parse_date(get("doc_date")),
                taxable_value=taxable,
                igst=igst,
                cgst=cgst,
                sgst=sgst,
                cess=cess,
                invoice_value=invoice_value,
                # Canonical portal label (IMS B2B-CN -> B2B-CDNR) so Pass 5's
                # original-vs-amendment pairing needs no IMS-specific branch.
                sheet_name=sheet_label,
                raw={str(k): v for k, v in row.items() if not str(k).startswith("_")},
            ))

    return records


# ---------------------------------------------------------------------------
# Books Parser (Purchase Register + Debit Note Register)
# Tally export: 6-row preamble, header on row 6, data from row 7
# ---------------------------------------------------------------------------

def _sum_cols(row: dict[str, Any], aliases: list[str]) -> float:
    norm_row = {_norm(k): v for k, v in row.items()}
    total = 0.0
    for alias in aliases:
        key = _norm(alias)
        if key in norm_row:
            total += round_money(norm_row[key])
    return round(total, 2)


def _is_tax_col(c: str) -> bool:
    c_lower = c.lower()
    if any(t in c_lower for t in ["cgst", "sgst", "igst", "utgst"]):
        return True
    if "cess" in c_lower and "process" not in c_lower:
        return True
    return False


def _is_tds_col(c: str) -> bool:
    return "tds" in c.lower()


def _is_round_off_col(c: str) -> bool:
    """True for a Tally 'Round Off' rounding-adjustment column.
    Collapses spaces so 'Round Off' / 'RoundOff' match; 'Ground Rent' etc. do not."""
    return "roundoff" in str(c).lower().replace(" ", "")


def _is_discount_col(c: str) -> bool:
    """True for a purchase-discount ledger column (e.g. 'Discount on Purchase@5%').

    A discount is a reduction of the purchase, posted as a credit. The supplier
    declares the value net of it in GSTR-2B, so the Books taxable must DEDUCT it —
    adding it inflates that side by the discount, and merely skipping the column
    still leaves the gross purchase ledger standing, which is short by the same
    amount. Matched on the word alone so any rate/wording variant is covered, with
    spaces collapsed the same way as Round Off."""
    return "discount" in str(c).lower().replace(" ", "")


def _is_summary_col(c: str) -> bool:
    """True for a column that RESTATES the taxable value rather than posting to it.

    Some registers carry accountant-added summary columns after the ledgers —
    'Taxable Value', 'Taxable Amount', alongside 'Total CGST/SGST/IGST'. They repeat
    a figure already present in the expense ledgers, so summing them double-counts
    the invoice (a register with one ledger of 58,251 and a 'Taxable Value' of 58,251
    reported 116,502 in Books against 58,251 in GSTR-2B). The tax totals are already
    caught by _is_tax_col; this covers the taxable restatement.

    Matched on the exact normalised name so a real expense ledger that merely
    contains the word (e.g. 'Taxable Purchases 5%') is never swallowed."""
    return _norm(c) in {"taxable value", "taxable amount", "total taxable value",
                        "total taxable amount", "total taxable"}


def _is_total_tax_col(c: str) -> bool:
    """True for a 'Total CGST/SGST/IGST/Cess' roll-up rather than an input-tax ledger.

    The same registers that restate the taxable value also restate the tax, next to
    the real ledgers ('Input CGST_OD' 5,242.59 AND 'Total CGST' 5,242.59). Counting
    both reports exactly twice the tax the supplier declared. Only a leading 'Total'
    marks the roll-up — an ordinary ledger keeps its own name."""
    return _norm(c).startswith("total ")


def _find_value_col(row: dict[str, Any]) -> str | None:
    """Return the source header that holds the explicit taxable value.

    Prefers an explicit "Taxable Value"/"Taxable Amount" column, otherwise an
    exact "Value" column. Never matches "Gross Total" (or any "gross" header) —
    Gross Total includes tax/round-off and must never be used as the taxable."""
    exact_value = None
    for k in row.keys():
        n = _norm(k)
        if "gross" in n:
            continue
        if n in ("taxable value", "taxable amount") or ("taxable" in n and "value" in n):
            return k
        if n == "value" and exact_value is None:
            exact_value = k
    return exact_value


def _is_present_number(cell: Any) -> bool:
    """True only when the cell holds an actual number (not blank/placeholder)."""
    if cell is None:
        return False
    s = str(cell).replace(",", "").replace("₹", "").strip()
    if s.lower() in ("", "-", "nan", "nat", "none", "null", "n/a"):
        return False
    try:
        float(s)
        return True
    except ValueError:
        return False


IGST_ALIASES = [
    "input igst dl", "input igst 18% gj", "input igst 18% kr", "input igst 18% hr",
    "input igst 18% mh", "input igst 18% rj", "input igst 18% tn", "input igst 18% tg",
    "input igst 18% up", "input igst 18% wb", "input igst 18% isd", "igst",
]
CGST_ALIASES = [
    "input cgst dl", "input cgst 9% gj", "input cgst 9% hr", "input cgst 9% kr",
    "input cgst 9% mp", "input cgst 9% mh", "input cgst 9% pj", "input cgst 9% rj",
    "input cgst 9% tn", "input cgst 9% tg", "input cgst 9% up", "input cgst 9% wb", "cgst",
]
SGST_ALIASES = [
    "input sgst dl", "input sgst 9% gj", "input sgst 9% hr", "input sgst 9% kr",
    "input sgst 9% mp", "input sgst 9% mh", "input sgst 9% pj", "input sgst 9% rj",
    "input sgst 9% tn", "input sgst 9% tg", "input sgst 9% up", "input sgst 9% wb",
    "sgst", "utgst",
]


def _read_tally_sheet(data: bytes) -> list[dict[str, Any]]:
    xl = pd.ExcelFile(BytesIO(data))
    sheet_name = xl.sheet_names[0]
    raw = xl.parse(sheet_name, header=None, dtype=object)
    if len(raw) < 2:
        return []

    # Find the header row dynamically by scanning the first 20 rows
    header_idx = -1
    for idx in range(min(20, len(raw))):
        row_str = [str(x).strip().lower() for x in raw.iloc[idx]]
        if any("date" in x for x in row_str) and any("particulars" in x for x in row_str):
            header_idx = idx
            break
            
    if header_idx == -1:
        # Fallback to row index 6 (row 7)
        header_idx = min(6, len(raw) - 1)

    # Make column names unique
    raw_headers = [str(v).strip() if str(v) != "nan" else f"_col{i}" for i, v in enumerate(raw.iloc[header_idx])]
    seen: dict[str, int] = {}
    headers = []
    for h in raw_headers:
        count = seen.get(h, 0)
        seen[h] = count + 1
        headers.append(f"{h}_{count}" if count else h)

    data_rows = raw.iloc[header_idx + 1:].copy()
    data_rows.columns = headers
    data_rows = data_rows.dropna(how="all")

    # Keep each row's position in the source sheet. The output workbook copies the
    # register verbatim, cell for cell, so this index is what lets the audit columns
    # be written back onto the very row the figures came from — and what lets a row
    # the parser never turned into a record be spotted as genuinely missed.
    out: list[dict[str, Any]] = []
    for src_idx, record in zip(data_rows.index, data_rows.fillna("").to_dict(orient="records")):
        record["_src_row"] = int(src_idx)      # 0-based pandas row; Excel row = +1
        out.append(record)
    return out


def audit_row_figures(row: dict[str, Any], default_type: str) -> dict[str, float]:
    """Re-derive one register row's figures straight from its raw cells.

    Written as a SECOND, standalone reading of the row so the workbook can show the
    accountant an independent check of what the engine stored, rather than echoing
    the engine's own answer back at them. It shares only the column classifiers
    (_is_tax_col and friends) — the row walk, the sign handling and the arithmetic
    are separate, so a plumbing fault in parse_books (wrong column picked up, a sign
    dropped, a row skipped) shows as a difference instead of hiding.

    Applies exactly the rules parse_books applies, or every discount and summary row
    would report a false difference: tax/TDS/Round Off excluded, purchase discount
    SUBTRACTED where a real ledger exists, a restated 'Taxable Value' used only when
    the row has no ledger of its own, and 'Total CGST/SGST/IGST' roll-ups used only
    for a head with no input-tax ledger. Debit-note rows are negated."""
    keys = [k for k in row.keys() if not str(k).startswith("_")]
    gt_pos = next((i for i, k in enumerate(keys) if _norm(k) == "gross total"), -1)

    ledgers: list[float] = []
    summaries: list[float] = []
    for k in keys[gt_pos + 1:]:
        ks = str(k)
        if _is_tax_col(ks) or _is_tds_col(ks) or _is_round_off_col(ks):
            continue
        amt = round_money(row.get(k))
        if not amt:
            continue
        (summaries if _is_summary_col(ks) else ledgers).append(
            -abs(amt) if _is_discount_col(ks) else amt
        )
    # A discount with no real ledger beside it IS the amount billed, not a reduction.
    if not any(a > 0 for a in ledgers) and len(ledgers) == 1 and ledgers[0] < 0:
        ledgers = [abs(ledgers[0])]
    taxable = round(sum(ledgers) if ledgers else sum(summaries), 2)

    led = {"igst": 0.0, "cgst": 0.0, "sgst": 0.0, "cess": 0.0}
    tot = {"igst": 0.0, "cgst": 0.0, "sgst": 0.0, "cess": 0.0}
    for k in keys:
        kl = str(k).lower().strip()
        if "igst" in kl:
            head = "igst"
        elif "cgst" in kl:
            head = "cgst"
        elif "sgst" in kl or "utgst" in kl:
            head = "sgst"
        elif "cess" in kl and "process" not in kl:
            head = "cess"
        else:
            continue
        (tot if _is_total_tax_col(k) else led)[head] += round_money(row.get(k))

    out = {
        "taxable_value": taxable,
        "igst": led["igst"] or tot["igst"],
        "cgst": led["cgst"] or tot["cgst"],
        "sgst": led["sgst"] or tot["sgst"],
    }
    if default_type == "DBN":
        out = {k: -v for k, v in out.items()}
    return {k: round(v, 2) for k, v in out.items()}


def parse_books(purchase_data: bytes, debit_data: bytes) -> list[NormalizedInvoice]:
    purchase_data = _ensure_xlsx(purchase_data)
    debit_data = _ensure_xlsx(debit_data)
    records: list[NormalizedInvoice] = []
    index = 0

    datasets = [
        (purchase_data, "Purchase Register", "INV"),
        (debit_data, "Debit Note Register", "DBN"),
    ]

    for data, source, default_type in datasets:
        try:
            rows = _read_tally_sheet(data)
        except Exception:
            continue

        for row in rows:
            # Which register this row came from — needed to write the audit columns
            # back onto the right copied sheet.
            row["_src_sheet"] = source
            # Skip if no date (summary rows)
            date_raw = row.get("Date", "")
            if not str(date_raw).strip() or str(date_raw).strip() in ("nan", ""):
                continue

            # Supplier Invoice No. is the primary matching key. Books exports carry TWO
            # numbers though — the supplier's invoice no. and the buyer's own voucher
            # no. — and when a wrong supplier ref is typed in, the voucher no. is often
            # the one that actually corresponds to GSTR-2B. Keep BOTH: the first
            # non-empty stays the primary (display unchanged), the other becomes an
            # alternate matching key. Identical values collapse to no alternate.
            doc_no = ""
            alt_doc_no = ""
            for col in ["Supplier Invoice No.", "Voucher Ref. No.", "Voucher No."]:
                val = str(row.get(col, "") or "").strip()
                if val and val not in ("nan", ""):
                    if not doc_no:
                        doc_no = val
                    elif val != doc_no and not alt_doc_no:
                        alt_doc_no = val

            # Date
            doc_date = ""
            for col in ["Supplier Invoice Date", "Voucher Ref. Date", "Date"]:
                val = row.get(col, "")
                parsed = parse_date(val)
                if parsed:
                    doc_date = parsed
                    break

            # Supplier name
            supplier_name = ""
            for col in ["Particulars", "Supplier", "Buyer"]:
                val = str(row.get(col, "") or "").strip()
                if val and val not in ("nan", ""):
                    supplier_name = val
                    break

            if not doc_no and not supplier_name:
                continue

            # Input-tax ledgers and 'Total CGST/SGST/IGST' roll-ups are collected apart.
            # A register carrying both would count each tax twice, so the roll-up is used
            # only for a head with no ledger of its own on this row — the same row-aware
            # rule as the taxable-value restatement below.
            _tax_led = {"igst": 0.0, "cgst": 0.0, "sgst": 0.0, "cess": 0.0}
            _tax_tot = {"igst": 0.0, "cgst": 0.0, "sgst": 0.0, "cess": 0.0}

            for k, v in row.items():
                k_lower = str(k).lower().strip()
                if "igst" in k_lower:
                    head = "igst"
                elif "cgst" in k_lower:
                    head = "cgst"
                elif "sgst" in k_lower or "utgst" in k_lower:
                    head = "sgst"
                elif "cess" in k_lower and "process" not in k_lower:
                    head = "cess"
                else:
                    continue
                bucket = _tax_tot if _is_total_tax_col(k) else _tax_led
                bucket[head] += round_money(v)

            igst = _tax_led["igst"] or _tax_tot["igst"]
            cgst = _tax_led["cgst"] or _tax_tot["cgst"]
            sgst = _tax_led["sgst"] or _tax_tot["sgst"]
            cess = _tax_led["cess"] or _tax_tot["cess"]

            # ── Books taxable value ──────────────────────────────────────────
            # ALWAYS the sum of the purchase/expense ledger columns positioned
            # AFTER "Gross Total". The "Value" column is intentionally NOT used:
            # it is blank for no-GRN invoices and omits freight/penalty/etc.
            # Excluded from the sum:
            #   • GST input tax (Input IGST/CGST/SGST/UTGST/Cess) — _is_tax_col.
            #     "GST Interstate Purchase X%" is a PURCHASE ledger (no igst/cgst/
            #     sgst token) and is therefore correctly INCLUDED — it is the key
            #     amount on these files.
            #   • TDS columns                                      — _is_tds_col
            #   • Round Off (rounding adjustment, not an expense)  — _is_round_off_col
            # Deducted from the sum (NOT excluded):
            #   • Purchase discount — a credit reducing the purchase. The supplier
            #     declares the value net of it in GSTR-2B and Tally charges tax on
            #     the net, so Books must deduct it to reach the same taxable value.
            #                                                      — _is_discount_col
            gross = round_money(row.get("Gross Total", 0))
            invoice_value = gross

            taxable_breakdown: list[tuple[str, float]] = []
            keys = list(row.keys())
            gt_pos = next(
                (i for i, k in enumerate(keys) if _norm(k) == "gross total"),
                -1,
            )
            ledgers: list[tuple[str, float]] = []
            summaries: list[tuple[str, float]] = []
            for k in keys[gt_pos + 1:]:
                ks = str(k)
                # Internal bookkeeping keys (_src_row, _src_sheet) sit after the last
                # real column and are NOT ledgers — summing them would corrupt the
                # taxable value with a row number.
                if ks.startswith("_"):
                    continue
                if _is_tax_col(ks) or _is_tds_col(ks) or _is_round_off_col(ks):
                    continue
                amt = round_money(row.get(k))
                if not amt:
                    continue
                if _is_summary_col(ks):
                    summaries.append((ks, amt))
                else:
                    ledgers.append((ks, amt))

            # A 'Taxable Value' summary column repeats what the ledgers already say, so
            # it is dropped whenever this row HAS ledgers — counting both doubles the
            # invoice. If the row carries nothing but the summary (a register that lists
            # no expense ledgers at all), it is the only figure available, so use it
            # rather than reporting the row as zero. Same row-aware shape as the
            # discount rule above: decided from the data, no ledger names hardcoded.
            if not ledgers and summaries:
                ledgers = summaries

            # A discount ledger is only a REDUCTION when the row also carries a real
            # purchase/expense ledger for it to reduce. Tally posts the discount as a
            # separate credit line rather than netting it into the purchase ledger, so
            # that ledger stays GROSS — the discount must be SUBTRACTED (skipping it
            # leaves the taxable gross; adding it overstates by the same amount again).
            # When the discount ledger is the ONLY line on the row there is nothing to
            # reduce: the "discount" IS the amount being billed (a marketplace invoicing
            # the brand for funded discounts), so it counts positively, as any other
            # expense would. Decided per row from the data — no ledger names hardcoded.
            has_reducible = any(not _is_discount_col(h) for h, _ in ledgers)
            running = 0.0
            for ks, amt in ledgers:
                if has_reducible and _is_discount_col(ks):
                    # abs() so either export sign convention (positive, or already
                    # negative) reduces the purchase rather than inflating it.
                    amt = -abs(amt)
                running += amt
                taxable_breakdown.append((ks, round(amt, 2)))
            taxable = round(running, 2)
            taxable_derived = True

            if default_type == "DBN":
                taxable = -taxable
                igst = -igst
                cgst = -cgst
                sgst = -sgst
                cess = -cess
                invoice_value = -invoice_value
                taxable_breakdown = [(h, -a) for h, a in taxable_breakdown]

            # GSTIN — validate the shape, don't just normalise it. Books exports
            # regularly carry something other than a GSTIN in this column (an invoice
            # number typed into the wrong field is the common case). An unvalidated
            # value is worse than a blank one: it defeats the compound key, disqualifies
            # the invoice-only pass (which requires NO gstin) and trips Pass 2's guard,
            # so a row that matches perfectly by number and name is reported as missing
            # on both sides. Both GSTR-2B parsers already validate the same way.
            raw_gstin = _norm_gstin(
                row.get("GSTIN/UIN") or row.get("GSTIN") or row.get("gstin/uin") or row.get("gstin") or ""
            )
            bad_gstin = raw_gstin if (raw_gstin and not _GSTIN_RE.match(raw_gstin)) else ""
            gstin = "" if bad_gstin else raw_gstin

            index += 1
            rec = NormalizedInvoice(
                source=source,
                row_id=f"{source}-{index}",
                supplier_gstin=gstin,
                supplier_name=supplier_name,
                doc_type=default_type,
                doc_no=doc_no,
                normalized_doc_no=normalize_doc_no(doc_no),
                doc_date=doc_date,
                taxable_value=taxable,
                igst=igst,
                cgst=cgst,
                sgst=sgst,
                cess=cess,
                invoice_value=invoice_value,
                raw={str(k): v for k, v in row.items()},
            )
            # Display-only audit trail: when taxable was derived (no Value column),
            # remember which expense heads were summed so the output can show a
            # live formula + cell comment. Never affects the numeric value above.
            rec.raw["_taxable_derived"] = taxable_derived
            if taxable_derived:
                rec.raw["_taxable_breakdown"] = taxable_breakdown
            # Alternate matching key (see doc_no selection above) and the rejected
            # GSTIN, both carried for the matcher and the Remark 2 text. Stored on raw
            # so NormalizedInvoice stays untouched for every other agent.
            if alt_doc_no:
                rec.raw["_alt_doc_no"] = alt_doc_no
                rec.raw["_alt_normalized_doc_no"] = normalize_doc_no(alt_doc_no)
            if bad_gstin:
                rec.raw["_bad_gstin"] = bad_gstin
            records.append(rec)

    return records


# ---------------------------------------------------------------------------
# Custom reconciliation (match by invoice number; GSTIN not available in books)
# ---------------------------------------------------------------------------

def _name_sim(a: str, b: str) -> float:
    """Simple word-overlap similarity between two supplier names."""
    wa = set(re.sub(r"[^a-z0-9]", " ", a.lower()).split())
    wb = set(re.sub(r"[^a-z0-9]", " ", b.lower()).split())
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / max(len(wa), len(wb))


# Legal-form suffixes only. A Tally ledger name routinely drops them while the GST
# legal name spells them out, so they carry no identifying information. Industry
# words ("industries", "packaging", "foods") are deliberately NOT listed here —
# they are still compared, they just cannot carry a match on their own (see below).
_PARTY_NOISE = {
    "private", "pvt", "limited", "ltd", "llp", "llc", "inc",
    "company", "co", "corporation", "corp", "the", "and",
}


def _party_tokens(name: str) -> list[str]:
    words = re.sub(r"[^a-z0-9]", " ", str(name or "").lower()).split()
    return [w for w in words if w not in _PARTY_NOISE]


def _tok_match(wa: str, wb: str) -> bool:
    """True when two name tokens are the same word, or one is a clear truncation of
    the other (a ledger abbreviation of the same root word).

    The shared prefix is measured against the LONGER token, not the shorter one.
    Measured against the shorter, any short word that happens to open with the same
    letters as a longer unrelated word clears the bar and links distinct vendors.
    Against the longer token, a genuine truncation still passes because almost all of
    the longer word is shared, while a coincidental prefix falls well short."""
    if wa == wb:
        return True
    if len(wa) < 4 or len(wb) < 4:
        return False
    common = 0
    for ca, cb in zip(wa, wb):
        if ca != cb:
            break
        common += 1
    return common >= 4 and common >= 0.8 * max(len(wa), len(wb))


def _party_sim(a: str, b: str) -> float:
    """Identity-based supplier-name similarity, for CN↔DN party checks only.

    Answers "is this the same company?", not "do these strings share words".
    _name_sim() counts only whole-word equality, so a full GST legal name scores far
    too low against the shortened ledger name a client actually books under, and the
    pair is rejected even when the amount matches to the paisa.

    Two rules keep that from becoming loose keyword matching:

    1. The identifying word leads in Indian company names, so the FIRST
       non-legal-form token must match on both sides. Without this, a shared generic
       trailing word (an industry or product word) alone links unrelated vendors.
    2. Every token of the shorter name must be accounted for. A ledger name may DROP
       words the legal name carries, but a leftover distinct word on BOTH sides means
       two separate legal entities that merely share a group prefix.

    Both rules return 0.0 rather than a reduced score, deliberately: a missed match
    surfaces as a visible unmatched row the accountant reviews, whereas a false match
    silently pairs the wrong parties. Callers still gate on document type and amount.

    Fully name-agnostic — no vendor, brand, or ledger is referenced anywhere in the
    logic. _name_sim() is left untouched for every other caller."""
    ta, tb = _party_tokens(a), _party_tokens(b)
    if not ta or not tb:
        return 0.0
    # Identity gate — the distinctive leading word must be the same company.
    if not _tok_match(ta[0], tb[0]):
        return 0.0
    unused = list(tb)
    hits = 0
    for wa in ta:
        for i, wb in enumerate(unused):
            if _tok_match(wa, wb):
                hits += 1
                unused.pop(i)
                break
    # Rule 2 — the shorter name must be fully accounted for. Dropped words are fine
    # (ledger abbreviations); a leftover distinct word on BOTH sides is not.
    if hits < min(len(ta), len(tb)):
        return 0.0
    return hits / max(len(ta), len(tb))


def _core_digits(doc_no: str) -> str:
    """Extract the core numeric/alpha digits stripping common year suffixes (2025/2026)."""
    s = re.sub(r"(2025|2026)$", "", doc_no.upper())
    return re.sub(r"[^0-9A-Z]", "", s)


_CN_PREFIX_RE = re.compile(r'^(?:CDNR|CDN|LCN|CRN|CN|CR|CD)', re.IGNORECASE)

def _looks_like_cn(doc_no: str) -> bool:
    """True if doc_no starts with a common credit-note prefix (CDN, CN, LCN, CR, CRN…)."""
    return bool(_CN_PREFIX_RE.match(re.sub(r"[^A-Za-z0-9]", "", doc_no)))


def reconcile_by_invoice_no(
    gstr2b: list[NormalizedInvoice],
    books: list[NormalizedInvoice],
    tolerance: float = 1.0,
) -> list[MatchResult]:
    """
    Match GSTR-2B records to Books records using normalised invoice number as the
    primary key. When both sides carry a GSTIN (Purchase Register exports GSTIN/UIN),
    a compound (invoice_no + GSTIN) key is used first to prevent false matches across
    different vendors that happen to share the same invoice number (Pass 1A).
    Invoice-only matching is the fallback for Books rows without a GSTIN (Pass 1B).
    Falls back to supplier name + core-digit matching for minor year-suffix differences.
    """
    # Build books indexes
    books_by_no: dict[str, list[int]] = {}
    books_by_core: dict[str, list[int]] = {}
    # Compound index: (normalized_doc_no, normalized_gstin) → [indices] — only for rows with GSTIN
    books_by_compound: dict[tuple, list[int]] = {}
    for idx, rec in enumerate(books):
        books_by_no.setdefault(rec.normalized_doc_no, []).append(idx)
        books_by_core.setdefault(_core_digits(rec.normalized_doc_no), []).append(idx)
        # Index the alternate number too (buyer's voucher no. when it differs from the
        # supplier invoice no.). A mistyped supplier ref otherwise hides a row whose
        # voucher no. matches GSTR-2B exactly. used_books still allows one pairing per
        # row, and the candidate scorer below decides which key actually wins.
        alt = rec.raw.get("_alt_normalized_doc_no") or ""
        if alt and alt != rec.normalized_doc_no:
            books_by_no.setdefault(alt, []).append(idx)
            books_by_core.setdefault(_core_digits(alt), []).append(idx)
        if rec.normalized_doc_no and rec.supplier_gstin:
            key = (rec.normalized_doc_no, rec.supplier_gstin)
            books_by_compound.setdefault(key, []).append(idx)
            if alt and alt != rec.normalized_doc_no:
                books_by_compound.setdefault((alt, rec.supplier_gstin), []).append(idx)

    results: list[MatchResult] = []
    used_books: set[int] = set()
    used_gstr2b: set[int] = set()

    def _candidate_score(g_rec, b_idx: int) -> tuple:
        """Rank Books candidates that share an invoice number with a GSTR-2B row.

        The same number legitimately appears against several Books rows — a supplier
        ref typed onto the wrong party, or two vendors genuinely using the same
        number. Taking the first row in file order then pairs GSTR-2B against whichever
        happened to be entered first, which reports a confident 'Matched' against the
        wrong party while the correct row is left showing as missing. Rank on identity
        and value instead: GSTIN is decisive when both sides have one, then amount,
        then date, then party name. Ordering is unchanged when there is one candidate."""
        b = books[b_idx]
        g_gstin = (g_rec.supplier_gstin or "").strip()
        b_gstin = (b.supplier_gstin or "").strip()
        return (
            1 if (g_gstin and b_gstin and g_gstin == b_gstin) else 0,
            1 if amount_equal(g_rec.taxable_value, b.taxable_value, tolerance) else 0,
            1 if (g_rec.doc_date and g_rec.doc_date == b.doc_date) else 0,
            round(_party_sim(g_rec.supplier_name, b.supplier_name), 3),
            -b_idx,   # stable tie-break: earliest row wins, matching previous behaviour
        )

    def _best_candidate(g_rec, candidates: list[int]) -> int:
        return max(candidates, key=lambda i: _candidate_score(g_rec, i))

    def _make_result(g_rec, b_rec, category_override=None):
        mismatches: list[str] = []
        # A Debit Note is stored positive on the GSTR-2B side and negative on the Books
        # side by design, so a DN<->DN pair must be compared on magnitude. Comparing the
        # signed values would report every such pair as a mismatch of twice the amount.
        _dn_pair = _get_val(g_rec, "doc_type", "") == "DBN" and _get_val(b_rec, "doc_type", "") == "DBN"
        for field in ("taxable_value", "igst", "cgst", "sgst"):
            gv, bv = getattr(g_rec, field), getattr(b_rec, field)
            if _dn_pair:
                gv, bv = abs(gv), abs(bv)
            if not amount_equal(gv, bv, tolerance):
                mismatches.append(field)
        if category_override:
            category = category_override
            confidence = 70
            action = "Review — invoice number year suffix differs between GSTR-2B and Books."
            explanation = f"Matched by supplier name and core invoice digits; year suffix differs."
        elif not mismatches:
            category = "Matched"
            confidence = 100
            action = "Claim ITC if otherwise eligible."
            explanation = "Invoice number matches and all amounts are within tolerance."
        else:
            category = "Amount Mismatch"
            confidence = 75
            action = "Review amount differences before claiming ITC."
            explanation = f"Invoice number matches but {', '.join(mismatches)} differs."
        return MatchResult(
            category=category,
            confidence=confidence,
            gstr2b=g_rec,
            purchase=b_rec,
            mismatch_fields=mismatches,
            suggested_action=action,
            explanation=explanation,
        )

    # Pass 1A — compound key: invoice_no + GSTIN (definitive — no false positives across vendors)
    for g_idx, g_rec in enumerate(gstr2b):
        inv  = g_rec.normalized_doc_no
        gstn = g_rec.supplier_gstin
        if not inv or not gstn:
            continue
        comp_candidates = [i for i in books_by_compound.get((inv, gstn), []) if i not in used_books]
        if not comp_candidates:
            continue
        best_idx = _best_candidate(g_rec, comp_candidates)
        used_gstr2b.add(g_idx)
        used_books.add(best_idx)
        results.append(_make_result(g_rec, books[best_idx]))

    # Pass 1B — invoice-only fallback (Books rows without GSTIN — old file format)
    for g_idx, g_rec in enumerate(gstr2b):
        if g_idx in used_gstr2b:
            continue
        inv = g_rec.normalized_doc_no
        if not inv:
            continue
        # Only match Books rows that have NO GSTIN (so they were skipped in the compound index)
        candidates = [i for i in books_by_no.get(inv, [])
                      if i not in used_books and not books[i].supplier_gstin]
        if not candidates:
            continue
        best_idx = _best_candidate(g_rec, candidates)
        used_gstr2b.add(g_idx)
        used_books.add(best_idx)
        results.append(_make_result(g_rec, books[best_idx]))

    # Pass 2 — fuzzy fallback: core digits + supplier name similarity >= 0.5
    for g_idx, g_rec in enumerate(gstr2b):
        if g_idx in used_gstr2b:
            continue
        g_core = _core_digits(g_rec.normalized_doc_no)
        candidates = [i for i in books_by_core.get(g_core, []) if i not in used_books]
        if not candidates:
            continue
        # Pick best name similarity
        best_idx = max(candidates, key=lambda i: _name_sim(g_rec.supplier_name, books[i].supplier_name))
        if _name_sim(g_rec.supplier_name, books[best_idx].supplier_name) < 0.5:
            continue
        # GSTIN guard: if both sides carry a GSTIN and they differ, skip — definitely different vendors
        g_gstin = g_rec.supplier_gstin or ""
        b_gstin = books[best_idx].supplier_gstin or ""
        if g_gstin and b_gstin and g_gstin != b_gstin:
            continue
        used_gstr2b.add(g_idx)
        used_books.add(best_idx)
        results.append(_make_result(g_rec, books[best_idx], category_override="Matched"))

    # Pass 2.5 — CN (GSTR-2B) ↔ DN (Books) cross-type match
    # A supplier's Credit Note number (e.g. LCN-38/24-25) and the buyer's Debit Note
    # number (e.g. 44/24-25) are completely different strings — Passes 1 & 2 cannot link them.
    # Only attempt when the GSTR-2B doc_no has a recognisable CN prefix to avoid false positives.
    for g_idx, g_rec in enumerate(gstr2b):
        if g_idx in used_gstr2b:
            continue
        if g_rec.doc_type != "CRN" or not _looks_like_cn(g_rec.doc_no):
            continue
        best_b, best_sim = None, 0.0
        for b_idx, b_rec in enumerate(books):
            if b_idx in used_books or b_rec.doc_type != "DBN":
                continue
            sim = _party_sim(g_rec.supplier_name, b_rec.supplier_name)
            if sim >= 0.5 and abs(g_rec.taxable_value - b_rec.taxable_value) <= tolerance:
                if sim > best_sim:
                    best_b, best_sim = b_idx, sim
        if best_b is not None:
            used_gstr2b.add(g_idx)
            used_books.add(best_b)
            results.append(_make_result(g_rec, books[best_b], category_override="Partially Matched"))

    # Pass 2.6 — DN (GSTR-2B) ↔ DN (Books) match
    # A supplier's Debit Note number and the buyer's Debit Note voucher no. (often a
    # bare "1", "2") share nothing, so no invoice-number pass can link them. Unlike
    # Pass 2.5 the Books rows usually carry a GSTIN by this point (back-filled from the
    # GSTR-2B name map), so identity can be settled on GSTIN rather than name alone.
    #
    # The two sides are stored with OPPOSITE signs by design — parse_books negates a
    # Books debit note, parse_gstr2b leaves a GSTR-2B one positive — so magnitudes are
    # compared and the opposing sign is required explicitly, rather than relying on
    # that convention holding forever.
    #
    # Date is deliberately NOT a filter: a note is often booked in a later period and
    # that is legitimate. It is used only to choose BETWEEN otherwise-equal candidates
    # (recurring charges repeat at identical amounts), so it can never cost a match —
    # it only stops the pairing being arbitrary and keeps re-runs stable.
    def _dn_date_gap(a, b) -> int:
        """Days between two ISO dates; large sentinel when either is missing."""
        try:
            from datetime import date as _d
            ya, ma, da = (int(x) for x in str(a)[:10].split("-"))
            yb, mb, db = (int(x) for x in str(b)[:10].split("-"))
            return abs((_d(ya, ma, da) - _d(yb, mb, db)).days)
        except Exception:
            return 10 ** 6

    for g_idx, g_rec in enumerate(gstr2b):
        if g_idx in used_gstr2b or g_rec.doc_type != "DBN":
            continue
        g_gstin = (g_rec.supplier_gstin or "").strip()
        best_b, best_key = None, None
        for b_idx, b_rec in enumerate(books):
            if b_idx in used_books or b_rec.doc_type != "DBN":
                continue
            # Amount: equal in magnitude, and recorded on opposing sides.
            if abs(abs(g_rec.taxable_value) - abs(b_rec.taxable_value)) > tolerance:
                continue
            if g_rec.taxable_value * b_rec.taxable_value > 0:
                continue
            # Identity: GSTIN is decisive when both sides have one; otherwise fall
            # back to the party-name test used by Pass 2.5.
            b_gstin = (b_rec.supplier_gstin or "").strip()
            if g_gstin and b_gstin:
                if g_gstin != b_gstin:
                    continue
                sim = 1.0
            else:
                sim = _party_sim(g_rec.supplier_name, b_rec.supplier_name)
                if sim < 0.5:
                    continue
            # Rank: stronger identity first, then nearest date, then earliest row.
            key = (sim, -_dn_date_gap(g_rec.doc_date, b_rec.doc_date), -b_idx)
            if best_key is None or key > best_key:
                best_b, best_key = b_idx, key
        if best_b is not None:
            used_gstr2b.add(g_idx)
            used_books.add(best_b)
            results.append(_make_result(g_rec, books[best_b], category_override="Partially Matched"))

    # Pass 3 — GSTR-2B records with no match in books
    for g_idx, g_rec in enumerate(gstr2b):
        if g_idx not in used_gstr2b:
            results.append(MatchResult(
                category="In GSTR-2B not in Books",
                confidence=0,
                gstr2b=g_rec,
                purchase=None,
                mismatch_fields=["missing_in_books"],
                suggested_action="In 2B but not in the books",
                explanation="Invoice present in GSTR-2B but not found in Purchase/Debit Note Register.",
            ))

    # Pass 4 — Books records with no match in GSTR-2B
    for b_idx, b_rec in enumerate(books):
        if b_idx not in used_books:
            results.append(MatchResult(
                category="In Books not in GSTR-2B",
                confidence=0,
                gstr2b=None,
                purchase=b_rec,
                mismatch_fields=["missing_in_gstr2b"],
                suggested_action="Need to 2B",
                explanation="Invoice present in Books but not found in GSTR-2B.",
            ))

    # Pass 5 — Post-processing Calibration & Remark Overhaul

    # ── Amendment detection sets ─────────────────────────────────────────────
    # Two cases both need flagging:
    #   Case A: B2BA unmatched + B2B has same invoice (B2B matched with Books)
    #           → flag the B2BA row: "Amendment entry in B2BA"
    #   Case B: B2B unmatched + B2BA has same invoice (B2BA matched with Books)
    #           → flag the B2B row: "Original invoice amended in B2BA"
    # Same logic applies for B2B-CDNR / B2B-CDNRA.
    b2b_orig_nos  = {r.normalized_doc_no for r in gstr2b
                     if r.sheet_name == "B2B"       and r.normalized_doc_no}
    cdnr_orig_nos = {r.normalized_doc_no for r in gstr2b
                     if r.sheet_name == "B2B-CDNR"  and r.normalized_doc_no}
    b2ba_nos      = {r.normalized_doc_no for r in gstr2b
                     if r.sheet_name == "B2BA"       and r.normalized_doc_no}
    cdnra_nos     = {r.normalized_doc_no for r in gstr2b
                     if r.sheet_name == "B2B-CDNRA"  and r.normalized_doc_no}

    # ── Duplicate-type maps keyed by normalized_doc_no ───────────────────────
    # "dup"              = same doc_no, same sign, same-ish party → true duplicate
    # "same_no_diff_party" = same doc_no, same sign, different parties → different vendors, same number
    # "cross_ref"        = same doc_no with OPPOSITE signs → INV+CRN or PR+DN pair
    # ""                 = unique

    def _calc_dup_type_enhanced(records: list) -> str:
        """records: list of (taxable_value, supplier_name)"""
        if len(records) <= 1:
            return ""
        vals  = [r[0] for r in records]
        names = [r[1] for r in records]
        all_pos = all(v >= 0 for v in vals)
        all_neg = all(v <= 0 for v in vals)
        if all_pos or all_neg:
            any_diff = any(
                _name_sim(names[i], names[j]) < 0.5
                for i in range(len(names))
                for j in range(i + 1, len(names))
            )
            return "same_no_diff_party" if any_diff else "dup"
        return "cross_ref"

    g_key_records: dict = {}
    for g_rec in gstr2b:
        if g_rec.normalized_doc_no:
            g_key_records.setdefault(g_rec.normalized_doc_no, []).append(
                (g_rec.taxable_value, g_rec.supplier_name or "")
            )
    g_key_dup_type: dict = {k: _calc_dup_type_enhanced(v) for k, v in g_key_records.items()}

    b_key_records: dict = {}
    for b_rec in books:
        if b_rec.normalized_doc_no:
            b_key_records.setdefault(b_rec.normalized_doc_no, []).append(
                (b_rec.taxable_value, b_rec.supplier_name or "")
            )
    b_key_dup_type: dict = {k: _calc_dup_type_enhanced(v) for k, v in b_key_records.items()}

    for r in results:
        g = r.gstr2b
        b = r.purchase

        g_dup_type = g_key_dup_type.get(g.normalized_doc_no, "") if g else ""
        b_dup_type = b_key_dup_type.get(b.normalized_doc_no, "") if b else ""

        r.suggested_action_2 = ""

        # Scenario A: BOTH GSTR-2B and Books exist
        if g and b:
            # DN<->DN pairs are stored with opposing signs by design (see _make_result),
            # so the excess/mismatch remarks below compare magnitudes for those.
            _dn_pair = (_get_val(g, "doc_type", "") == "DBN"
                        and _get_val(b, "doc_type", "") == "DBN")
            _sgn = (lambda v: abs(v)) if _dn_pair else (lambda v: v)
            g_tax = round(_sgn(g.igst) + _sgn(g.cgst) + _sgn(g.sgst) + _sgn(g.cess), 2)
            b_tax = round(_sgn(b.igst) + _sgn(b.cgst) + _sgn(b.sgst) + _sgn(b.cess), 2)

            sec_remarks = []

            # Books data-entry flags. The matcher works around these, but the source
            # error stays in Tally until someone is told about it, so surface it here.
            _b_raw = _get_val(b, "raw", {}) or {}
            _bad_gstin = _b_raw.get("_bad_gstin") or ""
            if _bad_gstin:
                sec_remarks.append(
                    f"Books GSTIN column contains '{_bad_gstin}' — not a valid GSTIN "
                    f"(an invoice/voucher number appears to have been entered in the GSTIN "
                    f"field); ignored for matching — correct it in Books"
                )
            _alt_doc = _b_raw.get("_alt_doc_no") or ""
            if _alt_doc and _b_raw.get("_alt_normalized_doc_no") == _get_val(g, "normalized_doc_no", ""):
                sec_remarks.append(
                    f"Matched on Books voucher no. '{_alt_doc}' — the Supplier Invoice No. "
                    f"recorded in Books ('{_get_val(b, 'doc_no', '')}') does not match GSTR-2B; "
                    f"verify the reference"
                )

            _g_type, _b_type = _get_val(g, "doc_type", ""), _get_val(b, "doc_type", "")
            if _g_type == "CRN" and _b_type == "DBN":
                r.suggested_action = "Partially Matched"
                r.category = "Partially Matched"
                sec_remarks.insert(0,
                    f"CN-DN Match: {_get_val(g, 'doc_no', '')} ↔ {_get_val(b, 'doc_no', '')}"
                )
            elif (_g_type == "DBN" and _b_type == "DBN"
                  and _get_val(g, "normalized_doc_no", "") != _get_val(b, "normalized_doc_no", "")):
                # Paired by party + amount (Pass 2.6), not by a shared document number —
                # flag it for review the same way the CN-DN pairing is flagged.
                r.suggested_action = "Partially Matched"
                r.category = "Partially Matched"
                sec_remarks.insert(0,
                    f"DN-DN Match: {_get_val(g, 'doc_no', '')} ↔ {_get_val(b, 'doc_no', '')}"
                )
            else:
                r.suggested_action = "Matched"

            if g_tax - b_tax > 1.0:
                r.category = "Amount Mismatch"
                sec_remarks.append("Tax Amount Mismatch, Excess in 2B")
            elif b_tax - g_tax > 1.0:
                r.category = "Amount Mismatch"
                sec_remarks.append("Tax Amount Mismatch, Excess in Books")

            _g_taxable, _b_taxable = _sgn(g.taxable_value), _sgn(b.taxable_value)
            if _g_taxable - _b_taxable > 1.0:
                r.category = "Amount Mismatch"
                sec_remarks.append("Taxable Value Mismatch, Excess in 2B")
            elif _b_taxable - _g_taxable > 1.0:
                r.category = "Amount Mismatch"
                sec_remarks.append("Taxable Value Mismatch, Excess in Books")

            from recon.core import parse_date
            if parse_date(g.doc_date) != parse_date(b.doc_date):
                sec_remarks.append("Invoice Date Mismatch")

            # Books duplicate/cross-ref
            if b_dup_type == "dup":
                sec_remarks.append("Invoice appears twice in Books — verify if duplicate booking")
            elif b_dup_type == "same_no_diff_party":
                sec_remarks.append("Same voucher number in Books for different parties — verify")
            elif b_dup_type == "cross_ref":
                sec_remarks.append("Invoice also referenced in DN Register")

            # 2B duplicate/cross-ref (independent — both can appear)
            if g_dup_type == "dup":
                sec_remarks.append("Invoice appears twice in GSTR-2B — possible duplicate upload by vendor")
            elif g_dup_type == "same_no_diff_party":
                sec_remarks.append("Same invoice number in GSTR-2B for different parties — verify")
            elif g_dup_type == "cross_ref":
                sec_remarks.append("Same invoice number also exists as Credit Note in GSTR-2B")

            r.suggested_action_2 = ", ".join(sec_remarks) if sec_remarks else ""

        # Scenario B: In GSTR-2B but NOT in Books
        elif g and not b:
            r.suggested_action = "Showing in 2B but Not in Books"

            sec_remarks = []

            # RCM check
            is_rcm = any(
                "reverse charge" in k.lower() and str(v).strip().lower() == "yes"
                for k, v in g.raw.items()
            )
            if is_rcm:
                sec_remarks.append("RCM")

            # Amendment detection — covers both directions:
            # Case A: amendment sheet (B2BA/CDNRA) is unmatched, original (B2B/CDNR) matched Books
            # Case B: original sheet (B2B/CDNR) is unmatched, amendment (B2BA/CDNRA) matched Books
            # When amendment is flagged, skip the dup remark — dup is a false positive here.
            is_amendment = False
            if g.sheet_name == "B2BA" and g.normalized_doc_no in b2b_orig_nos:
                sec_remarks.append(
                    f"Amendment entry in B2BA — original invoice {g.doc_no} already present in B2B"
                )
                is_amendment = True
            elif g.sheet_name == "B2B-CDNRA" and g.normalized_doc_no in cdnr_orig_nos:
                sec_remarks.append(
                    f"Amendment entry in B2B-CDNRA — original note {g.doc_no} already present in B2B-CDNR"
                )
                is_amendment = True
            elif g.sheet_name == "B2B" and g.normalized_doc_no in b2ba_nos:
                sec_remarks.append(
                    f"Original invoice {g.doc_no} amended in B2BA — amendment entry also present in 2B"
                )
                is_amendment = True
            elif g.sheet_name == "B2B-CDNR" and g.normalized_doc_no in cdnra_nos:
                sec_remarks.append(
                    f"Original note {g.doc_no} amended in B2B-CDNRA — amendment entry also present in 2B"
                )
                is_amendment = True

            if not is_amendment:
                if g_dup_type == "dup":
                    sec_remarks.append("Invoice appears twice in GSTR-2B — possible duplicate upload by vendor")
                elif g_dup_type == "same_no_diff_party":
                    sec_remarks.append("Same invoice number in GSTR-2B for different parties — verify")
                elif g_dup_type == "cross_ref":
                    sec_remarks.append("Same invoice number also exists as Credit Note in GSTR-2B")

            r.suggested_action_2 = ", ".join(sec_remarks) if sec_remarks else ""

        # Scenario C: In Books but NOT in GSTR-2B
        elif b and not g:
            r.suggested_action = "Showing in Books but Not in 2B"

            sec_remarks_c = []
            # Flag the same Books data-entry error on rows that stay unmatched — a bad
            # GSTIN is often WHY the row never found its GSTR-2B counterpart.
            _bad_gstin_c = (_get_val(b, "raw", {}) or {}).get("_bad_gstin") or ""
            if _bad_gstin_c:
                sec_remarks_c.append(
                    f"Books GSTIN column contains '{_bad_gstin_c}' — not a valid GSTIN "
                    f"(an invoice/voucher number appears to have been entered in the GSTIN "
                    f"field); ignored for matching — correct it in Books"
                )
            if b_dup_type == "dup":
                sec_remarks_c.append("Invoice appears twice in Books — verify if duplicate booking")
            elif b_dup_type == "same_no_diff_party":
                sec_remarks_c.append("Same voucher number in Books for different parties — verify")
            elif b_dup_type == "cross_ref":
                sec_remarks_c.append("Invoice also referenced in DN Register")
            r.suggested_action_2 = ", ".join(sec_remarks_c) if sec_remarks_c else ""

    return results


# ---------------------------------------------------------------------------
# Excel export in SOP format
# ---------------------------------------------------------------------------

def _get_val(obj: Any, key: str, default: Any = "") -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _populate_workbook(ws, results: list[Any]) -> None:
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    # Styles
    header_font = Font(bold=True, size=10)
    section_font = Font(bold=True, size=11)
    center = Alignment(horizontal="center", vertical="center")
    thin = Side(style="thin")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    fill_2b = PatternFill("solid", fgColor="DCE6F1")    # light blue
    fill_books = PatternFill("solid", fgColor="E2EFDA")  # light green
    fill_diff = PatternFill("solid", fgColor="FCE4D6")   # light orange
    fill_matched = PatternFill("solid", fgColor="E2EFDA")
    fill_only_2b = PatternFill("solid", fgColor="FFF2CC")
    fill_only_books = PatternFill("solid", fgColor="FCE4D6")
    fill_mismatch = PatternFill("solid", fgColor="F4B942")
    fill_partial  = PatternFill("solid", fgColor="D6EAF8")  # light blue — CN↔DN partial match

    # Scan for dup types: "dup" (same sign), "cross_ref" (opposite signs), "" (unique)
    def _wb_dup_type(vals: list) -> str:
        if len(vals) <= 1:
            return ""
        return "dup" if (all(v >= 0 for v in vals) or all(v <= 0 for v in vals)) else "cross_ref"

    gstr2b_doc_vals_wb: dict = {}
    books_doc_vals_wb: dict = {}
    for r in results:
        g = _get_val(r, "gstr2b", None)
        b = _get_val(r, "purchase", None)
        g_doc = str(_get_val(g, "doc_no", "")).strip().upper()
        b_doc = str(_get_val(b, "doc_no", "")).strip().upper()
        if g_doc and g_doc not in ("NAN", ""):
            gstr2b_doc_vals_wb.setdefault(g_doc, []).append(float(_get_val(g, "taxable_value", 0) or 0))
        if b_doc and b_doc not in ("NAN", ""):
            books_doc_vals_wb.setdefault(b_doc, []).append(float(_get_val(b, "taxable_value", 0) or 0))

    gstr2b_doc_dup_type = {d: _wb_dup_type(v) for d, v in gstr2b_doc_vals_wb.items()}
    books_doc_dup_type  = {d: _wb_dup_type(v) for d, v in books_doc_vals_wb.items()}

    fill_duplicate  = PatternFill("solid", fgColor="FFC7CE")  # soft red   — true duplicate
    font_duplicate  = Font(color="9C0006", bold=True)         # dark red bold
    fill_cross_ref  = PatternFill("solid", fgColor="FFE0B2")  # soft orange — cross-reference
    font_cross_ref  = Font(color="E65100", bold=True)         # dark orange bold

    col_headers = [
        # GSTR-2B (cols A-J)
        "Party Name (GSTR-2B)", "GSTIN (2B)", "Invoice Number", "Invoice Date",
        "Taxable Value (₹)", "Central Tax (₹)", "State/UT Tax (₹)", "Integrated Tax (₹)",
        "Source Tab (2B)", "State (2B)",
        "",  # spacer col K
        # Books (cols L-U)
        "Particulars", "GSTIN (Books)", "Voucher No.", "Date",
        "Taxable Value (₹)", "Central Tax (₹)", "State/UT Tax (₹)", "Integrated Tax (₹)",
        "Source (Books)", "State (Books)",
        "",  # spacer col V
        # Difference (cols W-Z)
        "Taxable Value (₹)", "Central Tax (₹)", "State/UT Tax (₹)", "Integrated Tax (₹)",
        "Remark 1",   # col AA (27)
        "Remark 2",   # col AB (28)
    ]

    # Row 1: blank
    ws.append([""])

    # Row 2: section headers
    ws.append([
        "As Per GSTR 2B Data", "", "", "", "", "", "", "", "", "",
        "",
        "As Per Books Data", "", "", "", "", "", "", "", "", "",
        "",
        "Difference", "", "", "",
        "", "",
    ])
    ws.merge_cells("A2:J2")
    ws.merge_cells("L2:U2")
    ws.merge_cells("W2:Z2")
    for cell_addr in ["A2", "L2", "W2"]:
        c = ws[cell_addr]
        c.font = section_font
        c.alignment = center
    ws["A2"].fill = fill_2b
    ws["L2"].fill = fill_books
    ws["W2"].fill = fill_diff

    # Row 3: column headers
    ws.append(col_headers)
    for col_idx, _ in enumerate(col_headers, start=1):
        c = ws.cell(row=3, column=col_idx)
        c.font = header_font
        c.alignment = center
        c.border = border
        if col_idx in range(1, 11):       # A-J: 2B section
            c.fill = fill_2b
        elif col_idx in range(12, 22):    # L-U: Books section
            c.fill = fill_books
        elif col_idx in range(23, 29):    # W-Z + AA-AB: Diff + Remarks
            c.fill = fill_diff

    # Data rows
    for result in results:
        g = _get_val(result, "gstr2b", None)
        b = _get_val(result, "purchase", None)
        category = _get_val(result, "category", "")

        # Determine remarks
        remark_1 = _get_val(result, "suggested_action", "")
        remark_2 = _get_val(result, "suggested_action_2", "")

        g_taxable = _get_val(g, "taxable_value", 0)
        g_cgst    = _get_val(g, "cgst", 0)
        g_sgst    = _get_val(g, "sgst", 0)
        g_igst    = _get_val(g, "igst", 0)
        b_taxable = _get_val(b, "taxable_value", 0)
        b_cgst    = _get_val(b, "cgst", 0)
        b_sgst    = _get_val(b, "sgst", 0)
        b_igst    = _get_val(b, "igst", 0)

        diff_taxable = round(g_taxable - b_taxable, 2)
        diff_cgst    = round(g_cgst    - b_cgst,    2)
        diff_sgst    = round(g_sgst    - b_sgst,    2)
        diff_igst    = round(g_igst    - b_igst,    2)

        # New: GSTIN, Source Tab, State for 2B
        gstin_2b   = str(_get_val(g, "supplier_gstin", "") or "") or str(_get_val(b, "supplier_gstin", "") or "")
        source_tab = str(_get_val(g, "sheet_name",     "") or "")
        raw_g      = _get_val(g, "raw", {}) or {}
        entity_g   = str(raw_g.get("_entity_gstin", "") or "")
        state_2b   = GST_STATE_CODES.get(entity_g[:2], "") if entity_g else ""

        # New: GSTIN, Source, State for Books
        # Tally has no GSTIN column — use enriched value, fall back to 2B GSTIN for matched rows
        gstin_bks    = str(_get_val(b, "supplier_gstin", "") or "") or str(_get_val(g, "supplier_gstin", "") or "")
        src_bks_full = str(_get_val(b, "source",          "") or "")
        source_bks   = "PR" if "Purchase" in src_bks_full else ("DN" if "Debit" in src_bks_full else "")
        raw_b        = _get_val(b, "raw", {}) or {}
        entity_b     = str(raw_b.get("_entity_gstin", "") or "")
        state_bks    = GST_STATE_CODES.get(entity_b[:2], "") if entity_b else ""

        row = [
            _get_val(g, "supplier_name", ""),
            gstin_2b,
            _get_val(g, "doc_no", ""),
            _get_val(g, "doc_date", ""),
            g_taxable, g_cgst, g_sgst, g_igst,
            source_tab, state_2b,
            "",  # spacer K
            _get_val(b, "supplier_name", ""),
            gstin_bks,
            _get_val(b, "doc_no", ""),
            _get_val(b, "doc_date", ""),
            b_taxable, b_cgst, b_sgst, b_igst,
            source_bks, state_bks,
            "",  # spacer V
            diff_taxable, diff_cgst, diff_sgst, diff_igst,
            remark_1,
            remark_2,
        ]
        ws.append(row)

        # Row fill based on category
        row_idx = ws.max_row
        if category == "Matched":
            fill = fill_matched
        elif category == "Partially Matched":
            fill = fill_partial
        elif category == "Amount Mismatch":
            fill = fill_mismatch
        elif category == "In GSTR-2B not in Books" or category == "In GSTR-2B not in PR":
            fill = fill_only_2b
        else:
            fill = fill_only_books

        for col_idx in range(1, len(col_headers) + 1):
            c = ws.cell(row=row_idx, column=col_idx)
            if c.value != "" and col_idx != 11 and col_idx != 22:  # spacers K(11) and V(22)
                c.fill = fill
            c.border = border

        # Books Taxable (col P = 16): when the value was DERIVED (no source Value
        # column), replace the static number with a live Excel formula summing the
        # expense heads + a hover comment naming each head, so it's auditable.
        raw_b_disp = _get_val(b, "raw", {}) or {}
        if raw_b_disp.get("_taxable_derived") and raw_b_disp.get("_taxable_breakdown"):
            from openpyxl.comments import Comment
            breakdown = raw_b_disp["_taxable_breakdown"]
            note = " + ".join(f"{head} {amt:,.2f}" for head, amt in breakdown)
            # Keep the NUMERIC taxable already written by ws.append — an Excel formula
            # here renders blank/0 in viewers that don't auto-recalc (e.g. Numbers),
            # which made the whole column look empty. Show the make-up as a comment.
            ws.cell(row=row_idx, column=16).comment = Comment(f"= {note}", "Colonel")

        # Highlight GSTR-2B duplicates/cross-refs — Invoice Number is now col C (3)
        g_doc = str(_get_val(g, "doc_no", "")).strip().upper()
        g_dt = gstr2b_doc_dup_type.get(g_doc, "")
        if g_doc and g_doc not in ("NAN", "") and g_dt:
            cell_g = ws.cell(row=row_idx, column=3)
            if g_dt == "dup":
                cell_g.fill = fill_duplicate
                cell_g.font = font_duplicate
            else:
                cell_g.fill = fill_cross_ref
                cell_g.font = font_cross_ref

        # Highlight Books duplicates/cross-refs — Voucher No. is now col N (14)
        b_doc = str(_get_val(b, "doc_no", "")).strip().upper()
        b_dt = books_doc_dup_type.get(b_doc, "")
        if b_doc and b_doc not in ("NAN", "") and b_dt:
            cell_b = ws.cell(row=row_idx, column=14)
            if b_dt == "dup":
                cell_b.fill = fill_duplicate
                cell_b.font = font_duplicate
            else:
                cell_b.fill = fill_cross_ref
                cell_b.font = font_cross_ref

    # Column widths
    # A-J (2B): name, gstin, inv_no, date, taxable, cgst, sgst, igst, source_tab, state
    # K: spacer
    # L-U (Books): name, gstin, voucher, date, taxable, cgst, sgst, igst, source, state
    # V: spacer
    # W-Z (Diff) + AA-AB (Remarks)
    widths = [
        30, 20, 20, 14, 16, 14, 14, 16, 12, 14,   # A-J
        2,                                          # K spacer
        30, 20, 20, 14, 16, 14, 14, 16,  6, 14,   # L-U
        2,                                          # V spacer
        16, 14, 14, 16, 22, 22,                     # W-Z + AA-AB
    ]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w

    ws.freeze_panes = "A4"


def _fix_company_name(raw: str) -> str:
    """Title-case a vendor name and restore common Indian company abbreviations."""
    if not raw:
        return raw
    result = raw.title()
    for wrong, right in [
        ("Llp", "LLP"), ("Llc", "LLC"), (" Lp ", " LP "),
        ("Pvt.Ltd.", "Pvt Ltd"), ("Pvt.Ltd", "Pvt Ltd"), ("P.Ltd.", "P Ltd"),
        ("Ltd.", "Ltd"), (" Of ", " of "), (" And ", " and "),
        (" The ", " the "), (" A ", " a "), (" An ", " an "),
        (" For ", " for "), ("Isd", "ISD"), ("Gst", "GST"),
    ]:
        result = result.replace(wrong, right)
    return result


def _build_vendor_summary_sheet(ws, results: list[Any]) -> None:
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    thin        = Side(style="thin")
    border      = Border(left=thin, right=thin, top=thin, bottom=thin)
    center      = Alignment(horizontal="center", vertical="center")
    right_align = Alignment(horizontal="right",  vertical="center")

    title_fill   = PatternFill("solid", fgColor="1F3864")
    title_font   = Font(bold=True, size=12, color="FFFFFF")
    section_font = Font(bold=True, size=11)
    header_font  = Font(bold=True, size=10)

    fill_2b          = PatternFill("solid", fgColor="DCE6F1")
    fill_books_hdr   = PatternFill("solid", fgColor="E2EFDA")
    fill_diff_hdr    = PatternFill("solid", fgColor="FCE4D6")
    fill_matched     = PatternFill("solid", fgColor="E2EFDA")
    fill_mismatch    = PatternFill("solid", fgColor="F4B942")
    fill_only_2b     = PatternFill("solid", fgColor="FFF2CC")
    fill_only_books  = PatternFill("solid", fgColor="FCE4D6")

    TOL     = 1.0
    NUM_COLS = 20
    # Column index map (1-based):
    # A=1 Common Name, B=2 GSTIN
    # C=3 Name 2B, D=4 Taxable 2B, E=5 CGST 2B, F=6 SGST 2B, G=7 IGST 2B
    # H=8 spacer
    # I=9 Name Books, J=10 Taxable Books, K=11 CGST Books, L=12 SGST Books, M=13 IGST Books
    # N=14 spacer
    # O=15 Diff Taxable, P=16 Diff CGST, Q=17 Diff SGST, R=18 Diff IGST
    # S=19 Remark 1, T=20 Remark 2
    SPACERS      = {8, 14}
    NUMERIC_COLS = set(range(4, 8)) | set(range(10, 14)) | set(range(15, 19))

    # ── Step 0: build name→GSTIN lookup from all GSTR-2B records ────────────
    # Uses _extract_gstin() which scans the raw row dict for the GSTIN pattern,
    # so it works even when supplier_gstin wasn't set by the column-name lookup.
    name_to_gstin_map: dict[str, str] = {}
    for _r in results:
        _g = _get_val(_r, "gstr2b", None)
        if _g:
            _gstin = _extract_gstin(_g)
            _name  = str(_get_val(_g, "supplier_name", "") or "").strip().lower()
            if _gstin and _name and _name not in name_to_gstin_map:
                name_to_gstin_map[_name] = _gstin

    # ── Step 1: aggregate by GSTIN ───────────────────────────────────────────
    vendor_groups: dict[str, dict] = {}

    for r in results:
        g = _get_val(r, "gstr2b",    None)
        b = _get_val(r, "purchase",  None)

        # Use _extract_gstin: checks supplier_gstin attr first, then scans raw dict
        gstin = _extract_gstin(g) if g else ""
        if not gstin and b:
            gstin = _extract_gstin(b)

        # If GSTIN still missing, look it up by supplier name from 2B records
        if not gstin:
            _g_name = str(_get_val(g, "supplier_name", "") or "").strip().lower() if g else ""
            _b_name = str(_get_val(b, "supplier_name", "") or "").strip().lower() if b else ""
            gstin = name_to_gstin_map.get(_g_name, "") or name_to_gstin_map.get(_b_name, "")

        fallback_key = ""
        if not gstin:
            if g:
                fallback_key = str(_get_val(g, "supplier_name", "") or "").strip().upper()
            if not fallback_key and b:
                fallback_key = str(_get_val(b, "supplier_name", "") or "").strip().upper()
            if not fallback_key:
                continue

        group_key = gstin if gstin else f"__name__{fallback_key}"

        if group_key not in vendor_groups:
            vendor_groups[group_key] = {
                "gstin":         gstin,
                "name_2b":       "",    "name_books":    "",
                "taxable_2b":    0.0,   "taxable_books": 0.0,
                "cgst_2b":       0.0,   "cgst_books":    0.0,
                "sgst_2b":       0.0,   "sgst_books":    0.0,
                "igst_2b":       0.0,   "igst_books":    0.0,
                "has_2b":        False, "has_books":     False,
                "sec_tags":      set(),
            }
        else:
            # If this group was created earlier with an empty GSTIN (name-based key)
            # but we now have a GSTIN, upgrade it.
            if gstin and not vendor_groups[group_key]["gstin"]:
                vendor_groups[group_key]["gstin"] = gstin

        vg = vendor_groups[group_key]

        try:
            if g:
                n = str(_get_val(g, "supplier_name", "") or "").strip()
                if n and not vg["name_2b"]:
                    vg["name_2b"] = n
                vg["taxable_2b"] += float(_get_val(g, "taxable_value", 0) or 0)
                vg["cgst_2b"]    += float(_get_val(g, "cgst",          0) or 0)
                vg["sgst_2b"]    += float(_get_val(g, "sgst",          0) or 0)
                vg["igst_2b"]    += float(_get_val(g, "igst",          0) or 0)
                vg["has_2b"]      = True

            if b:
                n = str(_get_val(b, "supplier_name", "") or "").strip()
                if n and not vg["name_books"]:
                    vg["name_books"] = n
                vg["taxable_books"] += float(_get_val(b, "taxable_value", 0) or 0)
                vg["cgst_books"]    += float(_get_val(b, "cgst",          0) or 0)
                vg["sgst_books"]    += float(_get_val(b, "sgst",          0) or 0)
                vg["igst_books"]    += float(_get_val(b, "igst",          0) or 0)
                vg["has_books"]      = True

            r2_str = str(_get_val(r, "suggested_action_2", "") or "").strip()
            for tag in r2_str.split(","):
                tag = tag.strip()
                if tag:
                    vg["sec_tags"].add(tag)
        except Exception as _agg_err:
            print(f"Vendor Summary aggregation error for {group_key}: {_agg_err}")

    # ── Step 2: build sorted row lists ──────────────────────────────────────
    def _fmt(val, present):
        return round(val, 2) if present else ""

    def _common_name(vg):
        # Prefer Books name (Tally exports are already properly cased)
        base = vg["name_books"] if vg["name_books"] else _fix_company_name(vg["name_2b"])
        gstin = vg["gstin"]
        if gstin and len(gstin) >= 2:
            state = GST_STATE_CODES.get(gstin[:2], "")
            if state:
                base = f"{base} ({state})"
        return base

    matched_rows    = []
    only_2b_rows    = []
    only_books_rows = []
    no_gstin_rows   = []

    for group_key, vg in vendor_groups.items():
        has_2b    = vg["has_2b"]
        has_books = vg["has_books"]
        gstin     = vg["gstin"]
        both      = has_2b and has_books

        # Remark 2 — compute mismatches first so Remark 1 can reflect them
        sec = []
        if both:
            tax_2b    = round(vg["igst_2b"]   + vg["cgst_2b"]    + vg["sgst_2b"],    2)
            tax_books = round(vg["igst_books"] + vg["cgst_books"] + vg["sgst_books"], 2)
            if   tax_2b    - tax_books  > TOL:
                sec.append("Tax Amount Mismatch, Excess in 2B")
            elif tax_books - tax_2b     > TOL:
                sec.append("Tax Amount Mismatch, Excess in Books")
            tv_diff = round(vg["taxable_2b"] - vg["taxable_books"], 2)
            if   tv_diff  > TOL:
                sec.append("Taxable Value Mismatch, Excess in 2B")
            elif -tv_diff > TOL:
                sec.append("Taxable Value Mismatch, Excess in Books")
        else:
            for tag in sorted(vg["sec_tags"]):
                if "rcm" in tag.lower() or "duplicate" in tag.lower():
                    sec.append(tag)

        # Remark 1 — reflects actual match quality at vendor level
        if both and sec:
            remark_1 = "Amount Mismatch"
        elif both:
            remark_1 = "Matched"
        elif has_2b:
            remark_1 = "Showing in 2B but Not in Books"
        else:
            remark_1 = "Showing in Books but Not in 2B"

        rd = {
            "common_name":   _common_name(vg),
            "gstin":         gstin,
            "name_2b":       vg["name_2b"],
            "taxable_2b":    _fmt(vg["taxable_2b"],    has_2b),
            "cgst_2b":       _fmt(vg["cgst_2b"],       has_2b),
            "sgst_2b":       _fmt(vg["sgst_2b"],       has_2b),
            "igst_2b":       _fmt(vg["igst_2b"],       has_2b),
            "name_books":    vg["name_books"],
            "taxable_books": _fmt(vg["taxable_books"], has_books),
            "cgst_books":    _fmt(vg["cgst_books"],    has_books),
            "sgst_books":    _fmt(vg["sgst_books"],    has_books),
            "igst_books":    _fmt(vg["igst_books"],    has_books),
            "diff_taxable":  _fmt(round(vg["taxable_2b"] - vg["taxable_books"], 2), both),
            "diff_cgst":     _fmt(round(vg["cgst_2b"]    - vg["cgst_books"],    2), both),
            "diff_sgst":     _fmt(round(vg["sgst_2b"]    - vg["sgst_books"],    2), both),
            "diff_igst":     _fmt(round(vg["igst_2b"]    - vg["igst_books"],    2), both),
            "remark_1":      remark_1,
            "remark_2":      ", ".join(sec),
        }

        if remark_1 in ("Matched", "Amount Mismatch"):
            matched_rows.append(rd)
        elif remark_1 == "Showing in 2B but Not in Books":
            only_2b_rows.append(rd)
        elif remark_1 == "Showing in Books but Not in 2B":
            only_books_rows.append(rd)
        else:
            no_gstin_rows.append(rd)

    for grp in (matched_rows, only_2b_rows, only_books_rows, no_gstin_rows):
        grp.sort(key=lambda x: x["common_name"].lower())

    all_rows = matched_rows + only_2b_rows + only_books_rows + no_gstin_rows

    # ── Step 3: write worksheet ───────────────────────────────────────────────

    # Row 1: title
    ws.append(["DETAILED PARTY NAME MAPPING"] + [""] * (NUM_COLS - 1))
    ws.merge_cells(f"A1:{get_column_letter(NUM_COLS)}1")
    tc = ws["A1"]
    tc.fill      = title_fill
    tc.font      = title_font
    tc.alignment = center
    ws.row_dimensions[1].height = 28

    # Row 2: section headers
    ws.append([
        "", "",
        "As Per GSTR 2B Data", "", "", "", "",
        "",
        "As Per Books Data", "", "", "", "",
        "",
        "Difference", "", "", "",
        "", "",
    ])
    ws.merge_cells("C2:G2")
    ws.merge_cells("I2:M2")
    ws.merge_cells("O2:R2")
    for addr, fill in [("C2", fill_2b), ("I2", fill_books_hdr), ("O2", fill_diff_hdr)]:
        c = ws[addr]
        c.font      = section_font
        c.alignment = center
        c.fill      = fill
    ws.row_dimensions[2].height = 18

    # Row 3: column headers
    ws.append([
        "Common Name", "GSTIN",
        "Name as per 2B",    "Taxable Value (₹)", "CGST (₹)", "SGST (₹)", "IGST (₹)",
        "",
        "Name as per Books", "Taxable Value (₹)", "CGST (₹)", "SGST (₹)", "IGST (₹)",
        "",
        "Taxable Value (₹)", "CGST (₹)", "SGST (₹)", "IGST (₹)",
        "Remark 1", "Remark 2",
    ])
    for col_idx in range(1, NUM_COLS + 1):
        c = ws.cell(row=3, column=col_idx)
        c.font      = header_font
        c.alignment = center
        c.border    = border
        if   col_idx in range(3, 8):
            c.fill = fill_2b
        elif col_idx in range(9, 14):
            c.fill = fill_books_hdr
        elif col_idx in range(15, 19):
            c.fill = fill_diff_hdr
    ws.row_dimensions[3].height = 18

    # Data rows
    for rd in all_rows:
        ws.append([
            rd["common_name"],   rd["gstin"],
            rd["name_2b"],       rd["taxable_2b"],   rd["cgst_2b"],    rd["sgst_2b"],   rd["igst_2b"],
            "",
            rd["name_books"],    rd["taxable_books"], rd["cgst_books"], rd["sgst_books"],rd["igst_books"],
            "",
            rd["diff_taxable"],  rd["diff_cgst"],     rd["diff_sgst"],  rd["diff_igst"],
            rd["remark_1"],      rd["remark_2"],
        ])
        row_idx = ws.max_row

        r1 = rd["remark_1"]
        if r1 == "Matched":
            fill = fill_matched
        elif r1 == "Amount Mismatch":
            fill = fill_mismatch
        elif r1 == "Showing in 2B but Not in Books":
            fill = fill_only_2b
        else:
            fill = fill_only_books

        for col_idx in range(1, NUM_COLS + 1):
            c = ws.cell(row=row_idx, column=col_idx)
            if c.value != "" and col_idx not in SPACERS:
                c.fill = fill
            c.border = border
            if col_idx in NUMERIC_COLS:
                c.alignment = right_align

    # Column widths: A B | C D E F G | (H) | I J K L M | (N) | O P Q R | S T
    for i, w in enumerate(
        [35, 20,  35, 14, 12, 12, 12,  2,  35, 14, 12, 12, 12,  2,  14, 12, 12, 12,  32, 42], 1
    ):
        ws.column_dimensions[get_column_letter(i)].width = w

    ws.freeze_panes = "A4"


def build_excel_output(
    results: list[MatchResult],
    output_path: str | None = None,
) -> bytes:
    import openpyxl
    from io import BytesIO as BIO

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Reco 2B vs Books"
    _populate_workbook(ws, results)

    bio = BIO()
    wb.save(bio)
    bio.seek(0)
    return bio.read()


def _copy_workbook_sheets(src_bytes: bytes, target_wb: Any, title_prefix: str) -> None:
    src_bytes = _ensure_xlsx(src_bytes)
    import openpyxl
    from io import BytesIO
    import copy
    # OCTA 2B exports carry their data on one flat sheet (e.g. "Purchase"), not the
    # portal B2B/B2BA/CDNR tabs — copy that sheet as-is instead of filtering it out.
    octa_sheet = _find_octa_sheet_name(src_bytes) if title_prefix == "2B" else None
    try:
        src_wb = openpyxl.load_workbook(BytesIO(src_bytes), data_only=True)
        for name in src_wb.sheetnames:
            # ONLY copy the allowed 2B sheets (case-insensitive checking) if prefix is 2B
            if title_prefix == "2B":
                if octa_sheet is not None:
                    # OCTA: copy only the data sheet. Newer exports also ship an
                    # "Overview" cover sheet and an "ISD" sheet, which are not 2B
                    # invoice data and must not become source tabs.
                    if name != octa_sheet:
                        continue
                else:
                    # Portal tabs plus the IMS note tabs. IMS also ships two summary
                    # dashboards ("All other ITC", "Import of Goods") that hold record
                    # counts rather than invoices — excluded, like OCTA's Overview/ISD.
                    name_clean = str(name).strip().upper()
                    allowed_clean = {s.upper() for s in ALLOWED_SHEETS | IMS_SHEETS}
                    if name_clean not in allowed_clean:
                        continue

            src_sheet = src_wb[name]
            # Ensure unique and beautiful sheet title
            # Max sheet title length in Excel is 31 characters
            prefix = f"{title_prefix} - "
            max_name_len = 31 - len(prefix)
            short_name = name[:max_name_len]
            tgt_title = f"{prefix}{short_name}"
            
            # Avoid duplicate sheet titles
            base_title = tgt_title
            counter = 1
            while tgt_title in target_wb.sheetnames:
                suffix = f"_{counter}"
                tgt_title = base_title[:31 - len(suffix)] + suffix
                counter += 1
                
            tgt_sheet = target_wb.create_sheet(title=tgt_title)
            
            # Copy merged cell ranges
            for merged_range in src_sheet.merged_cells.ranges:
                tgt_sheet.merge_cells(str(merged_range))
                
            # Copy dimensions (row heights)
            for r_idx in src_sheet.row_dimensions:
                tgt_sheet.row_dimensions[r_idx].height = src_sheet.row_dimensions[r_idx].height
                
            # Copy dimensions (column widths)
            for col_letter in src_sheet.column_dimensions:
                tgt_sheet.column_dimensions[col_letter].width = src_sheet.column_dimensions[col_letter].width
                
            # Copy cell values and styles
            for r in range(1, src_sheet.max_row + 1):
                for c in range(1, src_sheet.max_column + 1):
                    cell = src_sheet.cell(row=r, column=c)
                    tgt_cell = tgt_sheet.cell(row=r, column=c, value=cell.value)
                    if cell.has_style:
                        tgt_cell.font = copy.copy(cell.font)
                        tgt_cell.fill = copy.copy(cell.fill)
                        tgt_cell.alignment = copy.copy(cell.alignment)
                        tgt_cell.border = copy.copy(cell.border)
                        tgt_cell.number_format = cell.number_format
    except Exception as e:
        print(f"Error copying sheets for prefix {title_prefix}: {e}")


#: Remark wording — kept here so the sheet and any future summary agree.
AUDIT_OK      = "Books and Tool amount match"
AUDIT_MISSED  = "Missed — not picked up by the tool"
AUDIT_DIFF    = "Amount differs — Books vs Tool"


def append_books_audit_columns(wb: Any, src_bytes: bytes, book_records: list[Any],
                               sheet_title: str, default_type: str,
                               file_idx: int = 0) -> int:
    """Append the accountant's check-point columns to a copied register sheet.

    The output already reproduces the register the accountant uploaded; this writes
    four figure columns plus a remark to the RIGHT of it, so the real invoice row and
    what the tool took from it sit side by side and can be scanned by colour instead
    of cross-checked by hand.

      Taxable Value / IGST / CGST / SGST  — as the tool recorded them
      Remark  — green  the tool's figures equal an independent re-reading of the row
                red    the row is in the register but the tool produced NO record
                yellow the tool recorded the row but the figures differ

    Rows the parser deliberately ignores (no Date — Tally's grand total, blanks) are
    left blank, never red: flagging those would put a false alarm at the foot of
    every register and cost exactly the trust this is meant to build.

    Returns the number of rows flagged red or yellow."""
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    ws = wb[sheet_title] if sheet_title in wb.sheetnames else None
    if ws is None:
        return 0
    try:
        rows = _read_tally_sheet(_ensure_xlsx(src_bytes))
    except Exception:
        return 0
    if not rows:
        return 0

    # The copier reproduces the register cell for cell, so a row's pandas index maps
    # to the same Excel row (+1). The header sits directly above the first data row.
    # Records reach here as dataclasses on one path and plain dicts on another —
    # _get_val reads both.
    #
    # The row index alone is NOT unique: in a multi-state run each register is parsed
    # separately and they all start numbering near row 5, so keying on it alone made
    # state 1's rows look up state 2's records and report false differences. The
    # multi-state parser tags every record with _file_idx, so match on the pair.
    want_sheet = sheet_title.split(" - ")[-1]
    stored = {}
    for r in book_records:
        raw = _get_val(r, "raw", {}) or {}
        if raw.get("_src_sheet") != want_sheet or raw.get("_src_row") is None:
            continue
        if int(raw.get("_file_idx", 0) or 0) != file_idx:
            continue
        stored[raw["_src_row"]] = r
    first_data = min(r["_src_row"] for r in rows)
    header_xl = first_data                      # Excel row of the header
    start_col = ws.max_column + 2               # leave one blank spacer column

    GREEN  = PatternFill("solid", fgColor="D5F5E3")
    RED    = PatternFill("solid", fgColor="F9C9C4")
    YELLOW = PatternFill("solid", fgColor="FDEBD0")
    HDR    = PatternFill("solid", fgColor="1F4E78")
    thin   = Side(style="thin", color="B0B0B0")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    titles = ["Taxable Value (Tool)", "IGST (Tool)", "CGST (Tool)", "SGST (Tool)", "Check"]
    band = ws.cell(row=max(header_xl - 1, 1), column=start_col,
                   value="Tool Check-Point (for verification)")
    band.font = Font(bold=True, color="FFFFFF", size=10)
    band.fill = HDR
    band.alignment = Alignment(horizontal="center")
    try:
        ws.merge_cells(start_row=max(header_xl - 1, 1), start_column=start_col,
                       end_row=max(header_xl - 1, 1), end_column=start_col + 4)
    except Exception:
        pass
    for i, t in enumerate(titles):
        c = ws.cell(row=header_xl, column=start_col + i, value=t)
        c.font = Font(bold=True, color="FFFFFF", size=9)
        c.fill = HDR
        c.alignment = Alignment(horizontal="center", wrap_text=True)
        c.border = border

    flagged = 0
    for row in rows:
        xl = row["_src_row"] + 1
        rec = stored.get(row["_src_row"])
        # Deliberately-skipped row (no Date): leave the strip blank.
        date_raw = str(row.get("Date", "") or "").strip()
        if not date_raw or date_raw == "nan":
            continue

        if rec is None:
            ws.cell(row=xl, column=start_col + 4, value=AUDIT_MISSED)
            for i in range(5):
                cc = ws.cell(row=xl, column=start_col + i)
                cc.fill = RED
                cc.border = border
            flagged += 1
            continue

        derived = audit_row_figures(row, default_type)
        vals = [float(_get_val(rec, "taxable_value", 0) or 0), float(_get_val(rec, "igst", 0) or 0),
                float(_get_val(rec, "cgst", 0) or 0), float(_get_val(rec, "sgst", 0) or 0)]
        same = all(abs(a - b) <= 0.01 for a, b in zip(
            vals, [derived["taxable_value"], derived["igst"], derived["cgst"], derived["sgst"]]))
        for i, v in enumerate(vals):
            cc = ws.cell(row=xl, column=start_col + i, value=round(v, 2))
            cc.number_format = "#,##0.00"
            cc.fill = GREEN if same else YELLOW
            cc.border = border
        rc = ws.cell(row=xl, column=start_col + 4,
                     value=AUDIT_OK if same else
                     f"{AUDIT_DIFF}: register {derived['taxable_value']:,.2f} vs tool {vals[0]:,.2f}")
        rc.fill = GREEN if same else YELLOW
        rc.border = border
        if not same:
            flagged += 1

    for i, w in enumerate([16, 13, 13, 13, 46]):
        ws.column_dimensions[get_column_letter(start_col + i)].width = w
    return flagged


def _build_month_summary_sheet(wb: Any, results: list[Any]) -> None:
    """Add a 'Month Summary' sheet when results span ≥ 2 distinct invoice months.
    Groups by YYYY-MM (preferring 2B date, falling back to Books date).
    Columns: Month | 2B Taxable/IGST/CGST/SGST | Books Taxable/IGST/CGST/SGST |
             Diff Taxable/IGST | Matched | 2B Only | Books Only"""
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from collections import defaultdict

    month_data: dict = defaultdict(lambda: {
        "taxable_2b": 0.0, "igst_2b": 0.0, "cgst_2b": 0.0, "sgst_2b": 0.0,
        "taxable_bk": 0.0, "igst_bk": 0.0, "cgst_bk": 0.0, "sgst_bk": 0.0,
        "matched": 0, "only_2b": 0, "only_bk": 0,
    })

    for r in results:
        g = _get_val(r, "gstr2b",   None)
        b = _get_val(r, "purchase", None)
        g_date = str(_get_val(g, "doc_date", "") or "") if g else ""
        b_date = str(_get_val(b, "doc_date", "") or "") if b else ""
        month  = (g_date or b_date)[:7]   # "YYYY-MM" or ""
        if not month or len(month) < 7:
            month = "Unknown"
        else:
            try:
                yr, mn = int(month[:4]), int(month[5:7])
                if not (2000 <= yr <= 2099) or not (1 <= mn <= 12):
                    month = "Unknown"
            except (ValueError, IndexError):
                month = "Unknown"

        md = month_data[month]
        if g:
            md["taxable_2b"] += float(_get_val(g, "taxable_value", 0) or 0)
            md["igst_2b"]    += float(_get_val(g, "igst",          0) or 0)
            md["cgst_2b"]    += float(_get_val(g, "cgst",          0) or 0)
            md["sgst_2b"]    += float(_get_val(g, "sgst",          0) or 0)
        if b:
            md["taxable_bk"] += float(_get_val(b, "taxable_value", 0) or 0)
            md["igst_bk"]    += float(_get_val(b, "igst",          0) or 0)
            md["cgst_bk"]    += float(_get_val(b, "cgst",          0) or 0)
            md["sgst_bk"]    += float(_get_val(b, "sgst",          0) or 0)

        status = str(_get_val(r, "suggested_action", "") or "")
        if "Not in Books" in status:
            md["only_2b"] += 1
        elif "Not in 2B" in status:
            md["only_bk"] += 1
        else:
            md["matched"] += 1

    # Only add sheet when spanning ≥ 2 months
    real_months = [m for m in month_data if m != "Unknown"]
    if len(real_months) < 2:
        return

    thin   = Side(style="thin")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal="center", vertical="center")
    right  = Alignment(horizontal="right",  vertical="center")

    fill_hdr   = PatternFill("solid", fgColor="1F3864")
    fill_total = PatternFill("solid", fgColor="D9E1F2")
    fill_alt   = PatternFill("solid", fgColor="F2F2F2")
    font_hdr   = Font(bold=True, color="FFFFFF", size=10)
    font_total = Font(bold=True, size=10)
    num_fmt    = "#,##0.00"
    int_fmt    = "#,##0"

    ws = wb.create_sheet(title="Month Summary")

    headers = [
        "Month",
        "2B Taxable", "2B IGST", "2B CGST", "2B SGST",
        "Books Taxable", "Books IGST", "Books CGST", "Books SGST",
        "Diff Taxable", "Diff IGST", "Diff CGST", "Diff SGST",
        "Matched", "2B Only", "Books Only",
    ]
    for col, hdr in enumerate(headers, 1):
        c = ws.cell(row=1, column=col, value=hdr)
        c.font      = font_hdr
        c.fill      = fill_hdr
        c.alignment = center
        c.border    = border
    ws.column_dimensions["A"].width = 14
    for col in range(2, len(headers) + 1):
        ws.column_dimensions[ws.cell(row=1, column=col).column_letter].width = 16

    sorted_months = sorted(month_data.keys())
    totals = {k: 0.0 for k in ["taxable_2b","igst_2b","cgst_2b","sgst_2b",
                                 "taxable_bk","igst_bk","cgst_bk","sgst_bk",
                                 "matched","only_2b","only_bk"]}

    for row_idx, month in enumerate(sorted_months, 2):
        md   = month_data[month]
        fill = fill_alt if row_idx % 2 == 0 else PatternFill()
        diff_t = round(md["taxable_2b"] - md["taxable_bk"], 2)
        diff_i = round(md["igst_2b"]    - md["igst_bk"],    2)
        diff_c = round(md["cgst_2b"]    - md["cgst_bk"],    2)
        diff_s = round(md["sgst_2b"]    - md["sgst_bk"],    2)

        row_vals = [
            month,
            md["taxable_2b"], md["igst_2b"], md["cgst_2b"], md["sgst_2b"],
            md["taxable_bk"], md["igst_bk"], md["cgst_bk"], md["sgst_bk"],
            diff_t, diff_i, diff_c, diff_s,
            md["matched"], md["only_2b"], md["only_bk"],
        ]
        for col, val in enumerate(row_vals, 1):
            c = ws.cell(row=row_idx, column=col, value=val)
            c.border = border
            c.fill   = fill
            if col == 1:
                c.alignment = center
            elif col <= 13:
                c.alignment    = right
                c.number_format = num_fmt
            else:
                c.alignment    = right
                c.number_format = int_fmt

        for k in totals:
            totals[k] += md.get(k, 0)

    # Totals row
    tr = len(sorted_months) + 2
    diff_t_tot = round(totals["taxable_2b"] - totals["taxable_bk"], 2)
    diff_i_tot = round(totals["igst_2b"]    - totals["igst_bk"],    2)
    diff_c_tot = round(totals["cgst_2b"]    - totals["cgst_bk"],    2)
    diff_s_tot = round(totals["sgst_2b"]    - totals["sgst_bk"],    2)
    total_vals = [
        "TOTAL",
        totals["taxable_2b"], totals["igst_2b"], totals["cgst_2b"], totals["sgst_2b"],
        totals["taxable_bk"], totals["igst_bk"], totals["cgst_bk"], totals["sgst_bk"],
        diff_t_tot, diff_i_tot, diff_c_tot, diff_s_tot,
        int(totals["matched"]), int(totals["only_2b"]), int(totals["only_bk"]),
    ]
    for col, val in enumerate(total_vals, 1):
        c = ws.cell(row=tr, column=col, value=val)
        c.font   = font_total
        c.fill   = fill_total
        c.border = border
        c.alignment = center if col == 1 else right
        if 2 <= col <= 13:
            c.number_format = num_fmt
        elif col > 13:
            c.number_format = int_fmt

    ws.freeze_panes = "B2"


def _copy_rcm_sheet(src_bytes: bytes, target_wb: Any) -> None:
    src_bytes = _ensure_xlsx(src_bytes)
    import openpyxl
    from io import BytesIO
    import copy
    try:
        src_wb = openpyxl.load_workbook(BytesIO(src_bytes), data_only=True)
        # Find the B2B sheet
        b2b_sheet = None
        for name in src_wb.sheetnames:
            if name.upper().strip() == "B2B":
                b2b_sheet = src_wb[name]
                break
        
        if b2b_sheet is None:
            # Fallback to check if "B2B" is in the name
            for name in src_wb.sheetnames:
                if "B2B" in name.upper():
                    b2b_sheet = src_wb[name]
                    break
                    
        if b2b_sheet is None:
            print("No B2B sheet found in GSTR-2B for RCM copying.")
            return

        tgt_sheet = target_wb.create_sheet(title="RCM")
        
        # Copy column dimensions (widths)
        for col_letter in b2b_sheet.column_dimensions:
            tgt_sheet.column_dimensions[col_letter].width = b2b_sheet.column_dimensions[col_letter].width
            
        # Copy merged cells that are within the header (rows 1-6)
        for merged_range in b2b_sheet.merged_cells.ranges:
            if merged_range.max_row <= 6:
                tgt_sheet.merge_cells(str(merged_range))
                
        # Find the column containing 'Supply Attract Reverse Charge' in rows 4-7
        rcm_col_idx = 8  # Default fallback to Column H (8th column)
        found_col = False
        for r_idx in range(4, 8):
            if found_col:
                break
            for col_idx in range(1, b2b_sheet.max_column + 1):
                cell_val = str(b2b_sheet.cell(row=r_idx, column=col_idx).value or "").strip().lower()
                if "supply attract reverse charge" in cell_val or "reverse charge" in cell_val:
                    rcm_col_idx = col_idx
                    found_col = True
                    break
        
        # Copy rows: first 6 are headers, remaining are filtered by 'Yes' in the rcm column
        tgt_row_idx = 1
        for r in range(1, b2b_sheet.max_row + 1):
            is_header = (r <= 6)
            is_rcm = False
            if not is_header:
                rcm_val = str(b2b_sheet.cell(row=r, column=rcm_col_idx).value or "").strip().lower()
                if rcm_val == "yes":
                    is_rcm = True
            
            if is_header or is_rcm:
                # Copy row height
                if r in b2b_sheet.row_dimensions:
                    tgt_sheet.row_dimensions[tgt_row_idx].height = b2b_sheet.row_dimensions[r].height
                    
                for c in range(1, b2b_sheet.max_column + 1):
                    cell = b2b_sheet.cell(row=r, column=c)
                    tgt_cell = tgt_sheet.cell(row=tgt_row_idx, column=c, value=cell.value)
                    if cell.has_style:
                        tgt_cell.font = copy.copy(cell.font)
                        tgt_cell.fill = copy.copy(cell.fill)
                        tgt_cell.alignment = copy.copy(cell.alignment)
                        tgt_cell.border = copy.copy(cell.border)
                        tgt_cell.number_format = cell.number_format
                tgt_row_idx += 1
    except Exception as e:
        print(f"Error copying RCM sheet: {e}")


def _append_rcm_rows(gstr2b_bytes: bytes, target_wb: Any) -> None:
    """Append RCM data rows (reverse charge = yes) from an additional state's GSTR-2B
    into the existing 'RCM' sheet in target_wb. Headers are NOT re-copied (state 1 wrote them).
    Called by the multistate builder for states 2-N."""
    gstr2b_bytes = _ensure_xlsx(gstr2b_bytes)
    import openpyxl
    from io import BytesIO
    import copy
    try:
        src_wb = openpyxl.load_workbook(BytesIO(gstr2b_bytes), data_only=True)
        b2b_sheet = None
        for name in src_wb.sheetnames:
            if name.upper().strip() == "B2B":
                b2b_sheet = src_wb[name]
                break
        if b2b_sheet is None:
            for name in src_wb.sheetnames:
                if "B2B" in name.upper():
                    b2b_sheet = src_wb[name]
                    break
        if b2b_sheet is None:
            return

        # Locate RCM column
        rcm_col_idx = 8
        for r_idx in range(4, 8):
            found = False
            for col_idx in range(1, b2b_sheet.max_column + 1):
                cell_val = str(b2b_sheet.cell(row=r_idx, column=col_idx).value or "").strip().lower()
                if "supply attract reverse charge" in cell_val or "reverse charge" in cell_val:
                    rcm_col_idx = col_idx
                    found = True
                    break
            if found:
                break

        if "RCM" not in target_wb.sheetnames:
            target_wb.create_sheet(title="RCM")
        tgt_sheet = target_wb["RCM"]

        # Append only RCM data rows (skip header rows 1-6)
        for r in range(7, b2b_sheet.max_row + 1):
            rcm_val = str(b2b_sheet.cell(row=r, column=rcm_col_idx).value or "").strip().lower()
            if rcm_val == "yes":
                new_row = tgt_sheet.max_row + 1
                for c in range(1, b2b_sheet.max_column + 1):
                    cell = b2b_sheet.cell(row=r, column=c)
                    tgt_cell = tgt_sheet.cell(row=new_row, column=c, value=cell.value)
                    if cell.has_style:
                        tgt_cell.font      = copy.copy(cell.font)
                        tgt_cell.fill      = copy.copy(cell.fill)
                        tgt_cell.alignment = copy.copy(cell.alignment)
                        tgt_cell.border    = copy.copy(cell.border)
                        tgt_cell.number_format = cell.number_format
        src_wb.close()
    except Exception as e:
        print(f"Error appending RCM rows: {e}")


def build_gstr2b_books_workbook(results: list[dict], payload: dict | None = None) -> Any:
    import openpyxl
    wb = openpyxl.Workbook()

    # 1. Copy GSTR-2B, Purchase Register, and Debit Note Register sheets first if payload is provided
    if payload:
        import base64
        # Decode and copy GSTR-2B sheets
        if "_gstr2b_b64" in payload:
            try:
                gstr2b_bytes = base64.b64decode(payload["_gstr2b_b64"])
                _copy_workbook_sheets(gstr2b_bytes, wb, "2B")
            except Exception as e:
                print(f"Failed to copy GSTR-2B sheets: {e}")
                
        # Decode and copy Purchase Register sheets
        if "_purchase_b64" in payload:
            try:
                purchase_bytes = base64.b64decode(payload["_purchase_b64"])
                _copy_workbook_sheets(purchase_bytes, wb, "PR")
            except Exception as e:
                print(f"Failed to copy Purchase Register sheets: {e}")
                
        # Decode and copy Debit Note Register sheets
        if "_debit_b64" in payload:
            try:
                debit_bytes = base64.b64decode(payload["_debit_b64"])
                _copy_workbook_sheets(debit_bytes, wb, "DN")
            except Exception as e:
                print(f"Failed to copy Debit Note sheets: {e}")

        # Accountant check-point: show, beside each register row, what the tool took
        # from it. Purely additive — a failure here must never cost the workbook.
        _books = [b for b in (_get_val(r, "purchase", None) for r in results) if b is not None]
        for _key, _title, _dt in (("_purchase_b64", "PR - Purchase Register", "INV"),
                                  ("_debit_b64",    "DN - Debit Note Register", "DBN")):
            # Per sheet, so a failure on one register cannot silently cost the other
            # its check-point (an early version lost the whole DN strip this way).
            if payload.get(_key):
                try:
                    append_books_audit_columns(
                        wb, base64.b64decode(payload[_key]), _books, _title, _dt)
                except Exception as e:
                    print(f"Failed to add audit columns to {_title}: {e}")


    # 2. Add RCM entries sheet
    if payload and "_gstr2b_b64" in payload:
        import base64
        try:
            gstr2b_bytes = base64.b64decode(payload["_gstr2b_b64"])
            _copy_rcm_sheet(gstr2b_bytes, wb)
        except Exception as e:
            print(f"Failed to dynamically populate RCM sheet: {e}")
            wb.create_sheet(title="RCM")
    else:
        wb.create_sheet(title="RCM")
    
    # 3. Add Vendor Summary sheet
    ws_vendor = wb.create_sheet(title="Vendor Summary")
    _build_vendor_summary_sheet(ws_vendor, results)

    # 4. Add Month Summary sheet (only when results span ≥ 2 distinct months)
    _build_month_summary_sheet(wb, results)

    # 5. Add main Output sheet (Reco 2B vs Books)
    ws_output = wb.create_sheet(title="Reco 2B vs Books")
    _populate_workbook(ws_output, results)

    # Remove the default 'Sheet' that openpyxl creates automatically if we added other sheets
    if "Sheet" in wb.sheetnames and len(wb.sheetnames) > 1:
        wb.remove(wb["Sheet"])

    return wb


# ---------------------------------------------------------------------------
# Top-level entry point
# ---------------------------------------------------------------------------

def reconcile_gstr2b_vs_books(
    gstr2b_data: bytes,
    purchase_data: bytes,
    debit_data: bytes,
    tolerance: float = 1.0,
) -> tuple[list[NormalizedInvoice], list[NormalizedInvoice], list[MatchResult]]:
    gstr2b_data = _ensure_xlsx(gstr2b_data)
    purchase_data = _ensure_xlsx(purchase_data)
    debit_data = _ensure_xlsx(debit_data)
    gstr2b_records = parse_gstr2b(gstr2b_data)
    books_records = parse_books(purchase_data, debit_data)
    
    # Map Books supplier_name to supplier_gstin from GSTR-2B to avoid false negatives from spelling
    name_to_gstin = {}
    for g in gstr2b_records:
        name_clean = str(g.supplier_name or "").strip().lower()
        if name_clean and g.supplier_gstin:
            name_to_gstin[name_clean] = g.supplier_gstin
            
    for b in books_records:
        if not b.supplier_gstin:
            name_clean = str(b.supplier_name or "").strip().lower()
            if name_clean in name_to_gstin:
                b.supplier_gstin = name_to_gstin[name_clean]
                
    results = reconcile_by_invoice_no(gstr2b_records, books_records, tolerance=tolerance)
    return gstr2b_records, books_records, results

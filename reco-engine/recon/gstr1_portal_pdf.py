"""GSTR-1 portal PDF (the "FORM GSTR-1" summary the GST portal lets you download).

One PDF = one GSTIN x one tax period. It carries table-wise TOTALS only (4A B2B,
5 B2CL, 6 exports/SEZ, 7 B2CS, 9 CDN + amendments, 10, 11 advances, 12 HSN …)
and a closing "Total Liability" line — no invoices. So it reconciles against
Books at registration x month level, not invoice level.

The portal stamps a diagonal "FINAL" watermark whose letters land inside the
extracted text ("Total I0 Invoice", "N0.00", "1,2N3.00"), so every line is cleaned
of stray L/A/N/I/F glued to digits before numbers are read.

`parse_gstr1_portal_pdf` returns None when the PDF is not this form.
"""
from __future__ import annotations

import io
import logging
import re

logger = logging.getLogger(__name__)

_MONTHS = ["january", "february", "march", "april", "may", "june", "july",
           "august", "september", "october", "november", "december"]
_GSTIN_RE = re.compile(r"\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b")
_NUM_RE = re.compile(r"-?\d[\d,]*\.\d{2}")

# Section headers, in the order the form prints them. The key is what the rest of
# this module calls the table.
_SECTION_RES = [
    ("4A", re.compile(r"^4A\s*[-–]")),
    ("4B", re.compile(r"^4B\s*[-–]")),
    ("5", re.compile(r"^5\s*[-–]")),
    ("6A", re.compile(r"^6A\s*[-–]")),
    ("6B", re.compile(r"^6B\s*[-–]")),
    ("6C", re.compile(r"^6C\s*[-–]")),
    ("7", re.compile(r"^7\s*[-–]")),
    ("8", re.compile(r"^8\s*[-–]")),
    ("9A", re.compile(r"^9A\s*[-–]")),
    ("9B_R", re.compile(r"^9B\s*[-–].*\(Registered\)", re.I)),
    ("9B_U", re.compile(r"^9B\s*[-–].*\(Unregistered\)", re.I)),
    ("9C_R", re.compile(r"^9C\s*[-–].*\(Registered\)", re.I)),
    ("9C_U", re.compile(r"^9C\s*[-–].*\(Unregistered\)", re.I)),
    ("10", re.compile(r"^10\s*[-–]")),
    ("11A", re.compile(r"^11A\(1\)")),
    ("11B", re.compile(r"^11B\(1\)")),
    ("11A_AMD", re.compile(r"^11A\s*[-–]")),
    ("11B_AMD", re.compile(r"^11B\s*[-–]")),
    ("12", re.compile(r"^12\s*[-–]")),
    ("13", re.compile(r"^13\s*[-–]")),
    ("14", re.compile(r"^14\s*[-–]")),
    ("14A", re.compile(r"^14A\s*[-–]")),
    ("15", re.compile(r"^15\s*[-–]")),
    ("15A", re.compile(r"^15A\s")),
]

# Registered-recipient tables vs everything else. 9A is split by its sub-header.
_B2B_TABLES = ("4A", "4B", "6B", "6C", "9B_R", "9C_R")
_B2C_TABLES = ("5", "6A", "7", "9B_U", "9C_U", "10")


def _clean(line: str) -> str:
    """Strip watermark letters that landed inside or right before a number."""
    line = re.sub(r"(?<=[\d,.])[LANIF]+(?=[\d,.])", "", line)
    line = re.sub(r"(?:(?<=\s)|^)[LANIF](?=[\d-])", "", line)
    return line


def _nums(line: str) -> list[float]:
    return [float(n.replace(",", "")) for n in _NUM_RE.findall(line)]


def _amounts(nums: list[float], section: str) -> dict:
    """Map the numbers on a total line onto value / IGST / CGST / SGST / cess.

    Inter-state-only tables (B2CL, exports, SEZ, CDNUR) print value, IGST, cess —
    no CGST/SGST columns."""
    out = {"taxable": 0.0, "igst": 0.0, "cgst": 0.0, "sgst": 0.0, "cess": 0.0}
    if len(nums) >= 5:
        out.update(taxable=nums[0], igst=nums[1], cgst=nums[2], sgst=nums[3], cess=nums[4])
    elif len(nums) == 4:
        out.update(taxable=nums[0], igst=nums[1], cgst=nums[2], sgst=nums[3])
    elif len(nums) == 3:
        out.update(taxable=nums[0], igst=nums[1], cess=nums[2])
    elif len(nums) == 2:
        out.update(taxable=nums[0], igst=nums[1])
    elif len(nums) == 1:
        out.update(taxable=nums[0])
    return out


def _add(acc: dict, amt: dict, sign: float = 1.0) -> None:
    for k in ("taxable", "igst", "cgst", "sgst", "cess"):
        acc[k] = round(acc.get(k, 0.0) + sign * amt.get(k, 0.0), 2)


def _zero() -> dict:
    return {"taxable": 0.0, "igst": 0.0, "cgst": 0.0, "sgst": 0.0, "cess": 0.0}


def parse_gstr1_portal_pdf(pdf_bytes: bytes) -> dict | None:
    try:
        import pdfplumber
    except Exception:                                   # pragma: no cover
        logger.error("pdfplumber not installed — cannot read GSTR-1 PDF")
        return None
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            text = "\n".join((p.extract_text() or "") for p in pdf.pages)
    except Exception as e:
        logger.warning("GSTR-1 PDF: could not open (%s)", e)
        return None
    if "GSTR-1" not in text.upper() or "Tax period" not in text:
        return None

    gstin_m = _GSTIN_RE.search(text)
    fy_m = re.search(r"Financial year\s+(\d{4})\s*-\s*(\d{2,4})", text)
    mon_m = re.search(r"Tax period\s+([A-Za-z]+)", text)
    if not (gstin_m and fy_m and mon_m):
        return None
    month_name = mon_m.group(1).strip().lower()
    if month_name not in _MONTHS:
        return None
    mo = _MONTHS.index(month_name) + 1
    fy_start = int(fy_m.group(1))
    year = fy_start if mo >= 4 else fy_start + 1
    nil = bool(re.search(r"Nil Filed\s+Yes", text))

    tables: dict[str, dict] = {}
    section = None
    sub9a = None                        # which 9A sub-table we are in: 'b2b' or 'b2c'
    total_liability = None
    for raw in text.split("\n"):
        line = _clean(raw.strip())
        if not line:
            continue
        for key, rx in _SECTION_RES:
            if rx.search(line):
                section = key
                if key == "9A":
                    sub9a = "b2c" if re.search(r"B2CL|Export", line, re.I) else "b2b"
                break
        if line.startswith("Total Liability"):
            total_liability = _amounts(_nums(line), "TL")
            continue
        if section is None:
            continue
        nums = _nums(line)
        if not nums:
            continue
        low = line.lower()
        if section == "9A" and low.startswith("net differential amount"):
            key = f"9A_{sub9a}"
            tables.setdefault(key, _zero())
            _add(tables[key], _amounts(nums, key))
            continue
        if section in ("9C_R", "9C_U") and low.startswith("net differential amount"):
            tables.setdefault(section, _amounts(nums, section))
            continue
        if section == "10" and low.startswith("net differential amount"):
            tables.setdefault("10", _amounts(nums, "10"))
            continue
        if section in ("9B_R", "9B_U") and low.startswith("total - net off"):
            tables.setdefault(section, _amounts(nums, section))
            continue
        if section in ("4A", "4B", "5", "6A", "6B", "6C", "7", "8", "11A", "11B", "14", "15") \
                and low.startswith("total"):
            tables.setdefault(section, _amounts(nums, section))
            continue
        if section == "12":
            if low.startswith("b2b total"):
                tables.setdefault("12_B2B", _amounts(nums, "12"))
            elif low.startswith("b2c total"):
                tables.setdefault("12_B2C", _amounts(nums, "12"))
            elif low.startswith("total"):
                tables.setdefault("12", _amounts(nums, "12"))

    b2b, b2c = _zero(), _zero()
    for t in _B2B_TABLES:
        if t in tables:
            _add(b2b, tables[t])
    if "9A_b2b" in tables:
        _add(b2b, tables["9A_b2b"])
    for t in _B2C_TABLES:
        if t in tables:
            _add(b2c, tables[t])
    if "9A_b2c" in tables:
        _add(b2c, tables["9A_b2c"])

    total = _zero()
    _add(total, b2b)
    _add(total, b2c)
    parsed_ok = True
    if total_liability is not None:
        # The form's own closing line is the authority. Advances (11A/11B) move tax
        # only, so any tax gap they explain is not a parsing miss.
        gap = {k: round(total_liability[k] - total[k], 2) for k in ("taxable", "igst", "cgst", "sgst")}
        parsed_ok = all(abs(v) <= 1.0 for v in gap.values())
        if not parsed_ok:
            logger.warning("GSTR-1 PDF %s %04d-%02d: table sum differs from Total Liability by %s",
                           gstin_m.group(1), year, mo, gap)
    elif not nil:
        parsed_ok = False

    return {
        "gstin": gstin_m.group(1),
        "period": f"{year:04d}-{mo:02d}",
        "month": _MONTHS[mo - 1].title(),
        "fy": f"{fy_start}-{str(fy_start + 1)[2:]}",
        "nil_filed": nil,
        "tables": tables,
        "b2b": b2b,
        "b2c": b2c,
        "total": total_liability if total_liability is not None else total,
        "table_sum": total,
        "parsed_ok": parsed_ok,
    }


# ---------------------------------------------------------------------------
# GSTR-3B portal PDF — table 3.1 (outward supplies)
# ---------------------------------------------------------------------------

_3B_ROWS = {
    "a": re.compile(r"^\(a\)\s*Outward taxable supplies \(other than zero", re.I),
    "b": re.compile(r"^\(b\)\s*Outward taxable supplies \(zero rated", re.I),
    "c": re.compile(r"^\(c\s*\)\s*Other outward supplies", re.I),
    "d": re.compile(r"^\(d\)\s*Inward supplies", re.I),
    "e": re.compile(r"^\(e\)\s*Non-GST outward", re.I),
}


def _3b_amounts(line: str) -> dict:
    """3.1 rows print value, IGST, CGST, SGST, cess with '-' where a column does not apply."""
    tokens = re.findall(r"-?\d[\d,]*\.\d{2}|(?<!\w)-(?!\d)", line)
    vals = [0.0 if t == "-" else float(t.replace(",", "")) for t in tokens]
    vals += [0.0] * (5 - len(vals))
    return {"taxable": vals[0], "igst": vals[1], "cgst": vals[2], "sgst": vals[3], "cess": vals[4]}


def parse_gstr3b_outward_pdf(pdf_bytes: bytes) -> dict | None:
    """GSTIN / period from the GSTR-3B Tally Entry agent's parser, plus table 3.1.

    Returns {"gstin", "period": 'YYYY-MM', "month", "rows": {a,b,c,d,e}, "outward": 3.1(a)+(b)}
    or None when the PDF is not a GSTR-3B."""
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            text = "\n".join((p.extract_text() or "") for p in pdf.pages)
    except Exception as e:
        logger.warning("GSTR-3B PDF: could not open (%s)", e)
        return None
    if "GSTR-3B" not in text.upper():
        return None

    meta = {}
    try:
        from .gstr_3b_tally_entry import _parse_gstr3b_pdf
        meta = _parse_gstr3b_pdf(pdf_bytes) or {}
    except Exception as e:                       # metadata only — 3.1 still read below
        logger.info("GSTR-3B PDF: tally-entry parser unavailable (%s)", e)

    gstin = meta.get("gstin") or ""
    if not gstin:
        m = _GSTIN_RE.search(text)
        gstin = m.group(1) if m else ""
    fy_m = re.search(r"Year\s+(\d{4})\s*-\s*(\d{2,4})", text)
    mon_m = re.search(r"Period\s+([A-Za-z]+)", text)
    if not (gstin and fy_m and mon_m) or mon_m.group(1).lower() not in _MONTHS:
        return None
    mo = _MONTHS.index(mon_m.group(1).lower()) + 1
    fy_start = int(fy_m.group(1))
    year = fy_start if mo >= 4 else fy_start + 1

    rows: dict[str, dict] = {}
    in_31 = False
    for raw in text.split("\n"):
        line = _clean(raw.strip())
        if line.startswith("3.1 "):
            in_31 = True
            continue
        if line.startswith("3.1.1") or line.startswith("3.2"):
            in_31 = False
        if not in_31:
            continue
        for key, rx in _3B_ROWS.items():
            if key not in rows and rx.search(line):
                rows[key] = _3b_amounts(line)
                break

    outward = _zero()
    for k in ("a", "b"):
        if k in rows:
            _add(outward, rows[k])
    return {
        "gstin": gstin,
        "period": f"{year:04d}-{mo:02d}",
        "month": _MONTHS[mo - 1].title(),
        "filing_date": meta.get("filing_date", ""),
        "rows": rows,
        "outward": outward,
        "parsed_ok": "a" in rows,
    }

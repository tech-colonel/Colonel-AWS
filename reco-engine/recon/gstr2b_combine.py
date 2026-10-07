"""
gstr2b_combine.py — several monthly GSTR-2B portal downloads for ONE registration,
combined into ONE portal-layout workbook before GSTR-2B vs Books (Multi-State) runs.

Accountants used to merge the months by hand (or with an AI chat) and upload the
result. Those hand-merged files shifted the portal's two-row heading and added a
Month column, so the taxable value read as Rs 0 on every row. Here the engine does
the merge itself, in the exact layout it already reads:

  * same tabs as the portal download (B2B, B2BA, B2B-CDNR, B2B-CDNRA),
  * each tab keeps the portal's own heading band, taken from the first month that
    has the tab, and every month's data rows go underneath it in period order,
  * the result is named  <first>-<last>_<GSTIN>_GSTR2B_combined.xlsx  so the
    registration is read from the name like any portal file.

Nothing is guessed. Before the combined file is handed on:
  * every file must be a GST-portal 2B (OCTA / Combined / unknown layouts are
    refused for month-combining — upload those as the only file for the state);
  * every file must belong to the same GSTIN (read from the file's own Read me tab,
    falling back to the file name);
  * the same file uploaded twice is used once; the same month twice with different
    content is refused;
  * each tab's column headings must be identical across months;
  * the combined file, read back by the normal parser, must give exactly the sum of
    the months — record count per tab, taxable value and tax, to the paisa.
Any failure raises Gstr2bCombineError with a message for the accountant.
"""
from __future__ import annotations

import hashlib
import re
from io import BytesIO
from typing import Any

import pandas as pd

TABS = ["B2B", "B2BA", "B2B-CDNR", "B2B-CDNRA"]
_GSTIN_ANY = re.compile(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]")
_MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], start=1)}
_MON_ABBR = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


class Gstr2bCombineError(ValueError):
    """Month-combining refused. The message is shown to the accountant as-is."""


def _s(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v != v:
        return ""
    s = str(v).strip()
    return "" if s.lower() in ("nan", "none") else s


def _read_me(data: bytes) -> dict:
    """GSTIN, financial year and tax period from the portal's Read me tab."""
    out = {"gstin": "", "fy": "", "period": ""}
    try:
        raw = pd.read_excel(BytesIO(data), sheet_name="Read me", header=None, dtype=object, nrows=12)
    except Exception:
        return out
    for _, row in raw.iterrows():
        cells = [_s(v) for v in row]
        label = cells[0].lower() if cells else ""
        value = next((c for c in cells[1:] if c), "")
        if label == "gstin":
            m = _GSTIN_ANY.search(value.upper())
            out["gstin"] = m.group(0) if m else ""
        elif label == "financial year":
            out["fy"] = value
        elif label == "tax period":
            out["period"] = value
    return out


def _period_key(meta: dict, filename: str) -> tuple[int, int] | None:
    """(year, month) of the return period: Read me first, then the portal file name
    (MMYYYY_<GSTIN>_GSTR2B_...)."""
    mon = _MONTHS.get(meta.get("period", "").strip().lower())
    fy = re.match(r"(\d{4})-(\d{2})", meta.get("fy", ""))
    if mon and fy:
        start = int(fy.group(1))
        return (start if mon >= 4 else start + 1, mon)
    m = re.match(r"(\d{2})(\d{4})_", filename or "")
    if m and 1 <= int(m.group(1)) <= 12:
        return (int(m.group(2)), int(m.group(1)))
    return None


def _label(key: tuple[int, int] | None) -> str:
    return f"{_MON_ABBR[key[1]]}-{key[0]}" if key else "period unknown"


def _tab_frames(data: bytes) -> dict[str, tuple[list[list[Any]], list[list[Any]]]]:
    """{tab: (heading_rows, data_rows)} for each portal tab present — the heading band
    exactly as the portal parser sees it, and the rows it would treat as data."""
    from .gstr_2b_books import _find_header_band_end, _row_is_data
    out = {}
    try:
        names = pd.ExcelFile(BytesIO(data)).sheet_names
    except Exception:
        return out
    for tab in TABS:
        if tab not in names:
            continue
        raw = pd.read_excel(BytesIO(data), sheet_name=tab, header=None, dtype=object)
        if len(raw) < 6:
            continue
        band_end = _find_header_band_end(raw) if len(raw) >= 7 else 6
        head = [list(raw.iloc[i]) for i in range(0, min(band_end, len(raw)))]
        body = [list(raw.iloc[i]) for i in range(band_end, len(raw)) if _row_is_data(raw.iloc[i])]
        out[tab] = (head, body)
    return out


def _labels(head: list[list[Any]]) -> list[str]:
    """Column headings from the band (rows 5+), for the cross-month layout check."""
    rows = head[4:] if len(head) > 4 else head
    width = max((len(r) for r in rows), default=0)
    out = []
    for c in range(width):
        out.append("|".join(_s(r[c]) if c < len(r) else "" for r in rows))
    while out and not out[-1].strip("|"):
        out.pop()
    return out


def _totals(records) -> dict:
    tabs: dict[str, int] = {}
    for r in records:
        tab = "-".join(str(r.row_id).split("-")[1:-1]) or r.sheet_name
        tabs[tab] = tabs.get(tab, 0) + 1
    return {
        "records": len(records),
        "tabs": tabs,
        "taxable": round(sum(r.taxable_value for r in records), 2),
        "tax": round(sum(r.igst + r.cgst + r.sgst + r.cess for r in records), 2),
    }


def combine_monthly_2b(items: list[dict]) -> tuple[dict, dict]:
    """items: [{"filename", "content"}] for ONE registration.
    Returns (combined_item, info). A single item is returned unchanged."""
    from .gstr_2b_books import _ensure_xlsx, parse_gstr2b, gstr2b_format_info

    if len(items) == 1:
        return items[0], {"combined": False, "files": 1}

    seen: dict[str, str] = {}
    months: list[dict] = []
    skipped: list[str] = []
    for it in items:
        name = it.get("filename") or "file.xlsx"
        data = _ensure_xlsx(it["content"])
        digest = hashlib.sha256(data).hexdigest()
        if digest in seen:
            skipped.append(f"{name} (same file as {seen[digest]})")
            continue
        seen[digest] = name
        fmt = gstr2b_format_info(data).get("format")
        if fmt != "portal":
            what = {"octa": "an OCTA export", "combined": "an already-combined workbook",
                    "new": "a non-portal layout"}.get(fmt, "not a GST-portal GSTR-2B")
            raise Gstr2bCombineError(
                f"{name} is {what}. Month-wise combining works on the GST-portal monthly downloads — "
                "upload this file on its own for the state, or replace it with the portal files.")
        meta = _read_me(data)
        gstin = meta["gstin"] or (_GSTIN_ANY.search(name.upper()).group(0)
                                  if _GSTIN_ANY.search(name.upper()) else "")
        key = _period_key(meta, name)
        recs = parse_gstr2b(data)
        months.append({"file": name, "data": data, "gstin": gstin, "key": key,
                       "period": _label(key), "frames": _tab_frames(data), **_totals(recs)})

    if len(months) == 1:
        only = months[0]
        return ({"filename": only["file"], "content": only["data"]},
                {"combined": False, "files": 1, "skipped": skipped})

    gstins = {m["gstin"] for m in months if m["gstin"]}
    if len(gstins) > 1:
        detail = "; ".join(f"{m['file']} → {m['gstin'] or 'unknown'}" for m in months)
        raise Gstr2bCombineError(
            f"These GSTR-2B files belong to different registrations, so they cannot be combined "
            f"for one state: {detail}. Put each GSTIN's months in its own state.")
    gstin = next(iter(gstins), "")
    if not gstin:
        raise Gstr2bCombineError("Could not read the GSTIN from these GSTR-2B files (Read me tab or file name).")

    by_key: dict[tuple, dict] = {}
    for m in months:
        if m["key"] is None:
            raise Gstr2bCombineError(f"Could not read the tax period of {m['file']} (Read me tab or file name).")
        if m["key"] in by_key:
            raise Gstr2bCombineError(
                f"{by_key[m['key']]['file']} and {m['file']} are both {m['period']} for {gstin} but their "
                "contents differ. Keep the one you want and remove the other.")
        by_key[m["key"]] = m
    months.sort(key=lambda m: m["key"])

    # Build the combined workbook: per tab, the first month's heading band, then every
    # month's data rows in period order. Headings must match across months.
    import openpyxl
    wb = openpyxl.Workbook()
    rm = wb.active
    rm.title = "Read me"
    rm.append(["Goods and Services Tax  - GSTR-2B (combined by Colonel from monthly portal downloads)"])
    rm.append([])
    rm.append([])
    rm.append(["Financial Year", ", ".join(sorted({_s(_read_me(m['data'])['fy']) for m in months} - {""}))])
    rm.append(["Tax Period", f"{months[0]['period']} to {months[-1]['period']} ({len(months)} months)"])
    rm.append(["GSTIN", gstin])
    rm.append([])
    rm.append(["Month", "Source file"])
    for m in months:
        rm.append([m["period"], m["file"]])

    for tab in TABS:
        # Only months with rows in this tab are compared and copied. An EMPTY amendment
        # tab has no data row to mark where its heading ends, so its third heading row
        # is indistinguishable from data and its band looks one row short — comparing
        # it would refuse files whose columns are in fact identical. Empty months add
        # nothing to the combined tab anyway.
        holders = [m for m in months if tab in m["frames"] and m["frames"][tab][1]]
        if not holders:
            continue
        ref_head = holders[0]["frames"][tab][0]
        ref_labels = _labels(ref_head)
        for m in holders[1:]:
            if _labels(m["frames"][tab][0]) != ref_labels:
                raise Gstr2bCombineError(
                    f"The {tab} columns in {m['file']} ({m['period']}) differ from {holders[0]['file']} "
                    f"({holders[0]['period']}). Re-download that month from the GST portal.")
        ws = wb.create_sheet(tab)
        for row in ref_head:
            ws.append([None if _s(v) == "" else v for v in row])
        for m in holders:
            for row in m["frames"][tab][1]:
                ws.append([None if _s(v) == "" else v for v in row])

    buf = BytesIO()
    wb.save(buf)
    combined = buf.getvalue()

    # Tie-out: the combined file must read back as exactly the sum of the months.
    got = _totals(parse_gstr2b(combined))
    want_tabs: dict[str, int] = {}
    for m in months:
        for t, n in m["tabs"].items():
            want_tabs[t] = want_tabs.get(t, 0) + n
    want = {"records": sum(m["records"] for m in months),
            "taxable": round(sum(m["taxable"] for m in months), 2),
            "tax": round(sum(m["tax"] for m in months), 2)}
    if (got["records"] != want["records"] or got["tabs"] != want_tabs
            or abs(got["taxable"] - want["taxable"]) > 0.005 or abs(got["tax"] - want["tax"]) > 0.005):
        raise Gstr2bCombineError(
            f"Combining the {len(months)} months for {gstin} did not tie out (months: {want['records']} "
            f"records, taxable {want['taxable']:,.2f}; combined: {got['records']} records, taxable "
            f"{got['taxable']:,.2f}). Nothing was reconciled — please send us these files.")

    first, last = months[0]["key"], months[-1]["key"]
    expected = []
    y, mo = first
    while (y, mo) <= last:
        expected.append((y, mo))
        y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
    missing = [_label(k) for k in expected if k not in by_key]

    name = f"{first[1]:02d}{first[0]}-{last[1]:02d}{last[0]}_{gstin}_GSTR2B_combined.xlsx"
    info = {
        "combined": True,
        "gstin": gstin,
        "file": name,
        "files": len(months),
        "from": months[0]["period"],
        "to": months[-1]["period"],
        "missing_months": missing,
        "skipped": skipped,
        "records": got["records"],
        "taxable": got["taxable"],
        "tax": got["tax"],
        "months": [{"period": m["period"], "file": m["file"], "records": m["records"],
                    "tabs": m["tabs"], "taxable": m["taxable"], "tax": m["tax"]} for m in months],
    }
    return {"filename": name, "content": combined}, info


def group_by_counts(items: list[dict], counts: list[int]) -> list[list[dict]]:
    """Split the ordered 2B uploads into one group per state using the per-state counts
    the page sends (gstr2b_counts). Counts that do not add up are refused."""
    counts = [int(c) for c in counts]
    if any(c < 0 for c in counts) or sum(counts) != len(items):
        raise Gstr2bCombineError(
            f"The GSTR-2B files did not arrive as sent ({len(items)} files for counts {counts}). Please try again.")
    groups, i = [], 0
    for c in counts:
        groups.append(items[i:i + c])
        i += c
    return groups

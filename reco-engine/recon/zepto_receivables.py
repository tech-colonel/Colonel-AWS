"""Zepto Receivables reconciliation engine.

Pipeline: GRN gate (PO match) -> per-invoice enrichment from Invoice Details,
Payment Advice, Credit Note -> `1. Invoice Tracker` sheet with live formulas.
"""
from __future__ import annotations

import csv
import io
from io import BytesIO
from typing import Any

import pandas as pd
from .gstr_2b_books import _ensure_xlsx   # OLE2 .xls -> .xlsx passthrough


def norm_po(v: Any) -> str:
    if v is None:
        return ""
    s = str(v).strip()
    if s.endswith(".0") and s[:-2].isdigit():   # pandas float-ified ints
        s = s[:-2]
    return s.upper()


def norm_inv(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip().upper()


def dn_ref_to_invoice(ref: str) -> str:
    """`V26-27/000007_QD` -> `INV26-27/000007` (drop `_...`, `V`->`INV`)."""
    base = str(ref or "").split("_")[0].strip()
    if base[:1].upper() == "V":
        base = "INV" + base[1:]
    return norm_inv(base)


def _norm_key(s: Any) -> str:
    return "".join(str(s or "").lower().split())


def _read_csv(data: bytes) -> list[list]:
    text = data.decode("utf-8-sig", errors="replace")
    return [row for row in csv.reader(io.StringIO(text))]


def _read_sheet(data: bytes, sheet: Any = 0) -> list[list]:
    data = _ensure_xlsx(data)
    df = pd.read_excel(BytesIO(data), sheet_name=sheet, header=None, dtype=object)
    grid = []
    for _, r in df.iterrows():
        grid.append(["" if (v is None or (isinstance(v, float) and pd.isna(v))) else v for v in r.tolist()])
    return grid


def _clean(v: Any) -> str:
    s = "" if v is None else str(v).strip()
    return "" if s.lower() == "nan" else s


def _find_header(grid: list[list], tokens: list[str], scan: int = 25) -> int:
    want = [_norm_key(t) for t in tokens]
    for i, row in enumerate(grid[:scan]):
        keys = {_norm_key(c) for c in row}
        if all(any(w in k for k in keys) for w in want):
            return i
    raise ValueError(f"Header row not found for tokens {tokens}")


def _rows_as_dicts(grid: list[list], header_idx: int) -> list[dict]:
    headers = [_clean(c) for c in grid[header_idx]]
    out = []
    for row in grid[header_idx + 1:]:
        if all(_clean(c) == "" for c in row):
            continue
        d = {}
        for j, h in enumerate(headers):
            if h:
                d[h] = row[j] if j < len(row) else ""
        out.append(d)
    return out


def _get(row: dict, aliases: list[str]) -> str:
    nk = {_norm_key(k): v for k, v in row.items()}
    for a in aliases:
        k = _norm_key(a)
        if k in nk:
            val = _clean(nk[k])
            if val != "":
                return val
    return ""

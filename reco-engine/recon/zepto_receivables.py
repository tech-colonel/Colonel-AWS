"""Zepto Receivables reconciliation engine.

Pipeline: GRN gate (PO match) -> per-invoice enrichment from Invoice Details,
Payment Advice, Credit Note -> `1. Invoice Tracker` sheet with live formulas.
"""
from __future__ import annotations

import csv
import io
from io import BytesIO
from typing import Any


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

from __future__ import annotations

from io import BytesIO, StringIO
import json
import re
from typing import Any

import pandas as pd

from .core import (
    NormalizedInvoice,
    normalize_doc_no,
    normalize_doc_type,
    normalize_gstin,
    parse_date,
    round_money,
)


FIELD_ALIASES = {
    "supplier_gstin": [
        "supplier gstin",
        "gstin of supplier",
        "gstin",
        "ctin",
        "supplier gst",
        "party gstin",
        "vendor gstin",
    ],
    "supplier_name": ["supplier name", "trade name", "legal name", "party name", "vendor name"],
    "doc_type": ["document type", "doc type", "invoice type", "type", "typ", "note type"],
    "doc_no": [
        "invoice number",
        "invoice no",
        "invoice no.",
        "document number",
        "document no",
        "doc no",
        "inum",
        "no",
        "bill no",
        "voucher no",
    ],
    "doc_date": [
        "invoice date",
        "document date",
        "doc date",
        "date",
        "idt",
        "dt",
        "bill date",
        "voucher date",
    ],
    "taxable_value": ["taxable value", "txval", "taxable amount", "assessable value"],
    "igst": ["igst", "integrated tax", "integrated tax amount", "iamt"],
    "cgst": ["cgst", "central tax", "central tax amount", "camt"],
    "sgst": ["sgst", "utgst", "state tax", "state/ut tax", "state tax amount", "samt"],
    "cess": ["cess", "cess amount", "csamt"],
    "invoice_value": ["invoice value", "total invoice value", "val", "total value", "gross value"],
}


def normalize_header(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[\n\r\t]+", " ", text)
    text = re.sub(r"[^a-z0-9/ ]+", "", text)
    return re.sub(r"\s+", " ", text).strip()


def read_upload(filename: str, data: bytes, source: str) -> list[NormalizedInvoice]:
    suffix = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if data.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") or suffix == "xls":
        from .gstr_2b_books import _ensure_xlsx
        data = _ensure_xlsx(data)
        suffix = "xlsx"

    if suffix == "json":
        rows = extract_json_rows(json.loads(data.decode("utf-8-sig")))
    elif suffix in {"xlsx", "xlsm"}:
        rows = read_excel_rows(data)
    elif suffix == "csv":
        rows = read_csv_rows(data)
    else:
        raise ValueError(f"Unsupported file type: {filename}")
    return normalize_rows(rows, source)


def read_csv_rows(data: bytes) -> list[dict[str, Any]]:
    text = data.decode("utf-8-sig", errors="replace")
    frame = pd.read_csv(StringIO(text))
    return frame.fillna("").to_dict(orient="records")


def read_excel_rows(data: bytes) -> list[dict[str, Any]]:
    sheets = pd.read_excel(BytesIO(data), sheet_name=None, dtype=object)
    rows: list[dict[str, Any]] = []
    for sheet_name, frame in sheets.items():
        frame = frame.dropna(how="all").fillna("")
        for record in frame.to_dict(orient="records"):
            record["_sheet"] = sheet_name
            rows.append(record)
    return rows


def extract_json_rows(payload: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def walk(node: Any, inherited: dict[str, Any]) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item, inherited)
            return
        if not isinstance(node, dict):
            return

        current = dict(inherited)
        for key in ("ctin", "gstin", "stin", "trdnm", "sup_name", "supplier_name"):
            if key in node and node[key]:
                current[key] = node[key]

        if looks_like_invoice(node):
            flat = dict(current)
            flatten_invoice(node, flat)
            rows.append(flat)

        for value in node.values():
            if isinstance(value, (dict, list)):
                walk(value, current)

    walk(payload, {})
    return rows


def looks_like_invoice(node: dict[str, Any]) -> bool:
    keys = {normalize_header(key) for key in node.keys()}
    invoice_keys = {"inum", "invoice number", "invoice no", "document number", "doc no", "nt num", "no"}
    date_keys = {"idt", "invoice date", "document date", "dt"}
    return bool(keys & invoice_keys) and bool(keys & date_keys)


def flatten_invoice(node: dict[str, Any], target: dict[str, Any]) -> None:
    for key, value in node.items():
        if isinstance(value, (str, int, float)) or value is None:
            target[key] = value
    totals = collect_tax_totals(node)
    for key, value in totals.items():
        target.setdefault(key, value)


def collect_tax_totals(node: Any) -> dict[str, float]:
    totals = {"txval": 0.0, "iamt": 0.0, "camt": 0.0, "samt": 0.0, "csamt": 0.0}

    def walk(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            for key, child in value.items():
                normalized = normalize_header(key)
                if normalized in totals:
                    totals[normalized] += round_money(child)
                elif isinstance(child, (dict, list)):
                    walk(child)

    walk(node)
    return {key: value for key, value in totals.items() if value}


def normalize_rows(rows: list[dict[str, Any]], source: str) -> list[NormalizedInvoice]:
    normalized: list[NormalizedInvoice] = []
    for index, row in enumerate(rows, start=1):
        getter = build_getter(row)
        doc_no = getter("doc_no")
        supplier_gstin = normalize_gstin(getter("supplier_gstin"))
        if not doc_no and not supplier_gstin:
            continue
        record = NormalizedInvoice(
            source=source,
            row_id=f"{source}-{index}",
            supplier_gstin=supplier_gstin,
            supplier_name=str(getter("supplier_name") or "").strip(),
            doc_type=normalize_doc_type(getter("doc_type")),
            doc_no=str(doc_no or "").strip(),
            normalized_doc_no=normalize_doc_no(doc_no),
            doc_date=parse_date(getter("doc_date")),
            taxable_value=round_money(getter("taxable_value")),
            igst=round_money(getter("igst")),
            cgst=round_money(getter("cgst")),
            sgst=round_money(getter("sgst")),
            cess=round_money(getter("cess")),
            invoice_value=round_money(getter("invoice_value")),
            raw={str(key): value for key, value in row.items() if not str(key).startswith("_")},
        )
        normalized.append(record)
    return normalized


def build_getter(row: dict[str, Any]):
    normalized_map = {normalize_header(key): value for key, value in row.items()}

    def get(field_name: str) -> Any:
        for alias in FIELD_ALIASES[field_name]:
            alias_key = normalize_header(alias)
            if alias_key in normalized_map and normalized_map[alias_key] != "":
                return normalized_map[alias_key]
        return ""

    return get


from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date, datetime
import math
import re
from typing import Any, Iterable


MONEY_FIELDS = ("taxable_value", "igst", "cgst", "sgst", "cess", "invoice_value")


@dataclass
class NormalizedInvoice:
    source: str
    row_id: str
    supplier_gstin: str = ""
    supplier_name: str = ""
    doc_type: str = "INV"
    doc_no: str = ""
    normalized_doc_no: str = ""
    doc_date: str = ""
    taxable_value: float = 0.0
    igst: float = 0.0
    cgst: float = 0.0
    sgst: float = 0.0
    cess: float = 0.0
    invoice_value: float = 0.0
    sheet_name: str = ""   # "B2B"/"B2BA"/"B2B-CDNR"/"B2B-CDNRA" for GSTR-2B; "" for Books
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def total_tax(self) -> float:
        return round_money(self.igst + self.cgst + self.sgst + self.cess)

    def identity_key(self) -> tuple[str, str, str]:
        return (self.supplier_gstin, self.doc_type, self.normalized_doc_no)

    def date_key(self) -> tuple[str, str, str, str]:
        return (*self.identity_key(), self.doc_date)

    def as_dict(self) -> dict[str, Any]:
        result = json_safe(asdict(self))
        result["total_tax"] = self.total_tax
        return result


@dataclass
class MatchResult:
    category: str
    confidence: int
    gstr2b: NormalizedInvoice | None
    purchase: NormalizedInvoice | None
    mismatch_fields: list[str]
    suggested_action: str
    explanation: str

    def as_dict(self) -> dict[str, Any]:
        res = {
            "category": self.category,
            "confidence": self.confidence,
            "gstr2b": self.gstr2b.as_dict() if self.gstr2b else None,
            "purchase": self.purchase.as_dict() if self.purchase else None,
            "mismatch_fields": self.mismatch_fields,
            "suggested_action": self.suggested_action,
            "explanation": self.explanation,
        }
        if hasattr(self, "suggested_action_2"):
            res["suggested_action_2"] = getattr(self, "suggested_action_2")
        if hasattr(self, "suggested_action_3"):
            res["suggested_action_3"] = getattr(self, "suggested_action_3")
        return res


def normalize_gstin(value: Any) -> str:
    text = str(value or "").upper().strip()
    return re.sub(r"[^0-9A-Z]", "", text)


def normalize_doc_no(value: Any) -> str:
    text = str(value or "").upper().strip()
    text = text.replace("\\", "/")
    return re.sub(r"[^0-9A-Z]", "", text)


def normalize_doc_type(value: Any) -> str:
    text = str(value or "").upper().strip()
    if any(token in text for token in ("CREDIT", "CR", "CN", "C/N")):
        return "CRN"
    if any(token in text for token in ("DEBIT", "DR", "DN", "D/N")):
        return "DBN"
    if text in {"R", "RCM"}:
        return "RCM"
    return "INV"


def parse_date(value: Any) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    if not text:
        return ""
    if re.fullmatch(r"\d+(\.0)?", text):
        try:
            serial = int(float(text))
            base = datetime(1899, 12, 30)
            return (base.fromordinal(base.toordinal() + serial)).date().isoformat()
        except Exception:
            pass
    formats = (
        "%d/%m/%Y",
        "%d-%m-%Y",
        "%Y-%m-%d",
        "%d.%m.%Y",
        "%m/%d/%Y",
        "%d/%m/%y",
        "%d-%m-%y",
        "%Y/%m/%d",
    )
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return text


def round_money(value: Any) -> float:
    try:
        if value is None or value == "":
            return 0.0
        if isinstance(value, str):
            value = value.replace(",", "").replace("₹", "").strip()
            if value in {"-", ""}:
                return 0.0
        number = float(value)
        if math.isnan(number) or math.isinf(number):
            return 0.0
        return round(number, 2)
    except Exception:
        return 0.0


def json_safe(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, dict):
        return {str(key): json_safe(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(child) for child in value]
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    if hasattr(value, "item"):
        try:
            return json_safe(value.item())
        except Exception:
            pass
    return value


def amount_equal(left: float, right: float, tolerance: float) -> bool:
    return abs(round_money(left) - round_money(right)) <= tolerance


def money_mismatches(left: NormalizedInvoice, right: NormalizedInvoice, tolerance: float) -> list[str]:
    mismatches: list[str] = []
    for field_name in MONEY_FIELDS:
        if not amount_equal(getattr(left, field_name), getattr(right, field_name), tolerance):
            mismatches.append(field_name)
    if not amount_equal(left.total_tax, right.total_tax, tolerance):
        mismatches.append("total_tax")
    return mismatches


def compare_records(gstr2b: NormalizedInvoice, purchase: NormalizedInvoice, tolerance: float) -> tuple[int, list[str]]:
    checks = {
        "supplier_gstin": gstr2b.supplier_gstin == purchase.supplier_gstin,
        "doc_type": gstr2b.doc_type == purchase.doc_type,
        "doc_no": gstr2b.normalized_doc_no == purchase.normalized_doc_no,
        "doc_date": gstr2b.doc_date == purchase.doc_date,
        "taxable_value": amount_equal(gstr2b.taxable_value, purchase.taxable_value, tolerance),
        "total_tax": amount_equal(gstr2b.total_tax, purchase.total_tax, tolerance),
        "tax_head_wise": all(
            amount_equal(getattr(gstr2b, field_name), getattr(purchase, field_name), tolerance)
            for field_name in ("igst", "cgst", "sgst", "cess")
        ),
    }
    mismatches = [name for name, ok in checks.items() if not ok]
    return sum(1 for ok in checks.values() if ok), mismatches


def reconcile(
    gstr2b_records: Iterable[NormalizedInvoice],
    purchase_records: Iterable[NormalizedInvoice],
    tolerance: float = 1.0,
) -> list[MatchResult]:
    gstr2b = list(gstr2b_records)
    purchase = list(purchase_records)
    results: list[MatchResult] = []
    used_purchase: set[int] = set()
    used_gstr2b: set[int] = set()

    purchase_by_date_key: dict[tuple[str, str, str, str], list[int]] = {}
    purchase_by_identity: dict[tuple[str, str, str], list[int]] = {}
    for index, record in enumerate(purchase):
        purchase_by_date_key.setdefault(record.date_key(), []).append(index)
        purchase_by_identity.setdefault(record.identity_key(), []).append(index)

    for g_index, g_record in enumerate(gstr2b):
        candidates = [idx for idx in purchase_by_date_key.get(g_record.date_key(), []) if idx not in used_purchase]
        exact_idx = None
        partial_idx = None
        partial_mismatches: list[str] = []
        for p_index in candidates:
            p_record = purchase[p_index]
            score, mismatches = compare_records(g_record, p_record, tolerance)
            if score == 7:
                exact_idx = p_index
                break
            if score >= 4 and partial_idx is None:
                partial_idx = p_index
                partial_mismatches = mismatches
        if exact_idx is not None:
            used_gstr2b.add(g_index)
            used_purchase.add(exact_idx)
            results.append(
                MatchResult(
                    "Exact Match",
                    100,
                    g_record,
                    purchase[exact_idx],
                    [],
                    "Claim ITC if otherwise eligible.",
                    "All GSTN-style parameters match within tolerance.",
                )
            )
        elif partial_idx is not None:
            used_gstr2b.add(g_index)
            used_purchase.add(partial_idx)
            results.append(
                MatchResult(
                    "Amount / Tax Mismatch",
                    75,
                    g_record,
                    purchase[partial_idx],
                    partial_mismatches,
                    "Review amount and tax heads before claiming ITC.",
                    f"Identity fields match, but {', '.join(partial_mismatches)} differs beyond tolerance.",
                )
            )

    for g_index, g_record in enumerate(gstr2b):
        if g_index in used_gstr2b:
            continue
        identity_candidates = [idx for idx in purchase_by_identity.get(g_record.identity_key(), []) if idx not in used_purchase]
        if not identity_candidates:
            continue
        best_idx = max(identity_candidates, key=lambda idx: compare_records(g_record, purchase[idx], tolerance)[0])
        score, mismatches = compare_records(g_record, purchase[best_idx], tolerance)
        if score >= 5:
            used_gstr2b.add(g_index)
            used_purchase.add(best_idx)
            results.append(
                MatchResult(
                    "Partial Match",
                    70,
                    g_record,
                    purchase[best_idx],
                    mismatches,
                    "Check invoice date or value differences, then decide claim or hold.",
                    f"Supplier, document type, and document number match, but {', '.join(mismatches)} differs.",
                )
            )

    for g_index, g_record in enumerate(gstr2b):
        if g_index in used_gstr2b:
            continue
        best_idx = None
        best_score = -1
        best_mismatches: list[str] = []
        for p_index, p_record in enumerate(purchase):
            if p_index in used_purchase:
                continue
            score, mismatches = compare_records(g_record, p_record, tolerance)
            if score > best_score:
                best_idx = p_index
                best_score = score
                best_mismatches = mismatches
        if best_idx is not None and best_score >= 5:
            used_gstr2b.add(g_index)
            used_purchase.add(best_idx)
            results.append(
                MatchResult(
                    "Probable Match",
                    55 + best_score * 5,
                    g_record,
                    purchase[best_idx],
                    best_mismatches,
                    "Senior review required before claim.",
                    f"{best_score} of 7 GSTN-style parameters match. Review formatting, GSTIN, and document details.",
                )
            )

    for g_index, g_record in enumerate(gstr2b):
        if g_index not in used_gstr2b:
            results.append(
                MatchResult(
                    "In GSTR-2B not in PR",
                    0,
                    g_record,
                    None,
                    ["missing_in_purchase_register"],
                    "Check whether purchase entry is missing, booked in another period, or ineligible.",
                    "Supplier reported the document, but it was not found in the purchase register.",
                )
            )

    for p_index, p_record in enumerate(purchase):
        if p_index not in used_purchase:
            results.append(
                MatchResult(
                    "In PR not in GSTR-2B",
                    0,
                    None,
                    p_record,
                    ["missing_in_gstr2b"],
                    "Hold ITC or follow up with vendor unless it appears in another period.",
                    "The purchase register has this document, but it was not found in GSTR-2B.",
                )
            )

    return results


def summarize(results: Iterable[MatchResult]) -> dict[str, int]:
    summary: dict[str, int] = {}
    for result in results:
        summary[result.category] = summary.get(result.category, 0) + 1
    return summary

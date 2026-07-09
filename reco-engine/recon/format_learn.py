"""
format_learn.py — layout-template cache + one-shot LLM format learner for the
PDF → Bank Statement extractor.

Deterministic extraction stays PRIMARY. This module adds two cheap, bounded things:

  1. A cache of **column-tag templates** keyed by a stable layout signature
     (bank + header token set). A format is only ever figured out once — every
     later PDF of that layout reuses the template at $0 (the TWIX pattern).

  2. A single **Claude Haiku** call that infers each column's semantics + the
     amount mode from a tiny sample (headers + ~10 rows) when deterministic
     tagging fails. Cost is O(number of distinct formats), not O(PDFs/rows).

No heavy deps — urllib + the Anthropic Messages API (tool-use for structured
output), consistent with the rest of this codebase. Template JSON shape is
inspired by pdf_statement_reader; the geometry (column x-ranges) stays
deterministic — the LLM only supplies column *meaning*.
"""
import os
import re
import json
import hashlib
import logging

logger = logging.getLogger(__name__)

TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "format_templates")

_VALID_TAGS = {"date", "narr", "ref", "debit", "credit", "amount", "drcr", "balance", "other"}


def norm(s) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", str(s or "").lower()).split())


def layout_signature(bank: str, headers: list) -> str:
    """Stable per-format key: bank + the sorted set of (normalised) header labels.
    Header-based (not x-based) so it matches across PDFs of the same format even
    when page geometry shifts slightly."""
    toks = sorted(h for h in (norm(x) for x in headers) if h)
    raw = norm(bank) + "|" + "|".join(toks)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


def load_template(sig: str):
    try:
        with open(os.path.join(TEMPLATE_DIR, sig + ".json"), encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def save_template(sig: str, tmpl: dict) -> bool:
    try:
        os.makedirs(TEMPLATE_DIR, exist_ok=True)
        with open(os.path.join(TEMPLATE_DIR, sig + ".json"), "w", encoding="utf-8") as fh:
            json.dump(tmpl, fh, indent=2, ensure_ascii=False)
        return True
    except Exception as e:
        logger.warning("save_template failed: %s", e)
        return False


_TEMPLATE_TOOL = {
    "name": "emit_column_template",
    "description": "Report the semantic type of each column of a bank / credit-card statement "
                   "transaction table, and how amounts are represented.",
    "input_schema": {
        "type": "object",
        "properties": {
            "columns": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "header": {"type": "string", "description": "the column header text, verbatim"},
                        "tag": {"type": "string", "enum": sorted(_VALID_TAGS)},
                    },
                    "required": ["header", "tag"],
                },
            },
            "amount_mode": {
                "type": "string",
                "enum": ["debit_credit", "amount_drcr_flag", "amount_only"],
                "description": "debit_credit = separate debit & credit columns; "
                               "amount_drcr_flag = one amount column + a DR/CR flag column; "
                               "amount_only = one amount column with the sign embedded.",
            },
            "primary_date_header": {"type": "string"},
        },
        "required": ["columns", "amount_mode", "primary_date_header"],
    },
}


def learn_template(bank: str, header_texts: list, sample_rows: list,
                   api_key: str, model: str = "claude-haiku-4-5", timeout: int = 45):
    """ONE Haiku call: given the column headers (in order) + a few sample data rows,
    return each column's semantic tag + the amount mode + the primary date header.
    Returns a dict (columns/amount_mode/primary_date_header/bank) or None. The LLM
    supplies only column *meaning*; column geometry stays deterministic."""
    if not api_key or not header_texts:
        return None
    import urllib.request
    import ssl

    hdr = " | ".join(str(h) for h in header_texts)
    rows = "\n".join(" | ".join(str(c) for c in r) for r in sample_rows[:10])
    prompt = (
        "Map the columns of an Indian bank or credit-card statement transaction table.\n\n"
        f"Column headers (in order):\n{hdr}\n\n"
        f"Sample data rows (same column order):\n{rows}\n\n"
        "For EACH header assign one tag: date, narr (description/particulars/remarks), "
        "ref (cheque/reference no), debit (money out/withdrawal), credit (money in/deposit), "
        "amount (a single signed amount column), drcr (a DR/CR direction flag), "
        "balance (running balance), or other. Then give amount_mode and the primary "
        "transaction-date header. Use the tool to reply."
    )
    body = json.dumps({
        "model": model,
        "max_tokens": 1024,
        "tools": [_TEMPLATE_TOOL],
        "tool_choice": {"type": "tool", "name": "emit_column_template"},
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = ssl.create_default_context()
    try:
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
            "content-type": "application/json", "x-api-key": api_key, "anthropic-version": "2023-06-01",
        })
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        logger.warning("learn_template call failed: %s: %s", type(e).__name__, str(e)[:150])
        return None
    if data.get("stop_reason") == "refusal":
        return None
    for blk in data.get("content", []):
        if blk.get("type") == "tool_use" and blk.get("name") == "emit_column_template":
            inp = blk.get("input") or {}
            cols = inp.get("columns")
            if not cols:
                return None
            for c in cols:
                if c.get("tag") not in _VALID_TAGS:
                    c["tag"] = "other"
            return {
                "columns": cols,
                "amount_mode": inp.get("amount_mode"),
                "primary_date_header": inp.get("primary_date_header"),
                "bank": bank,
                "source": "llm",
            }
    return None

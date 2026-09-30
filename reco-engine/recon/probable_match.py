"""
probable_match.py — the LAST step of GSTR-2B vs Books: pair what is still unmatched
by vendor + amount.

Runs after every other pass (1A … 2.6, Pass 5 remarks and, on multi-state runs, the
cross-state Remark 3). It only ever looks at rows whose final status is

    "Showing in 2B but Not in Books"    (a 2B row, no Books row)
    "Showing in Books but Not in 2B"    (a Books row, no 2B row)

and that carry no cross-state Remark 3. Matched, Amount Mismatch, Partially Matched —
anything an earlier pass settled — is never read or changed.

A 2B row and a Books row pair when
  * vendor is the same:  GSTIN when both sides have one (decisive either way);
                         otherwise the supplier name, compared without case, spacing,
                         punctuation or legal-form words (Pvt, Ltd, LLP, M/s …);
  * taxable value agrees within ±₹1, on the same side (a credit note never pairs
    with an invoice);
  * invoice numbers DIFFER — that is why every earlier pass left them unmatched.

The pairing is decided by the code whenever it can: equal tax, then nearest date,
then the more similar document number break ties among candidates. Gemini is asked
ONLY when the code cannot decide — two candidates that are equally good, or two names
that may or may not be the same vendor. Its answer is accepted only if it picks
among the candidates it was shown; no key, no answer, or anything else leaves the
rows unmatched exactly as they were.

A pair becomes one row, status "Probable Match" (or "Probable Match (AI)" when
Gemini chose), with a Remark 2 saying what differs — invoice numbers, the date gap,
any tax difference — so the accountant verifies it rather than trusting it blindly.
"""
from __future__ import annotations

import logging
import os
import re
from datetime import date
from difflib import SequenceMatcher
from typing import Any

from .core import MatchResult

logger = logging.getLogger(__name__)

UNMATCHED_2B = "Showing in 2B but Not in Books"
UNMATCHED_BK = "Showing in Books but Not in 2B"
PROBABLE = "Probable Match"
PROBABLE_AI = "Probable Match (AI)"

AMOUNT_TOL = 1.0          # ±₹1 on taxable value, as the accountant asked
_LEGAL = {"private", "pvt", "limited", "ltd", "llp", "llc", "inc", "company", "co",
          "corporation", "corp", "the", "and", "ms", "m", "s"}


# Trade words many unrelated vendors share — never enough on their own to suspect a match.
_GENERIC = {
    "traders", "trading", "trader", "enterprise", "enterprises", "industries", "industry",
    "fashion", "fashions", "textile", "textiles", "fabrics", "fabric", "garments", "garment",
    "creation", "creations", "exports", "export", "imports", "international", "india",
    "sales", "services", "service", "solutions", "agency", "agencies", "store", "stores",
    "mart", "overseas", "impex", "group", "global", "retail", "clothing", "apparels",
    "apparel", "process", "processors", "works", "packaging", "logistics", "digital",
    "technologies", "technology", "tech", "marketing", "distributors", "suppliers",
    "brothers", "sons", "associates", "corporation", "shree", "shri", "sri",
}


def ai_enabled() -> bool:
    return str(os.environ.get("PROBABLE_MATCH_AI", "1")).strip().lower() not in ("0", "false", "no", "off")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _v(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _gstin(rec) -> str:
    return re.sub(r"[^0-9A-Z]", "", str(_v(rec, "supplier_gstin", "") or "").upper())


def _name_tokens(name: str) -> list[str]:
    s = str(name or "").lower().replace("&", " and ")
    s = re.sub(r"\bm\s*/\s*s\b", " ", s)                  # M/s, M / S
    words = re.sub(r"[^a-z0-9]", " ", s).split()
    return [w for w in words if w not in _LEGAL]


def _compact(name: str) -> str:
    return "".join(_name_tokens(name))


def _days(a: str, b: str) -> int | None:
    try:
        return abs((date.fromisoformat(str(a)[:10]) - date.fromisoformat(str(b)[:10])).days)
    except Exception:
        return None


def _tax(rec) -> float:
    return round(sum(abs(float(_v(rec, f, 0) or 0)) for f in ("igst", "cgst", "sgst", "cess")), 2)


def _num_similarity(a: str, b: str) -> float:
    """How alike two document numbers look (tie-break only — never a reason to pair)."""
    na, nb = re.sub(r"[^0-9A-Z]", "", str(a).upper()), re.sub(r"[^0-9A-Z]", "", str(b).upper())
    if not na or not nb:
        return 0.0
    sa = (re.findall(r"\d+", na) or [""])[-1].lstrip("0")
    sb = (re.findall(r"\d+", nb) or [""])[-1].lstrip("0")
    serial = 1.0 if sa and sa == sb else 0.0
    return round(0.6 * serial + 0.4 * SequenceMatcher(None, na, nb).ratio(), 3)


def _vendor(g, b, party_sim) -> str:
    """'gstin' / 'name' = same vendor, decided by code; 'unsure' = ask Gemini;
    '' = different vendors."""
    gg, bg = _gstin(g), _gstin(b)
    if gg and bg:
        return "gstin" if gg == bg else ""
    gn, bn = str(_v(g, "supplier_name", "") or ""), str(_v(b, "supplier_name", "") or "")
    if not gn.strip() or not bn.strip():
        return ""
    if _compact(gn) and _compact(gn) == _compact(bn):
        return "name"
    if party_sim(gn, bn) >= 0.5:
        return "name"
    # Not provably the same, not provably different -> Gemini decides. "Maybe" means the
    # names are close as a whole, open alike, or share a DISTINCTIVE word (Ganesh, Resham)
    # — never just a trade word (Traders, Fashion) that unrelated vendors share.
    ca, cb = _compact(gn), _compact(bn)
    ta, tb = _name_tokens(gn), _name_tokens(bn)
    close = SequenceMatcher(None, ca, cb).ratio() >= 0.7 if ca and cb else False
    lead = bool(ta and tb and (ta[0][:4] == tb[0][:4]) and min(len(ta[0]), len(tb[0])) >= 3)
    da = {w for w in ta if len(w) >= 4 and w not in _GENERIC}
    db = {w for w in tb if len(w) >= 4 and w not in _GENERIC}
    shared = bool(da & db)
    return "unsure" if (close or lead or shared) else ""


def _side_ok(g, b) -> bool:
    """Same side of the ledger: invoice with invoice, credit with credit. A 2B debit
    note (stored positive) is left to Pass 2.6, which pairs it on opposing signs."""
    if str(_v(g, "doc_type", "")) == "DBN":
        return False
    gt, bt = float(_v(g, "taxable_value", 0) or 0), float(_v(b, "taxable_value", 0) or 0)
    if gt == 0 or bt == 0:
        return False
    return (gt > 0) == (bt > 0)


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------

def apply_probable_matches(results: list, party_sim, tolerance: float = AMOUNT_TOL,
                           use_ai: bool | None = None) -> tuple[list, dict]:
    """Return (results, stats). ``results`` keeps its order: each new pair takes the
    place of its 2B row, and its Books row is removed. Rows that do not pair are
    returned untouched."""
    use_ai = ai_enabled() if use_ai is None else use_ai
    stats = {"pairs_code": 0, "pairs_ai": 0, "ai_calls": 0, "ai_groups": 0, "left_unsure": 0}

    g_rows, b_rows = [], []
    for i, r in enumerate(results):
        if str(_v(r, "suggested_action_3", "") or "").strip():
            continue                                   # explained by the cross-state check
        status = _v(r, "suggested_action", "")
        g, b = _v(r, "gstr2b"), _v(r, "purchase")
        if status == UNMATCHED_2B and g is not None and b is None:
            g_rows.append(i)
        elif status == UNMATCHED_BK and b is not None and g is None:
            b_rows.append(i)
    if not g_rows or not b_rows:
        return results, stats

    # Candidate edges: same vendor (or unsure), taxable within ±₹1, same side.
    by_amount: dict[int, list[int]] = {}
    for bi in b_rows:
        amt = abs(float(_v(results[bi].purchase, "taxable_value", 0) or 0))
        by_amount.setdefault(int(round(amt)), []).append(bi)

    edges: dict[tuple[int, int], dict] = {}
    for gi in g_rows:
        g = results[gi].gstr2b
        gamt = abs(float(_v(g, "taxable_value", 0) or 0))
        near = set()
        for k in (int(round(gamt)) - 1, int(round(gamt)), int(round(gamt)) + 1):
            near.update(by_amount.get(k, []))
        for bi in near:
            b = results[bi].purchase
            if abs(gamt - abs(float(_v(b, "taxable_value", 0) or 0))) > tolerance + 1e-9:
                continue
            if not _side_ok(g, b):
                continue
            g_raw, b_raw = _v(g, "raw", {}) or {}, _v(b, "raw", {}) or {}
            # multi-state: a pair across two state FILES is the cross-state check's job
            if (not b_raw.get("_books_shared") and g_raw.get("_file_idx") is not None
                    and b_raw.get("_file_idx") is not None
                    and g_raw.get("_file_idx") != b_raw.get("_file_idx")):
                continue
            basis = _vendor(g, b, party_sim)
            if not basis:
                continue
            gap = _days(_v(g, "doc_date", ""), _v(b, "doc_date", ""))
            edges[(gi, bi)] = {
                "basis": basis,
                "tax_eq": abs(_tax(g) - _tax(b)) <= tolerance,
                "gap": gap if gap is not None else 10 ** 5,
                "num": _num_similarity(_v(g, "doc_no", ""), _v(b, "doc_no", "")),
            }
    if not edges:
        return results, stats

    def key(e):
        return (1 if e["tax_eq"] else 0, -e["gap"], e["num"])

    # Code decides: strongest certain edge first; an edge is ambiguous when another
    # still-open edge on the same 2B row or the same Books row is exactly as strong.
    certain = sorted(((k, e) for k, e in edges.items() if e["basis"] != "unsure"),
                     key=lambda kv: key(kv[1]), reverse=True)
    by_g: dict[int, list] = {}
    by_b: dict[int, list] = {}
    for kk, ee in certain:
        by_g.setdefault(kk[0], []).append((kk, ee))
        by_b.setdefault(kk[1], []).append((kk, ee))
    used_g, used_b = set(), set()
    pairs: list[tuple[int, int, str, str]] = []           # (gi, bi, how, ai_reason)
    ambiguous: set[int] = set()                            # 2B rows for Gemini
    for (gi, bi), e in certain:
        if gi in used_g or bi in used_b or gi in ambiguous:
            continue
        k = key(e)
        rivals = [kk for kk, ee in by_g.get(gi, []) if kk != (gi, bi) and kk[1] not in used_b and key(ee) == k]
        rivals += [kk for kk, ee in by_b.get(bi, []) if kk != (gi, bi) and kk[0] not in used_g and key(ee) == k]
        if rivals:
            ambiguous.add(gi)
            ambiguous.update(kk[0] for kk in rivals)
            continue
        used_g.add(gi)
        used_b.add(bi)
        pairs.append((gi, bi, "code", ""))
    stats["pairs_code"] = len(pairs)

    # Gemini: ambiguous rows + unsure-vendor edges still open.
    groups = _ai_groups(edges, used_g, used_b, ambiguous)
    stats["ai_groups"] = len(groups)
    if groups and use_ai:
        picked, calls = _ask_gemini(groups, results, edges)
        stats["ai_calls"] = calls
        for gi, bi, reason in picked:
            if gi in used_g or bi in used_b:
                continue
            used_g.add(gi)
            used_b.add(bi)
            pairs.append((gi, bi, "ai", reason))
            stats["pairs_ai"] += 1
    stats["left_unsure"] = sum(1 for grp in groups for gi in grp["g"] if gi not in used_g)

    if not pairs:
        return results, stats

    # Row order in the output: every settled row exactly where it was, then ALL the
    # Probable Match rows together (code-picked, then AI-picked, each in 2B order),
    # then whatever is still unmatched in its original order (2B-only, Books-only).
    paired = {i for gi, bi, _h, _r in pairs for i in (gi, bi)}
    ordered = sorted(pairs, key=lambda p: (p[2] == "ai", p[0]))
    probable_rows = [_make_pair(results[gi], results[bi], edges[(gi, bi)], how, reason, tolerance)
                     for gi, bi, how, reason in ordered]
    unmatched = {UNMATCHED_2B, UNMATCHED_BK}
    settled = [r for i, r in enumerate(results) if _v(r, "suggested_action", "") not in unmatched]
    rest = [r for i, r in enumerate(results)
            if _v(r, "suggested_action", "") in unmatched and i not in paired]
    return settled + probable_rows + rest, stats


def _ai_groups(edges, used_g, used_b, ambiguous) -> list[dict]:
    """Connected groups of still-open edges the code could not settle."""
    open_edges = [k for k, e in edges.items()
                  if k[0] not in used_g and k[1] not in used_b
                  and (e["basis"] == "unsure" or k[0] in ambiguous)]
    parent: dict[tuple, tuple] = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for gi, bi in open_edges:
        parent[find(("g", gi))] = find(("b", bi))
    comps: dict[tuple, dict] = {}
    for gi, bi in open_edges:
        c = comps.setdefault(find(("g", gi)), {"g": set(), "b": set(), "edges": []})
        c["g"].add(gi)
        c["b"].add(bi)
        c["edges"].append((gi, bi))
    return [c for c in comps.values() if len(c["edges"]) <= 40]


def _ask_gemini(groups, results, edges) -> tuple[list[tuple[int, int, str]], int]:
    from . import gemini_client
    if not gemini_client.available():
        return [], 0
    import json
    picked: list[tuple[int, int, str]] = []
    calls = 0
    for start in range(0, len(groups), 25):                # ≤25 groups per call
        chunk = groups[start:start + 25]
        payload = []
        for gid, grp in enumerate(chunk):
            def row(rec, ref):
                return {"ref": ref, "vendor": _v(rec, "supplier_name", ""), "gstin": _gstin(rec),
                        "doc_no": _v(rec, "doc_no", ""), "date": _v(rec, "doc_date", ""),
                        "taxable": _v(rec, "taxable_value", 0), "tax": _tax(rec)}
            payload.append({
                "group": gid,
                "gstr2b": [row(results[gi].gstr2b, f"G{gi}") for gi in sorted(grp["g"])],
                "books": [row(results[bi].purchase, f"B{bi}") for bi in sorted(grp["b"])],
                "allowed_pairs": [[f"G{gi}", f"B{bi}"] for gi, bi in grp["edges"]],
            })
        prompt = (
            "You reconcile an Indian GST purchase: GSTR-2B (what suppliers filed) against the "
            "buyer's Books. Every row below is still UNMATCHED; within each group the taxable "
            "values already agree within Rs 1, but the invoice numbers differ, so rules could not "
            "decide. For each group, pick the pairs that are the SAME supplier document. Same "
            "vendor means the same business even if written differently (case, Pvt/Ltd, M/s, "
            "abbreviations, spacing); different businesses that merely share a word are NOT the "
            "same. Prefer the nearest date and a similar document number. Each row may be used at "
            "most once. Only choose from allowed_pairs. When unsure, leave it out.\n\n"
            f"{json.dumps(payload, ensure_ascii=False, default=str)}\n\n"
            'Return JSON: {"pairs":[{"g":"G..","b":"B..","reason":"<10 words>"}]}'
        )
        reply = gemini_client.generate_json(prompt, max_tokens=4096, timeout=90)
        calls += 1
        if not isinstance(reply, dict):
            continue
        allowed = {(gi, bi) for grp in chunk for gi, bi in grp["edges"]}
        for p in reply.get("pairs") or []:
            try:
                gi, bi = int(str(p["g"]).lstrip("G")), int(str(p["b"]).lstrip("B"))
            except Exception:
                continue
            if (gi, bi) in allowed:
                picked.append((gi, bi, str(p.get("reason") or "")[:120]))
    return picked, calls


def _make_pair(g_res, b_res, edge, how, reason, tolerance) -> MatchResult:
    g, b = g_res.gstr2b, b_res.purchase
    mismatches = [f for f in ("taxable_value", "igst", "cgst", "sgst")
                  if abs(float(_v(g, f, 0) or 0) - float(_v(b, f, 0) or 0)) > tolerance]
    status = PROBABLE_AI if how == "ai" else PROBABLE
    basis = {"gstin": "same GSTIN", "name": "same vendor name", "unsure": "vendor name"}[edge["basis"]]
    remarks = [f"Invoice no. differs (2B: {_v(g, 'doc_no', '')} / Books: {_v(b, 'doc_no', '')}) — "
               f"{basis} and taxable value match (±₹{tolerance:g}); verify"]
    if edge["gap"] and edge["gap"] < 10 ** 5:
        remarks.append(f"Dates {edge['gap']} day{'s' if edge['gap'] != 1 else ''} apart")
    if not edge["tax_eq"]:
        remarks.append(f"Tax differs by ₹{abs(_tax(g) - _tax(b)):,.2f}")
    if how == "ai":
        remarks.append("Picked by AI" + (f": {reason}" if reason else ""))
    # keep any observation the earlier passes had already made on either row
    for prev in (_v(g_res, "suggested_action_2", ""), _v(b_res, "suggested_action_2", "")):
        for tag in str(prev or "").split(","):
            tag = tag.strip()
            if tag and tag not in remarks:
                remarks.append(tag)
    res = MatchResult(
        category=status,
        confidence=50 if how == "ai" else 60,
        gstr2b=g,
        purchase=b,
        mismatch_fields=mismatches,
        suggested_action=status,
        explanation=("Paired after all other passes: " + basis + " and taxable value match, "
                     "invoice numbers differ." + (" Chosen by AI among equal candidates." if how == "ai" else "")),
    )
    res.suggested_action_2 = ", ".join(remarks)
    res.suggested_action_3 = ""
    return res

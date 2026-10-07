"""GST Summary of the Sales Register — state-wise and month-wise, in the accountant's layout.

Built for the GSTR-3B vs Books agent. The Books side follows the accountant's own
working (FY 25-26 GST Summary, Global Fashion Off Duty):

  * **Input blocks.** One upload may hold several blocks stacked on one sheet with
    one or two blank lines between them — the Tally Sales Register, then extra
    ledgers (store sales, another state's sales, credit notes) each with its own
    header row. Every block is read with its own columns; a Grand Total row closes
    a block and is kept for the tie-out.
  * **Nature.** "Sales" / "Returns" (a Nature column, else the voucher type: a
    Credit Note is a return). Returns are shown as positive figures and deducted.
  * **State = the state of the tax columns.** Ledgers named for a state ("Output
    CGST Haryana 2.5%", "Output IGST BLR 5%") put the row in that state; untagged
    tax ledgers belong to the home registration. A row with no tax, or a block with
    only plain CGST/SGST/IGST columns, takes the State column. Rows where the State
    field says something else are listed, not silently changed.
  * **Interbranch Services** are shown on their own and added back only in the
    total that reconciles to the register.
  * **Net Value** = every sales ledger column + Round Off (excl. GST).
"""
from __future__ import annotations

import logging
import re
from collections import Counter, defaultdict
from datetime import datetime
from io import BytesIO

from openpyxl import load_workbook

from .core import round_money
from .gstr_1_multistate import _CITY_STATE, _STATE_TAGS, _base_state
from .gstr_1_vs_books import _FY_MONTHS, _classify_tally_ledger, _f
from .gstr_2b_books import GST_STATE_CODES, _state_from_voucher_type
from .parsers import normalize_header

logger = logging.getLogger(__name__)

TAX = ("cgst", "sgst", "igst")
AMT = ("net", "cgst", "sgst", "igst")
CATS = ("sales", "interbranch", "returns")

_HEADER_HINTS = {"particulars", "buyer", "voucher type", "voucher no", "nature", "state", "narration",
                 "gross total", "net value excl gst", "net value", "cgst", "sgst", "igst", "source", "value"}
# Columns that are never an amount of the row even though they are numeric or named
# like a ledger (helper / check / flag / gross columns an accountant adds).
_NOT_AMOUNT_RE = re.compile(r"gross|check|flag|^total|eff\.? ?state|state field|month|^rows?$|^s\.? ?no|quantity|qty|rate",
                            re.I)
_INTERBRANCH_RE = re.compile(r"inter[\s-]*branch|branch\s*transfer|stock\s*transfer", re.I)
_RETURN_RE = re.compile(r"return|credit\s*note|\brto\b", re.I)
_TOTAL_LABELS = {"grand total", "total", "sub total", "subtotal"}
# Amount columns that name no ledger — an added block's lines are named by their Source.
_GENERIC_AMOUNT = {"net value excl gst", "net value", "taxable value", "net amount", "value", "amount"}
_STATE_NAMES = {_base_state(n): n for n in GST_STATE_CODES.values()}
_KA_ALIAS = {"karnataka": "Karnataka"}


def _canon_state(text) -> str:
    """'Bangalore' → 'Karnataka', 'HAR' → 'Haryana', '27-Maharashtra' → 'Maharashtra'."""
    raw = str(text or "").strip()
    if not raw:
        return ""
    t = re.sub(r"^\d{1,2}\s*[-–]\s*", "", raw)
    if _base_state(t) in _STATE_NAMES:
        return _STATE_NAMES[_base_state(t)]
    low = t.lower()
    if low in _CITY_STATE:
        return _CITY_STATE[low]
    if t.upper() in _STATE_TAGS:
        return GST_STATE_CODES.get(_STATE_TAGS[t.upper()], "")
    named = _state_from_voucher_type(t)
    return named or ""


def _header_state_tag(header: str) -> str:
    """State named inside a ledger column header ('Output CGST BLR 6%' → Karnataka)."""
    for tok in [t for t in re.split(r"[\s\-_/()%.,\d]+", str(header or "")) if t]:
        if tok.upper() in _STATE_TAGS or tok.lower() in _CITY_STATE:
            st = _canon_state(tok)
            if st:
                return st
        if _base_state(tok) in _STATE_NAMES and len(tok) > 3:
            return _STATE_NAMES[_base_state(tok)]
    named = _state_from_voucher_type(str(header or ""))
    return named or ""


def _as_date(v):
    if isinstance(v, datetime):
        return v
    if v is None:
        return None
    s = str(v).strip()
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%b-%y", "%d-%b-%Y", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s[:19], fmt)
        except Exception:
            continue
    return None


def _is_header(cells: list) -> bool:
    norm = [normalize_header(c) for c in cells if c is not None and str(c).strip()]
    return "date" in norm and sum(1 for n in norm if n in _HEADER_HINTS or n.startswith("output")) >= 2


# ---------------------------------------------------------------------------
# Reading — every block of every sheet of every file
# ---------------------------------------------------------------------------

def read_books(items: list[dict], cn_items: list[dict] | None = None) -> dict:
    rows: list[dict] = []
    blocks: list[dict] = []
    for kind, group in (("register", items), ("credit_note", cn_items or [])):
        for item in group:
            try:
                wb = load_workbook(BytesIO(item["content"]), data_only=True, read_only=True)
            except Exception as e:
                raise ValueError(f"{item.get('filename')}: could not open ({e})")
            for ws in wb.worksheets:
                _read_sheet(ws, item.get("filename") or "file", kind, rows, blocks)
    if not rows:
        raise ValueError("No Sales Register rows found — the sheet needs a header row with Date plus "
                         "Particulars / Voucher Type / Nature / tax columns.")
    _assign_states(rows, blocks)
    return {"rows": rows, "blocks": blocks}


def _read_sheet(ws, fname, kind, rows, blocks):
    header = None
    block = None
    for rnum, cells in enumerate(ws.iter_rows(values_only=True), 1):
        cells = list(cells)
        if not any(c is not None and str(c).strip() for c in cells):
            continue                                     # the gap between blocks
        if _is_header(cells):
            header = [str(c).strip() if c is not None else "" for c in cells]
            block = _new_block(header, fname, ws.title, rnum, kind)
            blocks.append(block)
            continue
        if header is None:
            continue                                     # title rows above the first header
        rec = {header[i]: cells[i] for i in range(min(len(header), len(cells))) if header[i]}
        label = " ".join(str(rec.get(c) or "") for c in (block["part_col"], block["source_col"]) if c).strip().lower()
        first = str(cells[0] or "").strip().lower()
        if label in _TOTAL_LABELS or first in _TOTAL_LABELS or "grand total" in label:
            block["grand_total"] = _row_amounts(rec, block)
            block["grand_total_row"] = rnum
            block["_gt_raw"] = {h: _f(rec.get(h)) for h, _k, _t in block["cols"]}
            continue
        dt = _as_date(rec.get(block["date_col"]))
        amts = _row_amounts(rec, block)
        if dt is None and not any(abs(v) > 0 for v in amts.values()):
            continue
        rows.append(_make_row(rec, amts, dt, block, rnum))
        block["n_rows"] += 1


def _new_block(header, fname, sheet, rnum, kind):
    norm = {normalize_header(h): h for h in header if h}

    def find(*cands):
        for c in cands:
            if normalize_header(c) in norm:
                return norm[normalize_header(c)]
        return None

    cols = []
    for h in header:
        if not h:
            continue
        n = normalize_header(h)
        if _NOT_AMOUNT_RE.search(n) or _INTERBRANCH_RE.search(n) and "flag" in n:
            continue
        if n in ("round off", "rounding off"):
            cols.append((h, "net", ""))
            continue
        k = _classify_tally_ledger(h)
        if n in ("net value excl gst", "net value", "taxable value", "net amount"):
            k = "taxable"
        if not k:
            continue
        kind_ = "net" if k == "taxable" else k
        cols.append((h, kind_, _header_state_tag(h) if kind_ in TAX else ""))
    tagged = any(tag for _, k, tag in cols if k in TAX)
    return {
        "file": fname, "sheet": sheet, "header_row": rnum, "kind": kind, "cols": cols,
        "tagged_tax": tagged, "n_rows": 0, "grand_total": None, "grand_total_row": None,
        "date_col": find("Date", "Voucher Date", "Invoice Date"),
        "part_col": find("Particulars", "Party Name", "Buyer"),
        "state_col": find("State", "States", "Branch", "Location"),
        "nature_col": find("Nature", "Nature of Transaction", "Transaction Type"),
        "vt_col": find("Voucher Type", "Vch Type"),
        "narr_col": find("Narration"),
        "source_col": find("Source"),
        "flag_col": find("Interbranch flag", "Interbranch"),
        "gross_col": find("Gross Total", "Ledger Gross Total"),
        "interbranch_cols": [h for h in header if h and _INTERBRANCH_RE.search(h) and "flag" not in h.lower()],
        "label": f"{fname} · {sheet} (header row {rnum})",
    }


def _row_amounts(rec, block) -> dict:
    out = {k: 0.0 for k in AMT}
    for h, k, _tag in block["cols"]:
        out[k] += _f(rec.get(h))
    return out


def _make_row(rec, amts, dt, block, rnum) -> dict:
    nature_raw = str(rec.get(block["nature_col"]) or "").strip() if block["nature_col"] else ""
    vt = str(rec.get(block["vt_col"]) or "").strip() if block["vt_col"] else ""
    if block["kind"] == "credit_note":
        nature = "Returns"
    elif nature_raw:
        nature = "Returns" if _RETURN_RE.search(nature_raw) else "Sales"
    else:
        nature = "Returns" if re.search(r"credit\s*note", vt, re.I) else "Sales"
    tag_tax = defaultdict(float)
    untagged_tax = 0.0
    for h, k, tag in block["cols"]:
        if k in TAX:
            v = abs(_f(rec.get(h)))
            if not v:
                continue
            if tag:
                tag_tax[tag] += v
            else:
                untagged_tax += v
    flag = str(rec.get(block["flag_col"]) or "").strip().lower() if block["flag_col"] else ""
    interbranch = flag == "interbranch" or any(abs(_f(rec.get(c))) > 0 for c in block["interbranch_cols"])
    gross = _f(rec.get(block["gross_col"])) if block["gross_col"] else None
    src_name = (str(rec.get(block["source_col"]) or "").strip() if block["source_col"] else "") or block["sheet"]
    ledger_by_col = {(src_name if normalize_header(h) in _GENERIC_AMOUNT else h): _f(rec.get(h))
                     for h, k, _ in block["cols"] if k == "net" and abs(_f(rec.get(h))) > 0}
    return {
        "date": dt, "month": dt.strftime("%B") if dt else "", "period": dt.strftime("%Y-%m") if dt else "",
        "particulars": rec.get(block["part_col"]) if block["part_col"] else "",
        "voucher_type": vt, "narration": rec.get(block["narr_col"]) if block["narr_col"] else "",
        "source": (str(rec.get(block["source_col"]) or "").strip() if block["source_col"] else "") or
                  ("Credit Note Register" if block["kind"] == "credit_note" else "Sales Register"),
        "state_field": str(rec.get(block["state_col"]) or "").strip() if block["state_col"] else "",
        "nature": nature, "interbranch": interbranch,
        "tag_tax": dict(tag_tax), "untagged_tax": untagged_tax,
        "raw": amts, "gross": gross, "ledgers": ledger_by_col,
        "file": block["file"], "sheet": block["sheet"], "row": rnum, "block": block["label"],
        "_block": block, "_rec": rec,
    }


def _assign_states(rows, blocks):
    """State = state of the tax columns; untagged tax → home; else the Voucher Type, then
    the State field — but the State field only when it names the firm's own few
    registrations. A register whose "States" column is the customer's place of supply
    (30+ states) is not a registration column and is ignored for this."""
    by_block = defaultdict(set)
    for r in rows:
        c = _canon_state(r["state_field"])
        if c:
            by_block[id(r["_block"])].add(c)
    for b in blocks:
        b["state_is_reg"] = 0 < len(by_block.get(id(b), ())) <= 6

    def fld(r):
        return _canon_state(r["state_field"]) if r["_block"].get("state_is_reg") else ""

    def vts(r):
        return _canon_state(_state_from_voucher_type(r["voucher_type"]) or "")

    # Home registration: the State field on rows taxed only in untagged ledgers; else the
    # most common voucher-type state; else the most common registration-column value.
    votes = Counter(fld(r) for r in rows
                    if r["_block"]["tagged_tax"] and r["untagged_tax"] > 0 and not r["tag_tax"] and fld(r))
    if not votes:
        votes = Counter(vts(r) for r in rows if vts(r))
    if not votes:
        votes = Counter(fld(r) for r in rows if fld(r))
    home = votes.most_common(1)[0][0] if votes else ""
    # Display label per state = how the register itself spells it ('Bangalore').
    spell = defaultdict(Counter)
    for r in rows:
        c = fld(r)
        if c:
            spell[c][r["state_field"]] += 1
    order: list[str] = []
    for r in rows:
        if r["tag_tax"]:
            st = max(r["tag_tax"].items(), key=lambda kv: kv[1])[0]
            why = "Tax columns tagged " + st
        elif r["_block"]["tagged_tax"]:
            st, why = home, ("Untagged tax columns → home registration" if r["untagged_tax"] > 0
                             else "No tax → home registration")
            if not r["untagged_tax"] and fld(r):
                st, why = fld(r), "No tax → State field"
            elif not r["untagged_tax"] and vts(r):
                st, why = vts(r), f"No tax → Voucher type '{r['voucher_type']}'"
        elif vts(r):
            st, why = vts(r), f"Voucher type '{r['voucher_type']}'"
        elif fld(r):
            st, why = fld(r), "State field"
        else:
            st, why = home, "Home registration"
        r["state"] = st or "Unknown"
        r["state_why"] = why
        f = fld(r)
        r["state_mismatch"] = bool(f) and f != r["state"]
        if r["state"] not in order:
            order.append(r["state"])
    label = {st: (spell[st].most_common(1)[0][0] if spell.get(st) else st) for st in order}
    for r in rows:
        r["state_label"] = label.get(r["state"], r["state"])
    # Returns shown as positive figures (deducted later); sales keep their sign.
    for r in rows:
        tot = sum(r["raw"].values())
        sign = -1.0 if (r["nature"] == "Returns" and tot < 0) else 1.0
        r["amt"] = {k: round_money(sign * r["raw"][k]) for k in AMT}
        r["category"] = "returns" if r["nature"] == "Returns" else ("interbranch" if r["interbranch"] else "sales")
    return home


# ---------------------------------------------------------------------------
# Summaries
# ---------------------------------------------------------------------------

def _z():
    return {k: 0.0 for k in AMT}


def summarise(books: dict) -> dict:
    rows = books["rows"]
    labels = {r["state"]: r["state_label"] for r in rows}
    # Home registration first (the one the untagged ledgers belong to), then the rest
    # alphabetically by how the register names them — the accountant's own order.
    home_votes = Counter(r["state"] for r in rows if "home" in r["state_why"].lower())
    home = home_votes.most_common(1)[0][0] if home_votes else (rows[0]["state"] if rows else "")
    states = ([home] if home else []) + sorted((st for st in labels if st != home), key=lambda st: labels[st].lower())
    annual = {c: {s: _z() for s in states} for c in CATS}
    monthly = {c: {s: {m: _z() for m in _FY_MONTHS} for s in states} for c in CATS}
    for r in rows:
        a = annual[r["category"]][r["state"]]
        for k in AMT:
            a[k] += r["amt"][k]
            if r["month"] in _FY_MONTHS:
                monthly[r["category"]][r["state"]][r["month"]][k] += r["amt"][k]
    for c in CATS:
        for s in states:
            annual[c][s] = {k: round_money(v) for k, v in annual[c][s].items()}
            for m in _FY_MONTHS:
                monthly[c][s][m] = {k: round_money(v) for k, v in monthly[c][s][m].items()}

    def net_of(src_s, src_r):
        return {k: round_money(src_s[k] - src_r[k]) for k in AMT}

    annual["net"] = {s: net_of(annual["sales"][s], annual["returns"][s]) for s in states}
    annual["total"] = {s: {k: round_money(annual["net"][s][k] + annual["interbranch"][s][k]) for k in AMT} for s in states}
    for key, f in (("net", lambda s, m: net_of(monthly["sales"][s][m], monthly["returns"][s][m])),
                   ("total", lambda s, m: {k: round_money(monthly["sales"][s][m][k] - monthly["returns"][s][m][k]
                                                          + monthly["interbranch"][s][m][k]) for k in AMT})):
        monthly[key] = {s: {m: f(s, m) for m in _FY_MONTHS} for s in states}
    months_used = [m for m in _FY_MONTHS if any(r["month"] == m for r in rows)]

    # Ledger-wise memo (net value, sales − returns, rows)
    ledgers: dict[str, dict] = {}
    for r in rows:
        sgn = -1.0 if r["category"] == "returns" else 1.0
        for h, v in r["ledgers"].items():
            d = ledgers.setdefault(h, {"net": 0.0, "rows": 0})
            d["net"] += sgn * (abs(v) if r["category"] == "returns" else v)
            d["rows"] += 1
    ledger_memo = sorted(({"ledger": h, "net": round_money(d["net"]), "rows": d["rows"]} for h, d in ledgers.items()),
                         key=lambda x: -abs(x["net"]))

    # Source-wise memo per month (register vs the extra blocks)
    sources: list[str] = []
    for r in rows:
        if r["source"] not in sources:
            sources.append(r["source"])
    source_month = {src: {m: 0.0 for m in _FY_MONTHS} for src in sources}
    for r in rows:
        if r["month"] in _FY_MONTHS:
            sgn = -1.0 if r["category"] == "returns" else 1.0
            source_month[r["source"]][r["month"]] += sgn * r["amt"]["net"]
    source_month = {s: {m: round_money(v) for m, v in d.items()} for s, d in source_month.items()}

    return {"states": states, "labels": labels, "annual": annual, "monthly": monthly,
            "months": months_used, "ledger_memo": ledger_memo, "sources": sources,
            "source_month": source_month}


def tie_out(books: dict, summ: dict) -> dict:
    """Tie every block back to its own total row, then add the blocks up.

    Tally's Grand Total nets returns off (Sales − Returns); an accountant's added
    block usually just adds every line, credit notes included. Each block is checked
    on whichever of the two bases its own total uses, with the bridging items that
    explain the rest (a ledger cell exported with the wrong sign; Round Off)."""
    per_block = []
    for b in books["blocks"]:
        brows = [r for r in books["rows"] if r["_block"] is b]
        net_basis = _z()
        plain = _z()
        for r in brows:
            sgn = -1.0 if r["category"] == "returns" else 1.0
            for k in AMT:
                net_basis[k] += sgn * r["amt"][k]
                plain[k] += r["raw"][k]
        bridges = _bridges(brows, b)
        adjusted = {k: round_money(net_basis[k] + sum(x[k] for x in bridges)) for k in AMT}
        gt = b["grand_total"]
        basis, used, used_bridges = "Sales less Returns", adjusted, bridges
        if gt is not None:
            v_net = max(abs(adjusted[k] - gt[k]) for k in AMT)
            v_plain = max(abs(plain[k] - gt[k]) for k in AMT)
            if v_plain < v_net:
                basis, used, used_bridges = "All lines added (block total adds returns)", \
                    {k: round_money(v) for k, v in plain.items()}, []
        per_block.append({
            "label": b["label"], "rows": len(brows), "first_row": min((r["row"] for r in brows), default=None),
            "last_row": max((r["row"] for r in brows), default=None), "gt_row": b["grand_total_row"],
            "basis": basis, "sales_less_returns": {k: round_money(v) for k, v in net_basis.items()},
            "bridges": used_bridges, "compared": used,
            "grand_total": ({k: round_money(v) for k, v in gt.items()} if gt is not None else None),
            "variance": ({k: round_money(used[k] - gt[k]) for k in AMT} if gt is not None else None),
        })
    total = {k: round_money(sum(summ["annual"]["total"][s][k] for s in summ["states"])) for k in AMT}
    n_sales = sum(1 for r in books["rows"] if r["nature"] == "Sales")
    n_ret = sum(1 for r in books["rows"] if r["nature"] == "Returns")
    return {"total": total, "blocks": per_block, "n_sales": n_sales, "n_returns": n_ret,
            "n_rows": len(books["rows"])}


def _bridges(brows, block) -> list[dict]:
    bridges = []
    for r in brows:
        if r["gross"] is None:
            continue
        diff = round_money(sum(r["raw"].values()) - r["gross"])
        if abs(diff) <= 1.0:
            continue
        for h, k, _t in block["cols"]:
            if normalize_header(h) in ("round off", "rounding off"):
                continue                  # Round Off is bridged once, at block level
            v = _f(r["_rec"].get(h))
            if v and abs(abs(2 * v) - abs(diff)) <= 0.05:
                b = _z()
                b[k] = round_money(-2 * v if r["category"] != "returns" else 2 * v)
                bridges.append({"label": f"Row {r['row']} {r['particulars']}: '{h}' {v:,.2f} is carried with "
                                         "the opposite sign in the register total", **b})
                break
    ro = [h for h, k, _ in block["cols"] if normalize_header(h) in ("round off", "rounding off")]
    if ro and block.get("_gt_raw") is not None:
        rows_ro = sum((-abs(_f(r["_rec"].get(h))) if r["category"] == "returns" else _f(r["_rec"].get(h)))
                      for r in brows for h in ro)
        gt_ro = sum(block["_gt_raw"].get(h, 0.0) for h in ro)
        d = round_money(gt_ro - rows_ro)
        if abs(d) >= 0.01:
            b = _z()
            b["net"] = d
            bridges.append({"label": "Round Off ledger: register sign treatment (immaterial)", **b})
    return bridges

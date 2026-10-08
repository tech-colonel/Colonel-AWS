"""Ledger Reco — generic two-party ledger reconciliation engine.

(Formerly "Leisure Reco". The reco_type / module / function names keep the
`leisure_reco` spelling so existing reco_jobs history and the Node proxy map
stay valid — only the display name changed.)

Fully self-contained — deliberately does NOT import from any other recon/*.py
module (mirrors receivable_cycle.py's convention). This implements the
6-step ledger reconciliation SOP (opening balance -> standardize -> exact
match -> batch/split settlements -> variance buckets -> reco statement)
against a generic "Tally party ledger" export:

  - A variable-height preamble (company name/address, ledger account name,
    party address, period) sits above the real column header — height and
    wording differ file to file, so the header row is LOCATED, not assumed.
  - Fixed core columns: Date | Particulars | Buyer/Supplier |
    Buyer/Supplier Address | Voucher Type | Voucher No. | Voucher Ref. No. |
    Voucher Ref. Date | GSTIN/UIN | Narration | Gross Total.
  - A variable tail of per-ledger-account amount columns (each client's own
    chart of accounts — completely different column set every time) that is
    never matched on, only used as a weak polarity signal for ambiguous
    Journal rows (see _infer_polarity).
  - A "Grand Total" / "Closing Balance" footer row that is NOT a sum of the
    Gross Total column — it is the net running balance — so it is excluded
    from the transaction set and kept only as a self-check number.
  - No explicit Debit/Credit column. Polarity (does this row increase or
    decrease the balance) is inferred from Voucher Type + ledger nature
    (debtor/creditor, itself inferred from which voucher types dominate).
    Anything that can't be inferred safely is tagged "Needs Review" rather
    than guessed — see _infer_polarity.
  - No single reliably-populated reference field: Receipts/Payments usually
    leave Voucher No./Voucher Ref. No. blank and carry the only shared
    identifier (a UTR/cheque number) inside free-text Narration.
"""
from __future__ import annotations

import datetime as _dt
import itertools
import re
from io import BytesIO
from typing import Any

import pandas as pd


# ---------------------------------------------------------------------------
# Generic helpers (re-implemented here, not imported — see module docstring)
# ---------------------------------------------------------------------------

def _clean(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and pd.isna(v):
        return ""
    s = str(v).strip()
    return "" if s.lower() in ("nan", "nat", "none") else s


def _to_float(v: Any) -> float:
    s = _clean(v).replace(",", "").replace("₹", "")
    if s in ("", "-"):
        return 0.0
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    s = re.sub(r"\s*(Dr|Cr)\.?$", "", s, flags=re.IGNORECASE).strip()
    try:
        val = float(s)
        return -val if neg else val
    except ValueError:
        return 0.0


def _norm_header(s: Any) -> str:
    text = str(s or "").strip().lower()
    text = re.sub(r"[\n\r\t]+", " ", text)
    text = re.sub(r"[^a-z0-9/. ]+", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _norm_ref(v: Any) -> str:
    """Normalize a voucher/reference number for exact-key matching."""
    s = _clean(v)
    if not s:
        return ""
    if s.endswith(".0") and s[:-2].replace(".", "", 1).lstrip("-").isdigit():
        s = s[:-2]
    return re.sub(r"[^A-Z0-9/]", "", s.upper())


def _parse_date(v: Any) -> _dt.date | None:
    if v is None or v == "":
        return None
    if isinstance(v, _dt.datetime):
        return v.date()
    if isinstance(v, _dt.date):
        return v
    if hasattr(v, "to_pydatetime"):
        try:
            return v.to_pydatetime().date()
        except Exception:
            pass
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        try:
            return _dt.date(1899, 12, 30) + _dt.timedelta(days=float(v))
        except Exception:
            return None
    raw = _clean(v)
    if not raw:
        return None
    for fmt in ("%Y-%m-%d", "%d-%b-%y", "%d-%b-%Y", "%d/%m/%Y", "%d-%m-%Y",
                "%d.%m.%Y", "%m/%d/%Y", "%d/%m/%y", "%d-%m-%y", "%Y/%m/%d"):
        try:
            return _dt.datetime.strptime(raw.split(" ")[0], fmt).date()
        except ValueError:
            continue
    return None


def _round(v: float) -> float:
    return round(float(v or 0.0), 2)


# ---------------------------------------------------------------------------
# Reading the raw workbook + locating the real header row amid the preamble
# ---------------------------------------------------------------------------

def _read_all_cells(data: bytes) -> pd.DataFrame:
    """Every sheet's raw cells, header=None (position-based), stacked."""
    if not data:
        return pd.DataFrame()
    for reader, kwargs in (
        (pd.read_excel, {"sheet_name": None}),
        (pd.read_excel, {"sheet_name": None, "engine": "xlrd"}),
        (pd.read_csv, {"encoding": "utf-8-sig"}),
        (pd.read_csv, {"encoding": "latin-1"}),
    ):
        try:
            result = reader(BytesIO(data), dtype=object, header=None, **kwargs)
            break
        except Exception:
            result = None
    if result is None:
        raise ValueError("Unrecognized file format — expected .xlsx/.xls/.csv")
    if isinstance(result, dict):
        frames = [f for f in result.values() if not f.empty]
        return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    return result


# Header-cell aliases. Only the fields we actually key/display on need an
# alias list here — every other column in the export (the client's own
# chart-of-accounts tail) is carried through untouched as "extra" data.
HEADER_ALIASES: dict[str, list[str]] = {
    "date": ["date", "voucher date", "vch date", "dt", "transaction date"],
    "particulars": ["particulars", "ledger name", "account name", "account"],
    "buyer_supplier": ["buyer/supplier", "buyer supplier", "party name", "ledger"],
    "voucher_type": ["voucher type", "vch type", "type"],
    "voucher_no": ["voucher no.", "voucher no", "vch no.", "vch no", "voucher number"],
    "voucher_ref_no": ["voucher ref. no.", "voucher ref no", "voucher ref. no", "ref no.",
                        "ref no", "reference no", "reference number", "bill ref no",
                        "bill reference no"],
    "voucher_ref_date": ["voucher ref. date", "voucher ref date", "ref date", "reference date"],
    "gstin": ["gstin/uin", "gstin", "party gstin", "gstin uin"],
    "narration": ["narration", "remarks", "description"],
    # NOTE: no "value"/"net amount" alias here — Tally's columnar ledger export
    # often carries a distinct Qty x Rate "Value" column ahead of the real
    # "Gross Total" column; treating it as an alias would silently steal the
    # slot. "amount"/"total" stay as a last-resort fallback for exports that
    # spell the column differently.
    "gross_total": ["gross total", "total amount", "amount", "total"],
}
ALIAS_TO_FIELD = {alias: field for field, aliases in HEADER_ALIASES.items() for alias in aliases}

# Rows this many-or-fewer non-blank cells (or fewer date/particulars hits)
# below the preamble block are never candidates for the header row.
_HEADER_SCAN_ROWS = 40


def _find_header_row(raw: pd.DataFrame) -> int | None:
    """Locate the real column-header row amid a variable-height preamble.
    Score = count of non-blank cells (the header row, being all short
    labels, is consistently the densest string row); a literal "Date"
    header cell is required to rule out a dense preamble/address row."""
    best_idx, best_score = None, 0
    for i in range(min(_HEADER_SCAN_ROWS, len(raw))):
        cells = [_norm_header(c) for c in raw.iloc[i]]
        has_date = any(c in HEADER_ALIASES["date"] for c in cells)
        if not has_date:
            continue
        score = sum(1 for c in cells if c)
        if score > best_score:
            best_score, best_idx = score, i
    return best_idx


def _parse_ledger_file(data: bytes, filename: str, side: str) -> dict[str, Any]:
    raw = _read_all_cells(data)
    if raw.empty:
        raise ValueError(f"{filename}: could not read any sheet")

    header_idx = _find_header_row(raw)
    if header_idx is None:
        raise ValueError(
            f"{filename}: could not locate the ledger's column header row "
            f"(expected a row with a 'Date' column within the first {_HEADER_SCAN_ROWS} rows)"
        )
    preamble = raw.iloc[:header_idx]
    header_cells = [_norm_header(c) for c in raw.iloc[header_idx]]
    body = raw.iloc[header_idx + 1:].reset_index(drop=True)

    # Priority-ordered: for each field, walk ITS aliases in priority order and
    # take the first unclaimed header cell that matches — not simply the
    # first field to reach a given column left-to-right. Otherwise a generic
    # fallback alias (e.g. "amount") on an earlier column can steal a field
    # away from the exact column name (e.g. "Gross Total") sitting later.
    field_col: dict[str, int] = {}
    claimed_cols: set[int] = set()
    for field, aliases in HEADER_ALIASES.items():
        for alias in aliases:
            hit = next((i for i, c in enumerate(header_cells)
                        if c == alias and i not in claimed_cols), None)
            if hit is not None:
                field_col[field] = hit
                claimed_cols.add(hit)
                break

    extra_cols: list[tuple[int, str]] = [
        (i, _clean(raw.iloc[header_idx, i]))
        for i, c in enumerate(header_cells) if c and i not in claimed_cols
    ]

    if "date" not in field_col or "gross_total" not in field_col:
        raise ValueError(
            f"{filename}: header row found but is missing a 'Date' or 'Gross Total'/'Amount' column"
        )

    def cell(row_series: pd.Series, field: str) -> Any:
        col = field_col.get(field)
        return row_series.iloc[col] if col is not None and col < len(row_series) else None

    rows: list[dict[str, Any]] = []
    stated_closing_balance: float | None = None
    opening_balance = 0.0
    opening_row_seen = False

    for _, r in body.iterrows():
        particulars = _clean(cell(r, "particulars"))
        voucher_type = _clean(cell(r, "voucher_type"))
        gross_total_raw = cell(r, "gross_total")
        date = _parse_date(cell(r, "date"))
        label = f"{particulars} {voucher_type}".strip().lower()

        # Footer row (Grand Total / Closing Balance) — not a transaction.
        if not date and ("grand total" in label or "closing balance" in label):
            stated_closing_balance = _to_float(gross_total_raw)
            continue
        # Opening balance row (Tally convention) — captured, not matched.
        if "opening balance" in label:
            opening_balance = _to_float(gross_total_raw)
            opening_row_seen = True
            continue
        if not date and not particulars and not voucher_type and _to_float(gross_total_raw) == 0:
            continue  # fully blank spacer row
        if not date:
            continue  # can't reconcile a dateless data row

        extra_values: dict[str, float] = {}
        for col_idx, name in extra_cols:
            if col_idx < len(r):
                amt = _to_float(r.iloc[col_idx])
                if amt:
                    extra_values[name] = amt

        rows.append({
            "side": side,
            "row_no": len(rows),
            "date": date,
            "particulars": particulars,
            "buyer_supplier": _clean(cell(r, "buyer_supplier")),
            "voucher_type": voucher_type,
            "voucher_type_norm": _norm_header(voucher_type),
            "voucher_no": _clean(cell(r, "voucher_no")),
            "voucher_ref_no": _clean(cell(r, "voucher_ref_no")),
            "gstin": _clean(cell(r, "gstin")),
            "narration": _clean(cell(r, "narration")),
            "amount": abs(_to_float(gross_total_raw)),
            "extra_accounts": extra_values,
        })

    party_name = ""
    if rows:
        from collections import Counter
        names = Counter(r["particulars"] for r in rows if r["particulars"])
        if names:
            party_name = names.most_common(1)[0][0]
    if not party_name:
        for v in preamble.iloc[:, 0]:
            t = _clean(v)
            if t:
                party_name = t
                break

    # Source ledger of each entry: the row's own Particulars (the ledger account
    # in a columnar export, which can differ row to row when one file carries
    # more than one ledger for the same party), else the file-level party name.
    for r in rows:
        r["ledger_name"] = r["particulars"] or party_name
        r["source_file"] = filename

    return {
        "filename": filename,
        "party_name": party_name,
        "rows": rows,
        "opening_balance": opening_balance,
        "opening_row_seen": opening_row_seen,
        "stated_closing_balance": stated_closing_balance,
    }


# ---------------------------------------------------------------------------
# Ledger nature + polarity (Debit/Credit) inference
# ---------------------------------------------------------------------------

_TAX_ADJ_KEYWORDS = ("tds", "tcs", "194", "206c", "round off", "rounding")
_TIMING_KEYWORDS = ("in transit", "unpresented", "not presented", "uncleared", "awaited")
_DISPUTE_KEYWORDS = ("dispute", "reject", "not accepted", "rate diff", "short paid", "shortpaid")
_OMISSION_KEYWORDS = ("bank charge", "bank charges", "commission", "interest", "direct credit", "penalty")


def _infer_ledger_nature(rows: list[dict]) -> str:
    """'debtor' (we invoice them — Sales dominates) or 'creditor' (they
    invoice us — Purchase dominates). Defaults to 'debtor' on a tie/no signal."""
    sale_ct = sum(1 for r in rows if "sale" in r["voucher_type_norm"])
    purchase_ct = sum(1 for r in rows if "purchase" in r["voucher_type_norm"])
    return "creditor" if purchase_ct > sale_ct else "debtor"


def _infer_polarity(row: dict, nature: str) -> tuple[int, str]:
    """Returns (sign, method). sign: +1 increases the balance, -1 decreases
    it, 0 = could not be determined safely (-> Needs Review, never guessed)."""
    vt = row["voucher_type_norm"]
    is_sale = "sale" in vt
    is_purchase = "purchase" in vt
    is_receipt = "receipt" in vt
    is_payment = "payment" in vt
    is_credit_note = "credit note" in vt
    is_debit_note = "debit note" in vt
    is_journal = "journal" in vt

    if nature == "debtor":
        if is_sale or is_debit_note:
            return 1, "voucher_type"
        if is_receipt or is_credit_note or is_purchase:
            return -1, "voucher_type"
    else:  # creditor
        if is_purchase or is_credit_note:
            return 1, "voucher_type"
        if is_payment or is_debit_note or is_sale:
            return -1, "voucher_type"

    if is_journal:
        narration_l = row["narration"].lower()
        if any(k in narration_l for k in _TAX_ADJ_KEYWORDS):
            return -1, "narration-keyword"
        contra_names_l = " ".join(row["extra_accounts"].keys()).lower()
        if any(k in contra_names_l for k in _TAX_ADJ_KEYWORDS):
            return -1, "contra-account-keyword"

    return 0, "needs_review"


# ---------------------------------------------------------------------------
# Step 3 — tiered exact matching
# ---------------------------------------------------------------------------

def _ref_tokens(row: dict) -> set[str]:
    tokens = set()
    for v in (row["voucher_no"], row["voucher_ref_no"]):
        t = _norm_ref(v)
        if t:
            tokens.add(t)
    return tokens


def _digit_runs(text: str) -> list[str]:
    return [r.lstrip("0") or "0" for r in re.findall(r"\d{6,}", text or "")]


def _digit_runs_overlap(a_runs: list[str], b_runs: list[str], min_overlap: int = 6) -> bool:
    for a in a_runs:
        for b in b_runs:
            shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
            if len(shorter) >= min_overlap and longer.endswith(shorter):
                return True
    return False


def _amount_match(a: float, b: float, tolerance: float) -> bool:
    return abs(_round(a) - _round(b)) <= tolerance


def _match_pairs(int_rows, cp_rows, used_int, used_cp, matches, tolerance, method, key_fn):
    """key_fn(row) -> set/str of candidate keys; pairs rows sharing any key
    with a matching amount. Greedy, first-fit."""
    cp_index: dict[str, list[int]] = {}
    for j, r in enumerate(cp_rows):
        if j in used_cp:
            continue
        for k in key_fn(r):
            cp_index.setdefault(k, []).append(j)

    for i, ir in enumerate(int_rows):
        if i in used_int:
            continue
        candidates: list[int] = []
        for k in key_fn(ir):
            candidates.extend(cp_index.get(k, []))
        for j in dict.fromkeys(candidates):  # de-dup, keep order
            if j in used_cp:
                continue
            cr = cp_rows[j]
            if _amount_match(ir["amount"], cr["amount"], tolerance):
                used_int.add(i)
                used_cp.add(j)
                matches.append({"internal": ir, "counterparty": cr, "method": method})
                break


def _match_by_reference(int_rows, cp_rows, used_int, used_cp, matches, tolerance):
    _match_pairs(int_rows, cp_rows, used_int, used_cp, matches, tolerance,
                 "reference", _ref_tokens)


def _match_by_narration_digits(int_rows, cp_rows, used_int, used_cp, matches, tolerance):
    cp_unused = [(j, r) for j, r in enumerate(cp_rows) if j not in used_cp]
    for i, ir in enumerate(int_rows):
        if i in used_int:
            continue
        ir_runs = _digit_runs(ir["narration"])
        if not ir_runs:
            continue
        for j, cr in cp_unused:
            if j in used_cp:
                continue
            if not _amount_match(ir["amount"], cr["amount"], tolerance):
                continue
            cr_runs = _digit_runs(cr["narration"])
            if cr_runs and _digit_runs_overlap(ir_runs, cr_runs):
                used_int.add(i)
                used_cp.add(j)
                matches.append({"internal": ir, "counterparty": cr, "method": "narration_utr"})
                break


def _match_by_date_amount(int_rows, cp_rows, used_int, used_cp, matches, tolerance, window_days=45):
    cp_unused = [(j, r) for j, r in enumerate(cp_rows) if j not in used_cp]
    for i, ir in enumerate(int_rows):
        if i in used_int:
            continue
        best_j, best_gap = None, None
        for j, cr in cp_unused:
            if j in used_cp:
                continue
            if not _amount_match(ir["amount"], cr["amount"], tolerance):
                continue
            gap = abs((ir["date"] - cr["date"]).days)
            if gap <= window_days and (best_gap is None or gap < best_gap):
                best_j, best_gap = j, gap
        if best_j is not None:
            used_int.add(i)
            used_cp.add(best_j)
            matches.append({"internal": ir, "counterparty": cp_rows[best_j], "method": "date_amount"})


def _match_batches(int_rows, cp_rows, used_int, used_cp, matches, tolerance,
                    window_days=60, max_group=4):
    """Step 4 — lump-sum / partial-payment settlements: an unmatched row on
    one side whose amount equals the SUM of 2..max_group unmatched rows on
    the other side, within a date window. Bounded combination search."""
    def _try_direction(single_rows, single_used, group_rows, group_used, single_key, group_key):
        for i, sr in enumerate(single_rows):
            if i in single_used:
                continue
            pool = [(j, r) for j, r in enumerate(group_rows)
                    if j not in group_used and abs((sr["date"] - r["date"]).days) <= window_days]
            found = None
            for size in range(2, max_group + 1):
                if found or size > len(pool):
                    break
                for combo in itertools.combinations(pool, size):
                    if _amount_match(sum(c[1]["amount"] for c in combo), sr["amount"], tolerance):
                        found = combo
                        break
            if found:
                single_used.add(i)
                for j, gr in found:
                    group_used.add(j)
                    matches.append({single_key: sr, group_key: gr, "method": "batch",
                                     "batch_size": len(found)})

    _try_direction(int_rows, used_int, cp_rows, used_cp, "internal", "counterparty")
    _try_direction(cp_rows, used_cp, int_rows, used_int, "counterparty", "internal")


# ---------------------------------------------------------------------------
# Step 5 — variance bucketing for whatever is still unmatched
# ---------------------------------------------------------------------------

def _classify_variance(row: dict) -> str:
    text = f"{row['narration']} {row['voucher_type']} {' '.join(row['extra_accounts'].keys())}".lower()
    if any(k in text for k in _TAX_ADJ_KEYWORDS):
        return "Tax Deduction"
    if any(k in text for k in _TIMING_KEYWORDS):
        return "Timing Difference"
    if any(k in text for k in _DISPUTE_KEYWORDS):
        return "Disputed"
    if any(k in text for k in _OMISSION_KEYWORDS):
        return "Omission in Books"
    return "Missing at Counterparty"


# ---------------------------------------------------------------------------
# Result-row + closing-bridge construction
# ---------------------------------------------------------------------------

# Status remark carried on every result row / ledger entry. Anything that did
# not pair off (variance buckets + Needs Review) is "Mismatched".
STATUS_MATCHED = "Matched"
STATUS_MISMATCHED = "Mismatched"


def _row_fields(prefix: str, row: dict | None) -> dict[str, Any]:
    if row is None:
        return {f"{prefix}_date": None, f"{prefix}_voucher_type": None,
                f"{prefix}_voucher_no": None, f"{prefix}_ref_no": None,
                f"{prefix}_narration": None, f"{prefix}_amount": None,
                f"{prefix}_ledger": None, f"{prefix}_row_no": None}
    return {
        f"{prefix}_ledger": row.get("ledger_name") or None,
        f"{prefix}_row_no": row["row_no"],
        f"{prefix}_date": row["date"].isoformat() if row["date"] else None,
        f"{prefix}_voucher_type": row["voucher_type"] or None,
        f"{prefix}_voucher_no": row["voucher_no"] or None,
        f"{prefix}_ref_no": row["voucher_ref_no"] or None,
        f"{prefix}_narration": row["narration"] or None,
        f"{prefix}_amount": row["amount"],
    }


def _build_result_rows(matches: list[dict], unmatched_int: list[dict], unmatched_cp: list[dict],
                        needs_review: list[dict]) -> list[dict]:
    results: list[dict] = []

    method_labels = {
        "reference": "Matched — Voucher/Reference No.",
        "narration_utr": "Matched — UTR/Cheque No. (narration)",
        "date_amount": "Matched — Date + Amount",
        "batch": "Matched — Batch/Split Settlement",
    }
    for m in matches:
        ir, cr = m.get("internal"), m.get("counterparty")
        amount = (ir or cr)["amount"]
        results.append({
            "category": "Matched",
            "status": STATUS_MATCHED,
            "match_method": method_labels.get(m["method"], m["method"]),
            "amount": amount,
            **_row_fields("internal", ir),
            **_row_fields("counterparty", cr),
        })

    for r in unmatched_int:
        category = _classify_variance(r)
        results.append({
            "category": category,
            "status": STATUS_MISMATCHED,
            "match_method": None,
            "amount": r["amount"],
            **_row_fields("internal", r),
            **_row_fields("counterparty", None),
        })

    for r in unmatched_cp:
        category = _classify_variance(r)
        results.append({
            "category": category,
            "status": STATUS_MISMATCHED,
            "match_method": None,
            "amount": r["amount"],
            **_row_fields("internal", None),
            **_row_fields("counterparty", r),
        })

    for r in needs_review:
        results.append({
            "category": "Needs Review",
            "status": STATUS_MISMATCHED,
            "match_method": None,
            "amount": r["amount"],
            "explanation": "Journal entry — could not determine Debit/Credit direction "
                            "from voucher type or narration; verify manually.",
            **_row_fields(r["side"], r),
            **_row_fields("counterparty" if r["side"] == "internal" else "internal", None),
        })

    return results


def _closing_bridge(internal: dict, counterparty: dict, int_rows_resolved: list[dict],
                     cp_rows_resolved: list[dict], nature_internal: str,
                     nature_counterparty: str) -> dict:
    """Step 6 — computes each side's own closing balance from its resolved
    rows (needs-review rows are excluded — never guessed), cross-checks
    against the file's own stated Grand Total/Closing Balance footer when
    present, then bridges Internal closing to Counterparty closing. Both
    ledgers record the SAME relationship from opposite sides, so a genuine
    match nets to zero: Internal closing + Counterparty closing = 0."""
    def side_balance(opening: float, rows: list[dict], nature: str) -> float:
        total = opening
        for r in rows:
            sign, _ = _infer_polarity(r, nature)
            total += sign * r["amount"]
        return _round(total)

    computed_internal = side_balance(internal["opening_balance"], int_rows_resolved, nature_internal)
    computed_counterparty = side_balance(counterparty["opening_balance"], cp_rows_resolved, nature_counterparty)

    return {
        "opening_internal": _round(internal["opening_balance"]),
        "opening_counterparty": _round(counterparty["opening_balance"]),
        "opening_gap": _round(internal["opening_balance"] - counterparty["opening_balance"]),
        "computed_closing_internal": computed_internal,
        "computed_closing_counterparty": computed_counterparty,
        "stated_closing_internal": internal["stated_closing_balance"],
        "stated_closing_counterparty": counterparty["stated_closing_balance"],
        # Debtor-side internal balance should equal the negative of the
        # creditor-side counterparty balance when both books are current.
        "unexplained_variance": _round(computed_internal + computed_counterparty),
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def reconcile_leisure_ledgers(internal_bytes: bytes, internal_filename: str,
                               counterparty_bytes: bytes, counterparty_filename: str,
                               tolerance: float = 1.0) -> dict[str, Any]:
    internal = _parse_ledger_file(internal_bytes, internal_filename, "internal")
    counterparty = _parse_ledger_file(counterparty_bytes, counterparty_filename, "counterparty")

    int_rows = internal["rows"]
    cp_rows = counterparty["rows"]
    # Nature (debtor/creditor) is inferred PER SIDE — the two ledgers usually
    # mirror each other (one side's Sales is the other side's Purchase), so
    # applying one side's nature to the other would flip every polarity.
    nature_internal = _infer_ledger_nature(int_rows)
    nature_counterparty = _infer_ledger_nature(cp_rows)
    nature_by_side = {"internal": nature_internal, "counterparty": nature_counterparty}

    used_int: set[int] = set()
    used_cp: set[int] = set()
    matches: list[dict] = []

    _match_by_reference(int_rows, cp_rows, used_int, used_cp, matches, tolerance)
    _match_by_narration_digits(int_rows, cp_rows, used_int, used_cp, matches, tolerance)
    _match_by_date_amount(int_rows, cp_rows, used_int, used_cp, matches, tolerance)
    _match_batches(int_rows, cp_rows, used_int, used_cp, matches, tolerance)

    unmatched_int_all = [r for i, r in enumerate(int_rows) if i not in used_int]
    unmatched_cp_all = [r for j, r in enumerate(cp_rows) if j not in used_cp]

    # Split off rows whose Dr/Cr direction is unresolved — these go to Needs
    # Review, not into a variance bucket (SOP steps 5/6 need a signed amount).
    needs_review = [r for r in unmatched_int_all + unmatched_cp_all
                    if _infer_polarity(r, nature_by_side[r["side"]])[0] == 0
                    and "journal" in r["voucher_type_norm"]]
    review_ids = {(r["side"], r["row_no"]) for r in needs_review}
    unmatched_int = [r for r in unmatched_int_all if (r["side"], r["row_no"]) not in review_ids]
    unmatched_cp = [r for r in unmatched_cp_all if (r["side"], r["row_no"]) not in review_ids]

    results = _build_result_rows(matches, unmatched_int, unmatched_cp, needs_review)

    int_rows_resolved = [r for r in int_rows if (r["side"], r["row_no"]) not in review_ids]
    cp_rows_resolved = [r for r in cp_rows if (r["side"], r["row_no"]) not in review_ids]
    closing_bridge = _closing_bridge(internal, counterparty, int_rows_resolved, cp_rows_resolved,
                                      nature_internal, nature_counterparty)

    summary: dict[str, int] = {}
    for r in results:
        summary[r["category"]] = summary.get(r["category"], 0) + 1

    counts = {
        "internal_rows": len(int_rows),
        "counterparty_rows": len(cp_rows),
        "matched_pairs": len(matches),
        "matched_entries": len(used_int) + len(used_cp),
        "mismatched_entries": len(unmatched_int_all) + len(unmatched_cp_all),
        "needs_review_rows": len(needs_review),
        "result_rows": len(results),
    }

    opening_ok = abs(closing_bridge["opening_gap"]) <= tolerance

    return {
        "results": results,
        "summary": summary,
        "counts": counts,
        "opening_balance_ok": opening_ok,
        "closing_bridge": closing_bridge,
        "internal_meta": {"filename": internal["filename"], "party_name": internal["party_name"],
                           "ledger_nature": nature_internal},
        "counterparty_meta": {"filename": counterparty["filename"], "party_name": counterparty["party_name"],
                               "ledger_nature": nature_counterparty},
    }


# ---------------------------------------------------------------------------
# Excel workbook
# ---------------------------------------------------------------------------

def _style_header(sheet) -> None:
    from openpyxl.styles import Font, PatternFill
    fill = PatternFill("solid", fgColor="123C69")
    for cell in sheet[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = fill
    for column_cells in sheet.columns:
        max_length = max((len(str(cell.value or "")) for cell in column_cells), default=8)
        sheet.column_dimensions[column_cells[0].column_letter].width = min(max(max_length + 2, 12), 48)


MATCHED_COLUMNS = [
    ("amount", "Amount"), ("match_method", "Match Method"),
    ("internal_date", "Internal Date"), ("internal_voucher_type", "Internal Voucher Type"),
    ("internal_voucher_no", "Internal Voucher No"), ("internal_ref_no", "Internal Ref No"),
    ("internal_narration", "Internal Narration"),
    ("counterparty_date", "Counterparty Date"), ("counterparty_voucher_type", "Counterparty Voucher Type"),
    ("counterparty_voucher_no", "Counterparty Voucher No"), ("counterparty_ref_no", "Counterparty Ref No"),
    ("counterparty_narration", "Counterparty Narration"),
]
UNMATCHED_INTERNAL_COLUMNS = [
    ("category", "Variance Category"), ("internal_date", "Date"),
    ("internal_voucher_type", "Voucher Type"), ("internal_voucher_no", "Voucher No"),
    ("internal_ref_no", "Ref No"), ("internal_narration", "Narration"), ("amount", "Amount"),
]
UNMATCHED_COUNTERPARTY_COLUMNS = [
    ("category", "Variance Category"), ("counterparty_date", "Date"),
    ("counterparty_voucher_type", "Voucher Type"), ("counterparty_voucher_no", "Voucher No"),
    ("counterparty_ref_no", "Ref No"), ("counterparty_narration", "Narration"), ("amount", "Amount"),
]
NEEDS_REVIEW_COLUMNS = [
    ("internal_date", "Internal Date"), ("internal_voucher_type", "Internal Voucher Type"),
    ("internal_narration", "Internal Narration"),
    ("counterparty_date", "Counterparty Date"), ("counterparty_voucher_type", "Counterparty Voucher Type"),
    ("counterparty_narration", "Counterparty Narration"),
    ("amount", "Amount"), ("explanation", "Why it needs review"),
]


# ---------------------------------------------------------------------------
# Entry-level view: every ledger line once, with its Matched/Mismatched status
# ---------------------------------------------------------------------------

_SOURCE_LABEL = {"internal": "Internal Ledger", "counterparty": "Counterparty Statement"}
_HEADER_FILL = "123C69"
_SECTION_FILL = "DCE6F1"
_AMOUNT_FMT = "#,##0.00"
_DATE_FMT = "DD-MMM-YY"

# Suggested next step per variance bucket ({own}/{other} = the two parties).
_ACTION_BY_CATEGORY = {
    "Timing Difference": "None – timing only; confirm it clears in the next period",
    "Tax Deduction": "Confirm the TDS/TCS against Form 26AS / certificate and book it in {other} books",
    "Disputed": "Resolve the dispute with the party; pass a debit/credit note once agreed",
    "Omission in Books": "Book the omitted entry (charges / interest / direct credit) in {other} books",
    "Missing at Counterparty": "{other} to confirm and book it, or {own} to reverse",
    "Needs Review": "Verify the Debit/Credit direction of this journal manually",
}


def _ledger_entries(results: list[dict]) -> list[dict]:
    """Flattens result rows back to one line per ledger entry (a batch
    settlement repeats its lump-sum row once per split row — de-duplicated
    here), in each ledger's original order, Internal first."""
    entries: list[dict] = []
    seen: set[tuple[str, Any]] = set()
    for r in results:
        for side in ("internal", "counterparty"):
            if r.get(f"{side}_date") is None and r.get(f"{side}_amount") is None:
                continue
            key = (side, r.get(f"{side}_row_no"))
            if key[1] is not None:
                if key in seen:
                    continue
                seen.add(key)
            matched = r.get("category") == "Matched"
            entries.append({
                "side": side,
                "source": _SOURCE_LABEL[side],
                "ledger": r.get(f"{side}_ledger") or "",
                "row_no": r.get(f"{side}_row_no"),
                "date": _parse_date(r.get(f"{side}_date")),
                "voucher_type": r.get(f"{side}_voucher_type"),
                "voucher_no": r.get(f"{side}_voucher_no"),
                "ref_no": r.get(f"{side}_ref_no"),
                "narration": r.get(f"{side}_narration"),
                "amount": r.get(f"{side}_amount") or 0.0,
                "status": STATUS_MATCHED if matched else STATUS_MISMATCHED,
                "category": r.get("category"),
                "remark": r.get("match_method") if matched else r.get("category"),
                "explanation": r.get("explanation"),
            })
    entries.sort(key=lambda e: (0 if e["side"] == "internal" else 1,
                                e["row_no"] if e["row_no"] is not None else 0))
    return entries


def _style_table_header(sheet, row_idx: int, n_cols: int) -> None:
    from openpyxl.styles import Alignment, Font, PatternFill
    fill = PatternFill("solid", fgColor=_HEADER_FILL)
    for col in range(1, n_cols + 1):
        cell = sheet.cell(row=row_idx, column=col)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def _status_font(status: str):
    from openpyxl.styles import Font
    return Font(bold=True, color="1E7B34" if status == STATUS_MATCHED else "C00000")


def _write_all_entries_sheet(sheet, entries: list[dict]) -> None:
    headers = ["Source", "Ledger Name", "Date", "Voucher Type", "Voucher No", "Ref No",
               "Narration", "Amount", "Status", "Remark"]
    sheet.append(headers)
    for e in entries:
        sheet.append([e["source"], e["ledger"], e["date"], e["voucher_type"], e["voucher_no"],
                      e["ref_no"], e["narration"], e["amount"], e["status"], e["remark"]])
        row = sheet.max_row
        sheet.cell(row=row, column=3).number_format = _DATE_FMT
        sheet.cell(row=row, column=8).number_format = _AMOUNT_FMT
        sheet.cell(row=row, column=9).font = _status_font(e["status"])
    _style_table_header(sheet, 1, len(headers))
    for letter, width in zip("ABCDEFGHIJ", (22, 32, 12, 16, 16, 16, 48, 16, 14, 36)):
        sheet.column_dimensions[letter].width = width
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = f"A1:J{max(sheet.max_row, 1)}"


def _entry_text(e: dict) -> str:
    """How the entry reads in its own books — 'Payment 83 dated 05-Jul-25'."""
    parts = [str(p) for p in (e["voucher_type"], e["voucher_no"] or e["ref_no"]) if p]
    text = " ".join(parts) or "Entry"
    if e["date"]:
        text += f" dated {e['date'].strftime('%d-%b-%y')}"
    return text


def _write_mismatched_sheet(sheet, entries: list[dict], mismatched: list[dict], payload: dict,
                            internal_meta: dict, counterparty_meta: dict) -> None:
    """One sheet: reconciliation summary (totals + counts) on top, then the
    complete list of mismatched entries with the ledger each one came from."""
    from openpyxl.styles import Alignment, Font, PatternFill

    closing = payload.get("closing_bridge") or {}
    names = {"internal": internal_meta.get("party_name") or "Internal",
             "counterparty": counterparty_meta.get("party_name") or "Counterparty"}
    # Each file is the ledger OF the other party, so "X books" would be
    # ambiguous — label the two sides by role instead.
    books = {"internal": "Internal", "counterparty": "Counterparty"}
    section_fill = PatternFill("solid", fgColor=_SECTION_FILL)
    bold = Font(bold=True)

    def section(title: str) -> None:
        sheet.append([None, title])
        row = sheet.max_row
        for col in range(1, 15):
            sheet.cell(row=row, column=col).fill = section_fill
        sheet.cell(row=row, column=2).font = bold

    def stat(side: str | None, rows: list[dict]) -> tuple[int, float]:
        picked = [e for e in rows if side is None or e["side"] == side]
        return len(picked), _round(sum(e["amount"] for e in picked))

    def summary_line(label: str, rows: list[dict], is_bold: bool = False) -> None:
        ic, ia = stat("internal", rows)
        cc, ca = stat("counterparty", rows)
        tc, ta = stat(None, rows)
        sheet.append([None, label, ic, ia, cc, ca, tc, ta])
        row = sheet.max_row
        for col in (4, 6, 8):
            sheet.cell(row=row, column=col).number_format = _AMOUNT_FMT
        if is_bold:
            for col in range(2, 9):
                sheet.cell(row=row, column=col).font = bold

    def balance_line(label: str, internal_val: Any, counterparty_val: Any, note: str = "") -> None:
        sheet.append([None, label, None, internal_val, None, counterparty_val, None, None, note or None])
        row = sheet.max_row
        for col in (4, 6):
            sheet.cell(row=row, column=col).number_format = _AMOUNT_FMT

    sheet.append([f"List of differences – Internal Ledger ({names['internal']}) vs "
                  f"Counterparty Statement ({names['counterparty']})"])
    sheet.cell(row=1, column=1).font = Font(bold=True, size=14)
    sheet.append(["Every entry that did not pair off, with the ledger it came from. "
                  "Amounts are as booked in the source ledger (unsigned)."])
    sheet.cell(row=2, column=1).font = Font(italic=True, color="595959")
    sheet.append([])

    # ---- 1. Reconciliation summary: totals + counts --------------------
    section("1. Reconciliation summary – totals and counts")
    sheet.append([None, "Entries", "Internal – Count", "Internal – Amount", "Counterparty – Count",
                  "Counterparty – Amount", "Total – Count", "Total – Amount"])
    _style_table_header(sheet, sheet.max_row, 8)
    sheet.cell(row=sheet.max_row, column=1).fill = PatternFill(fill_type=None)
    matched = [e for e in entries if e["status"] == STATUS_MATCHED]
    summary_line("Total entries", entries, is_bold=True)
    summary_line(STATUS_MATCHED, matched)
    summary_line(STATUS_MISMATCHED, mismatched, is_bold=True)
    categories = list(dict.fromkeys(e["category"] for e in mismatched))
    for category in categories:
        summary_line(f"   of which: {category}", [e for e in mismatched if e["category"] == category])
    sheet.append([])

    section("2. Balances")
    sheet.append([None, "Balance", None, "Internal", None, "Counterparty"])
    _style_table_header(sheet, sheet.max_row, 6)
    sheet.cell(row=sheet.max_row, column=1).fill = PatternFill(fill_type=None)
    opening_gap = closing.get("opening_gap", 0) or 0
    balance_line("Opening balance", closing.get("opening_internal", 0), closing.get("opening_counterparty", 0),
                 f"Gap {opening_gap:,.2f}" if opening_gap else "Agrees")
    balance_line("Closing balance (computed)", closing.get("computed_closing_internal", 0),
                 closing.get("computed_closing_counterparty", 0))
    balance_line("Closing balance (stated in file)", closing.get("stated_closing_internal"),
                 closing.get("stated_closing_counterparty"))
    sheet.append([None, "Unexplained variance (Internal + Counterparty closing)", None,
                  closing.get("unexplained_variance", 0), None, None, None, None,
                  "Should be zero once the mismatched entries below are cleared"])
    row = sheet.max_row
    sheet.cell(row=row, column=2).font = bold
    sheet.cell(row=row, column=4).font = bold
    sheet.cell(row=row, column=4).number_format = _AMOUNT_FMT
    sheet.append([])

    # ---- 3. The mismatched list ----------------------------------------
    section(f"3. Mismatched entries ({len(mismatched)})")
    headers = ["#", "Type", "Status", "Source", "Ledger Name", "Date", "Voucher Type", "Voucher No",
               "Ref No", "Narration", "In Internal books", "In Counterparty books", "Amount (INR)", "Action"]
    sheet.append(headers)
    header_row = sheet.max_row
    _style_table_header(sheet, header_row, len(headers))

    wrap = Alignment(vertical="top", wrap_text=True)
    serial = 0

    def list_row(values: list[Any]) -> None:
        sheet.append(values)
        row = sheet.max_row
        sheet.cell(row=row, column=3).font = _status_font(STATUS_MISMATCHED)
        sheet.cell(row=row, column=6).number_format = _DATE_FMT
        sheet.cell(row=row, column=13).number_format = _AMOUNT_FMT
        for col in (10, 11, 12, 14):
            sheet.cell(row=row, column=col).alignment = wrap

    if payload.get("opening_balance_ok") is False:
        serial += 1
        list_row([serial, "Opening Balance", STATUS_MISMATCHED, "Both ledgers",
                  f"{names['internal']} / {names['counterparty']}", None, None, None, None,
                  "Opening balance mismatch",
                  f"Opening {closing.get('opening_internal', 0):,.2f}",
                  f"Opening {closing.get('opening_counterparty', 0):,.2f}",
                  abs(opening_gap),
                  "Tie both sides back to the prior-period closing balances"])

    for e in mismatched:
        serial += 1
        own, other = e["side"], ("counterparty" if e["side"] == "internal" else "internal")
        in_books = {own: _entry_text(e),
                    other: "—" if e["category"] == "Needs Review" else "Not booked"}
        action = _ACTION_BY_CATEGORY.get(e["category"], "Review").format(own=books[own], other=books[other])
        list_row([serial, e["category"], e["status"], e["source"], e["ledger"], e["date"],
                  e["voucher_type"], e["voucher_no"], e["ref_no"], e["narration"],
                  in_books["internal"], in_books["counterparty"], e["amount"], action])

    if not serial:
        sheet.append([None, "No mismatched entries – both ledgers agree."])

    for letter, width in zip("ABCDEFGHIJKLMN", (5, 40, 18, 22, 30, 20, 16, 16, 16, 44, 32, 32, 16, 52)):
        sheet.column_dimensions[letter].width = width
    if serial:
        sheet.auto_filter.ref = f"A{header_row}:N{sheet.max_row}"


def _write_rows(sheet, rows: list[dict], columns: list[tuple[str, str]]) -> None:
    sheet.append([label for _, label in columns])
    for row in rows:
        sheet.append([row.get(key) for key, _ in columns])
    _style_header(sheet)


def build_leisure_reco_workbook(results: list[dict], summary: dict[str, int], counts: dict[str, int],
                                 payload: dict | None = None):
    from openpyxl import Workbook
    payload = payload or {}
    closing = payload.get("closing_bridge") or {}
    internal_meta = payload.get("internal_meta") or {}
    counterparty_meta = payload.get("counterparty_meta") or {}

    entries = _ledger_entries(results)
    mismatched = [e for e in entries if e["status"] == STATUS_MISMATCHED]

    workbook = Workbook()

    summary_sheet = workbook.active
    summary_sheet.title = "Summary"
    summary_sheet.append(["Metric", "Value"])
    summary_sheet.append(["Internal ledger file", internal_meta.get("filename", "")])
    summary_sheet.append(["Internal party name", internal_meta.get("party_name", "")])
    summary_sheet.append(["Internal ledger nature", internal_meta.get("ledger_nature", "")])
    summary_sheet.append(["Counterparty ledger file", counterparty_meta.get("filename", "")])
    summary_sheet.append(["Counterparty party name", counterparty_meta.get("party_name", "")])
    summary_sheet.append(["Counterparty ledger nature", counterparty_meta.get("ledger_nature", "")])
    summary_sheet.append(["Internal rows", counts.get("internal_rows", 0)])
    summary_sheet.append(["Counterparty rows", counts.get("counterparty_rows", 0)])
    summary_sheet.append(["Matched pairs", counts.get("matched_pairs", 0)])
    summary_sheet.append(["Matched entries (both ledgers)", sum(1 for e in entries if e["status"] == STATUS_MATCHED)])
    summary_sheet.append(["Mismatched entries (both ledgers)", len(mismatched)])
    summary_sheet.append(["Needs review rows", counts.get("needs_review_rows", 0)])
    summary_sheet.append([])
    summary_sheet.append(["Category", "Count"])
    for category, count in summary.items():
        summary_sheet.append([category, count])
    _style_header(summary_sheet)

    _write_mismatched_sheet(workbook.create_sheet("Mismatched Entries"), entries, mismatched,
                            payload, internal_meta, counterparty_meta)
    _write_all_entries_sheet(workbook.create_sheet("All Entries"), entries)

    matched_rows = [r for r in results if r["category"] == "Matched"]
    _write_rows(workbook.create_sheet("Matched"), matched_rows, MATCHED_COLUMNS)

    unmatched_internal = [r for r in results
                           if r["category"] not in ("Matched", "Needs Review") and r.get("internal_date")]
    _write_rows(workbook.create_sheet("Unmatched - Internal"), unmatched_internal, UNMATCHED_INTERNAL_COLUMNS)

    unmatched_counterparty = [r for r in results
                               if r["category"] not in ("Matched", "Needs Review") and r.get("counterparty_date")]
    _write_rows(workbook.create_sheet("Unmatched - Counterparty"), unmatched_counterparty,
                UNMATCHED_COUNTERPARTY_COLUMNS)

    needs_review_rows = [r for r in results if r["category"] == "Needs Review"]
    _write_rows(workbook.create_sheet("Needs Review"), needs_review_rows, NEEDS_REVIEW_COLUMNS)

    reco_sheet = workbook.create_sheet("Reconciliation Statement")
    reco_sheet.append(["Reconciliation Statement", ""])
    reco_sheet.append(["", ""])
    reco_sheet.append(["Opening balance - Internal", closing.get("opening_internal", 0)])
    reco_sheet.append(["Opening balance - Counterparty", closing.get("opening_counterparty", 0)])
    reco_sheet.append(["Opening balance gap", closing.get("opening_gap", 0)])
    reco_sheet.append(["", ""])
    reco_sheet.append(["Closing balance as per Internal Books (computed)", closing.get("computed_closing_internal", 0)])
    reco_sheet.append(["Closing balance as per Counterparty Statement (computed)",
                        closing.get("computed_closing_counterparty", 0)])
    reco_sheet.append(["Closing balance as per Internal Books (stated in file)",
                        closing.get("stated_closing_internal")])
    reco_sheet.append(["Closing balance as per Counterparty Statement (stated in file)",
                        closing.get("stated_closing_counterparty")])
    reco_sheet.append(["", ""])
    reco_sheet.append(["Unexplained Variance (Internal computed + Counterparty computed)",
                        closing.get("unexplained_variance", 0)])
    reco_sheet.append(["  A genuine match nets these two closing balances to zero — "
                        "any non-zero figure above is covered by the Unmatched / Needs Review sheets.", ""])
    _style_header(reco_sheet)

    return workbook

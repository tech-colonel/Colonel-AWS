import re
from io import BytesIO
import pandas as pd

try:
    from thefuzz import fuzz
except ImportError:
    from fuzzywuzzy import fuzz

_OLE2 = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

def _read_any(path):
    """Read .xls/.xlsx into a sheet-name -> DataFrame(header=None) dict, dynamically."""
    with open(path, "rb") as f:
        data = f.read()
    # Try xlrd first for .xls OLE2 format, fallback to openpyxl for xlsx
    try:
        if data[:8] == _OLE2 or path.lower().endswith(".xls"):
            xls = pd.ExcelFile(BytesIO(data), engine="xlrd")
        else:
            xls = pd.ExcelFile(BytesIO(data), engine="openpyxl")
    except Exception:
        # Fallback: try openpyxl
        xls = pd.ExcelFile(BytesIO(data), engine="openpyxl")
    return {s: xls.parse(s, header=None) for s in xls.sheet_names}

def _find_header_row(df, must_have):
    """Return the row index whose cells contain all `must_have` tokens (case-insensitive)."""
    for i in range(min(40, len(df))):
        cells = [str(x).strip().lower() for x in df.iloc[i].tolist()]
        joined = " | ".join(cells)
        if all(tok in joined for tok in must_have):
            return i
    return None

def _num(x):
    if x is None: return 0.0
    s = str(x).replace(",", "").strip()
    if s in ("", "nan", "None"): return 0.0
    try: return float(s)
    except ValueError: return 0.0

def _colmap(header_cells):
    """Map logical fields to column indices by fuzzy header text."""
    m = {}
    for idx, c in enumerate(header_cells):
        cl = str(c).strip().lower()
        if cl == "date" and "date" not in m: m["date"] = idx
        elif "particular" in cl: m["particulars"] = idx
        elif "narration" in cl: m["narration"] = idx
        elif "vch type" in cl or "voucher type" in cl: m["vch_type"] = idx
        elif "vch no" in cl or "voucher no" in cl: m["vch_no"] = idx
        elif cl == "debit": m["debit"] = idx
        elif cl == "credit": m["credit"] = idx
    return m

def _tally_frame(path):
    sheets = _read_any(path)
    # pick the sheet containing a Date/Particulars/Debit/Credit header
    for name, df in sheets.items():
        h = _find_header_row(df, ["date", "particulars", "debit", "credit"])
        if h is not None:
            return df, h
    raise ValueError("No Tally daybook header row found (Date/Particulars/Debit/Credit)")

def parse_tally(path):
    df, h = _tally_frame(path)
    cm = _colmap(df.iloc[h].tolist())
    rows = []
    for i in range(h + 1, len(df)):
        r = df.iloc[i].tolist()
        date = r[cm["date"]] if cm.get("date") is not None else None
        # Tally puts Cr/Dr flag in Particulars col and the ledger name in the next col
        pcol = cm.get("particulars", 1)
        party = ""
        for cand in (pcol + 1, pcol, pcol + 2):
            if cand < len(r) and str(r[cand]).strip() not in ("", "nan", "Cr", "Dr"):
                party = str(r[cand]).strip(); break
        debit = _num(r[cm["debit"]]) if cm.get("debit") is not None else 0.0
        credit = _num(r[cm["credit"]]) if cm.get("credit") is not None else 0.0
        narr = str(r[cm["narration"]]).strip() if cm.get("narration") is not None and cm["narration"] < len(r) else ""
        party_l = party.lower()
        # Skip labeled summary/footer rows (opening/closing balance, grand total) — these are
        # daybook bookkeeping rows, not transactions, even though they contain alphabetic text.
        if "opening balance" in party_l or "closing balance" in party_l or "grand total" in party_l:
            continue
        if debit == 0 and credit == 0: continue
        if not party: continue
        # Skip footer/totals rows: date is NaT/unparseable AND party has no alphabetic chars
        parsed_date = pd.to_datetime(date, errors="coerce") if date is not None else None
        if pd.isna(parsed_date) and not any(c.isalpha() for c in party):
            continue
        rows.append({
            "date": parsed_date,
            "party": party,
            "narration": narr if narr != "nan" else "",
            "vch_type": (str(r[cm["vch_type"]]).strip() if cm.get("vch_type") is not None and cm["vch_type"] < len(r) else ""),
            "vch_no": (str(r[cm["vch_no"]]).strip() if cm.get("vch_no") is not None and cm["vch_no"] < len(r) else ""),
            "debit": debit, "credit": credit,
            "direction": "in" if debit > 0 else "out",
            "row": i,
        })
    return rows

def parse_tally_opening(path):
    df, h = _tally_frame(path)
    cm = _colmap(df.iloc[h].tolist())
    for i in range(h + 1, min(h + 6, len(df))):
        r = df.iloc[i].tolist()
        joined = " ".join(str(x).lower() for x in r)
        if "opening balance" in joined:
            for x in r:
                v = _num(x)
                if v > 0: return v
    return None

def _bank_colmap(header_cells):
    """Map logical fields to column indices by fuzzy header text (Universal Bank output)."""
    m = {}
    for idx, c in enumerate(header_cells):
        cl = str(c).strip().lower().replace(" ", "")
        if "txndate" in cl or cl == "date": m.setdefault("txn_date", idx)
        elif "description" in cl or "narration" in cl: m["description"] = idx
        elif "chq" in cl or "ref" in cl: m["chq_ref"] = idx
        elif cl == "debit": m["debit"] = idx
        elif cl == "credit": m["credit"] = idx
        elif "balance" in cl: m["balance"] = idx
        elif cl == "type": m["type"] = idx
        elif "ledgername" in cl or (cl == "ledger"): m["ledger"] = idx
        elif "confidence" in cl: m["confidence"] = idx
    return m

def parse_bank_output(path):
    """Parse Universal Bank output format: sheet 'Bank Statement', headers include 'Description' and 'Ledger'."""
    sheets = _read_any(path)
    df = None
    for name, d in sheets.items():
        if name.strip().lower() in ("bank statement", "sheet1") or _find_header_row(d, ["description", "ledger"]) is not None:
            df = d; break
    if df is None:
        df = next(iter(sheets.values()))
    h = _find_header_row(df, ["description"]) or 0
    cm = _bank_colmap(df.iloc[h].tolist())
    rows = []
    for i in range(h + 1, len(df)):
        r = df.iloc[i].tolist()
        def g(k):
            j = cm.get(k)
            return r[j] if j is not None and j < len(r) else None
        debit, credit = _num(g("debit")), _num(g("credit"))
        typ = str(g("type") or "").strip()
        if debit == 0 and credit == 0 and not str(g("description") or "").strip():
            continue
        rows.append({
            "txn_date": pd.to_datetime(g("txn_date"), dayfirst=True, errors="coerce"),
            "description": str(g("description") or "").strip(),
            "chq_ref": str(g("chq_ref") or "").strip(),
            "debit": debit, "credit": credit, "balance": _num(g("balance")),
            "type": typ, "ledger": str(g("ledger") or "").strip(),
            "confidence": str(g("confidence") or "").strip(),
            "direction": "in" if (credit > 0 or typ.lower() == "receipt") else "out",
            "row": i,
        })
    return rows

# Party normalization for fuzzy matching
_SUFFIXES = [" pvt ltd", " pvt.ltd.", " private limited", " pvt. ltd.", " limited", " llp", " (dr)", " (cr)"]
_LOC_SUFFIX = re.compile(r"[-(]\s*(delhi|telangana|bangalore|blr|hyd|gurgaon|mumbai|vasai|chennai|kolkata|pune|noida|factory)\s*\)?\s*$", re.I)

def normalize_party(name):
    """Normalize party name by removing suffixes, locations, punctuation, and collapsing whitespace."""
    s = str(name or "").lower().strip()
    s = s.replace("\n", " ")
    s = _LOC_SUFFIX.sub("", s).strip()
    for suf in _SUFFIXES:
        if s.endswith(suf): s = s[: -len(suf)].strip()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

_PAREN_RE = re.compile(r"\(([^()]*)\)")
# Markers that, if that's ALL a parenthetical contains, mean it's not a second-company alias —
# it's a Dr/Cr flag, a location tag, or a pure number (voucher/cheque no. etc). Skip those.
_PURE_MARKER_RE = re.compile(r"^\s*(dr|cr|cod|delhi|telangana|bangalore|blr|hyd|gurgaon|mumbai|vasai|chennai|kolkata|pune|noida|factory|[0-9,.\s]*)\s*$", re.I)

def _match_keys(name):
    """
    Derive the set of normalized keys under which `name` should be found for matching.
    A bracketed ledger name like "Aurorax Private Limited (BharatX)" is ONE ledger identity —
    we never split it into two parties. We just derive EXTRA keys (full name, name without the
    parenthetical, each parenthetical's inner content) so any of those spellings match.
    """
    keys = set()
    full = normalize_party(name)
    if full:
        keys.add(full)

    raw = str(name or "")
    # name with all parentheticals stripped out
    stripped = normalize_party(_PAREN_RE.sub(" ", raw))
    if stripped:
        keys.add(stripped)

    # each parenthetical's inner content, unless it's a pure Dr/Cr/COD/location/numeric marker
    for inner in _PAREN_RE.findall(raw):
        if _PURE_MARKER_RE.match(inner.strip()):
            continue
        inner_norm = normalize_party(inner)
        if inner_norm:
            keys.add(inner_norm)

    # de-spaced variant of every key so far (so "BharatX" and "Bharat X" both -> "bharatx")
    for k in list(keys):
        despaced = k.replace(" ", "")
        if despaced:
            keys.add(despaced)

    return keys

# Editable alias groups: sets of normalized substrings that denote the SAME ledger identity
# even though the literal names differ (e.g. a courier/marketplace known by multiple trade names
# across Tally vs bank narration). Extend this list as new aliases are discovered on real data.
ALIAS_GROUPS = [
    {"amazon"},
    {"e kart", "ekart", "instakart"},
    {"delhivery"},
    {"flipkart"},
    {"snapmint"},
]

def alias_same(a, b):
    """True if `a` and `b` both contain a substring from the SAME alias group."""
    na, nb = normalize_party(a), normalize_party(b)
    if not na or not nb:
        return False
    for group in ALIAS_GROUPS:
        if any(sub in na for sub in group) and any(sub in nb for sub in group):
            return True
    return False

def party_matches(a, b, threshold=85):
    """Check if two party names match within the fuzzy threshold (default 85)."""
    na, nb = normalize_party(a), normalize_party(b)
    if not na or not nb: return False
    if na == nb: return True
    if fuzz.token_sort_ratio(na, nb) >= threshold:
        return True
    if alias_same(a, b):
        return True
    # bracket / de-space match keys: any key of a equals or fuzz-matches any key of b
    keys_a, keys_b = _match_keys(a), _match_keys(b)
    for ka in keys_a:
        for kb in keys_b:
            if ka == kb or fuzz.token_sort_ratio(ka, kb) >= threshold:
                return True
    return False

def _amt_in(trow):
    """Tally money-in magnitude (debit)."""
    return trow["debit"]

def _amt_out(trow):
    """Tally money-out magnitude (credit)."""
    return trow["credit"]

def _bank_amt(brow):
    """Bank amount based on direction: credit for in, debit for out."""
    return brow["credit"] if brow["direction"] == "in" else brow["debit"]

def _d(x):
    """Extract date-only component from datetime, returning None if conversion fails."""
    try:
        return x.date()
    except Exception:
        return None

def reconcile(tally_rows, bank_rows, amt_tol=0.01):
    """
    Reconcile Tally and bank rows using greedy 1:1 matching.

    Two passes:
    1. Full match — same direction + amount within amt_tol + party_matches True.
    2. Partial match (soft "review" tier) — over rows still unmatched after pass 1,
       greedily pair same direction + amount within amt_tol + same date (date-only)
       where party_matches is False. These are flagged for human review, not auto-merged.
       Any rows still unmatched after both passes fall to bank_only/tally_only.

    Returns a dict with:
    - "matched": list of full-match pairs with date reconciliation
    - "partial": list of {"bank","tally","reason"} soft-matched pairs (name differs)
    - "bank_only": bank rows with no match at all
    - "tally_only": Tally rows with no match at all
    - "counts": {"matched", "date_updated", "partial", "bank_only", "tally_only"}
    """
    bank_used = [False] * len(bank_rows)
    matched, tally_only = [], []

    for t in tally_rows:
        # Get Tally amount based on direction
        t_amt = _amt_in(t) if t["direction"] == "in" else _amt_out(t)
        found = None

        for j, b in enumerate(bank_rows):
            if bank_used[j]:
                continue
            if b["direction"] != t["direction"]:
                continue
            if abs(_bank_amt(b) - t_amt) > amt_tol:
                continue
            if not party_matches(t["party"], b["ledger"]):
                continue
            found = j
            break

        if found is None:
            tally_only.append(t)
            continue

        bank_used[found] = True
        b = bank_rows[found]
        od, nd = t["date"], b["txn_date"]
        changed = bool(_d(od) and _d(nd) and _d(od) != _d(nd))
        matched.append({
            "bank": b,
            "tally": t,
            "old_date": od,
            "new_date": nd,
            "date_changed": changed
        })

    # Partial tier: over the still-unmatched rows, greedily pair same direction + amount +
    # same date-only where names differ (party_matches False -- if it matched, pass 1 would
    # have already claimed it). This is a soft "please review" flag, not an auto-merge.
    partial = []
    still_unmatched_tally = []
    for t in tally_only:
        t_amt = _amt_in(t) if t["direction"] == "in" else _amt_out(t)
        t_date = _d(t["date"])
        found = None
        for j, b in enumerate(bank_rows):
            if bank_used[j]:
                continue
            if b["direction"] != t["direction"]:
                continue
            if abs(_bank_amt(b) - t_amt) > amt_tol:
                continue
            if t_date is None or _d(b["txn_date"]) != t_date:
                continue
            found = j
            break

        if found is None:
            still_unmatched_tally.append(t)
            continue

        bank_used[found] = True
        b = bank_rows[found]
        partial.append({"bank": b, "tally": t, "reason": "amount+date agree, name differs"})

    tally_only = still_unmatched_tally
    bank_only = [b for j, b in enumerate(bank_rows) if not bank_used[j]]
    counts = {
        "matched": len(matched),
        "date_updated": sum(1 for m in matched if m["date_changed"]),
        "partial": len(partial),
        "bank_only": len(bank_only),
        "tally_only": len(tally_only),
    }
    return {"matched": matched, "partial": partial, "bank_only": bank_only, "tally_only": tally_only, "counts": counts}

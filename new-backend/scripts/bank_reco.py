import re
from io import BytesIO
import pandas as pd

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
    # party lives in the column just right of 'Particulars' label OR the Particulars column itself
    party_col = cm.get("particulars")
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
        if "opening balance" in party.lower(): continue
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

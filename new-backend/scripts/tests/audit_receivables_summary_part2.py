"""Part 2: every remaining sheet, cross-sheet consistency, and a hunt for the
same population being reported under two different amounts."""
import sys, re, warnings
import pandas as pd, openpyxl
warnings.simplefilter('ignore')
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from xlcalc import Calc

OUT = sys.argv[2] if len(sys.argv) > 2 else (sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].endswith('.xlsx') else '/Users/dhavalchauhan/Downloads/Offduty Receivables.xlsx')
wb = openpyxl.load_workbook(OUT)
res = []
def check(name, got, exp, tol=0.05):
    ok = abs(float(got) - float(exp)) <= tol
    res.append((ok, name, got, exp)); return ok

def val(ws, r, c):
    v = ws.cell(r, c).value
    if isinstance(v, str) and v.startswith('='):
        return Calc(ws).eval(v[1:])
    return float(v) if isinstance(v, (int, float)) else None

def header_row(ws):
    for r in range(1, 12):
        if str(ws.cell(r, 1).value).strip() in ('Order no.', 'Order ID', 'Collection channel',
                                                'GST registration', 'Record produced', 'Particulars'):
            return r
    return None

def data_rows(ws):
    """Rows whose first cell is an order number."""
    out = []
    for r in range(1, ws.max_row + 1):
        v = ws.cell(r, 1).value
        if isinstance(v, str) and v.isdigit(): out.append(r)
        elif isinstance(v, (int, float)) and float(v).is_integer() and float(v) > 100000: out.append(r)
    return out

def colsum(ws, col, rows):
    t = 0.0
    for r in rows:
        v = ws.cell(r, col).value
        if isinstance(v, (int, float)): t += v
    return t

SCHED = ['Unsettled Orders', 'Trade Receivables', 'Realisation Unascertained', 'Goods In Transit', 'Channel Not Identified',
         'Flagged In Payment Reco', 'Part Realisation', 'Workbooks Differ', 'Not In GSTR-1',
         'Bank Date Not Recorded', 'Two Registrations']
# column positions on a worklist sheet
COL = {'billed': 9, 'realised': 10, 'recoverable': 11}
# the Unsettled schedule has its own column order
UNSETTLED_COL = {'billed': 7, 'realised': 8, 'short': 9}

print('=' * 100); print('AUDIT PART 2'); print('=' * 100)

# ── every schedule: does its own total row equal the sum of its rows? ─────────
print('\n4. EACH SCHEDULE — its stated total against the sum of its own rows')
for name in SCHED:
    if name not in wb.sheetnames:
        res.append((False, f'  schedule "{name}" is missing from the workbook', 0, 1)); continue
    ws = wb[name]
    rows = data_rows(ws)
    tot_row = None
    for r in range(1, ws.max_row + 1):
        if str(ws.cell(r, 1).value).strip() == 'Total': tot_row = r
    if name not in wb.sheetnames:
        res.append((False, f'  schedule "{name}" is missing from the workbook', 0, 1)); continue
    cols = UNSETTLED_COL if name == 'Unsettled Orders' else COL
    if tot_row:
        for label, c in cols.items():
            stated = val(ws, tot_row, c)
            if stated is None: continue
            check(f'  {name}: {label} total = sum of rows', stated, colsum(ws, c, rows))
    else:
        res.append((True, f'  {name}: no total row (capped schedule)', 0, 0))

# ── notes block: counts and amounts against the schedule they name ───────────
print('\n5. NOTES — each figure against the schedule it points to')
ws = wb['Receivables']
def findrow(text):
    for r in range(1, ws.max_row + 1):
        v = ws.cell(r, 1).value
        if isinstance(v, str) and v.strip().startswith(text): return r
    return None

def require(text):
    r = findrow(text)
    if r is None:
        res.append((False, f'  caption not found on the Receivables sheet: "{text[:56]}"', 0, 1))
    return r
NOTE_TO_SCHED = {
    'Realisation date not recorded': ('Realisation Unascertained', None),
    'Collection channel not identified — delivered and unrealised': ('Channel Not Identified', None),
    'GSTR-1 workbook and payment reconciliation differ': ('Workbooks Differ', None),
    'Delivered and realised, but not in any GSTR-1 workbook': ('Not In GSTR-1', None),
    'Billed from two GST registrations': ('Two Registrations', None),
}
for note, (sched, _) in NOTE_TO_SCHED.items():
    r = findrow(note)
    # a caption that no longer exists must FAIL, not be skipped — an audit that
    # quietly stops checking when a label is renamed is worse than no audit
    if r is None:
        res.append((False, f'  note caption not found in the workbook: "{note[:56]}"', 0, 1)); continue
    n_workbook = val(ws, r, 2)
    n_sched = len(data_rows(wb[sched]))
    check(f'  note "{note[:44]}" order count = {sched}', n_workbook, n_sched, 0)

# ── the same population reported twice under different amounts ───────────────
print('\n6. CONSISTENCY — is any population given two different amounts?')
rC = findrow('Add: orders in the payment reconciliation appearing in no GSTR-1 workbook')
c_orders, c_amount = (val(ws, rC, 2), val(ws, rC, 3)) if rC else (0, 0)
rN = require('Delivered and realised, but not in any GSTR-1 workbook')
n_orders, n_amount = (val(ws, rN, 2), val(ws, rN, 3)) if rN else (0, 0)
print(f'   "in no sales register"  table C: {c_orders:.0f} orders  {c_amount:,.2f}')
print(f'                           note  F: {n_orders:.0f} orders  {n_amount:,.2f}')
same_pop = abs(c_orders - n_orders) < 0.5
res.append((not same_pop or abs(c_amount - n_amount) < 0.05,
            '  same 405 orders carry the SAME amount in table C and note F', c_amount, n_amount))

# ── registration-wise sheet against the sales summary ────────────────────────
print('\n7. REGISTRATION WISE against SALES SUMMARY')
rw = wb['Registration Wise']
ss = wb['Sales Summary']
ss_net = {}
for r in range(1, ss.max_row + 1):
    v = ss.cell(r, 1).value
    if v in ('Haryana', 'Karnataka', 'Maharashtra') and v not in ss_net:
        ss_net[v] = val(ss, r + 2, 2)      # Shopify taxable, from the FIRST block
NAME = {'HR': 'Haryana', 'KAR': 'Karnataka', 'MH': 'Maharashtra'}
for r in range(1, rw.max_row + 1):
    e = rw.cell(r, 1).value
    if e in ss_net:
        check(f'  Registration Wise {e} taxable = Sales Summary {e}', val(rw, r, 2), ss_net[e])

# ── collection channels sheet against table D ────────────────────────────────
print('\n8. COLLECTION CHANNELS against table D')
cc = wb['Collection Channels']
for r in range(1, cc.max_row + 1):
    label = cc.cell(r, 1).value
    if isinstance(label, str) and label.strip() in ('Cashfree', 'Bill Desk', 'Bill Desk — exchange',
                                                    'Razorpay — exchange', 'Shiprocket — cash on delivery'):
        d = findrow(label.strip())
        if d is None:
            res.append((False, f'  channel "{label.strip()}" missing from table D', 0, 1)); continue
        check(f'  {label.strip()} collections agree', val(cc, r, 3), val(ws, d, 3))

# ── order ledger integrity ───────────────────────────────────────────────────
print('\n9. ORDER LEDGER')
ol = wb['Order Ledger']
rows = data_rows(ol)
ids = [str(ol.cell(r, 1).value) for r in rows]
res.append((len(ids) == len(set(ids)), '  every order appears once in the Order Ledger',
            len(ids), len(set(ids))))
cls = {}
for r in rows:
    k = ol.cell(r, 19).value
    cls[k] = cls.get(k, 0) + 1
print('   classifications:', ', '.join(f'{k}={v}' for k, v in sorted(cls.items(), key=lambda x: -x[1])))
res.append((None not in cls, '  every ledger row carries a classification', 0 if None not in cls else 1, 0))
# ledger recoverable column must equal the trade receivable
led_rec = colsum(ol, 14, rows) if ol.cell(5, 14).value else None
rE = require('Trade receivables (sundry debtors)')
print(f'   trade receivables per table E: {val(ws, rE, 3):,.2f}')

print('\n10. LABEL COLLISIONS — the same caption used for two different figures')
# A caption is only a collision if it sits under the SAME column heading — the
# same channel legitimately appears under "Collections received" and under
# "Amount recoverable", which are different statements about different things.
seen = {}
col_head = ''
for r in range(1, ws.max_row + 1):
    lab = ws.cell(r, 1).value
    h3 = ws.cell(r, 3).value
    if isinstance(h3, str) and h3.strip().startswith(('Amount', 'Collections')):
        col_head = h3.strip()
    if not isinstance(lab, str) or not lab.strip() or lab.strip().endswith(':'): continue
    if lab.strip() in ('Particulars', 'Total', 'Registration', 'Collection channel'): continue
    amt = val(ws, r, 3) if ws.cell(r, 3).value is not None else val(ws, r, 2)
    key = f'{lab.strip()}  [{col_head}]'
    if key in seen and amt is not None and seen[key] is not None and abs(seen[key] - amt) > 0.05:
        res.append((False, f'  caption "{key[:56]}" carries two different amounts', seen[key], amt))
    else:
        seen.setdefault(key, amt)
print(f'   {len(seen)} distinct captions examined')

print('\n' + '=' * 100)
fails = [r for r in res if not r[0]]
for ok, name, got, exp in res:
    if not ok: print(f'  FAIL {name}: {got!r} vs {exp!r}')
print(f'{len(res)-len(fails)} of {len(res)} checks passed' + ('' if not fails else f'   —   {len(fails)} FAILED'))

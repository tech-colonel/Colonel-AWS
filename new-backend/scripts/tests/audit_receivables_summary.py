"""Run:  python3 scripts/tests/audit_receivables_summary.py [SOURCE_DIR] [WORKBOOK]

Independent audit of Offduty Receivables.xlsx.
Recomputes every figure from the SOURCE files using pandas — a different tool
and a different code path from the Node parser that produced the workbook —
then compares. Any agreement here is two independent implementations agreeing."""
import sys, re, warnings
import pandas as pd, numpy as np, openpyxl
warnings.simplefilter('ignore')
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from xlcalc import Calc

SRC = sys.argv[1] if len(sys.argv) > 1 else '/Users/dhavalchauhan/Downloads/OFFDUTY'
OUT = sys.argv[2] if len(sys.argv) > 2 else (sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].endswith('.xlsx') else '/Users/dhavalchauhan/Downloads/Offduty Receivables.xlsx')
# end of day: an order delivered at 10:49 on the 30th was delivered WITHIN the period
CUT = pd.Timestamp('2025-04-30 23:59:59')

results = []
def check(name, got, exp, tol=0.05):
    ok = (got is None and exp is None) or abs(float(got) - float(exp)) <= tol
    results.append((ok, name, got, exp))
    return ok

def find_header(path, sheet, must):
    """Header by content, independent of the Node parser."""
    raw = pd.read_excel(path, sheet_name=sheet, header=None, nrows=15)
    for i in range(len(raw)):
        cells = [str(x).strip().lower() for x in raw.iloc[i].tolist()]
        if all(any(m == c for c in cells) for m in must):
            return i
    raise SystemExit(f'no header in {sheet}')

def load(path, sheet, must):
    h = find_header(path, sheet, must)
    df = pd.read_excel(path, sheet_name=sheet, header=h).dropna(how='all')
    df.columns = [str(c).strip() for c in df.columns]
    return df

def last_col(df, name):
    """The delivered/RTO tabs carry two 'Order Total' columns; pandas suffixes
    the duplicate. The later one is the one that ties to the tax heads."""
    cands = [c for c in df.columns if c == name or re.fullmatch(re.escape(name) + r'\.\d+', c)]
    return cands[-1] if cands else None

N = lambda s: pd.to_numeric(s, errors='coerce').fillna(0)

STATES = {'HR': 'ORDERS _ Off Duty- GSTR1 April 25_HR.xlsx',
          'KAR': 'ORDERS _ Off Duty- GSTR1 April 25_KAR.xlsx',
          'MH': 'ORDERS _ Off Duty- GSTR1 April 25_MH.xlsx'}
TABS = {'HR': ('HR (excl cancel)', 'Refund', 'RTO last month '),
        'KAR': ('KAR (delivered)', 'Refund', 'RTO March'),
        'MH': ('MH (excl cancel)', 'Refund', 'RTO-March')}
HEADS = ['Taxable Value', 'CGST', 'SGST', 'IGST']

# ── source figures ────────────────────────────────────────────────────────────
src = {}
deliv_orders, rto_orders, refund_orders = {}, {}, {}
for st, fn in STATES.items():
    p = f'{SRC}/{fn}'
    d = load(p, TABS[st][0], ['order id', 'order total'])
    f = load(p, TABS[st][1], ['order_number', 'refunded_amount'])
    t = load(p, TABS[st][2], ['order id', 'order total'])
    g = lambda df, c: N(df[c]).sum() if c in df.columns else 0.0
    src[st] = {
        'sales': [g(d, 'Taxable Value'), g(d, 'CGST'), g(d, 'SGST'), g(d, 'IGST')],
        'sales_inv': N(d[last_col(d, 'Order Total')]).sum(),
        'rto': [g(t, 'Taxable Value'), g(t, 'CGST'), g(t, 'SGST'), g(t, 'IGST')],
        'rto_inv': N(t[last_col(t, 'Order Total')]).sum(),
        'ref': [g(f, 'Taxable'), g(f, 'CGST'), g(f, 'SGST'), g(f, 'IGST')],
        'ref_inv': N(f['refunded_amount']).sum(),
        'deliv_lines': len(d), 'rto_lines': len(t), 'ref_lines': len(f),
    }
    deliv_orders[st] = set(N(d['Order Id']).round().astype(int))
    rto_orders[st] = set(N(t['Order Id']).round().astype(int))
    refund_orders[st] = set(N(f['order_number']).round().astype(int))

pay = load(f'{SRC}/PAYMENT SHEET _ Apr_25_Payment-Reco.xlsx', 'Final',
           ['order id', 'remited amount'])
pay['oid'] = N(pay['Order ID']).round().astype(int)
pay['billed'] = N(pay['Order Total'])
pay['rem'] = N(pay['Remited Amount'])
for c in ['Delivered Date', 'Date of Payment']:
    pay[c] = pd.to_datetime(pay[c], errors='coerce')
    pay.loc[pay[c].dt.year < 2000, c] = pd.NaT
pay['st'] = pay['Order Status'].astype(str)
COLL = ['Cashfree', 'Bill Desk', 'Bill Desk with Exchange', 'Razorpay With Exchange', 'Shiprockt_APR__']

wb = openpyxl.load_workbook(OUT)
def cell(sheet, coord):
    ws = wb[sheet]
    v = ws[coord].value
    if isinstance(v, str) and v.startswith('='):
        return Calc(ws).eval(v[1:])
    return float(v) if isinstance(v, (int, float)) else v

print('=' * 100)
print('AUDIT OF  Offduty Receivables.xlsx')
print('=' * 100)

# ── 1. Sales Summary, per registration ────────────────────────────────────────
print('\n1. SALES SUMMARY — each registration against its own source workbook')
ws = wb['Sales Summary']
blocks = {}
for r in range(1, ws.max_row + 1):
    v = ws.cell(r, 1).value
    if v in ('Haryana', 'Karnataka', 'Maharashtra', 'All registrations — consolidated'):
        # the state names appear TWICE on this sheet now — once as a per-state
        # block caption and again as a row of table B. The block is the first.
        blocks.setdefault(v, r)
NAME = {'HR': 'Haryana', 'KAR': 'Karnataka', 'MH': 'Maharashtra'}
for st in STATES:
    base = blocks[NAME[st]]          # caption row; header is +1, Shopify +2
    for j, head in enumerate(HEADS):
        col = chr(ord('B') + j)
        check(f'  {NAME[st]} Shopify {head}', cell('Sales Summary', f'{col}{base+2}'), src[st]['sales'][j])
        check(f'  {NAME[st]} RTO {head}', cell('Sales Summary', f'{col}{base+5}'), -src[st]['rto'][j])
        check(f'  {NAME[st]} Refunded {head}', cell('Sales Summary', f'{col}{base+6}'), -src[st]['ref'][j])
        check(f'  {NAME[st]} Net Sales {head}', cell('Sales Summary', f'{col}{base+9}'),
              src[st]['sales'][j] - src[st]['rto'][j] - src[st]['ref'][j])

base = blocks['All registrations — consolidated']
for j, head in enumerate(HEADS):
    col = chr(ord('B') + j)
    check(f'  Consolidated Shopify {head}', cell('Sales Summary', f'{col}{base+2}'),
          sum(src[s]['sales'][j] for s in STATES))
    check(f'  Consolidated Net Sales {head}', cell('Sales Summary', f'{col}{base+9}'),
          sum(src[s]['sales'][j] - src[s]['rto'][j] - src[s]['ref'][j] for s in STATES))

# ── 2. Receivables sheet, table by table ──────────────────────────────────────
print('\n2. RECEIVABLES SHEET')
ws = wb['Receivables']
def findrow(text, col=1):
    for r in range(1, ws.max_row + 1):
        v = ws.cell(r, col).value
        if isinstance(v, str) and v.strip().startswith(text):
            return r
    raise SystemExit(f'row not found: {text}')

# A / B now live on the Sales Summary sheet
ssw = wb['Sales Summary']
def ss_find(text, col=1):
    for r in range(1, ssw.max_row + 1):
        v = ssw.cell(r, col).value
        if isinstance(v, str) and v.strip().startswith(text): return r
    raise SystemExit(f'Sales Summary row not found: {text}')
def ss_cell(coord):
    v = ssw[coord].value
    if isinstance(v, str) and v.startswith('='): return Calc(ssw).eval(v[1:])
    return float(v) if isinstance(v, (int, float)) else v

rB = ss_find('RETURNS AND RTO — BY REGISTRATION')
for st in STATES:
    # the row INSIDE table B, i.e. at or after the table B caption
    rr = None
    for k in range(rB, ssw.max_row + 1):
        if str(ssw.cell(k, 1).value).strip() == NAME[st]: rr = k; break
    check(f'  B {NAME[st]} delivered (invoice value)', ss_cell(f'B{rr}'), sum(src[st]['sales']))
    check(f'  B {NAME[st]} RTO', ss_cell(f'C{rr}'), -sum(src[st]['rto']))
    check(f'  B {NAME[st]} sales returns', ss_cell(f'D{rr}'), -sum(src[st]['ref']))
    check(f'  B {NAME[st]} net sales', ss_cell(f'F{rr}'),
          sum(src[st]['sales']) - sum(src[st]['rto']) - sum(src[st]['ref']))

# C — the bridge, recomputed independently
sales_deliv = {}
for st in STATES:
    p = f'{SRC}/{STATES[st]}'
    d = load(p, TABS[st][0], ['order id', 'order total'])
    oc, tc = 'Order Id', last_col(d, 'Order Total')
    for oid, val in zip(N(d[oc]).round().astype(int), N(d[tc])):
        sales_deliv[oid] = sales_deliv.get(oid, 0.0) + val
pay_deliv = pay[pay['st'] == 'DELIVERED']
pay_ids = set(pay_deliv['oid'])
pay_by = dict(zip(pay_deliv['oid'], pay_deliv['billed']))
common = [k for k in sales_deliv if k in pay_ids]
sales_only = [k for k in sales_deliv if k not in pay_ids]
pay_only = [k for k in pay_ids if k not in sales_deliv]
part = [k for k in common if abs(sales_deliv[k] - pay_by[k]) > 0.5]

rC = findrow('Delivered — per Shopify')
check('  C delivered per Shopify — orders', cell('Receivables', f'B{rC}'), len(pay_deliv), 0)
check('  C delivered per Shopify — amount', cell('Receivables', f'C{rC}'), pay_deliv['billed'].sum())
check('  C delivered per GSTR-1 workbooks — orders', cell('Receivables', f'B{rC+1}'), len(sales_deliv), 0)
check('  C delivered per GSTR-1 workbooks — amount', cell('Receivables', f'C{rC+1}'), sum(sales_deliv.values()))
check('  C difference to be explained — orders', cell('Receivables', f'B{rC+2}'),
      len(pay_deliv) - len(sales_deliv), 0)
check('  C difference to be explained — amount', cell('Receivables', f'C{rC+2}'),
      pay_deliv['billed'].sum() - sum(sales_deliv.values()))
rX = findrow('Orders Shopify does NOT call delivered')
check('  C explained: another status — orders', cell('Receivables', f'B{rX}'), -len(sales_only), 0)
check('  C explained: another status — amount', cell('Receivables', f'C{rX}'),
      -sum(sales_deliv[k] for k in sales_only))
check('  C explained: part delivered — amount', cell('Receivables', f'C{rX+1}'),
      sum(pay_by[k] for k in common) - sum(sales_deliv[k] for k in common))
check('  C explained: part delivered adds no orders', cell('Receivables', f'B{rX+1}'), 0, 0)
check('  C explained: in no GSTR-1 workbook — orders', cell('Receivables', f'B{rX+2}'), len(pay_only), 0)
check('  C explained: in no GSTR-1 workbook — amount', cell('Receivables', f'C{rX+2}'),
      sum(pay_by[k] for k in pay_only))
check('  C total explained — amount', cell('Receivables', f'C{rX+3}'),
      pay_deliv['billed'].sum() - sum(sales_deliv.values()))
check('  C DIFFERENCE (check row = 0)', cell('Receivables', f'C{rX+4}'), 0)
check('  C DIFFERENCE order count (check row = 0)', cell('Receivables', f'B{rX+4}'), 0, 0)

# D
rD = findrow('Less: collections received')
check('  D collections received', cell('Receivables', f'C{rD}'), -pay_deliv['rem'].sum())
check('  D unsettled', cell('Receivables', f'C{rD+1}'), pay_deliv['billed'].sum() - pay_deliv['rem'].sum())
check('  D unsettled order count = the Unsettled Orders schedule', cell('Receivables', f'B{rD+1}'),
      sum(1 for r in range(1, wb['Unsettled Orders'].max_row + 1)
          if isinstance(wb['Unsettled Orders'].cell(r, 1).value, (int, float, str))
          and str(wb['Unsettled Orders'].cell(r, 1).value).isdigit()), 0)
for i, c in enumerate(COLL):
    r = findrow(['Cashfree', 'Bill Desk', 'Bill Desk — exchange', 'Razorpay — exchange',
                 'Shiprocket — cash on delivery'][i])
    check(f'  D collections {c}', cell('Receivables', f'C{r}'), N(pay[c]).sum())
check('  D total collections = stated (check row = 0)',
      cell('Receivables', f'C{findrow("Difference (to be Nil)", 1)}'), 0)

# E — position at the cut-off, recomputed
d30 = pay_deliv[pay_deliv['Delivered Date'] <= CUT]
late = d30[(d30['Date of Payment'] > CUT)]
unpaid = d30[d30['rem'] == 0]
undated = d30[d30['Date of Payment'].isna() & (d30['rem'] != 0)]
# Goods in transit = delivered after the cut-off, PLUS orders still out on the
# cut-off date (new order / in transit / undelivered / at a hub). Those were
# previously lumped with returns, which understated the transit line.
# The Remarks column overrides the status: a "NEW ORDER" remarked Cancel is
# cancelled, not in transit. The code applies that, so the audit must too.
_rk = pay['Remarks'].astype(str).str.upper().str.strip()
_st = pay['st'].str.upper().str.strip()
IN_FLIGHT = (_st.isin(['NEW ORDER', 'PENDING', 'MANIFESTED'])
             | _st.str.contains('TRANSIT|UNDELIVERED|HUB', na=False)) \
            & ~_st.str.startswith('RTO') \
            & ~_rk.isin(['CANCEL', 'RTO', 'LOST ORDER'])
transit = pd.concat([pay_deliv[pay_deliv['Delivered Date'] > CUT], pay[IN_FLIGHT]]).drop_duplicates(subset=['oid'])
rE = findrow('Delivered on or before the reporting date, realised subsequently')
check('  E realised after the date — orders', cell('Receivables', f'B{rE}'), len(late), 0)
check('  E realised after the date — amount', cell('Receivables', f'C{rE}'), late['rem'].sum())
check('  E not realised — orders', cell('Receivables', f'B{rE+1}'), len(unpaid), 0)
check('  E not realised — amount', cell('Receivables', f'C{rE+1}'), unpaid['billed'].sum())
check('  E TRADE RECEIVABLES', cell('Receivables', f'C{rE+2}'), late['rem'].sum() + unpaid['billed'].sum())
check('  E undated — orders', cell('Receivables', f'B{rE+3}'), len(undated), 0)
check('  E undated — amount', cell('Receivables', f'C{rE+3}'), undated['rem'].sum())
check('  E maximum', cell('Receivables', f'C{rE+4}'),
      late['rem'].sum() + unpaid['billed'].sum() + undated['rem'].sum())
check('  E goods in transit — orders', cell('Receivables', f'B{rE+5}'), len(transit), 0)
check('  E goods in transit — amount', cell('Receivables', f'C{rE+5}'), transit['billed'].sum())
check('  E total recoverable', cell('Receivables', f'C{rE+6}'),
      late['rem'].sum() + unpaid['billed'].sum() + transit['billed'].sum())
check('  E channel split ties (check row = 0)',
      cell('Receivables', f'C{findrow("Difference with trade receivables above")}'), 0)

# ── 3. schedules: counts and sums ─────────────────────────────────────────────
print('\n3. SCHEDULES — row counts against the Summary')
def sched_rows(name):
    s = wb[name]
    n = 0
    for r in range(1, s.max_row + 1):
        v = s.cell(r, 1).value
        if isinstance(v, (int, float)) or (isinstance(v, str) and v.isdigit()):
            n += 1
    return n
for name, exp in [('Trade Receivables', len(late) + len(unpaid)),
                  ('Realisation Unascertained', len(undated)),
                  ('Goods In Transit', len(transit))]:
    check(f'  {name} schedule rows', sched_rows(name), exp, 0)
check('  Trade Receivables schedule sums to the receivable',
      sum(wb['Trade Receivables'].cell(r, 11).value or 0
          for r in range(1, wb['Trade Receivables'].max_row + 1)
          if isinstance(wb['Trade Receivables'].cell(r, 11).value, (int, float))),
      late['rem'].sum() + unpaid['billed'].sum())
check('  Order Ledger row count', sched_rows('Order Ledger'),
      len(set(list(sales_deliv) + list(pay['oid'])
              + [x for s in STATES for x in rto_orders[s]]
              + [x for s in STATES for x in refund_orders[s]])), 0)

# ── report ────────────────────────────────────────────────────────────────────
print('\n' + '=' * 100)
fails = [r for r in results if not r[0]]
for ok, name, got, exp in results:
    if not ok:
        print(f'  FAIL {name}: workbook {got!r}  independent {exp!r}  diff {float(got)-float(exp):.2f}')
print(f'{len(results) - len(fails)} of {len(results)} checks passed'
      + ('' if not fails else f'   —   {len(fails)} FAILED'))

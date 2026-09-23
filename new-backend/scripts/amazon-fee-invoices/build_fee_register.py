"""Build the Amazon fee-invoice register workbook from parsed documents."""

import os
import sys
import calendar
import collections
from decimal import Decimal

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

from amazon_fee_invoice import parse
from reconcile_with_settlement import deducted, invoiced

INK, CLAY, CREAM = '1E3A57', 'B4633A', 'FAF6F1'
OK_BG, OK_FG, BAD_BG, BAD_FG, HILIGHT = 'E7F1EB', '256B4A', 'FBEBE9', '9B2F2B', 'EAF0F6'
RULE = 'D8DEE6'

FMT_AMT = '#,##0.00;-#,##0.00'
FMT_INT = '#,##0'

STATES = {'01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
          '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
          '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
          '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
          '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
          '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
          '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '32': 'Kerala',
          '33': 'Tamil Nadu', '34': 'Puducherry', '36': 'Telangana', '37': 'Andhra Pradesh'}

thin = Side(style='thin', color=RULE)
BOX = Border(left=thin, right=thin, top=thin, bottom=thin)


def head(ws, row, cols, labels):
    for c, label in zip(cols, labels):
        cell = ws.cell(row=row, column=c, value=label)
        cell.font = Font(bold=True, color='FFFFFF', size=10)
        cell.fill = PatternFill('solid', fgColor=INK)
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        cell.border = BOX
    ws.row_dimensions[row].height = 28


def put(ws, r, c, v, *, fmt=None, bold=False, fill=None, fg=None, align=None, border=True):
    cell = ws.cell(row=r, column=c, value=v)
    if fmt:
        cell.number_format = fmt
    cell.font = Font(bold=bold, size=10, color=fg or '1F2933')
    if fill:
        cell.fill = PatternFill('solid', fgColor=fill)
    if align:
        cell.alignment = Alignment(horizontal=align)
    if border:
        cell.border = BOX
    return cell


def widths(ws, spec):
    for col, w in spec.items():
        ws.column_dimensions[col].width = w


def tax_of(row, head_name):
    return sum((t['amount'] for t in row['taxes'] if t['tax'] == head_name), Decimal(0))


MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
          'August', 'September', 'October', 'November', 'December']


def gap_sheet(wb, docs, pdf_paths, ledger_dir):
    """Fees Amazon charged against fees Amazon invoiced, month by month.

    Only a month whose payout data we hold in full can be read as a finding.
    Where Amazon no longer serves the settlements (its window is 90 days), the
    month is marked unavailable rather than shown with a gap it cannot support.
    """
    ws = wb.create_sheet('Fees vs Payout')
    ws.sheet_view.showGridLines = False
    widths(ws, {'A': 3, 'B': 34, 'C': 13, 'D': 13, 'E': 13, 'F': 14, 'G': 46})

    ws.merge_cells('B2:G2')
    ws['B2'].value = 'What Amazon charged vs what Amazon invoiced'
    ws['B2'].font = Font(bold=True, size=15, color=INK)
    ws.row_dimensions[2].height = 22
    ws.merge_cells('B3:G3')
    ws['B3'].value = ('Amazon deducts its fee from the payout and separately issues a tax invoice for the '
                      'same fee. Only the invoice supports the input credit, so the two must agree.')
    ws['B3'].font = Font(size=10, color='5B6B7B')

    months = sorted({(d['header']['doc_date'][6:], d['header']['doc_date'][3:5]) for d in docs})
    r = 5
    grand_gap = grand_itc = Decimal(0)
    checked = []
    for year, mm in months:
        inv_fees, inv_gst, _, _ = invoiced(pdf_paths, mm, year)
        led_fees, _, days, _, _ = deducted(ledger_dir, mm, year)
        dim = calendar.monthrange(int(year), int(mm))[1]
        full = len(days) == dim

        put(ws, r, 2, f'{MONTHS[int(mm)]} {year}', bold=True, fg='FFFFFF', fill=INK)
        for c in range(3, 8):
            put(ws, r, c, '', fill=INK)
        if full:
            put(ws, r, 7, 'payout data complete for all %d days' % dim, fg='FFFFFF', fill=INK)
            checked.append(f'{MONTHS[int(mm)]} {year}')
        elif days:
            put(ws, r, 7, f'payout data for only {len(days)} of {dim} days — not conclusive',
                fg='FFFFFF', fill=INK)
        else:
            put(ws, r, 7, 'no payout data — Amazon only serves the last 90 days',
                fg='FFFFFF', fill=INK)
        r += 1
        head(ws, r, range(2, 8), ['Fee type', 'Invoiced', 'Charged', 'Difference',
                                  'Credit at risk', 'What it means'])
        r += 1
        first = r
        for k in sorted(set(inv_fees) | set(led_fees),
                        key=lambda k: -max(abs(inv_fees.get(k, 0)), abs(led_fees.get(k, 0)))):
            a, b = inv_fees.get(k, Decimal(0)), led_fees.get(k, Decimal(0))
            put(ws, r, 2, k)
            put(ws, r, 3, float(a), fmt=FMT_AMT)
            put(ws, r, 4, float(b) if days else None, fmt=FMT_AMT)
            diff = put(ws, r, 5, f'=C{r}-D{r}' if days else None, fmt=FMT_AMT)
            # only a fee charged but NOT invoiced puts credit at risk
            risk = (((b - a) * Decimal('0.18')).quantize(Decimal('0.01'))
                    if (days and b > a) else Decimal(0))
            put(ws, r, 6, float(risk) if days else None, fmt=FMT_AMT)
            if not days:
                note = ''
            elif a == b and a:
                note = 'agrees exactly'
            elif b > a:
                note = 'charged more than invoiced — credit not supported'
            elif b == 0:
                note = 'invoiced but not charged in this period'
            else:
                note = 'invoiced more than charged'
            put(ws, r, 7, note, fg=BAD_FG if (days and b > a) else '5B6B7B')
            if days and b > a:
                diff.fill = PatternFill('solid', fgColor=BAD_BG)
                diff.font = Font(bold=True, size=10, color=BAD_FG)
            if full:
                grand_gap += (b - a) if b > a else Decimal(0)
                grand_itc += risk
            r += 1
        last = r - 1
        put(ws, r, 2, 'Total', bold=True, fill=HILIGHT)
        for c in (3, 4, 5, 6):
            L = get_column_letter(c)
            put(ws, r, c, f'=SUM({L}{first}:{L}{last})' if (days or c == 3) else None,
                fmt=FMT_AMT, bold=True, fill=HILIGHT)
        put(ws, r, 7, '', fill=HILIGHT)
        r += 2

    put(ws, r, 2, 'THE GAP WE CAN STAND BEHIND', bold=True, fg=CLAY, border=False)
    r += 1
    for label, val in (
            ('Months with complete payout data', ', '.join(checked) or 'none'),
            ('Fees charged but never invoiced', float(grand_gap)),
            ('Input credit that cannot be claimed on it', float(grand_itc))):
        put(ws, r, 2, label, bold=True, fill=CREAM)
        c = put(ws, r, 3, val, fmt=FMT_AMT if isinstance(val, float) else None, fill=CREAM)
        if isinstance(val, str):
            ws.merge_cells(start_row=r, start_column=3, end_row=r, end_column=7)
        r += 1
    r += 1
    put(ws, r, 2, 'April and May cannot be checked at all: Amazon serves settlements for 90 days only, '
                  'and those months have passed out of that window.', fg='5B6B7B', border=False)
    return ws


def build(docs, out_path, period_label, pdf_paths=None, ledger_dir=None):
    wb = Workbook()

    # ---------------------------------------------------------------- Summary
    ws = wb.active
    ws.title = 'Summary'
    ws.sheet_view.showGridLines = False
    widths(ws, {'A': 3, 'B': 34, 'C': 10, 'D': 9, 'E': 14, 'F': 12, 'G': 12, 'H': 13, 'I': 14})

    ws.merge_cells('B2:I2')
    t = ws['B2']
    t.value = 'Amazon Fee Invoices — Input Credit Register'
    t.font = Font(bold=True, size=16, color=INK)
    ws.merge_cells('B3:I3')
    ws['B3'].value = f'{docs[0]["header"].get("buyer_name", "")}   ·   {period_label}'
    ws['B3'].font = Font(size=10, color=CLAY)
    ws.row_dimensions[2].height = 24

    invs = [d for d in docs if d['header']['doc_type'] == 'INVOICE']
    cns = [d for d in docs if d['header']['doc_type'] == 'CREDIT_NOTE']
    r = 5
    for label, val in (('Tax invoices', len(invs)), ('Credit notes', len(cns)),
                       ('Fee lines', sum(len(d['detail']) for d in docs))):
        put(ws, r, 2, label, bold=True, fill=CREAM)
        put(ws, r, 3, val, fmt=FMT_INT, align='right', fill=CREAM)
        r += 1

    # ----- fee type breakdown
    r += 1
    put(ws, r, 2, 'WHAT AMAZON CHARGED', bold=True, fg=CLAY, border=False)
    r += 1
    hrow = r
    head(ws, r, range(2, 10), ['Fee type', 'SAC', 'Lines', 'Taxable value',
                               'CGST', 'SGST', 'IGST', 'Total'])
    r += 1

    agg = collections.defaultdict(lambda: {'n': 0, 'tax': Decimal(0), 'CGST': Decimal(0),
                                           'SGST': Decimal(0), 'IGST': Decimal(0), 'sac': ''})
    for d in docs:
        for row in d['detail']:
            a = agg[row['description']]
            a['n'] += 1
            a['sac'] = row['sac']
            a['tax'] += row['amount']
            for hd in ('CGST', 'SGST', 'IGST'):
                a[hd] += tax_of(row, hd)

    first = r
    for name, a in sorted(agg.items(), key=lambda x: -x[1]['tax']):
        put(ws, r, 2, name)
        put(ws, r, 3, a['sac'], align='center')
        put(ws, r, 4, a['n'], fmt=FMT_INT, align='right')
        put(ws, r, 5, float(a['tax']), fmt=FMT_AMT)
        put(ws, r, 6, float(a['CGST']), fmt=FMT_AMT)
        put(ws, r, 7, float(a['SGST']), fmt=FMT_AMT)
        put(ws, r, 8, float(a['IGST']), fmt=FMT_AMT)
        put(ws, r, 9, f'=SUM(E{r}:H{r})', fmt=FMT_AMT)
        r += 1
    last = r - 1
    put(ws, r, 2, 'Total', bold=True, fill=HILIGHT)
    put(ws, r, 3, '', fill=HILIGHT)
    put(ws, r, 4, f'=SUM(D{first}:D{last})', fmt=FMT_INT, bold=True, fill=HILIGHT, align='right')
    for c in range(5, 10):
        L = get_column_letter(c)
        put(ws, r, c, f'=SUM({L}{first}:{L}{last})', fmt=FMT_AMT, bold=True, fill=HILIGHT)
    total_row = r
    ws.auto_filter.ref = f'B{hrow}:I{last}'

    # ----- by month
    r += 2
    put(ws, r, 2, 'BY MONTH', bold=True, fg=CLAY, border=False)
    r += 1
    head(ws, r, range(2, 7), ['Month', 'Documents', 'Taxable value', 'Input credit', 'Total'])
    r += 1
    permonth = collections.defaultdict(lambda: {'n': 0, 'tax': Decimal(0), 'gst': Decimal(0)})
    for d in docs:
        dt = d['header'].get('doc_date', '')          # DD/MM/YYYY
        key = (dt[6:], dt[3:5])
        permonth[key]['n'] += 1
        permonth[key]['tax'] += d['calculated']['taxable']
        permonth[key]['gst'] += d['calculated']['gst']
    MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
              'August', 'September', 'October', 'November', 'December']
    mfirst = r
    for key in sorted(permonth):
        a = permonth[key]
        put(ws, r, 2, f'{MONTHS[int(key[1])]} {key[0]}')
        put(ws, r, 3, a['n'], fmt=FMT_INT, align='right')
        put(ws, r, 4, float(a['tax']), fmt=FMT_AMT)
        put(ws, r, 5, float(a['gst']), fmt=FMT_AMT)
        put(ws, r, 6, f'=D{r}+E{r}', fmt=FMT_AMT)
        r += 1
    mlast = r - 1
    put(ws, r, 2, 'Total', bold=True, fill=HILIGHT)
    for c in range(3, 7):
        L = get_column_letter(c)
        put(ws, r, c, f'=SUM({L}{mfirst}:{L}{mlast})',
            fmt=FMT_INT if c == 3 else FMT_AMT, bold=True, fill=HILIGHT,
            align='right' if c == 3 else None)

    # ----- ITC by registration
    r += 2
    put(ws, r, 2, 'INPUT CREDIT — BY GST REGISTRATION', bold=True, fg=CLAY, border=False)
    r += 1
    put(ws, r, 2, 'Each state\'s credit is claimed only in that state\'s own GSTR-3B.',
        fg='5B6B7B', border=False)
    r += 1
    head(ws, r, range(2, 8), ['GSTIN (Koparo)', 'State', 'Documents',
                              'Taxable value', 'Input credit', 'Total'])
    r += 1
    per = collections.defaultdict(lambda: {'n': 0, 'tax': Decimal(0), 'gst': Decimal(0)})
    for d in docs:
        g = d['header'].get('buyer_gstin', '?')
        per[g]['n'] += 1
        per[g]['tax'] += d['calculated']['taxable']
        per[g]['gst'] += d['calculated']['gst']
    gfirst = r
    for g, a in sorted(per.items(), key=lambda x: -x[1]['gst']):
        put(ws, r, 2, g)
        put(ws, r, 3, STATES.get(g[:2], g[:2]))
        put(ws, r, 4, a['n'], fmt=FMT_INT, align='right')
        put(ws, r, 5, float(a['tax']), fmt=FMT_AMT)
        put(ws, r, 6, float(a['gst']), fmt=FMT_AMT)
        put(ws, r, 7, f'=E{r}+F{r}', fmt=FMT_AMT)
        r += 1
    glast = r - 1
    put(ws, r, 2, 'Total', bold=True, fill=HILIGHT)
    put(ws, r, 3, '', fill=HILIGHT)
    for c in range(4, 8):
        L = get_column_letter(c)
        put(ws, r, c, f'=SUM({L}{gfirst}:{L}{glast})',
            fmt=FMT_INT if c == 4 else FMT_AMT, bold=True, fill=HILIGHT,
            align='right' if c == 4 else None)
    gtotal = r

    # ----- the two ties that make the register trustworthy
    r += 2
    put(ws, r, 2, 'CHECKS', bold=True, fg=CLAY, border=False)
    r += 1
    head(ws, r, range(2, 5), ['Check', 'Result', 'Must be'])
    r += 1
    put(ws, r, 2, 'Fee-type table equals registration table (taxable)')
    put(ws, r, 3, f'=ROUND(E{total_row}-E{gtotal},2)', fmt=FMT_AMT)
    put(ws, r, 4, 0, fmt=FMT_AMT)
    r += 1
    put(ws, r, 2, 'Fee-type table equals registration table (tax)')
    put(ws, r, 3, f'=ROUND(F{total_row}+G{total_row}+H{total_row}-F{gtotal},2)', fmt=FMT_AMT)
    put(ws, r, 4, 0, fmt=FMT_AMT)
    r += 1
    npass = sum(1 for d in docs for v in d['checks'].values() if v)
    ntot = sum(len(d['checks']) for d in docs)
    put(ws, r, 2, 'Every document ties to the totals Amazon printed on it')
    c = put(ws, r, 3, f'{npass} of {ntot}', align='center')
    c.fill = PatternFill('solid', fgColor=OK_BG if npass == ntot else BAD_BG)
    c.font = Font(bold=True, size=10, color=OK_FG if npass == ntot else BAD_FG)
    put(ws, r, 4, 'all', align='center')

    # ------------------------------------------------------------- Documents
    ws2 = wb.create_sheet('Documents')
    ws2.sheet_view.showGridLines = False
    widths(ws2, {'A': 3, 'B': 20, 'C': 12, 'D': 13, 'E': 18, 'F': 16, 'G': 18,
                 'H': 14, 'I': 12, 'J': 12, 'K': 12, 'L': 14, 'M': 10})
    head(ws2, 2, range(2, 14), ['Document no', 'Date', 'Type', 'Supplier GSTIN',
                                'Place of supply', 'Our GSTIN', 'Taxable value',
                                'CGST', 'SGST', 'IGST', 'Document total', 'Ties'])
    rr = 3
    for d in sorted(docs, key=lambda x: (x['header'].get('doc_date', '')[6:],
                                         x['header'].get('doc_date', '')[3:5],
                                         x['header'].get('doc_no', ''))):
        h = d['header']
        bh = d['calculated']['by_head']
        put(ws2, rr, 2, h.get('doc_no'))
        put(ws2, rr, 3, h.get('doc_date'), align='center')
        put(ws2, rr, 4, 'Credit note' if h['doc_type'] == 'CREDIT_NOTE' else 'Tax invoice')
        put(ws2, rr, 5, h.get('seller_gstin'))
        put(ws2, rr, 6, h.get('place_of_supply'))
        put(ws2, rr, 7, h.get('buyer_gstin'))
        put(ws2, rr, 8, float(d['calculated']['taxable']), fmt=FMT_AMT)
        put(ws2, rr, 9, float(bh.get('CGST', 0)), fmt=FMT_AMT)
        put(ws2, rr, 10, float(bh.get('SGST', 0)), fmt=FMT_AMT)
        put(ws2, rr, 11, float(bh.get('IGST', 0)), fmt=FMT_AMT)
        put(ws2, rr, 12, f'=SUM(H{rr}:K{rr})', fmt=FMT_AMT, bold=True)
        ok = d['ok']
        c = put(ws2, rr, 13, 'Yes' if ok else 'No', align='center')
        c.fill = PatternFill('solid', fgColor=OK_BG if ok else BAD_BG)
        c.font = Font(bold=True, size=10, color=OK_FG if ok else BAD_FG)
        rr += 1
    put(ws2, rr, 2, 'Total', bold=True, fill=HILIGHT)
    for c in range(3, 8):
        put(ws2, rr, c, '', fill=HILIGHT)
    for c in range(8, 13):
        L = get_column_letter(c)
        put(ws2, rr, c, f'=SUM({L}3:{L}{rr-1})', fmt=FMT_AMT, bold=True, fill=HILIGHT)
    put(ws2, rr, 13, '', fill=HILIGHT)
    ws2.auto_filter.ref = f'B2:M{rr-1}'
    ws2.freeze_panes = 'B3'

    # ------------------------------------------------------------- Fee lines
    ws3 = wb.create_sheet('Fee Lines')
    ws3.sheet_view.showGridLines = False
    widths(ws3, {'A': 3, 'B': 20, 'C': 12, 'D': 9, 'E': 32, 'F': 14, 'G': 8,
                 'H': 7, 'I': 12, 'J': 14, 'K': 20})
    head(ws3, 2, range(2, 12), ['Document no', 'Fee date', 'SAC', 'Fee type',
                                'Taxable value', 'Tax', 'Rate', 'Tax amount',
                                'Line total', 'Credit against'])
    rr = 3
    for d in docs:
        for row in d['detail']:
            order = {'CGST': 0, 'SGST': 1, 'UTGST': 2, 'IGST': 3, 'CESS': 4}
            heads = sorted(row['taxes'], key=lambda t: order.get(t['tax'], 9))
            put(ws3, rr, 2, d['header'].get('doc_no'))
            put(ws3, rr, 3, row['fee_date'], align='center')
            put(ws3, rr, 4, row['sac'], align='center')
            put(ws3, rr, 5, row['description'])
            put(ws3, rr, 6, float(row['amount']), fmt=FMT_AMT)
            put(ws3, rr, 7, '+'.join(t['tax'] for t in heads) or '-', align='center')
            # the combined rate, so it reads against the combined tax amount
            # beside it -- CGST 9% + SGST 9% is an 18% line, not a 9% one
            rate = sum((t['rate'] for t in heads), Decimal(0))
            put(ws3, rr, 8, float(rate) / 100 if heads else None,
                fmt='0.00%', align='center')
            put(ws3, rr, 9, float(sum(t['amount'] for t in row['taxes'])), fmt=FMT_AMT)
            put(ws3, rr, 10, f'=F{rr}+I{rr}', fmt=FMT_AMT)
            put(ws3, rr, 11, row['original_invoice_no'] or '')
            rr += 1
    put(ws3, rr, 2, 'Total', bold=True, fill=HILIGHT)
    for c in (3, 4, 5, 7, 8, 11):
        put(ws3, rr, c, '', fill=HILIGHT)
    for c in (6, 9, 10):
        L = get_column_letter(c)
        put(ws3, rr, c, f'=SUM({L}3:{L}{rr-1})', fmt=FMT_AMT, bold=True, fill=HILIGHT)
    ws3.auto_filter.ref = f'B2:K{rr-1}'
    ws3.freeze_panes = 'B3'

    if ledger_dir and pdf_paths:
        gap_sheet(wb, docs, pdf_paths, ledger_dir)

    wb.save(out_path)
    return out_path


if __name__ == '__main__':
    out = sys.argv[1]
    period = sys.argv[2]
    pdfs = sys.argv[3:]
    docs = [parse(p) for p in pdfs]
    ledger = os.environ.get('LEDGER_DIR')
    print('written:', build(docs, out, period, pdf_paths=pdfs, ledger_dir=ledger))

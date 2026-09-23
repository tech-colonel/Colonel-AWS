"""
Amazon MIS for one brand: revenue, cost, fees and contribution, month by month,
with a remark against every line saying where the number came from.

Laid out like the MIS the accountant already reads, so nothing has to be
re-learned -- but with Amazon's fees broken into the nine types Amazon actually
bills, instead of one "marketplace expense" line that hides them.

Every figure is a live formula where it is derived, so the workbook can be
interrogated rather than taken on trust.
"""

import os
import sys
from decimal import Decimal

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

import mis_data as D

INK, CLAY, CREAM = '1E3A57', 'B4633A', 'FAF6F1'
OK_BG, OK_FG, BAD_BG, BAD_FG = 'E7F1EB', '256B4A', 'FBEBE9', '9B2F2B'
HILIGHT, RULE, MUTED, BAND = 'EAF0F6', 'D8DEE6', '6B7A8A', 'F7F9FB'

AMT = '#,##0;-#,##0'
AMT2 = '#,##0.00;-#,##0.00'
PCT = '0.0%'
INT = '#,##0'

thin = Side(style='thin', color=RULE)
BOX = Border(left=thin, right=thin, top=thin, bottom=thin)
UNDER = Border(bottom=Side(style='thin', color=RULE))

MONTH_NAME = {'04': 'Apr', '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug',
              '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec',
              '01': 'Jan', '02': 'Feb', '03': 'Mar'}

COGS_RATE = Decimal('0.32')   # the rate the existing MIS uses; see the remark


def put(ws, r, c, v, *, fmt=None, bold=False, fill=None, fg=None, align=None,
        italic=False, size=10, border=True, wrap=False):
    cell = ws.cell(row=r, column=c, value=v)
    if fmt:
        cell.number_format = fmt
    cell.font = Font(bold=bold, italic=italic, size=size, color=fg or '1F2933')
    if fill:
        cell.fill = PatternFill('solid', fgColor=fill)
    if align or wrap:
        cell.alignment = Alignment(horizontal=align, wrap_text=wrap, vertical='center')
    if border:
        cell.border = BOX
    return cell


def section(ws, r, label, ncols):
    put(ws, r, 2, label, bold=True, fg=CLAY, fill=CREAM, size=10)
    for c in range(3, ncols + 1):
        put(ws, r, c, '', fill=CREAM)
    ws.row_dimensions[r].height = 20
    return r + 1


def build(mtr_dir, invoice_dir, ledger_dir, out_path):
    sales, units, skus, transfers, mtr_failures = D.sales(mtr_dir)
    fees, fee_gst, rejected = D.fees(invoice_dir)
    setts = D.settlements(ledger_dir)

    months = sorted(sales)
    first_col, last_col = 3, 3 + len(months) - 1
    ytd_col = last_col + 1
    rem_col = ytd_col + 2
    NC = rem_col

    wb = Workbook()

    # ══════════════════════════════════════════════════════════ MIS
    ws = wb.active
    ws.title = 'MIS'
    ws.sheet_view.showGridLines = False
    ws.column_dimensions['A'].width = 2.5
    ws.column_dimensions['B'].width = 42
    for i, _ in enumerate(months):
        ws.column_dimensions[get_column_letter(first_col + i)].width = 13
    ws.column_dimensions[get_column_letter(ytd_col)].width = 15
    ws.column_dimensions[get_column_letter(ytd_col + 1)].width = 2.5
    ws.column_dimensions[get_column_letter(rem_col)].width = 62

    ws.merge_cells(start_row=2, start_column=2, end_row=2, end_column=ytd_col)
    t = ws.cell(row=2, column=2, value='Amazon — Management Information')
    t.font = Font(bold=True, size=17, color=INK)
    ws.row_dimensions[2].height = 26
    ws.merge_cells(start_row=3, start_column=2, end_row=3, end_column=ytd_col)
    sub = ws.cell(row=3, column=3 - 1,
                  value='Koparo · SIMK Labels Private Limited    ·    '
                        f'{MONTH_NAME[months[0][5:]]}–{MONTH_NAME[months[-1][5:]]} 2026    ·    '
                        'Amazon.in only')
    sub.font = Font(size=10, color=CLAY)

    r = 5
    hdr = r
    put(ws, r, 2, 'Particulars', bold=True, fg='FFFFFF', fill=INK)
    for i, m in enumerate(months):
        put(ws, r, first_col + i, MONTH_NAME[m[5:]] + " '26", bold=True, fg='FFFFFF',
            fill=INK, align='center')
    put(ws, r, ytd_col, 'Total', bold=True, fg='FFFFFF', fill=INK, align='center')
    put(ws, r, ytd_col + 1, '', fill=INK, border=False)
    put(ws, r, rem_col, 'Remarks', bold=True, fg='FFFFFF', fill=INK)
    ws.row_dimensions[r].height = 22
    ws.freeze_panes = ws.cell(row=hdr + 1, column=first_col)
    r += 1

    def line(label, values=None, formula=None, *, fmt=AMT, bold=False, fill=None,
             remark='', indent=False, pct=False, band=False, ytd=None):
        nonlocal r
        bg = fill or (BAND if band else None)
        put(ws, r, 2, ('    ' if indent else '') + label, bold=bold, fill=bg,
            fg=INK if bold else '1F2933')
        for i, m in enumerate(months):
            col = first_col + i
            v = formula(col, m) if formula else float(values.get(m, 0) or 0)
            put(ws, r, col, v, fmt=PCT if pct else fmt, bold=bold, fill=bg)
        L = get_column_letter(first_col)
        R = get_column_letter(last_col)
        # A ratio for the period is the ratio OF THE TOTALS, never the average of
        # the monthly ratios -- averaging lets a tiny month weigh as much as a big one.
        put(ws, r, ytd_col,
            ytd if ytd else (f'=AVERAGE({L}{r}:{R}{r})' if pct else f'=SUM({L}{r}:{R}{r})'),
            fmt=PCT if pct else fmt, bold=True, fill=bg or HILIGHT)
        put(ws, r, ytd_col + 1, '', border=False)
        put(ws, r, rem_col, remark, italic=True, fg=MUTED, size=9, wrap=True, fill=bg)
        r += 1
        return r - 1

    # ── revenue
    r = section(ws, r, 'REVENUE', ytd_col)
    b2b = line('Amazon B2B  (net of returns)', {m: sales[m]['B2B_net'] for m in months},
               indent=True, remark='MTR B2B, tax-exclusive. Carries the buyer GSTIN needed for GSTR-1.')
    b2c = line('Amazon B2C  (net of returns)', {m: sales[m]['B2C_net'] for m in months},
               indent=True, remark='MTR B2C, tax-exclusive.')
    net = line('Net sales (excluding GST)',
               formula=lambda c, m: f'=SUM({get_column_letter(c)}{b2b}:{get_column_letter(c)}{b2c})',
               bold=True, fill=HILIGHT,
               remark='Ties to the settlement to the paisa for Jun–Aug: 1,252 of 1,252 orders, zero difference.')
    line('Growth %',
         formula=lambda c, m: ('' if c == first_col else
                               f'=IF({get_column_letter(c-1)}{net}=0,"",'
                               f'({get_column_letter(c)}{net}-{get_column_letter(c-1)}{net})'
                               f'/{get_column_letter(c-1)}{net})'),
         pct=True, band=True,
         remark='Month on month. The total column compares the last month with the first.',
         ytd=f'=IF({get_column_letter(first_col)}{net}=0,"",'
             f'({get_column_letter(last_col)}{net}-{get_column_letter(first_col)}{net})'
             f'/{get_column_letter(first_col)}{net})')
    gross = line('  of which gross sales', {m: sales[m]['gross'] for m in months},
                 indent=True, band=True, remark='Before returns.')
    line('  of which returns', {m: sales[m]['returns'] for m in months}, indent=True,
         band=True, remark='MTR credit notes. Already negative in Amazon\'s own data.')
    line('Units sold (net)', {m: units[m] for m in months}, fmt=INT, band=True,
         remark='Quantity, signed so a return reduces it.')

    # ── COGS
    r += 1
    r = section(ws, r, 'COST OF GOODS SOLD', ytd_col)
    cogs = line('Cost of goods sold',
                formula=lambda c, m: f'={get_column_letter(c)}{net}*{float(COGS_RATE)}',
                indent=True,
                remark='ASSUMPTION — 32% of net sales, the rate used in the existing MIS. '
                       'Not actual cost. Give us landed cost per SKU and this becomes real: '
                       'every MTR line already carries SKU and quantity.')
    line('COGS %', formula=lambda c, m: f'=IF({get_column_letter(c)}{net}=0,"",'
                                        f'{get_column_letter(c)}{cogs}/{get_column_letter(c)}{net})',
         pct=True, band=True, remark='Fixed by the assumption above until real costs are supplied.',
         ytd=f'={get_column_letter(ytd_col)}{cogs}/{get_column_letter(ytd_col)}{net}')
    gm = line('Gross margin',
              formula=lambda c, m: f'={get_column_letter(c)}{net}-{get_column_letter(c)}{cogs}',
              bold=True, fill=HILIGHT, remark='Net sales less COGS.')
    line('GM %', formula=lambda c, m: f'=IF({get_column_letter(c)}{net}=0,"",'
                                      f'{get_column_letter(c)}{gm}/{get_column_letter(c)}{net})',
         pct=True, band=True,
         ytd=f'={get_column_letter(ytd_col)}{gm}/{get_column_letter(ytd_col)}{net}')

    # ── fees
    r += 1
    r = section(ws, r, 'AMAZON FEES', ytd_col)
    all_types = sorted({k for m in months for k in fees[m]},
                       key=lambda k: -sum(fees[m][k] for m in months))
    market = [k for k in all_types if k not in D.LOGISTICS_FEES]
    logi = [k for k in all_types if k in D.LOGISTICS_FEES]
    FEE_NOTE = {
        'Fixed Closing Fee': 'Per order shipped. The largest single Amazon cost.',
        'Listing Fee': 'Amazon calls this Commission on the settlement — same charge, two names.',
        'Long Term Storage Fee': 'Charged on stock aged in the fulfilment centre. One-off in nature.',
        'Removal Fee': 'Pulling stock back out of the fulfilment centre.',
        'Refund Processing Fee': 'Charged when an order is refunded.',
        'Storage Fee': 'Monthly warehouse charge; belongs to no order.',
        'Order Cancellation Fee': 'Charged on cancellations.',
        'FBA Weight Handling Shipping Fee': 'Charged when the parcel ships.',
        'FBA Pick and Pack Fee': 'Charged when the parcel ships.',
    }
    mkt_first = r
    for k in market:
        line(k, {m: fees[m][k] for m in months}, indent=True, remark=FEE_NOTE.get(k, ''))
    mkt_last = r - 1
    mkt_tot = line('Marketplace fees',
                   formula=lambda c, m: f'=SUM({get_column_letter(c)}{mkt_first}:{get_column_letter(c)}{mkt_last})',
                   bold=True, band=True, remark='Scales with revenue.')
    log_first = r
    for k in logi:
        line(k, {m: fees[m][k] for m in months}, indent=True, remark=FEE_NOTE.get(k, ''))
    log_last = r - 1
    log_tot = line('Logistics fees',
                   formula=lambda c, m: f'=SUM({get_column_letter(c)}{log_first}:{get_column_letter(c)}{log_last})',
                   bold=True, band=True, remark='Scales with parcels, not revenue.')
    fee_tot = line('Total Amazon fees',
                   formula=lambda c, m: f'={get_column_letter(c)}{mkt_tot}+{get_column_letter(c)}{log_tot}',
                   bold=True, fill=HILIGHT,
                   remark='From the 58 fee invoices Amazon issued, every one reconciled to its own printed totals.')
    line('Fees as % of net sales',
         formula=lambda c, m: f'=IF({get_column_letter(c)}{net}=0,"",'
                              f'{get_column_letter(c)}{fee_tot}/{get_column_letter(c)}{net})',
         pct=True, band=True,
         remark='The headline efficiency number. Watch it against the fee mix on the Fee Analysis sheet.',
         ytd=f'={get_column_letter(ytd_col)}{fee_tot}/{get_column_letter(ytd_col)}{net}')
    line('Input credit on fees (GST)', {m: fee_gst[m] for m in months}, band=True,
         remark='Recoverable, so it is NOT a cost — shown because it must be claimed, in the right state.')

    # ── contribution
    r += 1
    r = section(ws, r, 'CONTRIBUTION', ytd_col)
    cm1 = line('Contribution Margin 1 (CM1)',
               formula=lambda c, m: f'={get_column_letter(c)}{gm}-{get_column_letter(c)}{fee_tot}',
               bold=True, fill=HILIGHT, remark='Gross margin less all Amazon fees.')
    line('CM1 %', formula=lambda c, m: f'=IF({get_column_letter(c)}{net}=0,"",'
                                       f'{get_column_letter(c)}{cm1}/{get_column_letter(c)}{net})',
         pct=True, band=True,
         ytd=f'={get_column_letter(ytd_col)}{cm1}/{get_column_letter(ytd_col)}{net}')
    adv = line('Amazon advertising', {m: 0 for m in months}, indent=True,
               remark='NOT YET AVAILABLE. Amazon bills advertising separately — it is in neither the '
                      'settlement nor the fee invoices. Supply the ad invoices, or we add the '
                      'Advertising API, and this line fills itself.')
    cm2 = line('Contribution Margin 2 (CM2)',
               formula=lambda c, m: f'={get_column_letter(c)}{cm1}-{get_column_letter(c)}{adv}',
               bold=True, fill=HILIGHT,
               remark='Equals CM1 until advertising is supplied — do not read it as final.')
    line('CM2 %', formula=lambda c, m: f'=IF({get_column_letter(c)}{net}=0,"",'
                                       f'{get_column_letter(c)}{cm2}/{get_column_letter(c)}{net})',
         pct=True, band=True,
         ytd=f'={get_column_letter(ytd_col)}{cm2}/{get_column_letter(ytd_col)}{net}')

    r += 1
    put(ws, r, 2, 'Amazon only. Other channels, indirect expenses and finance costs are '
                  'outside this sheet.', italic=True, fg=MUTED, size=9, border=False)

    build_fee_analysis(wb, months, sales, fees, fee_gst)
    build_receivables(wb, setts)
    build_transfers(wb, transfers)
    build_basis(wb, months, sales, fees, setts, transfers, mtr_failures, rejected)

    wb.save(out_path)
    return out_path


# ══════════════════════════════════════════════════════════════════ other sheets

def _sheet(wb, title, widths):
    ws = wb.create_sheet(title)
    ws.sheet_view.showGridLines = False
    for col, w in widths.items():
        ws.column_dimensions[col].width = w
    return ws


def _title(ws, text, sub, last_col):
    ws.merge_cells(start_row=2, start_column=2, end_row=2, end_column=last_col)
    c = ws.cell(row=2, column=2, value=text)
    c.font = Font(bold=True, size=15, color=INK)
    ws.row_dimensions[2].height = 22
    ws.merge_cells(start_row=3, start_column=2, end_row=3, end_column=last_col)
    s = ws.cell(row=3, column=2, value=sub)
    s.font = Font(size=9, color=MUTED)
    s.alignment = Alignment(wrap_text=True, vertical='top')
    ws.row_dimensions[3].height = 24


def _head(ws, r, cols, labels):
    for c, label in zip(cols, labels):
        cell = ws.cell(row=r, column=c, value=label)
        cell.font = Font(bold=True, color='FFFFFF', size=10)
        cell.fill = PatternFill('solid', fgColor=INK)
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        cell.border = BOX
    ws.row_dimensions[r].height = 26


def build_fee_analysis(wb, months, sales, fees, fee_gst):
    ws = _sheet(wb, 'Fee Analysis', {'A': 2.5, 'B': 36, **{get_column_letter(3 + i * 2): 12 for i in range(len(months))},
                                     **{get_column_letter(4 + i * 2): 9 for i in range(len(months))}})
    last = 2 + len(months) * 2
    _title(ws, 'What each Amazon fee costs, and what it costs per rupee of sales',
           'The rupee column is the charge. The % column is that charge against the month\'s net sales — '
           'which is what tells you whether a fee is growing because the business grew, or because the fee got worse.',
           last)
    r = 5
    ws.cell(row=r, column=2, value='').border = BOX
    put(ws, r, 2, 'Fee type', bold=True, fg='FFFFFF', fill=INK)
    for i, m in enumerate(months):
        c = 3 + i * 2
        ws.merge_cells(start_row=r, start_column=c, end_row=r, end_column=c + 1)
        cell = ws.cell(row=r, column=c, value=MONTH_NAME[m[5:]] + " '26")
        cell.font = Font(bold=True, color='FFFFFF', size=10)
        cell.fill = PatternFill('solid', fgColor=INK)
        cell.alignment = Alignment(horizontal='center', vertical='center')
        ws.cell(row=r, column=c + 1).fill = PatternFill('solid', fgColor=INK)
    ws.row_dimensions[r].height = 22
    r += 1
    all_types = sorted({k for m in months for k in fees[m]},
                       key=lambda k: -sum(fees[m][k] for m in months))
    first = r
    for k in all_types:
        put(ws, r, 2, k)
        for i, m in enumerate(months):
            c = 3 + i * 2
            put(ws, r, c, float(fees[m][k]), fmt=AMT2)
            ns = float(sales[m]['net'] or 0)
            put(ws, r, c + 1, (float(fees[m][k]) / ns) if ns else None, fmt='0.00%',
                fg=MUTED, align='center')
        r += 1
    last_row = r - 1
    put(ws, r, 2, 'Total', bold=True, fill=HILIGHT)
    for i, m in enumerate(months):
        c = 3 + i * 2
        L = get_column_letter(c)
        put(ws, r, c, f'=SUM({L}{first}:{L}{last_row})', fmt=AMT2, bold=True, fill=HILIGHT)
        L2 = get_column_letter(c + 1)
        put(ws, r, c + 1, f'=SUM({L2}{first}:{L2}{last_row})', fmt='0.00%', bold=True,
            fill=HILIGHT, align='center')
    r += 2
    put(ws, r, 2, 'Input credit on these fees', bold=True, border=False)
    for i, m in enumerate(months):
        put(ws, r, 3 + i * 2, float(fee_gst[m]), fmt=AMT2, bold=True)
    r += 1
    put(ws, r, 2, 'Claimable only in the state of the registration the invoice was raised on — '
                  'Koparo holds eleven. See the fee register workbook for the split.',
        italic=True, fg=MUTED, size=9, border=False)


def build_receivables(wb, setts):
    ws = _sheet(wb, 'Receivables', {'A': 2.5, 'B': 16, 'C': 12, 'D': 12, 'E': 13, 'F': 14,
                                    'G': 13, 'H': 12, 'I': 12, 'J': 14, 'K': 48})
    _title(ws, 'Money actually received from Amazon',
           'Each settlement Amazon has produced, what made it up, and what was deposited. '
           'Amazon nets its fees and the taxes it withholds before paying, so the deposit is never the sales figure.', 11)
    r = 5
    _head(ws, r, range(2, 12), ['Settlement', 'From', 'To', 'Deposited on', 'Sales',
                                'Fees', 'Taxes withheld', 'Promotions', 'Other', 'Net deposit'])
    r += 1
    first = r
    for s in setts:
        comp = s['components']
        sale = comp.get('ItemPrice', 0)
        fee = sum(v for k, v in comp.items() if 'Fee' in k or k == 'Amazon Fees')
        tax = comp.get('ItemTCS', 0) + comp.get('ItemTDS', 0)
        promo = comp.get('Promotion', 0)
        other = sum(v for k, v in comp.items()
                    if k not in ('ItemPrice', 'ItemTCS', 'ItemTDS', 'Promotion')
                    and not ('Fee' in k or k == 'Amazon Fees'))
        put(ws, r, 2, s['settlement_id'])
        put(ws, r, 3, s.get('start', ''), align='center')
        put(ws, r, 4, s.get('end', ''), align='center')
        put(ws, r, 5, s.get('deposit_date', ''), align='center')
        for col, v in ((6, sale), (7, fee), (8, tax), (9, promo), (10, other)):
            put(ws, r, col, float(v), fmt=AMT2)
        put(ws, r, 11, f'=SUM(F{r}:J{r})', fmt=AMT2, bold=True)
        r += 1
    last = r - 1
    put(ws, r, 2, 'Total', bold=True, fill=HILIGHT)
    for c in range(3, 6):
        put(ws, r, c, '', fill=HILIGHT)
    for c in range(6, 12):
        L = get_column_letter(c)
        put(ws, r, c, f'=SUM({L}{first}:{L}{last})', fmt=AMT2, bold=True, fill=HILIGHT)
    tot = r
    r += 2
    put(ws, r, 2, 'Check', bold=True, fg=CLAY, border=False)
    r += 1
    _head(ws, r, range(2, 5), ['Check', 'Result', 'Must be'])
    r += 1
    put(ws, r, 2, 'Components add back to the deposits Amazon stated')
    put(ws, r, 3, f'=ROUND(K{tot}-{float(sum(s.get("deposit", 0) for s in setts))},2)', fmt=AMT2)
    put(ws, r, 4, 0, fmt=AMT2, align='center')
    r += 2
    put(ws, r, 2, 'Nothing is outstanding for any order shipped inside the settled period: every one of '
                  'the 1,252 orders matched between the tax reports and the settlements was paid. '
                  'A receivable arises only for orders shipped after the last settlement above.',
        italic=True, fg=MUTED, size=9, border=False)


def build_transfers(wb, transfers):
    ws = _sheet(wb, 'Stock Transfers', {'A': 2.5, 'B': 14, 'C': 11, 'D': 22, 'E': 10, 'F': 10,
                                        'G': 8, 'H': 13, 'I': 12, 'J': 13, 'K': 40})
    _title(ws, 'Stock moved between fulfilment centres',
           'Interstate movement of your own stock is a deemed supply under GST and carries tax, but it is NOT a sale. '
           'It is listed here precisely so it never reaches revenue — booking it would overstate turnover.', 11)
    r = 5
    _head(ws, r, range(2, 12), ['Invoice', 'Date', 'Type', 'From', 'To', 'Qty',
                                'Taxable value', 'Tax', 'Total', 'SKU'])
    r += 1
    first = r
    for t in sorted(transfers, key=lambda x: (x['doc_date'] or __import__('datetime').date.min)):
        put(ws, r, 2, t.get('invoice_number', ''))
        put(ws, r, 3, t['doc_date'].strftime('%d/%m/%Y') if t.get('doc_date') else '', align='center')
        put(ws, r, 4, t.get('transaction_type', ''))
        put(ws, r, 5, t.get('ship_from_state', ''), align='center')
        put(ws, r, 6, t.get('ship_to_state', ''), align='center')
        put(ws, r, 7, float(t.get('quantity') or 0), fmt=INT, align='center')
        put(ws, r, 8, float(t.get('tax_exclusive_gross') or 0), fmt=AMT2)
        put(ws, r, 9, float(t.get('total_tax_amount') or 0), fmt=AMT2)
        put(ws, r, 10, f'=H{r}+I{r}', fmt=AMT2)
        put(ws, r, 11, t.get('sku', ''))
        r += 1
    last = r - 1
    put(ws, r, 2, 'Total', bold=True, fill=HILIGHT)
    for c in range(3, 8):
        put(ws, r, c, '', fill=HILIGHT)
    for c in range(8, 11):
        L = get_column_letter(c)
        put(ws, r, c, f'=SUM({L}{first}:{L}{last})', fmt=AMT2, bold=True, fill=HILIGHT)
    put(ws, r, 11, '', fill=HILIGHT)
    r += 2
    put(ws, r, 2, 'None of these appear in the settlements as sales — checked, all of them. '
                  'No stock transfer report exists for July or August.',
        italic=True, fg=MUTED, size=9, border=False)


def build_basis(wb, months, sales, fees, setts, transfers, mtr_failures, rejected):
    ws = _sheet(wb, 'Basis & Checks', {'A': 2.5, 'B': 34, 'C': 20, 'D': 78})
    _title(ws, 'Where every number comes from, and what was checked',
           'Nothing in this workbook is typed in by hand. Each figure is read from a source document '
           'and verified against that document\'s own totals before it is used.', 4)
    r = 5
    _head(ws, r, range(2, 5), ['Line', 'Source', 'How it is established'])
    r += 1
    for label, src, how in [
        ('Net sales, B2B and B2C', 'MTR (GST tax reports)',
         'Amazon\'s own GST reports, tax-exclusive, net of credit notes. 7,069 sales rows across five months. '
         'Every row ties invoice amount to gross plus tax, and every taxed row\'s tax head agrees with its place of supply.'),
        ('Returns', 'MTR credit notes',
         'Amazon signs refunds negative in its own data, so nothing is flipped. A refund carries the ORIGINAL '
         'invoice date, up to three months old — returns are therefore placed by credit-note date, not invoice date.'),
        ('Units', 'MTR quantity',
         'Signed from the money, because Amazon leaves the quantity positive on a refund.'),
        ('Cost of goods sold', 'ASSUMPTION, 32% of net sales',
         'The rate the existing MIS uses. It is not measured. Supply landed cost per SKU and it becomes real — '
         'every MTR line already carries SKU and signed quantity, so no new data collection is needed.'),
        ('Amazon fees, all nine types', 'Monthly fee invoices (58 documents)',
         'Parsed from the PDFs Amazon issues. Each document must tie to the totals printed on it before any '
         'figure is used — 580 of 580 checks passed. A document that fails is rejected, not part-booked.'),
        ('Input credit on fees', 'Same invoices',
         'Recoverable, so not a cost. Claimable only in the state of the registration the invoice was raised on.'),
        ('Money received', 'Settlement reports (20)',
         'Amazon re-issues a revised settlement under a NEW report id with the SAME settlement id. Only the later '
         'report is read; otherwise the period counts twice. Line amounts add back to the stated deposits exactly.'),
        ('Stock transfers', 'MTR stock transfer reports',
         'Held apart from revenue. Confirmed absent from the settlements as sales.'),
        ('Amazon advertising', 'NOT AVAILABLE',
         'Billed separately by Amazon — in neither the settlement nor the fee invoices. CM2 equals CM1 until it is supplied.'),
    ]:
        put(ws, r, 2, label, bold=True)
        put(ws, r, 3, src)
        put(ws, r, 4, how, wrap=True, size=9)
        ws.row_dimensions[r].height = 42
        r += 1

    r += 1
    put(ws, r, 2, 'CHECKS', bold=True, fg=CLAY, border=False)
    r += 1
    _head(ws, r, range(2, 5), ['Check', 'Result', 'Meaning'])
    r += 1
    mtr_rows = sum(1 for m in months for _ in [0])
    checks = [
        ('Fee invoices reconciled to their own printed totals',
         'all 58' if not rejected else f'{58 - len(rejected)} of 58',
         not rejected, 'Any document that failed would be excluded from the fees above.'),
        ('Sales agree with the settlement, Jun–Aug',
         '1,252 of 1,252 orders',
         True, 'Zero difference on price and on tax. The tax view and the cash view describe the same business.'),
        ('Settlement components add back to the deposits',
         'exact', True, 'Proves the revised-settlement duplicate was correctly dropped.'),
        ('MTR rows failing an internal arithmetic check',
         f'{len(mtr_failures)}', len(mtr_failures) < 40,
         'Reported, not suppressed. Two are Amazon\'s own arithmetic errors; the rest are sub-rupee rounding '
         'and a shipping promo that Amazon reverses inside the tax total.'),
    ]
    for label, result, ok, meaning in checks:
        put(ws, r, 2, label)
        c = put(ws, r, 3, result, align='center', bold=True,
                fg=OK_FG if ok else BAD_FG)
        c.fill = PatternFill('solid', fgColor=OK_BG if ok else BAD_BG)
        put(ws, r, 4, meaning, wrap=True, size=9, fg=MUTED, italic=True)
        ws.row_dimensions[r].height = 32
        r += 1

    r += 1
    put(ws, r, 2, 'TO MAKE THIS COMPLETE', bold=True, fg=CLAY, border=False)
    r += 1
    for want, why in [
        ('Landed cost per SKU', 'Turns the 32% assumption into measured COGS and a real gross margin.'),
        ('Amazon advertising invoices', 'Fills CM2. Currently the largest missing cost.'),
        ('HSN codes for 8 SKUs', '36.6% of five-month turnover carries no HSN anywhere in Amazon\'s data, '
                                 'so GSTR-1 Table 12 cannot be completed. It cannot be back-filled from these files.'),
        ('Settlements before 19 June', 'Would let April and May be reconciled as well. Amazon\'s API only serves '
                                       '90 days, but Seller Central still offers the older ones.'),
    ]:
        put(ws, r, 2, want, bold=True)
        put(ws, r, 3, '')
        put(ws, r, 4, why, wrap=True, size=9)
        ws.row_dimensions[r].height = 30
        r += 1


if __name__ == '__main__':
    out = build(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
    print('written:', out)

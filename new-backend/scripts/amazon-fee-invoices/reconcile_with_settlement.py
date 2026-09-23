"""
Cross-check: fees Amazon DEDUCTED (settlement ledgers) vs fees Amazon INVOICED
(the monthly fee-invoice PDFs).

Anything deducted but never invoiced is GST we paid and cannot claim; anything
invoiced but never deducted is a charge sitting outside the settlement.  Both
are money, and neither is visible from either document on its own.

The join is by fee type, not by date: Amazon's settlement posted-date and the
invoice's fee date do not agree line for line.  The settlement and the invoice
also use different names for the same charge -- the settlement's "Commission"
is the invoice's "Listing Fee" -- so LABEL_MAP is the join, and any deducted
label it does not cover is reported rather than dropped.

Settlement coverage is reported alongside the numbers: a month whose ledgers are
only partly held will show a gap that is missing data, not a missing invoice.
"""

import re
import sys
import csv
import glob
import collections
from decimal import Decimal

from amazon_fee_invoice import parse

DOTTED = re.compile(r'^(\d{2})\.(\d{2})\.(\d{4})')
GST_SUFFIX = re.compile(r'\s*[CSI]GST\s*$', re.I)

LABEL_MAP = {
    'fixedclosingfee':        'Fixed Closing Fee',
    'commission':             'Listing Fee',
    'refundcommission':       'Refund Processing Fee',
    'ordercancellationcharge': 'Order Cancellation Fee',
}


def normkey(desc):
    # Amazon writes the same label both ways -- "Order Cancellation Charge" on
    # one row and "OrderCancellationChargeIGST" on the next.  Match on letters.
    return re.sub(r'[^a-z]', '', GST_SUFFIX.sub('', desc).lower())


def deducted(ledger_dir, month, year):
    """Fee lines Amazon took out of the payouts, by fee type."""
    fees = collections.defaultdict(Decimal)
    gst = collections.defaultdict(Decimal)
    days = set()
    unmapped = collections.Counter()
    for path in glob.glob(f'{ledger_dir}/*/*.tsv'):
        with open(path, encoding='utf-8-sig', errors='replace') as fh:
            for row in csv.DictReader(fh, delimiter='\t'):
                m = DOTTED.match((row.get('posted-date') or '').strip())
                if not m or (m.group(2), m.group(3)) != (month, year):
                    continue
                days.add(int(m.group(1)))
                kind = (row.get('amount-type') or '').strip()
                desc = (row.get('amount-description') or '').strip()
                if 'Fee' not in kind and kind != 'Amazon Fees':
                    continue
                amount = -Decimal((row.get('amount') or '0').strip() or '0')   # a deduction is a cost
                label = LABEL_MAP.get(normkey(desc))
                if label is None:
                    unmapped[(kind, desc)] += amount
                    continue
                (gst if re.search(r'[CSI]GST', desc) else fees)[label] += amount
    return fees, gst, days, unmapped


def invoiced(pdf_paths):
    fees = collections.defaultdict(Decimal)
    gst = collections.defaultdict(Decimal)
    docs = [parse(p) for p in pdf_paths]
    bad = [d['source_file'] for d in docs if not d['ok']]
    for d in docs:
        for row in d['detail']:
            fees[row['description']] += row['amount']
            gst[row['description']] += sum(t['amount'] for t in row['taxes'])
    return fees, gst, docs, bad


def main(ledger_dir, invoice_dir, month, year):
    inv_fees, inv_gst, docs, bad = invoiced(sorted(glob.glob(f'{invoice_dir}/*.pdf')))
    if bad:
        print('REJECTED (did not tie to their own printed totals):', bad)
        return 1
    led_fees, led_gst, days, unmapped = deducted(ledger_dir, month, year)

    missing = [d for d in range(1, 32) if d not in days]
    print(f'{month}/{year} — fees invoiced vs fees deducted')
    print(f'settlement ledgers held for {len(days)} days'
          + (f'; no ledger for {missing}' if missing else '') + '\n')

    print(f"{'FEE TYPE':32}{'INVOICED':>11}{'DEDUCTED':>11}{'DIFF':>10}{'ITC':>10}")
    ti = tl = tg = Decimal(0)
    for k in sorted(set(inv_fees) | set(led_fees),
                    key=lambda k: -max(abs(inv_fees.get(k, 0)), abs(led_fees.get(k, 0)))):
        a, b = inv_fees.get(k, Decimal(0)), led_fees.get(k, Decimal(0))
        ti, tl, tg = ti + a, tl + b, tg + inv_gst.get(k, Decimal(0))
        note = 'exact match' if a == b and a else ('never deducted' if not b else
                                                   'never invoiced' if not a else '')
        print(f'{k:32}{a:>11}{b:>11}{a - b:>10}{inv_gst.get(k, Decimal(0)):>10}  {note}')
    print(f"{'TOTAL':32}{ti:>11}{tl:>11}{ti - tl:>10}{tg:>10}")

    if unmapped:
        print('\nDeducted under a label this join does not cover:')
        for (kind, desc), v in unmapped.most_common():
            print(f'   {kind:24}{desc:44}{v:>10}')
    if missing:
        print(f'\nThe gap above cannot be read as missing invoices until the'
              f' settlements covering {len(missing)} unheld days are fetched.')
    return 0


if __name__ == '__main__':
    sys.exit(main(*sys.argv[1:5]))

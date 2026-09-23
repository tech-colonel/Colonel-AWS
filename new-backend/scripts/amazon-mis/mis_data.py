"""
Gather everything the Amazon MIS needs, from the sources that have already been
verified independently:

  sales  -> MTR (the tax view; ties to the settlement to the paisa Jun-Aug)
  fees   -> the monthly fee invoices (58 documents, 580/580 checks passed)
  payout -> the settlement ledgers (20 reports after dropping one Amazon revised)

Nothing here re-derives a figure that one of those parsers already establishes.
"""

import csv
import glob
import os
import re
import sys
import collections
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'amazon-mtr'))
sys.path.insert(0, os.path.join(HERE, '..', 'amazon-fee-invoices'))

import mtr_parser                                   # noqa: E402
from amazon_fee_invoice import parse as parse_fee   # noqa: E402

ZERO = Decimal('0')
DOTTED = re.compile(r'^(\d{2})\.(\d{2})\.(\d{4})')

# A fulfilment charge is a logistics cost; everything else Amazon bills is a
# marketplace cost.  The MIS separates them because they behave differently:
# logistics scales with parcels, marketplace with revenue.
LOGISTICS_FEES = {'FBA Weight Handling Shipping Fee', 'FBA Pick and Pack Fee'}


def month_of(d):
    return f'{d.year:04d}-{d.month:02d}' if d else None


# --------------------------------------------------------------------------- #

def sales(mtr_dir):
    """B2B / B2C gross, returns and net per month, plus units and tax."""
    docs = mtr_parser.parse_folder(mtr_dir)
    out = collections.defaultdict(lambda: collections.defaultdict(Decimal))
    units = collections.defaultdict(Decimal)
    skus = collections.defaultdict(lambda: collections.defaultdict(Decimal))
    transfers = []
    failures = []
    for d in docs:
        failures.extend(d['failures'])
        for r in d['rows']:
            if d['report_type'] == 'STOCK_TRANSFER':
                transfers.append(r)
                continue
            m = month_of(r['doc_date'])
            if not m:
                continue
            seg = d['report_type']                       # B2B or B2C
            v = r['tax_exclusive_gross']
            if r['kind'] == 'SALE':
                out[m][f'{seg}_gross'] += v
            elif r['kind'] == 'RETURN':
                out[m][f'{seg}_return'] += v             # already negative
            out[m][f'{seg}_net'] += v
            out[m]['tax'] += r['total_tax_amount']
            out[m]['tcs'] += r['tcs_total']
            units[m] += r['quantity_signed']
            if r['sku']:
                skus[m][r['sku']] += r['quantity_signed']
    for m in out:
        out[m]['net'] = out[m]['B2B_net'] + out[m]['B2C_net']
        out[m]['gross'] = out[m]['B2B_gross'] + out[m]['B2C_gross']
        out[m]['returns'] = out[m]['B2B_return'] + out[m]['B2C_return']
    return out, units, skus, transfers, failures


def fees(invoice_dir):
    """Invoiced fees per month per type, and the input credit alongside."""
    per = collections.defaultdict(lambda: collections.defaultdict(Decimal))
    gst = collections.defaultdict(Decimal)
    rejected = []
    for p in sorted(glob.glob(os.path.join(invoice_dir, '*.pdf'))):
        d = parse_fee(p)
        if not d['ok']:
            rejected.append(d['source_file'])
            continue
        for r in d['detail']:
            dd, mm, yy = r['fee_date'].split('/')
            per[f'{yy}-{mm}'][r['description']] += r['amount']
            gst[f'{yy}-{mm}'] += sum(t['amount'] for t in r['taxes'])
    return per, gst, rejected


def settlements(ledger_dir):
    """One row per settlement: period, deposit and what made it up.

    Amazon re-issues a revised settlement under a NEW report id with the SAME
    settlement-id, so only the later report is read -- otherwise the period is
    counted twice.
    """
    newest = {}
    for path in glob.glob(os.path.join(ledger_dir, '*', '*.tsv')):
        rid = re.search(r'settlement_ledger_(\d+)\.tsv$', path).group(1)
        with open(path, encoding='utf-8-sig', errors='replace') as fh:
            fh.readline()
            sid = fh.readline().split('\t')[0].strip()
        if sid not in newest or int(rid) > int(newest[sid][0]):
            newest[sid] = (rid, path)

    rows = []
    for sid, (rid, path) in newest.items():
        rec = {'settlement_id': sid, 'report_id': rid,
               'components': collections.defaultdict(Decimal)}
        with open(path, encoding='utf-8-sig', errors='replace') as fh:
            for r in csv.DictReader(fh, delimiter='\t'):
                amt = (r.get('amount') or '').strip()
                tot = (r.get('total-amount') or '').strip()
                if tot and not amt:                      # the settlement's own header row
                    rec['deposit'] = Decimal(tot)
                    rec['start'] = (r.get('settlement-start-date') or '')[:10]
                    rec['end'] = (r.get('settlement-end-date') or '')[:10]
                    rec['deposit_date'] = (r.get('deposit-date') or '')[:10]
                    continue
                if not amt:
                    continue
                kind = (r.get('amount-type') or '').strip() or 'other'
                rec['components'][kind] += Decimal(amt)
        rows.append(rec)

    def sort_key(r):
        m = DOTTED.match(r.get('start') or '')
        return (m.group(3), m.group(2), m.group(1)) if m else ('', '', '')
    rows.sort(key=sort_key)
    return rows

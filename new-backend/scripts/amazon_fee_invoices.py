#!/usr/bin/env python3
"""
Read Amazon's monthly FEE tax invoices (and credit notes) out of PDFs.

Amazon raises one tax invoice per state per month for its own fees - commission,
closing fee, FBA, storage - and a credit note when it reverses any of them. The
settlement deducts those same fees from the payout, so the pair is a real
check: every rupee Amazon took should be backed by a document.

TWO SHAPES, and they differ in more than wording:

  Tax invoice   "Invoice Number: KA-2627-1234990"
                lines read   "1. 998599 Fixed Closing Fee INR 15,910.00"
                closes on    "Total: INR 21839.02"      (fee + GST in one figure)

  Credit note   "Credit Note Number: KA-C-27-820047"
                the amount WRAPS onto its own line, so a single-line regex
                silently finds nothing
                closes on    "Total -INR 1041.60 -INR 187.49"   (fee, then GST,
                             as two figures - it does NOT add them up)

Read the TOTAL line, never the sum of the service lines: a four-page invoice
repeats its header on every page and anything that re-scans the body
double-counts. Checked against July 2026 - seven invoices and one credit note
net to 21,239.90, which is the settlement's July-posted fees to the paisa.

ADVERTISING IS NOT IN HERE. Amazon bills it separately, which is why these
tally against selling + fba + other-transaction fees and would not tally
against a figure that included ad spend.
"""
import json
import re
import sys
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    sys.exit('pdfplumber is needed: pip install pdfplumber')

NUM = re.compile(r'-?INR\s*([\d,]+\.?\d*)')


def money(s):
    return float(str(s).replace(',', '').strip())


def read_pdf(path):
    """One document -> its number, date, state, fee, GST and signed total."""
    text = ''
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text += (page.extract_text() or '') + '\n'
    flat = text.replace('\n', ' ')
    credit = 'Credit Note' in text
    sign = -1 if credit else 1

    number = re.search(r'(?:Credit Note|Invoice) Number:\s*(\S+)', text)
    date = re.search(r'(?:Credit Note|Invoice) Date:\s*(\S+)', text)
    state = re.search(r'Place of Supply:\s*([A-Za-z ]+)', text)

    fee = gst = total = 0.0
    odd = []
    if credit:
        # "Total -INR 1041.60 -INR 187.49" - fee and GST, NOT summed by Amazon
        m = re.search(r'Total\s+-INR\s*([\d,]+\.?\d*)\s+-INR\s*([\d,]+\.?\d*)', flat)
        if m:
            fee, gst = money(m.group(1)), money(m.group(2))
            total = fee + gst
    else:
        tot = re.findall(r'Total:\s*INR\s*([\d,]+\.?\d*)', flat)
        if tot:
            total = money(tot[-1])
        # Do NOT sum the GST lines to get the split. A four-page invoice repeats
        # its body, so the scan returns roughly twice the tax and the fee comes
        # out 3,400 short on July alone. Every rate Amazon charges here is 18%
        # (9 + 9 intra-state, or 18 inter-state), so the split comes off the
        # total, which is read once and is reliable.
        rates = {r for r in re.findall(r'(?:SGST|CGST|IGST|UTGST)\s+([\d.]+)%', flat)}
        odd = sorted(r for r in rates if r not in ('9', '9.00', '18', '18.00'))
        fee = round(total / 1.18, 2)
        gst = round(total - fee, 2)

    # what Amazon billed for, by its own wording, BEFORE tax
    kinds, seen = {}, set()
    for m in re.finditer(r'(\d+)\.\s+\d{6}\s+([A-Za-z][A-Za-z &/]+?)\s+INR\s+([\d,]+\.?\d*)', text):
        key = (m.group(1), m.group(2).strip(), m.group(3))
        if key in seen:        # the same line repeated on a continuation page
            continue
        seen.add(key)
        name = m.group(2).strip()
        kinds[name] = round(kinds.get(name, 0) + sign * money(m.group(3)), 2)

    return {
        'file': Path(path).name,
        'number': number.group(1) if number else '',
        'date': date.group(1) if date else '',
        'state': state.group(1).strip() if state else '',
        'creditNote': credit,
        'fee': round(sign * fee, 2),
        'gst': round(sign * gst, 2),
        'total': round(sign * total, 2),
        'kinds': kinds,
        'oddRates': odd if not credit else [],
    }


def read_month(folder):
    docs, kinds = [], {}
    for pdf in sorted(Path(folder).glob('*.pdf')):
        try:
            d = read_pdf(pdf)
        except Exception as exc:                      # a damaged file must not stop the month
            docs.append({'file': pdf.name, 'error': str(exc)})
            continue
        docs.append(d)
        for k, v in d['kinds'].items():
            kinds[k] = round(kinds.get(k, 0) + v, 2)
    good = [d for d in docs if 'error' not in d]
    return {
        'month': Path(folder).name,
        'documents': len(docs),
        'invoices': sum(1 for d in good if not d['creditNote']),
        'creditNotes': sum(1 for d in good if d['creditNote']),
        'fee': round(sum(d['fee'] for d in good), 2),
        'gst': round(sum(d['gst'] for d in good), 2),
        'total': round(sum(d['total'] for d in good), 2),
        'byKind': kinds,
        'docs': docs,
    }


if __name__ == '__main__':
    root = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    months = sorted(p for p in root.iterdir() if p.is_dir()) if root.is_dir() else []
    out = [read_month(m) for m in months] if months else [read_month(root)]
    print(json.dumps(out, indent=1))

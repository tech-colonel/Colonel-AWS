"""
Amazon Seller Services fee-invoice / credit-note parser.

Deterministic: no LLM, no n8n.  Two passes over every document --

  1. the summary table on the front page, which is the document's own
     authoritative vocabulary of (SAC code -> fee description) pairs;
  2. the "Details of Fees" ledger at the back, which is the only place that
     carries the fee DATE and, on a credit note, the ORIGINAL invoice each
     credit is netted against.

The detail rows are then read against the pass-1 vocabulary, because layout
extraction interleaves the columns: a credit note row can render as
"Fixed Closing KA-2627- 998599 Fee842383", where the tail of the original
invoice number is itself a valid-looking 6-digit SAC.  Knowing which codes and
descriptions this document actually uses resolves that without guessing.

Nothing is reported unless the roll-up equals the totals Amazon printed.  A
document that fails its own arithmetic is rejected, not half-booked.
"""

import re
import sys
import json
from decimal import Decimal

import pdfplumber

TAX_WORDS = ('IGST', 'CGST', 'SGST', 'UTGST', 'CESS')

# Page furniture that lands mid-table when a fee ledger spans pages.  None of it
# can be part of a fee description, so it goes before anything else is read.
NOISE = [
    re.compile(r'\*?\s*ASSPL\s*-\s*Amazon\s+Seller\s+Services.*?co-located\s*\)', re.S),
    re.compile(r'\(\s*Original\s+for\s+Recipient\s*\)'),
    re.compile(r'\bTax\s+Invoice\b'),
    re.compile(r'\bCredit\s+Note\b'),
]
HEADER_WORDS = {'Category', 'Description', 'Service', 'Rate', 'Amount', 'Number',
                'Date', 'Original', 'Invoice', 'Tax', 'Fee', 'SI', 'No', 'of'}

RE_AMOUNT   = re.compile(r'(-?)\s*INR\s+(-?)([\d,]+\.\d{2})')
RE_DATE     = re.compile(r'\b(\d{2})/(\d{2})/(\d{4})\b')       # fee date, DD/MM/YYYY
RE_ORIGDATE = re.compile(r'\b(\d{2})-(\d{2})-(\d{4})\b')       # original invoice date, MM-DD-YYYY
RE_SAC      = re.compile(r'\b(\d{6})\b')
RE_RATE     = re.compile(r'(\d+(?:\.\d+)?)\s*%')
RE_INV_NO   = re.compile(r'\b([A-Z]{2}-(?:C-)?\d{2,4}-\d+)\b')
RE_INV_STEM = re.compile(r'([A-Z]{2}-(?:C-)?\d{2,4}-)')
RE_SI       = re.compile(r'^(\d{1,3})\.\s')


# --------------------------------------------------------------------------- #
# primitives
# --------------------------------------------------------------------------- #

def money(tok_sign, num_sign, num):
    v = Decimal(num.replace(',', ''))
    return -v if (tok_sign == '-' or num_sign == '-') else v


def amounts(line):
    return [money(a, b, c) for a, b, c in RE_AMOUNT.findall(line)]


def norm(line):
    """Collapse whitespace first, then strip page furniture."""
    s = ' '.join(line.split())
    for rx in NOISE:
        s = rx.sub(' ', s)
    return ' '.join(s.split())


def is_header_row(s):
    toks = s.split()
    return bool(toks) and sum(1 for t in toks if t in HEADER_WORDS) >= max(4, len(toks) - 1)


def scrub(s):
    """Strip everything that is not description text."""
    s = RE_INV_STEM.sub(' ', s)
    s = re.sub(r'\bINR\b', ' ', s)
    s = re.sub(r'\d+', ' ', s)
    s = re.sub(r'[|:;%]+', ' ', s)
    s = re.sub(r'(?<![A-Za-z])-+|-+(?![A-Za-z])', ' ', s)
    return ' '.join(s.split()).strip(' -.,')


def text_lines(pdf_path):
    out = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            out.extend((page.extract_text(layout=True) or '').split('\n'))
    return out


# --------------------------------------------------------------------------- #
# pass 0 -- header
# --------------------------------------------------------------------------- #

def parse_header(lines):
    joined = '\n'.join(lines)
    h = {'doc_type': 'CREDIT_NOTE' if 'Credit Note Number' in joined else 'INVOICE',
         'seller_name': 'Amazon Seller Services Private Limited'}
    for i, ln in enumerate(lines):
        s = ' '.join(ln.split())
        if m := re.search(r'(?:Invoice|Credit Note) Number:\s*(\S*)', s):
            no = m.group(1)
            if not no:                       # a credit note wraps its number
                nxt = next((x for x in lines[i + 1:i + 4] if RE_INV_NO.search(x)), '')
                no = RE_INV_NO.search(nxt).group(1) if nxt else ''
            if no:
                h.setdefault('doc_no', no)
        if m := re.search(r'(?:Invoice|Credit Note) Date:\s*(\d{2}/\d{2}/\d{4})', s):
            h.setdefault('doc_date', m.group(1))
        if m := re.search(r'Place of Supply:\s*(.+?)\s*$', s):
            h.setdefault('place_of_supply', m.group(1))
        if m := re.search(r'State/UT Code:\s*(\d+)', s):
            h.setdefault('state_code', m.group(1))
        if m := re.search(r'^GSTIN:\s*([0-9A-Z]{15})', s):
            h.setdefault('buyer_gstin', m.group(1))
        if m := re.search(r'GST Tax Registration No:\s*([0-9A-Z]{15})', s):
            h.setdefault('seller_gstin', m.group(1))
        if m := re.search(r'PAN No:\s*([A-Z]{5}\d{4}[A-Z])', s):
            h.setdefault('seller_pan', m.group(1))
        if m := re.search(r'^Name:\s*(.+?)\s*$', s):
            h.setdefault('buyer_name', m.group(1))
        if m := re.search(r'Reason for Credit:\s*(.+?)\s*$', s):
            h.setdefault('credit_reason', m.group(1))
        if 'reverse charge' in s.lower():
            h.setdefault('reverse_charge', 'No' if re.search(r'-\s*No\b', s) else 'Yes')
    # Amazon's document-number prefix is its own issuing series, NOT the state of
    # supply: KA-2627-1685246 is a DELHI invoice.  Never derive state from it.
    if m := re.match(r'^([A-Z]{2})-', h.get('doc_no', '')):
        h['series_prefix'] = m.group(1)
    return h


def printed_totals(lines):
    t = {}
    for ln in lines:
        s = ' '.join(ln.split())
        # layout extraction sometimes butts the label against "INR"
        if m := re.search(r'Subtotal of fees amount\s*(-?)\s*INR\s+(-?)([\d,]+\.\d{2})', s):
            t['taxable'] = money(*m.groups())
        elif m := re.search(r'Subtotal of GST amount\s*(-?)\s*INR\s+(-?)([\d,]+\.\d{2})', s):
            t['gst'] = money(*m.groups())
        elif m := re.search(r'Total (?:Invoice|Credit Note) amount\s*(-?)\s*INR\s+(-?)([\d,]+\.\d{2})', s):
            t['total'] = money(*m.groups())
        elif m := re.search(r'Subtotal for (IGST|CGST|SGST|UTGST|CESS)\s*(-?)\s*INR\s+(-?)([\d,]+\.\d{2})', s):
            t.setdefault('by_head', {})[m.group(1)] = money(m.group(2), m.group(3), m.group(4))
    return t


# --------------------------------------------------------------------------- #
# pass 1 -- the front summary table (the document's own vocabulary)
# --------------------------------------------------------------------------- #

def parse_summary(lines, negate=False):
    rows, cur, pending = [], None, []
    started = False
    for ln in lines:
        s = norm(ln)
        if not s:
            continue
        if 'Details of Fees to the above' in s:
            break
        if ('Category of' in s and 'Description of' in s) or re.search(r'\bSI\s*No\b', s):
            started = True
            continue
        if not started:
            continue
        if s.startswith('Subtotal') or re.match(r'^Total\s*:', s):
            cur = None
            pending = []
            continue

        amt = amounts(s)
        if any(w in s for w in TAX_WORDS) and RE_RATE.search(s) and amt:
            if cur is not None:
                cur['taxes'].append({'tax': next(w for w in TAX_WORDS if w in s),
                                     'rate': Decimal(RE_RATE.search(s).group(1)),
                                     'amount': amt[-1]})
            continue

        if RE_SI.match(s):
            body = RE_SI.sub('', s)
            inv = RE_INV_NO.search(body)
            if inv:
                body = body.replace(inv.group(1), ' ')
            od = RE_ORIGDATE.search(body)
            if od:
                body = body.replace(od.group(0), ' ')
            sac = RE_SAC.search(body)
            if sac:
                body = body.replace(sac.group(1), ' ', 1)
            cur = {'si': int(RE_SI.match(s).group(1)),
                   'sac': sac.group(1) if sac else None,
                   'description': scrub(' '.join(pending + [body])),
                   'amount': amt[-1] if amt else None,
                   'original_invoice_no': inv.group(1) if inv else None,
                   'taxes': []}
            rows.append(cur)
            pending = []
            continue

        # an SI row whose amount wrapped onto its own line ("-INR" / "126.00")
        if cur is not None and cur['amount'] is None and amt:
            cur['amount'] = amt[-1]
            continue
        if cur is not None and cur['amount'] is None and re.fullmatch(r'-?[\d,]+\.\d{2}', s):
            cur['amount'] = money('-' if s.startswith('-') else '', '', s.lstrip('-'))
            continue

        if not amt and not is_header_row(s) and re.search(r'[A-Za-z]', s):
            (pending if cur is None else cur.setdefault('tail', [])).append(s)

    for r in rows:
        r.pop('tail', None)
        # On a credit note the minus sign sits in the column header's row, not
        # beside the figure, so it is lost on extraction.  Every amount on a
        # credit note is negative by definition -- take that, not the glyph.
        if negate and r['amount'] is not None:
            r['amount'] = -abs(r['amount'])
        for t in r['taxes']:
            if negate:
                t['amount'] = -abs(t['amount'])
    return rows


# --------------------------------------------------------------------------- #
# pass 2 -- the date-wise "Details of Fees" ledger
# --------------------------------------------------------------------------- #

def parse_details(lines, vocab_sacs, vocab_descs):
    try:
        start = next(i for i, ln in enumerate(lines)
                     if 'Details of Fees to the above' in ln)
    except StopIteration:
        return [], None

    rows, cur, pending, grand = [], None, [], None

    for ln in lines[start + 1:]:
        s = norm(ln)
        if not s:
            continue
        if s.startswith('Please note') or s.startswith('To view your account'):
            break

        amt = amounts(s)
        if not amt and is_header_row(s):
            continue

        if re.match(r'^Total\b', s) and amt:
            grand = {'taxable': amt[0], 'gst': amt[1] if len(amt) > 1 else Decimal(0)}
            continue

        if any(w in s for w in TAX_WORDS) and RE_RATE.search(s) and amt:
            if cur is not None:
                cur['taxes'].append({'tax': next(w for w in TAX_WORDS if w in s),
                                     'rate': Decimal(RE_RATE.search(s).group(1)),
                                     'amount': amt[-1]})
            continue

        d = RE_DATE.search(s)
        if d and amt and RE_SAC.search(s):
            body = s.replace(d.group(0), ' ')
            body = RE_AMOUNT.sub(' ', body)

            # The original invoice number goes first: its tail is itself a
            # plausible 6-digit SAC, so removing it prevents a misread code.
            orig = None
            if m := RE_INV_NO.search(body):
                orig = m.group(1)
                body = body.replace(orig, ' ', 1)
            elif m := RE_INV_STEM.search(body):
                stem = m.group(1)
                tail = next((t.group(0) for t in re.finditer(r'\d{3,}', body[m.end():])
                             if t.group(0) not in vocab_sacs), None)
                if tail:
                    orig = stem + tail
                    body = body.replace(tail, ' ', 1)
                body = body.replace(stem, ' ', 1)

            od = RE_ORIGDATE.search(body)
            if od:
                body = body.replace(od.group(0), ' ')

            sac = next((c.group(1) for c in RE_SAC.finditer(body)
                        if c.group(1) in vocab_sacs), None) or \
                  (RE_SAC.search(body).group(1) if RE_SAC.search(body) else None)
            if sac:
                body = body.replace(sac, ' ', 1)

            cur = {'fee_date': d.group(0),
                   'sac': sac,
                   'sac_in_vocab': sac in vocab_sacs,
                   'desc_parts': pending + [body],
                   'amount': amt[-1],
                   'original_invoice_no': orig,
                   'original_invoice_date': (f'{od.group(2)}/{od.group(1)}/{od.group(3)}'
                                             if od else None),
                   'taxes': []}
            rows.append(cur)
            pending = []
            continue

        if not amt and not RE_RATE.search(s) and re.search(r'[A-Za-z]', s):
            if is_header_row(s):
                continue
            if cur is not None and not cur['taxes']:
                cur['desc_parts'].append(s)      # a description wrapped downward
            else:
                pending.append(s)                # ...or wrapped above its own row

    for r in rows:
        raw = scrub(' '.join(r.pop('desc_parts')))
        # Snap to the vocabulary this document declared up front; that is what
        # clears stray header words and page furniture out of a description.
        hit = [v for v in vocab_descs if v and v.lower() in raw.lower()]
        r['description'] = max(hit, key=len) if hit else raw
        r['description_raw'] = raw
        r['desc_in_vocab'] = bool(hit)
    return rows, grand


# --------------------------------------------------------------------------- #

def head_matches_place(head, by_head):
    seller = (head.get('seller_gstin') or '')[:2]
    buyer  = (head.get('buyer_gstin') or '')[:2]
    if not seller or not buyer:
        return True                     # nothing to assert against
    heads = set(by_head)
    intra = seller == buyer
    return heads <= {'CGST', 'SGST', 'UTGST', 'CESS'} if intra else heads <= {'IGST', 'CESS'}


def parse(pdf_path):
    lines   = text_lines(pdf_path)
    head    = parse_header(lines)
    summary = parse_summary(lines, negate=head['doc_type'] == 'CREDIT_NOTE')
    printed = printed_totals(lines)

    vocab_sacs  = {r['sac'] for r in summary if r['sac']}
    vocab_descs = {r['description'] for r in summary if r['description']}
    detail, grand = parse_details(lines, vocab_sacs, vocab_descs)

    taxable = sum((r['amount'] for r in detail), Decimal(0))
    gst     = sum((t['amount'] for r in detail for t in r['taxes']), Decimal(0))
    by_head = {}
    for r in detail:
        for t in r['taxes']:
            by_head[t['tax']] = by_head.get(t['tax'], Decimal(0)) + t['amount']

    sum_taxable = sum((r['amount'] for r in summary if r['amount'] is not None), Decimal(0))

    checks = {
        'taxable_ties_printed_subtotal': printed.get('taxable') == taxable,
        'gst_ties_printed_subtotal':     printed.get('gst') == gst,
        'total_ties_printed_total':      printed.get('total') == taxable + gst,
        'ties_details_total_row':        (grand or {}).get('taxable') == taxable,
        'ties_front_summary_table':      sum_taxable == taxable,
        'gst_head_split_ties':           (printed.get('by_head') or by_head) == by_head,
        'every_sac_known':               all(r['sac_in_vocab'] for r in detail),
        'every_description_known':       all(r['desc_in_vocab'] for r in detail),
        'credit_note_signs_negative':    (head['doc_type'] != 'CREDIT_NOTE'
                                          or all(r['amount'] <= 0 for r in detail)),
        # Intra-state supply must carry CGST+SGST and inter-state must carry
        # IGST.  Get this wrong and the credit is claimed under the wrong head,
        # which is exactly what GSTR-2B matching rejects.
        'tax_head_matches_place':        head_matches_place(head, by_head),
    }
    return {
        'source_file': pdf_path.rsplit('/', 1)[-1],
        'header': head,
        'summary': summary,
        'detail': detail,
        'printed': printed,
        'calculated': {'taxable': taxable, 'gst': gst, 'total': taxable + gst,
                       'by_head': by_head},
        'checks': checks,
        'ok': all(checks.values()),
    }


class DecEnc(json.JSONEncoder):
    def default(self, o):
        return str(o) if isinstance(o, Decimal) else super().default(o)


if __name__ == '__main__':
    print(json.dumps([parse(p) for p in sys.argv[1:]], indent=2, cls=DecEnc))

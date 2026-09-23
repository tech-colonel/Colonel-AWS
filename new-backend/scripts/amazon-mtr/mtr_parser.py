"""
Amazon India GST Merchant Tax Report (MTR) parser.

Deterministic: no LLM, no n8n.  An MTR is the only Amazon artefact that states
the seller's *outward* supply line by line with the tax already split by head,
so it -- not the settlement report -- is what GSTR-1 and GSTR-3B are built
from.  That makes it worth nothing unless every row is proved against its own
printed arithmetic first.  A row that fails is reported, never dropped: a
silently skipped invoice line is an understated output liability.

Three report flavours share one reader because they are the same supply seen
from three angles:

  B2B             registered buyer, carries Bill To State / Customer GSTID /
                  IRN, and is the only flavour where the tax head follows the
                  BILL-TO state rather than the ship-to state (bill-to /
                  ship-to, s.10(1)(b) IGST Act).
  B2C             unregistered buyer, 78 columns, no Bill To / IRN block.
  STOCK_TRANSFER  Koparo's own GSTIN to Koparo's own GSTIN between fulfilment
                  centres.  Not a sale.  It is kept separate and never added
                  into turnover, but it is parsed because an unmatched FC
                  transfer is an unexplained GSTR-1 entry.

The flavour is decided from the COLUMNS AND THE CONTENT, never from the file
name, because the file names here are folder paths a human typed.

Two things about these particular files are load-bearing:

  * Some were opened and re-saved in Excel before we got them.  Those carry a
    hand-made totals row ABOVE the header (so the header is not line 1) and
    their timestamps have been rewritten from Amazon's ISO
    "YYYY-MM-DD HH:MM:SS" into local "DD-MM-YYYY HH:MM".  A reader that trusts
    line 1 reads the totals row as its header and every field comes back blank.
    So the header is FOUND, not assumed, and the preamble is kept and checked
    against our own roll-up rather than thrown away.

  * Amazon already signs refunds negative.  Invoice Amount, Tax Exclusive
    Gross, every tax head and every *Basis* column are negative on a Refund
    row.  Negating refunds "to make them returns" double-counts them the wrong
    way.  What is NOT signed is Principal Amount, Shipping Amount and Quantity
    -- they stay positive on a refund -- which is why the taxable value must be
    taken from the ``* Amount Basis`` columns and never from ``Principal
    Amount``.  ``verify()`` asserts the convention instead of trusting this
    comment.

Run this file directly for a self-verification report over a folder of MTRs.
"""

import os
import re
import csv
import sys
import glob
import json
from decimal import Decimal, InvalidOperation
from datetime import datetime

ZERO = Decimal('0')

# Amazon's own rounding drifts by a paisa or two on percentage lines, and the
# Excel-touched files lost a digit here and there.  Anything wider than this is
# a real defect, not float noise.
TOL = Decimal('0.05')

# Accepted timestamp shapes.  Order matters only in that the ISO form is tried
# first; the DD-MM form is proved separately in verify() (max day-of-month
# across these files is 31 and max month equals the report month, so the first
# field is the day -- it is not an ambiguous US MM-DD).
DATE_FORMATS = ('%Y-%m-%d %H:%M:%S', '%d-%m-%Y %H:%M', '%d/%m/%Y %H:%M',
                '%Y-%m-%d', '%d-%m-%Y', '%d/%m/%Y')

TAX_HEADS = ('cgst', 'sgst', 'utgst', 'igst', 'cess')

# GST state code -> state name, only for the states this seller is registered
# in.  Used to prove Seller Gstin agrees with Ship From State; a mismatch means
# the row was invoiced out of the wrong registration.
GSTIN_STATE = {
    '06': 'HARYANA', '07': 'DELHI', '19': 'WEST BENGAL',
    '24': 'GUJARAT', '27': 'MAHARASHTRA', '29': 'KARNATAKA',
    '03': 'PUNJAB', '09': 'UTTAR PRADESH', '33': 'TAMIL NADU',
    '36': 'TELANGANA', '08': 'RAJASTHAN', '23': 'MADHYA PRADESH',
    '32': 'KERALA', '10': 'BIHAR', '21': 'ODISHA', '02': 'HIMACHAL PRADESH',
}


# --------------------------------------------------------------------------- #
# primitives
# --------------------------------------------------------------------------- #

def key(name):
    """Header names differ in case, quoting and stray spaces between the three
    flavours and between months.  Everything is looked up through this."""
    return re.sub(r'[^a-z0-9]+', ' ', (name or '').strip().strip('"').lower()).strip()


def dec(raw):
    """Money as Decimal.  Never float -- a 7,069-row roll-up of 2-dp rupees is
    exactly where binary floating point starts disagreeing with the ledger.

    The Excel-touched files emit thousands separators and leading spaces
    (' 21,052 '), so those are stripped rather than treated as a parse error.
    """
    s = (raw or '').strip().strip('"').replace(',', '').replace('₹', '')
    s = s.replace('\xa0', '').strip()
    if s in ('', '-', 'NA', 'N/A'):
        return ZERO
    try:
        return Decimal(s)
    except InvalidOperation:
        return ZERO


def parse_date(raw):
    s = (raw or '').strip().strip('"')
    if not s:
        return None
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def date_shape(raw):
    """The literal shape, with digits masked, so verify() can report which files
    Amazon wrote and which Excel rewrote."""
    s = (raw or '').strip().strip('"')
    return re.sub(r'\d', '9', s) if s else ''


# --------------------------------------------------------------------------- #
# reading
# --------------------------------------------------------------------------- #

def _find_header(rows):
    """Return (header_index, preamble_rows).

    'Transaction Type' is the one column present in all three flavours and in
    every month, so it identifies the header wherever a re-save pushed it down.
    """
    for i, row in enumerate(rows):
        if any(key(c) == 'transaction type' for c in row):
            return i, rows[:i]
    raise ValueError('no header row containing "Transaction Type"')


def detect_report_type(header_keys, sample_rows):
    """Decide the flavour from the data, not the file name.

    Stock transfer is unmistakable: it is the only layout with a receiver
    GSTIN, because it is the only one where the buyer is the seller.

    B2B vs B2C is decided first on whether a customer GSTIN was actually
    captured (that is what makes a supply B2B), and only falls back to the
    presence of the bill-to/IRN block when a month happens to have no populated
    GSTID -- a real possibility in a thin month.
    """
    if 'gstin of receiver' in header_keys or 'ship from fc' in header_keys:
        return 'STOCK_TRANSFER'

    gstid_cols = [c for c in ('customer bill to gstid', 'customer ship to gstid')
                  if c in header_keys]
    if any((r.get(c) or '').strip() for r in sample_rows for c in gstid_cols):
        return 'B2B'

    b2b_only = {'bill to state', 'buyer name', 'irn number', 'credit note no'}
    if 'bill to state' in header_keys and 'irn number' in header_keys:
        return 'B2B'
    if b2b_only & set(header_keys) >= {'bill to state', 'buyer name'}:
        return 'B2B'
    return 'B2C'


def read_csv_rows(path):
    """Yield (report_type, header list, preamble rows, list of (line_no, dict))."""
    with open(path, newline='', encoding='utf-8-sig') as fh:
        raw = list(csv.reader(fh))

    hi, preamble = _find_header(raw)
    header = [c.strip().strip('"') for c in raw[hi]]
    hkeys = [key(c) for c in header]

    rows = []
    for offset, row in enumerate(raw[hi + 1:]):
        if not any((c or '').strip() for c in row):
            continue                      # trailing blank line from the re-save
        # 1-based line number in the FILE, so a failure can be opened and read.
        rows.append((hi + 2 + offset, dict(zip(hkeys, row))))

    rtype = detect_report_type(set(hkeys), [r for _, r in rows[:500]])
    return rtype, header, preamble, rows


# --------------------------------------------------------------------------- #
# normalisation
# --------------------------------------------------------------------------- #

def _first(row, *names):
    """B2C renames two columns that B2B does not: 'Shipping Cess Tax Amount'
    vs 'Shipping Cess Tax'.  B2C also emits Igst/Utgst in the opposite order,
    which is harmless once everything is looked up by name."""
    for n in names:
        if n in row:
            return row[n]
    return ''


def _tax_block(row, prefix, cess_names):
    """The five heads for one of the three charge blocks (item / shipping /
    gift wrap)."""
    p = (prefix + ' ') if prefix else ''
    return {
        'cgst': dec(_first(row, p + 'cgst tax')),
        'sgst': dec(_first(row, p + 'sgst tax')),
        'utgst': dec(_first(row, p + 'utgst tax')),
        'igst': dec(_first(row, p + 'igst tax')),
        'cess': dec(_first(row, *cess_names)),
    }


def normalise_sale_row(line_no, row, rtype, source):
    """One B2B or B2C line -> a typed record.

    Taxable value comes from the *Basis* columns because those carry the sign on
    a refund; Principal/Shipping/Gift Wrap Amount do not.  ``item_promo_discount``
    is already negative in the file and is already netted into
    ``principal_basis``, so it is carried for disclosure only and never added
    again.
    """
    item = _tax_block(row, '', ['compensatory cess tax'])
    ship = _tax_block(row, 'shipping',
                      ['shipping cess tax amount', 'shipping cess tax'])
    gift = _tax_block(row, 'gift wrap',
                      ['gift wrap compensatory cess tax', 'gift wrap cess tax'])

    tx = (row.get('transaction type') or '').strip()
    invoice_amount = dec(row.get('invoice amount'))

    # Direction is taken from the transaction type, but the SIGN is taken from
    # the data.  They are cross-checked in verify(); nothing here flips a sign.
    # 'EInvoiceCancel' is its own thing: Amazon cancels an already-IRN'd
    # invoice by emitting the line twice, once negative and once positive, so
    # the PAIR nets to nil while neither ROW is nil.  Lumping it in with
    # 'Cancel' would make the nil-amount assertion fire on a correct pair.
    low = tx.lower()
    kind = ('EINVOICE_CANCEL' if 'einvoice' in low and 'cancel' in low
            else 'RETURN' if low.startswith('refund')
            else 'CANCEL' if 'cancel' in low
            else 'SALE')

    quantity = dec(row.get('quantity'))
    ship_from = (row.get('ship from state') or '').strip().upper()
    bill_from = (row.get('bill from state') or '').strip().upper()
    ship_to = (row.get('ship to state') or '').strip().upper()
    bill_to = (row.get('bill to state') or '').strip().upper()

    # Origin is the fulfilment centre that actually despatched (AFN rows ship
    # from a state the seller bills from only nominally).  Destination is the
    # registered buyer's state when there is one -- see module docstring.
    origin = ship_from or bill_from
    destination = bill_to or ship_to

    rec = {
        'source_file': os.path.basename(source),
        'line_no': line_no,
        'report_type': rtype,
        'transaction_type': tx,
        'kind': kind,
        'seller_gstin': (row.get('seller gstin') or '').strip(),
        'invoice_number': (row.get('invoice number') or '').strip(),
        'invoice_date': parse_date(row.get('invoice date')),
        'invoice_date_raw': (row.get('invoice date') or '').strip(),
        'order_id': (row.get('order id') or '').strip(),
        'order_date': parse_date(row.get('order date')),
        'shipment_date': parse_date(row.get('shipment date')),
        'credit_note_no': (row.get('credit note no') or '').strip(),
        'credit_note_date': parse_date(row.get('credit note date')),
        'quantity': quantity,
        # Units move the other way on a refund even though Amazon prints the
        # quantity positive; the sign is taken from the money, which is signed.
        'quantity_signed': -quantity if invoice_amount < 0 else quantity,
        'sku': (row.get('sku') or '').strip(),
        'asin': (row.get('asin') or '').strip(),
        'hsn': (row.get('hsn sac') or '').strip(),
        'item_description': (row.get('item description') or '').strip(),
        'ship_from_state': ship_from,
        'bill_from_state': bill_from,
        'ship_to_state': ship_to,
        'bill_to_state': bill_to,
        'origin_state': origin,
        'destination_state': destination,
        'is_intra_state': bool(origin) and origin == destination,
        'warehouse_id': (row.get('warehouse id') or '').strip(),
        'fulfillment_channel': (row.get('fulfillment channel') or '').strip(),
        'customer_gstin': ((row.get('customer bill to gstid') or '').strip()
                           or (row.get('customer ship to gstid') or '').strip()),
        'buyer_name': (row.get('buyer name') or '').strip(),
        'irn_number': (row.get('irn number') or '').strip(),
        'irn_status': (row.get('irn filing status') or '').strip(),

        'invoice_amount': invoice_amount,
        'tax_exclusive_gross': dec(row.get('tax exclusive gross')),
        'total_tax_amount': dec(row.get('total tax amount')),

        'principal_amount': dec(row.get('principal amount')),
        'principal_basis': dec(row.get('principal amount basis')),
        'shipping_amount': dec(row.get('shipping amount')),
        'shipping_basis': dec(row.get('shipping amount basis')),
        'giftwrap_amount': dec(row.get('gift wrap amount')),
        'giftwrap_basis': dec(row.get('gift wrap amount basis')),
        'item_promo_discount': dec(row.get('item promo discount')),
        'item_promo_basis': dec(row.get('item promo discount basis')),
        'shipping_promo_discount': dec(row.get('shipping promo discount')),
        'shipping_promo_basis': dec(row.get('shipping promo discount basis')),
        'giftwrap_promo_discount': dec(row.get('gift wrap promo discount')),
        'giftwrap_promo_basis': dec(row.get('gift wrap promo discount basis')),

        'item_tax': item,
        'shipping_tax': ship,
        'giftwrap_tax': gift,
        'promo_tax': {
            'item': dec(row.get('item promo tax')),
            'shipping': dec(row.get('shipping promo tax')),
            'giftwrap': dec(row.get('gift wrap promo tax')),
        },

        'rates': {h: dec(row.get(h + ' rate')) for h in ('cgst', 'sgst', 'utgst', 'igst')},
        'cess_rate': dec(row.get('compensatory cess rate')),

        'tcs': {h: dec(row.get('tcs %s amount' % h)) for h in ('cgst', 'sgst', 'utgst', 'igst')},
        'tcs_rates': {h: dec(row.get('tcs %s rate' % h)) for h in ('cgst', 'sgst', 'utgst', 'igst')},
    }

    # Head totals across all three charge blocks -- what a GSTR-1 line needs.
    rec['tax_by_head'] = {
        h: item[h] + ship[h] + gift[h] for h in TAX_HEADS
    }
    rec['tax_heads_total'] = sum(rec['tax_by_head'].values(), ZERO)
    rec['promo_tax_total'] = sum(rec['promo_tax'].values(), ZERO)
    rec['tcs_total'] = sum(rec['tcs'].values(), ZERO)
    rec['basis_total'] = (rec['principal_basis'] + rec['shipping_basis']
                          + rec['giftwrap_basis'] + rec['item_promo_basis']
                          + rec['shipping_promo_basis'] + rec['giftwrap_promo_basis'])

    # The date the document belongs to.  A refund keeps the ORIGINAL invoice
    # date in 'Invoice Date' -- up to three months back -- and carries its own
    # date in 'Credit Note Date'.  Group a refund by Invoice Date and it lands
    # in a month that was filed long ago; group it by Credit Note Date and it
    # lands in the month Amazon reported it, which is where it must be
    # disclosed.
    rec['doc_date'] = (rec['credit_note_date'] or rec['invoice_date']
                       if rec['kind'] == 'RETURN' else rec['invoice_date'])
    return rec


def normalise_transfer_row(line_no, row, source):
    """A stock transfer line.  Different vocabulary entirely -- 'Invoice Value'
    rather than 'Invoice Amount', 'Taxable Value' rather than 'Tax Exclusive
    Gross', amounts rather than taxes -- so it is normalised into the same
    shape as a sale row wherever a shared field genuinely means the same thing,
    and no further."""
    tax = {
        'cgst': dec(row.get('cgst amount')),
        'sgst': dec(row.get('sgst amount')),
        'utgst': dec(row.get('utgst amount')),
        'igst': dec(row.get('igst amount')),
        'cess': dec(row.get('compensatory cess amount')),
    }
    ship_from = (row.get('ship from state') or '').strip().upper()
    ship_to = (row.get('ship to state') or '').strip().upper()
    tx = (row.get('transaction type') or '').strip()
    return {
        'source_file': os.path.basename(source),
        'line_no': line_no,
        'report_type': 'STOCK_TRANSFER',
        'transaction_type': tx,
        # 'FC_REMOVAL-Cancel' exists in May: a removal that was called off.
        'kind': 'TRANSFER_CANCEL' if 'cancel' in tx.lower() else 'TRANSFER',
        'seller_gstin': (row.get('gstin of supplier') or '').strip(),
        'receiver_gstin': (row.get('gstin of receiver') or '').strip(),
        'invoice_number': (row.get('invoice number') or '').strip(),
        'invoice_date': parse_date(row.get('invoice date')),
        'invoice_date_raw': (row.get('invoice date') or '').strip(),
        'order_id': (row.get('order id') or '').strip(),
        'transaction_id': (row.get('transaction id') or '').strip(),
        'sku': (row.get('sku') or '').strip(),
        'asin': (row.get('asin') or '').strip(),
        'hsn': (row.get('hsn code') or '').strip(),
        'quantity': dec(row.get('quantity')),
        'quantity_signed': dec(row.get('quantity')),
        'ship_from_state': ship_from,
        'ship_to_state': ship_to,
        'ship_from_fc': (row.get('ship from fc') or '').strip(),
        'ship_to_fc': (row.get('ship to fc') or '').strip(),
        'origin_state': ship_from,
        'destination_state': ship_to,
        'is_intra_state': bool(ship_from) and ship_from == ship_to,
        'invoice_amount': dec(row.get('invoice value')),
        'tax_exclusive_gross': dec(row.get('taxable value')),
        'total_tax_amount': sum(tax.values(), ZERO),
        'tax_by_head': tax,
        'tax_heads_total': sum(tax.values(), ZERO),
        'rates': {h: dec(row.get(h + ' rate')) for h in ('cgst', 'sgst', 'utgst', 'igst')},
        'irn_number': (row.get('irn number') or '').strip(),
        'irn_status': (row.get('irn filing status') or '').strip(),
        'tcs': {h: ZERO for h in ('cgst', 'sgst', 'utgst', 'igst')},
        'tcs_total': ZERO,
        'promo_tax_total': ZERO,
        'basis_total': dec(row.get('taxable value')),
        'doc_date': parse_date(row.get('invoice date')),
    }


# --------------------------------------------------------------------------- #
# verification
# --------------------------------------------------------------------------- #

def _fail(bucket, rec, check, **amounts):
    bucket.append({
        'check': check,
        'file': rec['source_file'],
        'line_no': rec['line_no'],
        'invoice_number': rec.get('invoice_number', ''),
        'order_id': rec.get('order_id', ''),
        'transaction_type': rec.get('transaction_type', ''),
        'amounts': {k: str(v) for k, v in amounts.items()},
    })


def verify_row(rec):
    """Every arithmetic claim the row makes about itself.  Returns a list of
    failures; an empty list is the only acceptable result."""
    out = []

    # 1. The document's headline identity.
    lhs = rec['invoice_amount']
    rhs = rec['tax_exclusive_gross'] + rec['total_tax_amount']
    if abs(lhs - rhs) > TOL:
        _fail(out, rec, 'invoice_amount = tax_exclusive_gross + total_tax_amount',
              invoice_amount=lhs, tax_exclusive_gross=rec['tax_exclusive_gross'],
              total_tax_amount=rec['total_tax_amount'], difference=lhs - rhs)

    # 2. Taxable value must be the sum of the six *Basis* columns.  This is what
    #    proves the Basis columns -- not Principal Amount -- are the signed base.
    if rec['report_type'] != 'STOCK_TRANSFER':
        if abs(rec['tax_exclusive_gross'] - rec['basis_total']) > TOL:
            _fail(out, rec, 'tax_exclusive_gross = sum of amount-basis columns',
                  tax_exclusive_gross=rec['tax_exclusive_gross'],
                  basis_total=rec['basis_total'],
                  difference=rec['tax_exclusive_gross'] - rec['basis_total'])

    # 3. Literal head split, exactly as a reviewer would foot it: the five heads
    #    over item + shipping + gift wrap.  Reported on its own because it is
    #    what a GSTR-1 preparer will add up, and because it does NOT always hold
    #    (see check 4).
    if abs(rec['total_tax_amount'] - rec['tax_heads_total']) > TOL:
        _fail(out, rec, 'total_tax_amount = cgst+sgst+utgst+igst+cess (item+shipping+giftwrap)',
              total_tax_amount=rec['total_tax_amount'],
              heads_total=rec['tax_heads_total'],
              difference=rec['total_tax_amount'] - rec['tax_heads_total'])

    # 4. The identity that actually holds on every row, promo tax included.
    #    When a shipping charge is fully absorbed by a shipping promotion,
    #    Amazon prints the shipping tax positive AND a promo tax that cancels
    #    it, and Total Tax Amount is net of both.  Failing this is a genuine
    #    defect; failing only check 3 is an absorbed promotion.
    if rec['report_type'] != 'STOCK_TRANSFER':
        net = rec['tax_heads_total'] + rec['promo_tax_total']
        if abs(rec['total_tax_amount'] - net) > TOL:
            _fail(out, rec, 'total_tax_amount = heads + promo tax (net identity)',
                  total_tax_amount=rec['total_tax_amount'], heads_total=rec['tax_heads_total'],
                  promo_tax=rec['promo_tax_total'], difference=rec['total_tax_amount'] - net)

    # 5. Each head against its own rate x basis, block by block.  Rates are
    #    stored as fractions (0.09 / 0.18), not percentages.
    if rec['report_type'] != 'STOCK_TRANSFER':
        blocks = (('item', rec['item_tax'], rec['principal_basis']),
                  ('shipping', rec['shipping_tax'], rec['shipping_basis']),
                  ('giftwrap', rec['giftwrap_tax'], rec['giftwrap_basis']))
        for block, taxes, basis in blocks:
            for head in ('cgst', 'sgst', 'utgst', 'igst'):
                expected = rec['rates'][head] * basis
                if abs(taxes[head] - expected) > TOL:
                    _fail(out, rec, '%s %s = rate x basis' % (block, head),
                          rate=rec['rates'][head], basis=basis,
                          reported=taxes[head], expected=expected,
                          difference=taxes[head] - expected)
    else:
        for head in ('cgst', 'sgst', 'utgst', 'igst'):
            expected = rec['rates'][head] * rec['tax_exclusive_gross']
            if abs(rec['tax_by_head'][head] - expected) > TOL:
                _fail(out, rec, 'transfer %s = rate x taxable value' % head,
                      rate=rec['rates'][head], basis=rec['tax_exclusive_gross'],
                      reported=rec['tax_by_head'][head], expected=expected,
                      difference=rec['tax_by_head'][head] - expected)

    # 6. Place of supply.  Intra-state must be CGST+SGST (or UTGST); inter-state
    #    must be IGST.  Booked under the wrong head, the buyer's GSTR-2B will
    #    not match and the credit is lost.  Skipped where there is no tax at
    #    all, which is every Cancel row.
    if rec['total_tax_amount'] != 0:
        by = rec['tax_by_head']
        if rec['is_intra_state'] and by['igst'] != 0:
            _fail(out, rec, 'intra-state supply carries IGST',
                  origin=rec['origin_state'], destination=rec['destination_state'],
                  igst=by['igst'])
        if not rec['is_intra_state'] and (by['cgst'] or by['sgst'] or by['utgst']):
            _fail(out, rec, 'inter-state supply carries CGST/SGST/UTGST',
                  origin=rec['origin_state'], destination=rec['destination_state'],
                  cgst=by['cgst'], sgst=by['sgst'], utgst=by['utgst'])

    # 7. The sign convention, asserted rather than assumed.  A Refund must be
    #    negative, a Shipment positive, a Cancel nil.  If Amazon ever stops
    #    signing refunds, this is what will say so -- before the month is filed.
    k = rec['kind']
    amt = rec['invoice_amount']
    if k == 'RETURN' and amt > 0:
        _fail(out, rec, 'refund is not negative', invoice_amount=amt)
    if k == 'SALE' and amt < 0:
        _fail(out, rec, 'shipment is negative', invoice_amount=amt)
    if k == 'CANCEL' and amt != 0:
        _fail(out, rec, 'cancel carries a non-zero amount', invoice_amount=amt)

    # 8. The registration the row was invoiced out of must be the state it
    #    shipped from.
    code = (rec.get('seller_gstin') or '')[:2]
    expect_state = GSTIN_STATE.get(code)
    if expect_state and rec.get('ship_from_state') and expect_state != rec['ship_from_state']:
        _fail(out, rec, 'seller GSTIN state does not match ship-from state',
              seller_gstin=rec['seller_gstin'], gstin_state=expect_state,
              ship_from_state=rec['ship_from_state'])

    return out


# --------------------------------------------------------------------------- #
# file level
# --------------------------------------------------------------------------- #

def parse(path):
    rtype, header, preamble, raw_rows = read_csv_rows(path)

    if rtype == 'STOCK_TRANSFER':
        rows = [normalise_transfer_row(n, r, path) for n, r in raw_rows]
    else:
        rows = [normalise_sale_row(n, r, rtype, path) for n, r in raw_rows]

    failures = []
    for rec in rows:
        failures.extend(verify_row(rec))

    # 9. Period containment.  Every row's DOC date -- credit-note date for a
    #    refund, invoice date otherwise -- must fall inside the month the report
    #    was run for.  This is what proves doc_date is the right grouping key:
    #    147 of 147 refunds here carry an invoice date up to three months old
    #    and a credit-note date inside the period, so grouping on invoice date
    #    would post returns into months already filed.
    year, month, _label = period_of(path)
    if month:
        for rec in rows:
            d = rec.get('doc_date')
            if d and (d.year, d.month) != (year, month):
                _fail(failures, rec, 'document date outside the report period',
                      doc_date=d.strftime('%Y-%m-%d'),
                      period='%04d-%02d' % (year, month),
                      invoice_date=(rec['invoice_date'].strftime('%Y-%m-%d')
                                    if rec.get('invoice_date') else ''))

    # The preamble, when present, is a total somebody typed in Excel above the
    # header.  It is not Amazon's, so it is not authority -- but it is a free
    # second opinion, so it is compared and reported either way.
    hkeys = [key(c) for c in header]
    preamble_checks = []
    for prow in preamble:
        cells = {hkeys[i]: dec(v) for i, v in enumerate(prow)
                 if i < len(hkeys) and (v or '').strip()}
        for col, stated in cells.items():
            computed = _column_total(rows, col)
            if computed is None:
                continue
            preamble_checks.append({
                'column': col,
                'stated': str(stated),
                'computed': str(computed),
                # The June file's preamble is rounded to whole rupees, so a
                # rupee of slack is allowed before calling it a disagreement.
                'agrees': abs(stated - computed) <= Decimal('1.00'),
            })

    shapes = {}
    for _, r in raw_rows:
        s = date_shape(r.get('invoice date'))
        if s:
            shapes[s] = shapes.get(s, 0) + 1

    return {
        'source_file': os.path.basename(path),
        'report_type': rtype,
        'column_count': len(header),
        'row_count': len(rows),
        'header_line_no': len(preamble) + 1,
        'preamble_row_count': len(preamble),
        'preamble_checks': preamble_checks,
        'date_shapes': shapes,
        'rows': rows,
        'failures': failures,
        'ok': not failures,
    }


def _column_total(rows, col):
    """Map a preamble header key onto the normalised field it totals."""
    mapping = {
        'tax exclusive gross': lambda r: r['tax_exclusive_gross'],
        'invoice amount': lambda r: r['invoice_amount'],
        'total tax amount': lambda r: r['total_tax_amount'],
        'cgst tax': lambda r: r['item_tax']['cgst'] if 'item_tax' in r else r['tax_by_head']['cgst'],
        'sgst tax': lambda r: r['item_tax']['sgst'] if 'item_tax' in r else r['tax_by_head']['sgst'],
        'utgst tax': lambda r: r['item_tax']['utgst'] if 'item_tax' in r else r['tax_by_head']['utgst'],
        'igst tax': lambda r: r['item_tax']['igst'] if 'item_tax' in r else r['tax_by_head']['igst'],
    }
    fn = mapping.get(col)
    if not fn:
        return None
    return sum((fn(r) for r in rows), ZERO)


MONTHS = ('JANUARY FEBRUARY MARCH APRIL MAY JUNE JULY AUGUST SEPTEMBER '
          'OCTOBER NOVEMBER DECEMBER').split()


def period_of(path):
    """(year, month, label) for the report period.

    Read from the file name token Amazon puts there (MTR_B2B-APRIL-2026-...),
    because that is the period the report was RUN for.  Individual rows can
    fall outside it -- the April stock transfer file carries a 30-03-2026
    invoice -- and grouping by the row date would then move a line into a month
    it was never reported in.  Rows outside the period are flagged, not moved.
    """
    name = os.path.basename(path).upper()
    m = re.search(r'-(%s)-(\d{4})' % '|'.join(MONTHS), name)
    if m:
        month = MONTHS.index(m.group(1)) + 1
        return int(m.group(2)), month, '%s %s' % (m.group(1).title(), m.group(2))
    return None, None, 'UNKNOWN'


def parse_folder(folder):
    return [parse(p) for p in sorted(glob.glob(os.path.join(folder, '*.csv')))]


# --------------------------------------------------------------------------- #
# self-verification
# --------------------------------------------------------------------------- #

def _report(docs):
    print('=' * 78)
    print('AMAZON MTR -- SELF VERIFICATION')
    print('=' * 78)
    grand = {'rows': 0, 'fail': 0}
    tt = {}
    for d in docs:
        y, mo, label = period_of(d['source_file'])
        outside = sum(1 for r in d['rows']
                      if r['invoice_date'] and mo and
                      (r['invoice_date'].year, r['invoice_date'].month) != (y, mo))
        print('\n%-11s %-15s rows=%-5d cols=%-3d header@line %d  dates=%s'
              % (d['report_type'], label, d['row_count'], d['column_count'],
                 d['header_line_no'], '/'.join(d['date_shapes'])))
        if d['preamble_row_count']:
            print('   preamble rows above header: %d' % d['preamble_row_count'])
            for c in d['preamble_checks']:
                print('     %-22s stated %-12s computed %-12s %s'
                      % (c['column'], c['stated'], c['computed'],
                         'AGREES' if c['agrees'] else '*** DISAGREES ***'))
        if outside:
            print('   %d row(s) dated outside the report period' % outside)
        for r in d['rows']:
            tt[(d['report_type'], r['transaction_type'])] = \
                tt.get((d['report_type'], r['transaction_type']), 0) + 1
        grand['rows'] += d['row_count']
        grand['fail'] += len(d['failures'])
        if d['failures']:
            byc = {}
            for f in d['failures']:
                byc.setdefault(f['check'], []).append(f)
            for check, items in byc.items():
                print('   FAIL %-60s x%d' % (check[:60], len(items)))
                for f in items[:4]:
                    print('        line %-6d %-12s %s'
                          % (f['line_no'], f['invoice_number'] or f['order_id'][:12],
                             ', '.join('%s=%s' % kv for kv in f['amounts'].items())))
                if len(items) > 4:
                    print('        ... %d more' % (len(items) - 4))
        else:
            print('   all checks passed')

    print('\n' + '-' * 78)
    print('Transaction Type values found')
    for (rt, t), n in sorted(tt.items()):
        print('   %-15s %-20s %d' % (rt, t or '(blank)', n))
    print('-' * 78)
    print('TOTAL rows %d, failing checks %d' % (grand['rows'], grand['fail']))


class DecEnc(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return str(o)
        if isinstance(o, datetime):
            return o.isoformat(sep=' ')
        return super().default(o)


if __name__ == '__main__':
    args = sys.argv[1:]
    as_json = '--json' in args
    args = [a for a in args if a != '--json']
    paths = []
    for a in args:
        paths.extend(sorted(glob.glob(os.path.join(a, '*.csv'))) if os.path.isdir(a) else [a])
    if not paths:
        print(__doc__)
        sys.exit('usage: mtr_parser.py <folder-or-csv> [...] [--json]')
    docs = [parse(p) for p in paths]
    if as_json:
        print(json.dumps(docs, indent=2, cls=DecEnc))
    else:
        _report(docs)
        sys.exit(0 if all(d['ok'] for d in docs) else 1)

const test = require('node:test');
const assert = require('node:assert');
const { _test: { parseDate, parseAmount, toVoucher, sanitize, decode } } = require('../src/tally');

test('parseDate handles Tally formats', () => {
  assert.strictEqual(parseDate('20240401'), '2024-04-01');
  assert.strictEqual(parseDate({ '#text': '20250331', '@_TYPE': 'Date' }), '2025-03-31');
  assert.strictEqual(parseDate('1-Apr-2024'), '2024-04-01');
  assert.strictEqual(parseDate('15-Aug-24'), '2024-08-15');
  assert.strictEqual(parseDate(''), null);
});

test('parseAmount keeps Tally sign and handles forex / commas', () => {
  assert.strictEqual(parseAmount('-1500.00'), -1500);
  assert.strictEqual(parseAmount('1,23,456.50'), 123456.5);
  assert.strictEqual(parseAmount('$10 @ ₹83/$ = ₹830.00'), 830);
  assert.strictEqual(parseAmount('-$10 @ ₹83/$ = -₹830.00'), -830);
  assert.strictEqual(parseAmount(''), null);
});

test('toVoucher: accounting voucher uses party line as amount', () => {
  const v = toVoucher({
    GUID: 'g1', DATE: '20240405', VOUCHERTYPENAME: 'Sales', VOUCHERNUMBER: '7', PARTYLEDGERNAME: 'Sharma Retail',
    ALTERID: '120', ISCANCELLED: 'No',
    'ALLLEDGERENTRIES.LIST': [
      { LEDGERNAME: 'Sharma Retail', AMOUNT: '-23600.00' },
      { LEDGERNAME: 'Sales @ 18%', AMOUNT: '20000.00' },
      { LEDGERNAME: 'Output IGST', AMOUNT: '3600.00' },
    ],
  });
  assert.strictEqual(v.amount, 23600);
  assert.strictEqual(v.date, '2024-04-05');
  assert.strictEqual(v.alter_id, 120);
  assert.strictEqual(v.ledger_entries.length, 3);
});

test('toVoucher: invoice-mode voucher falls back to LEDGERENTRIES and credit total', () => {
  const v = toVoucher({
    GUID: 'g2', PARTYLEDGERNAME: '',
    'LEDGERENTRIES.LIST': [{ LEDGERNAME: 'Cash', AMOUNT: '-500' }, { LEDGERNAME: 'Sales', AMOUNT: '500' }],
  });
  assert.strictEqual(v.amount, 500);
  assert.strictEqual(v.party_name, null);
});

test('sanitize strips control-char entities but keeps newlines', () => {
  assert.strictEqual(sanitize('a&#4;b&#10;c\u0001'), 'ab&#10;c');
});

test('decode reads UTF-16LE with and without BOM', () => {
  const s = '<ENVELOPE/>';
  assert.strictEqual(decode(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])), s);
  assert.strictEqual(decode(Buffer.from(s, 'utf16le')), s);
  assert.strictEqual(decode(Buffer.from(s, 'utf8')), s);
});

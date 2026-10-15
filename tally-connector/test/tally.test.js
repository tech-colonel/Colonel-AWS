const test = require('node:test');
const assert = require('node:assert');
const { _test: { parseDate, parseAmount, parseQty, parseRate, toVoucher, sanitize, decode } } = require('../src/tally');

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

test('toVoucher: numeric character references in text become real characters', () => {
  const v = toVoucher({
    GUID: 'g9', DATE: '20251216', VOUCHERTYPENAME: 'Receipt', ALTERID: '9',
    NARRATION: 'NONREF &#13;&#10;IMPS&#13;&#10;535001525875', PARTYLEDGERNAME: 'A &#38; B Traders',
    'ALLLEDGERENTRIES.LIST': [{ LEDGERNAME: 'A &#38; B Traders', AMOUNT: '100.00' }, { LEDGERNAME: 'Bank', AMOUNT: '-100.00' }],
  });
  assert.strictEqual(v.narration, 'NONREF \r\nIMPS\r\n535001525875');
  assert.strictEqual(v.party_name, 'A & B Traders');
  assert.strictEqual(v.amount, 100);
});

test('toVoucher: invoice detail — items, bill allocations, bank details, party GSTIN', () => {
  const v = toVoucher({
    GUID: 'g10', DATE: '20251031', VOUCHERTYPENAME: 'Sales Karnataka', VOUCHERNUMBER: 'A-10', PARTYLEDGERNAME: 'Buyer', ALTERID: '10',
    ISINVOICE: 'Yes', REFERENCE: 'A-10', PARTYGSTIN: '29ABCDE1234F1Z5', PLACEOFSUPPLY: 'Karnataka', IRN: ' Not Applicable',
    'ALLLEDGERENTRIES.LIST': [
      { LEDGERNAME: 'Buyer', AMOUNT: '-5445.02', 'BILLALLOCATIONS.LIST': { NAME: 'A-10', BILLTYPE: 'New Ref', AMOUNT: '-5445.02' } },
      { LEDGERNAME: 'Sales', AMOUNT: '5185.73' },
      { LEDGERNAME: 'Output IGST 5%', AMOUNT: '259.29' },
      { LEDGERNAME: 'Bank', AMOUNT: '0.00', 'BANKALLOCATIONS.LIST': [{ INSTRUMENTNUMBER: '000123', INSTRUMENTDATE: '20251031', TRANSACTIONTYPE: 'NEFT', AMOUNT: '100.00' }] },
    ],
    'ALLINVENTORYENTRIES.LIST': {
      STOCKITEMNAME: 'Sticker book', RATE: '471.43/Nos', AMOUNT: '5185.73', BILLEDQTY: ' 11 Nos', GSTHSNNAME: '95030010',
      'RATEDETAILS.LIST': [{ GSTRATEDUTYHEAD: 'CGST', GSTRATE: ' 2.50' }, { GSTRATEDUTYHEAD: 'IGST', GSTRATE: ' 5' }],
      'BATCHALLOCATIONS.LIST': { GODOWNNAME: 'Main Location' }, 'ACCOUNTINGALLOCATIONS.LIST': { LEDGERNAME: 'Sales' },
    },
  });
  assert.strictEqual(v.amount, 5445.02);
  assert.deepStrictEqual(v.details.inventory, [{ item: 'Sticker book', qty: 11, unit: 'Nos', rate: 471.43, amount: 5185.73, hsn: '95030010', gst_rate: 5, godown: 'Main Location', ledger: 'Sales' }]);
  assert.deepStrictEqual(v.details.bills, [{ ledger: 'Buyer', name: 'A-10', type: 'New Ref', amount: -5445.02 }]);
  assert.deepStrictEqual(v.details.bank, [{ ledger: 'Bank', type: 'NEFT', instrument_no: '000123', instrument_date: '2025-10-31', amount: 100 }]);
  assert.strictEqual(v.details.party_gstin, '29ABCDE1234F1Z5');
  assert.strictEqual(v.details.place_of_supply, 'Karnataka');
  assert.strictEqual(v.details.irn, undefined, 'Tally placeholders are not stored');
});

test('parseQty and parseRate read Tally quantity and rate strings', () => {
  assert.deepStrictEqual(parseQty(' 116 Nos'), { qty: 116, unit: 'Nos' });
  assert.deepStrictEqual(parseQty('-1,250.5 Kg'), { qty: -1250.5, unit: 'Kg' });
  assert.deepStrictEqual(parseQty(''), { qty: null, unit: null });
  assert.strictEqual(parseRate('27.00/Nos'), 27);
});

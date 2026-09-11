/**
 * Scalar formula helpers — text functions + GST jurisdiction resolution.
 *
 *   Run: node --test tests/workflowEngine.formula.test.js
 *
 * Covers the use case that motivated them: from a "Seller GST Num" and a
 * "Shipping State" column, split a line's tax into CGST+SGST (intra-state) or
 * IGST (inter-state) with plain per-row Math formulas.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { evaluateFormula, evaluateFormulaWithHelpers, applyMultiSheetWorkflow, SCALAR_HELPERS } = require('../src/services/workflowEngine');
const XLSX = require('xlsx');

const ev = (formula, scope) => evaluateFormula(formula, scope);

// ── text functions ───────────────────────────────────────────────────────────

test('LEFT / RIGHT / MID / LEN', () => {
  const s = { SKU: 'ABX-100-RED', DESC: 'hello world' };
  assert.equal(ev('LEFT({SKU}, 3)', s), 'ABX');
  assert.equal(ev('RIGHT({SKU}, 3)', s), 'RED');
  assert.equal(ev('MID({SKU}, 5, 3)', s), '100'); // 1-indexed, like Excel
  assert.equal(ev('LEN({DESC})', s), 11);
});

test('a value that BEGINS with digits is pre-coerced to a number by the tokenizer', () => {
  // {col} that parseFloat()s to a number is substituted as that number, so text
  // functions see the number, not the original string. For GSTINs this means
  // LEFT() is unreliable — use GSTCODE()/GSTSTATE(), which re-pad, instead.
  assert.equal(ev('LEFT({G}, 2)', { G: '09ABCDE1234F1Z5' }), '9');   // NOT "09"
  assert.equal(ev('GSTCODE({G})', { G: '09ABCDE1234F1Z5' }), '09');  // robust
  assert.equal(ev('GSTSTATE({G})', { G: '09ABCDE1234F1Z5' }), 'Uttar Pradesh');
});

test('TRIM / UPPER / LOWER / CONCAT / VALUE / ROUND / ABS', () => {
  assert.equal(ev('TRIM({X})', { X: '  hi  ' }), 'hi');
  assert.equal(ev('UPPER({X})', { X: 'abc' }), 'ABC');
  assert.equal(ev('LOWER({X})', { X: 'ABC' }), 'abc');
  assert.equal(ev('CONCAT({A}, "-", {B})', { A: 'x', B: 'y' }), 'x-y');
  assert.equal(ev('VALUE(LEFT({H}, 4))', { H: '6109ABCD' }), 6109);
  assert.equal(ev('ROUND({N}, 2)', { N: 1234.5678 }), 1234.57);
  assert.equal(ev('ABS({N})', { N: -5 }), 5);
});

// ── GST jurisdiction helpers ─────────────────────────────────────────────────

test('GSTSTATE resolves a GSTIN, a bare code, and canonicalises a name', () => {
  assert.equal(ev('GSTSTATE({G})', { G: '09ABCDE1234F1Z5' }), 'Uttar Pradesh');
  assert.equal(ev('GSTSTATE({G})', { G: '27AABCU9603R1ZM' }), 'Maharashtra');
  assert.equal(ev('GSTSTATE({C})', { C: '07' }), 'Delhi');
  assert.equal(ev('GSTSTATE({C})', { C: 7 }), 'Delhi');            // numeric column
  assert.equal(ev('GSTSTATE({N})', { N: 'TAMIL NADU' }), 'Tamil Nadu');
  assert.equal(ev('GSTSTATE({N})', { N: 'andaman and nicobar islands' }), 'Andaman & Nicobar Islands');
  assert.equal(ev('GSTSTATE({N})', { N: 'Narnia' }), '');
});

test('GSTCODE reverse-maps', () => {
  assert.equal(ev('GSTCODE({N})', { N: 'Karnataka' }), '29');
  assert.equal(ev('GSTCODE({G})', { G: '29AABCU9603R1ZM' }), '29');
});

test('GSTABBR → 2-letter code for Tally voucher/ledger names', () => {
  assert.equal(ev('GSTABBR({G})', { G: '09ABCDE1234F1Z5' }), 'UP');
  assert.equal(ev('GSTABBR({N})', { N: 'Maharashtra' }), 'MH');
  assert.equal(ev('CONCAT("Sales-", GSTABBR({G}))', { G: '29AABCU9603R1ZM' }), 'Sales-KA');
  assert.equal(ev('GSTABBR({N})', { N: 'Narnia' }), '');
});

test('SAMESTATE compares seller GSTIN against a shipping-state name', () => {
  assert.equal(ev('SAMESTATE({G}, {S})', { G: '09ABCDE1234F1Z5', S: 'Uttar Pradesh' }), true);
  assert.equal(ev('SAMESTATE({G}, {S})', { G: '09ABCDE1234F1Z5', S: 'Delhi' }), false);
  assert.equal(ev('SAMESTATE({G}, {S})', { G: '09ABCDE1234F1Z5', S: '' }), false);
});

// ── the motivating use case: CGST/SGST vs IGST split ──────────────────────────

test('conditional GST split via flat Math columns', () => {
  const intra = { 'Seller GST Num': '09ABCDE1234F1Z5', 'Shipping State': 'Uttar Pradesh', 'Taxable Value': 1000, 'Tax Rate': 0.18 };
  const inter = { 'Seller GST Num': '09ABCDE1234F1Z5', 'Shipping State': 'Maharashtra',   'Taxable Value': 1000, 'Tax Rate': 0.18 };

  const cgst = 'IF(SAMESTATE({Seller GST Num}, {Shipping State}), ROUND({Taxable Value} * {Tax Rate} / 2, 2), 0)';
  const sgst = cgst;
  const igst = 'IF(SAMESTATE({Seller GST Num}, {Shipping State}), 0, ROUND({Taxable Value} * {Tax Rate}, 2))';

  assert.equal(ev(cgst, intra), 90);
  assert.equal(ev(sgst, intra), 90);
  assert.equal(ev(igst, intra), 0);

  assert.equal(ev(cgst, inter), 0);
  assert.equal(ev(igst, inter), 180);
});

test('helpers are also available in cross-row (excel) formulas', () => {
  assert.equal(
    evaluateFormulaWithHelpers('GSTSTATE({G})', { G: '24AABCU9603R1ZM' }, [], new Map()),
    'Gujarat'
  );
});

// ── end-to-end through applyMultiSheetWorkflow ───────────────────────────────

test('end-to-end: computed GST columns land in the output workbook', () => {
  const input = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(input, XLSX.utils.json_to_sheet([
    { GSTIN: '09ABCDE1234F1Z5', Ship: 'Uttar Pradesh', Taxable: 1000, Rate: 0.18 },
    { GSTIN: '09ABCDE1234F1Z5', Ship: 'Karnataka',     Taxable: 500,  Rate: 0.12 },
  ]), 'Sales');
  const buf = XLSX.write(input, { type: 'buffer', bookType: 'xlsx' });

  const sheets = [{
    id: 's1', name: 'GST', rawSheetName: 'Sales', filters: [],
    columns: [
      { id: 'c1', label: 'Seller State',  type: 'source',   key: 'GSTIN',   order: 0 },
      { id: 'c2', label: 'Shipping State', type: 'source',   key: 'Ship',    order: 1 },
      { id: 'c3', label: 'Taxable Value',  type: 'source',   key: 'Taxable', order: 2 },
      { id: 'c4', label: 'Tax Rate',       type: 'source',   key: 'Rate',    order: 3 },
      { id: 'c5', label: 'CGST', type: 'computed', order: 4,
        formula: 'IF(SAMESTATE({Seller State}, {Shipping State}), ROUND({Taxable Value} * {Tax Rate} / 2, 2), 0)' },
      { id: 'c6', label: 'SGST', type: 'computed', order: 5,
        formula: 'IF(SAMESTATE({Seller State}, {Shipping State}), ROUND({Taxable Value} * {Tax Rate} / 2, 2), 0)' },
      { id: 'c7', label: 'IGST', type: 'computed', order: 6,
        formula: 'IF(SAMESTATE({Seller State}, {Shipping State}), 0, ROUND({Taxable Value} * {Tax Rate}, 2))' },
    ],
  }];

  const { buffer } = applyMultiSheetWorkflow(sheets, buf, {}, []);
  const out = XLSX.read(buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(out.Sheets['GST'], { defval: '' });

  assert.deepEqual(
    rows.map(r => [r.CGST, r.SGST, r.IGST]),
    [[90, 90, 0], [0, 0, 60]]
  );
});

test('SCALAR_HELPERS is exported for reuse', () => {
  assert.equal(typeof SCALAR_HELPERS.GSTSTATE, 'function');
});

/**
 * Coverage for the M-Brands-motivated engine additions: template-sheet
 * carry-forward, live (uncomputed) formula cells, and the subtotal-formula
 * sheet layout. Each is a generic, reusable capability — not brand-specific
 * logic — so these tests exercise them with small synthetic fixtures, not the
 * real M-Brands workflow (that gets an end-to-end check against the real
 * files separately, in scripts/mbrands-shopify/).
 *
 *   Run: node --test tests/workflowEngine.mbrands.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');

const {
  applyMultiSheetWorkflow, substituteDateTokens, buildFormulaCellText,
} = require('../src/services/workflowEngine');

const col = (label, extra) => ({ id: label, label, order: extra.order, ...extra });

function bookBuffer(sheetMap) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheetMap)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{}]), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── substituteDateTokens ───────────────────────────────────────────────────

test('substituteDateTokens fills in Month/MonthNumberPadded/Year/YearShort', () => {
  const dv = { Month: 'July', MonthNumber: 7, MonthNumberPadded: '07', Year: 2026, YearShort: '26' };
  assert.equal(substituteDateTokens('Sales-{Month} {YearShort}', dv), 'Sales-July 26');
  assert.equal(substituteDateTokens('-{MonthNumberPadded}', dv), '-07');
  assert.equal(substituteDateTokens('no tokens here', dv), 'no tokens here');
});

// ── buildFormulaCellText ───────────────────────────────────────────────────

test('buildFormulaCellText resolves {Label} to column-letter+row and {SheetLastRow:Name}', () => {
  const colLetterByLabel = { 'Lineitem Price': 'I', 'Discount Amount': 'L', 'Shipping Province Name': 'N' };
  const text = buildFormulaCellText(
    '=IFERROR(VLOOKUP({Shipping Province Name},Source!$B$2:$D${SheetLastRow:Source},2,0),"")',
    colLetterByLabel, 5, { Source: 35 }
  );
  assert.equal(text, 'IFERROR(VLOOKUP(N5,Source!$B$2:$D$35,2,0),"")'); // leading '=' stripped
});

test('buildFormulaCellText leaves an unresolved token visible rather than blanking it', () => {
  const text = buildFormulaCellText('={Typo Label}', {}, 3, {});
  assert.equal(text, '{Typo Label}');
});

// ── template sheet: whole-sheet carry-forward + refresh ───────────────────

test('template sheet copies a whole sheet verbatim and refreshes one column via regex', () => {
  const tplWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(tplWb, XLSX.utils.aoa_to_sheet([
    ['State', 'Inv no.'],
    ['Delhi', 'Shopify-DL-06'],
    ['Karnataka', 'Shopify-KA-06'],
  ]), 'Source');
  const tplBuf = XLSX.write(tplWb, { type: 'buffer', bookType: 'xlsx' });

  const sheets = [{
    id: 'source', name: 'Source', type: 'template',
    templateFileInputId: 'template', templateSheetName: 'Source',
    refresh: [{ column: 'B', startRow: 2, find: '-\\d{2}$', replace: '-{MonthNumberPadded}' }],
  }];

  const { buffer } = applyMultiSheetWorkflow(
    sheets, { template: tplBuf }, {}, [{ id: 'template', label: 'Template' }],
    { month: 'July', year: 2026 }
  );
  const out = XLSX.read(buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(out.Sheets['Source'], { header: 1, defval: '' });
  assert.deepEqual(rows, [
    ['State', 'Inv no.'],
    ['Delhi', 'Shopify-DL-07'],
    ['Karnataka', 'Shopify-KA-07'],
  ]);
});

test('template sheet throws a clear error when the named sheet is missing', () => {
  const tplWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(tplWb, XLSX.utils.aoa_to_sheet([['x']]), 'OnlySheet');
  const tplBuf = XLSX.write(tplWb, { type: 'buffer', bookType: 'xlsx' });
  const sheets = [{ id: 's', name: 'Source', type: 'template', templateFileInputId: 'template', templateSheetName: 'Source' }];
  assert.throws(
    () => applyMultiSheetWorkflow(sheets, { template: tplBuf }, {}, [{ id: 'template' }]),
    /template sheet "Source" not found/
  );
});

// ── subtotal-formula layout: live formulas + row-1 SUBTOTAL ───────────────

test('subtotal-formula layout writes real formula cells (not values) and a row-1 SUBTOTAL', () => {
  const raw = [
    { SKU: 'A1', Qty: 2, Price: 100, Discount: 10 },
    { SKU: 'A2', Qty: 3, Price: 200, Discount: 0 },
  ];

  const sheets = [{
    id: 'sales', name: 'Sales', layout: 'subtotal-formula',
    sourceType: 'raw', rawSheetName: 'Data', filters: [],
    columns: [
      col('SKU', { order: 0, type: 'source', key: 'SKU' }),
      col('Qty', { order: 1, type: 'source', key: 'Qty', subtotal: true }),
      col('Price', { order: 2, type: 'source', key: 'Price' }),
      col('Discount', { order: 3, type: 'source', key: 'Discount' }),
      col('Net', { order: 4, type: 'formula', formula: '={Price}-{Discount}', subtotal: true }),
    ],
  }];

  const { buffer } = applyMultiSheetWorkflow(sheets, bookBuffer({ Data: raw }), {}, []);
  const out = XLSX.read(buffer, { type: 'buffer', cellFormula: true });
  const ws = out.Sheets['Sales'];

  // Row 2 = headers, row 3+ = data (row 1 reserved for SUBTOTAL formulas)
  assert.equal(ws['A2'].v, 'SKU');
  assert.equal(ws['B2'].v, 'Qty');
  assert.equal(ws['E2'].v, 'Net');
  assert.equal(ws['A3'].v, 'A1');
  assert.equal(ws['B3'].v, 2);

  // Net is a LIVE formula, not a precomputed value — its `v` is just a throwaway
  // placeholder (SheetJS drops a formula cell entirely if it has no `v` at all);
  // Excel recalculates and overwrites it on open (fullCalcOnLoad).
  assert.equal(ws['E3'].f, 'C3-D3');
  assert.equal(ws['E4'].f, 'C4-D4');

  // Row-1 SUBTOTAL only on flagged columns (Qty, Net) — not Price/Discount
  assert.equal(ws['B1'].f, 'SUBTOTAL(9,B3:B4)');
  assert.equal(ws['E1'].f, 'SUBTOTAL(9,E3:E4)');
  assert.equal(ws['C1'], undefined);
  assert.equal(ws['D1'], undefined);
});

test('subtotal-formula layout: fillDownFormula writes a same-column previous-row reference, not a copied value', () => {
  const raw = [
    { SKU: 'A1', Region: 'North' },
    { SKU: 'A2', Region: '' },   // blank — should become a live formula pointing at the row above
    { SKU: 'A3', Region: 'South' },
  ];
  const sheets = [{
    id: 'sales', name: 'Sales', layout: 'subtotal-formula',
    sourceType: 'raw', rawSheetName: 'Data', filters: [],
    columns: [
      col('SKU', { order: 0, type: 'source', key: 'SKU' }),
      col('Region', { order: 1, type: 'source', key: 'Region', fillDownFormula: true }),
    ],
  }];
  const { buffer } = applyMultiSheetWorkflow(sheets, bookBuffer({ Data: raw }), {}, []);
  const out = XLSX.read(buffer, { type: 'buffer', cellFormula: true });
  const ws = out.Sheets['Sales'];

  assert.equal(ws['B3'].v, 'North'); // first row: literal value, no formula
  assert.equal(ws['B3'].f, undefined);
  assert.equal(ws['B4'].f, 'B3');    // blank row: formula referencing the row above
  assert.equal(ws['B5'].v, 'South'); // non-blank row: literal value again
});

test('a formula column can VLOOKUP against a template sheet via {SheetLastRow:Name}', () => {
  const tplWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(tplWb, XLSX.utils.aoa_to_sheet([
    ['State', 'Debtor'],
    ['Delhi', 'Shopify-DELHI'],
    ['Karnataka', 'Shopify-KARNATAKA'],
  ]), 'Source');
  const tplBuf = XLSX.write(tplWb, { type: 'buffer', bookType: 'xlsx' });

  const raw = [{ State: 'Delhi' }];

  const sheets = [
    { id: 'source', name: 'Source', type: 'template', templateFileInputId: 'template', templateSheetName: 'Source' },
    {
      id: 'sales', name: 'Sales', layout: 'subtotal-formula',
      sourceType: 'raw', fileInputId: 'raw', rawSheetName: 'Data', filters: [],
      columns: [
        col('State', { order: 0, type: 'source', key: 'State' }),
        col('Debtor', {
          order: 1, type: 'formula',
          formula: '=IFERROR(VLOOKUP({State},Source!$A$2:$B${SheetLastRow:Source},2,0),"")',
        }),
      ],
    },
  ];

  const { buffer } = applyMultiSheetWorkflow(
    sheets, { raw: bookBuffer({ Data: raw }), template: tplBuf }, {},
    [{ id: 'raw' }, { id: 'template' }]
  );
  const out = XLSX.read(buffer, { type: 'buffer', cellFormula: true });
  assert.equal(out.Sheets['Sales']['B3'].f, 'IFERROR(VLOOKUP(A3,Source!$A$2:$B$3,2,0),"")');
});

test('sheet name tokens ({Month} {YearShort}) render into the output tab name', () => {
  const raw = [{ X: 1 }];
  const sheets = [{
    id: 's', name: 'Sales-{Month} {YearShort}', sourceType: 'raw', rawSheetName: 'Data', filters: [],
    columns: [col('X', { order: 0, type: 'source', key: 'X' })],
  }];
  const { buffer } = applyMultiSheetWorkflow(sheets, bookBuffer({ Data: raw }), {}, [], { month: 'July', year: 2026 });
  const out = XLSX.read(buffer, { type: 'buffer' });
  assert.ok(out.SheetNames.includes('Sales-July 26'), out.SheetNames.join(', '));
});

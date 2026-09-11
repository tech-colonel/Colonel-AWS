/**
 * Parity + speed check for the workflowEngine optimisation.
 *
 * Runs the CURRENT engine and the pre-optimisation backup side by side on a
 * battery of synthetic workflows and asserts the produced workbooks are
 * row-for-row identical. stdlib node:test only.
 *
 *   Run: node --test tests/workflowEngine.parity.test.js
 *
 * The backup path is picked up from the newest workflowEngine.js.bak-* next to
 * the live file; set WF_ENGINE_BAK to override.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const NEW = require('../src/services/workflowEngine');

const bak = process.env.WF_ENGINE_BAK || (() => {
  const dir = path.join(__dirname, '../src/services');
  const cand = fs.readdirSync(dir)
    .filter(f => f.startsWith('workflowEngine.js.bak-'))
    .sort()
    .pop();
  if (!cand) throw new Error('no workflowEngine.js.bak-* found; set WF_ENGINE_BAK');
  return path.join(dir, cand);
})();
const OLD = require(bak);

// ── helpers ──────────────────────────────────────────────────────────────────

// { SheetName: [ {col: val, ...}, ... ] }  ->  xlsx Buffer
function bookBuffer(sheetMap) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheetMap)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{}]), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// output Buffer -> { SheetName: [ row objects ] }
function readBook(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const out = {};
  for (const sn of wb.SheetNames) out[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: '' });
  return out;
}

function assertSameOutput(label, sheets, inputMap, masterData, fileInputs) {
  const a = OLD.applyMultiSheetWorkflow(sheets, inputMap, masterData, fileInputs);
  const b = NEW.applyMultiSheetWorkflow(sheets, inputMap, masterData, fileInputs);
  assert.deepStrictEqual(readBook(b.buffer), readBook(a.buffer), `${label}: workbook rows differ`);
  assert.deepStrictEqual(
    b.missingMasterValues, a.missingMasterValues,
    `${label}: missingMasterValues differ`,
  );
}

const col = (label, extra) => ({ id: label, label, order: extra.order, ...extra });

// ── fixtures ─────────────────────────────────────────────────────────────────

test('source + computed (IF, arithmetic, string concat, {Sheet.Col})', () => {
  const raw = [];
  for (let i = 0; i < 400; i++) {
    raw.push({ SKU: `S${i % 25}`, Qty: (i % 7) + 1, Rate: 10 + (i % 5), Region: ['N', 'S', 'E'][i % 3], Note: i % 4 ? `n${i}` : '' });
  }
  const sheets = [
    {
      id: 's1', name: 'Base', order: 0, sourceType: 'raw', fileInputId: null,
      rawSheetName: 'Data', prevSheetName: null, filters: [],
      columns: [
        col('SKU', { order: 0, type: 'source', key: 'SKU' }),
        col('Qty', { order: 1, type: 'source', key: 'Qty' }),
        col('Rate', { order: 2, type: 'source', key: 'Rate' }),
        col('Region', { order: 3, type: 'source', key: 'Region' }),
        col('Amount', { order: 4, type: 'computed', formula: '{Qty} * {Rate}' }),
        col('Band', { order: 5, type: 'computed', formula: 'IF({Amount} > 40, "HI", "LO")' }),
        col('Tag', { order: 6, type: 'computed', formula: '"R-" + {Region}' }),
        col('BlankNote', { order: 7, type: 'source', key: 'Note' }),
      ],
      groupBy: { enabled: false, columns: [], aggregations: {} },
    },
    {
      id: 's2', name: 'Derived', order: 1, sourceType: 'raw', fileInputId: null,
      rawSheetName: 'Data', prevSheetName: null, filters: [{ id: 'f', column: 'Region', operator: 'equals', value: 'N' }],
      columns: [
        col('SKU', { order: 0, type: 'source', key: 'SKU' }),
        col('FromBase', { order: 1, type: 'computed', formula: '{Base.Amount} + 1' }),
      ],
      groupBy: { enabled: false, columns: [], aggregations: {} },
    },
  ];
  assertSameOutput('computed', sheets, bookBuffer({ Data: raw }), {}, []);
});

test('excel cross-row: SUMIF / SUMIFS / COUNTIF / COUNTIFS / AVERAGEIF / VLOOKUP / MAXIF / MINIF', () => {
  const raw = [];
  for (let i = 0; i < 600; i++) {
    raw.push({
      SKU: `S${i % 30}`,
      Cat: ['A', 'B', 'C'][i % 3],
      State: ['MH', 'KA', 'DL'][i % 3],
      Net: (i % 11) - 3,            // includes negatives and zero
      Blank: i % 5 === 0 ? '' : i,  // some non-numeric-ish gaps
    });
  }
  const sheets = [{
    id: 's1', name: 'Calc', order: 0, sourceType: 'raw', fileInputId: null,
    rawSheetName: 'Data', prevSheetName: null, filters: [],
    columns: [
      col('SKU', { order: 0, type: 'source', key: 'SKU' }),
      col('Cat', { order: 1, type: 'source', key: 'Cat' }),
      col('State', { order: 2, type: 'source', key: 'State' }),
      col('Net', { order: 3, type: 'source', key: 'Net' }),
      col('SumBySku', { order: 4, type: 'excel', formula: 'SUMIF("SKU", {SKU}, "Net")' }),
      col('SumBySkuCat', { order: 5, type: 'excel', formula: 'SUMIFS("Net", "SKU", {SKU}, "Cat", {Cat})' }),
      col('CntBySku', { order: 6, type: 'excel', formula: 'COUNTIF("SKU", {SKU})' }),
      col('CntBySkuState', { order: 7, type: 'excel', formula: 'COUNTIFS("SKU", {SKU}, "State", {State})' }),
      col('AvgByCat', { order: 8, type: 'excel', formula: 'AVERAGEIF("Cat", {Cat}, "Net")' }),
      col('LookupState', { order: 9, type: 'excel', formula: 'VLOOKUP({SKU}, "SKU", "State")' }),
      col('MaxByCat', { order: 10, type: 'excel', formula: 'MAXIF("Cat", {Cat}, "Net")' }),
      col('MinByCat', { order: 11, type: 'excel', formula: 'MINIF("Cat", {Cat}, "Net")' }),
      col('Derived', { order: 12, type: 'excel', formula: 'SUMIF("SKU", {SKU}, "Net") + COUNTIF("Cat", {Cat})' }),
      // references an earlier computed column by label
      col('SumOfSum', { order: 13, type: 'excel', formula: 'SUMIF("Cat", {Cat}, "SumBySku")' }),
    ],
    groupBy: { enabled: false, columns: [], aggregations: {} },
  }];
  assertSameOutput('excel', sheets, bookBuffer({ Data: raw }), {}, []);
});

test('master_lookup / master_validate + missingMasterValues', () => {
  const raw = [];
  for (let i = 0; i < 300; i++) raw.push({ PortalSku: `P${i % 40}`, Ledger: `L${i % 10}` });
  const masterData = {
    sku_master: Array.from({ length: 20 }, (_, i) => ({ salesPortalSku: `P${i}`, tallySku: `T${i}`, hsn: `HSN${i}` })),
    ledger_master: Array.from({ length: 6 }, (_, i) => ({ name: `L${i}`, group: `G${i % 2}` })),
  };
  const sheets = [{
    id: 's1', name: 'M', order: 0, sourceType: 'raw', fileInputId: null,
    rawSheetName: 'Data', prevSheetName: null, filters: [],
    columns: [
      col('PortalSku', { order: 0, type: 'source', key: 'PortalSku' }),
      col('TallySku', { order: 1, type: 'master_lookup', masterType: 'sku', lookupColumn: 'PortalSku', matchField: 'salesPortalSku', returnField: 'tallySku' }),
      col('SkuOk', { order: 2, type: 'master_validate', masterType: 'sku', lookupColumn: 'PortalSku', matchField: 'salesPortalSku', matchLabel: 'Y', noMatchLabel: 'N' }),
      col('LedgerGroup', { order: 3, type: 'master_lookup', masterType: 'ledger', lookupColumn: 'Ledger', matchField: 'name', returnField: 'group' }),
    ],
    groupBy: { enabled: false, columns: [], aggregations: {} },
  }];
  assertSameOutput('master', sheets, bookBuffer({ Data: raw }), masterData, []);
});

test('groupBy aggregations', () => {
  const raw = [];
  for (let i = 0; i < 500; i++) raw.push({ Cat: ['A', 'B', 'C', 'D'][i % 4], Qty: i % 9, Amt: (i % 13) * 1.5, Name: `x${i}` });
  const sheets = [{
    id: 's1', name: 'G', order: 0, sourceType: 'raw', fileInputId: null,
    rawSheetName: 'Data', prevSheetName: null, filters: [],
    columns: [
      col('Cat', { order: 0, type: 'source', key: 'Cat' }),
      col('Qty', { order: 1, type: 'source', key: 'Qty' }),
      col('Amt', { order: 2, type: 'source', key: 'Amt' }),
      col('Name', { order: 3, type: 'source', key: 'Name' }),
    ],
    groupBy: { enabled: true, columns: ['Cat'], aggregations: { Qty: 'sum', Amt: 'avg', Name: 'concat' } },
  }];
  assertSameOutput('groupBy', sheets, bookBuffer({ Data: raw }), {}, []);
});

test('merge: join / stack / column_combine + prev_sheet chaining', () => {
  const left = Array.from({ length: 120 }, (_, i) => ({ Key: `K${i}`, L: i }));
  const right = Array.from({ length: 90 }, (_, i) => ({ Key: `K${i}`, R: i * 10 }));
  const sheets = [
    {
      id: 's1', name: 'L', order: 0, sourceType: 'raw', fileInputId: null, rawSheetName: 'Left', prevSheetName: null, filters: [],
      columns: [col('Key', { order: 0, type: 'source', key: 'Key' }), col('L', { order: 1, type: 'source', key: 'L' })],
      groupBy: { enabled: false, columns: [], aggregations: {} },
    },
    {
      id: 's2', name: 'Joined', order: 1, type: 'merge',
      mergeConfig: {
        mergeType: 'join', commonJoinKey: 'Key',
        sources: [
          { type: 'output', sheetName: 'L', columns: ['Key', 'L'], joinKey: 'Key' },
          { type: 'raw', sheetName: 'Right', columns: ['R'], joinKey: 'Key' },
        ],
      },
    },
    {
      id: 's3', name: 'Stacked', order: 2, type: 'merge',
      mergeConfig: {
        mergeType: 'stack', commonJoinKey: null,
        sources: [
          { type: 'raw', sheetName: 'Left', columns: ['Key'], joinKey: null },
          { type: 'raw', sheetName: 'Right', columns: ['Key'], joinKey: null },
        ],
      },
    },
    {
      id: 's4', name: 'Zip', order: 3, type: 'merge',
      mergeConfig: {
        mergeType: 'column_combine', commonJoinKey: null,
        sources: [
          { type: 'raw', sheetName: 'Left', columns: ['L'], joinKey: null },
          { type: 'raw', sheetName: 'Right', columns: ['R'], joinKey: null },
        ],
      },
    },
    {
      id: 's5', name: 'AfterJoin', order: 4, sourceType: 'prev_sheet', fileInputId: null, rawSheetName: null, prevSheetName: 'Joined', filters: [],
      columns: [
        col('Key', { order: 0, type: 'source', key: 'Key' }),
        col('Sum', { order: 1, type: 'computed', formula: '{L} + {R}' }),
      ],
      groupBy: { enabled: false, columns: [], aggregations: {} },
    },
  ];
  assertSameOutput('merge', sheets, bookBuffer({ Left: left, Right: right }), {}, []);
});

test('speed: excel-heavy sheet is dramatically faster', () => {
  const N = 4000;
  const raw = Array.from({ length: N }, (_, i) => ({ SKU: `S${i % 200}`, Cat: ['A', 'B', 'C', 'D', 'E'][i % 5], Net: i % 50 }));
  const sheets = [{
    id: 's1', name: 'Calc', order: 0, sourceType: 'raw', fileInputId: null, rawSheetName: 'Data', prevSheetName: null, filters: [],
    columns: [
      col('SKU', { order: 0, type: 'source', key: 'SKU' }),
      col('Cat', { order: 1, type: 'source', key: 'Cat' }),
      col('A', { order: 2, type: 'excel', formula: 'SUMIF("SKU", {SKU}, "Net")' }),
      col('B', { order: 3, type: 'excel', formula: 'COUNTIF("Cat", {Cat})' }),
      col('C', { order: 4, type: 'excel', formula: 'AVERAGEIF("Cat", {Cat}, "Net")' }),
    ],
    groupBy: { enabled: false, columns: [], aggregations: {} },
  }];
  const input = bookBuffer({ Data: raw });

  const t0 = process.hrtime.bigint();
  OLD.applyMultiSheetWorkflow(sheets, input, {}, []);
  const t1 = process.hrtime.bigint();
  NEW.applyMultiSheetWorkflow(sheets, input, {}, []);
  const t2 = process.hrtime.bigint();

  const oldMs = Number(t1 - t0) / 1e6;
  const newMs = Number(t2 - t1) / 1e6;
  console.log(`    excel-heavy ${N} rows: old ${oldMs.toFixed(0)}ms -> new ${newMs.toFixed(0)}ms  (${(oldMs / newMs).toFixed(1)}x)`);
  assert.ok(newMs * 3 < oldMs, `expected >3x speedup, got ${(oldMs / newMs).toFixed(1)}x`);
});

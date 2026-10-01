/* Build one month's Amazon settlement workbook.
 *
 *   node scripts/build-amazon-month.js 2026-07 "<out.xlsx>" [invoices.json]
 *
 * Four tabs: Summary (the month), Pivot (which settlements, from → to),
 * Settlement (every row, with the fee split), and — when invoice data is
 * supplied — Difference (what Amazon billed against what it actually took).
 *
 * Reads the retained ledgers on disk. Never calls Amazon.
 */
const fs = require('fs');
const path = require('path');
const XLSXStyle = require('xlsx-js-style');
const { buildSummaryAoA, styleSummarySheet, feeSplitRows, FEE_COLUMNS } =
  require('../src/services/processors/amazonSettlementSummary');
const { pivotSettlementRows, parseAmazonDate } =
  require('../src/services/processors/amazonSettlementPivot');
const { buildPivotAoA, buildDifferenceAoA, coverageGaps } =
  require('../src/services/processors/amazonSettlementMonthly');

const [MONTH, OUT, INVOICES] = process.argv.slice(2);
if (!MONTH || !OUT) { console.error('usage: build-amazon-month.js YYYY-MM out.xlsx [invoices.json]'); process.exit(1); }
const [YEAR, MON] = MONTH.split('-').map(Number);
const LABEL = new Date(Date.UTC(YEAR, MON - 1, 1))
  .toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DIR = path.resolve(__dirname, '../outputs/amazon-ledgers/Koparo');

/* Amazon stamps UTC; an Indian accountant reads IST, and a settlement posted
   23:40 UTC on the 31st belongs to the next month in IST. */
const istKey = (v) => {
  const d = v instanceof Date ? v : parseAmazonDate(v);
  if (!d) return '';
  const i = new Date(d.getTime() + 19800000);
  return `${i.getUTCFullYear()}-${String(i.getUTCMonth() + 1).padStart(2, '0')}`;
};
const istDay = (v) => {
  const d = parseAmazonDate(v);
  if (!d) return '';
  const i = new Date(d.getTime() + 19800000);
  const p = (n) => String(n).padStart(2, '0');
  return `${i.getUTCFullYear()}-${p(i.getUTCMonth() + 1)}-${p(i.getUTCDate())}`;
};
const disp = (s) => (s ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : '');
const feeCols = FEE_COLUMNS.map(([c]) => c);

const seen = new Set();
const parts = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.tsv')).sort()) {
  const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter((l) => l.length);
  const hdr = lines[0].split('\t');
  const led = lines.slice(1).map((l) => {
    const c = l.split('\t'); const o = {};
    hdr.forEach((h, i) => { o[h.trim()] = (c[i] || '').trim(); });
    return o;
  });
  const r = pivotSettlementRows(led);
  const s = r.settlement;
  if (!s || seen.has(s.settlement_id)) continue;

  const from = istDay(s.start_date), to = istDay(s.end_date);
  let touches = false;
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCFullYear() === YEAR && d.getUTCMonth() + 1 === MON) { touches = true; break; }
  }
  if (!touches) continue;
  seen.add(s.settlement_id);

  /* the fee split, grouped with the pivot's own key in the pivot's own order */
  const split = feeSplitRows(led);
  if (split.length !== r.rows.length
      || !r.rows.every((x, i) => (x.order_id || null) === (split[i]._order || null))) {
    console.error(`  ALIGNMENT FAILED on ${s.settlement_id}`); process.exit(1);
  }
  const rows = r.rows.map((x, i) => {
    const o = { ...x };
    for (const c of feeCols) o[c] = split[i][c];
    o.posted_month = istKey(x.date_time);      // sheet-only helper
    return o;
  });
  parts.push({ settlement: s, ledger: led, rows, _from: from, _to: to,
               from: disp(from), to: disp(to), deposited: disp(istDay(s.deposit_date)) });
}
if (!parts.length) { console.error(`no settlements touch ${MONTH}`); process.exit(1); }
parts.sort((a, b) => a._from.localeCompare(b._from));

const allLedger = parts.flatMap((p) => p.ledger);
const allRows = parts.flatMap((p) => p.rows);
const synthetic = {
  settlement_id: `${parts.length} settlements`,
  start_date: parts[0].settlement.start_date,
  end_date: parts[parts.length - 1].settlement.end_date,
  deposit_date: null,
  total_amount: parts.reduce((a, p) => a + Number(p.settlement.total_amount || 0), 0),
};

const { aoa, checks, colWidths, verifyAgainst } =
  buildSummaryAoA(allLedger, synthetic, allRows.length);
const bad = verifyAgainst(allRows);
if (bad.length) { console.error('  summary formulas disagree with the sheet:', bad); process.exit(1); }

const gaps = coverageGaps(parts.map((p) => ({ from: p._from, to: p._to })), YEAR, MON);
const pv = buildPivotAoA(parts, LABEL, {
  firstDay: disp(parts[0]._from), lastDay: disp(parts[parts.length - 1]._to), gaps });

const book = XLSXStyle.utils.book_new();
const sum = XLSXStyle.utils.aoa_to_sheet(aoa);
sum['!cols'] = colWidths; styleSummarySheet(sum, aoa, checks);
XLSXStyle.utils.book_append_sheet(book, sum, 'Summary');

const pvs = XLSXStyle.utils.aoa_to_sheet(pv.aoa);
pvs['!cols'] = pv.colWidths;
XLSXStyle.utils.book_append_sheet(book, pvs, 'Pivot');

/* Difference, only when invoice data was supplied. */
let diffLines = null;
if (INVOICES && fs.existsSync(INVOICES)) {
  const inv = JSON.parse(fs.readFileSync(INVOICES, 'utf8'));
  const d = buildDifferenceAoA(MONTH, LABEL, inv, inv.lines);
  diffLines = inv.lines;
  const ds = XLSXStyle.utils.aoa_to_sheet(d.aoa);
  ds['!cols'] = d.colWidths;
  XLSXStyle.utils.book_append_sheet(book, ds, 'Difference');
}

const ws = XLSXStyle.utils.json_to_sheet(allRows, { cellDates: true });
ws['!freeze'] = { xSplit: 0, ySplit: 1 };
ws['!autofilter'] = { ref: XLSXStyle.utils.encode_range({
  s: { r: 0, c: 0 }, e: { r: allRows.length, c: Object.keys(allRows[0]).length - 1 } }) };
XLSXStyle.utils.book_append_sheet(book, ws, 'Settlement');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, XLSXStyle.write(book, { type: 'buffer', bookType: 'xlsx' }));

const inMonth = allRows.filter((r) => r.posted_month === MONTH);
console.log(`  ${LABEL}: ${parts.length} settlements, ${allRows.length} rows `
  + `(${inMonth.length} posted in the month), payout ${synthetic.total_amount.toFixed(2)}`);
console.log(`  coverage: ${gaps.length ? 'GAPS ' + gaps.join(' | ') : 'complete'}`);
console.log(`  tabs: Summary, Pivot${diffLines ? ', Difference' : ''}, Settlement`);
console.log(`  written: ${OUT}`);

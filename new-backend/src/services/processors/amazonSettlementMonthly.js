/* ──────────────────────────────────────────────────────────────────────────────
   amazonSettlementMonthly.js — one workbook for a calendar month, built from
   the settlements that fall in it.

   Amazon does not settle by month. It settles roughly every seven days, on its
   own cycle, and deposits two days after a period closes. So "January" is never
   one report — it is however many settlement periods happen to land there, and
   the first question anyone asks of a monthly figure is which ones.

   That is what the PIVOT tab is for. One row per settlement, showing the period
   it covers (from → to), the day it was deposited, and every component it
   contributed. Each of those cells is a SUMIFS over the Settlement tab filtered
   on that settlement id, so clicking one highlights exactly the rows it came
   from — the same behaviour the Summary has, one level further down.

   The month's coverage is stated rather than implied. A settlement period that
   starts before the 1st or ends after the last day is shown as such, and days
   no settlement covers are named. A monthly total that silently omits nine days
   is worse than one that says so.
   ────────────────────────────────────────────────────────────────────────────── */

const { ROW_COLUMNS } = require('./amazonSettlementPivot');
const { FEE_COLUMNS } = require('./amazonSettlementSummary');

const FMT_AMT = '#,##0.00;-#,##0.00';
const FMT_INT = '#,##0';
const r2 = (n) => Number((n || 0).toFixed(2));

/* Column letters resolved by NAME from the settlement sheet's own order, never
   hardcoded — the same rule the Summary follows, for the same reason. */
/* `posted_month` is a helper column the monthly workbook adds to the Settlement
   sheet: the IST month each row posted in, so a figure can be filtered to the
   month without the reader having to parse a timestamp. Sheet only — it is
   never stored. */
const SHEET_COLS = [...ROW_COLUMNS, ...FEE_COLUMNS.map(([c]) => c), 'posted_month'];
function colLetter(name) {
  const i = SHEET_COLS.indexOf(name);
  if (i < 0) throw new Error(`settlement sheet has no column "${name}"`);
  let n = i, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
const C = (name) => `Settlement!$${colLetter(name)}:$${colLetter(name)}`;

/* What the pivot shows per settlement. `col` is the settlement-sheet column it
   sums; `type` narrows it to one transaction type where the summary does. */
const PIVOT_COLUMNS = [
  { label: 'Gross Sales',        col: 'product_sales', type: 'Order' },
  { label: 'Returns / Refunds',  col: 'product_sales', type: 'Refund' },
  { label: 'Cancellations',      col: 'product_sales', type: 'Cancellation' },
  { label: 'Shipping',           col: 'shipping_credits' },
  { label: 'Promotions',         col: 'promotional_rebates' },
  { label: 'GST from Buyers',    col: 'gst_before_tcs' },
  { label: 'Commission',         col: 'commission' },
  { label: 'Fixed Fee',          col: 'fixed_fee' },
  { label: 'Logistics',          col: 'logistics_fee' },
  { label: 'Storage',            col: 'storage_fee' },
  { label: 'Advertising',        col: 'advertising_fee' },
  { label: 'Other Charges',      col: 'other_charges' },
  { label: 'GST on Fees',        col: 'gst_on_fees' },
  { label: 'TDS 194-O',          col: 'tds_194o' },
  { label: 'TCS CGST',           col: 'tcs_cgst' },
  { label: 'TCS SGST',           col: 'tcs_sgst' },
  { label: 'TCS IGST',           col: 'tcs_igst' },
  { label: 'Debt Adjustment',    col: 'debt_adjustment' },
];

/**
 * The Pivot tab: one row per settlement, every figure a live SUMIFS over the
 * Settlement tab.
 *
 * @param parts  [{ settlement, rows, from, to, deposited }] in period order
 * @param monthLabel  e.g. "January 2026"
 * @param coverage    { firstDay, lastDay, gaps: [ 'string', … ] }
 */
function buildPivotAoA(parts, monthLabel, coverage) {
  const aoa = [];
  const F = (f, z) => ({ t: 'n', v: 0, f, z });
  const S = (v) => ({ t: 's', v });
  const I = (v) => ({ t: 'n', v: Number(v) || 0, z: FMT_INT });

  const push = (...cells) => { aoa.push(cells); return aoa.length; };

  push(S(`${monthLabel} — where every figure comes from`));
  push(S('One row per Amazon settlement. Every amount is a live SUMIFS over the Settlement tab '
       + 'filtered on that settlement id — click one and the rows it came from highlight.'));
  push();

  /* Coverage, stated before the numbers. */
  push(S('Month covered'), S(`${coverage.firstDay} to ${coverage.lastDay}`));
  push(S('Settlements in this report'), I(parts.length));
  for (const g of coverage.gaps) push(S('Not covered by any settlement'), S(g));
  push();

  const head = ['Settlement ID', 'Period from', 'Period to', 'Deposited', 'Rows',
                ...PIVOT_COLUMNS.map((c) => c.label), 'Amazon payout'];
  push(...head.map(S));
  const firstRow = aoa.length + 1;

  for (const p of parts) {
    const id = String(p.settlement.settlement_id);
    const cells = [S(id), S(p.from), S(p.to), S(p.deposited), I(p.rows.length)];
    for (const c of PIVOT_COLUMNS) {
      cells.push(F(c.type
        ? `SUMIFS(${C(c.col)},${C('settlement_id')},"${id}",${C('type')},"${c.type}")`
        : `SUMIFS(${C(c.col)},${C('settlement_id')},"${id}")`, FMT_AMT));
    }
    cells.push({ t: 'n', v: Number(p.settlement.total_amount) || 0, z: FMT_AMT });
    push(...cells);
  }
  const lastRow = aoa.length;

  /* The total is a SUM of the rows above, not a recomputation — so the month
     cannot disagree with the settlements it is made of. */
  const colL = (i) => {
    let n = i, s = '';
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  };
  const totals = [S('TOTAL — the month'), S(''), S(''), S(''),
                  F(`SUM(E${firstRow}:E${lastRow})`, FMT_INT)];
  for (let i = 0; i < PIVOT_COLUMNS.length + 1; i++) {
    const L = colL(5 + i);
    totals.push(F(`SUM(${L}${firstRow}:${L}${lastRow})`, FMT_AMT));
  }
  push(...totals);

  return {
    aoa,
    totalRow: aoa.length,
    colWidths: [{ wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 7 },
                ...PIVOT_COLUMNS.map(() => ({ wch: 13 })), { wch: 14 }],
  };
}

/**
 * Which calendar days of a month no settlement period covers.
 * Periods are half-open in Amazon's own reporting: a period "23-01 to 30-01"
 * settles activity up to the 30th, so the 30th is covered and the 31st is not.
 */
function coverageGaps(parts, year, month) {
  const pad = (n) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const covered = new Set();
  for (const p of parts) {
    const a = new Date(`${p.from}T00:00:00Z`), b = new Date(`${p.to}T00:00:00Z`);
    for (let d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month) {
        covered.add(d.getUTCDate());
      }
    }
  }
  const gaps = [];
  let run = null;
  for (let d = 1; d <= last; d++) {
    if (!covered.has(d)) { run = run || { a: d }; run.b = d; }
    else if (run) { gaps.push(run); run = null; }
  }
  if (run) gaps.push(run);
  return gaps.map((g) => (g.a === g.b
    ? `${pad(g.a)}-${pad(month)}-${year}`
    : `${pad(g.a)}-${pad(month)}-${year} to ${pad(g.b)}-${pad(month)}-${year}`));
}

/* ── Difference: Amazon's fee invoices against what the settlements took ──────
   Amazon bills its fees on a monthly tax invoice per state, and separately
   deducts them settlement by settlement. The two should describe the same
   money. Where they do not, somebody has to be able to see by how much and on
   which fee — which is the whole question this tab exists to answer.

   The settlement side is a SUMIFS over the Settlement tab filtered on
   `posted_month`, so it stays clickable like every other figure in the book.
   The invoice side is typed from the PDFs and is stated as such.

   A caution is printed on the face of it, because it changes how the number
   should be read: an invoice carries the date a fee was CHARGED, a settlement
   the date it POSTED. Fees dated at the end of a month settle in the next one.
   So a residual difference is expected, and only a fee-by-fee match on order id
   can turn this into a claim rather than a question. */
function buildDifferenceAoA(monthKey, monthLabel, invoice, lines) {
  const aoa = [];
  const S = (v) => ({ t: 's', v });
  const A = (v) => ({ t: 'n', v: Number(v) || 0, z: FMT_AMT });
  const F = (f, z) => ({ t: 'n', v: 0, f, z: z || FMT_AMT });
  const push = (...c) => { aoa.push(c); return aoa.length; };
  const M = (col) => `SUMIFS(${C(col)},${C('posted_month')},"${monthKey}")`;

  push(S(`${monthLabel} — what Amazon invoiced against what the settlements deducted`));
  push(S('Settlement figures are live SUMIFS over the Settlement tab, filtered to fees posted in this month. '
       + 'Invoice figures are read from Amazon’s monthly tax invoices.'));
  push();

  push(S('WHAT AMAZON INVOICED'));
  push(S('Document'), S('Type'), S('Date'), S('State'), S('Fees ex GST'), S('GST'), S('Total'));
  const docFirst = aoa.length + 1;
  for (const d of invoice.docs) {
    push(S(d.num), S(d.kind), S(d.date), S(d.state), A(d.fees), A(d.gst), A(d.total));
  }
  const docLast = aoa.length;
  const rInv = push(S(`Net invoiced — ${invoice.docs.length} documents`), S(''), S(''), S(''),
                    F(`SUM(E${docFirst}:E${docLast})`), F(`SUM(F${docFirst}:F${docLast})`),
                    F(`SUM(G${docFirst}:G${docLast})`));
  push();

  push(S('FEE BY FEE'));
  push(S('Fee'), S('Invoiced'), S('Settlement'), S('Difference'), S('Note'));
  const lineFirst = aoa.length + 1;
  for (const l of lines) {
    const row = aoa.length + 1;
    push(S(l.label), A(l.invoiced),
         l.col ? F(`ABS(${M(l.col)})`) : A(0),
         F(`B${row}-C${row}`), S(l.note || ''));
  }
  const lineLast = aoa.length;
  const rTot = push(S('Total'), F(`SUM(B${lineFirst}:B${lineLast})`),
                    F(`SUM(C${lineFirst}:C${lineLast})`), F(`SUM(D${lineFirst}:D${lineLast})`),
                    S('positive = invoiced more than deducted'));
  push();

  push(S('THE DIFFERENCE'));
  push(S('Invoiced, net of credit notes (ex GST)'), F(`E${rInv}`));
  push(S('Deducted by the settlements (ex GST)'),   F(`C${rTot}`));
  const rDiff = push(S('Difference (ex GST)'), F(`B${aoa.length - 1}-B${aoa.length}`));
  push();

  push(S('HOW TO READ THIS'));
  for (const t of [
    'An invoice is dated when the fee was CHARGED. A settlement carries it when it POSTED.',
    'Fees charged at the end of a month settle in the next one, so a residual difference is expected.',
    'Closing it properly means matching fee by fee on order id, not month against month.',
    'Storage, long-term storage and inbound transportation are billed to the account, not per order,',
    '    so they appear on an invoice but never in a settlement fee column.',
  ]) push(S(t));

  return { aoa, diffRow: rDiff,
           colWidths: [{ wch: 40 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 46 },
                       { wch: 12 }, { wch: 12 }] };
}

module.exports = { buildPivotAoA, buildDifferenceAoA, coverageGaps, PIVOT_COLUMNS, colLetter };

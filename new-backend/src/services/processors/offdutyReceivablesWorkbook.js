/* ──────────────────────────────────────────────────────────────────────────────
   offdutyReceivablesWorkbook.js — write the Receivables Summary workbook.

   Laid out like the Amazon settlement summary the accountants already read, and
   for the same reason: that sheet answers ONE question — we expected X, we
   received Y, here is every line that explains the difference — and an
   accountant can click any cell and see how it was derived.

   FORMULAS, NOT VALUES. Only figures that come from a source file are hard
   values. Every ratio, subtotal and difference is a live formula, so editing an
   input moves the rest and the two checks re-evaluate.
   ────────────────────────────────────────────────────────────────────────────── */

const XLSXStyle = require('xlsx-js-style');

const INK    = '1E3A57';
const CLAY   = 'B4633A';
const CREAM  = 'FAF6F1';
const OK_BG  = 'E7F1EB';  const OK_FG  = '256B4A';
const BAD_BG = 'FBEBE9';  const BAD_FG = '9B2F2B';
const MUTED  = '6B6660';
const HL_BG  = 'EAF0F6';  const HL_FG  = '1E3A57';

const AMT = '#,##0.00;-#,##0.00';
const PCT = '0.0%';
const INT = '#,##0';

const border = (sides, color = 'E4DDD3') =>
  sides.reduce((o, s) => ({ ...o, [s]: { style: 'thin', color: { rgb: color } } }), {});

const colLetter = (c) => {
  let s = '';
  for (let n = c; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
};

/* A cell carries its own styling intent, so the layout below reads as a
   document rather than as a pile of style objects. */
const C = (v, kind = 'text', extra = {}) => ({ v, kind, ...extra });

function styleCell(cell, kind, col) {
  const right = { alignment: { vertical: 'center', horizontal: col === 0 ? 'left' : 'right' } };
  switch (kind) {
    case 'title':   return { font: { bold: true, sz: 14, color: { rgb: INK } },
                             alignment: { vertical: 'center', horizontal: 'left' } };
    case 'meta':    return { font: { bold: col === 0, sz: 10, color: { rgb: col === 0 ? MUTED : INK } },
                             alignment: { vertical: 'center', horizontal: 'left' } };
    case 'header':  return { ...right, font: { bold: true, sz: 11, color: { rgb: 'FFFFFF' } },
                             fill: { patternType: 'solid', fgColor: { rgb: INK } } };
    case 'section': return { ...right, font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } },
                             fill: { patternType: 'solid', fgColor: { rgb: CLAY } } };
    case 'total':   return { ...right, font: { bold: true },
                             fill: { patternType: 'solid', fgColor: { rgb: CREAM } }, border: border(['top']) };
    case 'hilight': return { ...right, font: { bold: true, sz: 11.5, color: { rgb: HL_FG } },
                             fill: { patternType: 'solid', fgColor: { rgb: HL_BG } },
                             border: border(['top', 'bottom'], '9FB8D0') };
    case 'ok':      return { ...right, font: { bold: true, color: { rgb: OK_FG } },
                             fill: { patternType: 'solid', fgColor: { rgb: OK_BG } },
                             border: border(['top', 'bottom'], OK_FG) };
    case 'bad':     return { ...right, font: { bold: true, color: { rgb: BAD_FG } },
                             fill: { patternType: 'solid', fgColor: { rgb: BAD_BG } },
                             border: border(['top', 'bottom'], BAD_FG) };
    case 'sub':     return { ...right, font: { sz: 10, color: { rgb: MUTED } } };
    case 'note':    return { font: { italic: true, sz: 9, color: { rgb: MUTED } },
                             alignment: { vertical: 'center', horizontal: 'left', wrapText: true } };
    default:        return { ...right, border: border(['bottom']) };
  }
}

/* Turn a grid of C() cells into a styled worksheet. */
function sheetFrom(grid, widths) {
  const ws = {};
  let maxC = 0;
  grid.forEach((row, r) => {
    (row || []).forEach((cell, c) => {
      if (cell === null || cell === undefined) return;
      maxC = Math.max(maxC, c);
      const addr = colLetter(c) + (r + 1);
      const isFormula = typeof cell.v === 'string' && cell.v.startsWith('=');
      const out = isFormula
        ? { t: 'n', f: cell.v.slice(1) }
        : typeof cell.v === 'number'
          ? { t: 'n', v: cell.v }
          : { t: 's', v: cell.v == null ? '' : String(cell.v) };
      out.s = styleCell(cell, cell.kind, c);
      if (cell.fmt) out.z = cell.fmt;
      ws[addr] = out;
    });
  });
  ws['!ref'] = `A1:${colLetter(Math.max(maxC, 1))}${Math.max(grid.length, 1)}`;
  ws['!cols'] = (widths || []).map((w) => ({ wch: w }));
  return ws;
}

const money = (v, kind = 'text') => C(Number(v) || 0, kind, { fmt: AMT });
const count = (v, kind = 'text') => C(Number(v) || 0, kind, { fmt: INT });

/* ── Sheet 1: the summary ──────────────────────────────────────────────────── */

function summarySheet(b, meta) {
  const g = [];
  const push = (...cells) => { g.push(cells); return g.length; };   // returns 1-based row
  const blank = () => g.push([]);

  push(C('Off Duty — Receivables Summary', 'title'));
  push(C('Source', 'meta'), C(meta.sourceLine, 'meta'));
  push(C('Period covered', 'meta'), C(b.periods.join(', ') || '—', 'meta'));
  push(C('GST registrations', 'meta'), C(meta.entities.join(', ') || '—', 'meta'));
  push(C('Orders in ledger', 'meta'), C(b.totals.orders.toLocaleString('en-IN'), 'meta'));
  blank();

  push(C('Particulars', 'header'), C('Orders', 'header'), C('Amount (₹)', 'header'), C('% of Gross', 'header'));

  const grossRow = push(C('Gross Orders — every order in the files', 'hilight'),
                        count(b.totals.orders, 'hilight'), money(b.totals.billed, 'hilight'), C('', 'hilight'));
  const gref = `$C$${grossRow}`;

  const groupRows = [];
  for (const key of b.GROUP_ORDER) {
    const x = b.byGroup[key];
    if (!x.orders) continue;
    const r = push(C(`   ${b.GROUP_LABEL[key]}`), count(x.orders), money(x.billed),
                   C(`=IFERROR(C${g.length + 1}/${gref},0)`, 'text', { fmt: PCT }));
    groupRows.push(r);
  }
  // the % formula above referenced the row before it existed; rewrite correctly
  groupRows.forEach((r) => { g[r - 1][3] = C(`=IFERROR(C${r}/${gref},0)`, 'text', { fmt: PCT }); });

  const first = groupRows[0], last = groupRows[groupRows.length - 1];
  const totRow = push(C('Total of the split', 'total'),
                      C(`=SUM(B${first}:B${last})`, 'total', { fmt: INT }),
                      C(`=SUM(C${first}:C${last})`, 'total', { fmt: AMT }), C('', 'total'));
  const chk1 = push(C('Difference (must be 0)', b.checks.statusSplit === 0 ? 'ok' : 'bad'),
                    C('', b.checks.statusSplit === 0 ? 'ok' : 'bad'),
                    C(`=ROUND(C${totRow}-${gref},2)`, b.checks.statusSplit === 0 ? 'ok' : 'bad', { fmt: AMT }),
                    C('', b.checks.statusSplit === 0 ? 'ok' : 'bad'));
  g[chk1 - 1][0].v = b.checks.statusSplit === 0 ? 'Difference (must be 0)  ✓' : 'Difference (must be 0)  ✗';
  blank();

  push(C('WHAT IS ACTUALLY OWED', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  push(C('Only a delivered order can be owed — an RTO came back, a cancellation never shipped, '
       + 'and a refund was given back on purpose.', 'note'));
  const d = b.byGroup.DELIVERED;
  const dbRow = push(C('Delivered — billed to the customer'), count(d.orders), money(d.billed), C(''));
  const dcRow = push(C('Less: already remitted to you'), C(''), money(-d.collected), C(''));
  const recRow = push(C('RECEIVABLE', 'hilight'), C('', 'hilight'),
                      C(`=ROUND(C${dbRow}+C${dcRow},2)`, 'hilight', { fmt: AMT }),
                      C(`=IFERROR(C${dbRow + 2}/C${dbRow},0)`, 'hilight', { fmt: PCT }));
  blank();

  push(C('HOW THE MONEY ARRIVED', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  const colFirst = g.length + 1;
  for (const c of b.byCollector) {
    push(C(`   ${c.label}`), count(c.orders), money(c.collected),
         C(`=IFERROR(C${g.length + 1}/$C$${g.length + b.byCollector.length + 2 - (g.length + 1 - colFirst)},0)`, 'text'));
  }
  const colLast = g.length;
  // rewrite the ratios now that the total row's position is known
  const colTotRow = colLast + 1;
  for (let r = colFirst; r <= colLast; r++) g[r - 1][3] = C(`=IFERROR(C${r}/$C$${colTotRow},0)`, 'text', { fmt: PCT });
  push(C('Total collected', 'total'), C(''), C(`=SUM(C${colFirst}:C${colLast})`, 'total', { fmt: AMT }), C('', 'total'));
  const statedRow = push(C('Payment file states'), C(''), money(b.totals.collected), C(''));
  const ok2 = b.checks.collectors === 0;
  const chk2 = push(C(`Difference (must be 0)  ${ok2 ? '✓' : '✗'}`, ok2 ? 'ok' : 'bad'),
                    C('', ok2 ? 'ok' : 'bad'),
                    C(`=ROUND(C${colTotRow}-C${statedRow},2)`, ok2 ? 'ok' : 'bad', { fmt: AMT }),
                    C('', ok2 ? 'ok' : 'bad'));
  blank();

  push(C('WHERE THE RECEIVABLE SITS', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  push(C('Collector', 'header'), C('Delivered orders', 'header'), C('Still owed (₹)', 'header'), C('% of receivable', 'header'));
  const recFirst = g.length + 1;
  for (const r of b.receivableSplit) push(C(`   ${r.label}`), count(r.orders), money(r.receivable), C(''));
  const recLast = g.length;
  const recTot = recLast + 1;
  for (let r = recFirst; r <= recLast; r++) g[r - 1][3] = C(`=IFERROR(C${r}/$C$${recTot},0)`, 'text', { fmt: PCT });
  push(C('Total of the split', 'total'), C(`=SUM(B${recFirst}:B${recLast})`, 'total', { fmt: INT }),
       C(`=SUM(C${recFirst}:C${recLast})`, 'total', { fmt: AMT }), C('', 'total'));
  const ok3 = b.checks.receivableSplit === 0;
  push(C(`Difference from the RECEIVABLE above (must be 0)  ${ok3 ? '✓' : '✗'}`, ok3 ? 'ok' : 'bad'),
       C('', ok3 ? 'ok' : 'bad'),
       C(`=ROUND(C${recTot}-C${recRow},2)`, ok3 ? 'ok' : 'bad', { fmt: AMT }),
       C('', ok3 ? 'ok' : 'bad'));
  blank();

  push(C('WORKLISTS — each is a tab in this file', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  push(C('Worklist', 'header'), C('Orders', 'header'), C('Amount (₹)', 'header'), C('What it means', 'header'));
  const WL = [
    ['No collector', b.exceptions.noCollector, 'Delivered, no gateway, no UTR — nothing says who should have paid'],
    ['Red flag', b.exceptions.redFlag, 'Already marked by the accountant in the payment file'],
    ['Short paid', b.exceptions.shortPaid, 'A collector is named and money came, but less than was billed'],
    ['Status conflict', b.exceptions.statusConflict, 'Sales file says delivered, payment file says otherwise'],
    ['Delivered, taxed nowhere', b.exceptions.taxedNowhere, 'Money collected, but the order is in no state workbook'],
  ];
  for (const [label, rows, why] of WL)
    push(C(`   ${label}`), count(rows.length),
         money(Number(rows.reduce((a, x) => a + Math.abs(x.gap), 0).toFixed(2))), C(why, 'sub'));
  blank();
  push(C(`Ageing is not shown because "Date of Deposit in bank" is empty on every row of the payment file `
       + `(${b.exceptions.noDeposit.length.toLocaleString('en-IN')} collected orders carry no deposit date). `
       + `Fill that column, or supply the bank statement, and the ageing buckets appear here.`, 'note'));

  const ws = sheetFrom(g, [46, 14, 18, 34]);
  ws['!rows'] = g.map((row) => {
    const k = row && row[0] ? row[0].kind : null;
    if (k === 'title') return { hpt: 26 };
    if (k === 'section' || k === 'header') return { hpt: 20 };
    if (k === 'note') return { hpt: 30 };
    return { hpt: 16 };
  });
  return ws;
}

/* ── Sheet: a plain table with a header band and a total row ───────────────── */

function tableSheet(columns, rows, widths, opts = {}) {
  const g = [];
  if (opts.title) { g.push([C(opts.title, 'title')]); g.push([]); }
  if (opts.note) { g.push([C(opts.note, 'note')]); g.push([]); }
  const headRow = g.length + 1;
  g.push(columns.map((c) => C(c.label, 'header')));
  for (const r of rows) {
    g.push(columns.map((c) => {
      const v = r[c.key];
      if (c.money) return money(v);
      if (c.int) return count(v);
      return C(v == null ? '' : String(v));
    }));
  }
  if (rows.length && opts.total !== false) {
    const first = headRow + 1, last = g.length;
    g.push(columns.map((c, i) => {
      if (i === 0) return C('Total', 'total');
      if (c.money || c.int) return C(`=SUM(${colLetter(i)}${first}:${colLetter(i)}${last})`, 'total',
                                     { fmt: c.money ? AMT : INT });
      return C('', 'total');
    }));
  }
  const ws = sheetFrom(g, widths);
  ws['!freeze'] = true;
  return ws;
}

/* ── the workbook ──────────────────────────────────────────────────────────── */

const LEDGER_COLS = [
  { key: 'order_id', label: 'Order ID' },
  { key: 'entity', label: 'GSTIN' },
  { key: 'order_date', label: 'Order date' },
  { key: 'status', label: 'Status' },
  { key: 'group', label: 'Money group' },
  { key: 'collector', label: 'Collector' },
  { key: 'shipping_state', label: 'Ship state' },
  { key: 'billed', label: 'Billed', money: true },
  { key: 'earned_taxable', label: 'Taxable', money: true },
  { key: 'earned_tax', label: 'Tax', money: true },
  { key: 'refunded', label: 'Refunded', money: true },
  { key: 'rto_value', label: 'RTO value', money: true },
  { key: 'collected', label: 'Collected', money: true },
  { key: 'receivable', label: 'Receivable', money: true },
  { key: 'utr_id', label: 'UTR' },
  { key: 'payment_date', label: 'Paid on' },
  { key: 'remarks', label: 'Remarks' },
];

const WORKLIST_COLS = [
  { key: 'order_id', label: 'Order ID' },
  { key: 'entity', label: 'GSTIN' },
  { key: 'order_date', label: 'Order date' },
  { key: 'status', label: 'Status' },
  { key: 'collector', label: 'Collector' },
  { key: 'shipping_state', label: 'Ship state' },
  { key: 'billed', label: 'Billed', money: true },
  { key: 'collected', label: 'Collected', money: true },
  { key: 'gap', label: 'Gap', money: true },
  { key: 'utr_id', label: 'UTR' },
  { key: 'remarks', label: 'Remarks' },
];
const WL_W = [12, 8, 12, 16, 18, 13, 13, 13, 13, 22, 20];

function buildWorkbook(b, meta) {
  const wb = XLSXStyle.utils.book_new();
  const add = (name, ws) => XLSXStyle.utils.book_append_sheet(wb, ws, name.slice(0, 31));

  add('Summary', summarySheet(b, meta));

  add('By Collector', tableSheet([
    { key: 'label', label: 'Collector' },
    { key: 'orders', label: 'Orders with money', int: true },
    { key: 'collected', label: 'Collected (₹)', money: true },
    { key: 'delivered_orders', label: 'Delivered orders', int: true },
    { key: 'delivered_billed', label: 'Billed (₹)', money: true },
    { key: 'delivered_collected', label: 'Received (₹)', money: true },
    { key: 'receivable', label: 'Still owed (₹)', money: true },
  ], b.byCollector, [24, 18, 18, 18, 18, 18, 18], {
    title: 'Who collects, and who still owes',
    note: 'The first column is every order that carried money through that collector. The rest is the '
        + 'delivered-only view, which is the only part that can produce a receivable.',
  }));

  add('By GSTIN', tableSheet([
    { key: 'entity', label: 'GST registration' },
    { key: 'orders', label: 'Orders', int: true },
    { key: 'earned_taxable', label: 'Taxable value (₹)', money: true },
    { key: 'earned_tax', label: 'Tax (₹)', money: true },
    { key: 'refunded', label: 'Refunded (₹)', money: true },
    { key: 'rto_value', label: 'RTO (₹)', money: true },
    { key: 'billed', label: 'Delivered billed (₹)', money: true },
    { key: 'collected', label: 'Collected (₹)', money: true },
    { key: 'receivable', label: 'Receivable (₹)', money: true },
  ], b.byEntity, [20, 12, 18, 16, 16, 16, 20, 18, 18], {
    title: 'By GST registration',
    note: 'A row like "HR+KAR" is one order whose lines shipped from two warehouses. It is listed once, '
        + 'under both, so nothing is double counted — '
        + `${b.totals.splitShipments.toLocaleString('en-IN')} orders behave this way.`,
  }));

  const WL = [
    ['No Collector', b.exceptions.noCollector,
      'Delivered, nothing received, and no gateway or UTR anywhere on the row. Nothing in the file says who '
      + 'should have paid. This is the list to work first.'],
    ['Red Flag', b.exceptions.redFlag,
      'Rows the accountant already marked RED FLAG in the payment file. A subset of No Collector.'],
    ['Short Paid', b.exceptions.shortPaid,
      'A collector is named and money arrived, but less than was billed. Chaseable against that collector.'],
    ['Status Conflict', b.exceptions.statusConflict,
      'The state workbook taxed this order as delivered; the payment file gives it another status. '
      + 'One of the two is wrong, and the GST position depends on which.'],
    ['Taxed Nowhere', b.exceptions.taxedNowhere,
      'The payment file shows these delivered and paid, but they appear in no state workbook — so they may '
      + 'have been collected without being reported in GSTR-1.'],
    ['No Deposit Date', b.exceptions.noDeposit,
      'Money was collected but "Date of Deposit in bank" is blank, so these cannot be aged. '
      + 'This is why the Summary shows no ageing buckets.'],
  ];
  for (const [name, rows, note] of WL)
    add(name, tableSheet(WORKLIST_COLS, rows.slice(0, 20000), WL_W, { title: name, note }));

  add('Ledger', tableSheet(LEDGER_COLS, b.ledger,
    [12, 10, 12, 18, 14, 18, 12, 13, 13, 12, 13, 13, 13, 13, 22, 12, 18], {
      title: 'Per-order ledger — every order, every source',
      note: 'One row per order id. An order sold in one month and returned in the next appears once here, '
          + 'carrying both dates, which is why no month has to be netted against another.',
    }));

  /* Basis & Checks — where each figure came from, in the accountant's terms. */
  const basis = [];
  const B = (...c) => basis.push(c);
  B(C('Basis & Checks', 'title'));
  basis.push([]);
  B(C('File', 'header'), C('Tab', 'header'), C('Header row', 'header'), C('Rows read', 'header'), C('Read as', 'header'));
  for (const f of meta.files) for (const t of f.tabs)
    B(C(f.filename), C(t.tab), count(t.headerRow), count(t.rows), C(t.kind));
  basis.push([]);
  B(C('Tabs deliberately not read', 'section'), C('', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  B(C('These belong to other sales channels and carry no Shopify order id, so they could never join to the '
    + 'payment file. They are left out on purpose, not missed.', 'note'));
  for (const f of meta.files) for (const s of (f.skipped || []))
    B(C(f.filename), C(s.tab), C(''), C(''), C(s.why));
  basis.push([]);
  B(C('Checks', 'section'), C('', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  B(C('Check', 'header'), C('Result', 'header'), C('Must be', 'header'), C('', 'header'), C('', 'header'));
  const ck = (label, val) => B(C(label, val === 0 ? 'ok' : 'bad'),
                               C(val, val === 0 ? 'ok' : 'bad', { fmt: AMT }),
                               C(0, val === 0 ? 'ok' : 'bad', { fmt: AMT }),
                               C('', val === 0 ? 'ok' : 'bad'), C('', val === 0 ? 'ok' : 'bad'));
  ck('The five collector columns rebuild the remittance the file states', b.checks.collectors);
  ck('The status split rebuilds the gross the file states', b.checks.statusSplit);
  ck('The collector split rebuilds the receivable', b.checks.receivableSplit);
  basis.push([]);
  B(C('Stated, not forced', 'section'), C('', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  B(C('The sales workbooks and the payment file disagree about some orders. That difference is REPORTED on '
    + 'the Status Conflict and Taxed Nowhere tabs with the order ids, and is never netted away to make a '
    + 'total look clean.', 'note'));
  const bws = sheetFrom(basis, [48, 24, 13, 13, 44]);
  bws['!rows'] = basis.map((r) => ({ hpt: r && r[0] && r[0].kind === 'note' ? 34 : 16 }));
  add('Basis & Checks', bws);

  return wb;
}

module.exports = { buildWorkbook };

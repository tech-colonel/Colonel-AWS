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
      /* A styled cell costs an `s` attribute on every one of them, and the
         Ledger alone is 37k rows x 17 columns. Body cells of the big tables are
         written as 'plain' — number format kept, styling dropped — which takes
         the workbook from 39 MB to something that opens without a wait. */
      if (cell.kind !== 'plain') out.s = styleCell(cell, cell.kind, c);
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
  const push = (...cells) => { g.push(cells); return g.length; };
  const blank = () => g.push([]);
  const pretty = (d) => {
    if (!d) return '—';
    const [y, m, dd] = d.split('-');
    return `${dd} ${['', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
                     'August', 'September', 'October', 'November', 'December'][Number(m)]} ${y}`;
  };
  const P = b.byPosition;

  push(C('Off Duty — Receivables Summary', 'title'));
  push(C('Position as at', 'meta'), C(pretty(b.asAt), 'meta'));
  push(C('Source', 'meta'), C(meta.sourceLine, 'meta'));
  push(C('Period covered', 'meta'), C(b.periods.join(', ') || '—', 'meta'));
  push(C('GST registrations', 'meta'), C(meta.entities.join(', ') || '—', 'meta'));
  push(C('Orders in ledger', 'meta'), C(b.totals.orders.toLocaleString('en-IN'), 'meta'));
  blank();

  /* ── the position ──────────────────────────────────────────────────────
     A receivable is a position at a date. Leading with anything else — such
     as "delivered and still short" — answers a different question. */
  push(C(`THE POSITION AT ${pretty(b.asAt).toUpperCase()}`, 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  push(C('Particulars', 'header'), C('Orders', 'header'), C('Amount (₹)', 'header'), C('Why it sits here', 'header'));

  const line = (label, pos, why, kind) => push(
    C(label, kind), count(P[pos].orders, kind), money(P[pos].amount, kind), C(why, 'sub'));

  const lateRow = line('Delivered by the cut-off, money arrived after it', 'RECEIVABLE_LATE',
    'The goods were with the customer on that date and the cash was not. Owed.');
  const unpaidRow = line('Delivered by the cut-off, no money at all', 'RECEIVABLE_UNPAID',
    'Delivered and nothing has ever been received against it.');
  const recRow = push(C('TRADE RECEIVABLE', 'hilight'),
    C(`=B${lateRow}+B${unpaidRow}`, 'hilight', { fmt: INT }),
    C(`=ROUND(C${lateRow}+C${unpaidRow},2)`, 'hilight', { fmt: AMT }),
    C('What was owed to you on that date.', 'sub'));
  blank();

  const uncRow = line('Uncertain — paid, but the file gives no payment date', 'RECEIVABLE_UNDATED',
    'Could have landed on either side of the cut-off. The file does not say.');
  const undRow = P.UNDATED_DELIVERY.orders
    ? line('Uncertain — marked delivered, no delivery date', 'UNDATED_DELIVERY',
        'Cannot be placed against the cut-off at all.')
    : null;
  const upperRow = push(C('Upper bound if every uncertain order fell after the cut-off', 'total'),
    C('', 'total'),
    C(`=ROUND(C${recRow}+C${uncRow}${undRow ? `+C${undRow}` : ''},2)`, 'total', { fmt: AMT }),
    C('The receivable above is a floor, not a ceiling.', 'sub'));
  blank();

  const transitRow = line('Dispatched, not delivered by the cut-off', 'IN_TRANSIT',
    'Goods had left but had not arrived — not a trade receivable on a delivery basis.');
  const owedRow = push(C('TOTAL OWED TO THE BUSINESS', 'hilight'), C('', 'hilight'),
    C(`=ROUND(C${recRow}+C${transitRow},2)`, 'hilight', { fmt: AMT }),
    C('Include the transit line only if revenue is recognised on dispatch.', 'sub'));
  blank();

  push(C('For completeness — the rest of the book', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  const paidRow = line('Delivered and settled within the period', 'PAID_IN_PERIOD',
    'Money in, on or before the cut-off. Nothing to chase.');
  const notDueRow = line('Nothing owed — returned, cancelled, RTO or lost', 'NOT_DUE',
    'An RTO came back, a cancellation never shipped, a refund was given back on purpose.');
  const allRows = [lateRow, unpaidRow, uncRow, undRow, transitRow, paidRow, notDueRow].filter(Boolean);
  const totRow = push(C('Every order, once', 'total'),
    C(`=${allRows.map((r) => `B${r}`).join('+')}`, 'total', { fmt: INT }), C('', 'total'),
    C('Each order sits in exactly one line above.', 'sub'));
  const okPos = b.checks.positionSplit === 0;
  push(C(`Difference from the ledger count (must be 0)  ${okPos ? '✓' : '✗'}`, okPos ? 'ok' : 'bad'),
    C(`=B${totRow}-${b.totals.orders}`, okPos ? 'ok' : 'bad', { fmt: INT }),
    C('', okPos ? 'ok' : 'bad'), C('', okPos ? 'ok' : 'bad'));
  blank();

  /* ── who owes it ───────────────────────────────────────────────────── */
  push(C('WHO OWES THE RECEIVABLE', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  push(C('Collector', 'header'), C('Orders', 'header'), C('Owed (₹)', 'header'), C('% of receivable', 'header'));
  const rFirst = g.length + 1;
  for (const r of b.receivableSplit) push(C(`   ${r.label}`), count(r.orders), money(r.receivable), C(''));
  const rLast = g.length;
  const rTot = rLast + 1;
  for (let r = rFirst; r <= rLast; r++) g[r - 1][3] = C(`=IFERROR(C${r}/$C$${rTot},0)`, 'text', { fmt: PCT });
  push(C('Total of the split', 'total'), C(`=SUM(B${rFirst}:B${rLast})`, 'total', { fmt: INT }),
    C(`=SUM(C${rFirst}:C${rLast})`, 'total', { fmt: AMT }), C('', 'total'));
  const okSplit = b.checks.receivableSplit === 0;
  push(C(`Difference from the TRADE RECEIVABLE above (must be 0)  ${okSplit ? '✓' : '✗'}`, okSplit ? 'ok' : 'bad'),
    C('', okSplit ? 'ok' : 'bad'), C(`=ROUND(C${rTot}-C${recRow},2)`, okSplit ? 'ok' : 'bad', { fmt: AMT }),
    C('', okSplit ? 'ok' : 'bad'));
  blank();

  /* ── how the money arrived ─────────────────────────────────────────── */
  push(C('HOW THE MONEY ARRIVED, ACROSS EVERYTHING LOADED', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  const cFirst = g.length + 1;
  for (const c of b.byCollector) push(C(`   ${c.label}`), count(c.orders), money(c.collected), C(''));
  const cLast = g.length;
  const cTot = cLast + 1;
  for (let r = cFirst; r <= cLast; r++) g[r - 1][3] = C(`=IFERROR(C${r}/$C$${cTot},0)`, 'text', { fmt: PCT });
  push(C('Total collected', 'total'), C(''), C(`=SUM(C${cFirst}:C${cLast})`, 'total', { fmt: AMT }), C('', 'total'));
  const statedRow = push(C('Payment file states'), C(''), money(b.totals.collected), C(''));
  const ok2 = b.checks.collectors === 0;
  push(C(`Difference (must be 0)  ${ok2 ? '✓' : '✗'}`, ok2 ? 'ok' : 'bad'), C('', ok2 ? 'ok' : 'bad'),
    C(`=ROUND(C${cTot}-C${statedRow},2)`, ok2 ? 'ok' : 'bad', { fmt: AMT }), C('', ok2 ? 'ok' : 'bad'));
  blank();

  /* ── everything this data cannot tell you ──────────────────────────── */
  push(C('KNOWN LIMITS OF THIS DATA', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  push(C('Every one of these is a tab in this file, with the order ids. None of them has been netted '
       + 'away to make a total look clean.', 'note'));
  push(C('Limit', 'header'), C('Orders', 'header'), C('Amount (₹)', 'header'), C('What it means', 'header'));
  for (const l of b.limits) push(C(`   ${l.label}`), count(l.orders), money(l.amount), C(l.why, 'sub'));
  blank();

  /* ── the chase list, named as what it is ───────────────────────────── */
  push(C('SEPARATELY — THE COLLECTION WORKLIST', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  push(C('Still short today', 'total'), count(b.exceptions.noCollector.length + b.exceptions.shortPaid.length, 'total'),
    money(b.totals.stillShortToday, 'total'),
    C('What is STILL unpaid now, after all the chasing already done. This is a collection list, not a '
    + 'month-end figure — reporting it as the receivable understates the position, because by the time '
    + 'this file was made almost everything had come in, just not all of it before the cut-off.', 'sub'));
  const WL = [
    ['No collector', b.exceptions.noCollector, 'Delivered, no gateway, no UTR — nothing says who should have paid'],
    ['Red flag', b.exceptions.redFlag, 'Already marked by the accountant in the payment file'],
    ['Short paid', b.exceptions.shortPaid, 'A collector is named and money came, but less than was billed'],
  ];
  for (const [label, rows, why] of WL)
    push(C(`   ${label}`), count(rows.length),
      money(Number(rows.reduce((a, x) => a + Math.abs(x.gap), 0).toFixed(2))), C(why, 'sub'));

  const ws = sheetFrom(g, [52, 12, 18, 62]);
  ws['!rows'] = g.map((row) => {
    const k = row && row[0] ? row[0].kind : null;
    if (k === 'title') return { hpt: 26 };
    if (k === 'section' || k === 'header') return { hpt: 20 };
    if (k === 'note') return { hpt: 28 };
    if (row && row[3] && row[3].kind === 'sub' && String(row[3].v || '').length > 90) return { hpt: 30 };
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
  const kind = rows.length > 500 ? 'plain' : 'text';
  for (const r of rows) {
    g.push(columns.map((c) => {
      const v = r[c.key];
      if (c.money) return C(Number(v) || 0, kind, { fmt: AMT });
      if (c.int) return C(Number(v) || 0, kind, { fmt: INT });
      return C(v == null ? '' : String(v), kind);
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
  { key: 'delivered_date', label: 'Delivered on' },
  { key: 'payment_date', label: 'Paid on' },
  { key: 'remarks', label: 'File remark' },
  /* The Ledger carries the POSITION but not the sentence explaining it: the
     sentence names dates, so it is near-unique per row, and 37k copies of it
     made this one tab 33 MB of a 42 MB file. The sentence is on every worklist
     tab, which is where anyone actually reads it. */
  { key: 'position', label: 'Position' },
];

const WORKLIST_COLS = [
  { key: 'order_id', label: 'Order ID' },
  { key: 'entity', label: 'GSTIN' },
  { key: 'order_date', label: 'Order date' },
  { key: 'status', label: 'Status' },
  { key: 'collector', label: 'Collector' },
  { key: 'shipping_state', label: 'Ship state' },
  { key: 'delivered_date', label: 'Delivered on' },
  { key: 'payment_date', label: 'Paid on' },
  { key: 'billed', label: 'Billed', money: true },
  { key: 'collected', label: 'Collected', money: true },
  { key: 'owed', label: 'Owed at cut-off', money: true },
  { key: 'utr_id', label: 'UTR' },
  { key: 'remarks', label: 'File remark' },
  /* Every row says in plain words why it is on this tab. Nothing in this file
     should have to be taken on trust. */
  { key: 'remark', label: 'Why it sits here' },
];
const WL_W = [12, 8, 12, 16, 18, 13, 13, 13, 13, 13, 15, 20, 18, 74];

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

  const pos = (k) => b.ledger.filter((l) => l.position === k);
  const WL = [
    ['Receivable', [...pos('RECEIVABLE_LATE'), ...pos('RECEIVABLE_UNPAID')],
      'The orders that make up the trade receivable at the cut-off. Each row says which of the two '
      + 'reasons put it here — money that arrived after the cut-off, or money that never arrived.'],
    ['Uncertain', [...pos('RECEIVABLE_UNDATED'), ...pos('UNDATED_DELIVERY')],
      'Delivered before the cut-off, but the file records no payment date (or no delivery date), so '
      + 'these cannot be placed on either side of it. They are the gap between the receivable and its '
      + 'upper bound — counted as neither collected nor owed.'],
    ['In Transit', pos('IN_TRANSIT'),
      'Dispatched on or before the cut-off, delivered after it. Not a trade receivable on a delivery '
      + 'basis, but money the business is owed. Include them only if revenue is recognised on dispatch.'],
    ['No Collector', b.exceptions.noCollector,
      'Delivered, nothing received, and no gateway or UTR anywhere on the row. Nothing in the file says '
      + 'who should have paid. This is the list to work first.'],
    ['Red Flag', b.exceptions.redFlag,
      'Rows the accountant already marked RED FLAG in the payment file. A subset of No Collector.'],
    ['Short Paid', b.exceptions.shortPaid,
      'A collector is named and money arrived, but less than was billed. Chaseable against that collector.'],
    ['Status Conflict', b.exceptions.statusConflict,
      'The state workbook taxed this order as delivered; the payment file gives it another status. '
      + 'One of the two is wrong, and the GST position depends on which.'],
    ['Taxed Nowhere', b.exceptions.taxedNowhere,
      'The payment file shows these delivered and paid, but they appear in no state workbook — so they '
      + 'may have been collected without being reported in GSTR-1.'],
    ['No Deposit Date', b.exceptions.noDeposit,
      'Money was collected but "Date of Deposit in bank" is blank, so these cannot be aged against the '
      + 'bank statement. This is why the Summary shows no ageing buckets.'],
    ['Split Shipment', b.ledger.filter((l) => l.split_shipment),
      'One order whose lines shipped from two GST registrations. Counted once at order level; summing '
      + 'the By GSTIN sheet instead would double count these.'],
  ];
  for (const [name, rows, note] of WL) {
    if (!rows.length) continue;
    /* "No deposit date" is a statement about the payment file, not a list anyone
       works — it is nearly every collected order. The count belongs on the
       Summary; only a sample belongs here. */
    const cap = name === 'No Deposit Date' ? 200 : 20000;
    const shown = rows.slice(0, cap);
    const extra = rows.length > cap
      ? `${note}  —  ${rows.length.toLocaleString('en-IN')} orders in total; the first `
        + `${cap.toLocaleString('en-IN')} are shown here, and all of them are on the Ledger tab.`
      : note;
    add(name, tableSheet(WORKLIST_COLS, shown, WL_W, { title: name, note: extra, total: shown.length <= 500 }));
  }

  add('Ledger', tableSheet(LEDGER_COLS, b.ledger,
    [12, 10, 12, 18, 14, 18, 12, 13, 13, 12, 13, 13, 13, 13, 20, 15, 15, 18, 22], {
      title: 'Per-order ledger — every order, every source',
      note: 'One row per order id. An order sold in one month and returned in the next appears once here, '
          + 'carrying both dates, which is why no month has to be netted against another. The Position '
          + 'column says where each order fell at the cut-off; the tab named after that position spells '
          + 'out why, order by order.',
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
  ck('The collector split rebuilds the trade receivable', b.checks.receivableSplit);
  ck('Every order sits in exactly one position', b.checks.positionSplit);
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

/* Write options. bookSST puts repeated text in the shared-string table instead
   of inline in every cell — on a ledger of 37k rows where the same statuses,
   collectors and states repeat thousands of times, that is most of the file. */
const WRITE_OPTS = { bookType: 'xlsx', bookSST: true, compression: true };

module.exports = { buildWorkbook, WRITE_OPTS };

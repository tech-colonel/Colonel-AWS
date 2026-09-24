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

  push(C('Off Duty — Statement of Trade Receivables', 'title'));
  push(C('As on', 'meta'), C(pretty(b.asAt), 'meta'));
  push(C('Records examined', 'meta'), C(meta.sourceLine, 'meta'));
  push(C('Period', 'meta'), C(b.periods.join(', ') || '—', 'meta'));
  push(C('GST registrations', 'meta'), C(meta.entities.join(', ') || '—', 'meta'));
  push(C('Number of orders', 'meta'), C(b.totals.orders.toLocaleString('en-IN'), 'meta'));
  blank();

  /* ── the position ──────────────────────────────────────────────────────
     A receivable is a position at a date. Leading with anything else — such
     as "delivered and still short" — answers a different question. */
  push(C(`STATEMENT OF TRADE RECEIVABLES AS ON ${pretty(b.asAt).toUpperCase()}`, 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  push(C('Particulars', 'header'), C('No. of orders', 'header'), C('Amount (₹)', 'header'), C('Basis', 'header'));

  const line = (label, pos, why, kind) => push(
    C(label, kind), count(P[pos].orders, kind), money(P[pos].amount, kind), C(why, 'sub'));

  const lateRow = line('Delivered on or before the reporting date, realised subsequently', 'RECEIVABLE_LATE',
    'Goods delivered within the period; realisation received after the reporting date. Recoverable as on that date.');
  const unpaidRow = line('Delivered on or before the reporting date, not realised', 'RECEIVABLE_UNPAID',
    'Goods delivered within the period; no realisation received till date. Outstanding.');
  const recRow = push(C('TRADE RECEIVABLES (SUNDRY DEBTORS)', 'hilight'),
    C(`=B${lateRow}+B${unpaidRow}`, 'hilight', { fmt: INT }),
    C(`=ROUND(C${lateRow}+C${unpaidRow},2)`, 'hilight', { fmt: AMT }),
    C('Amount recoverable from customers as on the reporting date.', 'sub'));
  blank();

  const uncRow = line('Realised, but date of receipt not recorded', 'RECEIVABLE_UNDATED',
    'Period of realisation could not be ascertained from the records produced.');
  const undRow = P.UNDATED_DELIVERY.orders
    ? line('Delivered, but date of delivery not recorded', 'UNDATED_DELIVERY',
        'Could not be classified against the reporting date.')
    : null;
  const upperRow = push(C('Maximum trade receivables, if the above are treated as unrealised', 'total'),
    C('', 'total'),
    C(`=ROUND(C${recRow}+C${uncRow}${undRow ? `+C${undRow}` : ''},2)`, 'total', { fmt: AMT }),
    C('Trade receivables above are stated at the minimum; this is the maximum exposure.', 'sub'));
  blank();

  const transitRow = line('Goods in transit — dispatched within the period, delivered thereafter', 'IN_TRANSIT',
    'Not a trade receivable where revenue is recognised on delivery.');
  const owedRow = push(C('TOTAL AMOUNT RECOVERABLE', 'hilight'), C('', 'hilight'),
    C(`=ROUND(C${recRow}+C${transitRow},2)`, 'hilight', { fmt: AMT }),
    C('Trade receivables plus goods in transit. Include goods in transit only where revenue is '
    + 'recognised on dispatch.', 'sub'));
  blank();

  push(C('BALANCE OF ORDERS — NOT FORMING PART OF TRADE RECEIVABLES', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  const paidRow = line('Delivered and realised within the period', 'PAID_IN_PERIOD',
    'Realisation received on or before the reporting date. No amount recoverable.');
  const notDueRow = line('Not recoverable — sales returns, cancellations, RTO and goods lost', 'NOT_DUE',
    'Goods returned, orders cancelled before dispatch, returned to origin, or lost in transit.');
  const allRows = [lateRow, unpaidRow, uncRow, undRow, transitRow, paidRow, notDueRow].filter(Boolean);
  const totRow = push(C('Total orders accounted for', 'total'),
    C(`=${allRows.map((r) => `B${r}`).join('+')}`, 'total', { fmt: INT }), C('', 'total'),
    C('Each order appears in one line above only.', 'sub'));
  const okPos = b.checks.positionSplit === 0;
  push(C(`Difference with the order ledger (to be Nil)  ${okPos ? '✓' : '✗'}`, okPos ? 'ok' : 'bad'),
    C(`=B${totRow}-${b.totals.orders}`, okPos ? 'ok' : 'bad', { fmt: INT }),
    C('', okPos ? 'ok' : 'bad'), C('', okPos ? 'ok' : 'bad'));
  blank();

  /* ── who owes it ───────────────────────────────────────────────────── */
  push(C('TRADE RECEIVABLES — COLLECTION CHANNEL WISE', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  push(C('Collection channel', 'header'), C('No. of orders', 'header'), C('Amount recoverable (₹)', 'header'), C('% of total', 'header'));
  const rFirst = g.length + 1;
  for (const r of b.receivableSplit) push(C(`   ${r.label}`), count(r.orders), money(r.receivable), C(''));
  const rLast = g.length;
  const rTot = rLast + 1;
  for (let r = rFirst; r <= rLast; r++) g[r - 1][3] = C(`=IFERROR(C${r}/$C$${rTot},0)`, 'text', { fmt: PCT });
  push(C('Total', 'total'), C(`=SUM(B${rFirst}:B${rLast})`, 'total', { fmt: INT }),
    C(`=SUM(C${rFirst}:C${rLast})`, 'total', { fmt: AMT }), C('', 'total'));
  const okSplit = b.checks.receivableSplit === 0;
  push(C(`Difference with trade receivables above (to be Nil)  ${okSplit ? '✓' : '✗'}`, okSplit ? 'ok' : 'bad'),
    C('', okSplit ? 'ok' : 'bad'), C(`=ROUND(C${rTot}-C${recRow},2)`, okSplit ? 'ok' : 'bad', { fmt: AMT }),
    C('', okSplit ? 'ok' : 'bad'));
  blank();

  /* ── how the money arrived ─────────────────────────────────────────── */
  push(C('COLLECTIONS ROUTED THROUGH EACH CHANNEL — ALL PERIODS PRODUCED', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  const cFirst = g.length + 1;
  for (const c of b.byCollector) push(C(`   ${c.label}`), count(c.orders), money(c.collected), C(''));
  const cLast = g.length;
  const cTot = cLast + 1;
  for (let r = cFirst; r <= cLast; r++) g[r - 1][3] = C(`=IFERROR(C${r}/$C$${cTot},0)`, 'text', { fmt: PCT });
  push(C('Total collections', 'total'), C(''), C(`=SUM(C${cFirst}:C${cLast})`, 'total', { fmt: AMT }), C('', 'total'));
  const statedRow = push(C('As per the payment reconciliation'), C(''), money(b.totals.collected), C(''));
  const ok2 = b.checks.collectors === 0;
  push(C(`Difference (to be Nil)  ${ok2 ? '✓' : '✗'}`, ok2 ? 'ok' : 'bad'), C('', ok2 ? 'ok' : 'bad'),
    C(`=ROUND(C${cTot}-C${statedRow},2)`, ok2 ? 'ok' : 'bad', { fmt: AMT }), C('', ok2 ? 'ok' : 'bad'));
  blank();

  /* ── everything this data cannot tell you ──────────────────────────── */
  push(C('NOTES AND QUALIFICATIONS', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  push(C('Each of the matters below is annexed as a separate schedule in this workbook, giving the '
       + 'order numbers. No amount has been adjusted, netted off or excluded.', 'note'));
  push(C('Particulars', 'header'), C('No. of orders', 'header'), C('Amount (₹)', 'header'), C('Remarks', 'header'));
  for (const l of b.limits) push(C(`   ${l.label}`), count(l.orders), money(l.amount), C(l.why, 'sub'));
  blank();

  /* ── the chase list, named as what it is ───────────────────────────── */
  push(C('AMOUNTS OUTSTANDING AS ON DATE — FOR RECOVERY', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  push(C('Unrealised as on date', 'total'), count(b.exceptions.noCollector.length + b.exceptions.shortPaid.length, 'total'),
    money(b.totals.stillShortToday, 'total'),
    C('Amounts remaining unrealised on the date of this statement, after the recovery already effected. '
    + 'This is a recovery schedule and NOT the figure of trade receivables as on the reporting date — '
    + 'stating it as trade receivables would understate the position, since most collections had been '
    + 'received by the date of preparation, though not by the reporting date.', 'sub'));
  const WL = [
    ['Collection channel not identified', b.exceptions.noCollector,
      'Delivered, unrealised, and no gateway or UTR on record'],
    ['Flagged in the payment reconciliation', b.exceptions.redFlag,
      'Marked RED FLAG by the accountant in the payment reconciliation'],
    ['Part realisation received', b.exceptions.shortPaid,
      'Realisation received through a named channel, but short of the invoice value'],
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
  { key: 'entity', label: 'GST registration' },
  { key: 'order_date', label: 'Order date' },
  { key: 'status', label: 'Order status' },
  { key: 'group', label: 'Nature' },
  { key: 'collector', label: 'Collection channel' },
  { key: 'shipping_state', label: 'Place of supply' },
  { key: 'billed', label: 'Invoice value', money: true },
  { key: 'earned_taxable', label: 'Taxable value', money: true },
  { key: 'earned_tax', label: 'Tax', money: true },
  { key: 'refunded', label: 'Sales return', money: true },
  { key: 'rto_value', label: 'RTO', money: true },
  { key: 'collected', label: 'Amount realised', money: true },
  { key: 'receivable', label: 'Receivable', money: true },
  { key: 'utr_id', label: 'UTR' },
  { key: 'delivered_date', label: 'Date of delivery' },
  { key: 'payment_date', label: 'Date of realisation' },
  { key: 'remarks', label: 'Remark per payment reco' },
  /* The Ledger carries the POSITION but not the sentence explaining it: the
     sentence names dates, so it is near-unique per row, and 37k copies of it
     made this one tab 33 MB of a 42 MB file. The sentence is on every worklist
     tab, which is where anyone actually reads it. */
  { key: 'position', label: 'Classification' },
];

const WORKLIST_COLS = [
  { key: 'order_id', label: 'Order ID' },
  { key: 'entity', label: 'GST registration' },
  { key: 'order_date', label: 'Order date' },
  { key: 'status', label: 'Order status' },
  { key: 'collector', label: 'Collection channel' },
  { key: 'shipping_state', label: 'Place of supply' },
  { key: 'delivered_date', label: 'Date of delivery' },
  { key: 'payment_date', label: 'Date of realisation' },
  { key: 'billed', label: 'Invoice value', money: true },
  { key: 'collected', label: 'Amount realised', money: true },
  { key: 'owed', label: 'Amount recoverable', money: true },
  { key: 'utr_id', label: 'UTR' },
  { key: 'remarks', label: 'Remark per payment reco' },
  /* Every row says in plain words why it is on this tab. Nothing in this file
     should have to be taken on trust. */
  { key: 'remark', label: 'Basis' },
];
const WL_W = [12, 8, 12, 16, 18, 13, 13, 13, 13, 13, 15, 20, 18, 74];

function buildWorkbook(b, meta) {
  const wb = XLSXStyle.utils.book_new();
  const add = (name, ws) => XLSXStyle.utils.book_append_sheet(wb, ws, name.slice(0, 31));

  add('Summary', summarySheet(b, meta));

  add('Collection Channels', tableSheet([
    { key: 'label', label: 'Collection channel' },
    { key: 'orders', label: 'Orders routed', int: true },
    { key: 'collected', label: 'Collections (₹)', money: true },
    { key: 'delivered_orders', label: 'Delivered orders', int: true },
    { key: 'delivered_billed', label: 'Invoice value (₹)', money: true },
    { key: 'delivered_collected', label: 'Realised (₹)', money: true },
    { key: 'receivable', label: 'Recoverable (₹)', money: true },
  ], b.byCollector, [24, 18, 18, 18, 18, 18, 18], {
    title: 'Collections and amounts recoverable — collection channel wise',
    note: 'Collections cover every order routed through that channel across the periods produced. The '
        + 'remaining columns are restricted to delivered orders, being the only orders against which an '
        + 'amount can be recoverable.',
  }));

  add('Registration Wise', tableSheet([
    { key: 'entity', label: 'GST registration' },
    { key: 'orders', label: 'No. of orders', int: true },
    { key: 'earned_taxable', label: 'Taxable value (₹)', money: true },
    { key: 'earned_tax', label: 'Tax (₹)', money: true },
    { key: 'refunded', label: 'Sales returns (₹)', money: true },
    { key: 'rto_value', label: 'RTO (₹)', money: true },
    { key: 'billed', label: 'Delivered — invoice value (₹)', money: true },
    { key: 'collected', label: 'Collections (₹)', money: true },
    { key: 'receivable', label: 'Receivable (₹)', money: true },
  ], b.byEntity, [20, 12, 18, 16, 16, 16, 20, 18, 18], {
    title: 'Registration-wise summary',
    note: 'A caption such as "HR+KAR" denotes a single order whose line items were dispatched from two '
        + 'warehouses and billed under two registrations. Such orders are taken once only, so that no '
        + `amount is counted twice — ${b.totals.splitShipments.toLocaleString('en-IN')} orders are of `
        + 'this nature.',
  }));

  const pos = (k) => b.ledger.filter((l) => l.position === k);
  const WL = [
    ['Trade Receivables', [...pos('RECEIVABLE_LATE'), ...pos('RECEIVABLE_UNPAID')],
      'Orders comprising trade receivables as on the reporting date. The Basis column states, for each '
      + 'order, whether realisation was received after the reporting date or has not been received at all.'],
    ['Realisation Unascertained', [...pos('RECEIVABLE_UNDATED'), ...pos('UNDATED_DELIVERY')],
      'Delivered on or before the reporting date, but the payment reconciliation records no date of '
      + 'receipt (or no date of delivery), hence the period of realisation could not be ascertained. '
      + 'These represent the difference between trade receivables as stated and the maximum figure; '
      + 'they have been treated neither as realised nor as recoverable.'],
    ['Goods In Transit', pos('IN_TRANSIT'),
      'Dispatched on or before the reporting date and delivered thereafter. Not trade receivables where '
      + 'revenue is recognised on delivery; to be included only where revenue is recognised on dispatch.'],
    ['Channel Not Identified', b.exceptions.noCollector,
      'Delivered, no realisation received, and no payment gateway or UTR on record. The party from whom '
      + 'recovery is due could not be identified. Recommended for verification first.'],
    ['Flagged In Payment Reco', b.exceptions.redFlag,
      'Marked RED FLAG by the accountant in the payment reconciliation. Forms part of the preceding '
      + 'schedule.'],
    ['Part Realisation', b.exceptions.shortPaid,
      'Realisation received through a named collection channel, but short of the invoice value. '
      + 'Recoverable from that channel.'],
    ['Records Differ', b.exceptions.statusConflict,
      'Taxed as delivered in the GST sales register but shown under another status in the payment '
      + 'reconciliation. One of the two records is incorrect and the GST liability depends on which.'],
    ['Not In Sales Register', b.exceptions.taxedNowhere,
      'Shown as delivered and realised in the payment reconciliation but not appearing in any GST sales '
      + 'register produced. May have been realised without being reported in GSTR-1.'],
    ['Bank Date Not Recorded', b.exceptions.noDeposit,
      'Realisation received but the column "Date of Deposit in bank" is blank, hence ageing against the '
      + 'bank statement could not be carried out. This is why no ageing schedule is presented.'],
    ['Two Registrations', b.ledger.filter((l) => l.split_shipment),
      'A single order billed under two GST registrations. Taken once at order level; aggregating the '
      + 'registration-wise schedule instead would result in double counting.'],
  ];
  for (const [name, rows, note] of WL) {
    if (!rows.length) continue;
    /* "No deposit date" is a statement about the payment file, not a list anyone
       works — it is nearly every collected order. The count belongs on the
       Summary; only a sample belongs here. */
    const cap = name === 'Bank Date Not Recorded' ? 200 : 20000;
    const shown = rows.slice(0, cap);
    const extra = rows.length > cap
      ? `${note}  —  ${rows.length.toLocaleString('en-IN')} orders in all; the first `
        + `${cap.toLocaleString('en-IN')} are set out below, and every one of them appears on the Order Ledger.`
      : note;
    add(name, tableSheet(WORKLIST_COLS, shown, WL_W, { title: name, note: extra, total: shown.length <= 500 }));
  }

  add('Order Ledger', tableSheet(LEDGER_COLS, b.ledger,
    [12, 10, 12, 18, 14, 18, 12, 13, 13, 12, 13, 13, 13, 13, 20, 15, 15, 18, 22], {
      title: 'Order ledger — all orders, all records produced',
      note: 'One line per order number. An order sold in one month and returned in the next appears once, '
          + 'carrying both dates, so that no month requires to be netted against another. The '
          + 'Classification column states where each order stood as on the reporting date; the schedule '
          + 'bearing that name sets out the basis, order by order.',
    }));

  /* Basis & Checks — where each figure came from, in the accountant's terms. */
  const basis = [];
  const B = (...c) => basis.push(c);
  B(C('Basis of preparation and verification', 'title'));
  basis.push([]);
  B(C('Record produced', 'header'), C('Sheet', 'header'), C('Header at row', 'header'), C('Lines read', 'header'), C('Read as', 'header'));
  for (const f of meta.files) for (const t of f.tabs)
    B(C(f.filename), C(t.tab), count(t.headerRow), count(t.rows), C(t.kind));
  basis.push([]);
  B(C('Sheets not taken into account', 'section'), C('', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  B(C('These pertain to other sales channels and carry no Shopify order number, hence they cannot be '
    + 'matched with the payment reconciliation. They have been excluded deliberately.', 'note'));
  for (const f of meta.files) for (const s of (f.skipped || []))
    B(C(f.filename), C(s.tab), C(''), C(''), C(s.why));
  basis.push([]);
  B(C('Verification', 'section'), C('', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  B(C('Particulars', 'header'), C('Difference', 'header'), C('To be', 'header'), C('', 'header'), C('', 'header'));
  const ck = (label, val) => B(C(label, val === 0 ? 'ok' : 'bad'),
                               C(val, val === 0 ? 'ok' : 'bad', { fmt: AMT }),
                               C(0, val === 0 ? 'ok' : 'bad', { fmt: AMT }),
                               C('', val === 0 ? 'ok' : 'bad'), C('', val === 0 ? 'ok' : 'bad'));
  ck('The five collection-channel columns aggregate to the remittance stated in the payment reconciliation', b.checks.collectors);
  ck('The status-wise break-up aggregates to the gross value of orders', b.checks.statusSplit);
  ck('The channel-wise break-up aggregates to trade receivables', b.checks.receivableSplit);
  ck('Every order is classified under one head only', b.checks.positionSplit);
  basis.push([]);
  B(C('Matters reported without adjustment', 'section'), C('', 'section'), C('', 'section'), C('', 'section'), C('', 'section'));
  B(C('The GST sales registers and the payment reconciliation differ in respect of certain orders. Those '
    + 'differences are reported in the schedules "Records Differ" and "Not In Sales Register" together '
    + 'with the order numbers. No adjustment has been made and no amount has been netted off.', 'note'));
  const bws = sheetFrom(basis, [48, 24, 13, 13, 44]);
  bws['!rows'] = basis.map((r) => ({ hpt: r && r[0] && r[0].kind === 'note' ? 34 : 16 }));
  add('Basis of Preparation', bws);

  return wb;
}

/* Write options. bookSST puts repeated text in the shared-string table instead
   of inline in every cell — on a ledger of 37k rows where the same statuses,
   collectors and states repeat thousands of times, that is most of the file. */
const WRITE_OPTS = { bookType: 'xlsx', bookSST: true, compression: true };

module.exports = { buildWorkbook, WRITE_OPTS };

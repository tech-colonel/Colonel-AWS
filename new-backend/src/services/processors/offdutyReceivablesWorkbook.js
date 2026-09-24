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

/* No explicit negative section. Writing one ("#,##0;-#,##0") puts a literal
   minus in front of a value that is already negative in some viewers, and every
   deduction came out as "--1,862,777". Left to itself the format signs a
   negative once. */
const AMT = '#,##0.00';
/* The accountant's own Sales Summary is cast in whole rupees. Matching it. */
const RUP = '#,##0';
const GST_HEAD_BG = 'FFF7CC';   // the pale yellow band their sheet already uses
/* One colour per table, so a reader can tell at a glance which statement they
   are looking at. All pale, all printable, all distinguishable in greyscale by
   their captions rather than their fill. */
const CLR = {
  sales:   'FFF7CC',   // yellow  — sales
  returns: 'FCE4D6',   // orange  — returns and RTO
  recon:   'DDEBF7',   // blue    — reconciliation with the payment file
  cash:    'E2EFDA',   // green   — collections
  due:     'FFE1E1',   // pink    — amounts unsettled
  notes:   'EDEDED',   // grey    — notes
};
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
    /* The GST sales summary is laid out exactly as the accountant's own
       "Sales Summary" tab: a pale yellow banded header, boxed, with bold
       subtotals ruled above and below. Nothing invented. */
    case 'gsthead': return { font: { bold: true, sz: 11 },
                             fill: { patternType: 'solid', fgColor: { rgb: cell.bg || GST_HEAD_BG } },
                             border: border(['top', 'bottom', 'left', 'right'], '000000'),
                             alignment: { vertical: 'center', horizontal: 'center' } };
    case 'gstrow':  return { ...right, border: border(['left', 'right'], '000000') };
    case 'gsttot':  return { ...right, font: { bold: true },
                             fill: cell.bg ? { patternType: 'solid', fgColor: { rgb: cell.bg } } : undefined,
                             border: border(['top', 'bottom', 'left', 'right'], '000000') };
    case 'gstband': return { font: { bold: true, sz: 11, color: { rgb: INK } },
                             fill: { patternType: 'solid', fgColor: { rgb: cell.bg || 'EDEDED' } },
                             border: border(['top', 'bottom', 'left', 'right'], '000000'),
                             alignment: { vertical: 'center', horizontal: 'left' } };
    case 'gstname': return { font: { bold: true, sz: 12, color: { rgb: INK } },
                             alignment: { vertical: 'center', horizontal: 'left' } };
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

/* ── Sheet 1: the GST sales summary, in the shape already in use ───────────── */

const STATE_NAME = { HR: 'Haryana', KAR: 'Karnataka', MH: 'Maharashtra' };
const SHORT_MONTH = (p) => {
  if (!p) return '';
  const [mon, yr] = p.split(' ');
  return `${mon.slice(0, 3)}'${String(yr).slice(2)}`;
};

function salesSummarySheet(b, meta) {
  const g = [];
  const push = (...cells) => { g.push(cells); return g.length; };
  const blank = () => g.push([]);
  const heads = ['taxable_value', 'cgst', 'sgst', 'igst'];
  const period = b.periods.length === 1 ? SHORT_MONTH(b.periods[0])
               : `${SHORT_MONTH(b.periods[0])} to ${SHORT_MONTH(b.periods[b.periods.length - 1])}`;

  const rowOf = (label, o, kind) =>
    push(C(label, kind), ...heads.map((h) => C(Number(o[h]) || 0, kind, { fmt: RUP })));

  const block = (blk, caption) => {
    push(C(`Off Duty : Summary of Shopify Sales for the month of ${period}`, 'gstname'));
    push(C(caption, 'gstname'));
    push(C('Particulars', 'gsthead'), C('Taxable', 'gsthead'), C('CGST', 'gsthead'),
         C('SGST', 'gsthead'), C('IGST', 'gsthead'));
    const salesRow = rowOf('Shopify', blk.sales, 'gstrow');
    const totalSales = push(C('Total Sales', 'gsttot'),
      ...heads.map((h, i) => C(`=${colLetter(i + 1)}${salesRow}`, 'gsttot', { fmt: RUP })));
    blank();
    const rtoRow = rowOf('Shopify- Rto', blk.rto, 'gstrow');
    const refRow = rowOf('Shopify- Refunded', blk.refund, 'gstrow');
    const retRow = push(C('Total Return', 'gsttot'),
      ...heads.map((h, i) => {
        const L = colLetter(i + 1);
        return C(`=${L}${rtoRow}+${L}${refRow}`, 'gsttot', { fmt: RUP });
      }));
    blank();
    const netRow = push(C('Net Sales', 'gsttot'),
      ...heads.map((h, i) => {
        const L = colLetter(i + 1);
        return C(`=${L}${totalSales}+${L}${retRow}`, 'gsttot', { fmt: RUP });
      }));
    blank(); blank();
    return netRow;
  };

  const netRows = [];
  for (const blk of b.gst.blocks) netRows.push(block(blk, STATE_NAME[blk.entity] || blk.entity));
  if (b.gst.consolidated) {
    const at = block(b.gst.consolidated, 'All registrations — consolidated');
    /* The consolidation must equal the registrations added up. Stated as a live
       formula so it re-evaluates if anything above is edited. */
    push(C('Difference with the registrations above (to be Nil)', 'ok'),
      ...heads.map((h, i) => {
        const L = colLetter(i + 1);
        return C(`=ROUND(${L}${at}-(${netRows.map((r) => `${L}${r}`).join('+')}),2)`, 'ok', { fmt: AMT });
      }));
  }
  blank();
  push(C('Prepared from the delivered, refund and RTO sheets of each registration\'s GST sales register. '
       + 'Other sales channels appearing in those workbooks — Nykaa, Myntra, Slikk, B2B and the stores — '
       + 'are not included. Figures agree with the Sales Summary of each workbook.', 'note'));

  const ws = sheetFrom(g, [34, 16, 14, 14, 16]);
  ws['!rows'] = g.map((row) => {
    const k = row && row[0] ? row[0].kind : null;
    if (k === 'gstname') return { hpt: 19 };
    if (k === 'gsthead') return { hpt: 20 };
    if (k === 'note') return { hpt: 42 };
    return { hpt: 16 };
  });
  return ws;
}

/* ── Sheet 2: the receivables statement ────────────────────────────────────── */

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
  const br = b.bridge;
  const inv = (o) => r2v(o.taxable_value) + r2v(o.cgst) + r2v(o.sgst) + r2v(o.igst);
  const r2v = (n) => Number(n) || 0;

  /* One table: a caption band in the table's colour, a header row in the same
     colour, then rows. Everything boxed, as the accountant's own sheet is. */
  const band = (caption, colour, width) =>
    push(...Array.from({ length: width }, (_, i) => C(i === 0 ? caption : '', 'gstband', { bg: colour })));
  const head = (labels, colour) => push(...labels.map((l) => C(l, 'gsthead', { bg: colour })));
  const row = (label, vals, kind = 'gstrow', colour) =>
    push(C(label, kind, colour ? { bg: colour } : {}),
         ...vals.map((v) => (typeof v === 'string' && v.startsWith('=')
           ? C(v, kind, { fmt: RUP, ...(colour ? { bg: colour } : {}) })
           : v === null ? C('', kind, colour ? { bg: colour } : {})
           : C(Number(v) || 0, kind, { fmt: RUP, ...(colour ? { bg: colour } : {}) }))));

  push(C('Off Duty : Reconciliation of Sales with Collections', 'title'));
  push(C('For', 'meta'), C(b.periods.join(', ') || '—', 'meta'));
  push(C('As on', 'meta'), C(pretty(b.asAt), 'meta'));
  push(C('Records examined', 'meta'), C(meta.sourceLine, 'meta'));
  blank();

  /* ── A. net sales ───────────────────────────────────────────────────── */
  const gc = b.gst.consolidated || b.gst.blocks[0];
  band('A.  NET SALES — ALL REGISTRATIONS CONSOLIDATED', CLR.sales, 6);
  head(['Particulars', 'Taxable', 'CGST', 'SGST', 'IGST', 'Invoice value'], CLR.sales);
  // invoice value = taxable + the three tax heads; it is what the customer was billed
  const four = (o) => [o.taxable_value, o.cgst, o.sgst, o.igst];
  const rA1 = row('Shopify — delivered', [...four(gc.sales), inv(gc.sales)]);
  const rA2 = row('Less: RTO', [...four(gc.rto), inv(gc.rto)]);
  const rA3 = row('Less: Sales returns / refunds', [...four(gc.refund), inv(gc.refund)]);
  const rA4 = row('Net Sales', [1, 2, 3, 4, 5].map((i) => {
    const L = colLetter(i);
    return `=${L}${rA1}+${L}${rA2}+${L}${rA3}`;
  }), 'gsttot', CLR.sales);
  blank();

  /* ── B. returns and RTO by registration ─────────────────────────────── */
  band('B.  RETURNS AND RTO — BY REGISTRATION  (invoice value)', CLR.returns, 7);
  head(['Registration', 'Delivered', 'Less: RTO', 'Less: Sales returns', 'Total returns',
        'Net sales', 'Returns as % of delivered'], CLR.returns);
  const bFirst = g.length + 1;
  for (const blk of b.gst.blocks) {
    const r = row(STATE_NAME[blk.entity] || blk.entity,
      [inv(blk.sales), inv(blk.rto), inv(blk.refund), `=C${g.length + 1}+D${g.length + 1}`,
       `=B${g.length + 1}+E${g.length + 1}`, null]);
    /* the two computed columns refer to their own row, so they are written after
       the row exists rather than guessed at */
    g[r - 1][4] = C(`=C${r}+D${r}`, 'gstrow', { fmt: RUP });
    g[r - 1][5] = C(`=B${r}+E${r}`, 'gstrow', { fmt: RUP });
    g[r - 1][6] = C(`=IFERROR(-E${r}/B${r},0)`, 'gstrow', { fmt: PCT });
  }
  const bLast = g.length;
  const bTot = bLast + 1;
  push(C('Total', 'gsttot', { bg: CLR.returns }),
    ...[1, 2, 3, 4, 5].map((i) => C(`=SUM(${colLetter(i)}${bFirst}:${colLetter(i)}${bLast})`, 'gsttot',
      { fmt: RUP, bg: CLR.returns })),
    C(`=IFERROR(-E${bTot}/B${bTot},0)`, 'gsttot', { fmt: PCT, bg: CLR.returns }));
  push(C('Net sales above agree with A (to be Nil)', 'ok'), C('', 'ok'), C('', 'ok'), C('', 'ok'), C('', 'ok'),
    C(`=ROUND(F${bTot}-F${rA4},2)`, 'ok', { fmt: AMT }), C('', 'ok'));
  blank();

  /* ── C. the bridge ──────────────────────────────────────────────────── */
  band('C.  RECONCILIATION OF DELIVERED SALES WITH THE PAYMENT RECONCILIATION', CLR.recon, 3);
  head(['Particulars', 'No. of orders', 'Amount (₹)'], CLR.recon);
  const c1 = row('Delivered — per the GST sales registers', [br.salesDelivered.orders, br.salesDelivered.amount]);
  const c2 = row('Less: taxed as delivered, shown under another status in the payment reconciliation',
    [br.salesOnly.orders, -br.salesOnly.amount]);
  const c3 = row('Common orders — per the GST sales registers', [br.commonPerSales.orders, `=C${c1}+C${c2}`], 'gsttot');
  const c4 = row('Add: orders only part delivered — the register taxes the delivered lines, the payment '
               + 'reconciliation carries the whole order', [br.partDelivered.orders, br.partDelivered.amount]);
  const c5 = row('Common orders — per the payment reconciliation', [br.commonPerPayment.orders, `=C${c3}+C${c4}`], 'gsttot');
  const c6 = row('Add: orders in the payment reconciliation appearing in no sales register',
    [br.payOnly.orders, br.payOnly.amount]);
  const c7 = row('Delivered — per the payment reconciliation', [br.payDelivered.orders, br.payDelivered.amount],
    'gsttot', CLR.recon);
  const okC = Math.abs(br.difference) < 0.005;
  push(C('Difference (to be Nil)', okC ? 'ok' : 'bad'), C('', okC ? 'ok' : 'bad'),
    C(`=ROUND(C${c5}+C${c6}-C${c7},2)`, okC ? 'ok' : 'bad', { fmt: AMT }));
  blank();

  /* ── D. collections ─────────────────────────────────────────────────── */
  band('D.  COLLECTIONS AGAINST DELIVERED SALES', CLR.cash, 3);
  head(['Particulars', 'No. of orders', 'Amount (₹)'], CLR.cash);
  const d1 = row('Delivered — per the payment reconciliation', [br.payDelivered.orders, br.payDelivered.amount]);
  const d2 = row('Less: collections received', [null, -br.collections]);
  const d3 = row('Unsettled', [null, `=C${d1}+C${d2}`], 'gsttot', CLR.cash);
  blank();
  head(['Collection channel', 'Orders routed', 'Collections (₹)'], CLR.cash);
  const dFirst = g.length + 1;
  for (const c of b.byCollector) row(c.label, [c.orders, c.collected]);
  const dLast = g.length;
  const dTot = row('Total collections — all periods produced',
    [null, `=SUM(C${dFirst}:C${dLast})`], 'gsttot', CLR.cash);
  const dStated = row('As per the payment reconciliation', [null, b.totals.collected]);
  const ok2 = b.checks.collectors === 0;
  push(C('Difference (to be Nil)', ok2 ? 'ok' : 'bad'), C('', ok2 ? 'ok' : 'bad'),
    C(`=ROUND(C${dTot}-C${dStated},2)`, ok2 ? 'ok' : 'bad', { fmt: AMT }));
  blank();

  /* ── E. what is unsettled, as at the date ───────────────────────────── */
  band(`E.  AMOUNTS UNSETTLED AS ON ${pretty(b.asAt).toUpperCase()}`, CLR.due, 3);
  head(['Particulars', 'No. of orders', 'Amount (₹)'], CLR.due);
  const e1 = row('Delivered on or before the reporting date, realised subsequently',
    [P.RECEIVABLE_LATE.orders, P.RECEIVABLE_LATE.amount]);
  const e2 = row('Delivered on or before the reporting date, not realised',
    [P.RECEIVABLE_UNPAID.orders, P.RECEIVABLE_UNPAID.amount]);
  const e3 = row('Trade receivables (sundry debtors)', [`=B${e1}+B${e2}`, `=C${e1}+C${e2}`], 'gsttot', CLR.due);
  const e4 = row('Realised, but date of receipt not recorded',
    [P.RECEIVABLE_UNDATED.orders, P.RECEIVABLE_UNDATED.amount]);
  const e5 = row('Maximum trade receivables, if the above are treated as unrealised',
    [null, `=C${e3}+C${e4}`], 'gsttot');
  const e6 = row('Goods in transit — dispatched within the period, delivered thereafter',
    [P.IN_TRANSIT.orders, P.IN_TRANSIT.amount]);
  row('Total amount recoverable', [null, `=C${e3}+C${e6}`], 'gsttot', CLR.due);
  blank();
  head(['Trade receivables — collection channel wise', 'No. of orders', 'Amount (₹)'], CLR.due);
  const fFirst = g.length + 1;
  for (const r of b.receivableSplit) row(r.label, [r.orders, r.receivable]);
  const fLast = g.length;
  const fTot = row('Total', [`=SUM(B${fFirst}:B${fLast})`, `=SUM(C${fFirst}:C${fLast})`], 'gsttot', CLR.due);
  const okS = b.checks.receivableSplit === 0;
  push(C('Difference with trade receivables above (to be Nil)', okS ? 'ok' : 'bad'), C('', okS ? 'ok' : 'bad'),
    C(`=ROUND(C${fTot}-C${e3},2)`, okS ? 'ok' : 'bad', { fmt: AMT }));
  blank();

  /* ── F. notes ───────────────────────────────────────────────────────── */
  band('F.  NOTES AND QUALIFICATIONS', CLR.notes, 4);
  head(['Particulars', 'No. of orders', 'Amount (₹)', 'Remarks'], CLR.notes);
  for (const l of b.limits)
    push(C(l.label, 'gstrow'), C(l.orders, 'gstrow', { fmt: INT }),
         C(l.amount, 'gstrow', { fmt: RUP }), C(l.why, 'sub'));
  blank();
  band('G.  AMOUNTS UNREALISED AS ON DATE — FOR RECOVERY', CLR.notes, 4);
  head(['Particulars', 'No. of orders', 'Amount (₹)', 'Remarks'], CLR.notes);
  const WL = [
    ['Collection channel not identified', b.exceptions.noCollector,
     'Delivered, unrealised, and no gateway or UTR on record'],
    ['Flagged in the payment reconciliation', b.exceptions.redFlag,
     'Marked RED FLAG by the accountant in the payment reconciliation'],
    ['Part realisation received', b.exceptions.shortPaid,
     'Realisation received through a named channel, but short of the invoice value'],
  ];
  for (const [label, rows, why] of WL)
    push(C(label, 'gstrow'), C(rows.length, 'gstrow', { fmt: INT }),
         C(Number(rows.reduce((a, x) => a + Math.abs(x.gap), 0).toFixed(2)), 'gstrow', { fmt: RUP }),
         C(why, 'sub'));
  push(C('Total unrealised as on date', 'gsttot', { bg: CLR.notes }), C('', 'gsttot', { bg: CLR.notes }),
       C(b.totals.stillShortToday, 'gsttot', { fmt: RUP, bg: CLR.notes }),
       C('A recovery schedule, NOT trade receivables as on the reporting date — most collections had '
       + 'been received by the date of preparation, though not by the reporting date.', 'sub'));

  const ws = sheetFrom(g, [64, 16, 16, 18, 16, 16, 20]);
  ws['!rows'] = g.map((r) => {
    const k = r && r[0] ? r[0].kind : null;
    if (k === 'title') return { hpt: 26 };
    if (k === 'gstband' || k === 'gsthead') return { hpt: 21 };
    if (r && r[3] && r[3].kind === 'sub') return { hpt: 30 };
    if (r && r[0] && String(r[0].v || '').length > 70) return { hpt: 28 };
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

  add('Sales Summary', salesSummarySheet(b, meta));
  add('Receivables', summarySheet(b, meta));

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

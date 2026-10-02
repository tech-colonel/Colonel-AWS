/* ──────────────────────────────────────────────────────────────────────────────
   amazonReceivablesWorkbook.js — the receivables report as a workbook an
   accountant can actually work in.

   WHY THIS EXISTS AT ALL. The first version of this export was written with
   SheetJS, whose community build silently discards every style you give it. The
   result was a grid of unformatted numbers: no currency, no grouping, nothing
   to tell a subtotal from an input, truncated columns, and not one live formula.
   That is a data dump, not a report, and it is the one artefact that leaves this
   system and goes to a client.

   THREE THINGS A FINANCE WORKBOOK OWES ITS READER.

     It must RECALCULATE. Every derived figure here is a real formula, not a
     pasted number — net billable, due from Amazon, outstanding, every total,
     every percentage. Change an input and the sheet answers. A workbook of
     hard-coded results cannot be checked by changing anything, which is the
     first thing an accountant does.

     It must say WHICH CELLS IT CALCULATED. Derived cells carry a pale blue fill
     and a border, so a reader can see at a glance what is an input from Amazon
     and what this report worked out — and clicking one shows the arithmetic in
     the formula bar. The legend on the cover says so in as many words.

     It must EXPLAIN ITSELF WHERE THE FIGURE IS. Every amount carries a cell
     note naming the file, the column and the filter behind it. An explanation
     in a covering email is an explanation nobody has six months later; one
     attached to the cell travels with the number.

   The colours are the product's own — brand blue for the MTR, emerald for the
   settlement, violet for the order report, slate for anything derived — so the
   sheet and the screen agree about what each source is.
   ────────────────────────────────────────────────────────────────────────────── */

const ExcelJS = require('exceljs');

/* ── the palette, shared with the dashboard ─────────────────────────────── */
const C = {
  ink: 'FF0F172A', inkSoft: 'FF1E293B', paper: 'FFFFFFFF',
  band: 'FFF1F5F9', zebra: 'FFF8FAFC', rule: 'FFE2E8F0',
  muted: 'FF64748B', body: 'FF334155',
  brand: 'FF0748EE', violet: 'FF7C3AED', emerald: 'FF059669', slate: 'FF475569',
  calcBg: 'FFEFF6FF', calcEdge: 'FFBFDBFE',
  warnBg: 'FFFFFBEB', warnFg: 'FF92400E', warnEdge: 'FFFCD34D',
  dangerBg: 'FFFFF1F2', dangerFg: 'FFBE123C', dangerEdge: 'FFFCA5A5',
  goodBg: 'FFECFDF5', goodFg: 'FF047857', goodEdge: 'FF6EE7B7',
  infoBg: 'FFF0F9FF', infoFg: 'FF1E40AF', infoEdge: 'FF93C5FD',
};

/* Indian grouping — 2-2-3, the way every Indian statement reads — with losses
   in red. A western #,##0.00 on a lakh figure is the giveaway that nobody
   looked at the output. */
const MONEY = '#,##,##0.00;[Red]-#,##,##0.00';
const COUNT = '#,##,##0;[Red]-#,##,##0';
const PCT = '0.0%';

const FILE_TONE = { MTR: C.brand, Settlement: C.emerald, 'Order report': C.violet, Derived: C.slate };

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMonth = (m) => (/^\d{4}-\d{2}$/.test(m || '') ? `${MON[+m.slice(5) - 1]} ${m.slice(0, 4)}` : m || '');
const rangeLabel = (ms) => (!ms.length ? '—' : ms.length === 1 ? fmtMonth(ms[0])
  : `${fmtMonth(ms[0])} – ${fmtMonth(ms[ms.length - 1])}`);
const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0); };
const daysOld = (m) => Math.max(0, Math.floor((Date.now() - monthEnd(m).getTime()) / 86400000));

/* ── small builders, so every sheet is laid out the same way ─────────────── */

const border = (color = C.rule, style = 'thin') => ({ style, color: { argb: color } });

function fill(cell, argb) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

/** The dark banner every sheet opens with. */
function titleBand(ws, row, span, title, subtitle) {
  ws.mergeCells(row, 1, row, span);
  const t = ws.getCell(row, 1);
  t.value = title;
  t.font = { name: 'Calibri', size: 15, bold: true, color: { argb: C.paper } };
  fill(t, C.ink);
  t.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(row).height = 30;

  ws.mergeCells(row + 1, 1, row + 1, span);
  const s = ws.getCell(row + 1, 1);
  s.value = subtitle;
  s.font = { name: 'Calibri', size: 9.5, color: { argb: C.paper } };
  fill(s, C.inkSoft);
  s.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(row + 1).height = 18;
  return row + 2;
}

/** A pale section rule, so a long sheet reads as sections rather than rows. */
function sectionBand(ws, row, span, text, note) {
  ws.mergeCells(row, 1, row, span);
  const c = ws.getCell(row, 1);
  c.value = note ? `${text}   —   ${note}` : text;
  c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.ink } };
  fill(c, C.band);
  c.alignment = { vertical: 'middle', indent: 1 };
  c.border = { bottom: border(C.rule, 'medium') };
  ws.getRow(row).height = 22;
  return row + 1;
}

/** Column headers: ink, white, and frozen by the caller. */
function headerRow(ws, row, cols) {
  cols.forEach((c, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = c.label;
    cell.font = { name: 'Calibri', size: 9, bold: true, color: { argb: C.paper } };
    fill(cell, C.inkSoft);
    cell.alignment = { vertical: 'middle', horizontal: c.align || 'left',
                       wrapText: true, indent: c.align === 'right' ? 0 : 1 };
    if (c.note) cell.note = c.note;
  });
  ws.getRow(row).height = 26;
  return row + 1;
}

/** Mark a cell as something this report WORKED OUT rather than was given. */
function asCalc(cell) {
  fill(cell, C.calcBg);
  cell.border = { top: border(C.calcEdge), left: border(C.calcEdge),
                  bottom: border(C.calcEdge), right: border(C.calcEdge) };
}

function money(cell, value, { bold = false, calc = false, note = null, fmt = MONEY } = {}) {
  cell.value = value;
  cell.numFmt = fmt;
  cell.font = { name: 'Calibri', size: 10, bold, color: { argb: C.ink } };
  cell.alignment = { horizontal: 'right' };
  if (calc) asCalc(cell);
  if (note) cell.note = note;
  return cell;
}

/** The coloured source chip — the same four colours the dashboard uses. */
function sourceChip(cell, name) {
  cell.value = name;
  cell.font = { name: 'Calibri', size: 9, bold: true, color: { argb: FILE_TONE[name] || C.slate } };
  cell.alignment = { horizontal: 'center' };
}

const colLetter = (n) => {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

/* ── what every line means, and where it came from ───────────────────────────
   One place, used for the cell notes AND the visible "what this is" column, so
   the sheet cannot end up explaining a figure two different ways. */
const LINES = [
  { key: 'invoiced', label: 'Invoiced (incl GST)', sign: '+', src: 'MTR',
    what: 'What was billed to customers — the MTR invoice value.',
    note: 'MTR (Merchant Tax Report, B2B + B2C)\nColumn: Invoice Amount\nFilter: Transaction Type = Shipment\nDated by: Invoice Date (Shipment Date is blank on most B2C rows)\n\nThis is THE BASE of the report — the document actually issued to the customer.' },
  { key: 'returned', label: 'Returns / refunds', sign: '−', src: 'MTR',
    what: 'Money given back on those orders.',
    note: 'MTR\nColumn: Invoice Amount\nFilter: Transaction Type = Refund\n\nRefunds are negative in the MTR and are held positive here, as a deduction.' },
  { key: 'netBillable', label: 'Net billable', sign: '=', src: 'Derived', strong: true,
    formula: (c, r) => `${c}${r.invoiced}-${c}${r.returned}`,
    what: 'Invoiced less returns.',
    note: 'CALCULATED: Invoiced − Returns.' },
  { key: 'fees', label: 'Amazon fees', sign: '−', src: 'Settlement',
    what: 'Commission, closing fee, FBA, storage and the GST on them.',
    note: 'Settlement\nColumns: selling fees + fba fees + other transaction fees\nFilter: every settlement row for the order\n\nAccumulated signed and the magnitude taken once at the end — a reversed fee is a credit, not another charge.' },
  { key: 'tdsTcs', label: 'TDS 194-O / TCS', sign: '−', src: 'Settlement',
    what: 'Withheld at source by Amazon and paid to the government for you.',
    note: 'Settlement\nColumns: TDS (Section 194-O) + TCS-CGST + TCS-SGST + TCS-IGST\n\nGenuinely withheld, unlike GST — this money never reaches you, it reaches the department against your PAN.' },
  { key: 'expected', label: 'Due from Amazon', sign: '=', src: 'Derived', strong: true,
    formula: (c, r) => `${c}${r.netBillable}-${c}${r.fees}-${c}${r.tdsTcs}`,
    what: 'What Amazon owes on this month’s orders.',
    note: 'CALCULATED: Net billable − Amazon fees − TDS/TCS.' },
  { key: 'settled', label: 'Received (to date)', sign: '−', src: 'Settlement',
    what: 'What has arrived against them, whenever it arrived.',
    note: 'Settlement\nColumn: total\nFilter: every settlement row for the order, whatever month it landed in\n\nAmazon states the payout per row and the parts foot to it exactly, so it is read rather than rebuilt from eight signed columns.\n\nCOHORT, not cash-in-month: this is what arrived against THIS month’s invoices, even if it arrived later.' },
  { key: 'closing', label: 'Still outstanding', sign: '=', src: 'Derived', strong: true, final: true,
    formula: (c, r) => `${c}${r.expected}-${c}${r.settled}`,
    what: 'Not yet received. A NEGATIVE means more came in than was due.',
    note: 'CALCULATED: Due from Amazon − Received to date.\n\nA negative figure is a red flag, not a windfall: an order cannot pay more than it was invoiced, so it means a receipt is counted twice or a deduction is overstated.' },
];

const MEMO = [
  { key: 'settledLater', label: 'of which received later', src: 'Settlement',
    what: 'Part of “Received” that arrived after the month closed — the carry-forward.',
    note: 'The part of Received that landed in a LATER month than the one that invoiced it.\n\nAmazon settles about every seven days, so the end of every month settles in the month after. This figure is why a cash-in-month view disagrees with this one.' },
  { key: 'gstMemo', label: '(memo) GST within the receivable', src: 'MTR',
    what: 'How much of the receivable is GST you will remit. NOT withheld by Amazon.',
    note: 'MTR · Total Tax Amount.\n\nA MEMO, never a deduction. Amazon collects the full invoice from the buyer and pays the GST across to you; you remit it onward. Treating it as something Amazon kept turns every closing balance negative.' },
];

/* ══════════════════════════════════════════════════════════════════════════ */

function buildWorkbook(payload, { brand, months }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Colonel · agent.accountant';
  wb.created = new Date();

  const ms = months;
  const led = (payload.ledger?.perMonth || []).filter((m) => ms.includes(m.month));
  const rows = (payload.ledger?.rows || []).filter((r) => ms.includes(r.month));
  const chainRows = (payload.three?.orderRows || []).filter((r) => ms.includes(r.month));
  const chain = (payload.three?.perMonth || []).filter((m) => ms.includes(m.month));
  const issues = (payload.audit?.issues || []).filter((i) => !i.month || ms.includes(i.month));
  const srcKind = payload.sourceKind || {};
  const period = rangeLabel(ms);
  const stamp = new Date().toLocaleString('en-IN');

  const nMon = ms.length;
  const COL_TOTAL = 3 + nMon;          /* Line | Source | …months… | Total | What */
  const COL_WHAT = COL_TOTAL + 1;

  /* ── 2. the ledger, built first because the cover quotes it ───────────── */
  const L = wb.addWorksheet('Ledger', { views: [{ state: 'frozen', ySplit: 5, xSplit: 2 }] });
  L.columns = [
    { width: 3 }, { width: 28 }, ...ms.map(() => ({ width: 17 })),
    { width: 17 }, { width: 62 },
  ];
  /* the sign column sits at A and the label at B, so widths above are offset */
  L.getColumn(1).width = 3.5;
  L.getColumn(2).width = 28;

  let r = titleBand(L, 1, COL_WHAT, 'AMAZON RECEIVABLES — THE WATERFALL',
    `${brand}   ·   ${period}   ·   base: MTR invoice value   ·   generated ${stamp}`);
  r += 1;
  r = sectionBand(L, r, COL_WHAT, 'EACH MONTH IS ITS OWN COHORT',
    'the orders INVOICED that month, what Amazon kept, and what has since arrived against them — whenever it arrived');

  const headRow = r;
  r = headerRow(L, r, [
    { label: '', align: 'center' },
    { label: 'Line' },
    ...ms.map((m) => ({ label: fmtMonth(m), align: 'right',
      note: `Invoices raised in ${fmtMonth(m)}.\nSettlement source: ${srcKind[m] === 'unified'
        ? 'Amazon’s unified transaction report (the raw ledgers are past the 90-day window, and it merges fee columns)'
        : 'the retained settlement ledgers'}.` })),
    { label: 'Total', align: 'right' },
    { label: 'What this line is, and where it comes from' },
  ]);
  /* the source chip sits above the figures rather than in its own column, so
     the months stay side by side where they can be compared */
  L.getCell(headRow, 2).note = 'Blue-filled cells are CALCULATED by this report — click one to see the formula. '
    + 'Everything else is read straight out of one of Amazon’s three files.';

  const at = {};                       /* line key → its row, for the formulas */
  const firstMonthCol = 3;
  const lastMonthCol = 2 + nMon;

  for (const line of LINES) {
    at[line.key] = r;
    const sign = L.getCell(r, 1);
    sign.value = line.sign;
    sign.font = { name: 'Consolas', size: 10, color: { argb: C.muted } };
    sign.alignment = { horizontal: 'center' };

    const label = L.getCell(r, 2);
    label.value = line.label;
    label.font = { name: 'Calibri', size: 10, bold: !!line.strong, color: { argb: C.ink } };
    label.alignment = { vertical: 'middle', indent: 1 };
    label.note = line.note;

    ms.forEach((m, i) => {
      const col = firstMonthCol + i;
      const cell = L.getCell(r, col);
      const v = led[i]?.[line.key]?.amount ?? 0;
      /* A derived line is a real FORMULA, carrying the value we computed as its
         cached result so the figure is right the instant the file opens and
         still recalculates the moment an input is touched. */
      money(cell, line.formula
        ? { formula: line.formula(colLetter(col), at), result: v }
        : v, { bold: !!line.strong, calc: !!line.formula });
      cell.note = line.note;
    });

    const tot = L.getCell(r, COL_TOTAL);
    tot.value = { formula: `SUM(${colLetter(firstMonthCol)}${r}:${colLetter(lastMonthCol)}${r})` };
    tot.numFmt = MONEY;
    tot.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.ink } };
    tot.alignment = { horizontal: 'right' };
    asCalc(tot);
    tot.border = { ...tot.border, left: border(C.ink, 'medium') };

    const what = L.getCell(r, COL_WHAT);
    what.value = line.what;
    what.font = { name: 'Calibri', size: 9, color: { argb: C.muted } };
    what.alignment = { vertical: 'middle', wrapText: true, indent: 1 };

    if (line.strong) {
      for (let c = 1; c <= COL_WHAT; c++) {
        const cell = L.getCell(r, c);
        if (!cell.fill || cell.fill.fgColor?.argb !== C.calcBg) fill(cell, C.band);
        cell.border = { ...(cell.border || {}), top: border(C.rule), bottom: border(C.rule) };
      }
    }
    if (line.final) {
      for (let c = 1; c <= COL_WHAT; c++) {
        L.getCell(r, c).border = { ...(L.getCell(r, c).border || {}), bottom: border(C.ink, 'double') };
      }
    }
    L.getRow(r).height = 20;
    r += 1;
  }

  r += 1;
  for (const memo of MEMO) {
    at[memo.key] = r;
    const label = L.getCell(r, 2);
    label.value = memo.label;
    label.font = { name: 'Calibri', size: 9, italic: true, color: { argb: C.muted } };
    label.alignment = { indent: 1 };
    label.note = memo.note;
    ms.forEach((m, i) => {
      const cell = money(L.getCell(r, firstMonthCol + i), led[i]?.[memo.key]?.amount ?? 0);
      cell.font = { name: 'Calibri', size: 9, italic: true, color: { argb: C.muted } };
      cell.note = memo.note;
    });
    const tot = L.getCell(r, COL_TOTAL);
    tot.value = { formula: `SUM(${colLetter(firstMonthCol)}${r}:${colLetter(lastMonthCol)}${r})` };
    tot.numFmt = MONEY;
    tot.font = { name: 'Calibri', size: 9, italic: true, color: { argb: C.muted } };
    tot.alignment = { horizontal: 'right' };
    asCalc(tot);
    const what = L.getCell(r, COL_WHAT);
    what.value = memo.what;
    what.font = { name: 'Calibri', size: 9, italic: true, color: { argb: C.muted } };
    what.alignment = { wrapText: true, indent: 1 };
    for (let c = 1; c <= COL_WHAT; c++) {
      const cell = L.getCell(r, c);
      if (cell.fill?.fgColor?.argb !== C.calcBg) fill(cell, C.infoBg);
    }
    r += 1;
  }

  /* collection rate — the one ratio a receivables report is asked for */
  r += 1;
  const pctRow = r;
  const pl = L.getCell(r, 2);
  pl.value = '% collected';
  pl.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.ink } };
  pl.alignment = { indent: 1 };
  pl.note = 'CALCULATED: Received to date ÷ Due from Amazon.\n\n100% means the month is square. Short of it is either Amazon’s weekly lag or money being held.';
  ms.forEach((m, i) => {
    const col = colLetter(firstMonthCol + i);
    const cell = L.getCell(r, firstMonthCol + i);
    cell.value = { formula: `IF(${col}${at.expected}=0,0,${col}${at.settled}/${col}${at.expected})` };
    cell.numFmt = PCT;
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.ink } };
    cell.alignment = { horizontal: 'right' };
    asCalc(cell);
  });
  const ptot = L.getCell(r, COL_TOTAL);
  ptot.value = { formula: `IF(${colLetter(COL_TOTAL)}${at.expected}=0,0,${colLetter(COL_TOTAL)}${at.settled}/${colLetter(COL_TOTAL)}${at.expected})` };
  ptot.numFmt = PCT;
  ptot.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.ink } };
  ptot.alignment = { horizontal: 'right' };
  asCalc(ptot);
  L.addConditionalFormatting({
    ref: `${colLetter(firstMonthCol)}${pctRow}:${colLetter(COL_TOTAL)}${pctRow}`,
    rules: [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }],
              color: { argb: C.emerald } }],
  });

  /* ── the counts behind each line ──────────────────────────────────────── */
  r += 2;
  r = sectionBand(L, r, COL_WHAT, 'ORDERS BEHIND EACH LINE',
    'the same waterfall, counted rather than valued — a figure and the number of orders it covers are two different facts');
  r = headerRow(L, r, [
    { label: '' }, { label: 'Line' },
    ...ms.map((m) => ({ label: fmtMonth(m), align: 'right' })),
    { label: 'Total', align: 'right' }, { label: '' },
  ]);
  for (const line of LINES) {
    L.getCell(r, 2).value = line.label;
    L.getCell(r, 2).font = { name: 'Calibri', size: 9.5, color: { argb: C.body } };
    L.getCell(r, 2).alignment = { indent: 1 };
    ms.forEach((m, i) => {
      money(L.getCell(r, firstMonthCol + i), led[i]?.[line.key]?.count ?? 0, { fmt: COUNT });
    });
    const tot = L.getCell(r, COL_TOTAL);
    tot.value = { formula: `SUM(${colLetter(firstMonthCol)}${r}:${colLetter(lastMonthCol)}${r})` };
    tot.numFmt = COUNT;
    tot.alignment = { horizontal: 'right' };
    tot.font = { name: 'Calibri', size: 9.5, bold: true, color: { argb: C.ink } };
    asCalc(tot);
    if (r % 2 === 0) for (let c = 1; c <= COL_TOTAL; c++) {
      const cell = L.getCell(r, c);
      if (cell.fill?.fgColor?.argb !== C.calcBg) fill(cell, C.zebra);
    }
    r += 1;
  }

  /* ── 1. the cover, which quotes the ledger by reference ───────────────── */
  const S = wb.addWorksheet('Report', { views: [{ state: 'frozen', ySplit: 2, showGridLines: false }] });
  S.columns = [{ width: 34 }, { width: 19 }, { width: 14 }, { width: 24 }, { width: 52 }];
  const LT = colLetter(COL_TOTAL);

  let s = titleBand(S, 1, 5, 'AMAZON RECEIVABLES',
    `${brand}   ·   ${period}   ·   generated ${stamp}`);
  s += 1;

  s = sectionBand(S, s, 5, 'THE POSITION', `at ${stamp}`);
  const posHead = s;
  s = headerRow(S, s, [{ label: 'Figure' }, { label: 'Amount', align: 'right' },
    { label: 'Source', align: 'center' }, { label: 'What it means' }, { label: '' }]);
  /* the explanation wants the width of two columns, and an empty fifth column
     under a filled header reads as a fault in the sheet */
  S.mergeCells(posHead, 4, posHead, 5);

  for (const line of [...LINES, ...MEMO]) {
    const lab = S.getCell(s, 1);
    lab.value = line.label;
    lab.font = { name: 'Calibri', size: 10, bold: !!line.strong, color: { argb: C.ink } };
    lab.alignment = { indent: 1, vertical: 'middle' };
    const amt = S.getCell(s, 2);
    amt.value = { formula: `Ledger!${LT}${at[line.key]}` };
    amt.numFmt = MONEY;
    amt.font = { name: 'Calibri', size: line.strong ? 11 : 10, bold: !!line.strong, color: { argb: C.ink } };
    amt.alignment = { horizontal: 'right' };
    asCalc(amt);
    amt.note = `${line.note}\n\nThis cell reads the Ledger sheet’s own total, so the two can never disagree.`;
    sourceChip(S.getCell(s, 3), line.src);
    S.mergeCells(s, 4, s, 5);
    const what = S.getCell(s, 4);
    what.value = line.what;
    what.font = { name: 'Calibri', size: 9, color: { argb: C.muted } };
    what.alignment = { wrapText: true, vertical: 'middle', indent: 1 };
    if (line.strong) for (let c = 1; c <= 5; c++) {
      const cell = S.getCell(s, c);
      if (cell.fill?.fgColor?.argb !== C.calcBg) fill(cell, C.band);
    }
    S.getRow(s).height = 22;
    S.getRow(s).height = 20;
    s += 1;
  }

  /* ── ageing: the figure a receivables report is really for ────────────── */
  s += 1;
  s = sectionBand(S, s, 5, 'HOW OLD THE OUTSTANDING MONEY IS',
    'Amazon settles about every seven days, so last month’s tail is a timing difference and anything older is a question');
  s = headerRow(S, s, [{ label: 'Month invoiced' }, { label: 'Still outstanding', align: 'right' },
    { label: 'Days since month end', align: 'right' }, { label: 'Collected', align: 'right' },
    { label: 'Where the settlement for this month came from' }]);
  const ageFirst = s;
  led.forEach((m, i) => {
    const mc = colLetter(firstMonthCol + i);
    S.getCell(s, 1).value = fmtMonth(m.month);
    S.getCell(s, 1).font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.ink } };
    S.getCell(s, 1).alignment = { indent: 1 };
    const out = S.getCell(s, 2);
    out.value = { formula: `Ledger!${mc}${at.closing}` };
    out.numFmt = MONEY;
    out.alignment = { horizontal: 'right' };
    out.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.ink } };
    asCalc(out);
    const age = money(S.getCell(s, 3), daysOld(m.month), { fmt: COUNT });
    age.note = `Counted from ${monthEnd(m.month).toLocaleDateString('en-IN')}, the last day of the month that raised these invoices.`;
    const pc = S.getCell(s, 4);
    pc.value = { formula: `IF(Ledger!${mc}${at.expected}=0,0,Ledger!${mc}${at.settled}/Ledger!${mc}${at.expected})` };
    pc.numFmt = PCT;
    pc.alignment = { horizontal: 'right' };
    pc.font = { name: 'Calibri', size: 10, color: { argb: C.ink } };
    asCalc(pc);
    const from = S.getCell(s, 5);
    const unified = srcKind[m.month] === 'unified';
    from.value = unified ? 'Unified transaction report — the raw ledgers are past Amazon’s 90-day window, and it merges fee columns'
                         : 'Retained settlement ledgers';
    from.font = { name: 'Calibri', size: 9, color: { argb: unified ? C.warnFg : C.muted } };
    from.alignment = { wrapText: true, vertical: 'middle', indent: 1 };
    if (unified) fill(from, C.warnBg);
    S.getRow(s).height = 20;
    s += 1;
  });
  /* over thirty days stops being Amazon's weekly cycle and starts being a question */
  if (led.length) {
    S.addConditionalFormatting({
      ref: `C${ageFirst}:C${s - 1}`,
      rules: [
        { type: 'cellIs', operator: 'greaterThan', formulae: ['60'], priority: 1,
          style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: C.dangerBg } },
                   font: { color: { argb: C.dangerFg }, bold: true } } },
        { type: 'cellIs', operator: 'greaterThan', formulae: ['30'], priority: 2,
          style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: C.warnBg } },
                   font: { color: { argb: C.warnFg }, bold: true } } },
      ],
    });
  }

  /* ── how to read it, and the legend ───────────────────────────────────── */
  s += 1;
  s = sectionBand(S, s, 5, 'HOW TO READ THIS WORKBOOK');
  const notes = [
    ['The base is the MTR invoice value',
      'The MTR is the tax invoice actually issued to the customer, so it is what a receivable is held against. The order report is higher — it still carries orders that never shipped. The settlement is lower — it is Amazon’s own figure, net of refunds and excluding GST. Neither is the right base.'],
    ['GST is not a deduction',
      'Amazon collects the full invoice from the buyer and pays the GST across to you; you remit it onward. It is carried as a memo line, never as something Amazon kept. Treating it as a deduction turns every closing balance negative. TDS 194-O and TCS, by contrast, really are withheld.'],
    ['Each month is a cohort, not a cash period',
      '“June” means June’s invoices — what they were billed and what has since arrived against them, whenever it arrived. Netting June’s dues against cash that merely landed in June would count May’s receipts as June’s, which is not what a receivable means.'],
    ['Blue cells are calculated',
      'Any cell with a pale blue fill was worked out by this report. Click one and the formula bar shows the arithmetic. Everything else is read straight out of one of Amazon’s three files — change an input and the blue cells follow.'],
    ['Every amount has a note',
      'Hover any figure (the small red corner marker) for the file, the column and the filter behind it. An explanation that lives in a covering email is one nobody has six months later.'],
  ];
  for (const [h, b] of notes) {
    const hc = S.getCell(s, 1);
    hc.value = h;
    hc.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.brand } };
    hc.alignment = { vertical: 'top', wrapText: true, indent: 1 };
    S.mergeCells(s, 2, s, 5);
    const bc = S.getCell(s, 2);
    bc.value = b;
    bc.font = { name: 'Calibri', size: 9.5, color: { argb: C.body } };
    bc.alignment = { vertical: 'top', wrapText: true, indent: 1 };
    S.getRow(s).height = 46;
    for (let c = 1; c <= 5; c++) S.getCell(s, c).border = { bottom: border(C.rule) };
    s += 1;
  }

  s += 1;
  s = sectionBand(S, s, 5, 'THE THREE FILES, AND THEIR COLOUR THROUGHOUT');
  const srcNotes = [
    ['Order report', 'Pulled from Amazon SP-API (all orders by order date). The only file that knows an order was cancelled — which is why this reconciliation needs three legs and not two.'],
    ['MTR', 'The Merchant Tax Report, B2B + B2C, uploaded from Seller Central. The tax invoice actually issued to the customer, and the base for this report.'],
    ['Settlement', 'Amazon’s settlement ledgers, or the unified transaction report where the ledgers have aged past the 90-day window. What Amazon actually paid.'],
    ['Derived', 'Arithmetic on the lines above. No file of its own — it is the subtraction, not a source.'],
  ];
  for (const [n, b] of srcNotes) {
    sourceChip(S.getCell(s, 1), n);
    S.getCell(s, 1).alignment = { horizontal: 'left', indent: 1, vertical: 'middle' };
    S.mergeCells(s, 2, s, 5);
    const bc = S.getCell(s, 2);
    bc.value = b;
    bc.font = { name: 'Calibri', size: 9.5, color: { argb: C.body } };
    bc.alignment = { vertical: 'middle', wrapText: true, indent: 1 };
    S.getRow(s).height = 30;
    s += 1;
  }

  /* ── 3. the chain ─────────────────────────────────────────────────────── */
  const CH = wb.addWorksheet('Chain', { views: [{ state: 'frozen', ySplit: 5 }] });
  CH.columns = [{ width: 16 }, { width: 15 }, { width: 14 }, { width: 14 }, { width: 16 },
                { width: 13 }, { width: 15 }, { width: 18 }, { width: 18 }];
  let ch = titleBand(CH, 1, 9, 'THE CHAIN — ORDER REPORT → MTR → SETTLEMENT',
    `${brand}   ·   ${period}   ·   counts of ORDERS, not money`);
  ch += 1;
  ch = sectionBand(CH, ch, 9, 'THE THREE POPULATIONS ARE NOT MEANT TO BE EQUAL',
    'placed − cancelled = net · net − not-invoiced = shipped · shipped − not-settled = settled. Every subtraction names a countable group; nothing is a balancing figure.');
  const chHead = ch;
  ch = headerRow(CH, ch, [
    { label: 'Month' },
    { label: 'Orders placed', align: 'right', note: 'Order report · amazon-order-id, folded to one row per order.' },
    { label: 'Cancelled', align: 'right', note: 'Order report · order-status = Cancelled on every line of the order.\n\nOnly this file knows. The MTR omits a cancelled order (never invoiced) and so does the settlement (never paid) — two files that both correctly omit the same orders can never explain the gap.' },
    { label: 'Net orders', align: 'right', note: 'CALCULATED: placed − cancelled.' },
    { label: 'Invoiced (MTR)', align: 'right', note: 'MTR · the order has at least one Shipment row.' },
    { label: 'Settled', align: 'right', note: 'Settlement · the order appears in any settlement, in any month.\n\n“Settled” means it HAS been paid, not “was paid inside this window” — the window decides scope, not whether money arrived.' },
    { label: 'Unsettled', align: 'right', note: 'CALCULATED: net − settled.' },
    { label: 'Net order value', align: 'right' },
    { label: 'Unsettled value', align: 'right' },
  ]);
  const chFirst = ch;
  chain.forEach((m) => {
    CH.getCell(ch, 1).value = fmtMonth(m.month);
    CH.getCell(ch, 1).font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.ink } };
    CH.getCell(ch, 1).alignment = { indent: 1 };
    money(CH.getCell(ch, 2), m.placed, { fmt: COUNT });
    money(CH.getCell(ch, 3), m.cancelled, { fmt: COUNT }).font =
      { name: 'Calibri', size: 10, color: { argb: C.warnFg } };
    const net = CH.getCell(ch, 4);
    net.value = { formula: `B${ch}-C${ch}` };
    net.numFmt = COUNT; net.alignment = { horizontal: 'right' };
    net.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.ink } };
    asCalc(net);
    money(CH.getCell(ch, 5), m.shipped, { fmt: COUNT });
    money(CH.getCell(ch, 6), m.settled, { fmt: COUNT }).font =
      { name: 'Calibri', size: 10, color: { argb: C.goodFg } };
    const un = CH.getCell(ch, 7);
    un.value = { formula: `D${ch}-F${ch}` };
    un.numFmt = COUNT; un.alignment = { horizontal: 'right' };
    un.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.dangerFg } };
    asCalc(un);
    money(CH.getCell(ch, 8), m.valueNet);
    money(CH.getCell(ch, 9), m.valueUnsettled);
    CH.getRow(ch).height = 19;
    ch += 1;
  });
  /* a total row that is a real total */
  for (let c = 2; c <= 9; c++) {
    const cell = CH.getCell(ch, c);
    cell.value = { formula: `SUM(${colLetter(c)}${chFirst}:${colLetter(c)}${ch - 1})` };
    cell.numFmt = c >= 8 ? MONEY : COUNT;
    cell.alignment = { horizontal: 'right' };
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.paper } };
    fill(cell, C.inkSoft);
  }
  CH.getCell(ch, 1).value = 'Total';
  CH.getCell(ch, 1).font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.paper } };
  CH.getCell(ch, 1).alignment = { indent: 1 };
  fill(CH.getCell(ch, 1), C.inkSoft);

  ch += 2;
  ch = sectionBand(CH, ch, 9, 'WHICH FILE EACH COLUMN COMES FROM');
  ['', 'Order report', 'Order report', 'Derived', 'MTR', 'Settlement', 'Derived', 'Order report', 'Order report']
    .forEach((n, i) => { if (n) sourceChip(CH.getCell(ch, i + 1), n); });

  /* ── 4. where every order ended up ────────────────────────────────────── */
  const W = wb.addWorksheet('Where orders ended up', { views: [{ state: 'frozen', ySplit: 5 }] });
  W.columns = [{ width: 30 }, ...ms.flatMap(() => [{ width: 14 }, { width: 18 }]),
               { width: 14 }, { width: 18 }];
  const wSpan = 1 + nMon * 2 + 2;
  let w = titleBand(W, 1, wSpan, 'WHERE EVERY ORDER ENDED UP',
    `${brand}   ·   ${period}   ·   each order is in exactly one row`);
  w += 1;
  w = sectionBand(W, w, wSpan, 'NOTHING CAN HIDE BETWEEN THESE ROWS',
    'the statuses are exclusive and exhaustive, so they sum to the orders invoiced');
  w = headerRow(W, w, [
    { label: 'Status' },
    ...ms.flatMap((m) => [{ label: `${fmtMonth(m)}\norders`, align: 'right' },
                          { label: `${fmtMonth(m)}\ninvoice value`, align: 'right' }]),
    { label: 'Total\norders', align: 'right' }, { label: 'Total\nvalue', align: 'right' },
  ]);
  const STATUS_NOTE = {
    'Not an Amazon sale (MCF)': 'Multi-channel fulfilment: Amazon SHIPPED it but did not SELL it — the order came from another channel. There is no Amazon invoice and there never will be a settlement, so chasing it as a receivable makes Amazon look like it owes money it never collected.',
    'Settled in the month': 'Invoiced and paid inside the same month.',
    'Settled in a later month': 'Invoiced in this month, paid in a later one. This is Amazon’s weekly cycle, not a problem.',
    'Returned / refunded': 'The order carries a refund, in the MTR or in the settlement.',
    Cancelled: 'Cancelled before it shipped — never invoiced, never paid, and excluded from the money lines.',
    Outstanding: 'No settlement row at all. Distinct from the arithmetic shortfall, which is mostly part-settlements.',
  };
  const wFirst = w;
  (led[0]?.byStatus || []).forEach((b, idx) => {
    const lab = W.getCell(w, 1);
    lab.value = b.status;
    lab.font = { name: 'Calibri', size: 10, color: { argb: C.ink } };
    lab.alignment = { indent: 1, vertical: 'middle' };
    if (STATUS_NOTE[b.status]) lab.note = STATUS_NOTE[b.status];
    led.forEach((m, i) => {
      const g = m.byStatus.find((x) => x.status === b.status) || { count: 0, amount: 0 };
      money(W.getCell(w, 2 + i * 2), g.count, { fmt: COUNT });
      money(W.getCell(w, 3 + i * 2), g.amount).font =
        { name: 'Calibri', size: 9.5, color: { argb: C.muted } };
    });
    const cTot = W.getCell(w, wSpan - 1);
    cTot.value = { formula: ms.map((m, i) => `${colLetter(2 + i * 2)}${w}`).join('+') };
    cTot.numFmt = COUNT; cTot.alignment = { horizontal: 'right' };
    cTot.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.ink } };
    asCalc(cTot);
    const vTot = W.getCell(w, wSpan);
    vTot.value = { formula: ms.map((m, i) => `${colLetter(3 + i * 2)}${w}`).join('+') };
    vTot.numFmt = MONEY; vTot.alignment = { horizontal: 'right' };
    vTot.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.ink } };
    asCalc(vTot);
    if (idx % 2) for (let c = 1; c <= wSpan; c++) {
      const cell = W.getCell(w, c);
      if (cell.fill?.fgColor?.argb !== C.calcBg) fill(cell, C.zebra);
    }
    W.getRow(w).height = 19;
    w += 1;
  });
  for (let c = 2; c <= wSpan; c++) {
    const cell = W.getCell(w, c);
    cell.value = { formula: `SUM(${colLetter(c)}${wFirst}:${colLetter(c)}${w - 1})` };
    cell.numFmt = c % 2 ? MONEY : COUNT;
    cell.alignment = { horizontal: 'right' };
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.paper } };
    fill(cell, C.inkSoft);
  }
  W.getCell(w, 1).value = 'Every order';
  W.getCell(w, 1).font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.paper } };
  W.getCell(w, 1).alignment = { indent: 1 };
  fill(W.getCell(w, 1), C.inkSoft);

  /* ── 5. what needs attention ──────────────────────────────────────────── */
  const I = wb.addWorksheet('What needs attention', { views: [{ state: 'frozen', ySplit: 5 }] });
  I.columns = [{ width: 13 }, { width: 12 }, { width: 46 }, { width: 16 },
               { width: 54 }, { width: 54 }, { width: 54 }];
  let iq = titleBand(I, 1, 7, 'WHAT NEEDS ATTENTION',
    `${brand}   ·   ${period}   ·   ${payload.audit?.verdict || ''}`);
  iq += 1;
  iq = sectionBand(I, iq, 7, 'NOTHING HERE IS PLUGGED',
    'where a figure cannot be explained it says so, and names the orders behind it');
  iq = headerRow(I, iq, [{ label: 'Month' }, { label: 'Severity' }, { label: 'Issue' },
    { label: 'Amount', align: 'right' }, { label: 'What it is' }, { label: 'Why it happens' },
    { label: 'How to resolve it' }]);
  const SEV = { blocker: [C.dangerBg, C.dangerFg], warning: [C.warnBg, C.warnFg], info: [C.infoBg, C.infoFg] };
  for (const is of issues) {
    const [bg, fg] = SEV[is.severity] || [C.zebra, C.body];
    const vals = [fmtMonth(is.month) || '—', (is.severity || '').toUpperCase(), is.title, is.amount,
                  is.what, is.why, is.howToFix];
    vals.forEach((v, i) => {
      const cell = I.getCell(iq, i + 1);
      cell.value = v;
      if (i === 3) { cell.numFmt = MONEY; cell.alignment = { horizontal: 'right', vertical: 'top' }; }
      else cell.alignment = { vertical: 'top', wrapText: true, indent: 1 };
      cell.font = { name: 'Calibri', size: 9.5, bold: i <= 2,
                    color: { argb: i <= 3 ? fg : C.body } };
      fill(cell, bg);
      cell.border = { bottom: border(C.rule) };
    });
    I.getRow(iq).height = 72;
    iq += 1;
  }
  if (!issues.length) {
    I.mergeCells(iq, 1, iq, 7);
    const c = I.getCell(iq, 1);
    c.value = 'Every month in this period reconciles within tolerance. Nothing to chase.';
    c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.goodFg } };
    fill(c, C.goodBg);
    c.alignment = { indent: 1, vertical: 'middle' };
    I.getRow(iq).height = 26;
  }

  /* ── 6 & 7. the detail, where an accountant will actually filter ──────── */
  const detail = (name, title, subtitle, cols, data) => {
    const D = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 5 }] });
    D.columns = cols.map((c) => ({ width: c.width }));
    let d = titleBand(D, 1, cols.length, title, subtitle);
    d += 1;
    d = sectionBand(D, d, cols.length, 'FILTER, SORT AND TOTAL THIS FREELY',
      'the header row is frozen and filtered; every figure above can be traced to a row here');
    const hdr = d;
    d = headerRow(D, d, cols.map((c) => ({ label: c.label, align: c.money || c.count ? 'right' : 'left', note: c.note })));
    const first = d;
    data.forEach((row, idx) => {
      cols.forEach((c, i) => {
        const cell = D.getCell(d, i + 1);
        const v = c.get(row);
        cell.value = v;
        if (c.money) { cell.numFmt = MONEY; cell.alignment = { horizontal: 'right' }; }
        else if (c.count) { cell.numFmt = COUNT; cell.alignment = { horizontal: 'right' }; }
        else cell.alignment = { indent: 1 };
        cell.font = { name: c.mono ? 'Consolas' : 'Calibri', size: 9.5,
                      color: { argb: c.muted ? C.muted : C.ink } };
        if (idx % 2) fill(cell, C.zebra);
      });
      d += 1;
    });
    /* a totals strip that recalculates with any filter applied */
    cols.forEach((c, i) => {
      const cell = D.getCell(d, i + 1);
      if (c.money || c.count) {
        cell.value = { formula: `SUBTOTAL(109,${colLetter(i + 1)}${first}:${colLetter(i + 1)}${d - 1})` };
        cell.numFmt = c.money ? MONEY : COUNT;
        cell.alignment = { horizontal: 'right' };
        cell.note = 'SUBTOTAL, so this follows whatever filter you apply to the columns above.';
      } else if (i === 0) {
        cell.value = `${data.length} orders`;
        cell.alignment = { indent: 1 };
      }
      cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.paper } };
      fill(cell, C.inkSoft);
    });
    D.autoFilter = { from: { row: hdr, column: 1 }, to: { row: d - 1, column: cols.length } };
    return D;
  };

  detail('Orders', 'ORDER-LEVEL DETAIL',
    `${brand}   ·   ${period}   ·   invoiced from the MTR, fees / TDS / received from the settlement`,
    [
      { label: 'Order ID', width: 22, mono: true, get: (r) => r.orderId },
      { label: 'Month invoiced', width: 15, get: (r) => fmtMonth(r.month),
        note: 'The month the MTR INVOICED it — that is when it became a receivable — falling back to the month it was placed where the MTR carries no date.' },
      { label: 'Status', width: 24, get: (r) => r.status },
      { label: 'Invoiced', width: 14, money: true, get: (r) => r.invoiced },
      { label: 'Returned', width: 13, money: true, get: (r) => r.refunded },
      { label: 'GST within', width: 13, money: true, muted: true, get: (r) => r.gst,
        note: 'A memo. Amazon pays this across to you with the money; you remit it onward.' },
      { label: 'Amazon fees', width: 13, money: true, get: (r) => r.fees },
      { label: 'TDS / TCS', width: 12, money: true, get: (r) => r.tdsTcs },
      { label: 'Received', width: 14, money: true, get: (r) => r.settled },
      { label: 'Settled in', width: 13, get: (r) => (r.settledMonth ? fmtMonth(r.settledMonth) : '—') },
    ], rows);

  if (chainRows.length) {
    detail('Chain orders', 'EVERY ORDER THE CHAIN COUNTS',
      `${brand}   ·   ${period}   ·   with the flag each of the three files contributed`,
      [
        { label: 'Order ID', width: 22, mono: true, get: (r) => r.orderId },
        { label: 'Month placed', width: 15, get: (r) => fmtMonth(r.month) },
        { label: 'Order status', width: 24, get: (r) => r.status, note: 'Order report · order-status.' },
        { label: 'Cancelled', width: 11, get: (r) => (r.cancelled ? 'Yes' : 'No') },
        { label: 'In MTR', width: 10, get: (r) => (r.invoiced ? 'Yes' : 'No'), note: 'The order has at least one Shipment row in the MTR.' },
        { label: 'Settled', width: 10, get: (r) => (r.settled ? 'Yes' : 'No'), note: 'The order appears in a settlement — in any month, not only this window.' },
        { label: 'Order value', width: 15, money: true, get: (r) => r.value,
          note: 'Order report · item-price + item-tax, excluding cancelled lines. NOT the invoice value — that is on the Orders sheet.' },
        { label: 'Lines', width: 8, count: true, get: (r) => r.lines },
        { label: 'Ship state', width: 16, get: (r) => r.shipState || '—' },
      ], chainRows);
  }

  /* The cover belongs in front, and the detail at the back. `wb.worksheets` is
     a sorted COPY, so splicing it reorders nothing — only orderNo does. */
  ['Report', 'Ledger', 'Chain', 'Where orders ended up', 'What needs attention',
   'Orders', 'Chain orders'].forEach((name, i) => {
    const sheet = wb.getWorksheet(name);
    if (sheet) sheet.orderNo = i + 1;
  });

  return wb;
}

/* ── one drilled group, formatted the same way ───────────────────────────────
   The page can derive which orders sit behind a figure; it cannot format them.
   So it sends the rows and what they are, and the same palette, the same
   provenance block and the same filtered SUBTOTAL strip come back — rather
   than a second, cheaper-looking file escaping by a different door. */
function buildDrillWorkbook({ title, period, brand, provenance = {}, columns = [], rows = [] }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Colonel · agent.accountant';
  wb.created = new Date();
  const D = wb.addWorksheet('Orders', { views: [{ state: 'frozen', ySplit: 11 }] });
  const n = Math.max(columns.length, 4);
  D.columns = columns.map((c) => ({ width: c.width || (c.money || c.count ? 15 : 20) }));

  let r = titleBand(D, 1, n, String(title || 'Amazon Receivables').toUpperCase(),
    `${brand}   ·   ${period}   ·   ${rows.length.toLocaleString('en-IN')} orders   ·   generated ${new Date().toLocaleString('en-IN')}`);
  r += 1;

  /* WHERE THIS COMES FROM, before the rows — the first question about any
     figure is which of the three files to open to check it. */
  r = sectionBand(D, r, n, 'WHERE THIS COMES FROM');
  const facts = [
    ['Source file', provenance.file || '—'],
    ['Column', provenance.column || '—'],
    ['Filter', provenance.filter || 'all rows in the period'],
    ['Dated by', provenance.dated || '—'],
    ['Note', provenance.note || ''],
  ];
  for (const [k, v] of facts) {
    const key = D.getCell(r, 1);
    key.value = k;
    key.font = { name: 'Calibri', size: 9, bold: true, color: { argb: C.muted } };
    key.alignment = { indent: 1, vertical: 'top' };
    D.mergeCells(r, 2, r, n);
    const val = D.getCell(r, 2);
    val.value = v;
    val.font = { name: 'Calibri', size: 9.5,
                 color: { argb: FILE_TONE[provenance.file] || C.body }, bold: k === 'Source file' };
    val.alignment = { indent: 1, vertical: 'top', wrapText: true };
    D.getRow(r).height = k === 'Note' ? 30 : 16;
    r += 1;
  }
  r += 1;

  const hdr = r;
  r = headerRow(D, r, columns.map((c) => ({ label: c.label, align: c.money || c.count ? 'right' : 'left' })));
  const first = r;
  rows.forEach((row, idx) => {
    columns.forEach((c, i) => {
      const cell = D.getCell(r, i + 1);
      cell.value = row[c.key] === undefined || row[c.key] === null || row[c.key] === '' ? '—' : row[c.key];
      if (c.money) { cell.numFmt = MONEY; cell.alignment = { horizontal: 'right' }; }
      else if (c.count) { cell.numFmt = COUNT; cell.alignment = { horizontal: 'right' }; }
      else cell.alignment = { indent: 1 };
      cell.font = { name: c.mono ? 'Consolas' : 'Calibri', size: 9.5, color: { argb: C.ink } };
      if (idx % 2) fill(cell, C.zebra);
    });
    r += 1;
  });
  columns.forEach((c, i) => {
    const cell = D.getCell(r, i + 1);
    if (c.money || c.count) {
      cell.value = { formula: `SUBTOTAL(109,${colLetter(i + 1)}${first}:${colLetter(i + 1)}${r - 1})` };
      cell.numFmt = c.money ? MONEY : COUNT;
      cell.alignment = { horizontal: 'right' };
      cell.note = 'SUBTOTAL, so this follows whatever filter you apply above.';
    } else if (i === 0) {
      cell.value = `${rows.length} orders`;
      cell.alignment = { indent: 1 };
    }
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: C.paper } };
    fill(cell, C.inkSoft);
  });
  if (rows.length) D.autoFilter = { from: { row: hdr, column: 1 }, to: { row: r - 1, column: columns.length } };
  return wb;
}

module.exports = { buildWorkbook, buildDrillWorkbook, fmtMonth, rangeLabel };

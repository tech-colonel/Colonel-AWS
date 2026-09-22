/* ──────────────────────────────────────────────────────────────────────────────
   amazonSettlementSummary.js — the Summary tab for a settlement workbook,
   laid out like the Myntra reconciliation the accountants already read.

   Myntra's summary answers one question: we expected X, we received Y, why the
   difference? This does the same for Amazon, with the fee block broken out by
   type because Amazon charges several kinds of fee where Myntra charges three.

   FORMULAS, NOT VALUES. Myntra's sheet computes its percentages and totals in
   Excel (=B7/$B$5, =B13-B12, =SUM(B21:B27)), so an accountant can click a cell
   and see how it was derived, and can edit an input and watch the rest move.
   We write the same: only figures that come from Amazon are hard values; every
   ratio, subtotal and difference is a live formula.

   WHERE THE NUMBERS COME FROM. The wide rows the agent stores have already
   merged Amazon's fee labels into three columns, which is too coarse to show
   commission separately from closing fee. So the breakdown is computed from the
   RAW LEDGER — the same file the pivot reads — where every fee keeps its own
   label and its GST sits on its own line.
   ────────────────────────────────────────────────────────────────────────────── */

const has = (s, ...needles) => {
  const t = String(s || '').toLowerCase();
  return needles.some((n) => t.includes(n));
};

const r2 = (n) => Number((n || 0).toFixed(2));

/* GST on a fee arrives as its own ledger line — "Fixed closing fee IGST" next
   to "Fixed closing fee". Keeping the two apart matters: TDS applies to the
   taxable value, and the GST half is input credit, not a cost. */
function isFeeTax(desc) {
  return /\b(c|s|i)gst\b/i.test(String(desc || '')) || has(desc, 'gst');
}

/**
 * Which fee line of the summary does this ledger row belong to?
 * Returns null when the row is not a fee at all (sales, tax withheld, refunds).
 */
function feeGroup(amountType, amountDescription) {
  const type = String(amountType || '');
  const desc = String(amountDescription || '');

  if (has(type, 'debt') || has(desc, 'debt adjustment')) return null;      // handled separately
  if (has(type, 'itemtcs', 'itemtds')) return null;                        // withheld taxes
  if (has(type, 'itemprice', 'promotion')) return null;                    // revenue side

  const isFee = has(type, 'itemfees', 'fee', 'amazon fees', 'servicefee', 'cost of advertising');
  if (!isFee) return null;

  if (isFeeTax(desc)) return 'gstOnFees';

  /* Amazon splits the label across two columns inconsistently: a closing fee
     is fully described in amount-description, whereas storage arrives as
     amount-type "FBA Inventory Storage Fee" with amount-description "Base fee".
     Matching description alone put storage into Other Charges. */
  const label = `${type} ${desc}`;
  if (has(label, 'advertis')) return 'advertising';
  if (has(label, 'storage')) return 'storage';
  if (has(label, 'weight handling', 'pick & pack', 'pick and pack', 'easy ship', 'shipping chargeback', 'fba'))
    return 'logistics';
  if (has(label, 'fixed closing', 'closing fee')) return 'fixedFee';
  if (has(label, 'commission', 'referral')) return 'commission';
  return 'otherCharges';
}

/**
 * Fold a settlement's ledger into the figures the summary needs.
 * Amounts are returned POSITIVE for fees (they read as deductions in the sheet,
 * exactly as Myntra presents them) and signed for everything else.
 */
function collect(ledgerRows) {
  const f = { commission: 0, fixedFee: 0, logistics: 0, storage: 0, advertising: 0, otherCharges: 0, gstOnFees: 0 };
  let productSales = 0, shipping = 0, promotions = 0, gstCollected = 0;
  let tds = 0, tcs = 0, debtAdjustment = 0;
  const byType = new Map();              // Order / Refund / Cancellation → { orders:Set, amount }
  const orders = new Set();

  for (const row of ledgerRows) {
    const txn = String(row['transaction-type'] || '').trim();

    /* The header line is the one carrying `total-amount` and nothing else.
       Skipping every row with a blank transaction-type instead — which is what
       this did first — silently swallowed whole settlements: Amazon bills FBA
       storage as a standalone `FBAFees` row with no transaction type at all,
       and one settlement consisted of nothing but those. */
    const isHeader = !txn && !row['amount-type'] && row['total-amount'] !== '' && row['total-amount'] != null;
    if (isHeader) continue;
    const amt = Number(row['amount'] || 0) || 0;
    const type = row['amount-type'], desc = row['amount-description'];

    const label = txn || String(row['amount-type'] || 'Other').trim();
    const bucket = byType.get(label) || { orders: new Set(), amount: 0 };
    bucket.amount += amt;
    if (row['order-id']) bucket.orders.add(row['order-id']);
    byType.set(label, bucket);
    if (row['order-id']) orders.add(row['order-id']);

    /* A debt recovery appears as a PAIR: "Payable to Amazon" (the charge) and
       "Debt adjustment against …" (the credit clearing it). Counting one leg
       and not the other leaves the settlement out by exactly that amount. */
    if (has(type, 'debt') || has(desc, 'debt adjustment') || has(desc, 'payable to amazon')) {
      debtAdjustment += amt;
      continue;
    }
    if (has(type, 'itemtds') || has(desc, '194-o', '194o')) { tds += amt; continue; }
    if (has(type, 'itemtcs') || has(desc, 'tcs-')) { tcs += amt; continue; }

    if (has(type, 'promotion') || has(desc, 'discount')) { promotions += amt; continue; }
    if (has(type, 'itemprice')) {
      if (has(desc, 'tax')) gstCollected += amt;
      else if (has(desc, 'shipping')) shipping += amt;
      else productSales += amt;
      continue;
    }

    const g = feeGroup(type, desc);
    if (g) f[g] += amt;
  }

  // Fees are negative in the ledger; the sheet lists them as positive deductions.
  for (const k of Object.keys(f)) f[k] = r2(Math.abs(f[k]));

  return {
    orders: orders.size,
    productSales: r2(productSales),
    shipping: r2(shipping),
    promotions: r2(promotions),
    gstCollected: r2(gstCollected),
    fees: f,
    tds: r2(Math.abs(tds)),
    tcs: r2(Math.abs(tcs)),
    debtAdjustment: r2(debtAdjustment),
    byType: [...byType.entries()].map(([label, v]) => ({ label, orders: v.orders.size, amount: r2(v.amount) })),
  };
}

/**
 * Build the Summary sheet as rows of cells, with formulas where Myntra has
 * formulas. Returns { aoa, merges, colWidths } ready for XLSX.
 *
 * Row numbers are tracked as we go rather than hardcoded, so inserting a line
 * later cannot silently break a formula that pointed at the old position.
 */
function buildSummaryAoA(ledgerRows, settlement) {
  const d = collect(ledgerRows);
  const aoa = [];

  /* ── cell helpers ────────────────────────────────────────────────────────
     Two things every cell here needs:

     A TYPE. A cell written as a bare { f } is SILENTLY DROPPED when the
     workbook is saved — SheetJS needs a type to emit it, and the reader then
     sees an empty cell where a formula should be. Every formula carries t:'n'
     and a placeholder v, which Excel overwrites on recalculation.

     A NUMBER FORMAT. Without one a ratio renders as 0.0491316547278 instead of
     4.91%, which is unreadable and makes the sheet look broken. Amounts use
     Indian lakh/crore grouping — 1,56,047.65, not 156,047.65 — because that is
     how the figures will be read and checked. */
  const FMT_PCT = '0.00%';
  const FMT_INT = '#,##0';
  /* Indian lakh grouping (1,59,387.06) was the obvious choice for this audience
     and does not survive: the format needs literal \, placeholders, which emit a
     stray comma when a number is too short (",,101.70"), and every conditional
     variant that fixes THAT drops the minus sign on small negatives — rendering
     a -4,357.66 refund as 4,357.66. A wrong sign in a settlement is far worse
     than international grouping, so this stays plain, with an explicit negative
     section. Verified against the format engine across positive, negative, zero
     and lakh/crore values. */
  const FMT_AMT = '#,##0.00;-#,##0.00';

  const F  = (formula, z) => ({ t: 'n', v: 0, f: formula, ...(z ? { z } : {}) });
  const Fp = (formula) => F(formula, FMT_PCT);                       // formula, shown as a %
  const Fa = (formula) => F(formula, FMT_AMT);                       // formula, shown as money
  const A  = (v) => ({ t: 'n', v: Number(v) || 0, z: FMT_AMT });     // money
  const I  = (v) => ({ t: 'n', v: Number(v) || 0, z: FMT_INT });     // a count

  const push = (...cells) => {
    aoa.push(cells.map((c) => (c && typeof c === 'object' && c.f && c.t === undefined ? F(c.f) : c)));
    return aoa.length;
  };

  push('Particulars', 'Amount (₹)', '%');
  push('Total Orders', I(d.orders));

  /* ── what the customer paid ──────────────────────────────────────────────
     Every figure here is net of refunds and cancellations, because the ledger
     carries those as negative lines against the same categories. Stating the
     components separately is what lets the settlement below tie exactly — an
     "expected" that quietly omits shipping or promotions can never reconcile. */
  const rSales    = push('Total Seller Price (Net)', A(d.productSales));
  const rShipping = push('Shipping Charged', A(d.shipping),
                         Fp(`IFERROR(B${aoa.length + 1}/$B$${rSales},0)`));
  const rPromos   = push('Promotions / Discounts', A(d.promotions),
                         Fp(`IFERROR(B${aoa.length + 1}/$B$${rSales},0)`));
  const rGst      = push('GST Collected from Buyers', A(d.gstCollected),
                         Fp(`IFERROR(B${aoa.length + 1}/$B$${rSales},0)`));
  const rGross    = push('Total Seller Price With GST',
                         Fa(`B${rSales}+B${rShipping}+B${rPromos}+B${rGst}`));

  push();
  push('AMAZON FEES');
  const feeRows = {};
  const feeLines = [
    ['Commission',              'commission'],
    ['Fixed Fee',               'fixedFee'],
    ['Logistics / Fulfilment',  'logistics'],
    ['Storage Fee',             'storage'],
    ['Advertising',             'advertising'],
    ['Other Charges',           'otherCharges'],
    ['GST on Amazon Fees',      'gstOnFees'],
  ];
  for (const [label, key] of feeLines) {
    feeRows[key] = push(label, A(d.fees[key]), Fp(`IFERROR(B${aoa.length + 1}/$B$${rSales},0)`));
  }
  const rTotalFees = push('Total Amazon Fees',
                          Fa(`SUM(B${feeRows.commission}:B${feeRows.gstOnFees})`),
                          Fp(`IFERROR(B${aoa.length + 1}/$B$${rSales},0)`));

  push();
  push('WITHHELD TAXES');
  const rTds = push('TDS (Section 194-O)', A(d.tds), Fp(`IFERROR(B${aoa.length + 1}/$B$${rSales},0)`));
  const rTcs = push('TCS (CGST+SGST+IGST)', A(d.tcs), Fp(`IFERROR(B${aoa.length + 1}/$B$${rSales},0)`));

  /* ── reconciliation ──────────────────────────────────────────────────────
     Two independent checks, both of which must come to zero:
       1. what Amazon SHOULD have paid, built up from the components, against
          what Amazon says it paid;
       2. the payout split by transaction type, against the same figure.
     One catches a mis-read fee; the other catches a mis-read transaction. */
  push();
  push('RECONCILIATION');
  const rDebt     = push('Debt Adjustment (prior period)', A(d.debtAdjustment),
                         Fp(`IFERROR(B${aoa.length + 1}/$B$${rSales},0)`));
  const rExpected = push('Expected Settlement',
                         Fa(`B${rGross}-B${rTotalFees}-B${rTds}-B${rTcs}+B${rDebt}`));

  const headerTotal = settlement && settlement.total_amount != null ? Number(settlement.total_amount) : null;
  const rAmazon = push('Amazon stated payout', A(headerTotal),
                       Fp(`IFERROR(B${aoa.length + 1}/$B$${rSales},0)`));
  push('Difference (must be 0)', Fa(`ROUND(B${rExpected}-B${rAmazon},2)`));

  push();
  push('PAYOUT COMPOSITION');

  /* Every transaction label Amazon used, not a fixed list of four. Amazon adds
     types we have not seen before — `other-transaction` for a payable, a bare
     `FBAFees` row for standalone storage — and a hardcoded list silently drops
     them, leaving the payout short by exactly the amount it ignored. Listing
     whatever is actually in the file makes the total self-proving. */
  const NICE = { 'Order': 'Forward Settlement (Orders)', 'Refund': 'Reverse Settlement (Refunds)',
                 'Cancellation': 'Cancellations', 'Debt Adjustment': 'Debt Adjustment',
                 'other-transaction': 'Other Transactions', 'FBAFees': 'FBA Fees (non-order)' };
  const rank = ['Order', 'Refund', 'Cancellation', 'Debt Adjustment'];
  const comp = [...d.byType].sort((a, b) => {
    const ia = rank.indexOf(a.label), ib = rank.indexOf(b.label);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const rCompFirst = aoa.length + 1;
  for (const t of comp) {
    push(NICE[t.label] || t.label, A(t.amount), Fp(`IFERROR(B${aoa.length + 1}/$B$${rSales},0)`));
  }
  const rCompLast = aoa.length;
  const rNet = push('Net Settlement', Fa(`SUM(B${rCompFirst}:B${rCompLast})`),
                                      Fp(`IFERROR(B${aoa.length + 1}/$B$${rSales},0)`));
  push('Difference (must be 0)', Fa(`ROUND(B${rNet}-B${rAmazon},2)`));

  push();
  push('Status', 'No. of Orders', 'Amount (₹)', '%');
  const rStatusFirst = aoa.length + 1;
  const order = ['Order', 'Refund', 'Cancellation'];
  const sorted = [...d.byType].sort((a, b) => {
    const ia = order.indexOf(a.label), ib = order.indexOf(b.label);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const rGrand = rStatusFirst + sorted.length;
  for (const t of sorted) {
    push(t.label, I(t.orders), A(t.amount), Fp(`IFERROR(C${aoa.length + 1}/$C$${rGrand},0)`));
  }
  push('Grand Total', I(`SUM(B${rStatusFirst}:B${rGrand - 1})`),
                      Fa(`SUM(C${rStatusFirst}:C${rGrand - 1})`),
                      Fp(`IFERROR(C${rGrand}/$C$${rGrand},0)`));

  push();
  push('Settlement ID', settlement ? settlement.settlement_id : '');
  push('Period', settlement ? `${settlement.start_date || ''} → ${settlement.end_date || ''}` : '');
  push('Deposit date', settlement ? settlement.deposit_date || '' : '');

  /* The two differences are computed here, not read back from the formulas,
     so the styling can colour them by what they ACTUALLY are. A green "must be
     0" row that hasn't been checked is worse than no colour at all. */
  const totalFees = Object.values(d.fees).reduce((a, b) => a + b, 0);
  const grossAll  = d.productSales + d.shipping + d.promotions + d.gstCollected;
  const statedAmt = settlement && settlement.total_amount != null ? Number(settlement.total_amount) : 0;
  const checks = {
    recon:  r2(grossAll - totalFees - d.tds - d.tcs + d.debtAdjustment - statedAmt),
    payout: r2(d.byType.reduce((a, t) => a + t.amount, 0) - statedAmt),
  };

  return { aoa, checks, colWidths: [{ wch: 34 }, { wch: 16 }, { wch: 13 }, { wch: 11 }] };
}

/* ──────────────────────────────────────────────────────────────────────────────
   Styling. Written with xlsx-js-style, a SheetJS fork that actually emits cell
   styles — the stock community build silently drops them.

   The palette is deliberately quiet: this is a document an accountant checks
   figures in, not a dashboard. Colour is used only where it carries meaning —
   the two "must be 0" rows go green when they reconcile and red when they do
   not, which is the one thing a reader must never have to work out by squinting
   at a number.
   ────────────────────────────────────────────────────────────────────────────── */
const INK    = '1E3A57';   // column headers — deep slate
const CLAY   = 'B4633A';   // section bands — warm, reads as a divider not an alert
const CREAM  = 'FAF6F1';   // subtotal rows
const RULE   = 'E4DDD3';
const OK_BG  = 'E7F1EB';  const OK_FG  = '256B4A';
const BAD_BG = 'FBEBE9';  const BAD_FG = '9B2F2B';
const MUTED  = '6B6660';

const SECTIONS = new Set(['AMAZON FEES', 'WITHHELD TAXES', 'RECONCILIATION', 'PAYOUT COMPOSITION']);
const TOTALS   = new Set(['Total Seller Price With GST', 'Total Amazon Fees',
                          'Expected Settlement', 'Net Settlement', 'Grand Total']);
const FOOTER   = new Set(['Settlement ID', 'Period', 'Deposit date']);

const border = (sides, color = RULE) =>
  Object.fromEntries(sides.map((k) => [k, { style: 'thin', color: { rgb: color } }]));

function styleSummarySheet(ws, aoa, checks) {
  const width = Math.max(...aoa.map((r) => (r ? r.length : 0)), 4);
  const at = (r, c) => String.fromCharCode(65 + c) + (r + 1);
  const ensure = (addr) => (ws[addr] = ws[addr] || { t: 's', v: '' });

  aoa.forEach((row, r) => {
    const label = row && row[0] !== undefined && row[0] !== null ? String(row[0]) : '';
    const isHeaderRow = label === 'Particulars' || label === 'Status';
    const isSection   = SECTIONS.has(label);
    const isTotal     = TOTALS.has(label);
    const isCheck     = /must be 0/.test(label);
    const isFooter    = FOOTER.has(label);
    const isPayout    = label === 'Amazon stated payout';
    if (!label && !isHeaderRow) return;

    // which check does this row report on? they appear in order: recon, payout
    const checkVal = isCheck
      ? (aoa.slice(0, r).filter((x) => x && /must be 0/.test(String(x[0] || ''))).length === 0
          ? checks.recon : checks.payout)
      : null;
    const passed = isCheck ? Math.abs(checkVal) < 0.005 : false;

    for (let c = 0; c < width; c++) {
      const addr = at(r, c);
      if (!ws[addr] && !(isHeaderRow || isSection || isTotal || isCheck)) continue;
      ensure(addr);
      const cell = ws[addr];
      const base = { alignment: { vertical: 'center', horizontal: c === 0 ? 'left' : 'right' } };

      if (isHeaderRow) {
        cell.s = { ...base, font: { bold: true, sz: 11, color: { rgb: 'FFFFFF' } },
                   fill: { patternType: 'solid', fgColor: { rgb: INK } },
                   alignment: { ...base.alignment, horizontal: c === 0 ? 'left' : 'right' } };
      } else if (isSection) {
        cell.s = { ...base, font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } },
                   fill: { patternType: 'solid', fgColor: { rgb: CLAY } } };
      } else if (isCheck) {
        cell.s = { ...base, font: { bold: true, color: { rgb: passed ? OK_FG : BAD_FG } },
                   fill: { patternType: 'solid', fgColor: { rgb: passed ? OK_BG : BAD_BG } },
                   border: border(['top', 'bottom'], passed ? OK_FG : BAD_FG) };
        if (c === 0) cell.v = passed ? `${label}  ✓` : `${label}  ✗`;
      } else if (isTotal) {
        cell.s = { ...base, font: { bold: true },
                   fill: { patternType: 'solid', fgColor: { rgb: CREAM } },
                   border: border(['top']) };
      } else if (isPayout) {
        cell.s = { ...base, font: { bold: true } };
      } else if (isFooter) {
        cell.s = { ...base, font: { italic: true, sz: 9, color: { rgb: MUTED } },
                   alignment: { ...base.alignment, horizontal: 'left' } };
      } else {
        cell.s = { ...base, border: border(['bottom']) };
      }
    }
  });

  ws['!rows'] = aoa.map((row) => {
    const label = row && row[0] ? String(row[0]) : '';
    return SECTIONS.has(label) || label === 'Particulars' || label === 'Status'
      ? { hpt: 20 } : { hpt: 16 };
  });
  return ws;
}

module.exports = { buildSummaryAoA, styleSummarySheet, collect, feeGroup };


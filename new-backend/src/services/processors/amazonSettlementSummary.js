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

  /* A cell written as a bare { f } is SILENTLY DROPPED when the workbook is
     saved — SheetJS needs a type to emit it, and the reader then sees an empty
     cell where a formula should be. Every formula therefore carries t:'n' and a
     placeholder v, which Excel overwrites the moment it recalculates. */
  const F = (formula) => ({ t: 'n', v: 0, f: formula });
  const push = (...cells) => {
    aoa.push(cells.map((c) => (c && typeof c === 'object' && c.f && c.t === undefined ? F(c.f) : c)));
    return aoa.length;
  };

  push('Particulars', 'Amount (₹)', '%');
  push('Total Orders', d.orders);

  /* ── what the customer paid ──────────────────────────────────────────────
     Every figure here is net of refunds and cancellations, because the ledger
     carries those as negative lines against the same categories. Stating the
     components separately is what lets the settlement below tie exactly — an
     "expected" that quietly omits shipping or promotions can never reconcile. */
  const rSales    = push('Total Seller Price (Net)', d.productSales);
  const rShipping = push('Shipping Charged', d.shipping,
                         { f: `IFERROR(B${aoa.length + 1}/$B$${rSales},0)` });
  const rPromos   = push('Promotions / Discounts', d.promotions,
                         { f: `IFERROR(B${aoa.length + 1}/$B$${rSales},0)` });
  const rGst      = push('GST Collected from Buyers', d.gstCollected,
                         { f: `IFERROR(B${aoa.length + 1}/$B$${rSales},0)` });
  const rGross    = push('Total Seller Price With GST',
                         { f: `B${rSales}+B${rShipping}+B${rPromos}+B${rGst}` });

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
    feeRows[key] = push(label, d.fees[key], { f: `IFERROR(B${aoa.length + 1}/$B$${rSales},0)` });
  }
  const rTotalFees = push('Total Amazon Fees',
                          { f: `SUM(B${feeRows.commission}:B${feeRows.gstOnFees})` },
                          { f: `IFERROR(B${aoa.length + 1}/$B$${rSales},0)` });

  push();
  push('WITHHELD TAXES');
  const rTds = push('TDS (Section 194-O)', d.tds, { f: `IFERROR(B${aoa.length + 1}/$B$${rSales},0)` });
  const rTcs = push('TCS (CGST+SGST+IGST)', d.tcs, { f: `IFERROR(B${aoa.length + 1}/$B$${rSales},0)` });

  /* ── reconciliation ──────────────────────────────────────────────────────
     Two independent checks, both of which must come to zero:
       1. what Amazon SHOULD have paid, built up from the components, against
          what Amazon says it paid;
       2. the payout split by transaction type, against the same figure.
     One catches a mis-read fee; the other catches a mis-read transaction. */
  push();
  push('RECONCILIATION');
  const rDebt     = push('Debt Adjustment (prior period)', d.debtAdjustment,
                         { f: `IFERROR(B${aoa.length + 1}/$B$${rSales},0)` });
  const rExpected = push('Expected Settlement',
                         { f: `B${rGross}-B${rTotalFees}-B${rTds}-B${rTcs}+B${rDebt}` });

  const headerTotal = settlement && settlement.total_amount != null ? Number(settlement.total_amount) : null;
  const rAmazon = push('Amazon stated payout', headerTotal,
                       { f: `IFERROR(B${aoa.length + 1}/$B$${rSales},0)` });
  push('Difference (must be 0)', { f: `ROUND(B${rExpected}-B${rAmazon},2)` });

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
    push(NICE[t.label] || t.label, t.amount, { f: `IFERROR(B${aoa.length + 1}/$B$${rSales},0)` });
  }
  const rCompLast = aoa.length;
  const rNet = push('Net Settlement', { f: `SUM(B${rCompFirst}:B${rCompLast})` },
                                      { f: `IFERROR(B${aoa.length + 1}/$B$${rSales},0)` });
  push('Difference (must be 0)', { f: `ROUND(B${rNet}-B${rAmazon},2)` });

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
    push(t.label, t.orders, t.amount, { f: `IFERROR(C${aoa.length + 1}/$C$${rGrand},0)` });
  }
  push('Grand Total', { f: `SUM(B${rStatusFirst}:B${rGrand - 1})` },
                      { f: `SUM(C${rStatusFirst}:C${rGrand - 1})` },
                      { f: `IFERROR(C${rGrand}/$C$${rGrand},0)` });

  push();
  push('Settlement ID', settlement ? settlement.settlement_id : '');
  push('Period', settlement ? `${settlement.start_date || ''} → ${settlement.end_date || ''}` : '');
  push('Deposit date', settlement ? settlement.deposit_date || '' : '');

  return { aoa, colWidths: [{ wch: 34 }, { wch: 16 }, { wch: 14 }, { wch: 10 }] };
}

module.exports = { buildSummaryAoA, collect, feeGroup };

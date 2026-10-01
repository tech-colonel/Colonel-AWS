/* ──────────────────────────────────────────────────────────────────────────────
   amazonReceivablesLedger.js — a month-by-month receivables ledger for Amazon.

   THE QUESTION THIS ANSWERS. "In April I should have collected a lakh. I got
   seventy thousand. Ten is GST, Amazon took fifteen — where is the other five?"
   A reconciliation that only counts orders cannot answer that. This walks the
   money: what was invoiced, what the government took, what Amazon took, what
   actually arrived, and what is still owed.

   CARRY-FORWARD IS THE POINT. Amazon settles on its own weekly cycle, so the
   end of every month settles in the month after. Measured month by month in
   isolation, that looks like a hole in one month and a windfall in the next.
   Carried forward it is simply a balance: May closes owing 50,000, June opens
   owing 50,000, and June's receipts of 1.5 lakh against 1 lakh of sales stop
   looking like an error.

       opening outstanding        what last month closed owing
     + invoiced this month        MTR invoice value, INCLUDING GST
     − returns / refunds          money given back
     = net billable
     − Amazon fees                commission, closing, FBA, storage, GST on them
     − TDS 194-O and TCS          withheld at source by Amazon
     = expected to receive
     − settled                    what actually arrived
     = closing outstanding        becomes next month's opening

   GST IS NOT A DEDUCTION HERE, and getting that wrong turned every closing
   balance negative. Amazon collects the full invoice from the buyer and pays
   the GST across to the seller, who then remits it to the government. Proved on
   the July settlement, where the columns foot exactly:

       product sales 1,99,132.78 + GST 35,855.82 + shipping 67.80 − promo 80.00
       − fees 26,821.08 − TDS 211.53 − TCS 995.62  =  2,06,948.17 = stated total

   So GST ARRIVES with the money. It is carried as a memo line — how much of
   the receivable is tax you will owe onward — never as something Amazon kept.

   THE BASE IS THE MTR INVOICE VALUE, chosen deliberately: it is the document
   actually issued to the customer, it is the GST base, and cancelled orders are
   already out of it. The order report is higher (it still carries orders that
   never shipped) and the settlement is lower (Amazon's own figure, net of
   refunds, excluding GST) — neither is the right thing to hold a seller's
   receivable against.

   EVERY LINE CARRIES A COUNT AND AN AMOUNT, and every line can name its orders.
   A figure nobody can drill into is a figure nobody can defend.
   ────────────────────────────────────────────────────────────────────────────── */

const { monthKey, num, r2 } = require('./amazonThreeWay');

/* The closing state of an order. Exactly one applies, so the buckets sum to the
   order count and nothing can be counted twice or lost between them. */
const STATUS = {
  NOT_AMAZON: 'Not an Amazon sale (MCF)',
  SETTLED_IN_MONTH: 'Settled in the month',
  SETTLED_LATER: 'Settled in a later month',
  RETURNED: 'Returned / refunded',
  CANCELLED: 'Cancelled',
  OUTSTANDING: 'Outstanding',
};

/* ── fold each source to one record per order ─────────────────────────── */

function foldInvoiced(mtrRows) {
  const byOrder = new Map();
  for (const r of mtrRows) {
    const id = String(r['Order Id'] ?? r.order_id ?? '').trim();
    if (!id) continue;
    const txn = String(r['Transaction Type'] ?? r.txn ?? '').trim();
    const amt = num(r['Invoice Amount'] ?? r.amount);
    /* The B2C MTR leaves Shipment Date EMPTY on 1,443 of 1,998 shipment rows
       and carries Invoice Date instead. Reading only Shipment Date left the
       whole cohort without a month, which silently fell through to the order
       report's purchase date — a different thing entirely. Invoice Date is the
       right basis regardless: a receivable dates from the invoice. */
    const when = r['Invoice Date'] || r['Shipment Date'] || r.ship_date
               || r['Order Date'] || r.file_month || '';
    let o = byOrder.get(id);
    if (!o) o = { id, month: '', invoiced: 0, refunded: 0, gst: 0, shipped: false }, byOrder.set(id, o);
    if (txn === 'Shipment') {
      o.shipped = true;
      o.invoiced += amt;
      o.month = o.month || monthKey(when) || monthKey(r.file_month);
      /* The MTR states the tax both ways: one total, and split across the
         heads. Prefer the stated total — it is what the invoice shows — and
         fall back to summing the heads only when it is absent. */
      const stated = num(r['Total Tax Amount'] ?? r.total_tax);
      o.gst += stated || (num(r['Cgst Tax']) + num(r['Sgst Tax'])
                        + num(r['Igst Tax']) + num(r['Utgst Tax']));
    } else if (txn === 'Refund') {
      /* refunds are negative in the MTR; hold them positive as a deduction */
      o.refunded += Math.abs(amt);
    }
  }
  for (const o of byOrder.values()) {
    o.invoiced = r2(o.invoiced); o.refunded = r2(o.refunded); o.gst = r2(o.gst);
  }
  return byOrder;
}

function foldSettled(settlementRows) {
  const byOrder = new Map();
  /* ── the same transaction can arrive from two sources ──────────────────
     A settlement period straddles a month end, so its rows appear BOTH in an
     uploaded unified transaction report (which covers a calendar month) and in
     the retained ledger for that settlement. Merging the two naively counted
     223 June orders twice — one was invoiced 1,388 and showed 2,521 received,
     which is how a month ends up collecting more than it billed.

     A row is the same transaction when the order, the type and both amounts
     match. That is specific enough that two genuinely separate movements on one
     order — a payment and a later refund — are still counted separately. */
  const seen = new Set();
  for (const r of settlementRows) {
    const id = String(r.order_id ?? r['order id'] ?? r['order-id'] ?? '').trim();
    if (!id) continue;
    const sig = [id, String(r.type || '').trim(),
                 num(r.product_sales ?? r['product sales']).toFixed(2),
                 num(r.total ?? r['total']).toFixed(2)].join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const when = r.date_time ?? r['date/time'] ?? r.month;
    let o = byOrder.get(id);
    if (!o) o = { id, month: '', sales: 0, payout: 0, feesSigned: 0, tdsTcsSigned: 0, refundRows: 0 }, byOrder.set(id, o);
    o.month = o.month || monthKey(when);
    o.sales += num(r.product_sales ?? r['product sales']);
    /* What Amazon actually paid for this row. The settlement states it, and the
       parts foot to it exactly, so use it rather than re-deriving: product
       sales are ex-GST and rebuilding the payout by hand invites a sign error
       on every one of eight columns. */
    o.payout += num(r.total ?? r['total']);
    /* Amazon's deductions arrive NEGATIVE, and a reversed fee arrives positive.
       Accumulate them signed and take the magnitude once at the end — taking
       abs() per row turns every credit into another charge, which inflated
       June's fees by about 2,300 and made the month look over-collected. */
    o.feesSigned += num(r.selling_fees ?? r['selling fees'])
                  + num(r.fba_fees ?? r['fba fees'])
                  + num(r.other_transaction_fees ?? r['other transaction fees']);
    o.tdsTcsSigned += num(r.tds_194o ?? r['TDS (Section 194-O)'])
                    + num(r.tcs_cgst ?? r['TCS-CGST'])
                    + num(r.tcs_sgst ?? r['TCS-SGST'])
                    + num(r.tcs_igst ?? r['TCS-IGST']);
    if (String(r.type || '').trim() === 'Refund') o.refundRows += 1;
  }
  for (const o of byOrder.values()) {
    o.sales = r2(o.sales); o.payout = r2(o.payout);
    o.fees = r2(Math.abs(o.feesSigned)); o.tdsTcs = r2(Math.abs(o.tdsTcsSigned));
  }
  return byOrder;
}

function foldPlaced(orderRows) {
  const byOrder = new Map();
  for (const r of orderRows) {
    const id = String(r['amazon-order-id'] || '').trim();
    if (!id) continue;
    let o = byOrder.get(id);
    if (!o) o = { id, month: monthKey(r['purchase-date']), statuses: new Set(),
                  charged: 0, channel: '' }, byOrder.set(id, o);
    o.statuses.add(String(r['order-status'] || '').trim());
    o.channel = o.channel || String(r['sales-channel'] || '').trim();
    if (String(r['order-status'] || '').trim() !== 'Cancelled') {
      o.charged += num(r['item-price']) + num(r['item-tax']);
    }
  }
  for (const o of byOrder.values()) {
    o.charged = r2(o.charged);
    o.cancelled = o.statuses.size === 1 && o.statuses.has('Cancelled');
  }
  return byOrder;
}

/**
 * Build the ledger.
 *
 * @param src     { orders, mtr, settlement } raw rows
 * @param months  in order, e.g. ['2026-06','2026-07','2026-08']
 */
function buildLedger(src, months) {
  const placed = foldPlaced(src.orders || []);
  const inv = foldInvoiced(src.mtr || []);
  const sett = foldSettled(src.settlement || []);

  /* An order belongs to the month it was INVOICED in — that is when it became a
     receivable. Fall back to the month it was placed when the MTR has no date,
     so an order can never fall out of the ledger entirely. */
  const monthOf = (id) => (inv.get(id) && inv.get(id).month)
    || (placed.get(id) && placed.get(id).month) || '';

  const ids = new Set([...inv.keys(), ...placed.keys()]);
  const rows = [];
  for (const id of ids) {
    const i = inv.get(id) || { invoiced: 0, refunded: 0, gst: 0, shipped: false };
    const p = placed.get(id) || { cancelled: false, charged: 0 };
    const s = sett.get(id) || null;
    const m = monthOf(id);
    if (!months.includes(m)) continue;

    let status;
    /* Multi-channel fulfilment: Amazon SHIPPED it but did not SELL it — the
       order came from another channel. There is no Amazon invoice and never
       will be a settlement, so counting it as an unpaid receivable makes Amazon
       look like it owes money it never collected. These were the only
       "outstanding" orders in two months and each was worth nil, which is what
       gave them away. */
    /* ANCHORED. Amazon's own value for a multi-channel order is the string
       "Non-Amazon", which contains "Amazon" — so an unanchored test marks it as
       an Amazon sale and the exclusion silently does nothing. Match the start. */
    if (p.channel && !/^amazon/i.test(p.channel)) status = STATUS.NOT_AMAZON;
    else if (p.cancelled && !i.shipped) status = STATUS.CANCELLED;
    else if (!s) status = STATUS.OUTSTANDING;
    else if (i.refunded > 0 || s.refundRows > 0) status = STATUS.RETURNED;
    else if (s.month === m) status = STATUS.SETTLED_IN_MONTH;
    else status = STATUS.SETTLED_LATER;

    rows.push({
      orderId: id, month: m, status,
      invoiced: i.invoiced, refunded: i.refunded, gst: i.gst,
      fees: s ? s.fees : 0, tdsTcs: s ? s.tdsTcs : 0,
      settled: s ? (s.payout || r2(s.sales - s.fees - s.tdsTcs)) : 0,
      settledMonth: s ? s.month : '', charged: p.charged,
    });
  }

  /* ── the waterfall, month by month, carrying the balance forward ───────── */
  const sum = (rs, f) => r2(rs.reduce((a, x) => a + (Number(x[f]) || 0), 0));
  const perMonth = [];
  let openingAmt = 0, openingCnt = 0;

  for (const m of months) {
    const mine = rows.filter((r) => r.month === m);
    const billable = mine.filter((r) => r.status !== STATUS.CANCELLED
                                     && r.status !== STATUS.NOT_AMAZON);

    const invoiced = sum(billable, 'invoiced');
    const refunded = sum(billable, 'refunded');
    const gst = sum(billable, 'gst');          // memo only — see the header
    const fees = sum(billable, 'fees');
    const tdsTcs = sum(billable, 'tdsTcs');
    const netBillable = r2(invoiced - refunded);
    const expected = r2(netBillable - fees - tdsTcs);

    /* COHORT, not cash-in-month. "June" means June's orders: what they were
       billed, what Amazon kept, and what has since been received against them —
       whenever it arrived. Netting June's dues against cash that happened to
       land in June (including receipts for May's orders) is what drove the
       closing balance negative, and it is not what a receivable means. */
    const receivedForCohort = billable.filter((r) => r.settled !== 0);
    const settled = sum(receivedForCohort, 'settled');
    const settledLater = sum(billable.filter((r) => r.settled !== 0 && r.settledMonth && r.settledMonth !== m), 'settled');
    const closingRows = billable.filter((r) => r.status === STATUS.OUTSTANDING);
    const closingAmt = r2(expected - settled);

    perMonth.push({
      month: m,
      opening: { count: openingCnt, amount: openingAmt },
      invoiced: { count: billable.length, amount: invoiced },
      cancelled: { count: mine.length - billable.length,
                   amount: sum(mine.filter((r) => r.status === STATUS.CANCELLED), 'charged') },
      returned: { count: billable.filter((r) => r.refunded > 0).length, amount: refunded },
      netBillable: { count: billable.length, amount: netBillable },
      /* memo: how much of the receivable is tax to be remitted onward */
      gstMemo: { count: billable.filter((r) => r.gst > 0).length, amount: gst },
      fees: { count: billable.filter((r) => r.fees > 0).length, amount: fees },
      tdsTcs: { count: billable.filter((r) => r.tdsTcs > 0).length, amount: tdsTcs },
      expected: { count: billable.length, amount: expected },
      settled: { count: receivedForCohort.length, amount: settled },
      /* of the above, what arrived after the month closed — the carry */
      settledLater: { count: billable.filter((r) => r.settled !== 0 && r.settledMonth && r.settledMonth !== m).length,
                      amount: settledLater },
      /* TWO DIFFERENT FACTS, kept apart. `closing` is the arithmetic residual —
         due less received — and is real money. `unpaidOrders` is how many orders
         have no settlement at all. Reporting "3 orders worth 4,752.53" fused
         them, and those three orders were worth nil. */
      closing: { count: closingRows.length, amount: closingAmt },
      unpaidOrders: { count: closingRows.length,
                      amount: r2(closingRows.reduce((a, x) => a + x.invoiced, 0)) },
      byStatus: Object.values(STATUS).map((st) => {
        const g = mine.filter((r) => r.status === st);
        return { status: st, count: g.length, amount: sum(g, 'invoiced') };
      }),
    });
    openingAmt = closingAmt;
    openingCnt = closingRows.length;
  }

  return { months, perMonth, rows, STATUS };
}

module.exports = { buildLedger, STATUS, foldInvoiced, foldSettled, foldPlaced };

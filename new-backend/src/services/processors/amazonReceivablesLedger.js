/* ──────────────────────────────────────────────────────────────────────────────
   amazonReceivablesLedger.js — a month-by-month receivables ledger for Amazon.

   THE QUESTION THIS ANSWERS. "In April I should have collected a lakh. I got
   seventy thousand. Ten is GST, Amazon took fifteen — where is the other five?"
   A reconciliation that only counts orders cannot answer that. This walks the
   money: what was invoiced, what the government took, what Amazon took, what
   actually arrived, and what is still owed.

   A MONTH IS CLOSED AT ITS MONTH END, NOT AT TODAY. This is the rule the first
   version got wrong, and it matters more than anything else here. June's
   statement must show what was outstanding on 30 June. That a later file shows
   ₹5,485 of it arriving in July is July's business: June still closed owing it.
   Otherwise a month silently rewrites itself every time a newer file is loaded,
   and the figure an accountant signed off last quarter stops reproducing.

       opening outstanding        what last month closed owing
     + invoiced this month        MTR invoice value, INCLUDING GST
     − returns / refunds          money given back
     = net billable
     − Amazon fees                commission, closing, FBA, storage, GST on them
     − TDS 194-O                  income tax withheld against our PAN
     − TCS u/s 52                 GST collected at source
     = expected to receive
     − received IN the month      cash dated on or before the month end
     = closing outstanding        becomes next month's opening

   Then, only for months that later files cover: how much of that closing
   balance has since arrived, and how much is open to this day.

   GST IS NOT A DEDUCTION, and getting that wrong turned every closing balance
   negative. Amazon collects the full invoice from the buyer and pays the GST
   across to the seller, who then remits it to the government. Proved on the
   July settlement, where the columns foot exactly:

       product sales 1,99,132.78 + GST 35,855.82 + shipping 67.80 − promo 80.00
       − fees 26,821.08 − TDS 211.53 − TCS 995.62  =  2,06,948.17 = stated total

   So GST ARRIVES with the money. It is carried as a memo line — how much of
   the receivable is tax you will owe onward — never as something Amazon kept.
   TDS and TCS, by contrast, really are withheld, and are shown apart because
   they are reclaimed in different places: TDS in the income-tax return, TCS in
   the GST cash ledger.

   THE BASE IS THE MTR INVOICE VALUE, chosen deliberately: it is the document
   actually issued to the customer, it is the GST base, and cancelled orders are
   already out of it.

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

/* Which date books the sale. Companies differ, and all three are defensible —
   so the agent asks rather than assuming. DELIVERY is declared here but has no
   source: none of Amazon's three files carries a delivery date, so the
   controller refuses it rather than quietly falling back to another date. */
const BASIS = {
  ORDER: 'order',        // the month the customer placed the order
  DISPATCH: 'dispatch',  // the month it shipped and the invoice was raised
  DELIVERY: 'delivery',  // the month the customer received it — needs a 4th file
};

/* ── fold each source to one record per order ─────────────────────────── */

function foldInvoiced(mtrRows) {
  const byOrder = new Map();
  for (const r of mtrRows) {
    const id = String(r['Order Id'] ?? r.order_id ?? '').trim();
    if (!id) continue;
    const txn = String(r['Transaction Type'] ?? r.txn ?? '').trim();
    const amt = num(r['Invoice Amount'] ?? r.amount);
    let o = byOrder.get(id);
    if (!o) {
      o = { id, invMonth: '', shipMonth: '', invoiced: 0, refunded: 0, gst: 0,
            shipped: false, refundMonth: '', refundFile: '' };
      byOrder.set(id, o);
    }
    if (txn === 'Shipment') {
      o.shipped = true;
      o.invoiced += amt;
      /* Both dates are kept because the SALES BASIS decides which one books the
         sale. The B2C MTR used to look as though Shipment Date were blank; it
         is populated on all 2,037 shipment rows — what was blank was the parsed
         month, before DD-MM-YYYY was handled. */
      o.invMonth = o.invMonth || monthKey(r['Invoice Date'] || r.file_month);
      o.shipMonth = o.shipMonth || monthKey(r['Shipment Date'] || r['Invoice Date'] || r.file_month);
      /* The MTR states the tax both ways: one total, and split across the
         heads. Prefer the stated total — it is what the invoice shows — and
         fall back to summing the heads only when it is absent. */
      const stated = num(r['Total Tax Amount'] ?? r.total_tax);
      o.gst += stated || (num(r['Cgst Tax']) + num(r['Sgst Tax'])
                        + num(r['Igst Tax']) + num(r['Utgst Tax']));
    } else if (txn === 'Refund') {
      /* refunds are negative in the MTR; hold them positive as a deduction */
      o.refunded += Math.abs(amt);
      /* WHERE the refund turned up, which is NOT where the sale was invoiced.
         Amazon never restates a month it has already issued: a return on a June
         order appears in the JULY file carrying the ORIGINAL June invoice date.
         Keeping the file lets a prior-period refund be reported instead of
         silently dropped. */
      o.refundMonth = o.refundMonth || monthKey(r['Invoice Date']);
      o.refundFile = o.refundFile || String(r.__file || '');
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
     uploaded unified transaction report and in the retained ledger for that
     settlement. 250 such rows still overlap after the month-ownership filter,
     so they must be suppressed.

     BUT THE SIGNATURE ALONE IS NOT ENOUGH, and that cost ₹1,589 in June. An
     order for TWO UNITS OF ONE SKU is paid with two genuinely identical rows —
     same order, same type, same product sales, same total. Treating the second
     as a copy threw away a real payment and made Amazon look like it was
     withholding money it had already sent.

     So the test is "has this exact row already come from the OTHER source" —
     a repeat inside one file is a real second payment and is kept. */
  const seen = new Map();            // signature → the source that first supplied it
  for (const r of settlementRows) {
    const id = String(r.order_id ?? r['order id'] ?? r['order-id'] ?? '').trim();
    if (!id) continue;
    const sig = [id, String(r.type || '').trim(),
                 num(r.product_sales ?? r['product sales']).toFixed(2),
                 num(r.total ?? r['total']).toFixed(2)].join('|');
    const src = String(r.__src || 'unknown');
    const first = seen.get(sig);
    if (first !== undefined && first !== src) continue;   // same row, other source
    if (first === undefined) seen.set(sig, src);

    const when = r.date_time ?? r['date/time'] ?? r.month;
    const cashMonth = monthKey(when);
    let o = byOrder.get(id);
    if (!o) {
      o = { id, month: '', sales: 0, payout: 0, feesSigned: 0, tdsSigned: 0, tcsSigned: 0,
            refundRows: 0, byMonth: {} };
      byOrder.set(id, o);
    }
    o.month = o.month || cashMonth;
    o.sales += num(r.product_sales ?? r['product sales']);
    /* What Amazon actually paid for this row. The settlement states it, and the
       parts foot to it exactly, so use it rather than re-deriving: product
       sales are ex-GST and rebuilding the payout by hand invites a sign error
       on every one of eight columns. */
    const total = num(r.total ?? r['total']);
    o.payout += total;
    /* WHEN each rupee moved, so a month can be closed at its own month end
       rather than at today. Without this the ledger could only say "paid", not
       "paid by 30 June". */
    if (cashMonth) o.byMonth[cashMonth] = r2((o.byMonth[cashMonth] || 0) + total);
    /* Amazon's deductions arrive NEGATIVE, and a reversed fee arrives positive.
       Accumulate them signed and take the magnitude once at the end — taking
       abs() per row turns every credit into another charge, which inflated
       June's fees by about 2,300 and made the month look over-collected. */
    o.feesSigned += num(r.selling_fees ?? r['selling fees'])
                  + num(r.fba_fees ?? r['fba fees'])
                  + num(r.other_transaction_fees ?? r['other transaction fees']);
    /* TDS and TCS are kept APART. They are both withheld, but they are
       reclaimed in different places — TDS against the PAN in the income-tax
       return, TCS in the GST cash ledger — so one combined figure is useless
       to whoever has to claim them. */
    o.tdsSigned += num(r.tds_194o ?? r['TDS (Section 194-O)']);
    o.tcsSigned += num(r.tcs_cgst ?? r['TCS-CGST'])
                 + num(r.tcs_sgst ?? r['TCS-SGST'])
                 + num(r.tcs_igst ?? r['TCS-IGST']);
    if (String(r.type || '').trim() === 'Refund') o.refundRows += 1;
  }
  for (const o of byOrder.values()) {
    o.sales = r2(o.sales); o.payout = r2(o.payout);
    o.fees = r2(Math.abs(o.feesSigned));
    o.tds = r2(Math.abs(o.tdsSigned));
    o.tcs = r2(Math.abs(o.tcsSigned));
    o.tdsTcs = r2(o.tds + o.tcs);
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
 * @param opts    { basis }  which date books the sale — see BASIS
 */
function buildLedger(src, months, opts = {}) {
  const basis = opts.basis || BASIS.DISPATCH;
  const placed = foldPlaced(src.orders || []);
  const inv = foldInvoiced(src.mtr || []);
  const sett = foldSettled(src.settlement || []);

  /* WHICH MONTH AN ORDER BELONGS TO is the whole of the sales-basis question.
     Order basis books it when the customer bought; dispatch basis when it
     shipped and the invoice was raised. Either way, fall back to the other date
     when the chosen one is missing, so an order can never fall out entirely. */
  const monthOf = (id) => {
    const i = inv.get(id), p = placed.get(id);
    if (basis === BASIS.ORDER) return (p && p.month) || (i && (i.invMonth || i.shipMonth)) || '';
    return (i && (i.shipMonth || i.invMonth)) || (p && p.month) || '';
  };

  const ids = new Set([...inv.keys(), ...placed.keys()]);
  const rows = [];
  /* Refunds for orders invoiced BEFORE this report's window. Amazon puts them
     in a later month's file, so they arrive here with no shipment row to hang
     on. They used to be dropped by the window test; now they are reported. */
  const priorPeriodRefunds = [];

  for (const id of ids) {
    const i = inv.get(id) || { invoiced: 0, refunded: 0, gst: 0, shipped: false };
    const p = placed.get(id) || { cancelled: false, charged: 0 };
    const s = sett.get(id) || null;
    const m = monthOf(id);

    if (!months.includes(m)) {
      if (i.refunded > 0) {
        priorPeriodRefunds.push({
          orderId: id, amount: i.refunded,
          invoiceMonth: m || '', foundInFile: i.refundFile || '',
          refundMonth: i.refundMonth || '',
        });
      }
      continue;
    }

    let status;
    /* Multi-channel fulfilment: Amazon SHIPPED it but did not SELL it — the
       order came from another channel. There is no Amazon invoice and never
       will be a settlement, so counting it as an unpaid receivable makes Amazon
       look like it owes money it never collected. */
    /* ANCHORED. Amazon's own value for a multi-channel order is the string
       "Non-Amazon", which contains "Amazon" — so an unanchored test marks it as
       an Amazon sale and the exclusion silently does nothing. Match the start. */
    if (p.channel && !/^amazon/i.test(p.channel)) status = STATUS.NOT_AMAZON;
    else if (p.cancelled && !i.shipped) status = STATUS.CANCELLED;
    else if (!s) status = STATUS.OUTSTANDING;
    else if (i.refunded > 0 || s.refundRows > 0) status = STATUS.RETURNED;
    else if (s.month === m) status = STATUS.SETTLED_IN_MONTH;
    else status = STATUS.SETTLED_LATER;

    const settled = s ? (s.payout || r2(s.sales - s.fees - s.tdsTcs)) : 0;
    rows.push({
      orderId: id, month: m, status,
      invoiced: i.invoiced, refunded: i.refunded, gst: i.gst,
      fees: s ? s.fees : 0,
      tds: s ? s.tds : 0, tcs: s ? s.tcs : 0, tdsTcs: s ? s.tdsTcs : 0,
      settled,
      settledMonth: s ? s.month : '',
      settledBy: s ? s.byMonth : {},
      charged: p.charged,
    });
  }

  /* ── the waterfall, month by month, carrying the balance forward ───────── */
  const sum = (rs, f) => r2(rs.reduce((a, x) => a + (Number(x[f]) || 0), 0));
  /* cash received against these orders ON OR BEFORE the given month end */
  const upTo = (rs, m) => r2(rs.reduce((a, x) => a + Object.entries(x.settledBy || {})
    .reduce((b, [cm, v]) => b + (cm && cm <= m ? v : 0), 0), 0));
  const after = (rs, m) => r2(rs.reduce((a, x) => a + Object.entries(x.settledBy || {})
    .reduce((b, [cm, v]) => b + (cm && cm > m ? v : 0), 0), 0));

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
    const tds = sum(billable, 'tds');
    const tcs = sum(billable, 'tcs');
    const netBillable = r2(invoiced - refunded);
    const expected = r2(netBillable - fees - tds - tcs);

    /* THE MONTH IS CLOSED AT ITS OWN MONTH END. `receivedInMonth` is cash dated
       on or before it; `closing` is what the month ended owing. What arrived
       afterwards is reported separately and never folded back in. */
    const receivedInMonth = upTo(billable, m);
    const receivedLater = after(billable, m);
    const receivedToDate = r2(receivedInMonth + receivedLater);
    const closingAmt = r2(expected - receivedInMonth);
    const stillOpen = r2(expected - receivedToDate);

    const paidInMonth = billable.filter((r) => Object.keys(r.settledBy || {}).some((cm) => cm && cm <= m));
    const paidLater = billable.filter((r) => Object.keys(r.settledBy || {}).some((cm) => cm && cm > m));
    const neverPaid = billable.filter((r) => r.settled === 0);

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
      tds: { count: billable.filter((r) => r.tds > 0).length, amount: tds },
      tcs: { count: billable.filter((r) => r.tcs > 0).length, amount: tcs },
      tdsTcs: { count: billable.filter((r) => r.tdsTcs > 0).length, amount: r2(tds + tcs) },
      expected: { count: billable.length, amount: expected },
      /* received ON OR BEFORE the month end — this is what closes the month */
      received: { count: paidInMonth.length, amount: receivedInMonth },
      /* and the closing balance it leaves, which becomes next month's opening */
      closing: { count: billable.length - paidInMonth.length, amount: closingAmt },
      /* only knowable once later months are loaded — never folded into closing */
      receivedLater: { count: paidLater.length, amount: receivedLater },
      settled: { count: billable.filter((r) => r.settled !== 0).length, amount: receivedToDate },
      stillOpen: { count: neverPaid.length, amount: stillOpen },
      unpaidOrders: { count: neverPaid.length, amount: sum(neverPaid, 'invoiced') },
      byStatus: Object.values(STATUS).map((st) => {
        const g = mine.filter((r) => r.status === st);
        return { status: st, count: g.length, amount: sum(g, 'invoiced') };
      }),
    });
    openingAmt = closingAmt;
    openingCnt = billable.length - paidInMonth.length;
  }

  /* ── whose sales was each month's cash actually for? ────────────────────
     The owner's question, and the one a cohort ledger alone cannot answer:
     "Amazon paid me 3.78 lakh in June — was that all June's?" Group every
     payment by the month it moved, then by the month the sale was made. */
  const cashByMonth = {};
  const addCash = (cashM, saleM, amt, id) => {
    if (!cashM) return;
    const b = (cashByMonth[cashM] = cashByMonth[cashM] || { total: 0, orders: new Set(), bySale: {} });
    const s = (b.bySale[saleM] = b.bySale[saleM] || { amount: 0, orders: new Set() });
    s.amount = r2(s.amount + amt); s.orders.add(id);
    b.total = r2(b.total + amt); b.orders.add(id);
  };
  for (const r of rows) {
    for (const [cm, v] of Object.entries(r.settledBy || {})) addCash(cm, r.month, v, r.orderId);
  }
  /* and the payments for orders this report does not hold — the "old money" */
  const known = new Set(rows.map((r) => r.orderId));
  for (const [id, s] of sett) {
    if (known.has(id)) continue;
    for (const [cm, v] of Object.entries(s.byMonth || {})) addCash(cm, 'EARLIER', v, id);
  }
  const cash = months.map((m) => {
    const b = cashByMonth[m] || { total: 0, orders: new Set(), bySale: {} };
    return {
      month: m, total: r2(b.total), orders: b.orders.size,
      bySaleMonth: Object.entries(b.bySale)
        .map(([saleMonth, v]) => ({ saleMonth, amount: r2(v.amount), orders: v.orders.size }))
        .sort((a, x) => String(a.saleMonth).localeCompare(String(x.saleMonth))),
    };
  });

  return { months, basis, perMonth, rows, cash, priorPeriodRefunds, STATUS, BASIS };
}

module.exports = { buildLedger, STATUS, BASIS, foldInvoiced, foldSettled, foldPlaced };

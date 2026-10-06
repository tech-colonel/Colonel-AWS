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

const { monthKey, num, r2, isoDay, cashDate } = require('./amazonThreeWay');

/* The closing state of an order. Exactly one applies, so the buckets sum to the
   order count and nothing can be counted twice or lost between them. */
const STATUS = {
  NOT_AMAZON: 'Not an Amazon sale (MCF)',
  SETTLED_IN_MONTH: 'Settled in the month',
  SETTLED_LATER: 'Settled in a later month',
  RETURNED: 'Returned / refunded',
  CANCELLED: 'Cancelled',
  /* Amazon has RECORDED the sale and is HOLDING the money — it has not paid
     and it has not refused. That is a receivable, not a settlement, and it has
     to be visible as one rather than blend into "outstanding". */
  DEFERRED: 'Held by Amazon (deferred)',
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
      o = { id, invMonth: '', shipMonth: '', invDate: '', shipDate: '', refundDate: '',
            invoiced: 0, refunded: 0, gst: 0,
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
      /* the DAY, not just the month. An accountant checking a credit note
         against a filed return needs the date on it, and "Jun 2026" does not
         settle whether a 30-June sale belongs to June or July. */
      o.invDate = o.invDate || isoDay(r['Invoice Date']);
      o.shipDate = o.shipDate || isoDay(r['Shipment Date']);
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
         order appears in the JULY file still carrying the ORIGINAL June invoice
         date. Measured over 34 MTR files (Apr-25..Aug-26): 190 returns land in a
         later file than the sale and 172 of them appear ONLY there; the 18 that
         look restated are orders with two separate events (a Cancel, then a
         Refund), not one return written twice.

         So `Invoice Date` is the WRONG field for a refund — it is the original
         sale's date, and using it books the return back into a month that has
         already been signed off. `Credit Note Date` is the date the credit note
         was actually raised, and every one of the 529 refund rows carries it.
         That is also the correct GST period for a credit note.
         Falls back to the file the row arrived in, and only then to the invoice
         date, so a month is never silently rewritten. */
      o.refundMonth = o.refundMonth
        || monthKey(r['Credit Note Date'] ?? r['credit_note_date'])
        || monthKey(r.file_month)
        || monthKey(r['Invoice Date']);
      o.creditNote = o.creditNote || String(r['Credit Note No'] ?? r['credit_note_no'] ?? '').trim();
      o.refundDate = o.refundDate || isoDay(r['Credit Note Date'] ?? r['credit_note_date']);
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

    /* WHEN THE MONEY ARRIVED, not when Amazon wrote the row down — see
       cashDate in amazonThreeWay. Blank means deferred: recorded, not paid. */
    const when = cashDate(r);
    const cashMonth = monthKey(when);
    let o = byOrder.get(id);
    if (!o) {
      o = { id, month: '', sales: 0, payout: 0, credits: 0, deferred: 0,
            feesSigned: 0, tdsSigned: 0, tcsSigned: 0, refundRows: 0, byMonth: {} };
      byOrder.set(id, o);
    }
    o.month = o.month || cashMonth;
    o.sales += num(r.product_sales ?? r['product sales']);
    /* NOT every rupee Amazon pays is payment for an invoice. A Reimbursement
       compensates for goods lost or damaged on the way back, an Adjustment
       corrects an earlier settlement, a Fulfilment Fee Refund returns a fee —
       none of them settles a sale. Measured over 17 months: Reimbursements
       Rs 32,084 (95 rows), Adjustment Rs 32,635, Fulfilment Fee Refund
       Rs 6,004. They were counted as payment, which pushed "received" above
       "amount due" and made every month close with a NEGATIVE amount still
       pending — money we really have, against a bill that was already settled
       or cancelled. Kept apart so the pending figure means what it says. */
    /* What Amazon actually paid for this row. The settlement states it, and the
       parts foot to it exactly, so use it rather than re-deriving: product
       sales are ex-GST and rebuilding the payout by hand invites a sign error
       on every one of eight columns. */
    const total = num(r.total ?? r['total']);
    /* But a Reimbursement, an Adjustment or a Fee Refund is NOT payment against
       an invoice — it compensates for goods lost on the way back, corrects an
       earlier settlement, or returns a fee. Counting it as settlement of a sale
       pushed "received" above "amount due" and closed almost every month with a
       negative amount still pending. It is held apart so the receivable
       arithmetic only ever nets cash that actually settles an invoice; the
       credit is still reported, on its own line. */
    const ty = String(r.type || '').trim().toLowerCase();
    const isCredit = ty && ty !== 'order' && ty !== 'refund' && ty !== 'transfer';
    if (!cashMonth && !isCredit) {
      /* Deferred: Amazon has recorded the sale and is still holding the money.
         Counting it in the payout said it was received when it is not in the
         bank, so it is held on its own line until a release date appears. */
      o.deferred += total;
    } else if (isCredit) {
      o.credits += total;
    } else {
      o.payout += total;
      /* WHEN each rupee moved, so a month can be closed at its own month end
         rather than at today. Without this the ledger could only say "paid",
         not "paid by 30 June". */
      if (cashMonth) o.byMonth[cashMonth] = r2((o.byMonth[cashMonth] || 0) + total);
    }
    if (isCredit && cashMonth) {
      o.creditsBy = o.creditsBy || {};
      o.creditsBy[cashMonth] = r2((o.creditsBy[cashMonth] || 0) + total);
    }
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
    o.sales = r2(o.sales); o.payout = r2(o.payout); o.deferred = r2(o.deferred);
    o.fees = r2(Math.abs(o.feesSigned));
    o.credits = r2(o.credits);
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
    if (!o) o = { id, month: monthKey(r['purchase-date']), date: isoDay(r['purchase-date']),
                  statuses: new Set(),
                  charged: 0, cancelledValue: 0, tax: 0, channel: '' }, byOrder.set(id, o);
    const st = String(r['order-status'] || '').trim();
    o.statuses.add(st);
    o.channel = o.channel || String(r['sales-channel'] || '').trim();
    /* `item-tax` is the GST ALREADY INSIDE `item-price` (345.00 carries 52.63
       of 18% GST), which is why item-price ties to the MTR Principal exactly.
       Adding them overstated every order-report figure by about 15%. */
    if (st !== 'Cancelled') { o.charged += num(r['item-price']); o.tax += num(r['item-tax']); }
    /* A fully cancelled order has no non-cancelled line, so `charged` stayed at
       zero for precisely the orders the "cancelled" figure is made of — it
       reported Rs 0.00 cancelled however many were. Kept on its own field. */
    else o.cancelledValue += num(r['item-price']);
  }
  for (const o of byOrder.values()) {
    o.charged = r2(o.charged);
    o.cancelledValue = r2(o.cancelledValue);
    o.tax = r2(o.tax);
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
    const p = placed.get(id) || { cancelled: false, charged: 0, cancelledValue: 0, tax: 0 };
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
    else if (s.deferred && !s.payout) status = STATUS.DEFERRED;
    else if (i.refunded > 0 || s.refundRows > 0) status = STATUS.RETURNED;
    else if (s.month === m) status = STATUS.SETTLED_IN_MONTH;
    else status = STATUS.SETTLED_LATER;

    /* `payout` is what Amazon STATED it paid, and the fallback rebuilds it from
       the parts for a source that carries no `total`. But a DEFERRED row has no
       payout BY DESIGN — Amazon is holding the money — so rebuilding it from
       product sales would hand it straight back as received, which is the one
       thing the deferred rule exists to prevent. */
    const settled = !s ? 0
      : (s.payout || (s.deferred ? 0 : r2(s.sales - s.fees - s.tdsTcs)));
    rows.push({
      orderId: id, month: m, status,
      invoiced: i.invoiced, refunded: i.refunded, gst: i.gst,
      /* the month the CREDIT NOTE was raised — which month the return belongs
         to. Not the sale's month. See the returns block below. */
      refundMonth: i.refundMonth || '', creditNote: i.creditNote || '',
      saleDate: i.invDate || i.shipDate || p.date || '',
      refundDate: i.refundDate || '',
      deferred: s ? s.deferred : 0,
      fees: s ? s.fees : 0,
      tds: s ? s.tds : 0, tcs: s ? s.tcs : 0, tdsTcs: s ? s.tdsTcs : 0,
      settled,
      /* what of that was NOT payment against an invoice */
      credits: s ? s.credits : 0,
      creditsBy: s ? (s.creditsBy || {}) : {},
      settledMonth: s ? s.month : '',
      settledBy: s ? s.byMonth : {},
      charged: p.charged, cancelledValue: p.cancelledValue, orderTax: p.tax,
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

    /* ── A RETURN BELONGS TO THE MONTH ITS CREDIT NOTE WAS RAISED ──────────
       An order sold on 30 April and returned in May does NOT reduce April.
       April's GST has been filed on April's invoices; the return is a MAY
       credit note and reduces May. That is how the books work and how Amazon
       itself files the row — measured across 34 MTR files, 100% of refunds sit
       in the file for their credit-note month, never the month of the sale.
       The gap runs to 134 days (median 16), so a return can be two or three
       months after the sale and even cross the financial year — charging it
       back to the sale month would mean reopening a filed period.

       So this month's returns are every credit note RAISED this month, whatever
       month the goods were sold in, split so the reader can see both parts. */
    const creditedHere = rows.filter((r) => r.refundMonth === m && r.refunded > 0);
    const returnedOwn = sum(creditedHere.filter((r) => r.month === m), 'refunded');
    const returnedEarlier = sum(creditedHere.filter((r) => r.month !== m), 'refunded');
    /* sales before the report window have no row of their own, but their credit
       notes are still this month's returns */
    const returnedPrior = r2(priorPeriodRefunds
      .filter((p) => p.refundMonth === m)
      .reduce((a, p) => a + (Number(p.amount) || 0), 0));
    /* The CREDIT-NOTE view: what this month's returns are for GST and the P&L.
       April's sale returned in May is a MAY credit note and reduces MAY's net
       sales — April's GST is already filed and is never reopened. */
    const creditNotesRaised = r2(returnedOwn + returnedEarlier + returnedPrior);

    /* The RECEIVABLE view, which is a different question and must stay on the
       same population as the cash. "What does Amazon still owe for THIS
       month's orders" can only net off returns OF THOSE ORDERS, whenever the
       credit note was raised. Deducting another month's credit notes here
       shrinks this cohort's bill below the cash already collected against it
       and drives the closing balance negative — which is what happened when
       both views were briefly computed the same way. */
    const refunded = sum(billable, 'refunded');

    /* returns of THIS month's sales that were credited in a LATER month — not
       deducted here, shown separately, exactly as cash received later is */
    const returnedLater = sum(
      billable.filter((r) => r.refunded > 0 && r.refundMonth && r.refundMonth > m), 'refunded');

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
                   amount: sum(mine.filter((r) => r.status === STATUS.CANCELLED), 'cancelledValue') },
      /* `returned` = credit notes RAISED this month, whatever month was sold.
         `own` is this month's own sales coming back, `earlier` is the part that
         belongs to an earlier month's sales — the same split card 2 makes for
         cash, so the reader can read both sides the same way. */
      returned: {
        count: creditedHere.length + priorPeriodRefunds.filter((p) => p.refundMonth === m).length,
        amount: creditNotesRaised,
        /* what the receivable above actually netted off: returns of THIS
           month's own orders, whenever credited. Shown so the two numbers can
           never be mistaken for each other. */
        againstThisCohort: refunded,
        own: { count: creditedHere.filter((r) => r.month === m).length, amount: returnedOwn },
        earlier: {
          count: creditedHere.filter((r) => r.month !== m).length
               + priorPeriodRefunds.filter((p) => p.refundMonth === m).length,
          amount: r2(returnedEarlier + returnedPrior),
        },
      },
      /* this month's sales returned AFTER the month end — not deducted here */
      /* money received this month that was NOT for this month's sales, and
         money that was not payment for any invoice at all — the two reasons
         cash and billings never tie order for order */
      creditsNotAgainstInvoice: { count: billable.filter((r) => Math.abs(r.credits || 0) > 0.01).length,
                                  amount: sum(billable, 'credits') },
      /* money Amazon has recorded and is still holding — ours, not yet paid */
      deferred: { count: billable.filter((r) => Math.abs(r.deferred || 0) > 0.01).length,
                  amount: sum(billable, 'deferred') },
      returnedLater: {
        count: billable.filter((r) => r.refunded > 0 && r.refundMonth && r.refundMonth > m).length,
        amount: returnedLater,
      },
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
      /* WHICH later months it came in. The card can only ever say what was
         unpaid at the month end, because that is what the month closed on —
         but the reader's next question is always "and did we get it?", and
         "Later: 8,132 came in" did not answer it. Named months now. */
      laterBy: (() => {
        const by = {};
        for (const r of billable) {
          for (const [cm, v] of Object.entries(r.settledBy || {})) {
            if (!cm || cm <= m) continue;
            const b = (by[cm] = by[cm] || { amount: 0, orders: new Set() });
            b.amount = r2(b.amount + v); b.orders.add(r.orderId);
          }
        }
        return Object.entries(by)
          .map(([month, v]) => ({ month, amount: r2(v.amount), orders: v.orders.size }))
          .sort((a, b) => a.month.localeCompare(b.month));
      })(),
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

/* ──────────────────────────────────────────────────────────────────────────
   MTR vs SETTLEMENT — the tax invoice against the money

   The problem this answers, in the owner's words: we did 5 lakh of sales this
   month, the MTR shows 150 orders worth 5 lakh, but the settlement knows only
   100 of them worth 4 lakh — and of that 4 lakh only 3.5 lakh has actually
   been credited. Meanwhile Amazon's commission, TDS and TCS are deducted on
   the 100 orders the settlement DOES know, while net sales is built on all
   150. The two sides of the margin are computed on different populations, so
   the margin is wrong by construction and nothing on the screen says so.

   WHAT IS COMPARED WITH WHAT
   Gross against gross. The MTR's `Invoice Amount` is GST-INCLUSIVE (a row
   reading 474 carries 72.30 of tax inside it — `Tax Exclusive Gross` is the
   401.70), and the settlement's matching gross is

       product sales + GST + shipping credits + gift wrap - promotional rebates

   which is what Amazon credits BEFORE taking its own fees. Measured across
   20,208 orders the two come to 83,03,795.96 and 82,98,412.65 — apart by
   5,383.31, or 0.06%. Comparing the MTR against the settlement's `total`
   instead would put commission, TDS and TCS inside the difference and make
   every order look short-paid by about a quarter.

   Fees, TDS and TCS are reported underneath, never netted into the
   comparison, and the COVERAGE line says how many of the invoiced orders they
   actually cover — because the honest answer to "is my margin right?" is a
   population count, not an estimate. Nothing here is accrued or grossed up
   for the orders the settlement has not reached yet; an invented number is
   worse than a disclosed gap.
   ────────────────────────────────────────────────────────────────────────── */

const { monthKey, isoDay, num } = require('./amazonThreeWay');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const txt = (v) => String(v ?? '').trim();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* "settled in 2026-09" is a key, not a month. An accountant reads "Sep 2026". */
const monthName = (m) => (/^\d{4}-\d{2}$/.test(m || '')
  ? `${MON[+String(m).slice(5) - 1]} ${String(m).slice(0, 4)}` : (m || ''));

const BUCKETS = [
  { key: 'settledInPeriod', label: 'Invoiced and paid', expected: true,
    meaning: 'The tax invoice is in the MTR and Amazon settled it on or before the end of the '
           + 'selected period. This is the only bucket where the sale and the money are in the '
           + 'same period.' },
  { key: 'settledLater', label: 'Invoiced here, paid in a later month', expected: true,
    meaning: 'Amazon settles on its own cycle, so an order invoiced near the end of a month is '
           + 'very often paid in the next one. It is not outstanding — the row names the month '
           + 'the money actually arrived in.' },
  { key: 'neverSettled', label: 'Invoiced, never paid', expected: false,
    meaning: 'A tax invoice exists and no settlement anywhere in the files held mentions the '
           + 'order. This is the only bucket worth taking to Amazon.' },
  { key: 'settlementOnly', label: 'Paid here, invoiced outside this period', expected: true,
    meaning: 'Money credited inside the period against a sale made before it. Real cash, but it '
           + 'belongs to an earlier period’s sales and must not be read as this one’s.' },
];

/* ── the MTR, folded to one entry per order ───────────────────────────────
   Only Shipment rows raise an invoice; Refund rows credit one back. Cancel
   and FreeReplacement rows carry no value and would double-count the order. */
function foldMtr(rows, basis) {
  const by = new Map();
  for (const r of rows || []) {
    const id = txt(r['Order Id'] ?? r.order_id);
    if (!id) continue;
    const t = txt(r['Transaction Type']);
    let e = by.get(id);
    if (!e) {
      e = { id, invoiced: 0, refunded: 0, invMonth: '', shipMonth: '', invDate: '',
            invoiceNo: '', types: new Set(), netBy: {} };
      by.set(id, e);
    }
    e.types.add(t);
    const amt = num(r['Invoice Amount'] ?? r.amount);
    if (t === 'Shipment') {
      e.invoiced += amt;
      e.invMonth = e.invMonth || monthKey(r['Invoice Date'] || r.file_month);
      e.shipMonth = e.shipMonth || monthKey(r['Shipment Date'] || r['Invoice Date'] || r.file_month);
      e.invDate = e.invDate || isoDay(r['Invoice Date']);
      e.invoiceNo = e.invoiceNo || txt(r['Invoice Number']);
      const im = monthKey(r['Invoice Date'] || r.file_month);
      if (im) e.netBy[im] = r2((e.netBy[im] || 0) + amt);
    } else if (t === 'Refund') {
      e.refunded += Math.abs(amt);
      /* A return belongs to the month its CREDIT NOTE was raised, not the
         month of the sale — April's GST is already filed, so an April sale
         returned in May is a May credit note. Dating it by the sale instead
         left the MTR side of this comparison standing at full value while the
         settlement side had already reversed it, which showed up as the
         invoice being OVER-paid by the whole amount of the return. */
      const rm = monthKey(r['Credit Note Date'] ?? r['credit_note_date'])
              || monthKey(r.file_month) || monthKey(r['Invoice Date']);
      if (rm) e.netBy[rm] = r2((e.netBy[rm] || 0) - Math.abs(amt));
    }
  }
  for (const e of by.values()) {
    e.invoiced = r2(e.invoiced);
    e.refunded = r2(e.refunded);
    e.net = r2(e.invoiced - e.refunded);
    /* the sale sits where the chosen basis says it sits, exactly as the ledger
       and the order chain place it — three views of one period, or none */
    e.month = basis === 'order' ? (e.invMonth || e.shipMonth) : (e.shipMonth || e.invMonth);
    e.shipped = e.types.has('Shipment');
  }
  return by;
}

/* ── the settlement, folded to one entry per order ────────────────────────
   Same per-file de-duplication the ledger uses: Date Range Reports overlap all
   the time (a Jun-1..Jul-1 report sits entirely inside an Apr-1..Sep-22 one),
   and counting both put this comparison out by 4.5 lakh on a 83 lakh base
   until the overlap was removed. A repeat INSIDE one file is a genuine second
   payment on a multi-unit order and is kept. */
function foldSettlement(rows) {
  const by = new Map();
  const seen = new Map();
  for (const r of rows || []) {
    const id = txt(r.order_id ?? r['order id'] ?? r['order-id']);
    if (!id) continue;
    const type = txt(r.type);
    if (type !== 'Order' && type !== 'Refund') continue;   // Transfer is the bank sweep
    const sig = [id, type, num(r.product_sales ?? r['product sales']).toFixed(2),
                 num(r.total ?? r['total']).toFixed(2)].join('|');
    const src = String(r.__src || r.__file || 'unknown');
    const first = seen.get(sig);
    if (first !== undefined && first !== src) continue;
    if (first === undefined) seen.set(sig, src);

    const cashMonth = monthKey(r.date_time ?? r['date/time'] ?? r.month);
    let e = by.get(id);
    if (!e) {
      e = { id, gross: 0, net: 0, feesSigned: 0, tdsSigned: 0, tcsSigned: 0,
            byMonth: {}, grossBy: {}, rows: 0, refundRows: 0, deferred: 0 };
      by.set(id, e);
    }
    e.rows += 1;
    const total = num(r.total ?? r['total']);
    const fees = num(r.selling_fees ?? r['selling fees'])
               + num(r.fba_fees ?? r['fba fees'])
               + num(r.other_transaction_fees ?? r['other transaction fees']);
    const tds = num(r.tds_194o ?? r['TDS (Section 194-O)']);
    const tcs = num(r.tcs_cgst ?? r['TCS-CGST'])
              + num(r.tcs_sgst ?? r['TCS-SGST'])
              + num(r.tcs_igst ?? r['TCS-IGST']);
    /* ── what Amazon credits BEFORE its own deductions ────────────────────
       The figure comparable with the MTR's GST-inclusive Invoice Amount. It
       is DERIVED from the stated total rather than rebuilt from
       product sales + GST + shipping + gift wrap - rebates, because a month
       restored from a retained settlement ledger carries only product sales,
       total and the deduction columns — no GST, no shipping, no rebates. Adding
       those columns up therefore returned a gross of zero for every such month
       and made 1,019 perfectly ordinary orders read as short-paid.

       total = gross - fees - TDS - TCS, and the deductions arrive negative, so
       gross = total - (fees + TDS + TCS). Checked against the full FY 25-26
       file: 51,42,323.87 total + 12,72,804.44 fees + 5,564.37 TDS +
       27,321.06 TCS = 64,48,013.74, the same figure the column sum gives. */
    const gross = total - fees - tds - tcs;
    e.gross += gross;
    /* WHEN each rupee moved, so the comparison can be made as at the period
       end rather than as at today. Without this an August sale the customer
       returned in September reads as short-paid by its full value: the
       settlement has already taken the money back, while the credit note that
       would reduce the MTR is in a month the period does not cover. */
    if (cashMonth) e.grossBy[cashMonth] = r2((e.grossBy[cashMonth] || 0) + gross);
    if (type === 'Refund') e.refundRows += 1;
    if (/defer/i.test(txt(r.transaction_status ?? r['Transaction Status']))) e.deferred += gross;
    e.net += total;
    /* signed, then the magnitude taken once at the end — abs() per row turns a
       reversed charge into another charge */
    e.feesSigned += fees; e.tdsSigned += tds; e.tcsSigned += tcs;
    if (cashMonth) e.byMonth[cashMonth] = r2((e.byMonth[cashMonth] || 0) + total);
  }
  for (const e of by.values()) {
    e.gross = r2(e.gross); e.net = r2(e.net);
    e.fees = r2(Math.abs(e.feesSigned));
    e.tds = r2(Math.abs(e.tdsSigned));
    e.tcs = r2(Math.abs(e.tcsSigned));
    e.deferred = r2(e.deferred);
    e.grossUpTo = (m) => r2(Object.entries(e.grossBy)
      .reduce((a, [cm, v]) => a + (cm && (!m || cm <= m) ? v : 0), 0));
    e.grossAfter = (m) => r2(Object.entries(e.grossBy)
      .reduce((a, [cm, v]) => a + (cm && m && cm > m ? v : 0), 0));
    e.months = Object.keys(e.byMonth).filter(Boolean).sort();
    e.firstMonth = e.months[0] || '';
    e.lastMonth = e.months[e.months.length - 1] || '';
  }
  return by;
}

function build(src, months, opts = {}) {
  const basis = opts.basis || 'dispatch';
  const M = foldMtr(src.mtr, basis);
  const S = foldSettlement(src.settlement);
  const inWindow = (m) => !months.length || months.includes(m);
  const periodEnd = months.length ? months[months.length - 1] : '';

  const rows = [];

  /* every order the MTR invoiced inside the period */
  for (const e of M.values()) {
    if (!e.shipped || !inWindow(e.month)) continue;
    const s = S.get(e.id);
    const paidInPeriod = s ? s.months.some((cm) => cm <= periodEnd) : false;
    const bucket = !s ? 'neverSettled' : paidInPeriod ? 'settledInPeriod' : 'settledLater';
    /* as at the PERIOD END, not as at today — see grossBy above */
    const gross = s ? s.grossUpTo(periodEnd) : 0;
    const movedAfter = s ? s.grossAfter(periodEnd) : 0;
    rows.push({
      orderId: e.id, bucket, month: e.month,
      /* The month the INVOICE sits in, and WHEN each rupee was credited. The
         screen filters to a chosen range without re-running the report, so it
         has to be able to re-ask "paid by the end of THIS period?" for itself.
         Shipping only a pre-computed answer is what made the Order-vs-Invoice
         tab stand still when the range moved. */
      mtrMonth: e.month,
      grossBy: s ? s.grossBy : {},
      /* the invoice side by month too, so the screen can ask BOTH sides the
         same question at whatever period end it is showing */
      mtrBy: e.netBy,
      invoiceNo: e.invoiceNo, invoiceDate: e.invDate,
      mtrValue: e.net, mtrInvoiced: e.invoiced, mtrRefunded: e.refunded,
      settledGross: gross, settledNet: s ? s.net : 0,
      settledGrossAll: s ? s.gross : 0,
      /* a NEGATIVE here is the customer returning the goods after the period
         closed — real money going back, not a payment arriving */
      movedAfter: r2(movedAfter),
      returnedAfter: movedAfter < 0 ? r2(-movedAfter) : 0,
      deferred: s ? s.deferred : 0,
      fees: s ? s.fees : 0, tds: s ? s.tds : 0, tcs: s ? s.tcs : 0,
      /* the whole point of the "later" bucket: WHICH month, by name */
      paidMonth: s ? s.firstMonth : '',
      paidMonths: s ? s.months.map(monthName).join(', ') : '',
      shortfall: r2(e.net - gross),
      /* WHY it is short, classified per row rather than left as one unexplained
         total. The big one is not a fault at all: the customer returned the
         goods after the period closed, so the settlement has already taken the
         money back while the credit note that would reduce the MTR sits in a
         later month's file. */
      shortReason: (() => {
        /* only asked of orders that WERE paid inside the period. An order paid
           in a later month has a gross of nil as at the period end by
           definition; calling that whole value a shortfall would report it
           twice, once in its own bucket and once as money missing. */
        if (bucket !== 'settledInPeriod') return '';
        const sh = r2(e.net - gross);
        if (Math.abs(sh) <= 1) return '';
        if (movedAfter < 0 && Math.abs(sh + movedAfter) <= 1) return 'returnedAfter';
        if (s && s.deferred) return 'deferred';
        if (sh > 0) return 'shortPaid';
        return 'overPaid';
      })(),
      why: !s
        ? 'No settlement row for this order in any file held. Either Amazon has not paid it yet, '
          + 'or the month that paid it has not been loaded.'
        : paidInPeriod
          ? 'Settled inside the selected period.'
          : `Invoiced in this period and settled in ${monthName(s.firstMonth) || 'a later month'}, so it is `
            + 'not outstanding — the money is in, it just landed after the period closed.',
    });
  }

  /* and the mirror: money credited inside the period for a sale made outside it */
  for (const s of S.values()) {
    const e = M.get(s.id);
    if (e && e.shipped && inWindow(e.month)) continue;      // already above
    if (!s.months.some((cm) => inWindow(cm))) continue;
    rows.push({
      orderId: s.id, bucket: 'settlementOnly', month: s.firstMonth,
      mtrMonth: e ? e.month : '',
      grossBy: s.grossBy,
      mtrBy: e ? e.netBy : {},
      invoiceNo: e ? e.invoiceNo : '', invoiceDate: e ? e.invDate : '',
      mtrValue: e ? e.net : 0, mtrInvoiced: e ? e.invoiced : 0, mtrRefunded: e ? e.refunded : 0,
      settledGross: s.gross, settledNet: s.net,
      fees: s.fees, tds: s.tds, tcs: s.tcs,
      paidMonth: s.firstMonth, paidMonths: s.months.map(monthName).join(', '),
      shortfall: 0,
      why: e && e.month
        ? `Credited inside this period, but the invoice is dated ${monthName(e.month)} — an earlier period's sale.`
        : 'Credited inside this period with no tax invoice in the MTR files held, so the sale month '
          + 'cannot be named. Load that month’s MTR and it will be.',
    });
  }

  const sum = (rs, k) => r2(rs.reduce((a, x) => a + (x[k] || 0), 0));
  const buckets = BUCKETS.map((b) => {
    const mine = rows.filter((x) => x.bucket === b.key);
    return {
      ...b,
      count: mine.length,
      mtrValue: sum(mine, 'mtrValue'),
      settledGross: sum(mine, 'settledGross'),
      settledNet: sum(mine, 'settledNet'),
      fees: sum(mine, 'fees'), tds: sum(mine, 'tds'), tcs: sum(mine, 'tcs'),
      shortfall: sum(mine, 'shortfall'),
      returnedAfter: sum(mine, 'returnedAfter'),
    };
  });
  const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));

  /* ── COVERAGE ───────────────────────────────────────────────────────────
     The whole reason the tab exists. Net sales is built on every invoiced
     order in the period; Amazon's charges are only known for the ones the
     settlement has reached. Stating that ratio is the honest answer — no
     fee is estimated for the orders it has not reached, because an invented
     deduction would make the margin look complete and be wrong. */
  const invoiced = rows.filter((x) => x.bucket !== 'settlementOnly');
  const covered = rows.filter((x) => x.bucket === 'settledInPeriod' || x.bucket === 'settledLater');
  const invoicedValue = sum(invoiced, 'mtrValue');
  const coveredValue = sum(covered, 'mtrValue');

  return {
    months, basis, buckets, rows,
    totals: {
      invoicedOrders: invoiced.length,
      invoicedValue,
      settledOrders: covered.length,
      settledGross: sum(covered, 'settledGross'),
      settledNet: sum(covered, 'settledNet'),
      fees: sum(rows, 'fees'), tds: sum(rows, 'tds'), tcs: sum(rows, 'tcs'),
      shortfall: sum(rows.filter((x) => x.bucket === 'settledInPeriod'), 'shortfall'),
      neverOrders: byKey.neverSettled.count,
      neverValue: byKey.neverSettled.mtrValue,
      laterOrders: byKey.settledLater.count,
      laterValue: byKey.settledLater.mtrValue,
      onlyOrders: byKey.settlementOnly.count,
      onlyValue: byKey.settlementOnly.settledGross,
    },
    coverage: {
      orders: covered.length,
      ofOrders: invoiced.length,
      pctByOrders: invoiced.length ? r2((100 * covered.length) / invoiced.length) : 0,
      value: coveredValue,
      ofValue: invoicedValue,
      pctByValue: invoicedValue ? r2((100 * coveredValue) / invoicedValue) : 0,
    },
    /* the shortfall, broken down by what actually explains each rupee of it */
    shortfallBy: ['returnedAfter', 'deferred', 'shortPaid', 'overPaid'].map((k) => {
      const mine = rows.filter((x) => x.shortReason === k);
      return {
        key: k,
        label: { returnedAfter: 'Returned by the customer after the period closed',
                 deferred: 'Amazon has not released the money yet',
                 shortPaid: 'Paid less than the invoice, with no reason in the files',
                 overPaid: 'Paid more than the invoice' }[k],
        meaning: { returnedAfter: 'The settlement has already taken the money back. The credit note '
                                + 'that reduces the MTR is dated in a later month, so until that '
                                + 'month is loaded the sale still stands at full value here.',
                   deferred: 'The transaction is in the report but marked deferred — Amazon is '
                           + 'holding it, usually until delivery is confirmed.',
                   shortPaid: 'Nothing in the three files explains the difference. This is the only '
                            + 'group worth taking to Amazon.',
                   overPaid: 'More was credited than the invoice asked for, usually a reversal '
                           + 'landing against the wrong order.' }[k],
        count: mine.length,
        amount: sum(mine, 'shortfall'),
      };
    }).filter((x) => x.count),

    /* which later months the "paid later" orders actually landed in */
    laterByMonth: Object.entries(
      rows.filter((x) => x.bucket === 'settledLater')
        .reduce((a, x) => {
          const k = x.paidMonth || 'unknown';
          a[k] = a[k] || { month: k, orders: 0, amount: 0 };
          a[k].orders += 1; a[k].amount = r2(a[k].amount + x.mtrValue);
          return a;
        }, {}),
    ).map(([, v]) => v).sort((a, b) => String(a.month).localeCompare(String(b.month))),
  };
}

module.exports = { build, BUCKETS, foldMtr, foldSettlement };

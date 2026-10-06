/* Synthetic edge-case harness. Feeds crafted rows straight into the real
   processors, so a failure here is a failure in production code. */
const { buildLedger, BASIS } = require('../src/services/processors/amazonReceivablesLedger');
const ovm = require('../src/services/processors/amazonOrderVsMtr');
const mvs = require('../src/services/processors/amazonMtrVsSettlement');
const { monthKey, isoDay, r2, cashDate } = require('../src/services/processors/amazonThreeWay');

let pass = 0, fail = 0;
const T = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const near = (name, got, want, tol = 0.011) => {
  const ok = Math.abs((got || 0) - want) <= tol;
  if (ok) pass++; else { fail++; console.log(`  FAIL ${name}  got ${got}  want ${want}`); }
};

console.log('--- DATE PARSING ---');
T('iso',        monthKey('2026-03-01 10:13:56'), '2026-03');
T('dd-mm-yyyy', monthKey('01-03-2026 10:13'),    '2026-03');
T('dd-mm-yy',   monthKey('01-01-26 20:53'),      '2026-01');
T('m/d/yyyy',   monthKey('6/17/2025 18:46'),     '2025-06');
T('d Mon yyyy', monthKey('1 Jun 2026 7:20:46 am UTC'), '2026-06');
T('bare month', monthKey('2026-04'),             '2026-04');
T('empty',      monthKey(''),                    '');
T('null',       monthKey(null),                  '');
T('garbage',    monthKey('not a date'),          '');
T('day 13+ slash rejects D/M', monthKey('17/6/2025 10:00'), '');
T('isoDay iso',     isoDay('2026-03-01 10:13:56'), '2026-03-01');
T('isoDay ddmmyyyy',isoDay('01-03-2026 10:13'),    '2026-03-01');
T('isoDay mdyyyy',  isoDay('6/17/2025 18:46'),     '2025-06-17');
T('isoDay empty',   isoDay(''),                    '');
T('isoDay garbage', isoDay('xx'),                  '');
/* UTC->IST roll: 31 Dec 18:40 UTC is 1 Jan IST */
T('year roll utc->ist', monthKey('2026-12-31T18:40:00'), '2027-01');
T('day roll utc->ist',  isoDay('2026-06-30T19:00:00'),   '2026-07-01');

console.log('--- WHEN THE MONEY ARRIVED ---');
/* Amazon holds the money a median of 11.4 days, so the date it RECORDS a
   transaction and the date it RELEASES the cash are different months often
   enough to matter at a year end. */
T('release date wins over the posted date',
  monthKey(cashDate({ 'date/time': '3 Jul 2026 7:48:26 am UTC',
                      'Transaction Release Date': '18 Jul 2026 11:40:05 pm UTC' })), '2026-07');
T('a March posting released in April is APRIL cash',
  monthKey(cashDate({ 'date/time': '31 Mar 2026 11:08:33 pm UTC',
                      'Transaction Release Date': '12 Apr 2026 8:51:50 pm UTC' })), '2026-04');
T('the column present and EMPTY means deferred, so no cash month',
  monthKey(cashDate({ 'date/time': '1 Aug 2026 1:00:00 am UTC',
                      'Transaction Release Date': '' })), '');
/* The settlement pivot hands back a real DATE, not a string. String()-ing it
   gives "Sat Jul 18 2026 ..." which monthKey matches with none of its
   patterns and silently returns '' — that marked 916 ordinary ledger-sourced
   payments as deferred and moved 3.1 lakh out of "received". */
T('a ledger Date object survives (never String() it)',
  monthKey(cashDate({ date_time: new Date('2026-07-18T23:40:05.000Z') })), '2026-07');
T('a ledger row with no release column falls back to its own date',
  monthKey(cashDate({ 'date/time': '18 Jul 2026 11:40:05 pm UTC' })), '2026-07');
T('an invalid Date does not become a month', monthKey(cashDate({ date_time: new Date('x') })), '');

console.log('--- LEDGER EDGE CASES ---');
const O = (id, date, status, qty, price, ch) => ({
  'amazon-order-id': id, 'purchase-date': date, 'item-status': status,
  'order-status': status, quantity: String(qty), 'item-price': price == null ? '' : String(price),
  'sales-channel': ch || 'Amazon.in',
});
const M = (id, type, invDate, amt, extra) => Object.assign({
  'Order Id': id, 'Transaction Type': type, 'Invoice Date': invDate,
  'Shipment Date': invDate, 'Invoice Amount': String(amt),
  'Total Tax Amount': '0', 'Principal Amount': String(amt),
}, extra || {});
const S = (id, dt, sales, total, extra) => Object.assign({
  order_id: id, 'date/time': dt, type: 'Order', product_sales: String(sales),
  total: String(total), __src: 'upload:f1',
}, extra || {});

const months = ['2026-01', '2026-02'];
const src = {
  orders: [
    O('A-NORMAL',   '2026-01-05T10:00:00', 'Shipped',   1, 100),
    O('B-CANCEL0',  '2026-01-06T10:00:00', 'Cancelled', 0, null),
    O('C-CANCELPR', '2026-01-07T10:00:00', 'Cancelled', 0, 500),   // prepaid, price present
    O('D-UNSHIP',   '2026-01-08T10:00:00', 'Unshipped', 1, 200),
    Object.assign(O('E-BLANKST', '2026-01-09T10:00:00', '', 0, null),
    { 'order-status': 'Cancelled' }),   // item-status blank, order-status set
    O('F-FREEREP',  '2026-01-10T10:00:00', 'Shipped',   1, 0),     // free replacement
    O('G-XMONTH',   '2026-01-11T10:00:00', 'Shipped',   1, 300),   // returned in Feb
    O('H-MCF',      '2026-01-12T10:00:00', 'Shipped',   1, 400, 'Non-Amazon'),
    O('I-ZEROVAL',  '2026-01-13T10:00:00', 'Shipped',   1, 0),
    O('J-MULTI',    '2026-01-14T10:00:00', 'Shipped',   1, 150),
    O('J-MULTI',    '2026-01-14T10:00:00', 'Cancelled', 0, 150),   // partial cancel
  ],
  mtr: [
    M('A-NORMAL', 'Shipment', '2026-01-05 10:30', 100),
    M('C-CANCELPR','Cancel',  '2026-01-07 10:30', 0),
    M('F-FREEREP','FreeReplacement','2026-01-10 10:30', 0),
    M('G-XMONTH', 'Shipment', '2026-01-11 10:30', 300),
    M('G-XMONTH', 'Refund',   '2026-01-11 10:30', -300,
      { 'Credit Note Date': '2026-02-14 09:00', 'Credit Note No': 'CN-1' }),
    M('I-ZEROVAL','Shipment', '2026-01-13 10:30', 0),
    M('J-MULTI',  'Shipment', '2026-01-14 10:30', 150),
    M('PRIOR-1',  'Refund',   '2025-11-02 10:00', -99,
      { 'Credit Note Date': '2026-01-20 09:00', 'Credit Note No': 'CN-0' }),
    M('K-MTRONLY','Shipment', '2026-01-15 10:30', 250),            // no order row
  ],
  settlement: [
    S('A-NORMAL', '5 Jan 2026 10:00', 100, 90),
    S('G-XMONTH', '11 Jan 2026 10:00', 300, 280),
    S('G-XMONTH', '14 Feb 2026 10:00', -300, -280),                // clawback
    S('J-MULTI',  '14 Jan 2026 10:00', 150, 140),
    S('DUP-1',    '6 Jan 2026 10:00', 50, 45),
    S('DUP-1',    '6 Jan 2026 10:00', 50, 45),                     // genuine repeat, same file
  ],
  uploadedMonths: ['2026-01', '2026-02'],
  files: {},
};

const led = buildLedger(src, months, { basis: BASIS.ORDER });
const byId = Object.fromEntries(led.rows.map((r) => [r.orderId, r]));
const jan = led.perMonth.find((m) => m.month === '2026-01');
const feb = led.perMonth.find((m) => m.month === '2026-02');

T('every order has a row', led.rows.length >= 10, true);
T('MCF excluded from billable', byId['H-MCF'] && /MCF/.test(byId['H-MCF'].status), true);
T('cancelled qty0 flagged',    byId['B-CANCEL0'].status, 'Cancelled');
T('prepaid cancel still cancelled', byId['C-CANCELPR'].status, 'Cancelled');
T('blank item-status falls back',   byId['E-BLANKST'].status, 'Cancelled');
/* K-MTRONLY is a real invoice with no order row — it IS January revenue */
near('Jan invoiced', jan.invoiced.amount, 100 + 300 + 0 + 150 + 250);
T('cross-month return dated to Feb', byId['G-XMONTH'].refundMonth, '2026-02');
T('credit note captured',            byId['G-XMONTH'].creditNote, 'CN-1');
T('return DATE captured',            byId['G-XMONTH'].refundDate, '2026-02-14');
T('sale date captured',              byId['A-NORMAL'].saleDate, '2026-01-05');
/* PRIOR-1's credit note is dated 20 Jan, so it IS January's return even though
   the sale predates the window — that is the credit-note rule working */
near('Jan returns = the prior-period credit note only', jan.returned.amount, 99);
near('Feb returns carry the Jan sale',       feb.returned.amount, 300);
T('Feb return is flagged as earlier-month', feb.returned.earlier.amount >= 300, true);
near('prior-period refund captured', (led.priorPeriodRefunds || []).reduce((a, p) => a + p.amount, 0), 99);
near('genuine repeat payment kept (not de-duped)', byId['DUP-1'] ? byId['DUP-1'].settled : 90, 90);

console.log('--- DEFERRED IS A RECEIVABLE ---');
/* Amazon records the sale and holds the money. It has not paid and it has not
   refused, so it is OURS and still owed - it must never read as received. */
{
  const O2 = (id, d, st, q, pr) => ({ 'amazon-order-id': id, 'purchase-date': d,
    'item-status': st, 'order-status': st, quantity: String(q), 'item-price': String(pr),
    'sales-channel': 'Amazon.in' });
  const M2 = (id, d, t, amt) => ({ 'Order Id': id, 'Invoice Date': d, 'Shipment Date': d,
    'Transaction Type': t, 'Invoice Amount': String(amt), 'Total Tax Amount': '0' });
  /* a settlement row that is DEFERRED: the release column is present and empty.
     Note it carries product sales and fees, which is exactly what the payout
     fallback would otherwise rebuild a payment out of. */
  const S2 = (id, when, total, ps, fee) => ({ __src: 'u', order_id: id, 'date/time': when,
    'Transaction Release Date': '', type: 'Order', total: String(total),
    product_sales: String(ps), 'selling fees': String(fee),
    'TDS (Section 194-O)': '0', 'TCS-CGST': '0' });
  const src2 = {
    orders: [O2('DEF-1', '2026-05-04T05:00:00Z', 'Shipped', 1, 1000)],
    mtr: [M2('DEF-1', '2026-05-04 10:00', 'Shipment', 1000)],
    settlement: [S2('DEF-1', '5 May 2026 10:00:00 am UTC', 900, 1000, -100)],
    uploadedMonths: [], files: {},
  };
  const l2 = buildLedger(src2, ['2026-05'], { basis: BASIS.ORDER });
  const m2 = l2.perMonth[0];
  const row = l2.rows.find((r) => r.orderId === 'DEF-1');
  near('deferred money is NOT received',      m2.settled.amount, 0);
  near('deferred money stays outstanding',    m2.stillOpen.amount, m2.expected.amount);
  near('deferred is reported on its own line', m2.deferred.amount, 900);
  T('deferred count',                          m2.deferred.count, 1);
  T('the order says who is holding it',        row.status, 'Held by Amazon (deferred)');
  /* the payout fallback rebuilds a payment from product sales when a source
     carries no `total`; on a deferred row that would hand the money straight
     back as received */
  near('the payout fallback does not resurrect it', row.settled, 0);
}

console.log('--- ORDER vs MTR EDGE CASES ---');
const iv = ovm.build(src, months, {});
const bk = Object.fromEntries(iv.buckets.map((b) => [b.key, b.count]));
const rowOf = (id) => iv.rows.find((r) => r.orderId === id);
T('free replacement bucketed',  rowOf('F-FREEREP').bucket, 'freeReplacement');
T('cancelled-before-invoice',   rowOf('B-CANCEL0').bucket, 'cancelledBeforeInvoice');
T('invoiced-then-cancelled',    rowOf('C-CANCELPR').bucket, 'invoicedThenCancelled');
T('not shipped',                rowOf('D-UNSHIP').bucket, 'notShipped');
T('mtr only',                   rowOf('K-MTRONLY').bucket, 'mtrOnly');
T('zero-value shipped+invoiced is matched', rowOf('I-ZEROVAL').bucket, 'matched');
T('every order in exactly one bucket',
  Object.values(bk).reduce((a, b) => a + b, 0), iv.rows.length);
near('gap fully explained', Math.abs(iv.revenue.unexplained), 0, 0.02);

console.log('--- MTR vs SETTLEMENT ---');
/* gross must be DERIVED from the stated total plus the deductions, because a
   month restored from a retained settlement ledger has no GST, shipping or
   rebate column at all. Rebuilding gross from those columns returned zero for
   every such month and made 1,019 ordinary Koparo orders read as short-paid. */
const sRow = (id, when, type, total, fees, tds, tcs, extra = {}) => ({
  __src: 'u1', order_id: id, 'date/time': when, type,
  total: String(total), 'selling fees': String(fees),
  'TDS (Section 194-O)': String(tds), 'TCS-CGST': String(tcs), ...extra,
});
const mRow = (id, date, type, amt) => ({
  'Order Id': id, 'Invoice Date': date, 'Shipment Date': date, 'Transaction Type': type,
  'Invoice Amount': String(amt), 'Invoice Number': 'IN-' + id,
});
const mmSrc = {
  mtr: [
    mRow('P-PAID',   '2026-05-04 10:00', 'Shipment', 1000),
    mRow('P-LATER',  '2026-05-28 10:00', 'Shipment', 500),
    mRow('P-NEVER',  '2026-05-10 10:00', 'Shipment', 300),
    mRow('P-RETMTR', '2026-05-06 10:00', 'Shipment', 700),
    mRow('P-RETMTR', '2026-05-20 10:00', 'Refund',  -700),
  ],
  settlement: [
    /* gross 1000 = total 880 + fees 100 + tds 5 + tcs 15 */
    sRow('P-PAID',   '4 May 2026 10:00:00 am UTC', 'Order',  880, -100, -5, -15),
    sRow('P-LATER',  '3 Jun 2026 10:00:00 am UTC', 'Order',  440,  -50, -3,  -7),
    sRow('P-RETMTR', '6 May 2026 10:00:00 am UTC', 'Order',  616,  -70, -4, -10),
    sRow('P-RETMTR', '20 May 2026 9:00:00 am UTC', 'Refund', -616,  70,  4,  10),
    /* money in the period for a sale with no invoice in it */
    sRow('P-OLD',    '9 May 2026 10:00:00 am UTC', 'Order',  220,  -25, -2,  -3),
    /* a Transfer is the bank sweep, never a settlement of an invoice */
    sRow('',         '9 May 2026 10:00:00 am UTC', 'Transfer', -5000, 0, 0, 0),
  ],
};
const mm = mvs.build(mmSrc, ['2026-05'], { basis: 'order' });
const mb = Object.fromEntries(mm.buckets.map((b) => [b.key, b]));
const mrow = (id) => mm.rows.find((r) => r.orderId === id);
T('paid inside the period',        mrow('P-PAID').bucket, 'settledInPeriod');
T('paid in a later month',         mrow('P-LATER').bucket, 'settledLater');
T('never paid',                    mrow('P-NEVER').bucket, 'neverSettled');
T('settlement with no invoice here', mrow('P-OLD').bucket, 'settlementOnly');
near('gross derived from total + deductions', mrow('P-PAID').settledGross, 1000);
near('later order credits nothing by the period end', mrow('P-LATER').settledGross, 0);
T('later order names the month it was paid', mrow('P-LATER').paidMonths, 'Jun 2026');
near('matched gross equals the invoice', mb.settledInPeriod.mtrValue - mb.settledInPeriod.settledGross, 0);
T('a shortfall is only asked of orders paid in the period', mrow('P-LATER').shortReason, '');
near('MTR refund inside the period nets off', mrow('P-RETMTR').mtrValue, 0);
T('every invoiced order lands in exactly one bucket',
  mb.settledInPeriod.count + mb.settledLater.count + mb.neverSettled.count, 4);
T('coverage counts the invoiced orders only', mm.coverage.ofOrders, 4);
T('Transfer rows are not settlements of an invoice',
  mm.rows.some((r) => !r.orderId), false);
/* P-RETMTR was charged 70 and refunded 70, so its fee is NIL, not 140 - the
   deductions are accumulated signed and the magnitude taken once at the end.
   Taking abs() per row would report 240 here and overstate every month. */
near('fees reported, never netted into the comparison', mb.settledInPeriod.fees, 100);
near('a reversed fee cancels rather than doubling', mrow('P-RETMTR').fees, 0);
T('later months are listed by name', mm.laterByMonth.map((x) => x.month), ['2026-06']);

const mmEmpty = mvs.build({ mtr: [], settlement: [] }, ['2026-05'], {});
T('empty builds',            mmEmpty.rows.length, 0);
T('empty coverage is 0 not NaN', mmEmpty.coverage.pctByValue, 0);
T('empty has no shortfall reasons', mmEmpty.shortfallBy.length, 0);

console.log('--- EMPTY / DEGENERATE ---');
const empty = buildLedger({ orders: [], mtr: [], settlement: [], uploadedMonths: [], files: {} },
                          ['2026-05'], { basis: BASIS.ORDER });
T('empty month builds',        empty.perMonth.length, 1);
near('empty month invoiced 0', empty.perMonth[0].invoiced.amount, 0);
near('empty month expected 0', empty.perMonth[0].expected.amount, 0);
const ivEmpty = ovm.build({ orders: [], mtr: [], settlement: [] }, ['2026-05'], {});
T('empty invoicing builds', ivEmpty.orders, 0);
T('empty match rate is 0 not NaN', ivEmpty.matchRate, 0);
T('empty timing does not crash', ivEmpty.invoiceTiming.sample, 0);

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
process.exit(fail ? 1 : 0);

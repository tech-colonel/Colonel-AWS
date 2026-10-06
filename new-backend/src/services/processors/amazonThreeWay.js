/* ──────────────────────────────────────────────────────────────────────────────
   amazonThreeWay.js — Amazon Receivables: order report → MTR → settlement.

   WHY THREE AND NOT TWO. For weeks the settlement and the MTR would not agree
   and nothing explained it: 330 of ~550 July orders overlapped and the rest
   looked like missing data. They were not. They were CANCELLED — and only the
   order report carries `order-status`. The MTR excludes a cancelled order
   because it was never invoiced; the settlement excludes it because it was
   never paid. Two sources that both correctly omit the same orders can never
   explain why they are missing. The third leg is what makes the gap nameable.

   THE THREE POPULATIONS ARE NOT MEANT TO BE EQUAL.

     order report   every order PLACED       the widest net; the only one that
                                             knows about cancellations
     MTR            only what was SHIPPED    fewer, by design
     settlement     only what was PAID       lags: Amazon settles weekly, so the
                                             end of a month always settles in
                                             the month after

   So the reconciliation is a CHAIN, not three totals that should match:

     placed − cancelled = net
     net − not-yet-invoiced = shipped
     shipped − not-yet-settled = settled

   Every subtraction names a countable group. Nothing is a balancing figure.

   VALUE IS NOT THE RECONCILING MEASURE — the order count is. Each source
   measures money differently (item-price / Invoice Amount / product sales), so
   the three value totals legitimately differ. All three are GST-INCLUSIVE:
   `item-price` contains its `item-tax`, the MTR's Principal and Invoice Amount
   contain their Total Tax Amount, and the settlement's `total` is what hit the
   bank. Value is carried for context and for sizing what is outstanding,
   never as proof.
   ────────────────────────────────────────────────────────────────────────────── */

const r2 = (n) => Number((n || 0).toFixed(2));
const num = (v) => {
  const s = String(v == null ? '' : v).replace(/,/g, '').trim();
  if (!s) return 0;
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : 0;
};

/* Amazon stamps UTC; an Indian accountant reads IST. An order placed 23:40 UTC
   on the 31st belongs to the next month once +5:30 is applied, and being a day
   out at a month boundary is exactly what makes a reconciliation argue. */
const IST_MS = 5.5 * 60 * 60 * 1000;
const MONTH_NAMES = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/* The same parsing as monthKey, but keeping the DAY. Four date formats appear
   across the MTR — ISO, DD-MM-YYYY, DD-MM-YY and M/D/YYYY — so the day cannot
   be sliced off a string; it has to be parsed the same way the month is.
   Returns YYYY-MM-DD, in IST, or '' when nothing parses. */
function isoDay(value) {
  if (value == null || value === '') return '';
  const mk = monthKey(value);
  if (!mk) return '';
  const s = String(value).trim();
  let d = null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2})?:?(\d{2})?/);
  if (m) d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)));
  if (!d) { m = s.match(/^(\d{2})-(\d{2})-(\d{4})[ T]?(\d{1,2})?:?(\d{2})?/);
            if (m) d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0))); }
  if (!d) { m = s.match(/^(\d{2})-(\d{2})-(\d{2})(?!\d)[ T]?(\d{1,2})?:?(\d{2})?/);
            if (m) d = new Date(Date.UTC(2000 + +m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0))); }
  if (!d) { m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T]?(\d{1,2})?:?(\d{2})?/);
            if (m && +m[1] >= 1 && +m[1] <= 12) {
              d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0))); } }
  if (!d || Number.isNaN(d.getTime())) return '';
  /* ISO strings already carry a zone; the bare local formats are IST wall time.
     Only shift the ones monthKey shifts, so the day and the month never
     disagree with each other. */
  const iso = /^\d{4}-\d{2}-\d{2}[T ]/.test(s);
  const i = iso ? new Date(d.getTime() + IST_MS) : d;
  return `${i.getUTCFullYear()}-${String(i.getUTCMonth() + 1).padStart(2, '0')}-${String(i.getUTCDate()).padStart(2, '0')}`;
}

function monthKey(value) {
  if (value == null || value === '') return '';
  /* The pivot hands back a real Date; the files hand back strings. Stringifying
     a Date gives "Mon Jun 01 2026 …", which matches neither pattern below and
     silently yields '' — which in turn made every ledger month unmatchable and
     stopped the de-duplication against uploaded months working at all. */
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const i = new Date(value.getTime() + IST_MS);
    return `${i.getUTCFullYear()}-${String(i.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const s = String(value).trim();
  if (!s) return '';
  /* A bare YYYY-MM is already a month key — the MTR's per-file fallback uses
     it, and without this it parsed as nothing and the whole cohort lost its
     month. */
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  /* ISO first — the order report and MTR both use it */
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2})?:?(\d{2})?/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)));
    const i = new Date(d.getTime() + IST_MS);
    return `${i.getUTCFullYear()}-${String(i.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  /* DD-MM-YYYY. Amazon's MTR export is NOT consistent between files: the July
     B2C file dates as 2026-07-01 while the June and August files of the same
     report type date as 03-06-2026. Reading only ISO left those two months
     without an invoice month at all, and they silently fell back to the order
     report's purchase date — a different thing, and one that would quietly
     mis-state which month a receivable belongs to.
     13-08-2026 exists in the data, so the leading field is the day. */
  m = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) {
    const dd = +m[1], mm = +m[2];
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return `${m[3]}-${m[2]}`;
  }
  /* DD-MM-YY — a THIRD format, and the one that breaks silently. The Credit
     Note Date column writes the year as two digits in the January-2026 files
     ("01-01-26 20:53") while the same column is ISO in 447 other rows and
     DD-MM-YYYY in 53. The \d{4} branch above rejects it and returns '',
     which would drop 29 credit notes out of their month. Day-first, to match
     the DD-MM-YYYY branch; 2-digit years are this century. */
  m = s.match(/^(\d{2})-(\d{2})-(\d{2})(?!\d)/);
  if (m) {
    const dd = +m[1], mm = +m[2];
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return `20${m[3]}-${m[2]}`;
  }
  /* M/D/YYYY — a FOURTH format, and only one file uses it. The June-2025 B2C
     MTR writes every date as 6/17/2025 while every other file writes ISO or
     DD-MM-YYYY. Month-first is not a guess: across the 2,134 slash values in
     that file, 1,574 have a SECOND field above 12 (impossible as a month) and
     NONE has a first field above 12, and the first field always equals the
     file's own month. Guarded on both counts so a D/M file could never be read
     backwards here — if the first field exceeds 12 it falls through. */
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const mo = +m[1], dd = +m[2];
    if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
      return `${m[3]}-${String(mo).padStart(2, '0')}`;
    }
  }
  /* "1 Jun 2026 7:20:46 am UTC" — the unified transaction report's format */
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (m) {
    const mm = MONTH_NAMES[m[2].toLowerCase()];
    return mm ? `${m[3]}-${mm}` : '';
  }
  return '';
}

/* ── leg 1: the order report ──────────────────────────────────────────────
   One row per LINE ITEM, so an order with three SKUs is three rows. Folding to
   the order is what makes the counts comparable with the other two legs. */
function foldOrders(rows) {
  const byOrder = new Map();
  for (const r of rows) {
    const id = String(r['amazon-order-id'] || '').trim();
    if (!id) continue;
    let o = byOrder.get(id);
    if (!o) {
      o = { id, month: monthKey(r['purchase-date']), statuses: new Set(),
            value: 0, tax: 0, gross: 0, grossTax: 0, cancelledValue: 0,
            channel: '', shipState: '', lines: 0 };
      byOrder.set(id, o);
    }
    o.lines += 1;
    const st = String(r['order-status'] || '').trim();
    o.statuses.add(st);
    o.shipState = o.shipState || String(r['ship-state'] || '').toUpperCase();
    o.channel = o.channel || String(r['sales-channel'] || '').trim();
    /* `item-tax` is the GST CONTAINED IN `item-price`, not an addition to it.
       A line reading item-price 345.00 with item-tax 52.63 is 345 inclusive of
       18% GST (345 x 18/118 = 52.63), which is also why `item-price` ties to
       the MTR's Principal Amount to the paisa. Adding the two overstated every
       order-report amount by about 15%. The tax is carried alongside so a rung
       can be shown net of GST — never added on top of it. */
    const price = num(r['item-price']);
    const tax = num(r['item-tax']);
    o.gross += price; o.grossTax += tax;
    /* A cancelled line was never charged, so it carries no value in the live
       figure. It is kept separately because the gross-to-net walk has to show
       what was cancelled, and cannot show it out of a field that excludes it. */
    if (st !== 'Cancelled') { o.value += price; o.tax += tax; }
    else o.cancelledValue += price;
  }
  for (const o of byOrder.values()) {
    o.value = r2(o.value); o.tax = r2(o.tax);
    o.gross = r2(o.gross); o.grossTax = r2(o.grossTax);
    o.cancelledValue = r2(o.cancelledValue);
    o.cancelled = o.statuses.size === 1 && o.statuses.has('Cancelled');
    /* "Not an Amazon sale" (MCF): Amazon shipped it, but the order was taken on
       another website, so Amazon never raises a tax invoice for it and never
       pays for it. It is not a step of the chain — it is a door orders leave
       by, and every one of them carries an item-price of zero. */
    o.mcf = !!(o.channel && !/^amazon/i.test(o.channel));
    o.status = [...o.statuses].sort().join(', ');
  }
  return byOrder;
}

/* ── leg 2: the MTR ───────────────────────────────────────────────────────
   Only `Shipment` rows count as invoiced. Cancel and Refund rows exist in the
   same file and would double-count an order that was shipped and then returned. */
function foldMtr(rows) {
  const byOrder = new Map();
  for (const r of rows) {
    const id = String(r['Order Id'] || r['order_id'] || '').trim();
    if (!id) continue;
    const txn = String(r['Transaction Type'] || r['txn'] || '').trim();
    let m = byOrder.get(id);
    if (!m) { m = { id, txns: new Set(), value: 0, shipped: false, invMonth: '', shipMonth: '' }; byOrder.set(id, m); }
    m.txns.add(txn);
    if (txn === 'Shipment') {
      m.shipped = true;
      m.value += num(r['Invoice Amount'] ?? r['amount']);
      /* both dates, because the SALES BASIS decides which one books the sale and
         the chain has to describe the same months the ledger does — otherwise
         the two halves of one report count different populations */
      m.invMonth = m.invMonth || monthKey(r['Invoice Date'] || r.file_month);
      m.shipMonth = m.shipMonth || monthKey(r['Shipment Date'] || r['Invoice Date'] || r.file_month);
    }
  }
  for (const m of byOrder.values()) m.value = r2(m.value);
  return byOrder;
}

/* ── leg 3: the settlement ────────────────────────────────────────────────
   Accepts either shape, because both are legitimate sources and a month may
   only be available as one of them:
     • the pivoted wide row the agent already stores
     • Amazon's unified transaction report, which is the ONLY way to recover a
       month whose raw ledgers have aged past the API's 90-day window */
function foldSettlement(rows) {
  const byOrder = new Map();
  for (const r of rows) {
    const id = String(r.order_id ?? r['order id'] ?? r['order-id'] ?? '').trim();
    if (!id) continue;
    let s = byOrder.get(id);
    if (!s) {
      s = { id, month: monthKey(r.date_time ?? r['date/time'] ?? r.month), sales: 0, types: new Set() };
      byOrder.set(id, s);
    }
    s.types.add(String(r.type || '').trim());
    s.sales += num(r.product_sales ?? r['product sales']);
  }
  for (const s of byOrder.values()) s.sales = r2(s.sales);
  return byOrder;
}

/**
 * Run the chain for a set of months.
 *
 * @param {object} src  { orders, mtr, settlement } — arrays of raw rows
 * @param {string[]} months  e.g. ['2026-06','2026-07','2026-08']
 * @param {object} opts  { basis } — 'order' or 'dispatch'; must match the ledger
 */
const COUNT_KEYS = ['placed', 'cancelled', 'net', 'mcf', 'notInvoicedFree', 'notInvoiced',
                   'shipped', 'settled', 'unsettled'];
const VALUE_KEYS = ['valuePlaced', 'valueCancelled', 'valueMcf', 'valueNotInvoicedFree', 'valueNotInvoiced',
                    'valueInvoiced', 'valueSettled', 'valueNet', 'valueUnsettled',
                    'taxPlaced', 'taxInvoiced'];

function reconcile(src, months, opts = {}) {
  const basis = opts.basis || 'dispatch';
  const O = foldOrders(src.orders || []);
  const M = foldMtr(src.mtr || []);
  const S = foldSettlement(src.settlement || []);

  /* The chain must sit in the same months as the ledger. On an ORDER basis that
     is the purchase date the order report carries; on a DISPATCH basis it is the
     MTR's shipment date, falling back to the purchase date for an order that
     never shipped — which is exactly the group a dispatch basis is meant to
     push into a later month. */
  for (const o of O.values()) {
    const m = M.get(o.id);
    o.placedMonth = o.month;
    o.month = basis === 'order' ? o.month
      : (m && (m.shipMonth || m.invMonth)) || o.month;
  }

  const inWindow = (m) => months.includes(m);
  const shipped = new Set([...M.values()].filter((m) => m.shipped).map((m) => m.id));
  /* "Settled" means the order HAS been paid — not "was paid inside this
     window". Restricting it to the window made an order that settled in
     September count as unsettled, so this tab reported 148 outstanding while
     the receivables ledger, asking the same question without that restriction,
     reported 4. Two tabs of one workbook disagreeing on one quantity is worse
     than either answer. The window already decides which orders are in scope;
     it has no business also deciding whether they were paid. */
  const settled = new Set([...S.values()].map((s) => s.id));

  /* ── THE CHAIN ───────────────────────────────────────────────────────────
     Every order leaves by exactly one door, so each step subtracts cleanly to
     the next and nothing sits between two cards unexplained.

         placed - cancelled - notAnAmazonSale - notInvoiced = invoiced
         invoiced - unsettled = settled

     Before this the screen showed placed, cancelled and invoiced only: 22,191
     - 1,913 = 20,278 against an invoiced count of 20,157, and the 121 in
     between were nowhere on the page. They are 107 MCF orders plus 14 Amazon
     orders that shipped without an invoice ever reaching the MTR.

     "Not an Amazon sale" used to be shown as a sixth card beside the others,
     which double-counted: 17 of its 124 were already inside Cancelled and the
     other 107 inside that 121 gap. It is a rung now, at its own level. */
  const V = (a, k) => r2(a.reduce((x, o) => x + (o[k || 'value'] || 0), 0));
  const perMonth = months.map((month) => {
    const all = [...O.values()].filter((o) => o.month === month);
    const canc = all.filter((o) => o.cancelled);
    const net = all.filter((o) => !o.cancelled);
    const mcf = net.filter((o) => o.mcf);
    const rest = net.filter((o) => !o.mcf);
    const missing = rest.filter((o) => !shipped.has(o.id));
    /* Two very different things were sitting in one bucket. An order with an
       item-price of ZERO and no MTR row is a replacement sent at no charge —
       there is nothing to invoice and nothing to claim. An order with a real
       price and no MTR row is goods that left the warehouse with no tax
       invoice behind them, which is the only one of the two worth chasing.
       On this data the split is 12 free replacements against 2 priced orders,
       and both of the priced ones are the latest month, whose invoices are in
       the following month's MTR. */
    const noInvFree = missing.filter((o) => !o.value);
    const noInv = missing.filter((o) => o.value > 0);
    const sh = rest.filter((o) => shipped.has(o.id));
    /* Settlement is asked of the INVOICED orders, not of every live order.
       Asking it of the live orders counted the MCF orders as unpaid — they are
       not unpaid, Amazon was never going to pay for them — and produced a
       "paid" count of 20,171 sitting directly under an "invoiced" count of
       20,157, which is how the chain came to show more orders paid than were
       ever billed. */
    const se = sh.filter((o) => settled.has(o.id));
    const un = sh.filter((o) => !settled.has(o.id));
    return {
      month,
      placed: all.length,
      cancelled: canc.length,
      net: net.length,
      mcf: mcf.length,
      notInvoicedFree: noInvFree.length,
      notInvoiced: noInv.length,
      shipped: sh.length,
      settled: se.length,
      unsettled: un.length,
      /* GST-inclusive throughout; the tax contained in each is reported beside
         it so a rung can be read either way without ever adding the two. */
      valuePlaced: V(all, 'gross'),
      valueCancelled: V(canc, 'cancelledValue'),
      valueMcf: V(mcf),
      valueNotInvoicedFree: V(noInvFree),
      valueNotInvoiced: V(noInv),
      valueInvoiced: V(sh),
      valueSettled: V(se),
      valueNet: V(net),
      valueUnsettled: V(un),
      taxPlaced: V(all, 'grossTax'),
      taxInvoiced: V(sh, 'tax'),
      /* a month is clean when everything that could settle, did */
      clean: un.length === 0 || V(un) === 0,
    };
  });

  const net = [...O.values()].filter((o) => inWindow(o.month) && !o.cancelled);
  const netIds = new Set(net.map((o) => o.id));
  /* Outstanding means INVOICED AND NOT PAID. An MCF order is neither invoiced
     nor payable, and listing it here is what made 107 orders read as unpaid
     money when not one rupee of it was ever owed. */
  const unsettled = net.filter((o) => !o.mcf && shipped.has(o.id) && !settled.has(o.id))
    .map((o) => ({ orderId: o.id, month: o.month, status: o.status,
                   inMtr: shipped.has(o.id), value: o.value, shipState: o.shipState }))
    .sort((a, b) => (a.month === b.month ? b.value - a.value : a.month.localeCompare(b.month)));

  return {
    months,
    perMonth,
    totals: perMonth.reduce((t, m) => {
      const o = { ...t };
      for (const k of COUNT_KEYS) o[k] = t[k] + m[k];
      for (const k of VALUE_KEYS) o[k] = r2(t[k] + m[k]);
      return o;
    }, Object.fromEntries([...COUNT_KEYS, ...VALUE_KEYS].map((k) => [k, 0]))),
    legs: {
      orderToMtr: {
        both: net.filter((o) => shipped.has(o.id)).length,
        leftOnly: net.filter((o) => !shipped.has(o.id)).length,
        rightOnly: [...shipped].filter((id) => !netIds.has(id)).length,
      },
      mtrToSettlement: {
        both: [...shipped].filter((id) => settled.has(id)).length,
        leftOnly: [...shipped].filter((id) => !settled.has(id)).length,
        rightOnly: [...settled].filter((id) => !shipped.has(id)).length,
      },
      orderToSettlement: {
        both: net.filter((o) => settled.has(o.id)).length,
        leftOnly: net.filter((o) => !settled.has(o.id)).length,
        rightOnly: [...settled].filter((id) => !netIds.has(id)).length,
      },
    },
    unsettled,
    /* ── the orders behind every step of the chain ────────────────────────
       The chain was six numbers nobody could open. A figure an accountant
       cannot drill into is a figure they have to take on trust, which is the
       one thing this report is trying not to ask for.

       One flat list rather than six, because every step is a FILTER of the
       same population — placed, cancelled, net, invoiced, settled, unsettled —
       and six pre-built lists would ship the same orders six times over. The
       flags say which file knows each fact: `cancelled` is the order report's
       own status, `invoiced` is presence in the MTR, `settled` is presence in
       the settlement. */
    orderRows: [...O.values()].filter((o) => inWindow(o.month)).map((o) => ({
      orderId: o.id, month: o.month, status: o.status, cancelled: !!o.cancelled,
      mcf: !!o.mcf, channel: o.channel,
      invoiced: shipped.has(o.id), settled: settled.has(o.id),
      value: o.value, tax: o.tax, gross: o.gross, shipState: o.shipState, lines: o.lines,
    })).sort((a, b) => (a.month === b.month ? b.value - a.value
                                            : a.month.localeCompare(b.month))),
    counts: { orderRows: (src.orders || []).length, mtrRows: (src.mtr || []).length,
              settlementRows: (src.settlement || []).length,
              orders: O.size, mtrOrders: M.size, settlementOrders: S.size },
  };
}

module.exports = { isoDay, reconcile, foldOrders, foldMtr, foldSettlement, monthKey, num, r2 };

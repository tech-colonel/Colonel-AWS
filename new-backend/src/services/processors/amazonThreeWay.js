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
   measures money differently (item-price+item-tax / Invoice Amount / product
   sales), so the three value totals legitimately differ. Value is carried for
   context and for sizing what is outstanding, never as proof.
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
            value: 0, shipState: '', lines: 0 };
      byOrder.set(id, o);
    }
    o.lines += 1;
    o.statuses.add(String(r['order-status'] || '').trim());
    o.shipState = o.shipState || String(r['ship-state'] || '').toUpperCase();
    /* A cancelled line was never charged, so it carries no value. Counting it
       would overstate what is outstanding. */
    if (String(r['order-status'] || '').trim() !== 'Cancelled') {
      o.value += num(r['item-price']) + num(r['item-tax']);
    }
  }
  for (const o of byOrder.values()) {
    o.value = r2(o.value);
    o.cancelled = o.statuses.size === 1 && o.statuses.has('Cancelled');
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
    if (!m) { m = { id, txns: new Set(), value: 0, shipped: false }; byOrder.set(id, m); }
    m.txns.add(txn);
    if (txn === 'Shipment') {
      m.shipped = true;
      m.value += num(r['Invoice Amount'] ?? r['amount']);
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
 */
function reconcile(src, months) {
  const O = foldOrders(src.orders || []);
  const M = foldMtr(src.mtr || []);
  const S = foldSettlement(src.settlement || []);

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

  const perMonth = months.map((month) => {
    const all = [...O.values()].filter((o) => o.month === month);
    const canc = all.filter((o) => o.cancelled);
    const net = all.filter((o) => !o.cancelled);
    const sh = net.filter((o) => shipped.has(o.id));
    const se = net.filter((o) => settled.has(o.id));
    const un = net.filter((o) => !settled.has(o.id));
    return {
      month,
      placed: all.length,
      cancelled: canc.length,
      net: net.length,
      shipped: sh.length,
      notInvoiced: net.length - sh.length,
      settled: se.length,
      unsettled: un.length,
      valueNet: r2(net.reduce((a, o) => a + o.value, 0)),
      valueUnsettled: r2(un.reduce((a, o) => a + o.value, 0)),
      /* a month is clean when everything that could settle, did */
      clean: un.length === 0 || r2(un.reduce((a, o) => a + o.value, 0)) === 0,
    };
  });

  const net = [...O.values()].filter((o) => inWindow(o.month) && !o.cancelled);
  const netIds = new Set(net.map((o) => o.id));
  const unsettled = net.filter((o) => !settled.has(o.id))
    .map((o) => ({ orderId: o.id, month: o.month, status: o.status,
                   inMtr: shipped.has(o.id), value: o.value, shipState: o.shipState }))
    .sort((a, b) => (a.month === b.month ? b.value - a.value : a.month.localeCompare(b.month)));

  return {
    months,
    perMonth,
    totals: perMonth.reduce((t, m) => ({
      placed: t.placed + m.placed, cancelled: t.cancelled + m.cancelled,
      net: t.net + m.net, shipped: t.shipped + m.shipped,
      notInvoiced: t.notInvoiced + m.notInvoiced, settled: t.settled + m.settled,
      unsettled: t.unsettled + m.unsettled,
      valueNet: r2(t.valueNet + m.valueNet),
      valueUnsettled: r2(t.valueUnsettled + m.valueUnsettled),
    }), { placed: 0, cancelled: 0, net: 0, shipped: 0, notInvoiced: 0, settled: 0,
          unsettled: 0, valueNet: 0, valueUnsettled: 0 }),
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
    counts: { orderRows: (src.orders || []).length, mtrRows: (src.mtr || []).length,
              settlementRows: (src.settlement || []).length,
              orders: O.size, mtrOrders: M.size, settlementOrders: S.size },
  };
}

module.exports = { reconcile, foldOrders, foldMtr, foldSettlement, monthKey, num, r2 };

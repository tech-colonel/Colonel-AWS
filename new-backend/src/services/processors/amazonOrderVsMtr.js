/* ─────────────────────────────────────────────────────────────────────────
   ORDER REPORT  vs  MTR  —  why the two files never agree, and by how much.

   Everybody who runs an Amazon account knows the order report has more lines
   than the MTR. Almost nobody can say WHY, so the gap gets written off as
   "Amazon's data is messy" and a real missing invoice hides inside it. It is
   not messy. Every line of the difference is explained by columns that are
   already in the files, and this module names each one.

   WHAT THE TWO FILES ACTUALLY ARE
     Order report — one row per order LINE, written the moment the customer
                    clicks Buy. It never disappears; a cancelled order keeps
                    its row forever, with quantity 0.
     MTR          — one row per TAX INVOICE. A row exists only once Amazon has
                    raised an invoice against the order.

   WHEN THE INVOICE IS RAISED — measured, not assumed
     Across 20,162 Koparo invoices: the invoice is raised a MEDIAN OF 30
     MINUTES after the order (98.6% inside 24 hours) and 99.9% of them are
     raised BEFORE the goods ship (median 20 hours before). So Amazon invoices
     at ORDER CONFIRMATION, not at dispatch.

   WHICH IS THE WHOLE EXPLANATION OF THE GAP
     A cancelled order is missing from the MTR only if it was cancelled inside
     that ~30 minute window, before the invoice existed. Cancel any later and
     the invoice has already been raised, so Amazon cannot simply forget it —
     the order stays in the MTR carrying a `Cancel` row. That is why 1,576
     cancellations are absent while 3,033 others are present and reversed.

   THE MARKER FOR "NOTHING SHIPPED" IS QUANTITY, NOT PRICE
     `item-price` is still populated on 329 cancelled lines (a cancelled order
     can read ₹1,794.92) because it is what the customer WOULD have paid, and
     is what gets refunded on a prepaid order. `quantity = 0` is the column
     that actually says no goods moved.
   ───────────────────────────────────────────────────────────────────────── */

const { monthKey, num, r2 } = require('./amazonThreeWay');

/* The buckets, in the order a reader should meet them. `expected` marks the
   ones that SHOULD differ — only `shippedNoInvoice` and `mtrOnly` are worth a
   second look, and even those are usually the window's own edge. */
const BUCKETS = [
  {
    key: 'matched', label: 'Invoiced — in both files', expected: true,
    meaning: 'The order was placed and Amazon raised a tax invoice for it. '
           + 'This is the normal path and the only bucket that becomes revenue.',
  },
  {
    key: 'cancelledBeforeInvoice', label: 'Cancelled before the invoice existed', expected: true,
    meaning: 'The customer cancelled within about half an hour of ordering, before Amazon had '
           + 'raised the invoice. No invoice was ever created, so there is correctly nothing in '
           + 'the MTR and nothing in GST. The order row survives with quantity 0.',
  },
  {
    key: 'invoicedThenCancelled', label: 'Invoiced, then cancelled', expected: true,
    meaning: 'The invoice had already been raised when the cancellation came, so Amazon could not '
           + 'simply drop it — the order IS in the MTR, carrying a Cancel row that reverses it. '
           + 'Nothing shipped and nothing is owed, but unlike the bucket above it did exist as an '
           + 'invoice for a while, which is why it appears in one file and not the other.',
  },
  {
    key: 'notShipped', label: 'Not shipped yet', expected: true,
    meaning: 'The order was still in the warehouse when the report was pulled. Its invoice will '
           + 'appear once Amazon ships it.',
  },
  {
    key: 'freeReplacement', label: 'Free replacement sent', expected: true,
    meaning: 'Amazon shipped a replacement for an item that arrived damaged or never arrived. '
           + 'Nothing was sold and nothing was charged \u2014 the order carries a value of zero and the '
           + 'MTR records it as a FreeReplacement, not a sale \u2014 so there is correctly no tax '
           + 'invoice and nothing in GST. Goods did move, which is why it looks like a shipment.',
  },
  {
    key: 'shippedNoInvoice', label: 'Shipped but no invoice found', expected: false,
    meaning: 'Goods left the warehouse but no tax invoice is in the MTR files we hold. Almost '
           + 'always the order shipped in the last days of the period and its invoice sits in the '
           + 'NEXT month’s MTR. Anything here that is not at the period edge is a real missing '
           + 'invoice and a GST exposure.',
  },
  {
    key: 'mtrOnly', label: 'Invoiced with no order row', expected: false,
    meaning: 'An invoice exists but the order is not in the order reports we hold — normally '
           + 'because the customer ordered BEFORE this period began and it shipped inside it. '
           + 'Load the earlier month and it pairs up.',
  },
];

/* MTR-side view of cancellation, which the order report cannot show at all. */
const CANCEL_SHAPES = [
  { key: 'cancelOnly', label: 'Invoiced, then cancelled before shipping',
    meaning: 'The invoice was already raised when the cancellation came, so Amazon reversed it on '
           + 'the record rather than deleting it. No goods ever moved.' },
  { key: 'cancelShipment', label: 'Part cancelled, the rest shipped',
    meaning: 'A multi-item order where one item was cancelled and the others went out. The order '
           + 'is both a cancellation and a sale, which is why cancellation counts and '
           + '"never invoiced" counts are different numbers.' },
  { key: 'cancelRefund', label: 'Cancelled and refunded after shipping',
    meaning: 'Goods shipped, then the order was cancelled and the money returned.' },
];

const txt = (v) => String(v ?? '').trim();

/* An order line's status. `item-status` is BLANK on every cancellation in the
   file (1,749 rows), while `order-status` carries the word — reading only
   item-status leaves a quarter of the cancellations looking unexplained. */
const lineStatus = (r) => txt(r['item-status']) || txt(r['order-status']);

function build(src, months, opts = {}) {
  const inWindow = (m) => !months.length || months.includes(m);
  const lastMonth = months[months.length - 1] || '';

  /* ── the MTR side, folded to one entry per order ───────────────────────── */
  const mtr = new Map();
  for (const r of src.mtr || []) {
    const id = txt(r['Order Id'] || r.order_id);
    if (!id) continue;
    let e = mtr.get(id);
    if (!e) {
      e = { id, types: new Set(), invoiced: 0, refunded: 0, invMonth: '', orderDate: '',
            principal: 0, shipping: 0, giftWrap: 0, promo: 0, otherDiff: 0 };
      mtr.set(id, e);
    }
    const t = txt(r['Transaction Type']);
    e.types.add(t);
    const amt = num(r['Invoice Amount']);
    if (t === 'Shipment') {
      e.invoiced += amt;
      /* Invoice Amount is NOT the item price. It is principal + shipping +
         gift wrap − promotional discounts, and the order report's `item-price`
         carries ONLY the principal. Comparing the two directly leaves a
         difference that looks like a fault and is not one, so the parts are
         kept and named. */
      const prin = num(r['Principal Amount']);
      const sh = num(r['Shipping Amount']);
      const gw = num(r['Gift Wrap Amount']);
      const ip = num(r['Item Promo Discount']);
      const sp = num(r['Shipping Promo Discount']);
      e.principal += prin;
      /* The raw columns are NOT the components of the gap. A row can record a
         Shipping Amount that is not in its Invoice Amount at all — summing the
         column therefore attributes money the invoice never carried, which is
         how a bridge can foot by coincidence while every line of it is wrong.
         Measured on 20,851 shipment rows: 20,614 have invoice EXACTLY equal to
         principal; of the 237 that differ, 212 differ by shipping + its promo
         and 25 by the item promo. So the difference is classified per row by
         what actually explains it, and anything unexplained stays visible. */
      const diff = r2(amt - prin);
      if (Math.abs(diff) >= 0.005) {
        if (Math.abs(diff - (sh + sp)) < 0.02) e.shipping += diff;
        else if (Math.abs(diff - ip) < 0.02) e.promo += diff;
        else if (Math.abs(diff - gw) < 0.02) e.giftWrap += diff;
        else e.otherDiff += diff;
      }
      e.invMonth = e.invMonth || monthKey(r['Invoice Date'] || r['Shipment Date']);
      e.orderDate = e.orderDate || txt(r['Order Date']);
    } else if (t === 'Refund') {
      e.refunded += Math.abs(amt);
    }
  }
  for (const e of mtr.values()) {
    e.invoiced = r2(e.invoiced); e.refunded = r2(e.refunded);
    e.principal = r2(e.principal); e.shipping = r2(e.shipping);
    e.giftWrap = r2(e.giftWrap); e.promo = r2(e.promo); e.otherDiff = r2(e.otherDiff);
  }

  /* ── the order side, folded to one entry per order ─────────────────────── */
  const ord = new Map();
  for (const r of src.orders || []) {
    const id = txt(r['amazon-order-id'] || r.order_id);
    if (!id) continue;
    const m = monthKey(r['purchase-date']);
    if (!inWindow(m)) continue;
    let e = ord.get(id);
    if (!e) {
      e = { id, month: m, statuses: new Set(), qty: 0, value: 0, cancelledValue: 0,
            liveValue: 0, sku: txt(r.sku), channel: txt(r['sales-channel']),
            purchaseDate: txt(r['purchase-date']) };
      ord.set(id, e);
    }
    const st = lineStatus(r);
    e.statuses.add(st);
    const q = num(r.quantity);
    const v = num(r['item-price']);
    e.qty += q;
    e.value += v;
    if (st === 'Cancelled') e.cancelledValue += v; else e.liveValue += v;
  }
  for (const e of ord.values()) {
    e.value = r2(e.value); e.cancelledValue = r2(e.cancelledValue); e.liveValue = r2(e.liveValue);
  }

  /* ── put every order in exactly one bucket ─────────────────────────────── */
  const rows = [];
  for (const o of ord.values()) {
    const inv = mtr.get(o.id);
    let bucket;
    let why;
    if (inv && inv.invoiced > 0) {
      bucket = 'matched';
      why = `Invoice raised${inv.invMonth ? ` in ${inv.invMonth}` : ''}.`;
    } else if (inv && inv.types.has('Cancel')) {
      /* It IS in the MTR — invoiced first, cancelled after, with no Shipment
         row. Filing this under "cancelled before the invoice existed" would
         have been plainly wrong: the invoice existed. */
      bucket = 'invoicedThenCancelled';
      why = 'The invoice was already raised when the cancellation came, so the MTR carries a Cancel '
          + 'row reversing it. No goods shipped.';
    } else if (o.statuses.has('Cancelled') && o.qty === 0) {
      bucket = 'cancelledBeforeInvoice';
      why = 'Cancelled with quantity 0 — nothing shipped, so no invoice was ever raised.'
          + (o.cancelledValue > 0
              ? ` The ₹${o.cancelledValue.toFixed(2)} shown is what the customer would have paid.`
              : '');
    } else if (o.statuses.has('Unshipped') || o.statuses.has('Pending')) {
      bucket = 'notShipped';
      why = 'Still in the warehouse when the report was pulled — the invoice follows the dispatch.';
    } else if (o.statuses.has('Shipped')
               && (o.value === 0 || (inv && inv.types.has('FreeReplacement')))) {
      /* A shipped order worth nothing is a replacement, not a missing invoice.
         Measured: 11 of the 13 orders that looked like missing invoices carry a
         value of zero, and the MTR holds exactly 11 FreeReplacement rows. */
      bucket = 'freeReplacement';
      why = 'Shipped at no charge as a replacement — nothing was sold, so no tax invoice is due.';
    } else if (o.statuses.has('Shipped')) {
      bucket = 'shippedNoInvoice';
      why = o.month === lastMonth
        ? `Shipped at the end of ${o.month}, the last month of this report — its invoice is in the `
          + 'next month’s MTR, which is not loaded.'
        : 'Goods shipped but no tax invoice found in the MTR files held. Worth checking.';
    } else {
      bucket = 'cancelledBeforeInvoice';
      why = `No invoice, and the order carries no shipped line (status: ${[...o.statuses].join(', ') || 'blank'}).`;
    }
    rows.push({
      orderId: o.id, bucket, why, month: o.month, qty: o.qty,
      orderValue: o.value, cancelledValue: o.cancelledValue, liveValue: o.liveValue,
      invoicedValue: inv ? inv.invoiced : 0, refundedValue: inv ? inv.refunded : 0,
      principalValue: inv ? inv.principal : 0, shippingValue: inv ? inv.shipping : 0,
      giftWrapValue: inv ? inv.giftWrap : 0, promoValue: inv ? inv.promo : 0,
      otherDiffValue: inv ? inv.otherDiff : 0,
      status: [...o.statuses].filter(Boolean).join(', ') || '(blank)',
      sku: o.sku, purchaseDate: o.purchaseDate,
      mtrTypes: inv ? [...inv.types].filter(Boolean).sort().join(', ') : '',
    });
  }

  /* invoices with no order row at all */
  for (const e of mtr.values()) {
    if (ord.has(e.id) || !(e.invoiced > 0)) continue;
    if (!inWindow(e.invMonth)) continue;
    rows.push({
      orderId: e.id, bucket: 'mtrOnly', month: e.invMonth, qty: null,
      /* The MTR dates an order in IST while the order report's purchase-date is
         UTC, so an order placed just after midnight IST on the 1st sits in the
         PREVIOUS month's order file. Three of Koparo's twelve are exactly that
         — 00:55, 02:00 and 05:12 on 1 April — and calling them simply "before
         this report begins" would send someone looking for a file they have. */
      why: e.orderDate
        ? (monthKey(e.orderDate) === e.invMonth
            ? `Ordered ${e.orderDate.slice(0, 16)} IST — just after midnight, so the order report (which `
              + 'dates in UTC) files it in the previous month. Load that month and it pairs up.'
            : `Ordered on ${e.orderDate.slice(0, 10)}, before this report begins, and invoiced inside it.`)
        : 'Invoiced in this period but the order is not in the order reports held.',
      orderValue: 0, cancelledValue: 0, liveValue: 0,
      invoicedValue: e.invoiced, refundedValue: e.refunded,
      principalValue: e.principal, shippingValue: e.shipping,
      giftWrapValue: e.giftWrap, promoValue: e.promo, otherDiffValue: e.otherDiff,
      status: '(no order row)', sku: '', purchaseDate: e.orderDate,
      mtrTypes: [...e.types].filter(Boolean).sort().join(', '),
    });
  }

  /* ── bucket totals ─────────────────────────────────────────────────────── */
  const buckets = BUCKETS.map((b) => {
    const mine = rows.filter((r) => r.bucket === b.key);
    return {
      ...b,
      count: mine.length,
      orderValue: r2(mine.reduce((a, r) => a + r.orderValue, 0)),
      invoicedValue: r2(mine.reduce((a, r) => a + r.invoicedValue, 0)),
      /* at the period edge this is a timing difference, not a fault */
      atPeriodEdge: b.key === 'shippedNoInvoice'
        ? mine.filter((r) => r.month === lastMonth).length : 0,
    };
  });

  /* ── the two ways of counting the same sales ───────────────────────────── */
  const allOrderValue = r2(rows.reduce((a, r) => a + r.orderValue, 0));
  const cancelledValue = r2(rows.reduce((a, r) => a + r.cancelledValue, 0));
  const invoicedValue = r2(rows.reduce((a, r) => a + r.invoicedValue, 0));
  const refundedValue = r2(rows.reduce((a, r) => a + r.refundedValue, 0));
  const orderLevel = r2(allOrderValue - cancelledValue);
  /* the part of the gap we can NAME, so the rest is honestly labelled unknown
     rather than quietly absorbed */
  const mtrOnlyValue = r2(buckets.find((b) => b.key === 'mtrOnly')?.invoicedValue || 0);
  const gap = r2(orderLevel - invoicedValue);

  /* ── the gap, named line by line ────────────────────────────────────────
     Measured on Koparo's 17 months this reconciles to the paisa, and it is
     worth saying why it ever looked unexplained: the order report's
     `item-price` is the PRINCIPAL, while the MTR's `Invoice Amount` is
     principal + shipping + gift wrap − promotional discounts. Like was never
     being compared with like. */
  const matchedRows = rows.filter((r) => r.bucket === 'matched');
  const shipping = r2(matchedRows.reduce((a, r) => a + r.shippingValue, 0));
  const giftWrap = r2(matchedRows.reduce((a, r) => a + r.giftWrapValue, 0));
  const promo = r2(matchedRows.reduce((a, r) => a + r.promoValue, 0));
  const otherDiff = r2(matchedRows.reduce((a, r) => a + r.otherDiffValue, 0));
  const nShip = matchedRows.filter((r) => Math.abs(r.shippingValue) > 0.005).length;
  const nPromo = matchedRows.filter((r) => Math.abs(r.promoValue) > 0.005).length;
  const principal = r2(matchedRows.reduce((a, r) => a + r.principalValue, 0));
  const matchedOrderValue = r2(matchedRows.reduce((a, r) => a + r.orderValue, 0));
  const notInvoiced = r2(buckets.find((b) => b.key === 'shippedNoInvoice')?.orderValue || 0);
  const bridge = [
    { key: 'shipping', label: `Delivery billed on the invoice (${nShip} orders)`, amount: shipping,
      note: 'On almost every order the invoice equals the item price exactly. On these the customer '
          + 'was also billed for delivery, so the invoice is higher.' },
    { key: 'giftWrap', label: 'Gift wrap billed on the invoice', amount: giftWrap,
      note: 'Billed on the invoice, absent from the item price.' },
    { key: 'promo', label: `Promotional discount on the invoice (${nPromo} orders)`, amount: promo,
      note: 'The discount is deducted on the invoice but not from the order report\u2019s item price.' },
    { key: 'otherDiff', label: 'Other invoice adjustments', amount: otherDiff,
      note: 'Invoice differs from the item price for a reason none of the named columns explains.' },
    { key: 'mtrOnly', label: 'Invoiced, order placed before this period', amount: mtrOnlyValue,
      note: 'The invoice is inside the period but the order is not, so only one side counts it.' },
    { key: 'notInvoiced', label: 'Shipped but not invoiced', amount: -notInvoiced,
      note: 'Counted at order level, with no invoice to match it.' },
  ];
  const bridgeTotal = r2(bridge.reduce((a, x) => a + x.amount, 0));
  const revenue = {
    allOrderValue, cancelledValue, orderLevel,
    invoicedValue, refundedValue, netBilled: r2(invoicedValue - refundedValue),
    gap,
    /* like-for-like: the order report's item price against the MTR's PRINCIPAL,
       which is the same measure on both sides */
    matchedOrderValue, matchedPrincipal: principal,
    principalDiff: r2(matchedOrderValue - principal),
    bridge, bridgeTotal,
    unexplained: r2(-gap - bridgeTotal),
  };

  /* ── what the MTR says about cancellation, which the order file cannot ─── */
  const shape = { cancelOnly: [], cancelShipment: [], cancelRefund: [] };
  for (const e of mtr.values()) {
    if (!e.types.has('Cancel')) continue;
    if (!inWindow(e.invMonth) && e.invMonth) continue;
    if (e.types.has('Refund')) shape.cancelRefund.push(e.id);
    else if (e.types.has('Shipment')) shape.cancelShipment.push(e.id);
    else shape.cancelOnly.push(e.id);
  }
  const cancellation = CANCEL_SHAPES.map((c) => ({ ...c, count: shape[c.key].length,
                                                   orderIds: shape[c.key].slice(0, 500) }));

  /* ── per month, so the range picker can narrow it ──────────────────────── */
  const perMonth = months.map((m) => {
    const mine = rows.filter((r) => r.month === m);
    const by = {};
    for (const b of BUCKETS) by[b.key] = mine.filter((r) => r.bucket === b.key).length;
    return {
      month: m, orders: mine.length, ...by,
      orderLevel: r2(mine.reduce((a, r) => a + r.liveValue, 0)),
      invoiced: r2(mine.reduce((a, r) => a + r.invoicedValue, 0)),
    };
  });

  const orders = rows.length;
  const matched = buckets.find((b) => b.key === 'matched')?.count || 0;

  return {
    months,
    orders,
    matched,
    matchRate: orders ? r2((100 * matched) / orders) : 0,
    buckets,
    cancellation,
    revenue,
    perMonth,
    rows,
    /* stated on screen so the reader is not asked to take the timing on trust */
    invoiceTiming: measureTiming(src.mtr || []),
  };
}

/* How long after the order Amazon raises the invoice, and whether that is
   before or after dispatch. Measured from the files in hand on every run, so
   the explanation can never drift away from the data it describes. */
function measureTiming(mtrRows) {
  const parse = (s) => {
    const v = txt(s);
    if (!v) return null;
    let m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    m = v.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
    return null;
  };
  const oi = []; const is = [];
  for (const r of mtrRows) {
    if (txt(r['Transaction Type']) !== 'Shipment') continue;
    const o = parse(r['Order Date']); const i = parse(r['Invoice Date']); const s = parse(r['Shipment Date']);
    if (o != null && i != null) oi.push((i - o) / 3600000);
    if (i != null && s != null) is.push((s - i) / 3600000);
  }
  const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const within24 = oi.filter((x) => x >= 0 && x < 24).length;
  const beforeShip = is.filter((x) => x > 0).length;
  return {
    sample: oi.length,
    medianOrderToInvoiceHrs: med(oi) == null ? null : r2(med(oi)),
    medianInvoiceToShipHrs: med(is) == null ? null : r2(med(is)),
    pctInvoicedWithin24h: oi.length ? r2((100 * within24) / oi.length) : 0,
    pctInvoicedBeforeShipping: is.length ? r2((100 * beforeShip) / is.length) : 0,
  };
}

module.exports = { build, BUCKETS, CANCEL_SHAPES };

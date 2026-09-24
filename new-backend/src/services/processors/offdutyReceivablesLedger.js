/* ──────────────────────────────────────────────────────────────────────────────
   offdutyReceivablesLedger.js — turn the parsed rows into ONE ROW PER ORDER,
   then into the sheets the accountant reads.

   WHY PER ORDER AND NOT PER MONTH. An order sold in March can come back in
   April: the RTO tab of April's workbook holds March's order ids, and April's
   payment file does not contain them at all (its ids start at 829,052; those
   RTOs run 792,281-827,634). Netting a month against a month therefore invents
   a gap that does not exist. The order carries its own dates, so the order is
   the unit and a month is only ever a filter over it.

   THE TWO CHECKS. Same discipline as the Amazon settlement summary: the sheet
   never trusts a stated total on its own.
     1. The five collector columns must rebuild the remittance the file states.
     2. The status split must rebuild the gross the file states.
   Both are written as live formulas, so they re-evaluate if anyone edits a cell.

   WHAT IS NOT FORCED TO ZERO. The sales workbooks and the payment file disagree
   about a few hundred orders. That is a finding, not an error to be plugged, so
   it is REPORTED with its order ids and never netted away.
   ────────────────────────────────────────────────────────────────────────────── */

const r2 = (n) => Number((Number(n) || 0).toFixed(2));
const add = (a, b) => r2((Number(a) || 0) + (Number(b) || 0));

/* Order statuses, grouped the way money behaves rather than the way the courier
   words it. Anything unrecognised falls to OTHER and is listed, never absorbed. */
function moneyGroup(status, remarks) {
  const s = String(status || '').toUpperCase().trim();
  const r = String(remarks || '').toUpperCase().trim();
  if (r === 'CANCEL' || s === 'CANCELLED' || s === 'CANCELED') return 'CANCELLED';
  if (s.startsWith('RTO') || s === 'REACHED BACK AT_SELLER_CITY' || r === 'RTO') return 'RTO';
  if (s === 'LOST' || r === 'LOST ORDER') return 'LOST';
  if (s.startsWith('RETURN')) return 'RETURNED';
  if (s === 'DELIVERED') return 'DELIVERED';
  if (s === 'NEW ORDER' || s.includes('TRANSIT') || s.includes('UNDELIVERED') || s.includes('HUB')) return 'IN_FLIGHT';
  if (!s || s === '0') return 'NO_STATUS';
  return 'OTHER';
}

const GROUP_LABEL = {
  DELIVERED: 'Delivered',
  RETURNED:  'Returned to customer',
  RTO:       'RTO — came back',
  CANCELLED: 'Cancelled',
  LOST:      'Lost in transit',
  IN_FLIGHT: 'Still in transit',
  NO_STATUS: 'No status recorded',
  OTHER:     'Other',
};
const GROUP_ORDER = ['DELIVERED', 'RETURNED', 'IN_FLIGHT', 'RTO', 'CANCELLED', 'LOST', 'NO_STATUS', 'OTHER'];

/* Collect the many rows of one kind into one record per order. */
function foldByOrder(rows, kind, fields) {
  const m = new Map();
  for (const row of rows) {
    if (row.source_kind !== kind) continue;
    const id = row.order_id;
    if (!id) continue;
    let rec = m.get(id);
    if (!rec) { rec = { order_id: id, lines: 0, entities: new Set() }; m.set(id, rec); }
    rec.lines += 1;
    if (row.entity) rec.entities.add(row.entity);
    for (const f of fields) rec[f] = add(rec[f], row[f]);
    for (const f of ['order_date', 'rto_date', 'refunded_at', 'period', 'shipping_state', 'order_status', 'sales_month']) {
      if (rec[f] === undefined && row[f] != null) rec[f] = row[f];
    }
  }
  return m;
}

const TAXY = ['order_total', 'taxable_value', 'tax_amount', 'cgst', 'sgst', 'igst', 'qty'];

/**
 * Build everything the workbook needs from the flat parsed rows.
 */
function buildReceivables(allRows) {
  const payments = allRows.filter((r) => r.source_kind === 'PAYMENT');
  const delivered = foldByOrder(allRows, 'DELIVERED', TAXY);
  const refunds   = foldByOrder(allRows, 'REFUND', ['refunded_amount', 'taxable_value', 'tax_amount', 'cgst', 'sgst', 'igst', 'qty']);
  const rtos      = foldByOrder(allRows, 'RTO', TAXY);

  /* One payment row per order. If a month is uploaded twice the later row wins,
     exactly as re-issuing a settlement replaces the earlier one on Amazon. */
  const payByOrder = new Map();
  for (const p of payments) if (p.order_id) payByOrder.set(p.order_id, p);

  const ids = new Set([...payByOrder.keys(), ...delivered.keys(), ...refunds.keys(), ...rtos.keys()]);

  const ledger = [];
  for (const id of ids) {
    const p = payByOrder.get(id) || null;
    const d = delivered.get(id) || null;
    const f = refunds.get(id) || null;
    const t = rtos.get(id) || null;

    const entities = new Set([...(d ? d.entities : []), ...(t ? t.entities : []), ...(f ? f.entities : [])]);
    const group = moneyGroup(p ? p.order_status : (t ? 'RTO DELIVERED' : (d ? d.order_status : null)),
                             p ? p.remarks : null);

    const billed    = p ? r2(p.order_total) : r2(d ? d.order_total : (t ? t.order_total : 0));
    const collected = p ? r2(p.remitted_amount) : 0;

    ledger.push({
      order_id: id,
      entity: entities.size === 0 ? null : entities.size === 1 ? [...entities][0] : [...entities].sort().join('+'),
      split_shipment: entities.size > 1,
      order_date: (p && p.order_date) || (d && d.order_date) || (t && t.order_date) || null,
      period: (p && p.period) || (d && d.period) || (t && t.period) || null,
      status: p ? p.order_status : (d ? d.order_status : (t ? t.order_status : null)),
      group,
      remarks: p ? p.remarks : null,
      collector: p ? p.collector : null,
      shipping_state: (p && p.shipping_state) || (d && d.shipping_state) || null,

      billed,
      earned_taxable: d ? r2(d.taxable_value) : 0,
      earned_tax: d ? r2(d.tax_amount) : 0,
      refunded: f ? r2(f.refunded_amount) : 0,
      rto_value: t ? r2(t.order_total) : 0,
      rto_date: t ? t.rto_date : null,

      collected,
      collectors_total: p ? r2(p.collectors_total) : 0,
      cashfree: p ? r2(p.cashfree) : 0,
      billdesk: p ? r2(p.billdesk) : 0,
      billdesk_exchange: p ? r2(p.billdesk_exchange) : 0,
      razorpay_exchange: p ? r2(p.razorpay_exchange) : 0,
      shiprocket: p ? r2(p.shiprocket) : 0,

      utr_id: p ? p.utr_id : null,
      payment_date: p ? p.payment_date : null,
      deposit_date: p ? p.deposit_date : null,

      /* The receivable. Only a DELIVERED order can be owed: an RTO came back, a
         cancellation never shipped, a refund was given back on purpose. */
      receivable: group === 'DELIVERED' ? r2(billed - collected) : 0,
      gap: r2(billed - collected),

      in_sales_file: !!(d || t || f),
      in_payment_file: !!p,
    });
  }

  ledger.sort((a, b) => Number(b.order_id) - Number(a.order_id));

  /* ── roll-ups ──────────────────────────────────────────────────────────── */

  const byGroup = {};
  for (const g of GROUP_ORDER) byGroup[g] = { orders: 0, billed: 0, collected: 0, gap: 0 };
  for (const l of ledger) {
    const b = byGroup[l.group];
    b.orders += 1; b.billed = add(b.billed, l.billed);
    b.collected = add(b.collected, l.collected); b.gap = add(b.gap, l.gap);
  }

  /* Which collector does a delivered order belong to? The payment file names it
     in "Actual as per Sales", in its own words — "Bill Desk", "Shiprocket",
     "Shiprocket_Razorpay". Matching on a substring of the column name is not
     good enough: "billdesk" is inside "billdesk_exchange", so Bill Desk's
     19,378 orders were being counted twice. Each order therefore lands in
     EXACTLY ONE bucket, tested in this order, and anything unrecognised gets
     its own row rather than vanishing — which is what makes the split tie. */
  const collectorKeys = ['cashfree', 'billdesk', 'billdesk_exchange', 'razorpay_exchange', 'shiprocket'];
  const COLLECTOR_LABEL = {
    cashfree: 'Cashfree', billdesk: 'Bill Desk', billdesk_exchange: 'Bill Desk (exchange)',
    razorpay_exchange: 'Razorpay (exchange)', shiprocket: 'Shiprocket — COD',
  };
  const MATCH = [
    ['billdesk_exchange', /bill\s*desk.*exchange/i],
    ['billdesk',          /bill\s*desk/i],
    ['cashfree',          /cashfree/i],
    ['shiprocket',        /shiprock/i],
    ['razorpay_exchange', /razorpay/i],
  ];
  const bucketOf = (l) => {
    const c = String(l.collector || '').trim();
    if (!c) return 'none';
    for (const [key, re] of MATCH) if (re.test(c)) return key;
    return 'other';
  };

  const byCollector = collectorKeys.map((k) => {
    const withMoney = ledger.filter((l) => l[k] !== 0);
    const del = ledger.filter((l) => l.group === 'DELIVERED' && bucketOf(l) === k);
    return {
      key: k, label: COLLECTOR_LABEL[k],
      orders: withMoney.length,
      collected: withMoney.reduce((a, l) => add(a, l[k]), 0),
      delivered_orders: del.length,
      delivered_billed: del.reduce((a, l) => add(a, l.billed), 0),
      delivered_collected: del.reduce((a, l) => add(a, l.collected), 0),
      receivable: del.reduce((a, l) => add(a, l.receivable), 0),
    };
  });

  /* The receivable, split so that the parts add back to the whole. */
  const deliveredRows = ledger.filter((l) => l.group === 'DELIVERED');
  const bucketRow = (key, label) => {
    const rows = deliveredRows.filter((l) => bucketOf(l) === key);
    return { key, label, orders: rows.length, receivable: rows.reduce((a, l) => add(a, l.receivable), 0) };
  };
  const receivableSplit = [
    ...collectorKeys.map((k) => bucketRow(k, COLLECTOR_LABEL[k])),
    bucketRow('other', 'Collector named but not one of the five'),
    bucketRow('none', 'No collector named'),
  ].filter((r) => r.orders > 0);

  const entities = [...new Set(ledger.map((l) => l.entity).filter(Boolean))].sort();
  const byEntity = entities.map((e) => {
    const rows = ledger.filter((l) => l.entity === e);
    const del = rows.filter((l) => l.group === 'DELIVERED');
    return {
      entity: e,
      orders: rows.length,
      split_shipment: e.includes('+'),
      earned_taxable: rows.reduce((a, l) => add(a, l.earned_taxable), 0),
      earned_tax: rows.reduce((a, l) => add(a, l.earned_tax), 0),
      refunded: rows.reduce((a, l) => add(a, l.refunded), 0),
      rto_value: rows.reduce((a, l) => add(a, l.rto_value), 0),
      billed: del.reduce((a, l) => add(a, l.billed), 0),
      collected: del.reduce((a, l) => add(a, l.collected), 0),
      receivable: del.reduce((a, l) => add(a, l.receivable), 0),
    };
  });

  /* ── the four worklists ────────────────────────────────────────────────── */
  const isBlank = (v) => v == null || String(v).trim() === '' || String(v).trim() === '0';

  const exceptions = {
    noCollector: ledger.filter((l) => l.group === 'DELIVERED' && l.collected === 0 && isBlank(l.collector)),
    redFlag:     ledger.filter((l) => String(l.remarks || '').toUpperCase() === 'RED FLAG'),
    shortPaid:   ledger.filter((l) => l.group === 'DELIVERED' && l.receivable > 0.5 && !isBlank(l.collector)),
    statusConflict: ledger.filter((l) => l.in_sales_file && l.in_payment_file
                                      && l.earned_taxable > 0 && l.group !== 'DELIVERED'),
    taxedNowhere:   ledger.filter((l) => l.in_payment_file && !l.in_sales_file && l.group === 'DELIVERED'),
    noDeposit:      ledger.filter((l) => l.collected !== 0 && isBlank(l.deposit_date)),
  };

  const sum = (arr, f) => arr.reduce((a, x) => add(a, x[f]), 0);
  const totals = {
    orders: ledger.length,
    billed: sum(ledger, 'billed'),
    collected: sum(ledger, 'collected'),
    collectorsTotal: sum(ledger, 'collectors_total'),
    receivable: sum(ledger, 'receivable'),
    earnedTaxable: sum(ledger, 'earned_taxable'),
    earnedTax: sum(ledger, 'earned_tax'),
    refunded: sum(ledger, 'refunded'),
    rtoValue: sum(ledger, 'rto_value'),
    splitShipments: ledger.filter((l) => l.split_shipment).length,
  };

  const checks = {
    /* 1. the five collector columns must rebuild the stated remittance */
    collectors: r2(totals.collectorsTotal - totals.collected),
    /* 2. the status split must rebuild the stated gross */
    statusSplit: r2(GROUP_ORDER.reduce((a, g) => add(a, byGroup[g].billed), 0) - totals.billed),
    /* 3. the receivable split must rebuild the receivable. Without this a
          collector bucket can quietly go missing and the total still looks right. */
    receivableSplit: r2(receivableSplit.reduce((a, x) => add(a, x.receivable), 0) - totals.receivable),
  };

  const periods = [...new Set(ledger.map((l) => l.period).filter(Boolean))].sort();

  return { ledger, byGroup, GROUP_ORDER, GROUP_LABEL, byCollector, byEntity, receivableSplit,
           exceptions, totals, checks, periods, collectorKeys, COLLECTOR_LABEL, bucketOf };
}

module.exports = { buildReceivables, moneyGroup, GROUP_LABEL, GROUP_ORDER };

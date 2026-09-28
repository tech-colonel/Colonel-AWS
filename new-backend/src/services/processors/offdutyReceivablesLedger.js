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
  /* "Pending" is the second format's word for an order that never arrived —
     Refined Shipping Status collapses everything to Delivered / Cancelled-RTO-
     Lost / Pending, and Pending is goods still out. */
  if (s === 'NEW ORDER' || s === 'PENDING' || s === 'MANIFESTED'
      || s.includes('TRANSIT') || s.includes('UNDELIVERED') || s.includes('HUB')) return 'IN_FLIGHT';
  if (!s || s === '0') return 'NO_STATUS';
  return 'OTHER';
}

const GROUP_LABEL = {
  DELIVERED: 'Delivered',
  RETURNED:  'Sales return',
  RTO:       'Returned to origin (RTO)',
  CANCELLED: 'Cancelled before dispatch',
  LOST:      'Lost in transit',
  IN_FLIGHT: 'In transit',
  NO_STATUS: 'Status not recorded',
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

/* ── the position at a date ────────────────────────────────────────────────
   A receivable is a position AT A DATE, not a running balance. An order
   delivered on 28 April whose money arrived on 12 May was owed to you at
   30 April, and saying otherwise understates the book — in April 2025 by 5x.

   Each order lands in exactly one position, and carries a remark saying in
   plain words why, so nothing in this file has to be taken on trust. */
const POSITION = {
  PAID_IN_PERIOD:     'Realised within the period',
  RECEIVABLE_LATE:    'Recoverable — realised after the reporting date',
  RECEIVABLE_UNPAID:  'Recoverable — not realised',
  RECEIVABLE_UNDATED: 'Realised, date of receipt not recorded',
  UNDATED_DELIVERY:   'Delivered, date of delivery not recorded',
  IN_TRANSIT:         'Goods in transit',
  NOT_DUE:            'Not recoverable',
};
const POSITION_ORDER = ['RECEIVABLE_LATE', 'RECEIVABLE_UNPAID', 'RECEIVABLE_UNDATED',
                        'UNDATED_DELIVERY', 'IN_TRANSIT', 'PAID_IN_PERIOD', 'NOT_DUE'];
/* The three that are certainly owed at the cut-off, and the one that might be. */
const RECEIVABLE_POSITIONS = ['RECEIVABLE_LATE', 'RECEIVABLE_UNPAID'];
const UNCERTAIN_POSITIONS  = ['RECEIVABLE_UNDATED', 'UNDATED_DELIVERY'];

function placeOrder(l, asAt, opts = {}) {
  const delivered = l.delivered_date || null;
  const paid = l.payment_date || null;

  /* An order still out is goods in transit, whether the file says so with a
     "Pending" status or by carrying a delivery date after the cut-off. It was
     previously lumped with returns and cancellations, which understated the
     transit line by whatever had not yet arrived. */
  if (l.group === 'IN_FLIGHT') {
    return { position: 'IN_TRANSIT',
             remark: `${GROUP_LABEL[l.group]} as on ${asAt}. Dispatched and not yet delivered — `
                   + 'not a trade receivable where revenue is recognised on delivery.' };
  }
  if (l.group !== 'DELIVERED') {
    return { position: 'NOT_DUE',
             remark: `${GROUP_LABEL[l.group]}. No amount recoverable from the customer.` };
  }
  if (!delivered && opts.noPaymentDates && l.collected > 0) {
    return { position: 'PAID_IN_PERIOD',
             remark: 'Shown as delivered and realised, though the file records no delivery date. '
                   + 'Taken as realised within the period.' };
  }
  if (!delivered) {
    return { position: 'UNDATED_DELIVERY',
             remark: 'Shown as delivered in the payment reconciliation, but no date of delivery is on '
                   + `record. Could not be classified against the reporting date ${asAt}. Treated as `
                   + 'unascertained; not taken as realised.' };
  }
  if (delivered > asAt) {
    return { position: 'IN_TRANSIT',
             remark: `Dispatched within the period. Delivery completed ${delivered}, i.e. after the `
                   + `reporting date ${asAt}. Goods in transit — not a trade receivable where revenue is `
                   + 'recognised on delivery.' };
  }
  if (l.collected === 0) {
    return { position: 'RECEIVABLE_UNPAID',
             remark: `Delivered ${delivered}. No realisation received till date`
                   + `${l.collector ? ` through ${l.collector}` : '; collection channel not identified'}. `
                   + 'Outstanding and recoverable.' };
  }
  /* No payment date anywhere in the source: treat a settled order as realised
     in the period and say so once on the face of the statement, rather than
     flagging tens of thousands of orders as individually uncertain. */
  if (!paid && opts.noPaymentDates) {
    return { position: 'PAID_IN_PERIOD',
             remark: `Delivered ${delivered}. Realisation received. This payment file records no date `
                   + 'of receipt for any order, so it cannot be split between before and after the '
                   + 'reporting date; taken as realised within the period.' };
  }
  if (!paid) {
    return { position: 'RECEIVABLE_UNDATED',
             remark: `Delivered ${delivered}. Realisation received, but the payment reconciliation records `
                   + 'no date of receipt, hence the period of realisation could not be ascertained.' };
  }
  if (paid > asAt) {
    return { position: 'RECEIVABLE_LATE',
             remark: `Delivered ${delivered}. Realisation received ${paid}, i.e. after the reporting date `
                   + `${asAt}. Recoverable as on that date; subsequently realised.` };
  }
  return { position: 'PAID_IN_PERIOD',
           remark: `Delivered ${delivered}. Realisation received ${paid}, on or before the reporting `
                 + 'date. No amount recoverable.' };
}

/* ── the GST sales summary ─────────────────────────────────────────────────
   The shape the accountant already reads: sales, less returns, net — by
   registration, split across taxable / CGST / SGST / IGST. Built from the RAW
   line-item rows, not from the per-order ledger, because the taxable value and
   the tax heads are stated per line; aggregating the deduplicated order ledger
   would not agree with the workbook's own Sales Summary.

   Returns one block per registration plus a consolidated block. */
/* Does this sales-tab row represent an RTO that came back in the same month it
   was sold? Compared as the file states them — "March" against "March" — which
   needs no filename parsing and no calendar. */
function isSameMonthRto(r) {
  if (String(r.gst_status || '').trim().toUpperCase() !== 'RTO') return false;
  const back = String(r.rto_month || '').trim().toLowerCase();
  const sold = String(r.sales_month || '').trim().toLowerCase();
  return !!back && back === sold;
}

function gstSummary(allRows) {
  const HEADS = ['taxable_value', 'cgst', 'sgst', 'igst'];
  const zero = () => ({ taxable_value: 0, cgst: 0, sgst: 0, igst: 0, lines: 0 });
  const bucket = {};

  /* ROUND ONCE, AT THE END. add() rounds to the paisa on every step, which is
     right for rupee amounts but wrong here: a taxable value like
     1358.0357142857142 carries a sub-paisa fraction, and rounding the running
     total over 12,608 lines drifts by Rs 12 against the accountant's own Sales
     Summary. These heads therefore accumulate at full precision. */
  /* Take the MAGNITUDE for returns and RTO, row by row. The workbooks changed
     convention mid-year — April and May write returns positive, from June they
     write them negative — and a month that draws rows from both (a refund tab
     reaching back into the previous month) would have the two cancelling
     instead of adding. The direction is applied once, at the block. */
  const acc = (o, r, magnitude) => {
    o.lines += 1;
    for (const h of HEADS) {
      const v = Number(r[h]) || 0;
      o[h] += magnitude ? Math.abs(v) : v;
    }
  };

  for (const r of allRows) {
    if (r.source_kind === 'PAYMENT') continue;          // the payment file carries no tax heads
    const e = r.entity || 'Unallocated';
    bucket[e] = bucket[e] || { DELIVERED: zero(), RTO: zero(), REFUND: zero() };
    const b = bucket[e][r.source_kind];
    if (!b) continue;
    acc(b, r, r.source_kind === 'REFUND' || r.source_kind === 'RTO');
    /* An RTO row inside the sales tab that came back in the month it was sold
       is ALSO this month's RTO. The accountant's own Sales Summary is cast that
       way: sales = the whole tab, RTO = same-month returns + the previous
       month's returns from the "RTO <prev month>" tab. One that came back later
       is left out here — it is deducted in the month it actually returned. */
    if (r.source_kind === 'DELIVERED' && isSameMonthRto(r)) acc(bucket[e].RTO, r, true);
  }

  /* A return is a DEDUCTION, always shown negative — whatever sign the source
     used. April and May write returns positive; from June the same workbooks
     write them negative. Negating blindly therefore produced a positive
     "Less: Returns" for seven months of the year, which ADDED to net sales on
     the consolidated table instead of subtracting. The magnitude is what the
     workbook states; the direction is ours. */
  const neg = (o) => HEADS.reduce((a, h) => ({ ...a, [h]: -Math.abs(o[h]) }), { lines: o.lines });
  const sum = (...os) => HEADS.reduce((a, h) => ({ ...a, [h]: os.reduce((t, o) => t + o[h], 0) }),
                                      { lines: os.reduce((t, o) => t + (o.lines || 0), 0) });
  const round = (o) => HEADS.reduce((a, h) => ({ ...a, [h]: r2(o[h]) }), { lines: o.lines });

  const blocks = Object.keys(bucket).sort().map((entity) => {
    const sales = bucket[entity].DELIVERED;
    const rto = neg(bucket[entity].RTO);
    const ref = neg(bucket[entity].REFUND);
    return {
      entity,
      sales: round(sales), rto: round(rto), refund: round(ref),
      totalReturn: round(sum(rto, ref)),
      net: round(sum(sales, rto, ref)),
      _raw: { sales, rto, ref },
    };
  });

  /* The consolidation adds the FULL-PRECISION figures, then rounds — never the
     already-rounded per-registration ones. */
  const consolidated = blocks.length > 1 ? {
    entity: 'All registrations',
    sales: round(sum(...blocks.map((b) => b._raw.sales))),
    rto: round(sum(...blocks.map((b) => b._raw.rto))),
    refund: round(sum(...blocks.map((b) => b._raw.ref))),
    totalReturn: round(sum(...blocks.map((b) => sum(b._raw.rto, b._raw.ref)))),
    net: round(sum(...blocks.map((b) => sum(b._raw.sales, b._raw.rto, b._raw.ref)))),
  } : null;

  return { blocks, consolidated, HEADS };
}

/**
 * Build everything the workbook needs from the flat parsed rows.
 * `asAt` is the cut-off (YYYY-MM-DD). Left out, it is the last day of the
 * latest month present in the data.
 */
/* ── identical rows arriving from two different workbooks ──────────────────
   November 2025 exposed this: the Karnataka workbook's Refund tab is a
   byte-for-byte copy of Haryana's — 1,932 order numbers, all 1,932 in common —
   and December's Karnataka workbook carries a further 3,742 November refunds.
   Loaded together, November held 8,762 refund rows for 4,023 orders.

   An exact duplicate — same kind, same order, same month, same amount — is
   dropped, and what was dropped is REPORTED as a qualification rather than
   quietly removed. A split shipment is not affected: those rows differ in
   amount, and sales rows are never deduplicated, because one order genuinely
   does appear under two registrations when its lines ship from two warehouses. */
function dedupeExactRows(allRows) {
  /* NOT row by row. Two registrations legitimately hold the same order at the
     same value when its lines shipped from two warehouses and were refunded
     from both — dropping those took April below the figure its own Sales
     Summary states, which it had matched exactly.

     The real fault is coarser: a WHOLE TAB copied from one registration's
     workbook into another's. November 2025 is the case — Karnataka's Refund tab
     is Haryana's, all 1,932 order numbers in common. So tabs are compared as
     wholes, and a tab that is an exact duplicate of one already seen is set
     aside entire, with what was set aside reported. Anything short of a
     complete match is left alone. */
  const tabs = new Map();
  allRows.forEach((r, i) => {
    if (r.source_kind !== 'REFUND' && r.source_kind !== 'RTO') return;
    /* the registration is the discriminator: the parser does not stamp a
       filename on rows, and two registrations are exactly what the copied-tab
       fault spans */
    const k = `${r.entity || '?'}|${r.source_tab || '?'}|${r.source_kind}|${r.filename || ''}`;
    const t = tabs.get(k) || { key: k, idx: [], ids: [], total: 0, entity: r.entity, file: r.filename || r.entity };
    t.idx.push(i);
    t.ids.push(r.order_id);
    t.total += Math.abs(Number(r.source_kind === 'REFUND' ? r.refunded_amount : r.order_total) || 0);
    tabs.set(k, t);
  });

  const sig = (t) => `${t.idx.length}|${r2(t.total)}|${[...t.ids].sort().join(',')}`;
  const bySig = new Map();
  const drop = new Set();
  const dropped = [];
  for (const t of tabs.values()) {
    const g = sig(t);
    const first = bySig.get(g);
    if (!first) { bySig.set(g, t); continue; }
    for (const i of t.idx) { drop.add(i); dropped.push({ row: allRows[i], keptFrom: first.file }); }
    t.duplicateOf = first;
  }
  const duplicateTabs = [...tabs.values()].filter((t) => t.duplicateOf)
    .map((t) => ({ file: t.file, entity: t.entity, rows: t.idx.length, value: r2(t.total),
                   copyOf: t.duplicateOf.file, copyOfEntity: t.duplicateOf.entity }));
  return { kept: allRows.filter((_, i) => !drop.has(i)), dropped, duplicateTabs };
}

function buildReceivables(allRowsIn, asAtIn) {
  const { kept: allRows, dropped: duplicateRows, duplicateTabs } = dedupeExactRows(allRowsIn);
  const payments = allRows.filter((r) => r.source_kind === 'PAYMENT');
  const delivered = foldByOrder(allRows, 'DELIVERED', TAXY);
  const refunds   = foldByOrder(allRows, 'REFUND', ['refunded_amount', 'taxable_value', 'tax_amount', 'cgst', 'sgst', 'igst', 'qty']);
  const rtos      = foldByOrder(allRows, 'RTO', TAXY);

  /* One payment RECORD per order — but the second format is line-item level, so
     an order of three items is three rows and the amounts have to be added.
     Taking the last row (which is right for the one-row-per-order format) threw
     away every line but one and understated August by a crore. Dates and
     statuses come from the first row that states them. */
  const PAY_SUM = ['order_total', 'remitted_amount', 'collectors_total', 'difference',
                   'cashfree', 'billdesk', 'billdesk_exchange', 'razorpay_exchange', 'shiprocket',
                   'discount_amount', 'qty'];
  const PAY_FIRST = ['order_date', 'period', 'financial_status', 'order_status', 'gst_status',
                     'shipping_state', 'pickup_state', 'payment_method', 'shipping_aggregator',
                     'collector', 'utr_id', 'payment_date', 'deposit_date', 'delivered_date',
                     'rto_date', 'cancelled_at', 'remarks', 'entity', 'filename'];
  const payByOrder = new Map();
  for (const p of payments) {
    if (!p.order_id) continue;
    /* An order can be PART delivered — one line arrives, another comes back —
       so a single status per order cannot describe it. The value of the lines
       that were actually delivered is kept separately, which is how the file's
       own Summary counts, and is what the bridge compares against. */
    const lineDelivered = String(p.order_status || '').trim().toLowerCase() === 'delivered';
    const cur = payByOrder.get(p.order_id);
    if (!cur) {
      const rec = { order_id: p.order_id, _lines: 1,
                    delivered_value: lineDelivered ? (Number(p.order_total) || 0) : 0,
                    delivered_lines: lineDelivered ? 1 : 0 };
      for (const f of PAY_SUM) rec[f] = Number(p[f]) || 0;
      for (const f of PAY_FIRST) rec[f] = p[f] == null ? null : p[f];
      payByOrder.set(p.order_id, rec);
    } else {
      cur._lines += 1;
      if (lineDelivered) { cur.delivered_value += Number(p.order_total) || 0; cur.delivered_lines += 1; }
      for (const f of PAY_SUM) cur[f] = (Number(cur[f]) || 0) + (Number(p[f]) || 0);
      for (const f of PAY_FIRST) if (cur[f] == null && p[f] != null) cur[f] = p[f];
    }
  }
  for (const rec of payByOrder.values()) {
    for (const f of PAY_SUM) rec[f] = r2(rec[f]);
    rec.delivered_value = r2(rec.delivered_value);
    /* the order's headline status is the one its delivered lines give it, if any */
    if (rec.delivered_lines > 0 && rec.delivered_lines < rec._lines) rec.part_delivered = true;
    if (rec.delivered_lines > 0) rec.order_status = 'DELIVERED';
  }

  /* Does this data record WHEN money arrived at all? The second format does
     not. Without it there is no before/after-the-reporting-date split, and
     flagging every settled order as "date not recorded" would make the
     uncertain column the whole book. Said once instead — see placeOrder. */
  const paymentHasDates = payments.some((p) => p.payment_date);

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

    /* An order known only from a refund row still has a value — the amount
       refunded. Falling through to 0 made a note read "2,382 orders,
       Rs 20,81,155" when half of those orders were carrying nothing. */
    const billed    = p ? r2(p.order_total)
                    : d ? r2(d.order_total)
                    : t ? r2(t.order_total)
                    : f ? r2(f.refunded_amount)
                    : 0;
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
      delivered_value: p && p.delivered_value != null ? p.delivered_value : null,
      part_delivered: !!(p && p.part_delivered),
      collectors_total: p ? r2(p.collectors_total) : 0,
      cashfree: p ? r2(p.cashfree) : 0,
      billdesk: p ? r2(p.billdesk) : 0,
      billdesk_exchange: p ? r2(p.billdesk_exchange) : 0,
      razorpay_exchange: p ? r2(p.razorpay_exchange) : 0,
      shiprocket: p ? r2(p.shiprocket) : 0,

      utr_id: p ? p.utr_id : null,
      /* The two dates the position turns on. Both come only from the payment
         file — the sales workbooks carry no delivery date. */
      delivered_date: p ? p.delivered_date : null,
      payment_date: p ? p.payment_date : null,
      deposit_date: p ? p.deposit_date : null,

      /* NOT the receivable — this is what is STILL short today, after all the
         chasing already done. The receivable is a position at a date and is set
         below by placeOrder(). Keeping the two under different names is
         deliberate: reporting this one as the receivable understated April by
         5x, because by the time the file was made nearly everything had been
         collected — just not all of it before month end. */
      still_short: group === 'DELIVERED' ? r2(billed - collected) : 0,
      gap: r2(billed - collected),

      in_sales_file: !!(d || t || f),
      in_payment_file: !!p,
    });
  }

  ledger.sort((a, b) => Number(b.order_id) - Number(a.order_id));

  /* The cut-off. Default: the end of the latest month the orders cover, which is
     the month-end an accountant would be closing. */
  const monthsPresent = [...new Set(ledger.map((l) => l.period).filter(Boolean))].sort();
  const lastPeriod = monthsPresent[monthsPresent.length - 1];
  const monthEnd = (p) => {
    if (!p) return new Date().toISOString().slice(0, 10);
    const [y, m] = p.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  };
  /* Defaulting to the latest month is right for ONE month of data and silently
     wrong for a year: it would report a single position at the last month end
     and call it the answer. The default stands (it is what a one-month upload
     wants), but `monthsPresent` is published so the caller can build one
     statement per month — see buildMonthlyStatements below — and
     `spansMultipleMonths` is published so nobody can use a single-month figure
     over a year's data without knowing they did. */
  const asAt = asAtIn || monthEnd(lastPeriod);

  for (const l of ledger) {
    Object.assign(l, placeOrder(l, asAt, { noPaymentDates: !paymentHasDates }));
    /* What this order contributes to each line of the position statement. One
       order contributes to exactly one, so the lines always add back. */
    l.owed      = l.position === 'RECEIVABLE_LATE' ? l.collected
                : l.position === 'RECEIVABLE_UNPAID' ? l.billed : 0;
    l.uncertain = l.position === 'RECEIVABLE_UNDATED' ? l.collected
                : l.position === 'UNDATED_DELIVERY' ? l.billed : 0;
    l.in_transit_value = l.position === 'IN_TRANSIT' ? l.billed : 0;

    /* Why this order is short, in the words an accountant would use. Written
       per order so the schedule can be worked without going back to the file. */
    const ch = l.collector ? String(l.collector).trim() : '';
    const short = r2(l.billed - l.collected);
    l.unsettled_reason =
      l.group !== 'DELIVERED' ? ''
      : short <= 0.5 && short >= -0.5 ? ''
      : short < 0
        ? `Realisation of Rs ${Math.abs(short).toLocaleString('en-IN')} in excess of the invoice value `
          + `received${ch ? ` through ${ch}` : ''}. To be examined.`
      : l.collected === 0
        ? (ch
            ? `Delivered and billed Rs ${l.billed.toLocaleString('en-IN')}. No realisation received `
              + `through ${ch}. Outstanding in full.`
            : `Delivered and billed Rs ${l.billed.toLocaleString('en-IN')}. No realisation received, and `
              + 'no collection channel or UTR on record, so the party from whom recovery is due is not '
              + 'identifiable from the records produced.')
        : `Delivered and billed Rs ${l.billed.toLocaleString('en-IN')}. Part realisation of `
          + `Rs ${l.collected.toLocaleString('en-IN')} received${ch ? ` through ${ch}` : ''}; `
          + `short by Rs ${short.toLocaleString('en-IN')}.`;
  }

  const byPosition = {};
  for (const k of POSITION_ORDER) byPosition[k] = { key: k, label: POSITION[k], orders: 0, billed: 0, collected: 0, amount: 0 };
  for (const l of ledger) {
    const p = byPosition[l.position];
    p.orders += 1;
    p.billed = add(p.billed, l.billed);
    p.collected = add(p.collected, l.collected);
    /* What this position contributes to the position statement: money owed for
       the unpaid ones, money that came late for the late ones. */
    p.amount = add(p.amount, l.owed || l.uncertain || l.in_transit_value
                             || (l.position === 'PAID_IN_PERIOD' ? l.collected : l.billed));
  }

  const positionTotals = {
    asAt,
    receivable: RECEIVABLE_POSITIONS.reduce((a, k) => add(a, byPosition[k].amount), 0),
    uncertain:  UNCERTAIN_POSITIONS.reduce((a, k) => add(a, byPosition[k].amount), 0),
    inTransit:  byPosition.IN_TRANSIT.amount,
  };
  positionTotals.receivableUpperBound = add(positionTotals.receivable, positionTotals.uncertain);
  positionTotals.totalOwed = add(positionTotals.receivable, positionTotals.inTransit);

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
    cashfree: 'Cashfree', billdesk: 'Bill Desk', billdesk_exchange: 'Bill Desk — exchange',
    razorpay_exchange: 'Razorpay — exchange', shiprocket: 'Shiprocket — cash on delivery',
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


  /* The receivable, split so that the parts add back to the whole. Built from
     the POSITION, not from "delivered and short", so it agrees with the figure
     on the face of the summary. */
  const owedRows = ledger.filter((l) => l.position === 'RECEIVABLE_LATE' || l.position === 'RECEIVABLE_UNPAID');
  const bucketRow = (key, label) => {
    const rows = owedRows.filter((l) => bucketOf(l) === key);
    return { key, label, orders: rows.length, receivable: rows.reduce((a, l) => add(a, l.owed), 0) };
  };
  const receivableSplit = [
    ...collectorKeys.map((k) => bucketRow(k, COLLECTOR_LABEL[k])),
    bucketRow('other', 'Channel not among the five above'),
    bucketRow('none', 'No channel identified — within trade receivables'),
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
    shortPaid:   ledger.filter((l) => l.group === 'DELIVERED' && l.still_short > 0.5 && !isBlank(l.collector)),
    statusConflict: ledger.filter((l) => l.in_sales_file && l.in_payment_file
                                      && l.earned_taxable > 0 && l.group !== 'DELIVERED'),
    taxedNowhere:   ledger.filter((l) => l.in_payment_file && !l.in_sales_file && l.group === 'DELIVERED'),
    noDeposit:      ledger.filter((l) => l.collected !== 0 && isBlank(l.deposit_date)),
    /* Every delivered order where the money received differs from the amount
       billed — the population behind the "Unsettled" line of table D. */
    unsettled:      ledger.filter((l) => l.group === 'DELIVERED' && Math.abs(l.still_short) >= 0.01),
  };

  const sum = (arr, f) => arr.reduce((a, x) => add(a, x[f]), 0);
  const totals = {
    orders: ledger.length,
    billed: sum(ledger, 'billed'),
    collected: sum(ledger, 'collected'),
    collectorsTotal: sum(ledger, 'collectors_total'),
    /* the total of the Unsettled Orders schedule, so the figure on the face
       of table D and the schedule behind it are the same arithmetic */
    stillShortToday: sum(exceptions.unsettled, 'still_short'),
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
    receivableSplit: r2(receivableSplit.reduce((a, x) => add(a, x.receivable), 0)
                        - positionTotals.receivable),
    /* 4. every order sits in exactly one position, so the positions must rebuild
          the gross too. This is what stops a date bug from hiding an order. */
    positionSplit: r2(POSITION_ORDER.reduce((a, k) => add(a, byPosition[k].orders), 0) - ledger.length),
  };

  const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];
  /* ── the bridge from the GSTR-1 workbooks to the payment reconciliation ──
     The two documents count different things, so they are reconciled order by
     order rather than compared as totals. Three causes, and nothing left over:
       · orders taxed as delivered that the payment file gives another status
       · orders only PART delivered — the GSTR-1 workbook taxes the delivered lines,
         the payment file carries the whole order value
       · orders in the payment file that no GSTR-1 workbook contains
     Every figure below is measured, none is a balancing item. */
  /* Full precision, rounded once at the end. A delivered line's order total is
     taxable + tax and carries a sub-paisa fraction, so rounding on every one of
     29,349 additions drifts — the same fault that put the sales summary Rs 12
     out against the accountant's own figures. */
  const salesDelivered = new Map();
  for (const r of allRows) {
    if (r.source_kind !== 'DELIVERED' || !r.order_id) continue;
    salesDelivered.set(r.order_id, (salesDelivered.get(r.order_id) || 0) + (Number(r.order_total) || 0));
  }
  const payDelivered = ledger.filter((l) => l.in_payment_file && l.group === 'DELIVERED');
  /* where the source states a delivered value per line, use it — an order part
     delivered and part returned contributes only the part that arrived */
  const deliveredValue = (l) => (l.delivered_value != null && l.delivered_value > 0)
    ? l.delivered_value : l.billed;
  const payDelivIds = new Set(payDelivered.map((l) => l.order_id));

  const common = [...salesDelivered.keys()].filter((k) => payDelivIds.has(k));
  const salesOnly = [...salesDelivered.keys()].filter((k) => !payDelivIds.has(k));
  const payOnly = payDelivered.filter((l) => !salesDelivered.has(l.order_id));
  const payById = new Map(payDelivered.map((l) => [l.order_id, l]));
  const payValue = (k) => deliveredValue(payById.get(k));

  const sumBy = (keys, f) => r2(keys.reduce((a, k) => a + f(k), 0));
  const commonSales = sumBy(common, (k) => salesDelivered.get(k));
  const commonPay   = sumBy(common, payValue);
  const partDelivered = common.filter((k) => Math.abs(salesDelivered.get(k) - payValue(k)) > 0.5);

  const bridge = {
    salesDelivered:      { orders: salesDelivered.size, amount: sumBy([...salesDelivered.keys()], (k) => salesDelivered.get(k)) },
    salesOnly:           { orders: salesOnly.length, amount: sumBy(salesOnly, (k) => salesDelivered.get(k)) },
    commonPerSales:      { orders: common.length, amount: commonSales },
    partDelivered:       { orders: partDelivered.length, amount: r2(commonPay - commonSales) },
    commonPerPayment:    { orders: common.length, amount: commonPay },
    payOnly:             { orders: payOnly.length, amount: r2(payOnly.reduce((a, l) => a + deliveredValue(l), 0)) },
    payDelivered:        { orders: payDelivered.length, amount: r2(payDelivered.reduce((a, l) => a + deliveredValue(l), 0)) },
    collections:         r2(payDelivered.reduce((a, l) => a + l.collected, 0)),
    /* the direction of the part-delivery difference, which is what shows it is
       part delivery and not valuation noise */
    partHigherInPayment: partDelivered.filter((k) => payValue(k) > salesDelivered.get(k)).length,
  };
  bridge.difference = r2(bridge.salesDelivered.amount - bridge.salesOnly.amount + bridge.partDelivered.amount
                         + bridge.payOnly.amount - bridge.payDelivered.amount);
  bridge.unsettled = r2(bridge.payDelivered.amount - bridge.collections);

  const periods = [...new Set(ledger.map((l) => l.period).filter(Boolean))].sort()
    .map((p) => { const [y, m] = p.split('-'); return `${MONTHS[Number(m)]} ${y}`; });

  /* Every known limit of this data, with its size, so a reader meets it on the
     face of the report rather than discovering it later. */
  /* Each note states what its amount IS. Some are invoice value and some are
     cash received; putting both under a bare "Amount" column invited the reader
     to add them up or to read a collections figure as an exposure. */
  const lim = (key, rows, amountOf, label, why, basis) => ({
    key, label, why, basis, orders: rows.length,
    amount: r2(rows.reduce((a, x) => a + amountOf(x), 0)),
  });
  const limits = [
    lim('undatedPayment', ledger.filter((l) => l.position === 'RECEIVABLE_UNDATED'), (l) => l.collected,
        'Realisation date not recorded',
        'Delivered on or before the reporting date and realisation received, but the payment '
      + 'reconciliation records no date of receipt. The period of realisation could not be ascertained, '
      + 'hence trade receivables above are stated at the minimum.',
        'Realisation received'),
    lim('undatedDelivery', ledger.filter((l) => l.position === 'UNDATED_DELIVERY'), (l) => l.billed,
        'Date of delivery not recorded',
        'Shown as delivered in the payment reconciliation without a date of delivery, hence these could '
      + 'not be classified against the reporting date.',
        'Invoice value'),
    lim('noDeposit', exceptions.noDeposit, (l) => l.collected,
        'Bank credit date not recorded',
        'The column "Date of Deposit in bank" is blank throughout the payment reconciliation. '
      + 'Collections are traceable to the collection channel but not to the bank account, hence ageing '
      + 'against the bank statement could not be carried out.',
        'Collections received'),
    lim('noCollector', exceptions.noCollector, (l) => l.billed,
        'Collection channel not identified — delivered and unrealised, any date',
        'Delivered, no realisation received, and no payment gateway or UTR on record. The party from '
      + 'whom recovery is due could not be identified from the records produced.',
        'Invoice value'),
    lim('statusConflict', exceptions.statusConflict, (l) => l.billed,
        'GSTR-1 workbook and payment reconciliation differ',
        'Taxed as delivered in the GSTR-1 workbook, but shown under a different status in the payment '
      + 'reconciliation. One of the two records is incorrect and the GST liability depends on which. '
      + 'Reported as is; no adjustment has been made.',
        'Invoice value'),
    lim('taxedNowhere', exceptions.taxedNowhere, (l) => l.billed,
        'Delivered and realised, but not in any GSTR-1 workbook',
        'Shown as delivered in the payment reconciliation but not appearing in any GSTR-1 workbook '
      + 'produced; they may have been realised without being reported in GSTR-1. Stated at invoice '
      + `value, the same figure as in table C; realisation against them is Rs `
      + `${exceptions.taxedNowhere.reduce((a, l) => add(a, l.collected), 0)
            .toLocaleString('en-IN', { maximumFractionDigits: 0 })}.`,
        'Invoice value'),
    lim('splitShipment', ledger.filter((l) => l.split_shipment), (l) => l.billed,
        'Billed from two GST registrations',
        'A single order whose line items were dispatched from two warehouses and billed under two GST '
      + 'registrations. Taken once at order level; aggregating the registration-wise schedule instead '
      + 'would result in double counting.',
        'Invoice value'),
    ...(duplicateRows.length ? [{
      key: 'duplicateRows',
      label: 'Identical rows found in two workbooks',
      basis: 'Invoice value',
      orders: new Set(duplicateRows.map((d) => d.row.order_id)).size,
      amount: r2(duplicateRows.reduce((a, d) => a
        + Math.abs(Number(d.row.refunded_amount || d.row.order_total) || 0), 0)),
      why: 'A whole tab in one registration\'s workbook is an exact copy of another\'s — every order '
         + 'number, the same value. '
         + duplicateTabs.map((t) => `${t.entity} (${t.rows} rows) duplicates ${t.copyOfEntity}`).join('; ')
         + '. The copy has been set aside; counting it would have overstated returns. The workbooks '
         + 'themselves need correcting, and this statement does not decide which registration those '
         + 'orders belong to.',
    }] : []),
    lim('outOfWindow', ledger.filter((l) => !l.in_payment_file), (l) => l.billed,
        'Realisation falls outside the periods produced',
        'Pertaining to a period earlier than the earliest payment reconciliation produced — largely RTOs '
      + 'of a preceding month. No amount is recoverable on these, but their realisation lies in a period '
      + 'not examined.',
        'Invoice value'),
  ].filter((x) => x.orders > 0);

  return { gst: gstSummary(allRows), bridge, paymentHasDates,
           duplicateRows: duplicateRows.length, duplicateTabs,
           monthsPresent, spansMultipleMonths: monthsPresent.length > 1, monthEnd,
           ledger, byGroup, GROUP_ORDER, GROUP_LABEL, byCollector, byEntity, receivableSplit,
           exceptions, totals, checks, periods, collectorKeys, COLLECTOR_LABEL, bucketOf,
           byPosition, POSITION, POSITION_ORDER, positionTotals, asAt, limits };
}

/**
 * One statement per month, which is how GSTR-1 is filed and what the user asked
 * for. A month's rows are the rows whose `period` is that month — and `period`
 * is already the month the row belongs to IN THE RETURN, not merely the month
 * the order was placed: a delivered row carries its order month, an RTO row the
 * month the goods came BACK, a refund row the month it was refunded. So the
 * scoping needs no calendar of its own.
 *
 * Scoping matters as much as the cut-off. Building an April statement from a
 * whole year's rows with asAt = 30 April would classify every later order as
 * "goods in transit at 30 April" — orders that had not been placed yet.
 *
 * `monthsWithoutPayment` names the months whose payment reconciliation was
 * never produced (June and September 2025 for Off Duty). Those months get their
 * sales and GST figures and NO receivable, and the caller must SAY so — a blank
 * or a zero would read as "nothing is owed".
 */
function buildMonthlyStatements(allRows, opts = {}) {
  const months = [...new Set(allRows.map((r) => r.period).filter(Boolean))].sort();
  const pad2 = (n) => String(n).padStart(2, '0');
  const endOf = (p) => { const [y, m] = p.split('-').map(Number);
                         return `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
  return months.map((month) => {
    const rows = allRows.filter((r) => r.period === month);
    const hasPayment = rows.some((r) => r.source_kind === 'PAYMENT');
    return {
      month,
      asAt: endOf(month),
      hasPayment,
      /* stated, not implied — see the note above */
      receivableNote: hasPayment ? null
        : 'No payment reconciliation was produced for this month, so no receivable is reported. '
        + 'The sales, RTO and return figures below are complete.',
      result: buildReceivables(rows, endOf(month)),
    };
  });
}

module.exports = { buildReceivables, buildMonthlyStatements, gstSummary, isSameMonthRto, moneyGroup, placeOrder, GROUP_LABEL, GROUP_ORDER, POSITION };

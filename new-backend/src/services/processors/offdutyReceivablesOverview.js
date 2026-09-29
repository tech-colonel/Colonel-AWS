/**
 * The year on one screen.
 *
 * The month-by-month statements already exist and are the authority; this file
 * does not recompute anything. It takes what each month's statement already
 * says and answers the two questions an accountant asks before reading any of
 * them:
 *
 *   1. What do the twelve months look like side by side — sales, returns,
 *      collections, and what is still recoverable at each month end?
 *   2. What is wrong, how big is it, and which months is it in?
 *
 * Nothing here is a balancing figure. Every amount is carried straight from the
 * month it belongs to, and every count is the count of orders in that month's
 * own schedule, so a figure on this screen and the same figure inside that
 * month's workbook are the same arithmetic.
 */

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const label = (period) => { const [y, m] = String(period).split('-'); return `${MONTHS[Number(m)]} ${y}`; };

/* How much a finding matters, and why it is ranked where it is.
   `critical` = something in the records is wrong or a liability may be
   unreported. `attention` = a real amount whose recovery or treatment has to be
   decided. `note` = a limit of the records produced, which changes how a figure
   should be read but is not itself an error. */
const SEVERITY = {
  taxedNowhere: 'critical',
  duplicateRows: 'critical',
  noPaymentFile: 'attention',
  rtoNotProduced: 'attention',
  statusConflict: 'attention',
  noCollector: 'attention',
  shortPaid: 'attention',
  checkFailed: 'critical',
  undatedPayment: 'note',
  undatedDelivery: 'note',
  noDeposit: 'note',
  splitShipment: 'note',
  outOfWindow: 'note',
};
const SEV_RANK = { critical: 0, attention: 1, note: 2 };

/* What to do about it, in the words the firm would use in a query to the
   client. The workbook states what a figure IS; this states what it needs. */
const ACTION = {
  taxedNowhere: 'Confirm whether these orders were reported in GSTR-1 under another registration. '
    + 'If they were not, the tax on them is unpaid.',
  duplicateRows: 'The workbooks themselves need correcting. Until they are, the returns of the two '
    + 'registrations concerned cannot both be relied on.',
  noPaymentFile: 'Obtain the payment reconciliation for these months. Their sales and returns are '
    + 'complete; only the receivable could not be computed.',
  statusConflict: 'Decide which of the two records is right. The GST already charged depends on it.',
  noCollector: 'Identify the party from whom recovery is due, or write the amount off.',
  shortPaid: 'Take up the short realisation with the collection channel.',
  checkFailed: 'Do not rely on the month until this is traced — a figure and the schedule behind it '
    + 'do not agree.',
  undatedPayment: 'Trade receivables are stated at the minimum because of this. Ask for the dates of '
    + 'receipt if the exact position at the month end is needed.',
  undatedDelivery: 'Ask for the dates of delivery if the exact position at the month end is needed.',
  noDeposit: 'Collections cannot be aged against the bank account until the deposit dates are given.',
  splitShipment: 'No action — stated so that the registration-wise tables are not added together.',
  outOfWindow: 'No action — the realisation lies in a period not examined.',
};

/** One row of the month-by-month table, taken from that month's statement. */
function monthRow(s) {
  const b = s.result;
  const g = (b.gst.consolidated || b.gst.blocks[0] || {});
  const heads = (o) => o ? r2((o.cgst || 0) + (o.sgst || 0) + (o.igst || 0)) : 0;
  const ex = b.exceptions;
  const amt = (rows, f) => r2(rows.reduce((a, l) => a + (Number(l[f]) || 0), 0));

  return {
    month: s.month,
    label: label(s.month),
    asAt: s.asAt,
    hasPayment: s.hasPayment,
    note: s.receivableNote,
    orders: b.totals.orders,

    /* sales, as the accountant's own Sales Summary casts it */
    salesTaxable: g.sales ? r2(g.sales.taxable_value) : 0,
    salesTax: heads(g.sales),
    rtoTaxable: g.rto ? r2(g.rto.taxable_value) : 0,
    refundTaxable: g.refund ? r2(g.refund.taxable_value) : 0,
    returnsTaxable: g.totalReturn ? r2(g.totalReturn.taxable_value) : 0,
    /* A month whose workbooks carry no RTO tab and no RTO-flagged sales line
       has no RTO FIGURE — which is not the same as an RTO of nil. Shown as
       "not produced" rather than as a zero, because a zero reads as "there
       were none". */
    rtoProduced: !!(g.rto && g.rto.lines > 0),
    refundProduced: !!(g.refund && g.refund.lines > 0),
    netTaxable: g.net ? r2(g.net.taxable_value) : 0,
    netTax: heads(g.net),

    /* the payment side */
    billed: b.totals.billed,
    collected: b.totals.collected,

    /* the position at that month end */
    receivable: b.positionTotals.receivable,
    inTransit: b.positionTotals.inTransit,
    uncertain: b.positionTotals.uncertain,
    upperBound: b.positionTotals.receivableUpperBound,

    /* the bridge from the GSTR-1 workbooks to the payment file must close */
    bridgeDifference: b.bridge.difference,
    checks: b.checks,
    checksOk: Object.values(b.checks).every((v) => Math.abs(v) < 0.5),

    exceptions: {
      taxedNowhere:   { orders: ex.taxedNowhere.length,   amount: amt(ex.taxedNowhere, 'billed') },
      statusConflict: { orders: ex.statusConflict.length, amount: amt(ex.statusConflict, 'billed') },
      noCollector:    { orders: ex.noCollector.length,    amount: amt(ex.noCollector, 'billed') },
      shortPaid:      { orders: ex.shortPaid.length,      amount: amt(ex.shortPaid, 'still_short') },
      duplicateRows:  { orders: b.duplicateRows, amount: 0 },
    },
    duplicateTabs: b.duplicateTabs || [],
    entities: b.byEntity.map((e) => e.entity).filter((e) => !e.includes('+')),
  };
}

/**
 * Everything wrong in the year, largest first, each one naming the months it is
 * in. Built by aggregating the limits each month's statement already carries —
 * so a finding here is never a new claim, only the same claim added up.
 */
function buildFindings(statements, rows) {
  const byKey = new Map();
  const push = (key, label, basis, orders, amount, month, why) => {
    if (!orders && !amount) return;
    let f = byKey.get(key);
    if (!f) {
      f = { key, label, basis, severity: SEVERITY[key] || 'note',
            action: ACTION[key] || '', orders: 0, amount: 0, months: [], why };
      byKey.set(key, f);
    }
    f.orders += orders;
    f.amount = r2(f.amount + amount);
    f.months.push({ month, orders, amount });
  };

  /* Everything below the first two keys is derived from the payment
     reconciliation. For a month that has none, "no collection channel on
     record" and "not in the payment file" are true of every order in the month
     and say nothing — they are the missing file, which is already its own
     finding. Reporting them again would treat one absence as several, and
     would put crores of ordinary sales under a heading that reads as a
     problem. */
  const FROM_THE_RECORDS_THEMSELVES = new Set(['duplicateRows', 'splitShipment']);

  for (const s of statements) {
    for (const l of s.result.limits) {
      if (!s.hasPayment && !FROM_THE_RECORDS_THEMSELVES.has(l.key)) continue;
      push(l.key, l.label, l.basis || '', l.orders, l.amount, s.month, l.why);
    }
    const sp = s.result.exceptions.shortPaid;
    if (sp.length) {
      push('shortPaid', 'Part realisation received', 'Amount short',
           sp.length, r2(sp.reduce((a, l) => a + (Number(l.still_short) || 0), 0)), s.month,
           'Delivered and part realised through a collection channel. The balance is short and has '
           + 'not been received.');
    }
  }

  /* The months whose payment reconciliation was never produced. Stated as a
     finding rather than left as a blank column, because a blank reads as nil. */
  const missing = statements.filter((s) => !s.hasPayment);
  if (missing.length) {
    const f = { key: 'noPaymentFile', label: 'Payment reconciliation not produced',
      basis: 'Net sales of those months', severity: 'attention', action: ACTION.noPaymentFile,
      orders: 0, amount: 0, months: [],
      why: 'No payment reconciliation was produced for these months, so no receivable could be '
         + 'computed for them. Their sales, RTO and return figures are complete, and the year\'s '
         + 'receivable is therefore stated only for the months that were reconciled.' };
    for (const s of missing) {
      const g = s.result.gst.consolidated || s.result.gst.blocks[0] || {};
      const a = g.net ? r2(g.net.taxable_value) : 0;
      f.orders += s.result.totals.orders;
      f.amount = r2(f.amount + a);
      f.months.push({ month: s.month, orders: s.result.totals.orders, amount: a });
    }
    byKey.set('noPaymentFile', f);
  }

  /* The months whose workbooks carry no RTO tab at all. */
  const noRto = statements.filter((st) => {
    const g = st.result.gst.consolidated || st.result.gst.blocks[0] || {};
    return !(g.rto && g.rto.lines > 0);
  });
  if (noRto.length && noRto.length < statements.length) {
    byKey.set('rtoNotProduced', {
      key: 'rtoNotProduced', label: 'No RTO figure produced for the month',
      basis: 'Refunds stated for those months', severity: 'attention',
      action: 'Ask for the RTO tab for these months, or confirm that returns to origin are already '
            + 'inside the refund figures. Until then the split between the two cannot be given.',
      orders: 0, amount: 0, months: [],
      why: 'The workbooks for these months carry a refund tab but no RTO tab, and no sales line in '
         + 'them is flagged as a return to origin. Goods returned before delivery are therefore '
         + 'either inside the refund figures or were not produced at all; which of the two cannot be '
         + 'determined from the records. The RTO column is shown as not produced rather than as nil, '
         + 'because a nil would read as "there were none".',
    });
    const f = byKey.get('rtoNotProduced');
    for (const st of noRto) {
      const g = st.result.gst.consolidated || st.result.gst.blocks[0] || {};
      const a = g.refund ? Math.abs(r2(g.refund.taxable_value)) : 0;
      f.orders += g.refund ? g.refund.lines : 0;
      f.amount = r2(f.amount + a);
      f.months.push({ month: st.month, orders: g.refund ? g.refund.lines : 0, amount: a });
    }
  }

  /* A month whose own internal checks do not tie. There should never be one;
     if there is, it outranks everything else on the page. */
  const broken = statements.filter((s) => !Object.values(s.result.checks).every((v) => Math.abs(v) < 0.5));
  if (broken.length) {
    byKey.set('checkFailed', {
      key: 'checkFailed', label: 'A month does not tie to its own schedules', basis: 'Difference',
      severity: 'critical', action: ACTION.checkFailed, orders: broken.length,
      amount: r2(broken.reduce((a, s) => a + Math.max(...Object.values(s.result.checks).map(Math.abs)), 0)),
      months: broken.map((s) => ({ month: s.month, orders: 1,
        amount: Math.max(...Object.values(s.result.checks).map(Math.abs)) })),
      why: 'One of the four arithmetic checks on this month does not come to nil. The figures on the '
         + 'face of the statement and the schedules behind them do not agree.',
    });
  }

  return [...byKey.values()].sort((a, b) =>
    (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (b.amount - a.amount));
}

/** The year across every month held. `statements` comes from buildMonthlyStatements. */
function buildOverview(statements, meta = {}) {
  const months = statements.map(monthRow);
  const s = (f) => r2(months.reduce((a, m) => a + (Number(m[f]) || 0), 0));
  const withPay = months.filter((m) => m.hasPayment);
  const sp = (f) => r2(withPay.reduce((a, m) => a + (Number(m[f]) || 0), 0));

  const year = {
    months: months.length,
    monthsWithPayment: withPay.length,
    from: months.length ? months[0].label : null,
    to: months.length ? months[months.length - 1].label : null,
    asAt: months.length ? months[months.length - 1].asAt : null,
    orders: months.reduce((a, m) => a + m.orders, 0),
    salesTaxable: s('salesTaxable'), salesTax: s('salesTax'),
    rtoTaxable: s('rtoTaxable'), refundTaxable: s('refundTaxable'),
    returnsTaxable: s('returnsTaxable'),
    netTaxable: s('netTaxable'), netTax: s('netTax'),
    billed: s('billed'), collected: s('collected'),
    /* The receivable is a POSITION, not a flow: each month's is the amount
       outstanding at that month end. They are shown side by side and are NOT
       added — the year's figure is the closing month's. Only the months that
       were reconciled carry one. */
    closingReceivable: withPay.length ? withPay[withPay.length - 1].receivable : 0,
    closingInTransit: withPay.length ? withPay[withPay.length - 1].inTransit : 0,
    closingMonth: withPay.length ? withPay[withPay.length - 1].label : null,
    /* What every month left behind, added across the months — the recovery list
       for the year, which IS a total because each order appears in one month. */
    receivableAllMonths: sp('receivable'),
    inTransitAllMonths: sp('inTransit'),
    uncertainAllMonths: sp('uncertain'),
  };

  return { ...meta, year, months, findings: buildFindings(statements) };
}

/* One month's own limits, ranked and carrying the same severity and the same
   "what to do" as the year's findings — so a month reads like the year and the
   two never call the same thing by two names. */
function decorateLimits(limits) {
  return (limits || [])
    .map((l) => ({ ...l, severity: SEVERITY[l.key] || 'note', action: ACTION[l.key] || '' }))
    .sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (b.amount - a.amount));
}

module.exports = { buildOverview, buildFindings, monthRow, label, SEVERITY, ACTION, decorateLimits };

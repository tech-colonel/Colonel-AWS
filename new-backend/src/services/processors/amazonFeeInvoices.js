/* ── Amazon FEE invoices vs the settlement ────────────────────────────────
   Amazon takes its fees out of the settlement, then raises a tax invoice for
   the same fees. This asks one question per month: is every rupee it took
   backed by a document?

   TWO SIDES, and they are NOT symmetrical:

     the invoice     names every fee - Fixed Closing, Listing, FBA Weight
                     Handling, Storage, Removal... eleven kinds across the run
     the settlement  names none of them. It only drops each fee into one of
                     four money columns.

   So the TOTALS can be matched today and a kind-by-kind match cannot. The
   weekly settlement ledgers DO name each fee; once enough of them are held
   this grows a third panel. Until then the honest thing is to say so on the
   page rather than invent a mapping.

   WHICH DATE. Amazon invoices by the date it RECORDED the charge - the
   settlement's `date/time`. Measured over 18 months that is the only basis
   that ties: posted is out 0.13% over the 17 full months, while the release
   date swings up to Rs 41,082 in a single month and the sales basis drifts
   by the fees that get billed a month late. The release basis is deliberately
   NOT built here - it answers a bank question, not an invoice question, and
   belongs with the bank view ([[amazonReceivablesLedger]] already dates cash
   that way).

   STORAGE IS NOT AN ORDER COST. Storage, long-term storage, removals,
   disposals and inbound transport are billed for the MONTH, and 54 of those
   rows carry no order id at all - which is why the order-by-order ledger has
   never shown them (`if (!id) continue`). Rs 1.26 lakh over 18 months,
   invisible until now. They are reported as their own column and deliberately
   kept OUT of the receivable arithmetic: Amazon does not deduct them from any
   order's payout, so folding them into "Amazon charges" would push still-
   pending about Rs 1.08 lakh negative and break a reconciliation that is
   currently exact to Rs 10,171. */

const { monthKey, num, r2 } = require('./amazonThreeWay');

/* The four money columns of the unified transaction report. Amazon writes a
   charge as a NEGATIVE number (it is leaving the seller), so every one is
   negated to read as a positive cost. `other` is only a fee on the rows whose
   type says so - on every other row it is a reimbursement, an adjustment or
   advertising, none of which these invoices cover. */
/* The uploaded unified report spells these with spaces; a row pivoted out of a
   retained settlement ledger spells the SAME field with underscores. Reading
   only one spelling makes Amazon's fees read as ZERO for every ledger-sourced
   month - exactly the failure the controller's own comment warns about, and
   it silently cost Jul and Aug 2026 their entire fee line on the first run. */
const FEE_COLS = [['selling fees', 'selling_fees'],
                  ['fba fees', 'fba_fees'],
                  ['other transaction fees', 'other_transaction_fees']];
const INVENTORY_FEE_TYPE = 'FBA Inventory Fee';

const col = (r, pair) => (r[pair[0]] !== undefined ? r[pair[0]] : r[pair[1]]);

/* Advertising sits in `other` under a Service Fee row and is NOT on these
   PDFs - Amazon bills it separately. Both sides leave it out, which is part of
   why they tie; reading `other` unconditionally would break that. */
function feeOf(r) {
  let f = 0;
  for (const c of FEE_COLS) f += num(col(r, c));
  return -f;
}

function storageOf(r) {
  const t = String(r.type || r.__type || '').trim();
  return t === INVENTORY_FEE_TYPE ? -num(r.other) : 0;
}

const orderIdOf = (r) => String(r['order id'] ?? r.order_id ?? '').trim();
const postedOf = (r) => monthKey(r['date/time'] ?? r.date_time ?? r.month ?? '');

/* Date Range Reports are requested by hand and overlap constantly - a
   Jun1-Jul1 file and an Apr1-Sep22 file both carry every June row, and the
   month-ownership rule upstream keeps both files. Folding them straight gave
   June 2026 EXACTLY twice its fees.

   The rule is the controller's, not a new one: two rows with the same content
   are a duplicate only when they came from DIFFERENT sources. A genuinely
   repeated payment inside one file - two identical rows for a 2-unit order,
   which is real and was once wrongly discarded - keeps its matching `__src`
   and is kept. */
function dedupe(rows) {
  const bySig = new Map();
  const out = [];
  for (const r of rows) {
    const sig = [r['date/time'] ?? r.date_time, r['settlement id'] ?? r.settlement_id,
                 r.type, orderIdOf(r), r.Sku ?? r.sku, r.description,
                 r.quantity, r.total].join('\u0000');
    const src = r.__src || 'unknown';
    const seen = bySig.get(sig);
    if (seen && !seen.has(src)) continue;      // same row, another file - a copy
    if (!seen) bySig.set(sig, new Set([src]));
    else seen.add(src);
    out.push(r);
  }
  return out;
}

/* ── the settlement side, folded by the month Amazon recorded the charge ── */
function foldSettlement(rows, saleMonthOf) {
  const per = new Map();
  const get = (m) => {
    let p = per.get(m);
    if (!p) {
      p = { month: m, rows: 0, orders: new Set(),
            selling: 0, fba: 0, otherTxn: 0, storage: 0,
            own: 0, carryIn: 0, carryFwd: 0, unknownOrder: 0,
            carryInFrom: new Map() };
      per.set(m, p);
    }
    return p;
  };

  /* A fee billed on a month's sales but RECORDED the next month is not lost -
     it is on the next month's invoice. Tracked both ways so the bridge on the
     cohort view closes exactly rather than landing on a residual. */
  const carryOutBySale = new Map();

  for (const r of rows) {
    const posted = postedOf(r);
    if (!posted) continue;
    const fee = feeOf(r);
    const storage = storageOf(r);
    if (Math.abs(fee) < 0.005 && Math.abs(storage) < 0.005) continue;

    const p = get(posted);
    p.rows += 1;
    const id = orderIdOf(r);
    if (id) p.orders.add(id);

    /* An order id is what makes a fee attributable. Without one the charge is
       for the month itself - that is the storage family, and it is the whole
       reason this column exists. */
    if (!id) {
      p.storage += fee;
    } else {
      p.selling += -num(col(r, FEE_COLS[0]));
      p.fba += -num(col(r, FEE_COLS[1]));
      p.otherTxn += -num(col(r, FEE_COLS[2]));
    }
    p.storage += storage;

    if (id) {
      const sale = saleMonthOf(id);
      if (!sale) {
        /* The order report does not reach this order - it predates the window
           or postdates the last file. Shown separately rather than silently
           counted as this month's own, which would overstate the cohort. */
        p.unknownOrder += fee;
      } else if (sale === posted) {
        p.own += fee;
      } else if (sale < posted) {
        p.carryIn += fee;
        p.carryInFrom.set(sale, r2((p.carryInFrom.get(sale) || 0) + fee));
      } else {
        p.carryFwd += fee;
      }
      if (sale && sale !== posted) {
        const k = `${sale}\u0000${posted}`;
        carryOutBySale.set(k, r2((carryOutBySale.get(k) || 0) + fee));
      }
    }
  }

  return { per, carryOutBySale };
}

/* ── build ────────────────────────────────────────────────────────────────
   `invoices` is the parsed-PDF cache: one entry per month, already netted of
   credit notes by the reader (a credit note's total is negative). It is an
   OPTIONAL leg - a brand that has not uploaded its fee invoices still gets
   the settlement side and a clear "no documents" state, rather than a 500. */
function build(src, months, opts = {}) {
  const invoices = opts.invoices || [];
  /* A month restored from a retained settlement ledger is dated by the day
     Amazon RELEASED the money, not the day it recorded the charge - the
     ledger has no posted-date column at all (order 403-0255035-3228328:
     the unified report says posted 3 Jul / released 18 Jul, the ledger says
     18.07.2026). Amazon invoices on the POSTED date, so such a month cannot
     tie to its invoice however good the data is: it is holding a fortnight of
     the previous month's tail. Measured on Koparo, Jul 2026 reads 26,821
     against an invoice of 21,239 for exactly this reason.
     These months are flagged and kept OUT of the headline difference rather
     than reported as a shortfall nobody can close. */
  const sourceKind = opts.sourceKind || {};
  const byMonth = new Map(invoices.map((d) => [d.month, d]));

  /* Koparo books on the order date, so the cohort a fee belongs to is the
     month its ORDER sold in - not the month the fee was charged. */
  const saleOf = new Map();
  for (const r of src.orders || []) {
    const id = String(r['amazon-order-id'] || '').trim();
    if (!id || saleOf.has(id)) continue;
    const m = monthKey(r['purchase-date']);
    if (m) saleOf.set(id, m);
  }
  const saleMonthOf = (id) => saleOf.get(id) || '';

  const { per, carryOutBySale } = foldSettlement(dedupe(src.settlement || []), saleMonthOf);

  const carryOutOf = (sale) => {
    let total = 0;
    const to = {};
    for (const [k, v] of carryOutBySale) {
      const [s, posted] = k.split('\u0000');
      if (s !== sale || posted <= sale) continue;
      total += v;
      to[posted] = r2((to[posted] || 0) + v);
    }
    return { total: r2(total), to };
  };

  const rows = months.map((m) => {
    const p = per.get(m) || { rows: 0, orders: new Set(), selling: 0, fba: 0,
                              otherTxn: 0, storage: 0, own: 0, carryIn: 0,
                              carryFwd: 0, unknownOrder: 0, carryInFrom: new Map() };
    const inv = byMonth.get(m) || null;
    const took = r2(p.selling + p.fba + p.otherTxn + p.storage);
    const invoiced = inv ? r2(inv.total) : null;
    const out = carryOutOf(m);

    const basis = sourceKind[m] === 'ledger' ? 'release' : 'posted';

    return {
      month: m,
      sourceKind: sourceKind[m] || 'unified',
      /* A ledger month is dated by release, so its difference is a basis
         artefact, not a shortfall. Named so the UI can grey it rather than
         colour it red. */
      basis,
      basisMismatch: basis === 'release' && invoiced !== null,
      /* the invoice side */
      documents: inv ? inv.documents : 0,
      invoiceCount: inv ? inv.invoices : 0,
      creditNotes: inv ? inv.creditNotes : 0,
      invoiceFee: inv ? r2(inv.fee) : null,
      invoiceGst: inv ? r2(inv.gst) : null,
      invoiced,
      byKind: inv ? inv.byKind : {},
      /* the settlement side */
      settlementRows: p.rows,
      settlementOrders: p.orders.size,
      selling: r2(p.selling),
      fba: r2(p.fba),
      otherTxn: r2(p.otherTxn),
      storage: r2(p.storage),
      took,
      /* the two sides against each other */
      diff: invoiced === null ? null : r2(took - invoiced),
      ties: invoiced !== null && Math.abs(took - invoiced) < 0.005,
      /* the cohort bridge: this month's own orders, re-dated to the invoice */
      ownOrderFees: r2(p.own + out.total),
      billedLater: r2(-out.total),
      billedHere: r2(p.carryIn),
      outsideOrderFile: r2(p.unknownOrder + p.carryFwd),
      carryInFrom: Object.fromEntries(p.carryInFrom),
      carryOutTo: out.to,
    };
  });

  const sum = (k) => r2(rows.reduce((a, r) => a + (r[k] || 0), 0));
  const kinds = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.byKind || {})) kinds[k] = r2((kinds[k] || 0) + v);
  }

  /* A month whose settlement is only partly loaded reads as a shortfall that
     is not one - our file stops mid-September while Amazon's invoice covers
     the whole month. Naming it keeps the headline figure honest instead of
     carrying a gap nobody can close. */
  const partial = rows.filter((r) => r.invoiced !== null && r.diff !== null
    && Math.abs(r.diff) > 0.005 && r.settlementRows > 0
    && r.diff < 0 && Math.abs(r.diff) > 0.2 * r.invoiced).map((r) => r.month);

  const full = rows.filter((r) => r.invoiced !== null && !partial.includes(r.month)
    && !r.basisMismatch);
  const totals = {
    invoiced: sum('invoiced'),
    took: sum('took'),
    selling: sum('selling'),
    fba: sum('fba'),
    otherTxn: sum('otherTxn'),
    storage: sum('storage'),
    documents: rows.reduce((a, r) => a + r.documents, 0),
    invoiceCount: rows.reduce((a, r) => a + r.invoiceCount, 0),
    creditNotes: rows.reduce((a, r) => a + r.creditNotes, 0),
    settlementRows: rows.reduce((a, r) => a + r.settlementRows, 0),
    monthsTying: rows.filter((r) => r.ties).length,
    monthsWithInvoices: rows.filter((r) => r.invoiced !== null).length,
  };
  totals.diff = r2(totals.took - totals.invoiced);
  totals.unexplained = r2(full.reduce((a, r) => a + (r.diff || 0), 0));
  totals.partialMonths = partial;
  totals.basisMonths = rows.filter((r) => r.basisMismatch).map((r) => r.month);
  totals.basisGap = r2(rows.filter((r) => r.basisMismatch)
    .reduce((a, r) => a + (r.diff || 0), 0));
  totals.comparableMonths = full.length;
  totals.partialGap = r2(totals.diff - totals.unexplained - totals.basisGap);
  totals.invoiceFee = r2(rows.reduce((a, r) => a + (r.invoiceFee || 0), 0));
  totals.invoiceGst = r2(rows.reduce((a, r) => a + (r.invoiceGst || 0), 0));

  return {
    rows,
    totals,
    kinds,
    /* the PDFs name eleven fees, the settlement names four columns - the UI
       says so rather than pretending a mapping exists */
    hasInvoices: totals.monthsWithInvoices > 0,
    note: {
      storageTotal: totals.storage,
      advertisingExcluded: true,
    },
  };
}

module.exports = { build, feeOf, storageOf, dedupe, FEE_COLS, INVENTORY_FEE_TYPE };

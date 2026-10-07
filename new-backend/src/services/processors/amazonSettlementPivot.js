/* ──────────────────────────────────────────────────────────────────────────────
   amazonSettlementPivot.js — turn Amazon's settlement LEDGER into the WIDE rows
   the settlement-amazon agent already stores.

   Why this exists at all:

     Seller Central's on-screen export gives one row per order item, with
     `product sales`, `selling fees`, `TCS-CGST` … as COLUMNS. That is a pivot
     Amazon performs for you in the UI.

     The settlement report we now receive automatically is the underlying ledger:
     one row per AMOUNT COMPONENT. A single order item produces six or more rows
     — Principal, Product Tax, TDS, closing fee, closing fee IGST, TCS — each
     with an `amount-type` / `amount-description` pair and a signed `amount`.

   So the file is not a renamed version of the old one; it has to be pivoted back
   into the agent's shape. Everything downstream (the MIS builder, the files
   list, the stored table) then works unchanged.

   The category map below was derived from Koparo's actual settlements, not from
   documentation. Anything that does not match a rule lands in `other` and is
   reported in `unmapped` — money is never silently dropped, and a new fee type
   Amazon introduces shows up as a named unknown rather than a wrong total.

   BALANCE CHECK: because every amount is placed in exactly one bucket, the sum
   of the wide columns must equal the sum of the ledger's `amount` column. That
   equality is the proof the pivot is complete, and `verifyBalance()` asserts it.

   KNOWN GAP: the ledger carries no buyer city / state / postal code, which the
   on-screen export does. Those columns stay null here. Place of supply must come
   from the orders report or the MTR, not from settlement.
   ────────────────────────────────────────────────────────────────────────────── */


/* ── dates ──────────────────────────────────────────────────────────────────────
   Amazon sends "05.09.2026 18:56:56 UTC" — DAY.MONTH.YEAR, dotted.

   Handing that to `new Date()` is silently wrong: JavaScript reads a dotted date
   month-first, so 5 September becomes 9 May, and any day past the 12th becomes
   Invalid Date, which Postgres then rejects outright. Both failures are worse
   than useless — one is loud, the other quietly wrong in the books.

   So the format is parsed explicitly. Anything unrecognised returns null rather
   than a guess, because a missing date is recoverable and a wrong one is not.
   ────────────────────────────────────────────────────────────────────────────── */
const DOTTED = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2}):(\d{2}))?\s*(UTC)?/i;

function parseAmazonDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const m = DOTTED.exec(raw);
  if (m) {
    const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
    const day = Number(dd), month = Number(mm);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Amazon stamps these UTC; building from Date.UTC keeps the server's own
    // timezone out of it.
    const d = new Date(Date.UTC(Number(yyyy), month - 1, day, Number(hh), Number(mi), Number(ss)));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // ISO or anything else JS parses unambiguously.
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* Amazon's amounts are plain decimal strings; floats would drift across 400+
   rows, so everything is summed in paise as integers and converted back once. */
const toPaise = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const fromPaise = (p) => Number((p / 100).toFixed(2));

const has = (s, ...needles) => {
  const t = String(s || '').toLowerCase();
  return needles.some((n) => t.includes(n));
};

/**
 * Which wide column does one ledger line belong to?
 *
 * Ordering matters: the first matching rule wins, so the specific tests (TCS,
 * TDS, FBA) sit above the general ones (any ItemFees → selling fees).
 *
 * Fee GST stays with its fee — "Fixed closing fee IGST" goes to selling_fees
 * alongside "Fixed closing fee" — because that is how the on-screen export
 * presents it, and the agent's MIS was built against that export.
 */
function bucketFor(amountType, amountDescription) {
  const type = String(amountType || '');
  const desc = String(amountDescription || '');

  // ── balance adjustments (NOT fees) ──────────────────────────────────────
  // "Debt Adjustment against COD Transactions and Non-Transactional Fee
  // Accounts" is Amazon recovering money already owed from an earlier period
  // — a COD shortfall, unpaid account charges. It is the settlement of a prior
  // liability, not a cost of selling in this period, so it must NOT land in
  // the fee columns. `other` is where Amazon's own export puts it too.
  // Recognised explicitly here so it stops reading as an unknown category.
  if (has(type, 'debt', 'adjustment') || has(desc, 'debt adjustment') || has(desc, 'payable to amazon')) return 'other';

  // ── withheld taxes ──────────────────────────────────────────────────────
  if (has(type, 'itemtcs') || has(desc, 'tcs-')) {
    if (has(desc, 'cgst')) return 'tcs_cgst';
    if (has(desc, 'sgst')) return 'tcs_sgst';
    if (has(desc, 'igst')) return 'tcs_igst';
    return 'other';
  }
  if (has(type, 'itemtds') || has(desc, '194-o', '194o')) return 'tds_194o';

  // ── promotions (before ItemPrice: a discount is an ItemPrice-shaped line) ─
  if (has(type, 'promotion') || has(desc, 'discount')) return 'promotional_rebates';

  // ── revenue side ────────────────────────────────────────────────────────
  if (has(type, 'itemprice')) {
    if (has(desc, 'gift') && has(desc, 'tax')) return 'gst_before_tcs';
    if (has(desc, 'gift'))                     return 'gift_wrap_credits';
    if (has(desc, 'tax'))                      return 'gst_before_tcs';   // product + shipping tax
    if (has(desc, 'shipping'))                 return 'shipping_credits';
    if (has(desc, 'principal'))                return 'product_sales';
    return 'other';
  }

  // ── fees ────────────────────────────────────────────────────────────────
  if (has(type, 'itemfees', 'fbafees', 'fee')) {
    if (has(desc, 'fba') || has(type, 'fbafees')) return 'fba_fees';
    if (has(desc, 'commission', 'closing fee', 'referral')) return 'selling_fees';
    return 'other_transaction_fees';
  }
  if (has(type, 'amazon fees')) return 'other_transaction_fees';

  return 'other';
}

const WIDE_COLUMNS = [
  'product_sales', 'shipping_credits', 'gift_wrap_credits', 'promotional_rebates',
  'gst_before_tcs', 'tcs_cgst', 'tcs_sgst', 'tcs_igst', 'tds_194o',
  'selling_fees', 'fba_fees', 'other_transaction_fees', 'other',
];

/**
 * One wide row per order ITEM, matching the granularity of the on-screen export.
 * An order with two SKUs is two rows, which is why the key includes the item
 * code rather than only the order id.
 */
function groupKey(row) {
  return [
    row['order-id'] || row['adjustment-id'] || row['shipment-id'] || '',
    row['order-item-code'] || row['merchant-adjustment-item-id'] || row['sku'] || '',
    row['transaction-type'] || '',
  ].join('§');
}

/**
 * Pivot ledger rows → wide rows.
 *
 * Returns:
 *   rows      — wide rows, ready for the agent's table
 *   settlement— the header row's metadata (id, period, deposit date, total)
 *   unmapped  — distinct categories that fell through to `other`, with totals
 *   totals    — ledger total vs pivoted total, in rupees
 */
function pivotSettlementRows(ledgerRows) {
  const groups = new Map();
  const unmapped = new Map();
  let settlement = null;
  let ledgerPaise = 0;

  for (const row of ledgerRows) {
    const txnType = String(row['transaction-type'] || '').trim();

    /* The first line of every settlement file is the settlement header: it
       carries settlement-id, the period, the deposit date and the payout total,
       with no transaction against it. Treating it as a transaction is how a
       settlement ends up counted twice — once as itself and once as the sum of
       its own parts. */
    if (!txnType) {
      if (!settlement) {
        settlement = {
          settlement_id:  row['settlement-id'] || null,
          start_date:     row['settlement-start-date'] || null,
          end_date:       row['settlement-end-date'] || null,
          deposit_date:   row['deposit-date'] || null,
          total_amount:   row['total-amount'] === '' ? null : Number(row['total-amount']),
          currency:       row['currency'] || null,
        };
      }
      continue;
    }

    const paise = toPaise(row['amount']);
    ledgerPaise += paise;

    const key = groupKey(row);
    let g = groups.get(key);
    if (!g) {
      g = {
        settlement_id: row['settlement-id'] || null,
        type:          txnType,
        order_id:      row['order-id'] || row['adjustment-id'] || null,
        sku:           row['sku'] || null,
        description:   row['amount-description'] || null,
        quantity:      row['quantity-purchased'] === '' ? null : row['quantity-purchased'],
        marketplace:   row['marketplace-name'] || null,
        fulfillment:   row['fulfillment-id'] || null,
        date_time:     parseAmazonDate(row['posted-date-time'] || row['posted-date']),
        // Not present in the ledger — see KNOWN GAP at the top of this file.
        account_type:  null,
        order_city:    null,
        order_state:   null,
        order_postal:  null,
        _buckets:      Object.fromEntries(WIDE_COLUMNS.map((c) => [c, 0])),
      };
      groups.set(key, g);
    }

    const bucket = bucketFor(row['amount-type'], row['amount-description']);
    g._buckets[bucket] += paise;
    const deliberateOther = bucket === 'other' && (has(row['amount-type'], 'debt', 'adjustment') || has(row['amount-description'], 'debt adjustment', 'payable to amazon'));

    // `description` on the wide row should name the sale, not whichever
    // component happened to be seen first.
    if (has(row['amount-description'], 'principal')) g.description = row['amount-description'];
    if (!g.sku && row['sku']) g.sku = row['sku'];

    if (bucket === 'other' && !deliberateOther) {
      const label = `${row['amount-type'] || '(none)'} / ${row['amount-description'] || '(none)'}`;
      const u = unmapped.get(label) || { count: 0, paise: 0 };
      u.count++; u.paise += paise;
      unmapped.set(label, u);
    }
  }

  let pivotPaise = 0;
  const rows = [...groups.values()].map((g) => {
    const out = {
      settlement_id: g.settlement_id,
      date_time:     g.date_time,
      type:          g.type,
      order_id:      g.order_id,
      sku:           g.sku,
      description:   g.description,
      quantity:      g.quantity,
      marketplace:   g.marketplace,
      account_type:  g.account_type,
      fulfillment:   g.fulfillment,
      order_city:    g.order_city,
      order_state:   g.order_state,
      order_postal:  g.order_postal,
    };
    let rowPaise = 0;
    for (const c of WIDE_COLUMNS) {
      out[c] = fromPaise(g._buckets[c]);
      rowPaise += g._buckets[c];
    }
    out.total = fromPaise(rowPaise);
    pivotPaise += rowPaise;
    return out;
  });

  return {
    rows,
    settlement,
    unmapped: [...unmapped.entries()]
      .map(([label, v]) => ({ label, count: v.count, amount: fromPaise(v.paise) }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    totals: {
      ledger: fromPaise(ledgerPaise),
      pivot:  fromPaise(pivotPaise),
      settlementHeader: settlement ? settlement.total_amount : null,
    },
  };
}

/**
 * Every rupee in the ledger must land in exactly one column. If these disagree
 * the pivot dropped or duplicated something, and the result must not be stored.
 */
function verifyBalance(result) {
  const { ledger, pivot, settlementHeader } = result.totals;
  const drift = Number((pivot - ledger).toFixed(2));
  const vsHeader = settlementHeader === null || settlementHeader === undefined
    ? null
    : Number((pivot - settlementHeader).toFixed(2));
  return {
    ok: drift === 0,
    drift,
    vsHeader,                       // informational: Amazon rounds its own header
    ledger, pivot, settlementHeader,
  };
}

/* The column order a wide row is emitted in, which is the column order of the
   Settlement sheet. Exported so the Summary can address those columns by letter
   in its formulas and cannot drift out of step if a column is ever inserted. */
const ROW_COLUMNS = [
  'settlement_id', 'date_time', 'type', 'order_id', 'sku', 'description',
  'quantity', 'marketplace', 'account_type', 'fulfillment',
  'order_city', 'order_state', 'order_postal',
  ...WIDE_COLUMNS, 'total',
];

module.exports = { pivotSettlementRows, verifyBalance, bucketFor, parseAmazonDate,
                   WIDE_COLUMNS, ROW_COLUMNS, groupKey };

/**
 * One-off/rebuildable ETL: builds receivable_ledger + receivable_ledger_unmatched
 * from the raw rows already loaded into receivable_cycle_imports.
 *
 * Safe to re-run: TRUNCATEs both tables for the brand first, then rebuilds from
 * scratch. This is a batch job over historical data, not a per-upload sync — the
 * live reco upload pipeline (recoController.js) is untouched by this script.
 *
 * Usage: node scripts/buildReceivableLedger.js
 */
const { masterSequelize } = require('../src/config/database');

const BRAND_ID = '00cd57b9-25e4-4f3c-8abb-69e50a691a3d'; // Flo Mattress

const TALLY_FILE = 'Combined Tally GST report FY 24-25 - Copy.xlsx';
const TALLY_SHEET = 'Main Sheet';

const SETTLEMENT_SOURCES = [
  { source: 'ekart', file: 'combined ekart settelment report.xlsx', sheet: 'Combined' },
  { source: 'xpressbees', file: 'Xpressbees combined.xlsx', sheet: 'Combined' },
  { source: 'delhivery', file: 'combined delhivery remmittance.xlsx', sheet: 'Delhi vary 25-26' },
];

const SRN_SOURCES = [
  { file: 'Combine SRN Apr-25 to Oct-25.xlsx', sheet: 'Sheet1' },
  { file: 'Unicommerce Refunds Working FY 24-25.xlsx', sheet: 'Refunds' },
];

const CHUNK = 1000;

// ── generic helpers (mirrors reco-engine/recon/receivable_cycle.py's _clean/_to_float/_norm_code/_parse_date) ──

function clean(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return ['nan', 'nat', 'none', ''].includes(s.toLowerCase()) ? '' : s;
}

function toFloat(v) {
  const s = clean(v).replace(/,/g, '').replace(/₹/g, '');
  if (s === '' || s === '-') return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function normCode(v) {
  let s = clean(v);
  if (!s) return '';
  if (s.endsWith('.0') && /^-?\d+$/.test(s.slice(0, -2))) s = s.slice(0, -2);
  else if (/^-?\d+\.0+$/.test(s)) s = s.split('.')[0];
  return s.replace(/\s+/g, '').toUpperCase();
}

function get(row, ...aliases) {
  for (const alias of aliases) {
    const v = row[alias];
    if (v !== undefined && clean(v) !== '') return v;
  }
  return '';
}

function parseDate(v) {
  const s = clean(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function courierBucket(shippingProviderUpper) {
  if (shippingProviderUpper.includes('DELHIVERY')) return 'Delivery';
  if (shippingProviderUpper.includes('EKART')) return 'Ekart';
  if (shippingProviderUpper.includes('XPRESSB')) return 'Xpressbees';
  if (shippingProviderUpper.includes('DTDC')) return 'DTDC';
  if (shippingProviderUpper.includes('SELF')) return 'Self shipping';
  return 'Other COD';
}

// Buckets the Tally row's raw "Channel Ledger" value (33 distinct raw values seen
// in real data — many regional Amazon Flex/Flipkart warehouse variants) into the
// portal a CFO actually thinks in terms of.
function channelBucket(raw) {
  const u = (raw || '').toUpperCase();
  if (!u) return 'Unknown';
  if (u.includes('SHOPIFY')) return 'Shopify';
  if (u.includes('FLIPKART')) return 'Flipkart';
  if (u.includes('AMAZON') || u.includes('AMZ') || u.includes('FLEX')) return 'Amazon';
  if (u.includes('PEPPERFRY')) return 'Pepperfry';
  if (u.includes('ZEPTO')) return 'Zepto';
  if (u.includes('WOODENSTREET')) return 'WoodenStreet';
  if (u.includes('SNAPMINT')) return 'Snapmint';
  if (u.includes('CRED')) return 'CRED';
  if (u.includes('HUSH')) return 'Hush B2B';
  if (u.includes('INFLUENCER')) return 'Influencers';
  if (u.startsWith('CUSTOM') || u.includes('QC LAPSE')) return 'Custom / Manual';
  return 'Other';
}

async function fetchImportRows(sequelize, sourceFile, sheetName) {
  const [rows] = await sequelize.query(
    `SELECT row_data FROM receivable_cycle_imports
     WHERE brand_id = :brandId AND source_file = :sourceFile AND sheet_name = :sheetName
     ORDER BY row_index`,
    { replacements: { brandId: BRAND_ID, sourceFile: sourceFile, sheetName: sheetName } }
  );
  return rows.map((r) => r.row_data);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Step 1: load Tally Main Sheet rows into the ledger ──

async function loadTallyRows(sequelize) {
  const rows = await fetchImportRows(sequelize, TALLY_FILE, TALLY_SHEET);
  console.log(`[ledger] ${TALLY_FILE} :: ${TALLY_SHEET} -> ${rows.length} raw rows`);

  // The Main Sheet is one row per PRODUCT LINE, not per invoice/shipment — the same
  // AWB/invoice repeats once per SKU on that order, each with its own line-level
  // "Total" (confirmed against the real data: one invoice had 11 line rows summing
  // to its real invoice value). Group by key and SUM Total, or the ledger's
  // total_amount would only ever capture one line's amount, hugely undercounting
  // sales/receivables for any multi-item order.
  const groups = new Map(); // key = awb || invoice_key

  for (const row of rows) {
    const invoiceNo = clean(get(row, 'Invoice number'));
    const saleOrder = clean(get(row, 'Sale Order Number'));
    if (!invoiceNo && !saleOrder) continue;

    const awb = normCode(get(row, 'AWB num'));
    const invoiceKey = normCode(invoiceNo);
    if (!awb && !invoiceKey) continue;

    const orderDate = parseDate(get(row, 'Date'));
    if (!orderDate) continue; // can't bucket by month/year without a date

    // Same column priority orderCycleShopifyProcessor.js's Step 1 uses — Tally's own
    // dispatch/cancellation column when present, falling back to the sale date itself.
    // Feeds advance_amount_ledger's `date`/`dispatch_or_cancellation_date` (Advance
    // Amount Dashboard aging) even for brands that never get a Sales Order Combined
    // upload — matchDeliveryStatus below only ever refines this, never clears it.
    const dispatchDate = parseDate(get(row, 'Dispatch Date/Cancellation Date', 'Date', 'Dispatch Date', 'Invoice Date'));

    const paymentMethod = clean(get(row, 'Payment Method')).toUpperCase() || 'COD';
    const shippingProvider = clean(get(row, 'Shipping Provider')).toUpperCase();
    const channel = channelBucket(get(row, 'Channel Ledger'));
    const key = awb || invoiceKey;
    const lineTotal = toFloat(get(row, 'Total'));

    const existing = groups.get(key);
    if (existing) {
      existing.total_amount += lineTotal;
    } else {
      groups.set(key, {
        awb,
        invoice_key: invoiceKey,
        invoice_number: invoiceNo,
        sale_order_number: saleOrder,
        order_date: orderDate.toISOString().slice(0, 10),
        order_month: orderDate.getMonth() + 1,
        order_year: orderDate.getFullYear(),
        payment_method: paymentMethod,
        courier: paymentMethod === 'COD' ? courierBucket(shippingProvider) : '',
        channel,
        total_amount: lineTotal,
        dispatch_or_cancellation_date: dispatchDate ? dispatchDate.toISOString() : null,
      });
    }
  }

  const withAwb = [];
  const invoiceOnly = [];
  for (const e of groups.values()) (e.awb ? withAwb : invoiceOnly).push(e);

  console.log(`[ledger] grouped into ${groups.size} orders (${withAwb.length} with AWB, ${invoiceOnly.length} invoice-only)`);

  const insertBatch = async (batch, conflictCol, conflictWhere) => {
    if (!batch.length) return;
    const cols = ['brand_id', 'awb', 'invoice_key', 'invoice_number', 'sale_order_number',
      'order_date', 'order_month', 'order_year', 'payment_method', 'courier', 'channel', 'total_amount', 'source_file',
      'dispatch_or_cancellation_date'];
    const values = [];
    const params = [];
    batch.forEach((e, i) => {
      const base = i * cols.length;
      values.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`);
      params.push(BRAND_ID, e.awb, e.invoice_key, e.invoice_number, e.sale_order_number,
        e.order_date, e.order_month, e.order_year, e.payment_method, e.courier, e.channel, e.total_amount, TALLY_FILE,
        e.dispatch_or_cancellation_date);
    });
    await sequelize.query(
      `INSERT INTO receivable_ledger (${cols.join(',')}) VALUES ${values.join(',')}
       ON CONFLICT (brand_id, ${conflictCol}) WHERE ${conflictWhere} DO NOTHING`,
      { bind: params }
    );
  };

  for (const batch of chunk(withAwb, CHUNK)) await insertBatch(batch, 'awb', "awb <> ''");
  for (const batch of chunk(invoiceOnly, CHUNK)) await insertBatch(batch, 'invoice_key', "awb = '' AND invoice_key <> ''");

  // Prepaid orders are NOT auto-settled here — same rule change as
  // receivableLedgerBuilder.js's loadTallyRows: "cash collected upfront" isn't
  // "revenue earned" until the order is actually delivered. They stay
  // settled_flag = FALSE, like COD, until a delivery_status upload confirms
  // delivery via matchPrepaidDeliveries (see receivableLedgerBuilder.js) — this
  // one-off script doesn't read a delivery_status file, so Prepaid rows it
  // inserts stay unsettled until the live pipeline's own rebuild picks one up.
}

// ── Step 2: match courier settlements against the ledger ──

const SETTLEMENT_PARSERS = {
  ekart: (row) => ({
    awb: normCode(get(row, 'TRACKING_ID', 'SHIPMENT_ID')),
    amount: toFloat(get(row, 'COD_AMOUNT')),
    date: parseDate(get(row, 'DELIVERY_DATE', 'date')),
  }),
  xpressbees: (row) => ({
    awb: normCode(get(row, 'Shipping Id', 'POID')),
    amount: toFloat(get(row, 'Net Payment')),
    date: parseDate(get(row, 'Delivery Date', 'Shipping Date', 'Transaction Date', 'date')),
  }),
  delhivery: (row) => ({
    awb: normCode(get(row, 'waybill_num')),
    amount: toFloat(get(row, 'payable', 'cod_amount', 'cod')),
    date: parseDate(get(row, 'pickup_date', 'status_date')),
  }),
};

async function matchSettlements(sequelize) {
  for (const { source, file, sheet } of SETTLEMENT_SOURCES) {
    const rows = await fetchImportRows(sequelize, file, sheet);
    const parser = SETTLEMENT_PARSERS[source];
    const byAwb = new Map();
    for (const r of rows.map(parser).filter((r) => r.awb && r.date)) byAwb.set(r.awb, r); // last-wins on duplicate AWB, matches original per-job parser's dict-overwrite semantics
    const parsed = [...byAwb.values()];
    console.log(`[ledger] ${source}: ${rows.length} raw rows -> ${parsed.length} with AWB+date (deduped)`);

    let matched = 0;
    let unmatched = 0;
    for (const batch of chunk(parsed, CHUNK)) {
      const awbs = batch.map((r) => r.awb);
      const amounts = batch.map((r) => r.amount);
      const months = batch.map((r) => r.date.getMonth() + 1);
      const years = batch.map((r) => r.date.getFullYear());

      const [result] = await sequelize.query(
        `UPDATE receivable_ledger AS l
         SET settled_flag = TRUE, settled_amount = v.amount,
             settled_month = v.month, settled_year = v.year, settled_source = $5
         FROM (SELECT unnest($1::text[]) AS awb, unnest($2::numeric[]) AS amount,
                      unnest($3::int[]) AS month, unnest($4::int[]) AS year) v
         WHERE l.brand_id = $6 AND l.awb = v.awb AND l.settled_flag = FALSE
         RETURNING l.awb`,
        { bind: [awbs, amounts, months, years, source, BRAND_ID] }
      );
      const matchedAwbs = new Set(result.map((r) => r.awb));
      matched += matchedAwbs.size;

      const misses = batch.filter((r) => !matchedAwbs.has(r.awb));
      unmatched += misses.length;
      if (misses.length) {
        const cols = ['brand_id', 'match_key', 'source', 'amount', 'source_file'];
        const values = [];
        const params = [];
        misses.forEach((m, i) => {
          const base = i * cols.length;
          values.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`);
          params.push(BRAND_ID, m.awb, source, m.amount, file);
        });
        await sequelize.query(
          `INSERT INTO receivable_ledger_unmatched (${cols.join(',')}) VALUES ${values.join(',')}`,
          { bind: params }
        );
      }
    }
    console.log(`[ledger] ${source}: matched ${matched}, unmatched ${unmatched}`);
  }
}

// ── Step 3: match SRN/returns against the ledger (invoice first, AWB fallback) ──

function parseSrnRow(row) {
  const origInvoice = normCode(get(row, 'Original Invoice No', 'Original Invoice No.1'));
  const awb = normCode(get(row, 'AWB num'));
  const date = parseDate(get(row, 'Date', 'Return Date', 'Credit Note Date', 'Invoice Date'));
  const amount = toFloat(get(row, 'Total'));
  const srn = clean(get(row, 'Invoice number', 'Invoice Number', 'SRN'));
  return { origInvoice, awb, date, amount, srn };
}

async function matchSrn(sequelize) {
  for (const { file, sheet } of SRN_SOURCES) {
    const rows = await fetchImportRows(sequelize, file, sheet);
    const candidates = rows.map(parseSrnRow).filter((r) => (r.origInvoice || r.awb) && r.date);
    // Dedupe by match key (invoice preferred, AWB fallback) so no batch can ever contain
    // the same key twice — a duplicate key in one unnest() UPDATE would try to update the
    // same ledger row twice in a single statement, which Postgres rejects outright.
    const byKey = new Map();
    for (const r of candidates) byKey.set(r.origInvoice || r.awb, r);
    const parsed = [...byKey.values()];
    console.log(`[ledger] SRN ${file}: ${rows.length} raw rows -> ${parsed.length} matchable (deduped)`);

    let matched = 0;
    let unmatched = 0;
    for (const batch of chunk(parsed, CHUNK)) {
      const invoiceBatch = batch.filter((r) => r.origInvoice);
      const stillPending = new Map(batch.map((r, i) => [i, r]));

      if (invoiceBatch.length) {
        const keys = invoiceBatch.map((r) => r.origInvoice);
        const amounts = invoiceBatch.map((r) => r.amount);
        const months = invoiceBatch.map((r) => r.date.getMonth() + 1);
        const years = invoiceBatch.map((r) => r.date.getFullYear());
        const dates = invoiceBatch.map((r) => r.date.toISOString());
        const srns = invoiceBatch.map((r) => r.srn);
        const [result] = await sequelize.query(
          `UPDATE receivable_ledger AS l
           SET returned_flag = TRUE, returned_amount = v.amount, returned_month = v.month, returned_year = v.year,
               return_date = v.date, srn = NULLIF(v.srn, '')
           FROM (SELECT unnest($1::text[]) AS invoice_key, unnest($2::numeric[]) AS amount,
                        unnest($3::int[]) AS month, unnest($4::int[]) AS year,
                        unnest($6::timestamptz[]) AS date, unnest($7::text[]) AS srn) v
           WHERE l.brand_id = $5 AND l.invoice_key = v.invoice_key AND l.returned_flag = FALSE
           RETURNING l.invoice_key`,
          { bind: [keys, amounts, months, years, BRAND_ID, dates, srns] }
        );
        const matchedKeys = new Set(result.map((r) => r.invoice_key));
        matched += matchedKeys.size;
        for (const [i, r] of stillPending) {
          if (r.origInvoice && matchedKeys.has(r.origInvoice)) stillPending.delete(i);
        }
      }

      const awbBatchMap = new Map();
      for (const r of stillPending.values()) if (r.awb) awbBatchMap.set(r.awb, r); // defensive: two different invoice keys could share one AWB
      const awbBatch = [...awbBatchMap.values()];
      if (awbBatch.length) {
        const keys = awbBatch.map((r) => r.awb);
        const amounts = awbBatch.map((r) => r.amount);
        const months = awbBatch.map((r) => r.date.getMonth() + 1);
        const years = awbBatch.map((r) => r.date.getFullYear());
        const dates = awbBatch.map((r) => r.date.toISOString());
        const srns = awbBatch.map((r) => r.srn);
        const [result] = await sequelize.query(
          `UPDATE receivable_ledger AS l
           SET returned_flag = TRUE, returned_amount = v.amount, returned_month = v.month, returned_year = v.year,
               return_date = v.date, srn = NULLIF(v.srn, '')
           FROM (SELECT unnest($1::text[]) AS awb, unnest($2::numeric[]) AS amount,
                        unnest($3::int[]) AS month, unnest($4::int[]) AS year,
                        unnest($6::timestamptz[]) AS date, unnest($7::text[]) AS srn) v
           WHERE l.brand_id = $5 AND l.awb = v.awb AND l.returned_flag = FALSE
           RETURNING l.awb`,
          { bind: [keys, amounts, months, years, BRAND_ID, dates, srns] }
        );
        const matchedAwbs = new Set(result.map((r) => r.awb));
        matched += matchedAwbs.size;
        for (const [i, r] of stillPending) {
          if (r.awb && matchedAwbs.has(r.awb)) stillPending.delete(i);
        }
      }

      const misses = [...stillPending.values()];
      unmatched += misses.length;
      if (misses.length) {
        const cols = ['brand_id', 'match_key', 'source', 'amount', 'source_file'];
        const values = [];
        const params = [];
        misses.forEach((m, i) => {
          const base = i * cols.length;
          values.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`);
          params.push(BRAND_ID, m.origInvoice || m.awb, 'srn', m.amount, file);
        });
        await sequelize.query(
          `INSERT INTO receivable_ledger_unmatched (${cols.join(',')}) VALUES ${values.join(',')}`,
          { bind: params }
        );
      }
    }
    console.log(`[ledger] SRN ${file}: matched ${matched}, unmatched ${unmatched}`);
  }
}

// ── Step 4: match delivery status from the Sales Order Combined report ──
//
// Sourced from the raw Unicommerce export (ingested by scripts/ingestPrepaidFiles.js,
// projected down to { 'Order No': Display Order Code, 'Fulfillment Status': Sale
// Order Item Status, 'Dispatch Date': Dispatch Date }). Display Order Code is the
// same numeric format as Tally's own Sale Order Number. Scoped to Shopify Prepaid
// only — this is what lets advance_amount_ledger tell "gateway paid, not yet
// delivered" (Advance) apart from "gateway paid, delivered" (earned) on the same
// table; COD orders already have their own settle signal (courier remittance) and
// don't need a delivery_status at all.
const DELIVERY_STATUS_FILE = '1. Sales Order combined Fy 24-25.xlsx';
const DELIVERY_STATUS_SHEET = 'Sheet1';

function excelSerialToDate(n) {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + n * 86400000);
}

// Handles every date shape actually seen across these 3 files: Excel serials
// (Snapmint's Merchant Settlement Date, Sales Order Combined's Dispatch Date), and
// DD-MM-YYYY / DD/MM/YYYY text (Razorpay's settled_at/created_at) — the generic
// `parseDate()` above (plain `new Date(string)`) silently mis-parses DD-MM-YYYY as
// month-first, which would put every Razorpay date in the wrong month.
function parseFlexibleDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return excelSerialToDate(v);
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) {
    const [, d, mo, y] = m;
    const dt = new Date(Date.UTC(parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10)));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return parseDate(v);
}

// Collapses a raw delivery-status string to a single yes/no ("was this actually
// delivered") — mirrors receivableLedgerBuilder.js's isDeliveredStatus. Only an
// actual DELIVERED settles the receivable below; DISPATCHED/CANCELLED still get
// their delivery_status/dispatch date recorded (so the Advance dashboard correctly
// drops them, resolved either way) but don't flip settled_flag.
function isDeliveredStatus(raw) {
  const upper = clean(raw).toUpperCase().replace(/[-_\s]/g, '');
  return ['DELIVERED', 'DLDELIVERED', 'SHIPMENTDELIVERED', 'FULFILLED'].includes(upper);
}

// Also settles the receivable itself here (settled_flag/settled_amount/settled_month/
// settled_year) the moment status is actually DELIVERED — cash collected upfront
// isn't revenue earned until the order is actually delivered, same rule
// receivableLedgerBuilder.js's matchPrepaidDeliveries applies to generic marketplace
// Prepaid. settled_source/settled_amount/settled_date are left for
// matchGatewaySettlements (below, runs after this) to fill in separately with the
// real gateway facts; this only sets settled_flag + which MONTH to credit it to, from
// the delivery date, so a Shopify Prepaid order settles on its own delivery month
// regardless of which month the gateway cash actually landed in.
async function matchDeliveryStatus(sequelize) {
  const rows = await fetchImportRows(sequelize, DELIVERY_STATUS_FILE, DELIVERY_STATUS_SHEET);
  console.log(`[ledger] delivery status ${DELIVERY_STATUS_FILE}: ${rows.length} raw rows`);

  const byOrder = new Map(); // last-wins per order across its multiple line rows
  for (const row of rows) {
    const orderNo = clean(row['Order No']);
    if (!orderNo) continue;
    const status = clean(row['Fulfillment Status']).toUpperCase();
    const dispatchDate = parseFlexibleDate(row['Dispatch Date']);
    byOrder.set(orderNo, { status, dispatchDate });
  }
  const parsed = [...byOrder.entries()].map(([orderNo, v]) => ({ orderNo, ...v }));
  console.log(`[ledger] delivery status: ${parsed.length} distinct orders`);

  let matched = 0;
  let settled = 0;
  for (const batch of chunk(parsed, CHUNK)) {
    const orderNos = batch.map((r) => r.orderNo);
    const statuses = batch.map((r) => r.status);
    const dates = batch.map((r) => (r.dispatchDate ? r.dispatchDate.toISOString() : null));
    // Only settle when we actually know which month to credit it to.
    const delivered = batch.map((r) => isDeliveredStatus(r.status) && !!r.dispatchDate);
    const months = batch.map((r) => (r.dispatchDate ? r.dispatchDate.getMonth() + 1 : null));
    const years = batch.map((r) => (r.dispatchDate ? r.dispatchDate.getFullYear() : null));
    const [result] = await sequelize.query(
      `UPDATE receivable_ledger AS l
       SET delivery_status = NULLIF(v.status, ''),
           dispatch_or_cancellation_date = COALESCE(l.dispatch_or_cancellation_date, v.date),
           settled_flag = CASE WHEN v.delivered THEN TRUE ELSE l.settled_flag END,
           settled_amount = CASE WHEN v.delivered THEN l.total_amount ELSE l.settled_amount END,
           settled_month = CASE WHEN v.delivered THEN v.month ELSE l.settled_month END,
           settled_year = CASE WHEN v.delivered THEN v.year ELSE l.settled_year END
       FROM (SELECT unnest($1::text[]) AS order_no, unnest($2::text[]) AS status,
                    unnest($3::timestamptz[]) AS date, unnest($4::bool[]) AS delivered,
                    unnest($5::int[]) AS month, unnest($6::int[]) AS year) v
       WHERE l.brand_id = $7 AND l.sale_order_number = v.order_no
         AND l.payment_method = 'PREPAID' AND l.channel = 'Shopify'
       RETURNING l.id, v.delivered`,
      { bind: [orderNos, statuses, dates, delivered, months, years, BRAND_ID] }
    );
    matched += result.length;
    settled += result.filter((r) => r.delivered).length;
  }
  console.log(`[ledger] delivery status: updated ${matched} ledger rows (${settled} settled via delivery)`);
}

// ── Step 5: real Snapmint/Razorpay gateway settlements onto Shopify Prepaid rows ──
//
// Shopify Prepaid rows are NOT skipped by loadTallyRows above (unlike
// receivableLedgerBuilder.js's generic role-based path) specifically so this
// brand's real gateway settlement facts can live on this ledger instead of the
// separate (fake-data) shopify_order_cycle table — see the plan doc. Same
// amount-correspondence philosophy orderCycleShopifyProcessor.js's
// assignGatewayCandidates already established as vetted: Sale Order Number is
// reused across unrelated transactions over time, so an order-number match alone
// isn't trustworthy — the gateway's own gross order value must also correspond to
// the specific invoice it's being attributed to.
const GATEWAY_FILES = {
  snapmint: { file: 'Combine MSDR Snapmint FY 24-25.xlsx', sheet: 'Working' },
  razorpay: { file: 'Razorpay 24-25 Combined Report.xlsx', sheet: 'Sheet1' },
};

function amountsCorrespond(orderValue, invoiceAmount) {
  if (!orderValue || !invoiceAmount) return false;
  return Math.abs(orderValue - invoiceAmount) <= Math.max(5, invoiceAmount * 0.02);
}

// Deliberately only ever writes settled_amount/settled_date/settled_source — pure
// "which gateway, how much, when the cash arrived" facts, read by advance_amount_ledger.
// settled_flag/settled_month/settled_year belong entirely to matchDeliveryStatus above
// (settle on DELIVERY, not on cash receipt) — this runs against settled_source IS NULL
// (no gateway match recorded yet) instead of settled_flag = FALSE, so it can run
// whether or not the order has already settled via delivery. Runs AFTER
// matchDeliveryStatus so its own settled_amount (the real gateway figure) overwrites
// that function's total_amount fallback when a gateway match exists.
async function matchGatewaySettlements(sequelize) {
  const [candidateRows] = await sequelize.query(
    `SELECT id, sale_order_number, total_amount, dispatch_or_cancellation_date
     FROM receivable_ledger
     WHERE brand_id = $1 AND payment_method = 'PREPAID' AND channel = 'Shopify' AND settled_source IS NULL`,
    { bind: [BRAND_ID] }
  );
  console.log(`[ledger] gateway settlements: ${candidateRows.length} unsettled Shopify Prepaid rows to match against`);

  const byOrder = new Map();
  for (const row of candidateRows) {
    const key = clean(row.sale_order_number);
    if (!key) continue;
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push({
      id: row.id,
      sales_amount: parseFloat(row.total_amount) || 0,
      dispatch_date: row.dispatch_or_cancellation_date ? new Date(row.dispatch_or_cancellation_date) : null,
    });
  }

  // Snapmint: "Final Order Number" (91.9%-verified bridge against real Tally Sale
  // Order Numbers, checked this session) -> one candidate per Snapmint ledger row
  // (settlement, cancellation, partial cancellation...), each carrying that row's
  // own "Order value" as BOTH the correspondence-check value and the attributed
  // amount — "Order value" (not "Settlement Value") is what buildSnapmintLookup in
  // orderCycleShopifyProcessor.js already established as the reliable field.
  const snapmintRows = await fetchImportRows(sequelize, GATEWAY_FILES.snapmint.file, GATEWAY_FILES.snapmint.sheet);
  const snapmintLookup = new Map();
  for (const row of snapmintRows) {
    const orderNo = clean(row['Final Order Number']);
    if (!orderNo) continue;
    const orderValue = toFloat(row['Order value']);
    const settlementDate = parseFlexibleDate(row['Merchant Settlement Date']);
    if (!snapmintLookup.has(orderNo)) snapmintLookup.set(orderNo, []);
    snapmintLookup.get(orderNo).push({ order_value: orderValue, settlement_date: settlementDate, settlement_amount: orderValue });
  }

  const updates = []; // { id, amount, date, source }
  let snapMatched = 0, snapIssues = 0;
  for (const [orderNo, rowsForOrder] of byOrder.entries()) {
    const candidates = snapmintLookup.get(orderNo);
    if (!candidates || !candidates.length) continue;
    const claimed = new Set();
    for (const candidate of candidates) {
      const match = rowsForOrder.find((r) => !claimed.has(r) && amountsCorrespond(candidate.order_value, r.sales_amount));
      if (match) {
        claimed.add(match);
        updates.push({ id: match.id, amount: candidate.settlement_amount, date: candidate.settlement_date, source: 'snapmint' });
        snapMatched++;
      } else {
        snapIssues++;
      }
    }
  }
  console.log(`[ledger] snapmint: ${snapMatched} rows matched, ${snapIssues} candidate settlements with no amount-corresponding row`);

  // Razorpay: best-effort amount + dispatch-date-proximity match (approved
  // fallback — the processor's designed bridge, Razorpay.order_receipt -> Sales
  // Order Combined's "Payment References" column, doesn't exist in any file we have;
  // confirmed against the real 285,742-row Unicommerce export). Only claims a
  // payment when it has EXACTLY ONE surviving candidate — no order-number check
  // backs this up (unlike Snapmint), so ambiguous cases are left unmatched rather
  // than guessed at. Verified on this data: resolves ~0.15% of candidates
  // (158/107,477) — noisy, but real rupees, not fabricated. User-approved tradeoff.
  const RAZORPAY_DATE_WINDOW_MS = 10 * 24 * 3600 * 1000;
  const razorpayRows = await fetchImportRows(sequelize, GATEWAY_FILES.razorpay.file, GATEWAY_FILES.razorpay.sheet);
  const payments = razorpayRows
    .filter((r) => { const t = clean(r.type).toLowerCase(); return !t || t === 'payment'; })
    .map((r) => ({ credit: toFloat(r.credit), date: parseFlexibleDate(r.settled_at) }))
    .filter((p) => p.credit > 0 && p.date);
  console.log(`[ledger] razorpay: ${payments.length} settled payment rows`);

  const alreadyClaimedIds = new Set(updates.map((u) => u.id));
  const rzpCandidates = [...byOrder.values()].flat()
    .filter((r) => !alreadyClaimedIds.has(r.id) && r.dispatch_date && r.sales_amount > 0);
  const rzpClaimed = new Set();
  let rzpMatched = 0, rzpAmbiguous = 0, rzpNoCandidate = 0;
  for (const payment of payments) {
    const matches = rzpCandidates.filter((r) =>
      !rzpClaimed.has(r) &&
      Math.abs(r.dispatch_date.getTime() - payment.date.getTime()) <= RAZORPAY_DATE_WINDOW_MS &&
      amountsCorrespond(payment.credit, r.sales_amount)
    );
    if (matches.length === 1) {
      rzpClaimed.add(matches[0]);
      updates.push({ id: matches[0].id, amount: payment.credit, date: payment.date, source: 'razorpay' });
      rzpMatched++;
    } else if (matches.length > 1) rzpAmbiguous++;
    else rzpNoCandidate++;
  }
  console.log(`[ledger] razorpay best-effort match: ${rzpMatched} matched, ${rzpAmbiguous} ambiguous (skipped), ${rzpNoCandidate} no candidate`);

  let written = 0;
  for (const batch of chunk(updates, CHUNK)) {
    const ids = batch.map((u) => u.id);
    const amounts = batch.map((u) => u.amount);
    const dates = batch.map((u) => (u.date ? u.date.toISOString() : null));
    const sources = batch.map((u) => u.source);
    const [result] = await sequelize.query(
      `UPDATE receivable_ledger AS l
       SET settled_amount = v.amount, settled_date = v.date, settled_source = v.source
       FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::numeric[]) AS amount,
                    unnest($3::timestamptz[]) AS date, unnest($4::text[]) AS source) v
       WHERE l.id = v.id
       RETURNING l.id`,
      { bind: [ids, amounts, dates, sources] }
    );
    written += result.length;
  }
  console.log(`[ledger] gateway settlements: wrote ${written} rows (snapmint ${snapMatched}, razorpay ${rzpMatched})`);
}

async function main() {
  const sequelize = masterSequelize;
  await sequelize.query(`DELETE FROM receivable_ledger_unmatched WHERE brand_id = :brandId`, { replacements: { brandId: BRAND_ID } });
  await sequelize.query(`DELETE FROM receivable_ledger WHERE brand_id = :brandId`, { replacements: { brandId: BRAND_ID } });
  console.log('[ledger] cleared existing ledger rows for brand, rebuilding...');

  await loadTallyRows(sequelize);
  await matchSettlements(sequelize);
  await matchDeliveryStatus(sequelize);
  await matchGatewaySettlements(sequelize);
  await matchSrn(sequelize);

  const [[{ count }]] = await sequelize.query(
    `SELECT count(*) FROM receivable_ledger WHERE brand_id = :brandId`,
    { replacements: { brandId: BRAND_ID } }
  );
  const [[{ count: unmatchedCount }]] = await sequelize.query(
    `SELECT count(*) FROM receivable_ledger_unmatched WHERE brand_id = :brandId`,
    { replacements: { brandId: BRAND_ID } }
  );
  console.log(`[ledger] DONE. ledger rows: ${count}, unmatched rows: ${unmatchedCount}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[ledger] FAILED', err);
  process.exit(1);
});

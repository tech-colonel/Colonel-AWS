/**
 * Brand-generic Receivable Cycle ledger builder.
 *
 * receivable_cycle_imports holds raw rows (one JSON row per Excel row) tagged with a
 * `role` — 'tally' | 'delhivery' | 'ekart' | 'xpressbees' | 'srn' | 'delivery_status' —
 * instead of being matched by hardcoded filename/sheet name, so this works for any brand's uploads,
 * not just the one historical Flo Mattress dataset. Same transform rules as the
 * original one-off script (new-backend/scripts/buildReceivableLedger.js), just
 * parametrized by brand_id and sourced by role instead of by literal file/sheet name.
 *
 * Safe to re-run: rebuildReceivableLedgerForBrand clears the ledger for the brand
 * first, then rebuilds from scratch from whatever import rows currently exist.
 */

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

function excelSerialToDate(n) {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + n * 86400000);
}

function parseDate(v) {
  if (typeof v === 'number') return excelSerialToDate(v);
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

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const CHUNK = 1000;

// role -> settlement source name used in settled_source / receivable_ledger_unmatched.source
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

async function fetchImportRows(sequelize, brandId, role) {
  const [rows] = await sequelize.query(
    `SELECT row_data FROM receivable_cycle_imports
     WHERE brand_id = :brandId AND role = :role
     ORDER BY source_file, row_index`,
    { replacements: { brandId, role } }
  );
  return rows.map((r) => r.row_data);
}

async function loadTallyRows(sequelize, brandId) {
  const rows = await fetchImportRows(sequelize, brandId, 'tally');

  // The Main Sheet is one row per PRODUCT LINE, not per invoice/shipment — group by
  // key (awb || invoice_key) and SUM Total, or total_amount would only ever capture
  // one line's amount for any multi-item order.
  const groups = new Map();

  for (const row of rows) {
    const invoiceNo = clean(get(row, 'Invoice number'));
    const saleOrder = clean(get(row, 'Sale Order Number'));
    if (!invoiceNo && !saleOrder) continue;

    const awb = normCode(get(row, 'AWB num'));
    const invoiceKey = normCode(invoiceNo);
    if (!awb && !invoiceKey) continue;

    const orderDate = parseDate(get(row, 'Date'));
    if (!orderDate) continue;

    const paymentMethod = clean(get(row, 'Payment Method')).toUpperCase() || 'COD';
    const shippingProvider = clean(get(row, 'Shipping Provider')).toUpperCase();
    const channel = channelBucket(get(row, 'Channel Ledger'));

    // Shopify Prepaid orders used to be skipped here so shopify_order_cycle stayed
    // the single source of truth for that population — that table turned out to
    // hold fabricated test data (see db-restructure/024). Shopify Prepaid now flows
    // through this same ledger instead, gaining a real delivery lifecycle
    // (dispatch/delivery/return dates below, matchDeliveryStatus) and real gateway
    // settlement facts (matchGatewaySettlements) via the existing settled_flag/
    // settled_amount/settled_source columns — the Advance Amount + Payables
    // dashboards now read this ledger through the advance_amount_ledger view
    // instead of shopify_order_cycle.
    const dispatchDate = parseDate(get(row, 'Dispatch Date/Cancellation Date', 'Date', 'Dispatch Date', 'Invoice Date'));

    const key = awb || invoiceKey;
    const lineTotal = toFloat(get(row, 'Total'));

    const existing = groups.get(key);
    if (existing) {
      existing.total_amount += lineTotal;
    } else {
      groups.set(key, {
        awb, invoice_key: invoiceKey, invoice_number: invoiceNo, sale_order_number: saleOrder,
        order_date: orderDate.toISOString().slice(0, 10),
        order_month: orderDate.getUTCMonth() + 1, order_year: orderDate.getUTCFullYear(),
        payment_method: paymentMethod,
        courier: paymentMethod === 'COD' ? courierBucket(shippingProvider) : '',
        channel, total_amount: lineTotal, source_file: 'receivable_cycle upload',
        dispatch_or_cancellation_date: dispatchDate ? dispatchDate.toISOString() : null,
      });
    }
  }

  const withAwb = [];
  const invoiceOnly = [];
  for (const e of groups.values()) (e.awb ? withAwb : invoiceOnly).push(e);

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
      params.push(brandId, e.awb, e.invoice_key, e.invoice_number, e.sale_order_number,
        e.order_date, e.order_month, e.order_year, e.payment_method, e.courier, e.channel, e.total_amount, e.source_file,
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

  // Prepaid orders are NOT auto-settled here (they used to be, same month as the sale —
  // that conflated "cash collected upfront" with "revenue earned", which isn't true
  // until the order is actually delivered; a cancelled/RTO Prepaid order never earns
  // that revenue). They now stay settled_flag = FALSE, exactly like COD, until
  // matchPrepaidDeliveries (below) confirms delivery from an uploaded delivery_status
  // file — mirrors how the Advance Amount Dashboard now treats Shopify Prepaid (see
  // dashboardController.js's advanceOutstandingAsOf comment). Without a delivery_status
  // upload, a brand's marketplace Prepaid orders simply stay unsettled on the
  // Receivable Dashboard — that's a real, visible behavior change, not a bug.
  return groups.size;
}

async function matchSettlements(sequelize, brandId) {
  const summary = {};
  for (const source of Object.keys(SETTLEMENT_PARSERS)) {
    const rows = await fetchImportRows(sequelize, brandId, source);
    const parser = SETTLEMENT_PARSERS[source];
    const byAwb = new Map();
    for (const r of rows.map(parser).filter((r) => r.awb && r.date)) byAwb.set(r.awb, r); // last-wins on duplicate AWB
    const parsed = [...byAwb.values()];

    let matched = 0;
    let unmatched = 0;
    for (const batch of chunk(parsed, CHUNK)) {
      const awbs = batch.map((r) => r.awb);
      const amounts = batch.map((r) => r.amount);
      const months = batch.map((r) => r.date.getUTCMonth() + 1);
      const years = batch.map((r) => r.date.getUTCFullYear());

      const [result] = await sequelize.query(
        `UPDATE receivable_ledger AS l
         SET settled_flag = TRUE, settled_amount = v.amount,
             settled_month = v.month, settled_year = v.year, settled_source = $5
         FROM (SELECT unnest($1::text[]) AS awb, unnest($2::numeric[]) AS amount,
                      unnest($3::int[]) AS month, unnest($4::int[]) AS year) v
         WHERE l.brand_id = $6 AND l.awb = v.awb AND l.settled_flag = FALSE
         RETURNING l.awb`,
        { bind: [awbs, amounts, months, years, source, brandId] }
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
          params.push(brandId, m.awb, source, m.amount, 'receivable_cycle upload');
        });
        await sequelize.query(
          `INSERT INTO receivable_ledger_unmatched (${cols.join(',')}) VALUES ${values.join(',')}`,
          { bind: params }
        );
      }
    }
    summary[source] = { raw: rows.length, deduped: parsed.length, matched, unmatched };
  }
  return summary;
}

// Normalizes a raw delivery-status string the same way orderCycleShopifyProcessor.js's
// normalizeDeliveryStatus does, but collapsed to a single yes/no ("was this actually
// delivered") since that's all matchPrepaidDeliveries needs — the settle trigger for a
// Prepaid order, not a full lifecycle stage.
function isDeliveredStatus(raw) {
  const upper = clean(raw).toUpperCase().replace(/[-_\s]/g, '');
  return ['DELIVERED', 'DLDELIVERED', 'SHIPMENTDELIVERED', 'FULFILLED'].includes(upper);
}

function parseDeliveryStatusRow(row) {
  return {
    awb: normCode(get(row, 'AWB', 'AWB Number', 'AWB num', 'Tracking ID', 'Waybill Number', 'waybill_num')),
    date: parseDate(get(row, 'Delivery Date', 'Delivered Date', 'Status Date', 'date')),
    delivered: isDeliveredStatus(get(row, 'Delivery Status', 'Status', 'Shipment Status')),
  };
}

// Settles marketplace Prepaid orders (Amazon/Flipkart/Myntra/etc — Shopify Prepaid is
// skipped at load time, see loadTallyRows) once a delivery_status upload confirms
// delivery — Prepaid no longer auto-settles same-month as the sale (see loadTallyRows'
// comment). Only touches payment_method = 'PREPAID' rows; COD settlement already comes
// from matchSettlements above, so this can't double-settle a COD order even though both
// functions match by AWB. settled_amount comes from the ledger row's OWN total_amount
// (not from the delivery file, which has no monetary column — it only confirms an
// event), unlike matchSettlements where the settlement file carries the real amount.
async function matchPrepaidDeliveries(sequelize, brandId) {
  const rows = await fetchImportRows(sequelize, brandId, 'delivery_status');
  const byAwb = new Map();
  for (const r of rows.map(parseDeliveryStatusRow).filter((r) => r.awb && r.date && r.delivered)) {
    byAwb.set(r.awb, r); // last-wins on duplicate AWB
  }
  const parsed = [...byAwb.values()];

  let matched = 0;
  let unmatched = 0;
  for (const batch of chunk(parsed, CHUNK)) {
    const awbs = batch.map((r) => r.awb);
    const months = batch.map((r) => r.date.getUTCMonth() + 1);
    const years = batch.map((r) => r.date.getUTCFullYear());

    const [result] = await sequelize.query(
      `UPDATE receivable_ledger AS l
       SET settled_flag = TRUE, settled_amount = l.total_amount,
           settled_month = v.month, settled_year = v.year, settled_source = 'delivered'
       FROM (SELECT unnest($1::text[]) AS awb, unnest($2::int[]) AS month, unnest($3::int[]) AS year) v
       WHERE l.brand_id = $4 AND l.awb = v.awb AND l.payment_method = 'PREPAID' AND l.settled_flag = FALSE
       RETURNING l.awb`,
      { bind: [awbs, months, years, brandId] }
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
        params.push(brandId, m.awb, 'delivery_status', null, 'receivable_cycle upload');
      });
      await sequelize.query(
        `INSERT INTO receivable_ledger_unmatched (${cols.join(',')}) VALUES ${values.join(',')}`,
        { bind: params }
      );
    }
  }
  return { raw: rows.length, deduped: parsed.length, matched, unmatched };
}

function parseSrnRow(row) {
  const origInvoice = normCode(get(row, 'Original Invoice No', 'Original Invoice No.1'));
  const awb = normCode(get(row, 'AWB num'));
  const date = parseDate(get(row, 'Date', 'Return Date', 'Credit Note Date', 'Invoice Date'));
  const amount = toFloat(get(row, 'Total'));
  const srn = clean(get(row, 'Invoice number', 'Invoice Number', 'SRN'));
  return { origInvoice, awb, date, amount, srn };
}

async function matchSrn(sequelize, brandId) {
  const rows = await fetchImportRows(sequelize, brandId, 'srn');
  const candidates = rows.map(parseSrnRow).filter((r) => (r.origInvoice || r.awb) && r.date);
  const byKey = new Map();
  for (const r of candidates) byKey.set(r.origInvoice || r.awb, r);
  const parsed = [...byKey.values()];

  let matched = 0;
  let unmatched = 0;
  for (const batch of chunk(parsed, CHUNK)) {
    const invoiceBatch = batch.filter((r) => r.origInvoice);
    const stillPending = new Map(batch.map((r, i) => [i, r]));

    if (invoiceBatch.length) {
      const keys = invoiceBatch.map((r) => r.origInvoice);
      const amounts = invoiceBatch.map((r) => r.amount);
      const months = invoiceBatch.map((r) => r.date.getUTCMonth() + 1);
      const years = invoiceBatch.map((r) => r.date.getUTCFullYear());
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
        { bind: [keys, amounts, months, years, brandId, dates, srns] }
      );
      const matchedKeys = new Set(result.map((r) => r.invoice_key));
      matched += matchedKeys.size;
      for (const [i, r] of stillPending) {
        if (r.origInvoice && matchedKeys.has(r.origInvoice)) stillPending.delete(i);
      }
    }

    const awbBatchMap = new Map();
    for (const r of stillPending.values()) if (r.awb) awbBatchMap.set(r.awb, r);
    const awbBatch = [...awbBatchMap.values()];
    if (awbBatch.length) {
      const keys = awbBatch.map((r) => r.awb);
      const amounts = awbBatch.map((r) => r.amount);
      const months = awbBatch.map((r) => r.date.getUTCMonth() + 1);
      const years = awbBatch.map((r) => r.date.getUTCFullYear());
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
        { bind: [keys, amounts, months, years, brandId, dates, srns] }
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
        params.push(brandId, m.origInvoice || m.awb, 'srn', m.amount, 'receivable_cycle upload');
      });
      await sequelize.query(
        `INSERT INTO receivable_ledger_unmatched (${cols.join(',')}) VALUES ${values.join(',')}`,
        { bind: params }
      );
    }
  }
  return { raw: rows.length, matchable: parsed.length, matched, unmatched };
}

// Handles every date shape actually seen across the delivery-status/gateway files:
// Excel serials (already handled by parseDate() above) and DD-MM-YYYY / DD/MM/YYYY
// text (Razorpay's settled_at/created_at) — parseDate()'s plain `new Date(string)`
// fallback silently mis-parses DD-MM-YYYY as month-first, which would put every
// Razorpay date in the wrong month.
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

// Delivery status for Shopify Prepaid orders, sourced from a 'so_status' role file
// (Sales Order Combined report, projected at ingest time to { 'Order No', 'Fulfillment
// Status', 'Dispatch Date' }) — same shape as scripts/ingestPrepaidFiles.js produces.
// This is what lets advance_amount_ledger tell "gateway paid, not yet delivered"
// (Advance) apart from "gateway paid, delivered" (earned) on the same ledger row.
//
// Also settles the receivable itself here (settled_flag/settled_amount/settled_month/
// settled_year) the moment status is actually DELIVERED — not dispatched, not
// cancelled — mirroring matchPrepaidDeliveries' rule for generic marketplace Prepaid
// (cash collected upfront isn't revenue earned until the order is actually delivered).
// settled_source/settled_amount/settled_date are deliberately left for
// matchGatewaySettlements (below) to fill in separately with the real gateway facts —
// this only sets settled_flag + which MONTH to credit it to, from the delivery date,
// so a Shopify Prepaid order settles on its own delivery month regardless of which
// month the gateway cash happened to land in. settled_amount falls back to the
// ledger's own total_amount here; matchGatewaySettlements overwrites it with the real
// gateway figure when a gateway match exists (it runs after this, unconditionally).
async function matchDeliveryStatus(sequelize, brandId) {
  const rows = await fetchImportRows(sequelize, brandId, 'so_status');
  const byOrder = new Map(); // last-wins per order across its multiple line rows
  for (const row of rows) {
    const orderNo = clean(row['Order No']);
    if (!orderNo) continue;
    const status = clean(row['Fulfillment Status']).toUpperCase();
    const dispatchDate = parseFlexibleDate(row['Dispatch Date']);
    byOrder.set(orderNo, { status, dispatchDate });
  }
  const parsed = [...byOrder.entries()].map(([orderNo, v]) => ({ orderNo, ...v }));

  let matched = 0;
  let settled = 0;
  for (const batch of chunk(parsed, CHUNK)) {
    const orderNos = batch.map((r) => r.orderNo);
    const statuses = batch.map((r) => r.status);
    const dates = batch.map((r) => (r.dispatchDate ? r.dispatchDate.toISOString() : null));
    // Only settle when we actually know which month to credit it to — a DELIVERED
    // status with no parseable date leaves settled_flag alone rather than settling
    // into a null month (which SETTLED_ASOF would then never match anyway).
    const delivered = batch.map((r) => isDeliveredStatus(r.status) && !!r.dispatchDate);
    const months = batch.map((r) => (r.dispatchDate ? r.dispatchDate.getUTCMonth() + 1 : null));
    const years = batch.map((r) => (r.dispatchDate ? r.dispatchDate.getUTCFullYear() : null));
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
      { bind: [orderNos, statuses, dates, delivered, months, years, brandId] }
    );
    matched += result.length;
    settled += result.filter((r) => r.delivered).length;
  }
  return { raw: rows.length, distinctOrders: parsed.length, matched, settled };
}

function amountsCorrespond(orderValue, invoiceAmount) {
  if (!orderValue || !invoiceAmount) return false;
  return Math.abs(orderValue - invoiceAmount) <= Math.max(5, invoiceAmount * 0.02);
}

// Real Snapmint/Razorpay gateway settlements onto Shopify Prepaid rows — same
// amount-correspondence philosophy orderCycleShopifyProcessor.js's
// assignGatewayCandidates already established as vetted (Sale Order Number is
// reused across unrelated transactions over time, so an order-number match alone
// isn't trustworthy on its own). 'snapmint' role rows are expected in the raw
// export shape (Working sheet: 'Final Order Number', 'Order value', 'Merchant
// Settlement Date'); 'razorpay' role rows in the raw Razorpay settlement export
// shape ('type', 'credit', 'settled_at'). 'bharatx' has no source file yet — wired
// the same way, will simply match nothing until one exists.
//
// Deliberately only ever writes settled_amount/settled_date/settled_source — pure
// "which gateway, how much, when the cash arrived" facts, read by advance_amount_ledger.
// settled_flag/settled_month/settled_year are NOT touched here — those now belong
// entirely to matchDeliveryStatus (settle on DELIVERY, not on cash receipt), so this
// function runs against settled_source IS NULL (no gateway match recorded yet)
// instead of settled_flag = FALSE, and can run whether or not the order has already
// settled via delivery. Runs AFTER matchDeliveryStatus so its own settled_amount
// (the real gateway figure) overwrites that function's total_amount fallback when a
// gateway match exists.
async function matchGatewaySettlements(sequelize, brandId) {
  const [candidateRows] = await sequelize.query(
    `SELECT id, sale_order_number, total_amount, dispatch_or_cancellation_date
     FROM receivable_ledger
     WHERE brand_id = $1 AND payment_method = 'PREPAID' AND channel = 'Shopify' AND settled_source IS NULL`,
    { bind: [brandId] }
  );

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

  const updates = []; // { id, amount, date, source }
  let snapMatched = 0;

  // Snapmint: "Final Order Number" -> one candidate per Snapmint ledger row
  // (settlement, cancellation, partial cancellation...), each carrying that row's
  // own "Order value" as BOTH the correspondence-check value and the attributed
  // amount — "Order value" (not "Settlement Value") is what buildSnapmintLookup in
  // orderCycleShopifyProcessor.js already established as the reliable field.
  const snapmintRows = await fetchImportRows(sequelize, brandId, 'snapmint');
  const snapmintLookup = new Map();
  for (const row of snapmintRows) {
    const orderNo = clean(row['Final Order Number']);
    if (!orderNo) continue;
    const orderValue = toFloat(row['Order value']);
    const settlementDate = parseFlexibleDate(row['Merchant Settlement Date']);
    if (!snapmintLookup.has(orderNo)) snapmintLookup.set(orderNo, []);
    snapmintLookup.get(orderNo).push({ order_value: orderValue, settlement_date: settlementDate, settlement_amount: orderValue });
  }
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
      }
    }
  }

  // Razorpay: best-effort amount + dispatch-date-proximity match — no order-number
  // bridge exists (Razorpay's order_receipt -> a "Payment References" column that
  // doesn't exist in any Sales Order export checked against this data), so this
  // only claims a payment when it has EXACTLY ONE surviving candidate; ambiguous
  // cases are left unmatched rather than guessed at. Noisy by nature (verified on
  // real data: resolves a small fraction of candidates) — real rupees, not
  // fabricated, but not a complete picture either.
  const RAZORPAY_DATE_WINDOW_MS = 10 * 24 * 3600 * 1000;
  const razorpayRows = await fetchImportRows(sequelize, brandId, 'razorpay');
  const payments = razorpayRows
    .filter((r) => { const t = clean(r.type).toLowerCase(); return !t || t === 'payment'; })
    .map((r) => ({ credit: toFloat(r.credit), date: parseFlexibleDate(r.settled_at) }))
    .filter((p) => p.credit > 0 && p.date);

  const alreadyClaimedIds = new Set(updates.map((u) => u.id));
  const rzpCandidates = [...byOrder.values()].flat()
    .filter((r) => !alreadyClaimedIds.has(r.id) && r.dispatch_date && r.sales_amount > 0);
  const rzpClaimed = new Set();
  let rzpMatched = 0;
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
    }
  }

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
  return { candidateRows: candidateRows.length, snapMatched, rzpPayments: payments.length, rzpMatched, written };
}

/**
 * Rebuilds receivable_ledger + receivable_ledger_unmatched for ONE brand from
 * whatever role-tagged rows currently exist in receivable_cycle_imports. Clears
 * that brand's ledger first — safe to call repeatedly as more files get uploaded.
 */
async function rebuildReceivableLedgerForBrand(sequelize, brandId) {
  await sequelize.query(`DELETE FROM receivable_ledger_unmatched WHERE brand_id = :brandId`, { replacements: { brandId } });
  await sequelize.query(`DELETE FROM receivable_ledger WHERE brand_id = :brandId`, { replacements: { brandId } });

  const orderCount = await loadTallyRows(sequelize, brandId);
  const settlementSummary = await matchSettlements(sequelize, brandId);
  const prepaidDeliverySummary = await matchPrepaidDeliveries(sequelize, brandId);
  const deliveryStatusSummary = await matchDeliveryStatus(sequelize, brandId);
  const gatewaySettlementSummary = await matchGatewaySettlements(sequelize, brandId);
  const srnSummary = await matchSrn(sequelize, brandId);

  const [[{ count }]] = await sequelize.query(
    `SELECT count(*) FROM receivable_ledger WHERE brand_id = :brandId`,
    { replacements: { brandId } }
  );
  return {
    orderCount, ledgerRows: parseInt(count, 10), settlementSummary, prepaidDeliverySummary,
    deliveryStatusSummary, gatewaySettlementSummary, srnSummary,
  };
}

module.exports = {
  rebuildReceivableLedgerForBrand,
  // exported for the CLI script + tests
  clean, toFloat, normCode, get, parseDate, courierBucket, channelBucket,
};

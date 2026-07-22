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
      'order_date', 'order_month', 'order_year', 'payment_method', 'courier', 'channel', 'total_amount', 'source_file'];
    const values = [];
    const params = [];
    batch.forEach((e, i) => {
      const base = i * cols.length;
      values.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`);
      params.push(BRAND_ID, e.awb, e.invoice_key, e.invoice_number, e.sale_order_number,
        e.order_date, e.order_month, e.order_year, e.payment_method, e.courier, e.channel, e.total_amount, TALLY_FILE);
    });
    await sequelize.query(
      `INSERT INTO receivable_ledger (${cols.join(',')}) VALUES ${values.join(',')}
       ON CONFLICT (brand_id, ${conflictCol}) WHERE ${conflictWhere} DO NOTHING`,
      { bind: params }
    );
  };

  for (const batch of chunk(withAwb, CHUNK)) await insertBatch(batch, 'awb', "awb <> ''");
  for (const batch of chunk(invoiceOnly, CHUNK)) await insertBatch(batch, 'invoice_key', "awb = '' AND invoice_key <> ''");

  // Prepaid: always treated as received in the same month as the sale (product decision).
  await sequelize.query(
    `UPDATE receivable_ledger
     SET settled_flag = TRUE, settled_amount = total_amount,
         settled_month = order_month, settled_year = order_year, settled_source = 'prepaid'
     WHERE brand_id = :brandId AND payment_method = 'PREPAID' AND settled_flag = FALSE`,
    { replacements: { brandId: BRAND_ID } }
  );
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
  return { origInvoice, awb, date, amount };
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
        const [result] = await sequelize.query(
          `UPDATE receivable_ledger AS l
           SET returned_flag = TRUE, returned_amount = v.amount, returned_month = v.month, returned_year = v.year
           FROM (SELECT unnest($1::text[]) AS invoice_key, unnest($2::numeric[]) AS amount,
                        unnest($3::int[]) AS month, unnest($4::int[]) AS year) v
           WHERE l.brand_id = $5 AND l.invoice_key = v.invoice_key AND l.returned_flag = FALSE
           RETURNING l.invoice_key`,
          { bind: [keys, amounts, months, years, BRAND_ID] }
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
        const [result] = await sequelize.query(
          `UPDATE receivable_ledger AS l
           SET returned_flag = TRUE, returned_amount = v.amount, returned_month = v.month, returned_year = v.year
           FROM (SELECT unnest($1::text[]) AS awb, unnest($2::numeric[]) AS amount,
                        unnest($3::int[]) AS month, unnest($4::int[]) AS year) v
           WHERE l.brand_id = $5 AND l.awb = v.awb AND l.returned_flag = FALSE
           RETURNING l.awb`,
          { bind: [keys, amounts, months, years, BRAND_ID] }
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

async function main() {
  const sequelize = masterSequelize;
  await sequelize.query(`DELETE FROM receivable_ledger_unmatched WHERE brand_id = :brandId`, { replacements: { brandId: BRAND_ID } });
  await sequelize.query(`DELETE FROM receivable_ledger WHERE brand_id = :brandId`, { replacements: { brandId: BRAND_ID } });
  console.log('[ledger] cleared existing ledger rows for brand, rebuilding...');

  await loadTallyRows(sequelize);
  await matchSettlements(sequelize);
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

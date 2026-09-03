/* ──────────────────────────────────────────────────────────────────────────────
   invoiceMasterResolver.js — fills Invoice Process values that n8n returned as
   "N/A", using masters an accountant taught us (028 tables).

   CONTRACT — read this before changing anything:

   • n8n stays the PRIMARY resolver and is never written to. We act ONLY on a
     value n8n returned as N/A, and we NEVER overwrite a value it resolved.
     Worst case for a bug here is that an N/A stays an N/A.

   • We do NOT reproduce n8n's rules. n8n produced that N/A by running its own
     vendor sheet and CATEGORY_MASTER and failing, so re-running copies of them
     would fill nothing. These tables hold only what a human taught us.

   • An N/A has TWO causes and they need different fixes (see 028's header):
       Case A  vendor GSTIN absent from the sheet
               -> n8n returns vendor_name_tally "N/A", and its category fallback
                  then derives no vendor key from "N/A", so category is N/A too.
                  BOTH fields are missing together.
               -> invoice_vendor_master, keyed on GSTIN. Supplies both fields.
       Case B  known marketplace bills an unrecognised fee type
               -> vendor is fine, only category is N/A.
               -> invoice_category_master, keyed on the vendor NAME (never the
                  GSTIN: a marketplace bills from a different GSTIN per state
                  under one constant name).

   • CASE A MUST WRITE BOTH FIELDS OR NEITHER. The feed derives status as
       (isMissing(vendor) && isMissing(category)) ? 'Needs Review' : 'Approved'
     so filling the vendor ALONE flips a row to Approved and silently
     auto-approves exactly the invoice a human still needs to look at.
     Case B is safe: the vendor is already present, so the row was Approved
     before and after.

   MODES (env INVOICE_MASTER_RESOLVER):
     off      — do nothing at all
     shadow   — compute and log what WOULD be filled; write nothing (default)
     fill     — actually fill
   Gated further by INVOICE_MASTER_RESOLVER_BRANDS (comma-separated brand ids).
   Any brand not listed takes a byte-for-byte unchanged path.
   ────────────────────────────────────────────────────────────────────────────── */

const { QueryTypes } = require('sequelize');

const MODE = () => String(process.env.INVOICE_MASTER_RESOLVER || 'shadow').toLowerCase();
const ALLOWED_BRANDS = () =>
  String(process.env.INVOICE_MASTER_RESOLVER_BRANDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

/** Is this brand switched on? Empty allowlist = nobody, so a missing env var
 *  can never silently enable every brand. */
const isEnabledFor = (brandId) => {
  if (MODE() === 'off') return false;
  const allow = ALLOWED_BRANDS();
  return allow.length > 0 && allow.includes(String(brandId));
};

/* ── Missing-value test ───────────────────────────────────────────────────────
   The single definition; n8n-invoice-feed-db.js imports these rather than
   keeping its own copy, so the resolver and the status derivation can never
   disagree about what "missing" means. */
const NA_TOKENS = ['n/a', 'na', 'n.a.', 'missing', 'none', 'nil', '-', '—', 'null', 'undefined'];
const isMissingField = (v) => !v || !String(v).trim() || NA_TOKENS.includes(String(v).trim().toLowerCase());

/* ── Normalizers — PORTED CHARACTER-FOR-CHARACTER from the n8n Code node ──────
   Do not "clean these up". Both are load-bearing in ways that are invisible:

   normalize(): the alternation order is semantic. With /fee|fees|.../ the
   engine matches "fee" first, so "Storage Fees" -> "storage s" -> "storages",
   keeping a stray "s". Reordering to /fees|fee/ yields "storage" — a DIFFERENT
   key for the same input, so patterns stored under one ordering stop matching
   under the other.

   vendorKeyFor(): the chain ORDER is semantic. "fashnear" is tested before
   "meesho" because Fashnear Technologies is Meesho's legal entity; swapping
   them changes which rule set those invoices use. Do not alphabetise. */
function normalize(text) {
  if (!text) return '';
  return String(text).toLowerCase()
    .replace(/private limited|pvt ltd|pvt\. ltd\.|limited|ltd/g, '')
    .replace(/amazon|blinkit/g, '')
    .replace(/fee|fees|charges|charge/g, '')
    .replace(/[^a-z]/g, '')
    .trim();
}

/** n8n's getVendorKey, plus a fallback so non-marketplace vendors can hold
 *  rules too. n8n returns "" for anything unknown (which is why an unknown
 *  vendor always yields category N/A); we use the normalized vendor name
 *  instead, which is strictly more capable and cannot regress anything —
 *  we only ever run where n8n already gave up. */
function vendorKeyFor(vendor) {
  const v = String(vendor || '').toLowerCase();
  if (v.includes('amazon')) return 'amazon';
  if (v.includes('blink')) return 'blinkit';
  if (v.includes('flipkart')) return 'flipkart';
  if (v.includes('myntra')) return 'myntra';
  if (v.includes('fashnear')) return 'fashnear';
  if (v.includes('meesho')) return 'meesho';
  if (v.includes('nykaa')) return 'nykaa';
  if (v.includes('reliance')) return 'reliance';
  return normalize(vendor);
}

/** GSTINs are compared exactly, so only case/whitespace is normalized. */
const normGstin = (g) => String(g || '').trim().toUpperCase();

/* ── Master cache ─────────────────────────────────────────────────────────────
   MANDATORY, not an optimisation: each brand's pool is max 5 connections
   (config/database.js) and the n8n HTTP node fires once per LINE ITEM, so many
   POSTs are in flight at once. An uncached query per row would saturate the
   pool and stall the workflow.

   Keyed on brandId. This module is a singleton shared by all 12 brands, and a
   leak here would book one brand's ledgers onto another's invoices — RLS
   cannot catch that, because the mistake would be on the Node side. Every read
   re-checks the entry's own brandId. */
const CACHE_TTL_MS = 60 * 1000;
const _cache = new Map(); // brandId -> { at, brandId, vendorsByGstin, vendorsByName, rulesByVendorKey }

function invalidateMasters(brandId) {
  if (brandId) _cache.delete(String(brandId));
  else _cache.clear();
}

async function loadMasters(db, brandId) {
  const key = String(brandId);
  const hit = _cache.get(key);
  if (hit && hit.brandId === key && Date.now() - hit.at < CACHE_TTL_MS) return hit;

  // RLS scopes both reads to this brand via app.brand_id (preset per connection
  // in getBrandConnection's afterConnect), so no brand_id filter is needed here.
  const [vendors, rules] = await Promise.all([
    db.query(
      `SELECT gstin, vendor_name_norm, vendor_name_tally, nature_of_expense
         FROM invoice_vendor_master WHERE is_active = true`,
      { type: QueryTypes.SELECT },
    ),
    db.query(
      `SELECT vendor_key, pattern_norm, ledger
         FROM invoice_category_master WHERE is_active = true
        ORDER BY vendor_key, priority ASC, created_at ASC`,
      { type: QueryTypes.SELECT },
    ),
  ]);

  const vendorsByGstin = new Map();
  const vendorsByName = new Map();
  for (const v of vendors) {
    if (v.gstin) vendorsByGstin.set(normGstin(v.gstin), v);
    else if (v.vendor_name_norm) vendorsByName.set(v.vendor_name_norm, v);
  }

  // Already ordered by (priority, created_at); push order IS match order.
  const rulesByVendorKey = new Map();
  for (const r of rules) {
    if (!rulesByVendorKey.has(r.vendor_key)) rulesByVendorKey.set(r.vendor_key, []);
    rulesByVendorKey.get(r.vendor_key).push(r);
  }

  const entry = { at: Date.now(), brandId: key, vendorsByGstin, vendorsByName, rulesByVendorKey };
  _cache.set(key, entry);
  return entry;
}

/* ── Lookups ──────────────────────────────────────────────────────────────── */

/** Case A: find the vendor by GSTIN (exact), else by normalized name.
 *  Mirrors n8n's own precedence: GSTIN wins outright when present. */
function resolveVendor(masters, row) {
  const g = normGstin(row.seller_gstin);
  if (g) {
    const byGstin = masters.vendorsByGstin.get(g);
    if (byGstin) return byGstin;
  }
  const n = normalize(row.company || row.vendor_name_raw);
  if (n) {
    const byName = masters.vendorsByName.get(n);
    if (byName) return byName;
  }
  return null;
}

/** Case B: first rule whose pattern appears in the normalized product name.
 *  Plain substring, lowest priority first — no scoring. Ordering is why a
 *  Myntra "Shipping and Pick and Pack Fee" books to Pick and Pack, not
 *  Shipping: whichever rule the accountant ordered first wins. */
function resolveCategory(masters, vendorName, productName) {
  const key = vendorKeyFor(vendorName);
  if (!key) return null;
  const rules = masters.rulesByVendorKey.get(key);
  if (!rules || !rules.length) return null;
  const p = normalize(productName);
  if (!p) return null;
  for (const r of rules) {
    if (r.pattern_norm && p.includes(r.pattern_norm)) return r.ledger;
  }
  return null;
}

/**
 * Decide what a single row SHOULD become. Pure — returns a patch, never mutates.
 * @returns {{case:'A'|'B', vendor_name_tally?:string, category?:string}|null}
 */
function resolveOne(masters, row) {
  const vendorMissing = isMissingField(row.vendor_name_tally);
  const categoryMissing = isMissingField(row.category);
  if (!vendorMissing && !categoryMissing) return null;   // nothing to do

  // ── Case A — both missing: the vendor itself is unknown to n8n.
  if (vendorMissing && categoryMissing) {
    const v = resolveVendor(masters, row);
    if (!v) return null;

    // The category may come from the vendor's nature_of_expense, or — for a
    // marketplace whose nature is the "Refer from Category Master" sentinel —
    // from the fee-type rules.
    let category = isMissingField(v.nature_of_expense) ? null : v.nature_of_expense;
    if (category && /refer from category master/i.test(category)) category = null;
    if (!category) category = resolveCategory(masters, v.vendor_name_tally, row.product_name);

    // WRITE BOTH OR NEITHER. Filling the vendor alone would flip this row from
    // 'Needs Review' to 'Approved' while its category is still unresolved.
    if (!category) return null;
    return { case: 'A', vendor_name_tally: v.vendor_name_tally, category };
  }

  // ── Case B — vendor known, only the fee type is unrecognised.
  if (categoryMissing) {
    const category = resolveCategory(masters, row.vendor_name_tally || row.company, row.product_name);
    if (!category) return null;
    return { case: 'B', category };
  }

  // Vendor missing but category present: n8n resolved a category without a
  // vendor. Filling the vendor cannot change status (already 'Approved'), but
  // this combination does not occur in the n8n logic, so leave it be rather
  // than guess.
  return null;
}

/**
 * Resolve a batch of feed rows.
 *
 * In 'fill' mode the rows are MUTATED IN PLACE — deliberately, because the
 * caller derives `status` from the raw row afterwards (n8n-invoice-feed-db.js
 * :343) and must see the filled values. This mirrors the existing
 * `row.__brandFlag` convention in the same function.
 *
 * In 'shadow' mode nothing is written; it only logs what it would have done,
 * so a real production run can be inspected before anything changes.
 *
 * Never throws: the caller is the single ingestion choke point for all 12
 * brands, and a throw there becomes a 500 and a lost line item.
 *
 * @returns {{mode:string, considered:number, filled:number, details:Array}}
 */
async function resolveRowsInPlace(db, brandId, rows) {
  const mode = MODE();
  const result = { mode, considered: 0, filled: 0, details: [] };
  if (!Array.isArray(rows) || !rows.length || !isEnabledFor(brandId)) return result;

  const masters = await loadMasters(db, brandId);
  if (masters.brandId !== String(brandId)) {          // paranoia; see cache note
    console.error(`[invoice-master] brand mismatch: cache=${masters.brandId} want=${brandId} — skipping`);
    return result;
  }
  if (!masters.vendorsByGstin.size && !masters.vendorsByName.size && !masters.rulesByVendorKey.size) {
    return result;                                     // nothing taught yet
  }

  for (const row of rows) {
    if (!isMissingField(row.vendor_name_tally) && !isMissingField(row.category)) continue;
    result.considered += 1;

    const patch = resolveOne(masters, row);
    if (!patch) continue;

    result.filled += 1;
    result.details.push({
      invoice: row.invoice_number || null,
      product: row.product_name || null,
      case: patch.case,
      vendor: patch.vendor_name_tally || undefined,
      category: patch.category || undefined,
    });

    if (mode === 'fill') {
      if (patch.vendor_name_tally) row.vendor_name_tally = patch.vendor_name_tally;
      if (patch.category) row.category = patch.category;
    }
  }

  if (result.considered) {
    const verb = mode === 'fill' ? 'filled' : 'WOULD fill';
    console.log(`[invoice-master] ${mode}: ${result.considered} N/A row(s), ${verb} ${result.filled}`);
    for (const d of result.details.slice(0, 20)) {
      console.log(`[invoice-master]   case ${d.case} · ${d.invoice || '?'} · ${(d.product || '').slice(0, 40)}`
        + ` -> vendor=${d.vendor || '(kept)'} category=${d.category || '(kept)'}`);
    }
  }
  return result;
}

module.exports = {
  NA_TOKENS,
  isMissingField,
  normalize,
  vendorKeyFor,
  normGstin,
  loadMasters,
  invalidateMasters,
  resolveVendor,
  resolveCategory,
  resolveOne,
  resolveRowsInPlace,
  isEnabledFor,
  MODE,
};

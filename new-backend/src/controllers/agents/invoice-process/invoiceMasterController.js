/* ──────────────────────────────────────────────────────────────────────────────
   invoiceMasterController.js — the write path for the invoice masters (028).

   An accountant fixes an "N/A" on an invoice; we (a) remember the answer in the
   right master, (b) apply it to every matching row for that brand, and (c) record
   it in an append-only audit trail.

   The fix is classified, not guessed — see 028's header and invoiceMasterResolver:
     Case A  vendor unknown to n8n  -> BOTH vendor and category are N/A
             -> invoice_vendor_master, keyed on GSTIN
     Case B  known marketplace, unrecognised fee type -> only category is N/A
             -> invoice_category_master, keyed on the vendor NAME (never the
                GSTIN — a marketplace bills from a different GSTIN per state)

   n8n is never written to, and a value n8n resolved is never overwritten.
   ────────────────────────────────────────────────────────────────────────────── */

const { QueryTypes } = require('sequelize');
const { Brand } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const resolver = require('../../../services/invoiceMasterResolver');

const { isMissingField, normalize, vendorKeyFor, normGstin } = resolver;

// Above this many rows the backfill finishes in the background rather than
// holding the request open.
const BACKFILL_INLINE_MAX = Number(process.env.INVOICE_BACKFILL_INLINE_MAX || 5000);

/** Run `fn(db, t)` in a transaction scoped to the brand via the RLS GUC.
 *  Same shape as creditCardController.withBrandScope. */
async function withBrandScope(brandId, fn) {
  const brand = await Brand.findByPk(brandId);
  if (!brand) {
    const e = new Error('Brand not found');
    e.status = 404;
    throw e;
  }
  const db = getBrandConnection(brand.db_name);
  return db.transaction(async (t) => {
    await db.query(`SET LOCAL app.brand_id = '${String(brandId).replace(/'/g, '')}'`, { transaction: t });
    return fn(db, t);
  });
}

/** A read-only, brand-scoped connection (no transaction). */
async function brandConn(brandId) {
  const brand = await Brand.findByPk(brandId);
  if (!brand) {
    const e = new Error('Brand not found');
    e.status = 404;
    throw e;
  }
  return getBrandConnection(brand.db_name);
}

/** The acting user's id, or null for the shared demo login (creditCardController:169). */
const actorId = (req) => (req.user?.id && req.user.id !== 'demo' ? req.user.id : null);

/* ── Reads ─────────────────────────────────────────────────────────────────── */

/** GET …/invoice/category-master — the rules an accountant has taught us. */
exports.listCategoryMaster = async (req, res) => {
  try {
    const db = await brandConn(req.params.brandId);
    const rows = await db.query(
      `SELECT id, vendor_key, vendor_label, pattern_raw, pattern_norm, ledger,
              priority, is_active, source, created_at, updated_at
         FROM invoice_category_master
        ORDER BY vendor_key, priority ASC, created_at ASC`,
      { type: QueryTypes.SELECT },
    );
    return res.json({ rows });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

/** GET …/invoice/vendor-master — vendors an accountant has taught us.
 *  NOTE: this is NOT the full vendor master. The real one is the Google Sheet
 *  n8n reads; the UI shows that in an iframe. These are only our additions. */
exports.listVendorMaster = async (req, res) => {
  try {
    const db = await brandConn(req.params.brandId);
    const rows = await db.query(
      `SELECT id, gstin, vendor_name_raw, vendor_name_tally, nature_of_expense,
              is_active, source, created_at, updated_at
         FROM invoice_vendor_master
        ORDER BY vendor_name_tally`,
      { type: QueryTypes.SELECT },
    );
    return res.json({ rows });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

/** GET …/invoice/master-corrections — the audit trail, newest first. */
exports.listCorrections = async (req, res) => {
  try {
    const db = await brandConn(req.params.brandId);
    const rows = await db.query(
      `SELECT id, invoice_number, product_name_raw, previous_vendor, corrected_vendor,
              previous_category, corrected_category, backfilled_count, source,
              corrected_by, created_at
         FROM invoice_master_corrections
        ORDER BY created_at DESC LIMIT 200`,
      { type: QueryTypes.SELECT },
    );
    return res.json({ rows });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

/**
 * GET …/invoice/na-summary — what still needs fixing, grouped so the UI can
 * show "N vendors unknown / M fee types unrecognised" without scanning rows.
 */
exports.naSummary = async (req, res) => {
  try {
    const db = await brandConn(req.params.brandId);
    const naPred = `(x IS NULL OR btrim(x) = '' OR lower(btrim(x)) IN ('n/a','na','n.a.','missing','none','nil','-','null','undefined'))`;
    const rows = await db.query(
      `WITH f AS (
         SELECT seller_gstin, company, vendor_name_tally, category, product_name,
                (SELECT bool_and(true) FROM (SELECT vendor_name_tally AS x) s WHERE ${naPred}) AS v_na,
                (SELECT bool_and(true) FROM (SELECT category          AS x) s WHERE ${naPred}) AS c_na
           FROM invoice_process
          WHERE COALESCE(status,'') NOT IN ('Invalid','failed')
       )
       SELECT CASE WHEN v_na THEN 'A' ELSE 'B' END AS kind,
              COALESCE(NULLIF(btrim(company),''), '(unknown)') AS vendor,
              seller_gstin,
              count(*)::int AS rows
         FROM f
        WHERE v_na OR c_na
        GROUP BY 1,2,3
        ORDER BY rows DESC LIMIT 100`,
      { type: QueryTypes.SELECT },
    );
    return res.json({ groups: rows });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

/* ── The popup's save ──────────────────────────────────────────────────────── */

/**
 * POST …/invoice/master/resolve
 *
 * body: {
 *   invoice_row_id?, invoice_number?, seller_gstin?, company?, product_name?,
 *   vendor_name_tally?,     // Case A: the Tally ledger name for this vendor
 *   nature_of_expense?,     // Case A: its expense head (becomes the category)
 *   category?,              // Case B: the ledger for this fee type
 *   pattern?,               // Case B: text to match on (defaults to product_name)
 *   backfill?               // default true
 * }
 *
 * Writes the master, backfills the brand's matching N/A rows, and audits — all
 * in one transaction.
 */
exports.resolve = async (req, res) => {
  const { brandId } = req.params;
  const b = req.body || {};
  const doBackfill = b.backfill !== false;

  try {
    const out = await withBrandScope(brandId, async (db, t) => {
      const q = (sql, bind) => db.query(sql, { bind, type: QueryTypes.SELECT, transaction: t });

      // The row being fixed, so previous_* in the audit is what was really there
      // rather than what the client claimed.
      let src = null;
      if (b.invoice_row_id) {
        const [r] = await q(
          `SELECT id, invoice_number, seller_gstin, company, product_name,
                  vendor_name_tally, category, run_id
             FROM invoice_process WHERE id = $1`, [b.invoice_row_id]);
        src = r || null;
      }

      const sellerGstin = normGstin(b.seller_gstin ?? src?.seller_gstin ?? '') || null;
      const company     = b.company     ?? src?.company     ?? null;
      const productName = b.product_name ?? src?.product_name ?? null;
      // Normally the pre-fix values come from the row itself, so the client
      // cannot misreport them. The metadata-edit path is the exception: there
      // the PATCH has already written the new value, so the row no longer knows
      // what it replaced and the caller must supply it. Audit-only fields —
      // they feed no logic — so trusting them here is safe.
      const prevVendor  = b.previous_vendor   ?? src?.vendor_name_tally ?? null;
      const prevCat     = b.previous_category ?? src?.category ?? null;

      const wantVendor = String(b.vendor_name_tally || '').trim();
      const wantNature = String(b.nature_of_expense || '').trim();
      const wantCat    = String(b.category || '').trim();

      let vendorMasterId = null;
      let categoryMasterId = null;
      let kind = null;

      // ── Case A: teach the vendor. Supplies BOTH fields, which is what makes
      // it safe — filling a vendor alone would flip the row to 'Approved' while
      // its category is still unresolved (see the resolver's contract note).
      if (wantVendor) {
        const nature = wantNature || wantCat;
        if (!nature) {
          const e = new Error('A vendor fix needs an expense head too — otherwise the row would be auto-approved with no category.');
          e.status = 400;
          throw e;
        }
        const nameNorm = normalize(company) || null;

        // ON CONFLICT must repeat the partial index predicate, and one statement
        // cannot target both indexes — hence the branch on gstin.
        const rows = sellerGstin
          ? await q(
            `INSERT INTO invoice_vendor_master
               (gstin, vendor_name_raw, vendor_name_norm, vendor_name_tally, nature_of_expense, source, created_by)
             VALUES ($1,$2,$3,$4,$5,'correction',$6)
             ON CONFLICT (brand_id, gstin) WHERE gstin IS NOT NULL
             DO UPDATE SET vendor_name_tally = EXCLUDED.vendor_name_tally,
                           nature_of_expense = EXCLUDED.nature_of_expense,
                           vendor_name_raw   = COALESCE(EXCLUDED.vendor_name_raw, invoice_vendor_master.vendor_name_raw),
                           is_active = true, source = 'correction', updated_at = now()
             RETURNING id`,
            [sellerGstin, company, nameNorm, wantVendor, nature, actorId(req)])
          : await q(
            `INSERT INTO invoice_vendor_master
               (gstin, vendor_name_raw, vendor_name_norm, vendor_name_tally, nature_of_expense, source, created_by)
             VALUES (NULL,$1,$2,$3,$4,'correction',$5)
             ON CONFLICT (brand_id, vendor_name_norm) WHERE gstin IS NULL
             DO UPDATE SET vendor_name_tally = EXCLUDED.vendor_name_tally,
                           nature_of_expense = EXCLUDED.nature_of_expense,
                           is_active = true, source = 'correction', updated_at = now()
             RETURNING id`,
            [company, nameNorm, wantVendor, nature, actorId(req)]);
        vendorMasterId = rows[0]?.id || null;
        kind = 'A';
      }

      // ── Case B: teach the fee type. Keyed on the vendor NAME so one rule
      // covers every state GSTIN of that marketplace.
      if (!wantVendor && wantCat) {
        const patternRaw = String(b.pattern || productName || '').trim();
        const patternNorm = normalize(patternRaw);
        if (patternNorm.length < 4) {
          const e = new Error(`"${patternRaw}" is too short to match on (needs 4+ letters after normalising). Pick a longer phrase from the product line.`);
          e.status = 400;
          throw e;
        }
        const vKey = vendorKeyFor(prevVendor || company);
        if (!vKey) {
          const e = new Error('Could not derive a vendor key for this row — fix the vendor first.');
          e.status = 400;
          throw e;
        }
        const rows = await q(
          `INSERT INTO invoice_category_master
             (vendor_key, vendor_label, pattern_raw, pattern_norm, ledger, priority, source, created_by)
           VALUES ($1,$2,$3,$4,$5,500,'correction',$6)
           ON CONFLICT (brand_id, vendor_key, pattern_norm)
           DO UPDATE SET ledger = EXCLUDED.ledger, is_active = true,
                         pattern_raw = EXCLUDED.pattern_raw,
                         source = 'correction', updated_at = now()
           RETURNING id`,
          [vKey, prevVendor || company, patternRaw, patternNorm, wantCat, actorId(req)]);
        categoryMasterId = rows[0]?.id || null;
        kind = 'B';
      }

      if (!kind) {
        const e = new Error('Nothing to save — provide a vendor (with its expense head) or a category.');
        e.status = 400;
        throw e;
      }

      // The masters changed, so the resolver's cache for this brand is stale.
      resolver.invalidateMasters(brandId);

      // ── Backfill: re-resolve this brand's N/A rows through the SAME resolver
      // the feed uses, so the two can never disagree. Never a SQL LIKE — that
      // would be a second matching implementation in another language, the exact
      // failure mode this feature exists to remove.
      let applied = [];
      let remaining = 0;
      if (doBackfill) {
        const masters = await loadMastersInTx(db, t, brandId);
        const naRows = await q(
          `SELECT id, seller_gstin, company, product_name, vendor_name_tally, category
             FROM invoice_process
            WHERE COALESCE(status,'') NOT IN ('Invalid','failed')
              AND ( vendor_name_tally IS NULL OR btrim(vendor_name_tally) = ''
                    OR lower(btrim(vendor_name_tally)) IN ('n/a','na','n.a.','missing','none','nil','-','null','undefined')
                 OR category IS NULL OR btrim(category) = ''
                    OR lower(btrim(category)) IN ('n/a','na','n.a.','missing','none','nil','-','null','undefined') )
            ORDER BY processed_on DESC NULLS LAST
            LIMIT $1`, [BACKFILL_INLINE_MAX + 1]);

        if (naRows.length > BACKFILL_INLINE_MAX) remaining = naRows.length - BACKFILL_INLINE_MAX;
        const batch = naRows.slice(0, BACKFILL_INLINE_MAX);

        const ids = [], vendors = [], cats = [];
        for (const r of batch) {
          const patch = resolver.resolveOne(masters, r);
          if (!patch) continue;
          ids.push(r.id);
          vendors.push(patch.vendor_name_tally || null);
          cats.push(patch.category || null);
        }

        if (ids.length) {
          // One statement via unnest — no VALUES-string building, no injection
          // surface. The WHERE re-checks the row is STILL missing: optimistic and
          // lock-free on purpose, because the live n8n feed keeps inserting and a
          // FOR UPDATE over ~1000 rows would block an accountant mid-edit.
          const upd = await q(
            `UPDATE invoice_process ip
                SET vendor_name_tally = COALESCE(p.v, ip.vendor_name_tally),
                    category          = COALESCE(p.c, ip.category)
               FROM unnest($1::uuid[], $2::text[], $3::text[]) AS p(id, v, c)
              WHERE ip.id = p.id
                AND ( (p.v IS NOT NULL AND (ip.vendor_name_tally IS NULL OR btrim(ip.vendor_name_tally) = ''
                        OR lower(btrim(ip.vendor_name_tally)) IN ('n/a','na','n.a.','missing','none','nil','-','null','undefined')))
                   OR (p.c IS NOT NULL AND (ip.category IS NULL OR btrim(ip.category) = ''
                        OR lower(btrim(ip.category)) IN ('n/a','na','n.a.','missing','none','nil','-','null','undefined'))) )
              RETURNING ip.id`,
            [ids, vendors, cats]);
          applied = upd.map((r) => r.id);
        }
      }

      // ── Audit. Append-only by grant (028 REVOKEs UPDATE/DELETE).
      await db.query(
        `INSERT INTO invoice_master_corrections
           (invoice_row_id, run_id, invoice_number, seller_gstin, vendor_name_raw,
            product_name_raw, previous_vendor, corrected_vendor, previous_category,
            corrected_category, vendor_master_id, category_master_id,
            backfilled_count, backfilled_row_ids, source, corrected_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        {
          bind: [
            src?.id || null, src?.run_id || null,
            b.invoice_number ?? src?.invoice_number ?? null,
            sellerGstin, company, productName,
            prevVendor, wantVendor || null,
            prevCat, wantCat || wantNature || null,
            vendorMasterId, categoryMasterId,
            applied.length, applied,
            b.source || 'popup', actorId(req),
          ],
          type: QueryTypes.INSERT,
          transaction: t,
        },
      );

      return {
        case: kind,
        vendor_master_id: vendorMasterId,
        category_master_id: categoryMasterId,
        applied_rows: applied.length,
        partial: remaining > 0,
        remaining,
      };
    });

    return res.json({ success: true, ...out });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

/** Load the masters inside the open transaction, so the backfill sees the row
 *  we just inserted. The service's own loader uses a separate connection and a
 *  TTL cache, neither of which can see an uncommitted write. */
async function loadMastersInTx(db, t, brandId) {
  const sel = (sql) => db.query(sql, { type: QueryTypes.SELECT, transaction: t });
  const vendors = await sel(
    `SELECT gstin, vendor_name_norm, vendor_name_tally, nature_of_expense
       FROM invoice_vendor_master WHERE is_active = true`);
  const rules = await sel(
    `SELECT vendor_key, pattern_norm, ledger FROM invoice_category_master
      WHERE is_active = true ORDER BY vendor_key, priority ASC, created_at ASC`);

  const vendorsByGstin = new Map();
  const vendorsByName = new Map();
  for (const v of vendors) {
    if (v.gstin) vendorsByGstin.set(normGstin(v.gstin), v);
    else if (v.vendor_name_norm) vendorsByName.set(v.vendor_name_norm, v);
  }
  const rulesByVendorKey = new Map();
  for (const r of rules) {
    if (!rulesByVendorKey.has(r.vendor_key)) rulesByVendorKey.set(r.vendor_key, []);
    rulesByVendorKey.get(r.vendor_key).push(r);
  }
  return { at: Date.now(), brandId: String(brandId), vendorsByGstin, vendorsByName, rulesByVendorKey };
}

/* ── Master row maintenance (used by the masters screen) ───────────────────── */

exports.updateCategoryRule = async (req, res) => {
  try {
    const { brandId, id } = req.params;
    const b = req.body || {};
    const sets = [];
    const bind = [];
    if (b.ledger !== undefined)    { bind.push(String(b.ledger).trim()); sets.push(`ledger = $${bind.length}`); }
    if (b.priority !== undefined)  { bind.push(Number(b.priority));      sets.push(`priority = $${bind.length}`); }
    if (b.is_active !== undefined) { bind.push(!!b.is_active);           sets.push(`is_active = $${bind.length}`); }
    if (b.pattern !== undefined) {
      const pn = normalize(b.pattern);
      if (pn.length < 4) return res.status(400).json({ error: 'Pattern too short (needs 4+ letters after normalising).' });
      bind.push(String(b.pattern).trim()); sets.push(`pattern_raw = $${bind.length}`);
      bind.push(pn);                       sets.push(`pattern_norm = $${bind.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    const out = await withBrandScope(brandId, async (db, t) => {
      bind.push(id);
      const rows = await db.query(
        `UPDATE invoice_category_master SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${bind.length} RETURNING id`,
        { bind, type: QueryTypes.SELECT, transaction: t });
      return rows[0] || null;
    });
    if (!out) return res.status(404).json({ error: 'Rule not found' });
    resolver.invalidateMasters(brandId);
    return res.json({ success: true, id: out.id });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

exports.deleteCategoryRule = async (req, res) => {
  try {
    const { brandId, id } = req.params;
    const out = await withBrandScope(brandId, async (db, t) => {
      const rows = await db.query(
        `DELETE FROM invoice_category_master WHERE id = $1 RETURNING id`,
        { bind: [id], type: QueryTypes.SELECT, transaction: t });
      return rows[0] || null;
    });
    if (!out) return res.status(404).json({ error: 'Rule not found' });
    resolver.invalidateMasters(brandId);
    return res.json({ success: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

exports.deleteVendorEntry = async (req, res) => {
  try {
    const { brandId, id } = req.params;
    const out = await withBrandScope(brandId, async (db, t) => {
      const rows = await db.query(
        `DELETE FROM invoice_vendor_master WHERE id = $1 RETURNING id`,
        { bind: [id], type: QueryTypes.SELECT, transaction: t });
      return rows[0] || null;
    });
    if (!out) return res.status(404).json({ error: 'Vendor entry not found' });
    resolver.invalidateMasters(brandId);
    return res.json({ success: true });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};

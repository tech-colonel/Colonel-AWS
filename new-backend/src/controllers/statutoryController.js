/**
 * statutoryController.js — Statutory Compliance module.
 * Brand-scoped: any user assigned to a brand (via brand_users) can work its
 * register; the admin cross-brand summary is gated to role 'admin'. Data is
 * per-brand shared, in the master (unified) DB.
 *
 * DYNAMIC per brand: categories (filter chips) and status columns (Kanban) come
 * from statutory_config when a brand has a row there, else from the built-in
 * defaults below (so brands like Stroom keep their filing types + Not-Due/Filed
 * set unchanged). See db-restructure/010-statutory-config.sql.
 */
const { masterSequelize } = require('../config/database');
const { STATUTORY_SEED, STATUTORY_NOTES } = require('../data/statutoryTemplate');

// Default status columns — used when a brand has no custom statuses in config.
// `terminal: true` marks the "done" column (drives completion % + filing_date).
const DEFAULT_STATUSES = [
  { key: 'not_due',        label: 'Not Due',        color: '#64748B' },
  { key: 'pending',        label: 'Pending',        color: '#D97706' },
  { key: 'filed',          label: 'Filed',          color: '#059669', terminal: true },
  { key: 'not_applicable', label: 'Not Applicable', color: '#94A3B8' },
];

// 15 statutory obligations — keys/colors mirror frontend/src/lib/statutoryMeta.js
const STATUTORY_CATEGORIES = [
  { key: 'gstr_1',            name: 'GSTR-1',             color: '#0748EE', group: 'GST',        stateWise: true  },
  { key: 'gstr_3b',           name: 'GSTR-3B',            color: '#2563EB', group: 'GST',        stateWise: true  },
  { key: 'tds_payment',       name: 'TDS Payment',        color: '#D97706', group: 'TDS',        stateWise: false },
  { key: 'tds_26q',           name: 'TDS Return 26Q',     color: '#F59E0B', group: 'TDS',        stateWise: false },
  { key: 'tds_24q',           name: 'TDS Return 24Q',     color: '#B45309', group: 'TDS',        stateWise: false },
  { key: 'pf',                name: 'PF',                 color: '#059669', group: 'Payroll',    stateWise: false },
  { key: 'esic',              name: 'ESIC',               color: '#10B981', group: 'Payroll',    stateWise: false },
  { key: 'pt',                name: 'Professional Tax',   color: '#14B8A6', group: 'Payroll',    stateWise: true  },
  { key: 'itr',               name: 'Income Tax Return',  color: '#7C3AED', group: 'Income Tax', stateWise: false },
  { key: 'tax_audit',         name: 'Tax Audit',          color: '#8B5CF6', group: 'Income Tax', stateWise: false },
  { key: 'dpt_3',             name: 'DPT-3',              color: '#DB2777', group: 'ROC',        stateWise: false },
  { key: 'fla',               name: 'FLA Return',         color: '#EC4899', group: 'ROC',        stateWise: false },
  { key: 'statutory_audit',   name: 'Statutory Audit',    color: '#E11D48', group: 'Audit',      stateWise: false },
  { key: 'mca_annual',        name: 'MCA Annual Filings', color: '#6366F1', group: 'ROC',        stateWise: false },
  { key: 'other_secretarial', name: 'Other Secretarial',  color: '#0EA5E9', group: 'ROC',        stateWise: false },
];

/* Statutory is now brand-visible (no longer owner-only). Access is scoped by
   canAccessBrand below; this hook is kept as a no-op so call sites stay stable. */
const ownerOnly = () => true;

const canAccessBrand = async (user, brandId) => {
  if (user.role === 'admin') return true;
  const [rows] = await masterSequelize.query(
    `SELECT 1 FROM brand_users WHERE user_id = $1 AND brand_id = $2 LIMIT 1`,
    { bind: [user.id, brandId] }
  );
  return rows.length > 0;
};

/* Per-brand dynamic config → { categories, statuses }. Falls back to the
   built-in filing types + default status columns when a brand has no row. */
const getBrandConfig = async (brandId) => {
  const [rows] = await masterSequelize.query(
    `SELECT categories, statuses FROM statutory_config WHERE brand_id = $1 LIMIT 1`,
    { bind: [brandId] }
  );
  const cfg = rows[0];
  const categories = Array.isArray(cfg?.categories) && cfg.categories.length ? cfg.categories : STATUTORY_CATEGORIES;
  const statuses   = Array.isArray(cfg?.statuses)   && cfg.statuses.length   ? cfg.statuses   : DEFAULT_STATUSES;
  return { categories, statuses };
};

const listSelect = `
  SELECT f.*,
    (SELECT count(*) FROM compliance_attachments a
      WHERE a.entity_type = 'statutory_filing' AND a.entity_id = f.id) AS attachment_count
  FROM statutory_filings f`;

/* ── GET /api/brands/:brandId/statutory?year&month&category&state&status ── */
const listFilings = async (req, res, next) => {
  try {
    if (!ownerOnly(req, res)) return;
    const { brandId } = req.params;
    if (!(await canAccessBrand(req.user, brandId)))
      return res.status(403).json({ error: 'Access denied for this brand' });

    const { year, month, category, state, status } = req.query;
    const where = ['f.brand_id = $1'];
    const bind = [brandId];
    if (year)     { bind.push(Number(year));  where.push(`f.year IS NOT DISTINCT FROM $${bind.length}`); }
    if (month)    { bind.push(Number(month)); where.push(`f.month IS NOT DISTINCT FROM $${bind.length}`); }
    if (category && category !== 'all') { bind.push(category); where.push(`f.compliance_type = $${bind.length}`); }
    if (state)    { bind.push(state);   where.push(`f.state = $${bind.length}`); }
    if (status)   { bind.push(status);  where.push(`f.status = $${bind.length}`); }

    const [rows] = await masterSequelize.query(
      `${listSelect} WHERE ${where.join(' AND ')}
       ORDER BY f.compliance_type, f.state NULLS FIRST, f.year, f.month NULLS FIRST, f.quarter NULLS FIRST, f.period_label`,
      { bind }
    );
    res.json(rows);
  } catch (err) { next(err); }
};

/* ── GET /api/brands/:brandId/statutory/categories ── */
const listCategories = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    if (!(await canAccessBrand(req.user, brandId)))
      return res.status(403).json({ error: 'Access denied for this brand' });
    const { categories } = await getBrandConfig(brandId);
    res.json(categories);
  } catch (err) { next(err); }
};

/* ── GET /api/brands/:brandId/statutory/config → { categories, statuses } ── */
const getConfig = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    if (!(await canAccessBrand(req.user, brandId)))
      return res.status(403).json({ error: 'Access denied for this brand' });
    res.json(await getBrandConfig(brandId));
  } catch (err) { next(err); }
};

/* ── POST /api/brands/:brandId/statutory ── */
const createFiling = async (req, res, next) => {
  try {
    if (!ownerOnly(req, res)) return;
    const { brandId } = req.params;
    if (!(await canAccessBrand(req.user, brandId)))
      return res.status(403).json({ error: 'Access denied for this brand' });

    const b = req.body;
    if (!b.title?.trim()) return res.status(400).json({ error: 'title is required' });
    const cfg = await getBrandConfig(brandId);
    const statusKeys = cfg.statuses.map(s => s.key);
    const status = statusKeys.includes(b.status) ? b.status : statusKeys[0];
    const defaultType = cfg.categories[0]?.key || 'other_secretarial';

    const [rows] = await masterSequelize.query(
      `INSERT INTO statutory_filings
        (brand_id, compliance_type, title, period_label, period_type, year, month, quarter,
         state, status, due_date, filing_date, ack_no, applicability, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      { bind: [
        brandId, b.compliance_type || defaultType, b.title.trim(),
        b.period_label || null, b.period_type || 'monthly',
        b.year || null, b.month || null, b.quarter || null,
        b.state || null, status,
        b.due_date || null, b.filing_date || null, b.ack_no || null,
        b.applicability || null, b.note || null,
      ] }
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
};

/* ── PATCH /api/statutory/:id ── */
const updateFiling = async (req, res, next) => {
  try {
    if (!ownerOnly(req, res)) return;
    const { id } = req.params;
    const [found] = await masterSequelize.query(
      `SELECT * FROM statutory_filings WHERE id = $1 LIMIT 1`, { bind: [id] }
    );
    const filing = found[0];
    if (!filing) return res.status(404).json({ error: 'Filing not found' });
    if (!(await canAccessBrand(req.user, filing.brand_id)))
      return res.status(403).json({ error: 'Access denied' });

    const b = req.body;
    const sets = [];
    const bind = [];
    const set = (col, val) => { bind.push(val); sets.push(`${col} = $${bind.length}`); };

    for (const col of ['title', 'period_label', 'compliance_type', 'state', 'ack_no', 'note', 'drive_url', 'due_date', 'filing_date']) {
      if (b[col] !== undefined) set(col, b[col] === '' ? null : b[col]);
    }
    if (b.status !== undefined) {
      const { statuses } = await getBrandConfig(filing.brand_id);
      const stat = statuses.find(s => s.key === b.status);
      if (stat) {
        set('status', b.status);
        set('completed_at', stat.terminal ? new Date() : null);
        if (stat.terminal && b.filing_date === undefined && !filing.filing_date) set('filing_date', new Date());
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No updatable fields provided' });

    sets.push('updated_at = now()');
    bind.push(id);
    const [rows] = await masterSequelize.query(
      `UPDATE statutory_filings SET ${sets.join(', ')} WHERE id = $${bind.length} RETURNING *`,
      { bind }
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
};

/* ── DELETE /api/statutory/:id ── */
const deleteFiling = async (req, res, next) => {
  try {
    if (!ownerOnly(req, res)) return;
    const { id } = req.params;
    const [found] = await masterSequelize.query(
      `SELECT brand_id FROM statutory_filings WHERE id = $1 LIMIT 1`, { bind: [id] }
    );
    if (!found[0]) return res.status(404).json({ error: 'Filing not found' });
    if (!(await canAccessBrand(req.user, found[0].brand_id)))
      return res.status(403).json({ error: 'Access denied' });
    await masterSequelize.query(
      `DELETE FROM compliance_attachments WHERE entity_type = 'statutory_filing' AND entity_id = $1`, { bind: [id] }
    );
    await masterSequelize.query(`DELETE FROM statutory_filings WHERE id = $1`, { bind: [id] });
    res.json({ message: 'Filing deleted' });
  } catch (err) { next(err); }
};

/* ── POST /api/brands/:brandId/statutory/seed  (owner) ── */
const seedBrand = async (req, res, next) => {
  try {
    if (!ownerOnly(req, res)) return;
    const { brandId } = req.params;
    if (!(await canAccessBrand(req.user, brandId)))
      return res.status(403).json({ error: 'Access denied for this brand' });
    const result = await seedStatutoryForBrand({ brandId });
    res.json({ message: 'Statutory register seeded', ...result });
  } catch (err) { next(err); }
};

/**
 * Shared seeding — materialise STATUTORY_SEED for a brand. Idempotent via the
 * uq_statutory_row unique index. Used by the endpoint and the standalone script.
 */
const seedStatutoryForBrand = async ({ brandId }) => {
  let inserted = 0;
  for (const r of STATUTORY_SEED) {
    const note = r.note || STATUTORY_NOTES[r.compliance_type] || null;
    const [rows] = await masterSequelize.query(
      `INSERT INTO statutory_filings
        (brand_id, compliance_type, title, period_label, period_type, year, month, quarter,
         state, status, due_date, filing_date, ack_no, applicability, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (brand_id, compliance_type, COALESCE(state,''), COALESCE(period_label,''), COALESCE(title,''))
       DO NOTHING
       RETURNING id`,
      { bind: [
        brandId, r.compliance_type, r.title, r.period_label, r.period_type,
        r.year, r.month, r.quarter, r.state, r.status || 'not_due',
        r.due_date, r.filing_date, r.ack_no, r.applicability, note,
      ] }
    );
    if (rows.length) inserted += 1;
  }
  return { total: STATUTORY_SEED.length, inserted };
};

/* ── GET /api/statutory/admin/summary  (admin only) ──
   Cross-brand completion. Each brand carries its OWN dynamic categories +
   statuses (from statutory_config, else defaults) so the admin cards render
   correctly whether a brand uses filing types or a monthly workflow.
   Shape: { brands: [{ brand_id, brand_name, categories, statuses,
                        counts: { [type]: { [status]: n } }, total, done }] } */
const adminSummary = async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { year } = req.query;
    const where = [];
    const bind = [];
    if (year) { bind.push(Number(year)); where.push(`f.year IS NOT DISTINCT FROM $${bind.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await masterSequelize.query(
      `SELECT f.brand_id, b.name AS brand_name, f.compliance_type, f.status, count(*)::int AS n
       FROM statutory_filings f
       LEFT JOIN brands b ON b.id = f.brand_id
       ${clause}
       GROUP BY f.brand_id, b.name, f.compliance_type, f.status`,
      { bind }
    );
    const [cfgRows] = await masterSequelize.query(`SELECT brand_id, categories, statuses FROM statutory_config`);
    const cfgById = {};
    for (const c of cfgRows) cfgById[c.brand_id] = c;

    const byBrand = new Map();
    for (const r of rows) {
      if (!byBrand.has(r.brand_id)) {
        const c = cfgById[r.brand_id];
        const categories = Array.isArray(c?.categories) && c.categories.length ? c.categories : STATUTORY_CATEGORIES;
        const statuses   = Array.isArray(c?.statuses)   && c.statuses.length   ? c.statuses   : DEFAULT_STATUSES;
        byBrand.set(r.brand_id, { brand_id: r.brand_id, brand_name: r.brand_name || 'Brand', categories, statuses, counts: {}, total: 0, done: 0 });
      }
      const node = byBrand.get(r.brand_id);
      (node.counts[r.compliance_type] = node.counts[r.compliance_type] || {})[r.status] = r.n;
      node.total += r.n;
      if (node.statuses.find(s => s.key === r.status)?.terminal) node.done += r.n;
    }
    const brands = Array.from(byBrand.values()).sort((a, b) => a.brand_name.localeCompare(b.brand_name));
    res.json({ brands, categories: STATUTORY_CATEGORIES, defaultStatuses: DEFAULT_STATUSES });
  } catch (err) { next(err); }
};

module.exports = {
  listFilings, listCategories, getConfig, createFiling, updateFiling, deleteFiling,
  seedBrand, adminSummary, seedStatutoryForBrand, STATUTORY_CATEGORIES, DEFAULT_STATUSES,
};

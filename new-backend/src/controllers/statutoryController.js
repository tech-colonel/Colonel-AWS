/**
 * statutoryController.js — Statutory Compliance module (PRIVATE).
 * Working surface is gated to a single owner email; the admin cross-brand
 * summary is gated to role 'admin'. Data is per-brand shared, in the master DB.
 */
const { masterSequelize } = require('../config/database');
const { STATUTORY_SEED, STATUTORY_NOTES } = require('../data/statutoryTemplate');

const OWNER_EMAIL = 'chauhandhaval932@gmail.com';
const VALID_STATUS = ['not_due', 'pending', 'filed', 'not_applicable'];

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

/* Working surface is restricted to the single owner. Returns true if allowed. */
const ownerOnly = (req, res) => {
  if (req.user.email !== OWNER_EMAIL) {
    res.status(403).json({ error: 'Not available for this account' });
    return false;
  }
  return true;
};

const canAccessBrand = async (user, brandId) => {
  if (user.role === 'admin') return true;
  const [rows] = await masterSequelize.query(
    `SELECT 1 FROM brand_users WHERE user_id = $1 AND brand_id = $2 LIMIT 1`,
    { bind: [user.id, brandId] }
  );
  return rows.length > 0;
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
    if (!ownerOnly(req, res)) return;
    res.json(STATUTORY_CATEGORIES);
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
    const status = VALID_STATUS.includes(b.status) ? b.status : 'not_due';

    const [rows] = await masterSequelize.query(
      `INSERT INTO statutory_filings
        (brand_id, compliance_type, title, period_label, period_type, year, month, quarter,
         state, status, due_date, filing_date, ack_no, applicability, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      { bind: [
        brandId, b.compliance_type || 'other_secretarial', b.title.trim(),
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
    if (b.status !== undefined && VALID_STATUS.includes(b.status)) {
      set('status', b.status);
      set('completed_at', b.status === 'filed' ? new Date() : null);
      if (b.status === 'filed' && b.filing_date === undefined && !filing.filing_date) set('filing_date', new Date());
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
   Cross-brand completion: for each brand × compliance_type, how many filings
   are done vs total, plus per-status counts. Powers the admin overview. */
const adminSummary = async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { year } = req.query;
    const where = [];
    const bind = [];
    if (year) { bind.push(Number(year)); where.push(`f.year IS NOT DISTINCT FROM $${bind.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await masterSequelize.query(
      `SELECT f.brand_id, b.name AS brand_name, f.compliance_type,
              count(*)::int AS total,
              count(*) FILTER (WHERE f.status = 'filed')::int AS filed,
              count(*) FILTER (WHERE f.status = 'pending')::int AS pending,
              count(*) FILTER (WHERE f.status = 'not_due')::int AS not_due,
              count(*) FILTER (WHERE f.status = 'not_applicable')::int AS not_applicable
       FROM statutory_filings f
       LEFT JOIN brands b ON b.id = f.brand_id
       ${clause}
       GROUP BY f.brand_id, b.name, f.compliance_type
       ORDER BY b.name, f.compliance_type`,
      { bind }
    );
    res.json({ categories: STATUTORY_CATEGORIES, rows });
  } catch (err) { next(err); }
};

module.exports = {
  listFilings, listCategories, createFiling, updateFiling, deleteFiling,
  seedBrand, adminSummary, seedStatutoryForBrand, STATUTORY_CATEGORIES,
};

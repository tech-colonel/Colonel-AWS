/**
 * tallyBrandMatch.js — link a Tally company to the agent.accountant brand that
 * has the SAME NAME. Exact match after normalising (case, punctuation, legal
 * suffixes like "Pvt Ltd", financial-year tags like "(2024-25)"). Never fuzzy:
 * linking the wrong brand would show one brand another's books. Zero or several
 * candidate brands → leave unlinked for an admin to link by hand.
 */
const { masterSequelize } = require('../config/database');

const q = (sql, bind) => masterSequelize.query(sql, { bind, type: masterSequelize.QueryTypes.SELECT });

const normalize = (s) => String(s || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\([^)]*\)/g, ' ')                                  // "(from 1-Apr-24)", "(2024-25)"
  .replace(/\b(19|20)\d\d\s*[-–/]\s*(\d{2}|\d{4})\b/g, ' ')     // 2024-25
  .replace(/\b(pvt|private|limited|ltd|llp|opc|inc|company|co)\b\.?/g, ' ')
  .replace(/[^a-z0-9]+/g, '');

/** Link unlinked companies (one, or all) whose name matches exactly one brand. */
async function autoLinkCompanies(companyId = null) {
  const companies = await q(
    `SELECT id, name FROM tally_companies WHERE brand_id IS NULL AND NOT auto_link_off ${companyId ? 'AND id = $1' : ''}`,
    companyId ? [companyId] : undefined);
  if (!companies.length) return { linked: [], unmatched: [] };

  const byName = new Map();
  for (const b of await q(`SELECT id, name FROM brands`)) {
    const k = normalize(b.name);
    if (k) byName.set(k, [...(byName.get(k) || []), b]);
  }
  const linked = [], unmatched = [];
  for (const co of companies) {
    const hits = byName.get(normalize(co.name)) || [];
    if (hits.length !== 1) { unmatched.push({ company: co.name, reason: hits.length ? 'several brands share this name' : 'no brand with this name' }); continue; }
    const [, r] = await masterSequelize.query(
      `UPDATE tally_companies SET brand_id = $2, updated_at = now() WHERE id = $1 AND brand_id IS NULL`,
      { bind: [co.id, hits[0].id] });
    if (r && r.rowCount) linked.push({ company: co.name, brand: hits[0].name, brand_id: hits[0].id });
  }
  return { linked, unmatched };
}

module.exports = { normalize, autoLinkCompanies };

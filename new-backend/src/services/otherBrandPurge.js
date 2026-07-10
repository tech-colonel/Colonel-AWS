// otherBrandPurge.js
// Ephemeral master-data lifecycle for the shared "Other" catch-all brand only.
//
// "Other" (09abc16b) is used to process data for brands not yet onboarded, so any
// reference/master data left there could leak into the next person's ad-hoc run.
// This purges Other's MASTER data (COA file, SKU master, Ledger master, learned
// bank corrections) — but NEVER the processed RESULTS (reco_jobs, result tables,
// working files, generated outputs), so past runs stay visible.
//
// Scoped strictly to OTHER_BRAND_ID; a no-op for every real brand. Runs on the
// superuser (masterSequelize) connection, which bypasses RLS natively.
const fs = require('fs');
const path = require('path');
const { masterSequelize } = require('../config/database');

const OTHER_BRAND_ID = '09abc16b-643a-4380-a716-8a69e3435511';
const LEDGER_MASTER_DIR = process.env.LEDGER_MASTER_DIR
  || path.resolve(__dirname, '../../output/ledgers');

async function purgeOtherMaster(brandId) {
  if (brandId !== OTHER_BRAND_ID) return { skipped: true, reason: 'not the Other brand' };
  const out = { coaFileRemoved: false, masterCleared: 0, correctionsDeleted: 0 };

  // 1. Chart-of-Accounts / Ledger-Master file on disk (output/ledgers/<id>.xlsx)
  try {
    const p = path.join(LEDGER_MASTER_DIR, `${brandId}.xlsx`);
    if (fs.existsSync(p)) { fs.unlinkSync(p); out.coaFileRemoved = true; }
  } catch (e) { console.error('[OTHER-PURGE] coa file:', e.message); }

  // 2. Sales SKU/Ledger master in brand_agents (org table, no RLS)
  try {
    const [, meta] = await masterSequelize.query(
      `UPDATE brand_agents SET sku_master='[]'::jsonb, ledger_master='[]'::jsonb WHERE brand_id=:b`,
      { replacements: { b: brandId } });
    out.masterCleared = (meta && meta.rowCount) || 0;
  } catch (e) { console.error('[OTHER-PURGE] brand_agents:', e.message); }

  // 3. Learned bank corrections (RLS table; superuser bypasses natively)
  try {
    const [, meta] = await masterSequelize.query(
      `DELETE FROM bank_reco_corrections WHERE brand_id=:b`, { replacements: { b: brandId } });
    out.correctionsDeleted = (meta && meta.rowCount) || 0;
  } catch (e) { console.error('[OTHER-PURGE] corrections:', e.message); }

  return out;
}

module.exports = { OTHER_BRAND_ID, purgeOtherMaster };

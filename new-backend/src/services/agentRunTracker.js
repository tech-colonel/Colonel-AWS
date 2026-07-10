// agentRunTracker.js
// Fire-and-forget run recording for sales/marketplace agents.
// Writes ONE reco_jobs row per successful agent commit so the admin analytics
// dashboards (which read reco_jobs) show every agent run — who / when / which brand.
// Mirrors recoController.saveRecoJob's RLS-bypass pattern. NEVER throws:
// safe to call without awaiting; failures are logged and swallowed so a tracking
// problem can never break the agent's response. Does NOT touch agent tables/logic.
async function recordAgentRun(sequelize, { brandId, agentType, month, year, totalRows, outputFileId, createdBy, sourceName }) {
  try {
    if (!sequelize || !brandId || !agentType) return null;
    // output_file_id is varchar(36) (reco engine job UUID). A sales filename won't fit —
    // the uploaded file name goes in source_name ("from where") instead.
    const ofid = (outputFileId != null && String(outputFileId).length <= 36) ? String(outputFileId) : null;
    await sequelize.transaction(async (t) => {
      // In per-brand mode this bypasses RLS; in the unified DB the caller passes the
      // superuser (masterSequelize) which bypasses RLS natively (the client-settable
      // bypass GUC was removed when RLS was hardened).
      await sequelize.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
      await sequelize.query(
        `INSERT INTO reco_jobs
           (brand_id, agent_type, month, year, file_hash, status,
            total_rows, matched_rows, unmatched_rows, output_file_id, created_by, source_name)
         VALUES ($1,$2,$3,$4,NULL,'completed',$5,NULL,NULL,$6,$7,$8)`,
        { bind: [brandId, agentType, month || null, year || null,
                 totalRows || 0, ofid, createdBy || null, sourceName || null],
          transaction: t }
      );
    });
  } catch (err) {
    console.error('[AGENT-RUN] recordAgentRun error:', err.message);
  }
  return null;
}
module.exports = { recordAgentRun };

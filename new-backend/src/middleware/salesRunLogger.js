// salesRunLogger.js
// App-level, pull-proof attribution for sales/marketplace agent runs.
// After a successful …/generate (or …/generate/commit) that PERSISTS rows, logs
// ONE reco_jobs row via recordAgentRun — capturing who (created_by), which brand
// (brand_id), which agent (agent_type = dynamic table name), from where
// (source_name = uploaded filename), and how many rows. The admin dashboards read
// reco_jobs, so sales runs show up alongside reco runs with no dashboard changes.
// It never touches the agent controllers (survives future pulls) and never throws.
const { QueryTypes } = require('sequelize');
const { masterSequelize } = require('../config/database');
const { recordAgentRun } = require('../services/agentRunTracker');
const { Agent } = require('../models/master');

// Matches the sales/marketplace + order-cycle persist endpoints (not preview/discard).
const RUN_RE = /\/brands\/([^/]+)\/agents\/([^/]+)\/[^/]+\/generate(?:\/commit)?$/;

function salesRunLogger(req, res, next) {
  if (req.method !== 'POST') return next();
  const m = req.path.match(RUN_RE);
  if (!m) return next();
  const brandId = m[1];
  const agentId = m[2];
  const startedAt = new Date();

  res.on('finish', async () => {
    try {
      if (res.statusCode < 200 || res.statusCode >= 300 || !req.user || !req.user.id) return;
      const agent = await Agent.findByPk(agentId);
      if (!agent || !agent.name) return;
      const table = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      // How many rows this agent persisted for this brand during THIS request.
      // (masterSequelize = superuser in unified mode → sees all rows.)
      const rows = await masterSequelize
        .query(
          `SELECT count(*)::int AS n FROM "${table}" WHERE brand_id = :b AND created_at >= :t`,
          { replacements: { b: brandId, t: startedAt }, type: QueryTypes.SELECT }
        )
        .then((r) => (r && r[0] ? r[0].n : 0))
        .catch(() => 0);
      if (!rows) return; // preview / discard / no-op → nothing persisted → skip

      const f =
        (req.file && req.file.originalname) ||
        (Array.isArray(req.files) && req.files[0] && req.files[0].originalname) ||
        (req.files && typeof req.files === 'object' &&
          Object.values(req.files).flat()[0] && Object.values(req.files).flat()[0].originalname) ||
        null;

      recordAgentRun(masterSequelize, {
        brandId,
        agentType: table,
        totalRows: rows,
        sourceName: f,
        createdBy: req.user.id,
      });
    } catch (e) {
      console.error('[SALES-RUN-LOG]', e.message);
    }
  });

  next();
}

module.exports = { salesRunLogger };

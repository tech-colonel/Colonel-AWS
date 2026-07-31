/* ── Colonel AI — screen-context normalizer ──────────────────────────────
   Turns whatever the frontend sends as "current screen" into a normalized
   scope object used to build the system prompt (see ./prompts). Pure
   normalization only — NO DB reads (the DB tool is a follow-on piece of
   this plan) — and it must never throw on missing/undefined input.        */

/**
 * @param {object} [opts]
 * @param {object} [opts.screen] - current screen context from the frontend.
 *   May be undefined, or `{ route, agentType, agentLabel, brandId, brandName, hasResult, resultSummary }`.
 * @param {object} [opts.user] - current user (reserved for future use; not read here).
 * @returns {{mode:'agent'|'global', agentType:(string|null), agentLabel:(string|null), brandId:(string|null), brandName:(string|null)}}
 */
function resolveScope(opts) {
  const { screen } = opts || {};
  const s = screen && typeof screen === 'object' ? screen : {};

  if (s.agentType) {
    return {
      mode: 'agent',
      agentType: s.agentType,
      agentLabel: s.agentLabel || null,
      brandId: s.brandId || null,
      brandName: s.brandName || null,
    };
  }

  return {
    mode: 'global',
    agentType: null,
    agentLabel: null,
    brandId: null,
    brandName: null,
  };
}

module.exports = { resolveScope };

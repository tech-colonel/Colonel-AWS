/* ── Colonel AI — report intent detection (NO LLM) ──────────────────────────
   Cheap keyword match that decides whether a message is asking for a usage
   report and, if so, which canned report to run. Returns { key } or null.
   Role scoping / admin-only downgrade is decided by the controller, not here. */

const REPORT_TRIGGER = /\b(usage|report|adoption|activity|who('?s| is)? (using|use|used)|which tools?|how many runs|most[- ]?used|brand[- ]?wise|by (brand|user|tool)|per (brand|user|tool))\b/i;

/**
 * @param {string} message raw user message
 * @returns {{ key: 'usage_by_tool'|'usage_by_brand'|'usage_by_user'|'who_uses_what'|'my_usage' } | null}
 */
function detectReport(message) {
  const s = String(message || '');
  if (!REPORT_TRIGGER.test(s)) return null;
  const l = s.toLowerCase();

  // "who uses which tools on which brands" — the cross matrix.
  if (/\bwho\b/.test(l) && /(tool|brand)/.test(l)) return { key: 'who_uses_what' };
  if (/which tools?.*brand|brand.*which tools?|tool.*per brand|user.*tool.*brand/.test(l)) return { key: 'who_uses_what' };

  // Explicitly own usage.
  if (/\bmy (usage|report|runs|activity)\b|\bmy own\b|\bown usage\b/.test(l)) return { key: 'my_usage' };

  // By user / who is using.
  if (/\bwho\b|\bby user\b|\bper user\b|\bwhich user\b|\buser[- ]?wise\b/.test(l)) return { key: 'usage_by_user' };

  // By brand.
  if (/\bbrand[- ]?wise\b|\bby brand\b|\bper brand\b|\bwhich brand\b/.test(l)) return { key: 'usage_by_brand' };

  // Default usage report → by tool.
  return { key: 'usage_by_tool' };
}

module.exports = { detectReport };

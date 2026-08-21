'use strict';

// Shared bookkeeping for "raw file value not found in SKU/Ledger master" across every
// sales processor and the Workflow Builder. Dedupes by (masterType, matchField, value) and
// counts how many rows hit each miss, so the frontend can show one entry per distinct value.
function createMissingMasterTracker() {
  const byKey = new Map();

  function track({ masterType, matchField, value }) {
    const val = value === undefined || value === null ? '' : String(value).trim();
    if (!val) return;
    const key = `${masterType}::${matchField || ''}::${val.toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences += 1;
    } else {
      byKey.set(key, { masterType, matchField: matchField || '', value: val, occurrences: 1 });
    }
  }

  function list() {
    return Array.from(byKey.values());
  }

  return { track, list };
}

module.exports = { createMissingMasterTracker };

/**
 * pendingGenerationsStore.js
 *
 * A shared, agent-agnostic in-memory store for pending file generations.
 * Each agent's controller stores its processed workbook + finalData here
 * keyed by a taskId UUID, waits for accountant confirmation, then
 * either commits (save to DB + disk) or discards (clean up silently).
 *
 * TTL: 30 minutes — auto-cleaned on get to avoid memory leak.
 */

const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes

const store = new Map();

/**
 * Save a pending generation.
 * @param {string} taskId
 * @param {object} payload - { workbook, finalData, processFile, processPath, Model, agentType, ...meta }
 */
function setPending(taskId, payload) {
    store.set(taskId, {
        ...payload,
        expiresAt: Date.now() + PENDING_TTL_MS
    });
}

/**
 * Retrieve and validate a pending generation.
 * Returns null if not found or expired (and cleans up).
 * @param {string} taskId
 */
function getPending(taskId) {
    const entry = store.get(taskId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        store.delete(taskId);
        return null;
    }
    return entry;
}

/**
 * Remove a pending generation (after commit or discard).
 * @param {string} taskId
 */
function deletePending(taskId) {
    store.delete(taskId);
}

/**
 * Compute summary totals from a rows array.
 * Works for both working-file rows (raw column names) and pivot rows.
 * @param {Array} rows
 * @returns {{ quantity, taxableValue, cgst, sgst, igst }}
 */
function computeSummary(rows = []) {
    let qty = 0, taxable = 0, cgst = 0, sgst = 0, igst = 0;
    rows.forEach(row => {
        qty     += Number(row['Quantity']                  || row['quantity']                  || 0);
        taxable += Number(row['Final Taxable Sales Value'] || row['final_taxable_sales_value'] || 0);
        cgst    += Number(row['Final CGST Tax']            || row['final_cgst_tax']            || 0);
        sgst    += Number(row['Final SGST Tax']            || row['final_sgst_tax']            || 0);
        igst    += Number(row['Final IGST Tax']            || row['final_igst_tax']            || 0);
    });
    return {
        quantity:     Math.round(qty),
        taxableValue: Number(taxable.toFixed(2)),
        cgst:         Number(cgst.toFixed(2)),
        sgst:         Number(sgst.toFixed(2)),
        igst:         Number(igst.toFixed(2))
    };
}

module.exports = { setPending, getPending, deletePending, computeSummary };

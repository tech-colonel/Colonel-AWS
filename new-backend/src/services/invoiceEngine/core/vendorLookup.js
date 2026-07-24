/**
 * vendorLookup.js — code implementation of the n8n "Vendor_Master" tool.
 *
 * Replaces the LLM tool-call with a deterministic lookup (accuracy + cost), per
 * the EXACT rules in the Vendor_Master tool description:
 *   Sheet cols: A=Supplier GSTIN, B=As per Invoice Name, C=In Tally, D=Expense head in Tally
 *   1. seller_gstin present  -> EXACT match on col A. Found -> {C, D||"N/A"}. Not found -> {"N/A","Refer from Category Master"}. NO name fallback.
 *   2. seller_gstin empty     -> fuzzy (~90%) match on col B, ignoring Pvt/Private, Ltd/Limited, punctuation, spaces, case.
 *   Expense head (D) empty    -> nature_of_expense = "N/A" (vendor_name_tally still C).
 *
 * The result is injected into each extracted row as vendor_name_tally + category
 * (=nature_of_expense) BEFORE the verbatim Code-node runs — exactly what the tool fed n8n.
 */

const REFER = 'Refer from Category Master';

function nameNorm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/private limited|pvt\.? ?ltd\.?|pvt\.? ?limited|limited|ltd\.?/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// token Jaccard similarity for the (rare) name-fallback path
function similarity(a, b) {
  const A = new Set(nameNorm(a).split(' ').filter(Boolean));
  const B = new Set(nameNorm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / new Set([...A, ...B]).size;
}

/**
 * Build a lookup from the raw Vendor Master sheet rows (2D array incl. header row).
 * @returns {(seller_gstin: string, company: string) => {vendor_name_tally, nature_of_expense}}
 */
function buildVendorLookup(rows) {
  const byGstin = new Map();   // normalized GSTIN -> {tally, expense, invoiceName}
  const list = [];             // for name fallback

  (rows || []).forEach((r, i) => {
    if (i === 0) return; // header
    const gstin = String(r[0] || '').trim().toUpperCase();
    const invoiceName = String(r[1] || '').trim();
    const inTally = String(r[2] || '').trim();
    const expenseHead = String(r[3] || '').trim();
    if (!inTally && !gstin && !invoiceName) return;
    const rec = { gstin, invoiceName, inTally, expenseHead };
    if (gstin) byGstin.set(gstin, rec);
    if (invoiceName) list.push(rec);
  });

  const shape = (rec) => ({
    vendor_name_tally: rec.inTally || 'N/A',
    nature_of_expense: rec.expenseHead && rec.expenseHead.trim() ? rec.expenseHead : 'N/A',
  });

  return function lookup(seller_gstin, company) {
    const gstin = String(seller_gstin || '').trim().toUpperCase();

    // 1. GSTIN present -> exact only, NO name fallback
    if (gstin) {
      const rec = byGstin.get(gstin);
      if (rec) return shape(rec);
      return { vendor_name_tally: 'N/A', nature_of_expense: REFER };
    }

    // 2. GSTIN empty -> fuzzy name match (~90%) on col B
    let best = null, bestScore = 0;
    for (const rec of list) {
      const s = similarity(company, rec.invoiceName);
      if (s > bestScore) { bestScore = s; best = rec; }
    }
    if (best && bestScore >= 0.9) return shape(best);
    return { vendor_name_tally: 'N/A', nature_of_expense: REFER };
  };
}

module.exports = { buildVendorLookup, nameNorm };

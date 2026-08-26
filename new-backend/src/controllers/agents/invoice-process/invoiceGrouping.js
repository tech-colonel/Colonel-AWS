/* ──────────────────────────────────────────────────────────────────────────────
   invoiceGrouping.js — collapse flat invoice_process LINE-ITEM rows into INVOICES.

   The table stores one row PER LINE ITEM (n8n loops per line). The workspace UI
   wants one card per INVOICE that expands into its line items, so we group here.

   Grouping key = invoice_number + company_name  (user-decided).
     • Rows with a blank / "Invalid" invoice_number fall back to a PER-FILE key
       (invoice_link → filename → row id) so two DIFFERENT failed/unextracted PDFs
       never merge into one "Invalid" card.
   Each group returns the shared header + derived status + totals + the full
   line_items[] (each line keeps its own `id`, so the detail panel can select and
   edit an individual line exactly as today).

   Pure functions — no DB, no Express — so they unit-test trivially.
   ────────────────────────────────────────────────────────────────────────────── */

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const isBlankInvoiceNo = (v) => {
  const s = norm(v);
  return !s || s === 'invalid' || s === 'n/a' || s === 'na';
};

// Invoice-level status precedence — the WORST line status wins, so an invoice is
// only "Approved" when every one of its lines is Approved. 'Corrupted' == 'Invalid'.
const STATUS_RANK = { 'Approved': 1, 'Disapproved': 2, 'Needs Review': 3, 'Corrupted': 4, 'Invalid': 4 };
const RANK_STATUS = { 1: 'Approved', 2: 'Disapproved', 3: 'Needs Review', 4: 'Invalid' };

function deriveStatus(lineStatuses) {
  let worst = 0;
  for (const s of lineStatuses) {
    const r = STATUS_RANK[s] || 0;
    if (r > worst) worst = r;
  }
  return RANK_STATUS[worst] || 'Needs Review';
}

/** The stable key that identifies which invoice a line-item row belongs to. */
function groupKeyFor(row) {
  if (isBlankInvoiceNo(row.invoice_number)) {
    const file = norm(row.invoice_link) || norm(row.filename) || `id:${row.id}`;
    return `__file__::${file}`;
  }
  return `${norm(row.invoice_number)}::${norm(row.company)}`;
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Group flat rows (plain objects, e.g. Sequelize findAll({ raw: true })) into invoices.
 * @param {Array<object>} rows
 * @returns {Array<object>} one object per invoice, newest processed_on first.
 */
function groupInvoices(rows) {
  const map = new Map();          // key -> { line_items: [] }  (insertion-ordered)
  for (const r of (rows || [])) {
    const key = groupKeyFor(r);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }

  const out = [];
  for (const [key, items] of map) {
    const head = items[0] || {};
    let taxable = 0, gst = 0;
    for (const r of items) { taxable += num(r.taxable_value); gst += num(r.gst_amount); }
    out.push({
      group_key: key,
      // Header — shared across every line item of the invoice (taken from the first row).
      invoice_number: head.invoice_number,
      company: head.company,
      seller_gstin: head.seller_gstin,
      buyer_gstin: head.buyer_gstin,
      invoice_date: head.invoice_date,
      due_date: head.due_date,
      category: head.category,
      invoice_link: head.invoice_link,
      filename: head.filename,
      month: head.month,
      year: head.year,
      processed_on: head.processed_on,
      // Derived.
      status: deriveStatus(items.map((r) => r.status)),
      line_count: items.length,
      total_taxable: taxable,          // Σ taxable value (pre-GST)
      total_gst: gst,                  // Σ GST
      total_amount: taxable + gst,     // grand total (payable)
      // Full line-item rows — each keeps its own id for per-line select + edit.
      line_items: items,
    });
  }

  out.sort((a, b) => new Date(b.processed_on || 0) - new Date(a.processed_on || 0));
  return out;
}

/** Given the flat rows and a target group_key, return the row ids in that invoice. */
function idsForGroup(rows, groupKey) {
  return (rows || []).filter((r) => groupKeyFor(r) === groupKey).map((r) => r.id);
}

module.exports = { groupInvoices, groupKeyFor, deriveStatus, idsForGroup, isBlankInvoiceNo };

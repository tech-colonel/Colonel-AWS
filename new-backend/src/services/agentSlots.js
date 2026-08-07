/* ──────────────────────────────────────────────────────────────────────────────
   agentSlots.js — the input-slot registry for the generic Drive router.

   For each agent_type we declare the named file "slots" the agent consumes and,
   per slot, `match` hints (filename keywords + allowed extensions) used to
   auto-recognize which Drive file belongs in which slot. This mirrors the
   frontend's AGENT_CONFIG[...].files, but adds the match hints and is the
   AUTHORITATIVE source for POST /api/drive/route.

   Additive only: this changes no agent logic. It is read by driveRouter.js to
   preview a mapping; the user confirms it before anything runs.
   ────────────────────────────────────────────────────────────────────────────── */

const XLS = ['.xlsx', '.xls'];
const XLS_CSV = ['.xlsx', '.xls', '.csv'];
const XLS_CSV_PDF = ['.xlsx', '.xls', '.csv', '.pdf'];
const PDF_XLS = ['.pdf', '.xlsx', '.xls'];

// Slot shape: { key, label, required, multiple?, accept?, match:{ keywords:[], extensions:[] } }
const SLOTS = {
  gstr_2b_vs_purchase: [
    { key: 'gstr2b', label: 'GSTR-2B File', required: true, match: { keywords: ['gstr-2b', 'gstr2b', 'gstr 2b', '2b'], extensions: XLS } },
    { key: 'purchase', label: 'Purchase Register', required: true, match: { keywords: ['purchase register', 'purchase', 'pr'], extensions: XLS } },
  ],
  gstr_2a_vs_2b_vs_books: [
    { key: 'gstr2b', label: 'GSTR-2B File', required: true, match: { keywords: ['gstr-2b', 'gstr2b', 'gstr 2b', '2b'], extensions: XLS } },
    { key: 'purchase', label: 'Purchase Register', required: true, match: { keywords: ['purchase register', 'purchase', 'pr'], extensions: XLS } },
    { key: 'debit', label: 'Debit Note Register', required: true, match: { keywords: ['debit note', 'debit', 'dn'], extensions: XLS } },
  ],
  gstr_2b_books: [
    { key: 'gstr2b', label: 'GSTR-2B File', required: true, match: { keywords: ['gstr-2b', 'gstr2b', 'gstr 2b', '2b'], extensions: XLS } },
    { key: 'purchase', label: 'Purchase Register', required: true, match: { keywords: ['purchase register', 'purchase', 'pr'], extensions: XLS } },
    { key: 'debit', label: 'Debit Note Register', required: true, match: { keywords: ['debit note', 'debit', 'dn'], extensions: XLS } },
  ],
  // Multi-state uses per-state grouping (see driveRouter.routeMultiState), but the
  // per-file TYPE detection reuses these three slots.
  gstr_2b_books_multistate: [
    { key: 'gstr2b', label: 'GSTR-2B File', required: true, match: { keywords: ['gstr-2b', 'gstr2b', 'gstr 2b', 'einv', 'e-invoice', '2b'], extensions: XLS } },
    { key: 'purchase', label: 'Purchase Register', required: true, match: { keywords: ['purchase register', 'purchase', 'pr'], extensions: XLS } },
    { key: 'debit', label: 'Debit Note Register', required: false, match: { keywords: ['debit note', 'debit note register', 'debit', 'dn'], extensions: XLS } },
  ],
  gstr_3b_vs_2b: [
    { key: 'gstr3b', label: 'GSTR-3B Working File', required: true, match: { keywords: ['gstr-3b', 'gstr3b', 'gstr 3b', '3b'], extensions: XLS } },
    { key: 'gstr2b_3b', label: 'GSTR-2B File', required: true, match: { keywords: ['gstr-2b', 'gstr2b', 'gstr 2b', '2b'], extensions: XLS } },
  ],
  gstr_1_vs_books: [
    { key: 'tally_sales', label: 'Tally Sales Register', required: true, match: { keywords: ['tally sales', 'sales register', 'tally', 'sales'], extensions: XLS } },
    { key: 'gstr1_octa', label: 'GSTR-1 OCTA Report', required: true, match: { keywords: ['octa', 'gstr-1', 'gstr1', 'gstr 1'], extensions: XLS } },
    { key: 'gstr1_pdf', label: 'GSTR-1 PDF from GST Portal (Optional)', required: false, accept: '.pdf', match: { keywords: ['gstr-1', 'gstr1', 'gstr 1'], extensions: ['.pdf'] } },
    { key: 'credit_note', label: 'Credit Note Register (Optional)', required: false, match: { keywords: ['credit note', 'credit', 'cn'], extensions: XLS } },
  ],
  einvoice_reco: [
    { key: 'einvoice', label: 'E-Invoice Register', required: true, match: { keywords: ['e-invoice', 'einvoice', 'e invoice', 'einv', 'irn'], extensions: XLS } },
    { key: 'books', label: 'Books — Combined (Sales + Credit Note)', required: true, match: { keywords: ['combined', 'books', 'combine'], extensions: XLS } },
  ],
  bank_statement: [
    { key: 'bank_statement', label: 'Bank Statement', required: true, match: { keywords: ['bank', 'statement'], extensions: XLS_CSV } },
  ],
  universal_bank_statement: [
    { key: 'bank_statement', label: 'Bank Statement', required: true, accept: '.xlsx,.xls,.csv,.pdf', match: { keywords: ['bank', 'statement'], extensions: XLS_CSV_PDF } },
    { key: 'ledger_master', label: 'Ledger Master (Chart of Accounts)', required: false, match: { keywords: ['ledger', 'chart of account', 'coa', 'master'], extensions: XLS } },
  ],
  gstr_3b_tally_entry: [
    { key: 'gstr3b', label: 'GSTR-3B Files', required: true, multiple: true, accept: '.pdf,.xlsx,.xls', match: { keywords: ['gstr-3b', 'gstr3b', 'gstr 3b', '3b'], extensions: PDF_XLS } },
    { key: 'coa', label: 'Chart of Accounts (Optional)', required: false, accept: '.xlsx,.xls', match: { keywords: ['chart of account', 'coa'], extensions: XLS } },
    { key: 'vouchertype', label: 'Voucher Type Master (Optional)', required: false, accept: '.xlsx,.xls', match: { keywords: ['voucher type', 'vouchertype', 'voucher', 'vt master', 'vt'], extensions: XLS } },
  ],
  receivable_cycle: [
    { key: 'tally_gst', label: 'Combine Tally GST Report', required: true, match: { keywords: ['tally gst', 'tally', 'gst report'], extensions: XLS } },
    { key: 'sales_order', label: 'Sales Order Combine', required: true, match: { keywords: ['sales order', 'order combine', 'so combine'], extensions: XLS } },
    { key: 'delhivery', label: 'Delhivery COD Settlement (Optional)', required: false, multiple: true, match: { keywords: ['delhivery'], extensions: XLS } },
    { key: 'ekart', label: 'Ekart COD Settlement (Optional)', required: false, multiple: true, match: { keywords: ['ekart'], extensions: XLS } },
    { key: 'xpressbees', label: 'Xpressbees COD Settlement (Optional)', required: false, multiple: true, match: { keywords: ['xpressbees', 'xpress'], extensions: XLS } },
    { key: 'srn', label: 'Combined SRN Report (Optional)', required: false, multiple: true, match: { keywords: ['srn'], extensions: XLS } },
  ],
  bank_tally_reco: [
    { key: 'tally_daybook', label: 'Tally Bank Daybook', required: true, accept: '.xls,.xlsx', match: { keywords: ['daybook', 'day book', 'tally bank', 'tally'], extensions: XLS } },
    { key: 'bank_output', label: 'Universal Bank Statement Output', required: false, accept: '.xlsx', match: { keywords: ['universal bank', 'bank output', 'universal', 'output'], extensions: ['.xlsx'] } },
  ],
  credit_card_booking: [
    { key: 'card_statement', label: 'Credit Card Statement (PDF or Excel)', required: true,
      accept: '.pdf,.xlsx,.xls', match: { keywords: ['credit card', 'card statement', 'statement'], extensions: ['.pdf', '.xlsx', '.xls'] } },
  ],
  pdf_bank_extract: [
    { key: 'bank_pdf', label: 'Bank Statement PDF', required: true, accept: '.pdf', match: { keywords: ['bank', 'statement'], extensions: ['.pdf'] } },
  ],
};

/** Slots for an agent_type, or null if this agent isn't slot-routable here. */
function get(agentType) {
  const s = SLOTS[agentType];
  return s ? s.map((slot) => ({ ...slot })) : null;
}

/** True if we can route Drive files for this agent_type via slot matching. */
function isSupported(agentType) {
  return Object.prototype.hasOwnProperty.call(SLOTS, agentType);
}

/** All supported agent types (for diagnostics/tests). */
function supportedTypes() {
  return Object.keys(SLOTS);
}

module.exports = { get, isSupported, supportedTypes, SLOTS };

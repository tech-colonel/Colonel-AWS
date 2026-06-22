/* ── Shared reco agent specs (Colonel AI · Agent mode) ──────────────────────
   The set of reconciliation agents the in-chat Agent mode can run, with the
   exact file slots each needs (mirrors AGENT_CONFIG in RecoWorkspace). These
   runs go through POST /api/reco/run (the Python reco engine) — NEVER the Claude
   API. Excludes non-reconcile tools (MTR consolidator, PDF→Bank converter).

   Each spec:
     reco_type   — value sent as the `reco_type` form field to /api/reco/run
     name        — display label
     files       — ordered slots [{ key, label, hint, required, accept? }]
     multistate  — true → repeatable {gstr2b, purchase, debit} group per state
*/

export const RECO_AGENT_SPECS = [
  {
    reco_type: 'gstr_2b_books',
    name: 'GSTR-2B vs Books',
    files: [
      { key: 'gstr2b',   label: 'GSTR-2B File',        hint: '.xlsx / .xls', required: true },
      { key: 'purchase', label: 'Purchase Register',   hint: '.xlsx / .xls', required: true },
      { key: 'debit',    label: 'Debit Note Register', hint: '.xlsx / .xls', required: true },
    ],
  },
  {
    reco_type: 'gstr_2b_books_multistate',
    name: 'GSTR-2B vs Books (Multi-State)',
    multistate: true,
    // Per state: 2B → Purchase → Debit Note. "Add another state" repeats the group.
    files: [
      { key: 'gstr2b',   label: 'GSTR-2B File',        hint: '.xlsx / .xls', required: true },
      { key: 'purchase', label: 'Purchase Register',   hint: '.xlsx / .xls', required: true },
      { key: 'debit',    label: 'Debit Note Register', hint: '.xlsx / .xls', required: false },
    ],
  },
  {
    reco_type: 'gstr_2b_vs_purchase',
    name: 'GSTR-2B vs Purchase Register',
    files: [
      { key: 'gstr2b',   label: 'GSTR-2B File',      hint: '.xlsx / .xls', required: true },
      { key: 'purchase', label: 'Purchase Register', hint: '.xlsx / .xls', required: true },
    ],
  },
  {
    reco_type: 'gstr_2a_vs_2b_vs_books',
    name: 'GSTR-2A vs 2B vs Books (3-way)',
    files: [
      { key: 'gstr2b',   label: 'GSTR-2B File',        hint: '.xlsx / .xls', required: true },
      { key: 'purchase', label: 'Purchase Register',   hint: '.xlsx / .xls', required: true },
      { key: 'debit',    label: 'Debit Note Register', hint: '.xlsx / .xls', required: true },
    ],
  },
  {
    reco_type: 'gstr_3b_vs_2b',
    name: 'GSTR-3B vs GSTR-2B',
    files: [
      { key: 'gstr3b',    label: 'GSTR-3B Working File', hint: '.xlsx / .xls', required: true },
      { key: 'gstr2b_3b', label: 'GSTR-2B File',         hint: '.xlsx / .xls', required: true },
    ],
  },
  {
    reco_type: 'gstr_1_vs_books',
    name: 'GSTR-1 vs Books',
    files: [
      { key: 'tally_sales', label: 'Tally Sales Register',         hint: '.xlsx / .xls', required: true },
      { key: 'gstr1_octa',  label: 'GSTR-1 OCTA Report',           hint: '.xlsx',        required: true },
      { key: 'gstr1_pdf',   label: 'GSTR-1 PDF (optional)',        hint: '.pdf',         required: false, accept: '.pdf' },
      { key: 'credit_note', label: 'Credit Note Register (opt.)',  hint: '.xlsx / .xls', required: false },
    ],
  },
  {
    reco_type: 'universal_bank_statement',
    name: 'Universal Bank Statement',
    files: [
      { key: 'bank_statement', label: 'Bank Statement',                 hint: '.xlsx / .xls / .csv', required: true },
      { key: 'ledger_master',  label: 'Ledger Master (opt., saved)',    hint: '.xlsx / .xls',        required: false },
    ],
  },
  {
    reco_type: 'gstr_3b_tally_entry',
    name: 'GSTR-3B Tally Entry',
    files: [
      { key: 'gstr3b', label: 'GSTR-3B File', hint: '.pdf / .xlsx / .xls', required: true, accept: '.pdf,.xlsx,.xls' },
    ],
  },
];

export const specByType = (t) => RECO_AGENT_SPECS.find((s) => s.reco_type === t) || null;

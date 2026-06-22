// Engine-valid demo sample files (bundled in public/demo-samples/), auto-loaded
// into the upload slots when an ADMIN opens an agent — so Anshul can demo with
// one click. Files come from the repo's canonical GST Reco/Demo Files set + a
// real processed bank statement, so the reco engine accepts them as-is.

// Single-slot agents (RecoWorkspace) — keyed by agentType → [{ slot key, url, filename }]
export const DEMO_SAMPLES = {
  gstr_2b_books: [
    { key: 'gstr2b',   url: '/demo-samples/gstr_2b_books/gstr2b.xlsx',   filename: 'GSTR2B_Karnataka.xlsx' },
    { key: 'purchase', url: '/demo-samples/gstr_2b_books/purchase.xlsx', filename: 'Purchase_Register.xlsx' },
    { key: 'debit',    url: '/demo-samples/gstr_2b_books/debit.xlsx',    filename: 'Debit_Note_Register.xlsx' },
  ],
  universal_bank_statement: [
    { key: 'bank_statement', url: '/demo-samples/bank/bank.xlsx', filename: 'Bank_Statement.xlsx' },
  ],
  bank_statement: [
    { key: 'bank_statement', url: '/demo-samples/bank/bank.xlsx', filename: 'Bank_Statement.xlsx' },
  ],
};

// Multi-state agent (RecoMultiStateWorkspace) — one entry per state slot.
export const MULTISTATE_SAMPLE = [
  { gstr2b: '/demo-samples/multistate/s1_gstr2b.xlsx', purchase: '/demo-samples/multistate/s1_purchase.xlsx', debit: '/demo-samples/multistate/s1_debit.xlsx' },
  { gstr2b: '/demo-samples/multistate/s2_gstr2b.xlsx', purchase: '/demo-samples/multistate/s2_purchase.xlsx', debit: '/demo-samples/multistate/s2_debit.xlsx' },
];

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Fetch a bundled sample URL and turn it into a File the upload slots accept. */
export async function urlToFile(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sample fetch failed: ${url}`);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || XLSX_MIME });
}

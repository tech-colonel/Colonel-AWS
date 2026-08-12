/* ── Colonel AI — curated per-screen help KB (no LLM, no DB) ─────────────────
   A tiny, versioned map: screen (agentType / route) → a short how-to blurb +
   2-3 suggested prompts. The blurb is spliced into the system prompt ONLY when
   the pre-gate heuristic classifies a message as `app_help` (see ../router),
   so it stays cheap on tokens. Suggestions feed the chips above the input.

   Keys are the authoritative agent_type values from services/agentSlots.js.
   Content is intentionally short (<~1200 chars) and uses the exact UI
   vocabulary users see ("From Google Drive", "Run", "Download Excel",
   "Open in Google Sheets", "Add another state").                              */

// Shared how-to steps every reco/upload agent follows.
const runSteps = (files) => `**How to run this tool**
1. Pick your **brand** at the top of the screen.
2. Provide the files — either **drag & drop / upload** them, or use the **From Google Drive** section: paste a Drive **folder or file link** and the system auto-matches each file to its slot; review the mapping and click **Use these files**.
3. Click **Run**. When it finishes, the result dashboard appears and you can **Download Excel** or **Open in Google Sheets** (no re-download needed).

**Files this tool needs:** ${files}

**Drive link not fetching?** The folder/file must be shared as **Anyone with the link → Viewer** (or shared with our service account). Set that in Google Drive, then paste the link again. Also check the file is a real .xlsx/.xls/.csv (or .pdf where supported), not a shortcut.`;

// Default suggestions for a reconciliation/upload screen.
const RECO_SUGGESTIONS = [
  'How do I use this tool?',
  'How do I paste a Drive link?',
  'Why is my file not fetching?',
];

// Suggestions when a result is already on screen.
const RESULT_SUGGESTIONS = [
  'Summarize this run',
  'Why are there so many issues?',
  'Which vendors cause the most issues?',
];

// Colonel AI page / generic default.
const DEFAULT_SUGGESTIONS = [
  'How do I run a reconciliation?',
  'Which of my brands has the most reco issues?',
  'What is RCM under GST?',
];

// Per-agent: title + the file list spliced into the shared steps.
const AGENTS = {
  gstr_2b_vs_purchase: { title: 'GSTR-2B vs Purchase', files: 'GSTR-2B file, Purchase Register.' },
  gstr_2a_vs_2b_vs_books: { title: 'GSTR-2A vs 2B vs Books (3-way)', files: 'GSTR-2B file, Purchase Register, Debit Note Register.' },
  gstr_2b_books: { title: 'GSTR-2B vs Books', files: 'GSTR-2B file, Purchase Register, Debit Note Register.' },
  gstr_2b_books_multistate: {
    title: 'GSTR-2B vs Books (Multi-State)',
    files: 'per state — GSTR-2B, Purchase Register, and (optional) Debit Note. Paste ONE Drive folder holding every state\'s files and they are grouped by the GSTIN state code (first 2 digits) / state name in each filename; or use **Add another state** to upload manually.',
  },
  gstr_3b_vs_2b: { title: 'GSTR-3B vs GSTR-2B', files: 'GSTR-3B working file, GSTR-2B file.' },
  gstr_1_vs_books: { title: 'GSTR-1 vs Books', files: 'Tally Sales Register, GSTR-1 OCTA report; optional GSTR-1 PDF and Credit Note Register.' },
  einvoice_reco: { title: 'E-Invoice Reconciliation', files: 'E-Invoice Register, and Books — Combined (Sales + Credit Note).' },
  einvoice_extract: { title: 'E-Invoice Extraction', files: 'GST e-invoice PDFs (upload several, or paste a Google Drive folder) — each is parsed into the standard 3-sheet e-Invoice Register (Invoice Details + HSN summary + B2B summary), downloadable as Excel or opened in Google Sheets. It only accepts real GST e-invoices (with an IRN); other PDFs are flagged.' },
  bank_statement: { title: 'Bank Statement Classifier', files: 'the bank statement (.xlsx/.xls/.csv).' },
  universal_bank_statement: { title: 'Universal Bank Statement', files: 'the bank statement (.xlsx/.xls/.csv/.pdf); optional Ledger Master / chart of accounts, which is saved for next time.' },
  gstr_3b_tally_entry: { title: 'GSTR-3B Tally Entry', files: 'the GSTR-3B file — it is parsed into ready-to-post Tally journal entries.' },
  receivable_cycle: { title: 'Receivables / Order Cycle', files: 'the marketplace settlement / receivables files for the brand.' },
  bank_tally_reco: { title: 'Bank vs Tally Reco', files: 'the Tally daybook and the bank/Universal output to match against it.' },
  credit_card_booking: { title: 'Credit Card Booking', files: 'the credit-card statement (.pdf/.xlsx/.xls) — converted into Tally entries.' },
  pdf_bank_extract: { title: 'PDF → Bank Statement', files: 'the bank statement **PDF** — it is extracted into a clean tabular bank statement.' },
};

// A couple of shared how-to topics answerable without an agent context.
const TOPICS = {
  drive: `**Using a Google Drive link:** in the **From Google Drive** section, paste a **folder or file link**. First make sure the item is shared as **Anyone with the link → Viewer** (or shared with our service account) — otherwise it can't be read. The system reads the folder, auto-matches each file to its slot, and shows you the mapping to confirm before anything runs.`,
  sheets: `**Open in Google Sheets:** after a run, use the **Open in Google Sheets** button next to **Download Excel** to open the output directly as a Google Sheet — no need to download and re-upload.`,
};

/**
 * getHelp — returns the curated help for the current screen.
 * @param {{route?:string, agentType?:string, hasResult?:boolean}} ctx
 * @returns {{ title:string, blurb:string, suggestions:string[] }}
 */
function getHelp(ctx = {}) {
  const { agentType, hasResult } = ctx || {};
  const agent = agentType && AGENTS[agentType];

  if (agent) {
    return {
      title: agent.title,
      blurb: `**${agent.title}**\n\n${runSteps(agent.files)}\n\n${TOPICS.sheets}`,
      suggestions: hasResult ? RESULT_SUGGESTIONS : RECO_SUGGESTIONS,
    };
  }

  // Colonel AI page / unknown screen — general guidance.
  return {
    title: 'Colonel AI',
    blurb: `**Colonel AI** helps you across all your brands and agents.\n\n- To **run a reconciliation**: open the agent (e.g. GSTR-2B vs Books), pick the brand, upload files or paste a **Google Drive** link, then **Run** — the result opens with **Download Excel** and **Open in Google Sheets**.\n- Ask about **your data** (e.g. "why are there 466 issues in the last run?"), **how to use a tool**, or **Indian finance** (GST, TDS, ITC, RCM).\n\n${TOPICS.drive}`,
    suggestions: hasResult ? RESULT_SUGGESTIONS : DEFAULT_SUGGESTIONS,
  };
}

module.exports = { getHelp, RECO_SUGGESTIONS, RESULT_SUGGESTIONS, DEFAULT_SUGGESTIONS };

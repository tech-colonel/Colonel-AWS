/**
 * 01-reco-agents.js
 *
 * RECO-delta seeder — adds the 4 reconciliation agents and assigns them to
 * every brand already in colonel-master. Safe to run on an existing DB that
 * already has users, brands, and marketplace agents.
 *
 * Idempotent: all inserts use ON CONFLICT DO NOTHING (ignoreDuplicates: true).
 */

const RECO_AGENTS = [
  {
    id: '4e02cc5b-8fc8-4c79-8013-e7f510c850d5',
    name: 'gstr_2b_books',
    description: 'GSTR-2B vs Purchase Register + Debit Note Register reconciliation',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '855fe095-84c6-4947-a5e4-a73da83b2fd6',
    name: 'gstr_2b_books_multistate',
    description: 'GSTR-2B vs Books for multi-state brands — detects cross-state booking errors',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'b2d3fad4-0d90-4b49-acdc-d243cfa9c8d5',
    name: 'gstr_3b_tally_entry',
    description: 'Parse GSTR-3B and generate ready-to-post Tally journal entries',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '93d027ac-4333-403b-b448-9c637ebfc13c',
    name: 'universal_bank_statement',
    description: 'Brand-agnostic bank statement classifier mapped to Tally chart of accounts',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '8b8d0876-3169-4511-96d8-2a7467478007',
    name: 'gstr_1_vs_books',
    description: 'GSTR-1 outward supplies vs Tally Sales Register + Amazon books reconciliation',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '974ac4f2-1437-4ccc-826c-c2ea68e5b5e3',
    name: 'pdf_bank_extract',
    description: 'Convert any Indian bank statement PDF (HDFC, ICICI, SBI, Axis, Kotak) to Excel with Check Point validation columns',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'b2300af8-26d0-4299-b233-0cd48c2b96ec',
    name: 'amazon_mtr_consolidator',
    description: 'Consolidate Amazon B2B & B2C Merchant Tax Reports from all resellers into one workbook with Vendor Name + Month columns',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'ebcc3f8c-3e05-4132-860c-70e63b2380f1',
    name: 'zepto_receivables',
    description: 'Zepto receivables tracker — reads a Google Drive folder (Tally + Zepto files), reconciles per-invoice, outputs the Invoice Tracker with live formulas',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    // Superset UUID ...008 (matches AWS agents table; zepto_receivables moved to ...010)
    id: 'dcb5d5e9-9857-4925-b55d-b581bd6dec1e',
    name: 'einvoice_reco',
    description: 'E-Invoice Register (B2B/SEZ/DE + CDNR) vs Books (Sales + Credit Note) reconciliation',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '97702640-9642-4278-b34a-d1af684006ce',
    name: 'receivable_cycle',
    description: 'Receivable Cycle — Combine Tally GST + Sales Order Combine + courier COD settlement (Delhivery/Ekart/Xpressbees) + combined SRN report reconciled into a Main Sheet + per-courier COD sheets',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '290c797b-ec07-4caa-984f-45935e5c6b2a',
    name: 'bank_tally_reco',
    description: 'Bank Reco — reconcile Tally bank-ledger daybook vs Universal Bank Statement output (match, clearing-date update, ready-to-paste)',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

module.exports = {
  async up(queryInterface) {
    // Step 1: Insert the 4 RECO agents.
    // ignoreDuplicates: true = ON CONFLICT DO NOTHING on both id and name unique constraints.
    await queryInterface.bulkInsert('agents', RECO_AGENTS, { ignoreDuplicates: true });
    console.log('  [SEED] agents — RECO agents inserted (or already present)');

    // Step 2: Assign all 4 RECO agents to every brand in the DB.
    // Uses CROSS JOIN so it works regardless of what brand UUIDs the target DB has —
    // no hardcoded brand IDs. ON CONFLICT DO NOTHING skips already-assigned pairs.
    await queryInterface.sequelize.query(`
      INSERT INTO brand_agents (id, brand_id, agent_id, "createdAt", "updatedAt")
      SELECT
        gen_random_uuid(),
        b.id,
        a.id,
        NOW(),
        NOW()
      FROM brands b
      CROSS JOIN agents a
      WHERE a.name IN (
        'gstr_2b_books',
        'gstr_2b_books_multistate',
        'gstr_1_vs_books',
        'gstr_3b_tally_entry',
        'universal_bank_statement',
        'amazon_mtr_consolidator',
        'pdf_bank_extract',
        'zepto_receivables',
        'einvoice_reco',
        'receivable_cycle',
        'bank_tally_reco'
      )
      ON CONFLICT DO NOTHING
    `);
    console.log('  [SEED] brand_agents — RECO agents assigned to all brands');
  },
};

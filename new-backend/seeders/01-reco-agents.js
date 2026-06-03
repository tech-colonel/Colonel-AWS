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
    id: 'd0000000-0000-0000-0000-000000000001',
    name: 'gstr_2b_books',
    description: 'GSTR-2B vs Purchase Register + Debit Note Register reconciliation',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'd0000000-0000-0000-0000-000000000002',
    name: 'gstr_2b_books_multistate',
    description: 'GSTR-2B vs Books for multi-state brands — detects cross-state booking errors',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'd0000000-0000-0000-0000-000000000003',
    name: 'gstr_3b_tally_entry',
    description: 'Parse GSTR-3B and generate ready-to-post Tally journal entries',
    columns: JSON.stringify([]),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'd0000000-0000-0000-0000-000000000004',
    name: 'universal_bank_statement',
    description: 'Brand-agnostic bank statement classifier mapped to Tally chart of accounts',
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
    console.log('  [SEED] agents — 4 RECO agents inserted (or already present)');

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
        'gstr_3b_tally_entry',
        'universal_bank_statement'
      )
      ON CONFLICT DO NOTHING
    `);
    console.log('  [SEED] brand_agents — RECO agents assigned to all brands');
  },
};

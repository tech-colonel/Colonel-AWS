/**
 * 02-order-cycle-agent.js
 *
 * Order-Cycle delta seeder — adds the Shopify-Order-Cycle agent and assigns it
 * to every brand already in colonel-master. Safe to run on an existing DB
 * (e.g. AWS) that already has users, brands, RECO + marketplace agents.
 *
 * Idempotent: agent insert uses ON CONFLICT DO NOTHING; brand_agents uses a
 * CROSS JOIN + ON CONFLICT DO NOTHING so it never duplicates assignments.
 *
 * The `columns` JSONB below is the EXACT definition from port-3000 — the
 * backend's getDynamicModel() uses it to auto-create the per-brand
 * `shopify_order_cycle` table on first run. Do not trim it.
 *
 * UUID matches port-3000 (683e7953-…) so both environments stay identical.
 */

const ORDER_CYCLE_COLUMNS = [
  { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },
  { name: 'year', type: 'INTEGER' },
  { name: 'month', type: 'INTEGER' },
  { name: 'date', type: 'DATE' },
  { name: 'filename', type: 'STRING' },
  { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },
  { name: 'sale_order_number', type: 'STRING' },
  { name: 'platform', type: 'STRING' },
  { name: 'invoice_number', type: 'STRING' },
  { name: 'awb_number', type: 'STRING' },
  { name: 'shipping_partner', type: 'STRING' },
  { name: 'dispatch_or_cancellation_date', type: 'DATE' },
  { name: 'return_date', type: 'DATE' },
  { name: 'total_amount', type: 'DECIMAL' },
  { name: 'return_amount', type: 'DECIMAL' },
  { name: 'net_amount', type: 'DECIMAL' },
  { name: 'srn', type: 'STRING' },
  { name: 'ekart_remittance_date', type: 'DATE' },
  { name: 'ekart_actual_remittance_date', type: 'DATE' },
  { name: 'ekart_cod_amount', type: 'DECIMAL' },
  { name: 'delhivery_delivery_date', type: 'DATE' },
  { name: 'delhivery_cod_amount', type: 'DECIMAL' },
  { name: 'xpressbees_delivery_date', type: 'DATE' },
  { name: 'xpressbees_transaction_date', type: 'DATE' },
  { name: 'xpressbees_net_payment', type: 'DECIMAL' },
  { name: 'snapmint_settlement_date', type: 'DATE' },
  { name: 'snapmint_settlement_value', type: 'DECIMAL' },
  { name: 'bharatx_settlement_timestamp', type: 'DATE' },
  { name: 'bharatx_ledger_amount', type: 'DECIMAL' },
  { name: 'razorpay_settlement_date', type: 'DATE' },
  { name: 'razorpay_settlement_amount', type: 'DECIMAL' },
  { name: 'delivery_status', type: 'STRING' },
  { name: 'total_settlement_received', type: 'DECIMAL' },
  { name: 'balance_amount_receivable', type: 'DECIMAL' },
  { name: 'reconciliation_status', type: 'STRING' },
];

const ORDER_CYCLE_AGENT = {
  id: '683e7953-db02-4ebf-aa3e-49fdd0c25d1a',
  name: 'Shopify-Order-Cycle',
  description:
    'Tracks Shopify order lifecycle including dispatch, returns, and payment settlements across partners',
  columns: JSON.stringify(ORDER_CYCLE_COLUMNS),
  createdAt: new Date(),
  updatedAt: new Date(),
};

module.exports = {
  async up(queryInterface) {
    // Step 1: insert the Shopify-Order-Cycle agent (skips if id/name already present).
    await queryInterface.bulkInsert('agents', [ORDER_CYCLE_AGENT], { ignoreDuplicates: true });
    console.log('  [SEED] agents — Shopify-Order-Cycle inserted (or already present)');

    // Step 2: assign it to every brand. CROSS JOIN = no hardcoded brand UUIDs;
    // ON CONFLICT DO NOTHING skips brands that already have it.
    await queryInterface.sequelize.query(`
      INSERT INTO brand_agents (id, brand_id, agent_id, "createdAt", "updatedAt")
      SELECT gen_random_uuid(), b.id, a.id, NOW(), NOW()
      FROM brands b
      CROSS JOIN agents a
      WHERE a.name = 'Shopify-Order-Cycle'
      ON CONFLICT DO NOTHING
    `);
    console.log('  [SEED] brand_agents — Shopify-Order-Cycle assigned to all brands');
  },
};

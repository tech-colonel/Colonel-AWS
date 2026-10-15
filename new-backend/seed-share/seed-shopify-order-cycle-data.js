/* Seed the Shopify-Order-Cycle agent with its data.
 *
 *   node seed-share/seed-shopify-order-cycle-data.js            (from new-backend/)
 *   node seed-share/seed-shopify-order-cycle-data.js --replace  (overwrite existing rows)
 *
 * Loads: the agent row, its assignment to Flo Mattress and Amama, the
 * shopify_order_cycle table (66,571 rows) and the generated workbook the Flo
 * Mattress rows point at. See README.md in this folder. */
const fs = require('fs');
const path = require('path');
const lib = require('./_seed-lib');

const BRANDS = [
  { id: '00cd57b9-25e4-4f3c-8abb-69e50a691a3d', name: 'Flo Mattress', description: 'Flo Mattress brand', db_name: 'colonel_flo_mattress' },
  { id: '643045cb-c996-41bf-b611-fed387772c5c', name: 'Amama', description: 'Amama brand', db_name: 'colonel_amama' },
];

const AGENT = {
  name: 'Shopify-Order-Cycle',
  description: 'Tracks Shopify order lifecycle including dispatch, returns, and payment settlements across partners',
  columns: [
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
  ],
};

const DDL = [
  `CREATE TABLE IF NOT EXISTS shopify_order_cycle (
     id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     brand_id                      uuid NOT NULL DEFAULT NULLIF(current_setting('app.brand_id', true), '')::uuid,
     month                         integer,
     year                          integer,
     file_type                     varchar(255),
     inventory_type                varchar(255),
     filename                      varchar(255),
     created_at                    timestamptz,
     date                          timestamptz,
     sale_order_number             varchar(255),
     platform                      varchar(255),
     invoice_number                varchar(255),
     awb_number                    varchar(255),
     shipping_partner              varchar(255),
     dispatch_or_cancellation_date timestamptz,
     return_date                   timestamptz,
     total_amount                  numeric,
     return_amount                 numeric,
     net_amount                    numeric,
     srn                           varchar(255),
     ekart_remittance_date         timestamptz,
     ekart_actual_remittance_date  timestamptz,
     ekart_cod_amount              numeric,
     delhivery_delivery_date       timestamptz,
     delhivery_cod_amount          numeric,
     xpressbees_delivery_date      timestamptz,
     xpressbees_transaction_date   timestamptz,
     xpressbees_net_payment        numeric,
     snapmint_settlement_date      timestamptz,
     snapmint_settlement_value     numeric,
     bharatx_settlement_timestamp  timestamptz,
     bharatx_ledger_amount         numeric,
     razorpay_settlement_date      timestamptz,
     razorpay_settlement_amount    numeric,
     delivery_status               varchar(255),
     total_settlement_received     numeric,
     balance_amount_receivable     numeric,
     reconciliation_status         varchar(255),
     created_by                    uuid
   )`,
  'CREATE INDEX IF NOT EXISTS shopify_order_cycle_brand_idx ON shopify_order_cycle (brand_id)',
  'CREATE INDEX IF NOT EXISTS idx_shopify_order_cycle_filename ON shopify_order_cycle (filename)',
];

/* The Flo Mattress rows all carry this filename; the Download button serves it
   from new-backend/outputs/. */
const WORKBOOK = 'order_cycle_shopify_Flo Mattress_October_2026_49db009b-fef3-467f-ad68-0adf0b3c18bf.xlsx';

lib.run('Shopify-Order-Cycle data seed', async (client) => {
  const brandMap = await lib.resolveBrands(client, BRANDS);
  const brandIds = Object.values(brandMap);
  await lib.ensureAgent(client, AGENT, brandIds);
  await lib.ensureTable(client, 'shopify_order_cycle', DDL);
  await lib.clearOrRefuse(client, ['shopify_order_cycle'], brandIds);

  /* created_by points at a user of the machine this was exported from */
  await lib.loadTable(client, 'shopify_order_cycle', 'shopify_order_cycle.ndjson.gz', brandMap,
    { nullColumns: ['created_by'] });

  const outputs = path.resolve(__dirname, '../outputs');
  const dest = path.join(outputs, WORKBOOK);
  fs.mkdirSync(outputs, { recursive: true });
  if (fs.existsSync(dest)) {
    console.log('[FILE] workbook already in outputs/ — left as is');
  } else {
    fs.copyFileSync(path.join(lib.DATA_DIR, WORKBOOK), dest);
    console.log('[FILE] workbook copied to outputs/');
  }
});

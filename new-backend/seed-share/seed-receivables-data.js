/* Seed the Receivable Cycle agent (the Receivables dashboard) with its data.
 *
 *   node seed-share/seed-receivables-data.js            (from new-backend/)
 *   node seed-share/seed-receivables-data.js --replace  (overwrite existing rows)
 *
 * Loads: the agent row, its assignment to Flo Mattress and Amama, and three
 * tables — receivable_ledger (235,827 rows, one per order: what the dashboard
 * reads), receivable_ledger_unmatched (27,803) and receivable_cycle_imports
 * (427,982 raw source-file rows: the sheet browser, and the input that
 * scripts/buildReceivableLedger.js rebuilds the ledger from).
 * See README.md in this folder. */
const lib = require('./_seed-lib');

const BRANDS = [
  { id: '00cd57b9-25e4-4f3c-8abb-69e50a691a3d', name: 'Flo Mattress', description: 'Flo Mattress brand', db_name: 'colonel_flo_mattress' },
  { id: '643045cb-c996-41bf-b611-fed387772c5c', name: 'Amama', description: 'Amama brand', db_name: 'colonel_amama' },
];

const AGENT = {
  name: 'receivable_cycle',
  description: 'Receivable Cycle — Combine Tally GST + Sales Order Combine + courier COD settlement '
    + '(Delhivery/Ekart/Xpressbees) + combined SRN report reconciled into a Main Sheet + per-courier COD sheets',
  columns: [],
};

const BRAND_ID = 'uuid NOT NULL DEFAULT NULLIF(current_setting(\'app.brand_id\', true), \'\')::uuid';

const TABLES = [
  {
    name: 'receivable_ledger',
    file: 'receivable_ledger.ndjson.gz',
    ddl: [
      `CREATE TABLE IF NOT EXISTS receivable_ledger (
         id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         brand_id                      ${BRAND_ID},
         awb                           varchar(64) NOT NULL DEFAULT '',
         invoice_key                   varchar(64) NOT NULL DEFAULT '',
         invoice_number                varchar(64),
         sale_order_number             varchar(64),
         order_date                    date,
         order_month                   integer NOT NULL,
         order_year                    integer NOT NULL,
         payment_method                varchar(16) NOT NULL,
         courier                       varchar(32) NOT NULL DEFAULT '',
         total_amount                  numeric(14,2) NOT NULL DEFAULT 0,
         settled_flag                  boolean NOT NULL DEFAULT false,
         settled_amount                numeric(14,2),
         settled_month                 integer,
         settled_year                  integer,
         settled_source                varchar(32),
         returned_flag                 boolean NOT NULL DEFAULT false,
         returned_amount               numeric(14,2),
         returned_month                integer,
         returned_year                 integer,
         source_file                   varchar(255),
         created_at                    timestamptz DEFAULT now(),
         updated_at                    timestamptz DEFAULT now(),
         channel                       varchar(64) NOT NULL DEFAULT '',
         delivery_status               varchar(32),
         dispatch_or_cancellation_date timestamptz,
         return_date                   timestamptz,
         settled_date                  timestamptz,
         srn                           varchar(255)
       )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS receivable_ledger_awb_uidx ON receivable_ledger (brand_id, awb) WHERE awb <> \'\'',
      'CREATE UNIQUE INDEX IF NOT EXISTS receivable_ledger_invoice_uidx ON receivable_ledger (brand_id, invoice_key) WHERE awb = \'\' AND invoice_key <> \'\'',
      'CREATE INDEX IF NOT EXISTS receivable_ledger_channel_idx ON receivable_ledger (brand_id, channel)',
      'CREATE INDEX IF NOT EXISTS receivable_ledger_delivery_status_idx ON receivable_ledger (brand_id, delivery_status)',
      'CREATE INDEX IF NOT EXISTS receivable_ledger_order_month_idx ON receivable_ledger (brand_id, order_year, order_month)',
      'CREATE INDEX IF NOT EXISTS receivable_ledger_returned_month_idx ON receivable_ledger (brand_id, returned_year, returned_month)',
      'CREATE INDEX IF NOT EXISTS receivable_ledger_settled_month_idx ON receivable_ledger (brand_id, settled_year, settled_month)',
    ],
  },
  {
    name: 'receivable_ledger_unmatched',
    file: 'receivable_ledger_unmatched.ndjson.gz',
    ddl: [
      `CREATE TABLE IF NOT EXISTS receivable_ledger_unmatched (
         id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         brand_id    ${BRAND_ID},
         match_key   varchar(64) NOT NULL,
         source      varchar(32) NOT NULL,
         amount      numeric(14,2),
         source_file varchar(255),
         created_at  timestamptz DEFAULT now()
       )`,
      'CREATE INDEX IF NOT EXISTS receivable_ledger_unmatched_brand_idx ON receivable_ledger_unmatched (brand_id, source)',
    ],
  },
  {
    name: 'receivable_cycle_imports',
    file: 'receivable_cycle_imports.ndjson.gz',
    ddl: [
      `CREATE TABLE IF NOT EXISTS receivable_cycle_imports (
         id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         brand_id    ${BRAND_ID},
         source_file varchar(255) NOT NULL,
         sheet_name  varchar(64) NOT NULL,
         row_index   integer NOT NULL,
         row_data    json NOT NULL,
         created_at  timestamptz DEFAULT now(),
         role        varchar(16)
       )`,
      'CREATE INDEX IF NOT EXISTS receivable_cycle_imports_brand_role_idx ON receivable_cycle_imports (brand_id, role)',
      'CREATE INDEX IF NOT EXISTS receivable_cycle_imports_brand_source_idx ON receivable_cycle_imports (brand_id, source_file, sheet_name)',
    ],
  },
];

lib.run('Receivable Cycle data seed', async (client) => {
  const brandMap = await lib.resolveBrands(client, BRANDS);
  const brandIds = Object.values(brandMap);
  await lib.ensureAgent(client, AGENT, brandIds);
  for (const t of TABLES) await lib.ensureTable(client, t.name, t.ddl);
  await lib.clearOrRefuse(client, TABLES.map(t => t.name), brandIds);
  for (const t of TABLES) await lib.loadTable(client, t.name, t.file, brandMap);
});

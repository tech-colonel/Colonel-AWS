/* Shared plumbing for the two data seeders in this folder. Not run directly.
 *
 * Each seeder hands this a list of brands, one agent, the DDL for its tables and
 * the gzipped NDJSON file behind each table. Rows were exported with
 * row_to_json(), one per line, sorted by brand_id; they go back in through
 * json_populate_recordset(), so the target table's own column types do the
 * casting and a column the target lacks is simply ignored. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { Client } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const DATA_DIR = path.join(__dirname, 'data');
const BATCH = 1000;
const ARGS = new Set(process.argv.slice(2));
const REPLACE = ARGS.has('--replace');

const connect = async () => {
  const database = process.env.USE_UNIFIED_DB === 'false'
    ? null
    : (process.env.UNIFIED_DB_NAME || 'colonel_agent_accountant');
  if (!database) {
    throw new Error('These seeders target the unified DB. Remove USE_UNIFIED_DB=false from .env and re-run.');
  }
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
  });
  await client.connect();
  console.log(`[DB] connected to ${database} as ${process.env.DB_USER}`);
  return client;
};

/* Find each source brand in the target by name; create it with its original id
   when it is not there. Returns { sourceBrandId: targetBrandId }. */
const resolveBrands = async (client, brands) => {
  const map = {};
  for (const b of brands) {
    const { rows } = await client.query('SELECT id FROM brands WHERE lower(name) = lower($1)', [b.name]);
    if (rows.length) {
      map[b.id] = rows[0].id;
      console.log(`[BRAND] ${b.name} found (${rows[0].id})${rows[0].id === b.id ? '' : ' — rows will be re-tagged to this id'}`);
    } else {
      await client.query(
        'INSERT INTO brands (id, name, description, db_name) VALUES ($1, $2, $3, $4)',
        [b.id, b.name, b.description, b.db_name]);
      map[b.id] = b.id;
      console.log(`[BRAND] ${b.name} created (${b.id})`);
    }
  }
  return map;
};

/* Make sure the agent exists and is assigned to every seeded brand. An agent
   that is already there keeps its own id and columns. */
const ensureAgent = async (client, agent, brandIds) => {
  let { rows } = await client.query('SELECT id FROM agents WHERE name = $1', [agent.name]);
  if (!rows.length) {
    ({ rows } = await client.query(
      'INSERT INTO agents (name, description, columns) VALUES ($1, $2, $3::jsonb) RETURNING id',
      [agent.name, agent.description, JSON.stringify(agent.columns)]));
    console.log(`[AGENT] ${agent.name} created (${rows[0].id})`);
  } else {
    console.log(`[AGENT] ${agent.name} found (${rows[0].id})`);
  }
  for (const brandId of brandIds) {
    await client.query(
      'INSERT INTO brand_agents (brand_id, agent_id) VALUES ($1, $2) ON CONFLICT (brand_id, agent_id) DO NOTHING',
      [brandId, rows[0].id]);
  }
  return rows[0].id;
};

/* Create the table if it is missing, with the same row-level security and
   app-role grants the app expects. Every statement is idempotent. */
const ensureTable = async (client, table, ddl) => {
  for (const stmt of ddl) await client.query(stmt);
  await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  const { rows } = await client.query(
    'SELECT 1 FROM pg_policies WHERE schemaname = \'public\' AND tablename = $1', [table]);
  if (!rows.length) {
    await client.query(
      `CREATE POLICY ${table}_tenant_isolation ON ${table}
         USING (brand_id::text = current_setting('app.brand_id', true))
         WITH CHECK (brand_id::text = current_setting('app.brand_id', true))`);
  }
  const appRole = process.env.DB_APP_USER || 'colonel_app';
  const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appRole]);
  if (role.rows.length) {
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO "${appRole}"`);
  } else {
    console.log(`[WARN] role ${appRole} does not exist — run db-seed/restore.sh first, or the app cannot read ${table}`);
  }
};

/* Rows already held for the seeded brands. Without --replace their presence
   stops the run; with it they are deleted so the seed lands on a clean slate. */
const clearOrRefuse = async (client, tables, brandIds) => {
  const held = [];
  for (const t of tables) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM ${t} WHERE brand_id = ANY($1::uuid[])`, [brandIds]);
    if (rows[0].n) held.push({ t, n: rows[0].n });
  }
  if (!held.length) return;
  if (!REPLACE) {
    const list = held.map(h => `${h.t} (${h.n} rows)`).join(', ');
    throw new Error(
      `The seeded brands already have data in: ${list}.\n`
      + '       Re-run with --replace to delete those rows and load the seed in their place.');
  }
  for (const h of held) {
    await client.query(`DELETE FROM ${h.t} WHERE brand_id = ANY($1::uuid[])`, [brandIds]);
    console.log(`[REPLACE] ${h.t}: removed ${h.n} existing rows`);
  }
};

const BRAND_RE = /"brand_id":"([0-9a-f-]{36})"/;

/* Stream one gzipped NDJSON file into its table. Each batch is one transaction
   with app.brand_id set, so it passes row-level security whether DB_USER is a
   superuser or not. */
const loadTable = async (client, table, file, brandMap, { nullColumns = [] } = {}) => {
  const full = path.join(DATA_DIR, file);
  if (!fs.existsSync(full)) throw new Error(`Data file missing: ${full}`);
  const nullRes = nullColumns.map(c => new RegExp(`"${c}":"[^"]*"`));
  const rl = readline.createInterface({ input: fs.createReadStream(full).pipe(zlib.createGunzip()), crlfDelay: Infinity });

  let batch = [];
  let batchBrand = null;
  let total = 0;
  const started = Date.now();

  const flush = async () => {
    if (!batch.length) return;
    await client.query('BEGIN');
    try {
      await client.query('SELECT set_config(\'app.brand_id\', $1, true)', [batchBrand]);
      await client.query(
        `INSERT INTO ${table} SELECT * FROM json_populate_recordset(null::${table}, $1::json)`,
        [`[${batch.join(',')}]`]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
    total += batch.length;
    batch = [];
    if (total % 20000 === 0) process.stdout.write(`\r[LOAD] ${table}: ${total} rows`);
  };

  for await (let line of rl) {
    if (!line) continue;
    const m = BRAND_RE.exec(line);
    if (!m) throw new Error(`${file}: row without a brand_id`);
    const target = brandMap[m[1]];
    if (!target) throw new Error(`${file}: row for brand ${m[1]}, which this seeder does not know`);
    if (target !== m[1]) line = line.replace(BRAND_RE, `"brand_id":"${target}"`);
    for (const re of nullRes) line = line.replace(re, m0 => `${m0.slice(0, m0.indexOf(':'))}:null`);
    if (batch.length >= BATCH || (batchBrand && batchBrand !== target)) await flush();
    batchBrand = target;
    batch.push(line);
  }
  await flush();
  console.log(`\r[LOAD] ${table}: ${total} rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return total;
};

const run = async (title, body) => {
  console.log(`\n=== ${title} ===`);
  let client;
  try {
    client = await connect();
    await body(client);
    console.log('Done.\n');
    await client.end();
    process.exit(0);
  } catch (e) {
    console.error(`\n[ERROR] ${e.message}`);
    if (client) await client.end().catch(() => {});
    process.exit(1);
  }
};

module.exports = { DATA_DIR, run, resolveBrands, ensureAgent, ensureTable, clearOrRefuse, loadTable };

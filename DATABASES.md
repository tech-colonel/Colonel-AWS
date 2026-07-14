# 🗄️ DATABASES.md — PostgreSQL Schema & Persistence (Unified DB)

> Deep-dive companion for the **live `colonel-automation` app** (port 3000 / backend 8001) served on
> AWS EC2 → ngrok. Unified single-DB layout, models, migrations, RLS, idempotency, and the persistence flow.
>
> Cross-refs: [README.md](README.md) · [CLAUDE.md](CLAUDE.md) · [AWS.md](AWS.md) (EC2 / deploy / crons) ·
> [SERVERS.md](SERVERS.md) (ports & restart) · [RECO.md](RECO.md) (reco result flow) · [ARCHITECTURE.md](ARCHITECTURE.md).
>
> ⚠️ This is the **production superset**, ahead of the port-3001 sandbox. It has **more brands, more
> agents, and more master tables** (Zoho, Compliance, Statutory, Plans, Integrations, Conversations,
> MCP) than the sandbox `DATABASES.md`. Where the two diverge is flagged below.

---

## Recent changes (unified migration)

The database was restructured from **one DB per brand** to a **single unified database**. If you last
read this doc before that migration, these are the load-bearing changes:

- **17 DBs → 1 unified DB.** All brands now share **`colonel_agent_accountant`** (was `colonel-master`
  + 16 per-brand DBs). Tenant isolation is a `brand_id` UUID column + PostgreSQL **Row-Level Security**
  keyed on `current_setting('app.brand_id')`, set per-connection. Unified is the **default**
  (`config/database.js` → `UNIFIED = process.env.USE_UNIFIED_DB !== 'false'`); legacy per-brand mode is
  an escape hatch (`USE_UNIFIED_DB=false`).
- **App connects as non-superuser `colonel_app`** so RLS actually enforces. Superuser `postgres` (used
  for migrations/admin) bypasses RLS natively. The old **client-settable `app.bypass_rls` GUC was
  removed** (RLS hardening `005`) — the `SET LOCAL app.bypass_rls='true'` bypass pattern no longer works;
  superuser bypass only.
- **Dynamic sales/agent tables now carry `brand_id`** (auto-stamped via column `DEFAULT
  NULLIF(current_setting('app.brand_id',true),'')::uuid`) plus RLS + `colonel_app` grants — they used to
  have no `brand_id` (brand was implicit = which DB).
- **Agent + brand IDs are random UUIDv4.** The old sequential `d0000000…`/`b0000000…`/`c0000000…`/
  `f0000000…` IDs were regenerated for security (mappings in `db-restructure/008-agent-id-remap.json` +
  `009-brand-id-remap.json`; on-disk COA files renamed to match).
- **Single seed dump = real AWS production data.** `db-seed/dumps/colonel_agent_accountant.dump`
  (replaces the 17 per-brand dumps). Restore with one command: `cd db-seed && ./restore.sh`.

---

## Database layout — one unified DB, brand-scoped by RLS

```
PostgreSQL :5432   (ONE DB: colonel_agent_accountant — ~64 tables total)
│
│  Master / org / cross-brand tables (NO RLS — shared, accessed as superuser postgres)
│   │  (ORM, master/index.js + task/index.js)
│   ├── users            ├── brands            ├── agents
│   ├── brand_users      ├── brand_agents      ├── agent_workflows
│   ├── plans            ├── integrations      ├── conversations
│   ├── mcp_servers      ├── tasks             └── task_messages
│   │
│   │  (raw-SQL migrations, run on boot)
│   ├── zoho_organizations · zoho_accounts · zoho_contacts · zoho_items
│   │   · zoho_vouchers · zoho_bank_accounts · zoho_bank_transactions · zoho_sync_log   (zohoMigrate.js)
│   ├── compliance_categories · compliance_tasks · compliance_attachments
│   │   · compliance_chat_messages                                                       (complianceMigrate.js)
│   └── statutory_filings                                                                (statutoryMigrate.js)
│
│  Brand-scoped tables (each has a brand_id UUID column + RLS keyed on app.brand_id)
│   ├── reco_jobs                       ← 1 row per reco/agent run  (ADMIN ANALYTICS FEED)
│   ├── bank_reco_results · bank_reco_corrections
│   ├── gstr_2b_results · gstr_2a_2b_results · gstr_3b_results · gstr_1_results
│   ├── gstr_3b_tally_results · gstr3b_* (coa_master/vt_master/runs)
│   ├── ledger_master                   ← DB-backed Chart of Accounts (per brand)
│   └── <dynamic per-agent sales tables>   ← month/year/file_type/… + brand_id (getDynamicModel + bulkCreate)
```

> **All brands share one database.** Tenant isolation is a `brand_id` UUID column on every brand-scoped
> table + **RLS** policies keyed on `current_setting('app.brand_id')`. The app connects as the
> non-superuser role **`colonel_app`** (each brand's connection presets `app.brand_id` via an
> `afterConnect` hook), so RLS scopes every read and `brand_id` auto-stamps on insert via a column
> `DEFAULT`. Superuser `postgres` (master/migration connection) bypasses RLS natively.

### Unified is the default; schema is pre-built

`config/database.js` → `UNIFIED = process.env.USE_UNIFIED_DB !== 'false'` — a fresh clone runs unified
with **no extra config**. In unified mode `createBrandDatabase()` + `migrateAllBrands()` are **no-ops**
(they log and return): the shared schema is pre-built by the `db-restructure/` SQL, applied in order —

```
schema_01_master.sql          master/org tables
schema_02_reco_gstr3b.sql     reco + gstr3b tables
002_dynamic_agent_tables.sql  dynamic sales/agent tables (+ brand_id)
003_gstr3b_rls.sql            RLS on gstr3b tables
004_app_role_and_defaults.sql colonel_app role + brand_id auto-stamp DEFAULTs
005_harden_rls.sql            drop the app.bypass_rls escape hatch; add WITH CHECK
```

Setting `USE_UNIFIED_DB=false` re-enables the legacy one-DB-per-brand path (`createBrandDatabase`,
`migrateAllBrands` → `001_reco_tables.sql` per brand DB). That path is an escape hatch, not used in
production. Zoho / Compliance / Statutory / Plans / Integrations tables (3000-native features) are
absent from the sandbox backend.

---

## Persistence flow — how a run reaches the DB

```
 recoController.js  (after Python engine / classify.py returns results)
   │  results.length > 0 && no error flag                (empty/failed runs never write)
   │  file_hash = sha256(all uploaded buffers)
   ▼
 findExistingJob()  ── inside sequelize.transaction() (brand connection presets app.brand_id → RLS scopes the read)
   │      (NULL-safe month/year via IS NOT DISTINCT FROM)
   ├── exists + data saved  → updateOutputFileId()  (update Excel pointer, return early)
   ├── exists but 0-row      → deleteJob() (CASCADE) → re-save fresh
   └── new                   → INSERT reco_jobs
                                   │  setImmediate() fire-and-forget (download never blocked)
                                   ▼
                              saveGstRecoResults() / bank save  ── per-row try/catch, toSqlDate() guard
                                   ▼
                              *_results rows
```

Sales / marketplace / invoice agents do **not** go through this path — they persist parsed rows into a
**dynamic per-brand table** (see below) and separately record ONE `reco_jobs` row via
`agentRunTracker.recordAgentRun()` so admin analytics count the run.

---

## Boot sequence (`new-backend/server.js`)

Migrations run automatically on every backend start — all idempotent, safe to re-run:

```
masterSequelize.authenticate()
  → ensureSchemaExtras()              // enum/column extras BEFORE sync so models line up
  → masterSequelize.sync({alter:false})
  → seedMasterAgents()                // idempotent RECO agent + brand_agents seed
  → migrateAllBrands()                // UNIFIED: no-op (shared schema pre-built by db-restructure SQL)
  → migrateZoho()                     // zoho_* tables in master
  → migrateCompliance()               // compliance_* tables in master
  → migrateStatutory()                // statutory_filings in master
  → app.listen(PORT)                  // 8001
```

In **unified mode** `migrateAllBrands()` / `migrateSingleBrand()` short-circuit (log + return) — the
shared schema is pre-built by the `db-restructure/` SQL and restored from the seed dump. In **legacy
mode** (`USE_UNIFIED_DB=false`) `migrate.js` fetches `SELECT db_name FROM brands` and runs
`001_reco_tables.sql` per DB inside a transaction, and `migrateSingleBrand()` does the same for one
brand when a new brand is created.

---

## Sequelize models (`new-backend/src/models/`)

| Subfolder | Models (table) | Notes |
|---|---|---|
| `master/index.js` | `User` (users), `Brand` (brands), `Agent` (agents), `BrandUser` (brand_users), `BrandAgent` (brand_agents), `AgentWorkflow` (agent_workflows), `Plan` (plans), `Integration` (integrations), `Conversation` (conversations), `McpServer` (mcp_servers) | all on `masterSequelize` |
| `task/index.js` | `Task` (tasks), `TaskMessage` (task_messages) + `syncTaskTables()` | tasks have `category` (`task`/`feedback`) + `source_meta` for the feedback loop |
| `brand/index.js` | factory helpers — `getBrandAgentModel` (brand_agents on the brand DB) + `getDynamicModel(sequelize, tableName, columns)` for dynamic per-upload sales tables | |
| `reco/index.js` | factory helpers — `getRecoJobModel` (reco_jobs), `getBankRecoResultModel` (bank_reco_results), `getGstr2bResultModel` (gstr_2b_results) | |

**Master ORM specifics worth knowing:**
- `User.role` enum = `admin | accountant | brand_executive | developer`.
- `Brand` has `db_name` (unique) + `drive_folder_id` (Google Drive source folder). In unified mode
  `db_name` no longer names a physical DB — it's the key the `afterConnect` hook uses to look up the
  brand's `app.brand_id` (`SELECT id FROM brands WHERE db_name = $1`).
- `Agent` has `columns` (JSONB) — drives the dynamic per-upload table shape.
- `Conversation` is strictly private to `user_id` (admins do NOT see others' Colonel-AI chats).
- `Integration` / `McpServer` are visual-connect registries (no live OAuth handshake in the model).

> ⚠️ Only **3 of the reco tables** are ORM-modeled (`reco_jobs`, `bank_reco_results`, `gstr_2b_results`).
> The other result tables are populated via **raw SQL** in the controllers, not the ORM.

### Per-brand sales/agent data tables (dynamic)

Sales / marketplace / invoice agents persist parsed rows into a **dynamic per-agent table** (shared DB,
brand-scoped by RLS) via `getDynamicModel(brandDb, tableName, agent.columns)` + `Model.bulkCreate(...)`
(unconditional — no save flag). `tableName = agent.name` lowercased, non-alphanumerics → `_` (e.g.
`Amazon`→`amazon`, `Sales-Amazon`→`sales_amazon`). Fixed columns: `id, month, year, file_type,
inventory_type, filename, created_at` + the agent's own data columns. `timestamps: false` (uses the
explicit `created_at`).

> ⚠️ **Gotchas (verified on AWS):**
> - **The GET read path calls `Model.sync({force:false})` — opening an agent workspace CREATES its
>   (empty) table.** So "table exists, 0 rows" = *opened but no file uploaded*, NOT a broken pipeline.
> - **Dynamic tables now carry `brand_id`** (auto-stamped via column `DEFAULT
>   NULLIF(current_setting('app.brand_id',true),'')::uuid`) + RLS + `colonel_app` grants (added by
>   `002_dynamic_agent_tables.sql`) — they used to have no `brand_id` (brand was implicit = which DB).
> - **No user attribution on this data**: dynamic tables still have **no `user_id` / `created_by`**.
>   User-wise attribution exists only on reco/agent runs, via `reco_jobs.created_by`.

### `agentRunTracker.recordAgentRun()` — the analytics bridge

`new-backend/src/services/agentRunTracker.js` writes **one `reco_jobs` row per successful sales/agent
commit** so admin dashboards (which read `reco_jobs`) show every run — who / when / which brand.
- Same RLS-bypass-in-transaction pattern as reco saves; **never throws** (logged + swallowed).
- `output_file_id` is `varchar(36)` — a long sales filename won't fit, so it stores the value only if
  `length <= 36`, else `NULL`. `matched_rows` / `unmatched_rows` are left NULL for sales runs.
- Does **not** touch agent tables or agent logic — a purely additive analytics write.

---

## Migration — `new-backend/src/db/migrations/001_reco_tables.sql`

> **Unified mode note:** these reco tables now live in the shared DB, pre-built by the `db-restructure/`
> SQL (`schema_02_reco_gstr3b.sql` etc.) and restored from the seed dump — each gains a `brand_id`
> column + RLS. `001_reco_tables.sql` below is the **legacy per-brand** migration, still used only when
> `USE_UNIFIED_DB=false`. The table set is otherwise the same.

Single, **idempotent** migration (`IF NOT EXISTS` / `OR REPLACE` / drop-before-create policies), run per
brand DB at boot via `migrate.js` → `migrateAllBrands()` before `app.listen()` (legacy path only).

**9 brand-scoped reco tables:**

| # | Table | Purpose |
|---|---|---|
| 1 | `reco_jobs` | one row per reco/agent run (agent_type, month/year, file_hash, row counts, output pointer, created_by) — **admin analytics feed** |
| 2 | `bank_reco_results` | classified bank statement rows (debit/credit/**balance**, ledger, confidence) |
| 3 | `gstr_2b_results` | GSTR-2B vs Books rows (supplier, GSTIN, invoice, tax, remark_1/2) |
| 4 | `gstr_2a_2b_results` | 3-way 2A/2B/Books rows |
| 5 | `gstr_3b_results` | 3B-vs-2B ITC rows (itc_type, claimed/available/difference, remark) |
| 6 | `gstr_1_results` | GSTR-1 vs Books/sales rows (+ `gstin` added via `ALTER … ADD COLUMN IF NOT EXISTS`) |
| 7 | `bank_reco_corrections` | learned narration→ledger corrections (`source` = ui/excel/output_upload) |
| 8 | `gstr_3b_tally_results` | GSTR-3B → Tally journal rows (row_type, sno, particulars, debit, credit) |
| 9 | `ledger_master` | per-brand Chart of Accounts (DB-backed COA; dedup on `ledger_name_key`) |

`CREATE EXTENSION IF NOT EXISTS "pgcrypto"` at the top provides `gen_random_uuid()`. Lines ~190–306 are
**RLS policies** (`app.brand_id` / `app.bypass_rls`), not tables.

> **Divergence vs sandbox `001_hero_database.sql`:** the sandbox doc lists 11 tables including
> `bank_payee_directory` and `voucher_type_master` (and RECO-doc mentions `gstr3b_coa_master` /
> `vt_master` / `runs`). **This production `001_reco_tables.sql` has only the 9 above** — no
> `bank_payee_directory`, no `voucher_type_master`. If you port a sandbox change that assumes those
> tables, add them here (idempotently) first or the query will fail on AWS.

---

## Hero-DB design decisions (must preserve)

- **Row Level Security**: enabled on every brand-scoped table. Policy (after hardening `005`) =
  `brand_id::text = current_setting('app.brand_id',true)` with a matching `WITH CHECK`. The app connects
  as the **non-superuser `colonel_app`** role so RLS actually enforces; each brand's connection presets
  `app.brand_id` via an `afterConnect` hook. **The client-settable `app.bypass_rls` GUC was removed** —
  the old `SET LOCAL app.bypass_rls = 'true'` pattern is now a no-op; only real superuser `postgres`
  (master/migration connection) bypasses RLS, natively. *(Note: some controllers still contain leftover
  `SET LOCAL app.bypass_rls` lines — harmless no-ops in the unified schema.)*
- **Idempotency**: `reco_jobs` has a **partial unique index** on
  `(brand_id, agent_type, month, year, file_hash) WHERE file_hash IS NOT NULL`.
  - Duplicate run, data already saved → `updateOutputFileId()`, returns early (no re-save).
  - Duplicate run that was 0-row (prior save failed) → `deleteJob()` (CASCADE removes results) → re-save.
- **`bank_reco_results` dedup includes `balance`**: unique index on
  `(brand_id, description, txn_date, COALESCE(debit,0), COALESCE(credit,0), COALESCE(balance,0))`.
  Running balance is cumulative → uniquely distinguishes repeated same-day same-amount charges. The
  migration drops any older balance-less version of this index before recreating it.
- **NULL-safe month/year**: use `IS NOT DISTINCT FROM`, not `=` (`NULL = NULL` is false in PostgreSQL).
- **`findExistingJob` must run on the brand connection**: its SELECT is wrapped in
  `sequelize.transaction()` on the brand's `colonel_app` connection (which has preset `app.brand_id`), so
  RLS scopes the read to that brand. Query the wrong connection (no `app.brand_id`) and RLS returns
  nothing.
- **`toSqlDate()` guard**: normalises Python date strings before INSERT. Python's `parse_date()` returns
  `"nan"` for unparseable dates; `"nan"::date` throws → rolls back the whole transaction. `toSqlDate()`
  maps `"nan"/"nat"/"none"/"null"/"n/a"/"-"` → `null`.
- **Per-row try/catch** in the save loop — one bad row logs + increments a failure counter, never aborts
  the batch.
- **Non-blocking writes**: DB saves run in `setImmediate()` — the download response is never delayed.
- **`output_file_id` vs `id`**: `output_file_id` = Python engine UUID (hex-no-dashes for GST, dashed UUID
  for bank); `id` = PostgreSQL PK. `getJobById` queries `WHERE (output_file_id = $1 OR id::text = $1)`.
- **`GST_2B_FRONTEND_TYPES`** (`recoController.js`): a `Set` mapping frontend agent names →
  `gstr_2b_results`. On AWS it is: `gstr_2b_books`, `gstr_2a_vs_2b_vs_books`, `gstr_2b_vs_purchase`,
  `gstr_2b_books_multistate`, **and `einvoice_reco`** (the e-invoice agent shares the 2B result table).

---

## Master / org feature tables (raw-SQL migrations)

> These org-level tables live in the shared unified DB alongside the master/org tables (no `brand_id`,
> no RLS); per-brand scoping is by their own `organization_id` / `brand_id` payload keys.

### Zoho Books mirror (`zohoMigrate.js`) — read-only mirror
`zoho_organizations` (= brands) → `zoho_accounts` (COA), `zoho_contacts` (customers+vendors),
`zoho_items`, `zoho_vouchers` (ALL typed transactions, `UNIQUE(voucher_type, zoho_id)`),
`zoho_bank_accounts`, `zoho_bank_transactions`, `zoho_sync_log`. Every row keeps the full Zoho payload in
a `raw` JSONB column. Keyed on `organization_id` throughout for per-brand drill-down.

### Compliance Tracker (`complianceMigrate.js`) — brand + user scoped
`compliance_categories` (per-brand, colored, `is_system`), `compliance_tasks` (monthly-instance task
board; idempotent template seed via `uq_compliance_template_row … WHERE source='template'`),
`compliance_attachments` (polymorphic: `compliance_task` | `task`; upload or Drive),
`compliance_chat_messages` (one thread per brand + accountant, accountant↔admin).

### Statutory Compliance (`statutoryMigrate.js`) — private, owner-gated
`statutory_filings` — one row per filing occurrence (state × period for state-wise types); status
`not_due | pending | filed | not_applicable`. Idempotent seed key
`uq_statutory_row (brand_id, compliance_type, COALESCE(state,''), COALESCE(period_label,''), COALESCE(title,''))`.
API gated to a single owner email.

---

## Agents (master `agents` table)

The superset DB carries **33 agents** total (base sales/marketplace/invoice agents + the RECO suite).
`seed.js` / `seeders/01-reco-agents.js` insert the RECO agents idempotently (`ignoreDuplicates`) and
CROSS JOIN-assign them to every brand via `brand_agents` (`ON CONFLICT DO NOTHING`).

> ⚠️ **Agent (and brand) IDs are now random UUIDv4.** The old **sequential** IDs below
> (`d0000000-…-00NN`) were **regenerated for security** — do **not** rely on them. For current values,
> query the `agents` table or read the remap files `db-restructure/008-agent-id-remap.json` (agents) and
> `009-brand-id-remap.json` (brands). On-disk COA files were renamed to match
> (`009_rename_coa_files.js`). For example, `einvoice_reco` and `zepto_receivables` are now
> `dcb5d5e9-…` and `ebcc3f8c-…` respectively.

**Legacy sequential IDs (regenerated — for historical reference only):**

| Agent | NN (legacy) | Note |
|---|---|---|
| gstr_2b_books | 001 | |
| gstr_2b_books_multistate | 002 | |
| gstr_3b_tally_entry | 003 | |
| universal_bank_statement | 004 | classify.py subprocess |
| gstr_1_vs_books | 005 | |
| amazon_mtr_consolidator | 006 | |
| einvoice_reco | 008 | |
| zepto_receivables | 010 | |

> `pdf_bank_extract` is also assigned in the seeder's brand_agents CROSS JOIN.

---

## Data retention (production)

Admin analytics are fed **only** by `reco_jobs`. Any nightly purge must **KEEP `reco_jobs`** and clear
only the heavy `*_results` rows (`bank_reco_results`, `gstr_*_results`, `gstr_3b_tally_results`). EC2
nightly `pg_dump` → `/opt/colonel/backups/`. See [AWS.md](AWS.md).

---

## Seeding / restore — `db-seed/restore.sh`

Restores the full unified DB from a **single** committed `pg_dump` snapshot,
`db-seed/dumps/colonel_agent_accountant.dump` (custom format), which replaces the old 17 per-brand
dumps and contains **real AWS production data** — every brand's master + reco/sales rows, each carrying
a `brand_id` and protected by the RLS policies (included in the dump).

`restore.sh` (`cd db-seed && ./restore.sh`) ensures the non-superuser **`colonel_app`** role, terminates
live connections, `dropdb --if-exists` + `createdb` the one DB (**destructive** — back up local data
first), `pg_restore --no-owner` (schema + data + RLS policies + `brand_id` defaults), then GRANTs
`colonel_app` least-privilege access. Connection via `PGHOST/PGPORT/PGSUPER/PGPASSWORD` env (defaults
`127.0.0.1:5432 postgres/postgres`).

**Bootstrap:** `cd db-seed && ./restore.sh` → `cp new-backend/.env.example new-backend/.env` (unified is
the default — **no flag needed**) → fill in API keys → start the backend (`node server.js`). Boot
migrations are idempotent no-ops in unified mode (schema is pre-built).

---

## Auth / accounts

- **`chauhandhaval932@gmail.com` is an `accountant`** (owns the owner-gated features — Statutory
  Compliance, Zoho Books, Composio). ⚠️ This **differs from the sandbox**, where the same email is `admin`.
- **`dhaval.colonel@gmail.com`** = the `developer` role (feedback-loop / dev features).
- **Passwords are not committed.** The dump stores bcrypt hashes; plaintext passwords are set by
  gitignored provisioning scripts (`seed-accountants.js`) via the convention `<name-before-dot>123`
  (`<set via seed script>`). Roles: `admin` / `accountant` / `brand_executive` / `developer`.
- If login looks broken, **the backend is likely down** — check `pm2 status` before touching auth code.

# 🗄️ DATABASES.md — PostgreSQL Schema & Persistence (AWS Superset)

> Deep-dive companion for the **live `colonel-automation` app** (port 3000 / backend 8001) served on
> AWS EC2 → ngrok. Multi-DB layout, models, migrations, RLS, idempotency, and the persistence flow.
>
> Cross-refs: [README.md](README.md) · [CLAUDE.md](CLAUDE.md) · [AWS.md](AWS.md) (EC2 / deploy / crons) ·
> [SERVERS.md](SERVERS.md) (ports & restart) · [RECO.md](RECO.md) (reco result flow) · [ARCHITECTURE.md](ARCHITECTURE.md).
>
> ⚠️ This is the **production superset**, ahead of the port-3001 sandbox. It has **more brands, more
> agents, and more master tables** (Zoho, Compliance, Statutory, Plans, Integrations, Conversations,
> MCP) than the sandbox `DATABASES.md`. The reco migration file here is **`001_reco_tables.sql`**
> (the sandbox calls its variant `001_hero_database.sql`). Where they diverge is flagged below.

---

## Database layout — one master + one DB per brand

```
PostgreSQL :5432   (17 DBs total on EC2 = colonel-master + 16 per-brand)
│
├── colonel-master                     ← auth / org / cross-brand data (SHARED)
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
├── colonel-<brand>                    ← per-brand DB (createBrandDatabase())
│   │  (9 tables from 001_reco_tables.sql — run per brand DB at boot)
│   ├── reco_jobs                       ← 1 row per reco/agent run  (ADMIN ANALYTICS FEED)
│   ├── bank_reco_results · bank_reco_corrections
│   ├── gstr_2b_results · gstr_2a_2b_results · gstr_3b_results · gstr_1_results
│   ├── gstr_3b_tally_results
│   ├── ledger_master                   ← DB-backed Chart of Accounts (per brand)
│   └── <dynamic per-upload sales tables>   ← month/year/file_type/… (getDynamicModel + bulkCreate)
│
└── (EC2: 16 brand DBs — MIXED naming, hyphen AND underscore — always `\l` first)
```

> **Every per-brand reco table** is created by the single idempotent migration `001_reco_tables.sql`,
> run against each brand DB at boot. **RLS** (`app.brand_id` / `app.bypass_rls`) is enforced on all of
> them. Dynamic sales/marketplace tables are created lazily on first open/upload (not in the migration).

### On EC2 (production) — 17 databases, MIXED naming ⚠️

`colonel-master` + **16 per-brand DBs**. Naming is **inconsistent** — legacy brands are hyphenated,
newer ones underscored. **Always `\l` before querying** — do not assume the name. The committed
`db-seed/dumps/` snapshot (see below) is the canonical list of DB names:

```
colonel-master
colonel-biglilpeople   colonel-dchica     colonel-koparo     colonel-mbrands
colonel-nestroots      colonel-plenaire   colonel-shumee     colonel-stroom
colonel-urbanplant     colonel-zayden
colonel_amama          colonel_flipside   colonel_flo_mattress
colonel_nailinit       colonel_other      colonel_shumee_playroom
```

New-brand convention = `colonel_<slug>` (underscores); legacy brands keep hyphens (`colonel-stroom`).
Zoho / Compliance / Statutory / Plans / Integrations tables (3000-native features) live **only in the
EC2 master DB** and are absent from the sandbox backend.

---

## Persistence flow — how a run reaches the DB

```
 recoController.js  (after Python engine / classify.py returns results)
   │  results.length > 0 && no error flag                (empty/failed runs never write)
   │  file_hash = sha256(all uploaded buffers)
   ▼
 findExistingJob()  ── inside sequelize.transaction() + SET LOCAL app.bypass_rls = 'true'
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
  → migrateAllBrands()                // 001_reco_tables.sql on every brand DB (from brands.db_name)
  → migrateZoho()                     // zoho_* tables in master
  → migrateCompliance()               // compliance_* tables in master
  → migrateStatutory()                // statutory_filings in master
  → app.listen(PORT)                  // 8001
```

`migrate.js` fetches `SELECT db_name FROM brands` and runs the SQL per DB inside a transaction with
`SET LOCAL app.bypass_rls = 'true'` so RLS never blocks the migration itself. `migrateSingleBrand()`
does the same for one brand when a new brand is created.

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
- `Brand` has `db_name` (unique, per-brand DB) + `drive_folder_id` (Google Drive source folder).
- `Agent` has `columns` (JSONB) — drives the dynamic per-upload table shape.
- `Conversation` is strictly private to `user_id` (admins do NOT see others' Colonel-AI chats).
- `Integration` / `McpServer` are visual-connect registries (no live OAuth handshake in the model).

> ⚠️ Only **3 of the reco tables** are ORM-modeled (`reco_jobs`, `bank_reco_results`, `gstr_2b_results`).
> The other result tables are populated via **raw SQL** in the controllers, not the ORM.

### Per-brand sales/agent data tables (dynamic)

Sales / marketplace / invoice agents persist parsed rows into a **dynamic per-brand table** via
`getDynamicModel(brandDb, tableName, agent.columns)` + `Model.bulkCreate(...)` (unconditional — no save
flag). `tableName = agent.name` lowercased, non-alphanumerics → `_` (e.g. `Amazon`→`amazon`,
`Sales-Amazon`→`sales_amazon`). Fixed columns: `id, month, year, file_type, inventory_type, filename,
created_at` + the agent's own data columns. `timestamps: false` (uses the explicit `created_at`).

> ⚠️ **Two gotchas (verified on AWS):**
> - **The GET read path calls `Model.sync({force:false})` — opening an agent workspace CREATES its
>   (empty) table.** So "table exists, 0 rows" = *opened but no file uploaded*, NOT a broken pipeline.
> - **No user attribution on this data**: dynamic tables have **no `user_id` / `created_by` and no
>   `brand_id`** (brand is implicit = which DB). User-wise attribution exists only on reco/agent runs,
>   via `reco_jobs.created_by`.

### `agentRunTracker.recordAgentRun()` — the analytics bridge

`new-backend/src/services/agentRunTracker.js` writes **one `reco_jobs` row per successful sales/agent
commit** so admin dashboards (which read `reco_jobs`) show every run — who / when / which brand.
- Same RLS-bypass-in-transaction pattern as reco saves; **never throws** (logged + swallowed).
- `output_file_id` is `varchar(36)` — a long sales filename won't fit, so it stores the value only if
  `length <= 36`, else `NULL`. `matched_rows` / `unmatched_rows` are left NULL for sales runs.
- Does **not** touch agent tables or agent logic — a purely additive analytics write.

---

## Migration — `new-backend/src/db/migrations/001_reco_tables.sql`

Single, **idempotent** migration (`IF NOT EXISTS` / `OR REPLACE` / drop-before-create policies), run per
brand DB at boot via `migrate.js` → `migrateAllBrands()` before `app.listen()`.

**9 per-brand tables:**

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

- **Row Level Security**: `ENABLE` + `FORCE ROW LEVEL SECURITY` on every reco table (FORCE because the
  backend connects as `postgres`, a superuser). Policy = `current_setting('app.bypass_rls',true)='true'
  OR brand_id::text = current_setting('app.brand_id',true)`. Admin/migration ops set
  `SET LOCAL app.bypass_rls = 'true'` **inside a `sequelize.transaction()`** — `SET LOCAL` outside a
  transaction is a **PostgreSQL no-op**.
- **Idempotency**: `reco_jobs` has a **partial unique index** on
  `(brand_id, agent_type, month, year, file_hash) WHERE file_hash IS NOT NULL`.
  - Duplicate run, data already saved → `updateOutputFileId()`, returns early (no re-save).
  - Duplicate run that was 0-row (prior save failed) → `deleteJob()` (CASCADE removes results) → re-save.
- **`bank_reco_results` dedup includes `balance`**: unique index on
  `(brand_id, description, txn_date, COALESCE(debit,0), COALESCE(credit,0), COALESCE(balance,0))`.
  Running balance is cumulative → uniquely distinguishes repeated same-day same-amount charges. The
  migration drops any older balance-less version of this index before recreating it.
- **NULL-safe month/year**: use `IS NOT DISTINCT FROM`, not `=` (`NULL = NULL` is false in PostgreSQL).
- **`findExistingJob` must use a transaction**: its SELECT is wrapped in `sequelize.transaction()` with
  `SET LOCAL app.bypass_rls = 'true'` inside — otherwise RLS blocks the read and it returns null.
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

## Master-DB feature tables (raw-SQL migrations)

### Zoho Books mirror (`zohoMigrate.js`) — read-only mirror in master DB
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

The superset master DB carries **33 agents** total (base sales/marketplace/invoice agents + the RECO
suite). `seed.js` / `seeders/01-reco-agents.js` insert the RECO agents idempotently
(`ignoreDuplicates`) and CROSS JOIN-assign them to every brand via `brand_agents`
(`ON CONFLICT DO NOTHING`). Stable RECO UUIDs (`d0000000-0000-0000-0000-0000000000NN`):

| Agent | NN | Note |
|---|---|---|
| gstr_2b_books | 001 | |
| gstr_2b_books_multistate | 002 | |
| gstr_3b_tally_entry | 003 | |
| universal_bank_statement | 004 | classify.py subprocess |
| gstr_1_vs_books | 005 | |
| amazon_mtr_consolidator | 006 | |
| **einvoice_reco** | **008** | matches AWS agents table; kept at 008 |
| **zepto_receivables** | **010** | **moved OFF 008 → 010 so `einvoice_reco` matches AWS** |

> `pdf_bank_extract` is also assigned in the seeder's brand_agents CROSS JOIN. The reordering of
> zepto (008→010) is deliberate: the AWS `agents` table already had `einvoice_reco` at 008, so zepto was
> relocated to 010 to avoid a UUID collision on deploy.

---

## Data retention (production)

Admin analytics are fed **only** by `reco_jobs`. Any nightly purge must **KEEP `reco_jobs`** and clear
only the heavy `*_results` rows (`bank_reco_results`, `gstr_*_results`, `gstr_3b_tally_results`). EC2
nightly `pg_dump` → `/opt/colonel/backups/`. See [AWS.md](AWS.md).

---

## Seeding / restore — `db-seed/restore.sh`

Restores the full **superset** from committed `pg_dump` snapshots in `db-seed/dumps/` (custom-format
`*.dump`, one per DB — 17 files). For each dump it terminates live connections, `dropdb --if-exists`,
`createdb`, then `pg_restore --no-owner --no-privileges` (a **DROP + CREATE** — destructive; back up
local data first). Connection via `PGHOST/PGPORT/PGUSER/PGPASSWORD` env (defaults
`127.0.0.1:5432 postgres/postgres`). After restore, start the backend — boot migrations idempotently
re-ensure the per-brand reco tables + master zoho/compliance/statutory tables.

---

## Auth / accounts

- **`chauhandhaval932@gmail.com` is an `accountant` on the AWS superset** (owns the owner-gated features
  — Statutory Compliance, etc.). ⚠️ This **differs from the sandbox**, where the same email is `admin`.
- **`dhaval.colonel@gmail.com` / `dhaval123`** = the `developer` role (feedback-loop / dev features).
- Password convention for provisioned accountants: `<name-before-dot>123`.
- If login looks broken, **the backend is likely down** — check `pm2 status` before touching auth code.

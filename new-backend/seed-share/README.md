# Seed data — Shopify-Order-Cycle and Receivable Cycle

Two seeders that load real data for two agents into your local database, so both
have something to show without you uploading any files.

| Seeder | Agent | Tables it fills | Rows |
|---|---|---|---|
| `seed-shopify-order-cycle-data.js` | `Shopify-Order-Cycle` | `shopify_order_cycle` | 66,571 |
| `seed-receivables-data.js` | `receivable_cycle` (the Receivables dashboard) | `receivable_ledger` | 235,827 |
| | | `receivable_ledger_unmatched` | 27,803 |
| | | `receivable_cycle_imports` | 427,982 |

The data belongs to two brands: **Flo Mattress** (almost all of it) and **Amama**
(a small demo set).

## What you need first

1. PostgreSQL 16 or newer, running.
2. The unified database restored, from the repo root:
   ```bash
   cd db-seed && ./restore.sh
   ```
   This creates `colonel_agent_accountant`, the `colonel_app` role and the
   `brands` / `agents` / `brand_agents` tables the seeders write to.
3. `new-backend/.env` in place (`cp new-backend/.env.example new-backend/.env`),
   with `DB_HOST`, `DB_PORT`, `DB_USER` and `DB_PASSWORD` pointing at your
   Postgres. `DB_USER` should be the superuser (`postgres`), as the app expects.
   Do not set `USE_UNIFIED_DB=false`.
4. `npm install` done in `new-backend/`.
5. This whole `seed-share/` folder copied to `new-backend/seed-share/`, with
   its `data/` folder:
   ```
   new-backend/seed-share/
     README.md
     _seed-lib.js
     seed-shopify-order-cycle-data.js
     seed-receivables-data.js
     data/
       shopify_order_cycle.ndjson.gz
       receivable_ledger.ndjson.gz
       receivable_ledger_unmatched.ndjson.gz
       receivable_cycle_imports.ndjson.gz
       order_cycle_shopify_Flo Mattress_October_2026_49db009b-fef3-467f-ad68-0adf0b3c18bf.xlsx
   ```
   `data/` is git-ignored (it is client data), so it does not arrive with a
   `git pull` — it has to be sent to you separately.

## Run

From `new-backend/`:

```bash
node seed-share/seed-receivables-data.js
node seed-share/seed-shopify-order-cycle-data.js
```

Run both. The order-cycle Transaction Data table looks up each order's delivery
status, courier and settlement in `receivable_ledger`, so it is incomplete
without the receivables seed. The receivables seed takes a few minutes; the
order-cycle one well under a minute.

Then restart the backend (`node server.js` or `pm2 restart`) and open, as a user
with access to Flo Mattress:

- Flo Mattress → Agents → **Shopify-Order-Cycle**
- Flo Mattress → **Receivables** dashboard (`/brands/<brandId>/receivables`)

## What each seeder does

1. Finds the brands **by name**. If your brand has a different id, the rows are
   re-tagged to your id. If a brand does not exist, it is created.
2. Finds the agent by name, creating it if missing, and assigns it to both brands.
3. Creates the tables if they are missing, with their indexes, row-level
   security policy and grants to `colonel_app`.
4. Loads the rows in batches of 1,000.
5. Order cycle only: copies the generated workbook into `new-backend/outputs/`
   so the Download button works.

## Re-running

A seeder stops without changing anything if the two brands already have rows in
its tables. To load anyway:

```bash
node seed-share/seed-receivables-data.js --replace
node seed-share/seed-shopify-order-cycle-data.js --replace
```

`--replace` **deletes every existing row for Flo Mattress and Amama** in that
seeder's tables, then loads the seed. Other brands are not touched.

## Check it worked

```sql
SELECT b.name, count(*) FROM shopify_order_cycle s JOIN brands b ON b.id = s.brand_id GROUP BY 1;
-- Amama 11, Flo Mattress 66560
SELECT b.name, count(*) FROM receivable_ledger l JOIN brands b ON b.id = l.brand_id GROUP BY 1;
-- Amama 106, Flo Mattress 235721
```

## If something goes wrong

| Message | Cause and fix |
|---|---|
| `relation "brands" does not exist` | The unified DB was not restored. Run `db-seed/restore.sh`. |
| `Data file missing` | `seed-share/data/` is absent or incomplete. Ask for the data files. |
| `already have data in …` | Rows exist for these brands. Re-run with `--replace` if you want them overwritten. |
| `role colonel_app does not exist` (warning) | Run `db-seed/restore.sh`; without the role the app cannot read the tables. |
| Dashboard empty after seeding | Restart the backend, and check your user is assigned to Flo Mattress. |

## Not included

- The **Receivables Summary** agent (`receivables_summary` table) — a separate,
  newer agent. Its data is loaded by uploading files in its own screen.
- Per-run history (`reco_jobs`, `receivable_cycle_results`).

## For whoever produces the data files

`bash seed-share/export-data.sh` (from `new-backend/`) writes `data/` from your
own local database. It only reads.

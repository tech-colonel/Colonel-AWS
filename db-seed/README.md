# db-seed — Colonel unified database snapshot

A `pg_dump` (custom format) snapshot of the **single unified database** that the app
now uses. All brands share ONE database (`colonel_agent_accountant`) with Postgres
Row-Level-Security isolation — there are **no more per-brand databases**.

Contents of `dumps/`:
- `colonel_agent_accountant.dump` — the whole app: users, brands, agents,
  brand_users, brand_agents, integrations, plans, conversations, **plus** every
  brand's reco/sales data (`reco_jobs`, result tables, `ledger_master`,
  `bank_reco_corrections`, `gstr3b_*`, `sales_*`, `shopify_order_cycle`, …), each
  row carrying a `brand_id` and protected by RLS policies (included in the dump).

## Restore (fresh machine)

Requires PostgreSQL 16 running locally.

```bash
cd db-seed
./restore.sh                      # postgres/postgres @ 127.0.0.1:5432
# or override:  PGSUPER=me PGPASSWORD=secret ./restore.sh
```

`restore.sh` creates the non-superuser `colonel_app` role (RLS is enforced only for
non-superusers), (re)creates `colonel_agent_accountant`, restores schema + data +
RLS policies + `brand_id` defaults, and grants `colonel_app` least-privilege access.

Then:
```bash
cp new-backend/.env.example new-backend/.env   # unified mode is the DEFAULT (no flag needed)
# fill in API keys, then:
cd new-backend && node server.js
```

## Notes
- **Unified is the default.** `config/database.js` runs unified unless you explicitly
  set `USE_UNIFIED_DB=false` (escape hatch to the legacy per-brand path — not used).
- Data is real firm/brand data, shared intentionally for this **private** repo.
- User passwords are bcrypt hashes in the dump (not plaintext); provisioning scripts
  (`seed-accountants.js`, gitignored) set them via the `<name-before-dot>123` convention.
- `chauhandhaval932@gmail.com` is an **accountant** (owner of the gated Statutory/Zoho/
  Composio features) — do not change its role.
- Agent/brand IDs are **random UUIDs** (the old sequential `d0000000…`/`b0000000…` IDs
  were regenerated for security — see `db-restructure/008/009` mappings).

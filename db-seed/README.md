# db-seed — Colonel-AWS superset database snapshots

These are `pg_dump` (custom format) snapshots of the **full superset** databases —
the merged state of the local port-3000 app + AWS production data.

Contents of `dumps/`:
- `colonel-master.dump` — users, brands, agents (33: reco + sales + einvoice + zepto +
  local-only Shopify-Order-Cycle/Invoice-Processing), brand_users, brand_agents,
  integrations, plans, conversations.
- `colonel-<brand>.dump` (×16) — per-brand reco data: `reco_jobs`, result tables,
  `ledger_master`, `bank_reco_corrections`, `gstr3b_*`, sales tables, etc.

## Restore (fresh machine)

Requires PostgreSQL 16 running locally.

```bash
cd db-seed
./restore.sh                      # uses postgres/postgres @ 127.0.0.1:5432
# or override:
PGUSER=me PGPASSWORD=secret ./restore.sh
```

Then start the backend (`cd ../new-backend && node server.js`) — boot migrations
idempotently (re)create per-brand reco tables + master zoho/compliance/statutory tables.

## Notes
- Data is real firm/brand data shared intentionally for this collaboration repo.
- User passwords are stored as bcrypt hashes (not plaintext). Demo admin: `admin@colonel.app`.
- `chauhandhaval932@gmail.com` is an **accountant** (owner of the gated Statutory/Zoho/Composio
  features) — do not change its role.
- Agent UUIDs: `einvoice_reco = d0000000-…-008`, `zepto_receivables = d0000000-…-010`.

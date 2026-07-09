# DB Restructure — Security Attack + Edge-Case + Functional Test

## Security attacks (against colonel_agent_accountant)
| Attack | Result |
|---|---|
| SQL injection — auth bypass (`' OR '1'='1`) | ✅ 401, not bypassed (bcrypt + bind params) |
| SQL injection — brandId param `'; DROP TABLE reco_jobs;--` | ✅ neutralized — passed as bind param, rejected as invalid uuid; table intact |
| Cross-tenant READ (Koparo ctx sees Stroom) | ✅ blocked by RLS (0 rows) |
| Cross-tenant WRITE (insert Koparo row as Stroom) | ✅ blocked — "violates RLS policy" (USING acts as WITH CHECK; explicit WITH CHECK added) |
| **`app.bypass_rls` escalation (client sets GUC)** | 🔴 FOUND vuln → 🔒 FIXED (005_harden_rls.sql: removed bypass branch; real superuser still bypasses natively) |
| Privilege escalation `SET ROLE postgres` | ✅ denied |
| colonel_app privileges | ✅ least-privilege: not superuser, no bypassrls, cannot CREATE TABLE |

Minor hardening rec (not a vuln): malformed uuid path param returns 500 with raw error echoed → add a UUID-validation middleware to return 400.

## Single-DB edge cases / limitations (research + measured)
1. 🔴 **Connection-pool ceiling (the main one).** Unified mode uses one Sequelize pool PER BRAND (max 5) + master (15). max_connections=100. 16 brands × 5 + 15 = ~95 → near cap; 100 brands would exhaust it. Mitigated now by pool min:0 + 10s idle eviction (only active brands hold connections; measured ~1 idle). **Before scaling to many brands, switch to a single shared pool with per-request `SET LOCAL app.brand_id` (via middleware/transaction), or add PgBouncer, or raise max_connections.**
2. **Noisy neighbor.** One brand's heavy query/long txn can slow all others (shared CPU/IO/locks). Mitigate: statement_timeout, monitoring, later Citus/partitioning.
3. **Backup/restore granularity.** Per-brand restore is now filter-by-brand_id (vs dropping a whole DB before). Old per-brand dumps kept as fallback.
4. **RLS relies on app.brand_id being set** — enforced via afterConnect per brand pool; fail-closed (unset → 0 rows / NOT NULL violation on insert).

## Functional test (Playwright, real UI, live unified DB)
- Logged in as accountant **akshat** → saw ONLY assigned brands (Stroom, Other) = brand access control OK.
- Ran **GSTR-2B vs Books (Multi-State)** on Stroom with Karnataka demo files → 11 records rendered (Matched/2B-not-Books/Books-not-2B, Remark-3 cross-state).
- DB: reco_jobs 27→28 (Stroom), gstr_2b_results 858→869; new job agent_type=gstr_2b_books_multistate, **created_by=akshat (user-vise)**, **brand_id=Stroom (brand-vise)**.
- Admin: total runs 105→106, multistate 51→52; admin user-activity attributes the run to akshat.
- RLS: new job invisible to Koparo (0), visible to Stroom (1).
- Console errors during flow: only pre-existing React duplicate-key warning + 403 on owner-gated statutory (correct authz). Zero DB errors.

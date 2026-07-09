# DB Restructure — Phase 4 (Backend code, flag-gated)  — IN PROGRESS

Goal: make the app able to run on the single DB, behind `USE_UNIFIED_DB` (default OFF = today's behaviour). Flip happens in Phase 5.

## 4a — DONE (committed)
- `004_app_role_and_defaults.sql` (applied to colonel_agent_accountant): non-superuser role `colonel_app` (+ grants, default privileges) and `brand_id DEFAULT NULLIF(current_setting('app.brand_id',true),'')::uuid` on all 34 RLS tables → inserts auto-stamp brand_id, fail-closed if no context.
- `config/database.js` (flag-gated): OFF unchanged. ON → masterSequelize = superuser@unified (master has no RLS + needs DDL at boot); getBrandConnection = per-brand pool @unified as `colonel_app`, afterConnect presets `app.brand_id` (looked up from brands.db_name) so RLS scopes reads and defaults stamp writes — controllers unchanged. createBrandDatabase = no-op in unified.
- `migrate.js`: per-brand migration loop skipped in unified (schema pre-built).
- TESTED both flag states via the real Sequelize path: OFF and ON both give brands=16, stroom=27, koparo=16; ON isolates (stroom conn sees 0 Koparo rows via RLS). colonel_app insert auto-stamps + isolates.

## 4b — REMAINING (next)
- Audit `bypass_rls` call sites (recoController 14, dashboardController, gstr3bController, bankCorrectionsController, agentRunTracker). In unified mode bypass defeats RLS. reco/gstr3b/bankCorrections filter by explicit brand_id so data stays correct, but the dashboard cross-brand aggregation loop must be confirmed/fixed so each brand iteration returns only its rows (not all).
- Full endpoint smoke test with USE_UNIFIED_DB=true (login, list reco jobs, open a sales agent, admin dashboard totals).

Flag defaults OFF, so the live app is unaffected until Phase 5 cutover.

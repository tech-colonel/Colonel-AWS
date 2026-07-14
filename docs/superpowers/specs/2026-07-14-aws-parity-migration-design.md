# AWS Parity Migration — Design Spec

**Date:** 2026-07-14
**Branch:** `aws-parity` (off `main` @ `b12fd0b`)
**Status:** Design approved — pending spec review → implementation plan

## Goal

Bring the live AWS EC2 deployment (`/opt/colonel`, served at `https://eggbeater-thesis-crowbar.ngrok-free.dev`) to **full parity with local port-3000**: the single **unified DB**, the current **UI**, and **all new features**. End state: **AWS runs on the unified single DB `colonel_agent_accountant` — no per-brand DBs.**

The PDF→Bank tool was already updated on AWS by the user and is expected to match 3000 (to be diff-confirmed).

## Non-negotiable guardrails

- **All work on branch `aws-parity`** → revertible at any time.
- **Back up every file we touch** — local → `scratchpad-backups/`; box → `/tmp/<name>_$(date +%s)` or `/opt/colonel/backups/`.
- **AMI/EBS snapshot of the box before cutover** (ultimate rollback for a big redesign).
- **Preserve AWS production data** — freeze the box first, capture its final frozen state, build/verify locally, then deploy.
- **Rotate Composio + GenSpark API keys before the box goes public again** (they were exposed). New keys live only in the box `.env`, never committed.
- Roles unchanged: `chauhandhaval932@gmail.com` = **accountant**, `dhaval.colonel@gmail.com` = **admin** on AWS.
- Deploy path is **rsync/scp to `/opt/colonel` + pm2**, never a GitHub pull to the box. After a successful deploy, push branch `aws-parity` to the **Colonel-AWS** repo (gated).

## Current-state survey (read-only, 2026-07-14)

### Database
| | AWS (live) | Port-3000 (local) |
|---|---|---|
| Topology | **17 per-brand DBs** (`colonel-master` + 16 brand DBs) | **1 unified** `colonel_agent_accountant` (brand_id + RLS) |
| Config | old multi-DB, no `USE_UNIFIED_DB` | unified default (`USE_UNIFIED_DB !== 'false'`) |
| Brands | same 16 brands both sides | same 16 |
| Data freshness | 129 reco runs; ~3 newer than snapshot (Koparo, ephemeral "Other") | 126 reco runs (snapshot 2026-07-14 ~09:16 UTC) |

### Features MISSING on AWS (present on 3000)
- **Backend routes:** `statutory`, `compliance`, `zoho`, `meeting` (Fireflies), `attachments`, `composio`, `database`
- **Accountant UI:** Statutory Compliance, Compliance Tracker, Zoho Books, Fireflies Meetings, Analysis redesign (Analysis/AnalysisAgent/AnalysisMetric), GoogleDriveFolderInput
- **Admin UI:** AdminStatutory, Composio Marketplace, Database explorer, analytics drill-down (AdminChats, AdminToolDetail, AdminUserDetail, AdminAnalysis)
- **Reco engine:** `zepto_receivables.py`
- **Roles:** developer role + Feedback loop

### Deliberate divergences
- **Meetings:** AWS = Google Calendar (`calendarRoutes`); 3000 = Fireflies (`meetingRoutes`).
- **PDF→Bank:** present both sides (user-updated on AWS) — diff to confirm parity.
- **UI build:** AWS compiled 2026-07-10; 3000 is current.

## Decisions (locked via Q&A)

1. **DB-first.** The unified DB already holds every feature table **and** its data, so once AWS is unified, deploying feature code just connects to populated tables — no per-feature data import, no double migration.
2. **Freeze AWS now, prep at leisure.** Stop the site first → zero drift → local becomes the definitive source of truth. Downtime spans the whole prep (accepted tradeoff for certainty).
3. **Full parity — everything**, including Composio (with mandatory key rotation).
4. **Meetings = same as 3000** (Fireflies: events, meet, recordings) as primary, **and** evaluate folding in useful bits of AWS's Google Calendar integration.
5. **AMI snapshot** before cutover; **push branch** to Colonel-AWS after successful deploy.
6. **End state: unified DB only** on AWS.

## Rejected alternative

**In-place DB restructure on the live box** (apply db-restructure + 008/009 remaps + COA renames directly on production). Rejected: restructuring 17 live DBs in place is high-risk. Instead we rebuild the unified DB **locally** from the box's frozen dumps and deploy a proven artifact.

## Phased plan

### Phase 0 — Safety net
- Create branch `aws-parity` (done).
- **AMI/EBS snapshot** of instance `i-0e3aa71ed74f03aed` (via `aws` CLI, `colonel-deploy` creds).
- On box: `tar` `/opt/colonel`; back up `frontend/build`, `src/app.js`, `.env`.

### Phase 1 — Freeze AWS + capture final state
- `pm2 stop colonel-backend ngrok` → site down, no new data (Postgres + reco-engine remain up for dumping).
- Read-only `pg_dump -Fc --no-owner` all 17 `colonel%` DBs → scp down to a dated local dir.

### Phase 2 — Build unified DB locally (AWS final data + feature layer)
- Rebuild local unified from the fresh dumps via `db-restructure/refresh-from-aws.sh` (truncates reco/sales data, loads AWS's latest, **keeps** feature/org tables incl. `statutory_config`, `statutory_filings`, `compliance_*`, `zoho_*`, `brand_users`).
- Re-apply/verify feature layer: statutory dynamic config + 2367 filings, chauhandhaval932 brand assignments.
- **Audit on-disk file references** (COA/ledger files under `output/ledgers`, attachments) — reconcile any brand/agent-ID-keyed paths to the unified IDs.
- Verify locally (row counts, boot, smoke test) → produce the final deployable `colonel_agent_accountant.dump`.

### Phase 3 — Prep code/UI on the branch
- Confirm full feature set present (branch = 3000 code).
- **Meetings:** Fireflies primary; review `calendarController` and fold in valuable Google-Calendar behavior; ensure Fireflies key configured for the box `.env`.
- **Rotate Composio + GenSpark keys**; update `.env.example` placeholders (real keys only on box).
- Ensure unified mode config + role settings.
- Commit branch state.

### Phase 4 — Cutover deploy (gated, explicit permission)
- rsync `new-backend/`, `reco-engine/`, `frontend/` → `/opt/colonel` (preserve box `.env`).
- Restore unified DB on box: create `colonel_agent_accountant` + `colonel_app` role + RLS, restore final dump (mirror `db-seed/restore.sh`).
- Set box `.env`: `USE_UNIFIED_DB=true`, `DB_NAME=colonel_agent_accountant`, rotated keys, Fireflies key.
- Back up `build/` → `npm install --legacy-peer-deps` (ensure `react-is`, `html-to-image`, `@xyflow/react`) → `npm run build`.
- `pm2 restart colonel-backend reco-engine`; bring **ngrok up** → site live on unified stack.
- **Do NOT drop the 17 per-brand DBs** (keep for rollback).

### Phase 5 — Verify, rollback readiness, push
- Smoke test: login (admin + accountant), each feature (Statutory/Compliance/Zoho/Meetings/Analysis/Database/Feedback), data present, one reco run end-to-end.
- **Rollback path (kept ready):** 17 per-brand DBs untouched on box → revert `.env` to per-brand + restore `/opt/colonel` tar + `pm2 restart` → old stack; or restore the AMI.
- On success: push branch `aws-parity` → Colonel-AWS repo.

## Risks

1. **On-disk file references** keyed by brand/agent ID (COA/ledgers/attachments) — audit + reconcile in Phase 2.
2. **Key rotation** (Composio/GenSpark) mandatory before public relaunch.
3. **Frontend build deps** on box (`react-is`, `html-to-image`, `@xyflow/react`).
4. **Downtime** spans full prep (accepted).
5. **RLS / colonel_app grants** must be applied so the app (non-superuser on unified) can read/write all tables.

## Success criteria

- AWS serves the current 3000 UI + all features, on the **single unified DB**, with AWS's real production data intact (incl. the ~3 post-snapshot runs).
- No per-brand DBs in use by the app; 17 old DBs retained only as rollback.
- Rotated keys live; roles correct; rollback (AMI + DBs + tar) proven available.
- Branch `aws-parity` pushed to Colonel-AWS.

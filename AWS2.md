# ☁️ AWS2.md — Second AWS Account (Migration Target)

> **Purpose.** Colonel is migrating the live production app off the small credit-limited box in
> **account #1** onto a **larger instance in a brand-new account #2** (fresh $200 credits + card on
> file). This doc maps everything about **account #2** and the migration plan. Read alongside
> **[AWS.md](AWS.md)** (the current/live account #1 reference).
>
> **Status: PRE-CUTOVER.** Account #2 CLI access is LIVE (profile `colonel2` verified). Next steps =
> share AMI → launch bigger instance → verify → cutover. Account #1 (`43.205.60.250` / ngrok) is still
> the LIVE site and must keep running until #2 is verified. Nothing is stopped on #1 yet.

> ### 🟢 Latest rollback AMI (account #2)
> **`ami-0c7fe387f062263c6`** — `colonel-prod-2-pre-sales-fixes-deploy-20260814-131709`, `--no-reboot`, created **2026-08-14**. Taken immediately before deploying the `sales-fixes` merge + backlog (Advance Amount Dashboard, sales fixes, Credit Card Booking, Zepto Drive UI, order-cycle-shopify fixes) — bundle `main.977edc34.js`. DB dump `~/backups/colonel_agent_accountant_pre_deploy_20260814-131709.dump` (verified, 595 catalog entries).
> Prior rollback AMIs: `ami-01fd62d1d51cc41d6` (post-einvoice-dynamic, 2026-08-13) · `ami-02126a18cd8802ad9` (pre-E-Invoice deploy, 2026-08-12; DB dump `~/backups/colonel_agent_accountant_pre_einvoice_20260812-112609.dump`) · `ami-091d6465cab1614aa` (pre credit-card/persistence, 2026-08-07) · `ami-07e1584aec7fd0db9` (invoice/8-brands, 2026-08-04).

---

## ⛔ Golden rules carry over
1. **Never touch either AWS account** (deploy, restart, migration, DB op, stop/terminate) **without explicit human permission this session.** Same rule as [AWS.md](AWS.md).
2. **Do not stop/terminate account #1** until account #2 is fully verified and the user says so. #1 = fallback.
3. Back up before edits; prefer additive changes.

---

## Account #2 — identity
| Field | Value |
|---|---|
| **Account ID** | **679930074502** |
| **Account name / alias** | Colonel |
| Root / billing email | `tech@colonel…` (⚠️ CONFIRM exact address with user) |
| Console sign-in URL | `https://679930074502.signin.aws.amazon.com/console` |
| Credits | ~$200 free credits + payment card applied |
| Console tab seen in | region context `eu-north-1` (Stockholm) — that's just IAM's global console context, **not** the chosen compute region |
| **Target compute region** | **`ap-south-1` (Mumbai)** — recommended (matches #1, low latency for India) — ⚠️ CONFIRM |

## Account #2 — programmatic (CLI) access for the assistant
| Field | Value |
|---|---|
| IAM user | **`Colonel-AWS`** |
| Permissions | `AdministratorAccess` (temporary — **delete the key after migration**) |
| Access key ID | **`AKIAZ4TX5SWDLQVQZ4V6`** (description tag `colonel2-cli-migration`) |
| Secret access key | ✅ received & stored **only** in local `~/.aws/credentials` (NEVER written to any repo doc) |
| Local CLI profile | **`colonel2`** — configured & **VERIFIED** 2026-07-24 → `sts get-caller-identity` = 679930074502, user `Colonel-AWS` |
| Console access for this user | **NOT enabled** (CLI only; no human password needed) |

> Drive account #2 with `--profile colonel2` (region `ap-south-1`). Verify anytime:
> `aws sts get-caller-identity --profile colonel2`.

## Not needed for migration
- **Bedrock "API keys"** (the IAM API-keys section): skipped — the app calls Gemini + Claude/Anthropic **directly**, not AWS-hosted models. Add later only if we ever want Bedrock.
- **SSH key**: the assistant will generate the EC2 key pair via CLI at launch (`aws ec2 create-key-pair … > colonel2-key.pem`) — no manual step for the user.

---

## Target instance (account #2) — LAUNCHED & LIVE 2026-07-24
| Field | Value |
|---|---|
| **Instance ID** | **`i-07d81d3f4da578d28`** (t3.large, 2 vCPU / **7.6 GB RAM**), AZ `ap-south-1c` |
| **Elastic IP** | **`13.127.171.66`** (alloc `eipalloc-078d2b2a58fae2690`) — permanent, survives stop/start. (Initial dynamic IP was 13.206.78.128.) |
| **Region** | **`ap-south-1` (Mumbai)** — ALL #2 resources confirmed here (instance ap-south-1c, EIP, AMI, SG, VPC). eu-north-1 empty (only IAM's global console view). |
| **Domain / web** | ✅ **LIVE at `https://agent.accountant`** (+ `www`). GoDaddy DNS `A @ → 13.127.171.66` (600s), `CNAME www → agent.accountant.`. Nginx reverse-proxy (`:80`/`:443` → `127.0.0.1:8001`, `client_max_body_size 512M`, `proxy_read_timeout 600s`). Let's Encrypt cert (expires 2026-10-22, **auto-renew active**), HTTP→HTTPS 301. Browser-verified: login → /admin works. **ngrok RETIRED** (2026-07-24) — OAuth redirect URIs now point at agent.accountant. |
| Launched from | `ami-054dca98d9bb7a50e` (copy of #1's `ami-0e5733cd463ceb17f`), 30 GB gp3 root |
| Node heap | `NODE_OPTIONS=--max-old-space-size=6144` set on `colonel-backend` + `pm2 save` |
| **Runtime** | **Node `v24.18.0`** (NodeSource `node_24.x`, upgraded from 20.20.2 on 2026-07-28 — Node 20 hit end of LTS maintenance April 2026), npm `11.16.0`. **Python `3.12.3`** — system Python, deliberately NOT upgraded (`apt` depends on it; supported to 2028). Ubuntu 24.04.4 LTS. |
| SSH | key **`colonel2-key`** → `~/.ssh/colonel2-key.pem`; `ssh -i ~/.ssh/colonel2-key.pem ubuntu@13.127.171.66` |
| Security group | **`sg-077f835ef2a41e10e`** (22 ← my IP `49.36.122.59/32`; 80/443 ← any) in default VPC `vpc-001d5ca4386fe9a2b`, subnet `subnet-01b52346a4e932582` |
| Swap | 4 GB (inherited from AMI) |
| pm2 | `colonel-backend` (8001, heap 6144) + `reco-engine` (8765) — both online. ngrok process removed. |
| **ngrok** | **CUTOVER DONE** — `ngrok http 8001 --url eggbeater-thesis-crowbar.ngrok-free.dev` now runs on #2 (same authtoken, cloned). **#1's ngrok is STOPPED.** Live URL serves #2, HTTP 200. |
| DB state | cloned from #1 AMI snapshot (agents=34, invoices=170). ⚠️ Any #1 writes between AMI (13:39) and cutover are NOT here — do a final `pg_dump` sync if needed. |

---

## Source of truth to carry over (from account #1)
Everything is captured in the **migration AMI** taken 2026-07-24 (see below). For reference, account #1:
| Field | Value |
|---|---|
| Account ID (#1) | 364503394269 |
| Instance | i-0e3aa71ed74f03aed (t3.small, ap-south-1a) |
| Elastic IP | 43.205.60.250 |
| Security group | sg-0ac6dd941308c2cee |
| ngrok URL | https://eggbeater-thesis-crowbar.ngrok-free.dev |
| SSH key | `~/.ssh/colonel-key.pem` (user: `ubuntu`) |
| App dir | `/opt/colonel` (plain files, NOT git); pm2: reco-engine(0), colonel-backend(1), ngrok(2) |
| DB | single unified `colonel_agent_accountant` (brand_id + RLS, `colonel_app` role) |
| Swap | 4 GB swapfile |

### Migration AMI (fresh, full current state)
- **`ami-0e5733cd463ceb17f`** — name `colonel-migrate-20260724-123929`, `--no-reboot`, created 2026-07-24 07:09 UTC. **State: `available`**, snapshot **`snap-0c08fc3abce5a9eab`** (needed for cross-account snapshot share).
- Contents: Koparo invoice data (146 rows), `receivable_cycle` agent + all-brand assignments, admin/order-cycle UI fixes, backend heap flag, unified DB.
- Older AMIs (fallback): `ami-02ffcfdf01ddd5935` (pre-phase1, 2026-07-23), `ami-07d0e3d7f7b1c44a7` (pre-parity, 2026-07-14).

---

## Migration plan / checklist
Cross-account move (different account ⇒ share, don't launch directly):

- [x] **1. Keys** — ✅ DONE 2026-07-24. Profile `colonel2` verified = 679930074502 / `Colonel-AWS`.
- [ ] **2. Share AMI #1 → #2** (run on account #1): `aws ec2 modify-image-attribute --region ap-south-1 --image-id ami-0e5733cd463ceb17f --launch-permission "Add=[{UserId=679930074502}]"` **and** share the snapshot: `aws ec2 modify-snapshot-attribute --region ap-south-1 --snapshot-id snap-0c08fc3abce5a9eab --attribute createVolumePermission --operation-type add --user-ids 679930074502`.
- [x] **3. Copy AMI into #2** — ✅ `ami-054dca98d9bb7a50e` (available).
- [x] **4. Launch t3.large in #2** — ✅ `i-07d81d3f4da578d28` (chose t3.large over xlarge for credit runway ~3.3mo).
- [x] **5. Bring up services** — ✅ backend(6144 heap)+reco-engine online; ngrok cut over to #2.
- [ ] **6. Data freshness** — ⚠️ PENDING if needed: AMI DB = point-in-time (13:39). If #1 took writes after that, `pg_dump` #1 → restore #2. (Cutover already done, so do this only if something's missing.)
- [~] **7. VERIFY on #2** — ✅ Playwright-verified 2026-07-24: login (admin), dashboard (17 brands/165 runs/real charts), Agents page (34 agents, all card fixes correct — Bank Reco 🏦, Receivable Cycle 📦 in Other, Shopify-Order-Cycle + sales agents in Marketplace). ⏳ STILL TO TEST BY USER: **large FLO order-cycle preview** (the OOM case — needs the friend's files uploaded via browser; should now succeed on 8 GB / heap 6144).
- [x] **8. Cutover** — ✅ DONE — ngrok URL now serves #2. #1 ngrok stopped.
- [x] **9. STOPPED #1** (2026-07-24) — `i-0e3aa71ed74f03aed` stopped (not terminated); disk+data intact, restartable as fallback. Credit-burn stopped. Rollback if ever needed: start #1 → start its ngrok (note: #1 data is pre-cutover snapshot). AMI `ami-0e5733cd463ceb17f` also exists.
- [ ] **10. Elastic IP for #2** — allocate + associate an EIP so the public IP survives stop/start.
- [ ] **11. Security** — delete the `Colonel-AWS` access key (and/or IAM user) after migration.

**Rollback (if #2 misbehaves):** on #2 `pm2 stop ngrok`; on #1 `pm2 start ngrok` → URL back to #1 in seconds.

## Routing / OAuth updated for agent.accountant (2026-07-24)
App-side (done, on #2 `.env` + code, backend restarted; backups `.bak-routing-*`):
- `COMPOSIO_FRONT_URL=https://agent.accountant/integrations`
- `GOOGLE_REDIRECT_URI=https://agent.accountant/api/auth/google/callback` (added)
- `GOOGLE_FRONT_URL=https://agent.accountant/integrations` (added)
- `driveService.js:179` hardcoded ngrok callback → now `process.env.GOOGLE_REDIRECT_URI || https://agent.accountant/...`
- (The app resolves its own host dynamically — `frontend/src/lib/api.js` → same-origin — so no frontend rebuild needed.)

**External provider consoles — USER must update (or OAuth breaks with redirect_uri_mismatch):**
- [~] **Google Cloud Console redirect URI — DEFERRED / low urgency (2026-07-24).** Verified: per-user Google login (Calendar/Meetings) goes via **Composio** (`connectGoogle('googlecalendar')`), so no Google Cloud change needed for login. The Drive-reading agents (MTR / Zepto receivables / order-cycle Drive input) use the `google` integration row's **OAuth refresh_token** (DB: status=connected, has_refresh=true, cloned from #1) — refresh needs no redirect URI, so they keep working on agent.accountant now. **Add `https://agent.accountant/api/auth/google/callback` to OAuth client `107704745882-…` ONLY IF** that Google Workspace connection is ever revoked and must be re-connected via the direct flow. **Do NOT remove the service account / google credential — Drive agents still depend on it.**
- [ ] **Composio** dashboard → auth config → allow callback host `https://agent.accountant` (callbackUrl is sent dynamically from `COMPOSIO_FRONT_URL`, but whitelist if Composio enforces one).
- [ ] **n8n** (invoice feed) → if it POSTs to the ngrok URL, repoint its webhook target to `https://agent.accountant/…`.
- [ ] **Zoho** — env refresh-token based, no runtime redirect; no change unless re-auth.
Only the Google one is strictly required for OAuth login/connect to work on the new domain.

## Go-live + Security hardening (2026-07-24)
**ngrok RETIRED** — `pm2 delete ngrok` on #2; `https://agent.accountant` is the sole public URL (being shared with users). Old ngrok URL now 404. #2 pm2 = `colonel-backend` + `reco-engine` only.

**Authorized pentest (own infra, DB backed up first → `/opt/colonel/backups/pre-pentest-*.sql.gz`; baseline users=23/brands=17/agents=34/invoices=170/reco_jobs=166/70 tables — all intact after):**
- ✅ SQL injection: NOT vulnerable (Sequelize parameterized; UUID params reject injection; `pg_sleep` time-based = no delay; DROP/DELETE payloads neutralized).
- ✅ JWT: signature-flip, **alg:none**, empty → all 401. No alg-confusion.
- ✅ Unauth destructive endpoints (DELETE/POST/PUT users/brands/agents) → 401.
- ✅ Command injection / path traversal → rejected.
- 🔴 **FIXED — CRITICAL: privilege escalation.** `POST /api/auth/register` was PUBLIC and mass-assigned `role` from body → anyone could self-register as **admin** (verified: created an admin). Fix: added `authenticateToken, authorize('admin')` to the route (`authRoutes.js`, backup `.bak-sec-*`); the real admin user-create path is `/api/users` (already admin-guarded). Re-tested → 401, no user created. Test user deleted.
- 🟡 **FIXED — stack-trace leak.** `NODE_ENV=development` → error handler (`app.js:95`) returned `err.stack` to clients. Set `NODE_ENV=production` + restart → errors now clean.
- 🟡 **FIXED — hardening headers.** Added HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy; `server_tokens off`; `proxy_hide_header X-Powered-By`.
- 🟢 Noted (low, not fixed): backend sends `Access-Control-Allow-Origin: *` and 500s echo DB error text (`invalid input syntax for type uuid …`). Low risk (JWT-in-header auth, no cookies) — tighten later if desired. Also `.env DB_USER=postgres` (superuser → RLS bypassed at DB; app relies on code-level brand scoping) — inherited from #1, unchanged.
- 🟡 **FIXED — brute-force / credential-stuffing.** Added nginx rate-limit on `POST /api/auth/login`: `limit_req_zone …rate=10r/m` + `location = /api/auth/login { limit_req zone=login burst=5 nodelay; limit_req_status 429; }` (in `/etc/nginx/conf.d/ratelimit.conf` + site config; proxy settings moved to server-level so all locations inherit). Verified: 6th+ rapid attempt → `429`. Legit login unaffected.
- 🟡 **Added — auto OS security updates:** `unattended-upgrades` installed + enabled (unattended kernel/security patching).
- Research basis (2026 OWASP/Express hardening): parameterized queries ✅, security headers ✅, auth rate-limit ✅ now done. Future nice-to-haves: `helmet` in-app, `npm audit`/Snyk on deps, tighten CORS.
- Ports: only 22 (my IP), 80, 443 open; 8001/8765/5432 not externally reachable. `.env`/source not web-served (SPA fallback returns index.html, not file contents).
- ✅ **DNSSEC ENABLED** on GoDaddy for `agent.accountant` (2026-07-24) — domain status "signed", DS records auto-published (GoDaddy is registrar + DNS host), key-change alerts → `tech@colonel.co.in`. Protects against DNS spoofing/cache-poisoning of the production domain.

**GoDaddy free items — status:** DNSSEC ✅ done. **Deferred by user:** GoDaddy account **2-Step Verification** (do later — critical: stops domain-panel takeover / A-record repoint / domain theft). Other free extras (domain forwarding, social subdomains, WebsiteBuilder free tier, WHOIS privacy) = not needed. **Email @agent.accountant** = GoDaddy's is paid/trial; free routes = email forwarding or Zoho Mail free tier (5 users) — not set up yet.

---

## 2026-07-28 — Node 24 upgrade, bank-classifier deploy, learning reconciliation

### Rollback points (take these before trusting anything below)
| Artefact | Covers |
|---|---|
| **`ami-0a41e4da9e52b6db9`** | name `colonel-prod-2-pre-node24-20260728-030609`, `--no-reboot` (zero downtime), **State: available**. Whole box as it stood on **Node 20**. This is the Node-upgrade rollback. |
| `~/backups/pre-payeekeys-20260727-211539/` | `full.sql.gz` (14 MB, 71 tables) + `bank_payee_directory.sql.gz`, both `gzip -t` verified. DB before the Zaydn key push + phone-key deletion. |
| `~/backups/pre-multi-deploy-20260727-204803/` | `pdf_bank_extractor.py`, `googleAccountsController.js`, `format_templates/`, and **`env.backup`** + **`env.before-googlesuper`**. |
| `~/backups/pre-cache-deploy-20260727-203445/` | `classify.py`, `bankCorrectionsController.js`, `payee_key_fixtures.json` + a full DB dump. |
| `/etc/apt/sources.list.d/nodesource.sources.bak-node20` | apt repo definition, to revert the runtime without the AMI. |
| `~/.pm2/dump.pm2` | saved process list — `pm2 resurrect` if the daemon ever comes up empty. |

### Node 20.20.2 → 24.18.0
**Why:** Node 20 ("Iron") reached end of LTS maintenance in **April 2026** — production was on an unpatched runtime. Matching the dev Mac (24.15) was a secondary benefit.

**Why it was safe here:** the backend has **zero native modules** — no compiled `.node` binary across 281 packages, so nothing needed rebuilding against a new ABI — and of the 159 packages declaring an `engines.node` range, **none caps below 24**.

**Procedure used (repeat this shape for the next major):**
1. AMI with `--no-reboot` → wait for `available`.
2. `npm ci --dry-run` to prove lock/`package.json` are in sync (a clean fallback).
3. `sed -i 's|node_20.x|node_24.x|' /etc/apt/sources.list.d/nodesource.sources` → `apt-get update` → `apt-get install -y nodejs`. **The app keeps serving throughout** — running processes hold their own node binary until restarted.
4. **Before restarting:** `node --check` sweep over all 166 JS files + a `require()` smoke test of the core deps and the app graph, all under the new Node.
5. `pm2 save` (resurrect safety net) → `pm2 update` (restarts the God daemon + all processes under the new runtime).
6. Verify: `node -v` of the running pid, health endpoints, error-log mtime vs process start time, and the payee-key parity test.

**Verified after:** backend on `v24.18.0`; `agent.accountant` 200; `/api/health` 200; `/api/google/accounts` 401; `POST /api/auth/register` **401 (still admin-locked)**; payee-key parity + python suites ALL PASS; **zero new errors** (error.log last write 12:01:26 vs process start 21:41:49).

**Python stays 3.12.3.** Ubuntu 24.04 ships it as the system Python and `apt` depends on it. Supported to 2028, and every reco module compiles on it. If 3.14 is ever needed, use a venv alongside — never replace the system one.

### Node version is now pinned
`new-backend/package.json` carries `"engines": { "node": ">=24" }` on **both** sides, and the repo root has `.nvmrc` = `24`. `engine-strict` was deliberately NOT enabled (it would hard-fail a teammate's install over a mismatch that may not affect their work). Note `engines` fires on `npm install`, and deploys here are rsync of named files — so the real protection is `.nvmrc` keeping dev on the same major, plus the `node --check` sweep before restart.

### Code deployed (rsync, named files only)
`classify.py` (LLM batching + prompt caching, ~50x fewer input tokens), `bankCorrectionsController.js`, `payee_key_fixtures.json`, `pdf_bank_extractor.py` (rupee-balance / Bank-of-India layout), 7 format templates (add-only — AWS had 17 the Mac did not), `googleAccountsController.js` (Google Super multi-slug login).

### Config change
**`GOOGLE_LOGIN_SLUG=googlesuper`** appended to `/opt/colonel/new-backend/.env` (backup: `env.before-googlesuper`). The code defaults to `'gmail'` when unset, which is why deploying the controller alone changed nothing visible. Existing gmail connections are unaffected — `LOGIN_SLUGS` accepts both for detection. The button copy ("Sign in with your work mail") is static and does **not** change; judge it by the scopes on the Google consent screen.

### Bank-classifier learning reconciled
| Move | Direction | What |
|---|---|---|
| Urban Plant | AWS → local | 15 payee keys + 1 side rule (`AMAZON SEL` → receipt/payment pair). Both sides now **657 keys / 10 rules**. |
| Zaydn | local → AWS | **46 of 48** keys. AWS had been running on seed keys only — no backfill had ever executed there. 795 → 841. |
| Zaydn | deleted on AWS | 4 phone keys beginning `2`/`3` — not valid Indian mobiles (those start 6–9), so they were transaction references mis-read as phone numbers. 841 → **837**. |

**Two keys deliberately withheld from production:** `name|autopay` and `name|reserve2` → *Office Expense*. They were the accountant's answers for specific rows but are generic transaction tokens, not payees; as directory keys they would fire at High confidence on any narration containing the word. **Local 839 / AWS 837 is the intended end state, not drift.**

Verified after: **zero orphaned keys across all 17 brands** (every key points at a ledger in its own brand's CoA), and zero rows with `NULL brand_id`.

### ⚠️ /opt/colonel is NOT a git checkout
It is rsync-deployed, so drift accumulates in **both** directions. Two production-only fixes were found and recovered into git on 2026-07-28 — the `/register` admin lock and the `agent.accountant` OAuth redirect (git still had the dead ngrok URL hardcoded). A wholesale directory sync would have silently reverted both. **Deploy named files only; checksum-compare against the box first** (`md5sum` there vs `git show HEAD:<path> | md5 -q`), and re-audit with `rsync -rcn` after.

---

## 2026-08-03 — Latest AMIs (current rollback points)

Newest first, account `679930074502`, `ap-south-1`. Query:
`aws ec2 describe-images --profile colonel2 --region ap-south-1 --owners self --query "reverse(sort_by(Images,&CreationDate))[].{Created:CreationDate,AMI:ImageId,Name:Name,State:State}" --output table`

| AMI | Created (UTC) | Name | Notes |
|---|---|---|---|
| **`ami-07e1584aec7fd0db9`** ← **LATEST** | 2026-08-04 13:09 | `colonel-prod-2-invoice-8brands-20260804-183934` | **8 brands LIVE** on Invoice Process (Koparo/Nestroots/Shumee Playroom/Urban Plant/Stroom/Plenaire/Dichika/Biglilpeople): per-brand maintenance allowlist + "Processing X of N" counter + startRun self-heal + space→underscore `.env` key fix + `file_inputs` column + Google Drive Folder button (live bundle `main.8c449fb9.js`, hot-patched). New sales-fixes 6 commits NOT on box — local `main` only. `--no-reboot`. |
| **`ami-0e10879f7ef908725`** | 2026-08-03 07:49 | `colonel-post-invoice-maint-ai-20260803-1319` | Box after invoice UI + maintenance + AI Everywhere widget (bundle `main.8df54fc7.js`). Sales-fixes NOT in it (on `colonel-aws/main` `409e66c` only). Taken `--no-reboot`. |
| `ami-0186738f76c78ff94` | 2026-07-30 19:46 | `colonel-post-deploy-20260731-0116` | Box **after** the 07-31 deploy. State: available. |
| `ami-0ad6bdf282452684d` | 2026-07-30 19:19 | `colonel-pre-deploy-20260731-0049` | Box **before** the 07-31 deploy. State: available. |
| `ami-0a41e4da9e52b6db9` | 2026-07-27 21:36 | `colonel-prod-2-pre-node24-20260728-030609` | Node-20 (pre-Node-24 upgrade) rollback. |
| `ami-054dca98d9bb7a50e` | 2026-07-24 07:38 | `colonel-prod-migrated-20260724` | Original migrated box (#1→#2). |

**Latest AMI `ami-07e1584aec7fd0db9` (2026-08-04) captures the current live box** — 8 brands live on Invoice Process, distinct-invoice counter + startRun self-heal, space-key `.env` fix, `file_inputs` column, and the Google Drive Folder button (all in live bundle `main.8c449fb9.js`, hot-patched — NOT yet reconciled into source). The new **sales-fixes 6 commits** (X2Beta across marketplaces, gstr1-working) are merged into local `main` but **NOT deployed** to the box. Previous: **Latest AMI `ami-0e10879f7ef908725` (2026-08-03) captured the box** — invoice UI + maintenance mode + AI Everywhere widget (bundle `main.8df54fc7.js`). It does **NOT** contain the **sales-fixes** merge (Amazon/Flipkart/JioMart X2Beta Tally export, B2C ship-state split, SKU master lookup, Workflows tiles) — those live on `colonel-aws/main` `409e66c` and are **not deployed** to the box. So this AMI = the intended rollback point for everything-except-sales-fixes. (The repo `CLAUDE.md` "Latest rollback AMI" header still cites the older `ami-0a41e4da9e52b6db9` — update it too if you rely on it.)

---

## 2026-08-06 — Reco engine now runs TWO processes (GIL fix)

**Rollback point:** AMI **`ami-0e1ddda80748469ff`** (`colonel-pre-2engine-20260806-201003`, `--no-reboot`, State: available) · DB dump `~/backups/pre-2engine-20260806-144020/` (17 MB, `pg_restore -l` verified) · on-box file backups tagged `.bak-2eng-20260806-150408` · `~/.pm2/dump.pm2.bak-2eng-*`.
Baseline at backup: 25 users / 19 brands / 646 brand_agents / 244 reco_jobs / 682 invoice_process / 3,247 payee keys / 72 tables.

**Problem.** The reco engine is a single-process Python `ThreadingHTTPServer`. The GIL caps one process at **one CPU core** for CPU-bound work, so `MAX_CONCURRENT_RECO` only admits more threads — it never adds cores. Measured on the live box: **1 concurrent job = 45.7% CPU, 2 concurrent = 46.4%** on 2 vCPUs. One core both times; the second core idled.

**Now running:** `reco-engine` on **8765** and `reco-engine-2` on **8766**, each `MAX_CONCURRENT_RECO=1` (one job per vCPU). Backend load-balances via a new pool module.

### Verified on production 2026-08-07 (real FLO 4-state multistate data)

Two concurrent multistate recos fired from **the box itself** (so upload latency is zero — see the caveat below), instantaneous CPU sampled via `/proc/<pid>/stat` deltas:

```
08:14:19  e1=100.0%  e2=100.0%   <<< BOTH vCPUs BUSY
08:14:20  e1=100.0%  e2= 99.0%
...15 consecutive samples...
peak e1=101%   peak e2=100%   simultaneous-busy samples=15
```

Dispatch confirmed by engine access logs: `engine-1 401→404`, `engine-2 4→5`. Results byte-consistent across sequential and concurrent runs (111 rows, 4 states, Matched 56 / Partially 1 / In-2B-not-Books 20 / In-Books-not-2B 34).

### ⚠️ Real speedup is ~1.22×, NOT 2× — t3.large is ONE physical core

```
lscpu:  Socket(s)=1   Core(s) per socket=1   Thread(s) per core=2
```

The two vCPUs are **hyperthreads of a single physical core**, so they share execution units. Measured on the same dataset:

| | time |
|---|---|
| Sequential, two jobs | 8.66s + 8.84s = **17.5s** |
| Concurrent, two jobs | **14.4s** (each job 14.4s) |
| **Throughput gain** | **~1.22×** |

Note each individual job got *slower* (8.7s → 14.4s) while total throughput improved. That is expected hyperthreading behaviour, not a fault.

**So what this change actually bought:** ~1.22× throughput, plus **fairness** (a short reco no longer sits fully blocked behind a long one) and **redundancy** (staggered nightly restarts keep one engine always serving). A true ~2× needs an instance with **two physical cores** — `t3.xlarge` (4 vCPU = 2 cores). Revisit only if reco latency becomes a real complaint; the box is idle the vast majority of the time (24h avg CPU 0.4–19%).

**Measurement caveat for anyone repeating this:** running the test from a laptop measures your *uplink*, not the engines. From a home connection the 12-file multistate payload is 319 KB at ~34 KB/s ≈ 9.2s of pure upload, with engine CPU under 1%. Always test from the box. Also note `ps -o %cpu` reports the process **lifetime average** and will show ~0% for a short burst on a long-lived process — use `/proc` jiffy deltas.

| pm2 process | port | env |
|---|---|---|
| `reco-engine` | 8765 | `RECO_PORT=8765`, `MAX_CONCURRENT_RECO=1`, `PYTHONUNBUFFERED=1` |
| `reco-engine-2` | 8766 | `RECO_PORT=8766`, `MAX_CONCURRENT_RECO=1`, `PYTHONUNBUFFERED=1` |
| `colonel-backend` | 8001 | `NODE_OPTIONS=--max-old-space-size=6144` (**unchanged**) |

**Deployed (4 named files, rsync, all checksum-verified):** `reco-engine/server.py` (new `resolve_port()` reading `RECO_PORT`, default 8765 — `main()` only), `new-backend/src/lib/enginePool.js` (**new**), `recoController.js`, `gstr3bController.js`. `.env` gained `PYTHON_RECO_URLS=http://localhost:8765,http://localhost:8766`. **No reconciliation or agent logic changed — dispatch/transport only.**

**Why plain round-robin is safe here** (verified, not assumed):
- The backend only calls `POST /api/reconcile` (synchronous) and `GET /api/jobs/<id>/export.xlsx`. It **never** polls the plain status endpoint, so no status-side disk fallback was needed.
- Every agent pre-builds `_xlsx_bytes`; all three `= None` assignments are `except` branches. `_JobStore` persists to `RECO_OUTPUT_DIR` (`/opt/colonel/reco-engine/exports`, resolved from the **script path**, so both processes share it regardless of cwd), and `export_job()` falls back to that disk copy. Cross-process export proven: engine B served engine A's job byte-identically.
- The pool still tries the originating engine first, purely to preserve the on-demand rebuild path if a pre-build ever fails.

**Gotchas learned:**
- ⚠️ **Never `pm2 restart colonel-backend --update-env`** — it replaces the process env from the calling shell and would silently **drop `NODE_OPTIONS`**, halving the heap. A plain `pm2 restart` is correct: dotenv re-reads `.env` (loaded via `src/config/database.js:6`, which runs before the controllers even though `server.js` calls `dotenv.config()` *after* `require('./src/app')`).
- Node heap stays **6144**. Two concurrent recos cost only **+53 MB** engine RSS against ~6.6 GB free — the memory worry was unfounded, and 6144 exists to fix the FLO order-cycle OOM.
- The local `colonel-automation` checkout was on branch `zepto-recivables` with 3 undeployed Zepto commits (drive_assignments slots, xlsx persistence). **`main` is the branch matching production** — deploying from the feature branch would have shipped unrequested agent-logic changes. Always checksum local-vs-box before editing.
- Sustained two-core load burns t3 credits ~2× faster and the instance is `unlimited` (surplus is billable). Alarms `colonel-cpu-credits-low` / `colonel-cpu-surplus-billing` exist — but the SNS subscription for `tech@colonel.co.in` was **PendingConfirmation**, i.e. silent. Confirm that email.

### 2026-08-07 follow-ups (all done)

- **Nightly cron now covers both engines, staggered.** `/opt/colonel/memory-hygiene.sh` restarted only `reco-engine`, so engine-2 never got its RAM reset (visible as `reco-engine restarts=16` vs `reco-engine-2 restarts=0`). Now: restart engine-1 → `sleep 15` → restart engine-2, so **one engine is always serving**. A reco running at 21:30 survives, which the single-engine setup could never do. Backup `memory-hygiene.sh.bak-2eng-20260807-074945`. Verified by running the script manually, not by waiting for the cron.
- **Env survives restarts.** After the cron restart both processes still carry their correct `RECO_PORT` / `MAX_CONCURRENT_RECO=1`, and the backend still has `NODE_OPTIONS=--max-old-space-size=6144`.
- **SSH allowlist:** added `103.171.50.73/32` (rule `sgr-0275363b74da1fa05`, "dhaval mac 2026-08-07"). The dev Mac's IP is dynamic and this list now holds **8** entries that never expire — worth pruning, or replacing with SSM Session Manager which needs no IP allowlist at all.
- **CLAUDE.md rule 4 is stale, not violated.** It says Vendor Summary is the *second* sheet with 20 columns; actual multistate output has it 8th with **21** columns — and a pre-change export from before this work has it 4th with **21** columns too. `diff` of deployed `server.py` against the pre-change on-box backup shows **only** `resolve_port()` + two lines of `main()`, so `build_workbook` is byte-identical. Sheet position is data-driven (the engine emits one tab per 2B section present: B2B / B2BA / CDNR / CDNRA). Fix the doc line, not the code.

Rollback to one engine (no code revert needed): `pm2 delete reco-engine-2 && pm2 save`. The pool tolerates a dead sibling — `enginesForJob` just falls through.

Plan + verification steps: `docs/superpowers/plans/2026-08-06-reco-engine-second-process.md`.

---

## Notes
- The order-cycle 503 (`ERR_NGROK_3004`) on #1 is a **RAM ceiling**, not a code bug — the job computed `66,560 rows / 60,310 exceptions` from 235k+143k+66k input rows, then OOM'd building the output on the 1.9 GB box. t3.xlarge + 8 GB heap resolves it. See [[project_bank_reco]] / memory `reference_ec2_frontend_deploy`.
- Keep this file updated as keys/region/instance are confirmed and each checklist item completes.

# AWS Parity Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Accuracy note:** This plan was hardened by a 6-agent read-only verification pass (2026-07-14). Corrections from that pass are marked `[VERIFIED]`.

**Goal:** Bring the live AWS EC2 site to full parity with local port-3000 — unified single DB, current UI, all features — with AWS's real production data preserved and a proven rollback path.

**Architecture:** DB-first freeze cutover. Freeze AWS → capture its frozen data → rebuild the unified DB **locally** from that data + re-apply the feature layer → deploy the verified stack (code + UI + unified DB) to `/opt/colonel` in one cutover → relaunch on unified-only. The box is only touched with an artifact already proven locally. Rollback = AMI + retained 17 per-brand DBs + `/opt/colonel` tar.

**Tech Stack:** Node/Express (`new-backend`, :8001), React 18 + craco (`frontend`, build served by backend), Python reco-engine (:8765), PostgreSQL 16, pm2, ngrok, AWS EC2 (ap-south-1), `aws` CLI.

## Global Constraints

- **Branch:** all work on `aws-parity` (off `main` @ `b12fd0b`). Never push to `origin`. Push `aws-parity` to `colonel-aws` ONLY after a successful, verified deploy.
- **DO NOT edit the running port-3000 app.** The ONLY change to 3000 is its **DB receiving AWS's latest data** (the freeze→pull→rebuild — this is the "push the new data to 3000" the user asked for). 3000's DB **structure** is preserved. All AWS-specific **code** prep happens in an **isolated git worktree** so the primary 3000 working tree stays pristine.
- **UUIDs come FROM 3000.** AWS's post-migration brand/agent UUIDs are 3000's unified-DB UUIDs (we deploy 3000's DB). AWS's old `d0000000…`/per-brand ids are retired. `reco_jobs.agent_type` is a string, so analytics survive.
- **Back up BOTH sides.** AWS: AMI + all-17-DB dumps + `/opt/colonel` tar. Local: dump the unified DB before rebuild + the `aws-parity` branch is the code safety net.
- **Back up every file/DB touched** — local → `scratchpad-backups/aws-parity-<ts>/`; box → `/tmp/<name>_$(date +%s)` or `/opt/colonel/backups/`.
- **Box:** `ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250`; app root `/opt/colonel` (plain files, NOT git); pm2 procs `colonel-backend`, `reco-engine`, `ngrok`; Postgres TCP `127.0.0.1` `postgres`/`postgres` (confirm from box `.env` `DB_PASSWORD`); master DB name is **`colonel-master`** (hyphen); node v20.
- **Local:** repo `/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation`; unified DB `colonel_agent_accountant`; Postgres `postgres`/`postgres` (`export PGPASSWORD=postgres`); pm2 proc `colonel-automation-backend`.
- **zsh gotchas:** do NOT rely on word-splitting of unquoted vars; never name a var `UID`; always use the full quoted repo path.
- **AWS instance:** `i-0e3aa71ed74f03aed`, region `ap-south-1`, Elastic IP `43.205.60.250`; `aws` CLI at `/opt/homebrew/bin/aws` (user `colonel-deploy`).
- **End state:** AWS uses ONLY `colonel_agent_accountant`; the 17 per-brand DBs are retained but unused (rollback only).
- **Roles unchanged:** `chauhandhaval932@gmail.com` = accountant; `dhaval.colonel@gmail.com` = admin on AWS.
- **Keys `[VERIFIED]`:** exact env var names are `COMPOSIO_API_KEY`, `GSK_API_KEY` (NOT `GENSPARK_API_KEY`), `FIREFLIES_API_KEY`. **None exist in the box `.env` or in `.env.example`** — they must be ADDED. No secrets are hardcoded in committed source. Rotate Composio + GenSpark before public relaunch; real keys only in the box `.env`.

---

## Phase 0 — Safety net (both sides)

### Task 0.1: Confirm branch + local backup dir + local DB backup

- [ ] **Step 1: Confirm on `aws-parity`**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
git branch --show-current
```
Expected: `aws-parity`

- [ ] **Step 2: Create the timestamped local backup dir**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
export BK="scratchpad-backups/aws-parity-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BK"; echo "$BK" | tee scratchpad-backups/.aws-parity-current
```

- [ ] **Step 3: Back up the LOCAL unified DB (3000 safety net, before anything)**

```bash
export PGPASSWORD=postgres
BK=$(cat "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation/scratchpad-backups/.aws-parity-current")
pg_dump -U postgres -h localhost -Fc --no-owner colonel_agent_accountant -f "$BK/local_unified_PHASE0.dump"
ls -la "$BK/local_unified_PHASE0.dump"
```
Expected: dump present (~1.2 MB).

### Task 0.2: AMI snapshot of the live box (ultimate AWS rollback)

- [ ] **Step 1: Create the AMI (no-reboot, site stays up during Phase 0)**

```bash
/opt/homebrew/bin/aws ec2 create-image --region ap-south-1 \
  --instance-id i-0e3aa71ed74f03aed \
  --name "colonel-pre-parity-$(date +%Y%m%d-%H%M%S)" \
  --description "Full live box before AWS parity migration" \
  --no-reboot --output text
```
Expected: prints an AMI id `ami-...`. Record it.

- [ ] **Step 2: Wait until available**

```bash
/opt/homebrew/bin/aws ec2 wait image-available --region ap-south-1 --image-ids <ami-id> && echo "AMI READY"
```

- [ ] **Step 3: Record the AMI id in the branch**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
echo "AMI (pre-parity rollback): <ami-id>  $(date)" >> docs/superpowers/plans/2026-07-14-aws-parity-migration.md
git add docs/superpowers/plans/2026-07-14-aws-parity-migration.md
git commit -m "chore(aws-parity): record pre-migration AMI id"
```

### Task 0.3: On-box code + config backups

- [ ] **Step 1: Tar `/opt/colonel` + back up build/app.js/.env on the box**

```bash
ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'bash -s' <<'EOF'
TS=$(date +%s)
sudo tar czf /tmp/opt_colonel_backup_$TS.tgz -C /opt colonel 2>/dev/null
cp -a /opt/colonel/frontend/build /tmp/fe_build_backup_$TS
cp -a /opt/colonel/new-backend/src/app.js /tmp/app.js_backup_$TS
cp -a /opt/colonel/new-backend/.env /tmp/backend_env_backup_$TS 2>/dev/null
ls -la /tmp/opt_colonel_backup_$TS.tgz /tmp/fe_build_backup_$TS /tmp/app.js_backup_$TS
echo "BOX BACKUPS DONE ts=$TS"
EOF
```
Expected: lists artifacts; prints ts. Record it.

---

## Phase 1 — Freeze AWS + capture final data

### Task 1.1: Freeze the site

- [ ] **Step 1: Stop backend + ngrok (keep Postgres + reco-engine up for dumping)**

```bash
ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'pm2 stop colonel-backend ngrok && pm2 list | sed "s/\x1b\[[0-9;]*m//g" | grep -E "colonel-backend|ngrok|reco-engine"'
```
Expected: `colonel-backend` + `ngrok` = `stopped`; `reco-engine` = `online`.

- [ ] **Step 2: Confirm the public site is down `[VERIFIED: no /api/auth/health endpoint exists]`**

```bash
curl -s -o /dev/null -w "root=%{http_code}\n" --max-time 10 https://eggbeater-thesis-crowbar.ngrok-free.dev/ 2>/dev/null || echo "unreachable (expected — frozen)"
```
Expected: non-200 (502/522) or unreachable — ngrok has no backend to tunnel to.

### Task 1.2: Read-only dump of all 17 DBs → local

- [ ] **Step 1: On the box, dump every `colonel%` DB**

```bash
ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'bash -s' <<'EOF'
D=/tmp/aws-parity-dumps-$(date +%Y%m%d-%H%M%S); mkdir -p "$D"
for db in $(sudo -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'colonel%'"); do
  sudo -u postgres pg_dump -Fc --no-owner --no-privileges "$db" -f "$D/${db}.dump" && echo "  dumped $db"
done
sudo chown ubuntu:ubuntu "$D"/*.dump
echo "$D" > /tmp/aws-parity-dumps-latest.txt
ls "$D" | wc -l; echo "DUMP DIR: $D"
EOF
```
Expected: 17; prints dump dir.

- [ ] **Step 2: scp the dumps down**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
BK=$(cat scratchpad-backups/.aws-parity-current)
D=$(ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'cat /tmp/aws-parity-dumps-latest.txt')
mkdir -p "$BK/aws-dumps"
scp -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250:"$D/*.dump" "$BK/aws-dumps/"
ls "$BK/aws-dumps/" | wc -l
```
Expected: `17`.

---

## Phase 2 — Build unified DB locally (AWS final data + feature layer)

> `[VERIFIED]` `refresh-from-aws.sh` clones `colonel_agent_accountant` from `$BK/colonel_agent_accountant.CURRENT.dump` (a pre-existing dump — NOT the live DB), restores the fresh AWS per-brand dumps to scratch, TRUNCATEs only reco/sales data, and KEEPS feature/org tables (statutory/compliance/zoho/brand_users). So it needs the current-unified dump present as `CURRENT.dump`.

### Task 2.1: Provide the CURRENT unified dump the refresh script expects

- [ ] **Step 1: Copy the Phase-0 local dump into the name the script reads**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
BK=$(cat scratchpad-backups/.aws-parity-current)
cp -a "$BK/local_unified_PHASE0.dump" "$BK/colonel_agent_accountant.CURRENT.dump"
ls -la "$BK/colonel_agent_accountant.CURRENT.dump"
```

### Task 2.2: Rebuild unified from AWS's frozen dumps

- [ ] **Step 1: Stop the local backend (avoid DB contention)**

```bash
pm2 stop colonel-automation-backend 2>/dev/null; echo "local backend stopped"
```

- [ ] **Step 2: Run the refresh script**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
BK=$(cat scratchpad-backups/.aws-parity-current)
export PGPASSWORD=postgres
export AWSDIR="$BK/aws-dumps"
export BK="$BK"
bash db-restructure/refresh-from-aws.sh 2>&1 | tail -25
```
Expected: builds `colonel_agent_accountant_awsdata`; per-brand "loaded" lines; `DONE building`.

- [ ] **Step 3: Verify latest data + preserved features + UUIDs-from-3000**

```bash
export PGPASSWORD=postgres
q(){ psql -U postgres -h localhost -d colonel_agent_accountant_awsdata -tAc "$1"; }
echo "reco_jobs=$(q "SELECT count(*) FROM reco_jobs") latest=$(q "SELECT max(created_at) FROM reco_jobs")"
echo "statutory_filings=$(q "SELECT count(*) FROM statutory_filings")  brands=$(q "SELECT count(*) FROM brands")  agents=$(q "SELECT count(*) FROM agents")"
echo "-- UUIDs must match 3000 (random UUIDs), NOT AWS legacy d0000000: --"
q "SELECT 'legacy_agent_ids='||count(*) FROM agents WHERE id::text LIKE 'd0000000-%'"
q "SELECT 'sample brand: '||name||' '||id FROM brands ORDER BY name LIMIT 1"
```
Expected: `reco_jobs`≈129 latest `2026-07-14 11:51`; `statutory_filings=2367`; `brands=16`; `agents`≈33; `legacy_agent_ids=0` (confirms 3000's UUIDs, not AWS legacy).

### Task 2.3: Re-apply / verify the feature layer

- [ ] **Step 1: Ensure statutory_config exists + feature data survived**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
export PGPASSWORD=postgres
psql -U postgres -h localhost -d colonel_agent_accountant_awsdata -v ON_ERROR_STOP=1 -f db-restructure/010-statutory-config.sql
psql -U postgres -h localhost -d colonel_agent_accountant_awsdata -tAc "SELECT b.name||': '||count(*) FROM statutory_filings f JOIN brands b ON b.id=f.brand_id GROUP BY b.name ORDER BY b.name"
```
Expected: Stroom 375, Shumee Toys 624, Shumee Playroom 624, M Brands 384, Urban Plant 360.

- [ ] **Step 2: (Only if Step 1 shows 0 statutory rows) re-import against the clone `[VERIFIED: use UNIFIED_DB_NAME, not a target flag]`**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
export PGPASSWORD=postgres
UNIFIED_DB_NAME=colonel_agent_accountant_awsdata node db-restructure/import-statutory.js
```

- [ ] **Step 3: Verify chauhandhaval932 brand assignments on the clone**

```bash
export PGPASSWORD=postgres
psql -U postgres -h localhost -d colonel_agent_accountant_awsdata -tAc "SELECT b.name FROM brand_users bu JOIN brands b ON b.id=bu.brand_id JOIN users u ON u.id=bu.user_id WHERE u.email='chauhandhaval932@gmail.com' ORDER BY b.name" | tr '\n' ', '
```
Expected: includes Koparo, M Brands, Other, Shumee Playroom, Shumee Toys, Stroom, Urban Plant.

### Task 2.4: On-disk file references — VERIFIED, no remap needed

> `[VERIFIED]` Box has **no** `ledgers/` dir and **no** uploads/attachments dir. Output files DO embed UUIDs: `new-backend/output/reco/` (~70 bare-UUID xlsx = **reco_job ids**), `new-backend/outputs/` (channel+brand-name+UUID), `Extra/outputs/`. They are keyed by **reco_job id** (preserved verbatim through dump/restore) and **brand name** (unchanged) → **no rename/remap required**. They must simply be PRESERVED (excluded from the Phase 4 rsync).

- [ ] **Step 1: Note the box output dirs (read-only) so Phase 4 excludes are correct**

```bash
ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'echo reco:; ls /opt/colonel/new-backend/output/reco 2>/dev/null | wc -l; echo outputs:; ls /opt/colonel/new-backend/outputs 2>/dev/null | wc -l; echo ledgers:; ls /opt/colonel/new-backend/output/ledgers 2>/dev/null | wc -l'
```
Expected: reco ~70, outputs ~6, ledgers 0.

### Task 2.5: Promote the clone → local unified DB (the allowed "push new data to 3000")

- [ ] **Step 1: Swap clone into place (data-only change to 3000; structure preserved)**

```bash
export PGPASSWORD=postgres
psql -U postgres -h localhost -tAc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('colonel_agent_accountant','colonel_agent_accountant_awsdata') AND pid<>pg_backend_pid()" >/dev/null
psql -U postgres -h localhost -c "ALTER DATABASE colonel_agent_accountant RENAME TO colonel_agent_accountant_preparity"
psql -U postgres -h localhost -c "ALTER DATABASE colonel_agent_accountant_awsdata RENAME TO colonel_agent_accountant"
psql -U postgres -h localhost -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'colonel_agent%'"
```
Expected: `colonel_agent_accountant` (new) + `colonel_agent_accountant_preparity` (rollback).

- [ ] **Step 2: Restart local backend + smoke test**

```bash
pm2 restart colonel-automation-backend >/dev/null 2>&1; sleep 4
curl -s -X POST http://localhost:8001/api/auth/login -H 'Content-Type: application/json' -d '{"email":"dhaval.colonel@gmail.com","password":"dhaval123"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print('role=',(d.get('user') or {}).get('role'))"
```
Expected: `role= admin`.

- [ ] **Step 3: Produce the deploy dump + refresh the committed seed**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
export PGPASSWORD=postgres
BK=$(cat scratchpad-backups/.aws-parity-current)
cp -a db-seed/dumps/colonel_agent_accountant.dump "$BK/seed_dump_BEFORE.dump"
pg_dump -U postgres -h localhost -Fc --no-owner colonel_agent_accountant -f db-seed/dumps/colonel_agent_accountant.dump
git add db-seed/dumps/colonel_agent_accountant.dump
git commit -m "data(aws-parity): unified dump = AWS frozen prod data + feature layer (3000 UUIDs)"
```

---

## Phase 3 — Prep code/UI in an ISOLATED worktree (3000 untouched)

> Per constraint: do NOT edit the running-3000 working tree. Do all code edits in a worktree.

### Task 3.1: Create the code-prep worktree

- [ ] **Step 1: Add a worktree on `aws-parity` (separate dir; 3000 tree stays pristine)**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
git worktree add ../colonel-aws-parity aws-parity 2>&1 | tail -2 || echo "(worktree may already exist)"
cd ../colonel-aws-parity && git branch --show-current
```
Expected: `aws-parity`; a sibling dir `colonel-aws-parity`. All Phase-3 edits happen HERE.

### Task 3.2: Add feature keys to `.env.example` `[VERIFIED: currently missing]`

- [ ] **Step 1: Append the three key vars (placeholders only) + commit**

```bash
cd ../colonel-aws-parity
cat >> new-backend/.env.example <<'EOF'

# Feature integrations (set real values only in the deployed .env — never commit secrets)
COMPOSIO_API_KEY=
GSK_API_KEY=
FIREFLIES_API_KEY=
# optional: COMPOSIO_FRONT_URL= , GSK_BASE_URL= , GSK_MODEL=
EOF
git add new-backend/.env.example
git commit -m "chore(aws-parity): document COMPOSIO/GSK/FIREFLIES env vars (placeholders)"
```

### Task 3.3: Meetings — Fireflies primary + fold in Google Calendar

- [ ] **Step 1: Pull the box's calendar code for review**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
BK=$(cat scratchpad-backups/.aws-parity-current); mkdir -p "$BK/box-calendar"
scp -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250:/opt/colonel/new-backend/src/controllers/calendarController.js "$BK/box-calendar/" 2>/dev/null
scp -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250:/opt/colonel/new-backend/src/routes/calendarRoutes.js "$BK/box-calendar/" 2>/dev/null
ls "$BK/box-calendar/"
```

- [ ] **Step 2: Fold in (in the worktree), mounting before the SPA block `[VERIFIED pattern]`**

- Copy `calendarController.js` + `calendarRoutes.js` into `../colonel-aws-parity/new-backend/src/{controllers,routes}/`.
- In `new-backend/src/app.js`: add `const calendarRoutes = require('./routes/calendarRoutes');` in the top require block (near line 47-54), and `app.use('/api', calendarRoutes);` in the mount cluster (lines 58-83, i.e. BEFORE the error middleware at ~line 86 and the static/SPA block at ~line 95). Back up first: `cp -a new-backend/src/app.js "$BK/app.js.bak"`.
- Fireflies key: it reads `FIREFLIES_API_KEY` — ensure it's in the box `.env` (Task 4.3).

- [ ] **Step 3: Commit**

```bash
cd ../colonel-aws-parity
git add new-backend/src/app.js new-backend/src/controllers/calendarController.js new-backend/src/routes/calendarRoutes.js 2>/dev/null
git commit -m "feat(aws-parity): Fireflies Meetings + fold in Google Calendar view" || echo "no meetings changes"
```

### Task 3.4: Confirm PDF→Bank parity

- [ ] **Step 1: Diff the box's PDF→Bank agent against the branch**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
BK=$(cat scratchpad-backups/.aws-parity-current); mkdir -p "$BK/box-pdfbank"
for f in pdf_bank_extractor.py ilovepdf_ocr.py; do
  scp -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250:/opt/colonel/reco-engine/recon/$f "$BK/box-pdfbank/" 2>/dev/null
  echo "== diff $f =="; diff -q "$BK/box-pdfbank/$f" "reco-engine/recon/$f" && echo "  identical" || echo "  DIFFERS"
done
```
Expected: identical. If DIFFERS and the box copy is the intended newer one, copy it into the worktree and commit (box edit is source of truth for that tool).

### Task 3.5: Assemble the box `.env` template (unified + rotated keys) `[VERIFIED: box .env has none of the feature keys]`

- [ ] **Step 1: USER ACTION — rotate keys**: revoke exposed Composio + GenSpark keys, generate new ones. Keep the values for Step 2.

- [ ] **Step 2: Build the template from the box's current `.env` + required additions**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
BK=$(cat scratchpad-backups/.aws-parity-current)
scp -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250:/opt/colonel/new-backend/.env "$BK/box.env.CURRENT" 2>/dev/null
cp "$BK/box.env.CURRENT" "$BK/box.env.template"
echo "-- EDIT $BK/box.env.template: add/set --"
echo "   USE_UNIFIED_DB=true"
echo "   DB_NAME=colonel_agent_accountant   (was colonel-master)"
echo "   COMPOSIO_API_KEY=<new>  GSK_API_KEY=<new>  FIREFLIES_API_KEY=<value>"
echo "   (keep existing DB creds, JWT, GEMINI/ANTHROPIC/GOOGLE/ILOVEPDF keys, invoice webhooks)"
```
Expected: `box.env.template` created from the box env (preserves all working keys), ready to edit with the unified + rotated additions.

---

## Phase 4 — Cutover deploy (GATED — explicit go per action)

### Task 4.1: Deploy code to `/opt/colonel` `[VERIFIED excludes]`

- [ ] **Step 1: rsync backend + reco-engine + frontend (preserve box-only runtime/learning files)**

```bash
cd ../colonel-aws-parity
KEY=~/.ssh/colonel-key.pem; H=ubuntu@43.205.60.250
# backend: exclude .env, node_modules, build, and box-only runtime dirs (output/, outputs/, test-data/)
rsync -az --delete -e "ssh -i $KEY" --exclude '.env' --exclude 'node_modules' --exclude 'build' \
  --exclude 'output/' --exclude 'outputs/' --exclude 'test-data/' new-backend/ $H:/opt/colonel/new-backend/
# reco-engine: exclude caches + box-accumulated learned templates + backups (KEEP recon/data/Master.xlsx)
rsync -az --delete -e "ssh -i $KEY" --exclude '__pycache__' --exclude 'format_templates/' --exclude '*.bak-*' \
  reco-engine/ $H:/opt/colonel/reco-engine/
# frontend: exclude the live-served build, node_modules, .env (build happens on box)
rsync -az --delete -e "ssh -i $KEY" --exclude 'node_modules' --exclude 'build' --exclude '.env' \
  frontend/ $H:/opt/colonel/frontend/
echo "rsync done"
```
Expected: `rsync done`, no errors.

- [ ] **Step 2: Verify the previously-missing routes + zepto agent landed**

```bash
ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'echo ROUTES:; ls /opt/colonel/new-backend/src/routes | grep -E "statutory|compliance|zoho|meeting|attachments|composio|database|calendar" | tr "\n" " "; echo; echo AGENT:; ls /opt/colonel/reco-engine/recon | grep zepto'
```
Expected: statutory/compliance/zoho/meeting/attachments/composio/database (+calendar) routes; `zepto_receivables.py`.

- [ ] **Step 3: Confirm box-only output dirs survived (were excluded)**

```bash
ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'echo reco:; ls /opt/colonel/new-backend/output/reco 2>/dev/null | wc -l; echo outputs:; ls /opt/colonel/new-backend/outputs 2>/dev/null | wc -l'
```
Expected: same counts as Task 2.4 (nothing deleted; no file remap needed).

### Task 4.2: Restore the unified DB on the box `[VERIFIED invocation]`

- [ ] **Step 1: Copy the deploy dump + restore script to the box**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
KEY=~/.ssh/colonel-key.pem; H=ubuntu@43.205.60.250
ssh -i $KEY $H 'mkdir -p /tmp/parity-seed/dumps'
scp -i $KEY db-seed/dumps/colonel_agent_accountant.dump $H:/tmp/parity-seed/dumps/
scp -i $KEY db-seed/restore.sh $H:/tmp/parity-seed/
echo "seed copied"
```

- [ ] **Step 2: Run restore.sh over TCP (NOT via sudo -u postgres) — creates colonel_app + colonel_agent_accountant, restores dump (RLS baked in the dump), applies grants**

```bash
ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'bash -s' <<'EOF'
# confirm the box postgres TCP password from its .env
PGPW=$(grep -E '^DB_PASSWORD=' /opt/colonel/new-backend/.env | cut -d= -f2-)
cd /tmp/parity-seed && chmod +x restore.sh
PGHOST=127.0.0.1 PGPORT=5432 PGSUPER=postgres PGPASSWORD="${PGPW:-postgres}" ./restore.sh 2>&1 | tail -20
PGPASSWORD="${PGPW:-postgres}" psql -U postgres -h 127.0.0.1 -d colonel_agent_accountant -tAc "SELECT 'brands='||count(*) FROM brands"
PGPASSWORD="${PGPW:-postgres}" psql -U postgres -h 127.0.0.1 -d colonel_agent_accountant -tAc "SELECT 'statutory_filings='||count(*) FROM statutory_filings"
PGPASSWORD="${PGPW:-postgres}" psql -U postgres -h 127.0.0.1 -d colonel_agent_accountant -tAc "SELECT 'reco_jobs='||count(*) FROM reco_jobs"
EOF
```
Expected: `brands=16`, `statutory_filings=2367`, `reco_jobs≈129`. (The 17 per-brand DBs are NOT dropped.)

### Task 4.3: Point the box at the unified DB + rotated keys

- [ ] **Step 1: Upload the prepared `.env` (unified + all keys) + verify**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
BK=$(cat scratchpad-backups/.aws-parity-current)
scp -i ~/.ssh/colonel-key.pem "$BK/box.env.template" ubuntu@43.205.60.250:/opt/colonel/new-backend/.env
ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'chmod 600 /opt/colonel/new-backend/.env; grep -E "USE_UNIFIED_DB|^DB_NAME=|COMPOSIO_API_KEY|GSK_API_KEY|FIREFLIES_API_KEY" /opt/colonel/new-backend/.env | sed "s/=.*/=SET/"'
```
Expected: `USE_UNIFIED_DB=SET`, `DB_NAME=SET`, and the three feature keys `=SET`.

### Task 4.4: Rebuild the frontend on the box `[VERIFIED: build deps already in package.json]`

- [ ] **Step 1: Back up build/, install, rebuild (single npm install — no extra deps needed)**

```bash
ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'bash -s' <<'EOF'
cd /opt/colonel/frontend
cp -a build /tmp/fe_build_precutover_$(date +%s) 2>/dev/null
npm install --legacy-peer-deps 2>&1 | tail -3
npm run build 2>&1 | tail -8
ls -la build/index.html && echo "BUILD OK"
EOF
```
Expected: `BUILD OK`, fresh `index.html`. (`react-is`/`html-to-image`/`@xyflow/react` are already in `dependencies`; `--legacy-peer-deps` covers the react-is@19 vs react@18 peer.)

### Task 4.5: Relaunch on the unified stack

- [ ] **Step 1: Restart backend + reco-engine, bring ngrok up**

```bash
ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'pm2 restart colonel-backend reco-engine && pm2 start ngrok 2>/dev/null; sleep 3; pm2 list | sed "s/\x1b\[[0-9;]*m//g" | grep -E "colonel-backend|reco-engine|ngrok"'
```
Expected: all three `online`.

- [ ] **Step 2: Boot log — unified mode + feature migrations, no crash**

```bash
ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'pm2 logs colonel-backend --lines 40 --nostream | sed "s/\x1b\[[0-9;]*m//g" | grep -iE "unified|statutory|compliance|zoho|port 8001|error" | tail -15'
```
Expected: "running on port 8001", statutory/compliance/zoho "ready", no fatal errors.

---

## Phase 5 — Verify, rollback readiness, push

### Task 5.1: End-to-end smoke test on the live URL `[VERIFIED: no /health — use login/profile]`

- [ ] **Step 1: Site up + API answering (login with bad creds → JSON 4xx, not SPA HTML) + admin login**

```bash
BASE=https://eggbeater-thesis-crowbar.ngrok-free.dev
H='-H ngrok-skip-browser-warning:1'
curl -s -o /dev/null -w "root=%{http_code}\n" $BASE/
curl -s $H -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"email":"x@x","password":"x"}' | head -c 120; echo
curl -s $H -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"email":"dhaval.colonel@gmail.com","password":"<aws admin pw>"}' | python3 -c "import sys,json;d=json.load(sys.stdin);print('role=',(d.get('user') or {}).get('role'),'token=',bool(d.get('token')))"
```
Expected: `root=200`; bad-creds returns a JSON error (proves API, not SPA fallback); admin `role= admin token= True`.

- [ ] **Step 2: Feature endpoint returns data (statutory admin summary)**

```bash
BASE=https://eggbeater-thesis-crowbar.ngrok-free.dev
AT=$(curl -s -H ngrok-skip-browser-warning:1 -X POST $BASE/api/auth/login -H 'Content-Type: application/json' -d '{"email":"dhaval.colonel@gmail.com","password":"<aws admin pw>"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s "$BASE/api/statutory/admin/summary?year=2026" -H "Authorization: Bearer $AT" -H ngrok-skip-browser-warning:1 | python3 -c "import sys,json;d=json.load(sys.stdin);print('brands:',[b['brand_name'] for b in d['brands']])"
```
Expected: all 5 statutory brands listed.

- [ ] **Step 3: Browser smoke test** — log in as admin + as `chauhandhaval932`; verify Statutory (dynamic To-Do/In-Progress/Done for Shumee, filing types for Stroom), Compliance, Zoho, Meetings (Fireflies), Analysis, Database explorer, one reco run. Record pass/fail per feature.

### Task 5.2: Confirm rollback assets

- [ ] **Step 1: Verify AMI + box tar + 17 per-brand DBs all present**

```bash
echo "AMI:"; /opt/homebrew/bin/aws ec2 describe-images --owners self --region ap-south-1 --query "Images[?starts_with(Name,'colonel-pre-parity')].[ImageId,State]" --output text
ssh -i ~/.ssh/colonel-key.pem ubuntu@43.205.60.250 'ls -la /tmp/opt_colonel_backup_*.tgz 2>/dev/null | tail -1; sudo -u postgres psql -tAc "SELECT count(*) FROM pg_database WHERE datname LIKE '\''colonel-%'\'' OR datname LIKE '\''colonel_%'\''"'
```
Expected: AMI `available`; tarball present; 17+ DBs (per-brand retained + new unified).

- [ ] **Step 2: Rollback procedure (documented)** — on box: restore `/opt/colonel` tar, set `.env` back to per-brand (remove `USE_UNIFIED_DB`, `DB_NAME=colonel-master`), `pm2 restart colonel-backend reco-engine && pm2 start ngrok`. The 17 per-brand DBs were never dropped. Deeper: restore the AMI to a new instance + re-associate the Elastic IP. Local rollback: rename `colonel_agent_accountant_preparity` back.

### Task 5.3: Push the branch to Colonel-AWS (only after Task 5.1 all-pass)

- [ ] **Step 1: Push `aws-parity`**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
git push colonel-aws aws-parity 2>&1 | tail -4
git ls-remote --heads colonel-aws | sed 's/\x1b\[[0-9;]*m//g'
```
Expected: `aws-parity` on the Colonel-AWS remote.

- [ ] **Step 2 (optional, after a stable window): fast-forward `main`** — only when the user confirms stability:
```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
git checkout main && git merge --ff-only aws-parity && git push colonel-aws main:main
git checkout aws-parity
```

- [ ] **Step 3: Clean up the code-prep worktree**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
git worktree remove ../colonel-aws-parity 2>/dev/null || echo "(remove manually if needed)"
```

---

## Follow-ups (non-blocking)

- Add `pdfplumber` (+ OCR-fallback deps) to `reco-engine/requirements.txt` — `[VERIFIED]` it's required on EC2 but missing from the file, so a venv rebuild would omit it. (The running box venv already has it; rsync doesn't touch the venv.)

## Self-Review (coverage vs spec)

- Phase 0 (AMI + backups, both sides) → Tasks 0.1–0.3 ✅ (added local DB backup)
- Phase 1 (freeze + pull) → Tasks 1.1–1.2 ✅ (health-check corrected)
- Phase 2 (build unified + features + on-disk audit + UUID-from-3000) → Tasks 2.1–2.5 ✅
- Phase 3 (isolated worktree + keys + Meetings + PDF-bank + env template) → Tasks 3.1–3.5 ✅
- Phase 4 (deploy + restore + rebuild + relaunch) → Tasks 4.1–4.5 ✅ (excludes, restore invocation, build deps corrected)
- Phase 5 (verify + rollback + push) → Tasks 5.1–5.3 ✅ (smoke tests corrected)
- 3000 untouched except DB data ✅ · UUIDs from 3000 ✅ · both sides backed up ✅ · unified-only end state ✅

**Fill at execution time:** `<ami-id>`, dump dir ts, AWS admin password (smoke tests), rotated key values (box `.env` only).

## Phase 0 — EXECUTED 2026-07-14
- **AMI (pre-parity rollback):** `ami-07d0e3d7f7b1c44a7` (colonel-pre-parity-20260714-191534) — state `available`.
- **Local unified DB backup:** `scratchpad-backups/aws-parity-20260714-191531/local_unified_PHASE0.dump` (1.23 MB).
- **On-box backups:** `/tmp/opt_colonel_backup_1784036729.tgz` (137M) + `/tmp/fe_build_backup_1784036729` (11M) + `/tmp/app.js_backup_1784036729` + `/tmp/backend_env_backup_1784036729`.

## Phase 1 — EXECUTED 2026-07-14
- AWS FROZEN: `colonel-backend` + `ngrok` stopped (reco-engine up); public URL 404.
- All 17 DBs dumped (stdout-redirect to avoid postgres-user perm issue) → `scratchpad-backups/aws-parity-20260714-191531/aws-dumps/`.
- Freshness verified: colonel-koparo latest reco_job = 2026-07-14 15:46 IST (post-snapshot run captured).

## Phase 2 — EXECUTED 2026-07-14
- Rebuilt unified from frozen AWS dumps (refresh-from-aws.sh): 16 brands loaded, reco_jobs=129 (latest 2026-07-14 17:21 IST), statutory_filings=2367, statutory_config=4, agents=32, legacy d0000000 ids=0 (3000 UUIDs), chauhandhaval932 → 7 brands.
- Swapped clone → live local `colonel_agent_accountant`; old kept as `colonel_agent_accountant_preparity` (rollback). Local backend restarted, admin login OK.
- Deploy dump refreshed + committed: `db-seed/dumps/colonel_agent_accountant.dump` (1.26 MB) = Phase-4 deploy artifact.

## Phase 3 — EXECUTED 2026-07-14 (read-only prep; NO 3000 code edits, per constraint)
- PDF→Bank: box == local IDENTICAL (pdf_bank_extractor.py + ilovepdf_ocr.py) — rsync safe, nothing lost.
- AWS Meetings = Google Calendar `GET /api/calendar/upcoming` (upcoming events + Meet links via googleCalendarService). Complementary to 3000's Fireflies. Decision: deploy 3000 Fireflies at cutover; fold in Google Calendar "upcoming" as a POST-cutover follow-up (needs service+frontend+app.js = 3000 code edits, deferred).
- All 3 feature keys present in local .env (COMPOSIO_API_KEY, GSK_API_KEY, FIREFLIES_API_KEY). box.env.template built = box .env + DB_NAME=colonel_agent_accountant + USE_UNIFIED_DB=true + the 3 keys. (Composio+GenSpark keys were exposed → rotate.)

## Phase 4 + 5 — EXECUTED 2026-07-14 (CUTOVER SUCCESSFUL)
- 4.1 rsync code (excludes preserved output/reco 70 files); all 7 missing routes + zepto_receivables.py landed.
- 4.2 restore.sh over TCP → colonel_agent_accountant created (brands=16, statutory=2367, reco_jobs=129), colonel_app+RLS; 17 per-brand DBs kept (18 DBs).
- 4.3 uploaded unified .env (USE_UNIFIED_DB=true, DB_NAME=colonel_agent_accountant, COMPOSIO/GSK/FIREFLIES keys). Box .env pre-cutover backed up to /tmp.
- 4.4 frontend rebuilt on box (npm install --legacy-peer-deps + build OK).
- 4.5 relaunch: backend+reco-engine+ngrok online; boot log = unified mode, zoho/compliance/statutory ready, port 8001, no boot errors.
- 5.1 LIVE smoke: site 200, admin login OK (dhaval.colonel/dhaval123), statutory admin summary = 5 brands, dashboard analytics live (lastRun 2026-07-14T10:16).
- PENDING: rotate Composio+GenSpark keys (user), broad feature verification, push branch to colonel-aws.

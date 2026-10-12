# TALLY-DEPLOY.md: deploy the Tally Connector to agent.accountant and take every brand live

> Audience: whoever deploys from the **Mac** (the machine with the AWS key).
> Companion to [TALLY.md](TALLY.md) (what the connector is and how it works). This file is the runbook.
> Written 2026-10-12 on the Windows laptop where the connector was built and tested.
> **Golden rules still apply** ([CLAUDE.md](CLAUDE.md), `../../AWS2.md`): back up first, deploy *named files only*,
> never a whole directory, and nothing touches the box without a human saying go.

## 1. Where things stand

| Piece | Status |
|---|---|
| Code | On branch `main` (merged from `tally-release`, which is stable `main` + all Tally work). 46 files, all additive. |
| Built on | Windows laptop (Tally is Windows-only, so the connector `.exe` must be built and tested there). |
| Tested locally | Backend boots on the merged tree (stable `main` migrations + Tally migrations). Frontend `craco build` compiles. Connector tests 10/10. Real Tally (Webtel server `160.187.250.98:9002`) synced end to end earlier: company "Drips Foods Private Limited - from April 25". |
| **Live agent.accountant** (checked 2026-10-12 over public HTTPS only) | `/api/health` = 200. **No Tally**: `/api/tally/*` falls through to the SPA HTML; the live bundle `main.d485d109.js` contains no Tally dashboard. So nothing Tally-related is deployed yet. |
| Brand to company mapping | Done in code: `new-backend/src/config/tallyBrandAliases.json` (15 brands). |
| Not verified | Anything on the real box (no SSH from the Windows laptop). Section 4 is the checklist to prove it works once deployed. |

## 2. What gets deployed

**Backend (named files, copied to `/opt/colonel/`):**

| File | Why |
|---|---|
| `new-backend/server.js` | Shared file. Adds `migrateTally()` on boot. **Diff against the box first**, it is shared with live code. |
| `new-backend/src/app.js` | Shared file. Mounts `tallyRoutes`. **Diff against the box first.** |
| `new-backend/src/db/tallyMigrate.js` | Creates the `tally_*` tables, triggers and indexes; runs on boot; idempotent. |
| `new-backend/src/controllers/tallyController.js` | Connector sync API and admin/brand endpoints. |
| `new-backend/src/controllers/tallyReportsController.js` | P&L, Balance Sheet, Trial Balance, receivables, GST, etc. computed from stored vouchers. |
| `new-backend/src/routes/tallyRoutes.js` | Routes (connector, admin, brand-scoped). |
| `new-backend/src/services/tallyBrandMatch.js` | Links a Tally company to a brand. |
| `new-backend/src/config/tallyBrandAliases.json` | Brand name to Tally company name mapping. **The `config/` folder may not exist on the box**; the script creates it. |
| `new-backend/seed-tally-connector.js` | One-time seed: adds the "Tally Connector" agent to brands (`--all`). |

**Frontend:** a fresh build from `main`, rsynced as a whole build (that is the one directory deploy that is correct,
see "Frontend" in CLAUDE.md). Build **only from `main`**: a build from an older branch plus `rsync --delete` would revert live features.

**Do NOT deploy:**
- `new-backend/src/data/complianceTemplate.js` and `statutoryTemplate.js`. They are gitignored and exist only on the box.
  The Windows laptop has empty local stubs so the backend boots; those stubs must never be copied up.
- `tally-connector/` (the Windows app). It is distributed to clients, not run on the server.
- `new-backend/.env`.

## 3. Deploy steps (Mac)

Everything below is automated by `deploy-tally-to-aws.sh` (repo root). It follows the golden rules.

```bash
git checkout main && git pull
./deploy-tally-to-aws.sh            # DRY RUN: md5-compares each named file with the box, prints
                                    # the box->local diff of server.js and app.js. Changes nothing.
```

**Read the diffs.** If `server.js` / `app.js` show anything *removed* that is not Tally, STOP: a production-only fix
would be reverted. Merge it into the repo first. Then:

```bash
./deploy-tally-to-aws.sh --apply
```

What `--apply` does, in order:
1. Backs up to `~/backups/` on the box: backend tarball, the current `frontend/build`, and a `pg_dump -Fc` of `colonel_agent_accountant` (all stamped `pre-tally-<timestamp>`).
2. Creates `new-backend/src/config/`, then copies only the named backend files that differ.
3. Builds the frontend **locally** (`CI=false npx craco build`), rsyncs `frontend/build/` to the box.
4. `pm2 restart colonel-backend && pm2 save` (plain restart, no `--update-env`), waits for `/api/health`.
5. Verifies over HTTPS and lists `\dt tally_*`.

Prerequisites: `~/.ssh/colonel2-key.pem`, your IP allowed in the security group (see `../../AWS2.md`), Node on the Mac for the build.

### Migrations (nothing to run by hand)
The migrations run **on backend boot** and are idempotent (`CREATE ... IF NOT EXISTS`):
- Tables: `tally_connectors`, `tally_companies`, `tally_ledgers`, `tally_vouchers`, `tally_sync_runs`, `tally_masters`, `tally_bills`. Master DB, **no RLS** (like the Zoho mirror).
- `brand_id` on every data table, kept correct by DB triggers (`tally_stamp_brand`, `tally_cascade_brand`) and indexed.
- At the end of the migration it runs the brand matcher once (links companies to brands by the mapping file).

After `pm2 restart`, confirm in the log: `pm2 logs colonel-backend --lines 50` shows `[TALLY MIGRATE] ... Tally mirror tables ready`
and `[SERVER] Colonel Backend running on port 8001`. A failure here fails safe: the old tables are untouched and the box can be rolled back (below).

### Seed the agent for every brand (once)
```bash
ssh -i ~/.ssh/colonel2-key.pem ubuntu@13.127.171.66 'cd /opt/colonel/new-backend && node seed-tally-connector.js --all'
```
This adds the "Tally Connector" agent (one row in `agents`, one `brand_agents` row per brand, skipping "Other"). Safe to re-run.
Brands with no company linked simply show an empty Tally view.

### Rollback
Restore `~/backups/pre-tally-*-<ts>*`: untar the backend, put the old `frontend/build` back, `pm2 restart colonel-backend`.
The `tally_*` tables are additive and can stay. A DB restore is only needed if something *else* broke
(`pre-tally-db-<ts>.dump`). AMI rollback table: `../../AWS2.md`.

## 4. Verify on agent.accountant after deploy

Public checks (no login):
```bash
curl -s https://agent.accountant/ | grep -o 'main\.[a-f0-9]*\.js'          # hash changed from main.d485d109.js
curl -s -o /dev/null -w '%{http_code}\n' https://agent.accountant/api/health                  # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://agent.accountant/api/tally/connector/login \
     -H 'Content-Type: application/json' -d '{}'                                              # 400/401, NOT 404/HTML
```
Logged in as admin:
1. Sidebar shows **Tally** and **Tally Dashboard**; `/admin/tally` loads (no connector yet, empty is correct).
2. Open any brand: brand sidebar has **Tally Dashboard**; the brand's agent list has **Tally Connector**.
3. Existing features still work (Invoice Process, reco upload, brand switcher). This proves the shared files were not reverted.

## 5. Making it work live for every brand

### 5.1 Brand to company mapping
Each brand has one or more **Tally companies**. The mapping lives in
`new-backend/src/config/tallyBrandAliases.json` and was supplied by the team:

| Brand | Tally company |
|---|---|
| Amama | AMAMA JEWELS PRIVATE LIMITED |
| Biglilpeople | Big Lil People Private Limited |
| D'Chicha | DCHICA FASHION LIFESTYLE PRIVATE LIMITED |
| Flipside | Flipside Systems & Consultancy Private Limited |
| Flo Mattress | Flo Sleep Solutions Private Limited |
| Koparo | Simk Labels Private Limited |
| M Brands | M Brands Private Limited \| Ministitch |
| Nailinit | Dot&Shadow-Brands Private Limited |
| Nestroots | ADC BRANDS PRIVATE LIMITED |
| Plenaire | SHALOHM INDIA PRIVATE LIMITED |
| Shumee Playroom | Shumee Playrooms Private Limited |
| Shumee Toys | Shumee Toys Private Limited |
| Stroom | Drips Foods Private Limited |
| Urban Plant | Grandeur IT Innovations Pvt Ltd. |
| Zaydn | ZAYDN SNEAKERS PVT LTD |

"Other" has no company (ephemeral catch-all brand).

How linking works (`tallyBrandMatch.js`): when a company first syncs, its name is normalised (case, punctuation, Pvt/Ltd/LLP,
FY tags like "(2024-25)", and Tally's "- from April 25" suffix are ignored) and looked up in the mapping file; if not listed,
it falls back to an **exact** brand-name match; never fuzzy. No match or several matches leaves the company unlinked.
Admins can fix it by hand: `/admin/tally` → company → link to a brand, or the **Match brands by name** button
(`POST /api/tally/auto-link`). Unlinking pins a company (`auto_link_off`) so it is not re-linked.

Gotchas:
- A company that **changes name** in Tally (new FY copy) will not match; add the new name to the JSON (several names per brand are fine) and redeploy that one file, or link by hand.
- A brand with several companies (per FY or entity) works at the data level; check the dashboard totals the first time you link a second one.
- Check the mapping against the **live** brand list: the list used here came from a local snapshot of the DB.

### 5.2 Getting each client's data flowing
For **each** Tally installation (one connector per Tally host):

1. **Tally side** (on the machine/server running Tally): F1 → Settings → Connectivity → Client/Server configuration → *acts as* **Both**, port **9002**. Restart Tally. **Open every company to be synced** (Tally only answers for open companies; Alt+F3 → Select Company).
2. **Reachability:** from the PC that will run the connector, `Test-NetConnection <tally-host> -Port 9002` must be `True`. Tally RemoteApp/shared servers (e.g. Webtel, host `160.187.250.98`) need the connector pointed at the server's *public* address, or run inside the session.
3. **Connector:** build on Windows (`cd tally-connector && npm install && npm run build:exe` → `dist/ColonelTallyConnector.zip`; keep `--no-bytecode`), give the zip to the client. The app's default server is already `https://agent.accountant`.
4. In the app: log in with an **admin** account of agent.accountant, enter Tally host + port, pick the company, **Sync now**. Then it runs every 15 min while the app is open.
5. In agent.accountant: `/admin/tally` shows the connector Online and the company; the matcher links it to its brand. Check the brand's **Tally Dashboard**.
6. **Verify the numbers** per client: compare ledger/voucher counts and the Trial Balance with Tally's own Statistics/Trial Balance before relying on it.

Roll out brand by brand: start with one pilot brand (suggest Stroom, Drips Foods, already synced end to end), confirm numbers, then repeat step 1-6 for the others.

### 5.3 Who can see what
- Connector login and the `/admin/tally` page: **admin only**.
- A brand's Tally Dashboard / Tally Connector agent: **admin and accountant**, scoped to companies linked to that brand (`/api/brands/:brandId/tally/*`; another brand's company returns 404).
- The `tally_*` tables have **no RLS**; isolation is enforced in the backend routes. Treat that as a known limitation (see 7).

## 6. Day-two operations
- **Connector offline / "Tally not reachable":** the status shows on `/admin/tally`; check Tally is open with the company loaded and port 9002 reachable.
- **Stuck sync:** `tally_sync_runs` (status, counts, error) and `tally_connectors.last_status/last_error`. A failed sync is simply redone next cycle (watermark advances only on success).
- **Revoke a connector:** `/admin/tally`, delete connector (token is invalidated).
- **Windows exit/launch issues:** `Diagnose.bat` in the zip writes `diagnose-output.txt`. Logs: `%APPDATA%\ColonelTallyConnector\logs\`.
- **Big companies:** first full sync of the test company took about 5 min (a 5,000-AlterID window can be ~100 MB). Expect longer for large clients.

## 7. Known risks and open items
1. **Tally port 9002 has no password.** The Webtel server answers from the open internet. Restrict to known IPs with the provider.
2. **No RLS on `tally_*`** (brand isolation is in the backend only). Add RLS if accountants outside admin will use it widely.
3. **Unsigned `.exe`:** SmartScreen/Defender will warn. A code-signing certificate is still needed for client rollout.
4. Closing stock is only known as of today; bill ageing runs to the last voucher date. Label or fix before CAs rely on those two figures.
5. The connector does not start with Windows yet (manual start after reboot), no tray icon, no auto-update.
6. Real-Tally validation covers one company. Re-validate counts and balances for every client's company.
7. Brand-name list used for the mapping came from a snapshot, not read from live production.

## 8. Quick checklist

- [ ] `git checkout main && git pull` on the Mac
- [ ] Dry run: no non-Tally removals in `server.js` / `app.js` diffs
- [ ] `--apply`; backups confirmed in `~/backups/`
- [ ] Log shows `[TALLY MIGRATE] ... ready` and server running
- [ ] Seed: `node seed-tally-connector.js --all`
- [ ] Section 4 checks pass (bundle hash changed, health 200, connector login not 404)
- [ ] Pilot brand: Tally open, connector synced, company linked, dashboard numbers match Tally
- [ ] Repeat per brand; restrict port 9002; plan code signing

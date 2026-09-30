# TALLY.md: Tally Connector (purpose, status, what's next)

> **Read this first** for anything about the Tally integration. It's the single status doc:
> why it exists, how it works, what's done and verified, what's blocked, and what's next.
> Branch: **`tally-connector`** (not merged to `main`, **not deployed to AWS**).
> Last updated: 2026-09-30.

## 1. Purpose

Connect a client's **Tally** to **agent.accountant**, so their books (ledgers, vouchers,
later more) show up in the web app automatically, without Excel exports.

We're rebuilding what a competitor, **Riko AI**, does:
- **Their old way:** `Tally Integration.tcp` + `TallyHelper.dll` + `Register - TallyHelper.bat`
  copied into Tally's folder. The copies studied are in `test files receivables/Tally/`.
  - The `.tcp` is compiled, encrypted TDL (`‰SDB` header), so it can't be read.
  - The `.dll` is a .NET COM object, **`RikoTallyHelper.Client`**, with methods
    `Login` / `SendToAPIInBatches` / `PostSyncStatus` / `PostDelete`. It uses RestSharp,
    LiteDB offline queue, Polly retries and Serilog logs under `Tekhne\`.
  - Flow: Tally exports JSON → calls the DLL via COM → the DLL POSTs batches to their API.
- **Their new way:** a desktop `.exe`. You log in, enter the Tally **host + port**
  (e.g. `10.10.21.206:9002`) and keep Tally open with the company loaded. It syncs every
  15 minutes, and the data shows in their web app.

**How the new way works, and what we built:** Tally has a built-in **XML/HTTP server**
(F1 → Settings → Connectivity → Client/Server configuration → *acts as Both*, port).
Any program can POST an XML `<ENVELOPE>` containing **inline TDL** (a collection
definition) and get data back. Nothing is installed into Tally. Tally only answers
for **open** companies.

## 2. Decisions already made (don't re-litigate)

| Decision | Choice |
|---|---|
| Architecture | **Option B:** a connector app near Tally *pulls* from Tally's port and *pushes* to agent.accountant over HTTPS. The cloud never dials into the client network. |
| Port | Fixed at **9002** (the connector's default; overridable). |
| Firewall / cloud | Nothing opened on AWS or the internet. Port 9002 is opened on the LAN only if the connector isn't on the Tally machine. Tally's port has **no password**, so never expose it publicly. |
| Who sees it | **Admin only** (sidebar "Tally"; connector login requires an admin account). |
| First data scope | "Basic": companies; ledgers (name, group, opening/closing, GSTIN); vouchers (date, type, no., party, amount, narration + ledger lines). |
| Storage | Master-DB tables, **no RLS**, like the Zoho Books mirror. `tally_companies.brand_id` is an optional future link to a brand. |
| Auth | The connector trades an admin email/password for a **long-lived connector token** (`tcn_…`). Only its sha256 is stored. The password is never saved on the PC. Revocable from the Tally page. |
| Reliability | The watermark lives **server-side** and only advances on a successful finish. A failed sync is simply redone next cycle, with idempotent upserts. No local offline queue. |

## 3. How it works

```
Tally (XML server :9002, company open)
   ▲  POST <ENVELOPE> + inline TDL collection      (tally-connector/src/tally.js)
   │
Colonel Tally Connector (.exe)  ──HTTPS──▶  new-backend /api/tally/connector/*  ──▶  Postgres tally_*
                                                                                         │
                                            frontend /admin/tally  ◀── /api/tally/* ─────┘
```

One sync of one company (`tally-connector/src/sync.js`):
1. `listCompanies`: Name, GUID, BooksFrom, **AltVchID / AltMstID**, then a heartbeat.
2. `POST sync/start` → the server returns `run_id`, the voucher watermark (last synced
   **AlterID**), `reconcile` (once per 24 h), or `unchanged: true` (AltVchID/AltMstID same
   as the last good run, so skip).
3. Ledgers: the **full list** every run, in chunks of 500 → `sync/ledgers`.
4. Vouchers: `$AlterID > watermark`, fetched in AlterID windows of 5,000 → `sync/vouchers`.
5. On reconcile days: all voucher GUIDs → sent with finish; the server deletes vouchers no
   longer in Tally. Skipped if Tally returns 0 GUIDs, so a hiccup never wipes data.
6. `POST sync/finish` → the watermark advances to AltVchID, and ledgers not seen this run are
   deleted (only if the ledger list was non-empty).
7. If Tally's AlterID goes **backwards** (company restored), the server resets the watermark and reconciles.

Tally conventions used: amounts **negative = Debit, positive = Credit** (stored as-is).
Voucher `amount` = |party line|, or else the sum of credit lines. Dates arrive as `YYYYMMDD`.
The response may be UTF-16. Control-char entities are stripped before parsing.

## 4. Files

| Area | Path | What |
|---|---|---|
| DB | `new-backend/src/db/tallyMigrate.js` | Creates `tally_connectors`, `tally_companies`, `tally_ledgers`, `tally_vouchers`, `tally_sync_runs`. Runs on boot from `server.js` (`migrateTally`). |
| API | `new-backend/src/controllers/tallyController.js`, `src/routes/tallyRoutes.js` (mounted in `src/app.js`) | Connector: `POST /api/tally/connector/{login,heartbeat,sync/start,sync/ledgers,sync/vouchers,sync/finish}`. Admin: `GET /api/tally/overview`, `GET /api/tally/companies/:id/{ledgers,vouchers,runs}`, `DELETE /api/tally/connectors/:id`. |
| UI | `frontend/src/pages/admin/TallyPage.jsx`; nav in `src/lib/adminNav.js`; route in `src/App.js` | Connector cards (Online / Tally not reachable / Offline), company tiles, Vouchers / Ledgers / Sync history tabs. |
| Connector | `tally-connector/src/` | `index.js` CLI + status box + crash guard · `tally.js` XML client/parsers · `sync.js` · `dryrun.js` · `cloud.js` · `config.js` · `logger.js` |
| Dev | `tally-connector/dev/mock-tally.js` | Fake Tally on :9002 (type `add` / `edit` / `del` in its terminal). |
| Windows | `tally-connector/windows/{Start-Connector,Diagnose}.bat`, `scripts/package-windows.js` | Launcher that keeps the window open; diagnostics → `diagnose-output.txt`; bundle build. |
| Docs | `tally-connector/README.md`, `tally-connector/WINDOWS-TEST-HANDOFF.md` | Usage; step-by-step test + report template for a Claude on the Windows/Tally PC. |

Connector commands: `setup | run | once | test | dry-run | status | logout`, flags
`--host --port --company --debug`. `test` and `dry-run` need **no login** and send nothing.
Settings and logs: `%APPDATA%\ColonelTallyConnector\` (`config.json`, `logs\connector-*.log`,
`logs\dry-run-*.json`, `logs\raw\*.xml` with `--debug`, `ColonelTallyConnector-crash.log`).

## 5. What's done and how it was verified

| Item | Status | Evidence |
|---|---|---|
| Backend tables, endpoints, auth | ✅ | Local backend: bad login → 401, bad token → 401, no JWT → 401, bad `:id` → 400. |
| Full sync / unchanged skip / add / edit / delete-via-reconcile / restored-company reset | ✅ **mock only** | Connector vs `mock-tally.js` vs local backend and DB. |
| Tally unreachable / agent.accountant unreachable / not logged in | ✅ | Status box + heartbeat show the right state; exit code 1. |
| Admin Tally page | ✅ | Headless-browser screenshots of all tabs, no console errors. |
| Parser unit tests (dates, amounts incl. forex, UTF-16, invoice-mode lines) | ✅ | `cd tally-connector && npm test`, 6/6 pass. |
| Windows `.exe` starts | ✅ | 1st build crashed ("V8 rejected the bytecode cache": cross-built on a Mac). Fixed with `--no-bytecode --public`. The 2nd build runs on Windows. |
| **Against a real Tally** | ❌ **not yet** | Blocked, see section 6. |
| Deployed to agent.accountant (AWS) | ❌ | Needs explicit human permission (CLAUDE.md golden rule 1). |

Local dev leftovers (the Mac dev DB only): company "Demo Traders Pvt Ltd" and a connector
named `local-test` in the `tally_*` tables.

## 6. Current blocker (as of 2026-09-30)

On the user's test PC, **Tally is a web RemoteApp**: there's no `tally.exe` locally, and the
window is Remote Desktop showing Tally running on a **server**. So `localhost:9002` is
refused, and `Diagnose.bat` reports "Tally is NOT running".

Riko worked with host **`10.10.21.206`, port `9002`**, the server's private IP as shown in
Tally → F1 → About → Network Adapters.

**Next action:**
1. In the RemoteApp Tally, set *acts as Both*, Port 9002, then **restart Tally** and open the company.
2. From the PC: `Test-NetConnection <server-ip> -Port 9002`.
3. If `True`: `ColonelTallyConnector.exe test --host <ip> --port 9002`, then `dry-run --host <ip> --port 9002 --debug`.
4. If `False`, find out which it is: Tally not restarted, **server firewall** blocking 9002, the PC
   not on the server network (VPN?), or a **shared server** where another user's Tally holds the
   port. Ask the user whether Riko's app ran on this same PC when it worked. If the provider
   allows no network access, the connector must run **inside** the RemoteApp session on the server.

Instructions for the Windows-side Claude: `tally-connector/WINDOWS-TEST-HANDOFF.md`, sections 1b and 3.

## 7. What still needs to be done (in order)

1. **Reach the server Tally.** See section 6. For the RemoteApp case, `setup` should also save the
   server IP as the host (it already accepts any host).
2. **Validate against real Tally** with `dry-run`. Watch for:
   - field names in this Tally version (`AltVchID`, `LedGSTRegDetails`, `AllLedgerEntries` vs
     `LedgerEntries` for invoice-mode vouchers);
   - the incremental `$AlterID > N` filter actually being honoured (`dry-run` checks it);
   - counts matching Tally's *Statistics*;
   - balances matching the Trial Balance;
   - timing on the biggest company.

   Fix the parsers in `tally-connector/src/tally.js` and add unit tests with the real XML shapes.
3. **Deploy the backend to agent.accountant**, with permission only. Follow `../../AWS2.md` and
   golden rules 1/1b/2: back up, checksum-compare, and deploy *named files only*:
   - `new-backend/server.js`
   - `new-backend/src/app.js`
   - `new-backend/src/db/tallyMigrate.js`
   - `new-backend/src/controllers/tallyController.js`
   - `new-backend/src/routes/tallyRoutes.js`
   - a frontend build containing `TallyPage.jsx` / `adminNav.js` / `App.js`

   Then `pm2 restart` the backend (the tables self-create on boot). Then Phase 2 of the handoff
   doc: `setup` → `once` → check `/admin/tally`.
4. **Make it client-ready:**
   - run as a Windows service or at startup (currently a console window that must stay open);
   - a tray icon or small GUI like Riko's;
   - a **code-signing certificate** (unsigned exes trigger SmartScreen/Defender);
   - auto-update.
5. **Link Tally companies to brands** (`tally_companies.brand_id`), then decide whether
   accountants can see their brand's Tally data (would need RLS or brand scoping).
6. **More data:**
   - stock items + inventory lines;
   - GST details per voucher (HSN, tax split);
   - bills outstanding (receivables/payables);
   - cost centres;
   - the group hierarchy.

   Feed these into the reco/MIS agents.
7. **Write-back:** push GSTR-3B / purchase entries generated by our agents into Tally
   (`TALLYREQUEST=Import`) instead of Excel imports.
8. **Scale:**
   - first sync of very large companies (many sparse 5,000-AlterID windows mean many Tally
     scans; consider larger windows or date-based paging);
   - shared servers with several Tally instances, each needing its own port.

## 8. Develop and debug locally (macOS/Linux)

```bash
# backend (tables self-create on boot)
cd new-backend && node server.js                     # :8001
# fake Tally
cd tally-connector && npm install && npm run mock-tally    # :9002
# connector against local backend (use a scratch home so real config isn't touched)
export COLONEL_CONNECTOR_HOME=/tmp/conn
node src/index.js setup    # URL http://localhost:8001, admin login, host localhost, port 9002
node src/index.js once --debug
node src/index.js dry-run
npm test
npm run build:exe          # → dist/ColonelTallyConnector.zip (exe + .bat + handoff doc); dist/ is gitignored
```
Admin page: `http://localhost:3000/admin/tally`.

**Debugging order:**
1. The connector's status box / exit code.
2. `logs\connector-*.log`.
3. `--debug` → `logs\raw\*-request.xml` / `*-response.xml` (the exact Tally exchange).
4. `tally_sync_runs` (status, counts, error per run) and the `tally_connectors.last_status` / `last_error` columns.
5. On Windows: `Diagnose.bat` → `diagnose-output.txt` (Tally process and listening ports,
   RemoteApp detection, Defender, port test, crash log).

## 9. Rules for whoever picks this up
- Don't deploy or touch AWS without the user's explicit permission in that session.
- Never commit `tally-connector/dist/` (60 MB exe) or anything in `AWS Setup/`.
- Connector changes: keep `npm test` green and re-test against `mock-tally.js`. When changing
  anything Windows-specific, rebuild with `npm run build:exe` (keep `--no-bytecode`).
- `.bat` files must keep **CRLF** line endings.
- Never let a sync delete server data on an empty or partial Tally response. Both deletion
  paths are guarded; keep them that way.

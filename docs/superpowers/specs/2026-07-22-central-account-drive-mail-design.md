# Central Google Account + Drive-intake + Email-output — Design

**Date:** 2026-07-22
**App:** colonel-automation (local port 3000 / backend 8001) — LOCAL ONLY, no AWS, no GitHub push.
**Status:** Approved plan (A→B→C→D). This doc details the whole feature; **Slice A** is fully specced, B/C/D summarized.

---

## 1. Vision

`team@colonel.co.in` is the firm's **central Google account**. Every brand has a folder in team@'s
Drive, keyed by `brand_id` (the user provides each brand's folder path/link, like the Stroom setup).

Accountants no longer have to upload files from their laptop (though **manual upload stays** everywhere).
They can instead **paste a Drive link** (or use the pre-mapped brand folder), the agent **reads the files
from Drive**, processes them, and **emails the output** to recipients chosen at run time.

This works across **all agents** (reco, sales, MTR, invoice, bank, …) and later inside **Colonel AI chat**.
The dashboard shows the logged-in user's login email up by the logo. Users can also connect their
**personal** Google account and **switch** between team@ and personal from the profile logo.

## 2. Auth decision — Composio (with a hybrid read path)

- **Login/identity + mail send = Composio OAuth.** `team@colonel.co.in` is connected once as the
  **central** account; each user may additionally connect their **personal** Google account. Login
  buttons appear wherever a Drive action needs one, using the **Google logo pulled from Composio's
  toolkit metadata** (no hardcoded icons).
- **Bulk Drive reads = existing service account** (`colonel-drive@zeta-cortex-499810-k8.iam.gserviceaccount.com`,
  `driveService.js`). Reason: heavy agents (MTR ≈ 140 files / ~95 MB) would strain Composio's per-tool
  download layer. The SA reads team@'s brand folders once they're **shared with the SA email** (the
  existing Workspace link-sharing workaround — share the top folder once, it cascades).
- **DWD (domain-wide delegation) was considered and dropped** at the user's direction in favor of Composio.

So: **Composio = who you are + how mail goes out. Service account = how big files come in.**

## 3. Scope model (Composio userId buckets)

- `central` → the shared `team@colonel.co.in` account (connected once, by an admin). Available to everyone.
- `user_<userId>` → an individual user's personal Google account(s).
- A user's account switcher shows **central (team@)** + **their own personal** connections.
- **Active account** (which one sends mail / is "current") is remembered per user in `localStorage`
  (`colonel.activeGoogleAccount`), defaulting to `central`. Sent with mail/Drive requests in B/C.

> Note: the existing marketplace stays **per-brand** (`brand_<brandId>`) for other apps. Only this
> Google login flow is per-user/central. `resolveUserId` is extended, not replaced.

## 4. Slice A — Composio login foundation (DETAILED)

### 4.1 Backend

New/edited files (all additive; back up before editing shared ones):

- **`new-backend/src/services/composioClient.js`** (edit, additive):
  - `getConnectionEmail(connectedAccountId)` / include the associated Google email when listing, so the
    switcher can label accounts ("team@colonel.co.in", "someone@gmail.com"). Read from the connected
    account's `data`/`params` (Composio returns the authenticated email in account metadata).
  - `listConnections(userId)` already exists → reuse.
- **`new-backend/src/controllers/googleAccountsController.js`** (new):
  - `resolveGoogleUserId(kind, req)` → `central` when `kind==='central'`, else `user_<req.user.id>`.
  - `GET  /api/google/accounts` → `{ central: {...}|null, personal: [{id,email,slug,status}] }`
    (lists central + this user's personal Google connections, each with email + status).
  - `POST /api/google/connect` body `{ kind: 'central'|'personal', slug: 'gmail'|'googledrive' }`
    → returns `{ redirectUrl }` (OAuth), callback returns to the current page with `?google_connected=1`.
    `central` connect is **admin-only**; `personal` allowed for admin+accountant.
  - `POST /api/google/accounts/:id/disconnect` → remove a connection (idempotent, mirrors composio disconnect).
  - `GET  /api/google/status` → `{ configured, central: {connected,email}, driveOk, mailOk }` for the chip.
- **`new-backend/src/routes/googleAccountsRoutes.js`** (new) → mounts the above under `/api`.
- **`new-backend/src/app.js`** (edit, additive): `require` + `app.use('/api', googleAccountsRoutes)`
  (keep the full mount list intact — one added line).
- **`brand_drive_config`** persistence:
  - New Sequelize model `new-backend/src/models/BrandDriveConfig.js` — columns:
    `brand_id` (PK/FK), `root_folder_url`, `root_folder_id`, `label`, `updated_by`, `updated_at`.
    Follows unified-DB + RLS conventions (has `brand_id`; RLS policy like the other per-brand tables).
  - `GET/PUT /api/brands/:brandId/drive-config` (admin) — read/set a brand's central Drive folder.
    PUT validates by scanning the folder with `driveService` (must be reachable by the SA).
  - Migration file under `db-restructure/` (or the project's migration dir) creating the table + RLS
    policy; **additive**, does not alter existing tables.

### 4.2 Frontend

- **`frontend/src/components/layout/DashboardLayout.jsx`** (edit, back up first):
  - Show the logged-in user's **login email beside the "Colonel" logo** (mirror of the profile-area email).
  - Profile menu: add a **Google account block** — the active account (team@/personal) with the Google
    logo, a **switcher** to change active account, a **"Sign in with your work mail"** connect button
    (opens the Composio OAuth flow via `POST /api/google/connect`), and a disconnect for personal.
- **`frontend/src/components/GoogleAccountMenu.jsx`** (new): encapsulates the account list + switcher +
  connect/disconnect, driven by `/api/google/*`. Google logo comes from the Composio `gmail`/`googledrive`
  toolkit `meta.logo` (fetched via existing `/api/composio/toolkits`, cached).
- **`frontend/src/lib/googleAccount.js`** (new): tiny client helper — read/write
  `localStorage['colonel.activeGoogleAccount']`, fetch accounts, expose `useGoogleAccounts()` hook.
- **Admin brand Drive folder field**: on the existing Brands admin page, a per-brand "Central Drive
  folder" input (paste link → validate → save to `brand_drive_config`). (Small additive section.)
- **Health chip**: small "Central account connected ✅ / setup needed ⚠️" indicator on the admin
  Integrations page, from `/api/google/status`.

### 4.3 Error handling

- Composio not configured / not connected → endpoints return clear messages; UI shows "Connect team@…".
- Central not connected → chip shows ⚠️ with a one-click connect (admin).
- Drive folder unreachable by the SA on PUT → 422 "Share this folder with `<SA email>` first."
- Everything degrades softly; existing upload/marketplace flows are untouched.

### 4.4 Testing

- Unit: `resolveGoogleUserId`, `BrandDriveConfig` CRUD, folder-link parsing.
- Live smoke (needs user): admin connects team@ via Composio; connect a personal account; switch active;
  set one brand's Drive folder; `/api/google/status` returns `driveOk/mailOk`. Mail send itself = Slice B.

### 4.5 What is needed from the user to fully test A

1. Connect `team@colonel.co.in` via the in-app Composio OAuth (browser sign-in + Allow).
2. Provide each brand's Drive folder link (in team@'s Drive) and share the top folder with the SA email.

## 5. Slices B, C, D (summary)

- **B — Email-the-output step.** Reusable `mailService` (Composio Gmail send as the active/central
  account) + a "Send to…" UI (run-time recipients) that attaches the agent's output file. Drop into
  agents one at a time.
- **C — Drive option on all agents.** Manual upload **stays**; add a Drive option (paste link + the
  brand's pre-mapped folder) beside it, on **every** file-upload agent. **Extend** agents that already
  have Drive (Zepto Receivables, Amazon MTR, reco suite `GoogleDriveFolderInput`) — do not duplicate.
  Agent **auto-detects which files to process** (file-type routing, like MTR).
- **D — Colonel AI chat.** Paste a Drive link in chat → route to the right agent → email the result.
  Largest / most experimental; built last.

## 6. Guardrails (this whole effort)

- **LOCAL 3000 only.** No AWS/EC2 op. No `git push` to GitHub.
- **Back up** every existing file before editing: `cp -a <f> <f>.bak-$(date +%Y%m%d-%H%M%S)`.
- Prefer **new files + minimal additive edits**. Never change agent logic to add persistence/UI.
- **Commit each step to local `main`**, staging only this feature's files (leave pre-existing WIP alone).
- Keep `app.js` route mounts complete; restart the right process after backend changes.

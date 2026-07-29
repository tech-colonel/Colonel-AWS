# Google Login Phase — Design

**Date:** 2026-07-29
**App:** colonel-automation (local port 3000 / backend 8001) — **LOCAL ONLY, no AWS, no GitHub push.**
**Status:** Approved (2026-07-29). Extends the central-account feature
(`2026-07-22-central-account-drive-mail-design.md`, Slice A shipped). This is the **Login phase** that
precedes Slices B (mail-out), C (drive-on-every-tool), and D (AI everywhere).

---

## 1. Vision & scope

Add **"Sign in with Google" on the login page** so a user can authenticate into Colonel with their
personal/work Google account, and make **team@colonel.co.in the shared default identity for every user**.

**This phase is authentication only.** Mail-out (B), drive-input on agents (C), and AI-everywhere (D)
remain separate build cycles after this one. YAGNI: nothing here touches agents, mail sending, or the
reco pipeline.

## 2. Non-negotiable security requirement

**No new user may enter the app unless an admin has already registered them.** There is **no
self-provisioning** from Google login. On the login `finish` step the server looks up an **existing**
Colonel user by the Google-verified email; if none exists it returns `403` and issues no token. The
client cannot create a user, cannot set a role, and cannot influence the match. This mirrors the
`/register` admin-lock already applied on AWS (AWS2.md — the fixed privilege-escalation bug).

## 3. Decisions (locked 2026-07-29)

- **Who can log in:** existing users only (match by email, reject unknown).
- **Mechanism:** Composio `googlesuper` OAuth (reuse the connection the user already set up; one consent
  covers login + Drive + Gmail scopes).
- **Password login:** keep it — the Google button is additive; email/password still works (demo
  accounts, admin fallback, anyone without Google).
- **team@ model:** one shared central connection (Composio bucket `central`), available to all users as a
  send-from / Drive source. **No per-user copy of team@'s tokens.**

## 4. Login flow (Composio googlesuper, existing-users-only)

The user is not authenticated yet, so there is no `user_<id>` Composio bucket to key on. A single-use
temporary bucket bridges the OAuth handshake:

1. `/login` shows a **"Sign in with Google"** button (real Google logo pulled from Composio toolkit
   metadata, same source as Slice A's `getToolkitLogo`).
2. Click → `POST /api/auth/google/start` (**public**). Backend mints a single-use `nonce`, calls
   `composio.connect('login_<nonce>', <LOGIN_SLUG>, callbackUrl)`, stores the nonce server-side with a
   short TTL (~10 min), and returns `{ redirectUrl }`. `callbackUrl = <FRONT_URL base>/login?google_login=<nonce>`.
   `LOGIN_SLUG` = `process.env.GOOGLE_LOGIN_SLUG || 'gmail'` (AWS uses `googlesuper`; detection also
   accepts `gmail`, mirroring `googleAccountsController`).
3. Google consent → Composio redirects the browser to `/login?google_login=<nonce>`.
4. `/login` sees the param → `POST /api/auth/google/finish { nonce }` (**public**).
5. Backend:
   - Validates the nonce (exists, not expired, not already used) → else `400`.
   - Confirms the `login_<nonce>` bucket has an **ACTIVE** connection → else `409 "Google sign-in didn't
     complete — try again."`
   - Resolves the **verified email** from that connection (see §5).
   - Looks up a Colonel user by that email, **case-insensitive, exact** (`WHERE lower(email)=lower($1)`).
     - **Found** → issue the normal Colonel JWT (identical `{ userId, role }` payload, same secret and
       24h expiry as password login) → `{ token, user }`.
     - **Not found** → `403 { error: "This Google account isn't registered. Ask an admin to add you." }`,
       no token.
   - **Deletes the temp `login_<nonce>` connection** and clears its cached email (authentication only;
     personal Drive/Gmail stays the Slice-A profile connect under `user_<id>`). Nonce marked used.
6. Frontend stores the returned JWT exactly as password login does and routes into the app.

## 5. Verified-email resolution (the one unknown — spike first)

`composioClient.getGoogleEmail(userId)` currently calls `GMAIL_GET_PROFILE`. Before building the flow,
**spike** whether that resolves against a `googlesuper` connection:

- **Primary:** `GMAIL_GET_PROFILE` → `emailAddress`.
- **Fallback if it fails:** try a Google userinfo/OpenID tool available under the connection, or read the
  authenticated email from the connected-account metadata / id_token returned by Composio.

The chosen resolver becomes the single source of the login email. **The email must come from the
provider (inherently verified), never from client input.** If resolution returns null, `finish` fails
closed with `409` (no guessing, no fallback to any client-supplied value).

## 6. team@ as shared default

team@ stays one shared connection (bucket `central`, already connected). "Default for all users" means:
every logged-in user sees team@ as an available send-from identity and Drive source; the active-account
default is `central` (already the Slice-A default in `frontend/src/lib/googleAccount.js`); the profile
menu shows it as "WORK ✓". Nobody re-connects team@, and it is revocable centrally. No schema change.

## 7. Files touched (mostly additive; back up shared files before editing)

- **Backend (new):** `new-backend/src/controllers/googleLoginController.js` (or additions to
  `authController`) → `start`, `finish`; a small nonce store (in-memory Map with TTL).
- **Backend (edit):** `new-backend/src/routes/authRoutes.js` — add the two **public** routes
  (NOT behind `authenticateToken`). Back up first.
- **Backend (edit, only if the spike needs it):** `composioClient.js` — extend `getGoogleEmail` with the
  googlesuper fallback resolver. Additive.
- **Frontend (edit, back up first):** the Login page (`frontend/src/pages/.../Login*.jsx` — locate in the
  plan) — add the Google button + the `?google_login=` finish handler; persist the JWT the same way
  password login does; hide/disable the button cleanly when Composio is unconfigured.
- **No DB migration** — matches against the existing `users` table; no new tables.

## 8. Error handling

- Composio not configured → `start` returns a clear message; the login page hides the button (or shows
  "Google sign-in unavailable, use password"). Password login always works.
- Nonce missing/expired/reused → `400`. Connection not ACTIVE → `409`. Email unresolved → `409` (fail
  closed). Email not a registered user → `403` (the security gate).
- Every failure path leaves password login fully functional.
- Temp `login_<nonce>` connections are always cleaned up (on success and on failure) so no stubs
  accumulate.

## 9. Testing

- **Unit:** nonce lifecycle (issue / expire / single-use rejects replay); email→user match
  (found / not-found / different case); JWT payload parity with password login (same claims).
- **Live smoke (needs the user):** sign in with a **registered** Google email → lands in dashboard;
  sign in with an **unregistered** Google email → clean `403`, no account created; password login still
  works; refresh mid-flow doesn't create duplicate users or connections.

## 10. Guardrails (this whole effort)

- **LOCAL 3000 only.** No AWS/EC2 op. No `git push` to GitHub.
- **Back up** every existing file before editing: `cp -a <f> <f>.bak-$(date +%Y%m%d-%H%M%S)`.
- Prefer **new files + minimal additive edits**. Do not change agent logic.
- **Commit each step to local `main`**, staging only this feature's files.
- Keep `app.js` / `authRoutes.js` mounts complete; restart the backend after changes
  (`pm2 restart` / `node server.js`), rebuild/reload the frontend.

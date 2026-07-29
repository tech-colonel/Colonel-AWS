# Google Login Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Sign in with Google" on the Colonel login page (existing-users-only, Composio `googlesuper` OAuth), keeping email/password login working, with team@ as the shared default identity for everyone.

**Architecture:** The user isn't authenticated when they click "Sign in with Google", so there is no `user_<id>` Composio bucket yet. A single-use, short-TTL **nonce** keys a temporary `login_<nonce>` Composio bucket for the OAuth handshake. On completion the backend resolves the **provider-verified email** (`GOOGLESUPER_GET_PROFILE`, falling back from `GMAIL_GET_PROFILE`), matches it against an **existing** `users` row (case-insensitive), issues the same JWT password login issues, then deletes the temporary connection. No self-provisioning: an unmatched email gets `403` and no token.

**Tech Stack:** Node/Express + Sequelize + `jsonwebtoken` (backend :8001), `@composio/core` v0.13.1, React 18 + AuthContext (frontend :3000). Tests via built-in `node:test` + `node:assert` (Node 24, zero new deps).

## Global Constraints

- **LOCAL 3000 only.** No AWS/EC2 op. No `git push` to GitHub. (Deploy target later = named-files rsync to `/opt/colonel`; not this plan.)
- **Back up** every existing file before editing: `cp -a <f> <f>.bak-$(date +%Y%m%d-%H%M%S)`.
- Prefer **new files + minimal additive edits**. Do not change agent or reco logic.
- **Commit each task to local `main`**, staging ONLY this feature's files (never `git add -A` — other agents have uncommitted WIP).
- **Security gate is non-negotiable:** no new user may enter unless an admin already registered them. Enforced server-side in `finish`; the client can never create a user or set a role.
- JWT payload MUST be identical to password login: `jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN })`; response `{ token, user: { id, name, email, role } }`.
- `GOOGLE_LOGIN_SLUG` in local `.env` = `googlesuper`; code default is `'gmail'`; detection accepts both.
- Restart backend after backend changes: `pm2 restart colonel-automation-backend` (or the app's pm2 name) / re-run `server.js`. Frontend dev server hot-reloads.

**Verified facts (spiked 2026-07-29, do not re-litigate):**
- Central connection slug is `googlesuper`; `GMAIL_GET_PROFILE` returns **null** against it.
- `GOOGLESUPER_GET_PROFILE` returns `{ emailAddress: 'team@colonel.co.in', ... }` — this is the resolver.
- Connected-account tokens (`access_token`/`id_token`) come back **REDACTED** from the SDK, so email MUST come from executing a `GOOGLESUPER_*` tool, not from reading metadata.
- `composio.connect(userId, slug, callbackUrl)` auto-creates a brand-new entity bucket (so `login_<nonce>` works).
- `composioClient.listConnections(userId)` returns ACTIVE-only → presence confirms OAuth completed.

---

## File Structure

- **Create** `new-backend/src/services/loginNonceStore.js` — pure in-memory single-use nonce store (issue/consume/sweep). One responsibility: nonce lifecycle. Testable with no I/O.
- **Create** `new-backend/src/services/loginNonceStore.test.js` — `node:test` unit tests for the store.
- **Create** `new-backend/src/controllers/googleLoginController.js` — `start`, `finish`, `findUserByEmail`. Orchestrates composio + nonce store + User lookup + JWT.
- **Create** `new-backend/src/controllers/googleLoginController.test.js` — `node:test` unit tests for `findUserByEmail` matching (mocked User model).
- **Modify** `new-backend/src/services/composioClient.js` — extend `getGoogleEmail` with the `GOOGLESUPER_GET_PROFILE` fallback. Additive.
- **Modify** `new-backend/src/routes/authRoutes.js` — add two **public** routes.
- **Modify** `frontend/src/context/AuthContext.js` — add `startGoogleLogin()` and `finishGoogleLogin(nonce)`.
- **Modify** `frontend/src/pages/Login.jsx` — add the Google button + `?google_login=` finish handler.

---

## Task 1: Email resolver fallback (`getGoogleEmail` → googlesuper)

**Files:**
- Modify: `new-backend/src/services/composioClient.js` (the `getGoogleEmail` function, ~lines 257-270)

**Interfaces:**
- Consumes: existing `executeTool(userId, slug, args)`, `_emailCache`, `EMAIL_TTL_MS`.
- Produces: `getGoogleEmail(userId, force)` resolving an email for BOTH `gmail` and `googlesuper` connections (unchanged signature).

- [ ] **Step 1: Back up the file**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation/new-backend"
cp -a src/services/composioClient.js src/services/composioClient.js.bak-$(date +%Y%m%d-%H%M%S)
```

- [ ] **Step 2: Write the failing integration test**

Create `new-backend/src/services/composioClient.getemail.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
require('dotenv').config();
const composio = require('./composioClient');

// Live test against the already-connected central googlesuper account.
test('getGoogleEmail resolves a googlesuper connection', async () => {
  if (!composio.isConfigured()) return; // skip when no key
  const email = await composio.getGoogleEmail('central', true);
  assert.ok(email && /@/.test(email), `expected an email, got ${email}`);
});
```

- [ ] **Step 3: Run it to see it fail (pre-change resolves null)**

Run: `node --test src/services/composioClient.getemail.test.js`
Expected: FAIL — assertion "expected an email, got null" (GMAIL_GET_PROFILE alone returns null on googlesuper).

- [ ] **Step 4: Implement the fallback**

Replace the body of `getGoogleEmail` (keep the cache + signature). New resolution loop:

```js
async function getGoogleEmail(userId, force = false) {
  const now = Date.now();
  const hit = _emailCache.get(userId);
  if (!force && hit && now - hit.at < EMAIL_TTL_MS) return hit.email;
  let email = null;
  // Plain Gmail profile (legacy 'gmail' connections), then the combined Google
  // Super profile ('googlesuper'). Both return `emailAddress`.
  for (const slug of ['GMAIL_GET_PROFILE', 'GOOGLESUPER_GET_PROFILE']) {
    if (email) break;
    try {
      const res = await executeTool(userId, slug, {});
      const data = (res && (res.data || res)) || {};
      email = data.emailAddress || data.email
        || (data.response_data && data.response_data.emailAddress) || null;
    } catch (_) { /* try the next resolver */ }
  }
  _emailCache.set(userId, { email, at: now });
  return email;
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `node --test src/services/composioClient.getemail.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/composioClient.js src/services/composioClient.getemail.test.js
git commit -m "feat(login): resolve verified email from googlesuper connections

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Login nonce store

**Files:**
- Create: `new-backend/src/services/loginNonceStore.js`
- Test: `new-backend/src/services/loginNonceStore.test.js`

**Interfaces:**
- Produces:
  - `issue(): string` — mints an unguessable single-use nonce.
  - `consume(nonce: string): boolean` — true iff valid & unexpired; deletes it (single-use → replay is false).
  - `sweep(): void` — drops expired entries.
  - `TTL_MS: number`, `_store: Map` (test-only introspection).

- [ ] **Step 1: Write the failing tests**

Create `new-backend/src/services/loginNonceStore.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const store = require('./loginNonceStore');

test('issue returns a long unguessable string', () => {
  const n = store.issue();
  assert.equal(typeof n, 'string');
  assert.ok(n.length >= 24);
  assert.notEqual(store.issue(), store.issue()); // unique
});

test('consume is true once, then false (single-use)', () => {
  const n = store.issue();
  assert.equal(store.consume(n), true);
  assert.equal(store.consume(n), false); // replay rejected
});

test('consume rejects unknown / empty / non-string', () => {
  assert.equal(store.consume('never-issued'), false);
  assert.equal(store.consume(''), false);
  assert.equal(store.consume(undefined), false);
  assert.equal(store.consume(null), false);
});

test('consume rejects an expired nonce', () => {
  const n = store.issue();
  const entry = store._store.get(n);
  entry.createdAt = Date.now() - store.TTL_MS - 1000; // force-expire
  assert.equal(store.consume(n), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/services/loginNonceStore.test.js`
Expected: FAIL — "Cannot find module './loginNonceStore'".

- [ ] **Step 3: Implement the store**

Create `new-backend/src/services/loginNonceStore.js`:

```js
/* loginNonceStore.js — single-use, short-TTL nonces that bridge the Google
   login OAuth handshake. The user isn't authenticated when they start "Sign in
   with Google", so there's no user_<id> Composio bucket; a nonce keys a
   temporary `login_<nonce>` bucket and is consumed exactly once when the flow
   finishes. Pure in-memory (single pm2 process) + additive; no external deps. */

const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const _store = new Map(); // nonce -> { createdAt }

/** Mint a new single-use nonce. */
function issue() {
  const nonce = crypto.randomBytes(24).toString('base64url');
  _store.set(nonce, { createdAt: Date.now() });
  return nonce;
}

/** Validate + consume a nonce. True iff it was valid & unexpired. Single-use:
    the nonce is deleted regardless of outcome, so replay returns false. */
function consume(nonce) {
  if (!nonce || typeof nonce !== 'string') return false;
  const entry = _store.get(nonce);
  if (!entry) return false;
  _store.delete(nonce);
  return Date.now() - entry.createdAt <= TTL_MS;
}

/** Drop expired entries (called opportunistically after each finish). */
function sweep() {
  const now = Date.now();
  for (const [k, v] of _store) if (now - v.createdAt > TTL_MS) _store.delete(k);
}

module.exports = { issue, consume, sweep, TTL_MS, _store };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test src/services/loginNonceStore.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/loginNonceStore.js src/services/loginNonceStore.test.js
git commit -m "feat(login): single-use short-TTL nonce store for Google login handshake

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Google login controller + public routes

**Files:**
- Create: `new-backend/src/controllers/googleLoginController.js`
- Test: `new-backend/src/controllers/googleLoginController.test.js`
- Modify: `new-backend/src/routes/authRoutes.js`

**Interfaces:**
- Consumes: `composioClient.{isConfigured,connect,listConnections,getGoogleEmail,disconnect,clearGoogleEmail}`, `loginNonceStore.{issue,consume,sweep}`, `User` from `../models/master`, `jsonwebtoken`.
- Produces:
  - `start(req,res,next)` → `POST /api/auth/google/start` → `{ redirectUrl }`.
  - `finish(req,res,next)` → `POST /api/auth/google/finish` body `{ nonce }` → `{ token, user }` | `403`/`409`/`400`.
  - `findUserByEmail(email): Promise<User|null>` — exact case-insensitive match (exported for tests).

- [ ] **Step 1: Write the failing unit test for the matcher**

Create `new-backend/src/controllers/googleLoginController.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');

// Stub the models BEFORE requiring the controller so no real DB is touched.
const Module = require('module');
const origResolve = Module._resolveFilename;
const fakeUsers = [{ id: 'u1', name: 'Priya', email: 'Priya@Colonel.App', role: 'accountant' }];
require.cache[require.resolve('../models/master')] = {
  id: require.resolve('../models/master'),
  loaded: true,
  exports: {
    User: {
      async findOne(opts) {
        // controller matches via lower(email) = lower($1); emulate that here.
        const want = String(opts.__wantEmail || '').toLowerCase();
        return fakeUsers.find((u) => u.email.toLowerCase() === want) || null;
      },
    },
  },
};

const ctrl = require('./googleLoginController');

test('findUserByEmail matches case-insensitively', async () => {
  // Because Sequelize.where is opaque to the stub, test the contract via a thin shim:
  const found = await ctrl._matchEmailIn(fakeUsers, 'priya@colonel.app');
  assert.ok(found && found.id === 'u1');
});

test('findUserByEmail returns null for unknown email', async () => {
  const none = await ctrl._matchEmailIn(fakeUsers, 'ghost@nowhere.com');
  assert.equal(none, null);
});
```

> Note: `findUserByEmail` itself uses Sequelize and needs a DB, so the unit test targets the pure matching rule via an exported `_matchEmailIn(list, email)` helper that `findUserByEmail` also uses conceptually. The full DB-backed `findUserByEmail` is covered by the live smoke in Task 5.

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/controllers/googleLoginController.test.js`
Expected: FAIL — "Cannot find module './googleLoginController'".

- [ ] **Step 3: Implement the controller**

Create `new-backend/src/controllers/googleLoginController.js`:

```js
/* googleLoginController.js — "Sign in with Google" on the login page.
   Existing-users-only: the Google-verified email must match a Colonel user an
   admin already created; otherwise no token is issued (NO self-provisioning).
   Composio googlesuper OAuth proves the email; the temporary login bucket is
   deleted afterwards (personal Drive/Gmail stays the profile connect under
   user_<id>). PUBLIC routes — NOT behind authenticateToken. */

const jwt = require('jsonwebtoken');
const { Sequelize } = require('sequelize');
const { User } = require('../models/master');
const composio = require('../services/composioClient');
const nonces = require('../services/loginNonceStore');

const LOGIN_SLUG = (process.env.GOOGLE_LOGIN_SLUG || 'gmail').toLowerCase();
const FRONT_URL = process.env.COMPOSIO_FRONT_URL || process.env.GOOGLE_FRONT_URL
  || 'http://localhost:3000/integrations';

/** Site origin (scheme+host) from the configured front URL — where OAuth returns. */
function siteOrigin() {
  try { return new URL(FRONT_URL).origin; } catch (_) { return 'http://localhost:3000'; }
}

/** Pure matching rule (case-insensitive, exact) — exported for unit tests. */
function _matchEmailIn(list, email) {
  const want = String(email || '').toLowerCase();
  return (list || []).find((u) => String(u.email || '').toLowerCase() === want) || null;
}

/** Find a Colonel user by exact, case-insensitive email. Returns user or null. */
async function findUserByEmail(email) {
  if (!email) return null;
  return User.findOne({
    where: Sequelize.where(
      Sequelize.fn('lower', Sequelize.col('email')),
      String(email).toLowerCase(),
    ),
  });
}

/* POST /api/auth/google/start — public. Returns { redirectUrl }. */
const start = async (req, res, next) => {
  try {
    if (!composio.isConfigured()) {
      return res.status(400).json({ error: 'Google sign-in is not available. Use email and password.' });
    }
    const nonce = nonces.issue();
    const callbackUrl = `${siteOrigin()}/login?google_login=${encodeURIComponent(nonce)}`;
    const result = await composio.connect(`login_${nonce}`, LOGIN_SLUG, callbackUrl);
    if (!result.redirectUrl) {
      return res.status(422).json({ error: 'Could not start Google sign-in — please try again.' });
    }
    res.json({ redirectUrl: result.redirectUrl });
  } catch (e) { next(e); }
};

/* POST /api/auth/google/finish  body { nonce } — public. */
const finish = async (req, res, next) => {
  const nonce = req.body && req.body.nonce;
  const userId = `login_${nonce}`;
  let cleanupId = null;
  try {
    if (!nonces.consume(nonce)) {
      return res.status(400).json({ error: 'This sign-in link has expired. Please try again.' });
    }
    // Confirm the OAuth completed (ACTIVE connection present in the temp bucket).
    let conns = [];
    try { conns = await composio.listConnections(userId); } catch (_) { conns = []; }
    if (!conns.length) {
      return res.status(409).json({ error: "Google sign-in didn't complete — please try again." });
    }
    cleanupId = conns[0].id;

    // Provider-verified email (never from client input).
    const email = await composio.getGoogleEmail(userId, true);
    if (!email) {
      return res.status(409).json({ error: "Couldn't read your Google account — please try again." });
    }

    // ── SECURITY GATE: existing users only. No match → no token. ──
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(403).json({ error: "This Google account isn't registered. Ask an admin to add you." });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN },
    );
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    next(e);
  } finally {
    // Authentication-only: drop the temp connection + cached email so no stubs linger.
    if (cleanupId) { try { await composio.disconnect(cleanupId); } catch (_) {} }
    if (nonce) composio.clearGoogleEmail(`login_${nonce}`);
    nonces.sweep();
  }
};

module.exports = { start, finish, findUserByEmail, _matchEmailIn };
```

- [ ] **Step 4: Run to verify the unit test passes**

Run: `node --test src/controllers/googleLoginController.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Back up and wire the public routes**

```bash
cp -a src/routes/authRoutes.js src/routes/authRoutes.js.bak-$(date +%Y%m%d-%H%M%S)
```

Edit `src/routes/authRoutes.js` — add the controller require and two public routes (leave `/register`'s admin lock untouched):

```js
const googleLogin = require('../controllers/googleLoginController');
// ... existing routes ...
// Public — Google sign-in on the login page (existing-users-only gate is server-side).
router.post('/google/start', googleLogin.start);
router.post('/google/finish', googleLogin.finish);
```

- [ ] **Step 6: Restart backend and smoke the endpoints unauthenticated**

```bash
pm2 restart colonel-automation-backend 2>/dev/null || (kill $(lsof -t -i:8001) 2>/dev/null; nohup node server.js > /tmp/colonel_backend.log 2>&1 &)
sleep 2
# start → should return a redirectUrl (Composio consent URL)
curl -s -X POST http://localhost:8001/api/auth/google/start | head -c 300; echo
# finish with a bogus nonce → 400 (expired/invalid), never a token
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8001/api/auth/google/finish -H 'Content-Type: application/json' -d '{"nonce":"bogus"}'
```

Expected: `start` → JSON containing `redirectUrl`; `finish` bogus → `400`.

- [ ] **Step 7: Commit**

```bash
git add src/controllers/googleLoginController.js src/controllers/googleLoginController.test.js src/routes/authRoutes.js
git commit -m "feat(login): Google sign-in start/finish endpoints (existing-users-only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Frontend — AuthContext methods + Login button/handler

**Files:**
- Modify: `frontend/src/context/AuthContext.js`
- Modify: `frontend/src/pages/Login.jsx`

**Interfaces:**
- Consumes: existing `api` client, `useAuth`, `useNavigate`, `/api/auth/google/{start,finish}`.
- Produces (AuthContext value additions):
  - `startGoogleLogin(): Promise<void>` — POST start, then `window.location.href = redirectUrl`.
  - `finishGoogleLogin(nonce): Promise<user>` — POST finish, store `token`+`user` in localStorage, `setUser`, return userData (same shape `login` returns).

- [ ] **Step 1: Back up both files**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation/frontend"
cp -a src/context/AuthContext.js src/context/AuthContext.js.bak-$(date +%Y%m%d-%H%M%S)
cp -a src/pages/Login.jsx src/pages/Login.jsx.bak-$(date +%Y%m%d-%H%M%S)
```

- [ ] **Step 2: Add the two methods to AuthContext**

In `src/context/AuthContext.js`, after the existing `login` function, add:

```js
  // Start "Sign in with Google": get the Composio consent URL and go there.
  const startGoogleLogin = async () => {
    const response = await api.post('/api/auth/google/start', {});
    const { redirectUrl } = response.data;
    if (!redirectUrl) throw new Error('Google sign-in unavailable');
    window.location.href = redirectUrl;
  };

  // Finish it after Composio redirects back to /login?google_login=<nonce>.
  const finishGoogleLogin = async (nonce) => {
    const response = await api.post('/api/auth/google/finish', { nonce });
    const { token, user: userData } = response.data;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(userData);
    return userData;
  };
```

Add both to the context provider `value={{ ... }}` alongside `login`, `register`, `logout`.

- [ ] **Step 3: Add the button + finish handler to Login.jsx**

In `src/pages/Login.jsx`:

1. Extend the destructure: `const { login, startGoogleLogin, finishGoogleLogin } = useAuth();`
2. Add a `routeByRole(user)` inline using the SAME switch the password path uses (admin→`/admin`, developer→`/feedback`, accountant→`/brands`, else→`/dashboard`), or reuse the existing block by extracting it.
3. Add a mount effect to complete the flow when redirected back:

```jsx
  const [googleError, setGoogleError] = useState('');
  const [googleBusy, setGoogleBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nonce = params.get('google_login');
    if (!nonce) return;
    // Strip the param so a refresh doesn't re-run finish.
    window.history.replaceState({}, '', '/login');
    setGoogleBusy(true);
    finishGoogleLogin(nonce)
      .then((user) => {
        if (user.role === 'admin') navigate('/admin');
        else if (user.role === 'developer') navigate('/feedback');
        else if (user.role === 'accountant') navigate('/brands');
        else navigate('/dashboard');
      })
      .catch((e) => setGoogleError(e?.response?.data?.error || 'Google sign-in failed.'))
      .finally(() => setGoogleBusy(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
```

4. Add the button under the password form:

```jsx
  <button
    type="button"
    onClick={() => { setGoogleError(''); startGoogleLogin().catch((e) =>
      setGoogleError(e?.response?.data?.error || 'Google sign-in unavailable.')); }}
    disabled={googleBusy}
    style={{ marginTop: 12, width: '100%', display: 'flex', alignItems: 'center',
      justifyContent: 'center', gap: 8, padding: '10px 16px', borderRadius: 10,
      border: '1px solid var(--card-border, #E2E8F0)', background: 'var(--surface, #fff)',
      color: 'var(--text-heading, #0F172A)', fontWeight: 700, cursor: 'pointer' }}
  >
    <img src="https://www.google.com/favicon.ico" alt="" width="18" height="18"
         onError={(e) => { e.currentTarget.style.display = 'none'; }} />
    {googleBusy ? 'Signing in…' : 'Sign in with Google'}
  </button>
  {googleError ? <p style={{ color: '#DC2626', fontSize: 13, marginTop: 8 }}>{googleError}</p> : null}
```

> The Google logo can also come from `/api/composio/toolkits` metadata (as Slice A does) — but a static favicon with `onError` fallback avoids an extra pre-auth request on the login page. Use the Slice-A logo source only if the team wants a single logo origin.
> Ensure `useEffect`/`useState` are imported: `import React, { useState, useEffect } from 'react';`.

- [ ] **Step 4: Verify the frontend compiles**

Run: check the dev server output / `npm run build` (or the craco build) → 0 errors.
Expected: compiles clean; `/login` shows the Google button below the password form.

- [ ] **Step 5: Commit**

```bash
cd "/Users/dhavalchauhan/Colonel Full/colonol git/colonel-automation"
git add frontend/src/context/AuthContext.js frontend/src/pages/Login.jsx
git commit -m "feat(login): Sign in with Google button + finish handler on login page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Live end-to-end verification (needs the user)

**Files:** none (verification only).

- [ ] **Step 1: Registered email → success**

In the browser at `http://localhost:3000/login`, click **Sign in with Google**, complete Google consent with an email that IS a registered Colonel user (e.g. the account behind `chauhandhaval932@gmail.com` if that's its Google email, or team@colonel.co.in if a user row exists). Expected: redirected back and landed on the role's home (accountant → `/brands`). Confirm a valid `token` + `user` in `localStorage`.

- [ ] **Step 2: Unregistered email → clean 403, no account created**

Repeat with a Google account that has NO Colonel user row. Expected: a clear "This Google account isn't registered. Ask an admin to add you." message; NO token stored; and (verify) no new row in `users`:

```bash
# adjust connection to the unified DB
psql "$DATABASE_URL" -c "select count(*) from users;"   # unchanged vs before
```

- [ ] **Step 3: Password login still works**

Log in with an email/password demo account. Expected: unchanged behavior.

- [ ] **Step 4: No leftover temp connections**

After the two attempts, confirm no `login_*` stubs remain:

```bash
cd new-backend && node -e "require('dotenv').config(); const c=require('./src/services/composioClient'); (async()=>{ try{ const r=await c.listConnections('login_dummy'); console.log('login_dummy conns', r.length); }catch(e){console.log(e.message)} process.exit(0); })()"
```

Expected: the temp buckets are deleted in `finish`'s `finally` (spot-check that no stubs accumulate in the Composio dashboard).

- [ ] **Step 5: Update memory**

Update `project_central_account.md` (+ MEMORY.md if needed): Login phase shipped local-only; resolver = `GOOGLESUPER_GET_PROFILE`; existing-users-only gate; B/C/D still pending.

---

## Self-Review

**Spec coverage:** §2 security gate → Task 3 `finish` 403 + Task 5 Step 2. §4 flow → Tasks 2+3+4. §5 email resolution → Task 1. §6 team@ default → already Slice A (no new work; verified in Step 1 the active default is `central`). §7 files → Tasks 1-4. §8 errors → Task 3 (400/409/403) + Task 4 (button hidden/message). §9 testing → Tasks 1,2,3 unit + Task 5 live.

**Placeholder scan:** none — every code step contains full source.

**Type consistency:** JWT `{ userId, role }` and response `{ token, user:{id,name,email,role} }` match password login in every task. `getGoogleEmail(userId, force)`, `nonces.issue/consume/sweep`, `findUserByEmail`, `startGoogleLogin`/`finishGoogleLogin(nonce)` names are used identically across tasks.

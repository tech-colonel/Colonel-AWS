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
  if (!want) return null;
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

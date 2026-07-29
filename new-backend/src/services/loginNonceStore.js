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

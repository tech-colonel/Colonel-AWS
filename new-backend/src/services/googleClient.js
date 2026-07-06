/**
 * googleClient.js
 *
 * Builds an authenticated Google OAuth2 client from the tokens stored on the
 * `google` integration row (set by the Connect-with-Google flow in
 * integrationController). Reused by Calendar + Drive so they act AS the
 * connected Google account (the user's own calendar/drive), matching how
 * Google is connected on AWS.
 *
 * Returns null when Google isn't connected or client creds are missing — every
 * caller treats that as "not configured" and degrades gracefully (no 500s).
 */
const { google } = require('googleapis');
const { Integration } = require('../models/master');

const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8001/api/auth/google/callback';

/** Returns { client, email } or null. Auto-refreshes + persists new tokens. */
async function getGoogleClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return null;

  const row = await Integration.findOne({ where: { type: 'google' } });
  const cfg = row?.config || {};
  if (row?.status !== 'connected' || (!cfg.refresh_token && !cfg.access_token)) return null;

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
  );
  client.setCredentials({
    access_token: cfg.access_token,
    refresh_token: cfg.refresh_token,
    expiry_date: cfg.token_expiry,
  });

  // Persist refreshed access tokens so we don't re-refresh every call.
  client.on('tokens', async (tokens) => {
    try {
      const fresh = await Integration.findOne({ where: { type: 'google' } });
      const c = fresh?.config || {};
      await fresh.update({
        config: {
          ...c,
          access_token: tokens.access_token || c.access_token,
          refresh_token: tokens.refresh_token || c.refresh_token,
          token_expiry: tokens.expiry_date || c.token_expiry,
        },
      });
    } catch (_) { /* non-fatal */ }
  });

  return { client, email: cfg.email || null };
}

module.exports = { getGoogleClient };

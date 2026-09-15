/* ──────────────────────────────────────────────────────────────────────────────
   amazonTokenStore.js — per-brand Amazon SP-API refresh tokens, encrypted at rest.

   Deliberately a sibling of shopifyTokenStore.js: same table shape, same RLS,
   same AES-256-GCM `iv:tag:payload` envelope, so whoever reads one understands
   the other. Storage: amazon_connections (014_amazon_connections.sql), one live
   row per brand.

   The important difference from Shopify: Amazon gives us a long-lived REFRESH
   token, not a usable API token. Nothing here can call SP-API — the refresh
   token is exchanged for a 1-hour access token in amazonAuth.js on every call.
   That makes this the MORE sensitive of the two stores: a leaked Shopify token
   expires when the merchant uninstalls, whereas a leaked refresh token keeps
   minting access tokens until the authorization is explicitly revoked.

   Losing AMAZON_TOKEN_KEY makes stored tokens unreadable — every brand would
   have to re-authorize. It is never logged and never leaves this module in
   plaintext except through getRefreshToken().

   Multi-brand by construction: marketplace_id and region live on the ROW, not in
   config, so brand #2 can be on amazon.in and brand #3 on amazon.com without a
   code change.
   ────────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const { getBrandConnection } = require('../config/database');
const { Brand } = require('../models/master');

const ALGO = 'aes-256-gcm';

/* Defaults for a new connection. India today; both are per-row so they are
   defaults, not assumptions. */
const DEFAULT_MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'A21TJRUUN4KGV'; // amazon.in
const DEFAULT_REGION         = process.env.AMAZON_REGION         || 'eu';            // India sits in EU

/* ── Key handling ───────────────────────────────────────────────────────────── */
let _key = null;
function getKey() {
  if (_key) return _key;
  const secret = process.env.AMAZON_TOKEN_KEY;
  if (!secret || secret.length < 16) {
    const err = new Error(
      'AMAZON_TOKEN_KEY is missing or too short (need >= 16 chars). ' +
      'Set it in new-backend/.env before connecting an Amazon seller account.'
    );
    err.status = 500;
    throw err;
  }
  // Fixed salt: the key must derive identically across restarts and processes,
  // or every stored token becomes unreadable after a deploy.
  _key = crypto.scryptSync(secret, 'colonel.amazon.token.v1', 32);
  return _key;
}

/** Encrypt a token → "iv:tag:ciphertext" (hex). */
function encrypt(plain) {
  const iv = crypto.randomBytes(12);                     // 96-bit IV, GCM standard
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

/** Decrypt "iv:tag:ciphertext". Throws if the key is wrong or data was tampered. */
function decrypt(stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3) throw new Error('Stored Amazon refresh token is malformed.');
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/* ── DB plumbing (mirrors shopifyTokenStore) ────────────────────────────────── */
async function getBrandSeq(brandId) {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');
  return getBrandConnection(brand.db_name);
}

/**
 * Save (or replace) a brand's connection. Re-authorizing the same seller updates
 * the row in place so the unique-per-brand index keeps holding.
 */
async function saveConnection(brandId, {
  refreshToken, sellingPartnerId, marketplaceId, region, roles, authMethod, installedBy,
}) {
  if (!refreshToken) throw new Error('A refresh token is required to save an Amazon connection.');
  const seq = await getBrandSeq(brandId);
  const enc = encrypt(refreshToken);
  const [rows] = await seq.query(
    `INSERT INTO amazon_connections
       (brand_id, selling_partner_id, refresh_token, marketplace_id, region, roles, auth_method, installed_by)
     VALUES (:brandId, :spid, :enc, :mkt, :region, :roles, :authMethod, :installedBy)
     ON CONFLICT (brand_id) WHERE revoked_at IS NULL
     DO UPDATE SET selling_partner_id = EXCLUDED.selling_partner_id,
                   refresh_token      = EXCLUDED.refresh_token,
                   marketplace_id     = EXCLUDED.marketplace_id,
                   region             = EXCLUDED.region,
                   roles              = EXCLUDED.roles,
                   auth_method        = EXCLUDED.auth_method,
                   installed_by       = EXCLUDED.installed_by,
                   revoked_at         = NULL,
                   updated_at         = now()
     RETURNING id, selling_partner_id, marketplace_id, region, roles, auth_method, installed_at`,
    {
      replacements: {
        brandId,
        spid:        sellingPartnerId || null,
        enc,
        mkt:         marketplaceId || DEFAULT_MARKETPLACE_ID,
        region:      region || DEFAULT_REGION,
        roles:       roles || null,
        authMethod:  authMethod || 'self',
        installedBy: installedBy || null,
      },
    }
  );
  return rows[0];
}

/** The brand's live connection WITHOUT the token — safe to hand to the UI. */
async function getConnection(brandId) {
  const seq = await getBrandSeq(brandId);
  const [rows] = await seq.query(
    `SELECT id, selling_partner_id, marketplace_id, region, roles, auth_method,
            installed_at, last_used_at
       FROM amazon_connections
      WHERE brand_id = :brandId AND revoked_at IS NULL
      LIMIT 1`,
    { replacements: { brandId } }
  );
  return rows[0] || null;
}

/**
 * Decrypted refresh token + routing info for API calls. Returns null when the
 * brand has no live connection, so callers can answer "not connected" instead of
 * throwing.
 */
async function getRefreshToken(brandId) {
  const seq = await getBrandSeq(brandId);
  const [rows] = await seq.query(
    `SELECT selling_partner_id, refresh_token, marketplace_id, region
       FROM amazon_connections
      WHERE brand_id = :brandId AND revoked_at IS NULL LIMIT 1`,
    { replacements: { brandId } }
  );
  if (!rows[0]) return null;
  // Touch last_used_at, but never let telemetry break a real API call.
  seq.query(`UPDATE amazon_connections SET last_used_at = now()
              WHERE brand_id = :brandId AND revoked_at IS NULL`,
    { replacements: { brandId } }).catch(() => {});
  return {
    sellingPartnerId: rows[0].selling_partner_id,
    refreshToken:     decrypt(rows[0].refresh_token),
    marketplaceId:    rows[0].marketplace_id || DEFAULT_MARKETPLACE_ID,
    region:           rows[0].region || DEFAULT_REGION,
  };
}

/** Mark a brand's connection revoked (manual disconnect). */
async function revokeConnection(brandId) {
  const seq = await getBrandSeq(brandId);
  await seq.query(
    `UPDATE amazon_connections SET revoked_at = now(), updated_at = now()
      WHERE brand_id = :brandId AND revoked_at IS NULL`,
    { replacements: { brandId } }
  );
  return true;
}

module.exports = {
  encrypt, decrypt,                 // exported for tests
  saveConnection, getConnection, getRefreshToken, revokeConnection,
  DEFAULT_MARKETPLACE_ID, DEFAULT_REGION,
};

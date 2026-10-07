/* ──────────────────────────────────────────────────────────────────────────────
   shopifyTokenStore.js — per-brand Shopify Admin API tokens, encrypted at rest.

   Why we hold tokens ourselves instead of leaning on Composio (which already
   brokers our other OAuth apps):
     • Composio REDACTS access_token on every endpoint ("shpa..."), so its token
       can never be used for a direct Admin API call.
     • ~11 of the 30 scopes our Shopify app requests have NO Composio tool at all
       (returns, companies, shopify_payments_*, store credit, markets,
       publications, inventory transfers/shipments, order edits).
   Composio stays wired for its 1000+ other toolkits; Shopify is ours end to end.

   Storage: shopify_connections (see db/migrations/010_shopify_connections.sql),
   one live row per brand, RLS-scoped on brand_id like every other brand table.
   The token column holds AES-256-GCM ciphertext as `iv:tag:payload` (all hex).
   Losing SHOPIFY_TOKEN_KEY makes stored tokens unreadable — merchants would have
   to reconnect. It is never logged and never leaves this module in plaintext
   except through getToken().
   ────────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const { getBrandConnection } = require('../config/database');
const { Brand } = require('../models/master');

const ALGO = 'aes-256-gcm';

/* ── Key handling ───────────────────────────────────────────────────────────── */
/**
 * 32-byte key derived from SHOPIFY_TOKEN_KEY. Any length of secret is accepted —
 * scrypt stretches it — so operators can use a passphrase or a hex blob.
 * Throws loudly at first use rather than silently storing plaintext.
 */
let _key = null;
function getKey() {
  if (_key) return _key;
  const secret = process.env.SHOPIFY_TOKEN_KEY;
  if (!secret || secret.length < 16) {
    const err = new Error(
      'SHOPIFY_TOKEN_KEY is missing or too short (need >= 16 chars). ' +
      'Set it in new-backend/.env before connecting a Shopify store.'
    );
    err.status = 500;
    throw err;
  }
  // Fixed salt: the key must derive identically across restarts and processes,
  // so a random salt would make every stored token unreadable after a deploy.
  _key = crypto.scryptSync(secret, 'colonel.shopify.token.v1', 32);
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
  if (parts.length !== 3) throw new Error('Stored Shopify token is malformed.');
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/* ── DB plumbing (mirrors driveConfigController / bankCorrectionsController) ─── */
async function getBrandSeq(brandId) {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');
  return getBrandConnection(brand.db_name);
}

/**
 * Save (or replace) a brand's connection. Re-installing the same shop updates
 * the row in place so the unique-per-brand index keeps holding.
 */
async function saveConnection(brandId, { shopDomain, accessToken, scopes, apiVersion, installedBy }) {
  const seq = await getBrandSeq(brandId);
  const enc = encrypt(accessToken);
  return seq.transaction(async (t) => {
    await seq.query(
      `UPDATE shopify_connections SET revoked_at = now(), updated_at = now()
        WHERE brand_id = :brandId AND revoked_at IS NULL AND shop_domain <> :shopDomain`,
      { replacements: { brandId, shopDomain }, transaction: t }
    );
    const [rows] = await seq.query(
      `INSERT INTO shopify_connections
         (brand_id, shop_domain, access_token, scopes, api_version, installed_by)
       VALUES (:brandId, :shopDomain, :enc, :scopes, :apiVersion, :installedBy)
       ON CONFLICT (brand_id) WHERE revoked_at IS NULL
       DO UPDATE SET shop_domain  = EXCLUDED.shop_domain,
                     access_token = EXCLUDED.access_token,
                     scopes       = EXCLUDED.scopes,
                     api_version  = EXCLUDED.api_version,
                     installed_by = EXCLUDED.installed_by,
                     revoked_at   = NULL,
                     updated_at   = now()
       RETURNING id, shop_domain, scopes, installed_at`,
      {
        replacements: { brandId, shopDomain, enc, scopes: scopes || null,
                        apiVersion: apiVersion || '2026-07', installedBy: installedBy || null },
        transaction: t,
      }
    );
    return rows[0];
  });
}

/** The brand's live connection WITHOUT the token — safe to hand to the UI. */
async function getConnection(brandId) {
  const seq = await getBrandSeq(brandId);
  const [rows] = await seq.query(
    `SELECT id, shop_domain, scopes, api_version, installed_at, last_used_at
       FROM shopify_connections
      WHERE brand_id = :brandId AND revoked_at IS NULL
      LIMIT 1`,
    { replacements: { brandId } }
  );
  return rows[0] || null;
}

/**
 * Decrypted token + shop for API calls. Returns null when the brand has no live
 * connection, so callers can answer "not connected" instead of throwing.
 */
async function getToken(brandId) {
  const seq = await getBrandSeq(brandId);
  const [rows] = await seq.query(
    `SELECT shop_domain, access_token, api_version FROM shopify_connections
      WHERE brand_id = :brandId AND revoked_at IS NULL LIMIT 1`,
    { replacements: { brandId } }
  );
  if (!rows[0]) return null;
  // Touch last_used_at, but never let telemetry break a real API call.
  seq.query(`UPDATE shopify_connections SET last_used_at = now()
              WHERE brand_id = :brandId AND revoked_at IS NULL`,
    { replacements: { brandId } }).catch(() => {});
  return {
    shopDomain: rows[0].shop_domain,
    accessToken: decrypt(rows[0].access_token),
    apiVersion: rows[0].api_version || '2026-07',
  };
}

/** Mark a brand's connection revoked (uninstall webhook, or manual disconnect). */
async function revokeConnection(brandId) {
  const seq = await getBrandSeq(brandId);
  await seq.query(
    `UPDATE shopify_connections SET revoked_at = now(), updated_at = now()
      WHERE brand_id = :brandId AND revoked_at IS NULL`,
    { replacements: { brandId } }
  );
  return true;
}

/** Revoke by shop domain — the uninstall webhook knows the shop, not the brand. */
async function revokeByShopDomain(shopDomain) {
  const { sequelize } = require('../models/master');
  await sequelize.query(
    `UPDATE shopify_connections SET revoked_at = now(), updated_at = now()
      WHERE shop_domain = :shopDomain AND revoked_at IS NULL`,
    { replacements: { shopDomain } }
  );
  return true;
}

module.exports = {
  encrypt, decrypt,                 // exported for tests
  saveConnection, getConnection, getToken, revokeConnection, revokeByShopDomain,
};

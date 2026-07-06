/**
 * seed-compliance-stroom.js — one-time local provisioning (gitignored).
 *
 *   1. Grants chauhandhaval932@gmail.com access to the Stroom brand (brand_users).
 *   2. Seeds Stroom's 5 compliance categories.
 *   3. Materialises 12 monthly instances (2026) of the Stroom monthly workflow
 *      for that user.
 *
 * Idempotent — safe to re-run. Koparo and all other brands stay untouched
 * (blank tracker). Run:  node seed-compliance-stroom.js
 */
const { masterSequelize } = require('./src/config/database');
const { seedComplianceForBrandUser } = require('./src/controllers/complianceController');

const YEAR = 2026;
const USER_EMAIL = 'chauhandhaval932@gmail.com';
const BRAND_NAME = 'Stroom';

(async () => {
  try {
    await masterSequelize.authenticate();

    const [[user]] = await masterSequelize.query(
      `SELECT id, name FROM users WHERE email = $1 LIMIT 1`, { bind: [USER_EMAIL] }
    );
    const [[brand]] = await masterSequelize.query(
      `SELECT id, name FROM brands WHERE name = $1 LIMIT 1`, { bind: [BRAND_NAME] }
    );
    if (!user)  throw new Error(`User ${USER_EMAIL} not found`);
    if (!brand) throw new Error(`Brand ${BRAND_NAME} not found`);

    // 1. Grant brand access (brand_users) — idempotent.
    const [existing] = await masterSequelize.query(
      `SELECT 1 FROM brand_users WHERE user_id = $1 AND brand_id = $2 LIMIT 1`,
      { bind: [user.id, brand.id] }
    );
    if (!existing.length) {
      await masterSequelize.query(
        `INSERT INTO brand_users (id, brand_id, user_id, "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, now(), now())`,
        { bind: [brand.id, user.id] }
      );
      console.log(`[SEED] ✅ Granted ${user.name} access to ${brand.name}`);
    } else {
      console.log(`[SEED] • ${user.name} already has ${brand.name} access`);
    }

    // 2 + 3. Categories + 12-month template.
    const result = await seedComplianceForBrandUser({
      brandId: brand.id, userId: user.id, year: YEAR,
    });
    console.log(`[SEED] ✅ Compliance tracker: ${result.months} months, ${result.inserted} new tasks for ${YEAR}`);
    console.log('[SEED] Done. Log in as', USER_EMAIL, '→ Stroom → Compliance Tracker.');
    process.exit(0);
  } catch (err) {
    console.error('[SEED] ❌', err.message);
    process.exit(1);
  }
})();

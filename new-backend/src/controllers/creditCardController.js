/**
 * creditCardController.js — Credit Card Booking agent (brand-scoped).
 *
 * Owns the agent's learning layer:
 *   • getCardContext(brandId)  — the chart of accounts + auto-learned merchant
 *     directory handed to the Python engine on every run.
 *   • saveCorrections          — a reviewer's fixes from the Working grid, which
 *     are persisted AND folded back into the directory so next month books
 *     itself.
 *   • getDirectory / deleteDirectoryEntry — inspect and prune what was learned.
 *
 * RLS: cc_merchant_directory and cc_booking_corrections carry ONLY the hardened
 * tenant-isolation policy — there is deliberately no app.bypass_rls escape hatch
 * on them (005_harden_rls.sql removed that pattern). Every query here therefore
 * runs inside a transaction with `SET LOCAL app.brand_id`, which is also what
 * populates the brand_id column default.
 *
 * Nothing here reads or writes the Universal Bank Statement agent's tables.
 */
'use strict';

const { Brand } = require('../models/master');
const { getBrandConnection } = require('../config/database');

/** Mirrors extract_keys() in reco-engine/recon/credit_card_booking.py.
 *  MUST stay in sync — this file WRITES the keys that module READS. */
// The separator after the acquirer prefix is a literal '*' in clean text, but OCR
// renders it as a curly quote often enough that both must match. Written with
// explicit escapes — typing the curly characters directly is how this regex
// silently lost them, leaving 'PYU”FIipkart' unstripped and producing keys the
// Python side never generates.
const GATEWAY_RE = /^(RAZ|PAY|PYU|EASEBUZZ|PAYU|BILLDESK|CCAVENUE|INSTAMOJO|CASHFREE)\s*[*“”‘’"']\s*/i;
const REF_TAIL_RE = /\s*[-–—]?\s*Ref\s*No\.?\s*:?\s*\S+/ig;
const FOREX_RE = /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\s+[\d,]+\.?\d*\s+[A-Z]{3}\b/ig;
const CATEGORY_RE = /\b(?:[A-Za-z]+\s+){0,2}(?:Servi[cs]es?|Sewi[cs]es?|Stores?|Outlets?|Outiet|Utilities)\b/ig;

const NOISE = new Set([
  'IND', 'INDIA', 'IN', 'USA', 'US', 'GBR', 'SGP', 'CA', 'NY', 'DEL', 'MAH', 'KAR',
  'HAR', 'TN', 'UP', 'WB', 'GJ', 'MUMBAI', 'MUMBA', 'BANGALORE', 'BENGALURU',
  'GURGAON', 'GURUGRAM', 'DELHI', 'NEW', 'NOIDA', 'CHENNAI', 'HYDERABAD', 'PUNE',
  'KOLKATA', 'AHMEDABAD', 'JAIPUR', 'SAN', 'FRANCISCO', 'MATEO', 'JOSE', 'IRVINE',
  'SEATTLE', 'LONDON', 'SINGAPORE', 'DUBLIN', 'DUB', 'KAUNAS', 'BRUSSELS', 'YORK',
  'SOUTH', 'WEST', 'EAST', 'NORTH', 'SOUTHWESTDELH', 'URBANKARNATAK', 'WWW',
  'HTTPS', 'HTTP', 'COM', 'PVT', 'PRIVATE', 'LTD', 'LIMITED', 'LLP', 'INC', 'LLC',
  'CO', 'CORP', 'PTE', 'PLC', 'GMBH', 'SA', 'BV', 'L', 'S', 'D', 'DE',
]);

function merchantKey(narration) {
  let s = String(narration || '')
    .replace(REF_TAIL_RE, ' ')
    .replace(FOREX_RE, ' ')
    .replace(CATEGORY_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(GATEWAY_RE, '')
    .replace(/^M\/?S\.?\s+/i, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ');
  const out = [];
  for (const t of s.split(/\s+/)) {
    if (!t || NOISE.has(t) || /^\d+$/.test(t)) continue;
    out.push(t);
    if (out.length >= 3) break;
  }
  return out.join(' ');
}

function extractKeys(narration) {
  const keys = [];
  const exact = String(narration || '').replace(REF_TAIL_RE, '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (exact) keys.push({ key_type: 'exact', key_value: exact });
  const full = merchantKey(narration);
  if (!full) return keys;
  keys.push({ key_type: 'merchant', key_value: full });
  const toks = full.split(' ');
  const seen = new Set([full]);
  for (const [n, kt] of [[2, 'merchant2'], [1, 'merchant1']]) {
    if (toks.length > n) {
      const cand = toks.slice(0, n).join(' ');
      if (!seen.has(cand)) { seen.add(cand); keys.push({ key_type: kt, key_value: cand }); }
    }
  }
  return keys;
}

/** Run `fn(db, t)` in a transaction scoped to the brand via the RLS GUC. */
async function withBrandScope(brandId, fn) {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');
  const db = getBrandConnection(brand.db_name);
  return db.transaction(async (t) => {
    await db.query(`SET LOCAL app.brand_id = '${String(brandId).replace(/'/g, '')}'`, { transaction: t });
    return fn(db, t);
  });
}

/**
 * COA + learned directory for a brand, in the shape the Python agent expects.
 * Returns empty arrays (never throws) when a brand has no COA yet — the agent
 * still runs and simply books more rows to Suspense.
 */
async function getCardContext(brandId) {
  try {
    return await withBrandScope(brandId, async (db, t) => {
      const [coaRows] = await db.query(
        'SELECT ledger_name FROM ledger_master WHERE brand_id = $1',
        { bind: [brandId], transaction: t },
      );
      const [dirRows] = await db.query(
        `SELECT key_type, key_value, ledger FROM cc_merchant_directory
          WHERE brand_id = $1`,
        { bind: [brandId], transaction: t },
      );
      return {
        coa: coaRows.map((r) => String(r.ledger_name || '').trim()).filter(Boolean),
        directory: dirRows.map((r) => ({
          key_type: r.key_type, key_value: r.key_value, ledger: r.ledger,
        })),
      };
    });
  } catch (err) {
    console.warn(`[CC] context read failed for brand ${brandId}: ${err.message}`);
    return { coa: [], directory: [] };
  }
}

/**
 * POST /api/credit-card/:brandId/corrections
 * body: { corrections: [{ narration, correct_ledger, previous_ledger?, card_ledger? }], job_id? }
 *
 * Records each fix and folds it into the directory under EVERY key the narration
 * supports, so the same merchant is recognised next month even when the
 * statement truncates its name differently.
 */
async function saveCorrections(req, res) {
  const { brandId } = req.params;
  const corrections = Array.isArray(req.body?.corrections) ? req.body.corrections : [];
  if (!corrections.length) {
    return res.status(400).json({ error: 'No corrections supplied.' });
  }

  try {
    const result = await withBrandScope(brandId, async (db, t) => {
      // Only real COA ledgers may be learned — otherwise a typo in the review
      // grid becomes a permanent rule that produces un-importable bookings.
      const [coaRows] = await db.query(
        'SELECT ledger_name FROM ledger_master WHERE brand_id = $1',
        { bind: [brandId], transaction: t },
      );
      const coa = new Map(coaRows.map((r) => [String(r.ledger_name).trim().toLowerCase(),
        String(r.ledger_name).trim()]));

      let saved = 0; let learned = 0; const rejected = [];
      for (const c of corrections) {
        const narration = String(c.narration || '').trim();
        const wanted = String(c.correct_ledger || '').trim();
        if (!narration || !wanted) continue;
        const real = coa.size ? coa.get(wanted.toLowerCase()) : wanted;
        if (!real) { rejected.push(wanted); continue; }

        await db.query(
          `INSERT INTO cc_booking_corrections
             (brand_id, narration_raw, narration_key, correct_ledger,
              previous_ledger, card_ledger, job_id, corrected_by, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ui')`,
          {
            bind: [brandId, narration, merchantKey(narration), real,
              c.previous_ledger || null, c.card_ledger || null,
              req.body.job_id || null, req.user?.id && req.user.id !== 'demo' ? req.user.id : null],
            transaction: t,
          },
        );
        saved += 1;

        for (const k of extractKeys(narration)) {
          await db.query(
            `INSERT INTO cc_merchant_directory (brand_id, key_type, key_value, ledger, source)
             VALUES ($1, $2, $3, $4, 'correction')
             ON CONFLICT (brand_id, key_type, key_value)
             DO UPDATE SET ledger = EXCLUDED.ledger, source = 'correction', updated_at = NOW()`,
            { bind: [brandId, k.key_type, k.key_value, real], transaction: t },
          );
          learned += 1;
        }
      }
      return { saved, learned, rejected };
    });

    if (result.rejected.length) {
      console.warn(`[CC] rejected ${result.rejected.length} correction(s) — not in COA:`,
        [...new Set(result.rejected)].slice(0, 5));
    }
    return res.json({
      success: true,
      saved: result.saved,
      keys_learned: result.learned,
      rejected: [...new Set(result.rejected)],
    });
  } catch (err) {
    console.error('[CC] saveCorrections failed:', err.message);
    return res.status(500).json({ error: `Could not save corrections: ${err.message}` });
  }
}

/** GET /api/credit-card/:brandId/ledgers — COA names for the review dropdown. */
async function getLedgers(req, res) {
  try {
    const ctx = await getCardContext(req.params.brandId);
    // Sorted so the datalist is scannable; the card ledgers float to the top
    // because that is what a reviewer picks most often on this screen.
    const cards = ctx.coa.filter((l) => /credit\s*card/i.test(l)).sort();
    const rest = ctx.coa.filter((l) => !/credit\s*card/i.test(l)).sort();

    // Freshness of the chart of accounts. This agent only READS ledger_master —
    // the single write path is uploading a Ledger Master to the Universal Bank
    // Statement agent. Without this the UI cannot tell a stale COA from a
    // current one, and a ledger added in Tally today would silently send its
    // merchant to Suspense.
    let updatedAt = null;
    try {
      updatedAt = await withBrandScope(req.params.brandId, async (db, t) => {
        const [[row]] = await db.query(
          'SELECT max(updated_at) AS updated_at FROM ledger_master WHERE brand_id = $1',
          { bind: [req.params.brandId], transaction: t },
        );
        return row?.updated_at || null;
      });
    } catch (_) { /* freshness is advisory — never fail the picker over it */ }

    return res.json({
      count: ctx.coa.length,
      cardLedgers: cards,
      ledgers: [...cards, ...rest],
      updatedAt,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/** GET /api/credit-card/:brandId/directory — what the brand has learned. */
async function getDirectory(req, res) {
  try {
    const rows = await withBrandScope(req.params.brandId, async (db, t) => {
      const [r] = await db.query(
        `SELECT id, key_type, key_value, ledger, source, updated_at
           FROM cc_merchant_directory WHERE brand_id = $1
          ORDER BY ledger, key_type, key_value`,
        { bind: [req.params.brandId], transaction: t },
      );
      return r;
    });
    return res.json({ count: rows.length, entries: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/** DELETE /api/credit-card/:brandId/directory/:id — drop a bad learned rule. */
async function deleteDirectoryEntry(req, res) {
  try {
    const n = await withBrandScope(req.params.brandId, async (db, t) => {
      const [, meta] = await db.query(
        'DELETE FROM cc_merchant_directory WHERE brand_id = $1 AND id = $2',
        { bind: [req.params.brandId, req.params.id], transaction: t },
      );
      return meta?.rowCount ?? 0;
    });
    return res.json({ success: true, deleted: n });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getCardContext,
  getLedgers,
  saveCorrections,
  getDirectory,
  deleteDirectoryEntry,
  // exported for tests / parity checks with the Python key logic
  merchantKey,
  extractKeys,
};

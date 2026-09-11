/* ──────────────────────────────────────────────────────────────────────────────
   returnPrimeWebhookController.js — receives Return Prime webhook deliveries.

   THIS IS A PUBLIC, UNAUTHENTICATED URL. Anything on the internet can POST to
   it, and what it accepts becomes returns data in a financial report. Two things
   guard it:

     1. A SECRET IN THE PATH (RETURN_PRIME_WEBHOOK_TOKEN). Return Prime does not
        document a signing secret and its app UI exposes none, so there is no
        HMAC to verify — the unguessable path is the shared secret. Compared with
        timingSafeEqual so the comparison cannot be timed.
     2. HMAC VERIFICATION IF THEY EVER SIGN. If RETURN_PRIME_WEBHOOK_SECRET is
        set, a signature header is required and checked. Until then the code path
        is inert rather than absent, so switching it on is a config change.

   A secret path is weaker than a signature — it rides in the URL and cannot be
   rotated without reconfiguring the sender. It is the honest best available, and
   it is why this endpoint only ever WRITES TO A LANDING TABLE and never mutates
   a report directly. A forged event becomes a row someone can inspect and
   delete, not a silently altered receivable.

   ALWAYS 200 ON A VALID SECRET. A webhook sender that gets a 500 retries, and a
   retry storm against a broken parser is worse than a stored-but-unparsed event.
   The payload lands verbatim; interpretation happens on read.
   ────────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const { masterSequelize } = require('../config/database');
const { QueryTypes } = require('sequelize');

/** Constant-time compare that tolerates unequal lengths (timingSafeEqual throws). */
function safeEqual(a, b) {
    const ba = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    if (ba.length !== bb.length) {
        // Still burn a comparison so length alone isn't a timing oracle.
        crypto.timingSafeEqual(ba, ba);
        return false;
    }
    return crypto.timingSafeEqual(ba, bb);
}

function verifySignature(req) {
    const secret = process.env.RETURN_PRIME_WEBHOOK_SECRET;
    if (!secret) return { ok: true, checked: false };   // not configured — path secret only

    const header = req.get('x-returnprime-hmac-sha256')
        || req.get('x-rp-signature')
        || req.get('x-webhook-signature');
    if (!header) return { ok: false, checked: true, reason: 'signature header missing' };

    const body = req.rawBody || JSON.stringify(req.body || {});
    const digest = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
    const hex = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    const ok = safeEqual(header, digest) || safeEqual(header, hex);
    return { ok, checked: true, reason: ok ? null : 'signature mismatch' };
}

const str = (v) => (v == null ? null : String(v).trim() || null);
const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : null; };

/** Pull the fields we care about without assuming a shape we haven't seen.
    Return Prime's payload is undocumented to us, so every lookup is a list of
    plausible keys and a miss is null rather than a crash. */
function extract(body = {}) {
    const d = body.data || body.request || body.payload || body;
    const pick = (...keys) => {
        for (const k of keys) {
            const v = k.split('.').reduce((o, part) => (o == null ? o : o[part]), d);
            if (v !== undefined && v !== null && String(v).trim() !== '') return v;
        }
        return null;
    };
    return {
        requestId: str(pick('id', 'request_id', 'requestId', 'return_id', 'name')),
        orderNumber: str(pick('order_number', 'orderNumber', 'order_name', 'order.name', 'order.order_number')),
        amount: num(pick('refund_amount', 'refundAmount', 'amount', 'total', 'total_refund')),
        currency: str(pick('currency', 'currency_code')),
        shopDomain: str(pick('shop', 'shop_domain', 'shopDomain', 'store', 'store_url')),
    };
}

/**
 * POST /api/webhooks/return-prime/:token
 *
 * Idempotent: a replayed delivery hits the unique index on dedupe_key and is
 * acknowledged without writing a second row.
 */
const receive = async (req, res) => {
    const expected = process.env.RETURN_PRIME_WEBHOOK_TOKEN;
    if (!expected) {
        console.warn('[return-prime] webhook hit but RETURN_PRIME_WEBHOOK_TOKEN is not set — refusing');
        return res.status(503).json({ ok: false });
    }
    if (!safeEqual(req.params.token, expected)) {
        // Deliberately terse and 404: a wrong secret should not confirm that the
        // route exists at all.
        return res.status(404).end();
    }

    const sig = verifySignature(req);
    if (!sig.ok) {
        console.warn(`[return-prime] rejected delivery — ${sig.reason}`);
        return res.status(401).json({ ok: false });
    }

    const brandId = process.env.RETURN_PRIME_BRAND_ID;
    if (!brandId) {
        console.warn('[return-prime] RETURN_PRIME_BRAND_ID not set — cannot attribute event');
        return res.status(503).json({ ok: false });
    }

    const topic = str(req.get('x-returnprime-topic') || req.get('x-rp-topic') || (req.body && req.body.topic) || (req.body && req.body.event)) || 'unknown';
    const f = extract(req.body);
    const payload = req.body || {};

    // Prefer the sender's own id; fall back to a content hash so a payload with
    // no id still de-duplicates instead of inserting on every retry.
    const dedupe = f.requestId
        ? `${topic}:${f.requestId}`
        : `${topic}:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`;

    try {
        await masterSequelize.query(
            `INSERT INTO return_prime_events
               (brand_id, topic, shop_domain, request_id, order_number, amount, currency, payload, dedupe_key)
             VALUES (:brandId, :topic, :shop, :requestId, :orderNumber, :amount, :currency, CAST(:payload AS jsonb), :dedupe)
             ON CONFLICT (dedupe_key) DO NOTHING`,
            {
                type: QueryTypes.INSERT,
                replacements: {
                    brandId, topic,
                    shop: f.shopDomain,
                    requestId: f.requestId,
                    orderNumber: f.orderNumber ? String(f.orderNumber).replace(/^#/, '') : null,
                    amount: f.amount,
                    currency: f.currency,
                    payload: JSON.stringify(payload),
                    dedupe,
                },
            }
        );
        console.log(`[return-prime] stored ${topic} order=${f.orderNumber || '-'} amount=${f.amount ?? '-'}`);
    } catch (e) {
        // Store failures are ours, not the sender's. Log loudly, still 200 — a
        // retry storm would not fix a broken insert and would bury the error.
        console.error(`[return-prime] store failed (${e.message}) — acknowledging anyway to avoid a retry storm`);
    }
    return res.status(200).json({ ok: true });
};

/** GET /api/webhooks/return-prime/:token/health — lets us prove the route is
    live without POSTing a fake event into the table. */
const health = async (req, res) => {
    const expected = process.env.RETURN_PRIME_WEBHOOK_TOKEN;
    if (!expected || !safeEqual(req.params.token, expected)) return res.status(404).end();
    let count = null;
    try {
        const [row] = await masterSequelize.query(
            'SELECT count(*)::int AS n FROM return_prime_events', { type: QueryTypes.SELECT });
        count = row ? row.n : null;
    } catch { /* table may not exist yet */ }
    res.json({
        ok: true,
        signatureVerification: process.env.RETURN_PRIME_WEBHOOK_SECRET ? 'enabled' : 'disabled (path secret only)',
        brandConfigured: !!process.env.RETURN_PRIME_BRAND_ID,
        eventsStored: count,
    });
};

module.exports = { receive, health };

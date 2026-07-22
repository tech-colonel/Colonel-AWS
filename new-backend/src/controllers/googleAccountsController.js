/* ──────────────────────────────────────────────────────────────────────────────
   googleAccountsController.js — the central-account + personal Google login layer
   (Slice A of the central-account / Drive-intake / email-output feature).

   Two Composio "userId" buckets:
     • central              → the firm's shared team@colonel.co.in account
                              (connected once by an admin; used to SEND mail and
                              as the identity behind brand Drive folders).
     • user_<appUserId>     → an individual user's personal Google account.

   Bulk Drive READS use the service account (driveService), not Composio — this
   layer is about identity + who mail is sent as. Additive: it does not touch the
   existing per-brand marketplace flow (composioController).
   ────────────────────────────────────────────────────────────────────────────── */

const composio = require('../services/composioClient');
let driveService = null;
try { driveService = require('../services/driveService'); } catch (_) { /* optional */ }

// The firm's central mailbox. Central connections are always this identity.
const CENTRAL_EMAIL = process.env.CENTRAL_GOOGLE_EMAIL || 'team@colonel.co.in';
// The toolkit we connect for login — Gmail gives send + profile (email) scope.
const LOGIN_SLUG = process.env.GOOGLE_LOGIN_SLUG || 'gmail';

// Where the browser returns after authorizing.
const FRONT_URL = process.env.COMPOSIO_FRONT_URL
  || process.env.GOOGLE_FRONT_URL
  || 'http://localhost:3000/integrations';

/** Composio userId bucket for a login kind. */
function resolveGoogleUserId(kind, req) {
  return kind === 'central' ? 'central' : `user_${req.user.id}`;
}

function isAdmin(req) { return req.user && req.user.role === 'admin'; }

/* ── GET /api/google/accounts ─────────────────────────────────────────────────
   The accounts available to the current user: the shared central account plus
   their own personal connection(s). Each entry: { id, kind, email, slug, status }. */
const listAccounts = async (req, res, next) => {
  try {
    if (!composio.isConfigured()) return res.json({ configured: false, central: null, personal: [] });

    // Central (shared) — label is the known firm identity; verify it's connected.
    let central = null;
    try {
      const cs = await composio.listConnections('central');
      const gmail = cs.find((c) => String(c.slug || '').toLowerCase() === LOGIN_SLUG) || cs[0];
      if (gmail) central = { id: gmail.id, kind: 'central', email: CENTRAL_EMAIL, slug: gmail.slug, status: gmail.status };
    } catch (_) { /* central not connected yet */ }

    // Personal — resolve the real Google email via the profile tool (cached).
    const personal = [];
    try {
      const userId = `user_${req.user.id}`;
      const conns = await composio.listConnections(userId);
      if (conns.length) {
        const email = await composio.getGoogleEmail(userId);
        for (const c of conns) {
          personal.push({ id: c.id, kind: 'personal', email: email || null, slug: c.slug, status: c.status });
        }
      }
    } catch (_) { /* none */ }

    const logo = await composio.getToolkitLogo(LOGIN_SLUG);
    res.json({ configured: true, central, personal, logo });
  } catch (e) { next(e); }
};

/* ── POST /api/google/connect  body { kind:'central'|'personal', slug? } ──────
   Returns { redirectUrl } for the OAuth consent page. Central is admin-only. */
const connect = async (req, res, next) => {
  try {
    if (!composio.isConfigured()) return res.status(400).json({ error: 'Google login is not configured on this server.' });
    const kind = req.body?.kind === 'central' ? 'central' : 'personal';
    if (kind === 'central' && !isAdmin(req)) {
      return res.status(403).json({ error: 'Only an admin can connect the central team@ account.' });
    }
    const slug = (req.body?.slug || LOGIN_SLUG).toString().toLowerCase();
    const userId = resolveGoogleUserId(kind, req);
    const callbackUrl = `${FRONT_URL}?google_connected=${encodeURIComponent(kind)}`;
    const result = await composio.connect(userId, slug, callbackUrl);
    if (!result.redirectUrl) {
      return res.status(422).json({ error: 'Could not start Google sign-in — please try again.' });
    }
    composio.clearGoogleEmail(userId); // refresh label after the user finishes
    res.json({ redirectUrl: result.redirectUrl, connectedAccountId: result.connectedAccountId });
  } catch (e) {
    const raw = [e && e.message, e && e.code, JSON.stringify((e && e.response && e.response.data) || (e && e.body) || '')].join(' ');
    if (/DefaultAuthConfigNotFound|managed credentials|not found for toolkit/i.test(raw)) {
      return res.status(422).json({ error: 'Google sign-in isn’t available yet — the Gmail connector needs its Composio auth config.' });
    }
    next(e);
  }
};

/* ── POST /api/google/accounts/:id/disconnect ─────────────────────────────────
   Remove a connection. A user may remove their personal account; only an admin
   may remove the central account. */
const disconnect = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Missing account id' });
    if (String(req.query.kind) === 'central' && !isAdmin(req)) {
      return res.status(403).json({ error: 'Only an admin can disconnect the central account.' });
    }
    await composio.disconnect(id);
    // Bust cached emails for both buckets (cheap, avoids stale labels).
    composio.clearGoogleEmail('central');
    composio.clearGoogleEmail(`user_${req.user.id}`);
    res.json({ ok: true });
  } catch (e) {
    const raw = [e && e.message, e && e.status, JSON.stringify((e && e.response && e.response.data) || (e && e.body) || '')].join(' ');
    if (/not found|404|does not exist|NotFound/i.test(raw)) return res.json({ ok: true, alreadyGone: true });
    res.status(502).json({ error: 'Could not disconnect — please refresh and try again.' });
  }
};

/* ── GET /api/google/status ───────────────────────────────────────────────────
   Health for the "central account connected" chip.
     driveOk = the service account (bulk read path) is configured.
     mailOk  = the central account has an ACTIVE Gmail connection (send path). */
const status = async (req, res, next) => {
  try {
    const configured = composio.isConfigured();
    const driveOk = !!(driveService && driveService.isConfigured && driveService.isConfigured());
    let mailOk = false; let centralEmail = null;
    if (configured) {
      try {
        const cs = await composio.listConnections('central');
        mailOk = cs.some((c) => String(c.slug || '').toLowerCase() === LOGIN_SLUG);
        if (mailOk) centralEmail = CENTRAL_EMAIL;
      } catch (_) { /* not connected */ }
    }
    res.json({
      configured,
      central: { connected: mailOk, email: centralEmail },
      driveOk,
      mailOk,
      serviceAccountEmail: (driveService && driveService.serviceAccountEmail) ? driveService.serviceAccountEmail() : null,
    });
  } catch (e) { next(e); }
};

module.exports = { listAccounts, connect, disconnect, status, resolveGoogleUserId, CENTRAL_EMAIL, LOGIN_SLUG };

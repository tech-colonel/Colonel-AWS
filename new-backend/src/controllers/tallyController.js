/**
 * tallyController.js — receives data from the Colonel Tally Connector and serves
 * it to the admin Tally page. Tables: src/db/tallyMigrate.js.
 *
 * Connector protocol (one sync of one company):
 *   POST /tally/connector/sync/start     → run_id, voucher watermark, reconcile?
 *   POST /tally/connector/sync/ledgers   → chunks of ledgers (full list every sync)
 *   POST /tally/connector/sync/vouchers  → chunks of vouchers with AlterID > watermark
 *   POST /tally/connector/sync/finish    → commit: advance watermark, drop stale rows
 *
 * The watermark lives HERE, not on the client PC, and only advances on a
 * successful finish. A sync that dies half-way (network drop, Tally closed) is
 * simply re-fetched from the old watermark next cycle — the upserts make that
 * repeat harmless — so the connector needs no offline queue.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { masterSequelize } = require('../config/database');
const { User } = require('../models/master');

const q = (sql, bind) => masterSequelize.query(sql, { bind, type: masterSequelize.QueryTypes.SELECT });
const exec = (sql, bind) => masterSequelize.query(sql, { bind });

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const MAX_CHUNK = 2000;
const RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;

const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

// ── value cleaners (the connector normalises too; never trust a client) ──────
const str = (v, max = 500) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, max));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const bigint = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; };
const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const bool = (v) => v === true || v === 'true' || v === 'Yes';

const dedupeByGuid = (rows) => {
  const m = new Map();
  for (const r of rows) if (r.guid) m.set(r.guid, r); // last one wins
  return [...m.values()];
};

// ═════════════════════════════════════════════════════════════════════════════
// Connector auth
// ═════════════════════════════════════════════════════════════════════════════

/* POST /tally/connector/login — email + password of an ADMIN; returns a
   long-lived connector token so the password is never stored on the Tally PC. */
const connectorLogin = async (req, res, next) => {
  try {
    const { email, password, machine_name, connector_version } = req.body || {};
    if (!email || !password) return bad(res, 'email and password are required');
    const user = await User.findOne({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.password))) return bad(res, 'Invalid credentials', 401);
    if (user.role !== 'admin') return bad(res, 'Only admin users can connect Tally', 403);

    const token = 'tcn_' + crypto.randomBytes(32).toString('hex');
    const [row] = await q(
      `INSERT INTO tally_connectors (user_id, token_hash, token_prefix, machine_name, connector_version, last_seen_at, last_ip)
       VALUES ($1, $2, $3, $4, $5, now(), $6) RETURNING id`,
      [user.id, hashToken(token), token.slice(0, 12), str(machine_name, 200), str(connector_version, 50), str(req.ip, 100)]
    );
    res.json({ token, connector_id: row.id, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) { next(e); }
};

/* Middleware for every /tally/connector/* call after login. */
const connectorAuth = async (req, res, next) => {
  try {
    const h = req.headers['authorization'] || '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token.startsWith('tcn_')) return bad(res, 'Connector token required', 401);
    const [c] = await q(
      `SELECT c.id, c.user_id FROM tally_connectors c
         JOIN users u ON u.id = c.user_id AND u.role = 'admin'
        WHERE c.token_hash = $1 AND c.revoked_at IS NULL`,
      [hashToken(token)]
    );
    if (!c) return bad(res, 'Connector token is invalid or revoked — log in again', 401);
    req.connector = c;
    next();
  } catch (e) { next(e); }
};

/* POST /tally/connector/heartbeat — called every cycle, even when Tally is down,
   so the admin page can say "connector online, Tally not reachable". */
const heartbeat = async (req, res, next) => {
  try {
    const { status, error, tally_host, tally_port, connector_version, machine_name } = req.body || {};
    await exec(
      `UPDATE tally_connectors SET last_seen_at = now(), last_ip = $2, last_status = $3, last_error = $4,
              tally_host = COALESCE($5, tally_host), tally_port = COALESCE($6, tally_port),
              connector_version = COALESCE($7, connector_version), machine_name = COALESCE($8, machine_name)
        WHERE id = $1`,
      [req.connector.id, str(req.ip, 100), str(status, 40), str(error, 2000), str(tally_host, 200),
        bigint(tally_port), str(connector_version, 50), str(machine_name, 200)]
    );
    const [u] = await q(`SELECT name, email FROM users WHERE id = $1`, [req.connector.user_id]);
    res.json({ ok: true, server_time: new Date().toISOString(), user: u || null });
  } catch (e) { next(e); }
};

// ═════════════════════════════════════════════════════════════════════════════
// Sync
// ═════════════════════════════════════════════════════════════════════════════

const loadRun = async (req, res) => {
  const runId = bigint(req.body && req.body.run_id);
  if (!runId) { bad(res, 'run_id is required'); return null; }
  const [run] = await q(
    `SELECT r.id, r.company_id, r.status FROM tally_sync_runs r WHERE r.id = $1 AND r.connector_id = $2`,
    [runId, req.connector.id]
  );
  if (!run) { bad(res, 'Unknown run_id', 404); return null; }
  if (run.status !== 'running') { bad(res, `Run ${runId} is already ${run.status}`, 409); return null; }
  return run;
};

/* POST /tally/connector/sync/start  { company: {guid, name, books_from, alt_vch_id, alt_mst_id, raw} } */
const syncStart = async (req, res, next) => {
  try {
    const c = (req.body && req.body.company) || {};
    const name = str(c.name, 300);
    if (!name) return bad(res, 'company.name is required');
    const key = str(c.guid, 200) || `name:${name}`;
    const altVch = bigint(c.alt_vch_id);
    const altMst = bigint(c.alt_mst_id);

    const [company] = await q(
      `INSERT INTO tally_companies (company_key, connector_id, name, books_from, raw)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (company_key) DO UPDATE SET connector_id = EXCLUDED.connector_id, name = EXCLUDED.name,
              books_from = COALESCE(EXCLUDED.books_from, tally_companies.books_from),
              raw = EXCLUDED.raw, updated_at = now()
       RETURNING id, last_voucher_alter_id, last_alt_vch_id, last_alt_mst_id, last_reconcile_at, last_sync_status`,
      [key, req.connector.id, name, date(c.books_from), JSON.stringify(c.raw || {})]
    );

    let watermark = Number(company.last_voucher_alter_id) || 0;
    // Tally's AlterID counter went BACKWARDS → the company was restored/rebuilt
    // on the PC. Our watermark is meaningless now: start over and reconcile.
    let reset = false;
    if (altVch !== null && watermark > altVch) { watermark = 0; reset = true; }

    const reconcile = reset || !company.last_reconcile_at ||
      (Date.now() - new Date(company.last_reconcile_at).getTime() > RECONCILE_EVERY_MS);

    // Nothing changed in Tally since the last good sync → tell the connector to skip.
    const unchanged = !reconcile && company.last_sync_status === 'ok' &&
      altVch !== null && altMst !== null &&
      Number(company.last_alt_vch_id) === altVch && Number(company.last_alt_mst_id) === altMst;

    if (unchanged) {
      await exec(`UPDATE tally_companies SET last_sync_at = now() WHERE id = $1`, [company.id]);
      return res.json({ company_id: company.id, unchanged: true });
    }

    // A previous run of this company that never finished is abandoned, not resumed.
    await exec(
      `UPDATE tally_sync_runs SET status = 'error', finished_at = now(), error = 'Abandoned — superseded by a newer run'
        WHERE company_id = $1 AND status = 'running'`,
      [company.id]
    );
    const [run] = await q(
      `INSERT INTO tally_sync_runs (company_id, connector_id, status, counts)
       VALUES ($1, $2, 'running', $3::jsonb) RETURNING id`,
      [company.id, req.connector.id, JSON.stringify({ ledgers: 0, vouchers: 0, from_alter_id: watermark, alt_vch_id: altVch, alt_mst_id: altMst })]
    );
    res.json({ company_id: company.id, run_id: run.id, last_voucher_alter_id: watermark, reconcile, unchanged: false });
  } catch (e) { next(e); }
};

/* POST /tally/connector/sync/ledgers  { run_id, ledgers: [...] } */
const syncLedgers = async (req, res, next) => {
  try {
    const run = await loadRun(req, res); if (!run) return;
    const input = Array.isArray(req.body.ledgers) ? req.body.ledgers : [];
    if (input.length > MAX_CHUNK) return bad(res, `At most ${MAX_CHUNK} ledgers per request`);
    const rows = dedupeByGuid(input.map((l) => ({
      guid: str(l.guid, 200), name: str(l.name, 500), parent: str(l.parent, 500),
      opening_balance: num(l.opening_balance), closing_balance: num(l.closing_balance),
      gstin: str(l.gstin, 20), alter_id: bigint(l.alter_id),
    })));
    if (rows.length) {
      await exec(
        `INSERT INTO tally_ledgers (company_id, guid, name, parent, opening_balance, closing_balance, gstin, alter_id, sync_run_id, synced_at)
         SELECT $1, x.guid, x.name, x.parent, x.opening_balance, x.closing_balance, x.gstin, x.alter_id, $3, now()
           FROM jsonb_to_recordset($2::jsonb) AS x(guid text, name text, parent text, opening_balance numeric,
                closing_balance numeric, gstin text, alter_id bigint)
         ON CONFLICT (company_id, guid) DO UPDATE SET name = EXCLUDED.name, parent = EXCLUDED.parent,
                opening_balance = EXCLUDED.opening_balance, closing_balance = EXCLUDED.closing_balance,
                gstin = EXCLUDED.gstin, alter_id = EXCLUDED.alter_id, sync_run_id = EXCLUDED.sync_run_id, synced_at = now()`,
        [run.company_id, JSON.stringify(rows), run.id]
      );
    }
    await exec(
      `UPDATE tally_sync_runs SET counts = jsonb_set(counts, '{ledgers}', to_jsonb(COALESCE((counts->>'ledgers')::int, 0) + $2)) WHERE id = $1`,
      [run.id, rows.length]
    );
    res.json({ ok: true, received: rows.length });
  } catch (e) { next(e); }
};

/* POST /tally/connector/sync/vouchers  { run_id, vouchers: [...] } */
const syncVouchers = async (req, res, next) => {
  try {
    const run = await loadRun(req, res); if (!run) return;
    const input = Array.isArray(req.body.vouchers) ? req.body.vouchers : [];
    if (input.length > MAX_CHUNK) return bad(res, `At most ${MAX_CHUNK} vouchers per request`);
    const rows = dedupeByGuid(input.map((v) => ({
      guid: str(v.guid, 200), voucher_date: date(v.date), voucher_type: str(v.voucher_type, 200),
      voucher_number: str(v.voucher_number, 200), party_name: str(v.party_name, 500), amount: num(v.amount),
      narration: str(v.narration, 4000), is_cancelled: bool(v.is_cancelled), is_optional: bool(v.is_optional),
      alter_id: bigint(v.alter_id),
      ledger_entries: Array.isArray(v.ledger_entries)
        ? v.ledger_entries.slice(0, 500).map((e) => ({ ledger: str(e.ledger, 500), amount: num(e.amount) }))
        : [],
    })));
    if (rows.length) {
      await exec(
        `INSERT INTO tally_vouchers (company_id, guid, voucher_date, voucher_type, voucher_number, party_name, amount,
                                     narration, is_cancelled, is_optional, alter_id, ledger_entries, synced_at)
         SELECT $1, x.guid, x.voucher_date, x.voucher_type, x.voucher_number, x.party_name, x.amount,
                x.narration, x.is_cancelled, x.is_optional, x.alter_id, x.ledger_entries, now()
           FROM jsonb_to_recordset($2::jsonb) AS x(guid text, voucher_date date, voucher_type text, voucher_number text,
                party_name text, amount numeric, narration text, is_cancelled boolean, is_optional boolean,
                alter_id bigint, ledger_entries jsonb)
         ON CONFLICT (company_id, guid) DO UPDATE SET voucher_date = EXCLUDED.voucher_date,
                voucher_type = EXCLUDED.voucher_type, voucher_number = EXCLUDED.voucher_number,
                party_name = EXCLUDED.party_name, amount = EXCLUDED.amount, narration = EXCLUDED.narration,
                is_cancelled = EXCLUDED.is_cancelled, is_optional = EXCLUDED.is_optional,
                alter_id = EXCLUDED.alter_id, ledger_entries = EXCLUDED.ledger_entries, synced_at = now()`,
        [run.company_id, JSON.stringify(rows)]
      );
    }
    await exec(
      `UPDATE tally_sync_runs SET counts = jsonb_set(counts, '{vouchers}', to_jsonb(COALESCE((counts->>'vouchers')::int, 0) + $2)) WHERE id = $1`,
      [run.id, rows.length]
    );
    res.json({ ok: true, received: rows.length });
  } catch (e) { next(e); }
};

/* POST /tally/connector/sync/finish
     { run_id, status: 'ok'|'error', error?, max_voucher_alter_id?, ledgers_complete?, voucher_guids? } */
const syncFinish = async (req, res, next) => {
  try {
    const run = await loadRun(req, res); if (!run) return;
    const { status, error, ledgers_complete, voucher_guids } = req.body;

    if (status !== 'ok') {
      const msg = str(error, 4000) || 'Connector reported an error';
      await exec(`UPDATE tally_sync_runs SET status = 'error', finished_at = now(), error = $2 WHERE id = $1`, [run.id, msg]);
      await exec(`UPDATE tally_companies SET last_sync_at = now(), last_sync_status = 'error', last_error = $2, updated_at = now() WHERE id = $1`, [run.company_id, msg]);
      return res.json({ ok: true, status: 'error' });
    }

    const [runRow] = await q(`SELECT counts FROM tally_sync_runs WHERE id = $1`, [run.id]);
    const counts = runRow.counts || {};
    const maxAlter = bigint(req.body.max_voucher_alter_id);
    let removedLedgers = 0; let removedVouchers = 0;

    await masterSequelize.transaction(async (t) => {
      // Ledgers are sent in full every run, so anything not touched by this run
      // was deleted in Tally. Only trust that when the connector says the list
      // was complete — a partial list must never wipe the rest.
      if (ledgers_complete === true) {
        const [, r] = await masterSequelize.query(
          `DELETE FROM tally_ledgers WHERE company_id = $1 AND sync_run_id IS DISTINCT FROM $2`,
          { bind: [run.company_id, run.id], transaction: t }
        );
        removedLedgers = (r && r.rowCount) || 0;
      }
      // Reconcile: the full list of voucher GUIDs still present in Tally.
      if (Array.isArray(voucher_guids)) {
        const [, r] = await masterSequelize.query(
          `DELETE FROM tally_vouchers WHERE company_id = $1 AND NOT (guid = ANY($2::text[]))`,
          { bind: [run.company_id, voucher_guids.map((g) => String(g))], transaction: t }
        );
        removedVouchers = (r && r.rowCount) || 0;
      }
      await masterSequelize.query(
        `UPDATE tally_companies SET
            last_voucher_alter_id = CASE WHEN $2::bigint IS NOT NULL THEN $2::bigint
                                         ELSE last_voucher_alter_id END,
            last_alt_vch_id = $3, last_alt_mst_id = $4,
            last_reconcile_at = CASE WHEN $5 THEN now() ELSE last_reconcile_at END,
            last_sync_at = now(), last_sync_status = 'ok', last_error = NULL, updated_at = now()
          WHERE id = $1`,
        { bind: [run.company_id, maxAlter, bigint(counts.alt_vch_id), bigint(counts.alt_mst_id), Array.isArray(voucher_guids)], transaction: t }
      );
      await masterSequelize.query(
        `UPDATE tally_sync_runs SET status = 'ok', finished_at = now(),
                counts = counts || $2::jsonb WHERE id = $1`,
        { bind: [run.id, JSON.stringify({ removed_ledgers: removedLedgers, removed_vouchers: removedVouchers, to_alter_id: maxAlter })], transaction: t }
      );
    });
    res.json({ ok: true, status: 'ok', removed_ledgers: removedLedgers, removed_vouchers: removedVouchers });
  } catch (e) { next(e); }
};

// ═════════════════════════════════════════════════════════════════════════════
// Admin read side
// ═════════════════════════════════════════════════════════════════════════════

/* GET /tally/overview — connectors + companies with row counts */
const getOverview = async (req, res, next) => {
  try {
    const connectors = await q(
      `SELECT c.id, c.machine_name, c.connector_version, c.tally_host, c.tally_port, c.last_status, c.last_error,
              c.last_seen_at, c.created_at, c.token_prefix, u.name AS user_name, u.email AS user_email
         FROM tally_connectors c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.revoked_at IS NULL ORDER BY c.last_seen_at DESC NULLS LAST`
    );
    const companies = await q(
      `SELECT co.id, co.name, co.books_from, co.brand_id, co.connector_id, co.last_sync_at, co.last_sync_status,
              co.last_error, co.last_voucher_alter_id, co.created_at,
              (SELECT count(*)::int FROM tally_ledgers l WHERE l.company_id = co.id) AS ledger_count,
              (SELECT count(*)::int FROM tally_vouchers v WHERE v.company_id = co.id) AS voucher_count
         FROM tally_companies co ORDER BY co.name`
    );
    res.json({ connectors, companies });
  } catch (e) { next(e); }
};

const page = (req) => ({
  limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500),
  offset: Math.max(parseInt(req.query.offset, 10) || 0, 0),
  search: (req.query.search || '').trim(),
});

/* GET /tally/companies/:id/ledgers?search=&limit=&offset= */
const getLedgers = async (req, res, next) => {
  try {
    const { limit, offset, search } = page(req);
    const where = `company_id = $1 AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR parent ILIKE '%' || $2 || '%' OR gstin ILIKE '%' || $2 || '%')`;
    const rows = await q(
      `SELECT id, guid, name, parent, opening_balance, closing_balance, gstin, synced_at
         FROM tally_ledgers WHERE ${where} ORDER BY name LIMIT $3 OFFSET $4`,
      [req.params.id, search, limit, offset]
    );
    const [{ total }] = await q(`SELECT count(*)::int AS total FROM tally_ledgers WHERE ${where}`, [req.params.id, search]);
    res.json({ rows, total, limit, offset });
  } catch (e) { next(e); }
};

/* GET /tally/companies/:id/vouchers?search=&type=&from=&to=&limit=&offset= */
const getVouchers = async (req, res, next) => {
  try {
    const { limit, offset, search } = page(req);
    const type = (req.query.type || '').trim();
    const from = date(req.query.from); const to = date(req.query.to);
    const where = `company_id = $1
      AND ($2 = '' OR party_name ILIKE '%' || $2 || '%' OR voucher_number ILIKE '%' || $2 || '%' OR narration ILIKE '%' || $2 || '%')
      AND ($3 = '' OR voucher_type = $3)
      AND ($4::date IS NULL OR voucher_date >= $4::date)
      AND ($5::date IS NULL OR voucher_date <= $5::date)`;
    const bind = [req.params.id, search, type, from, to];
    const rows = await q(
      `SELECT id, guid, voucher_date, voucher_type, voucher_number, party_name, amount, narration,
              is_cancelled, is_optional, ledger_entries
         FROM tally_vouchers WHERE ${where}
        ORDER BY voucher_date DESC NULLS LAST, alter_id DESC LIMIT $6 OFFSET $7`,
      [...bind, limit, offset]
    );
    const [{ total }] = await q(`SELECT count(*)::int AS total FROM tally_vouchers WHERE ${where}`, bind);
    const types = await q(
      `SELECT voucher_type, count(*)::int AS count FROM tally_vouchers WHERE company_id = $1
        GROUP BY voucher_type ORDER BY count DESC`,
      [req.params.id]
    );
    res.json({ rows, total, limit, offset, types });
  } catch (e) { next(e); }
};

/* GET /tally/companies/:id/runs */
const getRuns = async (req, res, next) => {
  try {
    const rows = await q(
      `SELECT id, started_at, finished_at, status, counts, error FROM tally_sync_runs
        WHERE company_id = $1 ORDER BY started_at DESC LIMIT 30`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { next(e); }
};

/* DELETE /tally/connectors/:id — revoke; the connector must log in again */
const revokeConnector = async (req, res, next) => {
  try {
    const [, r] = await exec(`UPDATE tally_connectors SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [req.params.id]);
    if (!r || !r.rowCount) return bad(res, 'Connector not found', 404);
    res.json({ ok: true });
  } catch (e) { next(e); }
};

module.exports = {
  connectorLogin, connectorAuth, heartbeat,
  syncStart, syncLedgers, syncVouchers, syncFinish,
  getOverview, getLedgers, getVouchers, getRuns, revokeConnector,
};

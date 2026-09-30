/**
 * sync.js — one sync cycle: check Tally, heartbeat, then for each selected company
 *   1. start     → server returns the voucher watermark (last synced AlterID)
 *   2. ledgers   → all ledgers, in chunks (full replace)
 *   3. vouchers  → only AlterID > watermark, fetched in AlterID windows, in chunks
 *   4. reconcile → once a day, all voucher GUIDs so deletions in Tally are removed
 *   5. finish    → server advances the watermark (only now — so a failed run is
 *                  simply redone next cycle)
 */

const log = require('./logger');
const { TallyClient } = require('./tally');
const { CloudClient, CloudError } = require('./cloud');
const { version } = require('../package.json');

const UPLOAD_CHUNK = 500;
const ALTER_WINDOW = 5000;   // vouchers per Tally request, by AlterID range

const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/** Full span of dates to ask Tally for: books start → end of next financial year. */
function period(company) {
  const now = new Date();
  const fyEndYear = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
  return { from: company.books_from || '2000-04-01', to: `${fyEndYear + 1}-03-31` };
}

async function syncCompany(tally, cloud, company) {
  const t0 = Date.now();
  log.info(`[${company.name}] ── sync start (Tally AltVchID=${company.alt_vch_id ?? '?'}, AltMstID=${company.alt_mst_id ?? '?'})`);
  const start = await cloud.start({
    guid: company.guid, name: company.name, books_from: company.books_from,
    alt_vch_id: company.alt_vch_id, alt_mst_id: company.alt_mst_id, raw: company,
  });
  if (start.unchanged) {
    log.info(`[${company.name}] nothing changed in Tally since the last sync — skipped`);
    return { skipped: true };
  }
  const runId = start.run_id;
  const watermark = Number(start.last_voucher_alter_id) || 0;
  const range = period(company);
  log.info(`[${company.name}] run #${runId}: vouchers after AlterID ${watermark}${start.reconcile ? ', with daily reconcile' : ''}; period ${range.from} → ${range.to}`);

  try {
    // ── 2. ledgers ────────────────────────────────────────────────────────
    const ledgers = await tally.ledgers(company.name, range);
    log.info(`[${company.name}] fetched ${ledgers.length} ledgers from Tally`);
    for (const [i, part] of chunks(ledgers, UPLOAD_CHUNK).entries()) {
      await cloud.ledgers(runId, part);
      log.debug(`[${company.name}] uploaded ledger chunk ${i + 1} (${part.length})`);
    }

    // ── 3. vouchers ───────────────────────────────────────────────────────
    let total = 0; let maxSeen = null;
    const top = company.alt_vch_id;
    const windows = [];
    if (top !== null && top !== undefined) {
      for (let lo = watermark; lo < top; lo += ALTER_WINDOW) windows.push([lo, Math.min(lo + ALTER_WINDOW, top)]);
    } else {
      windows.push([watermark, null]); // Tally didn't report AltVchID: one open-ended request
    }
    for (const [lo, hi] of windows) {
      const vouchers = await tally.vouchers(company.name, { ...range, minAlter: lo, maxAlter: hi });
      log.info(`[${company.name}] fetched ${vouchers.length} vouchers with AlterID ${lo + 1}…${hi ?? '∞'}`);
      for (const part of chunks(vouchers, UPLOAD_CHUNK)) await cloud.vouchers(runId, part);
      for (const v of vouchers) if (v.alter_id !== null && (maxSeen === null || v.alter_id > maxSeen)) maxSeen = v.alter_id;
      total += vouchers.length;
    }
    // With a known AltVchID everything up to it has been read, even if the
    // window had no vouchers in it (AlterIDs are shared with masters).
    const newWatermark = top !== null && top !== undefined ? Math.max(top, watermark) : (maxSeen ?? null);

    // ── 4. reconcile deletions ────────────────────────────────────────────
    let voucherGuids;
    if (start.reconcile) {
      const guids = await tally.voucherGuids(company.name, range);
      if (guids.length) {
        voucherGuids = guids;
        log.info(`[${company.name}] reconcile: ${guids.length} vouchers exist in Tally`);
      } else {
        // An empty answer is far more likely a Tally hiccup than "every voucher
        // deleted" — never let it wipe the server copy.
        log.warn(`[${company.name}] reconcile skipped: Tally returned no voucher GUIDs`);
      }
    }

    // ── 5. finish ─────────────────────────────────────────────────────────
    const fin = await cloud.finish(runId, {
      status: 'ok', max_voucher_alter_id: newWatermark,
      ledgers_complete: ledgers.length > 0, voucher_guids: voucherGuids,
    });
    log.info(`[${company.name}] ── sync OK in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${ledgers.length} ledgers, ${total} new/changed vouchers`
      + `${fin.removed_ledgers ? `, ${fin.removed_ledgers} ledgers removed` : ''}${fin.removed_vouchers ? `, ${fin.removed_vouchers} vouchers removed` : ''}`
      + `; watermark → ${newWatermark ?? watermark}`);
    return { ledgers: ledgers.length, vouchers: total };
  } catch (e) {
    log.error(`[${company.name}] sync failed: ${e.message}`);
    try { await cloud.finish(runId, { status: 'error', error: e.message }); } catch (_) { /* server unreachable too */ }
    throw e;
  }
}

/**
 * One full cycle. Returns
 *   { ok, fatal, status: { cloud:{ok,detail}, tally:{ok,detail}, companies:[{name,ok,detail}] } }
 * `status` is what the app window shows; `fatal` means the connector token is no
 * longer valid and the caller should stop and ask the user to log in again.
 */
async function runCycle(cfg, { debug = false } = {}) {
  const tally = new TallyClient({ host: cfg.tally_host, port: cfg.tally_port, dumpRaw: debug });
  const cloud = new CloudClient({ serverUrl: cfg.server_url, token: cfg.token });
  const beat = { tally_host: cfg.tally_host, tally_port: cfg.tally_port, connector_version: version, machine_name: cfg.machine_name };
  const status = { cloud: { ok: false, detail: '' }, tally: { ok: false, detail: '' }, companies: [] };
  const done = (extra) => ({ ...extra, status });

  log.info(`══ cycle start — Tally ${cfg.tally_host}:${cfg.tally_port} → ${cfg.server_url}`);
  let open;
  try {
    open = await tally.listCompanies();
    status.tally = { ok: true, detail: `${open.length} compan${open.length === 1 ? 'y' : 'ies'} open` };
  } catch (e) {
    log.error(e.message);
    status.tally = { ok: false, detail: e.message };
    const hb = await heartbeatSafe(cloud, { ...beat, status: 'tally_unreachable', error: e.message }, status);
    return done(hb.fatal ? { fatal: true } : { ok: false });
  }
  log.info(`Tally has ${open.length} open compan${open.length === 1 ? 'y' : 'ies'}: ${open.map((c) => c.name).join(', ') || '(none)'}`);

  const wanted = cfg.companies && cfg.companies.length ? cfg.companies : null;
  const selected = wanted ? open.filter((c) => wanted.includes(c.name)) : open;
  const notOpen = wanted ? wanted.filter((n) => !open.some((c) => c.name === n)) : [];
  for (const n of notOpen) {
    log.warn(`"${n}" is selected but not open in Tally — open it in Tally to sync it`);
    status.companies.push({ name: n, ok: false, detail: 'not open in Tally' });
  }

  const hb = await heartbeatSafe(cloud, {
    ...beat,
    status: selected.length ? 'ok' : 'no_company',
    error: notOpen.length ? `Not open in Tally: ${notOpen.join(', ')}` : (selected.length ? null : 'No company is open in Tally'),
  }, status);
  if (hb.fatal) return done({ fatal: true });
  if (!hb.ok) return done({ ok: false }); // agent.accountant unreachable — try again next cycle

  let failed = 0;
  for (const company of selected) {
    try {
      const r = await syncCompany(tally, cloud, company);
      status.companies.push({
        name: company.name, ok: true,
        detail: r.skipped ? 'up to date (no changes in Tally)' : `synced ${r.ledgers} ledgers, ${r.vouchers} new/changed vouchers`,
      });
    } catch (e) {
      failed++;
      status.companies.push({ name: company.name, ok: false, detail: e.message });
      if (e instanceof CloudError && e.status === 401) { fatal(e, status); return done({ fatal: true }); }
    }
  }
  log.info(`══ cycle done — ${selected.length - failed}/${selected.length} compan${selected.length === 1 ? 'y' : 'ies'} synced`);
  if (failed) await heartbeatSafe(cloud, { ...beat, status: 'error', error: `${failed} company sync(s) failed — see connector log` }, status);
  return done({ ok: failed === 0 && notOpen.length === 0 });
}

async function heartbeatSafe(cloud, body, status) {
  try {
    const r = await cloud.heartbeat(body);
    const who = r.user ? (r.user.name ? `${r.user.name} <${r.user.email}>` : r.user.email) : 'connector';
    status.cloud = { ok: true, detail: `logged in as ${who}` };
    return { ok: true };
  } catch (e) {
    if (e instanceof CloudError && e.status === 401) { fatal(e, status); return { fatal: true }; }
    log.warn(`heartbeat failed: ${e.message}`);
    status.cloud = { ok: false, detail: e.message };
    return { ok: false };
  }
}

function fatal(e, status) {
  log.error(`agent.accountant rejected the connector (${e.message}). Run "setup" to log in again.`);
  status.cloud = { ok: false, detail: 'login expired or revoked — run setup to log in again' };
}

module.exports = { runCycle, syncCompany, period };

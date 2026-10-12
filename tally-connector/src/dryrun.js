/**
 * dryrun.js — read everything a sync would read from Tally, check it, and save a
 * report — WITHOUT sending anything to agent.accountant. Used to verify the
 * Tally side on a real client PC before (or without) the cloud being involved.
 *
 * Output: console summary with PASS / WARN / FAIL checks, plus
 *         <home>/logs/dry-run-<timestamp>.json (counts, checks, sample rows).
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { TallyClient } = require('./tally');
const { period } = require('./sync');
const { version } = require('../package.json');

const ALTER_WINDOW = 5000;

async function timed(fn) {
  const t = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t };
}

async function dryRunCompany(tally, company) {
  const checks = [];
  const check = (level, name, detail) => { checks.push({ level, name, detail }); };
  const range = period(company);
  const timings = {};

  check(company.guid ? 'PASS' : 'WARN', 'Company GUID reported',
    company.guid || 'missing — the company will be keyed by its name instead');
  check(company.alt_vch_id !== null ? 'PASS' : 'WARN', 'AltVchID reported (enables fast incremental sync)',
    company.alt_vch_id !== null ? `AltVchID=${company.alt_vch_id}, AltMstID=${company.alt_mst_id}` : 'missing — every sync will do one open-ended voucher request');

  // ── ledgers ────────────────────────────────────────────────────────────
  const L = await timed(() => tally.ledgers(company.name, range));
  const ledgers = L.value; timings.ledgers_ms = L.ms;
  check(ledgers.length ? 'PASS' : 'FAIL', 'Ledgers fetched', `${ledgers.length} ledgers in ${L.ms}ms`);
  const withClosing = ledgers.filter((l) => l.closing_balance !== null).length;
  check(ledgers.length && withClosing === 0 ? 'WARN' : 'PASS', 'Ledger closing balances parsed',
    `${withClosing}/${ledgers.length} ledgers have a closing balance`);
  const withGstin = ledgers.filter((l) => l.gstin).length;
  check('INFO', 'Ledgers with GSTIN', `${withGstin}`);
  const groups = {};
  for (const l of ledgers) groups[l.parent || '(none)'] = (groups[l.parent || '(none)'] || 0) + 1;

  // ── vouchers (same AlterID windows a real sync uses) ───────────────────
  const vouchers = [];
  const t0 = Date.now();
  const top = company.alt_vch_id;
  if (top !== null && top !== undefined) {
    for (let lo = 0; lo < top; lo += ALTER_WINDOW) {
      const hi = Math.min(lo + ALTER_WINDOW, top);
      vouchers.push(...await tally.vouchers(company.name, { ...range, minAlter: lo, maxAlter: hi }));
      log.info(`[${company.name}] dry-run: vouchers AlterID ${lo + 1}…${hi} → running total ${vouchers.length}`);
    }
  } else {
    vouchers.push(...await tally.vouchers(company.name, { ...range, minAlter: 0 }));
  }
  timings.vouchers_ms = Date.now() - t0;
  check(vouchers.length ? 'PASS' : 'WARN', 'Vouchers fetched', `${vouchers.length} vouchers in ${timings.vouchers_ms}ms`);

  const G = await timed(() => tally.voucherGuids(company.name, range));
  timings.voucher_guids_ms = G.ms;
  check(G.value.length === vouchers.length ? 'PASS' : 'WARN', 'Voucher count matches GUID list (deletion check)',
    `${vouchers.length} vouchers vs ${G.value.length} GUIDs`);

  const noDate = vouchers.filter((v) => !v.date);
  const noLines = vouchers.filter((v) => !v.ledger_entries.length);
  const noAmount = vouchers.filter((v) => !v.amount);
  const noAlter = vouchers.filter((v) => v.alter_id === null);
  const sample = (arr) => arr.slice(0, 5).map((v) => `${v.voucher_type || '?'} #${v.voucher_number || '?'} ${v.date || ''} (${v.guid})`);
  check(noDate.length ? 'WARN' : 'PASS', 'Every voucher has a date', noDate.length ? `${noDate.length} without: ${sample(noDate).join('; ')}` : 'ok');
  check(noLines.length ? 'WARN' : 'PASS', 'Every voucher has ledger lines', noLines.length ? `${noLines.length} without: ${sample(noLines).join('; ')}` : 'ok');
  check(noAmount.length ? 'WARN' : 'PASS', 'Every voucher has a non-zero amount', noAmount.length ? `${noAmount.length} with 0/blank: ${sample(noAmount).join('; ')}` : 'ok');
  check(vouchers.length && noAlter.length === vouchers.length ? 'FAIL' : noAlter.length ? 'WARN' : 'PASS',
    'Vouchers carry AlterID (needed for incremental sync)', `${vouchers.length - noAlter.length}/${vouchers.length} have one`);

  // ── does Tally honour the $AlterID filter? (incremental sync depends on it)
  const maxAlter = vouchers.reduce((m, v) => (v.alter_id !== null && v.alter_id > m ? v.alter_id : m), 0);
  if (maxAlter > 0) {
    const threshold = Math.max(0, maxAlter - 1);
    const inc = await tally.vouchers(company.name, { ...range, minAlter: threshold });
    const ok = inc.length >= 1 && inc.length < Math.max(2, vouchers.length) && inc.every((v) => v.alter_id > threshold);
    check(ok ? 'PASS' : 'FAIL', 'Incremental filter ($AlterID > N) works',
      `asked for AlterID > ${threshold}, got ${inc.length} voucher(s)${inc.length ? ` with AlterIDs ${inc.slice(0, 5).map((v) => v.alter_id).join(', ')}` : ''}`);
  }

  // ── summary numbers the tester can compare with Tally's own reports ────
  const byType = {};
  for (const v of vouchers) {
    const t = v.voucher_type || '(none)';
    byType[t] = byType[t] || { count: 0, amount: 0, cancelled: 0 };
    byType[t].count++; byType[t].amount += v.amount || 0; if (v.is_cancelled) byType[t].cancelled++;
  }
  for (const t of Object.values(byType)) t.amount = Math.round(t.amount * 100) / 100;
  const dates = vouchers.map((v) => v.date).filter(Boolean).sort();

  return {
    company: { name: company.name, guid: company.guid, books_from: company.books_from, alt_vch_id: company.alt_vch_id, alt_mst_id: company.alt_mst_id },
    period: range,
    timings,
    counts: { ledgers: ledgers.length, vouchers: vouchers.length, voucher_guids: G.value.length },
    voucher_date_range: dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null,
    vouchers_by_type: byType,
    ledger_groups: groups,
    checks,
    samples: {
      ledgers: ledgers.slice(0, 5),
      vouchers: vouchers.slice(0, 3).concat(vouchers.slice(-2)),
      vouchers_without_lines: noLines.slice(0, 3),
    },
  };
}

async function dryRun(cfg, { debug = false, company: onlyCompany } = {}) {
  const tally = new TallyClient({ host: cfg.tally_host, port: cfg.tally_port, dumpRaw: debug });
  log.info(`Colonel Tally Connector v${version} — DRY RUN (nothing is sent to agent.accountant)`);
  log.info(`Tally at ${cfg.tally_host}:${cfg.tally_port}`);
  const report = { connector_version: version, at: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`, tally: `${cfg.tally_host}:${cfg.tally_port}`, companies: [] };

  let open;
  try { open = await tally.listCompanies(); }
  catch (e) {
    log.error(`FAIL  Tally reachable — ${e.message}`);
    report.error = e.message;
    return { ok: false, file: save(report) };
  }
  log.info(`PASS  Tally reachable — ${open.length} open: ${open.map((c) => c.name).join(', ') || '(none)'}`);
  const targets = onlyCompany ? open.filter((c) => c.name === onlyCompany) : open;
  if (!targets.length) {
    log.error(`FAIL  ${onlyCompany ? `"${onlyCompany}" is not open in Tally` : 'No company is open in Tally'}`);
    report.error = 'no company to test';
    return { ok: false, file: save(report) };
  }

  let ok = true;
  for (const c of targets) {
    log.info(`── ${c.name}`);
    try {
      const r = await dryRunCompany(tally, c);
      report.companies.push(r);
      for (const ch of r.checks) (ch.level === 'FAIL' ? log.error : ch.level === 'WARN' ? log.warn : log.info)(`${ch.level.padEnd(5)} ${ch.name} — ${ch.detail}`);
      log.info(`      Vouchers by type: ${Object.entries(r.vouchers_by_type).map(([t, x]) => `${t} ${x.count}`).join(', ') || '(none)'}`);
      if (r.checks.some((ch) => ch.level === 'FAIL')) ok = false;
    } catch (e) {
      ok = false;
      log.error(`FAIL  ${c.name}: ${e.message}`);
      report.companies.push({ company: { name: c.name }, error: e.message, stack: e.stack });
    }
  }
  const file = save(report);
  log.info(`Report saved: ${file}`);
  return { ok, file };
}

function save(report) {
  const { home } = require('./config');
  const dir = path.join(home(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  const file = path.join(dir, `dry-run-${local}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

module.exports = { dryRun };

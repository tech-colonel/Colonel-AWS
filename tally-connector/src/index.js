#!/usr/bin/env node
/**
 * Colonel Tally Connector — keeps agent.accountant in sync with Tally.
 *
 *   colonel-tally-connector            first run: setup, then keep syncing
 *   colonel-tally-connector setup      log in, set Tally host/port, pick companies
 *   colonel-tally-connector run        sync now and every N minutes (default 15)
 *   colonel-tally-connector once       a single sync, then exit
 *   colonel-tally-connector test       check the Tally AND agent.accountant connections
 *   colonel-tally-connector dry-run    read everything from Tally, run checks, save a report — sends nothing
 *   colonel-tally-connector status     show the saved settings
 *   colonel-tally-connector logout     forget the login on this PC
 *
 * Flags: --debug (verbose console + save raw Tally XML in logs/raw), --host X, --port N,
 *        --company "Name" (dry-run: only this company)
 */

// ── crash guard: installed BEFORE anything else loads ───────────────────────
// A double-clicked .exe closes its window the moment it exits, so a startup
// failure would be invisible. Instead: write ColonelTallyConnector-crash.log next
// to the exe (and in %TEMP%), print it, and wait for a key before closing.
const fs = require('fs');
const os = require('os');
const path = require('path');

function pauseBeforeExit() {
  if (!process.stdin.isTTY) return;
  try {
    if (process.platform === 'win32') require('child_process').spawnSync('cmd.exe', ['/c', 'pause'], { stdio: 'inherit' });
  } catch (_) { /* nothing more we can do */ }
}

function crashOut(e) {
  const msg = `${new Date().toISOString()} Colonel Tally Connector crashed on ${process.platform} ${process.arch} (node ${process.version})\n${(e && e.stack) || e}\n\n`;
  const dirs = [os.tmpdir()];
  if (process.pkg) dirs.unshift(path.dirname(process.execPath)); // packaged .exe → its own folder
  const written = [];
  for (const d of dirs) {
    try { fs.appendFileSync(path.join(d, 'ColonelTallyConnector-crash.log'), msg); written.push(path.join(d, 'ColonelTallyConnector-crash.log')); } catch (_) { /* read-only folder */ }
  }
  console.error(`\n${msg}Crash details saved to:\n  ${written.join('\n  ') || '(could not write a crash file)'}\n`);
  pauseBeforeExit();
  process.exit(1);
}
process.on('uncaughtException', crashOut);
process.on('unhandledRejection', crashOut);

console.log('Colonel Tally Connector starting…');

const readline = require('readline');
const config = require('./config');
const log = require('./logger');
const { TallyClient } = require('./tally');
const { CloudClient } = require('./cloud');
const { runCycle } = require('./sync');
const { dryRun } = require('./dryrun');
const { version } = require('../package.json');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const VALUE_FLAGS = ['--host', '--port', '--company'];
const command = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1])) || 'default';

// ── connection status, shown in the window after every sync ─────────────────
const setTitle = (t) => { try { process.title = t; } catch (_) { /* not supported */ } };

function showStatus(cfg, status, nextAt) {
  const mark = (ok) => (ok ? '[OK]   CONNECTED    ' : '[FAIL] NOT CONNECTED');
  const cloudLabel = 'agent.accountant';
  const tallyLabel = `Tally ${cfg.tally_host}:${cfg.tally_port}`;
  const w = Math.max(cloudLabel.length, tallyLabel.length);
  const lines = [
    `${cloudLabel.padEnd(w)}  ${mark(status.cloud.ok)}  ${status.cloud.detail || ''}`,
    `${tallyLabel.padEnd(w)}  ${mark(status.tally.ok)}  ${status.tally.detail || ''}`,
    ...status.companies.map((c) => `  ${c.ok ? '[OK]  ' : '[FAIL]'} ${c.name} - ${c.detail}`),
    `Last check ${new Date().toLocaleTimeString()}${nextAt ? ` - next sync ${nextAt.toLocaleTimeString()}` : ''}`,
  ];
  const width = Math.min(110, Math.max(...lines.map((l) => l.length)) + 2);
  const bar = '─'.repeat(width);
  console.log(`\n┌${bar}┐`);
  for (const l of lines) console.log(`│ ${l.length > width - 2 ? l.slice(0, width - 5) + '...' : l.padEnd(width - 2)} │`);
  console.log(`└${bar}┘\n`);
  const all = status.cloud.ok && status.tally.ok && status.companies.every((c) => c.ok);
  setTitle(`Colonel Tally Connector - ${all ? 'Connected' : !status.cloud.ok ? 'agent.accountant NOT connected' : !status.tally.ok ? 'Tally NOT connected' : 'Sync problem'}`);
}

// ── prompts ──────────────────────────────────────────────────────────────────
function ask(question, { hidden = false, def } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const q = def !== undefined && def !== '' ? `${question} [${def}]: ` : `${question}: `;
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else if (!/[\r\n]/.test(s)) rl.output.write('*'); };
    }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim() || (def !== undefined ? String(def) : '')); });
  });
}

// ── commands ─────────────────────────────────────────────────────────────────
async function setup() {
  const cfg = config.load();
  console.log(`\nColonel Tally Connector v${version} — setup\n`);

  // 1. Log in to agent.accountant
  cfg.server_url = (await ask('agent.accountant URL', { def: cfg.server_url })).replace(/\/+$/, '');
  for (;;) {
    const email = await ask('Email', { def: cfg.user_email || undefined });
    const password = await ask('Password', { hidden: true });
    try {
      const r = await new CloudClient({ serverUrl: cfg.server_url }).login(email, password, {
        machine_name: cfg.machine_name, connector_version: version,
      });
      Object.assign(cfg, { token: r.token, connector_id: r.connector_id, user_email: email });
      console.log(`[OK] Logged in as ${r.user.name || email}\n`);
      break;
    } catch (e) { console.log(`[FAIL] ${e.message}\n`); }
  }

  // 2. Tally host + port
  console.log('In Tally: F1 Help → Settings → Connectivity → Client/Server configuration');
  console.log('          set "TallyPrime acts as" = Both, Port = 9002, then restart Tally.');
  console.log('Host: "localhost" if Tally runs on this PC, else the Tally PC\'s IP (Tally → Help → About → Network Adapters).\n');
  for (;;) {
    cfg.tally_host = await ask('Tally host', { def: cfg.tally_host });
    cfg.tally_port = Number(await ask('Tally port', { def: cfg.tally_port })) || 9002;
    try {
      const open = await new TallyClient({ host: cfg.tally_host, port: cfg.tally_port, timeoutMs: 20000 }).listCompanies();
      console.log(`[OK] Connected to Tally. Open companies:`);
      open.forEach((c, i) => console.log(`   ${i + 1}. ${c.name}`));
      if (!open.length) console.log('   (none — open the company in Tally; you can pick it later with "setup")');

      // 3. Which companies to sync
      const pick = await ask('\nCompanies to sync — numbers separated by commas, or Enter for ALL open companies', { def: '' });
      cfg.companies = pick
        ? pick.split(',').map((s) => open[Number(s.trim()) - 1]).filter(Boolean).map((c) => c.name)
        : [];
      console.log(cfg.companies.length ? `[OK] Will sync: ${cfg.companies.join(', ')}` : '[OK] Will sync every company that is open in Tally');
      break;
    } catch (e) {
      console.log(`[FAIL] ${e.message}\n`);
      const again = await ask('Try again? (y/n)', { def: 'y' });
      if (again.toLowerCase() !== 'y') break;
    }
  }

  cfg.interval_minutes = Number(await ask('Sync every how many minutes', { def: cfg.interval_minutes })) || 15;
  config.save(cfg);
  console.log(`\nSaved to ${config.file()}\n`);
  return cfg;
}

async function run({ loop }) {
  const cfg = config.load();
  if (opt('host')) cfg.tally_host = opt('host');
  if (opt('port')) cfg.tally_port = Number(opt('port'));
  if (!cfg.token) { log.error('Not set up yet — run "setup" first.'); return 1; }

  log.info(`Colonel Tally Connector v${version} on ${cfg.machine_name} (logs: ${config.home()}/logs)`);
  if (!loop) {
    const r = await runCycle(cfg, { debug: flag('debug') });
    showStatus(cfg, r.status);
    return r.fatal || r.ok === false ? 1 : 0;
  }

  const everyMs = Math.max(1, Number(cfg.interval_minutes) || 15) * 60 * 1000;
  log.info(`Syncing now and then every ${everyMs / 60000} minutes. Keep this window open (Ctrl+C to stop).`);
  for (;;) {
    let r;
    try { r = await runCycle(cfg, { debug: flag('debug') }); }
    catch (e) {
      log.error(`cycle crashed: ${e.stack || e.message}`);
      r = { status: { cloud: { ok: false, detail: '' }, tally: { ok: false, detail: `connector error: ${e.message}` }, companies: [] } };
    }
    showStatus(cfg, r.status, r.fatal ? null : new Date(Date.now() + everyMs));
    if (r.fatal) return 1;
    await new Promise((res) => setTimeout(res, everyMs));
  }
}

async function test() {
  const cfg = config.load();
  if (opt('host')) cfg.tally_host = opt('host');
  if (opt('port')) cfg.tally_port = Number(opt('port'));
  const status = { cloud: { ok: false, detail: '' }, tally: { ok: false, detail: '' }, companies: [] };

  log.info(`Testing Tally at ${cfg.tally_host}:${cfg.tally_port} …`);
  try {
    const open = await new TallyClient({ host: cfg.tally_host, port: cfg.tally_port, timeoutMs: 20000, dumpRaw: flag('debug') }).listCompanies();
    status.tally = { ok: true, detail: `${open.length} compan${open.length === 1 ? 'y' : 'ies'} open` };
    for (const c of open) {
      log.info(`   • ${c.name}  (books from ${c.books_from || '?'}, AltVchID ${c.alt_vch_id ?? '?'}, GUID ${c.guid || '?'})`);
      status.companies.push({ name: c.name, ok: true, detail: 'open in Tally' });
    }
  } catch (e) { log.error(e.message); status.tally = { ok: false, detail: e.message }; }

  if (!cfg.token) {
    status.cloud = { ok: false, detail: 'not logged in — run setup' };
  } else {
    log.info(`Testing agent.accountant at ${cfg.server_url} …`);
    try {
      const r = await new CloudClient({ serverUrl: cfg.server_url, token: cfg.token }).heartbeat({
        tally_host: cfg.tally_host, tally_port: cfg.tally_port, connector_version: version, machine_name: cfg.machine_name,
        status: status.tally.ok ? 'ok' : 'tally_unreachable', error: status.tally.ok ? null : status.tally.detail,
      });
      status.cloud = { ok: true, detail: `logged in as ${r.user ? r.user.email : 'connector'}` };
    } catch (e) { log.error(e.message); status.cloud = { ok: false, detail: e.message }; }
  }
  showStatus(cfg, status);
  return status.tally.ok && status.cloud.ok ? 0 : 1;
}

async function dryRunCmd() {
  const cfg = config.load();
  if (opt('host')) cfg.tally_host = opt('host');
  if (opt('port')) cfg.tally_port = Number(opt('port'));
  const r = await dryRun(cfg, { debug: flag('debug'), company: opt('company') });
  console.log(`\n${r.ok ? '[OK] Dry run passed' : '[FAIL] Dry run found problems'} — report: ${r.file}\n`);
  return r.ok ? 0 : 1;
}

function status() {
  const cfg = config.load();
  console.log(JSON.stringify({ ...cfg, token: cfg.token ? `${cfg.token.slice(0, 12)}…` : null, config_file: config.file() }, null, 2));
  return 0;
}

function logout() {
  const cfg = config.load();
  config.save({ ...cfg, token: null, connector_id: null });
  console.log('Logged out on this PC. (An admin can also revoke the connector on the agent.accountant Tally page.)');
  return 0;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  log.init(config.home(), { debug: flag('debug') });
  switch (command) {
    case 'setup': await setup(); return 0;
    case 'run': return run({ loop: true });
    case 'once': return run({ loop: false });
    case 'test': return test();
    case 'dry-run': return dryRunCmd();
    case 'status': return status();
    case 'logout': return logout();
    case 'default':
      if (!config.load().token) await setup();
      return run({ loop: true });
    default:
      console.log(`Unknown command "${command}". Use: setup | run | once | test | dry-run | status | logout`);
      return 1;
  }
}

main().then((code) => {
  // Double-clicked .exe: keep the window open so the user can read the error.
  if (code && command === 'default') pauseBeforeExit();
  process.exit(code || 0);
}).catch((e) => {
  try { log.error(e.stack || e.message); } catch (_) { /* logger not initialised */ }
  crashOut(e);
});

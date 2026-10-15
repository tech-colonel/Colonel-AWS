/**
 * app.js — the desktop app. A small local web server (127.0.0.1 only) serves the
 * window in ui.js and runs the same sync cycle as the console `run` command:
 * log in to agent.accountant, point it at Tally's host/port, pick companies, and
 * it syncs now and every N minutes for as long as the app is running.
 *
 * The window is a browser in "app mode" (Edge, else Chrome, else the default
 * browser). Closing the window does NOT stop syncing — "Quit" in the window does.
 * Starting the app a second time just reopens the window of the running one.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const log = require('./logger');
const { TallyClient } = require('./tally');
const { CloudClient } = require('./cloud');
const { runCycle } = require('./sync');
const { version } = require('../package.json');
const page = require('./ui');

const APP_ID = 'colonel-tally-connector';
const UI_PORT = Number(process.env.COLONEL_CONNECTOR_UI_PORT) || 47615;
const LOG_KEEP = 300;

function createApp({ debug = false } = {}) {
  let cfg = config.load();
  const state = {
    tally: { ok: null, detail: 'not checked yet' },
    open_companies: [],
    status: null,            // result of the last sync cycle (what runCycle returns as `status`)
    syncing: false,
    last_sync_at: null,
    next_sync_at: null,
    notice: null,
  };
  const lines = [];
  log.onLine((line) => { lines.push(line); if (lines.length > LOG_KEEP) lines.shift(); });
  let timer = null;
  let port = null;

  const snapshot = () => ({
    app: APP_ID,
    version,
    logged_in: !!cfg.token,
    user_email: cfg.user_email,
    server_url: cfg.server_url,
    tally_host: cfg.tally_host,
    tally_port: cfg.tally_port,
    companies: cfg.companies || [],
    interval_minutes: cfg.interval_minutes,
    machine_name: cfg.machine_name,
    ...state,
    logs: lines.slice(-150),
    log_dir: log.dir,
  });

  // ── sync loop ──────────────────────────────────────────────────────────────
  function schedule() {
    clearTimeout(timer); timer = null;
    if (!cfg.token) { state.next_sync_at = null; return; }
    const ms = Math.max(1, Number(cfg.interval_minutes) || 15) * 60 * 1000;
    state.next_sync_at = new Date(Date.now() + ms).toISOString();
    timer = setTimeout(syncNow, ms);
  }

  async function syncNow() {
    if (state.syncing || !cfg.token) return;
    clearTimeout(timer); timer = null;
    state.syncing = true; state.next_sync_at = null; state.notice = null;
    let r;
    try { r = await runCycle(cfg, { debug }); }
    catch (e) {
      log.error(`cycle crashed: ${e.stack || e.message}`);
      r = { ok: false, status: { cloud: { ok: false, detail: '' }, tally: { ok: false, detail: `connector error: ${e.message}` }, companies: [] } };
    }
    state.syncing = false;
    state.status = r.status;
    state.tally = r.status.tally;
    state.last_sync_at = new Date().toISOString();
    if (r.fatal) {
      // The connector token was revoked or expired: forget it and ask to log in again.
      cfg = { ...cfg, token: null, connector_id: null };
      config.save(cfg);
      state.notice = 'agent.accountant no longer accepts this login. Please log in again.';
      state.next_sync_at = null;
      return;
    }
    schedule();
  }

  async function checkTally(host, portNo) {
    const open = await new TallyClient({ host, port: portNo, timeoutMs: 20000, dumpRaw: debug }).listCompanies();
    state.open_companies = open.map((c) => ({ name: c.name, books_from: c.books_from }));
    state.tally = { ok: true, detail: `${open.length} compan${open.length === 1 ? 'y' : 'ies'} open` };
    return state.open_companies;
  }

  // ── actions the window can call ────────────────────────────────────────────
  const actions = {
    async '/api/login'(b) {
      const url = String(b.server_url || cfg.server_url || '').trim().replace(/\/+$/, '');
      const email = String(b.email || '').trim();
      const password = String(b.password || '');
      if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new Error('The agent.accountant address must start with https://');
      if (!email || !password) throw new Error('Enter your email and password.');
      const r = await new CloudClient({ serverUrl: url }).login(email, password, { machine_name: cfg.machine_name, connector_version: version });
      cfg = { ...cfg, server_url: url, token: r.token, connector_id: r.connector_id, user_email: email };
      config.save(cfg);
      log.info(`Logged in to ${url} as ${email}`);
      syncNow();
      return {};
    },

    async '/api/logout'() {
      cfg = { ...cfg, token: null, connector_id: null };
      config.save(cfg);
      state.status = null;
      schedule();
      log.info('Logged out on this PC');
      return {};
    },

    async '/api/tally'(b) {
      const host = String(b.host || '').trim();
      const portNo = Number(b.port);
      if (!/^[A-Za-z0-9.:-]+$/.test(host)) throw new Error('Enter the Tally host: "localhost", or the IP of the PC or server Tally runs on.');
      if (!Number.isInteger(portNo) || portNo < 1 || portNo > 65535) throw new Error('Enter the Tally port (usually 9002).');
      try { await checkTally(host, portNo); }
      catch (e) { state.tally = { ok: false, detail: e.message }; throw e; }
      cfg = { ...cfg, tally_host: host, tally_port: portNo };
      config.save(cfg);
      log.info(`Tally connection saved: ${host}:${portNo}`);
      return {};
    },

    async '/api/settings'(b) {
      const next = { ...cfg };
      if (Array.isArray(b.companies)) next.companies = b.companies.map((n) => String(n)).filter(Boolean);
      if (b.interval_minutes !== undefined) {
        const n = Number(b.interval_minutes);
        if (!Number.isFinite(n) || n < 1 || n > 1440) throw new Error('Sync interval must be between 1 and 1440 minutes.');
        next.interval_minutes = Math.round(n);
      }
      cfg = next;
      config.save(cfg);
      if (!state.syncing) schedule();
      return {};
    },

    async '/api/sync'() {
      if (!cfg.token) throw new Error('Log in to agent.accountant first.');
      syncNow();
      return {};
    },

    async '/api/quit'() {
      log.info('Quit requested from the app window');
      setImmediate(stop);
      return {};
    },
  };

  // ── http ───────────────────────────────────────────────────────────────────
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > 65536) { reject(new Error('Request too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (_) { reject(new Error('Bad request')); } });
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    // Only this PC's own window may talk to the app. The Host check stops DNS
    // rebinding; the custom header stops other web pages posting to it (a browser
    // will not send it cross-site, and no CORS headers are ever returned).
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(res, 403, { error: 'Forbidden' });
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/') return send(res, 200, page, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url === '/api/state') return send(res, 200, snapshot());
    if (req.method === 'POST' && actions[url]) {
      if (req.headers['x-colonel-ui'] !== '1') return send(res, 403, { error: 'Forbidden' });
      try { return send(res, 200, { ok: true, ...(await actions[url](await readJson(req))) }); }
      catch (e) { return send(res, 400, { ok: false, error: e.message }); }
    }
    return send(res, 404, { error: 'Not found' });
  });

  function stop() {
    clearTimeout(timer); timer = null;
    server.close();
    if (server.closeAllConnections) server.closeAllConnections();
    // Normally the process ends by itself once the server is closed; this is the
    // fallback if a sync in flight keeps it alive.
    setTimeout(() => process.exit(0), 5000).unref();
  }

  /** Resolves { port, already } — `already` = another copy of the app owns the port. */
  function listen(wantPort = UI_PORT) {
    return new Promise((resolve, reject) => {
      server.once('error', async (e) => {
        if (e.code !== 'EADDRINUSE') return reject(e);
        try {
          const r = await fetch(`http://127.0.0.1:${wantPort}/api/state`, { signal: AbortSignal.timeout(3000) });
          if ((await r.json()).app === APP_ID) return resolve({ port: wantPort, already: true });
        } catch (_) { /* something else has the port */ }
        reject(new Error(`Port ${wantPort} on this PC is used by another program. Close it, or set COLONEL_CONNECTOR_UI_PORT to a free port.`));
      });
      server.listen(wantPort, '127.0.0.1', () => {
        port = server.address().port;
        resolve({ port, already: false });
      });
    });
  }

  /** First things after the window is up: is Tally there, and start syncing if logged in. */
  function begin() {
    checkTally(cfg.tally_host, cfg.tally_port).catch((e) => { state.tally = { ok: false, detail: e.message }; });
    if (cfg.token) syncNow();
  }

  return { listen, begin, stop, snapshot };
}

function openWindow(url) {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const browser = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  try {
    if (process.platform === 'win32' && browser) spawn(browser, [`--app=${url}`, '--window-size=1040,820'], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) { log.warn(`Could not open the app window (${e.message}). Open ${url} in a browser.`); }
}

/** Run the desktop app. Returns an exit code only if it is not staying open. */
async function runApp({ debug = false, open = true } = {}) {
  const app = createApp({ debug });
  const { port, already } = await app.listen();
  const url = `http://127.0.0.1:${port}/`;
  if (already) {
    console.log('Colonel Tally Connector is already running — opening its window.');
    if (open) openWindow(url);
    return 0;
  }
  log.info(`Colonel Tally Connector v${version} — app window at ${url} (logs: ${log.dir})`);
  app.begin();
  if (open) openWindow(url);
  return new Promise(() => { /* stays open until Quit */ });
}

module.exports = { createApp, runApp, APP_ID };

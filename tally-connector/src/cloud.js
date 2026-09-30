/**
 * cloud.js — the agent.accountant side: login, heartbeat and the four sync calls.
 * Retries network blips and 5xx a few times; 4xx are real errors and surface.
 */

const log = require('./logger');

class CloudError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CloudClient {
  constructor({ serverUrl, token }) {
    this.base = serverUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async call(path, body, { retries = 3, timeoutMs = 120000 } = {}) {
    const url = `${this.base}/api${path}`;
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          body: JSON.stringify(body || {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const txt = await res.text();
        let data; try { data = JSON.parse(txt); } catch (_) { data = { error: txt.slice(0, 300) }; }
        log.debug(`← cloud ${path}: HTTP ${res.status} in ${Date.now() - started}ms`);
        if (res.ok) return data;
        const err = new CloudError(data.error || `HTTP ${res.status}`, res.status);
        if (res.status < 500 || attempt > retries) throw err;
        log.warn(`cloud ${path} failed (HTTP ${res.status}: ${err.message}) — retry ${attempt}/${retries}`);
      } catch (e) {
        if (e instanceof CloudError && (e.status < 500 || attempt > retries)) throw e;
        if (!(e instanceof CloudError)) {
          if (attempt > retries) throw new CloudError(`Cannot reach ${this.base} (${(e.cause && e.cause.code) || e.message})`, 0);
          log.warn(`cloud ${path} network error (${(e.cause && e.cause.code) || e.message}) — retry ${attempt}/${retries}`);
        }
      }
      await sleep(2000 * attempt);
    }
  }

  login(email, password, meta) { return this.call('/tally/connector/login', { email, password, ...meta }, { retries: 1 }); }
  heartbeat(body) { return this.call('/tally/connector/heartbeat', body, { retries: 1 }); }
  start(company) { return this.call('/tally/connector/sync/start', { company }); }
  ledgers(runId, ledgers) { return this.call('/tally/connector/sync/ledgers', { run_id: runId, ledgers }); }
  vouchers(runId, vouchers) { return this.call('/tally/connector/sync/vouchers', { run_id: runId, vouchers }); }
  finish(runId, body) { return this.call('/tally/connector/sync/finish', { run_id: runId, ...body }, { timeoutMs: 300000 }); }
}

module.exports = { CloudClient, CloudError };

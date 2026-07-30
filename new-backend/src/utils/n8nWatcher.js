/**
 * n8nWatcher.js — poll a triggered n8n execution and auto-clear the invoice
 * "Processing" state when the run reaches a terminal status in n8n itself.
 *
 * Why: the app normally learns a run finished via the workflow's /api/n8n/progress
 * "done" ping. But if the run is CANCELLED inside n8n or ERRORS, that ping never
 * fires — so the UI banner could hang until the 90s self-heal timer. This watcher
 * uses the n8n public API (n8n_api_key) to detect terminal status quickly and clear
 * the banner. On error we clear generically (the raw n8n error is NOT surfaced).
 *
 * Contained + safe: one interval per (brand,agent), unref'd, capped duration,
 * stops the moment the run leaves 'processing' (e.g. user cancels) or on any terminal.
 */
const { resetRun, getState } = require('./invoiceEvents');

const N8N_BASE = process.env.N8N_API_BASE || 'https://colonel1234.app.n8n.cloud/api/v1';
const watchers = new Map(); // `${brandId}-${agentId}` -> intervalId

const key = (b, a) => `${b}-${a}`;

function stop(brandId, agentId) {
  const k = key(brandId, agentId);
  if (watchers.has(k)) { clearInterval(watchers.get(k)); watchers.delete(k); }
}

/**
 * Start watching an execution. No-op if there's no executionId or API key.
 * @param {string} brandId
 * @param {string} agentId
 * @param {string} executionId  the n8n execution id captured at trigger time
 */
function watch(brandId, agentId, executionId, { intervalMs = 8000, maxMs = 10 * 60 * 1000 } = {}) {
  if (!executionId || !process.env.n8n_api_key) return;
  stop(brandId, agentId);
  const startedAt = Date.now();

  const iv = setInterval(async () => {
    // Give up after the cap (self-heal timer will handle anything left).
    if (Date.now() - startedAt > maxMs) return stop(brandId, agentId);
    // If the UI is no longer processing (finished, or user cancelled), stop.
    const st = getState(brandId, agentId);
    if (!st || st.status !== 'processing') return stop(brandId, agentId);

    try {
      const r = await fetch(`${N8N_BASE}/executions/${executionId}`, {
        headers: { 'X-N8N-API-KEY': process.env.n8n_api_key },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return; // transient (rate-limit etc.) — keep polling
      const j = await r.json();
      const status = String(j.status || '').toLowerCase(); // running|waiting|success|error|canceled

      if (status === 'error' || status === 'canceled') {
        stop(brandId, agentId);
        // Auto-clear the hung banner. Generic on purpose — no raw n8n error shown.
        resetRun(brandId, agentId);
      } else if (status === 'success') {
        // Success: let the feed ticks + settle timer emit the "done" summary.
        stop(brandId, agentId);
      }
      // running/waiting → keep polling
    } catch (_) {
      // transient network error — keep polling until the cap
    }
  }, intervalMs);

  if (iv.unref) iv.unref();
  watchers.set(key(brandId, agentId), iv);
}

module.exports = { watch, stop };

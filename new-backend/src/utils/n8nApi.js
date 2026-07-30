/**
 * n8nApi.js — thin wrapper over the n8n public API (n8n_api_key) for the invoice
 * agent: run history (#3), workflow on/off status (#4), and retry a failed run (#5).
 *
 * Brand→workflow resolution: prefer the id CAPTURED at trigger time (exact), else
 * fall back to the ACTIVE workflow whose normalized name contains the brand name
 * (reliable for e.g. Koparo → "KOPARO INVOICE"; fuzzy brands rely on the captured id).
 */
const N8N_BASE = process.env.N8N_API_BASE || 'https://colonel1234.app.n8n.cloud/api/v1';
const apiKey = () => process.env.n8n_api_key;

const registry = new Map();           // `${brandId}-${agentId}` -> workflowId (captured at trigger)
let wfCache = null, wfCacheAt = 0;
const WF_TTL = 5 * 60 * 1000;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function call(path, opts = {}) {
  if (!apiKey()) throw new Error('n8n_api_key not configured');
  const r = await fetch(`${N8N_BASE}${path}`, {
    headers: { 'X-N8N-API-KEY': apiKey() },
    signal: AbortSignal.timeout(15000),
    ...opts,
  });
  if (!r.ok) throw new Error(`n8n API ${r.status}`);
  return r.json();
}

/** Remember the workflow id for a brand+agent (called at trigger time). */
function remember(brandId, agentId, workflowId) {
  if (workflowId) registry.set(`${brandId}-${agentId}`, workflowId);
}

async function listWorkflows(force = false) {
  if (!force && wfCache && Date.now() - wfCacheAt < WF_TTL) return wfCache;
  const j = await call('/workflows?limit=250');
  wfCache = j.data || [];
  wfCacheAt = Date.now();
  return wfCache;
}

/** Resolve a brand's workflow id: captured id first, else active name-match. */
async function resolveWorkflowId(brandId, agentId, brandName) {
  const cached = registry.get(`${brandId}-${agentId}`);
  if (cached) return cached;
  try {
    const wfs = await listWorkflows();
    const bn = norm(brandName);
    if (!bn) return null;
    const matches = wfs.filter((w) => norm(w.name).includes(bn));
    const pick = matches.find((w) => w.active) || matches[0];
    if (pick) { registry.set(`${brandId}-${agentId}`, pick.id); return pick.id; }
  } catch (_) {}
  return null;
}

async function getWorkflow(id) {
  const w = await call(`/workflows/${id}`);
  return { id: w.id, name: w.name, active: !!w.active };
}

/** Last N executions for a workflow (compact). */
async function listRuns(workflowId, limit = 8) {
  const j = await call(`/executions?workflowId=${encodeURIComponent(workflowId)}&limit=${limit}`);
  return (j.data || []).map((e) => ({
    id: e.id,
    status: e.status,               // success | error | canceled | running | waiting
    mode: e.mode,
    startedAt: e.startedAt,
    stoppedAt: e.stoppedAt,
  }));
}

async function retryExecution(executionId) {
  return call(`/executions/${executionId}/retry`, { method: 'POST' });
}

module.exports = { remember, resolveWorkflowId, getWorkflow, listRuns, retryExecution, listWorkflows };

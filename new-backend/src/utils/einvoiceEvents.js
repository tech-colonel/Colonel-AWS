// E-Invoice Extractor — SSE progress emitter.
// Much simpler than invoiceEvents: our controller drives the batch loop
// synchronously (one PDF at a time), so there is no out-of-order / debounce
// problem — we just push start / progress / done / cancelled ticks.

const sseClients = new Map();        // `${brandId}-${agentId}` -> Set<res>
const processingState = new Map();   // `${brandId}-${agentId}` -> state

const keyOf = (brandId, agentId) => `${brandId}-${agentId}`;

const addSseClient = (brandId, agentId, res) => {
  const k = keyOf(brandId, agentId);
  if (!sseClients.has(k)) sseClients.set(k, new Set());
  sseClients.get(k).add(res);
};

const removeSseClient = (brandId, agentId, res) => {
  const k = keyOf(brandId, agentId);
  if (sseClients.has(k)) sseClients.get(k).delete(res);
};

const push = (brandId, agentId, data) => {
  const clients = sseClients.get(keyOf(brandId, agentId));
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => { try { res.write(payload); } catch (_) { /* gone */ } });
};

/** Batch started — total = number of PDFs. */
const startRun = (brandId, agentId, total = 0) => {
  processingState.set(keyOf(brandId, agentId), { status: 'processing', done: 0, total, timestamp: Date.now() });
  push(brandId, agentId, { status: 'processing', done: 0, total });
};

/** One PDF finished — X of N + running status counts. */
const tick = (brandId, agentId, done, total, counts = {}) => {
  processingState.set(keyOf(brandId, agentId), { status: 'processing', done, total, ...counts, timestamp: Date.now() });
  push(brandId, agentId, { status: 'progress', done, total, ...counts });
};

/** Whole batch finished. */
const complete = (brandId, agentId, summary = {}) => {
  processingState.set(keyOf(brandId, agentId), { status: 'done', ...summary, timestamp: Date.now() });
  push(brandId, agentId, { status: 'done', ...summary });
};

/** Cancel — reset to idle and tell clients to stop. */
const resetRun = (brandId, agentId) => {
  processingState.set(keyOf(brandId, agentId), { status: 'idle', timestamp: Date.now() });
  push(brandId, agentId, { status: 'cancelled' });
};

const getState = (brandId, agentId) =>
  processingState.get(keyOf(brandId, agentId)) || { status: 'idle' };

module.exports = { addSseClient, removeSseClient, startRun, tick, complete, resetRun, getState };

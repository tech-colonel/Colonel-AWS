const EventEmitter = require('events');

class InvoiceEmitter extends EventEmitter {}
const invoiceEmitter = new InvoiceEmitter();

/**
 * In-memory store of active SSE clients.
 * Key: `${brandId}-${agentId}`
 * Value: Set of Express res objects
 */
const sseClients = new Map();

/**
 * In-memory processing state.
 * Key: `${brandId}-${agentId}`
 * Value: { status: 'processing'|'done'|'idle', count: number, timestamp: Date }
 */
const processingState = new Map();

const getKey = (brandId, agentId) => `${brandId}-${agentId}`;

/** Register a new SSE client response object */
const addSseClient = (brandId, agentId, res) => {
  const key = getKey(brandId, agentId);
  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key).add(res);
};

/** Remove an SSE client */
const removeSseClient = (brandId, agentId, res) => {
  const key = getKey(brandId, agentId);
  if (sseClients.has(key)) {
    sseClients.get(key).delete(res);
  }
};

/** Push a JSON event to all connected SSE clients for this brand+agent */
const pushEvent = (brandId, agentId, eventData) => {
  const key = getKey(brandId, agentId);
  const clients = sseClients.get(key);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(eventData)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch (_) { /* client gone */ }
  });
};

/** Mark processing as started and notify clients. Arms a self-heal timer so that if
 *  n8n finds nothing to do (0 new files → no start/feed/done pings), the spinner still
 *  clears instead of hanging forever. A real run's Progress:start/feed re-arms this. */
const markProcessing = (brandId, agentId) => {
  const key = getKey(brandId, agentId);
  processingState.set(key, { status: 'processing', count: 0, timestamp: new Date() });
  pushEvent(brandId, agentId, { status: 'processing', count: 0 });
  armTimer(brandId, agentId, NOACTIVITY_MS);
};

/** Push incremental progress (X of N inserted) and notify clients */
const markProgress = (brandId, agentId, done = 0, total = 0) => {
  const key = getKey(brandId, agentId);
  processingState.set(key, { status: 'processing', done, total, count: done, timestamp: new Date() });
  pushEvent(brandId, agentId, { status: 'progress', done, total });
};

/** Mark processing as done and notify clients.
 *  processed = fully-approved rows, review = flagged "Needs Review", corrupted = "Invalid". */
const markDone = (brandId, agentId, processed = 0, corrupted = 0, review = 0) => {
  const key = getKey(brandId, agentId);
  processingState.set(key, { status: 'done', processed, corrupted, review, count: processed + review, timestamp: new Date() });
  pushEvent(brandId, agentId, { status: 'done', processed, corrupted, review, count: processed + review });
};

// ─── Cumulative run accumulation ───────────────────────────────────────────
// The KOPARO-style workflows call /api/n8n/feed once PER invoice (inside a loop),
// so we accumulate progress across those calls instead of finishing on each one.
// Completion is DEBOUNCED, never immediate: n8n's 'done' ping and the per-invoice
// feed calls can arrive in any order, so we only finalize once activity settles.
// This guarantees the summary reflects ALL feed ticks regardless of ordering.
const runTimers = new Map();
const IDLE_MS = 90000;      // no 'done' ping yet → wait this long after the last invoice
const SETTLE_MS = 9000;     // 'done' ping received → finalize this long after the last invoice
const NOACTIVITY_MS = 45000; // clicked Process but n8n sent nothing (0 new files) → clear

const armTimer = (brandId, agentId, ms) => {
  const key = getKey(brandId, agentId);
  if (runTimers.has(key)) clearTimeout(runTimers.get(key));
  const t = setTimeout(() => finalizeRun(brandId, agentId), ms);
  if (t.unref) t.unref();
  runTimers.set(key, t);
};

const clearTimer = (key) => {
  if (runTimers.has(key)) { clearTimeout(runTimers.get(key)); runTimers.delete(key); }
};

// True when the current state belongs to a finished/other run and the next tick
// should start a fresh one: no state, not processing, a run already "full"
// (done >= total), or the previous run already signalled done.
const shouldStartFresh = (st) =>
  !st || st.status !== 'processing' || st.done === undefined || st.doneRequested === true ||
  (st.total > 0 && (st.done || 0) >= st.total);

const freshState = () => ({ status: 'processing', done: 0, total: 0, approved: 0, review: 0, invalid: 0, doneRequested: false, timestamp: new Date() });

/** n8n's 'start' ping. n8n runs this leaf node LAST (not first), so it must NEVER
 *  reset or create a run — that would wipe the ticks. The real total comes from the
 *  batch_total on each feed call. Here we only RAISE the total of a live, mid-run. */
const startRun = (brandId, agentId, total = 0) => {
  const key = getKey(brandId, agentId);
  const st = processingState.get(key);
  if (st && st.status === 'processing' && st.done !== undefined && !shouldStartFresh(st)) {
    st.total = Math.max(st.total || 0, total || 0, st.done);
    processingState.set(key, st);
    pushEvent(brandId, agentId, { status: 'progress', done: st.done, total: st.total });
  }
  // else: no live/mid run → do nothing (batch_total on feeds drives the counter)
};

/** One invoice (or a small batch) just landed — accumulate and push live progress.
 *  `total` = the batch size n8n sends on every feed call, so the very first feed
 *  gives us the correct "of N" denominator without depending on the start ping. */
const feedTick = (brandId, agentId, { approved = 0, review = 0, invalid = 0, total = 0 } = {}) => {
  const key = getKey(brandId, agentId);
  let st = processingState.get(key);
  if (shouldStartFresh(st)) st = freshState();
  st.approved += approved; st.review += review; st.invalid += invalid;
  st.done += approved + review + invalid;
  st.total = Math.max(st.total || 0, total || 0, st.done);
  st.timestamp = new Date();
  processingState.set(key, st);
  pushEvent(brandId, agentId, { status: 'progress', done: st.done, total: st.total });
  armTimer(brandId, agentId, st.doneRequested ? SETTLE_MS : IDLE_MS);
};

/** n8n signalled the run is done — do NOT finish immediately (feed calls may still be
 *  in flight / arrive out of order); arm a short settle window instead. */
const completeRun = (brandId, agentId) => {
  const key = getKey(brandId, agentId);
  const st = processingState.get(key);
  if (!st || st.status !== 'processing') return; // nothing running
  st.doneRequested = true;
  processingState.set(key, st);
  armTimer(brandId, agentId, SETTLE_MS);
};

/** Actually emit the cumulative summary (fired by the settle/idle timer). */
const finalizeRun = (brandId, agentId) => {
  const key = getKey(brandId, agentId);
  clearTimer(key);
  const st = processingState.get(key);
  if (!st || st.status !== 'processing') return;
  markDone(brandId, agentId, st.approved || 0, st.invalid || 0, st.review || 0);
};

/** Hard-stop a run (Cancel) — clear the timer, reset to idle, tell clients to stop. */
const resetRun = (brandId, agentId) => {
  const key = getKey(brandId, agentId);
  clearTimer(key);
  processingState.set(key, { status: 'idle', count: 0, timestamp: new Date() });
  pushEvent(brandId, agentId, { status: 'cancelled' });
};

/** Get current state (for new SSE connections to replay last known state) */
const getState = (brandId, agentId) => {
  return processingState.get(getKey(brandId, agentId)) || { status: 'idle', count: 0 };
};

module.exports = {
  invoiceEmitter,
  addSseClient,
  removeSseClient,
  markProcessing,
  markProgress,
  markDone,
  startRun,
  feedTick,
  completeRun,
  resetRun,
  getState,
};

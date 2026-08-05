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
const markDone = (brandId, agentId, processed = 0, corrupted = 0, review = 0, wrongBrand = 0, wrongBrandName = null) => {
  const key = getKey(brandId, agentId);
  processingState.set(key, { status: 'done', processed, corrupted, review, wrongBrand, wrongBrandName, count: processed + review, timestamp: new Date() });
  pushEvent(brandId, agentId, { status: 'done', processed, corrupted, review, wrongBrand, wrongBrandName, count: processed + review });
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
// A run continues as long as it is live and processing. We deliberately do NOT
// start fresh just because done >= total: n8n feeds once per LINE ITEM while
// total is the number of INVOICES (files), so a run legitimately keeps receiving
// feeds after done reaches total — resetting there corrupted the count.
const shouldStartFresh = (st) =>
  !st || st.status !== 'processing' || st.done === undefined || st.doneRequested === true;

const freshState = () => ({ status: 'processing', invoices: new Map(), done: 0, total: 0, approved: 0, review: 0, invalid: 0, wrongBrand: 0, wrongBrandName: null, doneRequested: false, timestamp: new Date() });

/** n8n's 'start' ping — fires EARLY (right after the file list) announcing a real run
 *  of `total` invoices. Two safe jobs:
 *   1) If a run was just triggered but no feeds have landed yet (markProcessing set
 *      status:processing with no `done`), or the previous run finished, ESTABLISH this
 *      run with the known total and HOLD the self-heal window open (IDLE_MS, re-armed by
 *      each feed). Without this, a slow first extraction (AI can take >45s) trips the
 *      NOACTIVITY "no new invoices" clear before the first feed arrives.
 *   2) If feeds have already started (a live mid-run), only RAISE the total — never
 *      reset (which would wipe the ticks). shouldStartFresh guards make this correct
 *      whether the ping lands before or after the first feed. */
const startRun = (brandId, agentId, total = 0) => {
  const key = getKey(brandId, agentId);
  const st = processingState.get(key);
  if (total > 0 && shouldStartFresh(st)) {
    const fresh = freshState();
    fresh.total = total;
    processingState.set(key, fresh);
    pushEvent(brandId, agentId, { status: 'progress', done: 0, total });
    armTimer(brandId, agentId, IDLE_MS);
    return;
  }
  if (st && st.status === 'processing' && st.done !== undefined) {
    st.total = Math.max(st.total || 0, total || 0, st.done);
    processingState.set(key, st);
    pushEvent(brandId, agentId, { status: 'progress', done: st.done, total: st.total });
    armTimer(brandId, agentId, IDLE_MS);
  }
};

// Status precedence when the SAME invoice shows up across multiple line-item feeds.
const INV_STATUS_RANK = { 'Approved': 0, 'Needs Review': 1, 'Invalid': 2, 'Wrong Brand': 3 };
const INV_RANK_STATUS = ['Approved', 'Needs Review', 'Invalid', 'Wrong Brand'];

/** One feed call (a batch of line-item rows) just landed. We count DISTINCT
 *  INVOICES — by invoice_number, falling back to the Drive file link — not rows,
 *  because n8n loops per line item and a single invoice can arrive across several
 *  feed calls. `total` = the batch_total n8n sends = number of invoices in the run,
 *  so the "of N" denominator is correct from the very first feed. */
const feedTick = (brandId, agentId, { items = [], total = 0, wrongBrandName = null } = {}) => {
  const key = getKey(brandId, agentId);
  let st = processingState.get(key);
  if (shouldStartFresh(st)) st = freshState();
  if (!st.invoices) st.invoices = new Map();
  for (const it of (items || [])) {
    const inv = String(it.invoice_number || '').trim()
      || String(it.invoice_link || '').trim()
      || `__row_${st.invoices.size}`;
    const rank = INV_STATUS_RANK[it.status] ?? 1;
    const prevRank = st.invoices.has(inv) ? INV_STATUS_RANK[st.invoices.get(inv)] : -1;
    if (rank > prevRank) st.invoices.set(inv, INV_RANK_STATUS[rank]); // keep the worst status seen
  }
  let approved = 0, review = 0, invalid = 0, wrong = 0;
  for (const s of st.invoices.values()) {
    if (s === 'Approved') approved++;
    else if (s === 'Needs Review') review++;
    else if (s === 'Wrong Brand') wrong++;
    else invalid++;
  }
  st.approved = approved; st.review = review; st.invalid = invalid; st.wrongBrand = wrong;
  if (wrongBrandName) st.wrongBrandName = wrongBrandName;
  st.done = st.invoices.size;                       // distinct invoices seen so far
  st.total = Math.max(st.total || 0, total || 0, st.done);
  st.timestamp = new Date();
  processingState.set(key, st);
  pushEvent(brandId, agentId, { status: 'progress', done: st.done, total: st.total, wrongBrand: st.wrongBrand || 0, wrongBrandName: st.wrongBrandName || null });
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
  markDone(brandId, agentId, st.approved || 0, st.invalid || 0, st.review || 0, st.wrongBrand || 0, st.wrongBrandName || null);
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

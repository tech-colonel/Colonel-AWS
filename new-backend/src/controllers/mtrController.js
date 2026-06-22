/**
 * mtrController.js
 *
 * Amazon MTR Consolidator — job orchestration.
 *
 *   POST /api/mtr/run            { folderLink }            -> { jobId }
 *   GET  /api/mtr/stream/:jobId  (SSE)                     -> live progress events
 *   GET  /api/mtr/status/:jobId                            -> { status, summary, error }
 *   GET  /api/mtr/download/:jobId                          -> .xlsx file
 *   GET  /api/mtr/config                                   -> { configured, serviceAccount }
 *
 * v1 keeps job state in memory (jobId scopes everything, so concurrent runs by
 * different users never collide). Output workbooks live on disk under output/mtr/.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const drive = require('../services/driveService');
const { consolidate } = require('../services/mtrProcessor');

const OUTPUT_DIR = path.resolve(__dirname, '../../output/mtr');
const JOB_TTL_MS = 60 * 60 * 1000; // keep finished jobs + files for 1h
const MAX_EVENTS = 2000;           // cap replay buffer per job

/** jobId -> { status, summary, error, outPath, events:[], clients:Set<res>, createdAt } */
const jobs = new Map();

function ensureDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Delete orphaned MTR workbooks — files with no tracked job (e.g. leftovers
 * from before a restart, or manual artifacts). Files of tracked jobs (running
 * OR finished and still within TTL) are kept so each user can still download
 * their own result. Multi-user safe: a new run never deletes someone else's
 * finished file.
 */
function sweepStaleFiles() {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) return;
    const known = new Set([...jobs.keys()].map((id) => `${id}.xlsx`));
    for (const f of fs.readdirSync(OUTPUT_DIR)) {
      if (f.endsWith('.xlsx') && !known.has(f)) {
        try { fs.unlinkSync(path.join(OUTPUT_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function pushEvent(job, evt) {
  if (job.events.length < MAX_EVENTS) job.events.push(evt);
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of job.clients) {
    try { res.write(line); } catch { /* client gone */ }
  }
}

function scheduleCleanup(jobId) {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (!job) return;
    try { if (job.outPath && fs.existsSync(job.outPath)) fs.unlinkSync(job.outPath); } catch { /* ignore */ }
    jobs.delete(jobId);
  }, JOB_TTL_MS).unref?.();
}

/* ─── POST /api/mtr/run ────────────────────────────────────────────────────── */
async function runMtr(req, res) {
  const folderLink = req.body?.folderLink || req.body?.folderId || '';
  const folderId = drive.parseFolderId(folderLink);

  if (!drive.isConfigured()) {
    return res.status(503).json({
      error: 'Google Drive is not configured on the server (missing service-account key).',
    });
  }
  if (!folderId) {
    return res.status(400).json({ error: 'Could not read a Drive folder ID from that link.' });
  }

  // Verify access up-front so the user gets an immediate, clear error.
  try {
    await drive.getMeta(folderId, 'id,name');
  } catch (e) {
    return res.status(403).json({
      error: 'Cannot access that folder. Share it (Viewer) with the service account first.',
      serviceAccount: drive.serviceAccountEmail(),
      detail: e.message,
    });
  }

  ensureDir();
  sweepStaleFiles(); // clear previous run's file before starting a new one
  const jobId = uuidv4();
  const outPath = path.join(OUTPUT_DIR, `${jobId}.xlsx`);
  const job = {
    status: 'running',
    summary: null,
    error: null,
    outPath,
    folderId,
    events: [],
    clients: new Set(),
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);

  // Respond immediately; processing continues in the background.
  res.json({ jobId });

  consolidate({ folderId, outPath, emit: (evt) => pushEvent(job, evt) })
    .then((summary) => {
      job.status = 'done';
      job.summary = summary;
      pushEvent(job, { type: 'complete', status: 'done', summary });
      scheduleCleanup(jobId);
    })
    .catch((err) => {
      console.error('[MTR] job failed:', err);
      job.status = 'error';
      job.error = err.message;
      pushEvent(job, { type: 'complete', status: 'error', error: err.message });
      scheduleCleanup(jobId);
    });
}

/* ─── GET /api/mtr/stream/:jobId (SSE) ─────────────────────────────────────── */
function streamMtr(req, res) {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Job not found or expired' }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  // Replay everything so far (the client may attach after run started).
  for (const evt of job.events) res.write(`data: ${JSON.stringify(evt)}\n\n`);

  if (job.status !== 'running') {
    res.write(`data: ${JSON.stringify({ type: 'complete', status: job.status, summary: job.summary, error: job.error })}\n\n`);
    return res.end();
  }

  job.clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
  req.on('close', () => { clearInterval(ping); job.clients.delete(res); });
}

/* ─── GET /api/mtr/status/:jobId ───────────────────────────────────────────── */
function statusMtr(req, res) {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  res.json({ status: job.status, summary: job.summary, error: job.error });
}

/* ─── GET /api/mtr/download/:jobId ─────────────────────────────────────────── */
function downloadMtr(req, res) {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  if (job.status !== 'done' || !fs.existsSync(job.outPath)) {
    return res.status(409).json({ error: 'Output not ready' });
  }
  const fname = `MTR_${(job.summary?.folderName || 'Report').replace(/[^a-z0-9]+/gi, '_')}.xlsx`;
  res.download(job.outPath, fname);
}

/* ─── DELETE /api/mtr/reset/:jobId ─────────────────────────────────────────── */
function resetMtr(req, res) {
  const job = jobs.get(req.params.jobId);
  if (job) {
    for (const c of job.clients) { try { c.end(); } catch { /* ignore */ } }
    try { if (job.outPath && fs.existsSync(job.outPath)) fs.unlinkSync(job.outPath); } catch { /* ignore */ }
    jobs.delete(req.params.jobId);
  }
  // Belt-and-braces: also remove any other orphaned files.
  sweepStaleFiles();
  res.json({ reset: true });
}

/* ─── GET /api/mtr/config ──────────────────────────────────────────────────── */
function configMtr(req, res) {
  res.json({
    configured: drive.isConfigured(),
    serviceAccount: drive.serviceAccountEmail(),
  });
}

module.exports = { runMtr, streamMtr, statusMtr, downloadMtr, configMtr, resetMtr };

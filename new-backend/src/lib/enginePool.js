/**
 * Engine pool — spreads reco work across several reco-engine OS processes.
 *
 * Why processes and not threads: the reco engine is a Python ThreadingHTTPServer,
 * and Python's GIL means one process uses one CPU core for CPU-bound work no
 * matter how many threads it admits. Measured in production on 2 vCPUs:
 * one concurrent job = 45.7% CPU, two concurrent jobs = 46.4% — one core both
 * times. Running N processes is the only way to use N cores.
 *
 * Export routing: every engine persists its pre-built workbook to a shared
 * RECO_OUTPUT_DIR, and export_job() falls back to that disk copy, so any engine
 * can serve any job's export. We still try the originating engine first because
 * only it can run the on-demand rebuild path if the pre-build failed.
 *
 * Configure with PYTHON_RECO_URLS (comma-separated). Falls back to the legacy
 * single PYTHON_RECO_URL, then to localhost:8765, so an un-migrated deployment
 * behaves exactly as before.
 */

const axios = require('axios');

const DEFAULT_URL = 'http://localhost:8765';

const engines = (
  process.env.PYTHON_RECO_URLS ||
  process.env.PYTHON_RECO_URL ||
  DEFAULT_URL
)
  .split(',')
  .map((u) => u.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/** engine URL -> number of requests currently in flight against it */
const inFlight = new Map(engines.map((u) => [u, 0]));

/**
 * jobId -> engine URL that produced it. Bounded: an export follows its run
 * within minutes, so a few thousand entries is ample and cannot grow unbounded.
 */
const MAX_TRACKED_JOBS = 5000;
const jobEngine = new Map();

function listEngines() {
  return [...engines];
}

/**
 * Pick the least-busy engine and mark a slot in use.
 * Callers MUST pair this with releaseEngine() in a finally block — a leaked
 * slot permanently biases dispatch away from that engine.
 */
function acquireEngine() {
  let best = engines[0];
  for (const url of engines) {
    if (inFlight.get(url) < inFlight.get(best)) best = url;
  }
  inFlight.set(best, inFlight.get(best) + 1);
  return best;
}

function releaseEngine(baseUrl) {
  if (!inFlight.has(baseUrl)) return;
  inFlight.set(baseUrl, Math.max(0, inFlight.get(baseUrl) - 1));
}

function rememberJob(jobId, baseUrl) {
  if (!jobId || !baseUrl) return;
  if (!jobEngine.has(jobId) && jobEngine.size >= MAX_TRACKED_JOBS) {
    jobEngine.delete(jobEngine.keys().next().value); // evict oldest
  }
  jobEngine.set(jobId, baseUrl);
}

/** Origin engine first (for the rebuild path), then the rest as disk fallbacks. */
function enginesForJob(jobId) {
  const owner = jobEngine.get(jobId);
  if (!owner || !engines.includes(owner)) return [...engines];
  return [owner, ...engines.filter((u) => u !== owner)];
}

/**
 * GET a job's xlsx, trying the engine that produced it first and falling back to
 * its siblings. Cross-engine works because every engine shares RECO_OUTPUT_DIR
 * and export_job() falls back to that disk copy; trying the origin first only
 * preserves the on-demand rebuild path for the rare pre-build failure.
 * Only 404 ("not on this engine") is worth retrying — other errors surface now.
 */
async function exportFromEngines(jobId, axiosOpts = {}) {
  let lastErr;
  for (const base of enginesForJob(jobId)) {
    try {
      return await axios.get(`${base}/api/jobs/${jobId}/export.xlsx`, axiosOpts);
    } catch (err) {
      lastErr = err;
      if (err.response && err.response.status !== 404) throw err;
    }
  }
  throw lastErr;
}

/**
 * fetch() flavour of exportFromEngines, for callers that use the Fetch API
 * rather than axios (gstr3bController). Returns the first ok Response; on 404
 * tries the next engine; any non-404 response is returned as-is so the caller
 * can surface the real status. Returns the last Response if none succeeded.
 */
async function fetchExportFromEngines(jobId) {
  let last;
  for (const base of enginesForJob(jobId)) {
    const resp = await fetch(`${base}/api/jobs/${jobId}/export.xlsx`);
    if (resp.ok) return resp;
    last = resp;
    if (resp.status !== 404) return resp;
  }
  return last;
}

/** Test-only: reset counters and the job map. */
function _resetForTests() {
  for (const url of engines) inFlight.set(url, 0);
  jobEngine.clear();
}

/** Test/diagnostics only: current in-flight counts. */
function _inFlightSnapshot() {
  return Object.fromEntries(inFlight);
}

module.exports = {
  listEngines,
  acquireEngine,
  releaseEngine,
  rememberJob,
  enginesForJob,
  exportFromEngines,
  fetchExportFromEngines,
  _resetForTests,
  _inFlightSnapshot,
};

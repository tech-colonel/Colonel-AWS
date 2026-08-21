'use strict';

// Runs a workflow apply off the main thread, with a bound on how many can run at once.
//
// WHY THE BOUND MATTERS. Moving the work to a worker thread stops one export from
// freezing the site, but on its own it just trades a frozen event loop for an OOM:
// each apply holds the source workbook, every intermediate sheet and the built
// output in memory, and the shopify-koparo workflow's output alone is 136 MB. Let
// four of those run at once on a 7.6 GB box and the kernel picks a process to kill.
// So concurrency is capped and the rest queue.
//
// The cap is deliberately small. The box is a t3.large — two vCPUs on ONE physical
// core — and the reco engines already claim their share. Two concurrent builds
// would contend for the same core and finish no sooner than one after another.

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_FILE = path.join(__dirname, 'workflowApplyWorker.js');

const MAX_CONCURRENT = Number(process.env.WORKFLOW_MAX_CONCURRENT || 1);
// A build that has run this long is not going to finish; something is wrong with
// the workflow definition or the file. Kill it rather than leak a thread forever.
const TIMEOUT_MS = Number(process.env.WORKFLOW_APPLY_TIMEOUT_MS || 15 * 60 * 1000);
// Refuse work rather than grow an unbounded queue of pending uploads, each of
// which is holding its source file in memory while it waits.
const MAX_QUEUE = Number(process.env.WORKFLOW_MAX_QUEUE || 8);

let active = 0;
const queue = [];

function pump() {
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  const job = queue.shift();
  active += 1;
  spawn(job.payload)
    .then(job.resolve, job.reject)
    .finally(() => {
      active -= 1;
      pump();
    });
}

function spawn(payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_FILE, { workerData: payload });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      reject(Object.assign(
        new Error(`Workflow apply exceeded ${Math.round(TIMEOUT_MS / 1000)}s and was stopped`),
        { statusCode: 504 }
      ));
    }, TIMEOUT_MS);

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    worker.on('message', (msg) => {
      if (msg && msg.ok) {
        done(resolve, { buffer: Buffer.from(msg.buffer), missingMasterValues: msg.missingMasterValues });
      } else {
        const err = new Error((msg && msg.message) || 'Workflow apply failed');
        if (msg && msg.stack) err.stack = msg.stack;
        done(reject, err);
      }
    });

    worker.on('error', (err) => done(reject, err));

    worker.on('exit', (code) => {
      // A worker killed by the OOM killer exits non-zero without ever posting a
      // message. Without this the request would hang until the client gave up.
      if (!settled && code !== 0) {
        done(reject, new Error(`Workflow apply worker exited with code ${code}`));
      }
    });
  });
}

/**
 * @param {object} payload {sheets, fileBufferOrMap, masterData, fileInputs} or {legacyColumns, fileBufferOrMap}
 * @returns {Promise<{buffer: Buffer, missingMasterValues: Array}>}
 */
function runWorkflowApply(payload) {
  if (queue.length >= MAX_QUEUE) {
    return Promise.reject(Object.assign(
      new Error('Too many workflow exports queued — try again shortly'),
      { statusCode: 503 }
    ));
  }
  return new Promise((resolve, reject) => {
    queue.push({ payload, resolve, reject });
    pump();
  });
}

function stats() {
  return { active, queued: queue.length, maxConcurrent: MAX_CONCURRENT };
}

module.exports = { runWorkflowApply, stats };

'use strict';

// Worker-thread entry point for a workflow apply.
//
// One job per worker: the parent sends {sheets, fileBufferOrMap, masterData,
// fileInputs}, this runs the (entirely synchronous) build, posts the result back
// and exits. The heavy CPU burns on this thread, so the main thread's event loop
// stays free to serve everyone else — which is the whole point.
//
// Buffers are transferred rather than copied where possible; the built workbook
// can be well over 100 MB and copying it twice is not free.

const { parentPort, workerData } = require('worker_threads');
const engine = require('./workflowEngine');

// Structured clone turns a Buffer into a plain Uint8Array, and the engine decides
// "single file" vs "map of files" with Buffer.isBuffer(). A Uint8Array fails that
// test, so the engine took the map branch and walked 9.6 MILLION numeric indices as
// if each were a file — producing an empty workbook, slowly, with no error at all.
// Rehydrate to real Buffers before the engine ever sees them.
function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  return v;
}

function rehydrate(input) {
  if (input == null) return input;
  if (Buffer.isBuffer(input) || ArrayBuffer.isView(input) || input instanceof ArrayBuffer) {
    return toBuffer(input);
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = toBuffer(v);
  return out;
}

try {
  const { sheets, masterData, fileInputs, legacyColumns } = workerData;
  const fileBufferOrMap = rehydrate(workerData.fileBufferOrMap);

  let result;
  if (legacyColumns) {
    const buf = Buffer.isBuffer(fileBufferOrMap)
      ? fileBufferOrMap
      : Object.values(fileBufferOrMap)[0];
    result = engine.applyLegacyWorkflow(legacyColumns, buf);
  } else {
    result = engine.applyMultiSheetWorkflow(sheets, fileBufferOrMap, masterData, fileInputs);
  }

  const buffer = result.buffer;
  // ArrayBuffer is transferable; a Buffer is a view onto one. Transfer only when
  // the view covers its whole ArrayBuffer, otherwise we would hand over memory
  // that is not ours alone.
  const transfer = (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength)
    ? [buffer.buffer]
    : [];

  parentPort.postMessage(
    { ok: true, buffer, missingMasterValues: result.missingMasterValues || [] },
    transfer
  );
} catch (err) {
  // Error objects do not survive structured clone with their stack intact, so
  // send the parts the parent needs to rebuild a useful error.
  parentPort.postMessage({
    ok: false,
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack : null,
  });
}

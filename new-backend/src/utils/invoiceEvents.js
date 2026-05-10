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

/** Mark processing as started and notify clients */
const markProcessing = (brandId, agentId) => {
  const key = getKey(brandId, agentId);
  processingState.set(key, { status: 'processing', count: 0, timestamp: new Date() });
  pushEvent(brandId, agentId, { status: 'processing', count: 0 });
};

/** Mark processing as done and notify clients */
const markDone = (brandId, agentId, count) => {
  const key = getKey(brandId, agentId);
  processingState.set(key, { status: 'done', count, timestamp: new Date() });
  pushEvent(brandId, agentId, { status: 'done', count });
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
  markDone,
  getState,
};

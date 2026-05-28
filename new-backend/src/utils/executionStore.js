// Structure: { [brandId_agentId]: { executionId, startedAt, invoiceIds: [] } }

const store = {};

const key = (brandId, agentId) => `${brandId}_${agentId}`;

const setExecution = (brandId, agentId, executionId) => {
  store[key(brandId, agentId)] = { executionId, startedAt: new Date(), invoiceIds: [] };
};

const getExecution = (brandId, agentId) => store[key(brandId, agentId)] || null;

const clearExecution = (brandId, agentId) => { delete store[key(brandId, agentId)]; };

const addInvoiceId = (brandId, agentId, invoiceId) => {
  const entry = store[key(brandId, agentId)];
  if (entry) entry.invoiceIds.push(invoiceId);
};

module.exports = { setExecution, getExecution, clearExecution, addInvoiceId };

const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { AgentWorkflow, Agent, Brand, BrandAgent } = require('../models/master');
const { getBrandConnection } = require('../config/database');
const { getBrandAgentModel } = require('../models/brand');

const upload = multer({ storage: multer.memoryStorage() });

// The pure workflow computation now lives in services/workflowEngine.js so a worker
// thread can load it without pulling in express, multer or the database. Re-exported
// below unchanged, so existing callers of these names keep working.
const {
  extractAllSheetsFromBuffer,
  applyMultiSheetWorkflow,
  applyLegacyWorkflow,
} = require('../services/workflowEngine');
const { runWorkflowApply } = require('../services/workflowRunner');

// ─── Fetch Brand Master Data ──────────────────────────────────────────────────

async function fetchMasterData(brandId, agentId) {
  if (!brandId || !agentId) return { sku_master: [], ledger_master: [] };
  try {
    const brand = await Brand.findByPk(brandId);
    if (!brand) {
      console.log(`[workflow] fetchMasterData: brand ${brandId} not found`);
      return { sku_master: [], ledger_master: [] };
    }

    const brandDb = getBrandConnection(brand.db_name);
    const BrandAgentModel = getBrandAgentModel(brandDb);

    // Use findOrCreate consistent with salesService — creates an empty record if none exists
    const [record] = await BrandAgentModel.findOrCreate({
      where: { brand_id: brandId, agent_id: agentId }
    });

    console.log(`[workflow] fetchMasterData: sku=${record.sku_master?.length ?? 0} ledger=${record.ledger_master?.length ?? 0}`);

    return {
      sku_master:    record.sku_master    || [],
      ledger_master: record.ledger_master || []
    };
  } catch (err) {
    console.error('[workflow] fetchMasterData error:', err.message);
    return { sku_master: [], ledger_master: [] };
  }
}

// Returns the set of field names found in sku_master / ledger_master across all brands for an agent
async function scanMasterSchema(agentId) {
  const skuFields    = new Set();
  const ledgerFields = new Set();

  try {
    const brandAgents = await BrandAgent.findAll({ where: { agent_id: agentId } });
    for (const ba of brandAgents) {
      if (skuFields.size > 0 && ledgerFields.size > 0) break; // found enough
      const brand = await Brand.findByPk(ba.brand_id);
      if (!brand) continue;
      try {
        const brandDb = getBrandConnection(brand.db_name);
        const BrandAgentModel = getBrandAgentModel(brandDb);
        const [record] = await BrandAgentModel.findOrCreate({
          where: { brand_id: ba.brand_id, agent_id: agentId }
        });
        if (record.sku_master?.length)    Object.keys(record.sku_master[0]).forEach(k => skuFields.add(k));
        if (record.ledger_master?.length) Object.keys(record.ledger_master[0]).forEach(k => ledgerFields.add(k));
      } catch { continue; }
    }
  } catch (err) {
    console.error('[workflow] scanMasterSchema error:', err.message);
  }

  return { sku: Array.from(skuFields), ledger: Array.from(ledgerFields) };
}

// ─── Controllers ──────────────────────────────────────────────────────────────

const normalizeWorkflow = (wf) => {
  const data = wf.toJSON ? wf.toJSON() : { ...wf };
  data.fileInputs = data.file_inputs || [];
  delete data.file_inputs;
  return data;
};

const getWorkflows = async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const workflows = await AgentWorkflow.findAll({
      where: { agent_id: agentId },
      order: [['createdAt', 'ASC']]
    });
    res.json(workflows.map(normalizeWorkflow));
  } catch (error) {
    next(error);
  }
};

// Global list — every workflow across every agent, with its parent agent's
// id/name attached. Powers the "Workflows" section on the Agents pages
// (admin + accountant), which otherwise have no way to discover workflows
// without first opening each agent's workspace individually.
const getAllWorkflows = async (req, res, next) => {
  try {
    const workflows = await AgentWorkflow.findAll({
      include: [{ model: Agent, attributes: ['id', 'name'] }],
      order: [['name', 'ASC']]
    });
    res.json(workflows.map(wf => {
      const data = normalizeWorkflow(wf);
      data.agentName = wf.Agent?.name || null;
      return data;
    }));
  } catch (error) {
    next(error);
  }
};

const getWorkflow = async (req, res, next) => {
  try {
    const { workflowId } = req.params;
    const workflow = await AgentWorkflow.findByPk(workflowId);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    res.json(normalizeWorkflow(workflow));
  } catch (error) {
    next(error);
  }
};

const createWorkflow = async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const { name, description, sample_columns, sheets, fileInputs } = req.body;

    const agent = await Agent.findByPk(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'Workflow name is required' });
    if (!sheets || sheets.length === 0) return res.status(400).json({ error: 'At least one sheet is required' });

    const workflow = await AgentWorkflow.create({
      agent_id:       agentId,
      name:           name.trim(),
      description:    description || '',
      sample_columns: sample_columns || [],
      sheets:         sheets || [],
      file_inputs:    fileInputs || [],
      columns:        []
    });

    res.status(201).json({ message: 'Workflow created', workflow });
  } catch (error) {
    next(error);
  }
};

const updateWorkflow = async (req, res, next) => {
  try {
    const { workflowId } = req.params;
    const { name, description, sample_columns, sheets, fileInputs } = req.body;

    const workflow = await AgentWorkflow.findByPk(workflowId);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    await workflow.update({
      ...(name           !== undefined && { name: name.trim() }),
      ...(description    !== undefined && { description }),
      ...(sample_columns !== undefined && { sample_columns }),
      ...(sheets         !== undefined && { sheets }),
      ...(fileInputs     !== undefined && { file_inputs: fileInputs })
    });

    res.json({ message: 'Workflow updated', workflow });
  } catch (error) {
    next(error);
  }
};

const deleteWorkflow = async (req, res, next) => {
  try {
    const { workflowId } = req.params;
    const workflow = await AgentWorkflow.findByPk(workflowId);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    await workflow.destroy();
    res.json({ message: 'Workflow deleted' });
  } catch (error) {
    next(error);
  }
};

const extractColumns = [
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const sheets = extractAllSheetsFromBuffer(req.file.buffer);
      if (sheets.length === 0) return res.status(400).json({ error: 'Could not extract sheets from file' });
      // `columns` kept for backward compatibility (first sheet's columns)
      res.json({ sheets, columns: sheets[0]?.columns || [] });
    } catch (error) {
      next(error);
    }
  }
];

const applyWorkflow = [
  upload.any(),
  async (req, res, next) => {
    try {
      const { workflowId } = req.params;
      const workflow = await AgentWorkflow.findByPk(workflowId);
      if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

      const fileInputs = workflow.file_inputs || [];
      const allFiles   = req.files || [];

      // Build file buffer map: { [fileInputId]: Buffer }
      // Single-file (legacy): field name 'file' → maps to first fileInput id or 'file_0'
      // Multi-file: field names 'file_0', 'file_1', ... → mapped by index to fileInputs[i].id
      let fileBufferOrMap;
      if (fileInputs.length <= 1) {
        const singleFile = allFiles.find(f => f.fieldname === 'file' || f.fieldname === 'file_0');
        if (!singleFile) return res.status(400).json({ error: 'No file uploaded' });
        fileBufferOrMap = singleFile.buffer;
      } else {
        fileBufferOrMap = {};
        const missing = [];
        fileInputs.forEach((fi, i) => {
          const f = allFiles.find(f => f.fieldname === `file_${i}`);
          if (f) fileBufferOrMap[fi.id] = f.buffer;
          else   missing.push(fi.label || `File ${i + 1}`);
        });
        if (missing.length > 0) {
          return res.status(400).json({ error: `Missing required files: ${missing.join(', ')}` });
        }
      }

      // Fetch master data if brand/agent context provided
      const brandId = req.body.brandId;
      const agentId = req.body.agentId;
      const masterData = await fetchMasterData(brandId, agentId);

      // Build on a worker thread, never here. This is minutes of synchronous CPU —
      // the shopify-koparo workflow emits a 136 MB workbook — and on the main thread
      // it holds the event loop for the whole run, which is what repeatedly took the
      // live site down for every other user on 2026-08-21. runWorkflowApply also caps
      // how many run at once, so concurrent exports queue instead of racing each
      // other into an OOM.
      let outputBuffer, missingMasterValues;
      if (workflow.sheets && workflow.sheets.length > 0) {
        ({ buffer: outputBuffer, missingMasterValues } = await runWorkflowApply({
          sheets: workflow.sheets, fileBufferOrMap, masterData, fileInputs,
        }));
      } else if (workflow.columns && workflow.columns.length > 0) {
        const singleBuf = Buffer.isBuffer(fileBufferOrMap) ? fileBufferOrMap : Object.values(fileBufferOrMap)[0];
        ({ buffer: outputBuffer, missingMasterValues } = await runWorkflowApply({
          legacyColumns: workflow.columns, fileBufferOrMap: singleBuf,
        }));
      } else {
        return res.status(400).json({ error: 'Workflow has no sheets defined' });
      }

      if (missingMasterValues && missingMasterValues.length > 0 && req.body.proceedWithoutMaster !== 'true') {
        return res.status(400).json({ error: 'Missing master data values', missingMasterValues });
      }

      const outputDir = path.join(__dirname, '../../outputs');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      const filename = `workflow_${workflow.name.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.xlsx`;
      const filepath = path.join(outputDir, filename);
      fs.writeFileSync(filepath, outputBuffer);

      res.json({ message: 'Workflow applied successfully', filename });
    } catch (error) {
      next(error);
    }
  }
];

const getMasterSchema = async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const schema = await scanMasterSchema(agentId);
    res.json(schema);
  } catch (error) {
    next(error);
  }
};

const downloadWorkflowOutput = async (req, res, next) => {
  try {
    const { filename } = req.params;
    if (!/^[\w\-. ]+\.xlsx$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filepath = path.join(__dirname, '../../outputs', filename);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
    res.download(filepath, filename);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getWorkflows,
  getAllWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  extractColumns,
  applyWorkflow,
  downloadWorkflowOutput,
  getMasterSchema,
  extractAllSheetsFromBuffer,
  applyMultiSheetWorkflow
};

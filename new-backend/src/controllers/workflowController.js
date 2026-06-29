const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { AgentWorkflow, Agent, Brand, BrandAgent } = require('../models/master');
const { getBrandConnection } = require('../config/database');
const { getBrandAgentModel } = require('../models/brand');

const upload = multer({ storage: multer.memoryStorage() });

// ─── Formula Evaluator ────────────────────────────────────────────────────────

function evaluateFormula(formula, scope) {
  try {
    let expr = formula.replace(/\{([^}]+)\}/g, (_, colRef) => {
      const val = scope[colRef];
      if (val === null || val === undefined || val === '') return '0';
      const num = parseFloat(String(val).replace(/,/g, ''));
      if (!isNaN(num)) return String(num);
      return `"${String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    });

    expr = expr.replace(
      /\bIF\s*\(([^,()]+(?:\([^()]*\)[^,()]*)*)\s*,\s*([^,()]+(?:\([^()]*\)[^,()]*)*)\s*,\s*([^()]+(?:\([^()]*\)[^()]*)*)\)/gi,
      '(($1) ? ($2) : ($3))'
    );

    // eslint-disable-next-line no-new-func
    const result = new Function('"use strict"; return (' + expr + ');')();
    if (result === null || result === undefined || (typeof result === 'number' && isNaN(result))) return '';
    return result;
  } catch {
    return '';
  }
}

// ─── Row Filters ──────────────────────────────────────────────────────────────

function testFilter(row, filter) {
  const rawVal = row[filter.column];
  const cellStr = String(rawVal === null || rawVal === undefined ? '' : rawVal).trim();
  const filterVal = String(filter.value || '').trim();

  switch (filter.operator) {
    case 'equals':
      return cellStr.toLowerCase() === filterVal.toLowerCase();
    case 'not_equals':
      return cellStr.toLowerCase() !== filterVal.toLowerCase();
    case 'contains':
      return cellStr.toLowerCase().includes(filterVal.toLowerCase());
    case 'not_contains':
      return !cellStr.toLowerCase().includes(filterVal.toLowerCase());
    case 'gt': {
      const n = parseFloat(cellStr.replace(/,/g, ''));
      const nf = parseFloat(filterVal.replace(/,/g, ''));
      return !isNaN(n) && !isNaN(nf) && n > nf;
    }
    case 'lt': {
      const n = parseFloat(cellStr.replace(/,/g, ''));
      const nf = parseFloat(filterVal.replace(/,/g, ''));
      return !isNaN(n) && !isNaN(nf) && n < nf;
    }
    case 'is_empty':
      return cellStr === '';
    case 'is_not_empty':
      return cellStr !== '';
    default:
      return true;
  }
}

function applyFilters(rows, filters) {
  if (!filters || filters.length === 0) return rows;
  return rows.filter(row => filters.every(f => testFilter(row, f)));
}

// ─── Master Data Lookup ───────────────────────────────────────────────────────

function resolveMasterLookup(col, row, masterData) {
  const { masterType, lookupColumn, matchField, returnField } = col;
  const lookupValue = String(row[lookupColumn] || '').trim().toLowerCase();
  if (!lookupValue) return '';

  const master = masterType === 'sku'
    ? (masterData.sku_master || [])
    : (masterData.ledger_master || []);

  const keyField = masterType === 'sku' ? (matchField || 'salesPortalSku') : (matchField || '');

  const match = master.find(entry => {
    const entryVal = String(entry[keyField] || '').trim().toLowerCase();
    return entryVal === lookupValue;
  });

  if (!match) return '';
  return match[returnField] !== undefined ? match[returnField] : '';
}

// ─── File Header Extraction ───────────────────────────────────────────────────

function extractHeadersFromBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  for (const row of rows) {
    const headers = row.map(h => String(h || '').trim()).filter(h => h !== '');
    if (headers.length > 0) return headers;
  }
  return [];
}

// ─── Multi-Sheet Workflow Apply ───────────────────────────────────────────────

function applyMultiSheetWorkflow(sheets, fileBuffer, masterData = {}) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true, raw: false });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const allRawRows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });

  const outBook = XLSX.utils.book_new();
  const sheetResults = []; // sheetResults[i][rowIdx] = outputRow for cross-sheet refs

  for (let sheetIdx = 0; sheetIdx < sheets.length; sheetIdx++) {
    const wfSheet = sheets[sheetIdx];

    // 1. Apply per-sheet row filters
    const rawRows = applyFilters(allRawRows, wfSheet.filters || []);

    const orderedCols = [...(wfSheet.columns || [])].sort((a, b) => a.order - b.order);
    const sheetRowResults = [];

    const outputRows = rawRows.map((rawRow, rowIdx) => {
      const scope = {};

      // Seed source columns
      for (const col of orderedCols) {
        if (col.type === 'source') {
          scope[col.label] = rawRow[col.key] !== undefined ? rawRow[col.key] : '';
        }
      }

      // Seed cross-sheet refs: {PrevSheetName.ColumnLabel}
      for (let prevIdx = 0; prevIdx < sheetIdx; prevIdx++) {
        const prevSheet = sheets[prevIdx];
        const prevRowData = sheetResults[prevIdx]?.[rowIdx] || {};
        for (const [colLabel, value] of Object.entries(prevRowData)) {
          scope[`${prevSheet.name}.${colLabel}`] = value;
        }
      }

      const outputRow = {};
      for (const col of orderedCols) {
        let val;
        if (col.type === 'source') {
          val = scope[col.label];
        } else if (col.type === 'master_lookup') {
          val = resolveMasterLookup(col, rawRow, masterData);
          scope[col.label] = val;
        } else {
          // computed (formula or prev-sheet ref)
          val = evaluateFormula(col.formula || '', scope);
          scope[col.label] = val;
        }
        outputRow[col.label] = val;
      }

      sheetRowResults.push({ ...outputRow });
      return outputRow;
    });

    sheetResults.push(sheetRowResults);

    const safeSheetName = (wfSheet.name || `Sheet${sheetIdx + 1}`)
      .replace(/[:\\/?*[\]]/g, '')
      .slice(0, 31);

    const outSheet = XLSX.utils.json_to_sheet(outputRows);
    XLSX.utils.book_append_sheet(outBook, outSheet, safeSheetName);
  }

  return XLSX.write(outBook, { type: 'buffer', bookType: 'xlsx' });
}

function applyLegacyWorkflow(columns, fileBuffer) {
  return applyMultiSheetWorkflow(
    [{ id: 'default', name: 'Output', filters: [], columns }],
    fileBuffer,
    {}
  );
}

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

const getWorkflows = async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const workflows = await AgentWorkflow.findAll({
      where: { agent_id: agentId },
      order: [['createdAt', 'ASC']]
    });
    res.json(workflows);
  } catch (error) {
    next(error);
  }
};

const getWorkflow = async (req, res, next) => {
  try {
    const { workflowId } = req.params;
    const workflow = await AgentWorkflow.findByPk(workflowId);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    res.json(workflow);
  } catch (error) {
    next(error);
  }
};

const createWorkflow = async (req, res, next) => {
  try {
    const { agentId } = req.params;
    const { name, description, sample_columns, sheets } = req.body;

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
    const { name, description, sample_columns, sheets } = req.body;

    const workflow = await AgentWorkflow.findByPk(workflowId);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    await workflow.update({
      ...(name           !== undefined && { name: name.trim() }),
      ...(description    !== undefined && { description }),
      ...(sample_columns !== undefined && { sample_columns }),
      ...(sheets         !== undefined && { sheets })
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
      const headers = extractHeadersFromBuffer(req.file.buffer);
      if (headers.length === 0) return res.status(400).json({ error: 'Could not extract columns from file' });
      res.json({ columns: headers });
    } catch (error) {
      next(error);
    }
  }
];

const applyWorkflow = [
  upload.single('file'),
  async (req, res, next) => {
    try {
      const { workflowId } = req.params;
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const workflow = await AgentWorkflow.findByPk(workflowId);
      if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

      // Fetch master data if brand/agent context provided
      const brandId = req.body.brandId;
      const agentId = req.body.agentId;
      const masterData = await fetchMasterData(brandId, agentId);

      let outputBuffer;
      if (workflow.sheets && workflow.sheets.length > 0) {
        outputBuffer = applyMultiSheetWorkflow(workflow.sheets, req.file.buffer, masterData);
      } else if (workflow.columns && workflow.columns.length > 0) {
        outputBuffer = applyLegacyWorkflow(workflow.columns, req.file.buffer);
      } else {
        return res.status(400).json({ error: 'Workflow has no sheets defined' });
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
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  extractColumns,
  applyWorkflow,
  downloadWorkflowOutput,
  getMasterSchema
};

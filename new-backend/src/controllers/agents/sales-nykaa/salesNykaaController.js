'use strict';
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const XLSX_STYLE = require('xlsx-js-style');
const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { setPending, getPending, deletePending } = require('../../../services/pendingGenerationsStore');
const { nykaaProcessor } = require('../../../services/processors/nykaa/nykaaProcessor');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');
async function ensureDir() { await fs.ensureDir(OUTPUT_DIR); }

const MONTH_NUMS = {
  January:1,February:2,March:3,April:4,May:5,June:6,
  July:7,August:8,September:9,October:10,November:11,December:12,
};

const getMasterData = async (req, res, next) => {
  try {
    const result = await salesService.getMasterData(req.params.brandId, req.params.agentId);
    res.json(result);
  } catch (err) { next(err); }
};

function mapRowToSchema(row, monthName, year, filename) {
  return {
    year: parseInt(year, 10),
    month: MONTH_NUMS[monthName] || parseInt(monthName, 10) || 0,
    filename,
    externorderno:    row.externorderno,
    product_sku:      row.product_sku,
    invoiceno:        row.invoiceno,
    product_name:     row.product_name,
    cycle:            row.cycle,
    entry_type:       row.entry_type,
    resolved_status:  row.resolved_status,
    base_value:       row.base_value,
    igst:             row.igst,
    cgst:             row.cgst,
    sgst:             row.sgst,
    quantity:         row.quantity,
    state:            row.state,
    tax_percent:      row.tax_percent,
    narration:        row.narration,
  };
}

const generatePreview = async (req, res, next) => {
  try {
    const { brandId, agentId } = req.params;
    const { month, year } = req.body;
    if (!month || !year) return res.status(400).json({ error: 'month and year are required' });
    const cycle1Buffer = req.files && req.files.cycle1File ? req.files.cycle1File[0].buffer : null;
    const cycle2Buffer = req.files && req.files.cycle2File ? req.files.cycle2File[0].buffer : null;
    if (!cycle1Buffer || !cycle2Buffer)
      return res.status(400).json({ error: 'Both cycle1File (1-15) and cycle2File (16-30) are required' });
    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);
    if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });
    const result = nykaaProcessor(cycle1Buffer, cycle2Buffer, month, year);
    if (!result || !result.workingFileData || result.workingFileData.length === 0)
      return res.status(400).json({ error: 'No processable data found in the uploaded files' });
    const brandDb   = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const Model     = getDynamicModel(brandDb, tableName, agent.columns);
    const taskId    = uuidv4();
    const filename  = `nykaa_${brand.name}_${month}_${year}_${taskId}.xlsx`;
    const filepath  = path.join(OUTPUT_DIR, filename);
    const dbRows    = result.workingFileData.map(row => mapRowToSchema(row, month, year, filename));
    setPending(taskId, { workbook: result.outputWorkbook, dbRows, filepath, filename, Model, agentType: 'nykaa' });
    res.json({ success: true, taskId, filename, summary: result.summary });
  } catch (err) { next(err); }
};

const generateCommit = async (req, res, next) => {
  try {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: 'taskId is required' });
    const pending = getPending(taskId);
    if (!pending) return res.status(404).json({ error: 'Preview expired or not found. Please re-generate.' });
    const { workbook, dbRows, filepath, filename, Model } = pending;
    await ensureDir();
    XLSX_STYLE.writeFile(workbook, filepath);
    await Model.sync();
    await Model.bulkCreate(dbRows);

    // fire-and-forget: record run for admin analytics (never blocks/breaks the agent)
    try {
        const { recordAgentRun } = require('../../../services/agentRunTracker');
        recordAgentRun(Model.sequelize, {
            brandId: req.params.brandId,
            agentType: Model.tableName,
            month: (dbRows && dbRows[0] && dbRows[0].month) || null,
            year: (dbRows && dbRows[0] && dbRows[0].year) || null,
            totalRows: (dbRows && dbRows.length) || 0,
            outputFileId: (typeof filename !== 'undefined' ? filename : null),
            createdBy: (req.user && req.user.id) || null,
        });
    } catch (e) { /* tracking must never break the agent */ }
    deletePending(taskId);
    res.json({ success: true, message: 'Nykaa working file committed successfully', filename, count: dbRows.length });
  } catch (err) { next(err); }
};

const generateDiscard = async (req, res, next) => {
  try {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: 'taskId is required' });
    deletePending(taskId);
    res.json({ success: true, message: 'Generation discarded' });
  } catch (err) { next(err); }
};

module.exports = { getMasterData, generatePreview, generateCommit, generateDiscard };

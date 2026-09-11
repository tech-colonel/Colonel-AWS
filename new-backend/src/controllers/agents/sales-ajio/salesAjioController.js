const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { ajioProcessor } = require('../../../services/processors/ajio/ajioProcessor');
const { setPending, getPending, deletePending } = require('../../../services/pendingGenerationsStore');

const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx-js-style');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');

async function ensureDir() {
  await fs.ensureDir(OUTPUT_DIR);
}

function safeNum(value) {
  if (value === null || value === undefined || value === '') return 0;
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

function safeDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

const monthToNumber = (monthName) => {
  const months = {
    January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
    July: 7, August: 8, September: 9, October: 10, November: 11, December: 12
  };
  return months[monthName] || parseInt(monthName, 10) || 0;
};

// ─── Master data ──────────────────────────────────────────────────────────────
const uploadSkuMaster = async (req, res, next) => {
  try {
    const result = await salesService.uploadMasterData(
      req.params.brandId, req.params.agentId, 'sku', req.file.buffer
    );
    res.json({ message: 'SKU Master uploaded successfully', ...result });
  } catch (error) { next(error); }
};

const uploadLedgerMaster = async (req, res, next) => {
  try {
    const result = await salesService.uploadMasterData(
      req.params.brandId, req.params.agentId, 'ledger', req.file.buffer
    );
    res.json({ message: 'Ledger Master uploaded successfully', ...result });
  } catch (error) { next(error); }
};

const getMasterData = async (req, res, next) => {
  try {
    const result = await salesService.getMasterData(req.params.brandId, req.params.agentId);
    res.json(result);
  } catch (error) { next(error); }
};

// ─── Row → DB schema (see seed-sales-ajio.js) ─────────────────────────────────
const mapRowToAjioSchema = (row, month, year, filename) => ({
  year: parseInt(year, 10),
  month: monthToNumber(month),
  filename,
  record_type: row.recordType,
  status: row.status || null,
  voucher_no: row.voucherNo || null,
  ref_no: row.refNo || null,
  voucher_date: safeDate(row.voucherDate),
  invoice_date: safeDate(row.invoiceDate),
  ref_date: safeDate(row.refDate),
  cust_order_no: row.custOrderNo || null,
  seller_sku: row.sellerSku || null,
  hsn: row.hsn || null,
  stock_name: row.stockName || null,
  quantity: safeNum(row.quantity),
  rate: safeNum(row.rate),
  taxable_value: safeNum(row.taxableValue),
  cgst_amount: safeNum(row.cgstAmount),
  sgst_amount: safeNum(row.sgstAmount),
  igst_amount: safeNum(row.igstAmount),
  total_value: safeNum(row.totalValue),
  cost: safeNum(row.cost),
  cost_qty: safeNum(row.costQty),
  gst_rate: safeNum(row.ratePercent),
  party_ledger: 'Reliance Retail Limited (AJIO)',
  sales_ledger: 'Ajio Sales-B2B@5%'
});

function getBuffers(req) {
  const files = req.files || {};
  const order = files.file ? files.file[0].buffer : (req.file ? req.file.buffer : null);
  const returns = files.returnsFile ? files.returnsFile[0].buffer : null;
  return { order, returns };
}

async function runProcessor(req) {
  const { brandId, agentId } = req.params;
  const { month, year, inventory_type } = req.body;
  const useInventory = inventory_type !== 'Without';

  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) return { error: { status: 404, body: { error: 'Brand or Agent not found' } } };

  const masterData = await salesService.getMasterData(brandId, agentId);
  const { order, returns } = getBuffers(req);
  if (!order) return { error: { status: 400, body: { error: 'AJIO order report file is required' } } };
  if (!returns) return { error: { status: 400, body: { error: 'AJIO RTV (returns) report file is required' } } };

  const processed = await ajioProcessor(
    order, returns, masterData.sku_master, masterData.ledger_master,
    brand.name, month, year, useInventory
  );

  if (processed.missingMasterValues?.length > 0 && req.body.proceedWithoutMaster !== 'true') {
    return { error: { status: 400, body: { error: 'Missing master data values', missingMasterValues: processed.missingMasterValues } } };
  }

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  return { brand, agent, month, year, processed, Model };
}

// ─── Direct generate (legacy single-shot) ────────────────────────────────────
const generate = async (req, res, next) => {
  try {
    const r = await runProcessor(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);

    await ensureDir();
    const id = uuidv4();
    const filename = `ajio_${r.brand.name}_${r.month}_${r.year}_${id}.xlsx`;
    const filepath = path.join(OUTPUT_DIR, filename);

    const dbRows = [...r.processed.returnRows, ...r.processed.salesRows]
      .map(row => mapRowToAjioSchema(row, r.month, r.year, filename));

    await r.Model.sync();
    await r.Model.bulkCreate(dbRows);

    await fs.writeFile(filepath, XLSX.write(r.processed.outputWorkbook, { type: 'buffer', bookType: 'xlsx' }));

    res.json({ success: true, message: 'AJIO working file generated successfully', data: { filename, count: dbRows.length } });
  } catch (error) {
    console.error('AJIO Generation Error:', error);
    next(error);
  }
};

// ─── Phase 1: preview ────────────────────────────────────────────────────────
const generatePreview = async (req, res, next) => {
  try {
    const r = await runProcessor(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);

    const taskId = uuidv4();
    const filename = `ajio_${r.brand.name}_${r.month}_${r.year}_${taskId}.xlsx`;
    const processPath = path.join(OUTPUT_DIR, filename);

    const dbRows = [...r.processed.returnRows, ...r.processed.salesRows]
      .map(row => mapRowToAjioSchema(row, r.month, r.year, filename));

    const sum = (rows, k) => Number(rows.reduce((a, x) => a + Number(x[k] || 0), 0).toFixed(2));
    const workingFile = {
      quantity: r.processed.salesRows.reduce((a, x) => a + Number(x.quantity || 0), 0)
        - r.processed.returnRows.reduce((a, x) => a + Number(x.quantity || 0), 0),
      taxableValue: Number((sum(r.processed.salesRows, 'taxableValue') - sum(r.processed.returnRows, 'taxableValue')).toFixed(2)),
      cgst: Number((sum(r.processed.salesRows, 'cgstAmount') - sum(r.processed.returnRows, 'cgstAmount')).toFixed(2)),
      sgst: Number((sum(r.processed.salesRows, 'sgstAmount') - sum(r.processed.returnRows, 'sgstAmount')).toFixed(2)),
      igst: 0
    };

    setPending(taskId, {
      agentType: 'ajio',
      workbook: r.processed.outputWorkbook,
      finalData: dbRows,
      processFile: filename,
      processPath,
      Model: r.Model
    });

    res.json({
      success: true,
      taskId,
      rowCount: dbRows.length,
      summary: {
        workingFile,
        pivotFile: null,
        sales: { rows: r.processed.salesRows.length },
        returns: { rows: r.processed.returnRows.length }
      }
    });
  } catch (error) {
    console.error('AJIO Preview Error:', error);
    next(error);
  }
};

// ─── Phase 2a: commit ────────────────────────────────────────────────────────
const generateCommit = async (req, res, next) => {
  try {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: 'taskId is required' });

    const pending = getPending(taskId);
    if (!pending) return res.status(404).json({ error: 'No pending generation found. It may have expired. Please regenerate.' });

    const { workbook, finalData, processFile, processPath, Model } = pending;
    await ensureDir();
    await Model.sync();
    await Model.bulkCreate(finalData);
    await fs.writeFile(processPath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    deletePending(taskId);

    res.json({ success: true, message: 'AJIO file generated and saved successfully', data: { filename: processFile, count: finalData.length } });
  } catch (error) {
    console.error('AJIO Commit Error:', error);
    next(error);
  }
};

// ─── Phase 2b: discard ───────────────────────────────────────────────────────
const generateDiscard = async (req, res, next) => {
  try {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: 'taskId is required' });
    deletePending(taskId);
    res.json({ success: true, message: 'Generation discarded successfully' });
  } catch (error) {
    console.error('AJIO Discard Error:', error);
    next(error);
  }
};

module.exports = {
  uploadSkuMaster,
  uploadLedgerMaster,
  getMasterData,
  generate,
  generatePreview,
  generateCommit,
  generateDiscard
};

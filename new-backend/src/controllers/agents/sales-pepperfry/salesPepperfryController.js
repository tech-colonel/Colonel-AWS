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
const { pepperfryProcessor } = require('../../../services/processors/pepperfry/pepperfryProcessor');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');
async function ensureDir() { await fs.ensureDir(OUTPUT_DIR); }

const MONTH_NUMS = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

// Pepperfry's SOP computes everything directly off the two GSTR-1 reports — no SKU/Tally-ledger
// lookups are needed. These endpoints exist only because the generic agent workspace UI always
// renders "Upload SKU" / "Upload Ledger" buttons for every sales agent; kept as unused no-ops so
// those buttons don't 404 (same rationale as salesVareeController.js).
const uploadSkuMaster = async (req, res, next) => {
  try {
    const result = await salesService.uploadMasterData(req.params.brandId, req.params.agentId, 'sku', req.file.buffer);
    res.json({ message: 'SKU Master uploaded successfully', ...result });
  } catch (error) { next(error); }
};

const uploadLedgerMaster = async (req, res, next) => {
  try {
    const result = await salesService.uploadMasterData(req.params.brandId, req.params.agentId, 'ledger', req.file.buffer);
    res.json({ message: 'Ledger Master uploaded successfully', ...result });
  } catch (error) { next(error); }
};

const getMasterData = async (req, res, next) => {
  try {
    const result = await salesService.getMasterData(req.params.brandId, req.params.agentId);
    res.json(result);
  } catch (error) { next(error); }
};

function mapRowToSchema(row, monthName, year, filename) {
  return {
    year: parseInt(year, 10),
    month: MONTH_NUMS[monthName] || parseInt(monthName, 10) || 0,
    filename,

    order_id_sku: row.orderIdSku,
    state: row.state,
    gstin: row.gstin,
    document_type: row.documentType,
    taxability: row.taxability,
    supply_type: row.supplyType,
    gstin_of_recipient: row.gstinRecipient,
    recipient_state: row.recipientState,
    name_of_recipient: row.nameOfRecipient,
    invoice_number: row.invoiceNumber,
    invoice_date: row.invoiceDate,
    invoice_value: row.invoiceValue,
    total_discount: row.totalDiscount,
    item_code: row.itemCode,
    category: row.category,
    hsn_sac: row.hsnSac,
    product_description: row.productDescription,
    invoiced_quantity: row.invoicedQuantity,
    sale_price: row.salePrice,
    merchant_discount: row.merchantDiscount,
    taxable_value: row.taxableValue,
    tax_rate: row.taxRate,
    igst: row.igst,
    cgst: row.cgst,
    sgst: row.sgst,
    ship_from_state: row.shipFromState,
    ship_to_state: row.shipToState,
    tcs_amount: row.tcsAmount,
    status_of_delivery: row.statusOfDelivery,
    commission_amount: row.commissionAmount,
    commission_invoice_no: row.commissionInvoiceNo,
    return_date: row.returnDate,
    sale_type: row.saleType,           // B2B / B2C
    transaction_type: row.transactionType, // Sale / Return
  };
}

function computeSummary(records) {
  let qty = 0, taxable = 0, igst = 0, cgst = 0, sgst = 0;
  records.forEach((r) => {
    qty += Number(r.invoicedQuantity || 0);
    taxable += Number(r.taxableValue || 0);
    igst += Number(r.igst || 0);
    cgst += Number(r.cgst || 0);
    sgst += Number(r.sgst || 0);
  });
  return {
    quantity: Math.round(qty),
    taxableValue: Number(taxable.toFixed(2)),
    igst: Number(igst.toFixed(2)),
    cgst: Number(cgst.toFixed(2)),
    sgst: Number(sgst.toFixed(2)),
  };
}

const generatePreview = async (req, res, next) => {
  try {
    const { brandId, agentId } = req.params;
    const { month, year } = req.body;
    if (!month || !year) return res.status(400).json({ error: 'month and year are required' });

    const salesBuffer = req.files && req.files.salesFile ? req.files.salesFile[0].buffer : null;
    const refundBuffer = req.files && req.files.refundFile ? req.files.refundFile[0].buffer : null;
    if (!salesBuffer || !refundBuffer) {
      return res.status(400).json({ error: 'Both salesFile (GSTR-1 Sales report) and refundFile (GSTR-1 Refunds report) are required' });
    }

    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);
    if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

    const result = await pepperfryProcessor(salesBuffer, refundBuffer, brand.name, `${month}-${year}`);
    if (!result || !result.processedData || result.processedData.length === 0) {
      return res.status(400).json({ error: 'No processable data found in the uploaded files' });
    }

    const brandDb = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const Model = getDynamicModel(brandDb, tableName, agent.columns);

    const taskId = uuidv4();
    const filename = `pepperfry_${brand.name}_${month}_${year}_${taskId}.xlsx`;
    const filepath = path.join(OUTPUT_DIR, filename);

    const dbRows = result.processedData.map((row) => mapRowToSchema(row, month, year, filename));
    const summary = computeSummary(result.processedData);

    setPending(taskId, { workbook: result.outputWorkbook, dbRows, filepath, filename, Model, agentType: 'pepperfry' });

    res.json({
      success: true,
      taskId,
      filename,
      rowCount: dbRows.length,
      summary: { workingFile: summary },
    });
  } catch (error) {
    console.error('Pepperfry Preview Error:', error);
    next(error);
  }
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
    deletePending(taskId);

    res.json({ success: true, message: 'Pepperfry working file committed successfully', filename, count: dbRows.length });
  } catch (error) {
    console.error('Pepperfry Commit Error:', error);
    next(error);
  }
};

const generateDiscard = async (req, res, next) => {
  try {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: 'taskId is required' });
    deletePending(taskId);
    res.json({ success: true, message: 'Generation discarded' });
  } catch (error) {
    console.error('Pepperfry Discard Error:', error);
    next(error);
  }
};

module.exports = {
  uploadSkuMaster,
  uploadLedgerMaster,
  getMasterData,
  generatePreview,
  generateCommit,
  generateDiscard,
};

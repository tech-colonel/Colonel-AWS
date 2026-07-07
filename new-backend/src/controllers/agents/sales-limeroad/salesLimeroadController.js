'use strict';
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const XLSX = require('xlsx-js-style');
const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { setPending, getPending, deletePending } = require('../../../services/pendingGenerationsStore');
const { limeroadProcessor } = require('../../../services/processors/limeroad/limeroadProcessor');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');
async function ensureDir() { await fs.ensureDir(OUTPUT_DIR); }

const MONTH_NUMS = {
  January:1, February:2, March:3, April:4, May:5, June:6,
  July:7, August:8, September:9, October:10, November:11, December:12,
};

function safeNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function mapRowToSchema(row, monthName, year, filename) {
  return {
    year:                     parseInt(year, 10),
    month:                    MONTH_NUMS[monthName] || parseInt(monthName, 10) || 0,
    filename,
    vendor_id:                String(row.vendorId || ''),
    event_type:               String(row.eventType || ''),
    vendor_name:              String(row.vendorName || ''),
    gstin:                    String(row.GSTIN || ''),
    invoice_id:               String(row.invoiceId || ''),
    invoice_date:             String(row.invoiceDate || ''),
    customer_name:            String(row.customerName || ''),
    customer_state:           String(row.customerState || ''),
    customer_pincode:         String(row.customerPincode || ''),
    vendor_state:             String(row.vendorState || ''),
    vendor_pincode:           String(row.vendorPincode || ''),
    sales_type:               String(row.salesType || ''),
    ecommerce_gstin:          String(row['E-CommerceGSTIN'] || ''),
    ecommerce_name:           String(row['E-CommerceName'] || ''),
    unique_item_id:           String(row.uniqueItemId || ''),
    vendor_style_code:        String(row.vendorStyleCode || ''),
    order_id:                 String(row.orderId || ''),
    sub_order_id:             String(row.suborderId || ''),
    hsn_code:                 String(row.hsnCode || ''),
    product_description:      String(row.productDescription || ''),
    quantity:                 safeNum(row.quantity),
    total_gst_rate:           safeNum(row.totalGSTRate),
    igst:                     safeNum(row.IGST),
    cgst:                     safeNum(row.CGST),
    sgst:                     safeNum(row.SGST),
    tax_amount_for_igst:      safeNum(row.taxAmountForIGST),
    tax_amount_for_cgst:      safeNum(row.taxAmountForCGST),
    tax_amount_for_sgst:      safeNum(row.taxAmountForSGST),
    item_taxable_amount:      safeNum(row.itemTaxableAmount),
    shipping_taxable_amount:  safeNum(row.shippingTaxableAmount),
    cod_taxable_amount:       safeNum(row.codTaxableAmount),
    total_supply_taxable_amount: safeNum(row.totalSupplyTaxableAmount),
    tcs_amount_for_igst:      safeNum(row.tcsAmountForIGST),
    tcs_amount_for_cgst:      safeNum(row.tcsAmountForCGST),
    tcs_amount_for_sgst:      safeNum(row.tcsAmountForSGST),
    invoice_value:            safeNum(row.invoiceValue),
    tax_amount:               safeNum(row.taxAmount),
    cess_amount:              safeNum(row.cessAmount),
    tds_amount:               safeNum(row.tdsAmount),
  };
}

const getMasterData = async (req, res, next) => {
  try {
    const result = await salesService.getMasterData(req.params.brandId, req.params.agentId);
    res.json(result);
  } catch (err) { next(err); }
};

const generatePreview = async (req, res, next) => {
  try {
    const { brandId, agentId } = req.params;
    const { month, year } = req.body;

    if (!month || !year)
      return res.status(400).json({ error: 'month and year are required' });

    const fileBuffer = req.file ? req.file.buffer : null;
    if (!fileBuffer)
      return res.status(400).json({ error: 'LimeRoad Payment Sale Return Report file is required' });

    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);
    if (!brand || !agent)
      return res.status(404).json({ error: 'Brand or Agent not found' });

    const result = limeroadProcessor(fileBuffer, month, year);
    if (!result || !result.processedRows || result.processedRows.length === 0)
      return res.status(400).json({ error: 'No processable data found in the uploaded file' });

    const brandDb   = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const Model     = getDynamicModel(brandDb, tableName, agent.columns);

    const taskId  = uuidv4();
    const filename = `limeroad_${brand.name}_${month}_${year}_${taskId}.xlsx`;
    const filepath = path.join(OUTPUT_DIR, filename);
    const dbRows  = result.processedRows.map(row => mapRowToSchema(row, month, year, filename));

    setPending(taskId, {
      agentType: 'limeroad',
      workbook:  result.outputWorkbook,
      dbRows,
      filepath,
      filename,
      Model,
    });

    res.json({
      success: true,
      taskId,
      filename,
      rowCount: dbRows.length,
      summary: result.summary,
      b2cPivotRows: result.b2cPivot.length,
      hsnPivotRows: result.hsnPivot.length,
    });
  } catch (err) { next(err); }
};

const generateCommit = async (req, res, next) => {
  try {
    const { taskId } = req.body;
    if (!taskId)
      return res.status(400).json({ error: 'taskId is required' });

    const pending = getPending(taskId);
    if (!pending)
      return res.status(404).json({ error: 'Preview expired or not found. Please re-generate.' });

    const { workbook, dbRows, filepath, filename, Model } = pending;

    await ensureDir();
    XLSX.writeFile(workbook, filepath);

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

    res.json({
      success: true,
      message: 'LimeRoad working file committed successfully',
      filename,
      count: dbRows.length,
    });
  } catch (err) { next(err); }
};

const generateDiscard = async (req, res, next) => {
  try {
    const { taskId } = req.body;
    if (!taskId)
      return res.status(400).json({ error: 'taskId is required' });
    deletePending(taskId);
    res.json({ success: true, message: 'Generation discarded' });
  } catch (err) { next(err); }
};

const uploadSkuMaster = async (req, res, next) => {
  try {
    const result = await salesService.uploadMasterData(
      req.params.brandId, req.params.agentId, 'sku', req.file.buffer
    );
    res.json({ message: 'SKU Master uploaded successfully', ...result });
  } catch (err) { next(err); }
};

const uploadLedgerMaster = async (req, res, next) => {
  try {
    const result = await salesService.uploadMasterData(
      req.params.brandId, req.params.agentId, 'ledger', req.file.buffer
    );
    res.json({ message: 'Ledger Master uploaded successfully', ...result });
  } catch (err) { next(err); }
};

module.exports = { getMasterData, uploadSkuMaster, uploadLedgerMaster, generatePreview, generateCommit, generateDiscard };

'use strict';

const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx-js-style');

const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { setPending, getPending, deletePending } = require('../../../services/pendingGenerationsStore');
const { meeshoProcessor } = require('../../../services/processors/meesho/meeshoProcessor');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');
async function ensureDir() { await fs.ensureDir(OUTPUT_DIR); }

const MONTH_NUMS = {
    January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
    July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};
const monthToNumber = (m) => MONTH_NUMS[m] || parseInt(m, 10) || 0;

const num = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(String(v).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
};

// ─── Master data (shared shape: Meesho Master.xlsx = States / Ledger / Invoice No.) ──
const getMasterData = async (req, res, next) => {
    try {
        const result = await salesService.getMasterData(req.params.brandId, req.params.agentId);
        res.json(result);
    } catch (err) { next(err); }
};

const uploadSkuMaster = async (req, res, next) => {
    try {
        const result = await salesService.uploadMasterData(
            req.params.brandId, req.params.agentId, 'sku', req.file.buffer,
        );
        res.json({ message: 'SKU Master uploaded successfully', ...result });
    } catch (err) { next(err); }
};

const uploadLedgerMaster = async (req, res, next) => {
    try {
        const result = await salesService.uploadMasterData(
            req.params.brandId, req.params.agentId, 'ledger', req.file.buffer,
        );
        res.json({ message: 'Ledger Master uploaded successfully', ...result });
    } catch (err) { next(err); }
};

// First worksheet of an uploaded workbook -> array of row objects.
function sheetToJson(buffer) {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
}

function mapRowToSchema(row, monthName, year, filename, inventoryType) {
    return {
        year: parseInt(year, 10) || null,
        month: monthToNumber(monthName),
        filename,
        inventory_type: inventoryType,

        source_file: row.file || '',
        selling_state: String(row['selling state'] || ''),

        identifier: String(row.identifier || ''),
        fg: String(row.FG || ''),
        sup_name: String(row.sup_name || ''),
        gstin: String(row.gstin || ''),
        sub_order_num: String(row.sub_order_num || ''),
        order_date: String(row.order_date || ''),
        hsn_code: String(row.hsn_code || ''),
        quantity: num(row.quantity),
        gst_rate: num(row.gst_rate),
        total_taxable_sale_value: num(row.total_taxable_sale_value),
        tax_amount: num(row.tax_amount),
        total_invoice_value: num(row.total_invoice_value),
        taxable_shipping: num(row.taxable_shipping),
        end_customer_state_new: String(row.end_customer_state_new || ''),
        enrollment_no: String(row.enrollment_no || ''),
        manifest_date: String(row.manifest_date || ''),
        cancel_return_date: String(row.cancel_return_date || ''),
        transaction_type: String(row.transaction_type || ''),
        eco_tcs_gstin: String(row.eco_tcs_gstin || ''),
        financial_year: String(row.financial_year || ''),
        month_number: String(row.month_number || ''),
        supplier_id: String(row.supplier_id || ''),

        party_name: String(row['Party Name'] || ''),
        invoice_no: String(row['Invoice No.'] || ''),

        final_igst_amount: num(row['Final IGST Amount']),
        final_cgst_amount: num(row['Final CGST Amount']),
        final_sgst_amount: num(row['Final SGST Amount']),
    };
}

// Shared prep for preview + direct generate.
async function build(req) {
    const { brandId, agentId } = req.params;
    const { month, year, inventory_type } = req.body;
    if (!month || !year) { const e = new Error('month and year are required'); e.status = 400; throw e; }
    const withInventory = String(inventory_type || '').toLowerCase() !== 'without';

    const salesUp = req.files && req.files.salesFile ? req.files.salesFile[0] : null;
    const returnUp = req.files && req.files.returnFile ? req.files.returnFile[0] : null;
    if (!salesUp || !returnUp) {
        const e = new Error('Both salesFile (tcs_sales) and returnFile (tcs_sales_return) are required');
        e.status = 400; throw e;
    }

    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);
    if (!brand || !agent) { const e = new Error('Brand or Agent not found'); e.status = 404; throw e; }

    const masterData = await salesService.getMasterData(brandId, agentId);

    const result = meeshoProcessor(
        sheetToJson(salesUp.buffer),
        sheetToJson(returnUp.buffer),
        {
            salesFileName: salesUp.originalname,
            returnFileName: returnUp.originalname,
            withInventory,
            skuJson: masterData.sku_master || [],
            ledgerJson: masterData.ledger_master || [],
            date: `${month}-${year}`,
        },
    );

    if (!result || !result.processedData || result.processedData.length === 0) {
        const e = new Error('No processable rows found in the uploaded files'); e.status = 400; throw e;
    }

    // With-inventory: block on SKU-master gaps unless the caller opts to proceed.
    if (result.missingMasterValues?.length > 0 && req.body.proceedWithoutMaster !== 'true') {
        const e = new Error('Missing master data values'); e.status = 400;
        e.payload = { missingMasterValues: result.missingMasterValues };
        throw e;
    }

    const brandDb = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const Model = getDynamicModel(brandDb, tableName, agent.columns);

    const inventoryType = withInventory ? 'With' : 'Without';
    const taskId = uuidv4();
    const filename = `meesho_${brand.name}_${month}_${year}_${taskId}.xlsx`;
    const filepath = path.join(OUTPUT_DIR, filename);
    const dbRows = result.processedData.map((r) => mapRowToSchema(r, month, year, filename, inventoryType));

    return { result, Model, taskId, filename, filepath, dbRows };
}

// ─── Two-phase: preview → commit / discard ────────────────────────────────────
const generatePreview = async (req, res, next) => {
    try {
        const { result, Model, taskId, filename, filepath, dbRows } = await build(req);
        setPending(taskId, {
            agentType: 'meesho',
            workbook: result.outputWorkbook,
            dbRows,
            filepath,
            filename,
            Model,
        });
        res.json({ success: true, taskId, filename, rowCount: dbRows.length, summary: result.summary });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message, ...(err.payload || {}) });
        console.error('Meesho Preview Error:', err);
        next(err);
    }
};

const generate = async (req, res, next) => {
    try {
        const { result, Model, filename, filepath, dbRows } = await build(req);
        await ensureDir();
        await Model.sync();
        await Model.bulkCreate(dbRows);
        XLSX.writeFile(result.outputWorkbook, filepath);
        res.json({
            success: true,
            message: 'Meesho working file generated successfully',
            data: { filename, count: dbRows.length },
            summary: result.summary,
        });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message, ...(err.payload || {}) });
        console.error('Meesho Generation Error:', err);
        next(err);
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
        await Model.sync();
        await Model.bulkCreate(dbRows);
        XLSX.writeFile(workbook, filepath);
        deletePending(taskId);

        res.json({ success: true, message: 'Meesho working file committed successfully', filename, count: dbRows.length });
    } catch (err) {
        console.error('Meesho Commit Error:', err);
        next(err);
    }
};

const generateDiscard = async (req, res, next) => {
    try {
        const { taskId } = req.body;
        if (!taskId) return res.status(400).json({ error: 'taskId is required' });
        deletePending(taskId);
        res.json({ success: true, message: 'Generation discarded' });
    } catch (err) {
        console.error('Meesho Discard Error:', err);
        next(err);
    }
};

module.exports = {
    getMasterData,
    uploadSkuMaster,
    uploadLedgerMaster,
    generate,
    generatePreview,
    generateCommit,
    generateDiscard,
};

const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { creadProcessor } = require('../../../services/processors/cread/creadProcessor');
const { setPending, getPending, deletePending } = require('../../../services/pendingGenerationsStore');

const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx-js-style');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');

async function ensureDir() {
    await fs.ensureDir(OUTPUT_DIR);
}

const monthToNumber = (monthName) => {
    const months = {
        'January': 1, 'February': 2, 'March': 3, 'April': 4, 'May': 5, 'June': 6,
        'July': 7, 'August': 8, 'September': 9, 'October': 10, 'November': 11, 'December': 12
    };
    return months[monthName] || parseInt(monthName) || 0;
};

const uploadSkuMaster = async (req, res, next) => {
    try {
        const result = await salesService.uploadMasterData(
            req.params.brandId,
            req.params.agentId,
            'sku',
            req.file.buffer
        );
        res.json({ message: 'SKU Master uploaded successfully', ...result });
    } catch (error) {
        next(error);
    }
};

const uploadLedgerMaster = async (req, res, next) => {
    try {
        const result = await salesService.uploadMasterData(
            req.params.brandId,
            req.params.agentId,
            'ledger',
            req.file.buffer
        );
        res.json({ message: 'Ledger Master uploaded successfully', ...result });
    } catch (error) {
        next(error);
    }
};

const getMasterData = async (req, res, next) => {
    try {
        const result = await salesService.getMasterData(
            req.params.brandId,
            req.params.agentId
        );
        res.json(result);
    } catch (error) {
        next(error);
    }
};

function safeNum(value) {
    if (value === null || value === undefined || value === '') return 0;
    const num = Number(value);
    return isNaN(num) ? 0 : num;
}

const mapRowToCreadSchema = (row, month, year, filename) => ({
    year: parseInt(year),
    month: monthToNumber(month),
    filename,

    order_date: row['Order Date']
        ? (row['Order Date'] instanceof Date
            ? row['Order Date'].toISOString().split('T')[0]
            : String(row['Order Date']))
        : null,
    reference_code: String(row['Reference Code'] || ''),
    ee_invoice_no: String(row['EE Invoice No'] || ''),
    order_status: String(row['Order Status'] || ''),
    shipping_status: String(row['Shipping Status'] || ''),
    awb_no: String(row['AWB No'] || ''),
    suborder_quantity: safeNum(row['Suborder Quantity']),
    item_quantity: safeNum(row['Item Quantity']),
    sku: String(row['SKU'] || ''),
    final_sku: String(row['Final SKU'] || ''),
    mis_sku: String(row['MIS SKU'] || ''),
    shipping_zip_code: String(row['Shipping Zip Code'] || ''),
    shipping_state: String(row['Shipping States'] || ''),
    party_name: String(row['Party Name'] || ''),
    invoice_no: String(row['Invoice No.'] || ''),
    order_invoice_amount: safeNum(row['Order Invoice Amount']),
    tax: safeNum(row['Tax']),
    item_price_ex_tax: safeNum(row['Item Price Excluding Tax']),
    cred_status: String(row['Cred Status'] || ''),
    taxable_amount: safeNum(row['Taxable Amount']),
    cgst: safeNum(row['CGST '] ?? row['CGST'] ?? 0),
    sgst: safeNum(row['SGST']),
    igst: safeNum(row['IGST']),
    final_status: String(row['Final Status'] || '')
});

const computeSummary = (rows) => {
    let qty = 0, taxable = 0, igst = 0, cgst = 0, sgst = 0;
    rows.forEach(row => {
        qty     += safeNum(row['Suborder Quantity'] ?? row.suborder_quantity ?? 0);
        taxable += safeNum(row['Taxable Amount'] ?? row.taxable_amount ?? 0);
        igst    += safeNum(row['IGST'] ?? row.igst ?? 0);
        cgst    += safeNum(row['CGST '] ?? row['CGST'] ?? row.cgst ?? 0);
        sgst    += safeNum(row['SGST'] ?? row.sgst ?? 0);
    });
    return {
        quantity: Math.round(qty),
        taxableValue: Number(taxable.toFixed(2)),
        igst: Number(igst.toFixed(2)),
        cgst: Number(cgst.toFixed(2)),
        sgst: Number(sgst.toFixed(2))
    };
};

const computePivotSummary = (rows) => {
    let qty = 0, taxable = 0, igst = 0, cgst = 0, sgst = 0;
    rows.forEach(row => {
        qty     += safeNum(row['Sum of Suborder Quantity'] ?? 0);
        taxable += safeNum(row['Sum of Taxable Amount'] ?? 0);
        igst    += safeNum(row['Sum of IGST'] ?? 0);
        cgst    += safeNum(row['Sum of CGST '] ?? row['Sum of CGST'] ?? 0);
        sgst    += safeNum(row['Sum of SGST'] ?? 0);
    });
    return {
        quantity: Math.round(qty),
        taxableValue: Number(taxable.toFixed(2)),
        igst: Number(igst.toFixed(2)),
        cgst: Number(cgst.toFixed(2)),
        sgst: Number(sgst.toFixed(2))
    };
};

// ─── Phase 1: generatePreview ────────────────────────────────────────────────
const generatePreview = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const { month, year, inventory_type, selling_state } = req.body;
        const useInventory = inventory_type !== 'Without';

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const masterData = await salesService.getMasterData(brandId, agentId);

        if (!req.file && (!req.files || !req.files.file)) {
            return res.status(400).json({ error: 'cread raw report file is required' });
        }
        const fileBuffer = req.file ? req.file.buffer : req.files.file[0].buffer;

        const processedData = await creadProcessor(
            fileBuffer,
            masterData.sku_master,
            masterData.ledger_master,
            brand.name,
            month,
            year,
            selling_state || '',
            useInventory
        );

        if (!processedData || !processedData.workingData) {
            return res.status(400).json({ error: 'Processor Error: No data returned' });
        }

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const taskId = uuidv4();
        const filename = `cread_${brand.name}_${month}_${year}_${taskId}.xlsx`;
        const processPath = path.join(OUTPUT_DIR, filename);

        const dbRows = processedData.workingData.map(row =>
            mapRowToCreadSchema(row, month, year, filename)
        );

        const workingSummary = computeSummary(processedData.workingData);
        const pivotSummary = processedData.pivotData ? computePivotSummary(processedData.pivotData) : null;

        setPending(taskId, {
            agentType: 'cread',
            workbook: processedData.outputWorkbook,
            finalData: dbRows,
            processFile: filename,
            processPath,
            Model
        });

        res.json({
            success: true,
            taskId,
            rowCount: dbRows.length,
            summary: {
                workingFile: workingSummary,
                pivotFile: pivotSummary
            }
        });
    } catch (error) {
        console.error('cread Preview Error:', error);
        next(error);
    }
};

// ─── Phase 2a: generateCommit ────────────────────────────────────────────────
const generateCommit = async (req, res, next) => {
    try {
        const { taskId } = req.body;
        if (!taskId) return res.status(400).json({ error: 'taskId is required' });

        const pending = getPending(taskId);
        if (!pending) return res.status(404).json({
            error: 'No pending generation found. It may have expired. Please regenerate.'
        });

        const { workbook, finalData, processFile, processPath, Model } = pending;

        await ensureDir();
        await Model.sync();
        await Model.bulkCreate(finalData);

        XLSX.writeFile(workbook, processPath);
        deletePending(taskId);

        res.json({
            success: true,
            message: 'cread file generated and saved successfully',
            data: { filename: processFile, count: finalData.length }
        });
    } catch (error) {
        console.error('cread Commit Error:', error);
        next(error);
    }
};

// ─── Phase 2b: generateDiscard ───────────────────────────────────────────────
const generateDiscard = async (req, res, next) => {
    try {
        const { taskId } = req.body;
        if (!taskId) return res.status(400).json({ error: 'taskId is required' });
        deletePending(taskId);
        res.json({ success: true, message: 'Generation discarded successfully' });
    } catch (error) {
        console.error('cread Discard Error:', error);
        next(error);
    }
};

// ─── Legacy single-phase generate (kept for compatibility) ───────────────────
const generate = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const { month, year, inventory_type, selling_state } = req.body;
        const useInventory = inventory_type !== 'Without';

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const masterData = await salesService.getMasterData(brandId, agentId);

        if (!req.file && (!req.files || !req.files.file)) {
            return res.status(400).json({ error: 'cread raw report file is required' });
        }
        const fileBuffer = req.file ? req.file.buffer : req.files.file[0].buffer;

        const processedData = await creadProcessor(
            fileBuffer,
            masterData.sku_master,
            masterData.ledger_master,
            brand.name,
            month,
            year,
            selling_state || '',
            useInventory
        );

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        await ensureDir();
        const id = uuidv4();
        const filename = `cread_${brand.name}_${month}_${year}_${id}.xlsx`;
        const filepath = path.join(OUTPUT_DIR, filename);

        const dbRows = processedData.workingData.map(row =>
            mapRowToCreadSchema(row, month, year, filename)
        );

        await Model.sync();
        await Model.bulkCreate(dbRows);

        XLSX.writeFile(processedData.outputWorkbook, filepath);

        res.json({
            success: true,
            message: 'cread working file generated successfully',
            data: { filename, count: dbRows.length }
        });
    } catch (error) {
        console.error('cread Generation Error:', error);
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

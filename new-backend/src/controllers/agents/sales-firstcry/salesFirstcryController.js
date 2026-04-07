const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { firstcryProcessor } = require('../../../services/processors/firstcry/firstcryProcessor');
const { setPending, getPending, deletePending } = require('../../../services/pendingGenerationsStore');

const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx-js-style');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');

/**
 * Ensure output directory exists
 */
async function ensureDir() {
    await fs.ensureDir(OUTPUT_DIR);
}

/**
 * Safe number conversion
 */
function safeNum(value) {
    if (value === null || value === undefined || value === '') return 0;
    const num = Number(value);
    return isNaN(num) ? 0 : num;
}

/**
 * Convert month name to number
 */
const monthToNumber = (monthName) => {
    const months = {
        'January': 1, 'February': 2, 'March': 3, 'April': 4, 'May': 5, 'June': 6,
        'July': 7, 'August': 8, 'September': 9, 'October': 10, 'November': 11, 'December': 12
    };
    return months[monthName] || parseInt(monthName) || 0;
};

/**
 * Upload SKU Master
 */
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

/**
 * Upload Ledger Master
 */
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

/**
 * Get Master Data
 */
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

/**
 * Safe date conversion for DB (returns JS Date or null)
 */
function safeDate(value) {
    if (!value) return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

    // Try to parse if it's a string/number
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d;

    return null;
}

/**
 * Map Processor Row to FirstCry Database Schema
 * Based on firstcryProcessor return data and seed-sales-firstcry.js
 */
const mapRowToFirstcrySchema = (row, month, year, filename) => ({
    year: parseInt(year),
    month: monthToNumber(month),
    filename: filename,

    // Core order info
    fc_ref_no: String(row['FC Ref No.'] || row['FC Ref No'] || row['FC Reference No'] || ''),
    order_id: String(row['Order ID'] || row['Order Id'] || ''),

    // Dates
    order_date: safeDate(row['Order Date']),
    shipping_date: safeDate(row['Shipping Date'] || row['Shipping date']),
    delivery_date: safeDate(row['Delivery date'] || row['Delivery Date']),
    sr_rto_date: safeDate(row['SR/RTO date'] || row['SR RTO date'] || row['SR/RTO Date']),
    invoice_date: safeDate(row['Invoice Date'] || row['Invoice date']),

    // Product info
    product_id: String(row['Product ID'] || row['ProductID'] || row['Product Id'] || ''),
    hsn_code: String(row['HSN Code'] || row['HSN'] || ''),
    product_name: String(row['FG'] || row['Item Name'] || row['Product Name'] || ''),

    // Pricing & qty
    quantity: safeNum(row['Qty'] || row['Quantity'] || 0),
    mrp: safeNum(row['MRP'] || 0),
    base_cost: safeNum(row['Rate'] || row['Base Cost'] || 0),
    gross_amount: safeNum(row['Gross Amount'] || 0),

    // Tax
    cgst_percent: safeNum(row['CGST %'] || 0),
    cgst_amount: safeNum(row['CGST Amount'] || 0),
    sgst_percent: safeNum(row['SGST %'] || 0),
    sgst_amount: safeNum(row['SGST Amount'] || 0),

    total_amount: safeNum(row['Total'] || 0),

    // Invoice & finance refs
    vendor_invoice_no: String(row['Vendor Invoice no.'] || row['Vendor Invoice No.'] || ''),
    payment_advice_no: String(row['Payment Advice No.'] || ''),
    debit_note_no: String(row['Debit note no.'] || row['Debit Note No.'] || ''),

    // SR (Sales Return) - Populated if it's a negative row and identifies as SR
    // Assuming for now these are just mapped to main fields if negated
    sr_qty: 0,
    sr_total_amount: 0,
    sr_gross_amount: 0,

    // RTO (Return to Origin)
    rto_qty: 0,
    rto_total_amount: 0,
    rto_gross_amount: 0
});

/**
 * Generate FirstCry Working File
 */
const generate = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const { month, year, inventory_type } = req.body;
        const useInventory = inventory_type !== 'Without';

        // 1. Fetch Master Data
        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const masterData = await salesService.getMasterData(brandId, agentId);

        // 2. Get Raw File Buffer
        if (!req.file && (!req.files || !req.files.file)) {
            return res.status(400).json({ error: 'FirstCry raw report file is required' });
        }
        const fileBuffer = req.file ? req.file.buffer : req.files.file[0].buffer;

        // 3. Call Processor
        const processedData = await firstcryProcessor(
            fileBuffer,
            masterData.sku_master,
            masterData.ledger_master,
            brand.name,
            `${month}-${year}`,
            useInventory
        );

        // 4. Save to Database
        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        await ensureDir();
        const id = uuidv4();
        const filename = `firstcry_${brand.name}_${month}_${year}_${id}.xlsx`;
        const filepath = path.join(OUTPUT_DIR, filename);

        // Map processed rows for database storage
        const dbRows = processedData.processedData.map(row =>
            mapRowToFirstcrySchema(row, month, year, filename)
        );

        await Model.sync();
        await Model.bulkCreate(dbRows);

        // 5. Save Excel File
        const outputBuffer = XLSX.write(processedData.outputWorkbook, {
            type: 'buffer',
            bookType: 'xlsx'
        });
        await fs.writeFile(filepath, outputBuffer);

        res.json({
            success: true,
            message: 'FirstCry working file generated successfully',
            data: { filename, count: dbRows.length }
        });

    } catch (error) {
        console.error('FirstCry Generation Error:', error);
        next(error);
    }
};

// ─── Phase 1: generatePreview ──────────────────────────────────────────────────
const generatePreview = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const { month, year, inventory_type } = req.body;
        const useInventory = inventory_type !== 'Without';

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const masterData = await salesService.getMasterData(brandId, agentId);

        if (!req.file && (!req.files || !req.files.file)) {
            return res.status(400).json({ error: 'FirstCry raw report file is required' });
        }
        const fileBuffer = req.file ? req.file.buffer : req.files.file[0].buffer;

        const processedData = await firstcryProcessor(
            fileBuffer,
            masterData.sku_master,
            masterData.ledger_master,
            brand.name,
            `${month}-${year}`,
            useInventory
        );

        if (!processedData || !processedData.processedData) {
            return res.status(400).json({ error: 'Processor Error: No data returned' });
        }

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const taskId = uuidv4();
        const filename = `firstcry_${brand.name}_${month}_${year}_${taskId}.xlsx`;
        const processPath = path.join(OUTPUT_DIR, filename);

        const dbRows = processedData.processedData.map(row =>
            mapRowToFirstcrySchema(row, month, year, filename)
        );

        const computeFirstcrySummary = (rows) => {
            let qty = 0, taxable = 0, cgst = 0, sgst = 0, igst = 0;
            rows.forEach(row => {
                qty     += Number(row.Quantity || row.quantity || row.Qty || 0);
                taxable += Number(row['Taxable value'] || row.taxable_value || row['Gross Amount'] || 0);
                cgst    += Number(row['CGST Amount'] || row.cgst_amount || 0);
                sgst    += Number(row['SGST Amount'] || row.sgst_amount || 0);
                igst    += Number(row['IGST Amount'] || row.igst_amount || 0); // Note: Firstcry raw might not have IGST explicit, but workingSheetData does
            });
            return {
                quantity: Math.round(qty),
                taxableValue: Number(taxable.toFixed(2)),
                cgst: Number(cgst.toFixed(2)),
                sgst: Number(sgst.toFixed(2)),
                igst: Number(igst.toFixed(2))
            };
        };

        const workingSummary = computeFirstcrySummary(processedData.workingSheetData || processedData.processedData);

        setPending(taskId, {
            agentType: 'firstcry',
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
                pivotFile: null // FirstCry might not have a pivot file
            }
        });
    } catch (error) {
        console.error('FirstCry Preview Error:', error);
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

        const outputBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        await fs.writeFile(processPath, outputBuffer);
        
        deletePending(taskId);

        res.json({
            success: true,
            message: 'FirstCry file generated and saved successfully',
            data: { filename: processFile, count: finalData.length }
        });
    } catch (error) {
        console.error('FirstCry Commit Error:', error);
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
        console.error('FirstCry Discard Error:', error);
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

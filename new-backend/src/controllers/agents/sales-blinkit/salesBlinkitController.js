const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { blinkitProcessor } = require('../../../services/processors/blinkit/blinkitProcessor');
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
 * Safe number conversion
 */
function safeNum(value) {
    if (value === null || value === undefined || value === '') return 0;
    const num = Number(value);
    return isNaN(num) ? 0 : num;
}

/**
 * Map Processor Row to Blinkit Database Schema
 * Based on blinkitProcessor return data and seed-sales-blinkit.js
 */
const mapRowToBlinkitSchema = (row, month, year, filename) => ({
    year: parseInt(year),
    month: monthToNumber(month),
    filename: filename,

    // Core order info
    order_id: String(row['Order ID'] || row['Order ID'] || ''),
    order_date: row['Order Date'] || null,
    item_id: String(row['Item ID'] || row['Item ID'] || ''),

    // Product details
    product_name: String(row['Item Name'] || row['Product Name'] || row['Item Name'] || ''),
    brand_name: String(row['Brand Name'] || row['Brand Name'] || ''),
    upc: String(row['UPC'] || row['upc'] || ''),
    variant_description: String(row['Variant Description'] || row['Variant Description'] || ''),

    // Category mapping
    category_mapping: String(row['Category Mapping'] || row['Category Mapping'] || ''),
    business_category: String(row['Business Category'] || row['Business Category'] || ''),

    // Supply details
    supply_city: String(row['Supply City'] || row['Supply City'] || ''),
    supply_state: String(row['Supply State'] || row['Supply State'] || ''),
    supply_state_gst: String(row['Supply State GST'] || row['Supply State GST'] || ''),

    // Customer details
    customer_city: String(row['Customer City'] || row['Customer City'] || ''),
    customer_state: String(row['Customer State'] || row['Customer State'] || ''),

    // Order status
    order_status: String(row['Order Status'] || row['Order Status'] || ''),

    // Tax info
    hsn_code: String(row['HSN Code'] || row['HSN Code'] || ''),
    igst_percent: safeNum(row['IGST(%)'] || row['IGST (%)'] || 0),
    cgst_percent: safeNum(row['CGST(%)'] || row['CGST (%)'] || 0),
    sgst_percent: safeNum(row['SGST(%)'] || row['SGST (%)'] || 0),
    cess_percent: safeNum(row['Cess (%)'] || row['Cess(%)'] || 0),

    // Quantity & pricing
    quantity: safeNum(row['Quantity'] || row['Quantity'] || 0),
    mrp: safeNum(row['MRP'] || row['MRP'] || 0),
    selling_price: safeNum(row['Selling Price (Rs)'] || row['Selling Price'] || 0),

    // Tax values
    igst_value: safeNum(row['IGST Value'] || row['IGST Value'] || 0),
    cgst_value: safeNum(row['CGST Value'] || row['CGST Value'] || 0),
    sgst_value: safeNum(row['SGST Value'] || row['SGST Value'] || 0),
    cess_value: safeNum(row['Cess Value'] || row['Cess Value'] || 0),
    total_tax: safeNum(row['Total Tax'] || row['Total Tax'] || 0),

    // Totals
    total_gross_bill_amount: safeNum(row['Total Gross Bill Amount'] || row['Total Gross Bill Amount'] || 0),
    gst_rate: safeNum(row['GST Rate'] || row['GST Rate'] || 0),
    taxable_value: safeNum(row['Taxable value'] || row['Taxable value'] || 0),
    fg: String(row['FG'] || '')
});

/**
 * Generate Blinkit Working File
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
            return res.status(400).json({ error: 'Blinkit raw report file is required' });
        }
        const fileBuffer = req.file ? req.file.buffer : req.files.file[0].buffer;

        // 3. Call Processor
        const processedData = await blinkitProcessor(
            fileBuffer,
            masterData.sku_master,
            masterData.ledger_master, // Corrected from state_config
            brand.name,
            `${month}-${year}`,
            useInventory
        );

        if (processedData.missingMasterValues?.length > 0 && req.body.proceedWithoutMaster !== 'true') {
            return res.status(400).json({ error: 'Missing master data values', missingMasterValues: processedData.missingMasterValues });
        }

        // 4. Save to Database
        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        await ensureDir();
        const id = uuidv4();
        const filename = `blinkit_${brand.name}_${month}_${year}_${id}.xlsx`;
        const filepath = path.join(OUTPUT_DIR, filename);

        // Map processed rows for database storage
        // processedData.salesReportData contains the detailed rows
        const dbRows = processedData.salesReportData.map(row =>
            mapRowToBlinkitSchema(row, month, year, filename)
        );

        await Model.sync();
        await Model.bulkCreate(dbRows);

        // 5. Save Excel File
        XLSX.writeFile(processedData.outputWorkbook, filepath);

        res.json({
            success: true,
            message: 'Blinkit working file generated successfully',
            data: { filename, count: dbRows.length }
        });

    } catch (error) {
        console.error('Blinkit Generation Error:', error);
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
            return res.status(400).json({ error: 'Blinkit raw report file is required' });
        }
        const fileBuffer = req.file ? req.file.buffer : req.files.file[0].buffer;

        const processedData = await blinkitProcessor(
            fileBuffer,
            masterData.sku_master,
            masterData.ledger_master,
            brand.name,
            `${month}-${year}`,
            useInventory
        );

        if (!processedData || !processedData.salesReportData) {
            return res.status(400).json({ error: 'Processor Error: No data returned' });
        }

        if (processedData.missingMasterValues?.length > 0 && req.body.proceedWithoutMaster !== 'true') {
            return res.status(400).json({ error: 'Missing master data values', missingMasterValues: processedData.missingMasterValues });
        }

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const taskId = uuidv4();
        const filename = `blinkit_${brand.name}_${month}_${year}_${taskId}.xlsx`;
        const processPath = path.join(OUTPUT_DIR, filename);

        const dbRows = processedData.salesReportData.map(row =>
            mapRowToBlinkitSchema(row, month, year, filename)
        );

        const computeBlinkitSummary = (rows) => {
            let qty = 0, taxable = 0, cgst = 0, sgst = 0, igst = 0;
            rows.forEach(row => {
                qty     += Number(row.Quantity || row.quantity || 0);
                taxable += Number(row['Taxable value'] || row.taxable_value || 0);
                cgst    += Number(row['CGST Value'] || row.cgst_value || 0);
                sgst    += Number(row['SGST Value'] || row.sgst_value || 0);
                igst    += Number(row['IGST Value'] || row.igst_value || 0);
            });
            return {
                quantity: Math.round(qty),
                taxableValue: Number(taxable.toFixed(2)),
                cgst: Number(cgst.toFixed(2)),
                sgst: Number(sgst.toFixed(2)),
                igst: Number(igst.toFixed(2))
            };
        };

        const computeBlinkitPivotSummary = (rows) => {
            let taxable = 0, cgst = 0, sgst = 0, igst = 0;
            rows.forEach(row => {
                taxable += Number(row['Sum of Taxable Value'] || 0);
                cgst    += Number(row['Sum of CGST Value'] || 0);
                sgst    += Number(row['Sum of SGST Value'] || 0);
                igst    += Number(row['Sum of IGST Value'] || 0);
            });
            return {
                quantity: 0, // Pivot doesn't natively support quantity in the same way
                taxableValue: Number(taxable.toFixed(2)),
                cgst: Number(cgst.toFixed(2)),
                sgst: Number(sgst.toFixed(2)),
                igst: Number(igst.toFixed(2))
            };
        };

        const workingSummary = computeBlinkitSummary(processedData.salesReportData);
        let pivotSummary = null;
        if (processedData.gtReportData) {
            pivotSummary = computeBlinkitPivotSummary(processedData.gtReportData);
        }

        setPending(taskId, {
            agentType: 'blinkit',
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
        console.error('Blinkit Preview Error:', error);
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
            message: 'Blinkit file generated and saved successfully',
            data: { filename: processFile, count: finalData.length }
        });
    } catch (error) {
        console.error('Blinkit Commit Error:', error);
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
        console.error('Blinkit Discard Error:', error);
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

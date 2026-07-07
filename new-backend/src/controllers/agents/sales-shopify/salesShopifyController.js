const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { shopifyProcessor } = require('../../../services/processors/shopify/shopifyProcessor');
const { setPending, getPending, deletePending, computeSummary } = require('../../../services/pendingGenerationsStore');

const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const XLSX = require('exceljs'); // Using exceljs for saving workbook as per processor

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
 * Map Processor Row to Shopify Database Schema
 * Based on shopify schema in seed-sales-shopify.js
 */
const mapRowToShopifySchema = (row, month, year, filename) => ({
    year: parseInt(year),
    month: monthToNumber(month),
    filename: filename,
    date: row.date || row['Date'] || null,

    // Raw + Business Columns
    day: row.day || row['Day'] || null,
    sales: String(row.sales || row['Sales'] || ''),

    product_variant_sku: String(row.product_variant_sku || row['Product Variant SKU'] || ''),
    fg: String(row.fg || row['FG'] || ''),

    product_variant_id: String(row.product_variant_id || row['Product Variant ID'] || ''),
    product_variant_title: String(row.product_variant_title || row['Product Variant Title'] || ''),

    shipping_region: String(row.shipping_region || row['Shipping Region'] || ''),
    billing_region: String(row.billing_region || row['Billing Region'] || ''),

    tally_ledger: String(row.tally_ledger || row['Tally Ledger'] || ''),
    sales_ledger: String(row.sales_ledger || row['Sales Ledger'] || ''),
    invoice_number: String(row.invoice_number || row['Invoice Number'] || row['Invoice No'] || ''),

    customer_name: String(row.customer_name || row['Customer Name'] || ''),
    order_fulfillment_status: String(row.order_fulfillment_status || row['Order Fulfillment Status'] || ''),

    product_id: String(row.product_id || row['Product ID'] || ''),
    product_title: String(row.product_title || row['Product Title'] || ''),
    order_id: String(row.order_id || row['Order ID'] || ''),

    billing_city: String(row.billing_city || row['Billing City'] || ''),
    shipping_city: String(row.shipping_city || row['Shipping City'] || ''),

    // Financial Columns
    gross_sales: safeNum(row.gross_sales || row['Gross Sales']),
    discounts: safeNum(row.discounts || row['Discounts']),
    returns: safeNum(row.returns || row['Returns']),
    net_sales: safeNum(row.net_sales || row['Net Sales']),

    shipping_charges: safeNum(row.shipping_charges || row['Shipping Charges'] || row['Shipping']),
    return_fees: safeNum(row.return_fees || row['Return Fees']),
    taxes: safeNum(row.taxes || row['Taxes']),
    total_sales: safeNum(row.total_sales || row['Total Sales']),

    // Quantity Columns
    quantity_returned: safeNum(row.quantity_returned || row['Quantity Returned'] || 0),
    quantity_ordered: safeNum(row.quantity_ordered || row['Quantity Ordered'] || 0),
    quantity_ordered_per_order: safeNum(row.quantity_ordered_per_order || row['Quantity Ordered Per Order'] || 0),
    final_qty: safeNum(row.final_qty || row['Final QTY'] || row['Final Quantity'] || 0),

    // GST Columns
    gst_rate: safeNum(row.gst_rate || row['GST Rate'] || 0),
    taxable_value: safeNum(row.taxable_value || row['Taxable Value'] || 0),

    igst: safeNum(row.igst || row['IGST'] || 0),
    cgst: safeNum(row.cgst || row['CGST'] || 0),
    sgst: safeNum(row.sgst || row['SGST'] || 0)
});

/**
 * Generate Shopify Working File (Legacy Single Phase)
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
            return res.status(400).json({ error: 'Shopify raw report file is required' });
        }
        const fileBuffer = req.file ? req.file.buffer : req.files.file[0].buffer;

        // 3. Call Processor
        const processedData = await shopifyProcessor(
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
        const filename = `shopify_${brand.name}_${month}_${year}_${id}.xlsx`;
        const filepath = path.join(OUTPUT_DIR, filename);

        // Map processed rows for database storage
        const dbRows = processedData.salesReportData.map(row =>
            mapRowToShopifySchema(row, month, year, filename)
        );

        await Model.sync();
        await Model.bulkCreate(dbRows);

        // 5. Save Excel File
        if (processedData.outputWorkbook) {
            await processedData.outputWorkbook.xlsx.writeFile(filepath);
        }

        res.json({
            success: true,
            message: 'Shopify working file generated successfully',
            data: { filename, count: dbRows.length }
        });

    } catch (error) {
        console.error('Shopify Generation Error:', error);
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
            return res.status(400).json({ error: 'Shopify raw report file is required' });
        }
        const fileBuffer = req.file ? req.file.buffer : req.files.file[0].buffer;

        const processedData = await shopifyProcessor(
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

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const taskId = uuidv4();
        const filename = `shopify_${brand.name}_${month}_${year}_${taskId}.xlsx`;
        const processPath = path.join(OUTPUT_DIR, filename);

        const dbRows = processedData.salesReportData.map(row =>
            mapRowToShopifySchema(row, month, year, filename)
        );

        const computeShopifySummary = (rows) => {
            let qty = 0, taxable = 0, cgst = 0, sgst = 0, igst = 0;
            rows.forEach(row => {
                qty     += safeNum(row['final_qty'] || row['Final QTY'] || 0);
                taxable += safeNum(row['taxable_value'] || row['Taxable Value'] || 0);
                cgst    += safeNum(row['cgst'] || row['CGST'] || 0);
                sgst    += safeNum(row['sgst'] || row['SGST'] || 0);
                igst    += safeNum(row['igst'] || row['IGST'] || 0);
            });
            return {
                quantity: Math.round(qty),
                taxableValue: Number(taxable.toFixed(2)),
                cgst: Number(cgst.toFixed(2)),
                sgst: Number(sgst.toFixed(2)),
                igst: Number(igst.toFixed(2))
            };
        };

        const workingSummary = computeShopifySummary(processedData.salesReportData);

        setPending(taskId, {
            agentType: 'shopify',
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
                pivotFile: null // Implement if Shopify has a pivot summary
            }
        });
    } catch (error) {
        console.error('Shopify Preview Error:', error);
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

        // fire-and-forget: record run for admin analytics (never blocks/breaks the agent)
        try {
            const { recordAgentRun } = require('../../../services/agentRunTracker');
            recordAgentRun(Model.sequelize, {
                brandId: req.params.brandId,
                agentType: Model.tableName,
                month: (finalData && finalData[0] && finalData[0].month) || null,
                year: (finalData && finalData[0] && finalData[0].year) || null,
                totalRows: (finalData && finalData.length) || 0,
                outputFileId: (typeof processFile !== 'undefined' ? processFile : null),
                createdBy: (req.user && req.user.id) || null,
            });
        } catch (e) { /* tracking must never break the agent */ }

        if (workbook) {
            await workbook.xlsx.writeFile(processPath);
        }
        deletePending(taskId);

        res.json({
            success: true,
            message: 'Shopify file generated and saved successfully',
            data: { filename: processFile, count: finalData.length }
        });
    } catch (error) {
        console.error('Shopify Commit Error:', error);
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
        console.error('Shopify Discard Error:', error);
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

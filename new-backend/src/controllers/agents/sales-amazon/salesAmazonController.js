const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');

const { amazonB2BProcessor } = require('../../../services/processors/amazon/amazonB2BProcessor');
const { amazonB2CProcessor } = require('../../../services/processors/amazon/amazonB2CProcessor');

// 📦 Shared agent-agnostic store (also used by Flipkart, Myntra, etc. controllers)
const { setPending, getPending, deletePending, computeSummary } = require('../../../services/pendingGenerationsStore');

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');

// ── In-memory store for pending (unconfirmed) generations ─────────────────────
// key: taskId (uuid)  value: { workbook, finalData, processFile, processPath, summary }
const pendingGenerations = new Map();

// Auto-cleanup after 30 minutes so RAM doesn't pile up
const PENDING_TTL_MS = 30 * 60 * 1000;

/**
 * Ensure output directory exists
 */
async function ensureDir() {
    await fs.ensureDir(OUTPUT_DIR);
}

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

        res.json({
            message: 'SKU Master uploaded successfully',
            ...result
        });
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

        res.json({
            message: 'Ledger Master uploaded successfully',
            ...result
        });
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
 * Generate Amazon Working File
 */

const mapRowToAmazonSchema = (row, fileType, useInventory) => ({
    // basic info
    seller_gstin: row['Seller Gstin'],
    invoice_number: row['Invoice Number'],
    invoice_date: row['Invoice Date'],
    transaction_type: row['Transaction Type'],
    order_id: row['Order Id'],
    shipment_id: row['Shipment Id'],
    shipment_date: row['Shipment Date'],
    order_date: row['Order Date'],
    shipment_item_id: row['Shipment Item Id'],
    quantity: row['Quantity'],

    // product
    item_description: row['Item Description'],
    asin: row['Asin'],
    hsn_sac: row['Hsn Sac'],
    sku: row['Sku'],
    fg: row['FG'],
    product_tax_code: row['Product Tax Code'],

    // location
    bill_from_city: row['Bill From City'],
    bill_from_state: row['Bill From State'],
    bill_from_country: row['Bill From Country'],
    bill_from_postal_code: row['Bill From Postal Code'],

    ship_from_city: row['Ship From City'],
    ship_from_state: row['Ship From State'],
    ship_from_country: row['Ship From Country'],
    ship_from_postal_code: row['Ship From Postal Code'],

    ship_to_city: row['Ship To City'],
    ship_to_state: row['Ship To State'],
    ship_to_state_tally_ledger: row['Ship To State Tally Ledger'],
    final_invoice_number: row['Final Invoice No.'] || row['Final Invoice No'],

    ship_to_country: row['Ship To Country'],
    ship_to_postal_code: row['Ship To Postal Code'],

    // financials
    invoice_amount: row['Invoice Amount'],
    tax_exclusive_gross: row['Tax Exclusive Gross'],
    total_tax_amount: row['Total Tax Amount'],

    cgst_rate: row['Cgst Rate'],
    sgst_rate: row['Sgst Rate'],
    utgst_rate: row['Utgst Rate'],
    igst_rate: row['Igst Rate'],
    compensatory_cess_rate: row['Compensatory Cess Rate'],

    principal_amount: row['Principal Amount'],
    principal_amount_basis: row['Principal Amount Basis'],

    cgst_tax: row['Cgst Tax'],
    sgst_tax: row['Sgst Tax'],
    utgst_tax: row['Utgst Tax'],
    igst_tax: row['Igst Tax'],
    compensatory_cess_tax: row['Compensatory Cess Tax'],

    final_tax_rate: row['Final Tax Rate'],
    final_taxable_sales_value: row['Final Taxable Sales Value'],
    final_taxable_shipping_value: row['Final Taxable Shipping Value'],

    final_cgst_tax: row['Final CGST Tax'],
    final_sgst_tax: row['Final SGST Tax'],
    final_igst_tax: row['Final IGST Tax'],

    final_shipping_cgst_tax: row['Final Shipping CGST Tax'],
    final_shipping_sgst_tax: row['Final Shipping SGST Tax'],
    final_shipping_igst_tax: row['Final Shipping IGST Tax'],

    final_amount_receivable: row['Final Amount Receivable'],

    shipping_amount: row['Shipping Amount'],
    shipping_amount_basis: row['Shipping Amount Basis'],

    shipping_cgst_tax: row['Shipping Cgst Tax'],
    shipping_sgst_tax: row['Shipping Sgst Tax'],
    shipping_utgst_tax: row['Shipping Utgst Tax'],
    shipping_igst_tax: row['Shipping Igst Tax'],
    shipping_cess_tax: row['Shipping Cess Tax'],

    gift_wrap_amount: row['Gift Wrap Amount'],
    gift_wrap_amount_basis: row['Gift Wrap Amount Basis'],

    gift_wrap_cgst_tax: row['Gift Wrap Cgst Tax'],
    gift_wrap_sgst_tax: row['Gift Wrap Sgst Tax'],
    gift_wrap_utgst_tax: row['Gift Wrap Utgst Tax'],
    gift_wrap_igst_tax: row['Gift Wrap Igst Tax'],
    gift_wrap_compensatory_cess_tax: row['Gift Wrap Compensatory Cess Tax'],

    item_promo_discount: row['Item Promo Discount'],
    item_promo_discount_basis: row['Item Promo Discount Basis'],
    item_promo_tax: row['Item Promo Tax'],

    shipping_promo_discount: row['Shipping Promo Discount'],
    shipping_promo_discount_basis: row['Shipping Promo Discount Basis'],
    shipping_promo_tax: row['Shipping Promo Tax'],

    gift_wrap_promo_discount: row['Gift Wrap Promo Discount'],
    gift_wrap_promo_discount_basis: row['Gift Wrap Promo Discount Basis'],
    gift_wrap_promo_tax: row['Gift Wrap Promo Tax'],

    tcs_cgst_rate: row['Tcs Cgst Rate'],
    tcs_cgst_amount: row['Tcs Cgst Amount'],
    tcs_sgst_rate: row['Tcs Sgst Rate'],
    tcs_sgst_amount: row['Tcs Sgst Amount'],
    tcs_utgst_rate: row['Tcs Utgst Rate'],
    tcs_utgst_amount: row['Tcs Utgst Amount'],
    tcs_igst_rate: row['Tcs Igst Rate'],
    tcs_igst_amount: row['Tcs Igst Amount'],

    warehouse_id: row['Warehouse Id'],
    fulfillment_channel: row['Fulfillment Channel'],
    payment_method_code: row['Payment Method Code'],

    bill_to_city: row['Bill To City'],
    bill_to_state: row['Bill To State'],
    bill_to_country: row['Bill To Country'],
    bill_to_postal_code: row['Bill To Postalcode'] || row['Bill To Postal Code'],

    customer_bill_to_gstin: row['Customer Bill To Gstid'] || row['Customer Bill To Gstin'],
    customer_ship_to_gstin: row['Customer Ship To Gstid'] || row['Customer Ship To Gstin'],

    buyer_name: row['Buyer Name'],

    credit_note_number: row['Credit Note No'] || row['Credit Note Number'],
    credit_note_date: row['Credit Note Date'],

    irn_number: row['Irn Number'],
    irn_filing_status: row['Irn Filing Status'],
    irn_date: row['Irn Date'],
    irn_error_code: row['Irn Error Code']
});

const generate = async (req, res, next) => {
    try {
        console.log('=== AMAZON GENERATE REQUEST ===');
        console.log('Body:', req.body);
        console.log('Params:', req.params);

        // =====================================================
        // ✅ INPUT NORMALIZATION (BASED ON YOUR PAYLOAD)
        // =====================================================
        const { brandId, agentId } = req.params;

        const month = req.body.month;
        const year = parseInt(req.body.year);

        const fileType = String(req.body.file_type || '').toLowerCase().trim();

        let useInventory = true;

        if (req.body.inventory_type) {
            const val = String(req.body.inventory_type).toLowerCase().trim();

            if (
                val === 'without' ||
                val === 'false' ||
                val === '0' ||
                val === 'no'
            ) {
                useInventory = false;
            }
        }

        console.log('Normalized:', { month, year, fileType, useInventory });

        // =====================================================
        // ✅ VALIDATION
        // =====================================================
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ error: 'File is required' });
        }

        if (!month || !year || !fileType) {
            return res.status(400).json({ error: 'month, year, file_type required' });
        }

        // =====================================================
        // ✅ FETCH BRAND + AGENT
        // =====================================================
        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found' });
        }

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        // =====================================================
        // ✅ MASTER DATA
        // =====================================================
        const masterData = await salesService.getMasterData(brandId, agentId);

        // =====================================================
        // ✅ SKU BUFFER (MACROS STYLE)
        // =====================================================
        let skuFileBuffer;
        let sourceSheetData = [];

        if (!useInventory) {
            console.log('WITHOUT INVENTORY MODE');

            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.json_to_sheet([]);
            XLSX.utils.book_append_sheet(wb, ws, 'Source');

            skuFileBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        } else {
            console.log('WITH INVENTORY MODE');

            if (!masterData.sku_master || masterData.sku_master.length === 0) {
                return res.status(400).json({ error: 'No SKUs found' });
            }

            sourceSheetData = masterData.sku_master.map(sku => ({
                SKU: sku['Sales portal SKU'] || sku['SKU'] || sku.salesPortalSku || sku.sku,
                FG: sku['Tally new SKU'] || sku['Tally SKU'] || sku.tallyNewSku || sku.fg || sku.FG
            }));
            console.log("SKU ", masterData.sku_master);
            console.log("source sheet data", sourceSheetData);

            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.json_to_sheet(sourceSheetData);
            XLSX.utils.book_append_sheet(wb, ws, 'Source');

            skuFileBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        }

        // =====================================================
        // ✅ STATE CONFIG (OPTIONAL)
        // =====================================================
        let stateConfigData = null;

        if (masterData.ledger_master) {
            stateConfigData = masterData.ledger_master;
        }

        // =====================================================
        // 🔥 PROCESSOR CALL
        // =====================================================
        let processedData;

        try {
            if (fileType === 'b2b') {
                processedData = await amazonB2BProcessor(
                    req.file.buffer,
                    skuFileBuffer,
                    brand.name,
                    new Date().toISOString(),
                    sourceSheetData,
                    stateConfigData,
                    useInventory,
                    month,
                    year
                );
            } else if (fileType === 'b2c') {
                processedData = await amazonB2CProcessor(
                    req.file.buffer,
                    skuFileBuffer,
                    brand.name,
                    new Date().toISOString(),
                    sourceSheetData,
                    stateConfigData,
                    useInventory,
                    month,
                    year
                );
            } else {
                return res.status(400).json({ error: 'Invalid file_type' });
            }
        } catch (error) {
            if (error.missingSKUs) {
                return res.status(400).json({
                    error: 'Missing SKUs',
                    missingSKUs: error.missingSKUs
                });
            }
            throw error;
        }

        if (!processedData || !processedData.process1Json) {
            return res.status(400).json({ error: 'Invalid processor output' });
        }

        // =====================================================
        // ✅ FILE GENERATION
        // =====================================================
        await ensureDir();

        const id = uuidv4();

        const processFile = `amazon_${fileType}_${brand.name}_${id}.xlsx`;
        const processPath = path.join(OUTPUT_DIR, processFile);

        // ==================================
        // ✅ SAVE DB
        // ==================================
        const monthMapping = {
            "January": 1, "February": 2, "March": 3, "April": 4,
            "May": 5, "June": 6, "July": 7, "August": 8,
            "September": 9, "October": 10, "November": 11, "December": 12
        };
        const dbMonth = monthMapping[month] || (isNaN(parseInt(month)) ? 0 : parseInt(month));

        const finalData = processedData.process1Json.map(row => ({
            ...mapRowToAmazonSchema(row, fileType, useInventory),

            month: dbMonth,
            year,
            file_type: fileType,
            inventory_type: useInventory ? 'With' : 'Without',
            filename: processFile
        }));

        await Model.sync();
        const rows = await Model.bulkCreate(finalData, { returning: true });

        // ==================================
        // 🔥 USE PROCESSOR WORKBOOK (ALL SHEETS INCLUDED)
        // ==================================
        if (processedData.workbook) {
            await processedData.workbook.xlsx.writeFile(processPath);
        } else {
            throw new Error('Processor did not return workbook');
        }

        // ==================================
        // ✅ RESPONSE
        // ==================================
        res.json({
            success: true,
            message: 'Amazon working file generated successfully',
            data: {
                processFile,
                count: finalData.length
            }
        });

    } catch (error) {
        next(error);
    }
};


// ==========================================================================
// 🔍 PHASE 1 — generatePreview
//    Run full processor, compute summary, store pending — do NOT save yet.
// ==========================================================================
const generatePreview = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const month    = req.body.month;
        const year     = parseInt(req.body.year);
        const fileType = String(req.body.file_type || '').toLowerCase().trim();
        let useInventory = true;
        if (req.body.inventory_type) {
            const val = String(req.body.inventory_type).toLowerCase().trim();
            if (val === 'without' || val === 'false' || val === '0' || val === 'no') useInventory = false;
        }

        if (!req.file?.buffer)            return res.status(400).json({ error: 'File is required' });
        if (!month || !year || !fileType) return res.status(400).json({ error: 'month, year, file_type required' });

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const brandDb    = getBrandConnection(brand.db_name);
        const tableName  = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model      = getDynamicModel(brandDb, tableName, agent.columns);
        const masterData = await salesService.getMasterData(brandId, agentId);

        // Build SKU buffer
        let skuFileBuffer, sourceSheetData = [];
        if (!useInventory) {
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([]), 'Source');
            skuFileBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        } else {
            if (!masterData.sku_master?.length) return res.status(400).json({ error: 'No SKUs found' });
            sourceSheetData = masterData.sku_master.map(sku => ({
                SKU: sku['Sales portal SKU'] || sku['SKU'] || sku.salesPortalSku || sku.sku,
                FG:  sku['Tally new SKU']    || sku['Tally SKU'] || sku.tallyNewSku || sku.fg || sku.FG
            }));
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sourceSheetData), 'Source');
            skuFileBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        }

        // Run processor — no DB write, no file write
        let processedData;
        try {
            const processorArgs = [
                req.file.buffer, skuFileBuffer, brand.name,
                new Date().toISOString(), sourceSheetData,
                masterData.ledger_master || null, useInventory, month, year
            ];
            if (fileType === 'b2b')      processedData = await amazonB2BProcessor(...processorArgs);
            else if (fileType === 'b2c') processedData = await amazonB2CProcessor(...processorArgs);
            else return res.status(400).json({ error: 'Invalid file_type' });
        } catch (err) {
            if (err.missingSKUs) return res.status(400).json({ error: 'Missing SKUs', missingSKUs: err.missingSKUs });
            throw err;
        }

        if (!processedData?.process1Json) return res.status(400).json({ error: 'Invalid processor output' });

        // Prepare finalData (will be used on commit)
        const monthMapping = { "January":1,"February":2,"March":3,"April":4,"May":5,"June":6,"July":7,"August":8,"September":9,"October":10,"November":11,"December":12 };
        const dbMonth     = monthMapping[month] || (isNaN(parseInt(month)) ? 0 : parseInt(month));
        const taskId      = uuidv4();
        const processFile = `amazon_${fileType}_${brand.name}_${taskId}.xlsx`;
        const processPath = path.join(OUTPUT_DIR, processFile);

        const finalData = processedData.process1Json.map(row => ({
            ...mapRowToAmazonSchema(row, fileType, useInventory),
            month: dbMonth, year, file_type: fileType,
            inventory_type: useInventory ? 'With' : 'Without',
            filename: processFile
        }));

        // Compute summary totals using shared utility
        const workingFileSummary = computeSummary(processedData.process1Json);
        const pivotFileSummary   = computeSummary(processedData.pivotData || []);

        // Store in the shared agent-agnostic pending store
        setPending(taskId, {
            agentType: 'amazon',
            workbook:    processedData.workbook,
            finalData,
            processFile,
            processPath,
            Model
        });

        res.json({
            success:  true,
            taskId,
            rowCount: finalData.length,
            summary:  { workingFile: workingFileSummary, pivotFile: pivotFileSummary }
        });

    } catch (error) { next(error); }
};

// ==========================================================================
// ✅ PHASE 2a — generateCommit
//    Retrieve pending task, save to DB + disk, clean up store.
//    Agent-agnostic: any agent controller can use the same commit handler
//    because the Model, workbook, and finalData are already stored.
// ==========================================================================
const generateCommit = async (req, res, next) => {
    try {
        const { taskId } = req.body;
        if (!taskId) return res.status(400).json({ error: 'taskId is required' });

        const pending = getPending(taskId);
        if (!pending) return res.status(404).json({
            error: 'No pending generation found. It may have expired (30 min limit). Please regenerate.'
        });

        const { workbook, finalData, processFile, processPath, Model } = pending;

        await ensureDir();
        await Model.sync({ alter: true });
        await Model.bulkCreate(finalData, { returning: true });
        await workbook.xlsx.writeFile(processPath);

        deletePending(taskId);

        res.json({ success: true, message: 'File generated and saved successfully', data: { processFile, count: finalData.length } });

    } catch (error) { next(error); }
};

// ==========================================================================
// ❌ PHASE 2b — generateDiscard
//    Clean up without saving anything. Also agent-agnostic.
// ==========================================================================
const generateDiscard = async (req, res, next) => {
    try {
        const { taskId } = req.body;
        if (!taskId) return res.status(400).json({ error: 'taskId is required' });
        deletePending(taskId);
        res.json({ success: true, message: 'Generation discarded successfully' });
    } catch (error) { next(error); }
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
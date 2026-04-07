const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { jiomartProcessor } = require('../../../services/processors/jiomart/jiomartProcessor');
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

const mapRowToJiomartSchema = (row, month, year, filename) => ({
    year: parseInt(year),
    month: monthToNumber(month),
    filename: filename,

    seller_gstin: String(row['Seller GSTIN'] || ''),
    order_id: String(row['Order ID'] || ''),
    order_item_id: String(row['Order Item ID'] || ''),
    order_type: String(row['Order Type'] || ''),
    type: String(row['Type'] || ''),

    shipment_number: String(row['Shipment ID'] || row['Shipment Number'] || ''),
    original_shipment_number: String(row['Original Shipment Number'] || ''),
    fulfillment_type: String(row['Fulfillment Type'] || ''),
    fulfiller_name: String(row['Fulfiller Name'] || ''),

    product_name: String(row['Product Name'] || row['Item Name'] || ''),
    product_id: String(row['Product ID'] || row['FSN'] || ''),
    sku: String(row['SKU'] || ''),
    fg: String(row['FG'] || ''),
    hsn_code: String(row['HSN Code'] || ''),

    order_status: String(row['Order Status'] || ''),
    event_type: String(row['Event Type'] || ''),
    event_sub_type: String(row['Event Sub Type'] || ''),

    quantity: safeNum(row['Item Quantity'] || row['Quantity']),

    buyer_invoice_id: String(row['Buyer Invoice ID'] || row['Invoice Number'] || ''),
    original_invoice_id: String(row['Original Invoice ID'] || ''),
    
    buyer_invoice_amount: safeNum(row['Buyer Invoice Amount'] || row['Invoice Amount']),
    
    shipped_from_state: String(row['Shipped From State'] || ''),
    billed_from_state: String(row['Billed From State'] || ''),
    billing_pincode: String(row['Billing Pincode'] || ''),
    billing_state: String(row['Billing State'] || ''),
    delivery_pincode: String(row['Delivery Pincode'] || ''),
    delivery_state: String(row["Customer's Delivery State"] || row['Delivery State'] || ''),

    seller_coupon_code: String(row['Seller Coupon Code'] || ''),
    offer_price: safeNum(row['Offer Price'] || 0),
    seller_coupon_amount: safeNum(row['Seller Coupon Amount'] || 0),
    final_invoice_amount: safeNum(row['Final Invoice Amount'] || 0),

    tax_type: String(row['Tax Type'] || ''),
    taxable_value: safeNum(row['Taxable Value (Final Invoice Amount -Taxes)'] || row['Taxable Value'] || 0),

    igst_rate: safeNum(row['IGST Rate'] || 0),
    igst_amount: safeNum(row['IGST Amount'] || 0),
    cgst_rate: safeNum(row['CGST Rate'] || 0),
    cgst_amount: safeNum(row['CGST Amount'] || 0),
    sgst_rate: safeNum(row['SGST Rate (or UTGST as applicable)'] || row['SGST Rate'] || 0),
    sgst_amount: safeNum(row['SGST Amount (Or UTGST as applicable)'] || row['SGST Amount'] || 0),

    tcs_igst_rate: safeNum(row['TCS IGST Rate'] || 0),
    tcs_igst_amount: safeNum(row['TCS IGST Amount'] || 0),
    tcs_cgst_rate: safeNum(row['TCS CGST Rate'] || 0),
    tcs_cgst_amount: safeNum(row['TCS CGST Amount'] || 0),
    tcs_sgst_rate: safeNum(row['TCS SGST Rate'] || 0),
    tcs_sgst_amount: safeNum(row['TCS SGST Amount'] || 0),
    total_tcs_deducted: safeNum(row['Total TCS Deducted'] || 0),

    tds_rate: safeNum(row['TDS Rate'] || 0),
    tds_amount: safeNum(row['TDS Amount'] || 0),

    final_gst_rate: safeNum(row['Final GST Rate'] || 0)
});

const generate = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const { month, year, inventory_type } = req.body;
        const useInventory = inventory_type !== 'Without';

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const masterData = await salesService.getMasterData(brandId, agentId);

        if (!req.file && (!req.files || !req.files.file)) {
            return res.status(400).json({ error: 'JioMart raw report file is required' });
        }
        const fileBuffer = req.file ? req.file.buffer : req.files.file[0].buffer;

        // jiomartProcessor(rawJson, skuJson, brandName, date, withInventory)
        // Since we have a buffer, we must parse it to JSON first like Flipkart/Blinkit processors do, OR modify jiomart processor?
        // Wait, jiomartProcessor takes "rawJson". The other processors read buffer inside. Let's check how we handle it!
        // I will parse JSON here if jiomartProcessor expects JSON!
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rawJson = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

        const processedData = await jiomartProcessor(
            rawJson,
            masterData.sku_master,
            brand.name,
            `${month}-${year}`,
            useInventory
        );

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        await ensureDir();
        const id = uuidv4();
        const filename = `jiomart_${brand.name}_${month}_${year}_${id}.xlsx`;
        const filepath = path.join(OUTPUT_DIR, filename);

        const dbRows = processedData.processedData.map(row =>
            mapRowToJiomartSchema(row, month, year, filename)
        );

        await Model.sync();
        await Model.bulkCreate(dbRows);

        XLSX.writeFile(processedData.outputWorkbook, filepath);

        res.json({
            success: true,
            message: 'JioMart working file generated successfully',
            data: { filename, count: dbRows.length }
        });
    } catch (error) {
        console.error('JioMart Generation Error:', error);
        next(error);
    }
};

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
            return res.status(400).json({ error: 'JioMart raw report file is required' });
        }
        const fileBuffer = req.file ? req.file.buffer : req.files.file[0].buffer;

        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rawJson = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

        const processedData = await jiomartProcessor(
            rawJson,
            masterData.sku_master,
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
        const filename = `jiomart_${brand.name}_${month}_${year}_${taskId}.xlsx`;
        const processPath = path.join(OUTPUT_DIR, filename);

        const dbRows = processedData.processedData.map(row =>
            mapRowToJiomartSchema(row, month, year, filename)
        );

        const computeSummary = (rows) => {
            let qty = 0, taxable = 0, cgst = 0, sgst = 0, igst = 0;
            rows.forEach(row => {
                qty     += Number(row['Item Quantity'] || 0);
                taxable += Number(row['Taxable Value (Final Invoice Amount -Taxes)'] || 0);
                cgst    += Number(row['CGST Amount'] || 0);
                sgst    += Number(row['SGST Amount (Or UTGST as applicable)'] || 0);
                igst    += Number(row['IGST Amount'] || 0);
            });
            return {
                quantity: Math.round(qty),
                taxableValue: Number(taxable.toFixed(2)),
                cgst: Number(cgst.toFixed(2)),
                sgst: Number(sgst.toFixed(2)),
                igst: Number(igst.toFixed(2))
            };
        };

        const workingSummary = computeSummary(processedData.processedData);
        const b2cSummary = processedData.gstrB2C ? computeSummary(processedData.gstrB2C) : null;
        const hsnSummary = processedData.gstrHSN ? computeSummary(processedData.gstrHSN) : null;

        setPending(taskId, {
            agentType: 'jiomart',
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
                pivotFile: b2cSummary, // Keeping it backwards compatible with base UI logic
                gstrB2CFile: b2cSummary,
                gstrHSNFile: hsnSummary
            }
        });
    } catch (error) {
        console.error('JioMart Preview Error:', error);
        next(error);
    }
};

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
            message: 'JioMart file generated and saved successfully',
            data: { filename: processFile, count: finalData.length }
        });
    } catch (error) {
        console.error('JioMart Commit Error:', error);
        next(error);
    }
};

const generateDiscard = async (req, res, next) => {
    try {
        const { taskId } = req.body;
        if (!taskId) return res.status(400).json({ error: 'taskId is required' });
        deletePending(taskId);
        res.json({ success: true, message: 'Generation discarded successfully' });
    } catch (error) {
        console.error('JioMart Discard Error:', error);
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

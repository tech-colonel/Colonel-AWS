const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { tatacliqProcessor } = require('../../../services/processors/tatacliq/tatacliqProcessor');
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

const mapRowToTatacliqSchema = (row, month, year, filename) => ({
    year: parseInt(year),
    month: monthToNumber(month),
    filename,

    seller_code: String(row.raw['Seller Code'] || ''),
    seller_name: String(row.raw['Seller Name'] || ''),
    order_reference_no: String(row.raw['Order Reference No.'] || ''),
    order_id: String(row.raw['Order ID'] || ''),
    transaction_id: String(row.raw['Transaction ID'] || ''),
    hsn_code: String(row.raw['HSN Code'] || ''),
    fulfillment_type: String(row.raw['Fulfillment Type'] || ''),
    order_type: String(row.raw['Order Type'] || ''),
    order_tag: String(row.raw['Order Tag'] || ''),
    slave_id: String(row.raw['Slave ID'] || ''),
    slave_gstin: String(row.raw['Slave GSTIN'] || ''),
    slave_state: String(row.raw['Slave State'] || ''),
    destination_code: String(row.raw['Destination Code'] || ''),
    place_of_supply: String(row.raw['Place Of Supply'] || ''),
    seller_invoice: String(row.raw['Seller Invoice'] || ''),
    order_date: row.orderDate,
    transaction_date: row.transactionDate,

    product_value: row.productValue,
    product_cgst: row.cgst,
    product_sgst: row.sgst,
    product_igst: row.igst,
    gross_product_value: row.grossValue,
    tcs_cgst: Number(row.raw['TCS CGST'] || 0),
    tcs_sgst: Number(row.raw['TCS SGST'] || 0),
    tcs_igst: Number(row.raw['TCS IGST'] || 0),
    total_tcs: Number(row.raw['Total TCS'] || 0),

    clearing_document: String(row.raw['Clearing Document'] || ''),
    document_date: row.documentDate,
    tul_gstin: String(row.raw['TUL GSTIN'] || ''),
    gstin_status: String(row.raw['Gstin Status'] || ''),

    gst_rate: row.gstRate,
    state: row.stateName,
    sku: row.sku,
    voucher_type: row.voucherType,
    is_cn: row.isCN || null,
    invoice_number: row.invoiceNumber,
    debtor: row.debtor,
    sales_ledger: row.salesLedger,
    stock_name: row.stockName,
    qty: row.qty,
    output_igst: row.outputIGST,
    output_cgst: row.outputCGST,
    output_sgst: row.outputSGST,
    cost: row.cost,
    cost_qty: row.costQty
});

async function runProcessor(req) {
    const { brandId, agentId } = req.params;
    const { month, year } = req.body;

    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);
    if (!brand || !agent) {
        const err = new Error('Brand or Agent not found');
        err.status = 404;
        throw err;
    }

    const masterData = await salesService.getMasterData(brandId, agentId);

    if (!req.file && (!req.files || !req.files.file)) {
        const err = new Error('Tata Cliq TCS report file is required');
        err.status = 400;
        throw err;
    }
    const fileBuffer = req.file ? req.file.buffer : req.files.file[0].buffer;

    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rawJson = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

    const processedData = await tatacliqProcessor(
        rawJson,
        masterData.sku_master,
        brand.name,
        `${month}-${year}`
    );

    const brandDb = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const Model = getDynamicModel(brandDb, tableName, agent.columns);

    const id = uuidv4();
    const filename = `tatacliq_${brand.name}_${month}_${year}_${id}.xlsx`;

    const dbRows = processedData.processedData.map((row) =>
        mapRowToTatacliqSchema(row, month, year, filename)
    );

    return { brand, agent, Model, processedData, dbRows, filename };
}

const generate = async (req, res, next) => {
    try {
        const { brand, Model, processedData, dbRows, filename } = await runProcessor(req);

        await ensureDir();
        const filepath = path.join(OUTPUT_DIR, filename);

        await Model.sync();
        await Model.bulkCreate(dbRows);

        XLSX.writeFile(processedData.outputWorkbook, filepath);

        res.json({
            success: true,
            message: 'Tata Cliq working file generated successfully',
            data: { filename, count: dbRows.length }
        });
    } catch (error) {
        console.error('Tata Cliq Generation Error:', error);
        next(error);
    }
};

const computeSummary = (rows) => {
    let qty = 0, taxable = 0, cgst = 0, sgst = 0, igst = 0;
    rows.forEach((row) => {
        qty += Number(row.qty || 0);
        taxable += Number(row.productValue || 0);
        cgst += Number(row.cgst || 0);
        sgst += Number(row.sgst || 0);
        igst += Number(row.igst || 0);
    });
    return {
        quantity: Math.round(qty),
        taxableValue: Number(taxable.toFixed(2)),
        cgst: Number(cgst.toFixed(2)),
        sgst: Number(sgst.toFixed(2)),
        igst: Number(igst.toFixed(2))
    };
};

const generatePreview = async (req, res, next) => {
    try {
        const { Model, processedData, dbRows, filename } = await runProcessor(req);

        await ensureDir();
        const taskId = uuidv4();
        const processPath = path.join(OUTPUT_DIR, filename);

        const summary = computeSummary(processedData.processedData);

        setPending(taskId, {
            agentType: 'tatacliq',
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
            summary: { workingFile: summary }
        });
    } catch (error) {
        console.error('Tata Cliq Preview Error:', error);
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
            message: 'Tata Cliq file generated and saved successfully',
            data: { filename: processFile, count: finalData.length }
        });
    } catch (error) {
        console.error('Tata Cliq Commit Error:', error);
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
        console.error('Tata Cliq Discard Error:', error);
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

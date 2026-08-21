const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { vareeProcessor } = require('../../../services/processors/varee/vareeProcessor');
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

// Vaaree's SOP computes everything directly off the GSTR report — no SKU/Tally-ledger
// lookups are needed. These endpoints exist only because the generic agent workspace UI
// always renders "Upload SKU" / "Upload Ledger" buttons for every sales agent; kept as
// unused no-ops so those buttons don't 404.
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

// The Vaaree GSTR report is downloaded as CSV. SheetJS's CSV reader silently
// auto-detects some (not all) "DD/MM/YY HH:MM" cells as ambiguous MM/DD Excel date
// serials, corrupting them (e.g. 09/07 -> September 7). `raw: true` forces every CSV
// cell to stay a plain string so the processor's own DD/MM/YY parser handles dates.
function parseUploadedReport(fileBuffer) {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', raw: true });
    const sheetName = workbook.SheetNames[0];
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
}

const mapRowToVareeSchema = (row, month, year, filename) => ({
    year: parseInt(year),
    month: monthToNumber(month),
    filename,

    payment_cycle: row.raw['Payment Cycle'] || '',
    order_date: row.orderDate,
    order_number: String(row.raw['Order Number'] || ''),
    customer_name: row.customerName,
    customer_state: row.customerState,
    invoice_number: row.invoiceNumber,
    order_status: row.orderStatus,
    sku: row.sku,
    taxable_goods: row.taxableGoods,
    gst_on_goods: row.gstOnGoods,
    gst_rate: row.gstRate,
    taxable_cod: row.taxableCod,
    gst_on_cod: row.gstOnCod,
    total_invoice_value: row.totalInvoiceValue,
    final_rate: row.finalRate,
    final_taxable: row.finalTaxable,
    igst: row.igst,
    cgst: row.cgst,
    sgst: row.sgst,
    quantity: row.quantity,
    tds: row.tds,
    tcs: row.tcs,
    customer_gst_no: row.customerGstNo,
    fulfilled_by: row.fulfilledBy,
    seller_state: row.sellerState,
    invoice_date: row.invoiceDate,
    hsn_code: row.hsnCode,
    sale_type: row.saleType,
    transaction_type: row.transactionType,
});

const computeSummary = (rows) => {
    let qty = 0, taxable = 0, igst = 0, cgst = 0, sgst = 0;
    rows.forEach((row) => {
        qty += safeNum(row.quantity);
        taxable += safeNum(row.finalTaxable);
        igst += safeNum(row.igst);
        cgst += safeNum(row.cgst);
        sgst += safeNum(row.sgst);
    });
    return {
        quantity: Math.round(qty),
        taxableValue: Number(taxable.toFixed(2)),
        igst: Number(igst.toFixed(2)),
        cgst: Number(cgst.toFixed(2)),
        sgst: Number(sgst.toFixed(2))
    };
};

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

    if (!req.file && (!req.files || !req.files.file)) {
        const err = new Error('Vaaree GSTR report file is required');
        err.status = 400;
        throw err;
    }
    const fileBuffer = req.file ? req.file.buffer : req.files.file[0].buffer;

    const rawJson = parseUploadedReport(fileBuffer);

    const processedData = await vareeProcessor(rawJson, brand.name, `${month}-${year}`);

    const brandDb = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const Model = getDynamicModel(brandDb, tableName, agent.columns);

    const id = uuidv4();
    const filename = `varee_${brand.name}_${month}_${year}_${id}.xlsx`;

    const dbRows = processedData.processedData.map((row) =>
        mapRowToVareeSchema(row, month, year, filename)
    );

    return { brand, agent, Model, processedData, dbRows, filename };
}

const generatePreview = async (req, res, next) => {
    try {
        const { Model, processedData, dbRows, filename } = await runProcessor(req);

        await ensureDir();
        const taskId = uuidv4();
        const processPath = path.join(OUTPUT_DIR, filename);

        const summary = computeSummary(processedData.processedData);

        setPending(taskId, {
            agentType: 'varee',
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
        console.error('Vaaree Preview Error:', error);
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
            message: 'Vaaree file generated and saved successfully',
            data: { filename: processFile, count: finalData.length }
        });
    } catch (error) {
        console.error('Vaaree Commit Error:', error);
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
        console.error('Vaaree Discard Error:', error);
        next(error);
    }
};

// Legacy single-phase generate (kept for parity with the other sales-agent controllers).
const generate = async (req, res, next) => {
    try {
        const { Model, processedData, dbRows, filename } = await runProcessor(req);

        await ensureDir();
        const filepath = path.join(OUTPUT_DIR, filename);

        await Model.sync();
        await Model.bulkCreate(dbRows);

        XLSX.writeFile(processedData.outputWorkbook, filepath);

        res.json({
            success: true,
            message: 'Vaaree working file generated successfully',
            data: { filename, count: dbRows.length }
        });
    } catch (error) {
        console.error('Vaaree Generation Error:', error);
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

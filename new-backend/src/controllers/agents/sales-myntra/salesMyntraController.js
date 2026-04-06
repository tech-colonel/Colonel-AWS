const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { myntraProcessor } = require('../../../services/processors/myntra/myntraProcessor');

const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

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
 * Map Processor Row to Myntra Database Schema
 */
const mapRowToMyntraSchema = (row, month, year, filename) => ({
    year: parseInt(year),
    filename: filename,
    month: monthToNumber(month),
    date: row.date_column ? new Date(row.date_column) : null,

    seller_gstin: row.seller_gstin,
    invoice_number: row.final_invoice_no,
    debtor_ledger: row.ship_to_state_tally_ledger,

    sku: row.sku,
    quantity: row.quantity,

    shipping: row.shipping_case,
    gst_rate: row.gst_rate,

    base_value: row.base_value,
    file_type: row.report_type,

    igst_amount: row.igst_amount,
    cgst_amount: row.cgst_amount,
    sgst_amount: row.sgst_amount,

    invoice_amount: row.invoice_amount
});

/**
 * Generate Myntra Working File
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

        // 2. Prepare File Buffers
        // Support both single file and multiple files
        let fileBuffers = {};
        if (req.files) {
            fileBuffers.rtoFile = req.files.rtoFile ? req.files.rtoFile[0].buffer : null;
            fileBuffers.packedFile = req.files.packedFile ? req.files.packedFile[0].buffer : null;
            fileBuffers.rtFile = req.files.rtFile ? req.files.rtFile[0].buffer : null;

            // Fallback for single file upload via 'file' field
            if (!fileBuffers.packedFile && req.files.file) {
                fileBuffers.packedFile = req.files.file[0].buffer;
            }
        } else if (req.file) {
            // Fallback for single file upload via 'upload.single'
            fileBuffers.packedFile = req.file.buffer;
        }

        if (!fileBuffers.packedFile && !fileBuffers.rtoFile && !fileBuffers.rtFile) {
            return res.status(400).json({ error: 'At least one Myntra report (Packed, RTO, or RT) is required' });
        }

        // 3. Call Processor

        let sourceSheetData = [];
        if (useInventory && masterData.sku_master) {
            sourceSheetData = masterData.sku_master.map(sku => ({
                SKU: sku['Sales portal SKU'] || sku['Sales Portal SKU'] || sku['SKU'] || sku.salesPortalSku || sku.sku,
                FG: sku['Tally new SKU'] || sku['Tally New SKU'] || sku['Tally SKU'] || sku.tallyNewSku || sku.fg || sku.FG
            }));
        } else {
            sourceSheetData = masterData.sku_master;
        }

        const processedData = await myntraProcessor(
            fileBuffers,
            sourceSheetData,
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
        const filename = `myntra_${brand.name}_${month}_${year}_${id}.xlsx`;
        const filepath = path.join(OUTPUT_DIR, filename);

        const dbRows = processedData.workingFileData.map(row =>
            mapRowToMyntraSchema(row, month, year, filename)
        );

        await Model.sync();
        await Model.bulkCreate(dbRows);

        // 5. Save Excel File
        if (processedData.outputWorkbook) {
            const XLSX = require('xlsx-js-style');
            XLSX.writeFile(processedData.outputWorkbook, filepath);
        }

        res.json({
            success: true,
            message: 'Myntra working file generated successfully',
            data: { filename, count: dbRows.length }
        });

    } catch (error) {
        next(error);
    }
};

module.exports = {
    uploadSkuMaster,
    uploadLedgerMaster,
    getMasterData,
    generate
};

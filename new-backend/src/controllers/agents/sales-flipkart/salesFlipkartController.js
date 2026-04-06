const salesService = require('../../../services/salesService');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

// ✅ Single Flipkart Processor
const { flipkartProcessor } = require('../../../services/processors/flipkart/flipkartProcessor');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');

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
 * Generate Flipkart Working File
 */
const generate = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const { month, year, inventory_type } = req.body;

        // ✅ Validate
        if (!req.file) {
            return res.status(400).json({ error: 'File is required' });
        }

        if (!month || !year) {
            return res.status(400).json({ error: 'month and year are required' });
        }

        // ✅ Fetch brand & agent
        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found' });
        }

        // ✅ DB setup
        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const useInventory = inventory_type === 'With';

        // ✅ Get master data
        const masterData = await salesService.getMasterData(brandId, agentId);

        let sourceSheetData = [];
        if (useInventory && masterData.sku_master) {
            sourceSheetData = masterData.sku_master.map(sku => ({
                SKU: sku['Sales portal SKU'] || sku['Sales Portal SKU'] || sku['SKU'] || sku.salesPortalSku || sku.sku,
                FG: sku['Tally new SKU'] || sku['Tally New SKU'] || sku['Tally SKU'] || sku.tallyNewSku || sku.fg || sku.FG
            }));
        } else {
            sourceSheetData = masterData.sku_master;
        }

        // =====================================================
        // 🔥 SINGLE PROCESSOR
        // =====================================================
        const processedData = await flipkartProcessor(
            req.file.buffer,
            sourceSheetData,
            masterData.ledger_master,
            brand.name,
            new Date().toISOString(),
            useInventory
        );

        if (!processedData || !processedData.workingFileData) {
            return res.status(400).json({ error: 'Processor must return workingFileData' });
        }

        // =====================================================
        // ✅ FILE GENERATION
        // =====================================================
        await ensureDir();

        const fileId = uuidv4();
        const fileName = `flipkart_${brand.name}_${fileId}.xlsx`;
        const filePath = path.join(OUTPUT_DIR, fileName);

        // =====================================================
        // ✅ PREPARE DATA FOR DB
        // =====================================================
        const finalData = processedData.workingFileData.map(row => ({
            ...row,
            month,
            year,
            inventory_type,
            filename: fileName
        }));

        // =====================================================
        // ✅ SAVE TO DB
        // =====================================================
        const resultRows = await Model.bulkCreate(finalData, { returning: true });
        const firstId = resultRows[0]?.id;

        // ==================================
        // 🔥 SAVE MULTI-SHEET EXCEL
        // ==================================
        const XLSX = require('xlsx');
        if (processedData.outputWorkbook) {
            XLSX.writeFile(processedData.outputWorkbook, filePath);
        } else {
            // Fallback if outputWorkbook is missing
            const workbook = new ExcelJS.Workbook();
            const sheet1 = workbook.addWorksheet('process1');
            const headers1 = Object.keys(processedData.process1Json[0] || {});
            sheet1.addRow(headers1);
            processedData.process1Json.forEach(row => {
                sheet1.addRow(headers1.map(h => row[h]));
            });
            await workbook.xlsx.writeFile(filePath);
        }

        // =====================================================
        // ✅ RESPONSE
        // =====================================================
        res.json({
            message: 'Flipkart working file generated successfully',
            count: finalData.length,
            file: fileName,
            fileId: firstId
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
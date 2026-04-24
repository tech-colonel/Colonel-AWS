/**
 * Order Cycle Shopify Controller
 *
 * Handles the two-phase generate flow for the Shopify Order Cycle agent:
 *   Phase 1 — generatePreview: parse all files, compute summary, stash in memory
 *   Phase 2a — generateCommit: write Excel to disk + save to brand DB
 *   Phase 2b — generateDiscard: discard the stashed task
 *
 * Also handles:
 *   getGeneratedFiles — list saved outputs
 *   downloadFile      — stream an Excel file back to the browser
 *   deleteFile        — remove a file record + disk file
 */

const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { orderCycleShopifyProcessor } = require('../../../services/processors/orderCycleShopifyProcessor');
const { setPending, getPending, deletePending } = require('../../../services/pendingGenerationsStore');

const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');

async function ensureDir() {
    await fs.ensureDir(OUTPUT_DIR);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract all uploaded payment gateway + logistics buffers from req.files.
 * multer.fields() stores files as req.files[fieldName][0].
 *
 * @param {object}   reqFiles          - req.files from multer
 * @param {string[]} gatewayNames      - ordered list of gateway names
 * @param {string[]} logisticsNames    - ordered list of logistics partner names
 */
function extractPartnerFiles(reqFiles, gatewayNames, logisticsNames) {
    const paymentGatewayFiles = gatewayNames.map((name, i) => {
        const fieldName = `paymentGateway_${i}`;
        const fileArr = reqFiles[fieldName];
        if (!fileArr || !fileArr[0]) {
            throw new Error(`Missing file for payment gateway "${name}" (field: ${fieldName})`);
        }
        return { name, buffer: fileArr[0].buffer };
    });

    const logisticsFiles = logisticsNames.map((name, i) => {
        const fieldName = `logistics_${i}`;
        const fileArr = reqFiles[fieldName];
        if (!fileArr || !fileArr[0]) {
            throw new Error(`Missing file for logistics partner "${name}" (field: ${fieldName})`);
        }
        return { name, buffer: fileArr[0].buffer };
    });

    return { paymentGatewayFiles, logisticsFiles };
}

/**
 * Map a processed summary row to the DB schema columns defined in the seed.
 */
function mapRowToSchema(row, month, year, filename) {
    const safeNum = (v) => {
        if (v === null || v === undefined || v === '') return 0;
        const n = Number(v);
        return isNaN(n) ? 0 : n;
    };
    const safeStr = (v) => (v === null || v === undefined ? '' : String(v));
    const safeDate = (v) => {
        if (!v) return null;
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
    };

    return {
        year: parseInt(year) || new Date().getFullYear(),
        month: parseInt(month) || 0,
        filename,
        date: safeDate(row.date || row['Date']),
        sale_order_number: safeStr(row.sale_order_number || row['Order ID'] || row['Name']),
        platform: safeStr(row.platform || 'Shopify'),
        invoice_number: safeStr(row.invoice_number || row['Invoice Number']),
        awb_number: safeStr(row.awb_number || row['AWB'] || row['Tracking Number']),
        shipping_partner: safeStr(row.shipping_partner),
        dispatch_or_cancellation_date: safeDate(row.dispatch_or_cancellation_date),
        return_date: safeDate(row.return_date),
        total_amount: safeNum(row.total_amount || row['Total']),
        return_amount: safeNum(row.return_amount),
        net_amount: safeNum(row.net_amount || row['Net Sales']),
        srn: safeStr(row.srn || row['SRN']),
        // Ekart
        ekart_remittance_date: safeDate(row.ekart_remittance_date),
        ekart_actual_remittance_date: safeDate(row.ekart_actual_remittance_date),
        ekart_cod_amount: safeNum(row.ekart_cod_amount),
        // Delhivery
        delhivery_delivery_date: safeDate(row.delhivery_delivery_date),
        delhivery_cod_amount: safeNum(row.delhivery_cod_amount),
        // Xpressbees
        xpressbees_delivery_date: safeDate(row.xpressbees_delivery_date),
        xpressbees_transaction_date: safeDate(row.xpressbees_transaction_date),
        xpressbees_net_payment: safeNum(row.xpressbees_net_payment),
        // Snapmint
        snapmint_settlement_date: safeDate(row.snapmint_settlement_date),
        snapmint_settlement_value: safeNum(row.snapmint_settlement_value),
        // BharatX
        bharatx_settlement_timestamp: safeDate(row.bharatx_settlement_timestamp),
        bharatx_ledger_amount: safeNum(row.bharatx_ledger_amount),
    };
}

// ─── Phase 1: generatePreview ─────────────────────────────────────────────────

const generatePreview = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;

        // Parse partner name lists sent as JSON strings or comma-separated
        let gatewayNames, logisticsNames;
        try {
            gatewayNames = JSON.parse(req.body.gatewayNames || '[]');
            logisticsNames = JSON.parse(req.body.logisticsNames || '[]');
        } catch {
            gatewayNames = (req.body.gatewayNames || '').split(',').map(s => s.trim()).filter(Boolean);
            logisticsNames = (req.body.logisticsNames || '').split(',').map(s => s.trim()).filter(Boolean);
        }

        const month = req.body.month || '';
        const year = req.body.year || new Date().getFullYear().toString();

        // Validate Shopify file
        const shopifyFileArr = req.files?.shopifyFile;
        if (!shopifyFileArr || !shopifyFileArr[0]) {
            return res.status(400).json({ error: 'Shopify file is required (field: shopifyFile)' });
        }
        const shopifyBuffer = shopifyFileArr[0].buffer;

        // Validate Brand + Agent
        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found' });
        }

        // Extract partner + gateway file buffers
        let paymentGatewayFiles, logisticsFiles;
        try {
            ({ paymentGatewayFiles, logisticsFiles } = extractPartnerFiles(
                req.files, gatewayNames, logisticsNames
            ));
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }

        // Run processor
        const result = await orderCycleShopifyProcessor(
            shopifyBuffer,
            paymentGatewayFiles,
            logisticsFiles,
            brand.name,
            `${month}-${year}`
        );

        // Prepare DB model
        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const taskId = uuidv4();
        const filename = `order_cycle_shopify_${brand.name}_${month}_${year}_${taskId}.xlsx`;
        const filepath = path.join(OUTPUT_DIR, filename);

        const dbRows = result.summaryRows.map(row =>
            mapRowToSchema(row, month, year, filename)
        );

        // Stash for commit phase
        setPending(taskId, {
            agentType: 'order-cycle-shopify',
            workbook: result.outputWorkbook,
            finalData: dbRows,
            processFile: filename,
            processPath: filepath,
            Model,
            gatewayNames,
            logisticsNames,
        });

        res.json({
            success: true,
            taskId,
            rowCount: result.rowCount,
            parseStats: result.parseStats,
            summary: {
                shopifyRows: result.parseStats.shopify,
                gateways: result.parseStats.gateways,
                logistics: result.parseStats.logistics,
            }
        });

    } catch (error) {
        console.error('[OrderCycle] Preview Error:', error);
        next(error);
    }
};

// ─── Phase 2a: generateCommit ─────────────────────────────────────────────────

const generateCommit = async (req, res, next) => {
    try {
        const { taskId } = req.body;
        if (!taskId) return res.status(400).json({ error: 'taskId is required' });

        const pending = getPending(taskId);
        if (!pending) {
            return res.status(404).json({
                error: 'No pending generation found. It may have expired. Please regenerate.'
            });
        }

        const { workbook, finalData, processFile, processPath, Model } = pending;

        await ensureDir();
        await Model.sync();
        await Model.bulkCreate(finalData);

        if (workbook) {
            await workbook.xlsx.writeFile(processPath);
        }
        deletePending(taskId);

        res.json({
            success: true,
            message: 'Order Cycle file generated and saved successfully',
            data: { filename: processFile, count: finalData.length }
        });

    } catch (error) {
        console.error('[OrderCycle] Commit Error:', error);
        next(error);
    }
};

// ─── Phase 2b: generateDiscard ────────────────────────────────────────────────

const generateDiscard = async (req, res, next) => {
    try {
        const { taskId } = req.body;
        if (!taskId) return res.status(400).json({ error: 'taskId is required' });
        deletePending(taskId);
        res.json({ success: true, message: 'Generation discarded' });
    } catch (error) {
        console.error('[OrderCycle] Discard Error:', error);
        next(error);
    }
};

// ─── Get Generated Files ──────────────────────────────────────────────────────

const getGeneratedFiles = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        await Model.sync();

        // Get distinct filenames with metadata
        const { Sequelize } = require('sequelize');
        const rows = await Model.findAll({
            attributes: [
                'filename', 'month', 'year',
                [Sequelize.fn('COUNT', Sequelize.col('filename')), 'row_count'],
                [Sequelize.fn('MIN', Sequelize.col('created_at')), 'created_at'],
                [Sequelize.fn('MIN', Sequelize.col('id')), 'id'],
            ],
            group: ['filename', 'month', 'year'],
            order: [['year', 'DESC'], ['month', 'DESC']],
            raw: true,
        });

        res.json(rows);
    } catch (error) {
        console.error('[OrderCycle] GetFiles Error:', error);
        next(error);
    }
};

// ─── Download File ────────────────────────────────────────────────────────────

const downloadFile = async (req, res, next) => {
    try {
        const { filename } = req.params;
        if (!filename) return res.status(400).json({ error: 'filename is required' });

        // Basic path-traversal guard
        const safe = path.basename(filename);
        const filepath = path.join(OUTPUT_DIR, safe);

        if (!await fs.pathExists(filepath)) {
            return res.status(404).json({ error: 'File not found on disk' });
        }

        res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.sendFile(path.resolve(filepath));

    } catch (error) {
        console.error('[OrderCycle] Download Error:', error);
        next(error);
    }
};

// ─── Delete File ──────────────────────────────────────────────────────────────

const deleteFile = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const { filename } = req.body;
        if (!filename) return res.status(400).json({ error: 'filename is required' });

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        await Model.sync();
        await Model.destroy({ where: { filename } });

        const safe = path.basename(filename);
        const filepath = path.join(OUTPUT_DIR, safe);
        if (await fs.pathExists(filepath)) {
            await fs.remove(filepath);
        }

        res.json({ success: true, message: 'File deleted' });

    } catch (error) {
        console.error('[OrderCycle] Delete Error:', error);
        next(error);
    }
};

module.exports = {
    generatePreview,
    generateCommit,
    generateDiscard,
    getGeneratedFiles,
    downloadFile,
    deleteFile,
};

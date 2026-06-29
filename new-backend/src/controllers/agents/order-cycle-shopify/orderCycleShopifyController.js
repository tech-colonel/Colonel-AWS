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
const { orderCycleShopifyProcessor, parseExcelBuffer } = require('../../../services/processors/orderCycleShopifyProcessor');
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
    const sN = (v) => { if (v === null || v === undefined || v === '') return 0; const n = Number(v); return isNaN(n) ? 0 : n; };
    const sS = (v) => (v === null || v === undefined ? '' : String(v));
    const sD = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };

    return {
        year: parseInt(year) || new Date().getFullYear(),
        month: parseInt(month) || 0,
        filename,
        date: sD(row.dispatch_date),
        sale_order_number: sS(row.sale_order_number),
        platform: sS(row.shopify || 'Shopify'),
        invoice_number: sS(row.invoice_number),
        awb_number: sS(row.awb_number),
        shipping_partner: sS(row.shipping_partner),
        dispatch_or_cancellation_date: sD(row.dispatch_date),
        return_date: sD(row.return_date),
        total_amount: sN(row.sales_amount),
        return_amount: sN(row.return_amount),
        net_amount: sN(row.net_amount),
        srn: sS(row.srn),
        delivery_status: sS(row.delivery_status),
        // Ekart
        ekart_remittance_date: sD(row.ekart_remittance_date),
        ekart_actual_remittance_date: sD(row.ekart_actual_remittance_date),
        ekart_cod_amount: sN(row.ekart_cod_amount),
        // Delhivery
        delhivery_delivery_date: sD(row.delhivery_delivery_date),
        delhivery_cod_amount: sN(row.delhivery_cod_amount),
        // Xpressbees
        xpressbees_delivery_date: sD(row.xpressbees_delivery_date),
        xpressbees_transaction_date: sD(row.xpressbees_transaction_date),
        xpressbees_net_payment: sN(row.xpressbees_net_payment),
        // Snapmint
        snapmint_settlement_date: sD(row.snapmint_settlement_date),
        snapmint_settlement_value: sN(row.snapmint_settlement_amount),
        // BharatX
        bharatx_settlement_timestamp: sD(row.bharatx_settlement_date),
        bharatx_ledger_amount: sN(row.bharatx_settlement_amount),
        // Razorpay
        razorpay_settlement_date: sD(row.razorpay_settlement_date),
        razorpay_settlement_amount: sN(row.razorpay_settlement_amount),
        // Totals
        total_settlement_received: sN(row.total_settlement_received),
        balance_amount_receivable: sN(row.balance_amount_receivable),
        reconciliation_status: sS(row.reconciliation_status),
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

        // Validate required files
        const unicommerceArr = req.files?.unicommerceFile;       // Export-Tally GST Report
        const returnGSTArr = req.files?.returnGSTFile;           // Return GST Report
        const salesOrderArr = req.files?.salesOrderReportFile;   // Sales Order Combined Report
        if (!unicommerceArr || !unicommerceArr[0]) {
            return res.status(400).json({ error: 'Export-Tally GST file is required (field: unicommerceFile)' });
        }
        if (!salesOrderArr || !salesOrderArr[0]) {
            return res.status(400).json({ error: 'Sales Order Report file is required (field: salesOrderReportFile)' });
        }
        const unicommerceBuffer = unicommerceArr[0].buffer;
        const returnGSTBuffer = returnGSTArr?.[0]?.buffer || null;
        const salesOrderBuffer = salesOrderArr[0].buffer;

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

        // Parse all files to JSON
        const unicommerceJson = await parseExcelBuffer(unicommerceBuffer, 'Export-Tally GST Report');
        const returnGSTJson = returnGSTBuffer
            ? await parseExcelBuffer(returnGSTBuffer, 'Return GST Report')
            : [];
        const salesOrderJson = await parseExcelBuffer(salesOrderBuffer, 'Sales Order Combined Report');
        const gatewayDataJson = {};
        for (const gw of paymentGatewayFiles) {
            gatewayDataJson[gw.name] = await parseExcelBuffer(gw.buffer, `Payment Gateway: ${gw.name}`);
        }
        const logisticsDataJson = {};
        for (const lp of logisticsFiles) {
            logisticsDataJson[lp.name] = await parseExcelBuffer(lp.buffer, `Logistics: ${lp.name}`);
        }

        // Run processor
        const result = await orderCycleShopifyProcessor(
            unicommerceJson,
            returnGSTJson,
            salesOrderJson,
            gatewayDataJson,
            logisticsDataJson,
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
                gstReportRows: result.parseStats.gstReport,
                returnGSTRows: result.parseStats.returnGST,
                salesOrderRows: result.parseStats.salesOrder,
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
        // MIN(id::text) because id is UUID — PostgreSQL has no MIN() for UUID natively
        const { Sequelize } = require('sequelize');
        const rows = await Model.findAll({
            attributes: [
                'filename', 'month', 'year',
                [Sequelize.fn('COUNT', Sequelize.col('filename')), 'row_count'],
                [Sequelize.fn('MIN', Sequelize.col('created_at')), 'created_at'],
                [Sequelize.literal('MIN(id::text)'), 'id'],
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

// ─── Get Report Visualization Data ───────────────────────────────────────────

const getReportData = async (req, res, next) => {
    try {
        const { brandId, agentId, filename } = req.params;
        const decodedFilename = decodeURIComponent(filename);

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);
        await Model.sync();

        const rows = await Model.findAll({ where: { filename: decodedFilename }, raw: true });
        if (!rows.length) return res.status(404).json({ error: 'No data found for this file' });

        const toNum = v => { const n = Number(v); return isNaN(n) ? 0 : n; };

        // Aggregation accumulators
        let grossSales = 0, totalReturns = 0, netSales = 0;
        let cancelledCount = 0, rtoCount = 0, cancelledAmount = 0;
        let reconciledCount = 0, pendingCount = 0, overpaidCount = 0;

        const providers = {
            'Ekart COD':     { type: 'COD',     amount: 0, orders: 0, matched: 0, color: '#10b981' },
            'Delhivery COD': { type: 'COD',     amount: 0, orders: 0, matched: 0, color: '#6366f1' },
            'Xpressbees':    { type: 'COD',     amount: 0, orders: 0, matched: 0, color: '#f59e0b' },
            'Snapmint':      { type: 'Prepaid', amount: 0, orders: 0, matched: 0, color: '#8b5cf6' },
            'BharatX':       { type: 'Prepaid', amount: 0, orders: 0, matched: 0, color: '#ec4899' },
            'Razorpay':      { type: 'Prepaid', amount: 0, orders: 0, matched: 0, color: '#3b82f6' },
        };

        const courierMap = {};

        for (const row of rows) {
            const status = (row.reconciliation_status || '').toUpperCase();
            const ds     = (row.delivery_status      || '').toUpperCase();

            const ga = toNum(row.total_amount);
            const ra = toNum(row.return_amount);
            const na = toNum(row.net_amount);

            grossSales   += ga;
            totalReturns += ra;
            netSales     += na;

            if (ds === 'CANCELLED') { cancelledCount++; cancelledAmount += ga; }
            if (ds === 'RTO')       rtoCount++;

            if (status === 'RECONCILED')            reconciledCount++;
            else if (status === 'PENDING RECEIVABLE') pendingCount++;
            else if (status === 'OVERPAID / INVESTIGATE') overpaidCount++;

            // Provider amounts
            const ekAmt = toNum(row.ekart_cod_amount);
            if (ekAmt > 0) { providers['Ekart COD'].amount += ekAmt; providers['Ekart COD'].orders++; if (status === 'RECONCILED') providers['Ekart COD'].matched++; }

            const delAmt = toNum(row.delhivery_cod_amount);
            if (delAmt > 0) { providers['Delhivery COD'].amount += delAmt; providers['Delhivery COD'].orders++; if (status === 'RECONCILED') providers['Delhivery COD'].matched++; }

            const xpAmt = toNum(row.xpressbees_net_payment);
            if (xpAmt > 0) { providers['Xpressbees'].amount += xpAmt; providers['Xpressbees'].orders++; if (status === 'RECONCILED') providers['Xpressbees'].matched++; }

            const snAmt = toNum(row.snapmint_settlement_value);
            if (snAmt > 0) { providers['Snapmint'].amount += snAmt; providers['Snapmint'].orders++; if (status === 'RECONCILED') providers['Snapmint'].matched++; }

            const bhAmt = toNum(row.bharatx_ledger_amount);
            if (bhAmt > 0) { providers['BharatX'].amount += bhAmt; providers['BharatX'].orders++; if (status === 'RECONCILED') providers['BharatX'].matched++; }

            const rzAmt = toNum(row.razorpay_settlement_amount);
            if (rzAmt > 0) { providers['Razorpay'].amount += rzAmt; providers['Razorpay'].orders++; if (status === 'RECONCILED') providers['Razorpay'].matched++; }

            // Courier map
            const courier = (row.shipping_partner || 'Unknown').toLowerCase().trim();
            if (!courierMap[courier]) courierMap[courier] = { orders: 0, sales: 0 };
            courierMap[courier].orders++;
            courierMap[courier].sales += na;
        }

        const totalOrders = rows.length;
        const matchPct = totalOrders > 0
            ? Math.round((reconciledCount / totalOrders) * 1000) / 10
            : 0;

        const providerList = Object.entries(providers)
            .filter(([, v]) => v.orders > 0)
            .map(([name, v]) => ({
                name,
                type: v.type,
                amount: Math.round(v.amount * 100) / 100,
                orders: v.orders,
                matchPct: v.orders > 0 ? Math.round((v.matched / v.orders) * 1000) / 10 : 0,
                color: v.color,
            }));

        const totalSettled = providerList.reduce((s, p) => s + p.amount, 0);

        const couriers = Object.entries(courierMap)
            .sort((a, b) => b[1].sales - a[1].sales)
            .map(([name, v]) => ({
                name,
                orders: v.orders,
                sales: Math.round(v.sales * 100) / 100,
                share: totalOrders > 0 ? Math.round((v.orders / totalOrders) * 1000) / 10 : 0,
            }));

        res.json({
            totalOrders,
            summary: {
                grossSales: Math.round(grossSales * 100) / 100,
                totalReturns: Math.round(totalReturns * 100) / 100,
                netSales: Math.round(netSales * 100) / 100,
                cancelledCount,
                cancelledAmount: Math.round(cancelledAmount * 100) / 100,
                rtoCount,
            },
            reconciliation: {
                total: totalOrders,
                reconciled: reconciledCount,
                pending: pendingCount,
                overpaid: overpaidCount,
                rto: rtoCount,
                cancelled: cancelledCount,
                matchPct,
            },
            providers: providerList,
            totalSettled: Math.round(totalSettled * 100) / 100,
            couriers,
        });

    } catch (error) {
        console.error('[OrderCycle] ReportData Error:', error);
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
    getReportData,
};

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
const ExcelJS = require('exceljs');

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
const MONTH_NAME_TO_NUM = {
    january:1, february:2, march:3, april:4, may:5, june:6,
    july:7, august:8, september:9, october:10, november:11, december:12,
};

function mapRowToSchema(row, month, year, filename) {
    const sN = (v) => { if (v === null || v === undefined || v === '') return 0; const n = Number(v); return isNaN(n) ? 0 : n; };
    const sS = (v) => (v === null || v === undefined ? '' : String(v));
    const sD = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };

    // month can be a name ("October") or a number string ("10")
    const monthNum = MONTH_NAME_TO_NUM[String(month).toLowerCase()] || parseInt(month) || 0;

    return {
        year: parseInt(year) || new Date().getFullYear(),
        month: monthNum,
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

        // Postgres COUNT() comes back as a bigint string (e.g. "66560") — cast so
        // downstream numeric use (e.g. summing across files) doesn't silently
        // concatenate instead of add.
        const withNumericCounts = rows.map(r => ({ ...r, row_count: Number(r.row_count) }));

        res.json(withNumericCounts);
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

        // Ensure filename index exists on tables created before the index was added to the model
        await brandDb.query(
            `CREATE INDEX IF NOT EXISTS idx_${tableName}_filename ON \`${tableName}\` (filename)`
        ).catch(() => {}); // ignore if dialect doesn't support IF NOT EXISTS syntax

        const rows = await Model.findAll({ where: { filename: decodedFilename }, raw: true });
        if (!rows.length) return res.status(404).json({ error: 'No data found for this file' });

        const toNum = v => { const n = Number(v); return isNaN(n) ? 0 : n; };

        // Aggregation accumulators
        let grossSales = 0, totalReturns = 0, netSales = 0;
        let cancelledCount = 0, rtoCount = 0, cancelledAmount = 0;
        let reconciledCount = 0, pendingCount = 0, overpaidCount = 0, advanceCount = 0, neverTouchedCount = 0;

        const providers = {
            'Ekart COD':     { type: 'COD',     amount: 0, orders: 0, matched: 0, settledAmount: 0, settledOrders: 0, unsettledAmount: 0, unsettledOrders: 0, color: '#10b981' },
            'Delhivery COD': { type: 'COD',     amount: 0, orders: 0, matched: 0, settledAmount: 0, settledOrders: 0, unsettledAmount: 0, unsettledOrders: 0, color: '#6366f1' },
            'Xpressbees':    { type: 'COD',     amount: 0, orders: 0, matched: 0, settledAmount: 0, settledOrders: 0, unsettledAmount: 0, unsettledOrders: 0, color: '#f59e0b' },
            'Snapmint':      { type: 'Prepaid', amount: 0, orders: 0, matched: 0, settledAmount: 0, settledOrders: 0, unsettledAmount: 0, unsettledOrders: 0, color: '#8b5cf6' },
            'BharatX':       { type: 'Prepaid', amount: 0, orders: 0, matched: 0, settledAmount: 0, settledOrders: 0, unsettledAmount: 0, unsettledOrders: 0, color: '#ec4899' },
            'Razorpay':      { type: 'Prepaid', amount: 0, orders: 0, matched: 0, settledAmount: 0, settledOrders: 0, unsettledAmount: 0, unsettledOrders: 0, color: '#3b82f6' },
        };

        const courierMap = {};

        // "Settled" = order fully reconciled (balance receivable is zero).
        // Everything else (pending, overpaid, RTO, cancelled) counts as "unsettled".
        const addProvider = (key, amount, isReconciled) => {
            if (amount <= 0) return;
            const p = providers[key];
            p.amount += amount;
            p.orders++;
            if (isReconciled) { p.matched++; p.settledAmount += amount; p.settledOrders++; }
            else              { p.unsettledAmount += amount; p.unsettledOrders++; }
        };

        for (const row of rows) {
            const status = (row.reconciliation_status || '').toUpperCase();
            const ds     = (row.delivery_status      || '').toUpperCase();
            const isReconciled = status === 'RECONCILED';

            const ga = toNum(row.total_amount);
            const ra = toNum(row.return_amount);
            const na = toNum(row.net_amount);

            grossSales   += ga;
            totalReturns += ra;
            netSales     += na;

            if (ds === 'CANCELLED') { cancelledCount++; cancelledAmount += ga; }
            if (ds === 'RTO')       rtoCount++;

            // A PENDING RECEIVABLE row that was never returned AND never received a
            // rupee from any courier/gateway hasn't actually been found to be a
            // mismatch — it just hasn't been paid out yet. Counted separately as
            // "never touched" (rolled into Unsettled below) instead of Pending,
            // mirroring the same split in buildTransactionsWhere.
            const neverTouched = ra <= 0 && toNum(row.total_settlement_received) <= 0;

            if (isReconciled)                             reconciledCount++;
            else if (status === 'PENDING RECEIVABLE') {
                if (neverTouched) neverTouchedCount++;
                else              pendingCount++;
            }
            else if (status === 'OVERPAID / INVESTIGATE') overpaidCount++;
            else if (status === 'ADVANCE')                advanceCount++;

            // Provider amounts
            addProvider('Ekart COD',     toNum(row.ekart_cod_amount),        isReconciled);
            addProvider('Delhivery COD', toNum(row.delhivery_cod_amount),    isReconciled);
            addProvider('Xpressbees',    toNum(row.xpressbees_net_payment),  isReconciled);
            addProvider('Snapmint',      toNum(row.snapmint_settlement_value), isReconciled);
            addProvider('BharatX',       toNum(row.bharatx_ledger_amount),   isReconciled);
            addProvider('Razorpay',      toNum(row.razorpay_settlement_amount), isReconciled);

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

        const buildProviderList = (amountKey, ordersKey) => Object.entries(providers)
            .filter(([, v]) => v[ordersKey] > 0)
            .map(([name, v]) => ({
                name,
                type: v.type,
                amount: Math.round(v[amountKey] * 100) / 100,
                orders: v[ordersKey],
                matchPct: v.orders > 0 ? Math.round((v.matched / v.orders) * 1000) / 10 : 0,
                color: v.color,
            }));

        const settledProviderList   = buildProviderList('settledAmount', 'settledOrders');
        const unsettledProviderList = buildProviderList('unsettledAmount', 'unsettledOrders');
        const unsettledOrdersCount  = totalOrders - reconciledCount;

        const totalSettled   = settledProviderList.reduce((s, p) => s + p.amount, 0);
        const totalUnsettled = unsettledProviderList.reduce((s, p) => s + p.amount, 0);

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
                advance: advanceCount,
                rto: rtoCount,
                cancelled: cancelledCount,
                // Never returned AND never received any settlement (RTO/cancelled rows
                // are already their own distinct statuses, counted separately above).
                unsettled: rtoCount + cancelledCount + neverTouchedCount,
                matchPct,
            },
            // Backward-compatible defaults (settled view)
            providers: settledProviderList,
            totalSettled: Math.round(totalSettled * 100) / 100,
            settled: {
                providers: settledProviderList,
                total: Math.round(totalSettled * 100) / 100,
                orders: reconciledCount,
            },
            unsettled: {
                providers: unsettledProviderList,
                total: Math.round(totalUnsettled * 100) / 100,
                orders: unsettledOrdersCount,
            },
            couriers,
        });

    } catch (error) {
        console.error('[OrderCycle] ReportData Error:', error);
        next(error);
    }
};

// ─── Get Paginated Transactions ───────────────────────────────────────────────

/**
 * Build the Sequelize WHERE clause shared by getTransactions and downloadTransactions
 * from the tab/sub/search query params.
 * tab: matched|mismatched|unsettled|all|sales
 * sub (mismatched only): less|more|return|notreturn|advance
 *   - less/more    → PENDING RECEIVABLE / OVERPAID split (by amount direction)
 *   - return       → mismatched orders whose sale_order_number also matches a Return GST record
 *                     (i.e. this order's row was joined to a return — return_amount > 0)
 *   - notreturn    → mismatched orders with no matching return record
 *   - advance      → sold (Tally GST) AND returned (Return GST) AND still has a courier/gateway
 *                     settlement against it — reconciliation_status === 'ADVANCE'
 *
 * A PENDING RECEIVABLE row that was never returned AND never received a rupee
 * from any courier/gateway (NEVER_TOUCHED below) hasn't actually been found to
 * be a mismatch yet — it just hasn't been paid out at all. Those belong under
 * the Unsettled tab, not Mismatched — Mismatched is reserved for rows that DID
 * get some money moving against them (a return and/or a settlement) but still
 * don't balance.
 */
function buildTransactionsWhere(decodedFilename, tab, sub, search) {
    const { Op } = require('sequelize');
    const SETTLED = ['RECONCILED', 'PENDING RECEIVABLE', 'OVERPAID / INVESTIGATE', 'ADVANCE'];
    const MISMATCHED = ['PENDING RECEIVABLE', 'OVERPAID / INVESTIGATE'];

    const ZERO_RETURN = { [Op.or]: [{ return_amount: null }, { return_amount: { [Op.lte]: 0 } }] };
    const ZERO_SETTLEMENT = { [Op.or]: [{ total_settlement_received: null }, { total_settlement_received: { [Op.lte]: 0 } }] };
    const NEVER_TOUCHED = { [Op.and]: [ZERO_RETURN, ZERO_SETTLEMENT] };

    let where;
    if (tab === 'unsettled') {
        where = {
            [Op.and]: [
                { filename: decodedFilename },
                {
                    [Op.or]: [
                        { reconciliation_status: null },
                        { reconciliation_status: { [Op.notIn]: SETTLED } },
                        { [Op.and]: [{ reconciliation_status: 'PENDING RECEIVABLE' }, NEVER_TOUCHED] },
                    ],
                },
            ],
        };
    } else {
        where = { filename: decodedFilename };
        if (tab === 'matched')                     where.reconciliation_status = 'RECONCILED';
        if (tab === 'mismatched' && sub === 'less') {
            where.reconciliation_status = 'PENDING RECEIVABLE';
            where[Op.and] = [{ [Op.not]: NEVER_TOUCHED }];
        }
        if (tab === 'mismatched' && sub === 'more') where.reconciliation_status = 'OVERPAID / INVESTIGATE';
        if (tab === 'mismatched' && sub === 'return') {
            where.reconciliation_status = { [Op.in]: MISMATCHED };
            where.return_amount = { [Op.gt]: 0 };
        }
        if (tab === 'mismatched' && sub === 'notreturn') {
            where.reconciliation_status = { [Op.in]: MISMATCHED };
            where[Op.and] = [
                {
                    [Op.or]: [
                        { return_amount: { [Op.lte]: 0 } },
                        { return_amount: null },
                    ],
                },
                { [Op.not]: NEVER_TOUCHED },
            ];
        }
        if (tab === 'mismatched' && sub === 'advance') where.reconciliation_status = 'ADVANCE';
        // tab === 'all' | 'sales' → no status filter
    }

    if (search) {
        const searchCond = {
            [Op.or]: [
                { sale_order_number: { [Op.like]: `%${search}%` } },
                { invoice_number:    { [Op.like]: `%${search}%` } },
            ],
        };
        if (where[Op.and]) where[Op.and].push(searchCond);
        else                where[Op.and] = [searchCond];
    }

    return where;
}

const getTransactions = async (req, res, next) => {
    try {
        const { brandId, agentId, filename } = req.params;
        const decodedFilename = decodeURIComponent(filename);

        const page     = Math.max(1, parseInt(req.query.page)     || 1);
        const pageSize = Math.min(100, Math.max(10, parseInt(req.query.pageSize) || 50));
        const tab      = req.query.tab || 'all';    // matched|mismatched|unsettled|all|sales
        const sub      = req.query.sub || 'less';   // less|more (mismatched only)
        const search   = (req.query.search || '').trim();

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);
        await Model.sync();

        const where = buildTransactionsWhere(decodedFilename, tab, sub, search);

        const { count: total, rows } = await Model.findAndCountAll({
            where,
            limit:  pageSize,
            offset: (page - 1) * pageSize,
            raw:    true,
        });

        const TX_OMIT = new Set(['year', 'month', 'date', 'filename', 'file_type', 'inventory_type', 'created_at']);
        const txRows = rows.map(r => {
            const out = {};
            for (const k of Object.keys(r)) {
                if (!TX_OMIT.has(k)) out[k] = r[k];
            }
            return out;
        });

        res.json({
            rows: txRows,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        });
    } catch (error) {
        console.error('[OrderCycle] Transactions Error:', error);
        next(error);
    }
};

// ─── Download Transaction Sheet (current UI view, all rows) ───────────────────

function statusLabelOf(row) {
    const s  = (row.reconciliation_status || '').toUpperCase().trim();
    const ds = (row.delivery_status || '').toUpperCase();
    if (s === 'RECONCILED')         return 'RECONCILED';
    if (s === 'PENDING RECEIVABLE') return 'PENDING';
    if (s.startsWith('OVERPAID'))   return 'OVERPAID';
    if (s === 'ADVANCE')            return 'ADVANCE';
    if (ds === 'RTO')               return 'RTO';
    if (ds === 'CANCELLED')         return 'CANCELLED';
    return 'UNSETTLED';
}

function gatewayOfRow(row) {
    const toNum = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
    if (toNum(row.snapmint_settlement_value) > 0)  return 'Snapmint';
    if (toNum(row.bharatx_ledger_amount) > 0)      return 'BharatX';
    if (toNum(row.razorpay_settlement_amount) > 0) return 'Razorpay';
    return '—';
}

function settlementDateOfRow(row) {
    return row.snapmint_settlement_date || row.bharatx_settlement_timestamp || row.razorpay_settlement_date || null;
}

const NORMAL_COLUMNS = [
    { header: 'Order ID',         key: 'orderId',    width: 20 },
    { header: 'Invoice No.',      key: 'invoiceNo',  width: 20 },
    { header: 'Order Value',      key: 'orderValue', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Settlement',       key: 'settlement', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Diff',             key: 'diff',       width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Order Date',       key: 'orderDate',  width: 14, style: { numFmt: 'dd-mmm-yyyy' } },
    { header: 'Settlement Date',  key: 'settleDate', width: 14, style: { numFmt: 'dd-mmm-yyyy' } },
    { header: 'Status',           key: 'status',     width: 14 },
    { header: 'Courier',          key: 'courier',    width: 14 },
    { header: 'Gateway',          key: 'gateway',     width: 14 },
];

const SALES_COLUMNS = [
    { header: 'Order ID',       key: 'orderId',     width: 20 },
    { header: 'Invoice No.',    key: 'invoiceNo',   width: 20 },
    { header: 'Invoice Date',   key: 'invoiceDate', width: 14, style: { numFmt: 'dd-mmm-yyyy' } },
    { header: 'Channel',        key: 'channel',     width: 14 },
    { header: 'GMV',            key: 'gmv',         width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Return',         key: 'ret',         width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Net Amount',     key: 'netAmount',   width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Basic (÷1.12)',  key: 'basic',       width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'GST @12%',       key: 'gst',         width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Status',         key: 'status',      width: 14 },
];

function toNumVal(v) { const n = Number(v); return isNaN(n) ? 0 : n; }

function normalRowValues(row) {
    return {
        orderId:    row.sale_order_number || '',
        invoiceNo:  row.invoice_number || '',
        orderValue: toNumVal(row.total_amount),
        settlement: toNumVal(row.total_settlement_received),
        diff:       toNumVal(row.balance_amount_receivable),
        orderDate:  row.dispatch_or_cancellation_date ? new Date(row.dispatch_or_cancellation_date) : null,
        settleDate: settlementDateOfRow(row) ? new Date(settlementDateOfRow(row)) : null,
        status:     statusLabelOf(row),
        courier:    (row.shipping_partner || '').toLowerCase(),
        gateway:    gatewayOfRow(row),
    };
}

function salesRowValues(row) {
    const netAmount = toNumVal(row.net_amount);
    const basic = Math.round(netAmount / 1.12 * 100) / 100;
    const gst   = Math.round((netAmount - basic) * 100) / 100;
    return {
        orderId:     row.sale_order_number || '',
        invoiceNo:   row.invoice_number || '',
        invoiceDate: row.dispatch_or_cancellation_date ? new Date(row.dispatch_or_cancellation_date) : null,
        channel:     row.platform || '',
        gmv:         toNumVal(row.total_amount),
        ret:         toNumVal(row.return_amount),
        netAmount,
        basic,
        gst,
        status:      statusLabelOf(row),
    };
}

function addSheet(workbook, name, tabColor, columns, rows, rowMapper) {
    const sheet = workbook.addWorksheet(name, { properties: { tabColor: { argb: `FF${tabColor}` } } });
    sheet.columns = columns;
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    for (const row of rows) sheet.addRow(rowMapper(row));
    return sheet;
}

const downloadTransactions = async (req, res, next) => {
    try {
        const { brandId, agentId, filename } = req.params;
        const decodedFilename = decodeURIComponent(filename);
        const search = (req.query.search || '').trim();

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const brandDb   = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model     = getDynamicModel(brandDb, tableName, agent.columns);
        await Model.sync();

        const where = buildTransactionsWhere(decodedFilename, 'all', null, search);
        const rows  = await Model.findAll({ where, raw: true, order: [['id', 'ASC']] });

        // A PENDING RECEIVABLE row with no return AND no settlement at all hasn't
        // been found to be a mismatch — it just hasn't been paid out yet. Mirrors
        // the NEVER_TOUCHED split in buildTransactionsWhere so this export's sheets
        // match the UI's Mismatched/Unsettled tabs.
        const neverTouched = r => {
            const ret = Number(r.return_amount || 0);
            const settled = Number(r.total_settlement_received || 0);
            return ret <= 0 && settled <= 0;
        };

        const SETTLED = ['RECONCILED', 'PENDING RECEIVABLE', 'OVERPAID / INVESTIGATE', 'ADVANCE'];
        const matchedRows    = rows.filter(r => (r.reconciliation_status || '').toUpperCase().trim() === 'RECONCILED');
        const mismatchedRows = rows.filter(r => {
            const s = (r.reconciliation_status || '').toUpperCase().trim();
            if (s === 'PENDING RECEIVABLE') return !neverTouched(r);
            return s.startsWith('OVERPAID');
        });
        const advanceRows    = rows.filter(r => (r.reconciliation_status || '').toUpperCase().trim() === 'ADVANCE');
        const unsettledRows  = rows.filter(r => {
            const s = (r.reconciliation_status || '').toUpperCase().trim();
            if (!SETTLED.includes(s)) return true;
            return s === 'PENDING RECEIVABLE' && neverTouched(r);
        });

        const workbook = new ExcelJS.Workbook();
        addSheet(workbook, 'Matched',       '10B981', NORMAL_COLUMNS, matchedRows,    normalRowValues);
        addSheet(workbook, 'Mismatched',    'F59E0B', NORMAL_COLUMNS, mismatchedRows, normalRowValues);
        addSheet(workbook, 'Advance',       '6366F1', NORMAL_COLUMNS, advanceRows,    normalRowValues);
        addSheet(workbook, 'Unsettled',     '94A3B8', NORMAL_COLUMNS, unsettledRows,  normalRowValues);
        addSheet(workbook, 'All Orders',    '3B82F6', NORMAL_COLUMNS, rows,           normalRowValues);
        addSheet(workbook, 'Sales Report',  '7C3AED', SALES_COLUMNS,  rows,           salesRowValues);

        const safeBase = path.basename(decodedFilename, path.extname(decodedFilename));
        const outName = `${safeBase}_transaction_sheet.xlsx`;

        res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('[OrderCycle] Download Transactions Error:', error);
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
    getTransactions,
    downloadTransactions,
};

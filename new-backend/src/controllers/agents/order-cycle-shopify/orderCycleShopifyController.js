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
        // MIN(id::text) because id is UUID — PostgreSQL has no MIN() for UUID natively.
        // MIN/MAX(date) — the underlying orders' own dispatch dates — is the same
        // real span getReportData exposes as availableRange for one file, surfaced
        // here per row so the list itself shows what data an entry actually covers
        // instead of just the single month/year label it was uploaded under.
        const { Sequelize } = require('sequelize');
        const rows = await Model.findAll({
            attributes: [
                'filename', 'month', 'year',
                [Sequelize.fn('COUNT', Sequelize.col('filename')), 'row_count'],
                [Sequelize.fn('MIN', Sequelize.col('created_at')), 'created_at'],
                [Sequelize.literal('MIN(id::text)'), 'id'],
                [Sequelize.fn('MIN', Sequelize.col('date')), 'data_from'],
                [Sequelize.fn('MAX', Sequelize.col('date')), 'data_to'],
            ],
            group: ['filename', 'month', 'year'],
            order: [['year', 'DESC'], ['month', 'DESC']],
            raw: true,
        });

        // Postgres COUNT() comes back as a bigint string (e.g. "66560") — cast so
        // downstream numeric use (e.g. summing across files) doesn't silently
        // concatenate instead of add. data_from/data_to come back as full
        // timestamps — trim to a plain date so the UI doesn't have to.
        const withNumericCounts = rows.map(r => ({
            ...r,
            row_count: Number(r.row_count),
            data_from: r.data_from ? new Date(r.data_from).toISOString().slice(0, 10) : null,
            data_to: r.data_to ? new Date(r.data_to).toISOString().slice(0, 10) : null,
        }));

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

// ─── Order-Cycle Overview blocks (Volume / Cash / Funnel / Scenario / Package / Cash-Action) ──
//
// Extra sections layered onto the reconciliation report, matching the
// "ORDER CYCLE - DASHBOARD (Page 1 / overview)" spec. Computed from the same
// per-file, date-filtered rows as the summary — additive only, they never change
// the reconciliation numbers. Some buckets read 0 by design: the uploaded files
// carry DELIVERED / partial / blank delivery statuses plus RECONCILED / PENDING
// RECEIVABLE / OVERPAID / ADVANCE reco statuses — not the granular courier scan
// states (out-for-delivery, attempt-failed, at-hub) or an AWB-fallback SRN match,
// so rows that need those signals stay empty until a source file carries them.

const OCV_SCENARIO_ROWS = [
    { n: 1,  key: 'prepaid_settled_clean',                 payment: 'PREPAID', calc: 'settled same month, never returned' },
    { n: 2,  key: 'prepaid_settled_then_returned_full',    payment: 'PREPAID', calc: 'settled, later returned in full' },
    { n: 3,  key: 'prepaid_settled_then_returned_partial', payment: 'PREPAID', calc: 'settled, partial return < order value' },
    { n: 4,  key: 'cod_settled_clean',                     payment: 'COD',     calc: 'courier remittance present, never returned' },
    { n: 5,  key: 'cod_settled_late_cross_month',          payment: 'COD',     calc: 'remittance month after the dispatch month' },
    { n: 6,  key: 'cod_settled_short_remittance',          payment: 'COD',     calc: 'remitted amount < net order value' },
    { n: 7,  key: 'cod_returned_never_settled',            payment: 'COD',     calc: 'returned, no remittance received' },
    { n: 8,  key: 'cod_settled_then_returned',             payment: 'COD',     calc: 'remittance received AND later returned (full)' },
    { n: 9,  key: 'cod_settled_then_returned_partial',     payment: 'COD',     calc: 'remittance received + partial return' },
    { n: 10, key: 'cod_pending',                           payment: 'COD',     calc: 'no remittance / SRN yet (courier file exists)' },
    { n: 11, key: 'cod_pending_no_settlement_source',      payment: 'COD',     calc: 'no settlement file loaded for this courier' },
    { n: 12, key: 'cod_returned_via_awb_fallback',         payment: 'COD',     calc: 'SRN matched on AWB, not invoice number (not detectable in current files)' },
];

const OCV_PACKAGE_ROWS = [
    { n: 1, key: 'withBrandNotDispatched', label: 'With brand / warehouse (not dispatched)',          calc: 'no dispatch date, or cancelled before dispatch' },
    { n: 2, key: 'withCourierTransit',     label: 'With courier (in transit / at hub)',               calc: 'dispatched, not yet delivered or returned' },
    { n: 3, key: 'withCourierOFD',         label: 'With courier (out for delivery / attempt failed)', calc: 'courier out-for-delivery status (not carried in current files)' },
    { n: 4, key: 'withCustomer',           label: 'With customer (delivered)',                        calc: 'delivery confirmed, not returned' },
    { n: 5, key: 'returningToBrand',       label: 'Returning to brand (RTO / return in transit)',     calc: 'RTO or return raised, not yet received back' },
    { n: 6, key: 'backWithBrand',          label: 'Back with brand (return received)',                calc: 'return received / reconciled after the return' },
    { n: 7, key: 'lost',                   label: 'Lost / needs investigation',                       calc: 'lost / untraceable / overpaid-investigate' },
];

const OCV_CASHACTION_ROWS = [
    { n: 1, key: 'noAction',        label: 'No action (still in transit)', when: 'shipment moving, final outcome not yet known' },
    { n: 2, key: 'awaitRemittance', label: 'Await courier remittance',     when: 'delivered, waiting on the settlement / gateway file' },
    { n: 3, key: 'hold',            label: 'Hold (do not refund yet)',     when: 'return / RTO in transit, not yet received back' },
    { n: 4, key: 'refundNow',       label: 'Refund now',                   when: 'return / RTO confirmed received back at the warehouse' },
    { n: 5, key: 'investigate',     label: 'Investigate',                  when: 'lost / untraceable / overpaid status' },
];

const ocvNum = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const ocvDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d; };
const ocvMonthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const ocvDispatchDate = (r) => ocvDate(r.dispatch_or_cancellation_date) || ocvDate(r.date);
const ocvDeliveredDate = (r) =>
    ocvDate(r.delhivery_delivery_date) || ocvDate(r.xpressbees_delivery_date)
    || ocvDate(r.ekart_actual_remittance_date) || ocvDate(r.ekart_remittance_date);
const ocvSettlementDate = (r) =>
    ocvDate(r.ekart_actual_remittance_date) || ocvDate(r.ekart_remittance_date)
    || ocvDate(r.delhivery_delivery_date) || ocvDate(r.xpressbees_transaction_date) || ocvDate(r.xpressbees_delivery_date)
    || ocvDate(r.snapmint_settlement_date) || ocvDate(r.bharatx_settlement_timestamp) || ocvDate(r.razorpay_settlement_date);

function ocvPaymentMethod(r) {
    const sp = (r.shipping_partner || '').toLowerCase();
    if (/prepaid|\bpre[\s_-]?paid\b/.test(sp)) return 'Prepaid';
    if (/\bcod\b|cash on delivery/.test(sp)) return 'COD';
    if (ocvNum(r.snapmint_settlement_value) || ocvNum(r.bharatx_ledger_amount) || ocvNum(r.razorpay_settlement_amount)) return 'Prepaid';
    if (r.snapmint_settlement_date || r.bharatx_settlement_timestamp || r.razorpay_settlement_date) return 'Prepaid';
    if (ocvNum(r.ekart_cod_amount) || ocvNum(r.delhivery_cod_amount) || ocvNum(r.xpressbees_net_payment)) return 'COD';
    if ((r.reconciliation_status || '').toUpperCase().trim() === 'ADVANCE') return 'Prepaid';
    return 'COD';
}
function ocvCourier(r) {
    const s = (r.shipping_partner || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!s) return 'Unknown';
    if (s.includes('delhivery') || /^dlv/.test(s)) return 'Delhivery';
    if (s.includes('xpressb') || s.includes('busybee') || /^xb/.test(s)) return 'Xpressbees';
    if (s.includes('ekart') || s.includes('instakart')) return 'Ekart';
    if (s.includes('bluedart')) return 'Bluedart';
    if (s.includes('dtdc')) return 'DTDC';
    if (s.includes('selfship') || s.includes('selfshipping')) return 'Self Ship';
    if (s === 'ats') return 'ATS';
    return 'Other';
}
function ocvCouriersWithSettlement(rows) {
    const set = new Set();
    for (const r of rows) {
        if (ocvNum(r.ekart_cod_amount) || ocvDate(r.ekart_remittance_date) || ocvDate(r.ekart_actual_remittance_date)) set.add('Ekart');
        if (ocvNum(r.delhivery_cod_amount) || ocvDate(r.delhivery_delivery_date)) set.add('Delhivery');
        if (ocvNum(r.xpressbees_net_payment) || ocvDate(r.xpressbees_transaction_date) || ocvDate(r.xpressbees_delivery_date)) set.add('Xpressbees');
    }
    return set;
}
function ocvFacts(r, asOf) {
    const ds = (r.delivery_status || '').toUpperCase().trim();
    const status = (r.reconciliation_status || '').toUpperCase().trim();
    const dispatchDate = ocvDispatchDate(r);
    const delDate = ocvDeliveredDate(r);
    const setDate = ocvSettlementDate(r);
    const gross = ocvNum(r.total_amount);
    const ret = ocvNum(r.return_amount);
    const net = ocvNum(r.net_amount) || (gross - ret);
    const settledAmt = ocvNum(r.total_settlement_received);
    const balance = ocvNum(r.balance_amount_receivable);

    const isCancelled = ds === 'CANCELLED' || status === 'CANCELLED';
    const isRTO = ds === 'RTO' || status === 'RTO';
    const isLost = /LOST|UNTRACEABLE|ARCHIV/.test(ds) || status === 'OVERPAID / INVESTIGATE';
    const isAdvance = status === 'ADVANCE';
    const returned = ret > 0 || !!ocvDate(r.return_date);
    const partialReturn = returned && ret > 0 && ret < gross - 0.5;

    const dispatched = !!dispatchDate && !isCancelled;
    const delivered = !isRTO && !isCancelled && (ds === 'DELIVERED' || (!!delDate && (!asOf || delDate <= asOf)));
    const returnedPostDelivery = returned && (delivered || !!delDate);

    const settled = !isCancelled && (status === 'RECONCILED' || (balance === 0 && settledAmt > 0));
    const unsettled = dispatched && !isCancelled && !settled;
    const shortRemittance = settled && settledAmt > 0 && settledAmt < net - 1 && !returned;
    const crossMonth = !!(setDate && dispatchDate && ocvMonthKey(setDate) !== ocvMonthKey(dispatchDate));
    const returnReceived = returned && (settled || status === 'RECONCILED' || balance === 0);

    return {
        gross, ret, net, settledAmt, balance, dispatchDate,
        isCancelled, isRTO, isLost, isAdvance,
        returned, partialReturn, returnedPostDelivery, returnReceived,
        dispatched, delivered, settled, unsettled, shortRemittance, crossMonth,
        paymentMethod: ocvPaymentMethod(r),
        courier: ocvCourier(r),
        srn: !!r.srn,
        advanceAmount: isAdvance ? gross : 0,
        payableAmount: (returned && (settled || isAdvance || settledAmt > 0)) ? ret : 0,
    };
}
function ocvScenario(f, courierFileSet) {
    if (f.paymentMethod === 'Prepaid') {
        if (f.returned && f.settled) return f.partialReturn ? 'prepaid_settled_then_returned_partial' : 'prepaid_settled_then_returned_full';
        if (f.settled) return 'prepaid_settled_clean';
        return null;
    }
    if (f.returned && f.settled) return f.partialReturn ? 'cod_settled_then_returned_partial' : 'cod_settled_then_returned';
    if (f.returned) return 'cod_returned_never_settled';
    if (f.settled) {
        if (f.shortRemittance) return 'cod_settled_short_remittance';
        if (f.crossMonth) return 'cod_settled_late_cross_month';
        return 'cod_settled_clean';
    }
    return courierFileSet.has(f.courier) ? 'cod_pending' : 'cod_pending_no_settlement_source';
}
function ocvPackageBucket(f) {
    if (f.isLost) return 'lost';
    if (!f.dispatched) return 'withBrandNotDispatched';
    if (f.returned || f.isRTO) return f.returnReceived ? 'backWithBrand' : 'returningToBrand';
    if (f.delivered) return 'withCustomer';
    return 'withCourierTransit';
}
function ocvCashAction(f) {
    if (f.isLost) return 'investigate';
    if (f.returned || f.isRTO) return f.returnReceived ? 'refundNow' : 'hold';
    if (f.delivered && f.unsettled) return 'awaitRemittance';
    if (f.dispatched && !f.delivered) return 'noAction';
    return null;
}
/** Build the overview blocks from the already-filtered report rows. */
function ocvBuildOverview(rows, asOf) {
    const courierFileSet = ocvCouriersWithSettlement(rows);
    const vol = { ordersPlaced: 0, cancelled: 0, dispatched: 0, delivered: 0, rtoLost: 0, returnedPostDelivery: 0 };
    const cash = { netSales: 0, received: 0, advanceAmount: 0, payableAmount: 0 };
    const scen = Object.fromEntries(OCV_SCENARIO_ROWS.map(s => [s.key, 0]));
    const pkg = Object.fromEntries(OCV_PACKAGE_ROWS.map(s => [s.key, 0]));
    const act = Object.fromEntries(OCV_CASHACTION_ROWS.map(s => [s.key, { prepaid: 0, cod: 0 }]));
    // Net-amount accumulators, parallel to the count accumulators above — used to
    // surface an "Amount" + "% share of amount" column beside every order count.
    const funAmt = { ordersPlaced: 0, cancelledPreDispatch: 0, dispatched: 0, delivered: 0, rtoLost: 0, returnedPostDelivery: 0, netDelivered: 0 };
    const scenAmt = Object.fromEntries(OCV_SCENARIO_ROWS.map(s => [s.key, 0]));
    const pkgAmt = Object.fromEntries(OCV_PACKAGE_ROWS.map(s => [s.key, 0]));
    const actAmt = Object.fromEntries(OCV_CASHACTION_ROWS.map(s => [s.key, { prepaid: 0, cod: 0 }]));
    let cancelledPreDispatch = 0;
    for (const r of rows) {
        const f = ocvFacts(r, asOf);
        const amt = f.net;
        vol.ordersPlaced += 1;
        funAmt.ordersPlaced += amt;
        if (f.isCancelled) vol.cancelled += 1;
        if (f.isCancelled && !f.dispatchDate) { cancelledPreDispatch += 1; funAmt.cancelledPreDispatch += amt; }
        if (f.dispatched) { vol.dispatched += 1; funAmt.dispatched += amt; }
        if (f.delivered) { vol.delivered += 1; funAmt.delivered += amt; }
        if (f.isRTO || f.isLost) { vol.rtoLost += 1; funAmt.rtoLost += amt; }
        if (f.returnedPostDelivery) { vol.returnedPostDelivery += 1; funAmt.returnedPostDelivery += amt; }
        cash.netSales += f.net;
        cash.received += f.settledAmt;
        cash.advanceAmount += f.advanceAmount;
        cash.payableAmount += f.payableAmount;
        const sk = ocvScenario(f, courierFileSet);
        if (sk) { scen[sk] += 1; scenAmt[sk] += amt; }
        const pb = ocvPackageBucket(f);
        pkg[pb] += 1;
        pkgAmt[pb] += amt;
        const ck = ocvCashAction(f);
        if (ck) {
            const pmk = f.paymentMethod === 'COD' ? 'cod' : 'prepaid';
            act[ck][pmk] += 1;
            actAmt[ck][pmk] += amt;
        }
    }
    const r2 = (n) => Math.round(n * 100) / 100;
    const netDelivered = Math.max(0, vol.delivered - vol.returnedPostDelivery);
    funAmt.netDelivered = funAmt.delivered - funAmt.returnedPostDelivery;
    // % share helpers: funnel stages are subsets of "Orders Placed" so their share
    // is measured against that; the other three tables are mutually-exclusive
    // buckets, so their share is measured against the table's own column total.
    const pctOf = (part, whole) => (whole ? r2((part / whole) * 100) : 0);
    const scenAmtTotal = Object.values(scenAmt).reduce((a, b) => a + b, 0);
    const pkgAmtTotal = Object.values(pkgAmt).reduce((a, b) => a + b, 0);
    const actAmtTotal = OCV_CASHACTION_ROWS.reduce((t, s) => t + actAmt[s.key].prepaid + actAmt[s.key].cod, 0);
    return {
        volume: { ...vol, netDelivered },
        cash: {
            netSales: r2(cash.netSales),
            received: r2(cash.received),
            balance: r2(cash.netSales - cash.received),
            advanceAmount: r2(cash.advanceAmount),
            payableAmount: r2(cash.payableAmount),
        },
        funnel: [
            { n: 1, stage: 'Orders Placed', metric: 'ordersPlaced', count: vol.ordersPlaced, amount: r2(funAmt.ordersPlaced), pctAmount: pctOf(funAmt.ordersPlaced, funAmt.ordersPlaced), calc: 'count of order lines in the Sales Order file (period / brand / channel filter)' },
            { n: 2, stage: 'Cancelled (pre-dispatch)', metric: 'cancelledPreDispatch', count: cancelledPreDispatch, amount: r2(funAmt.cancelledPreDispatch), pctAmount: pctOf(funAmt.cancelledPreDispatch, funAmt.ordersPlaced), calc: 'reconciliation status CANCELLED with no dispatch date' },
            { n: 3, stage: 'Dispatched', metric: 'dispatched', count: vol.dispatched, amount: r2(funAmt.dispatched), pctAmount: pctOf(funAmt.dispatched, funAmt.ordersPlaced), calc: 'dispatch date present / status in the Dispatch Scenarios list' },
            { n: 4, stage: 'Delivered', metric: 'delivered', count: vol.delivered, amount: r2(funAmt.delivered), pctAmount: pctOf(funAmt.delivered, funAmt.ordersPlaced), calc: 'courier status in the Delivered list' },
            { n: 5, stage: 'RTO / lost in transit', metric: 'rtoLost', count: vol.rtoLost, amount: r2(funAmt.rtoLost), pctAmount: pctOf(funAmt.rtoLost, funAmt.ordersPlaced), calc: 'status RTO_* / LOST / LT-LOST / UNTRACEABLE' },
            { n: 6, stage: 'Returned after delivery', metric: 'returnedPostDelivery', count: vol.returnedPostDelivery, amount: r2(funAmt.returnedPostDelivery), pctAmount: pctOf(funAmt.returnedPostDelivery, funAmt.ordersPlaced), calc: 'return date present / matched in the SRN-Refunds file' },
            { n: 7, stage: 'Net delivered (kept)', metric: 'netDelivered', count: netDelivered, amount: r2(funAmt.netDelivered), pctAmount: pctOf(funAmt.netDelivered, funAmt.ordersPlaced), calc: 'Delivered − Returned after delivery' },
        ],
        scenarios: OCV_SCENARIO_ROWS.map(s => ({ ...s, count: scen[s.key], amount: r2(scenAmt[s.key]), pctAmount: pctOf(scenAmt[s.key], scenAmtTotal) })),
        packageStatus: OCV_PACKAGE_ROWS.map(s => ({ ...s, count: pkg[s.key], amount: r2(pkgAmt[s.key]), pctAmount: pctOf(pkgAmt[s.key], pkgAmtTotal) })),
        cashActions: OCV_CASHACTION_ROWS.map(s => {
            const amount = actAmt[s.key].prepaid + actAmt[s.key].cod;
            return { ...s, prepaid: act[s.key].prepaid, cod: act[s.key].cod, amount: r2(amount), pctAmount: pctOf(amount, actAmtTotal) };
        }),
    };
}

/** Volume-strip / funnel drill predicate for one order. */
function ocvMatchesFunnelMetric(f, metric) {
    switch (metric) {
        case 'cancelled':             return f.isCancelled;
        case 'cancelledPreDispatch':  return f.isCancelled && !f.dispatchDate;
        case 'dispatched':            return f.dispatched;
        case 'delivered':             return f.delivered;
        case 'rtoLost':               return f.isRTO || f.isLost;
        case 'returnedPostDelivery':  return f.returnedPostDelivery;
        case 'netDelivered':          return f.delivered && !f.returnedPostDelivery;
        case 'received':              return f.settledAmt > 0;
        case 'balance':               return (f.net - f.settledAmt) > 0.5;
        case 'advanceAmount':         return f.isAdvance;
        case 'payableAmount':         return f.payableAmount > 0;
        case 'ordersPlaced':
        case 'netSales':
        default:                      return true;
    }
}

/** Filter already-loaded report rows to one overview bucket (funnel / scenario / package / cash-action). */
function ocvFilterRows(allRows, opts) {
    const { funnelMetric, scenario, pkgBucket, cashAction, payment, search, asOf } = opts;
    const courierFileSet = ocvCouriersWithSettlement(allRows);
    const q = (search || '').toLowerCase().trim();
    const out = [];
    for (const r of allRows) {
        const f = ocvFacts(r, asOf);
        if (scenario) {
            if (ocvScenario(f, courierFileSet) !== scenario) continue;
        } else if (pkgBucket) {
            if (ocvPackageBucket(f) !== pkgBucket) continue;
        } else if (cashAction) {
            if (ocvCashAction(f) !== cashAction) continue;
            if (payment && f.paymentMethod !== payment) continue;
        } else if (!ocvMatchesFunnelMetric(f, funnelMetric || 'ordersPlaced')) {
            continue;
        }
        if (q) {
            const hay = `${r.sale_order_number || ''} ${r.invoice_number || ''} ${r.awb_number || ''}`.toLowerCase();
            if (!hay.includes(q)) continue;
        }
        out.push(r);
    }
    return out;
}

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

        const allRows = await Model.findAll({ where: { filename: decodedFilename }, raw: true });
        if (!allRows.length) return res.status(404).json({ error: 'No data found for this file' });

        // The upload is tagged with one month/year, but the underlying orders' own
        // dates (dispatch_or_cancellation_date, stored as `date`) routinely span a
        // wider window than that single label (settlement/processing lag). Surface
        // the real span so the UI can show it instead of the raw filename, and let
        // the caller narrow the report to a sub-range of it via fromDate/toDate.
        const rowDates = allRows.map(r => r.date).filter(Boolean).map(d => new Date(d));
        const availableRange = rowDates.length
            ? {
                from: new Date(Math.min(...rowDates)).toISOString().slice(0, 10),
                to: new Date(Math.max(...rowDates)).toISOString().slice(0, 10),
            }
            : { from: null, to: null };

        const fromDate = req.query.fromDate ? new Date(req.query.fromDate) : null;
        const toDate = req.query.toDate ? new Date(req.query.toDate) : null;
        const rows = (fromDate || toDate)
            ? allRows.filter(r => {
                if (!r.date) return false;
                const d = new Date(r.date);
                if (fromDate && d < fromDate) return false;
                if (toDate && d > toDate) return false;
                return true;
            })
            : allRows;
        if (!rows.length) return res.status(404).json({ error: 'No data found in this date range', availableRange });

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

        // Order-Cycle Overview (Page-1 spec) — additive sections over the same rows.
        const _reportDates = rows.map(r => r.date).filter(Boolean).map(d => new Date(d));
        const overviewAsOf = toDate || (_reportDates.length ? new Date(Math.max(..._reportDates.map(d => d.getTime()))) : new Date());
        const overview = ocvBuildOverview(rows, overviewAsOf);

        res.json({
            totalOrders,
            availableRange,
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
            // ── Order-Cycle Overview (Page-1 spec) ──
            volume: overview.volume,
            cash: overview.cash,
            funnel: overview.funnel,
            scenarios: overview.scenarios,
            packageStatus: overview.packageStatus,
            cashActions: overview.cashActions,
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
 * tab: matched|mismatched|unsettled|all
 * sub (matched):    return|notreturn (omit/'all' → every matched order)
 *   - return        → matched orders whose sale_order_number also matches a Return GST
 *                     record (return_amount > 0) — reconciled AND was returned; the
 *                     settlement still lines up against the post-return net_amount.
 *   - notreturn     → matched orders with no matching return record at all
 * sub (mismatched): less|more|return|notreturn|advance
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
function buildTransactionsWhere(decodedFilename, tab, sub, search, fromDate, toDate) {
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
        if (tab === 'matched') {
            where.reconciliation_status = 'RECONCILED';
            if (sub === 'return')    where.return_amount = { [Op.gt]: 0 };
            if (sub === 'notreturn') {
                where[Op.and] = [
                    { [Op.or]: [{ return_amount: { [Op.lte]: 0 } }, { return_amount: null }] },
                ];
            }
        }
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

    // Narrows to a sub-range of the file's own order dates (see getReportData's
    // availableRange) — same `date` column (dispatch_or_cancellation_date), so a
    // range picked against the report view lines up with what this view shows.
    if (fromDate || toDate) {
        const dateCond = { date: {} };
        if (fromDate) dateCond.date[Op.gte] = fromDate;
        if (toDate)   dateCond.date[Op.lte] = toDate;
        if (where[Op.and]) where[Op.and].push(dateCond);
        else                where[Op.and] = [dateCond];
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
        const fromDate = req.query.fromDate ? new Date(req.query.fromDate) : null;
        const toDate   = req.query.toDate ? new Date(req.query.toDate) : null;

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);
        await Model.sync();

        const where = buildTransactionsWhere(decodedFilename, tab, sub, search, fromDate, toDate);

        const { count: total, rows } = await Model.findAndCountAll({
            where,
            limit:  pageSize,
            offset: (page - 1) * pageSize,
            raw:    true,
        });

        // Enrich this page's rows with receivable_ledger data on AWB — it's the
        // trustworthy source for delivery status/payment method/courier/SRN (see
        // classifyOrderScenario's doc comment below), so the Transaction Data
        // table reconciles against it rather than shopify_order_cycle's own,
        // less reliable settlement columns.
        const { QueryTypes } = require('sequelize');
        const awbs = [...new Set(rows.map(r => r.awb_number).filter(Boolean))];
        const ledgerByAwb = {};
        if (awbs.length) {
            const ledgerRows = await brandDb.query(
                `SELECT awb, delivery_status, payment_method, courier, settled_flag,
                        settled_amount, settled_source, settled_date, srn,
                        dispatch_or_cancellation_date, return_date
                 FROM receivable_ledger
                 WHERE brand_id = $1 AND awb = ANY($2)`,
                { bind: [brandId, awbs], type: QueryTypes.SELECT }
            );
            for (const lr of ledgerRows) ledgerByAwb[lr.awb] = lr;
        }

        const TX_OMIT = new Set(['year', 'month', 'date', 'filename', 'file_type', 'inventory_type', 'created_at']);
        const txRows = rows.map(r => {
            const ledger = ledgerByAwb[r.awb_number] || null;
            const scenario = classifyOrderScenario({
                delivery_status: r.delivery_status,
                srn: r.srn,
                dispatch_or_cancellation_date: r.dispatch_or_cancellation_date,
                return_date: r.return_date,
                total_amount: r.total_amount,
                shipping_partner: r.shipping_partner,
                rl_delivery_status: ledger?.delivery_status ?? null,
                rl_payment_method: ledger?.payment_method ?? null,
                rl_courier: ledger?.courier ?? null,
                settled_flag: ledger?.settled_flag ?? null,
                settled_amount: ledger?.settled_amount ?? null,
                settled_source: ledger?.settled_source ?? null,
                rl_srn: ledger?.srn ?? null,
                rl_dispatch_date: ledger?.dispatch_or_cancellation_date ?? null,
                rl_return_date: ledger?.return_date ?? null,
            });

            const out = {};
            for (const k of Object.keys(r)) {
                if (!TX_OMIT.has(k)) out[k] = r[k];
            }
            out.scenario = scenario;
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
        const fromDate = req.query.fromDate ? new Date(req.query.fromDate) : null;
        const toDate   = req.query.toDate ? new Date(req.query.toDate) : null;

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const brandDb   = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model     = getDynamicModel(brandDb, tableName, agent.columns);
        await Model.sync();

        const where = buildTransactionsWhere(decodedFilename, 'all', null, search, fromDate, toDate);
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

// ─── Order Scenario classification (used inline by getTransactions) ──────────

/**
 * Classify a shopify_order_cycle row (merged with its matched receivable_ledger
 * columns) into a fulfilment/cancellation scenario. Surfaced as extra columns on
 * the Transaction Data table (getTransactions) rather than as a separate report.
 *
 * receivable_ledger is the trustworthy source for delivery_status/payment_method/
 * srn — shopify_order_cycle.delivery_status carries no CANCELLED/RTO values at all
 * for Flo Mattress, only DELIVERED/partial/blank, because its own courier/gateway
 * matching never resolved those orders. The rl_* (receivable_ledger) columns are
 * preferred; shopify_order_cycle's own columns are only used as a fallback for the
 * rare row with no receivable_ledger match (~1 in 66,560 for Flo Mattress).
 *
 * Cancellation reason text and the fine "delivery not accepted" / "not available
 * for pickup" / "customer return" split aren't captured in any currently uploaded
 * source file, so cancelled orders only get the 2 buckets derivable from real
 * fields (return date presence). A third "Not Dispatched" bucket (order cancelled
 * before ever leaving the warehouse) was tried and dropped — confirmed by direct
 * query that dispatch_or_cancellation_date is populated on 100% of Flo Mattress's
 * cancelled orders, so "no dispatch date" can't distinguish that case with the
 * data available today. Re-add it if a source file ever carries a real signal.
 */
function classifyOrderScenario(row) {
    const effectiveStatus = (row.rl_delivery_status || row.delivery_status || '').toUpperCase().trim();
    const effectiveSrn    = row.rl_srn || row.srn || null;
    const dispatchDate    = row.rl_dispatch_date || row.dispatch_or_cancellation_date || null;
    const returnDate      = row.rl_return_date || row.return_date || null;
    const paymentMethod   = (row.rl_payment_method || '').toUpperCase().trim() || null;

    let bucket = 'PENDING';
    let cancelSubScenario = null;
    let holder = null;

    if (effectiveStatus === 'DELIVERED') {
        bucket = 'FULFILLED';
    } else if (effectiveStatus === 'CANCELLED' || effectiveStatus === 'RTO') {
        bucket = 'CANCELLED';
        if (returnDate) {
            cancelSubScenario = 'DELIVERED_RETURNED';
            holder = 'Customer';
        } else {
            cancelSubScenario = 'DISPATCHED_CANCELLED_RTO';
            holder = 'Delivery Partner';
        }
    }

    const srnStatus    = effectiveSrn ? 'Generated' : 'Missing';
    const totalAmount  = Number(row.total_amount) || 0;
    const refundDue    = (bucket === 'CANCELLED' && paymentMethod === 'PREPAID') ? totalAmount : 0;

    return {
        bucket,
        cancelSubScenario,
        holder,
        srnStatus,
        paymentMethod,
        courier: row.rl_courier || row.shipping_partner || null,
        dispatchDate,
        returnDate,
        settledFlag: !!row.settled_flag,
        settledAmount: Number(row.settled_amount) || 0,
        settledSource: row.settled_source || null,
        refundDue,
        reasonAvailable: false, // static placeholder flag — no source file carries this yet
    };
}

// ─── Overview drill-down transactions (numbers in the Page-1 tables) ─────────
//
// Feeds the "click a number → orders in a modal" flow for the Order Journey
// Funnel / Scenario Catalog / Package Status / Cash Action tables. Same per-file,
// date-scoped rows as getReportData; one of funnelMetric | scenario | pkgBucket |
// cashAction (+ optional payment for the Prepaid/COD split) selects the bucket.
const getOverviewDrill = async (req, res, next) => {
    try {
        const { brandId, agentId, filename } = req.params;
        const decodedFilename = decodeURIComponent(filename);

        const page     = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize  = Math.min(200, Math.max(10, parseInt(req.query.pageSize) || 50));
        const fromDate  = req.query.fromDate ? new Date(req.query.fromDate) : null;
        const toDate    = req.query.toDate ? new Date(req.query.toDate) : null;

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);
        if (!brand || !agent) return res.status(404).json({ error: 'Brand or Agent not found' });

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);
        await Model.sync();

        const allRows = await Model.findAll({ where: { filename: decodedFilename }, raw: true });
        const scoped = (fromDate || toDate)
            ? allRows.filter(r => {
                if (!r.date) return false;
                const d = new Date(r.date);
                if (fromDate && d < fromDate) return false;
                if (toDate && d > toDate) return false;
                return true;
            })
            : allRows;

        const _d = scoped.map(r => r.date).filter(Boolean).map(x => new Date(x));
        const asOf = toDate || (_d.length ? new Date(Math.max(..._d.map(x => x.getTime()))) : new Date());

        const filtered = ocvFilterRows(scoped, {
            funnelMetric: req.query.funnelMetric || null,
            scenario: req.query.scenario || null,
            pkgBucket: req.query.pkgBucket || null,
            cashAction: req.query.cashAction || null,
            payment: req.query.payment || null,
            search: req.query.search || '',
            asOf,
        });
        filtered.sort((a, b) => {
            const da = ocvDispatchDate(a), db = ocvDispatchDate(b);
            return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
        });

        const total = filtered.length;

        // Column totals across the WHOLE filtered set (not just this page).
        const r2 = (n) => Math.round(n * 100) / 100;
        const sumBy = (getter) => filtered.reduce((s, r) => s + (Number(getter(r)) || 0), 0);
        const totals = {
            gross: r2(sumBy(r => r.total_amount)),
            ret: r2(sumBy(r => r.return_amount)),
            net: r2(sumBy(r => r.net_amount)),
            settled: r2(sumBy(r => r.total_settlement_received)),
            balance: r2(sumBy(r => r.balance_amount_receivable)),
        };

        const TX_OMIT = new Set(['year', 'month', 'filename', 'file_type', 'inventory_type', 'created_at']);
        const rows = filtered.slice((page - 1) * pageSize, page * pageSize).map(r => {
            const out = {};
            for (const k of Object.keys(r)) if (!TX_OMIT.has(k)) out[k] = r[k];
            out.payment_method = ocvPaymentMethod(r);
            out.courier_group = ocvCourier(r);
            return out;
        });

        res.json({ rows, total, totals, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    } catch (error) {
        console.error('[OrderCycle] OverviewDrill Error:', error);
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
    getOverviewDrill,
};

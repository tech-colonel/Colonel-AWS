const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { Op } = require('sequelize');
const fs = require('fs-extra');

const OUTPUT_DIR = path.join(__dirname, '../../../../outputs');

async function ensureDir() {
    await fs.ensureDir(OUTPUT_DIR);
}

/**
 * Map a raw Excel row to the Settlement-Amazon DB schema.
 * Handles various header naming conventions from Amazon settlement reports.
 */
const mapRowToSettlementSchema = (row) => {
    // Helper: try multiple header names for the same field
    const get = (...keys) => {
        for (const k of keys) {
            if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
        }
        return null;
    };

    return {
        date_time: get('date/time', 'Date/Time', 'date_time', 'DateTime'),
        settlement_id: get('settlement id', 'Settlement Id', 'settlement_id', 'Settlement id'),
        type: get('type', 'Type'),
        order_id: get('order id', 'Order Id', 'order_id', 'Order ID'),
        sku: get('sku', 'SKU', 'Sku'),
        description: get('description', 'Description'),
        quantity: get('quantity', 'Quantity'),
        marketplace: get('marketplace', 'Marketplace'),
        account_type: get('account type', 'Account Type', 'account_type'),
        fulfillment: get('fulfillment', 'Fulfillment', 'fulfilment'),
        order_city: get('order city', 'Order City', 'order_city'),
        order_state: get('order state', 'Order State', 'order_state'),
        order_postal: get('order postal', 'Order Postal', 'order_postal'),
        product_sales: get('product sales', 'Product Sales', 'product_sales'),
        shipping_credits: get('shipping credits', 'Shipping Credits', 'shipping_credits'),
        gift_wrap_credits: get('gift wrap credits', 'Gift Wrap Credits', 'gift_wrap_credits'),
        promotional_rebates: get('promotional rebates', 'Promotional Rebates', 'promotional_rebates'),
        gst_before_tcs: get('Total sales tax liable(GST before adjusting TCS)', 'GST collected by Amazon before TCS', 'gst_before_tcs', 'GST Before TCS'),
        tcs_cgst: get('TCS-CGST', 'tcs_cgst', 'TCS CGST'),
        tcs_sgst: get('TCS-SGST', 'tcs_sgst', 'TCS SGST'),
        tcs_igst: get('TCS-IGST', 'tcs_igst', 'TCS IGST'),
        tds_194o: get('TDS (Section 194-O)', 'TDS u/s 194O', 'tds_194o', 'TDS 194O', 'TDS u/s 194-O'),
        selling_fees: get('selling fees', 'Selling Fees', 'selling_fees'),
        fba_fees: get('fba fees', 'FBA Fees', 'fba_fees', 'FBA fees'),
        other_transaction_fees: get('other transaction fees', 'Other Transaction Fees', 'other_transaction_fees'),
        other: get('other', 'Other'),
        total: get('total', 'Total'),
    };
};

/**
 * Upload settlement file — parse Excel, store rows in brand DB
 */
const uploadSettlement = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;

        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ error: 'File is required' });
        }

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found' });
        }

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        // Parse the uploaded Excel file
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawData = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (!rawData || rawData.length === 0) {
            return res.status(400).json({ error: 'No data found in the uploaded file' });
        }

        // Generate a unique filename for tracking
        const fileId = uuidv4();
        const filename = `settlement_amazon_${brand.name}_${fileId}.xlsx`;

        // Save the original file to outputs for download
        await ensureDir();
        const filePath = path.join(OUTPUT_DIR, filename);
        await fs.writeFile(filePath, req.file.buffer);

        // Map rows to schema and add metadata
        const finalData = rawData.map(row => ({
            ...mapRowToSettlementSchema(row),
            filename,
        }));

        // Sync table and bulk insert
        await Model.sync({ alter: true });
        const rows = await Model.bulkCreate(finalData, { returning: true });

        res.json({
            success: true,
            message: 'Settlement file uploaded and stored successfully',
            data: {
                filename,
                count: finalData.length,
            }
        });

    } catch (error) {
        console.error('Settlement upload error:', error);
        next(error);
    }
};

/**
 * Get all uploaded settlement files (grouped by filename)
 */
const getSettlementFiles = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found' });
        }

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const rows = await Model.findAll({
            attributes: ['id', 'filename', 'settlement_id', 'created_at'],
            order: [['created_at', 'DESC']],
            raw: true
        });

        // Group by filename and return unique files
        const uniqueFilesMap = new Map();
        for (const row of rows) {
            if (row.filename && !uniqueFilesMap.has(row.filename)) {
                uniqueFilesMap.set(row.filename, {
                    id: row.id,
                    filename: row.filename,
                    settlement_id: row.settlement_id,
                    created_at: row.created_at,
                });
            }
        }

        res.json(Array.from(uniqueFilesMap.values()));

    } catch (error) {
        next(error);
    }
};

/**
 * Download a settlement file by ID (looks up filename from the row)
 */
const downloadSettlementFile = async (req, res, next) => {
    try {
        const { brandId, agentId, fileId } = req.params;

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found' });
        }

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const file = await Model.findByPk(fileId);
        if (!file || !file.filename) {
            return res.status(404).json({ error: 'File not found' });
        }

        const filePath = path.join(OUTPUT_DIR, file.filename);
        if (!(await fs.pathExists(filePath))) {
            return res.status(404).json({ error: 'File not found on disk' });
        }

        res.download(filePath, file.filename);

    } catch (error) {
        next(error);
    }
};

/**
 * Delete a settlement file and all its associated DB rows
 */
const deleteSettlementFile = async (req, res, next) => {
    try {
        const { brandId, agentId, fileId } = req.params;

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found' });
        }

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const file = await Model.findByPk(fileId);
        if (file && file.filename) {
            // Delete file from disk
            const filePath = path.join(OUTPUT_DIR, file.filename);
            if (await fs.pathExists(filePath)) {
                await fs.unlink(filePath);
            }
            // Delete ALL rows with this filename
            await Model.destroy({ where: { filename: file.filename } });
        }

        res.json({ success: true, message: 'Settlement file deleted successfully' });

    } catch (error) {
        next(error);
    }
};

/**
 * Get all settlement data (for viewing in table)
 */
const getSettlementData = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const { filename } = req.query;

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found' });
        }

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const whereClause = filename ? { filename } : {};

        const rows = await Model.findAll({
            where: whereClause,
            order: [['created_at', 'DESC']],
            raw: true
        });

        res.json({ success: true, data: rows, count: rows.length });

    } catch (error) {
        next(error);
    }
};

/**
 * Generate MIS Report for Settlement-Amazon
 */
const generateSettlementMIS = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const { startMonth, endMonth, startYear, endYear } = req.body;

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found' });
        }

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const monthMap = {
            'January': 0, 'February': 1, 'March': 2, 'April': 3,
            'May': 4, 'June': 5, 'July': 6, 'August': 7,
            'September': 8, 'October': 9, 'November': 10, 'December': 11
        };

        const startDate = new Date(startYear, monthMap[startMonth], 1);
        const endDate = new Date(endYear, monthMap[endMonth] + 1, 0); // Last day of endMonth

        // We also want data from the previous month to calculate Growth %
        const prevMonthDate = new Date(startDate);
        prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);

        const pad = (n) => String(n).padStart(2, '0');

        // Format to YYYY-MM-DD for lexical string comparison 
        // Example: '2025-01-01'
        const prevMonthStr = `${prevMonthDate.getFullYear()}-${pad(prevMonthDate.getMonth() + 1)}-01`;

        // Example: '2025-03-31 23:59:59' - appending high time to catch all times on the last day
        const endMonthStr = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())} 23:59:59`;

        const allData = await Model.findAll({
            where: {
                date_time: {
                    [Op.gte]: prevMonthStr,
                    [Op.lte]: endMonthStr
                }
            },
            raw: true
        });

        // Group data by Month-Year (e.g., "Mar 2026")
        // and also keep previous month separate for Growth %

        const formatMY = (d) => {
            const date = new Date(d);
            return `${date.toLocaleString('en-US', { month: 'short' })} ${date.getFullYear()}`;
        };

        const periodKeys = [];
        let curr = new Date(startDate);
        while (curr <= endDate) {
            periodKeys.push(formatMY(curr));
            curr.setMonth(curr.getMonth() + 1);
        }

        const groupedData = {};
        for (const pk of periodKeys) {
            groupedData[pk] = [];
        }

        const prevData = [];

        // Parse row dates considering the timezone offset +05:30 might be present
        for (const row of allData) {
            if (!row.date_time) continue;
            // The date_time might be "2025-01-21 12:28:36+05:30"
            // JS `new Date()` parses ISO 8601, so we replace space with 'T' if needed, 
            // though most engines parse "YYYY-MM-DD HH:mm:ss+ZZ:ZZ" directly.
            let dtStr = row.date_time;
            if (typeof dtStr === 'string' && dtStr.includes(' ') && dtStr.includes('+')) {
                dtStr = dtStr.replace(' ', 'T');
            }
            const rowDate = new Date(dtStr);

            if (rowDate >= startDate && rowDate <= new Date(endYear, monthMap[endMonth] + 1, 0, 23, 59, 59, 999)) {
                const key = formatMY(rowDate);
                if (groupedData[key]) {
                    groupedData[key].push(row);
                }
            } else if (rowDate >= prevMonthDate && rowDate < startDate) {
                prevData.push(row);
            }
        }

        const getSum = (arr, filterFn, valueFn) => {
            return arr.filter(filterFn).reduce((sum, r) => sum + (Number(valueFn(r)) || 0), 0);
        };

        const getCount = (arr, filterFn) => {
            return arr.filter(filterFn).length;
        };

        const safeDiv = (num, den) => (den === 0 ? 0 : num / den);

        // Helper to calculate metrics for a specific dataset
        const calcMetrics = (data) => {
            const orderIdRegex = /^\d{3}-\d{7}-\d{7}$/;
            const uniqueOrderIds = new Set(
                data.filter(r => r.order_id && orderIdRegex.test(String(r.order_id).trim()))
                    .map(r => String(r.order_id).trim())
            );
            const noOfOrders = uniqueOrderIds.size;
            const grossUnitsSold = getSum(data, r => (r.type || '').toLowerCase() === 'order', r => r.quantity);
            const unitsReturned = getSum(data, r => (r.type || '').toLowerCase() === 'refund', r => r.quantity);
            const netUnitsSold = grossUnitsSold - unitsReturned;
            const returnRate = safeDiv(unitsReturned, grossUnitsSold) * 100;

            const gmv = getSum(data, r => (r.type || '').toLowerCase() === 'order', r => (Number(r.product_sales) || 0) + (Number(r.gst_before_tcs) || 0));
            const refund = getSum(data, r => (r.type || '').toLowerCase() === 'refund', r => (Number(r.product_sales) || 0) + (Number(r.gst_before_tcs) || 0));
            const netSales = gmv - Math.abs(refund);
            const taxes = getSum(data, r => ['order', 'refund'].includes((r.type || '').toLowerCase()), r => r.gst_before_tcs);
            const revenue = netSales - taxes;

            const aov = safeDiv(gmv, noOfOrders);
            const asp = safeDiv(gmv, grossUnitsSold);

            const cogs = 0; // Cost of Goods Sold is not available directly
            const productMargin = revenue - cogs;
            const pmPercent = safeDiv(productMargin, revenue) * 100;

            const sellingFees = getSum(data, () => true, r => r.selling_fees);
            const easyShip = getSum(data, r => (r.type || '').toLowerCase() === 'shipping services', r => r.other_transaction_fees);
            const orderCancel = getSum(data, r => (r.type || '').toLowerCase() === 'service fee' && (r.description || '').toLowerCase() !== 'cost of advertising', r => r.other_transaction_fees);
            const otherShipping = getSum(data, r => ['order', 'refund'].includes((r.type || '').toLowerCase()), r => r.other_transaction_fees);
            const accountMgmt = getSum(data, r => (r.type || '').toLowerCase() === 'others', r => r.other);
            const otherAdj = getSum(data, r => (r.type || '').toLowerCase() === 'adjustment' || (r.type || '').toLowerCase() === 'clawbacks', r => r.other);

            const expenses = Math.abs(sellingFees) + Math.abs(easyShip) + Math.abs(orderCancel) + Math.abs(otherShipping) + Math.abs(accountMgmt) + Math.abs(otherAdj);

            const cm1 = productMargin - expenses;
            const cm1Percent = safeDiv(cm1, revenue) * 100;

            const costOfAdv = getSum(data, r => (r.type || '').toLowerCase() === 'service fee' && (r.description || '').toLowerCase() === 'cost of advertising', r => r.other_transaction_fees);
            const cm2 = cm1 - Math.abs(costOfAdv);
            const cm2Percent = safeDiv(cm2, revenue) * 100;

            const dmgLost = getSum(data, r => (r.type || '').toLowerCase() === 'reimbursements', r => r.other);
            const safet = getSum(data, r => (r.type || '').toLowerCase() === 'safe-t reimbursement', r => r.other);

            const taxesAll = getSum(data, () => true, r => r.gst_before_tcs);
            const tds194o = getSum(data, () => true, r => r.tds_194o);
            const tcsCgst = getSum(data, () => true, r => r.tcs_cgst);
            const tcsSgst = getSum(data, () => true, r => r.tcs_sgst);
            const tcsIgst = getSum(data, () => true, r => r.tcs_igst);
            const tcsOnGst = tcsCgst + tcsSgst + tcsIgst;

            const transfers = getSum(data, r => (r.type || '').toLowerCase() === 'transfer', r => r.other);
            const settlement = cm2 + dmgLost + safet + taxesAll + tds194o + tcsOnGst + transfers;

            return {
                noOfOrders, grossUnitsSold, unitsReturned, netUnitsSold, returnRate,
                gmv, refund, netSales, taxes, revenue, aov, asp,
                cogs, productMargin, pmPercent,
                sellingFees: Math.abs(sellingFees),
                easyShip: Math.abs(easyShip),
                orderCancel: Math.abs(orderCancel),
                otherShipping: Math.abs(otherShipping),
                accountMgmt: Math.abs(accountMgmt),
                otherAdj: Math.abs(otherAdj),
                expenses,
                cm1, cm1Percent,
                costOfAdv: Math.abs(costOfAdv),
                cm2, cm2Percent,
                dmgLost, safet,
                taxesAll, tds194o, tcsOnGst, tcsCgst, tcsSgst, tcsIgst,
                transfers,
                settlement
            };
        };

        const prevMetrics = calcMetrics(prevData);

        const periodMetrics = {};
        for (const pk of periodKeys) {
            periodMetrics[pk] = calcMetrics(groupedData[pk]);
        }

        // Aggregate total dataset for the "Total" column
        // const totalData = allData.filter(r => new Date(r.date_time) >= startDate && new Date(r.date_time) <= endDate);
        // const totalMetrics = calcMetrics(totalData);

        // Build Rows
        const buildRow = (label, isHeader, keyGetter) => {
            const row = { particulars: label, isHeader };
            if (isHeader) return row;

            for (let i = 0; i < periodKeys.length; i++) {
                const pk = periodKeys[i];
                let val = keyGetter(periodMetrics[pk]);

                // For Growth %, we need previous month's revenue
                if (label === 'Growth %') {
                    const currRev = periodMetrics[pk].revenue;
                    const prevRev = i === 0 ? prevMetrics.revenue : periodMetrics[periodKeys[i - 1]].revenue;
                    val = safeDiv(currRev - prevRev, prevRev) * 100;
                }

                row[pk] = val;
            }

            // // Total column
            // let totalVal = keyGetter(totalMetrics);
            // if (label === 'Growth %') {
            //     totalVal = safeDiv(totalMetrics.revenue - prevMetrics.revenue, prevMetrics.revenue) * 100;
            // }
            // row['Total'] = totalVal;

            return row;
        };

        const reportRows = [
            buildRow('No. of Orders', false, m => m.noOfOrders),
            buildRow('Gross Units Sold', false, m => m.grossUnitsSold),
            buildRow('Units Returned', false, m => m.unitsReturned),
            buildRow('Net Units Sold', false, m => m.netUnitsSold),
            buildRow('Return Rate %', false, m => m.returnRate),

            buildRow('SALES', true),
            buildRow('Gross Market Value', false, m => m.gmv),
            buildRow('Refund', false, m => m.refund),
            buildRow('Net Sales', false, m => m.netSales),
            buildRow('Taxes', false, m => m.taxes),
            buildRow('Revenue from sales of goods', false, m => m.revenue),
            buildRow('Growth %', false, m => 0), // handled in buildRow
            buildRow('Average Order Value', false, m => m.aov),
            buildRow('Average Selling Price', false, m => m.asp),

            buildRow('Cost of Goods Sold (COGS)', true),
            buildRow('Cost of Goods Sold', false, m => m.cogs),
            buildRow('Product Margin', false, m => m.productMargin),
            buildRow('PM %', false, m => m.pmPercent),

            buildRow('Expenses', true),
            buildRow('Selling Fees', false, m => m.sellingFees),
            buildRow('Easy Ship weight handling fees', false, m => m.easyShip),
            buildRow('Order Cancellation Charge', false, m => m.orderCancel),
            buildRow('Other Shipping Fees', false, m => m.otherShipping),
            buildRow('Account Management service (ABA)', false, m => m.accountMgmt),
            buildRow('Other Adjustments', false, m => m.otherAdj),
            buildRow('Total Expenses', false, m => m.expenses),

            buildRow('Contribution Margin 1', false, m => m.cm1),
            buildRow('CM 1 %', false, m => m.cm1Percent),

            buildRow('Cost of Advertising', false, m => m.costOfAdv),
            buildRow('Contribution Margin 2', false, m => m.cm2),
            buildRow('CM 2 %', false, m => m.cm2Percent),

            buildRow('Reimbursements', true),
            buildRow('Damage / Lost claim reimbursement', false, m => m.dmgLost),
            buildRow('SAFE-T Reimbursement', false, m => m.safet),

            buildRow('Taxes & Others', true),
            buildRow('Taxes (All)', false, m => m.taxesAll),
            buildRow('TDS (Section 194-O)', false, m => m.tds194o),
            buildRow('TCS on GST', false, m => m.tcsOnGst),
            buildRow('TCS-CGST', false, m => m.tcsCgst),
            buildRow('TCS-SGST', false, m => m.tcsSgst),
            buildRow('TCS-IGST', false, m => m.tcsIgst),

            buildRow('Transfers', false, m => m.transfers),
            buildRow('Settlement', false, m => m.settlement),
        ];

        // Format columns
        const columns = [
            { title: 'Particulars', key: 'particulars' },
            ...periodKeys.map(pk => ({ title: pk, key: pk })),
            // { title: 'Total', key: 'Total' }
        ];

        res.json({
            success: true,
            columns,
            data: reportRows
        });

    } catch (error) {
        console.error('MIS Generation Error:', error);
        next(error);
    }
};

module.exports = {
    uploadSettlement,
    getSettlementFiles,
    downloadSettlementFile,
    deleteSettlementFile,
    getSettlementData,
    generateSettlementMIS,
};

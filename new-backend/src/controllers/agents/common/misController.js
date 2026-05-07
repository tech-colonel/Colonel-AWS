const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const ExcelJS = require('exceljs');
const { Op, Sequelize } = require('sequelize');

const monthMapping = {
    1: 'January', 2: 'February', 3: 'March', 4: 'April',
    5: 'May', 6: 'June', 7: 'July', 8: 'August',
    9: 'September', 10: 'October', 11: 'November', 12: 'December'
};

const generateAmazonMIS = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        let { startMonth, endMonth, startYear, endYear, filterType } = req.body;

        startMonth = parseInt(startMonth);
        endMonth = parseInt(endMonth);
        startYear = parseInt(startYear);
        endYear = parseInt(endYear);

        if (!startMonth || !endMonth || !startYear || !endYear) {
            return res.status(400).json({ error: 'Start/End month and year are required' });
        }

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found' });
        }

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const yyyyMmStart = startYear * 100 + startMonth;
        const yyyyMmEnd = endYear * 100 + endMonth;

        // Build where clause with optional file_type filter
        const whereConditions = [
            Sequelize.where(
                Sequelize.literal('("year" * 100 + "month")'),
                '>=',
                yyyyMmStart
            ),
            Sequelize.where(
                Sequelize.literal('("year" * 100 + "month")'),
                '<=',
                yyyyMmEnd
            )
        ];

        // Apply B2B/B2C filter if specified (not 'combine')
        if (filterType && filterType.toLowerCase() !== 'combine') {
            whereConditions.push({
                file_type: { [Op.iLike]: filterType }
            });
        }

        const allRows = await Model.findAll({
            where: {
                [Op.and]: whereConditions
            }
        });

        // Group by Year-Month
        const grouped = {};
        for (const row of allRows) {
            const m = row.month;
            const y = row.year;
            if (!m || !y) continue;

            const key = `${y}-${String(m).padStart(2, '0')}`;
            if (!grouped[key]) {
                grouped[key] = {
                    year: y,
                    month: m,
                    monthName: `${monthMapping[m]} ${y}`,
                    // New metric accumulators
                    grossUnitsSold: 0,
                    unitsRefund: 0,
                    grossMarketValue: 0,
                    taxes: 0,
                    refund: 0,
                };
            }

            const data = row.dataValues;
            const q = Number(data.quantity) || 0;
            const invAmt = Number(data.invoice_amount) || 0;
            const taxAmt = Number(data.total_tax_amount) || 0;
            const taxExclGross = Number(data.tax_exclusive_gross) || 0;

            const transType = (data.transaction_type || '').toLowerCase().trim();

            // Gross Units Sold: transaction_type = shipment → sum of quantity
            if (transType === 'shipment') {
                grouped[key].grossUnitsSold += q;
            }

            // Units Refund: transaction_type = refund → sum of quantity
            if (transType === 'refund') {
                grouped[key].unitsRefund += q;
            }

            // Gross Market Value: transaction_type = shipment → sum of invoice_amount
            if (transType === 'shipment') {
                grouped[key].grossMarketValue += invAmt;
            }

            // Taxes: sum of total_tax_amount (all rows)
            grouped[key].taxes += taxAmt;

            // Refund: transaction_type = refund → sum of tax_exclusive_gross
            if (transType === 'refund') {
                grouped[key].refund += taxExclGross;
            }
        }

        // Sort keys (chronological)
        const sortedKeys = Object.keys(grouped).sort();

        // Calculate derived per-month metrics
        sortedKeys.forEach(key => {
            const g = grouped[key];

            // Net Units Sold = Gross Units Sold - Units Refund
            g.netUnitsSold = g.grossUnitsSold - g.unitsRefund;

            // Net Sales = Gross Market Value - Taxes
            g.netSales = g.grossMarketValue - g.taxes;

            // Revenue from sales of goods = Net Sales - Refund
            g.revenue = g.netSales - g.refund;

            // Average Order Value = Gross Market Value / Gross Units Sold
            g.aov = g.grossUnitsSold > 0
                ? (g.grossMarketValue / g.grossUnitsSold)
                : 0;

            // Return Rate = Refund / Net Sales
            g.returnRate = g.netSales !== 0
                ? ((g.refund / g.netSales) * 100).toFixed(2) + '%'
                : '0.00%';
        });

        // Columns: Metrics (first column) + Each month (subsequent columns)
        const finalColumns = [{ key: 'metric', title: 'Metrics' }];
        sortedKeys.forEach(k => {
             finalColumns.push({ key: k, title: grouped[k].monthName });
        });

        const metricsToDisplay = [
            { id: 'grossUnitsSold', title: 'Gross Units Sold' },
            { id: 'unitsRefund', title: 'Units Refund' },
            { id: 'netUnitsSold', title: 'Net Units Sold' },
            { id: 'grossMarketValue', title: 'Gross Market Value' },
            { id: 'taxes', title: 'Taxes' },
            { id: 'netSales', title: 'Net Sales' },
            { id: 'refund', title: 'Refund' },
            { id: 'revenue', title: 'Revenue from sales of goods' },
            { id: 'aov', title: 'Average Order Value' },
            { id: 'returnRate', title: 'Return Rate' },
        ];

        // Rows: Iterate array of metrics, and look up the data per month
        const finalData = metricsToDisplay.map(metric => {
            const row = { metric: metric.title };
            sortedKeys.forEach(k => {
                row[k] = grouped[k][metric.id];
            });
            return row;
        });

        res.json({ success: true, columns: finalColumns, data: finalData });

    } catch (error) {
        console.error('MIS Error:', error);
        next(error);
    }
};

module.exports = {
    generateAmazonMIS
};

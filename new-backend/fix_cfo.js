const fs = require('fs');
const filepath = 'f:/Colonel/colonel-automation/colonel-emergent/new-backend/src/services/cfoAnalyticsService.js';
const content = fs.readFileSync(filepath, 'utf8');
const lines = content.split('\n');

const validLines = lines.slice(0, 471); // Takes up to exactly '    limit,' in getDetailedTransactions

const newContent = validLines.join('\n') + `
    offset,
    order: [['year', 'DESC'], ['month', 'DESC'], ['created_at', 'DESC']],
    raw: true
  });

  return {
    total: count,
    data: rows.map(row => ({
      ...row,
      month_str: \`\${parseInt(row.year)}-\${String(parseInt(row.month)).padStart(2, '0')}\`
    })),
    page: Math.floor(offset / limit) + 1,
    limit
  };
};

/**
 * Revenue MIS Report: Monthly aggregation of Sales, Returns, and Financial KPIs
 */
const getRevenueMISReport = async (brandId, agentId, startDate, endDate, sku = null) => {
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  const monthYearFilter = getMonthYearFilter(startDate, endDate);
  const where = monthYearFilter || {};

  if (sku) {
    where.sku = sku;
  }

  // Define classification rules
  const saleCondition = "transaction_type = 'Sale'";
  const returnCondition = "transaction_type = 'Return' OR (credit_note_number IS NOT NULL AND credit_note_number != '')";

  const misData = await Model.findAll({
    attributes: [
      'year',
      'month',
      // Orders
      [Sequelize.fn('COUNT', Sequelize.fn('DISTINCT', Sequelize.literal(\`CASE WHEN \${saleCondition} THEN order_id END\`))), 'orders_count'],
      
      // Units
      [Sequelize.fn('SUM', Sequelize.literal(\`CASE WHEN \${saleCondition} THEN quantity ELSE 0 END\`)), 'units_gross'],
      [Sequelize.fn('SUM', Sequelize.literal(\`CASE WHEN \${returnCondition} THEN ABS(quantity) ELSE 0 END\`)), 'units_return'],
      
      // Sales Values
      [Sequelize.fn('SUM', Sequelize.literal(\`CASE WHEN \${saleCondition} THEN invoice_amount ELSE 0 END\`)), 'sales_gross_inc_gst'],
      [Sequelize.fn('SUM', Sequelize.literal(\`CASE WHEN \${saleCondition} THEN total_tax_amount ELSE 0 END\`)), 'sales_tax'],
      
      // Returns Value
      [Sequelize.fn('SUM', Sequelize.literal(\`CASE WHEN \${returnCondition} THEN ABS(final_taxable_sales_value) ELSE 0 END\`)), 'returns_value']
    ],
    where,
    group: ['year', 'month'],
    order: [
      ['year', 'ASC'],
      ['month', 'ASC']
    ],
    raw: true
  });

  return misData.map(row => {
    const year = parseInt(row.year);
    const month = parseInt(row.month);
    const date = new Date(year, month - 1, 1);
    const monthLabel = format(date, 'MMM-yy'); // Apr-25

    const ordersCount = parseInt(row.orders_count) || 0;
    const unitsGross = parseInt(row.units_gross) || 0;
    const unitsReturn = parseInt(row.units_return) || 0;
    const netUnits = unitsGross - unitsReturn;

    const salesGrossIncGst = Math.round(parseFloat(row.sales_gross_inc_gst) || 0);
    const salesTax = Math.round(parseFloat(row.sales_tax) || 0);
    const netSales = salesGrossIncGst - salesTax;
    const returnsValue = Math.round(parseFloat(row.returns_value) || 0);
    const revenueFromGoods = netSales - returnsValue;

    const aov = ordersCount > 0 ? Math.round(salesGrossIncGst / ordersCount) : 0;

    return {
      month_label: monthLabel,
      year: year,
      month: month,
      particulars: {
        orders: ordersCount,
        units: {
          gross: unitsGross,
          returns: unitsReturn,
          net: netUnits
        },
        sales: {
          gross_inc_gst: salesGrossIncGst,
          tax: salesTax,
          net_sales: netSales,
          returns: returnsValue,
          revenue_from_goods: revenueFromGoods
        },
        aov: aov
      }
    };
  });
};

/**
 * Get Available Month/Year Filters
 */
const getAvailableFilters = async (brandId, agentId) => {
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  const filterRows = await Model.findAll({
    attributes: [
      [Sequelize.fn('EXTRACT', Sequelize.literal('YEAR FROM invoice_date')), 'year'],
      [Sequelize.fn('EXTRACT', Sequelize.literal('MONTH FROM invoice_date')), 'month']
    ],
    where: { invoice_date: { [Op.not]: null } },
    group: [
      Sequelize.fn('EXTRACT', Sequelize.literal('YEAR FROM invoice_date')),
      Sequelize.fn('EXTRACT', Sequelize.literal('MONTH FROM invoice_date'))
    ],
    order: [
      [Sequelize.fn('EXTRACT', Sequelize.literal('YEAR FROM invoice_date')), 'DESC'],
      [Sequelize.fn('EXTRACT', Sequelize.literal('MONTH FROM invoice_date')), 'DESC']
    ],
    raw: true
  });

  const validFilters = filterRows
    .filter(row => row.year && row.month)
    .map(row => {
      const y = parseInt(row.year);
      const m = parseInt(row.month);
      return {
        year: y,
        month: m,
        label: format(new Date(y, m - 1, 1), 'MMM yyyy')
      };
    });

  return { agent_name: agent.name, filters: validFilters };
};

module.exports = {
  getSummaryMetrics,
  getStateWiseSales,
  getTopProducts,
  getTaxAnalysis,
  getRefundAnalysis,
  getDiscountAnalysis,
  getPaymentMethodAnalysis,
  getGSTComplianceStatus,
  getMonthlyTrend,
  getDetailedTransactions,
  getRevenueMISReport,
  getAvailableFilters
};
`;

fs.writeFileSync(filepath, newContent, 'utf8');
console.log('Fixed cfoAnalyticsService.js successfully');

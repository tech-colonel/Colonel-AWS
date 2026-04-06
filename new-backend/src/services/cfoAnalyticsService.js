const { Brand, Agent } = require('../models/master');
const { getBrandConnection } = require('../config/database');
const { getDynamicModel } = require('../models/brand');
const { Op, Sequelize } = require('sequelize');
const { format } = require('date-fns');

/**
 * CFO Analytics Service - Amazon Agent
 * Provides aggregated data for CFO Dashboard
 */

/**
 * Convert date range to month/year filtering conditions
 * Returns a Sequelize where clause that filters by month and year columns
 */
const getMonthYearFilter = (startDate, endDate) => {
  if (!startDate && !endDate) return null;

  const filters = [];

  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const startYear = start.getFullYear();
    const startMonth = start.getMonth() + 1; // getMonth() is 0-indexed
    const endYear = end.getFullYear();
    const endMonth = end.getMonth() + 1;

    if (startYear === endYear) {
      filters.push(
        Sequelize.where(
          Sequelize.literal(`(year = ${startYear} AND month >= ${startMonth} AND month <= ${endMonth})`),
          Sequelize.Op.eq,
          Sequelize.literal('true')
        )
      );
    } else {
      filters.push(
        Sequelize.where(
          Sequelize.literal(`(year = ${startYear} AND month >= ${startMonth}) OR (year > ${startYear} AND year < ${endYear}) OR (year = ${endYear} AND month <= ${endMonth})`),
          Sequelize.Op.eq,
          Sequelize.literal('true')
        )
      );
    }
  } else if (startDate) {
    const start = new Date(startDate);
    const startYear = start.getFullYear();
    const startMonth = start.getMonth() + 1;

    // year > startYear OR (year = startYear AND month >= startMonth)
    filters.push(
      Sequelize.where(
        Sequelize.literal(`(year > ${startYear}) OR (year = ${startYear} AND month >= ${startMonth})`),
        Sequelize.Op.eq,
        Sequelize.literal('true')
      )
    );
  } else if (endDate) {
    const end = new Date(endDate);
    const endYear = end.getFullYear();
    const endMonth = end.getMonth() + 1;

    // year < endYear OR (year = endYear AND month <= endMonth)
    filters.push(
      Sequelize.where(
        Sequelize.literal(`(year < ${endYear}) OR (year = ${endYear} AND month <= ${endMonth})`),
        Sequelize.Op.eq,
        Sequelize.literal('true')
      )
    );
  }

  return filters.length > 0 ? { [Op.and]: filters } : null;
};

/**
 * Summary metrics: Total Revenue, Total Tax, Transaction Count
 */
const getSummaryMetrics = async (brandId, agentId, startDate, endDate) => {
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  const monthYearFilter = getMonthYearFilter(startDate, endDate);
  const where = monthYearFilter || {};

  const summary = await Model.findAll({
    attributes: [
      [Sequelize.fn('SUM', Sequelize.col('final_amount_receivable')), 'total_revenue'],
      [Sequelize.fn('SUM', Sequelize.col('final_cgst_tax')), 'total_cgst'],
      [Sequelize.fn('SUM', Sequelize.col('final_sgst_tax')), 'total_sgst'],
      [Sequelize.fn('SUM', Sequelize.col('final_igst_tax')), 'total_igst'],
      [Sequelize.fn('SUM', Sequelize.literal("CAST(final_cgst_tax AS DECIMAL) + CAST(final_sgst_tax AS DECIMAL) + CAST(final_igst_tax AS DECIMAL)")), 'total_tax'],
      [Sequelize.fn('SUM', Sequelize.col('quantity')), 'total_units'],
      [Sequelize.fn('COUNT', Sequelize.col('order_id')), 'transaction_count'],
      [Sequelize.fn('COUNT', Sequelize.literal("CASE WHEN quantity < 0 THEN 1 END")), 'refund_count']
    ],
    where,
    raw: true
  });

  const metrics = summary[0] || {};
  return {
    total_revenue: parseFloat(metrics.total_revenue) || 0,
    total_tax: parseFloat(metrics.total_tax) || 0,
    total_cgst: parseFloat(metrics.total_cgst) || 0,
    total_sgst: parseFloat(metrics.total_sgst) || 0,
    total_igst: parseFloat(metrics.total_igst) || 0,
    total_units: parseInt(metrics.total_units) || 0,
    transaction_count: parseInt(metrics.transaction_count) || 0,
    refund_count: parseInt(metrics.refund_count) || 0,
    refund_rate: metrics.transaction_count ? ((parseInt(metrics.refund_count) / parseInt(metrics.transaction_count)) * 100).toFixed(2) : 0
  };
};

/**
 * State-wise Sales Distribution
 */
const getStateWiseSales = async (brandId, agentId, startDate, endDate) => {
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  const monthYearFilter = getMonthYearFilter(startDate, endDate);
  const where = monthYearFilter || {};

  const stateData = await Model.findAll({
    attributes: [
      'ship_to_state',
      [Sequelize.fn('SUM', Sequelize.col('final_amount_receivable')), 'revenue'],
      [Sequelize.fn('SUM', Sequelize.literal("CAST(final_cgst_tax AS DECIMAL) + CAST(final_sgst_tax AS DECIMAL) + CAST(final_igst_tax AS DECIMAL)")), 'tax'],
      [Sequelize.fn('COUNT', Sequelize.col('order_id')), 'transaction_count']
    ],
    where,
    group: ['ship_to_state'],
    raw: true,
    order: [[Sequelize.fn('SUM', Sequelize.col('final_amount_receivable')), 'DESC']]
  });

  return stateData.map(row => ({
    state: row.ship_to_state || 'N/A',
    revenue: parseFloat(row.revenue) || 0,
    tax: parseFloat(row.tax) || 0,
    transactions: parseInt(row.transaction_count) || 0
  }));
};

/**
 * Top 10 Products by Revenue
 */
const getTopProducts = async (brandId, agentId, startDate, endDate, limit = 10) => {
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  const monthYearFilter = getMonthYearFilter(startDate, endDate);
  const baseWhere = monthYearFilter || {};
  const where = { ...baseWhere, sku: { [Op.ne]: null } };

  const products = await Model.findAll({
    attributes: [
      'sku',
      'asin',
      'item_description',
      [Sequelize.fn('SUM', Sequelize.col('final_amount_receivable')), 'revenue'],
      [Sequelize.fn('SUM', Sequelize.col('quantity')), 'units_sold'],
      [Sequelize.fn('COUNT', Sequelize.col('order_id')), 'transaction_count']
    ],
    where,
    group: ['sku', 'asin', 'item_description'],
    raw: true,
    order: [[Sequelize.fn('SUM', Sequelize.col('final_amount_receivable')), 'DESC']],
    limit
  });

  return products.map(row => ({
    sku: row.sku,
    asin: row.asin,
    product_name: row.item_description || 'N/A',
    revenue: parseFloat(row.revenue) || 0,
    units_sold: parseInt(row.units_sold) || 0,
    transactions: parseInt(row.transaction_count) || 0,
    avg_price: (parseFloat(row.revenue) / parseInt(row.units_sold)) || 0
  }));
};

/**
 * Tax Breakdown Analysis
 */
const getTaxAnalysis = async (brandId, agentId, startDate, endDate) => {
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  const monthYearFilter = getMonthYearFilter(startDate, endDate);
  const where = monthYearFilter || {};

  const taxData = await Model.findAll({
    attributes: [
      [Sequelize.fn('SUM', Sequelize.col('final_cgst_tax')), 'item_cgst'],
      [Sequelize.fn('SUM', Sequelize.col('final_sgst_tax')), 'item_sgst'],
      [Sequelize.fn('SUM', Sequelize.col('final_igst_tax')), 'item_igst'],
      [Sequelize.fn('SUM', Sequelize.col('final_shipping_cgst_tax')), 'shipping_cgst'],
      [Sequelize.fn('SUM', Sequelize.col('final_shipping_sgst_tax')), 'shipping_sgst'],
      [Sequelize.fn('SUM', Sequelize.col('final_shipping_igst_tax')), 'shipping_igst'],
      [Sequelize.fn('SUM', Sequelize.literal("CAST(tcs_cgst_amount AS DECIMAL) + CAST(tcs_sgst_amount AS DECIMAL) + CAST(tcs_igst_amount AS DECIMAL) + CAST(tcs_utgst_amount AS DECIMAL)")), 'total_tcs']
    ],
    where,
    raw: true
  });

  const tax = taxData[0] || {};
  return {
    item_cgst: parseFloat(tax.item_cgst) || 0,
    item_sgst: parseFloat(tax.item_sgst) || 0,
    item_igst: parseFloat(tax.item_igst) || 0,
    shipping_cgst: parseFloat(tax.shipping_cgst) || 0,
    shipping_sgst: parseFloat(tax.shipping_sgst) || 0,
    shipping_igst: parseFloat(tax.shipping_igst) || 0,
    total_tcs: parseFloat(tax.total_tcs) || 0
  };
};

/**
 * Refund Analysis
 */
const getRefundAnalysis = async (brandId, agentId, startDate, endDate) => {
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  const monthYearFilter = getMonthYearFilter(startDate, endDate);
  const where = monthYearFilter || {};

  const refundData = await Model.findAll({
    attributes: [
      'transaction_type',
      [Sequelize.fn('COUNT', Sequelize.col('order_id')), 'count'],
      [Sequelize.fn('SUM', Sequelize.literal('ABS(quantity)')), 'units'],
      [Sequelize.fn('SUM', Sequelize.col('final_amount_receivable')), 'amount'],
      [Sequelize.fn('SUM', Sequelize.literal("CAST(final_cgst_tax AS DECIMAL) + CAST(final_sgst_tax AS DECIMAL) + CAST(final_igst_tax AS DECIMAL)")), 'tax_impact']
    ],
    where,
    group: ['transaction_type'],
    raw: true
  });

  const shipments = refundData.find(r => r.transaction_type === 'Shipment') || {};
  const refunds = refundData.find(r => r.transaction_type === 'Refund') || {};

  return {
    shipments: {
      count: parseInt(shipments.count) || 0,
      units: parseInt(shipments.units) || 0,
      revenue: parseFloat(shipments.amount) || 0,
      tax_impact: parseFloat(shipments.tax_impact) || 0
    },
    refunds: {
      count: parseInt(refunds.count) || 0,
      units: parseInt(refunds.units) || 0,
      amount: parseFloat(refunds.amount) || 0,
      tax_impact: parseFloat(refunds.tax_impact) || 0
    }
  };
};

/**
 * Discount Analysis
 */
const getDiscountAnalysis = async (brandId, agentId, startDate, endDate) => {
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  const monthYearFilter = getMonthYearFilter(startDate, endDate);
  const where = monthYearFilter || {};

  const discountData = await Model.findAll({
    attributes: [
      [Sequelize.fn('SUM', Sequelize.col('item_promo_discount')), 'item_discount'],
      [Sequelize.fn('SUM', Sequelize.col('shipping_promo_discount')), 'shipping_discount'],
      [Sequelize.fn('SUM', Sequelize.col('gift_wrap_promo_discount')), 'gift_wrap_discount'],
      [Sequelize.fn('SUM', Sequelize.literal("CAST(item_promo_discount AS DECIMAL) + CAST(shipping_promo_discount AS DECIMAL) + CAST(gift_wrap_promo_discount AS DECIMAL)")), 'total_discount'],
      [Sequelize.fn('SUM', Sequelize.col('final_amount_receivable')), 'total_revenue']
    ],
    where,
    raw: true
  });

  const discount = discountData[0] || {};
  const totalRevenue = parseFloat(discount.total_revenue) || 1;
  
  return {
    item_discount: parseFloat(discount.item_discount) || 0,
    shipping_discount: parseFloat(discount.shipping_discount) || 0,
    gift_wrap_discount: parseFloat(discount.gift_wrap_discount) || 0,
    total_discount: parseFloat(discount.total_discount) || 0,
    discount_as_percent_of_revenue: ((parseFloat(discount.total_discount) || 0) / totalRevenue * 100).toFixed(2)
  };
};

/**
 * Payment Method Distribution
 */
const getPaymentMethodAnalysis = async (brandId, agentId, startDate, endDate) => {
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  const monthYearFilter = getMonthYearFilter(startDate, endDate);
  const where = monthYearFilter || {};

  const paymentData = await Model.findAll({
    attributes: [
      'payment_method_code',
      [Sequelize.fn('COUNT', Sequelize.col('order_id')), 'count'],
      [Sequelize.fn('SUM', Sequelize.col('final_amount_receivable')), 'revenue']
    ],
    where,
    group: ['payment_method_code'],
    raw: true,
    order: [[Sequelize.fn('SUM', Sequelize.col('final_amount_receivable')), 'DESC']]
  });

  return paymentData.map(row => ({
    payment_method: row.payment_method_code || 'N/A',
    count: parseInt(row.count) || 0,
    revenue: parseFloat(row.revenue) || 0
  }));
};

/**
 * GST Compliance Status
 */
const getGSTComplianceStatus = async (brandId, agentId, startDate, endDate) => {
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  const monthYearFilter = getMonthYearFilter(startDate, endDate);
  const where = monthYearFilter || {};

  const complianceData = await Model.findAll({
    attributes: [
      'irn_filing_status',
      [Sequelize.fn('COUNT', Sequelize.col('id')), 'count']
    ],
    where,
    group: ['irn_filing_status'],
    raw: true
  });

  const total = await Model.count({ where });

  return {
    total_records: total,
    status_breakdown: complianceData.map(row => ({
      status: row.irn_filing_status || 'NOT_FILED',
      count: parseInt(row.count) || 0,
      percentage: ((parseInt(row.count) / total) * 100).toFixed(2)
    }))
  };
};

/**
 * Monthly Trend Data (for line charts)
 */
const getMonthlyTrend = async (brandId, agentId, startDate, endDate) => {
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  const monthYearFilter = getMonthYearFilter(startDate, endDate);
  const where = monthYearFilter || {};

  const trendData = await Model.findAll({
    attributes: [
      'year',
      'month',
      [Sequelize.fn('SUM', Sequelize.col('final_amount_receivable')), 'revenue'],
      [Sequelize.fn('SUM', Sequelize.literal("CAST(final_cgst_tax AS DECIMAL) + CAST(final_sgst_tax AS DECIMAL) + CAST(final_igst_tax AS DECIMAL)")), 'tax'],
      [Sequelize.fn('COUNT', Sequelize.col('order_id')), 'transactions']
    ],
    where,
    group: ['year', 'month'],
    order: [['year', 'ASC'], ['month', 'ASC']],
    raw: true
  });

  return trendData.map(row => {
    const year = parseInt(row.year) || new Date().getFullYear();
    const month = parseInt(row.month) || 1;
    const dateStr = `${year}-${String(month).padStart(2, '0')}-01`;
    return {
      month: dateStr,
      revenue: parseFloat(row.revenue) || 0,
      tax: parseFloat(row.tax) || 0,
      transactions: parseInt(row.transactions) || 0
    };
  });
};

/**
 * Get detailed transactions with optional filters
 */
const getDetailedTransactions = async (brandId, agentId, startDate, endDate, limit = 100, offset = 0, filters = {}) => {
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const Model = getDynamicModel(brandDb, tableName, agent.columns);

  // Date range filter using month and year
  const monthYearFilter = getMonthYearFilter(startDate, endDate);
  const where = monthYearFilter || {};

  // Additional filters
  if (filters.state) where.ship_to_state = filters.state;
  if (filters.sku) where.sku = filters.sku;
  if (filters.transaction_type) where.transaction_type = filters.transaction_type;

  const { count, rows } = await Model.findAndCountAll({
    where,
    attributes: [
      'id', 'invoice_number', 'invoice_date', 'order_id', 'order_date',
      'sku', 'asin', 'item_description', 'quantity',
      'ship_to_state', 'transaction_type',
      'final_amount_receivable', 'final_cgst_tax', 'final_sgst_tax', 'final_igst_tax',
      'shipping_amount', 'item_promo_discount',
      'year', 'month', 'created_at'
    ],
    limit,
    offset,
    order: [['year', 'DESC'], ['month', 'DESC'], ['created_at', 'DESC']],
    raw: true
  });

  return {
    total: count,
    data: rows.map(row => ({
      ...row,
      month_str: `${parseInt(row.year)}-${String(parseInt(row.month)).padStart(2, '0')}`
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

  // Define classification rules dynamically based on column availability
  const hasCreditNote = agent.columns && agent.columns.some(c => c.name === 'credit_note_number');

  const saleCondition = hasCreditNote
    ? "transaction_type IN ('Sale', 'Shipment', 'Order') AND (credit_note_number IS NULL OR credit_note_number = '')"
    : "transaction_type IN ('Sale', 'Shipment', 'Order')";

  const returnCondition = hasCreditNote
    ? "transaction_type IN ('Return', 'Refund', 'Cancel') OR (credit_note_number IS NOT NULL AND credit_note_number != '')"
    : "transaction_type IN ('Return', 'Refund', 'Cancel')";

  const misData = await Model.findAll({
    attributes: [
      'year',
      'month',
      // Orders
      [Sequelize.fn('COUNT', Sequelize.fn('DISTINCT', Sequelize.literal(`CASE WHEN ${saleCondition} THEN order_id END`))), 'orders_count'],
      
      // Units
      [Sequelize.fn('SUM', Sequelize.literal(`CASE WHEN ${saleCondition} THEN CAST(quantity AS DECIMAL) ELSE 0 END`)), 'units_gross'],
      [Sequelize.fn('SUM', Sequelize.literal(`CASE WHEN ${returnCondition} THEN ABS(CAST(quantity AS DECIMAL)) ELSE 0 END`)), 'units_return'],
      
      // Sales Values
      [Sequelize.fn('SUM', Sequelize.literal(`CASE WHEN ${saleCondition} THEN CAST(invoice_amount AS DECIMAL) ELSE 0 END`)), 'sales_gross_inc_gst'],
      [Sequelize.fn('SUM', Sequelize.literal(`CASE WHEN ${saleCondition} THEN CAST(total_tax_amount AS DECIMAL) ELSE 0 END`)), 'sales_tax'],
      
      // Returns Value
      [Sequelize.fn('SUM', Sequelize.literal(`CASE WHEN ${returnCondition} THEN ABS(CAST(final_taxable_sales_value AS DECIMAL)) ELSE 0 END`)), 'returns_value']
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

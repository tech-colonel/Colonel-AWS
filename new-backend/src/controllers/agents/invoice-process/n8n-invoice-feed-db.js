const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');

const parseDate = (dString) => {
  if (!dString) return null;
  const parts = dString.split(/[-/]/);
  if (parts.length === 3 && parts[2].length === 4) {
    return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
  }
  return new Date(dString); 
};

// ─── POST /api/n8n/invoice/feed ───────────────
const feedInvoicesFromN8n = async (req, res, next) => {
  try {
    const { brandId, agentId, processed_invoices } = req.body;

    if (!brandId || !agentId) {
      return res.status(400).json({ error: 'brandId and agentId are required in the request body.' });
    }

    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);

    if (!brand || !agent) {
      return res.status(404).json({ error: 'Brand or Agent not found' });
    }

    if (!processed_invoices || !Array.isArray(processed_invoices)) {
      return res.status(400).json({
        error: 'Invalid payload. Expected { "processed_invoices": [...] }'
      });
    }

    if (processed_invoices.length === 0) {
      return res.json({ message: 'No invoices found to process.', count: 0, data: [] });
    }

    // Get brand DB and dynamic model
    const brandDb = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const InvoiceModel = getDynamicModel(brandDb, tableName, agent.columns);

    // Ensure table exists
    await InvoiceModel.sync({ alter: false });

    // Map webhook response fields → DB columns
    const finalData = processed_invoices.map(row => ({
      processed_on: new Date(),
      company: row.company,
      invoice_number: row.invoice_number,
      invoice_date: parseDate(row.invoice_date),
      due_date: parseDate(row.due_date),
      seller_gstin: row.seller_gstin,
      buyer_gstin: row.buyer_gstin,
      category: row.category,
      product_name: row.product_name,
      hsn_code: row.hsn_code,
      quantity: parseInt(row.quantity) || 0,
      unit: row.unit,
      rate: parseFloat(row.rate) || 0,
      cgst_rate: parseFloat(row.cgst_rate) || 0,
      sgst_rate: parseFloat(row.sgst_rate) || 0,
      igst_rate: parseFloat(row.igst_rate) || 0,
      cgst_amount: parseFloat(row.cgst_amount) || 0,
      sgst_amount: parseFloat(row.sgst_amount) || 0,
      igst_amount: parseFloat(row.igst_amount) || 0,
      gst_amount: parseFloat(row.GST_AMOUNT || row.gst_amount) || 0,
      taxable_value: parseFloat(row['taxable value'] || row.taxable_value) || 0,
      invoice_link: row.Invoice_link || row.invoice_link || null,
      status: 'Processed'
    }));

    // Bulk insert
    const resultRows = await InvoiceModel.bulkCreate(finalData, { returning: true });

    res.json({
      success: true,
      message: 'Invoices stored successfully via n8n feed',
      count: resultRows.length,
      data: finalData
    });

  } catch (error) {
    next(error);
  }
};

module.exports = {
  feedInvoicesFromN8n
};

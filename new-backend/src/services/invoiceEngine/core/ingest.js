/**
 * ingest.js — write processed invoice rows into the `invoice_code` table.
 *
 * Mirrors the field mapping + status logic of the existing n8n feed controller
 * (controllers/agents/invoice-process/n8n-invoice-feed-db.js) so invoice_code stays
 * consistent with invoice_process — but writes ONLY to the new agent's table.
 */
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');

// ── copied verbatim from n8n-invoice-feed-db.js ──────────────────────────
const NA_TOKENS = ['n/a', 'na', 'n.a.', 'missing', 'none', 'nil', '-', '—', 'null', 'undefined'];
const isMissingField = (v) => !v || !String(v).trim() || NA_TOKENS.includes(String(v).trim().toLowerCase());

const MONTH_MAP = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
const parseDate = (dString) => {
  if (!dString || dString === 'null' || dString === 'undefined' || String(dString).trim() === '') return null;
  const s = String(dString).trim();
  try {
    const nameMatch = s.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,9})[-\/\s](\d{2,4})$/);
    if (nameMatch) {
      const [, day, mon, yr] = nameMatch;
      const mm = MONTH_MAP[mon.toLowerCase().slice(0, 3)];
      if (mm) {
        const year = yr.length === 2 ? (parseInt(yr) >= 50 ? `19${yr}` : `20${yr}`) : yr;
        return new Date(`${year}-${mm}-${day.padStart(2, '0')}`);
      }
    }
    const parts = s.split(/[-/]/);
    if (parts.length === 3 && parts[2].length === 4) return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
};

/**
 * @param {object} brand  resolved Brand row (needs .db_name, .name)
 * @param {object} agent  resolved Agent row (needs .name === 'Invoice code', .columns)
 * @param {Array<object>} rows  runCodeNode output rows (plain json), each may carry `_filename`
 */
async function writeRows(brand, agent, rows) {
  const brandDb = getBrandConnection(brand.db_name);
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase(); // -> invoice_code
  const Model = getDynamicModel(brandDb, tableName, agent.columns);
  await Model.sync({ alter: false }); // no-op in unified mode

  const corruptedRows = [];
  const validRows = [];

  rows.forEach((row) => {
    const isMissingCritical = !row.product_name || !row.invoice_number || !row.invoice_date;
    const base = {
      processed_on: new Date(),
      company: row.company || null,
      vendor_name_tally: row.vendor_name_tally || null,
      invoice_number: row.invoice_number || null,
      invoice_date: parseDate(row.invoice_date),
      due_date: parseDate(row.due_date),
      seller_gstin: row.seller_gstin || null,
      buyer_gstin: row.buyer_gstin || null,
      voucher_type: row.voucher_type || null,
      category: row.category || null,
      product_name: row.product_name || null,
      hsn_code: row.hsn_code || null,
      batch_no: row.batch_no || null,
      creditors: row.creditors || null,
      quantity: parseInt(row.quantity) || 0,
      unit: row.unit || null,
      rate: parseFloat(row.rate) || 0,
      cgst_rate: parseFloat(row.cgst_rate) || 0,
      sgst_rate: parseFloat(row.sgst_rate) || 0,
      igst_rate: parseFloat(row.igst_rate) || 0,
      cgst_amount: parseFloat(row.cgst_amount) || 0,
      sgst_amount: parseFloat(row.sgst_amount) || 0,
      igst_amount: parseFloat(row.igst_amount) || 0,
      gst_amount: parseFloat(row.GST_AMOUNT || row.gst_amount) || 0,
      taxable_value: parseFloat(row['taxable value'] || row.taxable_value || row.amount) || 0,
      tds_section: row.tds_section || null,
      tds_rate: parseFloat(row.tds_rate) || 0,
      tds_amount: parseFloat(row.tds_amount) || 0,
      invoice_link: row.Invoice_link || row.invoice_link || null,
      filename: row._filename || null,
    };
    if (isMissingCritical) {
      corruptedRows.push({ ...base, status: 'Invalid' });
    } else {
      base.status = (isMissingField(row.vendor_name_tally) && isMissingField(row.category)) ? 'Needs Review' : 'Approved';
      validRows.push(base);
    }
  });

  const validResult = await Model.bulkCreate(validRows, { returning: true });
  const corruptedResult = await Model.bulkCreate(corruptedRows, { returning: true });

  return {
    approved: validResult.filter(r => r.status === 'Approved').length,
    needsReview: validResult.filter(r => r.status === 'Needs Review').length,
    invalid: corruptedResult.length,
    total: validResult.length + corruptedResult.length,
    ids: [...validResult, ...corruptedResult].map(r => r.id),
  };
}

module.exports = { writeRows, parseDate, isMissingField };

const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { markDone } = require('../../../utils/invoiceEvents');

// ─── Helper: Parse Date ───────────────────────
const parseDate = (dString) => {
    if (!dString) return null;

    try {
        const parts = dString.split(/[-/]/);

        // Format: DD-MM-YYYY or DD/MM/YYYY
        if (parts.length === 3 && parts[2].length === 4) {
            return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        }

        return new Date(dString);
    } catch (err) {
        return null;
    }
};

// ─── POST /api/n8n/invoice/feed ───────────────
const feedInvoicesFromN8n = async (req, res, next) => {
    try {
        // ✅ Handle BOTH naming formats (important for n8n)
        const brandId =
            req.query.brandId ||
            req.body.brandId ||
            req.body.brandid ||
            (Array.isArray(req.body) ? req.body[0]?.brand_id : req.body.processed_invoices?.[0]?.brand_id);

        const agentId =
            req.query.agentId ||
            req.body.agentId ||
            req.body.agentid ||
            (Array.isArray(req.body) ? req.body[0]?.agent_id : req.body.processed_invoices?.[0]?.agent_id);

        let processed_invoices = [];
        if (Array.isArray(req.body)) {
            processed_invoices = req.body;
        } else if (req.body && Array.isArray(req.body.processed_invoices)) {
            processed_invoices = req.body.processed_invoices;
        }

        // ─── Validations ───────────────────────────
        if (!brandId || !agentId) {
            return res.status(400).json({
                error: 'brandId/agentId missing (supports brandId, brandid, agentId, agentid)'
            });
        }

        if (!processed_invoices || !Array.isArray(processed_invoices)) {
            return res.status(400).json({
                error: 'Invalid payload. Expected an array or { "processed_invoices": [...] }'
            });
        }

        if (processed_invoices.length === 0) {
            // Notify SSE clients that processing is complete with 0 count
            markDone(brandId, agentId, 0);

            return res.json({
                success: true,
                message: 'No invoices to process',
                count: 0,
                data: []
            });
        }

        // ─── Fetch Master Data ─────────────────────
        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        if (!brand || !agent) {
            return res.status(404).json({
                error: 'Brand or Agent not found'
            });
        }

        // ─── Dynamic DB + Model ────────────────────
        const brandDb = getBrandConnection(brand.db_name);

        const tableName = agent.name
            .replace(/[^a-zA-Z0-9]/g, '_')
            .toLowerCase();

        const InvoiceModel = getDynamicModel(
            brandDb,
            tableName,
            agent.columns
        );

        await InvoiceModel.sync({ alter: false });

        // ─── Data Mapping ──────────────────────────
        const finalData = processed_invoices.map((row) => ({
            processed_on: new Date(),

            buyer_gstin: row.buyer_gstin || null,
            category: row.category || null,
            product_name: row.product_name || null,
            hsn_code: row.hsn_code || null,

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

            taxable_value:
                parseFloat(row['taxable value'] || row.taxable_value) || 0,

            invoice_link:
                row.Invoice_link ||
                row.invoice_link ||
                null,

            status: 'Processed'
        }));

        // ─── Insert Data ───────────────────────────
        const resultRows = await InvoiceModel.bulkCreate(finalData, {
            returning: true
        });

        // ─── Notify SSE clients (large-batch path via n8n push) ────────
        markDone(brandId, agentId, resultRows.length);

        // ─── Response ──────────────────────────────
        res.json({
            success: true,
            message: 'Invoices stored successfully via n8n feed',
            count: resultRows.length,
            data: resultRows
        });

    } catch (error) {
        console.error('❌ Invoice Feed Error:', error);
        next(error);
    }
};

module.exports = {
    feedInvoicesFromN8n
};
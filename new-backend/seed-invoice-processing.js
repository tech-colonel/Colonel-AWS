const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const seedInvoiceAgent = async () => {
    console.log("Seeding Invoice-Processing Agent...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Invoice-Processing' }
        });

        const agentColumns = [
            { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

            // meta
            { name: 'processed_on', type: 'DATE', defaultValue: 'NOW' },

            // company info
            { name: 'company', type: 'STRING' },
            { name: 'vendor_name_tally', type: 'STRING' },

            // invoice details
            { name: 'invoice_number', type: 'STRING' },
            { name: 'invoice_date', type: 'DATE' },
            { name: 'due_date', type: 'DATE' },

            // GST details
            { name: 'seller_gstin', type: 'STRING' },
            { name: 'buyer_gstin', type: 'STRING' },

            // voucher / classification
            { name: 'voucher_type', type: 'STRING' },
            { name: 'category', type: 'STRING' },

            // product details
            { name: 'product_name', type: 'STRING' },
            { name: 'hsn_code', type: 'STRING' },
            { name: 'batch_no', type: 'STRING' },

            // quantity & pricing
            { name: 'quantity', type: 'DECIMAL' },
            { name: 'unit', type: 'STRING' },
            { name: 'rate', type: 'DECIMAL' },
            { name: 'taxable_value', type: 'DECIMAL' },

            // GST rates
            { name: 'cgst_rate', type: 'DECIMAL' },
            { name: 'sgst_rate', type: 'DECIMAL' },
            { name: 'igst_rate', type: 'DECIMAL' },

            // GST amounts
            { name: 'cgst_amount', type: 'DECIMAL' },
            { name: 'sgst_amount', type: 'DECIMAL' },
            { name: 'igst_amount', type: 'DECIMAL' },

            // totals
            { name: 'gst_amount', type: 'DECIMAL' },

            // file reference
            { name: 'invoice_link', type: 'STRING' },

            // status tracking
            { name: 'status', type: 'STRING', defaultValue: 'Pending' }
        ];

        if (!exists) {
            await Agent.create({
                name: 'Invoice-Processing',
                description: 'Invoice Processing Agent for extracting structured invoice data',
                columns: agentColumns
            });

            console.log('✓ Invoice-Processing agent created');
        } else {
            exists.columns = agentColumns;
            exists.description = 'Invoice Processing Agent for extracting structured invoice data';
            await exists.save();

            console.log('✓ Invoice-Processing agent updated');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedInvoiceAgent();
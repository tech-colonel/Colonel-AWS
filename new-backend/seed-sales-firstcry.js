const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const seedSalesFirstcry = async () => {
    console.log("Seeding Sales-FirstCry...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-FirstCry' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-FirstCry',
                description: 'FirstCry Sales Agent - Handles sales, SR, and RTO data',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // Common meta fields
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // Core order info
                    { name: 'fc_ref_no', type: 'STRING' },
                    { name: 'order_id', type: 'STRING' },

                    // Dates
                    { name: 'order_date', type: 'DATE' },
                    { name: 'shipping_date', type: 'DATE' },
                    { name: 'delivery_date', type: 'DATE' },
                    { name: 'sr_rto_date', type: 'DATE' },
                    { name: 'invoice_date', type: 'DATE' },

                    // Product info
                    { name: 'product_id', type: 'STRING' },
                    { name: 'hsn_code', type: 'STRING' },
                    { name: 'product_name', type: 'STRING' }, // from FG

                    // Pricing & qty
                    { name: 'quantity', type: 'INTEGER' },
                    { name: 'mrp', type: 'DECIMAL' },
                    { name: 'base_cost', type: 'DECIMAL' },
                    { name: 'gross_amount', type: 'DECIMAL' },

                    // Tax
                    { name: 'cgst_percent', type: 'DECIMAL' },
                    { name: 'cgst_amount', type: 'DECIMAL' },
                    { name: 'sgst_percent', type: 'DECIMAL' },
                    { name: 'sgst_amount', type: 'DECIMAL' },

                    { name: 'total_amount', type: 'DECIMAL' },

                    // Invoice & finance refs
                    { name: 'vendor_invoice_no', type: 'STRING' },
                    { name: 'payment_advice_no', type: 'STRING' },
                    { name: 'debit_note_no', type: 'STRING' },

                    // SR (Sales Return)
                    { name: 'sr_qty', type: 'INTEGER' },
                    { name: 'sr_total_amount', type: 'DECIMAL' },
                    { name: 'sr_gross_amount', type: 'DECIMAL' },

                    // RTO (Return to Origin)
                    { name: 'rto_qty', type: 'INTEGER' },
                    { name: 'rto_total_amount', type: 'DECIMAL' },
                    { name: 'rto_gross_amount', type: 'DECIMAL' }
                ]
            });

            console.log('✓ Sales-FirstCry agent created');
        } else {
            console.log('✓ Sales-FirstCry already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesFirstcry();
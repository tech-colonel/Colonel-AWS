const { masterSequelize } = require('./src/config/database.js');
const { Agent } = require('./src/models/master/index.js');

const seedSalesVaree = async () => {
    console.log("Seeding Sales-Varee...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-Varee' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-Varee',
                description: 'Vaaree Sales Agent - Process the Vaaree Seller Portal GSTR report into a GST Sales / B2B / HSN working file',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // Common meta fields
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // Source report fields
                    { name: 'payment_cycle', type: 'STRING' },
                    { name: 'order_date', type: 'DATE' },
                    { name: 'order_number', type: 'STRING' },
                    { name: 'customer_name', type: 'STRING' },
                    { name: 'customer_state', type: 'STRING' },
                    { name: 'invoice_number', type: 'STRING' },
                    { name: 'order_status', type: 'STRING' },
                    { name: 'sku', type: 'STRING' },

                    // Taxable value & tax breakdown
                    { name: 'taxable_goods', type: 'DECIMAL' },
                    { name: 'gst_on_goods', type: 'DECIMAL' },
                    { name: 'gst_rate', type: 'DECIMAL' },
                    { name: 'taxable_cod', type: 'DECIMAL' },
                    { name: 'gst_on_cod', type: 'DECIMAL' },
                    { name: 'total_invoice_value', type: 'DECIMAL' },

                    // SOP-computed fields
                    { name: 'final_rate', type: 'DECIMAL' },
                    { name: 'final_taxable', type: 'DECIMAL' },
                    { name: 'igst', type: 'DECIMAL' },
                    { name: 'cgst', type: 'DECIMAL' },
                    { name: 'sgst', type: 'DECIMAL' },
                    { name: 'quantity', type: 'INTEGER' },

                    { name: 'tds', type: 'DECIMAL' },
                    { name: 'tcs', type: 'DECIMAL' },
                    { name: 'customer_gst_no', type: 'STRING' },
                    { name: 'fulfilled_by', type: 'STRING' },
                    { name: 'seller_state', type: 'STRING' },
                    { name: 'invoice_date', type: 'DATE' },
                    { name: 'hsn_code', type: 'STRING' },

                    // SOP classification fields
                    { name: 'sale_type', type: 'STRING' },        // B2B / B2C
                    { name: 'transaction_type', type: 'STRING' }, // Sales / Returns
                ]
            });

            console.log('✓ Sales-Varee agent created');
        } else {
            console.log('✓ Sales-Varee already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesVaree();

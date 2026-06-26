const { masterSequelize } = require('./src/config/database.js');
const { Agent } = require('./src/models/master/index.js');

const seedSalesMirrow = async () => {
    console.log("Seeding Sales-Mirrow...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-Mirrow' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-Mirrow',
                description: 'Mirrow Sales Agent - Process Mirrow sales reports with SKU and ledger mapping',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // Common meta fields
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },
                    { name: 'date', type: 'DATE' },

                    // Core order info
                    { name: 'order_id', type: 'STRING' },
                    { name: 'sku', type: 'STRING' },
                    { name: 'product_name', type: 'STRING' },
                    { name: 'quantity', type: 'INTEGER' },

                    // Pricing & financial
                    { name: 'mrp', type: 'DECIMAL' },
                    { name: 'selling_price', type: 'DECIMAL' },
                    { name: 'taxable_value', type: 'DECIMAL' },

                    // GST details
                    { name: 'gst_rate', type: 'DECIMAL' },
                    { name: 'cgst', type: 'DECIMAL' },
                    { name: 'sgst', type: 'DECIMAL' },
                    { name: 'igst', type: 'DECIMAL' },
                    { name: 'total_amount', type: 'DECIMAL' },

                    // Customer details
                    { name: 'state', type: 'STRING' },
                    { name: 'city', type: 'STRING' },

                    // Tally mapping
                    { name: 'tally_ledger', type: 'STRING' },
                    { name: 'invoice_number', type: 'STRING' },
                    { name: 'fg', type: 'STRING' }
                ]
            });

            console.log('✓ Sales-Mirrow agent created');
        } else {
            console.log('✓ Sales-Mirrow already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesMirrow();

const { masterSequelize } = require('./src/config/database.js');
const { Agent } = require('./src/models/master/index.js');

const seedSalesCread = async () => {
    console.log("Seeding Sales-cread...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-cread' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-cread',
                description: 'Cread Sales Agent - Process Cread sales reports with SKU and ledger mapping',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // Meta fields
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // Order info
                    { name: 'order_date', type: 'DATE' },
                    { name: 'reference_code', type: 'STRING' },
                    { name: 'ee_invoice_no', type: 'STRING' },
                    { name: 'order_status', type: 'STRING' },
                    { name: 'shipping_status', type: 'STRING' },
                    { name: 'awb_no', type: 'STRING' },
                    { name: 'suborder_quantity', type: 'INTEGER' },
                    { name: 'item_quantity', type: 'INTEGER' },

                    // SKU info
                    { name: 'sku', type: 'STRING' },
                    { name: 'final_sku', type: 'STRING' },
                    { name: 'mis_sku', type: 'STRING' },

                    // Shipping info
                    { name: 'shipping_zip_code', type: 'STRING' },
                    { name: 'shipping_state', type: 'STRING' },

                    // Tally mapping
                    { name: 'party_name', type: 'STRING' },
                    { name: 'invoice_no', type: 'STRING' },

                    // Financial
                    { name: 'order_invoice_amount', type: 'DECIMAL' },
                    { name: 'tax', type: 'DECIMAL' },
                    { name: 'item_price_ex_tax', type: 'DECIMAL' },
                    { name: 'taxable_amount', type: 'DECIMAL' },

                    // GST
                    { name: 'cgst', type: 'DECIMAL' },
                    { name: 'sgst', type: 'DECIMAL' },
                    { name: 'igst', type: 'DECIMAL' },

                    // Status
                    { name: 'cred_status', type: 'STRING' },
                    { name: 'final_status', type: 'STRING' }
                ]
            });

            console.log('✓ Sales-cread agent created');
        } else {
            console.log('✓ Sales-cread already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesCread();

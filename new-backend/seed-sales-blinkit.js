const { masterSequelize } = require('./src/config/database.js');
const { Agent } = require('./src/models/master/index.js');

const seedSalesBlinkit = async () => {
    console.log("Seeding Sales-Blinkit...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-Blinkit' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-Blinkit',
                description: 'Blinkit Sales Agent - Handles order level sales data',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // Common meta fields
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // Core order info
                    { name: 'order_id', type: 'STRING' },
                    { name: 'order_date', type: 'DATE' },
                    { name: 'item_id', type: 'STRING' },

                    // Product details
                    { name: 'product_name', type: 'STRING' },
                    { name: 'brand_name', type: 'STRING' },
                    { name: 'upc', type: 'STRING' },
                    { name: 'variant_description', type: 'STRING' },

                    // Category mapping
                    { name: 'category_mapping', type: 'STRING' }, // L0 → L1 → L2
                    { name: 'business_category', type: 'STRING' },

                    // Supply details
                    { name: 'supply_city', type: 'STRING' },
                    { name: 'supply_state', type: 'STRING' },
                    { name: 'supply_state_gst', type: 'STRING' },

                    // Customer details
                    { name: 'customer_city', type: 'STRING' },
                    { name: 'customer_state', type: 'STRING' },

                    // Order status
                    { name: 'order_status', type: 'STRING' },

                    // Tax info
                    { name: 'hsn_code', type: 'STRING' },
                    { name: 'igst_percent', type: 'DECIMAL' },
                    { name: 'cgst_percent', type: 'DECIMAL' },
                    { name: 'sgst_percent', type: 'DECIMAL' },
                    { name: 'cess_percent', type: 'DECIMAL' },

                    // Quantity & pricing
                    { name: 'quantity', type: 'INTEGER' },
                    { name: 'mrp', type: 'DECIMAL' },
                    { name: 'selling_price', type: 'DECIMAL' },

                    // Tax values
                    { name: 'igst_value', type: 'DECIMAL' },
                    { name: 'cgst_value', type: 'DECIMAL' },
                    { name: 'sgst_value', type: 'DECIMAL' },
                    { name: 'cess_value', type: 'DECIMAL' },
                    { name: 'total_tax', type: 'DECIMAL' },

                    // Totals
                    { name: 'total_gross_bill_amount', type: 'DECIMAL' },
                    { name: 'gst_rate', type: 'DECIMAL' },
                    { name: 'taxable_value', type: 'DECIMAL' }
                ]
            });

            console.log('✓ Sales-Blinkit agent created');
        } else {
            console.log('✓ Sales-Blinkit already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesBlinkit();
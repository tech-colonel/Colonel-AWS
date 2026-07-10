const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const seedSalesShopify = async () => {
    console.log("Seeding Sales-Shopify...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-Shopify' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-Shopify',
                description: 'Shopify Sales Agent - Processes Shopify sales reports with GST and ledger mapping',
                columns: [
                    // 🔹 System Fields
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'date', type: 'DATE' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // 🔹 Raw + Business Columns
                    { name: 'day', type: 'DATE' },
                    { name: 'sales', type: 'STRING' },

                    { name: 'product_variant_sku', type: 'STRING' },
                    { name: 'fg', type: 'STRING' },

                    { name: 'product_variant_id', type: 'STRING' },
                    { name: 'product_variant_title', type: 'STRING' },

                    { name: 'shipping_region', type: 'STRING' },
                    { name: 'billing_region', type: 'STRING' },

                    { name: 'tally_ledger', type: 'STRING' },
                    { name: 'sales_ledger', type: 'STRING' },
                    { name: 'invoice_number', type: 'STRING' },

                    { name: 'customer_name', type: 'STRING' },
                    { name: 'order_fulfillment_status', type: 'STRING' },

                    { name: 'product_id', type: 'STRING' },
                    { name: 'product_title', type: 'STRING' },
                    { name: 'order_id', type: 'STRING' },

                    { name: 'billing_city', type: 'STRING' },
                    { name: 'shipping_city', type: 'STRING' },

                    // 🔹 Financial Columns
                    { name: 'gross_sales', type: 'DECIMAL' },
                    { name: 'discounts', type: 'DECIMAL' },
                    { name: 'returns', type: 'DECIMAL' },
                    { name: 'net_sales', type: 'DECIMAL' },

                    { name: 'shipping_charges', type: 'DECIMAL' },
                    { name: 'return_fees', type: 'DECIMAL' },
                    { name: 'taxes', type: 'DECIMAL' },
                    { name: 'total_sales', type: 'DECIMAL' },

                    // 🔹 Quantity Columns
                    { name: 'quantity_returned', type: 'INTEGER' },
                    { name: 'quantity_ordered', type: 'INTEGER' },
                    { name: 'quantity_ordered_per_order', type: 'INTEGER' },
                    { name: 'final_qty', type: 'INTEGER' },

                    // 🔹 GST Columns
                    { name: 'gst_rate', type: 'DECIMAL' },
                    { name: 'taxable_value', type: 'DECIMAL' },

                    { name: 'igst', type: 'DECIMAL' },
                    { name: 'cgst', type: 'DECIMAL' },
                    { name: 'sgst', type: 'DECIMAL' }
                ]
            });

            console.log('✓ Sales-Shopify agent created');
        } else {
            console.log('✓ Sales-Shopify already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesShopify();
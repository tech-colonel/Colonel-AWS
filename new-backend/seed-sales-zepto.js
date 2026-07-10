const { masterSequelize } = require('./src/config/database.js');
const { Agent } = require('./src/models/master/index.js');

const seedSalesZepto = async () => {
    console.log("Seeding Sales-Zepto...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-Zepto' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-Zepto',
                description: 'Zepto Sales Agent - Handles SKU level sales data',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // Common meta fields
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // Date
                    { name: 'date', type: 'DATE' },

                    // SKU details
                    { name: 'sku_number', type: 'STRING' },
                    { name: 'sku_name', type: 'STRING' },
                    { name: 'ean', type: 'STRING' },

                    // Category
                    { name: 'sku_category', type: 'STRING' },
                    { name: 'sku_sub_category', type: 'STRING' },

                    // Brand & manufacturer
                    { name: 'brand_name', type: 'STRING' },
                    { name: 'manufacturer_name', type: 'STRING' },
                    { name: 'manufacturer_id', type: 'STRING' },

                    // Location
                    { name: 'city', type: 'STRING' },

                    // Sales metrics
                    { name: 'sales_qty_units', type: 'INTEGER' },
                    { name: 'mrp', type: 'DECIMAL' },
                    { name: 'selling_price', type: 'DECIMAL' },
                    { name: 'gross_merchandise_value', type: 'DECIMAL' },
                    { name: 'gross_selling_value', type: 'DECIMAL' },

                    // Pack info
                    { name: 'pack_size', type: 'INTEGER' },
                    { name: 'unit_of_measure', type: 'STRING' },

                    // Orders
                    { name: 'orders', type: 'INTEGER' },

                    // SKU master mapped columns
                    { name: 'fg', type: 'STRING' },

                    // Ledger master mapped columns
                    { name: 'state', type: 'STRING' },
                    { name: 'tally_ledger', type: 'STRING' },
                    { name: 'invoice_number', type: 'STRING' },

                    // Tax computed columns
                    { name: 'tax', type: 'DECIMAL' },
                    { name: 'taxable_value', type: 'DECIMAL' },
                    { name: 'igst', type: 'DECIMAL' },
                    { name: 'cgst', type: 'DECIMAL' },
                    { name: 'sgst', type: 'DECIMAL' }
                ]
            });

            console.log('✓ Sales-Zepto agent created');
        } else {
            console.log('✓ Sales-Zepto already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesZepto();

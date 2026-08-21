const { masterSequelize } = require('./src/config/database.js');
const { Agent } = require('./src/models/master/index.js');

const seedSalesPepperfry = async () => {
    console.log("Seeding Sales-Pepperfry...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-Pepperfry' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-Pepperfry',
                description: 'Pepperfry Sales Agent - Merge the Pepperfry Seller Portal GSTR-1 Sales + Refunds reports into a B2B / B2C / HSN working file',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // Common meta fields
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // Source report fields
                    { name: 'order_id_sku', type: 'STRING' },
                    { name: 'state', type: 'STRING' },
                    { name: 'gstin', type: 'STRING' },
                    { name: 'document_type', type: 'STRING' },
                    { name: 'taxability', type: 'STRING' },
                    { name: 'supply_type', type: 'STRING' },
                    { name: 'gstin_of_recipient', type: 'STRING' },
                    { name: 'recipient_state', type: 'STRING' },
                    { name: 'name_of_recipient', type: 'STRING' },
                    { name: 'invoice_number', type: 'STRING' },
                    { name: 'invoice_date', type: 'DATE' },
                    { name: 'invoice_value', type: 'DECIMAL' },
                    { name: 'total_discount', type: 'DECIMAL' },
                    { name: 'item_code', type: 'STRING' },
                    { name: 'category', type: 'STRING' },
                    { name: 'hsn_sac', type: 'STRING' },
                    { name: 'product_description', type: 'STRING' },
                    { name: 'invoiced_quantity', type: 'DECIMAL' },
                    { name: 'sale_price', type: 'DECIMAL' },
                    { name: 'merchant_discount', type: 'DECIMAL' },

                    // SOP column mapping (section 7): Taxable Value, Tax Rate, IGST/CGST/SGST
                    { name: 'taxable_value', type: 'DECIMAL' },
                    { name: 'tax_rate', type: 'DECIMAL' },
                    { name: 'igst', type: 'DECIMAL' },
                    { name: 'cgst', type: 'DECIMAL' },
                    { name: 'sgst', type: 'DECIMAL' },

                    { name: 'ship_from_state', type: 'STRING' },
                    { name: 'ship_to_state', type: 'STRING' },
                    { name: 'tcs_amount', type: 'DECIMAL' },
                    { name: 'status_of_delivery', type: 'STRING' },
                    { name: 'commission_amount', type: 'DECIMAL' },
                    { name: 'commission_invoice_no', type: 'STRING' },
                    { name: 'return_date', type: 'DATE' },

                    // SOP classification fields
                    { name: 'sale_type', type: 'STRING' },        // B2B / B2C
                    { name: 'transaction_type', type: 'STRING' }, // Sale / Return
                ]
            });

            console.log('✓ Sales-Pepperfry agent created');
        } else {
            console.log('✓ Sales-Pepperfry already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesPepperfry();

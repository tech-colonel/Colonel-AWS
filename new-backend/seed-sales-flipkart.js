const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const seedSalesFlipkart = async () => {
    console.log("Seeding Sales-Flipkart...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-Flipkart' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-Flipkart',
                description: 'Flipkart Sales Agent - Handles sales, returns, tax, TCS & TDS',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // meta
                    { name: 'month', type: 'INTEGER' },
                    { name: 'year', type: 'INTEGER' },
                    { name: 'inventory_type', type: 'STRING' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },
                    { name: 'date', type: 'DATE' },

                    // seller info
                    { name: 'seller_gstin', type: 'STRING' },
                    { name: 'seller_state', type: 'STRING' },

                    // order info
                    { name: 'order_id', type: 'STRING' },
                    { name: 'order_item_id', type: 'STRING' },
                    { name: 'order_type', type: 'STRING' },
                    { name: 'event_type', type: 'STRING' },
                    { name: 'event_sub_type', type: 'STRING' },

                    { name: 'order_date', type: 'DATE' },
                    { name: 'order_approval_date', type: 'DATE' },

                    // product
                    { name: 'sku', type: 'STRING' },
                    { name: 'fg', type: 'STRING' }, // IMPORTANT
                    { name: 'fsn', type: 'STRING' },
                    { name: 'item_description', type: 'STRING' },
                    { name: 'hsn_code', type: 'STRING' },

                    { name: 'quantity', type: 'INTEGER' },

                    // fulfillment
                    { name: 'fulfilment_type', type: 'STRING' },
                    { name: 'warehouse_id', type: 'STRING' },
                    { name: 'ship_from_state', type: 'STRING' },

                    // pricing
                    { name: 'price_before_discount', type: 'DECIMAL' },
                    { name: 'total_discount', type: 'DECIMAL' },
                    { name: 'price_after_discount', type: 'DECIMAL' },

                    { name: 'shipping_charges', type: 'DECIMAL' },

                    // final values (VERY IMPORTANT)
                    { name: 'final_taxable_sales_value', type: 'DECIMAL' },
                    { name: 'final_shipping_taxable_value', type: 'DECIMAL' },
                    { name: 'final_invoice_amount', type: 'DECIMAL' },

                    // GST
                    { name: 'gst_rate', type: 'DECIMAL' },
                    { name: 'cgst_rate', type: 'DECIMAL' },
                    { name: 'sgst_rate', type: 'DECIMAL' },
                    { name: 'igst_rate', type: 'DECIMAL' },

                    { name: 'cgst_amount', type: 'DECIMAL' },
                    { name: 'sgst_amount', type: 'DECIMAL' },
                    { name: 'igst_amount', type: 'DECIMAL' },

                    // final GST (important for Tally)
                    { name: 'final_cgst_tax', type: 'DECIMAL' },
                    { name: 'final_sgst_tax', type: 'DECIMAL' },
                    { name: 'final_igst_tax', type: 'DECIMAL' },

                    // shipping tax
                    { name: 'shipping_cgst_tax', type: 'DECIMAL' },
                    { name: 'shipping_sgst_tax', type: 'DECIMAL' },
                    { name: 'shipping_igst_tax', type: 'DECIMAL' },

                    // TCS
                    { name: 'tcs_igst_amount', type: 'DECIMAL' },
                    { name: 'tcs_cgst_amount', type: 'DECIMAL' },
                    { name: 'tcs_sgst_amount', type: 'DECIMAL' },
                    { name: 'total_tcs', type: 'DECIMAL' },

                    // TDS (Flipkart specific)
                    { name: 'tds_rate', type: 'DECIMAL' },
                    { name: 'tds_amount', type: 'DECIMAL' },

                    // invoice
                    { name: 'buyer_invoice_id', type: 'STRING' },
                    { name: 'buyer_invoice_date', type: 'DATE' },
                    { name: 'buyer_invoice_amount', type: 'DECIMAL' },
                    { name: 'final_invoice_number', type: 'STRING' },

                    // customer
                    { name: 'billing_state', type: 'STRING' },
                    { name: 'billing_pincode', type: 'STRING' },
                    { name: 'shipping_state', type: 'STRING' },
                    { name: 'shipping_pincode', type: 'STRING' },

                    // business
                    { name: 'business_name', type: 'STRING' },
                    { name: 'business_gstin', type: 'STRING' },

                    // extra flags
                    { name: 'is_shopsy_order', type: 'BOOLEAN' },

                    // misc
                    { name: 'tally_ledger', type: 'STRING' },
                    { name: 'imei', type: 'STRING' }
                ]
            });

            console.log('✓ Sales-Flipkart agent created');
        } else {
            console.log('✓ Sales-Flipkart already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesFlipkart();
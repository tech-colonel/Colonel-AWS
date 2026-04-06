const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const seedSalesJiomart = async () => {
    console.log("Seeding Sales-JioMart...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-JioMart' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-JioMart',
                description: 'JioMart Sales Agent - Handles GST, TCS, TDS and shipment level data',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // Common meta fields
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // Seller & order info
                    { name: 'seller_gstin', type: 'STRING' },
                    { name: 'order_id', type: 'STRING' },
                    { name: 'order_item_id', type: 'STRING' },
                    { name: 'order_type', type: 'STRING' },

                    { name: 'order_date', type: 'DATE' },
                    { name: 'order_approval_date', type: 'DATE' },

                    { name: 'type', type: 'STRING' },

                    // Shipment details
                    { name: 'shipment_number', type: 'STRING' },
                    { name: 'original_shipment_number', type: 'STRING' },
                    { name: 'fulfillment_type', type: 'STRING' },
                    { name: 'fulfiller_name', type: 'STRING' },

                    // Product info
                    { name: 'product_name', type: 'STRING' },
                    { name: 'product_id', type: 'STRING' }, // FSN
                    { name: 'sku', type: 'STRING' },

                    // ✅ REQUIRED: FG after SKU
                    { name: 'fg', type: 'STRING' },

                    { name: 'hsn_code', type: 'STRING' },

                    // Order status
                    { name: 'order_status', type: 'STRING' },
                    { name: 'event_type', type: 'STRING' },
                    { name: 'event_sub_type', type: 'STRING' },

                    // Quantity
                    { name: 'quantity', type: 'INTEGER' },

                    // Invoice
                    { name: 'buyer_invoice_id', type: 'STRING' },
                    { name: 'original_invoice_id', type: 'STRING' },
                    { name: 'buyer_invoice_date', type: 'DATE' },
                    { name: 'tcs_date', type: 'DATE' },

                    { name: 'buyer_invoice_amount', type: 'DECIMAL' },

                    // Location
                    { name: 'shipped_from_state', type: 'STRING' },
                    { name: 'billed_from_state', type: 'STRING' },
                    { name: 'billing_pincode', type: 'STRING' },
                    { name: 'billing_state', type: 'STRING' },
                    { name: 'delivery_pincode', type: 'STRING' },
                    { name: 'delivery_state', type: 'STRING' },

                    // Pricing
                    { name: 'seller_coupon_code', type: 'STRING' },
                    { name: 'offer_price', type: 'DECIMAL' },
                    { name: 'seller_coupon_amount', type: 'DECIMAL' },
                    { name: 'final_invoice_amount', type: 'DECIMAL' },

                    { name: 'tax_type', type: 'STRING' },
                    { name: 'taxable_value', type: 'DECIMAL' },

                    // GST
                    { name: 'igst_rate', type: 'DECIMAL' },
                    { name: 'igst_amount', type: 'DECIMAL' },
                    { name: 'cgst_rate', type: 'DECIMAL' },
                    { name: 'cgst_amount', type: 'DECIMAL' },
                    { name: 'sgst_rate', type: 'DECIMAL' },
                    { name: 'sgst_amount', type: 'DECIMAL' },

                    // TCS
                    { name: 'tcs_igst_rate', type: 'DECIMAL' },
                    { name: 'tcs_igst_amount', type: 'DECIMAL' },
                    { name: 'tcs_cgst_rate', type: 'DECIMAL' },
                    { name: 'tcs_cgst_amount', type: 'DECIMAL' },
                    { name: 'tcs_sgst_rate', type: 'DECIMAL' },
                    { name: 'tcs_sgst_amount', type: 'DECIMAL' },
                    { name: 'total_tcs_deducted', type: 'DECIMAL' },

                    // TDS
                    { name: 'tds_rate', type: 'DECIMAL' },
                    { name: 'tds_amount', type: 'DECIMAL' },

                    // Final GST
                    { name: 'final_gst_rate', type: 'DECIMAL' }
                ]
            });

            console.log('✓ Sales-JioMart agent created');
        } else {
            console.log('✓ Sales-JioMart already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesJiomart();
const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const seedSalesTatacliq = async () => {
    console.log("Seeding Sales-TataCliq...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-TataCliq' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-TataCliq',
                description: 'Tata Cliq B2C Sales Agent - Reconciles the monthly TCS report into GST-mapped sales/credit-note working files',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // Common meta fields
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // Raw TCS report fields
                    { name: 'seller_code', type: 'STRING' },
                    { name: 'seller_name', type: 'STRING' },
                    { name: 'order_reference_no', type: 'STRING' },
                    { name: 'order_id', type: 'STRING' },
                    { name: 'transaction_id', type: 'STRING' },
                    { name: 'hsn_code', type: 'STRING' },
                    { name: 'fulfillment_type', type: 'STRING' },
                    { name: 'order_type', type: 'STRING' },
                    { name: 'order_tag', type: 'STRING' },
                    { name: 'slave_id', type: 'STRING' },
                    { name: 'slave_gstin', type: 'STRING' },
                    { name: 'slave_state', type: 'STRING' },
                    { name: 'destination_code', type: 'STRING' },
                    { name: 'place_of_supply', type: 'STRING' },
                    { name: 'seller_invoice', type: 'STRING' },
                    { name: 'order_date', type: 'DATE' },
                    { name: 'transaction_date', type: 'DATE' },

                    { name: 'product_value', type: 'DECIMAL' },
                    { name: 'product_cgst', type: 'DECIMAL' },
                    { name: 'product_sgst', type: 'DECIMAL' },
                    { name: 'product_igst', type: 'DECIMAL' },
                    { name: 'gross_product_value', type: 'DECIMAL' },
                    { name: 'tcs_cgst', type: 'DECIMAL' },
                    { name: 'tcs_sgst', type: 'DECIMAL' },
                    { name: 'tcs_igst', type: 'DECIMAL' },
                    { name: 'total_tcs', type: 'DECIMAL' },

                    { name: 'clearing_document', type: 'STRING' },
                    { name: 'document_date', type: 'DATE' },
                    { name: 'tul_gstin', type: 'STRING' },
                    { name: 'gstin_status', type: 'STRING' },

                    // Computed fields (SOP steps 2-6)
                    { name: 'gst_rate', type: 'DECIMAL' },
                    { name: 'state', type: 'STRING' },
                    { name: 'sku', type: 'STRING' },
                    { name: 'voucher_type', type: 'STRING' },
                    { name: 'is_cn', type: 'STRING' },
                    { name: 'invoice_number', type: 'STRING' },
                    { name: 'debtor', type: 'STRING' },
                    { name: 'sales_ledger', type: 'STRING' },
                    { name: 'stock_name', type: 'STRING' },
                    { name: 'qty', type: 'INTEGER' },
                    { name: 'output_igst', type: 'DECIMAL' },
                    { name: 'output_cgst', type: 'DECIMAL' },
                    { name: 'output_sgst', type: 'DECIMAL' },
                    { name: 'cost', type: 'DECIMAL' },
                    { name: 'cost_qty', type: 'DECIMAL' }
                ]
            });

            console.log('✓ Sales-TataCliq agent created');
        } else {
            console.log('✓ Sales-TataCliq already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesTatacliq();

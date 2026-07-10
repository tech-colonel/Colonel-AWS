const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const seedSalesAmazon = async () => {
    console.log("Seeding Sales-Amazon...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-Amazon' }
        });

        const agentColumns = [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // meta
                    { name: 'month', type: 'INTEGER' },
                    { name: 'year', type: 'INTEGER' },
                    { name: 'inventory_type', type: 'STRING' },
                    { name: 'file_type', type: 'STRING' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },
                    { name: 'date', type: 'DATE' },

                    // basic info
                    { name: 'seller_gstin', type: 'STRING' },
                    { name: 'invoice_number', type: 'STRING' },
                    { name: 'invoice_date', type: 'DATE' },
                    { name: 'transaction_type', type: 'STRING' },

                    { name: 'order_id', type: 'STRING' },
                    { name: 'shipment_id', type: 'STRING' },
                    { name: 'shipment_date', type: 'DATE' },
                    { name: 'order_date', type: 'DATE' },

                    { name: 'shipment_item_id', type: 'STRING' },
                    { name: 'quantity', type: 'INTEGER' },

                    { name: 'item_description', type: 'STRING' },
                    { name: 'asin', type: 'STRING' },
                    { name: 'hsn_sac', type: 'STRING' },
                    { name: 'sku', type: 'STRING' },
                    { name: 'fg', type: 'STRING' },

                    { name: 'product_tax_code', type: 'STRING' },

                    { name: 'bill_from_city', type: 'STRING' },
                    { name: 'bill_from_state', type: 'STRING' },
                    { name: 'bill_from_country', type: 'STRING' },
                    { name: 'bill_from_postal_code', type: 'STRING' },

                    { name: 'ship_from_city', type: 'STRING' },
                    { name: 'ship_from_state', type: 'STRING' },
                    { name: 'ship_from_country', type: 'STRING' },
                    { name: 'ship_from_postal_code', type: 'STRING' },

                    { name: 'ship_to_city', type: 'STRING' },
                    { name: 'ship_to_state', type: 'STRING' },
                    { name: 'ship_to_state_tally_ledger', type: 'STRING' },
                    { name: 'final_invoice_number', type: 'STRING' },

                    { name: 'ship_to_country', type: 'STRING' },
                    { name: 'ship_to_postal_code', type: 'STRING' },

                    { name: 'invoice_amount', type: 'DECIMAL' },
                    { name: 'tax_exclusive_gross', type: 'DECIMAL' },
                    { name: 'total_tax_amount', type: 'DECIMAL' },

                    { name: 'cgst_rate', type: 'DECIMAL' },
                    { name: 'sgst_rate', type: 'DECIMAL' },
                    { name: 'utgst_rate', type: 'DECIMAL' },
                    { name: 'igst_rate', type: 'DECIMAL' },
                    { name: 'compensatory_cess_rate', type: 'DECIMAL' },

                    { name: 'principal_amount', type: 'DECIMAL' },
                    { name: 'principal_amount_basis', type: 'DECIMAL' },

                    { name: 'cgst_tax', type: 'DECIMAL' },
                    { name: 'sgst_tax', type: 'DECIMAL' },
                    { name: 'utgst_tax', type: 'DECIMAL' },
                    { name: 'igst_tax', type: 'DECIMAL' },
                    { name: 'compensatory_cess_tax', type: 'DECIMAL' },

                    { name: 'final_tax_rate', type: 'DECIMAL' },
                    { name: 'final_taxable_sales_value', type: 'DECIMAL' },
                    { name: 'final_taxable_shipping_value', type: 'DECIMAL' },

                    { name: 'final_cgst_tax', type: 'DECIMAL' },
                    { name: 'final_sgst_tax', type: 'DECIMAL' },
                    { name: 'final_igst_tax', type: 'DECIMAL' },

                    { name: 'final_shipping_cgst_tax', type: 'DECIMAL' },
                    { name: 'final_shipping_sgst_tax', type: 'DECIMAL' },
                    { name: 'final_shipping_igst_tax', type: 'DECIMAL' },

                    { name: 'final_amount_receivable', type: 'DECIMAL' },

                    { name: 'shipping_amount', type: 'DECIMAL' },
                    { name: 'shipping_amount_basis', type: 'DECIMAL' },

                    { name: 'shipping_cgst_tax', type: 'DECIMAL' },
                    { name: 'shipping_sgst_tax', type: 'DECIMAL' },
                    { name: 'shipping_utgst_tax', type: 'DECIMAL' },
                    { name: 'shipping_igst_tax', type: 'DECIMAL' },
                    { name: 'shipping_cess_tax', type: 'DECIMAL' },

                    { name: 'gift_wrap_amount', type: 'DECIMAL' },
                    { name: 'gift_wrap_amount_basis', type: 'DECIMAL' },

                    { name: 'gift_wrap_cgst_tax', type: 'DECIMAL' },
                    { name: 'gift_wrap_sgst_tax', type: 'DECIMAL' },
                    { name: 'gift_wrap_utgst_tax', type: 'DECIMAL' },
                    { name: 'gift_wrap_igst_tax', type: 'DECIMAL' },
                    { name: 'gift_wrap_compensatory_cess_tax', type: 'DECIMAL' },

                    { name: 'item_promo_discount', type: 'DECIMAL' },
                    { name: 'item_promo_discount_basis', type: 'DECIMAL' },
                    { name: 'item_promo_tax', type: 'DECIMAL' },

                    { name: 'shipping_promo_discount', type: 'DECIMAL' },
                    { name: 'shipping_promo_discount_basis', type: 'DECIMAL' },
                    { name: 'shipping_promo_tax', type: 'DECIMAL' },

                    { name: 'gift_wrap_promo_discount', type: 'DECIMAL' },
                    { name: 'gift_wrap_promo_discount_basis', type: 'DECIMAL' },
                    { name: 'gift_wrap_promo_tax', type: 'DECIMAL' },

                    { name: 'tcs_cgst_rate', type: 'DECIMAL' },
                    { name: 'tcs_cgst_amount', type: 'DECIMAL' },
                    { name: 'tcs_sgst_rate', type: 'DECIMAL' },
                    { name: 'tcs_sgst_amount', type: 'DECIMAL' },
                    { name: 'tcs_utgst_rate', type: 'DECIMAL' },
                    { name: 'tcs_utgst_amount', type: 'DECIMAL' },
                    { name: 'tcs_igst_rate', type: 'DECIMAL' },
                    { name: 'tcs_igst_amount', type: 'DECIMAL' },

                    { name: 'warehouse_id', type: 'STRING' },
                    { name: 'fulfillment_channel', type: 'STRING' },
                    { name: 'payment_method_code', type: 'STRING' },

                    { name: 'bill_to_city', type: 'STRING' },
                    { name: 'bill_to_state', type: 'STRING' },
                    { name: 'bill_to_country', type: 'STRING' },
                    { name: 'bill_to_postal_code', type: 'STRING' },

                    { name: 'customer_bill_to_gstin', type: 'STRING' },
                    { name: 'customer_ship_to_gstin', type: 'STRING' },

                    { name: 'buyer_name', type: 'STRING' },

                    { name: 'credit_note_number', type: 'STRING' },
                    { name: 'credit_note_date', type: 'DATE' },

                    { name: 'irn_number', type: 'STRING' },
                    { name: 'irn_filing_status', type: 'STRING' },
                    { name: 'irn_date', type: 'DATE' },
                    { name: 'irn_error_code', type: 'STRING' }
        ];

        if (!exists) {
            await Agent.create({
                name: 'Sales-Amazon',
                description: 'Amazon Sales Agent - Full raw column structure',
                columns: agentColumns
            });
            console.log('✓ Sales-Amazon agent created');
        } else {
            exists.columns = agentColumns;
            await exists.save();
            console.log('✓ Sales-Amazon updated');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesAmazon();
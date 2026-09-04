const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const seedSalesMeesho = async () => {
    console.log("Seeding Sales-Meesho...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({ where: { name: 'Sales-Meesho' } });

        const description = 'Meesho Sales Agent — merges the monthly tcs_sales + tcs_sales_return TCS extracts into a "working" sheet (returns signed negative), derives the CGST/SGST/IGST split from seller vs customer state, pulls Party Name + Invoice No. from the Ledger master, adds an FG column from the SKU master on "with inventory" runs, and emits GSTR B2C / GSTR HSN summaries.';
        {
            const columns = [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // Common meta / working-file listing fields
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'inventory_type', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // Source-file marker ("file" column on the working sheet)
                    { name: 'source_file', type: 'STRING' },
                    // Seller state name from GSTIN[0:2] ("selling state" column, first on the sheet)
                    { name: 'selling_state', type: 'STRING' },

                    // Raw TCS extract fields (union of tcs_sales + tcs_sales_return)
                    { name: 'identifier', type: 'STRING' },
                    // FG from the SKU master (identifier -> Tally FG); with-inventory runs only
                    { name: 'fg', type: 'STRING' },
                    { name: 'sup_name', type: 'STRING' },
                    { name: 'gstin', type: 'STRING' },
                    { name: 'sub_order_num', type: 'STRING' },
                    { name: 'order_date', type: 'STRING' },
                    { name: 'hsn_code', type: 'STRING' },
                    { name: 'quantity', type: 'DECIMAL' },
                    { name: 'gst_rate', type: 'DECIMAL' },
                    { name: 'total_taxable_sale_value', type: 'DECIMAL' },
                    { name: 'tax_amount', type: 'DECIMAL' },
                    { name: 'total_invoice_value', type: 'DECIMAL' },
                    { name: 'taxable_shipping', type: 'DECIMAL' },
                    { name: 'end_customer_state_new', type: 'STRING' },
                    { name: 'enrollment_no', type: 'STRING' },
                    { name: 'manifest_date', type: 'STRING' },
                    { name: 'cancel_return_date', type: 'STRING' },
                    { name: 'transaction_type', type: 'STRING' },
                    { name: 'eco_tcs_gstin', type: 'STRING' },
                    { name: 'financial_year', type: 'STRING' },
                    { name: 'month_number', type: 'STRING' },
                    { name: 'supplier_id', type: 'STRING' },

                    // Ledger-master derived, keyed on end_customer_state_new
                    { name: 'party_name', type: 'STRING' },
                    { name: 'invoice_no', type: 'STRING' },

                    // Derived GST split
                    { name: 'final_igst_amount', type: 'DECIMAL' },
                    { name: 'final_cgst_amount', type: 'DECIMAL' },
                    { name: 'final_sgst_amount', type: 'DECIMAL' },
            ];

            if (!exists) {
                await Agent.create({ name: 'Sales-Meesho', description, columns });
                console.log('✓ Sales-Meesho agent created');
            } else {
                await exists.update({ description, columns });
                console.log('✓ Sales-Meesho updated (description + columns)');
            }
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesMeesho();

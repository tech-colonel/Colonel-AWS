const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const seedSalesNykaa = async () => {
    console.log("Seeding Sales-Nykaa...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-Nykaa' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-Nykaa',
                description: 'Nykaa Sales Agent - Handles sales and GST data',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // meta
                    { name: 'month', type: 'INTEGER' },
                    { name: 'year', type: 'INTEGER' },
                    { name: 'inventory_type', type: 'STRING' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // voucher
                    { name: 'voucher_date', type: 'DATE' },
                    { name: 'voucher_type', type: 'STRING' },
                    { name: 'voucher_no', type: 'STRING' },
                    { name: 'reference_no', type: 'STRING' },
                    { name: 'reference_date', type: 'DATE' },

                    // ledgers
                    { name: 'party_ledger', type: 'STRING' },
                    { name: 'sales_ledger', type: 'STRING' },

                    // item
                    { name: 'stock_item', type: 'STRING' },
                    { name: 'description', type: 'STRING' },
                    { name: 'godown', type: 'STRING' },

                    // quantity
                    { name: 'actual_qty', type: 'DECIMAL' },
                    { name: 'quantity', type: 'DECIMAL' },
                    { name: 'unit', type: 'STRING' },

                    // pricing
                    { name: 'rate', type: 'DECIMAL' },
                    { name: 'discount', type: 'DECIMAL' },
                    { name: 'amount', type: 'DECIMAL' },

                    // taxes
                    { name: 'gst_rate', type: 'DECIMAL' },
                    { name: 'igst_amount', type: 'DECIMAL' },
                    { name: 'cgst_amount', type: 'DECIMAL' },
                    { name: 'sgst_amount', type: 'DECIMAL' },
                    { name: 'cess_amount', type: 'DECIMAL' },
                    { name: 'tcs_amount', type: 'DECIMAL' },

                    // classification
                    { name: 'taxability', type: 'STRING' },
                    { name: 'gst_nature', type: 'STRING' },
                    { name: 'hsn', type: 'STRING' },
                    { name: 'hsn_description', type: 'STRING' },

                    // customer
                    { name: 'state', type: 'STRING' },
                    { name: 'country', type: 'STRING' },
                    { name: 'place_of_supply', type: 'STRING' },
                    { name: 'gst_type', type: 'STRING' },
                    { name: 'gstin', type: 'STRING' },

                    // misc
                    { name: 'narration', type: 'STRING' },
                    { name: 'round_off', type: 'DECIMAL' }
                ]
            });

            console.log('✓ Sales-Nykaa agent created');
        } else {
            console.log('✓ Sales-Nykaa already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesNykaa();
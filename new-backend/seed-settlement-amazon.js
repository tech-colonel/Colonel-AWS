const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const seedSettlementAmazon = async () => {
    console.log("Seeding Settlement-Amazon...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Settlement-Amazon' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Settlement-Amazon',
                description: 'Amazon Settlement Agent - Handles settlements, fees, TCS, TDS, reimbursements',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // meta
                    { name: 'date_time', type: 'DATE' },
                    { name: 'settlement_id', type: 'STRING' },
                    { name: 'type', type: 'STRING' },

                    // order info
                    { name: 'order_id', type: 'STRING' },
                    { name: 'sku', type: 'STRING' },
                    { name: 'description', type: 'STRING' },
                    { name: 'quantity', type: 'INTEGER' },

                    // marketplace info
                    { name: 'marketplace', type: 'STRING' },
                    { name: 'account_type', type: 'STRING' },
                    { name: 'fulfillment', type: 'STRING' },

                    // location
                    { name: 'order_city', type: 'STRING' },
                    { name: 'order_state', type: 'STRING' },
                    { name: 'order_postal', type: 'STRING' },

                    // revenue
                    { name: 'product_sales', type: 'DECIMAL' },
                    { name: 'shipping_credits', type: 'DECIMAL' },
                    { name: 'gift_wrap_credits', type: 'DECIMAL' },
                    { name: 'promotional_rebates', type: 'DECIMAL' },

                    // GST before TCS
                    { name: 'gst_before_tcs', type: 'DECIMAL' },

                    // TCS
                    { name: 'tcs_cgst', type: 'DECIMAL' },
                    { name: 'tcs_sgst', type: 'DECIMAL' },
                    { name: 'tcs_igst', type: 'DECIMAL' },

                    // TDS
                    { name: 'tds_194o', type: 'DECIMAL' },

                    // fees
                    { name: 'selling_fees', type: 'DECIMAL' },
                    { name: 'fba_fees', type: 'DECIMAL' },
                    { name: 'other_transaction_fees', type: 'DECIMAL' },
                    { name: 'other', type: 'DECIMAL' },

                    // final
                    { name: 'total', type: 'DECIMAL' },

                    // system fields
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' }
                ]
            });

            console.log('✓ Settlement-Amazon agent created');
        } else {
            console.log('✓ Settlement-Amazon already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSettlementAmazon();
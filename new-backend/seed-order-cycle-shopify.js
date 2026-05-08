const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const seedShopifyOrderCycle = async () => {
    console.log("Seeding Shopify-Order-Cycle...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Shopify-Order-Cycle' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Shopify-Order-Cycle',
                description: 'Tracks Shopify order lifecycle including dispatch, returns, and payment settlements across partners',

                columns: [
                    // 🔹 System Fields
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'date', type: 'DATE' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // 🔹 Core Order Info
                    { name: 'sale_order_number', type: 'STRING' },
                    { name: 'platform', type: 'STRING' }, // Shopify / others
                    { name: 'invoice_number', type: 'STRING' },
                    { name: 'awb_number', type: 'STRING' },
                    { name: 'shipping_partner', type: 'STRING' },

                    // 🔹 Dates
                    { name: 'dispatch_or_cancellation_date', type: 'DATE' },
                    { name: 'return_date', type: 'DATE' },

                    // 🔹 Financials
                    { name: 'total_amount', type: 'DECIMAL' },
                    { name: 'return_amount', type: 'DECIMAL' },
                    { name: 'net_amount', type: 'DECIMAL' },

                    // 🔹 Return / SRN
                    { name: 'srn', type: 'STRING' },

                    // 🔹 Ekart
                    { name: 'ekart_remittance_date', type: 'DATE' },
                    { name: 'ekart_actual_remittance_date', type: 'DATE' },
                    { name: 'ekart_cod_amount', type: 'DECIMAL' },

                    // 🔹 Delhivery
                    { name: 'delhivery_delivery_date', type: 'DATE' },
                    { name: 'delhivery_cod_amount', type: 'DECIMAL' },

                    // 🔹 Xpressbees
                    { name: 'xpressbees_delivery_date', type: 'DATE' },
                    { name: 'xpressbees_transaction_date', type: 'DATE' },
                    { name: 'xpressbees_net_payment', type: 'DECIMAL' },

                    // 🔹 Snapmint
                    { name: 'snapmint_settlement_date', type: 'DATE' },
                    { name: 'snapmint_settlement_value', type: 'DECIMAL' },

                    // 🔹 BharatX
                    { name: 'bharatx_settlement_timestamp', type: 'DATE' },
                    { name: 'bharatx_ledger_amount', type: 'DECIMAL' }
                ]
            });

            console.log('✓ Shopify-Order-Cycle agent created');
        } else {
            console.log('✓ Shopify-Order-Cycle already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedShopifyOrderCycle();
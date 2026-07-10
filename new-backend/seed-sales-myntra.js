const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const seedSalesMyntra = async () => {
    console.log("Seeding Sales-Myntra...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-Myntra' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-Myntra',
                description: 'Myntra Sales Agent - Merges RTO, Packed, and RT reports',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },
                    { name: 'year', type: 'INTEGER' },
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'date', type: 'DATE' },

                    { name: 'seller_gstin', type: 'STRING' },
                    { name: 'invoice_number', type: 'STRING' },
                    { name: 'debtor_ledger', type: 'STRING' },

                    { name: 'sku', type: 'STRING' },
                    { name: 'quantity', type: 'INTEGER' },

                    { name: 'shipping', type: 'STRING' },
                    { name: 'gst_rate', type: 'DECIMAL' },

                    { name: 'base_value', type: 'DECIMAL' },
                    { name: 'file_type', type: 'STRING' },

                    { name: 'igst_amount', type: 'DECIMAL' },
                    { name: 'cgst_amount', type: 'DECIMAL' },
                    { name: 'sgst_amount', type: 'DECIMAL' },

                    { name: 'invoice_amount', type: 'DECIMAL' },

                    // ✅ extra useful fields (recommended)

                ]
            });

            console.log('✓ Sales-Myntra agent created');
        } else {
            console.log('✓ Sales-Myntra already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesMyntra();

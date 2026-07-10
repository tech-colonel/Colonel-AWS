const { masterSequelize } = require('./src/config/database.js');
const { Agent } = require('./src/models/master/index.js');

const seedTotalSalesAnalyzer = async () => {
    console.log("Seeding Total-Sales-Analyzer...");

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Total-Sales-Analyzer' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Total-Sales-Analyzer',
                description: 'Analyzes total sales data from vouchers and ledger entries',
                columns: [
                    { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

                    // Meta fields
                    { name: 'filename', type: 'STRING' },
                    { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

                    // Core fields
                    { name: 'account', type: 'STRING' },
                    { name: 'date', type: 'DATE' },
                    { name: 'year', type: 'INTEGER' },
                    { name: 'month', type: 'INTEGER' },
                    { name: 'particulars', type: 'STRING' },
                    { name: 'SKU', type: 'STRING' },
                    { name: 'buyer_supplier', type: 'STRING' },
                    { name: 'buyer_supplier_address', type: 'TEXT' },
                    { name: 'city', type: 'STRING' },
                    { name: 'state', type: 'STRING' },
                    { name: 'depo_name', type: 'STRING' },

                    // Voucher details
                    { name: 'voucher_type', type: 'STRING' },
                    { name: 'voucher_no', type: 'STRING' },

                    // Quantity & value
                    { name: 'quantity', type: 'STRING' }, // keeping STRING because values like "3 CTN"
                    { name: 'value', type: 'DECIMAL' },
                    { name: 'gross_total', type: 'DECIMAL' },
                    { name: 'sales_value', type: 'DECIMAL' },

                ]
            });

            console.log('✓ Total-Sales-Analyzer agent created');
        } else {
            console.log('✓ Total-Sales-Analyzer already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedTotalSalesAnalyzer();
const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

// Sales-AJIO — Reliance Retail DropShip (Order Report + RTV Report) → Tally working.
// The frontend keys the workspace off name.includes('ajio').
const seedSalesAjio = async () => {
    console.log('Seeding Sales-AJIO...');

    try {
        await masterSequelize.sync({ force: false });

        const columns = [
            { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },

            // meta
            { name: 'year', type: 'INTEGER' },
            { name: 'month', type: 'INTEGER' },
            { name: 'filename', type: 'STRING' },
            { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },

            // 'sale' | 'return'
            { name: 'record_type', type: 'STRING' },
            { name: 'status', type: 'STRING' },

            // voucher / refs
            { name: 'voucher_no', type: 'STRING' },
            { name: 'ref_no', type: 'STRING' },
            { name: 'voucher_date', type: 'DATE' },
            { name: 'invoice_date', type: 'DATE' },
            { name: 'ref_date', type: 'DATE' },
            { name: 'cust_order_no', type: 'STRING' },

            // product
            { name: 'seller_sku', type: 'STRING' },
            { name: 'hsn', type: 'STRING' },
            { name: 'stock_name', type: 'STRING' },

            // pricing & qty
            { name: 'quantity', type: 'DECIMAL' },
            { name: 'rate', type: 'DECIMAL' },
            { name: 'taxable_value', type: 'DECIMAL' },
            { name: 'cgst_amount', type: 'DECIMAL' },
            { name: 'sgst_amount', type: 'DECIMAL' },
            { name: 'igst_amount', type: 'DECIMAL' },
            { name: 'total_value', type: 'DECIMAL' },
            { name: 'gst_rate', type: 'DECIMAL' },

            // inventory
            { name: 'cost', type: 'DECIMAL' },
            { name: 'cost_qty', type: 'DECIMAL' },

            // ledgers
            { name: 'party_ledger', type: 'STRING' },
            { name: 'sales_ledger', type: 'STRING' }
        ];

        const exists = await Agent.findOne({ where: { name: 'Sales-AJIO' } });
        if (!exists) {
            await Agent.create({
                name: 'Sales-AJIO',
                description: 'AJIO Sales Agent - DropShip Order Report + RTV (returns) Report → Tally working',
                columns
            });
            console.log('✓ Sales-AJIO agent created');
        } else {
            await exists.update({ columns });
            console.log('✓ Sales-AJIO columns updated');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesAjio();

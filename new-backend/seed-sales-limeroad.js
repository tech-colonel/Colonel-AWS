const { masterSequelize } = require('./src/config/database.js');
const { Agent } = require('./src/models/master/index.js');

const seedSalesLimeroad = async () => {
    console.log('Seeding Sales-Limeroad...');

    try {
        await masterSequelize.sync({ force: false });

        const exists = await Agent.findOne({
            where: { name: 'Sales-Limeroad' }
        });

        if (!exists) {
            await Agent.create({
                name: 'Sales-Limeroad',
                description: 'LimeRoad Sales Agent - Process LimeRoad Payment Sale Return Reports with B2C and HSN pivot generation',
                columns: [
                    { name: 'id',                         type: 'UUID',    primaryKey: true, defaultValue: 'UUIDV4' },

                    // Meta
                    { name: 'year',                       type: 'INTEGER' },
                    { name: 'month',                      type: 'INTEGER' },
                    { name: 'filename',                   type: 'STRING'  },
                    { name: 'created_at',                 type: 'DATE',    defaultValue: 'NOW' },

                    // Vendor / invoice info
                    { name: 'vendor_id',                  type: 'STRING'  },
                    { name: 'event_type',                 type: 'STRING'  },
                    { name: 'vendor_name',                type: 'STRING'  },
                    { name: 'gstin',                      type: 'STRING'  },
                    { name: 'invoice_id',                 type: 'STRING'  },
                    { name: 'invoice_date',               type: 'STRING'  },

                    // Customer
                    { name: 'customer_name',              type: 'STRING'  },
                    { name: 'customer_state',             type: 'STRING'  },
                    { name: 'customer_pincode',           type: 'STRING'  },

                    // Vendor location
                    { name: 'vendor_state',               type: 'STRING'  },
                    { name: 'vendor_pincode',             type: 'STRING'  },
                    { name: 'sales_type',                 type: 'STRING'  },

                    // E-Commerce
                    { name: 'ecommerce_gstin',            type: 'STRING'  },
                    { name: 'ecommerce_name',             type: 'STRING'  },

                    // Item identifiers
                    { name: 'unique_item_id',             type: 'STRING'  },
                    { name: 'vendor_style_code',          type: 'STRING'  },
                    { name: 'order_id',                   type: 'STRING'  },
                    { name: 'sub_order_id',               type: 'STRING'  },
                    { name: 'hsn_code',                   type: 'STRING'  },
                    { name: 'product_description',        type: 'STRING'  },

                    // Quantity & tax rates
                    { name: 'quantity',                   type: 'DECIMAL' },
                    { name: 'total_gst_rate',             type: 'DECIMAL' },
                    { name: 'igst',                       type: 'DECIMAL' },
                    { name: 'cgst',                       type: 'DECIMAL' },
                    { name: 'sgst',                       type: 'DECIMAL' },

                    // Tax amounts (signed: negative for returns)
                    { name: 'tax_amount_for_igst',        type: 'DECIMAL' },
                    { name: 'tax_amount_for_cgst',        type: 'DECIMAL' },
                    { name: 'tax_amount_for_sgst',        type: 'DECIMAL' },

                    // Taxable amounts
                    { name: 'item_taxable_amount',        type: 'DECIMAL' },
                    { name: 'shipping_taxable_amount',    type: 'DECIMAL' },
                    { name: 'cod_taxable_amount',         type: 'DECIMAL' },
                    { name: 'total_supply_taxable_amount',type: 'DECIMAL' },

                    // TCS
                    { name: 'tcs_amount_for_igst',        type: 'DECIMAL' },
                    { name: 'tcs_amount_for_cgst',        type: 'DECIMAL' },
                    { name: 'tcs_amount_for_sgst',        type: 'DECIMAL' },

                    // Invoice totals
                    { name: 'invoice_value',              type: 'DECIMAL' },
                    { name: 'tax_amount',                 type: 'DECIMAL' },
                    { name: 'cess_amount',                type: 'DECIMAL' },
                    { name: 'tds_amount',                 type: 'DECIMAL' },
                ],
            });

            console.log('✓ Sales-Limeroad agent created');
        } else {
            console.log('✓ Sales-Limeroad already exists');
        }

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedSalesLimeroad();

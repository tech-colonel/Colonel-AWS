/**
 * Fix: ALTER sales_amazon.month and sales_amazon.year columns back to INTEGER
 * Converts any existing string data before altering
 */
const { masterSequelize, getBrandConnection } = require('./src/config/database');
const { Brand } = require('./src/models/master/index.js');

const fixAmazonColumns = async () => {
    console.log("Fixing sales_amazon month/year columns back to INTEGER...");

    const monthNameToNumber = {
        'january': 1, 'february': 2, 'march': 3, 'april': 4,
        'may': 5, 'june': 6, 'july': 7, 'august': 8,
        'september': 9, 'october': 10, 'november': 11, 'december': 12
    };

    try {
        await masterSequelize.sync({ force: false });
        const brands = await Brand.findAll();

        for (const brand of brands) {
            console.log(`\nProcessing brand: ${brand.name} (db: ${brand.db_name})`);
            const brandDb = getBrandConnection(brand.db_name);

            try {
                const [tables] = await brandDb.query(
                    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sales_amazon'`
                );

                if (tables.length === 0) {
                    console.log(`  → No sales_amazon table found, skipping.`);
                    continue;
                }

                const [columns] = await brandDb.query(
                    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'sales_amazon' AND column_name IN ('month', 'year')`
                );

                console.log(`  Current column types:`, columns.map(c => `${c.column_name}=${c.data_type}`).join(', '));

                for (const col of columns) {
                    if (col.data_type !== 'integer') {
                        console.log(`  → Converting ${col.column_name} from ${col.data_type} to INTEGER...`);

                        if (col.column_name === 'month') {
                            // First update any month name strings to numbers
                            for (const [name, num] of Object.entries(monthNameToNumber)) {
                                await brandDb.query(
                                    `UPDATE sales_amazon SET "month" = '${num}' WHERE LOWER("month") = '${name}'`
                                );
                            }
                        }

                        // Now alter column - cast existing string values to integer
                        await brandDb.query(
                            `ALTER TABLE sales_amazon ALTER COLUMN "${col.column_name}" TYPE INTEGER USING NULLIF("${col.column_name}", '')::INTEGER`
                        );
                        console.log(`  ✓ ${col.column_name} fixed to INTEGER.`);
                    } else {
                        console.log(`  → ${col.column_name} is already INTEGER, no change needed.`);
                    }
                }

            } catch (err) {
                console.error(`  ✗ Error for brand ${brand.name}:`, err.message);
            }
        }

        console.log('\n✅ Done!');
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
};

fixAmazonColumns();

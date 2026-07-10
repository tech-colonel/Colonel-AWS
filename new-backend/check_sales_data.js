const { getBrandConnection } = require('./src/config/database');
const { Brand } = require('./src/models/master');

async function checkSalesData() {
  try {
    const brand = await Brand.findOne({ where: { name: 'Nestroots' } });
    if (!brand) {
      console.log('Nestroots brand not found');
      return;
    }

    const brandDb = getBrandConnection(brand.db_name);
    const [results] = await brandDb.query('SELECT count(*) FROM sales_amazon_new');

    console.log(`--- sales_amazon_new count in ${brand.db_name} ---`);
    console.log(results[0]);

    if (results[0].count > 0) {
      const [rows] = await brandDb.query('SELECT * FROM sales_amazon_new LIMIT 5');
      console.log('Sample Rows:', rows);
    }

  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

checkSalesData();

const { masterSequelize } = require('./src/config/database');
const { Agent } = require('./src/models/master/index.js');

const undoSalesAmazon = async () => {
    console.log("Undoing Sales-Amazon seed...");

    try {
        await masterSequelize.sync();

        const deleted = await Agent.destroy({
            where: { name: 'Sales-Amazon' }
        });

        console.log(`✓ Deleted ${deleted} record(s)`);

        process.exit(0);
    } catch (error) {
        console.error('Undo error:', error);
        process.exit(1);
    }
};

undoSalesAmazon();
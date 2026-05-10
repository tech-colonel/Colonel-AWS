const bcrypt = require('bcryptjs');
const { masterSequelize } = require('./src/config/database');
const { User, Agent, Brand, BrandUser, BrandAgent } = require('./src/models/master/index.js');

const seedDatabase = async () => {
    console.log("seed");
    try {
        await masterSequelize.sync({ force: false });

        const adminExists = await User.findOne({ where: { email: 'admin@colonel.com' } });
        let adminUser;
        if (!adminExists) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            adminUser = await User.create({
                name: 'Admin User',
                email: 'admin@colonel.com',
                password: hashedPassword,
                role: 'admin'
            });
            console.log('✓ Admin user created (email: admin@colonel.com, password: admin123)');
        } else {
            adminUser = adminExists;
            console.log('✓ Admin user already exists');
        }

        const accountantExists = await User.findOne({ where: { email: 'accountant@colonel.com' } });
        let accountantUser;
        if (!accountantExists) {
            const hashedPassword = await bcrypt.hash('accountant123', 10);
            accountantUser = await User.create({
                name: 'Accountant User',
                email: 'accountant@colonel.com',
                password: hashedPassword,
                role: 'accountant'
            });
            console.log('✓ Accountant user created (email: accountant@colonel.com, password: accountant123)');
        } else {
            accountantUser = accountantExists;
            console.log('✓ Accountant user already exists');
        }

        const salesAmazonExists = await Agent.findOne({ where: { name: 'Sales-Amazon' } });
        let salesAmazonAgent;
        if (!salesAmazonExists) {
            salesAmazonAgent = await Agent.create({
                name: 'Sales-Amazon',
                description: 'Process Amazon sales data and generate working files with SKU and Ledger mapping',
                columns: [
                    { name: 'SKU', type: 'STRING' },
                    { name: 'Product_Name', type: 'STRING' },
                    { name: 'Quantity', type: 'INTEGER' },
                    { name: 'Amount', type: 'DECIMAL' },
                    { name: 'State', type: 'STRING' }
                ]
            });
            console.log('✓ Sales-Amazon agent created');
        } else {
            salesAmazonAgent = salesAmazonExists;
            console.log('✓ Sales-Amazon agent already exists');
        }

        const salesFlipkartExists = await Agent.findOne({ where: { name: 'Sales-Flipkart' } });
        let salesFlipkartAgent;
        if (!salesFlipkartExists) {
            salesFlipkartAgent = await Agent.create({
                name: 'Sales-Flipkart',
                description: 'Process Flipkart sales data and generate working files with SKU and Ledger mapping',
                columns: [
                    { name: 'SKU', type: 'STRING' },
                    { name: 'Product_Name', type: 'STRING' },
                    { name: 'Quantity', type: 'INTEGER' },
                    { name: 'Amount', type: 'DECIMAL' },
                    { name: 'State', type: 'STRING' }
                ]
            });
            console.log('✓ Sales-Flipkart agent created');
        } else {
            salesFlipkartAgent = salesFlipkartExists;
            console.log('✓ Sales-Flipkart agent already exists');
        }

        const totalSalesAnalyzerExists = await Agent.findOne({ where: { name: 'Total-Sales-Analyzer' } });
        let totalSalesAnalyzerAgent;
        if (!totalSalesAnalyzerExists) {
            totalSalesAnalyzerAgent = await Agent.create({
                name: 'Total-Sales-Analyzer',
                description: 'Process all sales data to analyze total sales without SKU and Ledger mappings',
                columns: []
            });
            console.log('✓ Total-Sales-Analyzer agent created');
        } else {
            totalSalesAnalyzerAgent = totalSalesAnalyzerExists;
            console.log('✓ Total-Sales-Analyzer agent already exists');
        }

        const settlementAmazonExists = await Agent.findOne({ where: { name: 'Settlement-Amazon' } });
        let settlementAmazonAgent;
        if (!settlementAmazonExists) {
            settlementAmazonAgent = await Agent.create({
                name: 'Settlement-Amazon',
                description: 'Process Amazon settlement reports and generate MIS reporting',
                columns: []
            });
            console.log('✓ Settlement-Amazon agent created');
        } else {
            settlementAmazonAgent = settlementAmazonExists;
            console.log('✓ Settlement-Amazon agent already exists');
        }

        const demoBrandExists = await Brand.findOne({ where: { db_name: 'tenant_demo' } });
        let demoBrand;
        if (!demoBrandExists) {
            demoBrand = await Brand.create({
                name: 'Demo Brand',
                description: 'A demo brand for testing purposes',
                image_url: 'https://via.placeholder.com/150',
                db_name: 'tenant_demo'
            });
            console.log('✓ Demo Brand created');
        } else {
            demoBrand = demoBrandExists;
            console.log('✓ Demo Brand already exists');
        }

        const adminBrandUserExists = await BrandUser.findOne({ where: { brand_id: demoBrand.id, user_id: adminUser.id } });
        if (!adminBrandUserExists) {
            await BrandUser.create({
                brand_id: demoBrand.id,
                user_id: adminUser.id
            });
            console.log('✓ Admin user linked to Demo Brand');
        } else {
            console.log('✓ Admin user already linked to Demo Brand');
        }

        const accountantBrandUserExists = await BrandUser.findOne({ where: { brand_id: demoBrand.id, user_id: accountantUser.id } });
        if (!accountantBrandUserExists) {
            await BrandUser.create({
                brand_id: demoBrand.id,
                user_id: accountantUser.id
            });
            console.log('✓ Accountant user linked to Demo Brand');
        } else {
            console.log('✓ Accountant user already linked to Demo Brand');
        }

        const agentsToLink = [salesAmazonAgent, salesFlipkartAgent, totalSalesAnalyzerAgent, settlementAmazonAgent];
        
        for (const agent of agentsToLink) {
            if (agent) {
                const brandAgentExists = await BrandAgent.findOne({ where: { brand_id: demoBrand.id, agent_id: agent.id } });
                if (!brandAgentExists) {
                    await BrandAgent.create({
                        brand_id: demoBrand.id,
                        agent_id: agent.id
                    });
                    console.log(`✓ ${agent.name} linked to Demo Brand`);
                } else {
                    console.log(`✓ ${agent.name} already linked to Demo Brand`);
                }
            }
        }

        console.log('\n✓ Database seeding completed successfully!');
        console.log('\nLogin Credentials:');
        console.log('Admin: admin@colonel.com / admin123');
        console.log('Accountant: accountant@colonel.com / accountant123');
        console.log('');

        process.exit(0);
    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedDatabase();

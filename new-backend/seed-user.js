const bcrypt = require('bcryptjs');
const { masterSequelize } = require('./src/config/database');
const { User } = require('./src/models/master/index.js');

const seedUsers = async () => {
    console.log("Seeding Users...");

    try {
        await masterSequelize.sync({ force: false });

        // Jayesh
        let exists = await User.findOne({ where: { email: 'jayesh.colonel@gmail.com' } });
        if (!exists) {
            const hashedPassword = await bcrypt.hash(process.env.SEED_USER_PASSWORD || 'ChangeMe123!', 10);
            await User.create({
                name: 'Jayesh',
                email: 'jayesh.colonel@gmail.com',
                password: hashedPassword,
                role: 'accountant'
            });
            console.log('✓ jayesh.colonel@gmail.com created');
        }

        // Amjad
        exists = await User.findOne({ where: { email: 'amjad.colonel@gmail.com' } });
        if (!exists) {
            const hashedPassword = await bcrypt.hash(process.env.SEED_USER_PASSWORD || 'ChangeMe123!', 10);
            await User.create({
                name: 'Amjad',
                email: 'amjad.colonel@gmail.com',
                password: hashedPassword,
                role: 'accountant'
            });
            console.log('✓ amjad.colonel@gmail.com created');
        }

        // Varshita
        exists = await User.findOne({ where: { email: 'varshita.colonel@gmail.com' } });
        if (!exists) {
            const hashedPassword = await bcrypt.hash(process.env.SEED_USER_PASSWORD || 'ChangeMe123!', 10);
            await User.create({
                name: 'Varshita',
                email: 'varshita.colonel@gmail.com',
                password: hashedPassword,
                role: 'accountant'
            });
            console.log('✓ varshita.colonel@gmail.com created');
        }

        // Vidhi
        exists = await User.findOne({ where: { email: 'Vidhi.colonel@gmail.com' } });
        if (!exists) {
            const hashedPassword = await bcrypt.hash(process.env.SEED_USER_PASSWORD || 'ChangeMe123!', 10);
            await User.create({
                name: 'Vidhi',
                email: 'Vidhi.colonel@gmail.com',
                password: hashedPassword,
                role: 'accountant'
            });
            console.log('✓ Vidhi.colonel@gmail.com created');
        }

        // Shrikant (fix typo if needed)
        exists = await User.findOne({ where: { email: 'shrikant.colonel@gmail.com' } });
        if (!exists) {
            const hashedPassword = await bcrypt.hash(process.env.SEED_USER_PASSWORD || 'ChangeMe123!', 10);
            await User.create({
                name: 'Shrikant',
                email: 'shrikant.colonel@gmail.com',
                password: hashedPassword,
                role: 'accountant'
            });
            console.log('✓ shrikant.colonel@gmail.com created');
        }

        // Pankaj Rathore
        exists = await User.findOne({ where: { email: 'pankajrathore.colonel@gmail.com' } });
        if (!exists) {
            const hashedPassword = await bcrypt.hash(process.env.SEED_USER_PASSWORD || 'ChangeMe123!', 10);
            await User.create({
                name: 'Pankaj Rathore',
                email: 'pankajrathore.colonel@gmail.com',
                password: hashedPassword,
                role: 'accountant'
            });
            console.log('✓ pankajrathore.colonel@gmail.com created');
        }

        // Riya
        exists = await User.findOne({ where: { email: 'riya.colonel@gmail.com' } });
        if (!exists) {
            const hashedPassword = await bcrypt.hash(process.env.SEED_USER_PASSWORD || 'ChangeMe123!', 10);
            await User.create({
                name: 'Riya',
                email: 'riya.colonel@gmail.com',
                password: hashedPassword,
                role: 'accountant'
            });
            console.log('✓ riya.colonel@gmail.com created');
        }

        console.log('\n✓ User seeding completed successfully!');
        process.exit(0);

    } catch (error) {
        console.error('Seed error:', error);
        process.exit(1);
    }
};

seedUsers();
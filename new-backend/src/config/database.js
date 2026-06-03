const path = require('path');
const { Sequelize } = require('sequelize');
const dotenv = require('dotenv');

// Resolve .env from new-backend root regardless of where the script is run from
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Master Database Connection
 */
const masterSequelize = new Sequelize(
  process.env.DB_NAME_MASTER || process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'postgres',
    logging: false,
    pool: {
      max: 15,
      min: 1,
      acquire: 30000,
      idle: 10000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 0
    }
  }
);

// Map to store brand-specific connections
const brandConnections = new Map();

/**
 * Get or create a connection for a specific brand database
 * @param {string} dbName - The name of the brand database
 * @returns {Sequelize} - The sequelize instance for the brand
 */
const getBrandConnection = (dbName) => {
  if (brandConnections.has(dbName)) {
    return brandConnections.get(dbName);
  }

  const sequelize = new Sequelize(
    dbName,
    process.env.DB_USER,
    process.env.DB_PASSWORD,
    {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      dialect: 'postgres',
      logging: false,
      pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 0
      }
    }
  );

  brandConnections.set(dbName, sequelize);
  return sequelize;
};

/**
 * Helper to create a new Postgres database for a brand
 * @param {string} dbName - The name of the database to create
 */
const createBrandDatabase = async (dbName) => {
  // Use a temporary connection to postgres/master db to run CREATE DATABASE
  const tempSequelize = new Sequelize(
    'postgres',
    process.env.DB_USER,
    process.env.DB_PASSWORD,
    {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      dialect: 'postgres',
      logging: false
    }
  );

  try {
    // Check if database already exists
    const [results] = await tempSequelize.query(
      `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`
    );

    if (results.length === 0) {
      await tempSequelize.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Database created: ${dbName}`);
    } else {
      console.log(`Database already exists: ${dbName}`);
    }
  } catch (error) {
    console.error(`Error creating database ${dbName}:`, error);
    throw error;
  } finally {
    await tempSequelize.close();
  }
};

module.exports = {
  masterSequelize,
  getBrandConnection,
  createBrandDatabase
};

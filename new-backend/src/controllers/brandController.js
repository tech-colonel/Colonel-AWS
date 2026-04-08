const { Brand, BrandUser, User, Agent } = require('../models/master');
const { getBrandConnection, createBrandDatabase } = require('../config/database');
const { getBrandAgentModel, getDynamicModel } = require('../models/brand');
const path = require('path');
const fs = require('fs-extra');

const OUTPUT_DIR = path.join(__dirname, '../../outputs');

/**
 * Create a new brand and its dedicated database
 */
const createBrand = async (req, res, next) => {
  try {
    const { name, description, image_url } = req.body;
    const db_name = `colonel_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

    const existingBrand = await Brand.findOne({ where: { name } });
    if (existingBrand) {
      return res.status(400).json({ error: 'Brand already exists' });
    }

    // 1. Create the Postgres database
    await createBrandDatabase(db_name);

    // 2. Create the brand record in Master DB
    const brand = await Brand.create({
      name,
      description,
      image_url,
      db_name
    });

    // 3. Initialize the Brand DB with basic tables (like brand_agents)
    const brandDb = getBrandConnection(db_name);
    getBrandAgentModel(brandDb);
    await brandDb.sync();

    res.status(201).json({
      message: 'Brand created successfully',
      brand
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all brands (admin see all, others see assigned)
 */
const getAllBrands = async (req, res, next) => {
  console.log('[DEBUG] getAllBrands hit', { user: req.user.email, path: req.path });
  try {
    if (req.user.role === 'admin') {
      const brands = await Brand.findAll({ order: [['createdAt', 'DESC']] });
      return res.json(brands);
    }

    const user = await User.findByPk(req.user.id, {
      include: [{ model: Brand, through: { attributes: [] } }]
    });

    res.json(user.Brands || []);
  } catch (error) {
    next(error);
  }
};

/**
 * Get brand by ID
 */
const getBrandById = async (req, res, next) => {
  if (req.params.id === 'my-brands') return next();
  try {
    const brand = await Brand.findByPk(req.params.id);
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }
    res.json(brand);
  } catch (error) {
    next(error);
  }
};

/**
 * Assign a user to a brand
 */
const assignUserToBrand = async (req, res, next) => {
  try {
    const { brand_id, user_id } = req.body;

    const brand = await Brand.findByPk(brand_id);
    const user = await User.findByPk(user_id);

    if (!brand || !user) {
      return res.status(404).json({ error: 'Brand or User not found' });
    }

    await BrandUser.findOrCreate({
      where: { brand_id, user_id }
    });

    res.json({ message: 'User assigned to brand successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * List users assigned to a brand
 */
const getBrandUsers = async (req, res, next) => {
  try {
    const brand = await Brand.findByPk(req.params.brandId, {
      include: [{ model: User, through: { attributes: [] } }]
    });

    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    res.json(brand.Users || []);
  } catch (error) {
    next(error);
  }
};

const getBrandStatus = async (req, res, next) => {
  try {
    const brand = await Brand.findByPk(req.params.id, {
      include: [{ model: Agent }]
    });

    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const brandDb = getBrandConnection(brand.db_name);
    const agentsProgress = [];

    const numToMonth = {
      1: "January", 2: "February", 3: "March", 4: "April",
      5: "May", 6: "June", 7: "July", 8: "August",
      9: "September", 10: "October", 11: "November", 12: "December"
    };

    // Make sure we have tables ready before trying to query
    let allTables = [];
    try {
      allTables = await brandDb.getQueryInterface().showAllTables();
    } catch (e) {
      console.warn("Failed to fetch tables for brand", brand.name);
    }

    const BrandAgentModel = getBrandAgentModel(brandDb);
    const brandAgentsData = await BrandAgentModel.findAll();
    
    const masterDataMap = {};
    for (const ba of brandAgentsData) {
      masterDataMap[ba.agent_id] = {
        hasSkuMaster: Array.isArray(ba.sku_master) && ba.sku_master.length > 0,
        hasLedgerMaster: Array.isArray(ba.ledger_master) && ba.ledger_master.length > 0,
        skuMasterCount: Array.isArray(ba.sku_master) ? ba.sku_master.length : 0,
        ledgerMasterCount: Array.isArray(ba.ledger_master) ? ba.ledger_master.length : 0
      };
    }

    for (const agent of brand.Agents) {
      const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      let generatedFiles = [];

      if (allTables.includes(tableName)) {
        try {
          const Model = getDynamicModel(brandDb, tableName, agent.columns);
          
          const rows = await Model.findAll({
            attributes: ['id', 'month', 'year', 'filename', 'file_type', 'created_at'],
            order: [['created_at', 'DESC']],
            raw: true
          });

          const uniqueFilesMap = new Map();
          for (const row of rows) {
            if (row.filename && !uniqueFilesMap.has(row.filename)) {
              uniqueFilesMap.set(row.filename, row);
            }
          }

          const distinctMonths = Array.from(uniqueFilesMap.values());

          generatedFiles = distinctMonths.map(row => {
            const filePath = row.filename ? path.join(OUTPUT_DIR, row.filename) : null;
            const fileExists = filePath ? fs.existsSync(filePath) : false;

            return {
              month: numToMonth[row.month] || row.month,
              year: row.year,
              filename: row.filename,
              fileType: row.file_type,
              fileId: row.id,
              fileExists
            };
          });
        } catch (err) {
          console.error(`Query failed for agent ${agent.name} on table ${tableName}`, err);
        }
      }

      const masterStatus = masterDataMap[agent.id] || { 
        hasSkuMaster: false, hasLedgerMaster: false, skuMasterCount: 0, ledgerMasterCount: 0 
      };

      agentsProgress.push({
        agentId: agent.id,
        agentName: agent.name,
        generatedFiles,
        masterStatus
      });
    }

    res.json({
      brandId: brand.id,
      brandName: brand.name,
      agents: agentsProgress
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createBrand,
  getAllBrands,
  getBrandById,
  assignUserToBrand,
  getBrandUsers,
  getBrandStatus
};

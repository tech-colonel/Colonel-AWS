const { Brand, BrandUser, User, Agent } = require('../models/master');
const { getBrandConnection, createBrandDatabase } = require('../config/database');
const { getBrandAgentModel, getDynamicModel } = require('../models/brand');
const drive = require('../services/driveService');
const { getGoogleClient } = require('../services/googleClient');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs-extra');

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

// Can this user see this brand? (admin, or assigned via brand_users)
const userCanAccessBrand = async (user, brandId) => {
  if (user.role === 'admin') return true;
  const link = await BrandUser.findOne({ where: { brand_id: brandId, user_id: user.id } });
  return !!link;
};

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

/**
 * GET /api/brands/:brandId/drive
 * Lists files/subfolders in this brand's configured Drive folder.
 * Degrades gracefully: returns { configured:false } when no folder is set or
 * the service account isn't available (e.g. on local — real creds live on AWS).
 */
const getBrandDrive = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    const brand = await Brand.findByPk(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    if (!(await userCanAccessBrand(req.user, brandId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!brand.drive_folder_id) {
      return res.json({ configured: false, reason: 'no_folder', files: [] });
    }
    try {
      const rootId = brand.drive_folder_id;
      // Allow drilling into a subfolder via ?folderId, but keep it INSIDE this
      // brand's own tree (isolation) — verified via the service account.
      let folderId = (req.query.folderId || rootId).toString();
      if (folderId !== rootId) {
        const within = drive.isConfigured() ? await drive.isDescendant(folderId, rootId).catch(() => false) : false;
        if (!within) folderId = rootId;
      }

      const mapFile = (c, folderMime) => ({
        id: c.id,
        name: c.name,
        mimeType: c.mimeType,
        isFolder: c.mimeType === folderMime,
        size: c.size != null ? Number(c.size) : null,
        modifiedTime: c.modifiedTime || null,
        webViewLink: c.webViewLink || `https://drive.google.com/file/d/${c.id}/view`,
      });

      let files = null;
      // Prefer the connected Google account (OAuth → its own Drive access)…
      const g = await getGoogleClient();
      if (g) {
        try {
          const d = google.drive({ version: 'v3', auth: g.client });
          const r = await d.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)',
            orderBy: 'folder,modifiedTime desc,name',
            pageSize: 200,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          files = (r.data.files || []).map((c) => mapFile(c, DRIVE_FOLDER_MIME));
        } catch (_) { files = null; }
      }
      // …then fall back to the service account (brand folders are shared with
      // colonel-drive@…, not with personal OAuth accounts).
      if ((!files || files.length === 0) && drive.isConfigured()) {
        try { files = (await drive.listChildren(folderId) || []).map((c) => mapFile(c, drive.FOLDER_MIME)); }
        catch (_) { if (files == null) files = []; }
      }
      if (files == null) return res.json({ configured: false, reason: 'google_not_connected', files: [] });
      res.json({ configured: true, folderId, rootFolderId: rootId, files });
    } catch (err) {
      // Folder not accessible, or transient Drive error → empty, not 500.
      res.json({ configured: true, error: err.message, files: [] });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/brands/:brandId/drive-folder  (admin)
 * Admin pastes the brand's Drive folder link/id; we store the parsed id.
 */
const setBrandDriveFolder = async (req, res, next) => {
  try {
    const { brandId } = req.params;
    const { folderLink } = req.body;
    const brand = await Brand.findByPk(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const folderId = folderLink ? drive.parseFolderId(folderLink) : null;
    await brand.update({ drive_folder_id: folderId });
    res.json({ message: 'Drive folder updated', drive_folder_id: folderId, serviceAccount: drive.isConfigured() ? drive.serviceAccountEmail() : null });
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
  getBrandStatus,
  getBrandDrive,
  setBrandDriveFolder
};

const xlsx = require('xlsx');
const XLSX_STYLE = require('xlsx-js-style');
const path = require('path');
const fs = require('fs-extra');
const { getBrandConnection } = require('../config/database');
const { getBrandAgentModel, getDynamicModel } = require('../models/brand');
const { Brand, Agent } = require('../models/master');

// Import processors
const { processMacros: processAmazonB2C } = require('./processors/macrosProcessorB2C');
const { processMacrosB2B: processAmazonB2B } = require('./processors/macrosProcessorB2B');

const MONTH_NAME_TO_NUM = {
  'January': 1, 'February': 2, 'March': 3, 'April': 4,
  'May': 5, 'June': 6, 'July': 7, 'August': 8,
  'September': 9, 'October': 10, 'November': 11, 'December': 12
};
const toMonthNum = (m) => MONTH_NAME_TO_NUM[m] || parseInt(m) || null;
const toYearNum = (y) => parseInt(y) || null;

/**
 * Upload SKU or Ledger master for a brand-agent
 */
const uploadMasterData = async (brandId, agentId, type, fileBuffer) => {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');

  const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

  const brandDb = getBrandConnection(brand.db_name);
  const BrandAgentModel = getBrandAgentModel(brandDb);

  const [brandAgent] = await BrandAgentModel.findOrCreate({
    where: { brand_id: brandId, agent_id: agentId }
  });

  const updateData = {};
  if (type === 'sku') updateData.sku_master = data;
  else if (type === 'ledger') updateData.ledger_master = data;

  await brandAgent.update(updateData);
  return { count: data.length };
};

/**
 * Get master data for a brand-agent
 */
const getMasterData = async (brandId, agentId) => {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');

  const brandDb = getBrandConnection(brand.db_name);
  const BrandAgentModel = getBrandAgentModel(brandDb);

  const [brandAgent] = await BrandAgentModel.findOrCreate({
    where: { brand_id: brandId, agent_id: agentId }
  });

  return {
    sku_master: brandAgent.sku_master || [],
    ledger_master: brandAgent.ledger_master || []
  };
};

/**
 * Generate working file for Amazon
 */
const generateAmazonWorkingFile = async (brandId, agentId, options, fileBuffer) => {
  const { month, year, file_type, inventory_type } = options;
  
  const brand = await Brand.findByPk(brandId);
  const agent = await Agent.findByPk(agentId);
  if (!brand || !agent) throw new Error('Brand or Agent not found');

  const brandDb = getBrandConnection(brand.db_name);
  const BrandAgentModel = getBrandAgentModel(brandDb);

  const [brandAgent] = await BrandAgentModel.findOrCreate({
    where: { brand_id: brandId, agent_id: agentId }
  });

  if (!brandAgent.sku_master || !brandAgent.ledger_master) {
    throw new Error('Master data (SKU/Ledger) missing. Please upload them first.');
  }

  const useInventory = inventory_type === 'With';
  const dateString = `${year}-${month}-01`;

  let result;
  if (file_type === 'B2B') {
    result = await processAmazonB2B(
      fileBuffer,
      null,
      brand.name,
      dateString,
      brandAgent.sku_master,
      brandAgent.ledger_master,
      useInventory
    );
  } else {
    result = await processAmazonB2C(
      fileBuffer,
      null,
      brand.name,
      dateString,
      brandAgent.sku_master,
      brandAgent.ledger_master,
      useInventory
    );
  }

  // Save the output file
  const outputBuffer = XLSX_STYLE.write(result.outputWorkbook, {
    type: 'buffer',
    bookType: 'xlsx'
  });

  const timestamp = Date.now();
  const filename = `${brand.name}_Amazon_${file_type}_${month}_${year}_${timestamp}.xlsx`;
  const outputPath = path.join(__dirname, '../../outputs', filename);

  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, outputBuffer);

  // Record in dynamic table
  const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const WorkingFileModel = getDynamicModel(brandDb, tableName, agent.columns);

  const workingFile = await WorkingFileModel.create({
    month: toMonthNum(month),
    year: toYearNum(year),
    file_type,
    inventory_type,
    filename
  });

  return {
    fileId: workingFile.id,
    filename,
    recordCount: result.pivotData?.length || 0
  };
};

const addSkuMasterSingle = async (brandId, agentId, skuData) => {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');

  const brandDb = getBrandConnection(brand.db_name);
  const BrandAgentModel = getBrandAgentModel(brandDb);

  const [brandAgent] = await BrandAgentModel.findOrCreate({
    where: { brand_id: brandId, agent_id: agentId }
  });

  const currentSkuMaster = brandAgent.sku_master || [];
  // Ensure we append the new SKU matching the format. The upload uses whatever is in Excel.
  // The processor uses 'Sales portal SKU' and 'Tally new SKU'.
  const newEntry = {
    'Sales portal SKU': skuData.salesPortalSku,
    'Tally new SKU': skuData.tallyNewSku
  };
  if (skuData.rate !== undefined && skuData.rate !== '') {
    newEntry['Rate'] = skuData.rate;
  }
  const updatedSkuMaster = [...currentSkuMaster, newEntry];

  await brandAgent.update({ sku_master: updatedSkuMaster });
  return { success: true, count: updatedSkuMaster.length };
};

/**
 * Append a single, arbitrary-shaped entry to a brand-agent's sku_master or ledger_master.
 * Unlike addSkuMasterSingle (which hardcodes the SKU field names), this accepts whatever
 * key/value fields the caller provides — used to resolve a "missing master value" popup for
 * either master type, matching whatever column headers that brand's uploaded master used.
 */
const addMasterEntry = async (brandId, agentId, type, fields) => {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');
  if (type !== 'sku' && type !== 'ledger') {
    const err = new Error('type must be "sku" or "ledger"');
    err.status = 400;
    throw err;
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
    const err = new Error('fields object is required');
    err.status = 400;
    throw err;
  }

  const brandDb = getBrandConnection(brand.db_name);
  const BrandAgentModel = getBrandAgentModel(brandDb);

  const [brandAgent] = await BrandAgentModel.findOrCreate({
    where: { brand_id: brandId, agent_id: agentId }
  });

  const field = type === 'sku' ? 'sku_master' : 'ledger_master';
  const current = brandAgent[field] || [];
  const updated = [...current, fields];

  await brandAgent.update({ [field]: updated });
  return { success: true, count: updated.length };
};

const deleteSkuMasterSingle = async (brandId, agentId, tallySku) => {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');

  const brandDb = getBrandConnection(brand.db_name);
  const BrandAgentModel = getBrandAgentModel(brandDb);

  const [brandAgent] = await BrandAgentModel.findOrCreate({
    where: { brand_id: brandId, agent_id: agentId }
  });

  const currentSkuMaster = brandAgent.sku_master || [];
  
  // Filter out the matching Tally SKU
  // We check different variations since it comes from excel ('Tally new SKU', 'Tally SKU', etc.)
  const updatedSkuMaster = currentSkuMaster.filter(sku => {
    const currentTallySku = sku['Tally new SKU'] || sku['Tally SKU'] || sku.tallyNewSku || sku.fg || sku.FG;
    return currentTallySku !== tallySku;
  });

  await brandAgent.update({ sku_master: updatedSkuMaster });
  return { success: true, count: updatedSkuMaster.length };
};

/**
 * Delete a single sku_master/ledger_master entry by its array index.
 * Index-based so it works regardless of which column headers a given
 * bulk-uploaded sheet happened to use (SKU/FG vs Sales portal SKU/Tally new SKU, etc).
 */
const deleteMasterEntryAtIndex = async (brandId, agentId, type, index) => {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');

  const brandDb = getBrandConnection(brand.db_name);
  const BrandAgentModel = getBrandAgentModel(brandDb);

  const [brandAgent] = await BrandAgentModel.findOrCreate({
    where: { brand_id: brandId, agent_id: agentId }
  });

  const field = type === 'sku' ? 'sku_master' : 'ledger_master';
  const current = brandAgent[field] || [];
  const idx = parseInt(index, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
    const err = new Error('Invalid entry index');
    err.status = 400;
    throw err;
  }

  const updated = current.filter((_, i) => i !== idx);
  await brandAgent.update({ [field]: updated });
  return { success: true, count: updated.length };
};

/**
 * Wipe the entire sku_master or ledger_master array for a brand-agent (bulk delete).
 */
const clearMasterData = async (brandId, agentId, type) => {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');

  const brandDb = getBrandConnection(brand.db_name);
  const BrandAgentModel = getBrandAgentModel(brandDb);

  const [brandAgent] = await BrandAgentModel.findOrCreate({
    where: { brand_id: brandId, agent_id: agentId }
  });

  const field = type === 'sku' ? 'sku_master' : 'ledger_master';
  await brandAgent.update({ [field]: [] });
  return { success: true, count: 0 };
};

module.exports = {
  uploadMasterData,
  getMasterData,
  generateAmazonWorkingFile,
  addSkuMasterSingle,
  addMasterEntry,
  deleteSkuMasterSingle,
  deleteMasterEntryAtIndex,
  clearMasterData
};

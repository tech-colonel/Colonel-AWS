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

// Path to the standalone classifier (reused in --list-ledgers mode for COA validation/extraction).
const CLASSIFY_PY = process.env.BANK_CLASSIFIER_PATH
  || path.resolve(__dirname, '../../scripts/classify.py');

const ledgerKey = (name) => String(name).trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * Ingest a brand's full Chart of Accounts into the DB-backed `ledger_master` table.
 * Reuses classify.py's `--list-ledgers` mode so the same Tally cleaning + COA-integrity
 * guard run here (a bank statement uploaded as a COA is rejected, exit 2). Idempotent:
 * ON CONFLICT keeps existing rows, so re-uploading an updated COA only adds new ledgers.
 * @returns {Promise<{inserted:number,total:number,skipped:number}>}
 */
const ingestLedgerMasterToTable = async (brandId, fileBuffer) => {
  const brand = await Brand.findByPk(brandId);
  if (!brand) throw new Error('Brand not found');

  const os = require('os');
  const { execFile } = require('child_process');
  const tmpFile = path.join(os.tmpdir(), `coa_ingest_${brandId}_${Date.now()}.xlsx`);
  await fs.writeFile(tmpFile, fileBuffer);

  let names;
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('python3', [CLASSIFY_PY, '--ledger', tmpFile, '--list-ledgers'],
        { maxBuffer: 64 * 1024 * 1024 },
        (err, out, stderr) => {
          if (err) return reject(new Error((stderr || err.message || '').toString().trim()));
          resolve(out);
        });
    });
    names = JSON.parse(stdout);
  } finally {
    fs.remove(tmpFile).catch(() => {});
  }

  if (!Array.isArray(names) || names.length === 0) {
    throw new Error('No ledger names could be read from the uploaded COA file.');
  }

  const seen = new Set();
  const unique = [];
  for (const n of names) {
    const k = ledgerKey(n);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    unique.push({ name: String(n).trim(), key: k });
  }

  const brandDb = getBrandConnection(brand.db_name);
  let inserted = 0;
  await brandDb.transaction(async (t) => {
    await brandDb.query(`SET LOCAL app.bypass_rls = 'true'`, { transaction: t });
    for (const { name, key } of unique) {
      const [rows] = await brandDb.query(
        `INSERT INTO ledger_master (brand_id, ledger_name, ledger_name_key, source)
         VALUES ($1, $2, $3, 'upload')
         ON CONFLICT (brand_id, ledger_name_key) DO NOTHING
         RETURNING id`,
        { bind: [brandId, name, key], transaction: t }
      );
      if (rows && rows.length) inserted++;
    }
  });

  return { inserted, total: names.length, skipped: names.length - inserted };
};

module.exports = {
  uploadMasterData,
  getMasterData,
  generateAmazonWorkingFile,
  addSkuMasterSingle,
  deleteSkuMasterSingle,
  ingestLedgerMasterToTable
};

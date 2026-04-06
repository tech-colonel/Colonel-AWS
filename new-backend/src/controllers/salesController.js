const salesService = require('../services/salesService');
const { Brand, Agent } = require('../models/master');
const { getBrandConnection } = require('../config/database');
const { getDynamicModel } = require('../models/brand');
const path = require('path');
const fs = require('fs-extra');
const { amazonB2BProcessor } = require('../services/processors/amazon/amazonB2BProcessor');
const { amazonB2CProcessor } = require('../services/processors/amazon/amazonB2CProcessor');
const { flipkartProcessor } = require('../services/processors/flipkart/flipkartProcessor');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const XLSX_STYLE = require('xlsx-js-style'); // Using style version for writing if needed
const { v4: uuidv4 } = require('uuid');
const { QueryTypes } = require('sequelize');

const OUTPUT_DIR = path.join(__dirname, '../../outputs');

/**
 * Shared logic for working file management across all agents
 */
const getWorkingFiles = async (req, res, next) => {
  try {
    const { brandId, agentId } = req.params;

    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);

    if (!brand || !agent) {
      return res.status(404).json({ error: 'Brand or Agent not found' });
    }

    const brandDb = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

    const WorkingFileModel = getDynamicModel(
      brandDb,
      tableName,
      agent.columns
    );

    // ✅ Fetch all rows sorted (latest first)
    const rows = await WorkingFileModel.findAll({
      attributes: [
        'id',
        'filename',
        'month',
        'year',
        'file_type',
        'inventory_type',
        'created_at'
      ],
      order: [
        ['filename', 'ASC'],
        ['created_at', 'DESC']
      ],
      raw: true
    });

    // =====================================================
    // ✅ GROUP BY filename (keep latest)
    // =====================================================
    const uniqueFilesMap = new Map();

    for (const row of rows) {
      if (!uniqueFilesMap.has(row.filename)) {
        uniqueFilesMap.set(row.filename, row);
      }
    }

    const files = Array.from(uniqueFilesMap.values());

    res.json(files);

  } catch (error) {
    next(error);
  }
};

const deleteWorkingFile = async (req, res, next) => {
  try {
    const { brandId, agentId, fileId } = req.params;
    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);

    const brandDb = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const WorkingFileModel = getDynamicModel(brandDb, tableName, agent.columns);

    const file = await WorkingFileModel.findByPk(fileId);
    if (file && file.filename) {
      const filePath = path.join(OUTPUT_DIR, file.filename);
      if (await fs.exists(filePath)) {
        await fs.unlink(filePath);
      }
      await file.destroy();
    }

    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    next(error);
  }
};

const downloadWorkingFile = async (req, res, next) => {
  try {
    const { brandId, agentId, fileId } = req.params;
    const brand = await Brand.findByPk(brandId);
    const agent = await Agent.findByPk(agentId);

    const brandDb = getBrandConnection(brand.db_name);
    const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const WorkingFileModel = getDynamicModel(brandDb, tableName, agent.columns);

    const file = await WorkingFileModel.findByPk(fileId);
    if (!file || !file.filename) return res.status(404).json({ error: 'File not found' });

    const filePath = path.join(OUTPUT_DIR, file.filename);
    if (!(await fs.pathExists(filePath))) return res.status(404).json({ error: 'File not found on disk' });

    res.download(filePath, file.filename);
  } catch (error) {
    next(error);
  }
};

// ensure dir
async function ensureDir() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}
ensureDir();
const amazon = {
  uploadSkuMaster: async (req, res, next) => {
    try {
      const result = await salesService.uploadMasterData(req.params.brandId, req.params.agentId, 'sku', req.file.buffer);
      res.json({ message: 'SKU Master uploaded successfully', ...result });
    } catch (error) { next(error); }
  },
  uploadLedgerMaster: async (req, res, next) => {
    try {
      const result = await salesService.uploadMasterData(req.params.brandId, req.params.agentId, 'ledger', req.file.buffer);
      res.json({ message: 'Ledger Master uploaded successfully', ...result });
    } catch (error) { next(error); }
  },
  getMasterData: async (req, res, next) => {
    try {
      const result = await salesService.getMasterData(req.params.brandId, req.params.agentId);
      res.json(result);
    } catch (error) { next(error); }
  },
  // generate: async (req, res, next) => {
  //   try {
  //     const result = await salesService.generateAmazonWorkingFile(req.params.brandId, req.params.agentId, req.body, req.file.buffer);
  //     res.json({ message: 'Working file generated successfully', ...result });
  //   } catch (error) { next(error); }
  // }


  generate: async (req, res, next) => {
    try {
      const brand = await Brand.findByPk(req.params.brandId);
      const agent = await Agent.findByPk(req.params.agentId);

      if (!brand || !agent) {
        return res.status(404).json({ error: 'Brand or Agent not found' });
      }

      const brandDb = getBrandConnection(brand.db_name);
      const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const Model = getDynamicModel(brandDb, tableName, agent.columns);

      let processedData;
      const useInventory = req.body.inventory_type === 'With';

      // Fetch master data needed by processors
      const masterData = await salesService.getMasterData(req.params.brandId, req.params.agentId);

      // 🔥 PROCESSING
      if (req.body.file_type?.toLowerCase() === 'b2b') {
        processedData = await amazonB2BProcessor(
          req.file.buffer,
          null, // skuFileBuffer (already in masterData)
          brand.name,
          new Date().toISOString(), // Use current date for invoice month logic
          masterData.sku_master,
          masterData.ledger_master,
          useInventory
        );
      } else if (req.body.file_type?.toLowerCase() === 'b2c') {
        processedData = await amazonB2CProcessor(
          req.file.buffer,
          null,
          brand.name,
          new Date().toISOString(),
          masterData.sku_master,
          masterData.ledger_master,
          useInventory
        );
      } else {
        return res.status(400).json({ error: 'Invalid type. Use b2b or b2c' });
      }

      if (!processedData || !processedData.process1Json) {
        return res.status(400).json({ error: 'Processor must return array of JSON' });
      }

      // ✅ UNIQUE FILE NAME (MACROS STYLE)
      const fileId = uuidv4();
      const fileName = `amazon_${req.body.file_type}_${brand.name}_${fileId}.xlsx`;
      const filePath = path.join(OUTPUT_DIR, fileName);
      await fs.ensureDir(OUTPUT_DIR);

      // ✅ Convert month name to number
      const monthNameToNumber = {
        'January': 1, 'February': 2, 'March': 3, 'April': 4,
        'May': 5, 'June': 6, 'July': 7, 'August': 8,
        'September': 9, 'October': 10, 'November': 11, 'December': 12
      };
      const monthNum = monthNameToNumber[req.body.month] || parseInt(req.body.month) || null;
      const yearNum = parseInt(req.body.year) || null;

      // ✅ FINAL DATA (FOR DB)
      const finalData = processedData.process1Json.map(row => ({
        ...row,
        month: monthNum,
        year: yearNum,
        file_type: req.body.file_type,
        inventory_type: req.body.inventory_type,
        filename: fileName
      }));

      // ✅ SAVE DB
      const resultRows = await Model.bulkCreate(finalData, { returning: true });
      const firstId = resultRows[0]?.id;

      // =====================================================
      // 🔥 MULTI-SHEET EXCEL GENERATION (LIKE MACROS)
      // =====================================================

      const workbook = new ExcelJS.Workbook();
      // ... (Rest of Excel generation)
      const sheet1 = workbook.addWorksheet('process1');
      const headers1 = Object.keys(processedData.process1Json[0] || {});
      sheet1.addRow(headers1);
      processedData.process1Json.forEach(row => {
        sheet1.addRow(headers1.map(h => row[h]));
      });

      if (processedData.pivotData && processedData.pivotData.length > 0) {
        const sheet2 = workbook.addWorksheet('pivot');
        const headers2 = Object.keys(processedData.pivotData[0]);
        sheet2.addRow(headers2);
        processedData.pivotData.forEach(row => {
          sheet2.addRow(headers2.map(h => row[h]));
        });
      }

      await workbook.xlsx.writeFile(filePath);

      res.json({
        message: 'Amazon working file generated successfully',
        count: finalData.length,
        file: fileName,
        fileId: firstId
      });

    } catch (error) {
      next(error);
    }
  }
};

const flipkart = {
  uploadSkuMaster: async (req, res, next) => {
    try {
      const result = await salesService.uploadMasterData(req.params.brandId, req.params.agentId, 'sku', req.file.buffer);
      res.json({ message: 'SKU Master uploaded successfully', ...result });
    } catch (error) { next(error); }
  },
  uploadLedgerMaster: async (req, res, next) => {
    try {
      const result = await salesService.uploadMasterData(req.params.brandId, req.params.agentId, 'ledger', req.file.buffer);
      res.json({ message: 'Ledger Master uploaded successfully', ...result });
    } catch (error) { next(error); }
  },
  getMasterData: async (req, res, next) => {
    try {
      const result = await salesService.getMasterData(req.params.brandId, req.params.agentId);
      res.json(result);
    } catch (error) { next(error); }
  },
  generate: async (req, res, next) => {
    try {
      const brand = await Brand.findByPk(req.params.brandId);
      const agent = await Agent.findByPk(req.params.agentId);

      if (!brand || !agent) {
        return res.status(404).json({ error: 'Brand or Agent not found' });
      }

      const brandDb = getBrandConnection(brand.db_name);
      const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const Model = getDynamicModel(brandDb, tableName, agent.columns);

      const useInventory = req.body.inventory_type === 'With';

      // 1. Fetch master data needed by processors
      const masterData = await salesService.getMasterData(req.params.brandId, req.params.agentId);

      // 2. 🔥 PROCESSING
      const processedData = await flipkartProcessor(
        req.file.buffer,
        masterData.sku_master,
        masterData.ledger_master,
        brand.name,
        new Date().toISOString(), // Base date for invoice logic
        useInventory
      );

      if (!processedData || !processedData.workingFileData) {
        return res.status(400).json({ error: 'Processor Error: No data returned' });
      }

      // 3. ✅ UNIQUE FILE NAME
      const fileId = uuidv4();
      const fileName = `flipkart_${brand.name}_${fileId}.xlsx`;
      const filePath = path.join(OUTPUT_DIR, fileName);
      await fs.ensureDir(OUTPUT_DIR);

      // 4. ✅ Convert month name to number
      const monthNameToNumber = {
        'January': 1, 'February': 2, 'March': 3, 'April': 4,
        'May': 5, 'June': 6, 'July': 7, 'August': 8,
        'September': 9, 'October': 10, 'November': 11, 'December': 12
      };
      const monthNum = monthNameToNumber[req.body.month] || parseInt(req.body.month) || null;
      const yearNum = parseInt(req.body.year) || null;

      // 5. ✅ FINAL DATA (FOR DB) - Map to seed-sales-flipkart.js structure
      const finalData = processedData.workingFileData.map(row => ({
        // meta
        month: monthNum,
        year: yearNum,
        inventory_type: req.body.inventory_type,
        filename: fileName,
        date: row.order_date ? new Date(row.order_date) : null,

        // seller info
        seller_gstin: row.seller_gstin,
        seller_state: row.seller_state,

        // order info
        order_id: row.order_id,
        order_item_id: row.order_item_id,
        order_type: row.order_type,
        event_type: row.event_type,
        event_sub_type: row.event_sub_type,
        order_date: row.order_date ? new Date(row.order_date) : null,
        order_approval_date: row.order_approval_date ? new Date(row.order_approval_date) : null,

        // product
        sku: row.sku,
        fg: row.fg || null,
        fsn: row.fsn,
        item_description: row.product_title,
        hsn_code: row.hsn_code,
        quantity: Math.abs(parseInt(row.item_quantity)) || 0,

        // fulfillment
        fulfilment_type: row.fulfilment_type,
        warehouse_id: row.warehouse_id,
        ship_from_state: row.order_shipped_from_state,

        // pricing
        price_before_discount: row.price_before_discount,
        total_discount: row.total_discount,
        price_after_discount: row.price_after_discount,
        shipping_charges: row.shipping_charges,

        // final values
        final_taxable_sales_value: row.final_taxable_sales_value,
        final_shipping_taxable_value: row.final_shipping_taxable_value,
        final_invoice_amount: row.final_invoice_amount,

        // GST rates
        gst_rate: row.final_gst_rate,
        cgst_rate: row.cgst_rate,
        sgst_rate: row.sgst_rate,
        igst_rate: row.igst_rate,

        // GST amounts
        cgst_amount: row.cgst_amount,
        sgst_amount: row.sgst_amount,
        igst_amount: row.igst_amount,

        // final GST taxes
        final_cgst_tax: row.final_cgst_taxable,
        final_sgst_tax: row.final_sgst_taxable,
        final_igst_tax: row.final_igst_taxable,

        // shipping taxes
        shipping_cgst_tax: row.final_cgst_shipping,
        shipping_sgst_tax: row.final_sgst_shipping,
        shipping_igst_tax: row.final_igst_shipping,

        // TCS
        tcs_igst_amount: row.tcs_igst_amount,
        tcs_cgst_amount: row.tcs_cgst_amount,
        tcs_sgst_amount: row.tcs_sgst_amount,
        total_tcs: row.total_tcs_deducted,

        // TDS
        tds_rate: row.tds_rate,
        tds_amount: row.tds_amount,

        // invoice
        buyer_invoice_id: row.buyer_invoice_id,
        buyer_invoice_date: row.buyer_invoice_date ? new Date(row.buyer_invoice_date) : null,
        buyer_invoice_amount: row.buyer_invoice_amount,
        final_invoice_number: row.final_invoice_no,

        // customer
        billing_state: row.customer_billing_state,
        billing_pincode: row.customer_billing_pincode,
        shipping_state: row.customer_delivery_state,
        shipping_pincode: row.customer_delivery_pincode,

        // business
        business_name: row.business_name,
        business_gstin: row.business_gst_number,

        // misc
        is_shopsy_order: row.is_shopsy_order || false,
        tally_ledger: row.tally_ledgers,
        imei: row.imei
      }));

      // 6. ✅ SAVE TO DB
      const resultRows = await Model.bulkCreate(finalData, { returning: true });
      const firstId = resultRows[0]?.id;

      // 7. ✅ FINAL EXCEL FILE GENERATION (USING PROCESSOR OUTPUT)
      XLSX_STYLE.writeFile(processedData.outputWorkbook, filePath);

      res.json({
        message: 'Flipkart working file generated successfully',
        count: finalData.length,
        file: fileName,
        fileId: firstId
      });

    } catch (error) {
      next(error);
    }
  }
};

module.exports = {
  amazon,
  flipkart,
  getWorkingFiles,
  deleteWorkingFile,
  downloadWorkingFile
};

// Runs the shopify-dchica workflow (workflow.json) with the RTO/Return merge
// against the AUG test files (4 inputs: raw dump + Omnivio + Velocity + Eshopbox),
// using the same engine (applyMultiSheetWorkflow) the Workflow Manager uses in prod.
const fs = require('fs');
const path = require('path');
const { applyMultiSheetWorkflow } = require('../../src/controllers/workflowController');

const DIR = __dirname;
const BASE = '/Users/apple/Documents/Colonel-AWS/test files receivables/shopify dchica/AUG';

const workflow = JSON.parse(fs.readFileSync(path.join(DIR, 'workflow.json'), 'utf8'));
const sku_master = JSON.parse(fs.readFileSync(path.join(DIR, 'sku_master.json'), 'utf8'));
const ledger_master = JSON.parse(fs.readFileSync(path.join(DIR, 'hsn_master.json'), 'utf8'));
const product_type_master = JSON.parse(fs.readFileSync(path.join(DIR, 'product_type_master.json'), 'utf8'));

const fileBufferOrMap = {
  file_0: fs.readFileSync(path.join(BASE, 'Total sales breakdown (P) With Order Name Aug.csv')),
  file_1: fs.readFileSync(path.join(BASE, 'MIS-OmniVio Aug-26.xlsx')),
  file_2: fs.readFileSync(path.join(BASE, 'DCHICA FAS-Order Report-Aug-26.xlsx')),
  file_3: fs.readFileSync(path.join(BASE, 'sale_order_report_v2_260910102321921-3938 Working.xlsx')),
};

const { buffer, missingMasterValues } = applyMultiSheetWorkflow(
  workflow.sheets,
  fileBufferOrMap,
  { sku_master, ledger_master, product_type_master },
  workflow.fileInputs
);

const outPath = path.join(DIR, 'output_aug_rto.xlsx');
fs.writeFileSync(outPath, buffer);
console.log('Wrote', outPath, buffer.length, 'bytes');
console.log('Missing master values:', missingMasterValues.length);

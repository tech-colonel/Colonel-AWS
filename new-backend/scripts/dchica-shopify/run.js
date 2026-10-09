// Runs the shopify-dchica workflow (workflow.json) against the real monthly dump,
// using the same engine (applyMultiSheetWorkflow) the Workflow Manager uses in prod.
const fs = require('fs');
const path = require('path');
const { applyMultiSheetWorkflow } = require('../../src/controllers/workflowController');

const DIR = __dirname;
const BASE = '/Users/apple/Documents/Colonel-AWS/test files receivables/shopify dchica';

const workflow = JSON.parse(fs.readFileSync(path.join(DIR, 'workflow.json'), 'utf8'));
const sku_master = JSON.parse(fs.readFileSync(path.join(DIR, 'sku_master.json'), 'utf8'));
const ledger_master = JSON.parse(fs.readFileSync(path.join(DIR, 'hsn_master.json'), 'utf8'));
const product_type_master = JSON.parse(fs.readFileSync(path.join(DIR, 'product_type_master.json'), 'utf8'));

const fileBuffer = fs.readFileSync(path.join(BASE, 'Total sales breakdown (P) With Order Name Dump.csv'));

const { buffer, missingMasterValues } = applyMultiSheetWorkflow(
  workflow.sheets,
  fileBuffer,
  { sku_master, ledger_master, product_type_master },
  workflow.fileInputs
);

const outPath = path.join(DIR, 'output_generated.xlsx');
fs.writeFileSync(outPath, buffer);
console.log('Wrote', outPath, buffer.length, 'bytes');
console.log('Missing master values:', missingMasterValues.length);
fs.writeFileSync(path.join(DIR, 'missing_master_values.json'), JSON.stringify(missingMasterValues, null, 2));

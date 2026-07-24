#!/usr/bin/env node
/**
 * smoke-invoice-code-local.js — Phase 1a end-to-end smoke test on LOCAL PDFs.
 *
 * Runs the exact engine pipeline (pdf-parse → Claude Haiku extraction → code
 * Vendor Master lookup → verbatim Code node) on given PDFs, ONE INVOICE AT A TIME
 * (a separate Claude call per file, like n8n's Loop Over Items). Prints each
 * invoice's extracted rows for comparison against the KOPARO OUTPUT sheet.
 *
 * Vendor Master is a local snapshot (scratchpad/vendor_master.json) exported via
 * the Drive API, because the Sheets API is currently disabled in the SA's GCP project.
 *
 * Usage (from new-backend/):
 *   node scripts/smoke-invoice-code-local.js --verbose
 *   node scripts/smoke-invoice-code-local.js --write --verbose   # also insert into invoice_code
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const engine = require('../src/services/invoiceEngine/brands/koparo.engine');
const { buildVendorLookup } = require('../src/services/invoiceEngine/core/vendorLookup');
const { extractPdfText, runExtraction, MODEL } = require('../src/services/invoiceEngine/core/extract');

const VENDOR_SNAPSHOT = '/private/tmp/claude-501/-Users-dhavalchauhan-Colonel-Full/67732eda-f6b5-476a-b85f-71d55eda38a0/scratchpad/vendor_master.json';
const FILES = [
  '/Users/dhavalchauhan/Downloads/Processed_Sales-Other_AH_26-27_567.pdf',
  '/Users/dhavalchauhan/Downloads/Processed_Sales-Other_AH_26-27_568.pdf',
  '/Users/dhavalchauhan/Downloads/Processed_Sales-Other_AH_26-27_569.pdf',
];
const flag = (n) => process.argv.includes(`--${n}`);

function safeParseArray(str) {
  if (Array.isArray(str)) return str;
  if (typeof str !== 'string') return null;
  let s = str.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : [v]; } catch {}
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

const SHOW = ['company','vendor_name_tally','invoice_number','invoice_date','seller_gstin','buyer_gstin','voucher_type','category','product_name','hsn_code','quantity','rate','amount','cgst_rate','sgst_rate','igst_rate','GST_AMOUNT','tds_section','tds_rate','tds_amount','batch_no','status'];

(async () => {
  const verbose = flag('verbose');
  const doWrite = flag('write');
  const vmRows = JSON.parse(fs.readFileSync(VENDOR_SNAPSHOT, 'utf8'));
  const vendorLookup = buildVendorLookup(vmRows);
  console.log(`Vendor master rows: ${vmRows.length - 1} | model: ${MODEL}\n`);

  const allRows = [];
  for (const file of FILES) {                              // ← one invoice at a time
    const name = file.split('/').pop();
    console.log('═'.repeat(78));
    console.log('INVOICE FILE:', name);
    if (!fs.existsSync(file)) { console.log('  !! not found, skipping'); continue; }

    const buffer = fs.readFileSync(file);
    const text = await extractPdfText(buffer);
    console.log(`  pdf text length: ${text.length} chars`);
    if (verbose) console.log('  --- text head ---\n' + text.slice(0, 500).split('\n').map(l => '   | ' + l).join('\n') + '\n  ---');

    let outputStr = '[]';
    if (text && text.trim()) {
      // Text extracted (pdf-parse) → same as n8n's "Extract from File" → AI Agent.
      const llmRaw = await runExtraction(engine.buildPrompt(text));  // ← separate Claude call per invoice
      const parsed = safeParseArray(llmRaw);
      if (Array.isArray(parsed)) {
        for (const r of parsed) {
          if (r && typeof r === 'object') {
            const res = vendorLookup(r.seller_gstin, r.company);
            r.vendor_name_tally = res.vendor_name_tally;   // injected from code lookup (replaces n8n tool)
            r.category = res.nature_of_expense;
          }
        }
        outputStr = JSON.stringify(parsed);
        console.log(`  Claude extracted ${parsed.length} raw line-item(s)`);
      } else {
        outputStr = llmRaw;
        console.log('  Claude output was not a JSON array; passing raw to Code node guards');
        if (verbose) console.log('  raw:', JSON.stringify(llmRaw).slice(0, 300));
      }
    }

    const rows = engine.runCodeNode([{ json: { output: outputStr, webViewLink: 'local://' + name } }]);
    console.log(`  → Code node produced ${rows.length} output row(s):`);
    rows.forEach((r, i) => {
      const j = r.json;
      console.log(`\n  ── line ${i + 1} ──`);
      SHOW.forEach(k => { if (j[k] !== undefined && j[k] !== '' && j[k] !== null) console.log(`     ${k}: ${j[k]}`); });
      allRows.push({ ...j, _filename: name });
    });
    console.log('');
  }

  if (doWrite) {
    const { Brand, Agent } = require('../src/models/master');
    const ingest = require('../src/services/invoiceEngine/core/ingest');
    const brand = await Brand.findOne({ where: { name: 'Koparo' } });
    const agent = await Agent.findOne({ where: { name: 'Invoice code' } });
    if (!brand || !agent) throw new Error('Koparo brand or Invoice code agent not found');
    const summary = await ingest.writeRows(brand, agent, allRows);
    console.log('═'.repeat(78));
    console.log('WROTE TO invoice_code:', JSON.stringify(summary, null, 2));
  }
  console.log('\nDONE. Total output rows across all invoices:', allRows.length);
  process.exit(0);
})().catch(e => { console.error('SMOKE ERROR:', e && e.stack ? e.stack : e); process.exit(1); });

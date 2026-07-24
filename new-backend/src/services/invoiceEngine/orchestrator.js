/**
 * orchestrator.js — the in-app invoice engine (code replacement for the n8n flow).
 *
 * Phase 1a: Drive-poll intake for ONE brand (Koparo), writing to the new
 * `invoice_code` table via the `Invoice code` agent. Existing Invoice Process
 * (n8n) flow is untouched.
 *
 * Pipeline per file (faithful to the n8n graph):
 *   Drive list → skip already-processed → download → pdf-parse text →
 *   Claude Haiku extraction (verbatim prompt) → inject vendor_name_tally+category
 *   from the code Vendor Master lookup (replaces the n8n tool) →
 *   verbatim Code-node (TDS/category/voucher/dedup/invoice-total) → write invoice_code.
 */
const path = require('path');
const { QueryTypes } = require('sequelize');
const { masterSequelize, getBrandConnection } = require('../../config/database');
const { Brand, Agent } = require('../../models/master');
const drive = require('../driveService');
const sheets = require('./core/sheetsService');
const { buildVendorLookup } = require('./core/vendorLookup');
const { extractPdfText, runExtraction } = require('./core/extract');
const ingest = require('./core/ingest');

// variant -> brand engine module (verbatim prompt + Code node)
const ENGINES = {
  koparo: require('./brands/koparo.engine'),
};

const log = (verbose, ...a) => { if (verbose) console.log('[invoice-code]', ...a); };

function safeParseArray(str) {
  if (typeof str !== 'string') return Array.isArray(str) ? str : null;
  let s = str.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : [v]; } catch {}
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

async function processBrand(opts = {}) {
  const { brand: brandName = 'Koparo', limit = 0, file = null, dryRun = false, verbose = false } = opts;

  // 1. Resolve brand + the "Invoice code" agent
  const brand = await Brand.findOne({ where: { name: brandName } })
    || await Brand.findOne({ where: { name: brandName.toLowerCase() } });
  if (!brand) throw new Error(`Brand not found: ${brandName}`);
  const agent = await Agent.findOne({ where: { name: 'Invoice code' } });
  if (!agent) throw new Error(`Agent "Invoice code" not found — run migration 100_invoice_code_agent.sql`);

  // 2. Per-brand config (Pattern A: brand_agents.invoice_config)
  const cfgRows = await masterSequelize.query(
    'SELECT invoice_config FROM brand_agents WHERE brand_id = :b AND agent_id = :a LIMIT 1',
    { replacements: { b: brand.id, a: agent.id }, type: QueryTypes.SELECT }
  );
  const config = (cfgRows[0] && cfgRows[0].invoice_config) || {};
  const variant = config.variant || brandName.toLowerCase();
  const engine = ENGINES[variant];
  if (!engine) throw new Error(`No engine module for variant "${variant}"`);
  if (config.enabled === false) throw new Error(`invoice_config.enabled is false for ${brandName}`);

  const folderId = drive.parseFolderId(config.driveFolderId) || config.driveFolderId;
  if (!folderId) throw new Error(`invoice_config.driveFolderId missing for ${brandName}`);

  log(verbose, `brand=${brand.name} (${brand.id}) agent=${agent.id} variant=${variant}`);
  log(verbose, `service account = ${drive.serviceAccountEmail()}`);

  // 3. Vendor Master (Drive CSV export via service account — Sheets API is disabled)
  const vm = config.vendorMaster || {};
  const vmRows = await sheets.readSheetCsv(vm.sheetId, vm.gid);
  const vendorLookup = buildVendorLookup(vmRows);
  log(verbose, `vendor master rows: ${vmRows.length}`);

  // 4. Drive files (PDFs), minus already-processed (by filename in invoice_code)
  let files = await drive.listChildren(folderId);
  files = files.filter(f => f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
  if (file) files = files.filter(f => f.id === file || f.name === file);

  const brandDb = getBrandConnection(brand.db_name);
  const processed = await brandDb.query('SELECT DISTINCT filename FROM invoice_code', { type: QueryTypes.SELECT });
  const seen = new Set(processed.map(r => r.filename).filter(Boolean));
  const pending = files.filter(f => !seen.has(f.name));
  const toRun = limit > 0 ? pending.slice(0, limit) : pending;
  log(verbose, `folder files=${files.length}, already-processed=${seen.size}, to-run=${toRun.length}`);

  // 5. Process each file
  const allRows = [];
  const perFile = [];
  for (const f of toRun) {
    let meta = {};
    try { meta = await drive.getMeta(f.id, 'id,name,webViewLink'); } catch {}
    const webViewLink = meta.webViewLink || `https://drive.google.com/file/d/${f.id}/view`;

    const buffer = await drive.downloadFile(f.id);
    const text = await extractPdfText(buffer);

    let outputStr;
    if (!text || !text.trim()) {
      outputStr = '[]'; // scanned/empty → matches n8n empty-text behavior (OCR is Phase 2)
    } else {
      const llmRaw = await runExtraction(engine.buildPrompt(text));
      // Inject vendor_name_tally + category from code lookup (replaces n8n Vendor_Master tool)
      const parsed = safeParseArray(llmRaw);
      if (Array.isArray(parsed)) {
        for (const r of parsed) {
          if (r && typeof r === 'object') {
            const res = vendorLookup(r.seller_gstin, r.company);
            r.vendor_name_tally = res.vendor_name_tally;
            r.category = res.nature_of_expense;
          }
        }
        outputStr = JSON.stringify(parsed);
      } else {
        outputStr = llmRaw; // let the Code node's own guards handle unparseable output
      }
    }

    const rows = engine.runCodeNode([{ json: { output: outputStr, webViewLink } }]);
    const plain = rows.map(r => ({ ...r.json, _filename: f.name }));
    allRows.push(...plain);
    perFile.push({ file: f.name, lines: plain.length, statuses: plain.map(p => p.status) });
    log(verbose, `  ${f.name}: text=${text.length}b → ${plain.length} row(s)`);
  }

  // 6. Write (unless dry run)
  let writeSummary = null;
  if (!dryRun && allRows.length) {
    writeSummary = await ingest.writeRows(brand, agent, allRows);
  }

  return {
    brand: brand.name, agent: agent.name, variant,
    folderFiles: files.length, alreadyProcessed: seen.size, ran: toRun.length,
    rowsProduced: allRows.length, perFile, write: writeSummary,
    sampleRows: allRows.slice(0, 3),
  };
}

module.exports = { processBrand };

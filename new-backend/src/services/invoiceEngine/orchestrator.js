/**
 * orchestrator.js — the in-app invoice engine (code replacement for the n8n flow).
 *
 * Fetches invoice PDFs from Drive, extracts them with Claude (verbatim prompt),
 * resolves vendor/category/TDS in code, writes to the `invoice_code` table, then
 * moves each file into its vendor folder — the full n8n Koparo flow, in code.
 *
 * Drive access is pluggable per-brand via invoice_config.source:
 *   "composio"        → Google Super toolkit as the connected account (composioUserId)
 *   "service-account" → the colonel-drive service account (default)
 */
const { QueryTypes } = require('sequelize');
const { masterSequelize, getBrandConnection } = require('../../config/database');
const { Brand, Agent } = require('../../models/master');
const driveSA = require('../driveService');
const driveComposio = require('./core/driveComposio');
const { buildVendorLookup } = require('./core/vendorLookup');
const { extractPdfText, runExtraction } = require('./core/extract');
const ingest = require('./core/ingest');

const ENGINES = { koparo: require('./brands/koparo.engine') };
const isPdf = (f) => f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name || '');
const log = (v, ...a) => { if (v) console.log('[invoice-code]', ...a); };

function safeParseArray(str) {
  if (Array.isArray(str)) return str;
  if (typeof str !== 'string') return null;
  let s = str.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : [v]; } catch {}
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

// Pick the vendor folder name for a file from its processed rows.
function pickVendor(rows) {
  const good = rows.find((r) => r.vendor_name_tally && !/^n\/?a$/i.test(String(r.vendor_name_tally).trim()));
  const name = (good && good.vendor_name_tally) || (rows[0] && rows[0].company) || 'Unknown';
  return String(name).replace(/[\\/]/g, '-').trim() || 'Unknown';
}

// Build the Drive source (composio | service-account) from config.
function makeSource(config, verbose) {
  if (config.source === 'composio') {
    const userId = config.composioUserId || 'central';
    return {
      kind: 'composio', userId, canMove: true,
      listPdfs: async (folderId) => (await driveComposio.listChildren(userId, folderId)).filter(isPdf),
      download: (fileId) => driveComposio.downloadFile(userId, fileId), // {buffer, webViewLink}
      ensureFolder: (name, parent) => driveComposio.ensureFolder(userId, name, parent),
      moveFile: (fileId, add, remove) => driveComposio.moveFile(userId, fileId, add, remove),
    };
  }
  return {
    kind: 'service-account', canMove: false,
    listPdfs: async (folderId) => (await driveSA.listChildren(folderId)).filter(isPdf),
    download: async (fileId) => {
      const buffer = await driveSA.downloadFile(fileId);
      let webViewLink = null;
      try { webViewLink = (await driveSA.getMeta(fileId, 'id,name,webViewLink')).webViewLink; } catch {}
      return { buffer, webViewLink };
    },
  };
}

async function processBrand(opts = {}) {
  const { brand: brandName = 'Koparo', limit = 0, file = null, dryRun = false, verbose = false, move } = opts;

  const brand = await Brand.findOne({ where: { name: brandName } })
    || await Brand.findOne({ where: { name: brandName.toLowerCase() } });
  if (!brand) throw new Error(`Brand not found: ${brandName}`);
  const agent = await Agent.findOne({ where: { name: 'Invoice code' } });
  if (!agent) throw new Error('Agent "Invoice code" not found — run migration 100_invoice_code_agent.sql');

  const cfgRows = await masterSequelize.query(
    'SELECT invoice_config FROM brand_agents WHERE brand_id = :b AND agent_id = :a LIMIT 1',
    { replacements: { b: brand.id, a: agent.id }, type: QueryTypes.SELECT }
  );
  const config = (cfgRows[0] && cfgRows[0].invoice_config) || {};
  const variant = config.variant || brandName.toLowerCase();
  const engine = ENGINES[variant];
  if (!engine) throw new Error(`No engine module for variant "${variant}"`);
  if (config.enabled === false) throw new Error(`invoice_config.enabled is false for ${brandName}`);

  const folderId = driveSA.parseFolderId(config.driveFolderId) || config.driveFolderId;
  if (!folderId) throw new Error(`invoice_config.driveFolderId missing for ${brandName}`);

  const src = makeSource(config, verbose);
  const doMove = (move !== undefined ? move : (config.moveVendorWise !== false)) && src.canMove && !dryRun;
  const vendorParent = driveSA.parseFolderId(config.vendorFolderParentId) || config.vendorFolderParentId || folderId;
  log(verbose, `brand=${brand.name} agent=${agent.id} variant=${variant} source=${src.kind} move=${doMove}`);

  // Vendor Master — prefer the in-code module.
  let vmRows;
  try { vmRows = require(`./brands/${variant}.vendorMaster`).rows; log(verbose, `vendor master: code (${vmRows.length - 1} rows)`); }
  catch (e) {
    const vm = config.vendorMaster || {};
    if (!vm.sheetId) throw new Error(`No code vendor master for "${variant}"`);
    const sheets = require('./core/sheetsService');
    vmRows = await sheets.readSheetCsv(vm.sheetId, vm.gid);
  }
  const vendorLookup = buildVendorLookup(vmRows);

  // List PDFs minus already-processed (by filename in invoice_code)
  let files = await src.listPdfs(folderId);
  if (file) {
    const wanted = String(file).split(',').map((s) => s.trim()).filter(Boolean);
    files = files.filter((f) => wanted.includes(f.id) || wanted.includes(f.name));
  }
  const brandDb = getBrandConnection(brand.db_name);
  const processed = await brandDb.query('SELECT DISTINCT filename FROM invoice_code', { type: QueryTypes.SELECT });
  const seen = new Set(processed.map((r) => r.filename).filter(Boolean));
  const pending = files.filter((f) => !seen.has(f.name));
  const toRun = limit > 0 ? pending.slice(0, limit) : pending;
  log(verbose, `folder=${files.length} processed=${seen.size} to-run=${toRun.length}`);

  const allRows = [];
  const perFile = [];
  for (const f of toRun) {
    let dl;
    try { dl = await src.download(f.id); } catch (e) { log(verbose, `  download failed ${f.name}: ${e.message}`); continue; }
    const webViewLink = dl.webViewLink || f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`;
    const text = await extractPdfText(dl.buffer);

    let outputStr = '[]';
    if (text && text.trim()) {
      const llmRaw = await runExtraction(engine.buildPrompt(text));
      const parsed = safeParseArray(llmRaw);
      if (Array.isArray(parsed)) {
        for (const r of parsed) if (r && typeof r === 'object') {
          const res = vendorLookup(r.seller_gstin, r.company);
          r.vendor_name_tally = res.vendor_name_tally;
          r.category = res.nature_of_expense;
        }
        outputStr = JSON.stringify(parsed);
      } else { outputStr = llmRaw; }
    }
    const rows = engine.runCodeNode([{ json: { output: outputStr, webViewLink } }]).map((r) => r.json);
    rows.forEach((r) => allRows.push({ ...r, _filename: f.name }));
    perFile.push({ id: f.id, name: f.name, vendor: pickVendor(rows), lines: rows.length, statuses: rows.map((r) => r.status) });
    log(verbose, `  ${f.name}: text=${text.length}b → ${rows.length} row(s) → vendor "${pickVendor(rows)}"`);
  }

  // Write to invoice_code
  let write = null;
  if (!dryRun && allRows.length) write = await ingest.writeRows(brand, agent, allRows);

  // Move each file into its vendor folder (create-if-missing) — the n8n cleanup step
  const moved = [];
  if (doMove) {
    for (const pf of perFile) {
      try {
        const vf = await src.ensureFolder(pf.vendor, vendorParent);
        if (vf) { await src.moveFile(pf.id, vf, folderId); moved.push({ file: pf.name, vendor: pf.vendor, folderId: vf }); }
        log(verbose, `  moved ${pf.name} → "${pf.vendor}" (${vf})`);
      } catch (e) { log(verbose, `  move failed ${pf.name}: ${e.message}`); }
    }
  }

  return {
    brand: brand.name, agent: agent.name, variant, source: src.kind,
    folderFiles: files.length, alreadyProcessed: seen.size, ran: toRun.length,
    rowsProduced: allRows.length, perFile, write, moved,
    sampleRows: allRows.slice(0, 2),
  };
}

module.exports = { processBrand };

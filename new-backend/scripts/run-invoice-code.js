#!/usr/bin/env node
/**
 * run-invoice-code.js — CLI runner / end-to-end smoke test for the in-app
 * "Invoice code" engine (Phase 1a: Koparo).
 *
 * Usage (from new-backend/):
 *   node scripts/run-invoice-code.js --brand=Koparo --limit=1 --verbose        # process 1 file, write to invoice_code
 *   node scripts/run-invoice-code.js --brand=Koparo --file="<driveFileId>" --dry --verbose   # process one file, no DB write
 *
 * Flags: --brand=<name> (default Koparo) --limit=<n> --file=<id|name> --dry --verbose
 */
const { processBrand } = require('../src/services/invoiceEngine/orchestrator');

function arg(name, def) {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

(async () => {
  const opts = {
    brand: arg('brand', 'Koparo'),
    limit: parseInt(arg('limit', '0'), 10) || 0,
    file: arg('file', null),
    dryRun: !!arg('dry', false),
    verbose: !!arg('verbose', false),
  };
  console.log('[invoice-code] run options:', JSON.stringify(opts));
  try {
    const res = await processBrand(opts);
    console.log('\n===== RESULT =====');
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('\n[invoice-code] ERROR:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();

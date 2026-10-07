#!/usr/bin/env node
// One-time: upgrade a brand's PO Sheet from the original 8-column PO_Data layout
// to the 16-column master-data layout (poSheetLayout.js), and create the
// Vendor_Master / SKU_Master tabs the XLOOKUPs read.
//
//   node scripts/po-sheet-add-master-columns.js <spreadsheetId>            # dry run
//   node scripts/po-sheet-add-master-columns.js <spreadsheetId> --apply
//
// Columns are INSERTED (not overwritten), so existing rows keep their data
// under the right headers; their new columns stay blank (new runs only).
// Idempotent: does nothing if PO_Data already has the new header.
// Needs the Sheet shared with the service account as Editor + Sheets API enabled.

require('dotenv').config();
const drive = require('../src/services/driveService');
const { PO_SHEET_COLUMNS, VENDOR_TAB, SKU_TAB, VENDOR_HEADERS, SKU_HEADERS } =
  require('../src/controllers/agents/po-extract/poSheetLayout');

const OLD_HEADERS = [
  'PO number', 'Po date', 'Suppiler gtsn number', 'Buyer gstn number',
  'Billing address / Deliverd to', 'Product description/Item Description',
  'Basic Cost price/Unit Cost', 'GST rate',
];
const TAB = 'PO_Data';

(async () => {
  const [spreadsheetId, flag] = process.argv.slice(2);
  const apply = flag === '--apply';
  if (!spreadsheetId) { console.error('usage: node scripts/po-sheet-add-master-columns.js <spreadsheetId> [--apply]'); process.exit(1); }
  const sheets = drive.getSheets();

  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
  const tabs = (meta.data.sheets || []).map((s) => s.properties);
  const poTab = tabs.find((t) => t.title === TAB);
  if (!poTab) throw new Error(`No "${TAB}" tab in ${spreadsheetId}`);

  const hdr = ((await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!1:1` })).data.values || [[]])[0];
  const newHeaders = PO_SHEET_COLUMNS.map((c) => c.header);
  const trimmed = hdr.map((h) => String(h).trim());

  if (trimmed.includes('Vendor Name as per Tally')) {
    console.log(`${TAB} already has the new layout — columns untouched.`);
  } else {
    if (JSON.stringify(trimmed.slice(0, 8)) !== JSON.stringify(OLD_HEADERS)) {
      throw new Error(`${TAB} header is not the expected 8-column layout — aborting.\nFound: ${JSON.stringify(hdr)}`);
    }
    const ins = (start, n) => ({
      insertDimension: { range: { sheetId: poTab.sheetId, dimension: 'COLUMNS', startIndex: start, endIndex: start + n }, inheritFromBefore: false },
    });
    // Applied in order; indexes account for the earlier inserts.
    const requests = [
      ins(4, 1),  // E  Vendor Name as per Tally (after Buyer GSTIN)
      ins(7, 2),  // H,I Material Code, FG       (after Product description, now G)
      ins(11, 5), // L..P QTY, Taxable, IGST, CGST, SGST (after GST rate, now K)
    ];
    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: insert columns E, H-I, L-P in ${TAB}; header ->\n  ${newHeaders.join(' | ')}`);
    if (apply) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `${TAB}!A1:P1`, valueInputOption: 'RAW', requestBody: { values: [newHeaders] },
      });
    }
  }

  for (const [tab, headers] of [[VENDOR_TAB, VENDOR_HEADERS], [SKU_TAB, SKU_HEADERS]]) {
    if (tabs.some((t) => t.title === tab)) { console.log(`${tab} tab exists — left as is.`); continue; }
    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: create ${tab} tab with header ${headers.join(' | ')}`);
    if (apply) await drive.replaceTabValues(spreadsheetId, tab, [headers]);
  }
  console.log(apply ? 'Done.' : 'Dry run only — re-run with --apply.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

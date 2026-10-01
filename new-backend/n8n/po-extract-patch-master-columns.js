#!/usr/bin/env node
// Patches an exported "PO Extractor — <Brand>" n8n workflow (GET /api/v1/workflows/:id)
// for the master-data columns: Material Code + QTY extraction, the 16-column
// PO_Data append (XLOOKUP / tax formulas from poSheetLayout.js), and the feed body.
//
//   node po-extract-patch-master-columns.js <live.json> <out.json>
//
// Idempotent: re-running on an already-patched export produces the same output.
// Output keeps only the fields PUT /api/v1/workflows/:id accepts.

const fs = require('fs');
const path = require('path');
const { PO_SHEET_COLUMNS, SHEET_FORMULAS } = require(path.join(__dirname, '../src/controllers/agents/po-extract/poSheetLayout'));

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) { console.error('usage: node po-extract-patch-master-columns.js <live.json> <out.json>'); process.exit(1); }
const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const node = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`node "${name}" not found — workflow shape changed, patch by hand`);
  return n;
};

// 1) AI Agent prompt — two new per-line fields.
const agent = node('AI Agent');
let p = agent.parameters.text;
if (!p.includes('"material_code"')) {
  p = p.replace('  "product_description": "",\n', '  "product_description": "",\n  "material_code": "",\n');
  p = p.replace('  "gst_rate": 0\n}', '  "gst_rate": 0,\n  "qty": 0\n}');
  p = p.replace('\nROW FILTERING', [
    '',
    '• material_code = the buyer\'s product code printed on that line, as TEXT exactly as printed',
    '  (keep leading zeros). Column label varies by buyer — use, in this priority order:',
    '  "Material Code" > "SKU Code" > "Item Code" > "Article Code" > "Product Code".',
    '  If BOTH "Material Code" and "SKU Code" columns exist, use Material Code.',
    '  NEVER the HSN code, EAN, UPC or barcode. If none is printed, use "".',
    '• qty = the ordered quantity for that line (\"Qty\" / \"Quantity\" / \"Order Qty\") as a plain number.',
    '  NEVER the MRP, a pack size from the description (e.g. "2 L", "1 pc") or the total quantity row.',
    '',
    'ROW FILTERING',
  ].join('\n'));
  if (!p.includes('"material_code"') || !p.includes('"qty"') || !p.includes('material_code = ')) {
    throw new Error('AI Agent prompt anchors not found — patch the prompt by hand');
  }
  agent.parameters.text = p;
}

// 2) Parser Code node — pass the new fields through.
const code = node('Code in JavaScript');
let js = code.parameters.jsCode;
if (!js.includes('material_code')) {
  js = js.replace(
    "  gst_rate: num(it.gst_rate),\n  status:",
    "  gst_rate: num(it.gst_rate),\n  material_code: s(it.material_code),\n  qty: (it.qty == null || it.qty === '') ? null : num(it.qty),\n  status:");
  js = js.replace(
    "product_description: 'Unable to read PO', unit_cost: 0, gst_rate: 0, status: 'Not a PO',",
    "product_description: 'Unable to read PO', unit_cost: 0, gst_rate: 0, material_code: '', qty: null, status: 'Not a PO',");
  if (!js.includes('material_code: s(it.material_code)') || !js.includes("material_code: '', qty: null")) throw new Error('Code node anchors not found — patch by hand');
  code.parameters.jsCode = js;
}

// 3) PO_Data append — 16 columns by header name; formulas need USER_ENTERED.
const append = node('Append row in sheet');
const schemaCol = (id) => ({
  id, displayName: id, required: false, defaultMatch: false, display: true,
  type: 'string', canBeUsedToMatch: true, removed: false,
});
const exprFor = (key) => {
  // n8n reads a leading "=" as "this is an expression" and strips it, so a
  // formula needs a second "=" to reach the Sheet as "=IFERROR(...)".
  if (SHEET_FORMULAS[key]) return `=${SHEET_FORMULAS[key]}`;
  // Codes as text (leading apostrophe) so USER_ENTERED keeps leading zeros.
  if (key === 'material_code') return "={{ $json.material_code ? \"'\" + $json.material_code : '' }}";
  if (key === 'qty') return "={{ $json.qty == null ? '' : $json.qty }}";
  return `={{ $json.${key} }}`;
};
append.parameters.columns.value = Object.fromEntries(PO_SHEET_COLUMNS.map((c) => [c.header, exprFor(c.key)]));
append.parameters.columns.schema = PO_SHEET_COLUMNS.map((c) => schemaCol(c.header));
append.parameters.options = { ...(append.parameters.options || {}), cellFormat: 'USER_ENTERED' };

// 4) Feed to backend — build the body with JSON.stringify (quotes in a description
//    or an empty qty used to produce invalid JSON with the old string template).
const feed = node('HTTP Request');
feed.parameters.jsonBody = '={{ JSON.stringify({\n' +
  '  agentId: $json.agentId, brandId: $json.brandId, batch_total: $json.batch_total, run_id: $json.run_id,\n' +
  '  processed_invoices: [{\n' +
  '    source_file: $json.source_file, po_pdf_link: $json.po_pdf_link, po_number: $json.po_number,\n' +
  '    po_date: $json.po_date, supplier_gstin: $json.supplier_gstin, buyer_gstin: $json.buyer_gstin,\n' +
  '    billing_address: $json.billing_address, product_description: $json.product_description,\n' +
  '    material_code: $json.material_code, unit_cost: $json.unit_cost, gst_rate: $json.gst_rate,\n' +
  '    qty: $json.qty, status: $json.status\n' +
  '  }]\n' +
  '}) }}';

const out = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || {} };
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`patched -> ${outFile}`);

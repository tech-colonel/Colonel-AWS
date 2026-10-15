#!/usr/bin/env node
// Patches an exported "PO Extractor — <Brand>" n8n workflow (GET /api/v1/workflows/:id)
// so a MERGED PDF (many POs in one file) is split into one AI call per PO.
//
// Why: the whole PDF text used to go to Gemini in ONE call. A 121-page / 22-PO file
// (147k prompt tokens, mostly repeated Terms & Conditions) came back with only 18 POs,
// and a different 3-4 were dropped on every run. Nothing checked the count.
//
//   Extract from File → [Split POs] → AI Agent → Code in JavaScript
//
//   • Split POs          — one item per PO (grouped by the PO number printed on each
//                          page), trailing Terms & Conditions pages dropped.
//   • AI Agent           — unchanged prompt; now ~1 page per call. Retries on error.
//   • Code in JavaScript — handles N items; a PO that was detected in the PDF but
//                          came back with no line items is written as a
//                          "Needs Review" row instead of vanishing.
//
//   node po-extract-patch-split-pos.js <live.json> <out.json>
//
// Idempotent: re-running on an already-patched export produces the same output.
// Output keeps only the fields PUT /api/v1/workflows/:id accepts.

const fs = require('fs');

// ── "Split POs" Code node ────────────────────────────────────────────────────
const SPLIT_CODE = String.raw`// One item per Purchase Order. A merged PDF holds many POs; sending the whole
// text to the model in one call makes it skip POs, so each PO goes on its own.
const src = $input.first().json;
const raw = src.text;
// "Extract from File" joins pages with a blank line (or returns an array when
// Join Pages is off) — a page's own text never contains a blank line.
const pages = (Array.isArray(raw) ? raw : String(raw || '').split('\n\n'))
  .map((p) => String(p || ''))
  .filter((p) => p.trim());

// PO number as labelled on the page: "PO No", "P.O. Number", "Purchase Order No", "Order No" …
const PO_RE = /(?:\bP\.?\s?O\.?|\bPurchase\s+Order|\bOrder)\s*(?:No|Number|Num|#)\s*\.?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\/_\-]{3,})/gi;
const poOf = (page) => {
  PO_RE.lastIndex = 0;
  let m;
  while ((m = PO_RE.exec(page)) !== null) {
    const v = m[1].replace(/[\/_\-]+$/, '');
    if (/\d/.test(v) && v.length >= 4) return v.toUpperCase();
  }
  return '';
};
const TITLE_RE = /^\s*purchase\s+order\b/i;
const TC_RE = /^\s*(?:general\s+)?terms\s*(?:and|&)\s*conditions\b|^\s*annexure\b/i;

// Group pages: a new PO starts on a page whose PO number differs from the current one.
// Pages with no PO number (continuation, totals, T&C) stay with the current PO.
let chunks = [];
let cur = null;
let lead = [];
for (const page of pages) {
  const po = poOf(page);
  if (po && (!cur || po !== cur.po)) {
    cur = { po, pages: lead };
    lead = [];
    chunks.push(cur);
  }
  if (cur) cur.pages.push(page); else lead.push(page);
}

// No labelled PO number anywhere: fall back to pages that open with a "Purchase Order" title.
if (!chunks.length) {
  const starts = pages.map((p, i) => (TITLE_RE.test(p) ? i : -1)).filter((i) => i >= 0);
  if (starts.length >= 2) {
    chunks = starts.map((s, k) => ({ po: '', pages: pages.slice(k === 0 ? 0 : s, starts[k + 1] === undefined ? pages.length : starts[k + 1]) }));
  } else {
    chunks = [{ po: '', pages }];
  }
}

// Drop the Terms & Conditions / annexure tail of each PO (never its first page).
for (const c of chunks) {
  const cut = c.pages.findIndex((p, i) => i > 0 && TC_RE.test(p.slice(0, 200)));
  if (cut > 0) c.pages = c.pages.slice(0, cut);
}

const expected = chunks.map((c) => c.po).filter(Boolean);
return chunks.map((c, i) => ({
  json: {
    text: c.pages.join('\n\n'),
    expected_po: c.po,
    po_index: i + 1,
    po_total: chunks.length,
    expected_pos: expected,
  },
  pairedItem: { item: 0 },
}));`;

// ── "Code in JavaScript" (parser) ────────────────────────────────────────────
const PARSE_CODE = String.raw`// One input item per PO (see "Split POs"); an image file arrives as a single item.
const cfg = $('Code in JavaScript1').first().json;
const items = $input.all();

const fileOf = (i) => {
  try { const f = $('Code in JavaScript1').itemMatching(i).json; if (f && f.name) return f; } catch (e) {}
  try { const f = $('Code in JavaScript1').item.json; if (f && f.name) return f; } catch (e) {}
  try { return $('Download file').first().json; } catch (e) {}
  return {};
};
// What "Split POs" detected for this item (null on the image path, which skips it).
const splitOf = (i) => {
  try { return $('Split POs').itemMatching(i).json; } catch (e) { return null; }
};

function parseJson(v) {
  if (typeof v !== 'string') return v;
  let t = v.trim().replace(/^` + '```' + String.raw`(?:json)?\s*/i, '').replace(/\s*` + '```' + String.raw`$/i, '');
  try { return JSON.parse(t); } catch (e) {}
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s !== -1 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch (e2) {} }
  const os = t.indexOf('{'), oe = t.lastIndexOf('}');
  if (os !== -1 && oe > os) { try { return [JSON.parse(t.slice(os, oe + 1))]; } catch (e3) {} }
  return null;
}

const s = (v) => (v == null) ? '' : String(v).replace(/<br\s*\/?\s*>/gi, ' ').replace(/\s+/g, ' ').trim();
const num = (v) => { if (v == null || v === '') return 0; const n = parseFloat(String(v).replace(/[,\s₹]/g, '')); return Number.isFinite(n) ? n : 0; };

const output = [];
items.forEach((item, i) => {
  const file = fileOf(i);
  const split = splitOf(i);
  const expectedPo = split ? s(split.expected_po) : '';
  const base = {
    run_id: $execution.id,
    batch_total: $('Code in JavaScript1').all().length,
    brandId: cfg.brandId, brandName: cfg.brandName,
    agentId: cfg.agentId, agentName: cfg.agentName,
    source_file: s(file.name),
    po_pdf_link: s(file.webViewLink),
  };

  const agentResp = item.json;
  const raw = agentResp.output !== undefined ? agentResp.output : agentResp;
  let arr = parseJson(raw);
  if (!arr) arr = [];
  if (!Array.isArray(arr)) arr = [arr];

  for (const it of arr) {
    // The PO number printed on the page wins when the model left it blank.
    const poNumber = s(it.po_number) || expectedPo;
    output.push({ json: {
      ...base,
      po_number: poNumber,
      po_date: s(it.po_date),
      supplier_gstin: s(it.supplier_gstin),
      buyer_gstin: s(it.buyer_gstin),
      billing_address: s(it.billing_address),
      product_description: s(it.product_description),
      unit_cost: num(it.unit_cost),
      gst_rate: num(it.gst_rate),
      material_code: s(it.material_code),
      qty: (it.qty == null || it.qty === '') ? null : num(it.qty),
      status: (poNumber && s(it.product_description)) ? 'Extracted' : 'Needs Review',
    }, pairedItem: { item: i } });
  }

  if (!arr.length) {
    // A PO that was found in the PDF must never disappear silently: surface it for review.
    const partOfMany = !!(split && split.po_total > 1);
    const known = expectedPo || partOfMany;
    output.push({ json: {
      ...base,
      po_number: expectedPo, po_date: '', supplier_gstin: '', buyer_gstin: '', billing_address: '',
      product_description: known
        ? 'PO found in PDF but no line items were extracted (PO ' + split.po_index + ' of ' + split.po_total + ') - check the PDF'
        : 'Unable to read PO',
      unit_cost: 0, gst_rate: 0, material_code: '', qty: null,
      status: known ? 'Needs Review' : 'Not a PO',
    }, pairedItem: { item: i } });
  }
});

return output;`;

module.exports = { SPLIT_CODE, PARSE_CODE };
if (require.main !== module) return;

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) { console.error('usage: node po-extract-patch-split-pos.js <live.json> <out.json>'); process.exit(1); }
const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const node = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`node "${name}" not found — workflow shape changed, patch by hand`);
  return n;
};

const extract = node('Extract from File');
const agent = node('AI Agent');
const parser = node('Code in JavaScript');
if (!parser.parameters.jsCode.includes('material_code')) {
  throw new Error('run po-extract-patch-master-columns.js first — parser has no material_code');
}

// 1) Split POs node between "Extract from File" and "AI Agent".
let split = wf.nodes.find((x) => x.name === 'Split POs');
if (!split) {
  split = {
    parameters: {},
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [extract.position[0] + 120, extract.position[1] - 170],
    id: 'b7c1f0de-3a52-4c1e-9d0a-5e2f4a7c9b31',
    name: 'Split POs',
  };
  wf.nodes.push(split);
}
split.parameters.jsCode = SPLIT_CODE;
wf.connections['Extract from File'] = { main: [[{ node: 'Split POs', type: 'main', index: 0 }]] };
wf.connections['Split POs'] = { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] };

// 2) One call per PO means more calls per file — retry a transient model error
//    instead of failing the whole file.
agent.retryOnFail = true;
agent.maxTries = 3;
agent.waitBetweenTries = 5000;

// 3) Parser handles one item per PO and flags a PO that came back empty.
parser.parameters.jsCode = PARSE_CODE;

const out = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || {} };
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`patched -> ${outFile}`);

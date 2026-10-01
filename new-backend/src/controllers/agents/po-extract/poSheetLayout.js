// PO_Data sheet layout — the ONE place the 16 output columns are defined.
// The n8n workflow's "Build Rows" node writes the same layout (its code carries a
// copy of SHEET_FORMULAS — keep both in step if a column moves).
//
// Derived columns are written as live Sheet formulas (XLOOKUP into the
// Vendor_Master / SKU_Master tabs, tax maths off the same row), so correcting a
// master row or a QTY in the Sheet recalculates on its own. Every formula reads
// its own row via INDEX(col, ROW()), so it is position-independent: the same
// string works on any row, whether appended by n8n or rewritten by an app edit.

const VENDOR_TAB = 'Vendor_Master';
const SKU_TAB = 'SKU_Master';
const VENDOR_HEADERS = ['Buyer GSTIN', 'Vendor Name as per Tally'];
const SKU_HEADERS = ['Material Code / SKU Code', 'FG (Tally Item Name)'];

// key = po_extractor column (or a formula placeholder), header = Sheet header.
const PO_SHEET_COLUMNS = [
  { key: 'po_number',           header: 'PO number' },                            // A
  { key: 'po_date',             header: 'Po date' },                              // B
  { key: 'supplier_gstin',      header: 'Suppiler gtsn number' },                 // C
  { key: 'buyer_gstin',         header: 'Buyer gstn number' },                    // D
  { key: '=vendor_name_tally',  header: 'Vendor Name as per Tally' },             // E
  { key: 'billing_address',     header: 'Billing address / Deliverd to' },        // F
  { key: 'product_description', header: 'Product description/Item Description' }, // G
  { key: 'material_code',       header: 'Material Code / SKU Code' },             // H
  { key: '=fg',                 header: 'FG' },                                   // I
  { key: 'unit_cost',           header: 'Basic Cost price/Unit Cost' },           // J
  { key: 'gst_rate',            header: 'GST rate' },                             // K
  { key: 'qty',                 header: 'QTY' },                                  // L
  { key: '=taxable_value',      header: 'Taxable' },                              // M
  { key: '=igst',               header: 'IGST' },                                 // N
  { key: '=cgst',               header: 'CGST' },                                 // O
  { key: '=sgst',               header: 'SGST' },                                 // P
];

const c = (L) => `INDEX($${L}:$${L},ROW())`;
// Same state = first 2 chars of Supplier GSTIN (C) and Buyer GSTIN (D) match.
const SAME_STATE = `LEFT(${c('C')},2)=LEFT(${c('D')},2)`;
const NO_STATE = `OR(LEN(${c('C')})<2,LEN(${c('D')})<2,${c('M')}="")`;
const SHEET_FORMULAS = {
  '=vendor_name_tally': `=IFERROR(XLOOKUP(UPPER(TRIM(${c('D')})),ARRAYFORMULA(UPPER(TRIM(${VENDOR_TAB}!$A$2:$A))),${VENDOR_TAB}!$B$2:$B,""),"")`,
  '=fg':                `=IFERROR(XLOOKUP(UPPER(TRIM(TO_TEXT(${c('H')}))),ARRAYFORMULA(UPPER(TRIM(TO_TEXT(${SKU_TAB}!$A$2:$A)))),${SKU_TAB}!$B$2:$B,""),"")`,
  '=taxable_value':     `=IF(OR(${c('J')}="",${c('L')}=""),"",ROUND(${c('J')}*${c('L')},2))`,
  '=igst':              `=IF(${NO_STATE},"",IF(${SAME_STATE},0,ROUND(${c('M')}*${c('K')}/100,2)))`,
  '=cgst':              `=IF(${NO_STATE},"",IF(${SAME_STATE},ROUND(${c('M')}*${c('K')}/200,2),0))`,
  '=sgst':              `=IF(${NO_STATE},"",IF(${SAME_STATE},ROUND(${c('M')}*${c('K')}/200,2),0))`,
};

// Codes are written with a leading apostrophe so USER_ENTERED keeps them as
// text (no lost leading zeros, no 1.97E+07 on long numeric codes).
const asText = (v) => (v === null || v === undefined || v === '' ? '' : `'${v}`);

/** One PO_Data row (array, A..P) for a po_extractor record. Write USER_ENTERED. */
function sheetRowFor(r) {
  return PO_SHEET_COLUMNS.map(({ key }) => {
    if (SHEET_FORMULAS[key]) return SHEET_FORMULAS[key];
    const v = r[key];
    if (key === 'material_code') return asText(v);
    return v === null || v === undefined ? '' : v;
  });
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * DB-side twin of the Sheet's tax formulas.
 * Taxable = Unit cost × QTY. Same state → CGST = SGST = Taxable × (GST%/2)/100,
 * IGST 0; different state → IGST = Taxable × GST%/100, CGST/SGST 0. Anything the
 * inputs can't decide stays null (never guessed).
 */
function computeTaxes({ unit_cost, qty, gst_rate, supplier_gstin, buyer_gstin }) {
  const cost = numOrNull(unit_cost), q = numOrNull(qty), rate = numOrNull(gst_rate);
  const out = { taxable_value: null, igst: null, cgst: null, sgst: null };
  if (cost === null || q === null) return out;
  out.taxable_value = round2(cost * q);
  const sg = String(supplier_gstin || '').trim(), bg = String(buyer_gstin || '').trim();
  if (rate === null || sg.length < 2 || bg.length < 2) return out;
  if (sg.slice(0, 2) === bg.slice(0, 2)) {
    const half = round2(out.taxable_value * rate / 200);
    Object.assign(out, { igst: 0, cgst: half, sgst: half });
  } else {
    Object.assign(out, { igst: round2(out.taxable_value * rate / 100), cgst: 0, sgst: 0 });
  }
  return out;
}

// 0-based column indexes used to find an existing row in the Sheet.
const colIdx = (key) => PO_SHEET_COLUMNS.findIndex((col) => col.key === key);

module.exports = {
  PO_SHEET_COLUMNS, SHEET_FORMULAS, VENDOR_TAB, SKU_TAB, VENDOR_HEADERS, SKU_HEADERS,
  sheetRowFor, computeTaxes, colIdx,
};

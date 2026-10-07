const XLSX = require('xlsx');

// ─── X2Beta sheet template (workflow engine) ──────────────────────────────────
// Lays a workflow sheet's rows out in the Tally "X2Beta" import template — the
// same column layout the Sales-Amazon agent writes as "x2beta working"
// (amazonB2CProcessor.js STEP 10). A workflow sheet opts in with
// `outputTemplate: 'x2beta'`; its own columns then only have to produce the
// values, labelled with the template header they feed (e.g. "Party Ledger*").
//
// The template can't be expressed as ordinary workflow columns: it repeats
// headers (Discount, Name, State, Date …), has two header-less columns, and its
// Output IGST/CGST/SGST columns depend on which GST rates the run contains.

// `key` = the row label a column reads; columns without one are always blank.
const col = (header, key) => ({ header, key });
const blank = (...headers) => headers.map(h => col(h));

const HEAD_COLUMNS = [
  col('Vch. Date* ', 'Vch. Date*'), col('Vch. Type*', 'Vch. Type*'), col('Vch. No.*', 'Vch. No.*'),
  col('Ref. No.', 'Ref. No.'), col('Ref. Date', 'Ref. Date'), col('Is CN?', 'Is CN?'), col('Is Vch?'),
  col('Party Ledger*', 'Party Ledger*'), col('Sales Ledger*', 'Sales Ledger*'),
  col('Stock Item', 'Stock Item'), col('Description', 'Description'), col('Godown', 'Godown'),
  col('Quantity', 'Quantity'), col('Rate', 'Rate'), col('Unit', 'Unit'),
  col('Discount'), col('Amount*', 'Amount*'), col('Discount')
];

const TAIL_COLUMNS = [
  col(null), col(null),
  col('Narration', 'Narration'),
  ...blank('Taxability', 'GST Nature', 'GST Rate', 'Cess', 'RCM?'),
  col('HSN', 'HSN'),
  ...blank('HSN Desc', 'Supply Type', 'Cost Category', 'Cost Centre'),
  // Party / consignee / buyer blocks — only State and Country are filled, as in the Amazon sheet.
  ...blank('Name', 'Address 1', 'Address 2'), col('State', 'State'), col('Country', 'Country'), col('PIN Code'),
  col('Place of Supply', 'Place of Supply'), col('GST Type', 'GST Type'), col('GSTIN'),
  ...blank('Name', 'Address 1', 'Address 2'), col('State', 'State'), col('Country', 'Country'), col('PIN Code'),
  ...blank('Place', 'GSTIN'),
  ...blank('Name', 'Address 1', 'Address 2'), col('State', 'State'), col('Country', 'Country'), col('PIN Code'),
  ...blank('Place', 'GSTIN'),
  // Dispatch / e-way-bill / transport fields — not used.
  ...blank(
    'DN No.', 'DN Date', 'Doc. No.', 'Dis. Through', 'Destination', 'Carrier Name', 'LR No.', 'LR Date',
    'Order No.', 'Order Date', 'Term of Delivery', 'Terms of Paymemt', 'Other Ref.', 'Place of Receipt',
    'Vessel/Flight No.', 'Port of Loading', 'Port of Discharge', 'Country to', 'Shipping Bill No.', 'Date',
    'Port Code', 'e-Way Bill No', 'Date', 'Cons. e-Way Bill No.', 'Date', 'Sub Type', 'Doc. Type',
    'Distance (KM)', 'Transporter Name', 'Transporter ID', 'Transport Mode', 'Doc No.', 'Date',
    'Vehicle No.', 'Vehicle Type', 'Status', 'Note Reason', 'Orig. Inv. No.', 'Orig. Inv. Date'
  )
];

// Row labels that feed the rate-wise Output tax columns; a sheet can rename them via `x2beta`.
const DEFAULT_TAX_FIELDS = {
  rateColumn: 'Tax Rate',
  stateCodeColumn: 'Seller State Code',
  igstColumn: 'IGST',
  cgstColumn: 'CGST',
  sgstColumn: 'SGST'
};

const DATE_FORMAT = 'dd/mm/yyyy';

const toNum = v => {
  const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
};
const round2 = n => Math.round(n * 100) / 100;

// Excel date serial from the Date's own calendar day, so the cell shows the same
// date whatever timezone the server runs in.
const toExcelSerial = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5 + 25569;

function buildX2betaSheet(rows, config = {}) {
  const f = { ...DEFAULT_TAX_FIELDS, ...config };
  const rateOf  = row => round2(toNum(row[f.rateColumn]));
  const stateOf = row => String(row[f.stateCodeColumn] ?? '').trim();

  // One IGST/CGST/SGST triplet per (rate, seller state) present in this run.
  const rates  = [...new Set(rows.map(rateOf))].filter(r => r > 0).sort((a, b) => a - b);
  const states = [...new Set(rows.map(stateOf))].filter(Boolean).sort();
  const taxColumns = [];
  for (const rate of rates) {
    const half = round2(rate / 2);
    for (const sc of states) {
      const amount = field => row => (rateOf(row) === rate && stateOf(row) === sc ? toNum(row[field]) : 0);
      taxColumns.push(
        { header: `Output IGST ${rate}%-${sc}`, get: amount(f.igstColumn) },
        { header: `Output CGST ${half}%-${sc}`, get: amount(f.cgstColumn) },
        { header: `Output SGST ${half}%-${sc}`, get: amount(f.sgstColumn) }
      );
    }
  }

  const fromRow = c => ({
    header: c.header,
    get: row => {
      const v = c.key ? row[c.key] : null;
      return v === undefined || v === '' ? null : v;
    }
  });
  const columns = [...HEAD_COLUMNS.map(fromRow), ...taxColumns, ...TAIL_COLUMNS.map(fromRow)];

  const sheet = XLSX.utils.aoa_to_sheet([columns.map(c => c.header)]);
  rows.forEach((row, r) => {
    columns.forEach((c, cIdx) => {
      const v = c.get(row);
      if (v === null) return;
      const addr = XLSX.utils.encode_cell({ r: r + 1, c: cIdx });
      if (v instanceof Date) sheet[addr] = { t: 'n', v: toExcelSerial(v), z: DATE_FORMAT };
      else if (typeof v === 'number') sheet[addr] = { t: 'n', v };
      else sheet[addr] = { t: 's', v: String(v) };
    });
  });
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: columns.length - 1 } });
  return sheet;
}

module.exports = { buildX2betaSheet };

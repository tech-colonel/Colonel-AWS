/**
 * mtrProcessor.js
 *
 * Amazon MTR Consolidator engine.
 *
 * Walks every vendor subfolder of a Reseller Data Drive folder, finds the
 * monthly B2C / B2B report ZIPs, unzips the CSV inside each, prepends a
 * "Vendor Name" (from the folder) and "Month" (from the filename) column,
 * and streams every row into ONE workbook:
 *    - B2C sheet  (all vendors, all months)
 *    - B2B sheet  (all vendors, all months)
 *    - Log sheet  (per vendor x month x type: rows / skipped / errors)
 *
 * Rows land in Vendor (A->Z) -> Month (chronological) order because we process
 * vendors alphabetically and sort each vendor's files by month before writing.
 *
 * Memory: rows are committed to disk per-row via exceljs streaming WorkbookWriter,
 * so a 300k-row run never holds the whole dataset in RAM (matters on the 2 GB EC2 box).
 *
 * Auto-split: if a type ever exceeds Excel's ~1,048,575 data-row cap, that type
 * spills into month-wise tabs (B2C_April_2026 ...). Default stays a single sheet.
 */

const AdmZip = require('adm-zip');
const ExcelJS = require('exceljs');
const drive = require('./driveService');

const EXCEL_MAX_DATA_ROWS = 1048575; // 1,048,576 incl. header

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Columns whose values must stay TEXT (ids, codes) — never coerce to Number,
// or we lose leading zeros / hit scientific-notation on long ids.
const KEEP_TEXT_RE =
  /gstin|gstid|invoice number|order id|shipment id|shipment item id|asin|\bsku\b|hsn|postal|warehouse|credit note no|irn|payment method|product tax code|invoice date|shipment date|order date|credit note date/i;

/* ─── filename parsing ─────────────────────────────────────────────────────── */

/** `b2cReport_April_2026.zip` -> { dtype:'B2C', monthIdx:4, year:2026, monthLabel:'April 2026', sortKey } */
function parseReportName(name) {
  const m = name.match(/b2(c|b)report[_\- ]+([a-z]+)[_\- ]+(\d{4})/i);
  if (!m) return null;
  const dtype = m[1].toLowerCase() === 'c' ? 'B2C' : 'B2B';
  const monthIdx = MONTHS[m[2].toLowerCase()];
  if (!monthIdx) return null;
  const year = parseInt(m[3], 10);
  const monthName = m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
  return {
    dtype,
    monthIdx,
    year,
    monthLabel: `${monthName} ${year}`,
    monthToken: `${monthName}_${year}`,
    sortKey: year * 100 + monthIdx,
  };
}

/* ─── CSV parsing (quote-safe, dependency-free) ────────────────────────────── */

/** Robust CSV -> array-of-arrays. Handles quoted commas, "" escapes, CRLF/LF. */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true; sawAny = true;
    } else if (c === ',') {
      row.push(field); field = ''; sawAny = true;
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; sawAny = false;
    } else if (c === '\r') {
      // ignore; newline handled on \n
    } else {
      field += c; sawAny = true;
    }
  }
  if (sawAny || field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Coerce a raw string cell to Number when safe, else keep as text. */
function cellValue(header, raw) {
  if (raw === null || raw === undefined) return '';
  const s = String(raw).trim();
  if (s === '') return '';
  if (KEEP_TEXT_RE.test(header)) return s;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    if (s.length > 1 && s[0] === '0' && s[1] !== '.') return s;        // leading zero -> keep text
    if (s.replace(/[-.]/g, '').length > 15) return s;                  // precision risk -> keep text
    return Number(s);
  }
  return s;
}

/* ─── extracting rows from a downloaded file ───────────────────────────────── */

/** From a ZIP buffer, return { header:[], rows:[[...]] } of the CSV inside. */
function readZipCsv(buf) {
  const zip = new AdmZip(buf);
  const entry =
    zip.getEntries().find((e) => /\.csv$/i.test(e.entryName)) ||
    zip.getEntries().find((e) => /\.txt$/i.test(e.entryName)) ||
    zip.getEntries()[0];
  if (!entry) return { header: [], rows: [] };
  const all = parseCsv(entry.getData().toString('utf8'));
  return { header: all[0] || [], rows: all.slice(1) };
}

/** From a raw CSV buffer. */
function readCsvBuffer(buf) {
  const all = parseCsv(buf.toString('utf8'));
  return { header: all[0] || [], rows: all.slice(1) };
}

/* ─── streaming sheet wrapper (handles lazy header + overflow split) ────────── */

class TypeSheet {
  constructor(wb, dtype, ws) {
    this.wb = wb;
    this.dtype = dtype;           // 'B2C' | 'B2B'
    this.ws = ws;                 // pre-created primary worksheet (fixes tab order)
    this.canonHeader = null;      // includes Vendor Name, Month
    this.nameIndex = null;        // original-header name -> col index
    this.dataRowsInSheet = 0;
    this.totalRows = 0;
    this.split = false;           // became true once we overflow
    this.headerWritten = false;
  }

  _writeHeader() {
    const hdr = this.ws.addRow(this.canonHeader);
    hdr.font = { bold: true };
    hdr.commit();
    this.dataRowsInSheet = 0;
    this.headerWritten = true;
  }

  /** Initialise canonical header from the first file's header of this type. */
  _initHeader(fileHeader) {
    this.canonHeader = ['Vendor Name', 'Month', ...fileHeader.map((h) => String(h).trim())];
    this.nameIndex = {};
    fileHeader.forEach((h, i) => { this.nameIndex[String(h).trim()] = i; });
    this._writeHeader();
  }

  /** Write all rows of one parsed file, tagged with vendor + month. */
  addFile(vendor, monthLabel, monthToken, fileHeader, rows) {
    if (!this.canonHeader) this._initHeader(fileHeader);

    // Map this file's columns onto the canonical order (Amazon schema is uniform,
    // but guard against the odd reordered/short export).
    const sameOrder =
      fileHeader.length === this.canonHeader.length - 2 &&
      fileHeader.every((h, i) => String(h).trim() === this.canonHeader[i + 2]);

    let written = 0;
    for (const r of rows) {
      if (!r || r.every((c) => String(c).trim() === '')) continue; // skip blank lines

      let dataCells;
      if (sameOrder) {
        dataCells = this.canonHeader.slice(2).map((h, i) => cellValue(h, r[i]));
      } else {
        dataCells = this.canonHeader.slice(2).map((h) => {
          const idx = this.nameIndex[h];
          return idx === undefined ? '' : cellValue(h, r[idx]);
        });
      }

      // Overflow -> spill into month-wise tabs from here on.
      if (this.dataRowsInSheet >= EXCEL_MAX_DATA_ROWS) {
        this.split = true;
        this.ws.commit();
        this.ws = this.wb.addWorksheet(`${this.dtype}_${monthToken}`, { views: [{ state: 'frozen', ySplit: 1 }] });
        this._writeHeader();
      }

      this.ws.addRow([vendor, monthLabel, ...dataCells]).commit();
      this.dataRowsInSheet++;
      this.totalRows++;
      written++;
    }
    return written;
  }

  /** Write a header/placeholder if no data was ever added, then commit. */
  finalize(emptyNote) {
    if (!this.headerWritten) {
      this.canonHeader = ['Vendor Name', 'Month'];
      this._writeHeader();
      this.ws.addRow([emptyNote || 'No data found', '']).commit();
    }
    this.ws.commit();
  }
}

/* ─── main entry ───────────────────────────────────────────────────────────── */

/**
 * Consolidate all MTR reports under `folderId` into the workbook at `outPath`.
 * @param {object} opts
 * @param {string} opts.folderId   Drive folder id (Reseller Data root)
 * @param {string} opts.outPath    absolute path to write the .xlsx
 * @param {(evt:object)=>void} [opts.emit]  progress callback
 * @returns {Promise<object>} summary
 */
async function consolidate({ folderId, outPath, emit = () => {} }) {
  const log = [];
  const logEntry = (vendor, month, dtype, status, detail = '') => {
    log.push({ vendor, month, dtype, status, detail });
  };

  const rootMeta = await drive.getMeta(folderId, 'id,name');
  const vendors = await drive.listSubfolders(folderId);
  emit({ type: 'start', folderName: rootMeta.name, vendors: vendors.length });

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: outPath, useStyles: true });
  // Pre-create worksheets so tab order is deterministic: B2C, then B2B, then Log.
  const b2cWs = wb.addWorksheet('B2C', { views: [{ state: 'frozen', ySplit: 1 }] });
  const b2bWs = wb.addWorksheet('B2B', { views: [{ state: 'frozen', ySplit: 1 }] });
  const b2c = new TypeSheet(wb, 'B2C', b2cWs);
  const b2b = new TypeSheet(wb, 'B2B', b2bWs);

  let vendorsWithData = 0;
  let vendorsSkipped = 0;
  let filesProcessed = 0;

  for (let vi = 0; vi < vendors.length; vi++) {
    const vendor = vendors[vi];
    emit({ type: 'vendor', name: vendor.name, index: vi + 1, total: vendors.length });

    let children;
    try {
      children = await drive.listChildren(vendor.id);
    } catch (e) {
      vendorsSkipped++;
      logEntry(vendor.name, '', '', 'error', `Could not list folder: ${e.message}`);
      emit({ type: 'error', vendor: vendor.name, message: `Could not read folder: ${e.message}` });
      continue;
    }

    // Match report files; sort chronologically so the sheet stays month-ordered.
    const matched = [];
    const unmatched = [];
    for (const f of children) {
      if (f.mimeType === drive.FOLDER_MIME) continue;
      const meta = parseReportName(f.name);
      if (meta && /\.(zip|csv)$/i.test(f.name)) matched.push({ file: f, meta });
      else unmatched.push(f);
    }
    matched.sort((a, b) =>
      a.meta.dtype.localeCompare(b.meta.dtype) || a.meta.sortKey - b.meta.sortKey
    );

    if (matched.length === 0 && children.length === 0) {
      vendorsSkipped++;
      logEntry(vendor.name, '', '', 'skipped', 'Empty folder');
      emit({ type: 'skip', vendor: vendor.name, reason: 'empty folder' });
      continue;
    }
    if (matched.length === 0) {
      vendorsSkipped++;
      const why = unmatched.length ? `no MTR report files (${unmatched.length} other file(s))` : 'no data';
      logEntry(vendor.name, '', '', 'skipped', why);
      emit({ type: 'skip', vendor: vendor.name, reason: why });
      continue;
    }

    let vendorRows = 0;
    for (const { file, meta } of matched) {
      try {
        const buf = await drive.downloadFile(file.id);
        const parsed = /\.zip$/i.test(file.name) ? readZipCsv(buf) : readCsvBuffer(buf);
        if (!parsed.header.length || parsed.rows.length === 0) {
          logEntry(vendor.name, meta.monthLabel, meta.dtype, 'skipped', 'empty report');
          emit({ type: 'file', vendor: vendor.name, month: meta.monthLabel, dtype: meta.dtype, rows: 0, note: 'empty' });
          continue;
        }
        const sheet = meta.dtype === 'B2C' ? b2c : b2b;
        const n = sheet.addFile(vendor.name, meta.monthLabel, meta.monthToken, parsed.header, parsed.rows);
        filesProcessed++;
        vendorRows += n;
        logEntry(vendor.name, meta.monthLabel, meta.dtype, 'ok', `${n} rows`);
        emit({ type: 'file', vendor: vendor.name, month: meta.monthLabel, dtype: meta.dtype, rows: n });
      } catch (e) {
        logEntry(vendor.name, meta.monthLabel, meta.dtype, 'error', e.message);
        emit({ type: 'error', vendor: vendor.name, file: file.name, message: e.message });
      }
    }
    if (vendorRows > 0) vendorsWithData++;
  }

  // Finalise data sheets.
  b2c.finalize('No B2C data found');
  b2b.finalize('No B2B data found');

  // Log sheet.
  const logWs = wb.addWorksheet('Log');
  const logHdr = logWs.addRow(['Vendor', 'Month', 'Type', 'Status', 'Detail']);
  logHdr.font = { bold: true };
  logHdr.commit();
  for (const e of log) {
    logWs.addRow([e.vendor, e.month, e.dtype, e.status, e.detail]).commit();
  }
  logWs.commit();

  await wb.commit();

  const summary = {
    folderName: rootMeta.name,
    vendorsScanned: vendors.length,
    vendorsWithData,
    vendorsSkipped,
    filesProcessed,
    b2cRows: b2c.totalRows,
    b2bRows: b2b.totalRows,
    b2cSplit: b2c.split,
    b2bSplit: b2b.split,
    log,
  };
  emit({ type: 'done', summary });
  return summary;
}

module.exports = { consolidate, parseReportName, parseCsv };

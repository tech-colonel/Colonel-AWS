/**
 * sheetsService.js — read a Google Sheet tab as rows, via the Drive API CSV
 * export using the SAME `colonel-drive` service account as driveService.
 *
 * Uses Drive export (not the Sheets API) on purpose: the Sheets API is currently
 * disabled in the service account's GCP project, whereas the Drive API is enabled.
 * The sheet must be shared with the service-account email.
 */
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const CREDENTIALS_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : path.join(__dirname, '../../../../config/google-credentials.json');

let _auth = null;
function auth() {
  if (_auth) return _auth;
  if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error(`Google credentials not found at ${CREDENTIALS_PATH}.`);
  _auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return _auth;
}

function serviceAccountEmail() {
  try { return require(CREDENTIALS_PATH).client_email || null; } catch { return null; }
}

// minimal RFC-4180 CSV parser (handles quoted fields with commas/newlines)
function parseCsv(text) {
  const rows = []; let row = [], field = '', i = 0, inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Read a specific tab of a spreadsheet as a 2D array of cell strings, via
 * Drive CSV export. `gid` selects the tab (omit for the first sheet).
 */
async function readSheetCsv(spreadsheetId, gid) {
  const client = await auth().getClient();
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv` +
    (gid != null && gid !== '' ? `&gid=${gid}` : '');
  const res = await client.request({ url, responseType: 'text' });
  const text = typeof res.data === 'string' ? res.data : String(res.data);
  return parseCsv(text).filter(r => r.length && r.some(c => (c || '').trim() !== ''));
}

module.exports = { readSheetCsv, serviceAccountEmail, parseCsv, CREDENTIALS_PATH };

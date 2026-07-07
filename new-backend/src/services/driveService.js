/**
 * driveService.js
 *
 * Generic, reusable Google Drive access for the platform.
 * Authenticates with the `colonel-drive` service account
 * (key at backend/config/google-credentials.json) and exposes a few
 * primitives any agent can build on. MTR is its first consumer.
 *
 * Access model: folders are shared with the service-account email as Viewer
 * (one-time, cascades to subfolders). The accountant then just pastes the
 * folder link — no per-run sharing.
 *
 * Works with both My Drive and Shared Drives (supportsAllDrives everywhere).
 */

const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const CREDENTIALS_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : path.join(__dirname, '../../config/google-credentials.json');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Optional destination folder (Shared Drive folder, or a folder shared to the
// service account as Editor) where output Sheets are created. A service account
// has no personal Drive quota, so uploads into its own My Drive fail with
// storageQuotaExceeded — set GOOGLE_OUTPUT_FOLDER_ID to a Shared Drive folder.
const OUTPUT_FOLDER_ID =
  parseFolderId(process.env.GOOGLE_OUTPUT_FOLDER_ID) || null;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

let _drive = null;

/** Lazily build an authenticated Drive client (full drive scope: read + write). */
function getDrive() {
  if (_drive) return _drive;
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Google credentials not found at ${CREDENTIALS_PATH}. ` +
      `Place the service-account JSON there (see CLAUDE.md / MTR spec).`
    );
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

/** Is the credentials file present? (used for clean error messaging) */
function isConfigured() {
  return fs.existsSync(CREDENTIALS_PATH);
}

/** The service-account email — handy to show the user what to share with. */
function serviceAccountEmail() {
  try {
    return require(CREDENTIALS_PATH).client_email || null;
  } catch {
    return null;
  }
}

/**
 * Extract a Drive folder ID from whatever the user pastes:
 *  - https://drive.google.com/drive/folders/<ID>?usp=sharing
 *  - https://drive.google.com/drive/u/0/folders/<ID>
 *  - https://drive.google.com/open?id=<ID>
 *  - a bare ID
 */
function parseFolderId(input) {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // bare id (Drive IDs are URL-safe base64-ish, typically 25+ chars)
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  return null;
}

/** Read a file/folder's metadata. Throws a friendly error if inaccessible. */
async function getMeta(fileId, fields = 'id,name,mimeType,driveId') {
  const drive = getDrive();
  const res = await drive.files.get({ fileId, fields, supportsAllDrives: true });
  return res.data;
}

/**
 * List immediate children of a folder. Pages through all results.
 * @returns {Promise<Array<{id,name,mimeType,size}>>}
 */
async function listChildren(folderId) {
  const drive = getDrive();
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,size)',
      pageSize: 1000,
      orderBy: 'name',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

/** List only the subfolders of a folder. */
async function listSubfolders(folderId) {
  return (await listChildren(folderId)).filter((f) => f.mimeType === FOLDER_MIME);
}

/** Download a file's bytes as a Buffer (works for binary: zips, xlsx, etc.). */
async function downloadFile(fileId) {
  const drive = getDrive();
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

/**
 * Upload a local .xlsx and convert it to a native Google Sheet.
 * Returns { id, webViewLink }. Honours GOOGLE_OUTPUT_FOLDER_ID if set.
 */
async function uploadXlsxAsSheet(localPath, name) {
  const drive = getDrive();
  const res = await drive.files.create({
    requestBody: {
      name: name || path.basename(localPath, '.xlsx'),
      mimeType: SHEET_MIME,                      // convert xlsx → Google Sheet
      ...(OUTPUT_FOLDER_ID ? { parents: [OUTPUT_FOLDER_ID] } : {}),
    },
    media: { mimeType: XLSX_MIME, body: fs.createReadStream(localPath) },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  return { id: res.data.id, webViewLink: res.data.webViewLink };
}

/** Make a file readable by anyone with the link (so accountants can open it). */
async function makeAnyoneReader(fileId) {
  const drive = getDrive();
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true,
  });
}


/**
 * Build an OAuth2Client from stored tokens (Integration model).
 * Auto-refreshes if the access token is within 60s of expiry.
 * Returns null if no Google OAuth connection exists.
 */
async function getOAuthClient() {
  try {
    const { Integration } = require('../models/master');
    const row = await Integration.findOne({ where: { type: 'google' } });
    if (!row || row.status !== 'connected' || !row.config || !row.config.refresh_token) return null;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'https://eggbeater-thesis-crowbar.ngrok-free.dev/api/auth/google/callback',
    );
    oauth2Client.setCredentials({
      access_token:  row.config.access_token,
      refresh_token: row.config.refresh_token,
      expiry_date:   row.config.token_expiry,
    });

    // Refresh if expired or within 60s of expiry
    const expiry = row.config.token_expiry;
    if (expiry && Date.now() > expiry - 60000) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      await row.update({
        config: {
          ...row.config,
          access_token: credentials.access_token,
          token_expiry: credentials.expiry_date,
        },
      });
    }
    return oauth2Client;
  } catch (e) {
    console.error('getOAuthClient error:', e.message);
    return null;
  }
}

module.exports = {
  FOLDER_MIME,
  isConfigured,
  serviceAccountEmail,
  parseFolderId,
  getMeta,
  listChildren,
  listSubfolders,
  downloadFile,
  uploadXlsxAsSheet,
  makeAnyoneReader,
  getOAuthClient,
  hasOutputFolder: () => !!OUTPUT_FOLDER_ID,
};

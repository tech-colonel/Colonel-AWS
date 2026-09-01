/* ──────────────────────────────────────────────────────────────────────────────
   driveFetchController.js — Drive input for CLIENT-SIDE agents.

     POST /api/drive/list                 → { files: [{fileId,name,mimeType,ext,size}] }
     GET  /api/drive/file/:fileId/content → the file's raw bytes

   Why this exists alongside /api/drive/route:
   ------------------------------------------
   /api/drive/route previews a filename→slot mapping for agents whose ENGINE runs
   on the server (the backend downloads the bytes itself, from the fileIds).
   The Marketplace Ticket Generator has no server engine — it parses everything in the
   browser and detects each report's type from its HEADERS, not its filename. So
   it needs the opposite: a plain file listing plus the bytes, in the browser.

   Additive only. No existing route, agent, or service behaviour is changed —
   scanFolder()/downloadFile() are reused exactly as the reco agents use them.
   ────────────────────────────────────────────────────────────────────────────── */

const drive = require('../services/driveService');
const driveRouter = require('../services/driveRouter');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_NATIVE = 'application/vnd.google-apps.';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Same ceiling as the reco upload limit (multer in recoRoutes.js).
const MAX_BYTES = 150 * 1024 * 1024;

// scanFolder() walks a folder tree recursively. A brand's ROOT drive can hold
// thousands of nested files, so bound the wait and tell the user to paste a more
// specific folder instead of letting the request hang.
const SCAN_TIMEOUT_MS = 45000;

/** Map a Drive/permission error onto the same friendly message /drive/route uses. */
function sendDriveError(err, res, fallback) {
  const raw = `${err && err.message} ${err && err.code} ${JSON.stringify((err && err.response && err.response.data) || '')}`;
  if (/403|404|not found|permission|insufficient|forbidden|cannot access|does not have/i.test(raw)) {
    return res.status(403).json({
      error: 'Can’t open that link — set the folder/file to “Anyone with the link → Viewer” (or share it with the service account), then try again.',
    });
  }
  return res.status(500).json({ error: (err && err.message) || fallback });
}

/** Lowercased extension incl. dot, or '' if none. */
const extOf = (name) => {
  const m = String(name || '').toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? m[1] : '';
};

/**
 * POST /api/drive/list
 * Body: { folder_url, extensions? }  — extensions e.g. ['.xlsx','.xls','.csv']
 * Lists every file under a Drive folder link (recursively) or the single file a
 * file link points at. Google Sheets are surfaced as their .xlsx export name.
 */
async function listDriveFiles(req, res) {
  try {
    const folderUrl = req.body?.folder_url || req.body?.folderLink || req.body?.url;
    if (!folderUrl) return res.status(400).json({ error: 'folder_url is required' });
    if (!drive.isConfigured()) {
      return res.status(400).json({ error: 'Google Drive is not configured on this server.' });
    }

    const wanted = Array.isArray(req.body?.extensions)
      ? req.body.extensions.map((e) => String(e).toLowerCase())
      : null;

    let timer;
    const scanned = await Promise.race([
      driveRouter.scanFolder(folderUrl),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('__SCAN_TIMEOUT__')), SCAN_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));

    const files = [];
    for (const f of scanned) {
      const isSheet = f.mimeType === SHEET_MIME;
      // Other Google-native types (Docs, Slides, Forms…) can't feed a spreadsheet parser.
      if (!isSheet && String(f.mimeType || '').startsWith(GOOGLE_NATIVE)) continue;

      const name = isSheet && extOf(f.name) !== '.xlsx' ? `${f.name}.xlsx` : f.name;
      const ext = extOf(name);
      if (wanted && !wanted.includes(ext)) continue;

      files.push({ fileId: f.fileId, name, mimeType: f.mimeType, ext, isGoogleSheet: isSheet });
    }

    return res.json({
      files,
      skipped: scanned.length - files.length,
      serviceAccountEmail: drive.serviceAccountEmail ? drive.serviceAccountEmail() : null,
    });
  } catch (err) {
    if (err && err.message === '__SCAN_TIMEOUT__') {
      return res.status(504).json({
        error: 'That folder has too many nested files to scan. Paste the specific folder holding the reports (e.g. the month folder) instead.',
      });
    }
    return sendDriveError(err, res, 'Failed to scan the Drive link.');
  }
}

/**
 * GET /api/drive/file/:fileId/content
 * Streams one Drive file's bytes to the browser so a client-side agent can parse
 * it. The real filename comes back in X-Drive-File-Name (URI-encoded).
 */
async function getDriveFileContent(req, res) {
  try {
    const fileId = String(req.params.fileId || '').trim();
    if (!/^[a-zA-Z0-9_-]{10,}$/.test(fileId)) {
      return res.status(400).json({ error: 'Invalid Drive file id.' });
    }
    if (!drive.isConfigured()) {
      return res.status(400).json({ error: 'Google Drive is not configured on this server.' });
    }

    const meta = await drive.getMeta(fileId, 'id,name,mimeType,size');
    if (meta.mimeType === FOLDER_MIME) {
      return res.status(400).json({ error: 'That link points to a folder, not a file.' });
    }
    if (meta.size && Number(meta.size) > MAX_BYTES) {
      return res.status(413).json({ error: `That file is larger than ${Math.round(MAX_BYTES / (1024 * 1024))}MB.` });
    }

    const isSheet = meta.mimeType === SHEET_MIME;
    if (!isSheet && String(meta.mimeType || '').startsWith(GOOGLE_NATIVE)) {
      return res.status(415).json({ error: `“${meta.name}” is a Google ${String(meta.mimeType).replace(GOOGLE_NATIVE, '')} — export it to Excel/CSV first.` });
    }

    const buffer = isSheet ? await drive.exportFile(fileId, XLSX_MIME) : await drive.downloadFile(fileId);
    const name = isSheet && extOf(meta.name) !== '.xlsx' ? `${meta.name}.xlsx` : meta.name;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Drive-File-Name', encodeURIComponent(name));
    res.setHeader('Access-Control-Expose-Headers', 'X-Drive-File-Name');
    return res.send(buffer);
  } catch (err) {
    return sendDriveError(err, res, 'Failed to download that Drive file.');
  }
}

module.exports = { listDriveFiles, getDriveFileContent };

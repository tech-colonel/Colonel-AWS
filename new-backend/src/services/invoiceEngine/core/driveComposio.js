/**
 * driveComposio.js — Google Drive access through Composio's "Google Super" toolkit,
 * acting as the connected account (e.g. central / team@colonel.co.in). Alternative to
 * the service-account driveService; selected per-brand via invoice_config.source.
 *
 * Actions used: GOOGLESUPER_FIND_FILE, GOOGLESUPER_DOWNLOAD_FILE (returns an s3url we
 * fetch for bytes), GOOGLESUPER_CREATE_FOLDER, GOOGLESUPER_MOVE_FILE.
 */
const composio = require('../../composioClient');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const data = (r) => (r && r.data) || {};
const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** List direct children of a folder (paged). Returns [{id,name,mimeType,webViewLink}]. */
async function listChildren(userId, folderId) {
  const out = [];
  let pageToken;
  do {
    const r = await composio.executeTool(userId, 'GOOGLESUPER_FIND_FILE', {
      q: `'${esc(folderId)}' in parents and trashed = false`,
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'nextPageToken, files(id, name, mimeType, webViewLink)',
      ...(pageToken ? { pageToken } : {}),
    });
    const d = data(r);
    out.push(...(d.files || []));
    pageToken = d.nextPageToken;
  } while (pageToken);
  return out;
}

/** Download a file's bytes. Returns { buffer, webViewLink, name, mimeType }. */
async function downloadFile(userId, fileId) {
  const r = await composio.executeTool(userId, 'GOOGLESUPER_DOWNLOAD_FILE', { fileId });
  const d = data(r);
  const content = d.downloaded_file_content || {};
  const s3url = content.s3url || content.s3Url || content.url;
  if (!s3url) throw new Error('Composio download returned no s3url');
  const resp = await fetch(s3url);
  if (!resp.ok) throw new Error(`Fetch s3url failed: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { buffer, webViewLink: d.display_url || null, name: d.name, mimeType: d.mimeType };
}

/** Find a subfolder by exact name under a parent. Returns {id,name} or null. */
async function findFolder(userId, name, parentId) {
  const r = await composio.executeTool(userId, 'GOOGLESUPER_FIND_FILE', {
    q: `name = '${esc(name)}' and mimeType = '${FOLDER_MIME}' and '${esc(parentId)}' in parents and trashed = false`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: 'files(id, name)',
  });
  const files = data(r).files || [];
  return files[0] || null;
}

/** Create a folder under a parent. Returns the new folder id. */
async function createFolder(userId, name, parentId) {
  const r = await composio.executeTool(userId, 'GOOGLESUPER_CREATE_FOLDER', { name, parent_id: parentId });
  const d = data(r);
  return d.id || (d.file && d.file.id) || (d.response_data && d.response_data.id) || null;
}

/** Find-or-create a subfolder by name under a parent. Returns its id. */
async function ensureFolder(userId, name, parentId) {
  const existing = await findFolder(userId, name, parentId);
  if (existing && existing.id) return existing.id;
  return createFolder(userId, name, parentId);
}

/** Move a file to a new parent (removing the old one). */
async function moveFile(userId, fileId, addParentId, removeParentId) {
  return composio.executeTool(userId, 'GOOGLESUPER_MOVE_FILE', {
    file_id: fileId,
    add_parents: addParentId,
    ...(removeParentId ? { remove_parents: removeParentId } : {}),
    supports_all_drives: true,
  });
}

module.exports = { listChildren, downloadFile, findFolder, createFolder, ensureFolder, moveFile, FOLDER_MIME };

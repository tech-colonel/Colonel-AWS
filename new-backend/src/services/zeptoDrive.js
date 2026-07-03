const drive = require('./driveService');

// Google Docs-native mimeTypes we must export rather than download raw.
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function classifyZeptoFile(name) {
  const n = String(name || '').toLowerCase().trim();
  if (n.startsWith('1.') || n.includes('receivable tracker')) return null; // output file
  if (n.includes('drips')) return null;                                    // LRN/POD (future)
  if (n.includes('zepto payment')) return 'zepto_payment';
  if (n.startsWith('grn_list') || n.includes('grn_list') || n.includes('grn list')) return 'grn_list';
  if (n.includes('invoice details')) return 'invoice_details';
  if (n.startsWith('payment_advice') || n.includes('payment_advice') || n.includes('payment advice')) return 'payment_advice';
  if (n.includes('credit note')) return 'credit_note';
  return null;
}

// Recurse through folder + subfolders, classify every non-folder file.
async function _walk(folderId, out, ignored) {
  const children = await drive.listChildren(folderId);
  for (const c of children) {
    if (c.mimeType === FOLDER_MIME) {
      await _walk(c.id, out, ignored);
    } else {
      const type = classifyZeptoFile(c.name);
      if (type) out.push({ id: c.id, name: c.name, mimeType: c.mimeType, type });
      else ignored.push({ name: c.name });
    }
  }
}

async function collectZeptoFiles(folderUrl) {
  const folderId = drive.parseFolderId(folderUrl);
  if (!folderId) throw new Error('Could not parse a Google Drive folder ID from the link.');
  const files = [], ignored = [];
  await _walk(folderId, files, ignored);
  const counts = files.reduce((acc, f) => { acc[f.type] = (acc[f.type] || 0) + 1; return acc; }, {});
  return { files, counts, ignored };
}

async function downloadClassified(folderUrl) {
  const { files } = await collectZeptoFiles(folderUrl);
  const grouped = {};
  for (const f of files) {
    const buffer = await drive.downloadFile(f.id);
    (grouped[f.type] = grouped[f.type] || []).push({ filename: f.name, buffer });
  }
  return grouped;
}

module.exports = { classifyZeptoFile, collectZeptoFiles, downloadClassified };

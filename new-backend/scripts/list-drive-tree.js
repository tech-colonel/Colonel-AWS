/* Print the shape of a shared Drive folder before pulling anything from it. */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const drive = require('../src/services/driveService');

(async () => {
  const root = drive.parseFolderId(process.argv[2]);
  if (!root) throw new Error('not a Drive folder link');
  async function walk(id, depth) {
    if (depth > 5) return;
    for (const c of await drive.listChildren(id)) {
      const isDir = c.mimeType === 'application/vnd.google-apps.folder';
      const kind = c.mimeType.replace('application/vnd.google-apps.', 'gdrive-')
                             .replace('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx');
      console.log(`${'  '.repeat(depth)}${isDir ? `[${c.name}]` : `${c.name}   <${kind}>`}`);
      if (isDir) await walk(c.id, depth + 1);
    }
  }
  await walk(root, 0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

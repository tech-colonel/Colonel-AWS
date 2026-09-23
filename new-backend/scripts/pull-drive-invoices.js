/* Pull the Amazon fee-invoice PDFs the brand shared on Drive. Read-only. */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const drive = require('../src/services/driveService');

const LINK = process.argv[2];
const DEST = process.argv[3] || path.resolve(process.env.HOME, 'Downloads/KOPARO INVOICES');

(async () => {
  console.log('service account:', drive.serviceAccountEmail());
  const root = drive.parseFolderId(LINK);
  if (!root) throw new Error('not a Drive folder link');
  console.log('folder:', root);

  const seen = new Set();
  let files = 0;
  async function walk(id, prefix) {
    if (seen.has(id)) return;
    seen.add(id);
    const kids = await drive.listChildren(id);
    for (const c of kids) {
      if (c.mimeType === 'application/vnd.google-apps.folder') {
        console.log(`  [dir] ${prefix}${c.name}`);
        await walk(c.id, `${prefix}${c.name}/`);
      } else {
        const out = path.join(DEST, c.name);
        if (!fs.existsSync(out)) {
          const buf = await drive.downloadFile(c.id);
          fs.writeFileSync(out, buf);
        }
        files += 1;
        console.log(`  ${prefix}${c.name}  (${c.mimeType})`);
      }
    }
  }
  fs.mkdirSync(DEST, { recursive: true });
  await walk(root, '');
  console.log(`\n${files} files -> ${DEST}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

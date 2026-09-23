const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const drive = require('../src/services/driveService');
(async () => {
  const root = drive.parseFolderId(process.argv[2]);
  const hits = [];
  async function walk(id, trail, depth) {
    if (depth > 6) return;
    for (const c of await drive.listChildren(id)) {
      if (c.mimeType === 'application/vnd.google-apps.folder') {
        await walk(c.id, [...trail, c.name], depth + 1);
      } else if (trail.some((t) => /amazon/i.test(t)) || /amazon|mtr/i.test(c.name)) {
        hits.push(`${trail.join(' / ')} :: ${c.name}   [${c.mimeType.split(/[./]/).pop()}]`);
      }
    }
  }
  await walk(root, [], 0);
  hits.sort();
  console.log(hits.join('\n'));
  console.log(`\nTOTAL Amazon-related files in the tree: ${hits.length}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

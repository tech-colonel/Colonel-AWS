/* Walk the brand's month/channel Drive tree and pull only the MTR CSVs.
   Layout: <Month>/<Channel>/Amazon Sales/Amazon B2B|Amazon B2C/MTR_*.csv
   The folder path is kept in the saved filename, because the CSVs themselves
   are named inconsistently across months. */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const drive = require('../src/services/driveService');

const DEST = path.resolve(process.env.HOME, 'Downloads/KOPARO MTR');
const safe = (s) => String(s).replace(/[^\w.\- ]+/g, '_').trim();

(async () => {
  const root = drive.parseFolderId(process.argv[2]);
  if (!root) throw new Error('not a Drive folder link');
  fs.mkdirSync(DEST, { recursive: true });

  let got = 0, skipped = 0;
  async function walk(id, trail, depth) {
    if (depth > 6) return;
    for (const c of await drive.listChildren(id)) {
      if (c.mimeType === 'application/vnd.google-apps.folder') {
        await walk(c.id, [...trail, c.name], depth + 1);
        continue;
      }
      const isCsv = /\.csv$/i.test(c.name) || c.mimeType === 'text/csv';
      const looksMtr = /mtr/i.test(c.name) || trail.some((t) => /B2B|B2C/i.test(t));
      if (!isCsv || !looksMtr) { skipped += 1; continue; }
      const out = path.join(DEST, safe(`${trail.join(' ~ ')} ~ ${c.name}`));
      if (!fs.existsSync(out)) {
        fs.writeFileSync(out, await drive.downloadFile(c.id));
      }
      got += 1;
      console.log(`  ${trail.join(' / ')} / ${c.name}`);
    }
  }
  await walk(root, [], 0);
  console.log(`\n${got} MTR csv files -> ${DEST}   (${skipped} other files ignored)`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

/* Pull the accountant's own Amazon working files, so the MIS can be checked
   against what he already produces by hand. Read-only. */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const drive = require('../src/services/driveService');

const DEST = path.resolve(process.env.HOME, 'Downloads/KOPARO WORKINGS');
const safe = (s) => String(s).replace(/[^\w.\- ]+/g, '_').trim();
const WANT = /output|working|macros|utillity|utility/i;

(async () => {
  const root = drive.parseFolderId(process.argv[2]);
  fs.mkdirSync(DEST, { recursive: true });
  let got = 0;
  async function walk(id, trail, depth) {
    if (depth > 6) return;
    for (const c of await drive.listChildren(id)) {
      if (c.mimeType === 'application/vnd.google-apps.folder') {
        await walk(c.id, [...trail, c.name], depth + 1);
        continue;
      }
      const inAmazon = trail.some((t) => /amazon/i.test(t));
      if (!inAmazon || !WANT.test(c.name) || /\.zip$/i.test(c.name)) continue;
      const out = path.join(DEST, safe(`${trail.join(' ~ ')} ~ ${c.name}`));
      if (!fs.existsSync(out)) fs.writeFileSync(out, await drive.downloadFile(c.id));
      got += 1;
      console.log(`  ${trail.join(' / ')} / ${c.name}`);
    }
  }
  await walk(root, [], 0);
  console.log(`\n${got} working files -> ${DEST}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

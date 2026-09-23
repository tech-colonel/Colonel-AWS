// List every settlement report Amazon still holds, and say which we already have
// on disk.  Listing is cheap; it is the DOCUMENT call that is one a minute.
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const reports = require('../src/services/amazonReports');

const BRAND = '546976a5-6ca5-42d1-8b7d-2c6379ffa221';
const LEDGERS = path.resolve(__dirname, "../outputs/amazon-ledgers");

(async () => {
  const have = new Set();
  for (const d of fs.readdirSync(LEDGERS)) {
    const p = path.join(LEDGERS, d);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p)) {
      const m = f.match(/settlement_ledger_(\d+)\.tsv$/);
      if (m) have.add(m[1]);
    }
  }
  let token, all = [], page = 0;
  do {
    const list = await reports.listReports(BRAND, {
      reportTypes: [reports.REPORT_TYPES.SETTLEMENT_V2.type],
      processingStatuses: ['DONE'],
      createdSince: new Date(Date.now() - 90 * 24 * 3600 * 1000),
      pageSize: 100,
      nextToken: token,
    });
    all = all.concat(list?.reports || []);
    token = list?.nextToken;
    page += 1;
  } while (token && page < 10);

  all.sort((a, b) => String(a.dataStartTime).localeCompare(String(b.dataStartTime)));
  console.log(`${all.length} settlement reports available (${have.size} already on disk)\n`);
  const fmt = (s) => (s ? String(s).slice(0, 10) : '?');
  for (const r of all) {
    console.log(`${have.has(String(r.reportId)) ? 'HAVE' : ' -- '}  ${r.reportId}  ${fmt(r.dataStartTime)} -> ${fmt(r.dataEndTime)}  created ${fmt(r.createdTime)}`);
  }
  const missing = all.filter((r) => !have.has(String(r.reportId)) && r.reportDocumentId);
  console.log(`\nMISSING: ${missing.length}  -> ${missing.map((r) => r.reportId).join(' ')}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

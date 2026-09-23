/* Download the settlement ledgers we do not already hold.
   Amazon allows ONE report-document call a minute, so this paces itself and
   retries on 429 rather than burning the quota.  Files only: nothing is written
   to the database here, so it is safe to re-run. */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const reports = require('../src/services/amazonReports');

const BRAND = '546976a5-6ca5-42d1-8b7d-2c6379ffa221';
const DIR = path.resolve(__dirname, '../outputs/amazon-ledgers/Koparo');
const SPACING_MS = 62_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const have = new Set(fs.readdirSync(DIR)
    .map((f) => (f.match(/settlement_ledger_(\d+)\.tsv$/) || [])[1]).filter(Boolean));

  let token, all = [], page = 0;
  do {
    const list = await reports.listReports(BRAND, {
      reportTypes: [reports.REPORT_TYPES.SETTLEMENT_V2.type],
      processingStatuses: ['DONE'],
      createdSince: new Date(Date.now() - 90 * 24 * 3600 * 1000),
      pageSize: 100, nextToken: token,
    });
    all = all.concat(list?.reports || []);
    token = list?.nextToken; page += 1;
  } while (token && page < 10);

  const todo = all.filter((r) => r.reportDocumentId && !have.has(String(r.reportId)))
                  .sort((a, b) => String(a.dataStartTime).localeCompare(String(b.dataStartTime)));
  console.log(`${todo.length} to download, ~${Math.ceil(todo.length * SPACING_MS / 60000)} min\n`);

  let done = 0;
  for (const r of todo) {
    const dest = path.join(DIR, `settlement_ledger_${r.reportId}.tsv`);
    const win = `${String(r.dataStartTime).slice(0, 10)} -> ${String(r.dataEndTime).slice(0, 10)}`;
    let ok = false;
    for (let attempt = 1; attempt <= 4 && !ok; attempt += 1) {
      try {
        const doc = await reports.getReportDocument(BRAND, r.reportDocumentId);
        await reports.downloadDocument(doc, dest);
        const lines = fs.readFileSync(dest, 'utf8').split('\n').filter(Boolean).length - 1;
        console.log(`  OK   ${r.reportId}  ${win}  ${lines} rows`);
        ok = true; done += 1;
      } catch (e) {
        const wait = /429|quota|rate/i.test(e.message) ? SPACING_MS * attempt : 5000;
        console.log(`  wait ${r.reportId}  ${e.message.slice(0, 70)}  retry in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
    if (!ok) console.log(`  FAIL ${r.reportId}  ${win}`);
    if (r !== todo[todo.length - 1]) await sleep(SPACING_MS);
  }
  console.log(`\ndownloaded ${done} of ${todo.length}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

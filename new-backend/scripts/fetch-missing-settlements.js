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

  /* The ledgers built from the FINANCES api are named for the settlement, not
     the report - settlement_<deposit-date>_<settlementId>.tsv - so matching on
     reportId alone cannot see them, and every run queued ~56 downloads of
     weeks already on disk: an hour of quota re-fetching what we have, weekly.
     The PERIOD is the one thing both naming schemes agree on, so it is the
     second key. */
  const havePeriod = new Set();
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.tsv')) continue;
    try {
      const txt = fs.readFileSync(path.join(DIR, f), 'utf8');
      const nl = txt.indexOf('\n');
      const hdr = txt.slice(0, nl).split('\t');
      const row = txt.slice(nl + 1, txt.indexOf('\n', nl + 1)).split('\t');
      const i = hdr.indexOf('settlement-start-date');
      const j = hdr.indexOf('settlement-end-date');
      if (i < 0 || j < 0) continue;
      const iso = (d) => { const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(d || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
      const a = iso(row[i]); const b = iso(row[j]);
      if (a && b) havePeriod.add(`${a}|${b}`);
    } catch { /* an unreadable file simply does not count as held */ }
  }

  /* The DOWNLOADS retry four times each; the LISTING did not retry at all, so
     one transient socket error ended the run - "FAILED: fetch failed", exit 1,
     nothing fetched. That is exactly what happened on Mon 12 Oct 2026 07:15:
     the laptop had just woken and the network was not up. A weekly job that
     gives up on the first blip is a weekly job that quietly stops, and with
     the Reports api refusing anything over 90 days old, about twelve missed
     runs put a settlement permanently out of reach. */
  let token, all = [], page = 0;
  do {
    let list = null;
    for (let attempt = 1; attempt <= 5 && !list; attempt += 1) {
      try {
        list = await reports.listReports(BRAND, {
          reportTypes: [reports.REPORT_TYPES.SETTLEMENT_V2.type],
          processingStatuses: ['DONE'],
          createdSince: new Date(Date.now() - 90 * 24 * 3600 * 1000),
          pageSize: 100, nextToken: token,
        });
      } catch (e) {
        if (attempt === 5) throw e;
        const wait = 15000 * attempt;
        console.log(`  list attempt ${attempt} failed (${e.message.slice(0, 60)}) - retry in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
    all = all.concat(list?.reports || []);
    token = list?.nextToken; page += 1;
  } while (token && page < 10);

  const period = (r) => `${String(r.dataStartTime).slice(0, 10)}|${String(r.dataEndTime).slice(0, 10)}`;
  const todo = all.filter((r) => r.reportDocumentId
                              && !have.has(String(r.reportId))
                              && !havePeriod.has(period(r)))
                  .sort((a, b) => String(a.dataStartTime).localeCompare(String(b.dataStartTime)));
  const skipped = all.filter((r) => r.reportDocumentId && havePeriod.has(period(r))).length;
  if (skipped) console.log(`${skipped} already held under their settlement name - skipping`);
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

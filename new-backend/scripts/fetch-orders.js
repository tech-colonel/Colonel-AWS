/* Pull the all-orders report so every order id can be dated.
   The settlement carries an order id on each fee line but no order date; the
   fee invoice carries a date but no order id.  The order date is the bridge. */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const reports = require('../src/services/amazonReports');

const BRAND = '546976a5-6ca5-42d1-8b7d-2c6379ffa221';
const DIR = path.resolve(__dirname, '../outputs/amazon-orders');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 30-day maximum per request, so the span is cut into windows.
const WINDOWS = [
  ['2026-06-25', '2026-07-24'],
  ['2026-07-24', '2026-08-22'],
  ['2026-08-22', '2026-09-20'],
];

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  for (const [from, to] of WINDOWS) {
    const dest = path.join(DIR, `orders_${from}_${to}.tsv`);
    if (fs.existsSync(dest)) { console.log(`  have ${from} -> ${to}`); continue; }
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
      try {
        const res = await reports.fetchReport(BRAND,
          reports.REPORT_TYPES.ORDERS_BY_ORDER_DATE.type,
          { dataStartTime: `${from}T00:00:00Z`, dataEndTime: `${to}T23:59:59Z`, keepFile: true });
        fs.copyFileSync(res.filePath, dest);
        fs.promises.unlink(res.filePath).catch(() => {});
        console.log(`  OK   ${from} -> ${to}  ${res.count} orders`);
        ok = true;
      } catch (e) {
        console.log(`  wait ${from}: ${e.message.slice(0, 80)}`);
        await sleep(65_000);
      }
    }
    if (!ok) console.log(`  FAIL ${from} -> ${to}`);
    await sleep(65_000);
  }
  console.log('done');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

#!/usr/bin/env node
/* ⚠️  NOT VERIFIED - DO NOT USE FOR REAL DATA YET  ⚠️
   ──────────────────────────────────────────────────────────────────────────
   Tested on 12 Oct 2026 by regenerating ten April-2025 settlements already on
   disk and diffing them against Amazon's own files. NINE OF TEN STILL DIFFER:

     settlement      Amazon payout   this script      short by
     24587771722        125,493.07    106,465.16     19,027.91
     24561008332         16,617.22     12,644.13      3,973.09
     24566478622         21,212.04     15,611.70      5,600.34
     ...                                        1 of 10 matches

   Amazon's own files sum exactly to their payout; these do not, so money is
   still being missed somewhere in the breakdown mapping. Three faults were
   found and fixed along the way - (txn)/(item) level amounts being dropped as
   if they were rollups, the missing "Balance brought forward" row, and a
   transaction window too narrow for settlements that end after it - and each
   closed part of the gap. The rest is not yet diagnosed.

   Committed for the diagnosis and the breakdown taxonomy it encodes, not
   because it works. Finish the mapping and get all ten to diff clean before
   trusting a single file it writes.
   ────────────────────────────────────────────────────────────────────────── */
/* ──────────────────────────────────────────────────────────────────────────────
   pull-settlements.js — one entry point, two routes, chosen by how far back you
   are asking.

       node scripts/pull-settlements.js                  last 90 days  (Reports)
       node scripts/pull-settlements.js --from 2025-04-01 --to 2025-09-30
       node scripts/pull-settlements.js --from 2025-01-01 --finances
       node scripts/pull-settlements.js --from 2025-04-01 --dry-run

   WHY TWO ROUTES. The Reports API serves the real settlement flat file, which
   is the thing to use when it is available - it is Amazon's own document, no
   reconstruction involved. But it refuses anything over 90 days old:
       "RequestedFromDate 2026-03-01 is more than 90 days old"
   The Finances API has no such wall; it reached back to 2023 when the 500
   ledgers now on disk were built. It does not hand over a flat file, though -
   it hands over transactions, and the file has to be rebuilt from them.

   So: inside 90 days, take Amazon's own file. Outside it, rebuild from the
   Finances API. The route is picked from --from unless you force it.

   WRITES FILES ONLY. Nothing touches the database, nothing is deleted, and a
   settlement already on disk is never fetched again - so this is safe to
   re-run as often as you like.
   ────────────────────────────────────────────────────────────────────────────── */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const client = require('../src/services/amazonClient');

const BRAND = process.env.KOPARO_BRAND_ID || '546976a5-6ca5-42d1-8b7d-2c6379ffa221';
const DIR = process.env.LEDGER_OUT || path.resolve(__dirname, '../outputs/amazon-ledgers/Koparo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── arguments ─────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);
const DRY = has('dry-run');
const TO = arg('to', new Date().toISOString().slice(0, 10));
const FROM = arg('from', new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10));
const ageDays = Math.round((Date.now() - new Date(FROM).getTime()) / 864e5);
const route = has('finances') ? 'finances'
            : has('reports') ? 'reports'
            : (ageDays > 85 ? 'finances' : 'reports');   // 85, not 90: leave a margin

/* ── the flat file's 24 columns, in Amazon's order ─────────────────────────── */
const COLS = ['settlement-id', 'settlement-start-date', 'settlement-end-date', 'deposit-date',
  'total-amount', 'currency', 'transaction-type', 'order-id', 'merchant-order-id',
  'adjustment-id', 'shipment-id', 'marketplace-name', 'amount-type', 'amount-description',
  'amount', 'fulfillment-id', 'posted-date', 'posted-date-time', 'order-item-code',
  'merchant-order-item-id', 'merchant-adjustment-item-id', 'sku', 'quantity-purchased',
  'promotion-id'];

const dmy = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};
const dmyTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${dmy(iso)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
};
const money = (n) => (n === null || n === undefined ? '' : String(Math.round(n * 100) / 100));

/* ── breakdown leaf → the flat file's (amount-type, amount-description) ───────
   Amazon returns the SAME money twice: once as a rollup (Sales > ProductCharges,
   Expenses > TaxDeductedAtSource) and once as detail (ProductCharges >
   OurPricePrincipal, Commission > Base). Taking both doubles every rupee, so
   only the detail side is mapped and the rollups are listed as ignored - by
   name, so an unmapped leaf is loud rather than silently dropped. */
const ROLLUPS = new Set(['Sales', 'Expenses', 'Refunded Sales', 'Refunded Expenses']);
/* ...but ONLY where a detail level exists underneath. On an Adjustment, a
   Transfer or a ServiceFee there is no item breakdown at all and the money
   hangs straight off the transaction, so "(txn) > Sales" IS the detail and
   dropping it loses the whole amount. Those are kept. */
const MAP = {
  'ProductCharges>OurPricePrincipal': ['ItemPrice', 'Principal'],
  'Tax>OurPriceTax':                  ['ItemPrice', 'Product Tax'],
  'Shipping>ShippingPrincipal':       ['ItemPrice', 'Shipping'],
  'Tax>ShippingTax':                  ['ItemPrice', 'Shipping Tax'],
  'PromoRebates>OurPriceDiscount':    ['ItemPrice', 'Promotion Principal'],
  'PromoRebates>ShippingDiscount':    ['ItemPrice', 'Promotion Shipping'],
  'Tax>OurPriceTaxDiscount':          ['ItemPrice', 'Promotion Principal Tax'],
  'Tax>ShippingTaxDiscount':          ['ItemPrice', 'Promotion Shipping Tax'],
  'TaxWithholding>ItemTDS':           ['ItemTDS',   'TDS (Section 194-O)'],
  'TaxCollectedAtSource>TCS-IGST':    ['ItemTCS',   'TCS-IGST'],
  'TaxCollectedAtSource>TCS-CGST':    ['ItemTCS',   'TCS-CGST'],
  'TaxCollectedAtSource>TCS-SGST':    ['ItemTCS',   'TCS-SGST'],
};
/* every fee arrives as Base + Tax under the fee's own name */
const FEES = ['Commission', 'FixedClosingFee', 'RefundCommission', 'FBAPerUnitFulfillmentFee',
  'FBAWeightBasedFee', 'FBAStorageFee', 'FBARemovalFee', 'ShippingChargeback',
  'OrderCancellationCharge', 'StorageBillingFee'];
for (const f of FEES) {
  MAP[`${f}>Base`] = ['ItemFees', 'AmazonFees'];
  MAP[`${f}>Tax`]  = ['ItemFees', 'AmazonFees IGST'];
}

const unmapped = new Map();
function leaves(nodes, parent, out) {
  for (const n of nodes || []) {
    const kids = n.breakdowns || [];
    if (kids.length) { leaves(kids, n.breakdownType, out); continue; }
    if (ROLLUPS.has(parent)) continue;                 // the rollup side of the same money
    const key = `${parent}>${n.breakdownType}`;
    const m = MAP[key];
    if (m) {
      out.push({ type: m[0], desc: m[1], amount: n.breakdownAmount?.currencyAmount ?? 0 });
      continue;
    }
    /* straight off the transaction or the item, with nothing nested under it:
       this is the only record of that money, so write it under its own name
       rather than drop it */
    if (parent === '(txn)' || parent === '(item)') {
      out.push({ type: 'other-transaction', desc: n.breakdownType,
                 amount: n.breakdownAmount?.currencyAmount ?? 0 });
      continue;
    }
    unmapped.set(key, (unmapped.get(key) || 0) + 1);
  }
}

const relId = (t, name) =>
  (t.relatedIdentifiers || []).find((r) => r.relatedIdentifierName === name)?.relatedIdentifierValue || '';

/* ── the Finances route ────────────────────────────────────────────────────── */
async function viaFinances() {
  console.log(`Finances API  ${FROM} -> ${TO}   (${ageDays} days back)\n`);

  // 1. the settlement headers
  const groups = [];
  let token = null, page = 0;
  do {
    const q = { FinancialEventGroupStartedAfter: new Date(FROM).toISOString(),
                FinancialEventGroupStartedBefore: new Date(TO).toISOString(), MaxResultsPerPage: 100 };
    if (token) q.NextToken = token;
    const r = await client.request(BRAND, '/finances/v0/financialEventGroups', { query: q });
    const p = r?.payload || r;
    groups.push(...(p?.FinancialEventGroupList || []));
    token = p?.NextToken; page += 1;
  } while (token && page < 40);
  console.log(`${groups.length} settlement groups`);

  /* 2. every transaction, bucketed by settlement id.
     NOT over --from..--to. A settlement that STARTS inside the window can end
     days after it, and its last transactions are posted right up to the end -
     querying the user's window truncated nine of ten April settlements, one of
     them by Rs 31,153.44, and the shortfall looks exactly like missing data
     rather than a bad date bound. So the transaction window is widened to span
     the groups actually found, plus a day either side for the boundary. */
  const starts = groups.map((g) => new Date(g.FinancialEventGroupStart).getTime()).filter(Boolean);
  const ends = groups.map((g) => new Date(g.FinancialEventGroupEnd || g.FundTransferDate || 0).getTime()).filter(Boolean);
  const txFrom = new Date(Math.min(new Date(FROM).getTime(), ...(starts.length ? starts : [Date.now()])) - 864e5);
  const txTo = new Date(Math.max(new Date(TO).getTime(), ...(ends.length ? ends : [0])) + 864e5);
  console.log(`transactions ${txFrom.toISOString().slice(0, 10)} -> ${txTo.toISOString().slice(0, 10)} (widened to cover the groups)`);

  const bySettle = new Map();
  token = null; page = 0;
  let seen = 0;
  do {
    const q = { postedAfter: txFrom.toISOString(), postedBefore: txTo.toISOString() };
    if (token) q.nextToken = token;
    const r = await client.request(BRAND, '/finances/2024-06-19/transactions', { query: q });
    const p = r?.payload || r;
    for (const t of p?.transactions || []) {
      seen += 1;
      /* RELEASED only. DEFERRED_RELEASED is money earmarked against a
         settlement that Amazon has not actually paid out in it; counting it
         overstated April 2025 by about 1.3 lakh when this was first built. */
      if (t.transactionStatus !== 'RELEASED') continue;
      const sid = relId(t, 'SETTLEMENT_ID');
      if (!sid) continue;
      if (!bySettle.has(sid)) bySettle.set(sid, []);
      bySettle.get(sid).push(t);
    }
    token = p?.nextToken; page += 1;
    if (page % 10 === 0) console.log(`  ...${seen} transactions`);
  } while (token && page < 400);
  console.log(`${seen} transactions, ${bySettle.size} settlements with lines\n`);

  const gById = new Map();
  for (const g of groups) gById.set(g.FinancialEventGroupId, g);

  let written = 0, skipped = 0;
  for (const [sid, txs] of bySettle) {
    const g = gById.get(relId(txs[0], 'FINANCIAL_EVENT_GROUP_ID')) || {};
    /* deposit-date is Amazon's convention: FundTransferDate + 2 days, verified
       on 25 real flat files. It is NOT the day the bank acknowledged it. */
    const dep = g.FundTransferDate ? new Date(new Date(g.FundTransferDate).getTime() + 2 * 864e5).toISOString() : '';
    const name = `settlement_${(dep || g.FinancialEventGroupEnd || '').slice(0, 10)}_${sid}.tsv`;
    const dest = path.join(DIR, name);
    if (fs.existsSync(dest)) { skipped += 1; continue; }

    const rows = [];
    const head = {};
    COLS.forEach((c) => { head[c] = ''; });
    head['settlement-id'] = sid;
    head['settlement-start-date'] = dmyTime(g.FinancialEventGroupStart);
    head['settlement-end-date'] = dmyTime(g.FinancialEventGroupEnd);
    head['deposit-date'] = dmyTime(dep);
    head['total-amount'] = money(g.OriginalTotal?.CurrencyAmount);
    head['currency'] = g.OriginalTotal?.CurrencyCode || 'INR';
    rows.push(head);

    /* A settlement that opens owing (or owed) carries that in as its first
       line. It is not a transaction, so it appears in no transactions call -
       it is Amazon's BeginningBalance on the group, and without it a
       settlement does not sum to its own payout. The real flat file words it
       exactly like this. */
    const bb = g.BeginningBalance?.CurrencyAmount;
    if (bb !== undefined && bb !== null && Math.abs(bb) > 0.001) {
      const b = {}; COLS.forEach((c) => { b[c] = ''; });
      b['settlement-id'] = sid;
      b['transaction-type'] = 'other-transaction';
      b['amount-type'] = 'other-transaction';
      b['amount-description'] = 'Balance brought forward';
      b['amount'] = money(bb);
      b['marketplace-name'] = 'Amazon.in';
      b['posted-date'] = dmy(g.FinancialEventGroupStart);
      rows.push(b);
    }

    for (const t of txs) {
      const base = {};
      COLS.forEach((c) => { base[c] = ''; });
      base['settlement-id'] = sid;
      base['transaction-type'] = t.transactionType === 'Shipment' ? 'Order'
                               : t.transactionType === 'Refund' ? 'Refund' : 'other-transaction';
      base['order-id'] = relId(t, 'ORDER_ID');
      base['shipment-id'] = relId(t, 'SHIPMENT_ID');
      base['marketplace-name'] = t.marketplaceDetails?.marketplaceName || '';
      base['posted-date'] = dmy(t.postedDate);
      base['posted-date-time'] = dmyTime(t.postedDate);
      for (const it of t.items || []) {
        const out = [];
        leaves(it.breakdowns, '(item)', out);
        for (const l of out) {
          rows.push({ ...base, sku: it.sku || '', 'amount-type': l.type,
                      'amount-description': l.desc, amount: money(l.amount) });
        }
      }
      const txOut = [];
      leaves(t.breakdowns, '(txn)', txOut);
      for (const l of txOut) {
        rows.push({ ...base, 'amount-type': l.type, 'amount-description': l.desc, amount: money(l.amount) });
      }
    }

    if (DRY) { console.log(`  would write ${name}  ${rows.length - 1} rows`); written += 1; continue; }
    const tsv = [COLS.join('\t'), ...rows.map((r) => COLS.map((c) => r[c] ?? '').join('\t'))].join('\n');
    fs.writeFileSync(dest, `${tsv}\n`);
    console.log(`  ${name}  ${rows.length - 1} rows`);
    written += 1;
  }
  console.log(`\n${written} written, ${skipped} already on disk`);
  if (unmapped.size) {
    console.log('\nUNMAPPED breakdown types - money NOT written, add them to MAP:');
    [...unmapped.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`   ${String(v).padStart(6)}  ${k}`));
  }
}

/* ── the Reports route: delegate to the script that already does it ────────── */
async function viaReports() {
  console.log(`Reports API  ${FROM} -> ${TO}   (${ageDays} days back)\n`);
  await require('child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'fetch-missing-settlements.js')], { stdio: 'inherit' });
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  if (route === 'finances') await viaFinances(); else await viaReports();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

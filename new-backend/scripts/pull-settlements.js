#!/usr/bin/env node
/* VERIFIED 15 Oct 2026 against Amazon's own settlement files.
   ──────────────────────────────────────────────────────────────────────────
   Regenerated every April-2025 settlement from the Finances API and diffed it
   against the flat file Amazon itself served:

     39 of 39 files sum EXACTLY to Amazon's own payout        (0 differing)
     39 of 39 agree on EVERY pivoted column                   (0 mismatches)
        product_sales · shipping_credits · promotional_rebates · gst_before_tcs
        tcs_cgst · tcs_sgst · tcs_igst · tds_194o · selling_fees · fba_fees
        other_transaction_fees · other
      4 settlements were SKIPPED rather than written, because their financial
        event group fell outside the window and so could not be proved.

   It used to get 1 of 10 right. Four faults, each found by measurement:

   1. THE ROLLUP FILTER DISCARDED REAL MONEY. The code assumed Amazon serves
      each amount twice, rollup and detail. It does not - the sum of every leaf
      equals the transactions' own totalAmount to the paisa. `leaves()` only
      emits childless nodes, so a true rollup is never emitted anyway; the
      filter was deleting the FLAT form ("Sales > ProductCharges" with nothing
      under it), which is the only record of that money. 1,72,585.81 lost on
      one settlement.
   2. A Transfer transaction IS THE PAYOUT, not a part of it. Its single leaf
      is Sales > FundTransfer for the whole settlement. Counting it roughly
      doubled the file.
   3. THE ITEM TREE AND THE TRANSACTION TREE ARE THE SAME MONEY, TWICE. Each
      sums to the payout on its own. Walking both - which fault 1 had been
      masking - doubled every file again. Item level wins, because only it
      carries the SKU.
   4. THE COLUMNS WERE WRONG EVEN WHEN THE TOTAL WAS RIGHT. Every fee was
      written as "AmazonFees", so 17,024.62 of FBA removal and storage landed
      in other_transaction_fees and fba_fees read nil; discounts were written
      as ItemPrice/"Promotion Principal", so the pivot banked them as product
      sales and promotional_rebates read nil. The files tied to the payout
      throughout, which is why this never surfaced as an error.

   THE GUARD THAT MAKES THAT STAY TRUE: a file is now written ONLY if it sums
   to Amazon's own OriginalTotal for that settlement. Anything that does not
   tie is reported and skipped, never written half-right.

   Re-verify after any change with:
     LEDGER_OUT=/tmp/regen node scripts/pull-settlements.js \
        --from 2025-04-01 --to 2025-04-30 --finances
   then diff each file's amount column, and its pivoted columns, against
   "Input - Settelemnt Bank report". Both must come back zero.
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
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ── breakdown leaf → the flat file's (amount-type, amount-description) ───────
   Amazon returns the SAME money twice: once as a rollup (Sales > ProductCharges,
   Expenses > TaxDeductedAtSource) and once as detail (ProductCharges >
   OurPricePrincipal, Commission > Base). Taking both doubles every rupee, so
   only the detail side is mapped and the rollups are listed as ignored - by
   name, so an unmapped leaf is loud rather than silently dropped. */
/* THERE IS NO DOUBLE COUNTING. Measured on settlement 24587771722: the sum of
   every leaf equals the sum of the transactions' own totalAmount, 144,334.70,
   to the paisa - so nothing is served twice, and no leaf may be discarded.
   `leaves()` only ever emits a node with NO children, so a true rollup (one
   that has a detail level under it) is never emitted in the first place; the
   recursion already handles it. The old ROLLUPS set therefore did not remove
   duplicates, it removed the FLAT form - "Sales > ProductCharges" with nothing
   nested beneath - which is the only record of that money. It threw away
   1,72,585.81 on that one settlement and left every file short.
   Checked across 25 April-2025 settlements: no transaction ever emits both the
   flat and the nested form, so there is nothing to de-duplicate. */
const MAP = {
  'ProductCharges>OurPricePrincipal': ['ItemPrice', 'Principal'],
  'Tax>OurPriceTax':                  ['ItemPrice', 'Product Tax'],
  'Shipping>ShippingPrincipal':       ['ItemPrice', 'ShippingPrincipal'],
  'Tax>ShippingTax':                  ['ItemPrice', 'ShippingTax'],
  /* A DISCOUNT IS NOT AN ItemPrice LINE IN AMAZON'S FILE. It writes the two
     cash discounts as other-transaction and only their TAX under ItemPrice.
     Written as ItemPrice/"Promotion Principal" - which is what this did - the
     downstream pivot reads "principal" and banks it as PRODUCT SALES, so the
     revenue is overstated and promotional_rebates comes out nil. */
  'PromoRebates>OurPriceDiscount':    ['other-transaction', 'OurPriceDiscount'],
  'PromoRebates>ShippingDiscount':    ['other-transaction', 'ShippingDiscount'],
  'Tax>OurPriceTaxDiscount':          ['ItemPrice', 'OurPriceTaxDiscount'],
  'Tax>ShippingTaxDiscount':          ['ItemPrice', 'ShippingTaxDiscount'],
  'TaxWithholding>ItemTDS':           ['ItemTDS',   'TDS (Section 194-O)'],
  'TaxCollectedAtSource>TCS-IGST':    ['ItemTCS',   'TCS-IGST'],
  'TaxCollectedAtSource>TCS-CGST':    ['ItemTCS',   'TCS-CGST'],
  'TaxCollectedAtSource>TCS-SGST':    ['ItemTCS',   'TCS-SGST'],
};
/* The FLAT form, where Amazon hangs the money straight off Sales / Expenses
   with no detail level under it. Derived by joining the API's leaves back to
   Amazon's own flat file on (order-id, amount) for settlement 24587771722 and
   taking the amount-type / amount-description Amazon itself used. */
Object.assign(MAP, {
  'Sales>ProductCharges':                 ['ItemPrice', 'Principal'],
  'Sales>Tax':                            ['ItemPrice', 'Product Tax'],
  'Sales>Shipping':                       ['ItemPrice', 'ShippingPrincipal'],
  'Sales>FulfillmentFeeRefund':           ['ItemFees',  'FulfillmentFeeRefund'],
  'Refunded Sales>ProductCharges':        ['ItemPrice', 'Principal'],
  'Refunded Sales>Tax':                   ['ItemPrice', 'Product Tax'],
  'Refunded Sales>Shipping':              ['ItemPrice', 'ShippingPrincipal'],
  'Refunded Sales>AmazonFees':            ['ItemFees',  'AmazonFees'],
  'Expenses>AmazonFees':                  ['ItemFees',  'AmazonFees'],
  'Expenses>TaxDeductedAtSource':         ['ItemTDS',   'TDS (Section 194-O)'],
  /* the API serves TCS as ONE leaf; the flat file splits it IGST / CGST / SGST
     by where the order shipped. The split is not in the transactions payload,
     so it is written as IGST and the TOTAL is right - which is what the ledger
     reads, since it sums the three. */
  'Expenses>TaxCollectedAtSource':        ['ItemTCS',   'TCS-IGST'],
  'Refunded Expenses>TaxCollectedAtSource': ['ItemTCS', 'TCS-IGST'],
  'Refunded Expenses>AmazonFees':         ['ItemFees',  'AmazonFees'],
  'Expenses>PromoRebates':                ['other-transaction', 'OurPriceDiscount'],
  'Refunded Expenses>PromoRebates':       ['other-transaction', 'OurPriceDiscount'],
  'Tax>PaymentMethodFeeTax':              ['ItemPrice', 'PaymentMethodFeeTax'],
  'Other>PaymentMethodFeePrincipal':      ['other-transaction', 'PaymentMethodFeePrincipal'],
  'Expenses>CrossAccountDebtAdjustment':  ['other-transaction', 'CrossAccountGroupDebtOffset'],
});

/* Every fee arrives as Base + Tax under the fee's own name. Amazon then writes
   MOST of them under one description, "AmazonFees" - commission, closing fee,
   FBA per-unit and weight-based all land there, verified by joining the API's
   leaves back to its own file. But three keep a name of their own, and that
   name is the ONLY thing telling the downstream pivot an FBA fee from any
   other: it buckets on the description containing "fba". Collapsing every fee
   to "AmazonFees" put the whole 17,024.62 of FBA removal and storage into
   other_transaction_fees and left fba_fees at zero. The fee TOTAL was right
   either way, so nothing downstream complained. */
const FEE_DESC = {
  FBARemovalFee:  'FBARemoval',
  FBAStorageFee:  'FBAStorageBilling',
  StorageBillingFee: 'FBAStorageBilling',
  OrderCancellationCharge: 'OrderCancellationCharge',
};
const FEES = ['Commission', 'FixedClosingFee', 'RefundCommission', 'FBAPerUnitFulfillmentFee',
  'FBAWeightBasedFee', 'FBAStorageFee', 'FBARemovalFee', 'ShippingChargeback',
  'OrderCancellationCharge', 'StorageBillingFee'];
for (const f of FEES) {
  const d = FEE_DESC[f] || 'AmazonFees';
  MAP[`${f}>Base`] = ['ItemFees', d];
  MAP[`${f}>Tax`]  = ['ItemFees', `${d} IGST`];
}

const unmapped = new Map();
function leaves(nodes, parent, out) {
  for (const n of nodes || []) {
    const kids = n.breakdowns || [];
    if (kids.length) { leaves(kids, n.breakdownType, out); continue; }
    const key = `${parent}>${n.breakdownType}`;
    const m = MAP[key];
    if (m) {
      out.push({ type: m[0], desc: m[1], amount: n.breakdownAmount?.currencyAmount ?? 0 });
      continue;
    }
    /* A leaf we have no column for is still money. Write it under its own
       name so the file keeps summing to the payout, and NAME it at the end so
       the mapping can be extended. Dropping it is how the file silently went
       short before. */
    out.push({ type: 'other-transaction', desc: n.breakdownType,
               amount: n.breakdownAmount?.currencyAmount ?? 0 });
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
    /* Widened by 10 days either side. A settlement that PAYS inside the window
       can have STARTED before it, and the group carries the payout and the
       opening balance - without the group a file is written with an empty
       total-amount and no "Balance brought forward", which is how four April
       files came out unverifiable. */
    const q = { FinancialEventGroupStartedAfter: new Date(new Date(FROM).getTime() - 10 * 864e5).toISOString(),
                FinancialEventGroupStartedBefore: new Date(new Date(TO).getTime() + 10 * 864e5).toISOString(),
                MaxResultsPerPage: 100 };
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

  let written = 0, skipped = 0, unverified = 0;
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
      /* A Transfer transaction is Amazon RECORDING THE PAYOUT ITSELF - its one
         leaf is Sales > FundTransfer for the whole settlement amount. It is
         not a component of the payout, it IS the payout, so counting it makes
         the file sum to roughly twice the money that moved. On 24587771722:
         released transactions 1,44,334.70, less this transfer of 18,841.63,
         equals Amazon's own 1,25,493.07 exactly. */
      if (t.transactionType === 'Transfer') continue;
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
      /* THE ITEM TREE AND THE TRANSACTION TREE ARE THE SAME MONEY, TWICE.
         Measured on 24587771722: t.breakdowns sums to 1,25,493.07 on its own,
         and items[].breakdowns plus the transactions that have no items sums
         to 1,25,493.07 as well. Both are complete. Walking both - which this
         did, masked by the old rollup filter dropping one side - writes every
         rupee twice and doubles the file.
         Item level is preferred because only it carries the SKU, exactly as
         Amazon's own flat file does; the transaction tree is the fallback for
         an Adjustment or a ServiceFee, which has no items at all. */
      const items = t.items || [];
      if (items.length) {
        for (const it of items) {
          const out = [];
          leaves(it.breakdowns, '(item)', out);
          for (const l of out) {
            rows.push({ ...base, sku: it.sku || '', 'amount-type': l.type,
                        'amount-description': l.desc, amount: money(l.amount) });
          }
        }
      } else {
        const txOut = [];
        leaves(t.breakdowns, '(txn)', txOut);
        for (const l of txOut) {
          rows.push({ ...base, 'amount-type': l.type, 'amount-description': l.desc, amount: money(l.amount) });
        }
      }
    }

    /* ── THE FILE MUST SUM TO AMAZON'S OWN PAYOUT, OR IT IS NOT WRITTEN ────
       Amazon's real flat files sum exactly to their total-amount. That is the
       one check that catches every class of fault this script has had - a
       dropped leaf, a double-counted tree, a missing opening balance - so it
       is enforced here rather than left to whoever reads the file later. A
       settlement that cannot be proved is REPORTED AND SKIPPED, never written
       half-right. */
    const payout = g.OriginalTotal?.CurrencyAmount;
    if (payout === undefined || payout === null) {
      console.log(`  SKIP ${sid}  no financial event group found - cannot verify, not written`);
      unverified += 1; continue;
    }
    const built = r2(rows.slice(1).reduce((a, r) => a + (Number(r.amount) || 0), 0));
    if (Math.abs(built - r2(payout)) > 0.01) {
      console.log(`  SKIP ${sid}  builds to ${built.toFixed(2)} but Amazon paid ${Number(payout).toFixed(2)}`
                + `  (short ${(r2(payout) - built).toFixed(2)}) - not written`);
      unverified += 1; continue;
    }

    if (DRY) { console.log(`  would write ${name}  ${rows.length - 1} rows  ties to ${built.toFixed(2)}`); written += 1; continue; }
    const tsv = [COLS.join('\t'), ...rows.map((r) => COLS.map((c) => r[c] ?? '').join('\t'))].join('\n');
    fs.writeFileSync(dest, `${tsv}\n`);
    console.log(`  ${name}  ${rows.length - 1} rows`);
    written += 1;
  }
  console.log(`\n${written} written (each ties to Amazon's own payout), ${skipped} already on disk`
            + (unverified ? `, ${unverified} SKIPPED as unverifiable` : ''));
  if (unmapped.size) {
    console.log('\nUNMAPPED breakdown types - the money IS written, under the type\'s own\n'
              + 'name, and the files still tie. Add them to MAP for a tidier column:');
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

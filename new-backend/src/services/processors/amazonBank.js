/* ── Bank — when the money actually ARRIVED ───────────────────────────────
   Every other tab stops at "Amazon released it". This one asks the question
   after that: did it reach the bank, and if not, who is holding it?

   RELEASED IS NOT BANKED. `Transaction Release Date` is when Amazon let the
   money go; the sweep lands a day or two later, and a week's payout can be
   withheld entirely. Over 17 months the two agree to 2.22%, which is exactly
   why a month looks reconciled while the bank disagrees.

   ONLY THE RETAINED SETTLEMENT LEDGER CAN ANSWER THIS. The unified
   transaction report has no deposit date and no reserve - the words do not
   appear in it. The ledger carries `deposit-date`, `total-amount` (the payout
   actually sent) and, as `amount-type=other-transaction`, Amazon's own
   `Current Reserve Amount` / `Previous Reserve Amount Balance` lines. So this
   view exists for the months whose ledgers are held and says so plainly for
   the rest, rather than estimating.

   THE MONEY IN A MONTH IS MOSTLY THE PREVIOUS MONTH'S. Of the 2,51,925.35
   banked in July 2026, only 84,016.15 was July's own sales - 1,70,085.00 was
   June's, swept in on 5 July. A cohort figure and a cash figure must never be
   put side by side without saying which is which; that mistake was made twice
   while this report was being built. Every panel here names its basis. */

const fs = require('fs');
const path = require('path');
const { monthKey, num, r2 } = require('./amazonThreeWay');

const RESERVE_HELD = 'Current Reserve Amount';
const RESERVE_BACK = 'Previous Reserve Amount Balance';

/* The ledger writes dates as DD.MM.YYYY hh:mm:ss UTC, which monthKey's
   DD-MM-YYYY branch does not reach. Normalised here rather than widening
   monthKey, whose every branch is load-bearing for another file. */
function ledgerDate(s) {
  const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
const ledgerMonth = (s) => ledgerDate(s).slice(0, 7);

function parseTsv(buf) {
  const lines = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  if (!lines.length) return [];
  const head = lines[0].split('\t').map((h) => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = lines[i].split('\t');
    const o = {};
    head.forEach((h, j) => { o[h] = (c[j] || '').trim(); });
    out.push(o);
  }
  return out;
}

/* One settlement = one bank deposit. Amazon re-issues the same settlement in
   more than one file (12 Jul's 423.65 arrives twice in Koparo's folder), so
   they are folded by settlement id or the deposit is counted twice.

   `dirs` may be several directories. They are read IN ORDER and the first copy
   of a settlement wins, so the caller puts the directory it trusts most first:
   files Amazon itself produced ahead of ones rebuilt from the Finances API.
   The two were proved identical on all 21 settlements held both ways - same
   payout, same deposit date, no per-order difference - but when they ever
   disagree the real file should be the one that is believed. */
function readSettlements(dirs) {
  const list = Array.isArray(dirs) ? dirs : [dirs];
  const files = [];
  for (const d of list) {
    if (!d) continue;
    try {
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.tsv')).sort()) {
        files.push(path.join(d, f));
      }
    } catch { /* a directory that is not there is simply a source we lack */ }
  }

  const byId = new Map();
  for (const f of files) {
    let rows;
    try { rows = parseTsv(fs.readFileSync(f)); } catch { continue; }
    const head = rows.find((r) => r['settlement-id'] && r['deposit-date']);
    if (!head) continue;
    const id = head['settlement-id'];
    if (byId.has(id)) continue;

    let reserveHeld = 0, reserveBack = 0, orderMoney = 0, refunds = 0;
    const bySaleMonth = new Map();
    const orders = new Set();
    for (const r of rows) {
      const desc = (r['amount-description'] || '').trim();
      const amt = num(r.amount);
      if (desc === RESERVE_HELD) { reserveHeld += amt; continue; }
      if (desc === RESERVE_BACK) { reserveBack += amt; continue; }
      const oid = (r['order-id'] || '').trim();
      if (oid) orders.add(oid);
      if (amt < 0 && /refund/i.test(r['transaction-type'] || '')) refunds += amt;
      orderMoney += amt;
      /* posted-date is the day the LINE was written; which month's SALE it
         belongs to is resolved by the caller from the order report, because
         the ledger has no purchase date at all. */
      if (oid) {
        const cur = bySaleMonth.get(oid) || 0;
        bySaleMonth.set(oid, r2(cur + amt));
      }
    }

    /* Everything in the payout that no order id claims: balances brought
       forward, service fees billed to the account rather than an order, debt
       adjustments. Without this, panel 2 splits only the order-tagged rows and
       its parts overshoot the deposit - April 2025 added to 4.63 lakh against
       3.64 lakh actually banked. */
    const claimed = [...bySaleMonth.values()].reduce((a, v) => a + v, 0);

    byId.set(id, {
      id,
      start: ledgerDate(head['settlement-start-date']),
      end: ledgerDate(head['settlement-end-date']),
      deposit: ledgerDate(head['deposit-date']),
      depositMonth: ledgerMonth(head['deposit-date']),
      payout: num(head['total-amount']),
      reserveHeld: r2(-reserveHeld),   // Amazon writes the hold as a negative
      reserveBack: r2(reserveBack),
      refunds: r2(refunds),
      rows: rows.length,
      orders: orders.size,
      perOrder: bySaleMonth,
      unassigned: r2(num(head['total-amount']) - claimed),
      file: path.basename(f),
    });
  }
  return [...byId.values()].sort((a, b) => (a.deposit < b.deposit ? -1 : 1));
}

/* ── build, for ONE month ─────────────────────────────────────────────────
   Deliberately a single month: the bank question is asked of a statement
   period, and a 17-month roll-up of deposits answers nothing an accountant
   would act on. The month comes from the period picker. */
function build(src, month, opts = {}) {
  const dir = opts.ledgerDir;
  if (!dir || !month) return null;

  const settlements = opts.settlements || readSettlements(dir);
  if (!settlements.length) return { month, hasLedgers: false, settlements: [] };

  /* Which month an order SOLD in - the ledger cannot say, so the order report
     does. Koparo books on the order date. */
  const saleOf = new Map();
  for (const r of src.orders || []) {
    const id = String(r['amazon-order-id'] || '').trim();
    if (!id || saleOf.has(id)) continue;
    const m = monthKey(r['purchase-date']);
    if (m) saleOf.set(id, m);
  }

  const inMonth = settlements.filter((s) => s.depositMonth === month);
  const banked = r2(inMonth.reduce((a, s) => a + s.payout, 0));

  /* Panel 2: of the money that reached the bank this month, whose sale was it
     for? This is the line that stops a cash figure being read as a cohort
     one. */
  const whose = new Map();
  let noOrder = 0;
  /* An order the settlement names but the ORDER REPORT does not hold is a very
     different thing from a fee with no order id, and lumping the two together
     hid 2.27 lakh of April 2025 under the word "fees". Koparo's order reports
     start in April 2025, so every March sale that settled in April lands here.
     It is reported separately, with the settlement WEEKS it came from, because
     that is the honest answer: we can say where the money came from without
     inventing a sale month for it. */
  const ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;
  let unknown = 0, unknownOrders = 0;
  const unknownBy = new Map();
  for (const s of inMonth) {
    noOrder = r2(noOrder + (s.unassigned || 0));
    for (const [oid, amt] of s.perOrder) {
      const sm = saleOf.get(oid);
      if (!sm) {
        if (!ORDER_ID.test(oid)) { noOrder = r2(noOrder + amt); continue; }
        unknown = r2(unknown + amt);
        unknownOrders += 1;
        const k = `${s.start}|${s.end}`;
        const cur = unknownBy.get(k) || { start: s.start, end: s.end, amount: 0, orders: 0 };
        cur.amount = r2(cur.amount + amt);
        cur.orders += 1;
        unknownBy.set(k, cur);
        continue;
      }
      const cur = whose.get(sm) || { month: sm, amount: 0, orders: 0 };
      cur.amount = r2(cur.amount + amt);
      cur.orders += 1;
      whose.set(sm, cur);
    }
  }
  const whoseList = [...whose.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  const ownBanked = r2((whose.get(month) || { amount: 0 }).amount);

  /* Panel 1 comes from the ledger the rest of the report already built - the
     cohort side - so the two cannot drift apart. */
  const pm = (opts.perMonth || []).find((p) => p.month === month) || null;
  const sold = pm ? r2(pm.invoiced && pm.invoiced.amount) : null;
  const owed = pm ? r2(pm.expected && pm.expected.amount) : null;
  const released = pm ? r2(pm.received && pm.received.amount) : null;
  const notReleased = pm && owed !== null && released !== null ? r2(owed - released) : null;

  /* Panel 4: the reserve. A week can release money and pay nothing - Amazon
     holds all of it, then returns it in the next statement. */
  const reserveWeeks = settlements
    .filter((s) => s.reserveHeld || s.reserveBack)
    .map((s) => ({ id: s.id, start: s.start, end: s.end, deposit: s.deposit,
                   held: s.reserveHeld, returned: s.reserveBack, payout: r2(s.payout) }));
  /* `end` and `depositMonth` are ALREADY normalised to ISO by readSettlements -
     running ledgerMonth over them again matched nothing (its regex wants
     DD.MM.YYYY) and the reserve silently read as zero on every panel while the
     week-by-week table below showed it correctly. Slice the ISO date instead.
     The hold belongs to the month the settlement period ENDED in: the 24-31 Jul
     week is July's money, even though its deposit is dated 2 August. */
  const heldThisMonth = r2(settlements
    .filter((s) => String(s.end || '').slice(0, 7) === month)
    .reduce((a, s) => a + s.reserveHeld, 0));

  /* Panel 3: released on this month's sales, less what actually landed inside
     the month, is money in transit at month end - and the reserve is the
     named part of it. */
  const inTransit = released !== null ? r2(released - ownBanked) : null;

  return {
    month,
    hasLedgers: true,
    cohort: { sold, owed, released, notReleased, heldAsReserve: heldThisMonth },
    bank: {
      banked,
      deposits: inMonth.length,
      whose: whoseList,
      noOrder: r2(noOrder),
      unknown: unknownOrders ? {
        amount: r2(unknown),
        orders: unknownOrders,
        byPeriod: [...unknownBy.values()].sort((a, b) => (a.start < b.start ? -1 : 1)),
      } : null,
      own: ownBanked,
    },
    transit: inTransit === null ? null : {
      released, ownBanked, inTransit,
      reserve: heldThisMonth,
      lag: r2(inTransit - heldThisMonth),
    },
    reserveWeeks,
    settlements: settlements.map((s) => ({
      id: s.id, start: s.start, end: s.end, deposit: s.deposit,
      released: r2(s.payout + s.reserveHeld - s.reserveBack),
      reserve: s.reserveHeld, payout: r2(s.payout),
      rows: s.rows, orders: s.orders,
      inMonth: s.depositMonth === month,
    })),
    coverage: {
      settlements: settlements.length,
      from: settlements[0] && settlements[0].deposit,
      to: settlements[settlements.length - 1] && settlements[settlements.length - 1].deposit,
    },
  };
}

/* Build every month in the window that actually has a deposit, keyed by month,
   so the period picker can switch between them without a rebuild. A month with
   no ledger is left out rather than returned empty - the view then says which
   months CAN be answered instead of showing a blank panel. */
function buildAll(src, months, opts = {}) {
  const dir = opts.ledgerDir;
  if (!dir) return null;
  /* Read once and hand the parsed settlements to every month. Re-reading 156
     files per month turned a 0.2s leg into a 30s one. */
  const settlements = readSettlements(dir);
  const have = new Set(settlements.map((s) => s.depositMonth));
  const byMonth = {};
  for (const m of months) {
    if (!have.has(m)) continue;
    const one = build(src, m, { ...opts, settlements });
    if (one && one.hasLedgers) byMonth[m] = one;
  }
  return {
    byMonth,
    available: Object.keys(byMonth).sort(),
    held: settlements.length,
    from: settlements[0] && settlements[0].deposit,
    to: settlements[settlements.length - 1] && settlements[settlements.length - 1].deposit,
  };
}

module.exports = { build, buildAll, readSettlements, ledgerDate, ledgerMonth };

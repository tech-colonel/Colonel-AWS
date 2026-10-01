/* ──────────────────────────────────────────────────────────────────────────────
   amazonReceivablesAudit.js — what is wrong with this ledger, and what would fix it.

   A receivables report that quietly balances is worth less than one that says
   "this month is out by 23,252, here is the line I suspect, and here is what
   you would have to look at to settle it". The accountant can act on the second.
   The first just has to be trusted.

   So every check here returns three things beyond the number: WHAT is wrong,
   WHY it happens, and HOW to resolve it — in words an accountant can act on or
   hand back as "no, the cause is X". Each one also names the orders behind it,
   because a figure nobody can drill into is a figure nobody can argue with.

   Severity is about money and trust, not tidiness:
     blocker  the month cannot be relied on as it stands
     warning  real, bounded, and explainable — act when convenient
     info     expected behaviour worth stating so nobody mistakes it for a fault
   ────────────────────────────────────────────────────────────────────────────── */

const r2 = (n) => Number((n || 0).toFixed(2));
const money = (n) => (n < 0 ? '-' : '') + Math.abs(r2(n)).toLocaleString('en-IN',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * @param ledger   the result of buildLedger
 * @param context  { sources: { '2026-06': 'unified report', … }, coverage: {…} }
 */
function auditLedger(ledger, context = {}) {
  const issues = [];
  const src = context.sources || {};
  const add = (i) => issues.push({ id: `${i.month || 'all'}:${i.key}`, ...i });

  for (const m of ledger.perMonth) {
    /* ── 1. received more than was due ─────────────────────────────────────
       The hardest signal there is: you cannot collect more than you billed.
       Either a receipt is counted twice, or a deduction is overstated. */
    if (m.closing.amount < -1) {
      const over = Math.abs(m.closing.amount);
      const pct = m.expected.amount ? (100 * over / m.expected.amount) : 0;
      add({
        key: 'over-collected', month: m.month, severity: 'blocker',
        title: `${m.month} shows ${money(over)} MORE received than was due`,
        amount: r2(-over), count: 0,
        what: `Due from Amazon was ${money(m.expected.amount)} but ${money(m.settled.amount)} `
            + `has been received against the same orders — ${pct.toFixed(1)}% more than was billed. `
            + 'An order cannot pay more than it was invoiced, so something here is counted twice '
            + 'or a deduction is understated.',
        why: src[m.month] === 'unified'
          ? 'This month is reconstructed from Amazon’s unified transaction report rather than the '
            + 'raw settlement ledgers, because the ledgers for it are past Amazon’s 90-day window. '
            + 'The unified report merges Amazon’s fee columns, so a fee that belongs to the seller '
            + 'cannot always be told apart from a pass-through.'
          : 'Receipts for these orders appear in more than one settlement source, or a fee column is '
            + 'being read as a cost when it is a pass-through.',
        howToFix: 'Pick any order on the drill-down whose receipt exceeds its invoice and trace it in '
                + 'Seller Central → Payments. If the payment is genuinely single, the fault is in a '
                + 'fee column and we correct the mapping. If it appears twice, the two sources overlap '
                + 'and we tighten the de-duplication.',
        drill: 'overCollected',
      });
    }

    /* ── 2. still outstanding ─────────────────────────────────────────────
       Expected at the tail of a month, alarming when it is old. */
    /* The residual: due less received. Real money, independent of how many
       orders have no settlement row. */
    if (Math.abs(m.closing.amount) > 1) {
      const isLatest = m.month === ledger.months[ledger.months.length - 1];
      add({
        key: 'outstanding', month: m.month,
        severity: isLatest ? 'info' : 'warning',
        title: `${m.month}: ${money(m.closing.amount)} of this month’s invoices not yet received`,
        amount: m.closing.amount, count: m.unpaidOrders ? m.unpaidOrders.count : m.closing.count,
        what: `Due from Amazon was ${money(m.expected.amount)} and ${money(m.settled.amount)} has `
            + `arrived, leaving ${money(m.closing.amount)}. Separately, `
            + `${m.unpaidOrders ? m.unpaidOrders.count : 0} order(s) have no settlement row at all, `
            + `worth ${money(m.unpaidOrders ? m.unpaidOrders.amount : 0)} — the shortfall is mostly `
            + 'part-settlements, not whole orders missing.',
        why: isLatest
          ? 'Amazon settles about every seven days, so the end of the most recent month always settles '
            + 'in the month after. This is the normal tail, not a loss.'
          : 'A month this old should have settled by now. Either the settlement covering it has not been '
            + 'loaded, or Amazon is holding the money.',
        howToFix: isLatest
          ? 'Nothing to do. Load the next month’s settlement and these will clear.'
          : 'Check whether a settlement covering this period is missing from the sources, then look for '
            + 'the orders in Seller Central → Payments to see if Amazon is withholding them.',
        drill: 'outstanding',
      });
    }

    /* ── 3. a fee line wildly out of line with its neighbours ─────────────
       The thing that is quietly wrong for months before anyone notices. */
    const others = ledger.perMonth.filter((x) => x.month !== m.month && x.invoiced.amount > 0);
    if (others.length && m.invoiced.amount > 0) {
      const rate = m.fees.amount / m.invoiced.amount;
      const peer = others.reduce((a, x) => a + x.fees.amount / x.invoiced.amount, 0) / others.length;
      if (peer > 0 && rate > peer * 1.8) {
        add({
          key: 'fee-outlier', month: m.month, severity: 'warning',
          title: `${m.month}: Amazon fees are ${(rate * 100).toFixed(1)}% of sales against `
               + `${(peer * 100).toFixed(1)}% in the other months`,
          amount: r2(m.fees.amount - m.invoiced.amount * peer), count: m.fees.count,
          what: `Fees of ${money(m.fees.amount)} on ${money(m.invoiced.amount)} of sales. At the rate the `
              + `other months run, this month would be about ${money(m.invoiced.amount * peer)}.`,
          why: 'Either Amazon genuinely charged more this month, or a column is being counted as a fee '
             + 'that is not one. Pass-through amounts sitting in "other transaction fees" are the usual '
             + 'cause, and they are indistinguishable from real fees in the unified report.',
          howToFix: 'Compare this month against Amazon’s own fee tax invoices for the same period. '
                  + 'If the invoices are lower, the extra is not a seller fee and we exclude it.',
          drill: 'fees',
        });
      }
    }
  }

  /* ── 4. where each month came from, and what that costs ────────────────── */
  for (const [month, kind] of Object.entries(src)) {
    if (kind !== 'unified') continue;
    add({
      key: 'source-unified', month, severity: 'info',
      title: `${month} is rebuilt from the unified transaction report, not raw settlements`,
      amount: 0, count: 0,
      what: 'The raw settlement ledgers for this month are past Amazon’s 90-day API window and cannot '
          + 'be fetched again. The unified transaction report recovers the month, but merges Amazon’s '
          + 'fee columns.',
      why: 'The SP-API serves settlement reports for 90 days and then refuses them outright. Any month '
         + 'not pulled inside that window can only be recovered this way.',
      howToFix: 'Nothing for this month. The weekly settlement pull now in place stops it happening again; '
              + 'if a fee-level breakdown is ever needed for this month, it is not recoverable.',
      drill: null,
    });
  }

  const blockers = issues.filter((i) => i.severity === 'blocker');
  return {
    issues,
    verdict: blockers.length
      ? `${blockers.length} month(s) cannot be relied on as they stand`
      : 'Every month reconciles within tolerance',
    counts: {
      blocker: blockers.length,
      warning: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
    },
  };
}

/** The orders behind an issue, so every figure can be argued with. */
function drillFor(ledger, issue) {
  const rows = ledger.rows.filter((r) => !issue.month || r.month === issue.month);
  switch (issue.drill) {
    case 'overCollected':
      return rows.filter((r) => r.settled > r.invoiced + 0.01)
        .sort((a, b) => (b.settled - b.invoiced) - (a.settled - a.invoiced));
    case 'outstanding':
      return rows.filter((r) => r.status === 'Outstanding')
        .sort((a, b) => b.invoiced - a.invoiced);
    case 'fees':
      return rows.filter((r) => r.fees > 0).sort((a, b) => b.fees - a.fees);
    default:
      return [];
  }
}

module.exports = { auditLedger, drillFor };

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
      /* A month end can legitimately hold more cash than the net receivable:
         Amazon pays for an order in June and takes the refund back only when the
         customer returns the goods in July. At 30 June the seller really was
         holding money it would later give back — an ADVANCE, not a
         reconciliation failure. The proof is that a later month carries the
         matching negative, so only call it a blocker when nothing explains it. */
      const explained = m.receivedLater && m.receivedLater.amount < -1;
      add({
        key: 'over-collected', month: m.month, severity: explained ? 'info' : 'blocker',
        title: explained
          ? `${m.month} held ${money(over)} at the month end for orders returned later`
          : `${m.month} shows ${money(over)} MORE received than was due`,
        amount: r2(-over), count: 0,
        what: `Amount due from Amazon on ${m.month} sales was ${money(m.expected.amount)}, but `
            + `${money(m.received.amount)} had been received by the month end — ${pct.toFixed(1)}% more `
            + 'than was billed.'
            + (explained
              ? ` Amazon took ${money(Math.abs(m.receivedLater.amount))} back in a later month, when the `
                + 'customers returned the goods.'
              : ' An order cannot pay more than it was invoiced, so something here is counted twice '
                + 'or a deduction is understated.'),
        why: explained
          ? 'Amazon pays for an order as soon as it ships and deducts the refund only when the goods come '
            + 'back. If the return happens in a later month, the month end shows cash in hand that will be '
            + 'given back. In the books this is an advance from customers, not income.'
          : src[m.month] === 'unified'
            ? 'This month is rebuilt from Amazon’s unified transaction report rather than the raw '
              + 'settlement files, because the files for it are past Amazon’s 90-day window. The unified '
              + 'report merges Amazon’s charge columns, so a charge cannot always be told apart from a '
              + 'pass-through.'
            : 'Payments for these orders appear in more than one settlement file, or a charge column is '
              + 'being read as a cost when it is a pass-through.',
        howToFix: explained
          ? 'No action needed. Carry it as an advance received against orders returned later — the next '
            + 'month’s refund entries clear it.'
          : 'Open any order in the drill-down where the receipt is more than the invoice and check it in '
            + 'Seller Central → Payments. If the payment is genuinely single, the fault is in a charge '
            + 'column. If it appears twice, two settlement files overlap.',
        drill: 'overCollected',
      });
    }

    /* ── 2. still outstanding ─────────────────────────────────────────────
       Expected at the tail of a month, alarming when it is old. */
    /* STILL OPEN TODAY, not the month-end closing balance. The closing balance
       is an accounting fact and needs no chasing — most of it is Amazon's weekly
       cycle and arrives in the next month. What deserves an issue is what is
       open AFTER every loaded file has had its say. */
    const open = m.stillOpen || m.closing;
    if (Math.abs(open.amount) > 1) {
      const isLatest = m.month === ledger.months[ledger.months.length - 1];
      add({
        key: 'outstanding', month: m.month,
        severity: isLatest ? 'info' : 'warning',
        title: `${m.month}: ${money(open.amount)} of this month’s sales is still not received`,
        amount: open.amount, count: open.count,
        what: `Amount due from Amazon on ${m.month} sales was ${money(m.expected.amount)}. `
            + `${money(m.received.amount)} came in by the month end, leaving `
            + `${money(m.closing.amount)} to carry forward. `
            + `${money(m.receivedLater ? m.receivedLater.amount : 0)} of that has since arrived in a later `
            + `month, so ${money(open.amount)} is still open. `
            + `${open.count} order(s) have no payment at all.`,
        why: isLatest
          ? 'Amazon pays about every seven days, so sales at the end of the most recent month are '
            + 'normally received in the following month. This is a timing difference, not a loss.'
          : 'A month this old should have been paid by now. Either the settlement file covering it has '
            + 'not been uploaded, or Amazon is holding the money.',
        howToFix: isLatest
          ? 'No action needed. Upload the next month’s settlement file and this will clear.'
          : 'Check whether a settlement file covering this period is missing, then look the orders up in '
            + 'Seller Central → Payments to see whether Amazon is holding them.',
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

  /* ── 4. refunds for sales made before this report's window ──────────────
     Amazon never restates a month it has already issued: a return on a May
     order turns up in the June file carrying its ORIGINAL May invoice date.
     Those rows belong to a month this report does not hold, so they cannot be
     set against any cohort here — but they are real money and must not vanish. */
  const ppr = context.priorPeriodRefunds || [];
  if (ppr.length) {
    const amt = r2(ppr.reduce((a, x) => a + x.amount, 0));
    add({
      key: 'prior-period-refunds', month: null, severity: 'warning',
      title: `${ppr.length} refund(s) worth ${money(amt)} belong to sales made before this period`,
      amount: amt, count: ppr.length,
      what: `These orders were invoiced before ${ledger.months[0]}, so this report has no sales figure to `
          + 'set them against. They are sitting in this period’s MTR files carrying their original '
          + 'invoice dates.',
      why: 'Amazon adds a return to the CURRENT month’s report with the ORIGINAL invoice date; it never '
         + 'goes back and amends the month that has already been issued.',
      howToFix: `Extend the report back to cover those months, or treat the ${money(amt)} as a `
              + 'prior-period adjustment in the month the file arrived.',
      drill: 'priorRefunds',
    });
  }

  /* ── 5. where each month came from, and what that costs ────────────────── */
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
      /* every order of the month whose receipts fall short of what it was due,
         not just the ones with no payment at all — a part settlement is exactly
         the case that used to be invisible */
      return rows.filter((r) => r2(r.invoiced - r.refunded - r.fees - r.tdsTcs - r.settled) > 0.01)
        .sort((a, b) => (b.invoiced - b.refunded - b.fees - b.tdsTcs - b.settled)
                      - (a.invoiced - a.refunded - a.fees - a.tdsTcs - a.settled));
    case 'fees':
      return rows.filter((r) => r.fees > 0).sort((a, b) => b.fees - a.fees);
    case 'priorRefunds':
      return (ledger.priorPeriodRefunds || []).map((x) => ({
        orderId: x.orderId, month: x.invoiceMonth || '—', status: 'Refund of an earlier sale',
        invoiced: 0, refunded: x.amount, fees: 0, tdsTcs: 0, settled: 0,
        settledMonth: '', foundInFile: x.foundInFile,
      }));
    default:
      return [];
  }
}

module.exports = { auditLedger, drillFor };

/* ──────────────────────────────────────────────────────────────────────────────
   Amazon Receivables — of everything we sold, what have we actually been paid for?

   Three files, read as a chain rather than three totals that ought to agree:

     order report   every order PLACED      the only one that knows about
                                            cancellations
     MTR            what was INVOICED       the base for the receivable, because
                                            it is the document actually issued
     settlement     what was PAID           lags: Amazon settles weekly, so the
                                            end of a month lands in the next one

   Then the money, month by month, as a cohort: June means June's INVOICES —
   what they were billed, what Amazon kept, and what has since arrived against
   them, whenever it arrived. That is what makes "May's 50,000 turned up in June"
   a balance rather than a hole in one month and a windfall in the next.

   THREE THINGS THIS PAGE INSISTS ON.

     The period is stated, never assumed. The report covers whichever months
     have all three files, and it says so beside the title — a receivables
     figure with no period on it is not a figure.

     One month at a time is the normal question. "What did August bill and what
     is still owed on it" is what an accountant actually asks; the whole range
     is the exception, not the default view. Hence the month filter, which
     drives every panel below it.

     Every figure names its source. Each drill opens with the file, the column
     and the filter that produced it, because an accountant checking a number
     needs to know which of the three files to open — and because a figure that
     cannot be traced is one that has to be taken on trust, which is worth much
     less than one that can be argued with.
   ────────────────────────────────────────────────────────────────────────────── */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  RefreshCw, Download, AlertTriangle, AlertCircle, Info, ChevronRight,
  Package, Receipt, Banknote, X, Loader2, ArrowLeft, CalendarRange,
  LayoutDashboard, Bot, FileSpreadsheet, Sigma, Clock, FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { sidebarFor } from '../../lib/adminNav';

/* ── formatting ─────────────────────────────────────────────────────────── */
const inr = (n, dp = 2) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('en-IN',
      { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const int = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMonth = (m) => {
  if (!m || !/^\d{4}-\d{2}$/.test(m)) return m || '—';
  const [y, mo] = m.split('-');
  return `${MON[+mo - 1]} ${y}`;
};
/* The period, spelled out. A range of one month is that month, not "Jun – Jun". */
const rangeLabel = (ms) => (!ms || !ms.length ? '—'
  : ms.length === 1 ? fmtMonth(ms[0]) : `${fmtMonth(ms[0])} – ${fmtMonth(ms[ms.length - 1])}`);
const pctOf = (a, b) => (!b ? 0 : (100 * a) / b);

/* How old is an unpaid month. Amazon settles weekly, so anything still open
   beyond about a month has stopped being a timing difference. */
const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0); };
const daysOld = (m) => Math.max(0, Math.floor((Date.now() - monthEnd(m).getTime()) / 86400000));
const ageBucket = (d) => (d <= 30 ? '0–30 days' : d <= 60 ? '31–60 days'
  : d <= 90 ? '61–90 days' : 'over 90 days');

/* The order statuses the ledger assigns. Mirrored from the backend's STATUS,
   and read from the payload when it is there so the two cannot drift. */
const FALLBACK_ST = {
  NOT_AMAZON: 'Not an Amazon sale (MCF)', SETTLED_IN_MONTH: 'Settled in the month',
  SETTLED_LATER: 'Settled in a later month', RETURNED: 'Returned / refunded',
  CANCELLED: 'Cancelled', OUTSTANDING: 'Outstanding',
};

/* ── where every figure comes from ───────────────────────────────────────────
   An accountant checking a number has to know which of the three files to open
   and what to filter it by. So each drill, and each step of the chain, carries
   its own provenance rather than leaving the reader to infer it from the title. */
const FILES = {
  order: { label: 'Order report', short: 'Order report', icon: Package, tone: '#7C3AED',
    how: 'Pulled from Amazon SP-API (all orders by order date). The only file that knows an order was cancelled.' },
  mtr: { label: 'MTR — Merchant Tax Report (B2B + B2C)', short: 'MTR', icon: Receipt, tone: '#0748EE',
    how: 'Uploaded from Seller Central. The tax invoice actually issued to the customer, and the base for this report.' },
  settlement: { label: 'Settlement', short: 'Settlement', icon: Banknote, tone: '#059669',
    how: 'Amazon’s settlement ledgers, or the unified transaction report where the ledgers have aged past the 90-day window.' },
  derived: { label: 'Derived', short: 'Derived', icon: Sigma, tone: '#475569',
    how: 'Arithmetic on the lines above. It has no file of its own — it is the subtraction, not a source.' },
};

const PROV = {
  /* the money lines */
  invoiced: { file: 'mtr', column: 'Invoice Amount', filter: 'Transaction Type = Shipment',
    dated: 'Invoice Date (Shipment Date is blank on most B2C rows, so it is read second)' },
  returned: { file: 'mtr', column: 'Invoice Amount', filter: 'Transaction Type = Refund',
    note: 'Refunds are negative in the MTR and are held positive here, as a deduction.' },
  netBillable: { file: 'derived', column: 'Invoiced − Returns' },
  fees: { file: 'settlement', column: 'selling fees + fba fees + other transaction fees',
    filter: 'every settlement row for the order',
    note: 'Accumulated signed, magnitude taken once at the end — a reversed fee is a credit, not another charge.' },
  tdsTcs: { file: 'settlement', column: 'TDS (Section 194-O) + TCS-CGST + TCS-SGST + TCS-IGST',
    note: 'Genuinely withheld by Amazon and paid to the government against your PAN.' },
  expected: { file: 'derived', column: 'Net billable − Amazon fees − TDS/TCS' },
  settled: { file: 'settlement', column: 'total',
    filter: 'every settlement row for the order, whatever month it landed in',
    note: 'Amazon states the payout per row and the parts foot to it exactly, so it is read rather than rebuilt from eight signed columns.' },
  closing: { file: 'derived', column: 'Due from Amazon − Received to date' },
  gstMemo: { file: 'mtr', column: 'Total Tax Amount',
    note: 'A memo, never a deduction. Amazon collects the full invoice and passes the GST across to you; you remit it onward.' },
  /* the chain */
  placed: { file: 'order', column: 'amazon-order-id', filter: 'every row, folded to one per order',
    dated: 'purchase-date, converted to IST' },
  cancelled: { file: 'order', column: 'order-status', filter: 'order-status = Cancelled on every line of the order' },
  net: { file: 'derived', column: 'Orders placed − cancelled' },
  chainInvoiced: { file: 'mtr', column: 'Order Id', filter: 'the order has at least one Shipment row' },
  chainSettled: { file: 'settlement', column: 'order id', filter: 'the order appears in any settlement, in any month' },
  chainUnsettled: { file: 'derived', column: 'Net orders that appear in no settlement at all' },
  status: { file: 'derived', column: 'order report status + MTR presence + settlement presence',
    note: 'Exactly one status applies to each order, so the rows sum to the orders invoiced and nothing can hide between them.' },
};

/* The waterfall. `sign` drives the sign column, `strong` marks a subtotal, and
   `what` is the plain-English note the sheet carries too — the same words in
   both places so nobody has to reconcile the explanation as well as the number. */
const LINES = [
  { key: 'invoiced',    label: 'Invoiced (incl GST)', sign: '+', prov: 'invoiced',
    what: 'What was billed to customers — the MTR invoice value.' },
  { key: 'returned',    label: 'Returns / refunds', sign: '−', prov: 'returned',
    what: 'Money given back on those orders.' },
  { key: 'netBillable', label: 'Net billable', sign: '=', strong: true, prov: 'netBillable',
    what: 'Invoiced less returns.' },
  { key: 'fees',        label: 'Amazon fees', sign: '−', prov: 'fees',
    what: 'Commission, closing fee, FBA, storage and the GST on them.' },
  { key: 'tdsTcs',      label: 'TDS 194-O / TCS', sign: '−', prov: 'tdsTcs',
    what: 'Withheld at source by Amazon and paid to the government for you.' },
  { key: 'expected',    label: 'Due from Amazon', sign: '=', strong: true, prov: 'expected',
    what: 'What Amazon owes on this month’s orders.' },
  { key: 'settled',     label: 'Received (to date)', sign: '−', prov: 'settled',
    what: 'What has arrived against them, whenever it arrived.' },
  { key: 'closing',     label: 'Still outstanding', sign: '=', strong: true, final: true, prov: 'closing',
    what: 'Not yet received. A NEGATIVE means more came in than was due.' },
];

const SEV = {
  blocker: { icon: AlertTriangle, bg: '#FEF2F2', border: '#FCA5A5', fg: '#991B1B', label: 'Blocker' },
  warning: { icon: AlertCircle,  bg: '#FFFBEB', border: '#FCD34D', fg: '#92400E', label: 'Warning' },
  info:    { icon: Info,         bg: '#F0F9FF', border: '#93C5FD', fg: '#1E40AF', label: 'For information' },
};

/* ════════════════════════════════════════════════════════════════════════ */

export default function AmazonReceivablesDashboard() {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState(null);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [drill, setDrill] = useState(null);
  /* '' means the whole period. A month key means that month alone. */
  const [sel, setSel] = useState('');

  /* The route carries only the brand. Find the agent once so the API path is
     the same shape every other agent uses. */
  useEffect(() => {
    api.get(`/api/brands/${brandId}/agents`)
      .then((r) => {
        const list = r.data?.agents || r.data || [];
        const a = list.find((x) => /receivab/i.test(x.name) && /amazon/i.test(x.name))
               || list.find((x) => /settlement.?amazon/i.test(x.name)) || list[0];
        setAgentId(a?.id || null);
      })
      .catch(() => setAgentId(null));
  }, [brandId]);

  const base = agentId ? `/api/brands/${brandId}/agents/${agentId}/amazon-receivables` : null;

  const load = useCallback(async () => {
    if (!base) return;
    setLoading(true);
    try {
      const [s, r] = await Promise.all([
        api.get(`${base}/status`).catch(() => ({ data: null })),
        api.get(`${base}/run`).catch(() => ({ data: { empty: true } })),
      ]);
      setStatus(s.data);
      setData(r.data && !r.data.empty ? r.data : null);
    } finally { setLoading(false); }
  }, [base]);

  useEffect(() => { if (base) load(); }, [base, load]);

  const run = async () => {
    if (!base) return;
    setRunning(true);
    try {
      const months = status?.suggestedMonths || ['2026-06', '2026-07', '2026-08'];
      const r = await api.post(`${base}/run`, { months });
      setData(r.data);
      toast.success(`Reconciled ${months.length} months in ${r.data.builtInMs} ms`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not run the reconciliation');
    } finally { setRunning(false); }
  };

  /* sidebarFor() builds the role's FULL menu — an accountant gets the same
     eleven items here as on every other agent page, an admin gets the admin
     menu, a brand executive gets their restricted two. Hand-rolling a short
     list, which is what the demo page did, silently dropped Statutory
     Compliance, Colonel AI, Meetings, Tasks and the rest, so this page alone
     looked like a different product.

     It belongs on EVERY state including loading: a shell that appears only once
     the data lands flickers the navigation away on each reload. */
  /* The labels must MATCH the base menu's own ("Dashboard", "Agents"), because
     sidebarFor merges by label: an unmatched label is appended as an extra
     item instead of overriding, so passing "All Agents" produced a second
     agents entry carrying the same testId and React warned about duplicate
     keys. Matching the label overrides the path with this brand's, which is
     the whole point of passing them. */
  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  const months = data?.ledger?.months || data?.months || [];
  /* One selection, read by every panel below. Filtering in one place is what
     stops the chain and the ledger ever describing different periods. */
  const shown = useMemo(
    () => (sel && months.includes(sel) ? [sel] : months), [sel, months]);

  if (loading) {
    return (
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="p-6 flex items-center gap-3 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading Amazon receivables…
        </div>
      </DashboardLayout>
    );
  }

  const allLedger = data?.ledger?.perMonth || [];
  const ledger = allLedger.filter((m) => shown.includes(m.month));
  const three = data?.three;
  const audit = data?.audit;
  const sources = (data?.sources || []).filter((s) => shown.includes(s.month));
  const ST = data?.ledger?.STATUS || FALLBACK_ST;

  const openDrill = (d) => setDrill({ months: shown, ...d });

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
    <div className="p-6 space-y-5 max-w-[1500px]">
      <button onClick={() => navigate(`/brands/${brandId}/reco`)}
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-blue-600 group transition-colors">
        <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
        Back to Reconciliation
      </button>

      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Order report · MTR · Settlement
          </div>
          <div className="flex items-center gap-3 flex-wrap mt-0.5">
            <h1 className="text-2xl font-bold text-slate-900">Amazon Receivables</h1>
            {/* THE PERIOD, on the face of the page. A receivables figure with no
                period against it is not a figure. */}
            {months.length > 0 && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
                               bg-slate-900 text-white text-xs font-semibold">
                <CalendarRange className="h-3.5 w-3.5" />
                {rangeLabel(months)}
                <span className="font-normal text-slate-300">
                  · {months.length} month{months.length > 1 ? 's' : ''}
                </span>
              </span>
            )}
            {data?.stale && (
              <span className="px-2 py-1 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold">
                Sources changed since this run
              </span>
            )}
          </div>
          <p className="text-sm text-slate-500 mt-1.5 max-w-3xl">
            Of everything sold, what has actually been paid for. Each month is its own cohort —
            the orders <strong>invoiced</strong> that month, what Amazon kept, and what has since
            arrived against them. <strong>The base is the MTR invoice value</strong>, because that
            is the document actually issued to the customer.
            {data?.builtAt && <span className="text-slate-400">
              {' '}Last reconciled {new Date(data.builtAt).toLocaleString('en-IN')}.
            </span>}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {data && <ExportButtons data={data} months={months} shown={shown} status={status} base={base} />}
          <button onClick={load}
                  className="px-3 py-2 text-sm font-medium rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center gap-2">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button onClick={run} disabled={running}
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-800 flex items-center gap-2 disabled:opacity-50">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {running ? 'Reconciling…' : 'Run reconciliation'}
          </button>
        </div>
      </div>

      {!data && (
        <>
          <SourcesPanel status={status} sources={[]} sourceKind={{}} />
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center">
            <p className="text-slate-600 font-medium">No reconciliation has been run yet.</p>
            <p className="text-sm text-slate-500 mt-1">
              Load the three sources, then press <strong>Run reconciliation</strong>.
            </p>
          </div>
        </>
      )}

      {data && <>
        {/* ── the period filter, before anything it governs ─────────────── */}
        <MonthFilter months={months} sel={sel} onSelect={setSel} ledger={allLedger} />

        {/* ── what an accountant opens the page for ─────────────────────── */}
        <Headline ledger={ledger} shown={shown} onDrill={openDrill} />

        {/* ── how old the unpaid money is ───────────────────────────────── */}
        <AgeingPanel ledger={ledger} onDrill={openDrill} />

        {/* ── the chain: order → MTR → settlement ───────────────────────── */}
        {three && <ThreeWayStrip three={three} shown={shown} onDrill={openDrill} />}

        {/* ── issues, before the numbers that depend on them ────────────── */}
        {audit?.issues?.length > 0 && (
          <IssuesPanel audit={audit} shown={shown}
                       onDrill={(i) => openDrill({ kind: 'issue', issue: i })} />
        )}

        {/* ── the ledger ────────────────────────────────────────────────── */}
        <LedgerTable ledger={ledger}
                     onDrill={(line, month) => setDrill({ kind: 'line', line, months: [month] })} />

        {/* ── closing status ────────────────────────────────────────────── */}
        <StatusTable ledger={ledger}
                     onDrill={(st, month) => setDrill({ kind: 'status', status: st, months: [month] })} />

        {/* ── the three files, stated last: this is the evidence, and it
               belongs where somebody checking a figure will look for it ─── */}
        <SourcesPanel status={status} sources={sources} sourceKind={data?.sourceKind || {}} />
      </>}

      {drill && <DrillPanel drill={drill} data={data} ST={ST} base={base}
                            onClose={() => setDrill(null)} />}
    </div>
    </DashboardLayout>
  );
}

/* ── the period filter ───────────────────────────────────────────────────────
   "What is still owed on August" is the question an accountant actually asks;
   the whole range is the exception. Each pill carries the month's own
   outstanding so the choice is informed before it is made. */
function MonthFilter({ months, sel, onSelect, ledger }) {
  const find = (m) => ledger.find((x) => x.month === m);
  const totalOut = ledger.reduce((a, m) => a + (m.closing?.amount || 0), 0);
  const Pill = ({ value, label, sub, out }) => {
    const on = sel === value;
    return (
      <button onClick={() => onSelect(value)}
              className={`px-3.5 py-2 rounded-lg border text-left transition-colors ${
                on ? 'border-slate-900 bg-slate-900 text-white'
                   : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'}`}>
        <div className="text-sm font-semibold leading-tight">{label}</div>
        <div className={`text-[11px] leading-tight mt-0.5 ${on ? 'text-slate-300' : 'text-slate-400'}`}>
          {sub}
          {Math.abs(out) > 1 && (
            <span className={on ? 'text-rose-300 font-semibold' : 'text-rose-600 font-semibold'}>
              {' '}· ₹{inr(out, 0)} open
            </span>
          )}
        </div>
      </button>
    );
  };
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs font-bold uppercase tracking-wider text-slate-400 mr-1">Period</span>
      <Pill value="" label={`All · ${rangeLabel(months)}`}
            sub={`${months.length} month${months.length > 1 ? 's' : ''}`} out={totalOut} />
      {months.map((m) => (
        <Pill key={m} value={m} label={fmtMonth(m)}
              sub={`${int(find(m)?.invoiced?.count ?? 0)} invoices`}
              out={find(m)?.closing?.amount || 0} />
      ))}
    </div>
  );
}

/* ── the five numbers the page exists to give ────────────────────────────────
   Billed, kept, due, received, still owed — in that order, because that is the
   order the money moves in, and each one opens the orders behind it. */
function Headline({ ledger, shown, onDrill }) {
  const amt = (k) => ledger.reduce((a, m) => a + (m[k]?.amount || 0), 0);
  const cnt = (k) => ledger.reduce((a, m) => a + (m[k]?.count || 0), 0);

  const netBillable = amt('netBillable');
  const fees = amt('fees');
  const tds = amt('tdsTcs');
  const expected = amt('expected');
  const settled = amt('settled');
  const closing = amt('closing');
  const collected = pctOf(settled, expected);

  const CARDS = [
    { key: 'netBillable', label: 'Net billable', value: netBillable, drill: 'netBillable',
      sub: `${int(cnt('invoiced'))} invoices · ${rangeLabel(shown)}`,
      note: 'Invoiced to customers, less what was refunded.' },
    { key: 'kept', label: 'Amazon kept', value: fees + tds, drill: 'fees', tone: 'text-amber-700',
      sub: `${pctOf(fees + tds, netBillable).toFixed(1)}% of net billable`,
      note: 'Fees, plus TDS 194-O and TCS withheld at source.' },
    { key: 'expected', label: 'Due from Amazon', value: expected, drill: 'expected', strong: true,
      sub: 'Net billable less what Amazon kept',
      note: 'What Amazon owes on this period’s invoices.' },
    { key: 'settled', label: 'Received to date', value: settled, drill: 'settled', tone: 'text-emerald-700',
      sub: `${collected.toFixed(1)}% collected · ${int(cnt('settled'))} orders`,
      note: 'Arrived against these orders, whenever it arrived.', bar: collected },
    { key: 'closing', label: 'Still outstanding', value: closing, drill: 'closing', strong: true,
      tone: closing < -1 ? 'text-rose-700' : closing > 1 ? 'text-rose-600' : 'text-emerald-700',
      sub: closing < -1 ? 'MORE received than was due — see the issues'
         : Math.abs(closing) <= 1 ? 'This period is square'
         : `${int(cnt('unpaidOrders'))} orders with no settlement at all`,
      note: 'Due from Amazon, less what has been received.' },
  ];

  return (
    <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
      {CARDS.map((c) => (
        <button key={c.key} onClick={() => onDrill({ kind: 'line', line: c.drill })}
                className={`text-left rounded-xl border bg-white p-4 hover:shadow-md hover:border-slate-300
                            transition-all group ${c.strong ? 'border-slate-300' : 'border-slate-200'}`}>
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{c.label}</div>
          <div className={`mt-1.5 text-xl font-bold tabular-nums ${c.tone || 'text-slate-900'}`}>
            ₹{inr(c.value)}
          </div>
          {c.bar !== undefined && (
            <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500"
                   style={{ width: `${Math.max(0, Math.min(100, c.bar))}%` }} />
            </div>
          )}
          <div className="mt-1.5 text-[11px] font-medium text-slate-500">{c.sub}</div>
          <div className="mt-1 text-[11px] text-slate-400 leading-snug">{c.note}</div>
          <div className="mt-2 text-[11px] font-semibold text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity">
            Show the orders →
          </div>
        </button>
      ))}
    </div>
  );
}

/* ── how old the unpaid money is ─────────────────────────────────────────────
   Amazon settles about every seven days, so last month's tail is a timing
   difference and anything older is a question. The distinction is the whole
   point of ageing it, and it is not visible from the amounts alone. */
function AgeingPanel({ ledger, onDrill }) {
  const open = ledger.filter((m) => Math.abs(m.closing?.amount || 0) > 1);
  if (!open.length) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-3 flex items-center gap-2">
        <Sigma className="h-4 w-4 text-emerald-700" />
        <p className="text-sm text-emerald-800">
          <strong>Nothing outstanding in this period.</strong> Everything due has been received.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100">
        <h3 className="text-sm font-bold text-slate-800">How old the outstanding money is</h3>
        <p className="text-xs text-slate-400 mt-0.5">
          Aged from the end of the month that invoiced it. Amazon settles about every seven days, so the
          most recent month is a timing difference — anything beyond 30 days is a question to ask.
        </p>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
          <tr>
            <th className="px-5 py-2.5 text-left font-bold">Month invoiced</th>
            <th className="px-4 py-2.5 text-left font-bold">Age</th>
            <th className="px-4 py-2.5 text-left font-bold">Bucket</th>
            <th className="px-4 py-2.5 text-right font-bold">Still outstanding</th>
            <th className="px-4 py-2.5 text-right font-bold">% of that month collected</th>
            <th className="px-4 py-2.5 text-left font-bold">Orders with no settlement</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {open.map((m) => {
            const d = daysOld(m.month);
            const bucket = ageBucket(d);
            const old = d > 30;
            return (
              <tr key={m.month} className={old ? 'bg-amber-50/50' : ''}>
                <td className="px-5 py-2.5 font-semibold text-slate-800">{fmtMonth(m.month)}</td>
                <td className="px-4 py-2.5 text-slate-600 tabular-nums">
                  <span className="inline-flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-slate-400" /> {d} days
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                    old ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-800'}`}>{bucket}</span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums font-bold text-slate-900">
                  <button className="hover:underline underline-offset-2"
                          onClick={() => onDrill({ kind: 'line', line: 'closing', months: [m.month] })}>
                    ₹{inr(m.closing.amount)}
                  </button>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                  {pctOf(m.settled?.amount || 0, m.expected?.amount || 0).toFixed(1)}%
                </td>
                <td className="px-4 py-2.5 text-slate-600">
                  {int(m.unpaidOrders?.count ?? 0)}
                  <span className="text-slate-400"> · ₹{inr(m.unpaidOrders?.amount ?? 0)} invoiced</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── the three files, with what each contributed ─────────────────────────── */
function SourcesPanel({ status, sources, sourceKind }) {
  const S = status?.sources;
  const CARDS = [
    { key: 'orders', file: 'order', note: 'Every order placed. The only file that knows about cancellations.' },
    { key: 'mtr', file: 'mtr', note: 'What was invoiced. THE BASE for this report.' },
    { key: 'settlement', file: 'settlement', note: 'What Amazon paid. Settles weekly, so it lags.' },
  ];
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100">
        <h3 className="text-sm font-bold text-slate-800">The three files this is built from</h3>
        <p className="text-xs text-slate-400 mt-0.5">
          They are not meant to be equal — each counts a different moment. Every figure above can be
          traced back to one of these three, and each drill says which.
        </p>
      </div>
      <div className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-100">
        {CARDS.map((c) => {
          const f = FILES[c.file];
          const s = S?.[c.key];
          const Icon = f.icon;
          return (
            <div key={c.key} className="p-4">
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4" style={{ color: f.tone }} />
                <span className="text-sm font-semibold text-slate-800">{f.label}</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-slate-900">
                {s ? int(s.rows) : '—'} <span className="text-sm font-medium text-slate-400">rows</span>
              </div>
              <div className="text-xs text-slate-500">{s ? `${s.files} file(s)` : 'not loaded'}</div>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">{c.note}</p>
              <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed italic">{f.how}</p>
            </div>
          );
        })}
      </div>
      {sources.length > 0 && (
        <div className="overflow-x-auto border-t border-slate-100">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-bold">What each file holds</th>
                {sources.map((s) => (
                  <th key={s.month} className="px-4 py-2 text-right font-bold">{fmtMonth(s.month)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {[['order', 'Order report — orders'], ['mtr', 'MTR — orders invoiced'],
                ['settlement', 'Settlement — orders paid']].map(([k, l]) => (
                <tr key={k}>
                  <td className="px-4 py-2 font-medium text-slate-600">{l}</td>
                  {sources.map((s) => (
                    <td key={s.month} className="px-4 py-2 text-right tabular-nums text-slate-800">
                      {int(s[k].orders)}
                      <span className="text-slate-400"> · ₹{inr(s[k].value, 0)}</span>
                    </td>
                  ))}
                </tr>
              ))}
              {/* WHICH settlement source owns each month. It changes what the
                  fee lines can be trusted to mean, so it is stated, not buried. */}
              <tr className="bg-slate-50/60">
                <td className="px-4 py-2 font-medium text-slate-600">Settlement came from</td>
                {sources.map((s) => (
                  <td key={s.month} className="px-4 py-2 text-right text-slate-600">
                    {sourceKind[s.month] === 'unified'
                      ? <span className="text-amber-700 font-semibold">unified transaction report</span>
                      : 'retained settlement ledgers'}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── order → MTR → settlement, as a chain of subtractions ────────────────────
   Six numbers that nobody could open, until now: each step says which file it
   came from and lists the orders behind it. */
function ThreeWayStrip({ three, shown, onDrill }) {
  /* Per-month when one month is chosen, totals when the whole period is. The
     chain must describe the same period as everything else on the page. */
  const t = useMemo(() => {
    const rows = (three.perMonth || []).filter((m) => shown.includes(m.month));
    if (!rows.length) return three.totals;
    return rows.reduce((a, m) => ({
      placed: a.placed + m.placed, cancelled: a.cancelled + m.cancelled,
      net: a.net + m.net, shipped: a.shipped + m.shipped,
      settled: a.settled + m.settled, unsettled: a.unsettled + m.unsettled,
    }), { placed: 0, cancelled: 0, net: 0, shipped: 0, settled: 0, unsettled: 0 });
  }, [three, shown]);

  const steps = [
    { step: 'placed', label: 'Orders placed', value: t.placed, prov: 'placed', tone: 'text-slate-900' },
    { step: 'cancelled', label: 'less cancelled', value: -t.cancelled, prov: 'cancelled', tone: 'text-amber-700' },
    { step: 'net', label: 'Net orders', value: t.net, prov: 'net', tone: 'text-slate-900', strong: true },
    { step: 'invoiced', label: 'Invoiced (MTR)', value: t.shipped, prov: 'chainInvoiced', tone: 'text-slate-900' },
    { step: 'settled', label: 'Settled', value: t.settled, prov: 'chainSettled', tone: 'text-emerald-700' },
    { step: 'unsettled', label: 'Still unsettled', value: t.unsettled, prov: 'chainUnsettled', tone: 'text-rose-700', strong: true },
  ];
  const drillable = Array.isArray(three.orderRows);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
        <h3 className="text-sm font-bold text-slate-800">
          The chain — order report → MTR → settlement
          <span className="font-normal text-slate-400"> · {rangeLabel(shown)}</span>
        </h3>
        <p className="text-xs text-slate-400">
          Counts of ORDERS, not money. Every subtraction names a countable group — nothing here is a
          balancing figure. {drillable
            ? 'Click any step for the orders behind it.'
            : 'Run the reconciliation again to make these steps clickable.'}
        </p>
      </div>
      <div className="flex items-stretch gap-1 flex-wrap">
        {steps.map((s, i) => {
          const f = FILES[PROV[s.prov].file];
          const Icon = f.icon;
          return (
            <React.Fragment key={s.step}>
              <button disabled={!drillable}
                      onClick={() => onDrill({ kind: 'chain', step: s.step })}
                      className={`px-3 py-2 rounded-lg text-left transition-colors ${
                        s.strong ? 'bg-slate-100' : ''} ${
                        drillable ? 'hover:bg-slate-200/70 cursor-pointer' : 'cursor-default'}`}>
                <div className={`text-lg font-bold tabular-nums ${s.tone}`}>
                  {s.value < 0 ? '−' : ''}{int(Math.abs(s.value))}
                </div>
                <div className="text-[11px] text-slate-500">{s.label}</div>
                {/* WHICH FILE SAYS SO. The number is only checkable if you know
                    where to go and look for it. */}
                <div className="mt-1 flex items-center gap-1 text-[10px] font-medium"
                     style={{ color: f.tone }}>
                  <Icon className="h-3 w-3" /> from {f.short}
                </div>
              </button>
              {i < steps.length - 1 && (
                <div className="flex items-center"><ChevronRight className="h-4 w-4 text-slate-300" /></div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

/* ── what is wrong, and what would fix it ────────────────────────────────── */
function IssuesPanel({ audit, shown, onDrill }) {
  const issues = audit.issues.filter((i) => !i.month || shown.includes(i.month));
  if (!issues.length) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-3">
        <p className="text-sm text-emerald-800">
          <strong>Nothing needs attention in {rangeLabel(shown)}.</strong> {audit.verdict}.
        </p>
      </div>
    );
  }
  const counts = issues.reduce((a, i) => ({ ...a, [i.severity]: (a[i.severity] || 0) + 1 }), {});
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-bold text-slate-800">
            What needs attention
            <span className="font-normal text-slate-400"> · {rangeLabel(shown)}</span>
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {audit.verdict} · nothing here is plugged — where a figure cannot be explained it says so.
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          {['blocker', 'warning', 'info'].map((k) => counts[k] > 0 && (
            <span key={k} className="px-2 py-1 rounded font-semibold"
                  style={{ background: SEV[k].bg, color: SEV[k].fg }}>
              {counts[k]} {SEV[k].label}
            </span>
          ))}
        </div>
      </div>
      <div className="divide-y divide-slate-100">
        {issues.map((i) => {
          const s = SEV[i.severity]; const Icon = s.icon;
          return (
            <div key={i.id} className="p-4" style={{ background: s.bg }}>
              <div className="flex items-start gap-3">
                <Icon className="h-5 w-5 shrink-0 mt-0.5" style={{ color: s.fg }} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-900">{i.title}</div>
                  <dl className="mt-2 grid gap-2 md:grid-cols-3 text-xs">
                    <div><dt className="font-bold text-slate-500 uppercase tracking-wide">What it is</dt>
                      <dd className="text-slate-700 mt-0.5 leading-relaxed">{i.what}</dd></div>
                    <div><dt className="font-bold text-slate-500 uppercase tracking-wide">Why it happens</dt>
                      <dd className="text-slate-700 mt-0.5 leading-relaxed">{i.why}</dd></div>
                    <div><dt className="font-bold text-slate-500 uppercase tracking-wide">How to resolve it</dt>
                      <dd className="text-slate-700 mt-0.5 leading-relaxed">{i.howToFix}</dd></div>
                  </dl>
                  {i.drill && (
                    <button onClick={() => onDrill(i)}
                            className="mt-3 text-xs font-semibold underline underline-offset-2"
                            style={{ color: s.fg }}>
                      Show the {i.count ? int(i.count) + ' ' : ''}orders behind this →
                    </button>
                  )}
                </div>
                {i.amount !== 0 && (
                  <div className="text-right shrink-0">
                    <div className="text-lg font-bold tabular-nums" style={{ color: s.fg }}>
                      ₹{inr(i.amount)}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── the money, month by month ───────────────────────────────────────────── */
function LedgerTable({ ledger, onDrill }) {
  const months = ledger.map((m) => m.month);
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100">
        <h3 className="text-sm font-bold text-slate-800">
          Receivables by month
          <span className="font-normal text-slate-400"> · {rangeLabel(months)}</span>
        </h3>
        <p className="text-xs text-slate-400 mt-0.5">
          Click any figure to see the orders behind it, and which file it came from. GST is a memo, not a
          deduction — Amazon pays it across to you and you remit it onward.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-2.5 text-left font-bold w-8" />
              <th className="px-2 py-2.5 text-left font-bold">Line</th>
              <th className="px-3 py-2.5 text-left font-bold">Source</th>
              {months.map((m) => <th key={m} className="px-4 py-2.5 text-right font-bold">{fmtMonth(m)}</th>)}
              {months.length > 1 && (
                <th className="px-4 py-2.5 text-right font-bold border-l border-slate-200">Total</th>
              )}
              <th className="px-4 py-2.5 text-left font-bold">What this line is</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {LINES.map((L) => {
              const vals = ledger.map((m) => m[L.key]?.amount ?? 0);
              const total = vals.reduce((a, b) => a + b, 0);
              const bad = L.final && vals.some((v) => v < -1);
              const f = FILES[PROV[L.prov].file];
              const Icon = f.icon;
              return (
                <tr key={L.key} className={L.strong ? 'bg-slate-50/70' : ''}>
                  <td className="px-4 py-2 text-slate-400 font-mono">{L.sign}</td>
                  <td className={`px-2 py-2 whitespace-nowrap ${L.strong ? 'font-bold text-slate-900' : 'text-slate-700'}`}>
                    {L.label}
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold whitespace-nowrap"
                          style={{ color: f.tone }}>
                      <Icon className="h-3 w-3" /> {f.short}
                    </span>
                  </td>
                  {ledger.map((m, i) => (
                    <td key={m.month} className="px-4 py-2 text-right tabular-nums">
                      <button onClick={() => onDrill(L.key, m.month)}
                              className={`hover:underline underline-offset-2 ${
                                vals[i] < -1 && L.final ? 'text-rose-600 font-bold'
                                : L.strong ? 'font-semibold text-slate-900' : 'text-slate-700'}`}>
                        {inr(vals[i])}
                      </button>
                    </td>
                  ))}
                  {months.length > 1 && (
                    <td className={`px-4 py-2 text-right tabular-nums border-l border-slate-200 ${
                          L.strong ? 'font-bold' : ''} ${bad ? 'text-rose-600' : 'text-slate-900'}`}>
                      {inr(total)}
                    </td>
                  )}
                  <td className="px-4 py-2 text-xs text-slate-400 max-w-md">{L.what}</td>
                </tr>
              );
            })}
            <tr className="bg-sky-50/40">
              <td /><td className="px-2 py-2 text-xs text-slate-500 italic whitespace-nowrap">of which received later</td>
              <td />
              {ledger.map((m) => (
                <td key={m.month} className="px-4 py-2 text-right tabular-nums text-xs text-slate-600">
                  {inr(m.settledLater?.amount ?? 0)}
                </td>
              ))}
              {months.length > 1 && <td className="border-l border-slate-200" />}
              <td className="px-4 py-2 text-xs text-slate-400">
                Part of “Received” that arrived after the month closed — the carry-forward.
              </td>
            </tr>
            <tr className="bg-sky-50/40">
              <td /><td className="px-2 py-2 text-xs text-slate-500 italic whitespace-nowrap">(memo) GST within it</td>
              <td />
              {ledger.map((m) => (
                <td key={m.month} className="px-4 py-2 text-right tabular-nums text-xs text-slate-600">
                  {inr(m.gstMemo?.amount ?? 0)}
                </td>
              ))}
              {months.length > 1 && <td className="border-l border-slate-200" />}
              <td className="px-4 py-2 text-xs text-slate-400">
                How much of the receivable is GST you will remit. NOT withheld by Amazon.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── every order lands in exactly one bucket ─────────────────────────────── */
function StatusTable({ ledger, onDrill }) {
  const months = ledger.map((m) => m.month);
  const statuses = ledger[0]?.byStatus?.map((b) => b.status) || [];
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100">
        <h3 className="text-sm font-bold text-slate-800">
          Where every order ended up
          <span className="font-normal text-slate-400"> · {rangeLabel(months)}</span>
        </h3>
        <p className="text-xs text-slate-400 mt-0.5">
          Each order is in exactly one row, so these sum to the orders invoiced — nothing can hide between
          them. The count is above; the invoice value is below it.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-5 py-2.5 text-left font-bold">Status</th>
              {months.map((m) => <th key={m} className="px-4 py-2.5 text-right font-bold">{fmtMonth(m)}</th>)}
              {months.length > 1 && (
                <th className="px-4 py-2.5 text-right font-bold border-l border-slate-200">Total</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {statuses.map((st) => {
              const cells = ledger.map((m) => m.byStatus.find((b) => b.status === st)
                                            || { count: 0, amount: 0 });
              const tot = cells.reduce((a, c) => ({ count: a.count + c.count, amount: a.amount + c.amount }),
                                       { count: 0, amount: 0 });
              return (
                <tr key={st}>
                  <td className="px-5 py-2 text-slate-700">{st}</td>
                  {ledger.map((m, i) => (
                    <td key={m.month} className="px-4 py-2 text-right tabular-nums">
                      <button onClick={() => onDrill(st, m.month)}
                              className="text-slate-700 hover:underline underline-offset-2">
                        {int(cells[i].count)}
                        <div className="text-[10px] text-slate-400">₹{inr(cells[i].amount, 0)}</div>
                      </button>
                    </td>
                  ))}
                  {months.length > 1 && (
                    <td className="px-4 py-2 text-right tabular-nums font-semibold border-l border-slate-200">
                      {int(tot.count)}
                      <div className="text-[10px] font-normal text-slate-400">₹{inr(tot.amount, 0)}</div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── which rows sit behind a given figure ────────────────────────────────────
   One place decides this, because the drill and the export must never disagree
   about what they are showing. */
function drillRows(drill, data, ST) {
  const all = data?.ledger?.rows || [];
  const ms = drill.months || [];
  const inSel = (r) => !ms.length || ms.includes(r.month);
  const billable = (r) => r.status !== ST.CANCELLED && r.status !== ST.NOT_AMAZON;

  if (drill.kind === 'issue') {
    return { kind: 'ledger', rows: data?.drills?.[drill.issue.id] || [],
             prov: PROV[drill.issue.drill === 'fees' ? 'fees'
                      : drill.issue.drill === 'overCollected' ? 'settled' : 'closing'] };
  }
  if (drill.kind === 'status') {
    return { kind: 'ledger', prov: PROV.status,
             rows: all.filter((r) => inSel(r) && r.status === drill.status) };
  }
  if (drill.kind === 'chain') {
    const rows = (data?.three?.orderRows || []).filter(inSel);
    const f = {
      placed: () => rows,
      cancelled: () => rows.filter((r) => r.cancelled),
      net: () => rows.filter((r) => !r.cancelled),
      invoiced: () => rows.filter((r) => !r.cancelled && r.invoiced),
      settled: () => rows.filter((r) => !r.cancelled && r.settled),
      unsettled: () => rows.filter((r) => !r.cancelled && !r.settled),
    }[drill.step] || (() => rows);
    const provKey = { placed: 'placed', cancelled: 'cancelled', net: 'net',
                      invoiced: 'chainInvoiced', settled: 'chainSettled',
                      unsettled: 'chainUnsettled' }[drill.step] || 'placed';
    return { kind: 'chain', rows: f(), prov: PROV[provKey] };
  }
  /* a ledger line */
  const mine = all.filter(inSel);
  const pick = {
    returned: () => mine.filter((r) => billable(r) && r.refunded > 0),
    fees: () => mine.filter((r) => billable(r) && r.fees > 0),
    tdsTcs: () => mine.filter((r) => billable(r) && r.tdsTcs > 0),
    settled: () => mine.filter((r) => billable(r) && r.settled !== 0),
    closing: () => mine.filter((r) => r.status === ST.OUTSTANDING),
  }[drill.line];
  return { kind: 'ledger', rows: pick ? pick() : mine.filter(billable),
           prov: PROV[drill.line] || PROV.invoiced };
}

const LEDGER_COLS = [
  { key: 'orderId', label: 'Order ID', mono: true },
  { key: 'month', label: 'Month', fmt: fmtMonth },
  { key: 'status', label: 'Status' },
  { key: 'invoiced', label: 'Invoiced', num: true },
  { key: 'refunded', label: 'Returned', num: true },
  { key: 'fees', label: 'Fees', num: true },
  { key: 'tdsTcs', label: 'TDS/TCS', num: true },
  { key: 'settled', label: 'Received', num: true },
  { key: 'settledMonth', label: 'Settled in', fmt: (v) => (v ? fmtMonth(v) : '—') },
];
const CHAIN_COLS = [
  { key: 'orderId', label: 'Order ID', mono: true },
  { key: 'month', label: 'Month placed', fmt: fmtMonth },
  { key: 'status', label: 'Order status' },
  { key: 'invoiced', label: 'In MTR?', bool: true },
  { key: 'settled', label: 'Settled?', bool: true },
  { key: 'value', label: 'Order value', num: true },
  { key: 'lines', label: 'Lines', num: true, dp: 0 },
  { key: 'shipState', label: 'Ship state' },
];

/* ── the orders behind whatever was clicked ──────────────────────────────── */
function DrillPanel({ drill, data, ST, base, onClose }) {
  const [busy, setBusy] = useState(false);
  const { kind, rows, prov } = useMemo(() => drillRows(drill, data, ST), [drill, data, ST]);
  const cols = kind === 'chain' ? CHAIN_COLS : LEDGER_COLS;
  const f = FILES[prov.file];
  const FIcon = f.icon;

  const period = rangeLabel(drill.months || []);
  const title = drill.kind === 'issue' ? drill.issue.title
    : drill.kind === 'status' ? `${period} · ${drill.status}`
    : drill.kind === 'chain' ? `${period} · ${{
        placed: 'Orders placed', cancelled: 'Orders cancelled', net: 'Net orders',
        invoiced: 'Invoiced (in the MTR)', settled: 'Settled', unsettled: 'Still unsettled',
      }[drill.step] || drill.step}`
    : `${period} · ${LINES.find((l) => l.key === drill.line)?.label || drill.line}`;

  const totals = useMemo(() => cols.filter((c) => c.num).reduce((a, c) => ({
    ...a, [c.key]: rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0),
  }), {}), [rows, cols]);

  const cell = (r, c) => {
    const v = r[c.key];
    if (c.bool) return v ? 'Yes' : 'No';
    if (c.num) return v ? inr(v, c.dp === 0 ? 0 : 2) : '—';
    if (c.fmt) return c.fmt(v);
    return v === '' || v === undefined || v === null ? '—' : v;
  };

  const fileStem = `amazon-receivables-${(drill.months || []).join('_') || 'all'}-${drill.kind}`;

  const csv = () => {
    const q = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
    const head = cols.map((c) => c.label);
    const body = rows.map((r) => cols.map((c) => q(c.bool ? (r[c.key] ? 'Yes' : 'No') : r[c.key])).join(','));
    const meta = [
      `"Amazon Receivables — ${title}"`,
      `"Source: ${f.label}${prov.column ? ' · column: ' + prov.column : ''}${prov.filter ? ' · filter: ' + prov.filter : ''}"`,
      `"${int(rows.length)} orders"`, '',
    ];
    const blob = new Blob([[...meta, head.map(q).join(','), ...body].join('\n')],
                          { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${fileStem}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  /* Excel as well as CSV, because this is handed to an accountant who will
     filter, total and annotate it — and because a CSV of order ids loses them
     to scientific notation the moment it is double-clicked.

     The rows are derived here and FORMATTED on the backend, by the same hand
     that builds the full workbook. Doing it here would mean SheetJS, which
     discards every style, and a second cheaper-looking file escaping by a
     different door. */
  const excel = async () => {
    if (!base) return;
    setBusy(true);
    try {
      const r = await api.post(`${base}/export/drill`, {
        title, period, filename: fileStem,
        provenance: { file: f.short, column: prov.column, filter: prov.filter,
                      dated: prov.dated, note: prov.note || f.how },
        columns: cols.map((c) => ({
          key: c.key, label: c.label, mono: !!c.mono,
          money: !!c.num && c.dp !== 0, count: c.dp === 0,
          width: c.key === 'orderId' ? 22 : Math.max(12, c.label.length + 6),
        })),
        rows: rows.map((row) => cols.reduce((a, c) => ({
          ...a, [c.key]: c.bool ? (row[c.key] ? 'Yes' : 'No')
            : c.num ? Number(row[c.key] || 0)
            : c.fmt ? c.fmt(row[c.key]) : row[c.key],
        }), {})),
      }, { responseType: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.data);
      a.download = `${fileStem}.xlsx`;
      a.click(); URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error('Could not build the sheet');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" onClick={onClose}>
      <div className="w-full max-w-5xl bg-white h-full overflow-auto shadow-2xl"
           onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-white border-b border-slate-200">
          <div className="px-5 py-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900">{title}</h3>
              <p className="text-xs text-slate-400">{int(rows.length)} orders · {period}</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={excel} disabled={busy}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 flex items-center gap-1.5 disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <FileSpreadsheet className="h-3.5 w-3.5" />}
                {busy ? 'Building…' : 'Excel'}
              </button>
              <button onClick={csv}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5" /> CSV
              </button>
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100">
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
          </div>
          {/* WHERE THIS COMES FROM — the first thing on the panel, because the
              first question about any figure is which file to open to check it. */}
          <div className="px-5 py-2.5 bg-slate-50 border-t border-slate-100">
            <div className="flex items-start gap-2">
              <FIcon className="h-4 w-4 mt-0.5 shrink-0" style={{ color: f.tone }} />
              <div className="text-xs text-slate-600 leading-relaxed">
                <span className="font-bold text-slate-800">Where this comes from:</span>{' '}
                <span className="font-semibold" style={{ color: f.tone }}>{f.label}</span>
                {prov.column && <> · column <code className="px-1 bg-white border border-slate-200 rounded">{prov.column}</code></>}
                {prov.filter && <> · filter <code className="px-1 bg-white border border-slate-200 rounded">{prov.filter}</code></>}
                {prov.dated && <> · dated by {prov.dated}</>}
                <div className="text-slate-500 mt-0.5">{prov.note || f.how}</div>
              </div>
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">
            No orders in this group for {period}. That is an answer, not an error — the figure above is
            zero for the same reason.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                {cols.map((c) => (
                  <th key={c.key} className={`px-3 py-2 font-bold ${c.num ? 'text-right' : 'text-left'}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {rows.slice(0, 500).map((r) => (
                <tr key={r.orderId} className="hover:bg-slate-50">
                  {cols.map((c) => (
                    <td key={c.key}
                        className={`px-3 py-1.5 ${c.num ? 'text-right tabular-nums' : ''} ${
                          c.mono ? 'font-mono text-slate-700' : 'text-slate-600'}`}>
                      {cell(r, c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 border-t border-slate-200 font-semibold text-slate-800">
              <tr>
                {cols.map((c, i) => (
                  <td key={c.key} className={`px-3 py-2 ${c.num ? 'text-right tabular-nums' : ''}`}>
                    {i === 0 ? `${int(rows.length)} orders` : c.num ? inr(totals[c.key], c.dp === 0 ? 0 : 2) : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        )}
        {rows.length > 500 && (
          <p className="p-4 text-xs text-slate-400">
            Showing the first 500 of {int(rows.length)} — the totals above cover all of them. Download the
            Excel or CSV for the full list.
          </p>
        )}
      </div>
    </div>
  );
}

/* ── the whole report, as a workbook ─────────────────────────────────────────
   The workbook is built on the BACKEND and downloaded, not assembled here.
   The only spreadsheet library on the frontend is SheetJS's community build,
   which accepts a style on every cell and then silently discards all of them
   on write — the first version of this export went out as a grid of
   unformatted numbers with no currency, no subtotals and not one live formula.
   ExcelJS, which keeps its formatting, is a backend dependency, so the file is
   built where the library that can format it lives.

   The CSV stays here: it has no formatting to lose. */
function ExportButtons({ data, months, shown, status, base }) {
  const [busy, setBusy] = useState(false);

  const excel = async () => {
    if (!base) return;
    setBusy(true);
    try {
      const r = await api.get(`${base}/export`, {
        params: { months: shown.join(',') }, responseType: 'blob',
      });
      const name = (r.headers['content-disposition'] || '').match(/filename="([^"]+)"/)?.[1]
        || `Amazon_Receivables_${shown[0]}_to_${shown[shown.length - 1]}.xlsx`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.data);
      a.download = name;
      a.click(); URL.revokeObjectURL(a.href);
      toast.success(`Workbook for ${rangeLabel(shown)} downloaded`);
    } catch (e) {
      toast.error('Could not build the workbook');
    } finally { setBusy(false); }
  };

  const csv = () => {
    const ms = shown;
    const led = (data.ledger?.perMonth || []).filter((m) => ms.includes(m.month));
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      [`Amazon Receivables — ${rangeLabel(ms)}`],
      ['The base is the MTR invoice value. GST is a memo, not a deduction.'],
      [],
      ['Line', 'Source', ...ms.map(fmtMonth), 'Total'],
      ...LINES.map((L) => {
        const v = led.map((m) => m[L.key]?.amount ?? 0);
        return [L.label, FILES[PROV[L.prov].file].short, ...v, v.reduce((a, b) => a + b, 0)];
      }),
    ].map((r) => r.map(q).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `amazon-receivables-${ms[0]}-to-${ms[ms.length - 1]}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  const partial = shown.length !== months.length;
  return (
    <div className="flex gap-2">
      <button onClick={excel} disabled={busy}
              title={`Formatted workbook for ${rangeLabel(shown)} — cover, ledger with live formulas, chain, issues and order detail`}
              className="px-3 py-2 text-sm font-semibold rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 flex items-center gap-2 disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
        {busy ? 'Building…' : 'Excel'}
        {partial && !busy && <span className="text-[10px] font-medium">({rangeLabel(shown)})</span>}
      </button>
      <button onClick={csv} title="The waterfall only, as a CSV"
              className="px-3 py-2 text-sm font-medium rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center gap-2">
        <Download className="h-4 w-4" /> CSV
      </button>
    </div>
  );
}

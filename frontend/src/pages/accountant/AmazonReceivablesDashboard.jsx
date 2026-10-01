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

   Every figure is clickable and every problem is on the face of the page. A
   reconciliation an accountant cannot argue with is one they have to take on
   trust, which is worth much less.
   ────────────────────────────────────────────────────────────────────────────── */
import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  RefreshCw, Download, AlertTriangle, AlertCircle, Info, ChevronRight,
  Package, Receipt, Banknote, X, Loader2, ArrowLeft,
  LayoutDashboard, Bot, ClipboardList,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';
import DashboardLayout from '../../components/layout/DashboardLayout';

const inr = (n, dp = 2) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('en-IN',
      { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const int = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));

/* The waterfall. `sign` drives the sign column, `strong` marks a subtotal, and
   `what` is the plain-English note the sheet carries too — the same words in
   both places so nobody has to reconcile the explanation as well as the number. */
const LINES = [
  { key: 'invoiced',    label: 'Invoiced (incl GST)', sign: '+',
    what: 'What was billed to customers — the MTR invoice value.' },
  { key: 'returned',    label: 'Returns / refunds', sign: '−',
    what: 'Money given back on those orders.' },
  { key: 'netBillable', label: 'Net billable', sign: '=', strong: true,
    what: 'Invoiced less returns.' },
  { key: 'fees',        label: 'Amazon fees', sign: '−',
    what: 'Commission, closing fee, FBA, storage and the GST on them.' },
  { key: 'tdsTcs',      label: 'TDS 194-O / TCS', sign: '−',
    what: 'Withheld at source by Amazon and paid to the government for you.' },
  { key: 'expected',    label: 'Due from Amazon', sign: '=', strong: true,
    what: 'What Amazon owes on this month’s orders.' },
  { key: 'settled',     label: 'Received (to date)', sign: '−',
    what: 'What has arrived against them, whenever it arrived.' },
  { key: 'closing',     label: 'Still outstanding', sign: '=', strong: true, final: true,
    what: 'Not yet received. A NEGATIVE means more came in than was due.' },
];

const SEV = {
  blocker: { icon: AlertTriangle, bg: '#FEF2F2', border: '#FCA5A5', fg: '#991B1B', label: 'Blocker' },
  warning: { icon: AlertCircle,  bg: '#FFFBEB', border: '#FCD34D', fg: '#92400E', label: 'Warning' },
  info:    { icon: Info,         bg: '#F0F9FF', border: '#93C5FD', fg: '#1E40AF', label: 'For information' },
};

export default function AmazonReceivablesDashboard() {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState(null);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [drill, setDrill] = useState(null);

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

  /* The sidebar belongs on EVERY state of the page, loading included — a shell
     that appears only once the data lands reads as the navigation breaking. */
  const sidebarItems = [
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
    { path: `/brands/${brandId}/reco`, label: 'Reconciliation', icon: ClipboardList, testId: 'nav-reco' },
  ];

  if (loading) {
    return (
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="p-6 flex items-center gap-3 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading Amazon receivables…
        </div>
      </DashboardLayout>
    );
  }

  const months = data?.ledger?.months || data?.months || [];
  const ledger = data?.ledger?.perMonth || [];
  const three = data?.three;
  const audit = data?.audit;
  const sources = data?.sources || [];

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
    <div className="p-6 space-y-6 max-w-[1500px]">
      <button onClick={() => navigate(`/brands/${brandId}/reco`)}
              className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-blue-600 group transition-colors">
        <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
        Back to Reconciliation
      </button>

      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Order report · MTR · Settlement
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mt-0.5">Amazon Receivables</h1>
          <p className="text-sm text-slate-500 mt-1 max-w-3xl">
            Of everything sold, what has actually been paid for. Each month is its own cohort —
            the orders <strong>invoiced</strong> that month, what Amazon kept, and what has since
            arrived against them. <strong>The base is the MTR invoice value</strong>, because that
            is the document actually issued to the customer.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
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

      {/* ── the three files ────────────────────────────────────────────── */}
      <SourcesPanel status={status} sources={sources} months={months} />

      {!data && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center">
          <p className="text-slate-600 font-medium">No reconciliation has been run yet.</p>
          <p className="text-sm text-slate-500 mt-1">
            Load the three sources, then press <strong>Run reconciliation</strong>.
          </p>
        </div>
      )}

      {data && <>
        {/* ── the chain: order → MTR → settlement ─────────────────────── */}
        {three && <ThreeWayStrip three={three} />}

        {/* ── issues, before the numbers that depend on them ──────────── */}
        {audit?.issues?.length > 0 && (
          <IssuesPanel audit={audit} onDrill={(i) => setDrill({ kind: 'issue', issue: i })} />
        )}

        {/* ── the ledger ──────────────────────────────────────────────── */}
        <LedgerTable months={months} ledger={ledger}
                     onDrill={(line, month) => setDrill({ kind: 'line', line, month })} />

        {/* ── closing status ──────────────────────────────────────────── */}
        <StatusTable months={months} ledger={ledger}
                     onDrill={(st, month) => setDrill({ kind: 'status', status: st, month })} />
      </>}

      {drill && <DrillPanel drill={drill} data={data} onClose={() => setDrill(null)} />}
    </div>
    </DashboardLayout>
  );
}

/* ── the three files, stated before anything derived from them ───────────── */
function SourcesPanel({ status, sources, months }) {
  const S = status?.sources;
  const CARDS = [
    { key: 'orders', label: 'Order report', icon: Package, tone: '#7C3AED',
      note: 'Every order placed. The only file that knows about cancellations.' },
    { key: 'mtr', label: 'MTR (B2B + B2C)', icon: Receipt, tone: '#0748EE',
      note: 'What was invoiced. THE BASE for this report.' },
    { key: 'settlement', label: 'Settlement', icon: Banknote, tone: '#059669',
      note: 'What Amazon paid. Settles weekly, so it lags.' },
  ];
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100">
        <h3 className="text-sm font-bold text-slate-800">The three files</h3>
        <p className="text-xs text-slate-400 mt-0.5">
          They are not meant to be equal — each counts a different moment. The chain below is how they relate.
        </p>
      </div>
      <div className="grid grid-cols-3 divide-x divide-slate-100">
        {CARDS.map((c) => {
          const s = S?.[c.key];
          const Icon = c.icon;
          return (
            <div key={c.key} className="p-4">
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4" style={{ color: c.tone }} />
                <span className="text-sm font-semibold text-slate-800">{c.label}</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-slate-900">
                {s ? int(s.rows) : '—'} <span className="text-sm font-medium text-slate-400">rows</span>
              </div>
              <div className="text-xs text-slate-500">{s ? `${s.files} file(s)` : 'not loaded'}</div>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">{c.note}</p>
            </div>
          );
        })}
      </div>
      {sources.length > 0 && (
        <table className="w-full text-xs border-t border-slate-100">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-2 text-left font-bold">Orders per month</th>
              {sources.map((s) => <th key={s.month} className="px-4 py-2 text-right font-bold">{s.month}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {[['order', 'Order report'], ['mtr', 'MTR'], ['settlement', 'Settlement']].map(([k, l]) => (
              <tr key={k}>
                <td className="px-4 py-2 font-medium text-slate-600">{l}</td>
                {sources.map((s) => (
                  <td key={s.month} className="px-4 py-2 text-right tabular-nums text-slate-800">
                    {int(s[k].orders)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ── order → MTR → settlement, as a chain of subtractions ────────────────── */
function ThreeWayStrip({ three }) {
  const t = three.totals;
  const steps = [
    { label: 'Orders placed', value: t.placed, tone: 'text-slate-900' },
    { label: 'less cancelled', value: -t.cancelled, tone: 'text-amber-700' },
    { label: 'Net orders', value: t.net, tone: 'text-slate-900', strong: true },
    { label: 'Invoiced (MTR)', value: t.shipped, tone: 'text-slate-900' },
    { label: 'Settled', value: t.settled, tone: 'text-emerald-700' },
    { label: 'Still unsettled', value: t.unsettled, tone: 'text-rose-700', strong: true },
  ];
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-bold text-slate-800 mb-3">
        The chain — order report → MTR → settlement
      </h3>
      <div className="flex items-center gap-1 flex-wrap">
        {steps.map((s, i) => (
          <React.Fragment key={s.label}>
            <div className={`px-3 py-2 rounded-lg ${s.strong ? 'bg-slate-100' : ''}`}>
              <div className={`text-lg font-bold tabular-nums ${s.tone}`}>
                {s.value < 0 ? '−' : ''}{int(Math.abs(s.value))}
              </div>
              <div className="text-[11px] text-slate-500">{s.label}</div>
            </div>
            {i < steps.length - 1 && <ChevronRight className="h-4 w-4 text-slate-300" />}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

/* ── what is wrong, and what would fix it ────────────────────────────────── */
function IssuesPanel({ audit, onDrill }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-800">What needs attention</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {audit.verdict} · nothing here is plugged — where a figure cannot be explained it says so.
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          {['blocker', 'warning', 'info'].map((k) => audit.counts[k] > 0 && (
            <span key={k} className="px-2 py-1 rounded font-semibold"
                  style={{ background: SEV[k].bg, color: SEV[k].fg }}>
              {audit.counts[k]} {SEV[k].label}
            </span>
          ))}
        </div>
      </div>
      <div className="divide-y divide-slate-100">
        {audit.issues.map((i) => {
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
function LedgerTable({ months, ledger, onDrill }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100">
        <h3 className="text-sm font-bold text-slate-800">Receivables by month</h3>
        <p className="text-xs text-slate-400 mt-0.5">
          Click any figure to see the orders behind it. GST is a memo, not a deduction — Amazon pays it
          across to you and you remit it onward.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-2.5 text-left font-bold w-8" />
              <th className="px-2 py-2.5 text-left font-bold">Line</th>
              {months.map((m) => <th key={m} className="px-4 py-2.5 text-right font-bold">{m}</th>)}
              <th className="px-4 py-2.5 text-right font-bold border-l border-slate-200">Total</th>
              <th className="px-4 py-2.5 text-left font-bold">What this line is</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {LINES.map((L) => {
              const vals = ledger.map((m) => m[L.key]?.amount ?? 0);
              const total = vals.reduce((a, b) => a + b, 0);
              const bad = L.final && vals.some((v) => v < -1);
              return (
                <tr key={L.key} className={L.strong ? 'bg-slate-50/70' : ''}>
                  <td className="px-4 py-2 text-slate-400 font-mono">{L.sign}</td>
                  <td className={`px-2 py-2 ${L.strong ? 'font-bold text-slate-900' : 'text-slate-700'}`}>
                    {L.label}
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
                  <td className={`px-4 py-2 text-right tabular-nums border-l border-slate-200 ${
                        L.strong ? 'font-bold' : ''} ${bad ? 'text-rose-600' : 'text-slate-900'}`}>
                    {inr(total)}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-400 max-w-md">{L.what}</td>
                </tr>
              );
            })}
            <tr className="bg-sky-50/40">
              <td /><td className="px-2 py-2 text-xs text-slate-500 italic">of which received later</td>
              {ledger.map((m) => (
                <td key={m.month} className="px-4 py-2 text-right tabular-nums text-xs text-slate-600">
                  {inr(m.settledLater?.amount ?? 0)}
                </td>
              ))}
              <td className="border-l border-slate-200" />
              <td className="px-4 py-2 text-xs text-slate-400">
                Part of “Received” that arrived after the month closed — the carry-forward.
              </td>
            </tr>
            <tr className="bg-sky-50/40">
              <td /><td className="px-2 py-2 text-xs text-slate-500 italic">(memo) GST within it</td>
              {ledger.map((m) => (
                <td key={m.month} className="px-4 py-2 text-right tabular-nums text-xs text-slate-600">
                  {inr(m.gstMemo?.amount ?? 0)}
                </td>
              ))}
              <td className="border-l border-slate-200" />
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
function StatusTable({ months, ledger, onDrill }) {
  const statuses = ledger[0]?.byStatus?.map((b) => b.status) || [];
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100">
        <h3 className="text-sm font-bold text-slate-800">Where every order ended up</h3>
        <p className="text-xs text-slate-400 mt-0.5">
          Each order is in exactly one row, so these sum to the orders invoiced — nothing can hide between them.
        </p>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
          <tr>
            <th className="px-5 py-2.5 text-left font-bold">Status</th>
            {months.map((m) => <th key={m} className="px-4 py-2.5 text-right font-bold">{m}</th>)}
            <th className="px-4 py-2.5 text-right font-bold border-l border-slate-200">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {statuses.map((st) => {
            const vals = ledger.map((m) => m.byStatus.find((b) => b.status === st)?.count ?? 0);
            return (
              <tr key={st}>
                <td className="px-5 py-2 text-slate-700">{st}</td>
                {ledger.map((m, i) => (
                  <td key={m.month} className="px-4 py-2 text-right tabular-nums">
                    <button onClick={() => onDrill(st, m.month)}
                            className="text-slate-700 hover:underline underline-offset-2">
                      {int(vals[i])}
                    </button>
                  </td>
                ))}
                <td className="px-4 py-2 text-right tabular-nums font-semibold border-l border-slate-200">
                  {int(vals.reduce((a, b) => a + b, 0))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── the orders behind whatever was clicked ──────────────────────────────── */
function DrillPanel({ drill, data, onClose }) {
  const rows = React.useMemo(() => {
    const all = data?.ledger?.rows || [];
    if (drill.kind === 'issue') return data?.drills?.[drill.issue.id] || [];
    if (drill.kind === 'status') {
      return all.filter((r) => r.month === drill.month && r.status === drill.status);
    }
    const inMonth = all.filter((r) => r.month === drill.month);
    switch (drill.line) {
      case 'returned': return inMonth.filter((r) => r.refunded > 0);
      case 'fees':     return inMonth.filter((r) => r.fees > 0);
      case 'tdsTcs':   return inMonth.filter((r) => r.tdsTcs > 0);
      case 'settled':  return inMonth.filter((r) => r.settled !== 0);
      case 'closing':  return inMonth.filter((r) => r.status === 'Outstanding');
      default:         return inMonth.filter((r) => r.status !== 'Cancelled');
    }
  }, [drill, data]);

  const title = drill.kind === 'issue' ? drill.issue.title
    : drill.kind === 'status' ? `${drill.month} · ${drill.status}`
    : `${drill.month} · ${LINES.find((l) => l.key === drill.line)?.label || drill.line}`;

  const csv = () => {
    const head = ['order_id', 'month', 'status', 'invoiced', 'returned', 'fees', 'tds_tcs', 'received', 'settled_in'];
    const body = rows.map((r) => [r.orderId, r.month, r.status, r.invoiced, r.refunded,
                                 r.fees, r.tdsTcs, r.settled, r.settledMonth].join(','));
    const blob = new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `amazon-receivables-${(drill.month || 'all')}-${drill.kind}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" onClick={onClose}>
      <div className="w-full max-w-5xl bg-white h-full overflow-auto shadow-2xl"
           onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-slate-900">{title}</h3>
            <p className="text-xs text-slate-400">{int(rows.length)} orders</p>
          </div>
          <div className="flex gap-2">
            <button onClick={csv}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center gap-1.5">
              <Download className="h-3.5 w-3.5" /> CSV
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100">
              <X className="h-4 w-4 text-slate-500" />
            </button>
          </div>
        </div>
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400 sticky top-[57px]">
            <tr>
              {['Order ID', 'Month', 'Status', 'Invoiced', 'Returned', 'Fees', 'TDS/TCS', 'Received', 'Settled in']
                .map((h, i) => (
                  <th key={h} className={`px-3 py-2 font-bold ${i >= 3 && i <= 7 ? 'text-right' : 'text-left'}`}>{h}</th>
                ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rows.slice(0, 500).map((r) => (
              <tr key={r.orderId} className="hover:bg-slate-50">
                <td className="px-3 py-1.5 font-mono text-slate-700">{r.orderId}</td>
                <td className="px-3 py-1.5 text-slate-500">{r.month}</td>
                <td className="px-3 py-1.5 text-slate-600">{r.status}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{inr(r.invoiced)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.refunded ? inr(r.refunded) : '—'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.fees ? inr(r.fees) : '—'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.tdsTcs ? inr(r.tdsTcs) : '—'}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.settled ? inr(r.settled) : '—'}</td>
                <td className="px-3 py-1.5 text-slate-500">{r.settledMonth || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 500 && (
          <p className="p-4 text-xs text-slate-400">
            Showing the first 500 of {int(rows.length)}. Download the CSV for all of them.
          </p>
        )}
      </div>
    </div>
  );
}

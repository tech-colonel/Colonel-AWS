/* ──────────────────────────────────────────────────────────────────────────────
   Amazon Receivables — how much we sold, how much Amazon paid, what is pending.

   Built on the Shopify Order Cycle pattern — a report list, a generate wizard,
   then the report itself — because an accountant works in reports, not in a
   single page that silently rewrites itself. Everything else is Amazon's.

   THE FOUR QUESTIONS A MONTH HAS TO ANSWER, and the one the old page missed:

     1  How much did we sell this month?        the amount due from Amazon
     2  How much did Amazon credit this month?  ALL of it, not just this month's
     3  How much of THIS MONTH'S SALES is not received?
     4  How much of the credit was for older sales?

   Question 2 has to be the whole credit, including money for earlier months.
   Showing only the part that belonged to this month left the reader asking
   where the rest came from.

   A MONTH IS CLOSED AT ITS MONTH END. June's statement shows what was
   outstanding on 30 June. That a July file later shows some of it arriving is
   July's business — June still closed owing it. A statement that rewrites
   itself every time a newer file is loaded cannot be signed off.

   EVERY FIGURE NAMES ITS SOURCE, because the first question about any number is
   which of the three files to open to check it.
   ────────────────────────────────────────────────────────────────────────────── */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  RefreshCw, Download, AlertTriangle, AlertCircle, Info, ChevronRight, ChevronDown,
  Package, Receipt, Banknote, X, Loader2, ArrowLeft, CalendarRange, Plus,
  LayoutDashboard, Bot, FileSpreadsheet, Sigma, Clock, FileText, Eye, Trash2, Search,
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
const FULLMON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                 'September', 'October', 'November', 'December'];
const fmtMonth = (m) => {
  if (!m || !/^\d{4}-\d{2}$/.test(m)) return m === 'EARLIER' ? 'Earlier months' : (m || '—');
  const [y, mo] = m.split('-');
  return `${MON[+mo - 1]} ${y}`;
};
const rangeLabel = (ms) => (!ms || !ms.length ? '—'
  : ms.length === 1 ? fmtMonth(ms[0]) : `${fmtMonth(ms[0])} – ${fmtMonth(ms[ms.length - 1])}`);
const pctOf = (a, b) => (!b ? 0 : (100 * a) / b);
const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0); };
const daysOld = (m) => Math.max(0, Math.floor((Date.now() - monthEnd(m).getTime()) / 86400000));
const endLabel = (m) => (/^\d{4}-\d{2}$/.test(m || '')
  ? `${monthEnd(m).getDate()} ${MON[+m.slice(5) - 1]} ${m.slice(0, 4)}` : '—');

/* Amazon's own colours, so the sheet and the screen agree about each source. */
const T = {
  ink: '#232F3E', amber: '#FF9900', amberText: '#8A5200', blue: '#146EB4',
  violet: '#7C3AED', green: '#067647', red: '#B42318',
};
const FILES = {
  order: { label: 'Order report', short: 'Order report', icon: Package, tone: T.violet,
    how: 'Downloaded from Amazon (all orders by order date). The only file that shows a cancelled order.' },
  mtr: { label: 'MTR — sales report with GST', short: 'MTR', icon: Receipt, tone: T.blue,
    how: 'Uploaded from Seller Central. The tax invoice given to the customer, and the base for this report.' },
  settlement: { label: 'Settlement report', short: 'Settlement', icon: Banknote, tone: T.green,
    how: 'Payments received from Amazon. For a month older than 90 days, only the unified transaction report works.' },
  derived: { label: 'Calculated', short: 'Calculated', icon: Sigma, tone: '#475569',
    how: 'Worked out from the lines above. It has no file of its own.' },
};
const PROV = {
  invoiced: { file: 'mtr', column: 'Invoice Amount', filter: 'Transaction Type = Shipment',
    dated: 'Shipment Date, else Invoice Date' },
  returned: { file: 'mtr', column: 'Invoice Amount', filter: 'Transaction Type = Refund',
    note: 'Returns are negative in the MTR and are shown positive here, as a deduction.' },
  netBillable: { file: 'derived', column: 'Sales invoiced − customer returns' },
  fees: { file: 'settlement', column: 'selling fees + fba fees + other transaction fees',
    note: 'Added up with their signs, so a reversed charge is a credit and not another charge.' },
  tds: { file: 'settlement', column: 'TDS (Section 194-O)',
    note: 'Deducted by Amazon against our PAN. Claimed in the income-tax return.' },
  tcs: { file: 'settlement', column: 'TCS-CGST + TCS-SGST + TCS-IGST',
    note: 'Deducted by Amazon under section 52. Claimed in the GST cash ledger.' },
  tdsTcs: { file: 'settlement', column: 'TDS 194-O + TCS CGST/SGST/IGST' },
  expected: { file: 'derived', column: 'Net sales − Amazon charges − TDS − TCS' },
  received: { file: 'settlement', column: 'total', filter: 'payments dated on or before the month end' },
  settled: { file: 'settlement', column: 'total', filter: 'every payment for the order, in any month',
    note: 'Amazon states the payout on each row and the parts add up to it, so it is read and not rebuilt.' },
  closing: { file: 'derived', column: 'Amount due − received by the month end' },
  stillOpen: { file: 'derived', column: 'Amount due − everything received to date' },
  gstMemo: { file: 'mtr', column: 'Total Tax Amount',
    note: 'A memo, never a deduction. Amazon pays this to us with the sale amount and we pay it to the government.' },
  placed: { file: 'order', column: 'amazon-order-id', filter: 'every row, counted once per order' },
  cancelled: { file: 'order', column: 'order-status', filter: 'order-status = Cancelled on every line' },
  net: { file: 'derived', column: 'Orders placed − cancelled' },
  chainInvoiced: { file: 'mtr', column: 'Order Id', filter: 'the order has at least one Shipment row' },
  chainSettled: { file: 'settlement', column: 'order id', filter: 'the order appears in any settlement' },
  chainUnsettled: { file: 'derived', column: 'Net orders with no payment at all' },
  status: { file: 'derived', column: 'order status + MTR presence + settlement presence' },
};

/* The monthly statement, in the order the money moves. */
const LINES = [
  { key: 'invoiced', label: 'Sales invoiced', sign: '+', prov: 'invoiced',
    what: 'Invoice value from the MTR sales report.' },
  { key: 'returned', label: 'Customer returns', sign: '−', prov: 'returned',
    what: 'Refunds given on those orders.' },
  { key: 'netBillable', label: 'Net sales', sign: '=', strong: true, prov: 'netBillable',
    what: 'Sales after customer returns.' },
  { key: 'fees', label: 'Amazon charges', sign: '−', prov: 'fees',
    what: 'Commission, closing fee, FBA and storage.' },
  { key: 'tds', label: 'TDS u/s 194-O', sign: '−', prov: 'tds',
    what: 'Deducted by Amazon against our PAN. Claim in the income-tax return.' },
  { key: 'tcs', label: 'TCS u/s 52 (GST)', sign: '−', prov: 'tcs',
    what: 'Deducted by Amazon. Claim in the GST cash ledger.' },
  { key: 'expected', label: 'Amount due from Amazon', sign: '=', strong: true, prov: 'expected',
    what: 'What Amazon owes on this month’s sales.' },
  { key: 'received', label: 'Received by the month end', sign: '−', prov: 'received',
    what: 'Payments dated on or before the last day of the month.' },
  { key: 'closing', label: 'Closing balance', sign: '=', strong: true, final: true, prov: 'closing',
    what: 'Still to be received as on the month end. Carried into the next month.' },
];
const AFTER = [
  { key: 'receivedLater', label: 'Received later, in a following month', sign: '−', prov: 'settled',
    what: 'Only visible because later months are loaded.' },
  { key: 'stillOpen', label: 'Still pending today', sign: '=', strong: true, prov: 'stillOpen',
    what: 'Not received even after every loaded file.' },
];

const SEV = {
  blocker: { icon: AlertTriangle, bg: '#FEF2F2', fg: '#991B1B', label: 'Needs attention' },
  warning: { icon: AlertCircle, bg: '#FFFBEB', fg: '#92400E', label: 'Warning' },
  info: { icon: Info, bg: '#F0F9FF', fg: '#1E40AF', label: 'For information' },
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
  const [view, setView] = useState('list');     // 'list' | 'report'
  const [wizard, setWizard] = useState(false);
  const [sel, setSel] = useState('');           // '' = whole period, else one month
  const [txOpen, setTxOpen] = useState(false);

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

  const run = async ({ months, basis }) => {
    if (!base) return;
    setRunning(true);
    try {
      const r = await api.post(`${base}/run`, { months, basis });
      setData(r.data);
      setWizard(false);
      setView('report');
      setSel('');
      toast.success(`Report ready — ${months.length} month(s) in ${r.data.builtInMs} ms`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not generate the report');
    } finally { setRunning(false); }
  };

  /* sidebarFor() builds the role's FULL menu. The labels must MATCH the base
     menu's own ("Dashboard", "Agents") because it merges by label — an
     unmatched label is appended as an extra item instead of overriding, which
     produced a duplicate testId and a React key warning. */
  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  const months = data?.ledger?.months || [];
  const shown = useMemo(() => (sel && months.includes(sel) ? [sel] : months), [sel, months]);
  const ST = data?.ledger?.STATUS || {};
  const openDrill = (d) => setDrill({ months: shown, ...d });

  if (loading) {
    return (
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="p-6 flex items-center gap-3 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading Amazon receivables…
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6 pb-16 max-w-[1560px]">
        <button onClick={() => (view === 'report' ? setView('list') : navigate(`/brands/${brandId}/agents`))}
                className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-blue-600 group transition-colors mb-3">
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
          {view === 'report' ? 'Back to reports' : 'Back to Agents'}
        </button>

        {view === 'list' ? (
          <ReportList status={status} data={data} months={months}
                      onOpen={() => { setView('report'); setSel(''); }}
                      onGenerate={() => setWizard(true)} onRefresh={load} />
        ) : (
          <ReportView data={data} status={status} months={months} shown={shown} sel={sel}
                      setSel={setSel} onDrill={openDrill} base={base}
                      onTx={() => setTxOpen(true)} onRefresh={load} ST={ST} />
        )}

        {wizard && (
          <GenerateWizard status={status} running={running}
                          onClose={() => setWizard(false)} onRun={run} />
        )}
        {txOpen && data && (
          <TransactionData data={data} shown={shown} ST={ST} onClose={() => setTxOpen(false)} />
        )}
        {drill && (
          <DrillPanel drill={drill} data={data} ST={ST} base={base} onClose={() => setDrill(null)} />
        )}
      </div>
    </DashboardLayout>
  );
}

/* ── the landing page: what has been generated before ────────────────────── */
function ReportList({ status, data, months, onOpen, onGenerate, onRefresh }) {
  const runs = status?.runs || [];
  const open = (data?.ledger?.perMonth || []).reduce((a, m) => a + (m.stillOpen?.amount || 0), 0);
  const oldest = months.length ? daysOld(months[0]) : 0;
  return (
    <>
      <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Amazon Receivables</h1>
      <p className="text-sm text-slate-500 mt-1.5 max-w-3xl">
        How much we sold on Amazon, how much Amazon has paid, and how much is still pending.
        Built from the order report, the MTR sales report and the settlement report.
      </p>

      <div className="flex items-end justify-between gap-4 mt-7 mb-4 flex-wrap">
        <div>
          <div className="text-xl font-bold text-slate-900">Reconciliation Summary</div>
          <div className="text-sm text-slate-500">Amazon Receivables</div>
        </div>
        <div className="flex gap-2">
          <button onClick={onRefresh}
                  className="px-3 py-2.5 text-sm font-medium rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center gap-2">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button onClick={onGenerate}
                  className="px-4 py-2.5 text-sm font-semibold rounded-lg text-white hover:opacity-90 flex items-center gap-2"
                  style={{ background: T.ink }}>
            <Plus className="h-4 w-4" /> Generate Report
          </button>
        </div>
      </div>

      <div className="flex gap-4 mb-6 flex-wrap">
        <div className="w-[230px] bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Total reports</div>
          <div className="text-4xl font-bold text-slate-900 mt-1">{runs.length}</div>
          <div className="text-xs text-slate-500">Generated</div>
        </div>
        <div className="w-[300px] bg-white border border-slate-200 rounded-xl p-5"
             style={{ borderLeft: `4px solid ${T.amber}` }}>
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Pending from Amazon</div>
          <div className="text-4xl font-bold mt-1" style={{ color: open > 1 ? T.red : T.green }}>
            ₹{inr(open, 0)}
          </div>
          <div className="text-xs text-slate-500">
            {months.length ? `latest report · oldest month is ${oldest} days old` : 'no report yet'}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <FileText className="h-4 w-4 text-slate-400" />
            <span className="font-bold text-slate-800">Report History</span>
            <span className="text-xs font-bold bg-slate-100 rounded-full px-2 py-0.5">{runs.length}</span>
          </div>
          <span className="text-xs text-slate-400">Click View to open the report</span>
        </div>
        {runs.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-slate-600 font-medium">No report has been generated yet.</p>
            <p className="text-sm text-slate-500 mt-1">
              Press <strong>Generate Report</strong> to build one from the three Amazon files.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-5 py-2.5 text-left font-bold">Period</th>
                <th className="px-4 py-2.5 text-left font-bold">Sales booked on</th>
                <th className="px-4 py-2.5 text-right font-bold">Rows read</th>
                <th className="px-4 py-2.5 text-left font-bold">Generated</th>
                <th className="px-5 py-2.5 text-right font-bold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {runs.map((r, i) => (
                <tr key={`${(r.months || []).join('_')}-${i}`} className="hover:bg-slate-50/60">
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <span className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold"
                            style={{ background: '#FFF4E0', color: T.amberText }}>A</span>
                      <div>
                        <div className="font-semibold text-slate-800">{rangeLabel(r.months || [])}</div>
                        <div className="text-[11px] text-slate-400">{(r.months || []).length} month(s)</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <span className="text-[11px] font-bold px-2.5 py-1 rounded-full"
                          style={{ background: '#FFF4E0', color: T.amberText }}>
                      {r.basis === 'order' ? 'Order date' : 'Dispatch date'}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right tabular-nums text-slate-600">
                    {int((r.orderRows || 0) + (r.mtrRows || 0) + (r.settlementRows || 0))}
                  </td>
                  <td className="px-4 py-4 text-slate-600">
                    {r.builtAt ? new Date(r.builtAt).toLocaleString('en-IN') : '—'}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex gap-2 justify-end">
                      <button onClick={onOpen}
                              className="px-4 py-2 text-xs font-semibold rounded-lg text-white flex items-center gap-1.5"
                              style={{ background: T.ink }}>
                        <Eye className="h-3.5 w-3.5" /> View
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/* ── the generate wizard, and the question nothing else asks ─────────────── */
function GenerateWizard({ status, running, onClose, onRun }) {
  const [step, setStep] = useState(1);
  const [from, setFrom] = useState('2026-06');
  const [to, setTo] = useState('2026-08');
  const [basis, setBasis] = useState('dispatch');
  const S = status?.sources;

  const months = useMemo(() => {
    const out = []; let [y, m] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1; if (m > 12) { m = 1; y += 1; }
      if (out.length > 36) break;
    }
    return out;
  }, [from, to]);

  const years = [2025, 2026, 2027];
  const pick = (val, set, label) => (
    <div className="flex-1">
      <label className="block text-xs font-bold text-slate-700 mb-1.5">{label}</label>
      <div className="flex gap-2">
        <select value={val.split('-')[1]} aria-label={`${label} month`}
                onChange={(e) => set(`${val.split('-')[0]}-${e.target.value}`)}
                className="flex-1 text-sm px-3 py-2.5 border border-slate-300 rounded-lg bg-white">
          {FULLMON.map((n, i) => (
            <option key={n} value={String(i + 1).padStart(2, '0')}>{n}</option>
          ))}
        </select>
        <select value={val.split('-')[0]} aria-label={`${label} year`}
                onChange={(e) => set(`${e.target.value}-${val.split('-')[1]}`)}
                className="w-28 text-sm px-3 py-2.5 border border-slate-300 rounded-lg bg-white">
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
    </div>
  );

  const STEPS = ['Period', 'Files', 'Sales basis', 'Generate'];
  const BASES = [
    { key: 'order', title: 'Order date', tag: 'Available',
      what: 'Sale is booked in the month the customer placed the order, even if it was never dispatched.',
      cols: ['order report · purchase-date', 'MTR · Order Date'], ok: true },
    { key: 'dispatch', title: 'Dispatch date', tag: 'Available · default',
      what: 'Sale is booked in the month the goods left the warehouse and the invoice was raised. '
          + 'The amount becomes receivable from this date.',
      cols: ['MTR · Shipment Date', 'MTR · Invoice Date (fallback)'], ok: true },
    { key: 'delivery', title: 'Delivery date', tag: 'Needs one more file',
      what: 'Sale is booked in the month the customer received the goods. The most conservative option.',
      cols: ['not in the order report', 'not in the MTR or settlement'], ok: false },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(35,47,62,0.55)' }}>
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-7 pt-6">
          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Generate Receivables Report</h2>
              <p className="text-sm text-slate-500 mt-0.5">Amazon Receivables · {status?.brand || ''}</p>
            </div>
            <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-slate-100">
              <X className="h-4 w-4 text-slate-500" />
            </button>
          </div>
          <div className="flex items-center gap-2 mt-5 pb-4 border-b border-slate-200">
            {STEPS.map((s, i) => (
              <React.Fragment key={s}>
                <div className="flex items-center gap-2">
                  <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                        style={step === i + 1 ? { background: T.ink, color: '#fff' }
                                              : { background: '#EEF0F3', color: '#5B6472' }}>{i + 1}</span>
                  <span className="text-sm font-semibold whitespace-nowrap"
                        style={{ color: step === i + 1 ? '#111927' : '#5B6472' }}>{s}</span>
                </div>
                {i < STEPS.length - 1 && <span className="flex-1 h-px bg-slate-200" />}
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-auto px-7 py-5">
          {step === 1 && (
            <>
              <div className="flex gap-4 mb-5">{pick(from, setFrom, 'From')}{pick(to, setTo, 'To')}</div>
              <p className="text-sm text-slate-600">
                {months.length} month(s) selected — <strong>{rangeLabel(months)}</strong>.
              </p>
            </>
          )}

          {step === 2 && (
            <>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-3">The three files</div>
              {[['orders', 'order', 'API'], ['mtr', 'mtr', 'Upload only'], ['settlement', 'settlement', 'API or upload']]
                .map(([k, fk, tag]) => {
                  const f = FILES[fk]; const s = S?.[k]; const Icon = f.icon;
                  return (
                    <div key={k} className="border border-slate-200 rounded-xl p-4 mb-3"
                         style={{ borderLeft: `4px solid ${f.tone}` }}>
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2">
                            <Icon className="h-4 w-4" style={{ color: f.tone }} />
                            <span className="font-bold text-slate-800">{f.label}</span>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                              {tag}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 mt-1.5 max-w-xl">{f.how}</p>
                        </div>
                        <span className="text-xs font-bold shrink-0"
                              style={{ color: s?.rows ? T.green : T.red }}>
                          {s?.rows ? `${int(s.rows)} rows · ${s.files} file(s)` : 'not loaded'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              <div className="rounded-xl p-4 mt-4" style={{ background: '#FFFBEB', border: '1px solid #FCD34D' }}>
                <div className="text-xs font-bold mb-1" style={{ color: '#92400E' }}>
                  Why the MTR cannot be downloaded automatically
                </div>
                <p className="text-xs leading-relaxed" style={{ color: '#78350F' }}>
                  Amazon has not yet approved our Tax Invoicing access. Till then, download the MTR from
                  Seller Central and upload it. Files already uploaded are listed above.
                </p>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="rounded-xl p-4 mb-5" style={{ background: '#FFF4E0', border: '1px solid #FFD591' }}>
                <p className="text-sm leading-relaxed" style={{ color: '#6B3F00' }}>
                  Suppose 100 orders come in this month, 80 are dispatched and 60 are delivered. Some companies
                  book sales of <strong>100</strong>, some <strong>80</strong>, some <strong>60</strong>. All three
                  are correct as per their own accounting policy, so we cannot decide it for you.
                  Select it once — sales, amount due, ageing and the month of every order follow this choice.
                </p>
              </div>
              {BASES.map((b) => (
                <label key={b.key}
                       className={`block mb-3 rounded-xl p-4 border-2 ${b.ok ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                       style={{ borderColor: basis === b.key ? T.amber : '#E3E6EA',
                                background: basis === b.key ? '#FFFBF4' : (b.ok ? '#fff' : '#FAFBFC') }}>
                  <div className="flex items-start gap-3">
                    <input type="radio" name="basis" checked={basis === b.key} disabled={!b.ok}
                           onChange={() => b.ok && setBasis(b.key)} className="mt-1 h-4 w-4" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-slate-900">{b.title}</span>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                              style={b.ok ? { background: '#ECFDF3', color: '#065F46' }
                                          : { background: '#FEF3F2', color: T.red }}>{b.tag}</span>
                      </div>
                      <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">{b.what}</p>
                      <div className="flex gap-2 mt-2 flex-wrap">
                        {b.cols.map((c) => (
                          <span key={c} className="text-[10px] font-mono bg-white border border-slate-200 rounded px-2 py-1">
                            {c}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </label>
              ))}
              <div className="rounded-xl p-4" style={{ background: '#FEF3F2', border: '1px solid #FCA5A5' }}>
                <div className="text-xs font-bold mb-1" style={{ color: T.red }}>
                  Delivery date is not available in any of the three Amazon files
                </div>
                <p className="text-xs leading-relaxed" style={{ color: '#7F1D1D' }}>
                  We checked all of them. Order date and dispatch date are on every row; there is no delivery
                  column anywhere. For that option we need Amazon’s <strong>Fulfilled Shipments</strong> report.
                </p>
              </div>
            </>
          )}

          {step === 4 && (
            <div className="space-y-3">
              {[['Period', rangeLabel(months)], ['Months', months.join(', ')],
                ['Sales booked on', basis === 'order' ? 'Order date' : 'Dispatch date'],
                ['Order report', `${int(S?.orders?.rows || 0)} rows`],
                ['MTR sales report', `${int(S?.mtr?.rows || 0)} rows`],
                ['Settlement report', `${int(S?.settlement?.rows || 0)} rows`]].map(([k, v]) => (
                <div key={k} className="flex justify-between py-2.5 border-b border-slate-100">
                  <span className="text-sm text-slate-500">{k}</span>
                  <span className="text-sm font-semibold text-slate-900">{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-7 py-4 border-t border-slate-200 flex justify-between items-center">
          <button onClick={() => (step > 1 ? setStep(step - 1) : onClose())}
                  className="px-4 py-2.5 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-50">
            {step > 1 ? '‹ Back' : 'Cancel'}
          </button>
          {step < 4 ? (
            <button onClick={() => setStep(step + 1)}
                    className="px-6 py-2.5 text-sm font-bold rounded-lg text-white" style={{ background: T.ink }}>
              Next ›
            </button>
          ) : (
            <button onClick={() => onRun({ months, basis })} disabled={running}
                    className="px-6 py-2.5 text-sm font-bold rounded-lg text-white flex items-center gap-2 disabled:opacity-50"
                    style={{ background: T.ink }}>
              {running && <Loader2 className="h-4 w-4 animate-spin" />}
              {running ? 'Generating…' : 'Generate report'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── the report ─────────────────────────────────────────────────────────── */
function ReportView({ data, status, months, shown, sel, setSel, onDrill, base, onTx, onRefresh, ST }) {
  const all = data?.ledger?.perMonth || [];
  const led = all.filter((m) => shown.includes(m.month));
  const one = sel && led.length === 1 ? led[0] : null;
  const basisLabel = data?.basis === 'order' ? 'order date' : 'dispatch date';

  return (
    <>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Order report · MTR · Settlement
          </div>
          <div className="flex items-center gap-3 flex-wrap mt-1">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Receivables Report</h1>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-white text-xs font-semibold"
                  style={{ background: T.ink }}>
              <CalendarRange className="h-3.5 w-3.5" /> {rangeLabel(months)}
            </span>
            <span className="text-xs font-bold px-2.5 py-1 rounded-full"
                  style={{ background: '#FFF4E0', color: T.amberText }}>
              Sales booked on {basisLabel}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={onTx}
                  className="px-3 py-2.5 text-sm font-semibold rounded-lg border flex items-center gap-2"
                  style={{ borderColor: T.amber, color: T.amberText, background: '#FFFBF4' }}>
            <Search className="h-4 w-4" /> Transaction data
          </button>
          <button onClick={onRefresh}
                  className="px-3 py-2.5 text-sm font-medium rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center gap-2">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <ExcelButton base={base} shown={shown} />
        </div>
      </div>

      {/* period filter */}
      <div className="flex items-center gap-2 flex-wrap mb-5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mr-1">Period</span>
        {[{ v: '', label: `All · ${rangeLabel(months)}`, sub: `${months.length} month(s)` },
          ...months.map((m) => ({ v: m, label: fmtMonth(m),
            sub: `${int(all.find((x) => x.month === m)?.invoiced?.count ?? 0)} invoices` }))]
          .map((p) => {
            const on = sel === p.v;
            const openAmt = p.v ? (all.find((x) => x.month === p.v)?.stillOpen?.amount || 0)
                                : all.reduce((a, m) => a + (m.stillOpen?.amount || 0), 0);
            return (
              <button key={p.v || 'all'} onClick={() => setSel(p.v)}
                      className="px-3.5 py-2 rounded-lg border text-left transition-colors"
                      style={on ? { background: T.ink, borderColor: T.ink, color: '#fff' }
                                : { background: '#fff', borderColor: '#E3E6EA', color: '#374151' }}>
                <div className="text-sm font-semibold leading-tight">{p.label}</div>
                <div className="text-[11px] leading-tight mt-0.5" style={{ color: on ? '#C3CAD3' : '#94A3B8' }}>
                  {p.sub}
                  {Math.abs(openAmt) > 1 && (
                    <span className="font-semibold" style={{ color: on ? '#FCA5A5' : T.red }}>
                      {' '}· ₹{inr(openAmt, 0)} pending
                    </span>
                  )}
                </div>
              </button>
            );
          })}
      </div>

      {one ? <MonthStatement m={one} data={data} onDrill={onDrill} />
           : <PeriodOverview led={led} data={data} shown={shown} onDrill={onDrill} />}

      <IssuesPanel audit={data?.audit} shown={shown}
                   onDrill={(i) => onDrill({ kind: 'issue', issue: i })} />
      <LedgerTable led={led} onDrill={onDrill} />
      <JourneyAndScenarios data={data} shown={shown} onDrill={onDrill} ST={ST} />
      <SourcesPanel status={status} sources={(data?.sources || []).filter((s) => shown.includes(s.month))}
                    sourceKind={data?.sourceKind || {}} />
    </>
  );
}

/* ── one month: the four questions, then the statement ───────────────────── */
function MonthStatement({ m, data, onDrill }) {
  const cash = (data?.ledger?.cash || []).find((c) => c.month === m.month)
            || { total: 0, orders: 0, bySaleMonth: [] };
  const own = cash.bySaleMonth.find((x) => x.saleMonth === m.month) || { amount: 0, orders: 0 };
  const older = cash.bySaleMonth.filter((x) => x.saleMonth !== m.month);
  const olderAmt = older.reduce((a, x) => a + x.amount, 0);
  const olderOrders = older.reduce((a, x) => a + x.orders, 0);
  const diff = +(cash.total - own.amount - olderAmt).toFixed(2);

  const cards = [
    { n: 1, q: 'How much did we sell in this month?', val: m.expected.amount, tone: T.blue, fg: '#111927',
      sub: `${int(m.invoiced.count)} invoices · amount due from Amazon`,
      lines: [['Invoice value', inr(m.invoiced.amount)],
              ['Less returns, charges, TDS, TCS',
               inr(m.invoiced.amount - m.expected.amount)]],
      drill: { kind: 'line', line: 'expected' } },
    { n: 2, q: 'How much did Amazon credit in this month?', val: cash.total, tone: T.green, fg: T.green,
      sub: `${int(cash.orders)} orders · total money received`,
      lines: [['For this month’s sales', inr(own.amount)],
              ['For earlier months’ sales', inr(olderAmt)],
              ...(Math.abs(diff) > 0.5 ? [['Difference under checking', inr(diff)]] : [])],
      drill: { kind: 'line', line: 'received' } },
    /* A NEGATIVE closing is not "minus money still to come" — it means Amazon
       paid for goods the customer returned after the month end, so the month
       really did hold cash it would later give back. Flip the question rather
       than printing a minus sign against the word "pending". */
    ...(m.closing.amount < 0 ? [{
      n: 3, q: 'How much was held in excess at the month end?', val: Math.abs(m.closing.amount),
      tone: T.amber, fg: T.amberText,
      sub: `advance held on ${endLabel(m.month)}`,
      lines: [['Amount due', inr(m.expected.amount)],
              ['Received by the month end', inr(m.received.amount)],
              ['Returned to Amazon later', inr(Math.abs(m.receivedLater.amount))]],
      drill: { kind: 'line', line: 'closing' },
    }] : [{
      n: 3, q: 'How much of THIS MONTH’S SALES is not received?', val: m.closing.amount,
      tone: T.red, fg: T.red,
      sub: `pending as on ${endLabel(m.month)}`,
      lines: [['Amount due', inr(m.expected.amount)],
              ['Less received by the month end', inr(m.received.amount)],
              [m.receivedLater.amount > 0
                ? `Later: ₹${inr(m.receivedLater.amount, 0)} came in · ₹${inr(m.stillOpen.amount, 0)} open`
                : 'Nothing has come in since', '']],
      drill: { kind: 'line', line: 'closing' },
    }]),
    { n: 4, q: 'How much of it was old money?', val: olderAmt, tone: T.amber, fg: T.amberText,
      sub: `${int(olderOrders)} orders · sold in an earlier month`,
      lines: [['Part of card 2, not card 1', ''], ['No sales invoice in this report', '']],
      drill: { kind: 'cash', month: m.month } },
  ];

  return (
    <>
      <div className="rounded-xl px-5 py-3.5 mb-5" style={{ background: '#FFF4E0', border: '1px solid #FFD591' }}>
        <p className="text-sm leading-relaxed" style={{ color: '#6B3F00' }}>
          <strong>Cut-off:</strong> this statement is closed on <strong>{endLabel(m.month)}</strong>. Anything
          Amazon paid after that date is not treated as received here, even if the later file is loaded — it
          belongs to that month’s statement. So this month closes with{' '}
          <strong>₹{inr(Math.abs(m.closing.amount))}</strong>{' '}
          {m.closing.amount < 0
            ? 'held in excess — money received for orders the customers returned later.'
            : 'still to be received.'}
        </p>
      </div>

      <div className="grid gap-3.5 grid-cols-1 md:grid-cols-2 xl:grid-cols-4 mb-5">
        {cards.map((c) => (
          <button key={c.n} onClick={() => onDrill({ ...c.drill, months: [m.month] })}
                  className="text-left bg-white border border-slate-200 rounded-xl p-4 hover:shadow-md hover:border-slate-300 transition-all"
                  style={{ borderTop: `4px solid ${c.tone}` }}>
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full text-white text-[11px] font-bold flex items-center justify-center shrink-0"
                    style={{ background: c.tone }}>{c.n}</span>
              <span className="text-[12.5px] font-bold text-slate-700 leading-tight">{c.q}</span>
            </div>
            <div className="text-[26px] font-bold tracking-tight mt-2.5 tabular-nums" style={{ color: c.fg }}>
              ₹{inr(c.val)}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">{c.sub}</div>
            <div className="mt-2.5 pt-2 border-t border-slate-100">
              {c.lines.map(([k, v], i) => (
                <div key={i} className="flex justify-between gap-2 py-0.5">
                  <span className="text-[11.5px] text-slate-500">{k}</span>
                  <span className="text-[11.5px] font-bold text-slate-700 tabular-nums whitespace-nowrap">{v}</span>
                </div>
              ))}
            </div>
          </button>
        ))}
      </div>

      {/* how the four tie together */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 mb-5">
        <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-3">
          How the four amounts tie together
        </div>
        <div className="grid md:grid-cols-2 gap-7">
          <div>
            <div className="text-xs font-bold text-slate-800 mb-2">
              Against {fmtMonth(m.month)} sales — what is still owed
            </div>
            {[[`${fmtMonth(m.month)} sales — amount due`, m.expected.amount, 700, '#111927'],
              ['Less: received by the month end', m.received.amount, 500, T.green],
              [m.closing.amount < 0
                ? `Held in excess on ${endLabel(m.month)}`
                : `Not received as on ${endLabel(m.month)}`,
               Math.abs(m.closing.amount), 800, m.closing.amount < 0 ? T.amberText : T.red]].map(([k, v, w, fg], i) => (
              <div key={i} className="flex justify-between gap-3 py-1.5 border-b border-slate-100">
                <span className="text-[13px]" style={{ fontWeight: w, color: fg }}>{k}</span>
                <span className="text-[13.5px] tabular-nums" style={{ fontWeight: w, color: fg }}>{inr(v)}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-xs font-bold text-slate-800 mb-2">
              Money credited in {fmtMonth(m.month)} — what it was for
            </div>
            {[['For this month’s sales', own.amount, 500, '#111927'],
              ['Add: for earlier months’ sales', olderAmt, 500, T.amberText],
              ...(Math.abs(diff) > 0.5 ? [['Add: difference under checking', diff, 500, T.red]] : []),
              ['Total credited by Amazon', cash.total, 800, T.green]].map(([k, v, w, fg], i) => (
              <div key={i} className="flex justify-between gap-3 py-1.5 border-b border-slate-100">
                <span className="text-[13px]" style={{ fontWeight: w, color: fg }}>{k}</span>
                <span className="text-[13.5px] tabular-nums" style={{ fontWeight: w, color: fg }}>{inr(v)}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-3 leading-relaxed">
          ₹{inr(own.amount)} appears in both columns. On the left it is the part of this month’s bill that has
          been settled; on the right it is the part of this month’s bank credit that belonged to this month.
          Same money, read from the sales side and from the receipts side.
        </p>
      </div>

      {/* whose sales was the cash for */}
      <div className="bg-white border rounded-xl overflow-hidden mb-5" style={{ borderColor: T.amber }}>
        <div className="px-5 py-3.5 border-b flex items-center justify-between gap-3 flex-wrap"
             style={{ background: '#FFFBF4', borderColor: '#FFD591' }}>
          <div>
            <div className="font-bold text-slate-900">
              Is the money Amazon credited in {fmtMonth(m.month)} actually {fmtMonth(m.month)}’s?
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Every payment dated in {fmtMonth(m.month)}, split by the month the sale was made
            </div>
          </div>
          <span className="text-[11px] font-bold px-3 py-1.5 rounded-full"
                style={olderAmt > 1 ? { background: '#FEF3F2', color: T.red }
                                    : { background: '#ECFDF3', color: T.green }}>
            {olderAmt > 1 ? `${pctOf(olderAmt, cash.total).toFixed(1)}% is older money` : 'All of it is this month’s'}
          </span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-5 py-2.5 text-left font-bold">Sale month</th>
              <th className="px-4 py-2.5 text-right font-bold">Orders</th>
              <th className="px-4 py-2.5 text-right font-bold">Amount</th>
              <th className="px-4 py-2.5 text-left font-bold w-56">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {cash.bySaleMonth.map((x) => {
              const share = pctOf(Math.abs(x.amount), Math.abs(cash.total));
              const isOwn = x.saleMonth === m.month;
              return (
                <tr key={x.saleMonth} style={isOwn ? {} : { background: '#FFFBF4' }}>
                  <td className="px-5 py-3">
                    <div className="font-semibold text-slate-800">{fmtMonth(x.saleMonth)}</div>
                    <div className="text-[11px] text-slate-500">
                      {isOwn ? 'Sold and paid in the same month'
                             : x.saleMonth === 'EARLIER'
                               ? 'No sales invoice inside this report — May or before'
                               : 'Sold earlier, paid now'}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-600">{int(x.orders)}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-bold"
                      style={{ color: isOwn ? '#111927' : T.amberText }}>₹{inr(x.amount)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full"
                             style={{ width: `${Math.min(100, share)}%`, background: isOwn ? T.green : T.amber }} />
                      </div>
                      <span className="text-[11px] font-bold text-slate-500 w-11 text-right">{share.toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
            <tr style={{ background: T.ink, color: '#fff' }}>
              <td className="px-5 py-3 font-bold">Total credited in {fmtMonth(m.month)}</td>
              <td className="px-4 py-3 text-right tabular-nums font-bold">{int(cash.orders)}</td>
              <td className="px-4 py-3 text-right tabular-nums font-bold">₹{inr(cash.total)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── the whole period: volume, summary, cash cycle ───────────────────────── */
function PeriodOverview({ led, data, shown, onDrill }) {
  const t = data?.three?.totals || {};
  const amt = (k) => led.reduce((a, m) => a + (m[k]?.amount || 0), 0);
  const cnt = (k) => led.reduce((a, m) => a + (m[k]?.count || 0), 0);
  const VOL = [
    { cap: 'Orders placed', v: t.placed, src: 'order', note: 'All orders in the period, counted once each' },
    { cap: 'Cancelled', v: t.cancelled, src: 'order', note: 'Cancelled before dispatch — no invoice, no payment', fg: T.amberText },
    { cap: 'Invoiced', v: t.shipped, src: 'mtr', note: 'Invoice raised in the MTR sales report' },
    { cap: 'Paid by Amazon', v: t.settled, src: 'settlement', note: 'Payment received, in any month', fg: T.green },
    { cap: 'Not paid yet', v: t.unsettled, src: 'settlement', note: 'No payment received at all', fg: T.red },
    { cap: 'Not an Amazon sale', v: (led[0]?.byStatus || []).length
        ? led.reduce((a, m) => a + (m.byStatus.find((b) => /MCF/.test(b.status))?.count || 0), 0) : 0,
      src: 'order', note: 'Sold on another website, only shipped by Amazon', fg: '#5B6472' },
  ];
  const EQ = [
    { cap: 'Net sales', v: amt('netBillable'), note: 'Sales after customer returns', op: '−' },
    { cap: 'Amazon charges', v: amt('fees'), note: 'Commission, closing fee, FBA and storage', op: '−', fg: T.amberText, bg: '#FFFBF4' },
    { cap: 'TDS u/s 194-O', v: amt('tds'), note: 'Against our PAN. Claim in the income-tax return.', op: '−', fg: T.amberText, bg: '#FFFBF4' },
    { cap: 'TCS u/s 52 (GST)', v: amt('tcs'), note: 'Claim in the GST cash ledger.', op: '=', fg: T.amberText, bg: '#FFFBF4' },
    { cap: 'Due from Amazon', v: amt('expected'), note: 'Amount due on these invoices', op: '−', bg: '#F7F9FB' },
    { cap: 'Received to date', v: amt('settled'), note: 'In this month or later', op: '=', fg: T.green, bg: '#F3FBF6' },
    { cap: 'Still pending', v: amt('stillOpen'), note: 'Not received after every loaded file', op: '', fg: T.red, bg: '#FEF8F8' },
  ];
  return (
    <>
      <Card title="Order Cycle — Volume" sub="What happened to every order in this period. Click any number to see the orders.">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-px bg-slate-100">
          {VOL.map((v) => {
            const f = FILES[v.src]; const Icon = f.icon;
            return (
              <div key={v.cap} className="bg-white p-4">
                <div className="text-[10.5px] font-bold uppercase tracking-wider text-slate-400">{v.cap}</div>
                <div className="text-[29px] font-bold tracking-tight mt-1 tabular-nums" style={{ color: v.fg || '#111927' }}>
                  {int(v.v)}
                </div>
                <p className="text-[11.5px] text-slate-500 mt-1.5 leading-snug">{v.note}</p>
                <div className="flex items-center gap-1 mt-2 text-[10px] font-bold" style={{ color: f.tone }}>
                  <Icon className="h-3 w-3" /> {f.short}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Cash Cycle" sub="How much of the net sales has actually been received">
        <div className="p-5">
          <div className="flex items-stretch gap-2.5 flex-wrap">
            {EQ.map((e) => (
              <React.Fragment key={e.cap}>
                <div className="flex-1 min-w-[170px] border border-slate-200 rounded-xl p-4"
                     style={{ background: e.bg || '#fff' }}>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{e.cap}</div>
                  <div className="text-[22px] font-bold tracking-tight mt-1 tabular-nums"
                       style={{ color: e.fg || '#111927' }}>₹{inr(e.v)}</div>
                  <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">{e.note}</p>
                </div>
                {e.op && <div className="flex items-center text-xl font-bold text-slate-300">{e.op}</div>}
              </React.Fragment>
            ))}
          </div>
          <div className="grid md:grid-cols-2 gap-3 mt-3">
            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/50">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                GST included in the amount due (memo)
              </div>
              <div className="text-xl font-bold mt-1 tabular-nums">₹{inr(amt('gstMemo'))}</div>
              <p className="text-[11px] text-slate-500 mt-1">
                Amazon pays this to us along with the sale amount. It is not a deduction. We pay it to the government.
              </p>
            </div>
            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/50">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Received after the sale month ended
              </div>
              <div className="text-xl font-bold mt-1 tabular-nums">₹{inr(amt('receivedLater'))}</div>
              <p className="text-[11px] text-slate-500 mt-1">
                Sales of one month for which payment came in a later month.
              </p>
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}

function Card({ title, sub, children, right }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden mb-5">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="font-bold text-slate-800">{title}</h3>
          {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

/* ── what needs attention ────────────────────────────────────────────────── */
function IssuesPanel({ audit, shown, onDrill }) {
  if (!audit?.issues?.length) return null;
  const issues = audit.issues.filter((i) => !i.month || shown.includes(i.month));
  if (!issues.length) {
    return (
      <div className="rounded-xl px-5 py-3.5 mb-5" style={{ background: '#ECFDF3', border: '1px solid #6EE7B7' }}>
        <p className="text-sm" style={{ color: '#047857' }}>
          <strong>Nothing needs attention in {rangeLabel(shown)}.</strong> {audit.verdict}.
        </p>
      </div>
    );
  }
  const counts = issues.reduce((a, i) => ({ ...a, [i.severity]: (a[i.severity] || 0) + 1 }), {});
  return (
    <Card title="What needs attention"
          sub={`${audit.verdict} · nothing here is a plug — where a figure cannot be explained it says so`}
          right={
            <div className="flex gap-2">
              {['blocker', 'warning', 'info'].map((k) => counts[k] > 0 && (
                <span key={k} className="px-2.5 py-1 rounded text-xs font-bold"
                      style={{ background: SEV[k].bg, color: SEV[k].fg }}>
                  {counts[k]} {SEV[k].label}
                </span>
              ))}
            </div>}>
      <div className="divide-y divide-slate-100">
        {issues.map((i) => {
          const s = SEV[i.severity]; const Icon = s.icon;
          return (
            <div key={i.id} className="p-4" style={{ background: s.bg }}>
              <div className="flex items-start gap-3">
                <Icon className="h-5 w-5 shrink-0 mt-0.5" style={{ color: s.fg }} />
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-slate-900">{i.title}</div>
                  <dl className="mt-2 grid gap-3 md:grid-cols-3 text-xs">
                    {[['What it is', i.what], ['Why it happens', i.why], ['What to do', i.howToFix]].map(([k, v]) => (
                      <div key={k}>
                        <dt className="font-bold text-slate-500 uppercase tracking-wide">{k}</dt>
                        <dd className="text-slate-700 mt-0.5 leading-relaxed">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  {i.drill && (
                    <button onClick={() => onDrill(i)}
                            className="mt-3 text-xs font-bold underline underline-offset-2" style={{ color: s.fg }}>
                      Show the {i.count ? `${int(i.count)} ` : ''}orders behind this →
                    </button>
                  )}
                </div>
                {i.amount !== 0 && (
                  <div className="text-lg font-bold tabular-nums shrink-0" style={{ color: s.fg }}>
                    ₹{inr(i.amount)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ── the statement, month by month ───────────────────────────────────────── */
function LedgerTable({ led, onDrill }) {
  const ms = led.map((m) => m.month);
  const row = (L, after) => {
    const vals = led.map((m) => m[L.key]?.amount ?? 0);
    const total = vals.reduce((a, b) => a + b, 0);
    const f = FILES[PROV[L.prov].file]; const Icon = f.icon;
    return (
      <tr key={L.key} className={L.strong ? 'bg-slate-50/70' : ''}
          style={after ? { opacity: 0.92 } : {}}>
        <td className="px-4 py-2.5 text-slate-400 font-mono w-7">{L.sign}</td>
        <td className="px-2 py-2.5 whitespace-nowrap">
          <div className={L.strong ? 'font-bold text-slate-900' : 'text-slate-700'}>{L.label}</div>
        </td>
        <td className="px-3 py-2.5">
          <span className="inline-flex items-center gap-1 text-[10px] font-bold whitespace-nowrap" style={{ color: f.tone }}>
            <Icon className="h-3 w-3" /> {f.short}
          </span>
        </td>
        {led.map((m, i) => (
          <td key={m.month} className="px-4 py-2.5 text-right tabular-nums">
            <button onClick={() => onDrill({ kind: 'line', line: L.key, months: [m.month] })}
                    className={`hover:underline underline-offset-2 ${L.strong ? 'font-bold text-slate-900' : 'text-slate-700'}`}
                    style={L.final && vals[i] < 0 ? { color: T.amberText } : {}}>
              {inr(vals[i])}
            </button>
          </td>
        ))}
        {ms.length > 1 && (
          <td className={`px-4 py-2.5 text-right tabular-nums border-l border-slate-200 ${L.strong ? 'font-bold' : ''}`}>
            {inr(total)}
          </td>
        )}
        <td className="px-4 py-2.5 text-xs text-slate-400 max-w-md">{L.what}</td>
      </tr>
    );
  };
  return (
    <Card title={`Monthly statement · ${rangeLabel(ms)}`}
          sub="Each month is closed at its own month end. Click any number to see the orders and the file it came from.">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="w-7" /><th className="px-2 py-2.5 text-left font-bold">Line</th>
              <th className="px-3 py-2.5 text-left font-bold">Source</th>
              {ms.map((m) => <th key={m} className="px-4 py-2.5 text-right font-bold">{fmtMonth(m)}</th>)}
              {ms.length > 1 && <th className="px-4 py-2.5 text-right font-bold border-l border-slate-200">Total</th>}
              <th className="px-4 py-2.5 text-left font-bold">What this line is</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {LINES.map((L) => row(L))}
            <tr className="bg-slate-100/70">
              <td /><td colSpan={2 + ms.length + (ms.length > 1 ? 1 : 0) + 1}
                        className="px-2 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Afterwards — only visible because later months are loaded
              </td>
            </tr>
            {AFTER.map((L) => row(L, true))}
            <tr className="bg-sky-50/40">
              <td /><td className="px-2 py-2 text-xs italic text-slate-500 whitespace-nowrap">(memo) GST within it</td><td />
              {led.map((m) => (
                <td key={m.month} className="px-4 py-2 text-right tabular-nums text-xs text-slate-600">
                  {inr(m.gstMemo?.amount ?? 0)}
                </td>
              ))}
              {ms.length > 1 && <td className="border-l border-slate-200" />}
              <td className="px-4 py-2 text-xs text-slate-400">
                How much of the amount due is GST we will pay to the government. Not withheld by Amazon.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ── order journey and settlement scenarios ──────────────────────────────── */
function JourneyAndScenarios({ data, shown, onDrill, ST }) {
  const t = data?.three?.totals || {};
  const led = (data?.ledger?.perMonth || []).filter((m) => shown.includes(m.month));
  const statuses = led[0]?.byStatus?.map((b) => b.status) || [];
  const totalOrders = t.placed || 0;
  const FUNNEL = [
    { n: 1, stage: 'Orders placed', rule: 'All orders in the period', src: 'order', v: t.placed, step: 'placed' },
    { n: 2, stage: 'Cancelled before invoice', rule: 'Cancelled before dispatch', src: 'order', v: t.cancelled, step: 'cancelled' },
    { n: 3, stage: 'Net orders', rule: 'Orders placed minus cancelled', src: 'derived', v: t.net, step: 'net', strong: true },
    { n: 4, stage: 'Invoiced (MTR)', rule: 'Invoice raised — the amount becomes due from here', src: 'mtr', v: t.shipped, step: 'invoiced' },
    { n: 5, stage: 'Paid by Amazon', rule: 'Payment received, in any month', src: 'settlement', v: t.settled, step: 'settled' },
    { n: 6, stage: 'Not paid yet', rule: 'No payment received at all', src: 'derived', v: t.unsettled, step: 'unsettled', strong: true },
  ];
  return (
    <>
      <Card title="Order Journey" sub="What happened to every order, stage by stage. Click a count for the orders.">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-5 py-2.5 text-left font-bold w-12">#</th>
              <th className="px-2 py-2.5 text-left font-bold">Stage</th>
              <th className="px-4 py-2.5 text-left font-bold">Source</th>
              <th className="px-4 py-2.5 text-right font-bold">Orders</th>
              <th className="px-5 py-2.5 text-right font-bold">% of all orders</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {FUNNEL.map((f) => {
              const F = FILES[f.src]; const Icon = F.icon;
              return (
                <tr key={f.n} className={f.strong ? 'bg-slate-50/70' : ''}>
                  <td className="px-5 py-3">
                    <span className="text-[11px] font-bold text-slate-500 bg-slate-100 rounded px-2 py-0.5">{f.n}</span>
                  </td>
                  <td className="px-2 py-3">
                    <div className={f.strong ? 'font-bold text-slate-900' : 'text-slate-800'}>{f.stage}</div>
                    <div className="text-[11px] text-slate-500">{f.rule}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold" style={{ color: F.tone }}>
                      <Icon className="h-3 w-3" /> {F.short}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <button onClick={() => onDrill({ kind: 'chain', step: f.step })}
                            className="font-bold text-blue-600 hover:underline underline-offset-2">{int(f.v)}</button>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-slate-500">
                    {pctOf(f.v, totalOrders).toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title="Where every order ended up"
            sub="Every order falls in exactly one row, so the rows add up to the total order count.">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-5 py-2.5 text-left font-bold">Status</th>
                {led.map((m) => <th key={m.month} className="px-4 py-2.5 text-right font-bold">{fmtMonth(m.month)}</th>)}
                <th className="px-5 py-2.5 text-right font-bold border-l border-slate-200">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {statuses.map((st) => {
                const cells = led.map((m) => m.byStatus.find((b) => b.status === st) || { count: 0, amount: 0 });
                const tot = cells.reduce((a, c) => ({ count: a.count + c.count, amount: a.amount + c.amount }),
                                         { count: 0, amount: 0 });
                return (
                  <tr key={st}>
                    <td className="px-5 py-2.5 text-slate-700">{st}</td>
                    {led.map((m, i) => (
                      <td key={m.month} className="px-4 py-2.5 text-right tabular-nums">
                        <button onClick={() => onDrill({ kind: 'status', status: st, months: [m.month] })}
                                className="text-slate-700 hover:underline underline-offset-2">
                          {int(cells[i].count)}
                          <div className="text-[10px] text-slate-400">₹{inr(cells[i].amount, 0)}</div>
                        </button>
                      </td>
                    ))}
                    <td className="px-5 py-2.5 text-right tabular-nums font-bold border-l border-slate-200">
                      {int(tot.count)}
                      <div className="text-[10px] font-normal text-slate-400">₹{inr(tot.amount, 0)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3.5 border-t border-slate-100" style={{ background: '#FFFBEB' }}>
          <div className="text-xs font-bold mb-1" style={{ color: '#92400E' }}>
            Prepaid and COD split needs one more file
          </div>
          <p className="text-xs leading-relaxed" style={{ color: '#78350F' }}>
            None of the three Amazon files shows whether an order was prepaid or COD. Amazon collects from the
            customer in both cases and pays us on the same weekly cycle, so from our side both look the same.
            That split needs Amazon’s <strong>Fulfilled Shipments</strong> report.
          </p>
        </div>
      </Card>
    </>
  );
}

/* ── the three files ─────────────────────────────────────────────────────── */
function SourcesPanel({ status, sources, sourceKind }) {
  const S = status?.sources;
  return (
    <Card title="The three files this is built from"
          sub="They are not meant to be equal — each one counts a different moment.">
      <div className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-100">
        {[['orders', 'order'], ['mtr', 'mtr'], ['settlement', 'settlement']].map(([k, fk]) => {
          const f = FILES[fk]; const s = S?.[k]; const Icon = f.icon;
          return (
            <div key={k} className="p-4">
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4" style={{ color: f.tone }} />
                <span className="font-semibold text-slate-800 text-sm">{f.label}</span>
              </div>
              <div className="text-2xl font-bold text-slate-900 mt-2">
                {s ? int(s.rows) : '—'} <span className="text-sm font-medium text-slate-400">rows</span>
              </div>
              <div className="text-xs text-slate-500">{s ? `${s.files} file(s)` : 'not loaded'}</div>
              <p className="text-[11.5px] text-slate-400 mt-2 leading-relaxed">{f.how}</p>
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
                {sources.map((s) => <th key={s.month} className="px-4 py-2 text-right font-bold">{fmtMonth(s.month)}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {[['order', 'Order report — orders'], ['mtr', 'MTR — orders invoiced'],
                ['settlement', 'Settlement — orders paid']].map(([k, l]) => (
                <tr key={k}>
                  <td className="px-4 py-2 font-medium text-slate-600">{l}</td>
                  {sources.map((s) => (
                    <td key={s.month} className="px-4 py-2 text-right tabular-nums text-slate-800">
                      {int(s[k].orders)} <span className="text-slate-400">· ₹{inr(s[k].value, 0)}</span>
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="bg-slate-50/60">
                <td className="px-4 py-2 font-medium text-slate-600">Settlement came from</td>
                {sources.map((s) => (
                  <td key={s.month} className="px-4 py-2 text-right text-slate-600">
                    {sourceKind[s.month] === 'unified'
                      ? <span className="font-bold" style={{ color: T.amberText }}>unified transaction report</span>
                      : 'saved settlement files'}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ExcelButton({ base, shown }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!base) return;
    setBusy(true);
    try {
      const r = await api.get(`${base}/export`, { params: { months: shown.join(',') }, responseType: 'blob' });
      const name = (r.headers['content-disposition'] || '').match(/filename="([^"]+)"/)?.[1]
        || `Amazon_Receivables_${shown[0]}_to_${shown[shown.length - 1]}.xlsx`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.data); a.download = name; a.click();
      URL.revokeObjectURL(a.href);
      toast.success('Workbook downloaded');
    } catch { toast.error('Could not build the workbook'); } finally { setBusy(false); }
  };
  return (
    <button onClick={go} disabled={busy}
            className="px-3 py-2.5 text-sm font-semibold rounded-lg border flex items-center gap-2 disabled:opacity-50"
            style={{ borderColor: '#A7F3D0', background: '#ECFDF3', color: '#047857' }}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
      {busy ? 'Building…' : 'Excel'}
    </button>
  );
}

/* ── which rows sit behind a figure ───────────────────────────────────────── */
function drillRows(drill, data, ST) {
  const all = data?.ledger?.rows || [];
  const ms = drill.months || [];
  const inSel = (r) => !ms.length || ms.includes(r.month);
  const billable = (r) => r.status !== ST.CANCELLED && r.status !== ST.NOT_AMAZON;
  const due = (r) => +(r.invoiced - r.refunded - r.fees - r.tds - r.tcs).toFixed(2);
  const recdBy = (r, m) => Object.entries(r.settledBy || {})
    .reduce((a, [cm, v]) => a + (cm && cm <= m ? v : 0), 0);

  if (drill.kind === 'issue') {
    return { kind: 'ledger', rows: data?.drills?.[drill.issue.id] || [],
             prov: PROV[drill.issue.drill === 'fees' ? 'fees'
                      : drill.issue.drill === 'overCollected' ? 'received'
                      : drill.issue.drill === 'priorRefunds' ? 'returned' : 'closing'] };
  }
  if (drill.kind === 'status') {
    return { kind: 'ledger', prov: PROV.status,
             rows: all.filter((r) => inSel(r) && r.status === drill.status) };
  }
  if (drill.kind === 'cash') {
    /* money credited in this month that was NOT for this month's sales */
    const m = drill.month;
    return { kind: 'ledger', prov: PROV.received,
             rows: all.filter((r) => r.month !== m && (r.settledBy || {})[m]) };
  }
  if (drill.kind === 'chain') {
    const rows = (data?.three?.orderRows || []).filter(inSel);
    const pick = {
      placed: () => rows, cancelled: () => rows.filter((r) => r.cancelled),
      net: () => rows.filter((r) => !r.cancelled),
      invoiced: () => rows.filter((r) => !r.cancelled && r.invoiced),
      settled: () => rows.filter((r) => !r.cancelled && r.settled),
      unsettled: () => rows.filter((r) => !r.cancelled && !r.settled),
    }[drill.step] || (() => rows);
    const pk = { placed: 'placed', cancelled: 'cancelled', net: 'net', invoiced: 'chainInvoiced',
                 settled: 'chainSettled', unsettled: 'chainUnsettled' }[drill.step] || 'placed';
    return { kind: 'chain', rows: pick(), prov: PROV[pk] };
  }
  const mine = all.filter(inSel).filter(billable);
  const m0 = ms[0];
  const pick = {
    returned: () => mine.filter((r) => r.refunded > 0),
    fees: () => mine.filter((r) => r.fees > 0),
    tds: () => mine.filter((r) => r.tds > 0),
    tcs: () => mine.filter((r) => r.tcs > 0),
    received: () => mine.filter((r) => recdBy(r, m0) !== 0),
    receivedLater: () => mine.filter((r) => r.settled - recdBy(r, m0) !== 0),
    /* the closing balance: every order not fully paid by the month end — a part
       settlement belongs here just as much as an order with no payment at all */
    closing: () => mine.filter((r) => Math.abs(due(r) - recdBy(r, m0)) > 0.01),
    stillOpen: () => mine.filter((r) => Math.abs(due(r) - r.settled) > 0.01),
  }[drill.line];
  return { kind: 'ledger', rows: pick ? pick() : mine, prov: PROV[drill.line] || PROV.invoiced };
}

const LEDGER_COLS = [
  { key: 'orderId', label: 'Order ID', mono: true, w: 22 },
  { key: 'month', label: 'Sale month', fmt: fmtMonth },
  { key: 'status', label: 'Status' },
  { key: 'invoiced', label: 'Invoiced', num: true },
  { key: 'refunded', label: 'Returned', num: true },
  { key: 'fees', label: 'Amazon charges', num: true },
  { key: 'tds', label: 'TDS', num: true },
  { key: 'tcs', label: 'TCS', num: true },
  { key: 'netDue', label: 'Net amount due', num: true, calc: (r) => +(r.invoiced - r.refunded - r.fees - r.tds - r.tcs).toFixed(2) },
  { key: 'settled', label: 'Received', num: true },
  { key: 'diff', label: 'Difference', num: true, calc: (r) => +(r.invoiced - r.refunded - r.fees - r.tds - r.tcs - r.settled).toFixed(2) },
  { key: 'settledMonth', label: 'Payment month', fmt: (v) => (v ? fmtMonth(v) : '—') },
];
const CHAIN_COLS = [
  { key: 'orderId', label: 'Order ID', mono: true, w: 22 },
  { key: 'month', label: 'Sale month', fmt: fmtMonth },
  { key: 'status', label: 'Order status' },
  { key: 'invoiced', label: 'Invoiced?', bool: true },
  { key: 'settled', label: 'Paid?', bool: true },
  { key: 'value', label: 'Order value', num: true },
  { key: 'shipState', label: 'Ship state' },
];

function DrillPanel({ drill, data, ST, base, onClose }) {
  const [busy, setBusy] = useState(false);
  const { kind, rows, prov } = useMemo(() => drillRows(drill, data, ST), [drill, data, ST]);
  const cols = kind === 'chain' ? CHAIN_COLS : LEDGER_COLS;
  const f = FILES[prov.file]; const FIcon = f.icon;
  const period = rangeLabel(drill.months || []);
  const title = drill.kind === 'issue' ? drill.issue.title
    : drill.kind === 'status' ? `${period} · ${drill.status}`
    : drill.kind === 'cash' ? `${period} · credited for earlier months’ sales`
    : drill.kind === 'chain' ? `${period} · ${{
        placed: 'Orders placed', cancelled: 'Cancelled', net: 'Net orders',
        invoiced: 'Invoiced', settled: 'Paid by Amazon', unsettled: 'Not paid yet',
      }[drill.step] || drill.step}`
    : `${period} · ${[...LINES, ...AFTER].find((l) => l.key === drill.line)?.label || drill.line}`;

  const val = (r, c) => (c.calc ? c.calc(r) : r[c.key]);
  const cell = (r, c) => {
    const v = val(r, c);
    if (c.bool) return v ? 'Yes' : 'No';
    if (c.num) return v ? inr(v) : '—';
    if (c.fmt) return c.fmt(v);
    return v === '' || v === undefined || v === null ? '—' : v;
  };
  const totals = useMemo(() => cols.filter((c) => c.num).reduce((a, c) => ({
    ...a, [c.key]: rows.reduce((s, r) => s + (Number(val(r, c)) || 0), 0) }), {}), [rows, cols]);
  const stem = `amazon-receivables-${(drill.months || []).join('_') || 'all'}-${drill.kind}`;

  const excel = async () => {
    if (!base) return;
    setBusy(true);
    try {
      const r = await api.post(`${base}/export/drill`, {
        title, period, filename: stem,
        provenance: { file: f.short, column: prov.column, filter: prov.filter, dated: prov.dated,
                      note: prov.note || f.how },
        columns: cols.map((c) => ({ key: c.key, label: c.label, mono: !!c.mono, money: !!c.num,
                                    width: c.w || Math.max(12, c.label.length + 6) })),
        rows: rows.map((row) => cols.reduce((a, c) => ({
          ...a, [c.key]: c.bool ? (val(row, c) ? 'Yes' : 'No')
            : c.num ? Number(val(row, c) || 0)
            : c.fmt ? c.fmt(val(row, c)) : val(row, c) }), {})),
      }, { responseType: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.data); a.download = `${stem}.xlsx`; a.click();
      URL.revokeObjectURL(a.href);
    } catch { toast.error('Could not build the sheet'); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" onClick={onClose}>
      <div className="w-full max-w-6xl bg-white h-full overflow-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 bg-white border-b border-slate-200">
          <div className="px-5 py-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900">{title}</h3>
              <p className="text-xs text-slate-400">{int(rows.length)} orders · {period}</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={excel} disabled={busy}
                      className="px-3 py-1.5 text-xs font-bold rounded-lg border flex items-center gap-1.5 disabled:opacity-50"
                      style={{ borderColor: '#A7F3D0', background: '#ECFDF3', color: '#047857' }}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
                {busy ? 'Building…' : 'Excel'}
              </button>
              <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-slate-100">
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
          </div>
          <div className="px-5 py-2.5 bg-slate-50 border-t border-slate-100 flex items-start gap-2">
            <FIcon className="h-4 w-4 mt-0.5 shrink-0" style={{ color: f.tone }} />
            <div className="text-xs text-slate-600 leading-relaxed">
              <span className="font-bold text-slate-800">Where this comes from:</span>{' '}
              <span className="font-bold" style={{ color: f.tone }}>{f.label}</span>
              {prov.column && <> · column <code className="px-1 bg-white border border-slate-200 rounded">{prov.column}</code></>}
              {prov.filter && <> · filter <code className="px-1 bg-white border border-slate-200 rounded">{prov.filter}</code></>}
              {prov.dated && <> · dated by {prov.dated}</>}
              <div className="text-slate-500 mt-0.5">{prov.note || f.how}</div>
            </div>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">
            No orders in this group for {period}. That is an answer, not an error — the figure above is nil
            for the same reason.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
              <tr>{cols.map((c) => (
                <th key={c.key} className={`px-3 py-2 font-bold ${c.num ? 'text-right' : 'text-left'}`}>{c.label}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {rows.slice(0, 500).map((r, i) => (
                <tr key={`${r.orderId}-${i}`} className="hover:bg-slate-50">
                  {cols.map((c) => (
                    <td key={c.key}
                        className={`px-3 py-1.5 ${c.num ? 'text-right tabular-nums' : ''} ${c.mono ? 'font-mono text-slate-700' : 'text-slate-600'}`}>
                      {cell(r, c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-slate-200 font-bold text-slate-800" style={{ background: '#F1F5F9' }}>
              <tr>{cols.map((c, i) => (
                <td key={c.key} className={`px-3 py-2 ${c.num ? 'text-right tabular-nums' : ''}`}>
                  {i === 0 ? `${int(rows.length)} orders` : c.num ? inr(totals[c.key]) : ''}
                </td>
              ))}</tr>
            </tfoot>
          </table>
        )}
        {rows.length > 500 && (
          <p className="p-4 text-xs text-slate-400">
            Showing the first 500 of {int(rows.length)} — the totals above cover all of them.
            Download the Excel for the full list.
          </p>
        )}
      </div>
    </div>
  );
}

/* ── every order, end to end ─────────────────────────────────────────────── */
function TransactionData({ data, shown, ST, onClose }) {
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const all = (data?.ledger?.rows || []).filter((r) => shown.includes(r.month));
  const due = (r) => +(r.invoiced - r.refunded - r.fees - r.tds - r.tcs).toFixed(2);
  const TABS = [
    { k: 'all', label: 'All orders', f: () => all },
    { k: 'inmonth', label: 'Paid in the month', f: () => all.filter((r) => r.status === ST.SETTLED_IN_MONTH) },
    { k: 'later', label: 'Paid later', f: () => all.filter((r) => r.status === ST.SETTLED_LATER) },
    { k: 'open', label: 'Not paid', f: () => all.filter((r) => Math.abs(due(r) - r.settled) > 0.01) },
    { k: 'ret', label: 'Returned', f: () => all.filter((r) => r.status === ST.RETURNED) },
  ];
  const rows = (TABS.find((t) => t.k === tab) || TABS[0]).f()
    .filter((r) => !q || r.orderId.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 bg-white overflow-auto">
      <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 z-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Transaction Data</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Order-wise details for {rangeLabel(shown)}. Click any row to see that order in each file.
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
                   aria-label="Search order ID" placeholder="Search order ID…"
                   className="text-sm px-3 py-2 border border-slate-300 rounded-lg w-56" />
            <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-slate-100">
              <X className="h-5 w-5 text-slate-500" />
            </button>
          </div>
        </div>
        <div className="flex gap-6 mt-4 border-b border-slate-200 -mb-4">
          {TABS.map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)}
                    className="pb-3 text-sm font-bold border-b-[3px]"
                    style={tab === t.k ? { borderColor: T.amber, color: '#111927' }
                                       : { borderColor: 'transparent', color: '#5B6472' }}>
              {t.label} <span className="text-xs font-bold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5 ml-1">
                {int(t.f().length)}</span>
            </button>
          ))}
        </div>
      </div>

      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
          <tr>
            <th className="w-8" />
            {['Order ID', 'Sale month', 'Invoiced', 'Returned', 'Amazon charges', 'TDS', 'TCS',
              'Net amount due', 'Received', 'Difference', 'Payment month', 'Status'].map((h, i) => (
              <th key={h} className={`px-3 py-2.5 font-bold ${i >= 2 && i <= 9 ? 'text-right' : 'text-left'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.slice(0, 400).map((r, i) => {
            const d = +(due(r) - r.settled).toFixed(2);
            const isOpen = open === r.orderId;
            return (
              <React.Fragment key={`${r.orderId}-${i}`}>
                <tr className="hover:bg-slate-50 cursor-pointer" onClick={() => setOpen(isOpen ? null : r.orderId)}>
                  <td className="pl-3 text-slate-400">
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </td>
                  <td className="px-3 py-2 font-mono font-semibold text-slate-800">{r.orderId}</td>
                  <td className="px-3 py-2 text-slate-600">{fmtMonth(r.month)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{inr(r.invoiced)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.refunded ? inr(r.refunded) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.fees ? inr(r.fees) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.tds ? inr(r.tds) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.tcs ? inr(r.tcs) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-bold">{inr(due(r))}</td>
                  <td className="px-3 py-2 text-right tabular-nums" style={{ color: T.green }}>{inr(r.settled)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className="px-2 py-0.5 rounded-full font-bold"
                          style={Math.abs(d) < 0.01 ? { background: '#ECFDF3', color: T.green }
                                                    : { background: '#FFFBEB', color: '#92400E' }}>
                      {Math.abs(d) < 0.01 ? '₹0' : inr(d)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{r.settledMonth ? fmtMonth(r.settledMonth) : '—'}</td>
                  <td className="px-3 py-2 text-slate-600">{r.status}</td>
                </tr>
                {isOpen && (
                  <tr style={{ background: '#FAFBFC' }}>
                    <td colSpan={13} className="px-10 py-4">
                      <div className="grid md:grid-cols-4 gap-3">
                        {[
                          { f: 'order', rows: [['Sale month', fmtMonth(r.month)], ['Order status', r.status]] },
                          { f: 'mtr', rows: [['Invoice value', `₹${inr(r.invoiced)}`], ['Returns', r.refunded ? `₹${inr(r.refunded)}` : 'none'],
                                             ['GST within it', `₹${inr(r.gst)}`]] },
                          { f: 'settlement', rows: [['Received', `₹${inr(r.settled)}`],
                                                    ['Payment month', r.settledMonth ? fmtMonth(r.settledMonth) : 'no payment yet'],
                                                    ...Object.entries(r.settledBy || {}).map(([m, v]) => [`Paid in ${fmtMonth(m)}`, `₹${inr(v)}`])] },
                          { f: 'derived', rows: [['Amazon charges', `₹${inr(r.fees)}`], ['TDS u/s 194-O', `₹${inr(r.tds)}`],
                                                 ['TCS u/s 52', `₹${inr(r.tcs)}`], ['Net amount due', `₹${inr(due(r))}`],
                                                 ['Difference', `₹${inr(d)}`]] },
                        ].map(({ f, rows: kv }) => {
                          const F = FILES[f];
                          return (
                            <div key={f} className="bg-white border border-slate-200 rounded-xl overflow-hidden"
                                 style={{ borderTop: `3px solid ${F.tone}` }}>
                              <div className="px-3.5 py-2 border-b border-slate-100 text-[11px] font-bold"
                                   style={{ color: F.tone }}>{F.label}</div>
                              <div className="px-3.5 py-2">
                                {kv.length === 0 ? <div className="py-1.5 text-slate-400">no record found</div>
                                  : kv.map(([k, v]) => (
                                    <div key={k} className="flex justify-between gap-3 py-1.5 border-b border-slate-50">
                                      <span className="text-slate-500">{k}</span>
                                      <span className="font-semibold tabular-nums text-right">{v}</span>
                                    </div>
                                  ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {rows.length > 400 && (
        <p className="p-4 text-xs text-slate-400">Showing the first 400 of {int(rows.length)}.</p>
      )}
    </div>
  );
}

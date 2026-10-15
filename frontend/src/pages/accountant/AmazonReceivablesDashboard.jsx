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
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { toast } from 'sonner';
import api from '../../lib/api';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { sidebarFor } from '../../lib/adminNav';
import FeeInvoicesView from './FeeInvoicesView';
import BankView from './BankView';

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
/* "18 Jun 2026" — the day matters: an accountant matching a credit note to a
   filed return needs the date on the document, and "Jun 2026" does not settle
   whether a 30-June sale belongs to June or July. */
/* Round ONCE, at the point a figure is shown or compared — never per row. */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ── how much of a report is on screen at once ────────────────────────────
   The report is built over every month there is. The SCREEN shows a window of
   it, because the per-order rows behind the panels are what weigh: eighteen
   months of the four legs is about 33 MB, fifty-four would be about 165 MB.
   MAX_VIEW is the ceiling the backend also enforces; DEFAULT_VIEW is where a
   long report opens, at its most recent end, where the questions usually are. */
const MAX_VIEW = 18;
const DEFAULT_VIEW = 12;

/* The order chain for the months on screen. `three.totals` is a whole-RUN sum
   computed once at build time, so on a five-year report it never moved when
   the period picker did - the ladder read 2,40,078 orders placed while the
   cards beside it read the eighteen months asked for. Folded here in the same
   order and with the same rounding the backend uses, so selecting the whole
   period reproduces `totals` exactly. */
const CHAIN_COUNTS = ['placed', 'cancelled', 'net', 'mcf', 'notInvoicedFree', 'notInvoiced',
                      'shipped', 'settled', 'settledLater', 'unsettled'];
const CHAIN_VALUES = ['valuePlaced', 'valueCancelled', 'valueMcf', 'valueNotInvoicedFree',
                      'valueNotInvoiced', 'valueInvoiced', 'valueSettled', 'valueSettledLater',
                      'valueNet', 'valueUnsettled', 'taxPlaced', 'taxInvoiced'];
const chainTotals = (three, shown) => {
  const pm = (three?.perMonth || []).filter((m) => shown.includes(m.month));
  if (!pm.length) return three?.totals || {};
  const t = Object.fromEntries([...CHAIN_COUNTS, ...CHAIN_VALUES].map((k) => [k, 0]));
  for (const m of pm) {
    for (const k of CHAIN_COUNTS) t[k] += (m[k] || 0);
    /* Number(x.toFixed(2)) per step, exactly as amazonThreeWay.js folds it */
    for (const k of CHAIN_VALUES) t[k] = Number((t[k] + (m[k] || 0)).toFixed(2));
  }
  return t;
};
const fmtDay = (d) => {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return '—';
  const [y, m, dd] = d.slice(0, 10).split('-');
  return `${+dd} ${MON[+m - 1]} ${y}`;
};
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
  returned: { file: 'mtr', column: 'Invoice Amount + Credit Note Date', filter: 'Transaction Type = Refund',
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
  chainSettled: { file: 'settlement', column: 'order id',
    filter: 'an INVOICED order that appears in a settlement',
    note: 'Asked of the invoiced orders only. Asked of every live order it counted the MCF orders as unpaid and returned more paid orders than were ever billed.' },
  chainSettledLater: { file: 'settlement', column: 'Transaction Release Date',
    filter: 'invoiced inside the period, released after it closed',
    note: 'Amazon holds the money a median of 11.4 days, so a slice of every month is paid after it ends. Not outstanding — just later.' },
  chainUnsettled: { file: 'derived', column: 'Invoiced orders with no payment at all',
    note: 'An MCF order is neither invoiced nor payable, so it is not outstanding and is not counted here.' },
  mcf: { file: 'order', column: 'sales-channel', filter: 'sales-channel is not Amazon',
    note: 'Sold on another website and only shipped by Amazon, so Amazon raises no tax invoice and pays nothing. Every one carries an item-price of zero.' },
  deferred: { file: 'settlement', column: 'Transaction Status = Deferred',
    filter: 'the release-date column is present and empty, so no money has moved',
    note: 'Amazon has recorded the sale and is holding the money. It has not paid and it has not refused — so it is still owed to us.' },
  money: { file: 'settlement', column: 'total, less selling/FBA/other fees, TDS and TCS',
    filter: 'Order and Refund rows, matched to the MTR by order id',
    note: 'Gross is derived from the stated total plus the deductions, not rebuilt from the GST and '
        + 'shipping columns — a month restored from a retained settlement ledger does not carry them.' },
  notInvoicedFree: { file: 'order', column: 'item-price', filter: 'item-price is nil and the order is in no MTR',
    note: 'A replacement sent at no charge. There is nothing to invoice and nothing to claim from Amazon.' },
  notInvoiced: { file: 'derived', column: 'order report minus MTR',
    filter: 'an Amazon order, not cancelled, with no Shipment row in any MTR',
    note: 'Goods left the warehouse but no tax invoice reached the MTR.' },
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
/* Two reasons the cash never ties to the billing order for order, both shown
   rather than left to be discovered as a negative pending figure. */
/* Outside the receivable arithmetic on purpose. This money is in the bank but
   it settles no invoice, so it is a memo beside the statement rather than a
   line inside it — exactly like the GST memo. */
const EXTRA = [
  { key: 'creditsNotAgainstInvoice', label: 'Reimbursements and other credits', sign: '', memo: true,
    prov: 'received',
    note: 'Money Amazon paid that is NOT payment for an invoice — compensation for goods lost or '
        + 'damaged on the way back, settlement adjustments, fee refunds. Real money, already in the '
        + 'bank, but it settles no sale, so it is not netted against what is still owed.' },
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

/* What a month does NOT have, said out loud.
   Koparo's Amazon history does not start level: Amazon's GST Monthly Reports go
   back only to 2022, so for anything earlier the MTR cannot be obtained at all -
   it is not a file somebody forgot. Without this banner those months read as
   zero invoiced and look like a collapse in sales rather than a missing report. */
/* ── what this period cannot answer, and why ──────────────────────────────
   Three different absences, and a reader must not have to guess which one
   they are looking at. A missing MTR, an order report Amazon returns short,
   and a period before fee invoices existed all leave a panel blank, but only
   one of them is anything to chase. The title and body come from the backend
   so the wording lives next to the test that produced it; this only decides
   which months are on screen and what the closing line should say. */
const NOTICE_FOOTER = {
  'mtr-missing': (
    <>Order reports and the settlement record <strong>do</strong> cover these months, so sales,
    payouts and the bank position are unaffected. Only <em>Order vs MTR</em> will read blank.</>
  ),
  'orders-short': (
    <>The MTR and the settlement <strong>do</strong> cover these months in full, so net sales, what
    Amazon charged and what it paid are all unaffected. Only <em>orders placed</em> on the Order
    Cycle, and the order-level half of <em>Order vs MTR</em>, understate the month.</>
  ),
  'no-fee-invoices': (
    <>Amazon still charged its fees in these months and the settlement records every rupee — what
    is missing is only the <strong>tax invoice</strong> for them. <em>Fee invoices</em> will show a
    nil invoice side against a real settlement side; that is an absence of documents, not a gap to
    chase.</>
  ),
};

function CoverageNotice({ coverage, shown }) {
  /* A run can have more than one of these at once - the MTR is missing for
     2021-22, the order report is short for May 2023, and there are no fee
     invoices before Apr 2023, all in the same report. Showing only the first
     meant a reader looking at May 2023 was told nothing at all. Each notice
     is drawn only for the months actually on screen. */
  const list = (coverage && (coverage.notices || (coverage.notice ? [coverage.notice] : []))) || [];
  if (!shown || !shown.length || !list.length) return null;
  const live = list.filter((x) => (x.months || []).some((m) => shown.includes(m)));
  if (!live.length) return null;
  return <>{live.map((n) => <OneNotice key={n.kind} n={n} shown={shown} />)}</>;
}

function OneNotice({ n, shown }) {
  const hit = (n.months || []).filter((m) => shown.includes(m));
  if (!hit.length) return null;
  const label = (m) => {
    const [y, mm] = String(m).split('-');
    return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+mm - 1]} ${y}`;
  };
  /* The backend titles the notice for the WHOLE run; on screen only some of
     those months may be selected, so the count is recomputed from what is
     actually shown rather than claiming more than the reader can see. */
  const title = hit.length === 1
    ? String(n.title || '').replace(/\d+ of the months selected|\d+ months/, label(hit[0]))
    : String(n.title || '').replace(/for .*/, `for ${hit.length} of the months selected`);
  return (
    <div className="mb-4 rounded-xl overflow-hidden"
         style={{ background: '#FFFBF3', border: '1px solid #FBE2BE' }}>
      <div className="flex items-start gap-3 px-4 py-3">
        <Info className="h-5 w-5 mt-0.5 shrink-0" style={{ color: T.amberText }} />
        <div className="min-w-0">
          <div className="text-[13px] font-bold" style={{ color: T.amberText }}>{title}</div>
          <p className="text-[12.5px] mt-1 leading-relaxed" style={{ color: '#5B4A2E' }}>{n.detail}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {hit.slice(0, 14).map((m) => (
              <span key={m} className="px-2 py-0.5 rounded text-[11px] font-semibold tabular-nums"
                    style={{ background: '#FDF0DB', color: '#8A6A3A' }}>{label(m)}</span>
            ))}
            {hit.length > 14 && (
              <span className="px-2 py-0.5 text-[11px] font-semibold" style={{ color: '#8A6A3A' }}>
                +{hit.length - 14} more
              </span>
            )}
          </div>
          <div className="mt-2 text-[11.5px]" style={{ color: '#8A6A3A' }}>
            {NOTICE_FOOTER[n.kind] || NOTICE_FOOTER['mtr-missing']}
          </div>
        </div>
      </div>
    </div>
  );
}

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
  /* null = the default window; otherwise {from,to} month keys, inclusive.
     from === to is a single month and opens that month's statement. */
  const [sel, setSel] = useState(null);
  const [txOpen, setTxOpen] = useState(false);
  /* the per-order rows for the months on screen, fetched separately */
  const [rows, setRows] = useState(null);
  const [rowsBusy, setRowsBusy] = useState(false);
  const [rowsErr, setRowsErr] = useState(null);

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

  /* Report History used to call this with no argument, so every row in it
     opened whichever report was built LAST - eight rows, one destination. The
     row's own months are passed now and that report is fetched. */
  const openReport = useCallback(async (runMonths) => {
    setView('report'); setSel(null);
    if (!base || !runMonths || !runMonths.length) return;
    /* Do NOT clear the rows before this test. Clearing them and then returning
       because the run is already open left `rows` null with nothing to refill
       it - the fetch keys on [base, months, run] and none of those changed, so
       the effect never fired again and every per-order panel read nil. */
    if ((data?.months || []).join(',') === runMonths.join(',')) return;  // already open
    setRows(null);
    setLoading(true);
    try {
      const r = await api.get(`${base}/run`, { params: { months: runMonths.join(',') } });
      if (r.data && !r.data.empty) setData(r.data);
    } catch {
      toast.error('Could not open that report');
    } finally { setLoading(false); }
  }, [base, data]);

  const run = async ({ months, basis }) => {
    if (!base) return;
    setRunning(true);
    try {
      const r = await api.post(`${base}/run`, { months, basis });
      setData(r.data);
      setWizard(false);
      setView('report');
      setSel(null);
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

  /* ── built over everything, read a window at a time ─────────────────────
     The report itself can cover any number of months - five years is normal
     now. What cannot scale is the per-order detail: eighteen months of the
     four legs is about 33 MB, and fifty-four would be ten times that, which
     is both more than a browser should hold and more than the 256 MB a
     Postgres jsonb value can store.

     So the period picker is the chunking. A longer report opens on its most
     recent twelve months and the window can be moved anywhere inside it, up
     to MAX_VIEW months at a time. Every panel keeps summing the rows itself,
     with the arithmetic it always used - only the number of rows in front of
     it changed. */
  const defaultSel = useMemo(() => (months.length <= DEFAULT_VIEW ? null
    : { from: months[months.length - DEFAULT_VIEW], to: months[months.length - 1] }), [months]);
  const effSel = sel || defaultSel;
  const shown = useMemo(() => (effSel && effSel.from && effSel.to
    ? months.filter((m) => m >= effSel.from && m <= effSel.to)
    : months), [effSel, months]);
  const ST = data?.ledger?.STATUS || {};
  const openDrill = (d) => setDrill({ months: shown, ...d });

  /* The rows for those months. Keyed on the months themselves rather than on
     `shown`, which is a fresh array every render and would re-fetch forever. */
  const shownKey = shown.join(',');
  const runKey = (data?.months || months).join(',');
  useEffect(() => {
    if (!base || !shownKey || !runKey) { setRows(null); return undefined; }
    let dead = false;
    setRowsBusy(true); setRowsErr(null);
    api.get(`${base}/run/window-rows`, { params: { months: shownKey, window: runKey } })
      .then((r) => { if (!dead) setRows(r.data?.legs || null); })
      .catch((e) => { if (!dead) { setRows(null); setRowsErr(e.response?.data?.error || 'Could not load the orders for this period'); } })
      .finally(() => { if (!dead) setRowsBusy(false); });
    return () => { dead = true; };
  }, [base, shownKey, runKey]);

  /* The payload carries summaries; the rows are slotted in beside them so
     every panel sees the shape it has always seen. A report generated before
     this split still has its own rows inside it, and the endpoint hands those
     back, so nothing old breaks. */
  const vdata = useMemo(() => {
    if (!data) return null;
    if (!rows) return data;
    return {
      ...data,
      ledger: { ...data.ledger, rows: rows.ledger || [] },
      invoicing: data.invoicing ? { ...data.invoicing, rows: rows.invoicing || [] } : data.invoicing,
      moneyMatch: data.moneyMatch ? { ...data.moneyMatch, rows: rows.money || [] } : data.moneyMatch,
      three: { ...data.three, orderRows: rows.chain || [] },
    };
  }, [data, rows]);

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
      {/* the cash cycle is seven cards in a row and the month table is 17
          columns wide; capping at 1560 left a dead gutter on the right and
          wrapped both. Let it use the screen, with a sane ceiling. */}
      <div className="p-6 pb-16 max-w-[2100px]">
        <button onClick={() => (view === 'report' ? setView('list') : navigate(`/brands/${brandId}/agents`))}
                className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-blue-600 group transition-colors mb-3">
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
          {view === 'report' ? 'Back to reports' : 'Back to Agents'}
        </button>

        {view === 'list' ? (
          <ReportList status={status} data={data} months={months}
                      onOpen={openReport}
                      onGenerate={() => setWizard(true)} onRefresh={load} />
        ) : (
          <ReportView data={vdata} status={status} months={months} shown={shown} sel={effSel}
                      setSel={setSel} onDrill={openDrill} base={base}
                      rowsBusy={rowsBusy} rowsErr={rowsErr}
                      onTx={() => setTxOpen(true)} onRefresh={load} ST={ST} />
        )}

        {wizard && (
          <GenerateWizard status={status} running={running}
                          onClose={() => setWizard(false)} onRun={run} />
        )}
        {txOpen && vdata && (
          <TransactionData data={vdata} shown={shown} ST={ST} onClose={() => setTxOpen(false)} />
        )}
        {drill && (
          <DrillPanel drill={drill} data={vdata} ST={ST} base={base} onClose={() => setDrill(null)} />
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
                      <button onClick={() => onOpen(r.months || [])}
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
function ReportView({ data, status, months, shown, sel, setSel, onDrill, base, onTx, onRefresh, ST,
                     rowsBusy, rowsErr }) {
  /* two layers over the same three files: what Amazon owes us, and whether
     every order we shipped was actually invoiced. Different questions, same
     upload — which is why this is a tab and not a second agent. */
  const [layer, setLayer] = useState('receivables');
  const all = data?.ledger?.perMonth || [];
  const led = all.filter((m) => shown.includes(m.month));
  /* one month selected -> its statement; any wider range -> the overview */
  const one = led.length === 1 ? led[0] : null;
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

      {/* ── period: a From/To range, not a row of pills ──────────────────────
          Seventeen months of pills is a wall, and it hides the question the
          accountant actually asks — "show me this quarter" or "show me the
          financial year". Same picker as the Shopify Order Cycle: two month+
          year selects, clamped to the months the report actually covers, and
          nothing re-reads until Search is pressed. From === To is a single
          month and opens that month's statement. */}
      <div className="flex items-center gap-1.5 mb-4 border-b border-slate-200">
        {[['receivables', 'Receivables', 'what Amazon owes us'],
          ['invoicing', 'Order vs MTR', 'did every order reach the MTR'],
          ['money', 'MTR vs Settlement', 'was every invoice paid'],
          ['bank', 'Bank', 'when the money actually arrived'],
          ['fees', 'Fee invoices', 'is every rupee Amazon took invoiced']].map(([k, label, sub]) => (
          /* The unselected tabs were #94A3B8 on white with the sub-label at 70%
             opacity on top of that — legible as a shape, not as words. Every
             tab name is BOLD now and the inactive ones sit at #334155, which
             reads; the selected one is separated by weight, a 2.5px rule and a
             tinted pill rather than by being the only readable thing. */
          <button key={k} onClick={() => setLayer(k)}
                  className="px-4 py-2.5 text-sm font-bold -mb-px transition-colors text-left rounded-t-lg"
                  style={layer === k
                    ? { borderBottom: `2.5px solid ${T.amber}`, color: T.ink, background: '#FFF8EC' }
                    : { borderBottom: '2.5px solid transparent', color: '#334155' }}>
            {label}
            <span className="ml-1.5 text-[11px] font-semibold"
                  style={{ color: layer === k ? T.amberText : '#64748B' }}>{sub}</span>
          </button>
        ))}
      </div>

      <Motion />
      <RangeBar months={months} sel={sel} setSel={setSel} all={all} />

      {/* The per-order rows arrive separately from the summaries, so say so
          rather than letting the walk read nil for a second and look wrong. */}
      {rowsBusy && (
        <div className="flex items-center gap-2 px-4 py-2.5 mb-4 rounded-xl text-[12px] font-semibold"
             style={{ background: '#F1F5F9', color: '#475569', border: '1px solid #E2E8F0' }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading the orders for {rangeLabel(shown)}…
        </div>
      )}
      {rowsErr && !rowsBusy && (
        <div className="px-4 py-3 mb-4 rounded-xl text-[12px]"
             style={{ background: '#FEF2F2', color: '#991B1B', border: '1px solid #FECACA' }}>
          <strong>{rowsErr}</strong>
          <div className="mt-0.5 opacity-80">
            The month totals above are unaffected; only the order-by-order panels need these.
          </div>
        </div>
      )}

      <CoverageNotice coverage={data?.coverage} shown={shown} />

      {layer === 'bank'
        ? <BankView bank={data?.bank} shown={shown} />
        : layer === 'fees'
        ? <FeeInvoicesView fees={data?.fees} shown={shown} />
        : layer === 'money'
        ? <MoneyMatchView mm={data?.moneyMatch} shown={shown} onDrill={onDrill} />
        : layer === 'invoicing'
        ? <InvoicingView inv={data?.invoicing} shown={shown} onDrill={onDrill} />
        : <>
      <BasisCompare cmp={data?.basisCompare} shown={shown} onDrill={onDrill} />

      {one ? <MonthStatement m={one} data={data} onDrill={onDrill} />
           : <PeriodOverview led={led} data={data} shown={shown} onDrill={onDrill} ST={ST} />}

      <IssuesPanel audit={data?.audit} shown={shown} data={data} brand={status?.brand}
                   onDrill={(i) => onDrill({ kind: 'issue', issue: i })} />
      <LedgerTable led={led} onDrill={onDrill} />
      <JourneyAndScenarios data={data} shown={shown} onDrill={onDrill} ST={ST} />
      <SourcesPanel status={status} sources={(data?.sources || []).filter((s) => shown.includes(s.month))}
                    sourceKind={data?.sourceKind || {}} />
        </>}
    </>
  );
}

/* ── order date vs dispatch date, side by side ────────────────────────────
   The basis is a policy the brand sets once, and the screen used to say only
   WHICH one was used, never what it cost. Both are computed on every run, so
   the accountant can see the month that moves most and defend the choice —
   or explain to a client why a month differs from last year's workpaper. */
function BasisCompare({ cmp, shown, onDrill }) {
  const [open, setOpen] = useState(false);
  if (!cmp || !cmp.months || !cmp.months.length) return null;
  const NAME = { order: 'Order date', dispatch: 'Dispatch date', delivery: 'Delivery date' };
  const rows = cmp.months.filter((x) => shown.includes(x.month));
  if (!rows.length) return null;
  const tot = rows.reduce((a, x) => a + x.thisBasis, 0);
  const oth = rows.reduce((a, x) => a + x.otherBasisAmt, 0);
  const diff = +(tot - oth).toFixed(2);
  const big = rows.slice().sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))[0];

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden mb-5">
      <button onClick={() => setOpen((o) => !o)}
              className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-slate-50 transition-colors text-left">
        <div>
          <div className="text-sm font-bold text-slate-800">
            If sales were booked on {NAME[cmp.otherBasis]?.toLowerCase()} instead
          </div>
          <div className="text-[11.5px] text-slate-500 mt-0.5">
            {rangeLabel(shown)} · {Math.abs(diff) < 1
              ? 'the period total would be the same'
              : `the period total would move by ₹${inr(Math.abs(diff), 0)}`}
            {big && Math.abs(big.diff) > 1
              && ` · biggest single month ${fmtMonth(big.month)} ₹${inr(Math.abs(big.diff), 0)}`}
          </div>
        </div>
        <span className="text-[11px] font-bold px-2.5 py-1 rounded-full"
              style={{ background: '#F1F5F9', color: '#475569' }}>
          {open ? 'Hide' : 'Compare'}
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: '#F8FAFC' }}>
              <tr className="text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-5 py-2.5 text-left font-semibold">Month</th>
                <th className="px-4 py-2.5 text-right font-semibold">
                  {NAME[cmp.basis]} <span className="normal-case font-normal">(in use)</span>
                </th>
                <th className="px-4 py-2.5 text-right font-semibold">{NAME[cmp.otherBasis]}</th>
                <th className="px-4 py-2.5 text-right font-semibold">Difference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.month} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                    onClick={() => onDrill({ kind: 'line', line: 'expected', months: [x.month] })}>
                  <td className="px-5 py-2 font-semibold text-slate-700">{fmtMonth(x.month)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold text-slate-800">
                    ₹{inr(x.thisBasis)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">₹{inr(x.otherBasisAmt)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-bold"
                      style={{ color: Math.abs(x.diff) < 1 ? '#94A3B8' : x.diff > 0 ? T.green : T.red }}>
                    {Math.abs(x.diff) < 1 ? '—' : `${x.diff > 0 ? '+' : '−'}₹${inr(Math.abs(x.diff))}`}
                  </td>
                </tr>
              ))}
              <tr style={{ background: T.ink, color: '#fff' }}>
                <td className="px-5 py-3 font-bold">{rangeLabel(shown)}</td>
                <td className="px-4 py-3 text-right tabular-nums font-bold">₹{inr(tot)}</td>
                <td className="px-4 py-3 text-right tabular-nums font-bold">₹{inr(oth)}</td>
                <td className="px-4 py-3 text-right tabular-nums font-bold">
                  {Math.abs(diff) < 1 ? '—' : `${diff > 0 ? '+' : '−'}₹${inr(Math.abs(diff))}`}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="px-5 py-3 text-[11.5px] text-slate-500 leading-relaxed">
            The basis moves orders <strong>between</strong> months — it does not create or destroy sales.
            That is why single months swing while the period total barely moves. It matters for any one
            month&rsquo;s GST, and very little across a full year. Click a month to see the orders behind it.
          </p>
        </div>
      )}
    </div>
  );
}

/* ── one aggregation for the MTR-vs-Settlement tab ────────────────────────
   Derived from the SELECTED months, never from the backend's whole-run answer,
   for exactly the reason the Order-vs-Invoice bridge had to be rebuilt: a
   pre-computed total does not move when the range does, and a page whose
   breakdown reshuffles under a total that never changes is worse than no page.

   "Paid" has to be re-asked at the new period end too, which is why each row
   carries `grossBy` — what Amazon credited in each month — rather than one
   settled figure. */
function mmAgg(mm, shown) {
  const sel = new Set(shown);
  const periodEnd = shown.length ? shown[shown.length - 1] : '';
  const upTo = (by) => r2(Object.entries(by || {})
    .reduce((a, [cm, v]) => a + (cm && (!periodEnd || cm <= periodEnd) ? v : 0), 0));
  const inPeriod = (by) => Object.keys(by || {}).some((cm) => cm && sel.has(cm));
  const paidBy = (by) => Object.keys(by || {}).filter(Boolean)
    .some((cm) => !periodEnd || cm <= periodEnd);

  const rows = [];
  for (const r of mm?.rows || []) {
    const hasSettlement = Object.keys(r.grossBy || {}).length > 0;
    let bucket;
    if (sel.has(r.mtrMonth)) {
      bucket = !hasSettlement ? 'neverSettled' : paidBy(r.grossBy) ? 'settledInPeriod' : 'settledLater';
    } else if (inPeriod(r.grossBy)) {
      bucket = 'settlementOnly';
    } else continue;
    const gross = bucket === 'settlementOnly' ? r2(Object.entries(r.grossBy || {})
      .reduce((a, [cm, v]) => a + (sel.has(cm) ? v : 0), 0)) : upTo(r.grossBy);
    /* BOTH sides as at the same period end. Reading the invoice side at its
       all-time net while the settlement side stopped at the period end made a
       December sale returned in January look OVER-paid by the whole value of
       the return — 6,821 of it across Apr-Dec 2025. */
    const mtrValue = bucket === 'settlementOnly' ? (r.mtrValue || 0) : upTo(r.mtrBy);
    const shortfall = bucket === 'settledInPeriod' ? r2(mtrValue - gross) : 0;
    const movedAfter = r2((r.settledGrossAll || 0) - upTo(r.grossBy));
    rows.push({ ...r, bucket, mtrValue, settledGross: gross, shortfall,
      shortReason: bucket !== 'settledInPeriod' || Math.abs(shortfall) <= 1 ? ''
        : (movedAfter < 0 && Math.abs(shortfall + movedAfter) <= 1) ? 'returnedAfter'
        : r.deferred ? 'deferred' : shortfall > 0 ? 'shortPaid' : 'overPaid' });
  }

  const sum = (rs, k) => r2(rs.reduce((a, x) => a + (x[k] || 0), 0));
  const buckets = (mm?.buckets || []).map((b) => {
    const mine = rows.filter((x) => x.bucket === b.key);
    return { ...b, count: mine.length,
      mtrValue: sum(mine, 'mtrValue'), settledGross: sum(mine, 'settledGross'),
      settledNet: sum(mine, 'settledNet'),
      fees: sum(mine, 'fees'), tds: sum(mine, 'tds'), tcs: sum(mine, 'tcs') };
  });
  const byKey = Object.fromEntries(buckets.map((b) => [b.key, b]));
  const invoiced = rows.filter((x) => x.bucket !== 'settlementOnly');
  const covered = rows.filter((x) => x.bucket === 'settledInPeriod' || x.bucket === 'settledLater');
  const paidRows = rows.filter((x) => x.bucket === 'settledInPeriod');

  const REASON = {
    returnedAfter: ['Returned by the customer after the period closed',
      'The settlement has already taken the money back. The credit note that reduces the MTR is dated '
      + 'in a later month, so until that month is loaded the sale still stands at full value here.'],
    deferred: ['Amazon has not released the money yet',
      'The transaction is in the report but marked deferred — Amazon is holding it, usually until '
      + 'delivery is confirmed.'],
    shortPaid: ['Paid less than the invoice, with no reason in the files',
      'Nothing in the three files explains the difference. This is the only group worth taking to Amazon.'],
    overPaid: ['Paid more than the invoice',
      'More was credited than the invoice asked for, usually a reversal landing against the wrong order.'],
  };

  return {
    rows, buckets, byKey,
    totals: {
      invoicedOrders: invoiced.length, invoicedValue: sum(invoiced, 'mtrValue'),
      laterOrders: byKey.settledLater?.count || 0, laterValue: byKey.settledLater?.mtrValue || 0,
      neverOrders: byKey.neverSettled?.count || 0, neverValue: byKey.neverSettled?.mtrValue || 0,
      fees: sum(covered, 'fees'), tds: sum(covered, 'tds'), tcs: sum(covered, 'tcs'),
      shortfall: sum(paidRows, 'shortfall'),
    },
    coverage: {
      orders: covered.length, ofOrders: invoiced.length,
      pctByOrders: invoiced.length ? r2((100 * covered.length) / invoiced.length) : 0,
      value: sum(covered, 'mtrValue'), ofValue: sum(invoiced, 'mtrValue'),
      pctByValue: sum(invoiced, 'mtrValue')
        ? r2((100 * sum(covered, 'mtrValue')) / sum(invoiced, 'mtrValue')) : 0,
    },
    shortfallBy: Object.keys(REASON).map((k) => {
      const mine = paidRows.filter((x) => x.shortReason === k);
      return { key: k, label: REASON[k][0], meaning: REASON[k][1],
               count: mine.length, amount: sum(mine, 'shortfall') };
    }).filter((x) => x.count),
    /* ── the two files, month by month ──────────────────────────────────
       `mtrBy` is keyed by the month the invoice (or credit note) is dated;
       `grossBy` by the month the money moved. Charting them against each other
       is the whole point — the gap between the bars IS the settlement lag, and
       it is invisible in any total. */
    series: shown.map((m) => {
      let a = 0, b = 0, orders = 0;
      for (const r of rows) {
        a += (r.mtrBy || {})[m] || 0;
        b += (r.grossBy || {})[m] || 0;
        if (r.mtrMonth === m) orders += 1;
      }
      return { month: m, label: fmtMonth(m), a: r2(a), b: r2(b), gap: r2(a - b), orders };
    }),
    money: {
      invoiced: sum(covered, 'mtrValue'),
      fees: sum(covered, 'fees'), tds: sum(covered, 'tds'), tcs: sum(covered, 'tcs'),
      net: r2(sum(covered, 'settledGross') - sum(covered, 'fees')
             - sum(covered, 'tds') - sum(covered, 'tcs')),
      credited: sum(covered, 'settledGross'),
    },
    laterByMonth: Object.values(rows.filter((x) => x.bucket === 'settledLater')
      .reduce((a, x) => {
        const k = Object.keys(x.grossBy || {}).filter(Boolean).sort()[0] || 'unknown';
        a[k] = a[k] || { month: k, orders: 0, amount: 0 };
        a[k].orders += 1; a[k].amount = r2(a[k].amount + (x.mtrValue || 0));
        return a;
      }, {})).sort((a, b) => String(a.month).localeCompare(String(b.month))),
  };
}

/* The three files, named the way the files are named — an accountant opening
   Seller Central sees "MTR", "Settlement report" and "All orders", not
   "what Amazon credited". Every figure on this tab says which file and which
   COLUMN of it, because that is the question being asked. */
const FILEMARK = {
  order: { name: 'Order report', tone: T.violet, bg: '#F5F3FF', bd: '#DDD6FE' },
  mtr: { name: 'MTR', tone: T.blue, bg: '#EFF6FF', bd: '#BFDBFE' },
  settlement: { name: 'Settlement', tone: T.green, bg: '#F3FBF6', bd: '#BBF7D0' },
};

function FileTag({ kind, col }) {
  const f = FILEMARK[kind]; const Ic = FILES[kind].icon;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded"
          style={{ background: f.bg, color: f.tone, border: `1px solid ${f.bd}` }}>
      <Ic className="h-2.5 w-2.5" />{f.name}{col ? <span className="font-medium opacity-80">· {col}</span> : null}
    </span>
  );
}

/* ── page motion ─────────────────────────────────────────────────────────
   One stylesheet for the whole report rather than one per tab: it lived
   inside the MTR-vs-Settlement view, so the Order-vs-MTR tab got the markup
   for the pulse and none of the keyframes to drive it. */
function Motion() {
  return (
    <style>{`
        @keyframes arGrow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
        @keyframes arRise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        /* the pulse that walks the equation: each card lights for about half a
           second of a 5.4s loop, and the dot crosses the connector in between */
        @keyframes arLit {
          0%    { box-shadow: 0 0 0 0 color-mix(in srgb, var(--lit) 40%, transparent); }
          5%    { box-shadow: 0 0 0 5px color-mix(in srgb, var(--lit) 13%, transparent); }
          13%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--lit) 0%, transparent); }
          100%  { box-shadow: 0 0 0 0 color-mix(in srgb, var(--lit) 0%, transparent); }
        }
        /* the agreement band: a slow ring, and a light sweeping its top edge */
        @keyframes arTie {
          0%   { box-shadow: 0 0 0 0 rgba(6,118,71,.30); }
          55%  { box-shadow: 0 0 0 11px rgba(6,118,71,0); }
          100% { box-shadow: 0 0 0 0 rgba(6,118,71,0); }
        }
        @keyframes arGlide {
          0%   { left: 2%;  opacity: 0; }
          12%  { opacity: 1; }
          78%  { opacity: 1; }
          100% { left: 94%; opacity: 0; }
        }
        .ar-tie { animation: arTie 3.4s ease-out infinite; }
        .ar-glide {
          position: absolute; top: 0; left: 2%;
          width: 56px; height: 2px; border-radius: 9999px; opacity: 0;
          animation: arGlide 3.4s linear infinite;
        }
        @keyframes arDot {
          0%   { left: 0;    opacity: 0; transform: translate(-50%, -50%) scale(.6); }
          3%   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          18%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          22%  { left: 100%; opacity: 0; transform: translate(-50%, -50%) scale(.6); }
          100% { left: 100%; opacity: 0; }
        }
        .ar-grow { transform-origin: left; animation: arGrow .7s cubic-bezier(.22,.8,.3,1) both; }
        .ar-rise { animation: arRise .45s cubic-bezier(.22,.8,.3,1) both; }
        .ar-lit  { animation: arLit 5.4s ease-out infinite; }
        .ar-dot  {
          position: absolute; top: 50%; left: 0;
          width: 7px; height: 7px; border-radius: 9999px; opacity: 0;
          animation: arDot 5.4s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .ar-grow, .ar-rise, .ar-lit, .ar-dot, .ar-tie, .ar-glide { animation: none; }
          .ar-dot, .ar-glide { display: none; }
        }
`}</style>
  );
}

/* ── one file against another, and every rupee between them ───────────────
   Three KPI cards reading as the equation they are — ORDER REPORT − MTR =
   DIFFERENCE — each with its amount and, under it in bold, how many orders
   that amount is. Underneath, every line that makes the difference up, with
   the order count in a column of its own beside the amount rather than as
   grey text trailing the label.

   A pulse travels left to right along the connectors on a loop and each card
   lights as it arrives, so the eye is walked through the subtraction instead
   of being handed three numbers at once. It stays where it is — nothing
   actually moves — and the whole thing stops under prefers-reduced-motion. */
function DiffWalk({ from, to, lines, diff, pctOf, onLine, note }) {
  const [glow, setGlow] = useState(false);
  const agree = Math.abs(diff) < 1;
  const tone = agree ? T.green : T.amberText;
  /* how many ORDERS the difference is, not just how many rupees */
  const diffOrders = lines.reduce((a, d) => a + (d.n || 0), 0);

  const Stop = ({ s, i, big, label, sub, color, bg, bd }) => (
    <div className="flex-1 min-w-[208px] rounded-xl px-4 py-3.5 ar-lit"
         style={{ background: bg, border: `1px solid ${bd}`, '--lit': color, animationDelay: `${i * 1.8}s` }}>
      {s ? <FileTag kind={s.kind} col={s.col} />
         : <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider"
                 style={{ background: '#FFFBEB', color: tone, border: '1px solid #FDE68A' }}>Difference</span>}
      <div className="text-[27px] font-bold tabular-nums leading-none mt-2" style={{ color }}>
        ₹{inr(big || 0)}
      </div>
      <div className="text-[12.5px] text-slate-500 mt-1.5">
        <span className="font-bold text-slate-800 tabular-nums">{int(label || 0)}</span> {sub}
      </div>
    </div>
  );

  const Link = ({ op, i }) => (
    <div className="flex flex-col justify-center items-center px-2 w-[58px] shrink-0">
      <div className="text-[19px] font-bold text-slate-300 leading-none mb-1.5">{op}</div>
      <div className="relative w-full h-px" style={{ background: '#E2E8F0' }}>
        <span className="ar-dot" style={{ animationDelay: `${0.6 + i * 1.8}s`, background: tone }} />
      </div>
    </div>
  );

  return (
    <div className="rounded-xl mb-5 overflow-hidden"
         style={{ background: '#fff', border: `1px solid ${agree ? '#BBF7D0' : '#FDE68A'}` }}>
      <div className="px-4 py-4 flex items-stretch flex-wrap lg:flex-nowrap gap-y-3"
           style={{ background: agree ? '#F7FCF9' : '#FFFDF5' }}>
        <Stop s={from} i={0} big={from.v} label={from.n} sub={from.unit}
              color={FILEMARK[from.kind].tone} bg={FILEMARK[from.kind].bg} bd={FILEMARK[from.kind].bd} />
        <Link op="−" i={0} />
        <Stop s={to} i={1} big={to.v} label={to.n} sub={to.unit}
              color={FILEMARK[to.kind].tone} bg={FILEMARK[to.kind].bg} bd={FILEMARK[to.kind].bd} />
        <Link op="=" i={1} />
        <button onClick={() => setGlow((g) => !g)}
                className="flex-1 min-w-[208px] rounded-xl px-4 py-3.5 text-left ar-lit transition-shadow hover:shadow-md"
                style={{ background: agree ? '#F0FDF4' : '#FFFBEB',
                         border: `1.5px solid ${agree ? '#86EFAC' : '#FCD34D'}`,
                         '--lit': tone, animationDelay: '3.6s' }}>
          <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider"
                style={{ background: '#fff', color: tone, border: `1px solid ${agree ? '#86EFAC' : '#FCD34D'}` }}>
            {agree ? 'No difference' : 'Difference'}
          </span>
          <div className="text-[27px] font-bold tabular-nums leading-none mt-2" style={{ color: tone }}>
            ₹{inr(Math.abs(diff))}
          </div>
          <div className="text-[12.5px] text-slate-500 mt-1.5">
            <span className="font-bold text-slate-800 tabular-nums">{int(diffOrders)}</span> orders make it up
          </div>
          <div className="text-[11px] mt-1" style={{ color: glow ? tone : '#94A3B8' }}>
            {glow ? 'these are the lines ↓' : pctOf}
          </div>
        </button>
      </div>

      <div className="px-5 py-1">
        <div className="flex items-baseline gap-4 pt-3 pb-1.5 border-b border-slate-100">
          <span className="flex-1 text-[10.5px] font-bold uppercase tracking-wider text-slate-400">
            And every rupee of it
          </span>
          <span className="w-[86px] text-right text-[10.5px] font-bold uppercase tracking-wider text-slate-400">
            Orders
          </span>
          <span className="w-[132px] text-right text-[10.5px] font-bold uppercase tracking-wider text-slate-400">
            Amount
          </span>
        </div>
        {lines.map((d) => {
          const lit = glow && Math.abs(d.v) >= 0.01;
          return (
            <button key={d.k} onClick={() => d.bucket && onLine(d)} disabled={!d.bucket}
                    className={`w-full flex items-baseline gap-4 py-2.5 border-b border-slate-100 last:border-0 text-left transition-colors ${d.bucket ? 'hover:bg-slate-50' : ''}`}
                    style={lit ? { background: '#FFFBEB' } : {}}>
              <span className="flex-1 min-w-0">
                <span className="text-[13px] font-semibold text-slate-700">{d.k}</span>
                <span className="block text-[11px] text-slate-400 leading-snug mt-0.5">{d.note}</span>
              </span>
              <span className="w-[86px] text-right text-[13px] tabular-nums font-semibold"
                    style={{ color: d.n ? '#334155' : '#CBD5E1' }}>
                {d.n != null ? int(d.n) : '—'}
              </span>
              <span className="w-[132px] text-right text-[13.5px] tabular-nums font-semibold transition-transform"
                    style={{ color: d.v > 0 ? T.amberText : d.v < 0 ? T.green : '#94A3B8',
                             transform: lit ? 'scale(1.06)' : 'none' }}>
                {d.v < 0 ? '−' : ''}₹{inr(Math.abs(d.v))}
              </span>
            </button>
          );
        })}
        <div className="flex items-baseline gap-4 py-3 border-t border-slate-200 mt-1">
          <span className="flex-1 text-[13px] font-bold text-slate-900">Difference</span>
          <span className="w-[86px] text-right text-[13px] font-bold tabular-nums text-slate-900">
            {int(diffOrders)}
          </span>
          <span className="w-[132px] text-right text-[14px] tabular-nums font-bold" style={{ color: tone }}>
            ₹{inr(diff)}
          </span>
        </div>
      </div>
      {note && <p className="px-5 pb-4 text-[11.5px] text-slate-500 leading-relaxed">{note}</p>}
    </div>
  );
}

/* ── two files, period by period ──────────────────────────────────────────
   One component, both comparisons: the order report against the MTR, and the
   MTR against the settlement. A total cannot show a timing difference; two
   bars per period can, and the gap between them IS it. Clicking a bar answers
   the question the chart can only hint at — what the difference actually is
   for that period, and which orders make it up.

   Grouping runs Month / Quarter / Financial year / Custom, where Custom
   narrows this chart alone and leaves the rest of the page on the page range.
   Quarters and years are Apr-Mar, because that is the year an Indian
   accountant closes. */
function CompareChart({ series, A, B, title, sub, note, countLabel, onSee }) {
  const [gran, setGran] = useState('month');
  const [metric, setMetric] = useState('amount');

  const months = (series || []).map((x) => x.month);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => {
    if (!months.length) return;
    setFrom((f) => (f && months.includes(f) ? f : months[0]));
    setTo((t) => (t && months.includes(t) ? t : months[months.length - 1]));
  }, [months.join('|')]);   // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo(() => {
    let src = series || [];
    if (gran === 'custom' && from && to) {
      const lo = from <= to ? from : to; const hi = from <= to ? to : from;
      src = src.filter((r) => r.month >= lo && r.month <= hi);
    }
    const withGap = (x) => ({ ...x, gap: r2((x.a || 0) - (x.b || 0)) });
    if (gran === 'month' || gran === 'custom') {
      return src.map((r) => withGap({ ...r, months: [r.month] }));
    }
    const keyOf = gran === 'quarter'
      ? (m) => {
        const y = +m.slice(0, 4); const mo = +m.slice(5);
        const q = Math.floor(((mo + 8) % 12) / 3) + 1;
        const fy = mo >= 4 ? y : y - 1;
        return `Q${q} FY${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
      }
      : (m) => {
        const y = +m.slice(0, 4); const mo = +m.slice(5);
        const fy = mo >= 4 ? y : y - 1;
        return `FY ${String(fy).slice(2)}-${String(fy + 1).slice(2)}`;
      };
    const by = {};
    for (const r of src) {
      const k = keyOf(r.month);
      by[k] = by[k] || { month: k, label: k, a: 0, b: 0, orders: 0, months: [] };
      by[k].a = r2(by[k].a + (r.a || 0));
      by[k].b = r2(by[k].b + (r.b || 0));
      by[k].orders += r.orders || 0;
      by[k].months.push(r.month);
    }
    return Object.values(by).map(withGap);
  }, [series, gran, from, to]);

  /* Clicking a bar used to open a panel that repeated the hover tooltip — the
     same three numbers, one scroll lower. It opens the DRILL now: both reports
     side by side for that period, with the difference on every single order
     behind them, which is the one thing the chart cannot already say.
     Recharts hands the BAR's props with the row under `payload`; reading
     `d.month` straight off it silently did nothing at all. */
  const pickBar = (d) => {
    const row = d?.payload ?? d;
    if (row && row.month && onSee) onSee(row);
  };

  /* Recharts' ResponsiveContainer measures on its first commit, before the
     tab's layout has resolved, and warns the chart is -1 by -1 every time.
     Measuring the wrapper here is deterministic. */
  const box = React.useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current; if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => {
      const next = Math.floor(e.contentRect.width);
      if (next > 0) setW((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const Toggle = ({ v, set, opts }) => (
    <div className="inline-flex rounded-lg p-0.5" style={{ background: '#F1F5F9' }}>
      {opts.map(([k, label]) => (
        <button key={k} onClick={() => set(k)}
                className="px-2.5 py-1 rounded-md text-[11px] font-bold transition-all"
                style={v === k ? { background: '#fff', color: T.ink, boxShadow: '0 1px 2px rgba(0,0,0,.08)' }
                               : { color: '#94A3B8' }}>
          {label}
        </button>
      ))}
    </div>
  );

  const tip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="rounded-lg px-3 py-2 text-[11.5px] shadow-lg"
           style={{ background: '#fff', border: '1px solid #E2E8F0' }}>
        <div className="font-bold text-slate-800 mb-1">{label}</div>
        <div className="flex justify-between gap-5"><span style={{ color: A.tone }}>{A.label}</span>
          <span className="tabular-nums font-semibold">₹{inr(d.a)}</span></div>
        <div className="flex justify-between gap-5"><span style={{ color: B.tone }}>{B.label}</span>
          <span className="tabular-nums font-semibold">₹{inr(d.b)}</span></div>
        <div className="flex justify-between gap-5 mt-1 pt-1 border-t border-slate-100">
          <span className="text-slate-500">Difference</span>
          <span className="tabular-nums font-bold"
                style={{ color: Math.abs(d.gap) < 1 ? T.green : T.amberText }}>
            ₹{inr(Math.abs(d.gap))}
          </span></div>
        <div className="text-[10.5px] text-slate-400 mt-1">{int(d.orders)} {countLabel}</div>
      </div>
    );
  };

  return (
    <Card title={title} sub={sub}
          right={
            <div className="flex items-center gap-2">
              <Toggle v={metric} set={setMetric} opts={[['amount', '₹'], ['orders', 'Orders']]} />
              <Toggle v={gran} set={setGran}
                      opts={[['month', 'Month'], ['quarter', 'Quarter'],
                             ['fy', 'Financial year'], ['custom', 'Custom']]} />
            </div>
          }>
      <div className="p-5">
        {gran === 'custom' && (
          <div className="flex items-center gap-2 mb-3 flex-wrap rounded-lg px-3 py-2"
               style={{ background: '#F8FAFC', border: '1px solid #E2E8F0' }}>
            <span className="text-[11.5px] font-bold text-slate-500">Chart only, from</span>
            {[[from, setFrom], [to, setTo]].map(([val, set], i) => (
              <React.Fragment key={i}>
                {i === 1 && <span className="text-[11.5px] font-bold text-slate-500">to</span>}
                <select value={val} onChange={(e) => set(e.target.value)}
                        className="text-[12px] font-semibold px-2 py-1 rounded-md border border-slate-200 bg-white">
                  {months.map((m) => <option key={m} value={m}>{fmtMonth(m)}</option>)}
                </select>
              </React.Fragment>
            ))}
            <span className="text-[11px] text-slate-400">
              narrows this chart without changing the rest of the page
            </span>
          </div>
        )}
        <div className="flex items-center gap-4 mb-3">
          {[A, B].map((x) => (
            <span key={x.label} className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-slate-600">
              <span className="w-3 h-3 rounded-sm" style={{ background: x.tone }} /> {x.legend || x.label}
            </span>
          ))}
        </div>
        <div ref={box} style={{ width: '100%', height: 300, minWidth: 0 }}>
          {w > 0 && (
            <BarChart width={w} height={300} data={data}
                      margin={{ top: 4, right: 8, left: 8, bottom: 4 }} barGap={3}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF1F4" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748B' }}
                     axisLine={{ stroke: '#E2E8F0' }} tickLine={false} interval={0}
                     angle={data.length > 8 ? -35 : 0} textAnchor={data.length > 8 ? 'end' : 'middle'}
                     height={data.length > 8 ? 54 : 24} />
              <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                     tickFormatter={(v) => (metric === 'orders' ? int(v)
                       : v >= 100000 ? `${(v / 100000).toFixed(1)}L` : int(v))} />
              <Tooltip content={tip} cursor={{ fill: 'rgba(148,163,184,.08)' }} />
              {metric === 'orders'
                ? <Bar dataKey="orders" fill={A.tone} radius={[3, 3, 0, 0]} maxBarSize={38}
                       cursor="pointer" onClick={pickBar} />
                : <>
                    <Bar dataKey="a" fill={A.tone} radius={[3, 3, 0, 0]} maxBarSize={22}
                         cursor="pointer" onClick={pickBar} />
                    <Bar dataKey="b" fill={B.tone} radius={[3, 3, 0, 0]} maxBarSize={22}
                         cursor="pointer" onClick={pickBar} />
                  </>}
            </BarChart>
          )}
        </div>

        <p className="text-[11.5px] text-slate-500 mt-2 leading-relaxed">
          Hover a bar for the period&rsquo;s totals; click it for every order behind them, both
          reports side by side with the difference on each. {note}
        </p>
      </div>
    </Card>
  );
}

/* ── from the invoice to the bank ─────────────────────────────────────────
   Named by the settlement's own columns, because "Amazon charges" is not
   something anyone can look up in a file. */
function MoneyFlow({ A }) {
  const m = A.money;
  /* It has to FOOT. It used to open on the MTR's invoiced value and then take
     the settlement's deductions off it, which quietly skipped the invoices the
     settlement has not reached yet — 52,213 of them — so the last line was
     short by exactly that and no line said why. */
  const pending = r2(m.invoiced - m.credited);
  const steps = [
    { k: 'MTR · Invoice Amount', v: m.invoiced, tone: T.blue, sign: '', file: 'mtr',
      note: 'Shipment rows, less credit notes, GST included' },
    ...(Math.abs(pending) > 0.5 ? [{ k: 'not in the Settlement by the period end',
      v: -pending, tone: '#94A3B8', sign: '−', file: 'mtr',
      note: 'Invoices Amazon credited in a later month — named further down the page' }] : []),
    { k: 'Settlement · total before fees', v: m.credited, tone: T.green, sign: '=', file: 'settlement',
      note: 'The same orders as the MTR line above, now in the settlement' },
    { k: 'selling fees + fba fees + other transaction fees', v: -m.fees, tone: T.amberText,
      sign: '−', file: 'settlement', note: 'Commission, closing fee, fulfilment and storage' },
    { k: 'TDS (Section 194-O)', v: -m.tds, tone: T.amberText, sign: '−', file: 'settlement',
      note: 'Withheld against our PAN. Claimed in the income-tax return.' },
    { k: 'TCS-CGST + TCS-SGST + TCS-IGST', v: -m.tcs, tone: T.amberText, sign: '−', file: 'settlement',
      note: 'Withheld under section 52. Claimed in the GST cash ledger.' },
    { k: 'Settlement · total', v: m.net, tone: T.green, sign: '=', file: 'settlement',
      note: 'What actually reached the bank for these orders', strong: true },
  ];
  const max = Math.max(...steps.map((x) => Math.abs(x.v)), 1);
  return (
    <Card title="From the tax invoice to the bank"
          sub="Every deduction named by the column it comes from, so it can be found in the file">
      <div className="px-5 py-4">
        {steps.map((x) => (
          <div key={x.k} className="flex items-center gap-3 py-2.5 border-b border-slate-100 last:border-0">
            <span className="w-4 text-[15px] font-semibold text-slate-300 shrink-0">{x.sign}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 flex-wrap">
                <FileTag kind={x.file} />
                <span className={`text-[13px] ${x.strong ? 'font-bold text-slate-900' : 'text-slate-700'}`}>
                  {x.k}
                </span>
              </span>
              <span className="block text-[11px] text-slate-400 mt-0.5 leading-snug">{x.note}</span>
            </span>
            <span className="w-[38%] shrink-0 hidden md:block">
              <span className="block h-2 rounded-full overflow-hidden" style={{ background: '#F1F5F9' }}>
                <span className="block h-full rounded-full ar-grow"
                      style={{ width: `${Math.max(2, (100 * Math.abs(x.v)) / max)}%`, background: x.tone }} />
              </span>
            </span>
            <span className={`w-[132px] text-right text-[13.5px] tabular-nums shrink-0 ${x.strong ? 'font-bold' : 'font-semibold'}`}
                  style={{ color: x.tone }}>
              ₹{inr(Math.abs(x.v))}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function MoneyMatchView({ mm, shown, onDrill }) {
  if (!mm) {
    return (
      <div className="rounded-xl px-5 py-4" style={{ background: '#F8FAFC', border: '1px solid #E3E6EA' }}>
        <p className="text-sm text-slate-500">
          This comparison needs both the MTR and the settlement report. Generate the report again once
          both are loaded.
        </p>
      </div>
    );
  }
  const A = mmAgg(mm, shown);
  const t = A.totals;
  const c = A.coverage;
  const byKey = A.byKey;
  const paid = byKey.settledInPeriod || { count: 0, mtrValue: 0, settledGross: 0 };
  const go = (bucket, label) => onDrill({ kind: 'money', bucket, label, months: shown });
  /* on the MATCHED orders only — one of the three parts of the difference */
  const matchedDiff = r2((paid.mtrValue || 0) - (paid.settledGross || 0));
  const DIFF = r2(A.money.invoiced - A.money.credited);
  const DIFF_PARTS = [
    { k: 'Credited in a later month', v: A.totals.laterValue, n: A.totals.laterOrders,
      bucket: 'settledLater',
      note: A.laterByMonth.length
        ? `Amazon settled these in ${A.laterByMonth.map((x) => fmtMonth(x.month)).join(', ')}. Not outstanding.`
        : 'Settled after the period closed. Not outstanding.' },
    { k: 'Never credited at all', v: A.totals.neverValue, n: A.totals.neverOrders,
      bucket: A.totals.neverOrders ? 'neverSettled' : null,
      note: A.totals.neverOrders
        ? 'A tax invoice exists and no settlement anywhere mentions the order. Worth taking to Amazon.'
        : 'Every tax invoice in this period has a settlement against it.' },
    /* the orders this line is actually made of, so the Difference card can say
       how MANY orders it is and not only how many rupees */
    { k: 'Credited more than the invoice asked for', v: matchedDiff,
      n: A.rows.filter((r) => r.bucket === 'settledInPeriod' && Math.abs(r.shortfall || 0) > 1).length,
      bucket: 'settledInPeriod',
      note: 'On the orders both files had settled inside the period — usually a reversal landing '
          + 'against the wrong order.' },
  ];
  const totalOrders = (A.buckets || []).reduce((a, b) => a + b.count, 0) || 1;
  const TONE = { settledInPeriod: T.green, settledLater: T.amber, neverSettled: T.red,
                 settlementOnly: '#94A3B8' };

  return (
    <>
      <div className="ar-rise">
        <DiffWalk
          from={{ kind: 'mtr', col: 'Invoice Amount', v: A.money.invoiced,
                  n: A.totals.invoicedOrders, unit: 'tax invoices raised in this period' }}
          to={{ kind: 'settlement', col: 'total before fees', v: A.money.credited,
                n: A.coverage.orders - A.totals.laterOrders, unit: 'credited by the end of it' }}
          lines={DIFF_PARTS}
          diff={DIFF}
          pctOf={DIFF > 0 ? 'the MTR invoiced more than the settlement has credited'
                          : 'the settlement has credited more than the MTR invoiced'}
          onLine={(d) => go(d.bucket, d.k)}
          note={'What Amazon then takes off this before the money reaches the bank is below, named by '
              + 'the column each deduction comes from.'} />
      </div>

      <div className="ar-rise">
        <CompareChart
          series={A.series}
          A={{ label: 'MTR invoiced', legend: 'MTR · Invoice Amount', tone: T.blue,
               short: 'The settlement moved MORE than the MTR invoiced here, which is money arriving '
                    + 'for sales invoiced in an earlier period.' }}
          B={{ label: 'Settlement credited', legend: 'Settlement · total before fees', tone: T.green,
               short: 'The settlement moved less than the MTR invoiced inside the period — the rest '
                    + 'lands in a later settlement, which the buckets below name by month.' }}
          title="MTR against Settlement, period by period"
          sub="Blue is what the MTR invoiced. Green is what the settlement moved. The gap is the lag."
          countLabel="tax invoices"
          onSee={(d) => onDrill({ kind: 'money', bucket: '__all',
                                  label: 'MTR against settlement, invoice by invoice',
                                  months: d.months })}
          note={'The two bars are keyed on different dates on purpose. The MTR bar sits in the month '
              + 'its invoice (or credit note) is dated; the settlement bar sits in the month the money '
              + 'actually moved. Amazon settles on its own cycle, so a short green bar beside a tall '
              + 'blue one at the right-hand edge is the normal lag, not a shortfall.'} />
      </div>
      <div className="ar-rise"><MoneyFlow A={A} /></div>

      <Card title="Every tax invoice, by what the settlement did with it"
            sub="Click any band or row for the orders, with the month each one was paid in">
        <div className="p-5">
          <div className="flex h-9 rounded-lg overflow-hidden" style={{ background: '#F1F5F9' }}>
            {A.buckets.filter((b) => b.count).map((b) => (
              <button key={b.key} onClick={() => go(b.key, b.label)}
                      title={`${b.label} — ${int(b.count)} orders`}
                      className="h-full ar-grow transition-opacity hover:opacity-80"
                      style={{ width: `${(100 * b.count) / totalOrders}%`, background: TONE[b.key] }} />
            ))}
          </div>
          <div className="flex gap-4 flex-wrap mt-2.5">
            {A.buckets.filter((b) => b.count).map((b) => (
              <span key={b.key} className="inline-flex items-center gap-1.5 text-[11.5px] text-slate-600">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: TONE[b.key] }} />
                {b.label} <span className="font-bold tabular-nums">{int(b.count)}</span>
                <span className="text-slate-400">
                  ({((100 * b.count) / totalOrders).toFixed(1)}%)
                </span>
              </span>
            ))}
          </div>
        </div>
        <div>
          {A.buckets.map((b) => (
            <button key={b.key} onClick={() => go(b.key, b.label)}
                    className="w-full px-5 py-3.5 border-t border-slate-100 text-left hover:bg-slate-50 flex items-start justify-between gap-5">
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: TONE[b.key] }} />
                  <span className="text-[13.5px] font-semibold text-slate-800">{b.label}</span>
                  {!b.expected && b.count > 0 && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                          style={{ background: '#FEE4E2', color: T.red }}>needs checking</span>
                  )}
                </span>
                <span className="block text-[11.5px] text-slate-500 leading-snug mt-1">{b.meaning}</span>
              </span>
              <span className="flex items-baseline gap-5 shrink-0">
                <span className="text-right">
                  <span className="block text-[10px] uppercase tracking-wider text-slate-400 font-bold">orders</span>
                  <span className="text-[15px] font-bold tabular-nums">{int(b.count)}</span>
                </span>
                <span className="text-right w-[120px]">
                  <span className="block text-[10px] uppercase tracking-wider text-slate-400 font-bold">MTR</span>
                  <span className="text-[15px] font-bold tabular-nums" style={{ color: T.blue }}>₹{inr(b.mtrValue)}</span>
                </span>
                <span className="text-right w-[120px]">
                  <span className="block text-[10px] uppercase tracking-wider text-slate-400 font-bold">Settlement</span>
                  <span className="text-[15px] font-bold tabular-nums" style={{ color: T.green }}>₹{inr(b.settledGross)}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </Card>

      <div className="rounded-xl px-5 py-4 mb-5"
           style={{ background: c.pctByOrders >= 99.95 ? '#F3FBF6' : '#FFFBEB',
                    border: `1px solid ${c.pctByOrders >= 99.95 ? '#BBF7D0' : '#FDE68A'}` }}>
        <div className="text-[11px] font-bold uppercase tracking-wider mb-1"
             style={{ color: c.pctByOrders >= 99.95 ? T.green : '#92400E' }}>
          Are the charges and the sales the same orders?
        </div>
        <p className="text-[12.5px] leading-relaxed" style={{ color: '#3F3F46' }}>
          Net sales is built on <strong>{int(c.ofOrders || 0)}</strong> tax invoices worth{' '}
          <strong>₹{inr(c.ofValue || 0, 0)}</strong>. The settlement&rsquo;s deductions —{' '}
          ₹{inr(t.fees || 0, 0)} in <em>selling / fba / other transaction fees</em>,{' '}
          ₹{inr(t.tds || 0, 0)} <em>TDS (Section 194-O)</em>, ₹{inr(t.tcs || 0, 0)}{' '}
          <em>TCS-CGST/SGST/IGST</em> — are known for{' '}
          <strong>{int(c.orders || 0)} of them ({c.pctByOrders}%, {c.pctByValue}% by value)</strong>.
          {c.pctByOrders >= 99.95
            ? ' Same population on both sides, so the margin on this period is complete.'
            : ' The rest carry no deduction in these files, so the margin is overstated by whatever'
              + ' Amazon will eventually take off them. Nothing is estimated here — load the'
              + ' settlement month that pays them and the gap closes by itself.'}
        </p>
      </div>

      {A.laterByMonth.length > 0 && (
        <Card title="Invoiced here, credited after the period closed"
              sub="Not outstanding — this is the month the settlement actually moved the money">
          <div className="px-5 py-2">
            {A.laterByMonth.map((x) => (
              <button key={x.month} onClick={() => go('settledLater', `Credited in ${fmtMonth(x.month)}`)}
                      className="w-full flex justify-between items-baseline gap-3 py-2.5 border-b border-slate-100 text-left hover:bg-slate-50">
                <span className="text-[13.5px] text-slate-700">
                  Credited in {fmtMonth(x.month)}
                  <span className="text-[11.5px] text-slate-400 ml-1.5">{int(x.orders)} invoices</span>
                </span>
                <span className="text-[13.5px] font-semibold tabular-nums" style={{ color: T.amberText }}>
                  ₹{inr(x.amount)}
                </span>
              </button>
            ))}
            <p className="text-[11.5px] text-slate-500 py-2.5 leading-relaxed">
              Amazon settles on its own cycle, so invoices raised near a month end are very often
              credited in the next one. The only bucket that means money is genuinely missing is
              &ldquo;invoiced, never credited&rdquo;.
            </p>
          </div>
        </Card>
      )}
    </>
  );
}

/* ── one aggregation, two tabs ────────────────────────────────────────────
   The Receivables tab's sales walk and the Order-vs-Invoice tab's bridge
   describe the same movement, so it is computed once, here, from the SELECTED
   rows. Reading a backend aggregate built over the whole run is exactly what
   let the two disagree: the counts were filtered and the amounts were not, so
   with Apr 2025 - Jan 2026 chosen the page valued 13,277 orders at the
   seventeen-month figure of 87,13,747.73. */
function invAgg(inv, shown) {
  const inSel = (mm) => !mm || shown.includes(mm);
  const sel = (inv?.rows || []).filter((x) => inSel(x.month));
  const S = (rs, k) => r2(rs.reduce((a, x) => a + (x[k] || 0), 0));
  const byKey = {};
  for (const b of inv?.buckets || []) {
    const rs = sel.filter((x) => x.bucket === b.key);
    byKey[b.key] = { n: rs.length, order: S(rs, 'orderValue'), inv: S(rs, 'invoicedValue') };
  }
  const matchedRows = sel.filter((x) => x.bucket === 'matched');
  const mtrOnlyRows = sel.filter((x) => x.bucket === 'mtrOnly');
  const R = {
    allOrderValue: S(sel, 'orderValue'),
    cancelledValue: S(sel, 'cancelledValue'),
    matchedOrderValue: S(matchedRows, 'orderValue'),
    matchedPrincipal: S(matchedRows, 'principalValue'),
    shipping: S(matchedRows, 'shippingValue'),
    promo: S(matchedRows, 'promoValue'),
    giftWrap: S(matchedRows, 'giftWrapValue'),
    mtrOnly: S(mtrOnlyRows, 'invoicedValue'),
    invoicedValue: S(sel, 'invoicedValue'),
    refundedValue: S(sel, 'refundedValue'),
    refundOrders: sel.filter((x) => (x.refundedValue || 0) > 0).length,
  };
  R.netBilled = r2(R.invoicedValue - R.refundedValue);
  R.orderLevel = r2(R.allOrderValue - R.cancelledValue);
  R.other = r2(R.invoicedValue - (R.matchedPrincipal + R.shipping + R.promo
                                  + R.giftWrap + R.mtrOnly));
  const totOrders = Object.values(byKey).reduce((a, x) => a + x.n, 0);
  const series = (shown || []).map((m) => {
    const rs = sel.filter((x) => x.month === m);
    const a = S(rs, 'orderValue'); const b = S(rs, 'invoicedValue');
    return { month: m, label: fmtMonth(m), a, b, gap: r2(a - b),
             orders: rs.filter((x) => x.bucket !== 'mtrOnly').length };
  });
  return {
    sel, byKey, R, S, series,
    totOrders,
    /* "Everything customers ordered" must count the ORDER REPORT's orders. The
       mtrOnly rows have no order row at all — they are invoices whose order
       sits outside the period — so including them made this read 22,203 while
       the Order Cycle beside it read 22,191, with the 12 unexplained. They add
       themselves back further down the walk, on their own line. */
    ordersPlaced: totOrders - (byKey.mtrOnly?.n || 0),
    totOrderVal: Object.values(byKey).reduce((a, x) => a + x.order, 0),
    m: byKey.matched || { n: 0, order: 0, inv: 0 },
  };
}

/* ── ORDER REPORT vs MTR ──────────────────────────────────────────────────
   Everyone knows the two files disagree; almost nobody can say why, so the gap
   gets written off as "Amazon's data is messy" and a real missing invoice hides
   inside it. Every line of the difference is explained by columns already in
   the files. This view names each one, in the order a reader meets them, and
   every number opens the orders behind it. */
function InvoicingView({ inv, shown, onDrill }) {
  /* Counting by ORDERS and counting by MONEY answer different questions and
     disagree sharply here — 1,581 cancellations are 7% of the orders but 0.02%
     of the value, while 316 are 1.4% of orders and 1.6% of value. Showing only
     one of them hides whichever matters, so both are always present and the
     toggle only decides which leads. */
  const [by, setBy] = useState('amount');
  const [open, setOpen] = useState(null);
  if (!inv) {
    return (
      <div className="rounded-xl px-5 py-4" style={{ background: '#F8FAFC', border: '1px solid #E3E6EA' }}>
        <p className="text-sm text-slate-500">
          This comparison needs both the order report and the MTR. Generate the report again once both
          are loaded.
        </p>
      </div>
    );
  }
  const t = inv.invoiceTiming || {};
  const { byKey, totOrders, ordersPlaced, totOrderVal, m, R, series } = invAgg(inv, shown);

  /* Both columns are generated FROM the bucket list, so a bucket can never be
     left out of the walk again. "Not an Amazon sale" and "free replacement"
     were absent from the left column; they happen to carry no money on this
     data, so the column footed by luck rather than by construction. */
  const L = (k, v, n, bucket, kind, op) => ({ k, v, n, bucket, kind, op });
  const leftLines = [L('Everything customers ordered', R.allOrderValue, ordersPlaced, '__all', 'strong', '')];
  for (const b of inv.buckets || []) {
    if (b.key === 'matched' || b.key === 'mtrOnly') continue;
    const a = byKey[b.key] || { n: 0, order: 0 };
    if (!a.n && !a.order) continue;
    /* the only bucket worth chasing is called out in red; the rest are
       ordinary life and must not read as faults */
    leftLines.push(L(String(b.label || b.key), -a.order, a.n, b.key,
                     b.key === 'shippedNoInvoice' ? 'flag' : '', '−'));
  }
  leftLines.push(L('Goods on orders in BOTH files', R.matchedOrderValue, m.n, 'matched', 'match', '='));

  const invoicedOrders = m.n + (byKey.mtrOnly?.n || 0);
  const rightLines = [L('Goods on the same orders — MTR principal', R.matchedPrincipal, m.n, 'matched', 'match', '')];
  if (Math.abs(R.shipping) >= 0.01) rightLines.push(L('Delivery billed on the invoice', R.shipping, null, null, '', '+'));
  if (Math.abs(R.promo) >= 0.01) rightLines.push(L('Promotional discount on the invoice', R.promo, null, null, '', '−'));
  if (Math.abs(R.giftWrap) >= 0.01) rightLines.push(L('Gift wrap billed on the invoice', R.giftWrap, null, null, '', '+'));
  if (Math.abs(R.mtrOnly) >= 0.01) rightLines.push(L('Invoiced, no order row in this period', R.mtrOnly, byKey.mtrOnly?.n, 'mtrOnly', '', '+'));
  if (Math.abs(R.other) >= 0.01) rightLines.push(L('Other invoice differences', R.other, null, null, '', '+'));
  rightLines.push(L('Invoiced', R.invoicedValue, invoicedOrders, null, 'strong', '='));
  rightLines.push(L('Returns credited', -R.refundedValue, R.refundOrders, 'matched', '', '−'));
  rightLines.push(L('Net invoiced', R.netBilled, invoicedOrders, null, 'strong', '='));

  /* The line-by-line walk below read the same whole-period aggregate, so it
     too stood still when the range moved. Built from the selected rows now,
     and from the SAME figures as the two columns above it — one period, one
     population, three presentations of it. */
  const bridgeLines = [
    { key: 'matchedGap', label: 'orders in the order report that never reached the MTR',
      note: 'Cancelled, not an Amazon sale, replaced at no charge, or shipped without an invoice.',
      amount: r2(R.matchedOrderValue - R.orderLevel) },
    { key: 'shipping', label: 'delivery billed on the invoice',
      note: 'The invoice carries a delivery charge the item price never did.', amount: R.shipping },
    { key: 'promo', label: 'promotional discount on the invoice',
      note: 'A discount applied on the invoice and not in the item price.', amount: R.promo },
    { key: 'giftWrap', label: 'gift wrap billed on the invoice', note: '', amount: R.giftWrap },
    { key: 'mtrOnly', label: 'invoiced with no order row in this period',
      note: 'Ordered just before the period opened, or just after midnight IST on the first.',
      amount: R.mtrOnly },
    { key: 'other', label: 'other invoice differences',
      note: 'Not explained by delivery, discount or gift wrap.', amount: R.other },
  ].filter((x) => Math.abs(x.amount) > 0.5);

  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(2)}%` : '—');
  const go = (bucket, label, side) => onDrill({ kind: 'invoicing', bucket, label, side, months: shown });

  /* every headline carries BOTH a count and a value, and opens its orders */
  const Bar = ({ a, b, tone }) => (
    <div className="h-1.5 rounded-full mt-2 overflow-hidden" style={{ background: '#EEF1F4' }}>
      <div className="h-full rounded-full" style={{ width: `${b ? Math.min(100, (100 * a) / b) : 0}%`, background: tone }} />
    </div>
  );

  /* ── the order report against the MTR, as one figure ──────────────────
     The tab opened on four counters and a 2x7 table. The question it answers
     is a single number — how much of what customers ordered reached the tax
     invoice — so that number leads, and the table underneath explains it. */
  const DIFF = r2(R.allOrderValue - R.invoicedValue);
  const DIFF_PARTS = [
    ...(inv.buckets || []).filter((b) => b.key !== 'matched' && b.key !== 'mtrOnly')
      .map((b) => ({ k: String(b.label || b.key), v: byKey[b.key]?.order || 0,
                     n: byKey[b.key]?.n || 0, bucket: b.key,
                     note: b.meaning ? String(b.meaning).split('. ')[0] + '.' : '' }))
      .filter((x) => x.n || x.v),
    ...(Math.abs(R.shipping) >= 0.01 ? [{ k: 'Delivery billed on the invoice', v: -R.shipping, n: null,
      note: 'The invoice carries a delivery charge the item price never did.' }] : []),
    ...(Math.abs(R.promo) >= 0.01 ? [{ k: 'Promotional discount on the invoice', v: -R.promo, n: null,
      note: 'A discount applied on the invoice and not in the item price.' }] : []),
    ...(Math.abs(R.giftWrap) >= 0.01 ? [{ k: 'Gift wrap billed on the invoice', v: -R.giftWrap, n: null,
      note: '' }] : []),
    ...(Math.abs(R.mtrOnly) >= 0.01 ? [{ k: 'Invoiced with no order row in this period', v: -R.mtrOnly,
      n: byKey.mtrOnly?.n || 0, bucket: 'mtrOnly',
      note: 'Ordered just before the period opened, or just after midnight IST on the first.' }] : []),
    ...(Math.abs(R.other) >= 0.01 ? [{ k: 'Other invoice differences', v: -R.other, n: null,
      note: 'Not explained by delivery, discount or gift wrap.' }] : []),
  ];

  return (
    <>
      <DiffWalk
        from={{ kind: 'order', col: 'item-price', v: R.allOrderValue, n: ordersPlaced,
                unit: 'orders placed in this period' }}
        to={{ kind: 'mtr', col: 'Invoice Amount', v: R.invoicedValue,
              n: m.n + (byKey.mtrOnly?.n || 0), unit: 'raised as tax invoices' }}
        lines={DIFF_PARTS}
        diff={DIFF}
        pctOf={`${((100 * Math.abs(DIFF)) / Math.max(R.allOrderValue, 1)).toFixed(2)}% of what customers ordered`}
        onLine={(d) => go(d.bucket, d.k, 'order')}
        note={'An order and its tax invoice are usually minutes apart, so most of this difference is '
            + 'cancellation. The two lines that carry no order count are differences in what the '
            + 'invoice bills for, not in which orders reached it.'} />

      <CompareChart
        series={series || []}
        A={{ label: 'Ordered', legend: 'Order report · item-price', tone: T.violet,
             short: 'The MTR invoiced MORE than the order report shows, which is invoices whose order '
                  + 'was placed before this period opened.' }}
        B={{ label: 'Invoiced', legend: 'MTR · Invoice Amount', tone: T.blue,
             short: 'Part of what customers ordered never reached a tax invoice — cancelled, not an '
                  + 'Amazon sale, or replaced at no charge.' }}
        title="Order report against MTR, period by period"
        sub="Purple is what customers ordered. Blue is what became a tax invoice."
        countLabel="orders"
        onSee={(d) => onDrill({ kind: 'invoicing', bucket: '__all',
                                label: 'order report against MTR, order by order',
                                side: 'order', months: d.months })}
        note={'An order and its tax invoice are usually minutes apart, so these two bars track each '
            + 'other closely. Where they do not, the difference is cancellations — and at a period '
            + 'edge, orders placed just before it opened.'} />

      <div className="rounded-xl px-5 py-4 mb-5" style={{ background: '#EFF6FF', border: '1px solid #BFDBFE' }}>
        <div className="text-sm font-bold mb-1.5" style={{ color: '#1E3A8A' }}>
          When does Amazon raise the invoice?
        </div>
        <p className="text-[13px] leading-relaxed" style={{ color: '#1E40AF' }}>
          Measured on {int(t.sample || 0)} invoices in these files: the tax invoice is raised a median
          of <strong>{t.medianOrderToInvoiceHrs} hours</strong> after the order
          ({t.pctInvoicedWithin24h}% inside 24 hours), and the goods leave a median of{' '}
          <strong>{t.medianInvoiceToShipHrs} hours</strong> later —{' '}
          <strong>{t.pctInvoicedBeforeShipping}% are invoiced BEFORE they ship.</strong> So the invoice
          belongs to <strong>order confirmation, not dispatch</strong>: cancel inside that first half
          hour and no invoice ever existed, cancel later and it stays in the MTR with a Cancel row.
        </p>
      </div>

      {/* sales, the two ways, every line opening its orders */}
      <Card title="Sales at order level vs MTR level"
            sub="The same months counted twice — once from the order report, once from the tax invoices. The green line is where they meet.">
        <div className="p-4 grid gap-5 lg:grid-cols-2">
          {[{ head: 'At order level', kind: 'order', col: 'item-price', lines: leftLines },
            { head: 'At MTR (invoice) level', kind: 'mtr', col: 'Invoice Amount', lines: rightLines },
          ].map((panel) => {
            const f = FILEMARK[panel.kind];
            /* scaled against the biggest line IN THIS COLUMN. Against the
               87 lakh every deduction is an invisible sliver, which is how a
               bar can be drawn and still say nothing. */
            const top = Math.max(...panel.lines.map((x) => Math.abs(x.v || 0)), 1);
            return (
              <div key={panel.head} className="rounded-xl overflow-hidden"
                   style={{ border: `1px solid ${f.bd}` }}>
                <div className="px-4 py-2.5 flex items-baseline gap-2.5"
                     style={{ background: f.bg, borderBottom: `1px solid ${f.bd}` }}>
                  <span className="text-[11px] uppercase tracking-wider font-bold" style={{ color: f.tone }}>
                    {panel.head}
                  </span>
                  <span className="text-[11px]" style={{ color: f.tone, opacity: .72 }}>
                    {f.name} · {panel.col}
                  </span>
                  <span className="ml-auto w-[62px] text-right text-[10px] uppercase tracking-wider font-bold"
                        style={{ color: f.tone, opacity: .6 }}>Orders</span>
                  <span className="w-[120px] text-right text-[10px] uppercase tracking-wider font-bold"
                        style={{ color: f.tone, opacity: .6 }}>Amount</span>
                </div>
                {panel.lines.map((x, i) => {
                  const match = x.kind === 'match'; const strong = x.kind === 'strong';
                  const bg = match ? '#F0FDF4' : strong ? f.bg : '#fff';
                  return (
                    <button key={i} disabled={!x.bucket}
                            onClick={() => x.bucket && go(x.bucket, x.k, panel.kind === 'mtr' ? 'mtr' : 'order')}
                            className={`w-full flex items-center gap-2.5 px-4 py-2.5 border-t border-slate-100 text-left transition-colors ${x.bucket ? 'hover:bg-slate-50 cursor-pointer' : ''}`}
                            style={{ background: bg,
                                     borderLeft: match ? '3px solid #34D399' : '3px solid transparent' }}>
                      <span className="w-3.5 shrink-0 text-center text-[14px]" style={{ color: `${f.tone}66` }}>
                        {x.op}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className={`block text-[13px] truncate ${match || strong ? 'font-bold' : 'font-semibold'}`}
                              style={{ color: match ? '#0A3D27' : '#1F2430' }}>
                          {x.k}
                        </span>
                        <span className="block h-[3px] mt-1.5 rounded-full overflow-hidden max-w-[150px]"
                              style={{ background: '#F1F3F6' }}>
                          <span className="block h-full rounded-full ar-grow"
                                style={{ width: `${Math.max(Math.abs(x.v) > 0 ? 3 : 0, (100 * Math.abs(x.v || 0)) / top)}%`,
                                         background: match ? '#34D399' : f.tone,
                                         opacity: match || strong ? 0.85 : 0.5 }} />
                        </span>
                      </span>
                      <span className="w-[62px] shrink-0 text-right text-[12.5px] font-semibold tabular-nums"
                            style={{ color: x.n == null ? '#CBD5E1' : '#334155' }}>
                        {x.n == null ? '—' : int(x.n)}
                      </span>
                      <span className="w-[120px] shrink-0 text-right text-[13.5px] font-semibold tabular-nums"
                            style={{ color: x.kind === 'flag' ? T.red : match ? T.green
                                            : strong ? f.tone : '#1F2430' }}>
                        ₹{inr(Math.abs(x.v || 0))}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* ── where the two columns meet ──────────────────────────────────
            The matched figure closes the left column and opens the right, so
            it sits in two far corners and the agreement has to be asserted
            rather than seen. Stated here, under both, with the green edge
            above tying it to the two rows it came from. */}
        <div className="mx-4 mb-4 rounded-xl relative overflow-hidden ar-tie"
             style={{ border: '1.5px solid #86EFAC', background: '#F0FDF4' }}>
          <span className="ar-glide" style={{ background: '#34D399' }} />
          <div className="px-5 py-3.5 flex items-center gap-6 flex-wrap">
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: T.green }}>
                The green line above, in both columns
              </div>
              <p className="text-[12.5px] mt-1 leading-relaxed max-w-[430px]" style={{ color: '#3F5B4D' }}>
                The order report&rsquo;s <em>item-price</em> and the MTR&rsquo;s <em>Principal Amount</em> on the
                same orders — two files, counted apart, to the paisa.
              </p>
            </div>
            <div className="ml-auto flex items-center gap-6">
              {[['Orders', int(m.n), '#0A3D27'],
                ['Order report', `₹${inr(R.matchedOrderValue)}`, T.violet],
                ['=', null, T.green],
                ['MTR', `₹${inr(R.matchedPrincipal)}`, T.blue]].map(([cap, val, c], i) => (
                val === null
                  ? <div key={i} className="text-[19px] font-bold" style={{ color: c }}>{cap}</div>
                  : (
                    <div key={i} className="text-right">
                      <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#6B8A79' }}>
                        {cap}
                      </div>
                      <div className="text-[20px] font-bold tabular-nums" style={{ color: c }}>{val}</div>
                    </div>
                  )
              ))}
            </div>
          </div>
        </div>

        <div className="px-4 pb-4">
          {/* THE BRIDGE. The two totals were never measuring the same thing:
              the order report's item-price is the PRINCIPAL, while the MTR's
              Invoice Amount is principal + shipping + gift wrap − promotional
              discounts. Naming each step turns a number that read as a fault
              into arithmetic the reader can follow. */}
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-2 text-[11px] uppercase tracking-wide font-bold"
                 style={{ background: '#F8FAFC', color: '#475569' }}>
              Why the two totals differ, line by line
            </div>
            <div className="px-4 py-2 border-t border-slate-100 flex justify-between">
              <span className="text-[13px] text-slate-600">
                Order level (item price)
                <span className="text-[11px] text-slate-400 ml-1.5">what customers were charged for goods</span>
              </span>
              <span className="text-[13px] tabular-nums font-semibold text-slate-800">₹{inr(R.orderLevel)}</span>
            </div>
            {bridgeLines.map((x) => (
              <div key={x.key} className="px-4 py-2 border-t border-slate-100 flex justify-between gap-3">
                <span className="text-[13px] text-slate-600 min-w-0">
                  {x.amount > 0 ? 'Add: ' : 'Less: '}{x.label}
                  <span className="block text-[11px] text-slate-400 leading-snug">{x.note}</span>
                </span>
                <span className="text-[13px] tabular-nums whitespace-nowrap"
                      style={{ color: x.amount > 0 ? T.green : T.red }}>
                  {x.amount > 0 ? '+' : '−'}₹{inr(Math.abs(x.amount))}
                </span>
              </div>
            ))}
            <div className="px-4 py-2.5 border-t border-slate-200 flex justify-between"
                 style={{ background: '#F8FAFC' }}>
              <span className="text-[13px] font-bold text-slate-800">Invoiced (MTR invoice amount)</span>
              <span className="text-[13px] tabular-nums font-bold text-slate-800">₹{inr(R.invoicedValue)}</span>
            </div>
            {Math.abs(R.other || 0) > 1 && (
              <div className="px-4 py-2 border-t flex justify-between"
                   style={{ background: '#FFFBEB', borderColor: '#FDE68A' }}>
                <span className="text-[13px] font-bold" style={{ color: '#78350F' }}>Still unexplained</span>
                <span className="text-[13px] tabular-nums font-bold" style={{ color: '#78350F' }}>
                  ₹{inr(Math.abs(R.other))}
                </span>
              </div>
            )}
          </div>
          <p className="text-[12px] leading-relaxed mt-2.5 rounded-lg px-3.5 py-2.5"
             style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', color: '#1E40AF' }}>
            <strong>The two highlighted rows are the same {int(m.n)} orders, measured the same way —
            and they are equal.</strong> Everything above and below them is one file counting orders the
            other does not have, or the invoice carrying something the item price never did. On the
            matched orders the two files agree exactly: the order report&rsquo;s item price totals{' '}
            <strong>₹{inr(R.matchedOrderValue, 0)}</strong> and the MTR&rsquo;s <em>Principal Amount</em>{' '}
            totals <strong>₹{inr(R.matchedPrincipal, 0)}</strong>
            {Math.abs(r2(R.matchedOrderValue - R.matchedPrincipal)) < 1 ? ' — the same number' : ''}. Everything above is the
            difference between <em>principal</em> and <em>invoice value</em>, not a discrepancy.
          </p>
        </div>
      </Card>

      {/* the buckets, counted both ways */}
      <Card title="Where the difference comes from"
            sub="every order sits in exactly one bucket — click a bucket to open its orders"
            right={
              <div className="flex rounded-lg overflow-hidden border border-slate-200">
                {[['amount', 'By amount'], ['orders', 'By orders']].map(([k, label]) => (
                  <button key={k} onClick={() => setBy(k)}
                          className="px-3 py-1.5 text-[11.5px] font-bold transition-colors"
                          style={by === k ? { background: T.ink, color: '#fff' }
                                          : { background: '#fff', color: '#64748B' }}>
                    {label}
                  </button>
                ))}
              </div>}>
        <div className="p-4 space-y-2">
          {(inv.buckets || []).map((b) => {
            const a = byKey[b.key] || { n: 0, order: 0, inv: 0 };
            if (!a.n) return null;
            const value = a.order || a.inv;
            const lead = by === 'amount' ? `₹${inr(value, 0)}` : int(a.n);
            const trail = by === 'amount' ? `${int(a.n)} orders` : `₹${inr(value, 0)}`;
            const share = by === 'amount' ? pct(value, totOrderVal) : pct(a.n, totOrders);
            const isOpen = open === b.key;
            return (
              <div key={b.key} className="border rounded-xl overflow-hidden"
                   style={{ borderColor: isOpen ? (b.expected ? '#CBD5E1' : '#FCA5A5') : '#E3E6EA' }}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="text-[10px] font-bold px-2 py-1 rounded uppercase tracking-wide shrink-0"
                        style={b.expected ? { background: '#F1F5F9', color: '#475569' }
                                          : { background: '#FEF2F2', color: T.red }}>
                    {b.expected ? 'Expected' : 'Check'}
                  </span>
                  <button onClick={() => setOpen(isOpen ? null : b.key)}
                          className="flex-1 min-w-0 text-left">
                    <div className="font-semibold text-slate-800 text-sm">{b.label}</div>
                    <Bar a={by === 'amount' ? value : a.n} b={by === 'amount' ? totOrderVal : totOrders}
                         tone={b.expected ? '#CBD5E1' : T.red} />
                  </button>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-bold tabular-nums text-slate-800">{lead}</div>
                    <div className="text-[11px] text-slate-500 tabular-nums">{trail} · {share}</div>
                  </div>
                  <button onClick={() => go(b.key, b.label)}
                          className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg border shrink-0 hover:bg-slate-50"
                          style={{ borderColor: '#E3E6EA', color: '#475569' }}>
                    Open
                  </button>
                  <button onClick={() => setOpen(isOpen ? null : b.key)} className="shrink-0">
                    <ChevronDown className="h-4 w-4 text-slate-400 transition-transform"
                                 style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }} />
                  </button>
                </div>
                {isOpen && (
                  <div className="px-4 pb-4 border-t" style={{ borderColor: '#EEF1F4' }}>
                    <p className="text-[13px] text-slate-700 leading-relaxed mt-3">{b.meaning}</p>
                    <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mt-3">
                      {[['Orders', int(a.n)], ['Order value', `₹${inr(a.order)}`],
                        ['Invoiced value', `₹${inr(a.inv)}`],
                        ['Share of orders', pct(a.n, totOrders)]].map(([k, v]) => (
                        <div key={k} className="rounded-lg px-3 py-2" style={{ background: '#F8FAFC' }}>
                          <div className="text-[10px] uppercase tracking-wide font-bold text-slate-500">{k}</div>
                          <div className="text-sm font-bold text-slate-800 tabular-nums mt-0.5">{v}</div>
                        </div>
                      ))}
                    </div>
                    {b.key === 'shippedNoInvoice' && b.atPeriodEdge > 0 && (
                      <p className="text-[12px] mt-3 rounded-lg px-3 py-2"
                         style={{ background: '#FFFBEB', border: '1px solid #FDE68A', color: '#78350F' }}>
                        {int(b.atPeriodEdge)} shipped in the last month of the report, so the invoice is
                        in the next month&rsquo;s MTR — timing, not a missing invoice. The other{' '}
                        {int(a.n - b.atPeriodEdge)} are worth checking.
                      </p>
                    )}
                    <button onClick={() => go(b.key, b.label)}
                            className="mt-3 text-xs font-bold px-3.5 py-2 rounded-lg text-white"
                            style={{ background: T.ink }}>
                      Open all {int(a.n)} orders
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="What the MTR says about cancellations"
            sub="the order report says only “Cancelled” — the MTR says what happened to the invoice">
        <div className="p-4 grid gap-2 md:grid-cols-3">
          {(inv.cancellation || []).map((c) => (
            <div key={c.key} className="rounded-xl border border-slate-200 px-4 py-3">
              <div className="text-2xl font-bold tabular-nums text-slate-800">{int(c.count)}</div>
              <div className="font-semibold text-slate-700 text-[13px] mt-0.5">{c.label}</div>
              <p className="text-[12px] text-slate-500 leading-relaxed mt-1.5">{c.meaning}</p>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

/* ── the period picker ────────────────────────────────────────────────────
   Two month+year selects and a Search, the same shape the Shopify Order Cycle
   uses, so an accountant moving between the two agents is not learning a second
   control. The selects are CLAMPED to the months this report actually covers —
   offering a month with no data only invites an empty screen — and nothing
   re-reads until Search is pressed, so half-typed ranges never run.
   From === To is a single month and opens that month's statement. */
function RangeBar({ months, sel, setSel, all }) {
  const lo = months[0] || '';
  const hi = months[months.length - 1] || '';
  const cur = sel && sel.from ? sel : { from: lo, to: hi };
  const [d, setD] = useState(cur);
  useEffect(() => { setD(sel && sel.from ? sel : { from: lo, to: hi }); }, [sel, lo, hi]);

  const years = [...new Set(months.map((m) => +m.slice(0, 4)))].sort();
  const monthsIn = (y) => months.filter((m) => +m.slice(0, 4) === y).map((m) => +m.slice(5));
  const mk = (y, mo) => `${y}-${String(mo).padStart(2, '0')}`;
  /* keep a half-made selection inside the data rather than letting it 404 */
  const clamp = (v) => (months.includes(v) ? v : (v < lo ? lo : hi));

  const set = (which, y, mo) => setD((p) => ({ ...p, [which]: clamp(mk(y, mo)) }));
  const invalid = d.from > d.to;
  const dirty = d.from !== cur.from || d.to !== cur.to;
  const narrowed = cur.from !== lo || cur.to !== hi;
  /* A report may cover five years; the screen shows MAX_VIEW months of it at
     a time, because the per-order rows behind the panels are fetched for the
     window and eighteen months of them is already 33 MB. Moving the window is
     free - it is only the width that is capped. */
  const span = months.filter((m) => m >= d.from && m <= d.to).length;
  const tooWide = span > MAX_VIEW;
  const longReport = months.length > MAX_VIEW;
  /* snap the other end in rather than just refusing: dragging From back past
     the limit should carry To with it, which is what a reader means by it */
  const snap = (which) => {
    const idx = months.indexOf(which === 'from' ? d.from : d.to);
    if (idx < 0) return;
    if (which === 'from') setD((p) => ({ ...p, to: months[Math.min(months.length - 1, idx + MAX_VIEW - 1)] }));
    else setD((p) => ({ ...p, from: months[Math.max(0, idx - MAX_VIEW + 1)] }));
  };

  const Picker = ({ which }) => {
    const v = d[which]; const y = +v.slice(0, 4); const mo = +v.slice(5);
    const avail = monthsIn(y);
    return (
      <div className="flex items-center gap-1.5 ml-1">
        <select value={mo} onChange={(e) => set(which, y, +e.target.value)}
                className="text-sm font-semibold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-800">
          {avail.map((n) => <option key={n} value={n}>{MON[n - 1]}</option>)}
        </select>
        <select value={y}
                onChange={(e) => {
                  const ny = +e.target.value;
                  const av = monthsIn(ny);
                  set(which, ny, av.includes(mo) ? mo : av[0]);
                }}
                className="text-sm font-semibold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-800">
          {years.map((yy) => <option key={yy} value={yy}>{yy}</option>)}
        </select>
      </div>
    );
  };

  const openAmt = all
    .filter((m) => m.month >= cur.from && m.month <= cur.to)
    .reduce((a, m) => a + (m.stillOpen?.amount || 0), 0);

  return (
    <div className="flex items-center justify-between flex-wrap gap-4 px-5 py-4 rounded-2xl mb-5"
         style={{ background: `${T.amber}0A`, border: `1px solid ${T.amber}35` }}>
      <div className="flex items-center flex-wrap gap-x-6 gap-y-3">
        <div className="flex items-center gap-2.5">
          <CalendarRange className="w-4 h-4 flex-shrink-0" style={{ color: T.amberText }} />
          <div>
            <p className="text-xs font-bold whitespace-nowrap text-slate-800">From</p>
            <p className="text-[10px] whitespace-nowrap text-slate-400">report covers {fmtMonth(lo)}</p>
          </div>
          <Picker which="from" />
        </div>

        <div className="w-px h-9 hidden sm:block bg-slate-200" />

        <div className="flex items-center gap-2.5">
          <CalendarRange className="w-4 h-4 flex-shrink-0" style={{ color: T.amberText }} />
          <div>
            <p className="text-xs font-bold whitespace-nowrap text-slate-800">To</p>
            <p className="text-[10px] whitespace-nowrap text-slate-400">through {fmtMonth(hi)}</p>
          </div>
          <Picker which="to" />
        </div>

        {!dirty && (
          <div className="text-[11px] leading-tight">
            <div className="font-semibold text-slate-600">
              {cur.from === cur.to ? fmtMonth(cur.from) : `${fmtMonth(cur.from)} – ${fmtMonth(cur.to)}`}
            </div>
            <div style={{ color: Math.abs(openAmt) < 1 ? '#94A3B8'
                                : openAmt < 0 ? T.amberText : T.red }}>
              {Math.abs(openAmt) < 1 ? 'fully settled'
                : `₹${inr(Math.abs(openAmt), 0)} ${openAmt < 0 ? 'held in excess' : 'pending'}`}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 flex-shrink-0">
        {tooWide && (
          <div className="text-[11px] leading-tight text-right max-w-[260px]">
            <div className="font-bold" style={{ color: T.amberText }}>
              {span} months selected · {MAX_VIEW} is the most that can be shown at once
            </div>
            <button onClick={() => snap('to')}
                    className="underline font-semibold" style={{ color: T.amberText }}>
              keep the last {MAX_VIEW} of them
            </button>
          </div>
        )}
        {narrowed && !dirty && !longReport && (
          <button onClick={() => setSel(null)}
                  className="text-[11px] font-bold px-2.5 py-1 rounded-full border transition-colors"
                  style={{ background: '#FFF7ED', color: T.amberText, borderColor: '#FED7AA' }}>
            Narrowed · show all {months.length}
          </button>
        )}
        {longReport && !dirty && (
          <span className="text-[11px] font-bold px-2.5 py-1 rounded-full border"
                style={{ background: '#FFF7ED', color: T.amberText, borderColor: '#FED7AA' }}>
            {span} of {months.length} months · move the dates to see the rest
          </span>
        )}
        <button onClick={() => !invalid && !tooWide && setSel({ from: d.from, to: d.to })}
                disabled={!dirty || invalid || tooWide}
                title={invalid ? '“From” must be on or before “To”'
                               : tooWide ? `Only ${MAX_VIEW} months can be shown at once`
                               : dirty ? 'Apply this range' : 'Range already applied'}
                className="flex items-center gap-1.5 text-sm font-bold px-4 py-2.5 rounded-xl flex-shrink-0 transition-all"
                style={dirty && !invalid && !tooWide
                  ? { background: T.ink, color: '#fff', boxShadow: `0 2px 8px ${T.ink}40` }
                  : { background: '#fff', border: '1px solid #e2e8f0', color: '#94a3b8', cursor: 'default' }}>
          <Search className="w-4 h-4" />
          Search
        </button>
      </div>
    </div>
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

  /* Returns read on the CREDIT-NOTE month — the month the note was raised, not
     the month of the sale — split into this month's own sales coming back and
     an earlier month's. `later` is this month's sales returned after the month
     end, which is NOT part of this month's total and is shown as a note. */
  const r = m.returned || {};
  const ret = {
    total: r.amount || 0,
    count: r.count || 0,
    own: (r.own && r.own.amount) || 0,
    earlier: (r.earlier && r.earlier.amount) || 0,
    later: (m.returnedLater && m.returnedLater.amount) || 0,
  };

  const [tab, setTab] = useState('statement');

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
                : 'Nothing has come in since', ''],
              ...(Math.abs(m.deferred?.amount || 0) > 1
                ? [[`Of this, Amazon is holding ₹${inr(m.deferred.amount, 0)}`, '']] : [])],
      foot: 'Month by month, in the box below ↓',
      drill: { kind: 'line', line: 'closing' },
    }]),
    { n: 4, q: 'How much of it was old money?', val: olderAmt, tone: T.amber, fg: T.amberText,
      sub: `${int(olderOrders)} orders · sold in an earlier month`,
      lines: [['Part of card 2, not card 1', ''], ['No sales invoice in this report', '']],
      foot: 'Month by month, in the box below ↓',
      drill: { kind: 'cash', month: m.month } },
  ];

  /* Returns get their own view, not a fifth card. A credit note is a different
     document from a sale and the accountant reads it on its own terms — how
     much came back, whose sales it was, and which orders — so it is a tab with
     its own KPIs rather than a number squeezed beside the receivable. */
  const TABS = [
    ['statement', 'Statement', m.invoiced.count ? `${int(m.invoiced.count)} invoices` : ''],
    ['returns', 'Returns', ret.count ? `${int(ret.count)} credit notes` : 'none'],
  ];

  return (
    <>
      <div className="flex items-center gap-1.5 mb-4 border-b border-slate-200">
        {TABS.map(([k, label, sub]) => (
          <button key={k} onClick={() => setTab(k)}
                  className="px-4 py-2.5 text-sm font-semibold -mb-px border-b-2 transition-colors"
                  style={tab === k
                    ? { borderColor: k === 'returns' ? T.violet : T.ink,
                        color: k === 'returns' ? T.violet : T.ink }
                    : { borderColor: 'transparent', color: '#94A3B8' }}>
            {label}
            {sub && <span className="ml-1.5 text-[11px] font-medium opacity-70">{sub}</span>}
          </button>
        ))}
      </div>

      {tab === 'returns'
        ? <ReturnsView m={m} data={data} ret={ret} onDrill={onDrill} />
        : <>
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

      {/* The order chain for THIS month, above the four questions: in April the
          order report holds N orders, the MTR invoiced fewer, the settlement
          paid fewer still, and until now the month view opened straight on a
          rupee figure with none of that said. */}
      <ChainLadder t={(data?.three?.perMonth || []).find((x) => x.month === m.month) || {}}
                   months={[m.month]} onDrill={onDrill}
                   title={`Order Cycle — ${fmtMonth(m.month)}`}
                   sub="What happened to every order placed in this month. Each step subtracts to the next." />

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
              {c.foot && (
                <div className="text-[11.5px] font-semibold mt-1.5" style={{ color: c.fg }}>{c.foot}</div>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* ── the two boxes cards 3 and 4 point down to ──────────────────────
          A card can only ever state the position AT THE MONTH END, because
          that is what the month closed on. The reader's next question is
          always "and did we get it?" / "whose sales was it?", and a 11px line
          reading "Later: 8,132 came in" answered neither. Named months, at a
          size someone will actually read. */}
      <div className="grid gap-3.5 grid-cols-1 lg:grid-cols-2 mb-5">
        <div className="bg-white border rounded-xl overflow-hidden" style={{ borderColor: '#FBD5D5' }}>
          <div className="px-5 py-3 border-b" style={{ background: '#FEF8F8', borderColor: '#FBD5D5' }}>
            <div className="text-[13.5px] font-bold" style={{ color: T.red }}>
              The ₹{inr(Math.abs(m.closing.amount))} unpaid on {endLabel(m.month)} — what happened to it
            </div>
            <div className="text-[12px] text-slate-500 mt-0.5">
              The card above still reads ₹{inr(Math.abs(m.closing.amount))}, because that is what the month
              closed on. This is what came in afterwards.
            </div>
          </div>
          <div className="px-5 py-2">
            {(m.laterBy || []).length === 0 && (
              <div className="text-[13px] text-slate-500 py-2">
                Nothing has come in since the month ended.
              </div>
            )}
            {(m.laterBy || []).map((x) => (
              <button key={x.month}
                      onClick={() => onDrill({ kind: 'line', line: 'receivedLater', months: [m.month] })}
                      className="w-full flex justify-between items-baseline gap-3 py-2 border-b border-slate-100 text-left hover:bg-slate-50">
                <span className="text-[13.5px] text-slate-700">
                  {/* a later month can also take money BACK — Jun 2025 was paid
                      4,206.33 in July and 381.95 of it reversed in September.
                      Calling that "came in" would be a lie about the sign. */}
                  {x.amount < 0 ? 'Taken back in ' : 'Came in '}{fmtMonth(x.month)}
                  <span className="text-[11.5px] text-slate-400 ml-1.5">{int(x.orders)} orders</span>
                </span>
                <span className="text-[13.5px] font-semibold tabular-nums"
                      style={{ color: x.amount < 0 ? T.red : T.green }}>
                  {x.amount < 0 ? '−' : ''}₹{inr(Math.abs(x.amount))}
                </span>
              </button>
            ))}
            <div className="flex justify-between items-baseline gap-3 py-2.5">
              <span className="text-[13.5px] font-bold text-slate-800">
                Still not received
                <span className="text-[11.5px] text-slate-400 ml-1.5">after every file loaded</span>
              </span>
              <span className="text-[14px] font-bold tabular-nums"
                    style={{ color: Math.abs(m.stillOpen.amount) < 1 ? T.green : T.red }}>
                ₹{inr(m.stillOpen.amount)}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-white border rounded-xl overflow-hidden" style={{ borderColor: '#FFD591' }}>
          <div className="px-5 py-3 border-b" style={{ background: '#FFFBF4', borderColor: '#FFD591' }}>
            <div className="text-[13.5px] font-bold" style={{ color: T.amberText }}>
              The ₹{inr(olderAmt)} of old money — which months it was for
            </div>
            <div className="text-[12px] text-slate-500 mt-0.5">
              Amazon credited it in {fmtMonth(m.month)}, but the sale was made earlier, so it belongs to
              card 2 and never to card 1.
            </div>
          </div>
          <div className="px-5 py-2">
            {older.length === 0 && (
              <div className="text-[13px] text-slate-500 py-2">
                Every rupee credited this month was for this month&rsquo;s own sales.
              </div>
            )}
            {older.map((x) => (
              <button key={x.saleMonth}
                      onClick={() => onDrill({ kind: 'cash', month: m.month, months: [m.month] })}
                      className="w-full flex justify-between items-baseline gap-3 py-2 border-b border-slate-100 text-left hover:bg-slate-50">
                <span className="text-[13.5px] text-slate-700">
                  {x.saleMonth === 'EARLIER'
                    ? 'Sold before this report begins'
                    : `Sold in ${fmtMonth(x.saleMonth)}`}
                  <span className="text-[11.5px] text-slate-400 ml-1.5">{int(x.orders)} orders</span>
                  {x.saleMonth === 'EARLIER' && (
                    <span className="block text-[11.5px] text-slate-400 leading-snug">
                      No sales invoice inside this report, so the month cannot be named. Load the earlier
                      months and it will be.
                    </span>
                  )}
                </span>
                <span className="text-[13.5px] font-semibold tabular-nums" style={{ color: T.amberText }}>
                  ₹{inr(x.amount)}
                </span>
              </button>
            ))}
            <div className="flex justify-between items-baseline gap-3 py-2.5">
              <span className="text-[13.5px] font-bold text-slate-800">Old money credited in {fmtMonth(m.month)}</span>
              <span className="text-[14px] font-bold tabular-nums" style={{ color: T.amberText }}>
                ₹{inr(olderAmt)}
              </span>
            </div>
          </div>
        </div>
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

      {/* The same Cash Cycle the multi-month view gets, for this one month —
          gross ordered down to what is still to come in. */}
      <CashCycle led={[m]} data={data} shown={[m.month]} onDrill={onDrill} />

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
        </>}
    </>
  );
}

/* ── RETURNS, on their own terms ──────────────────────────────────────────
   A credit note is not a smaller sale, it is its own document, and it belongs
   to the month it was RAISED — an order sold on 30 April and returned in May
   is a MAY credit note, because April's GST is filed and is not reopened.
   So this view answers the return questions only: how much came back, whose
   sales it was, how fast it came back, and which orders — down to the credit
   note number and the ledger row behind it. */
function ReturnsView({ m, data, ret, onDrill }) {
  const rows = (data?.ledger?.rows || [])
    .filter((r) => r.refunded > 0 && r.refundMonth === m.month);
  const prior = (data?.ledger?.priorPeriodRefunds || [])
    .filter((p) => p.refundMonth === m.month);

  const invoiced = m.invoiced.amount || 0;
  const rate = invoiced ? (100 * ret.own) / invoiced : 0;

  const kpis = [
    { q: 'How much came back in this month?', val: ret.total, tone: T.violet, fg: T.violet,
      sub: `${int(ret.count)} credit note${ret.count === 1 ? '' : 's'} raised in ${fmtMonth(m.month)}`,
      lines: [['Of this month’s sales', inr(ret.own)],
              ['Of earlier months’ sales', inr(ret.earlier)]] },
    { q: 'How much of THIS MONTH’S sales came back?', val: ret.own, tone: T.blue, fg: '#111927',
      sub: `${rate.toFixed(1)}% of ₹${inr(invoiced, 0)} invoiced this month`,
      lines: [['Invoiced this month', inr(invoiced)],
              ['Returned, credited this month', inr(ret.own)]] },
    { q: 'How much belonged to earlier months?', val: ret.earlier, tone: T.amber, fg: T.amberText,
      sub: 'sold before this month, credited now',
      lines: [['Sold in an earlier month', inr(ret.earlier)],
              ['Their sales month is already closed', '']] },
    { q: 'Sold this month, returned later?', val: ret.later, tone: T.red, fg: T.red,
      sub: ret.later > 0 ? 'credited after the month end' : 'nothing has come back since',
      lines: [['Not deducted from this month', ''],
              ['It is the later month’s credit note', '']] },
  ];

  const all = [
    ...rows.map((r) => ({ orderId: r.orderId, amount: r.refunded, saleMonth: r.month,
                          cn: r.creditNote || '', own: r.month === m.month, row: r })),
    ...prior.map((p) => ({ orderId: p.orderId, amount: p.amount, saleMonth: p.invoiceMonth || '—',
                           cn: '', own: false, row: null })),
  ].sort((a, b) => b.amount - a.amount);

  return (
    <>
      <div className="rounded-xl px-5 py-3.5 mb-5" style={{ background: '#F5F0FF', border: '1px solid #DDD0FF' }}>
        <p className="text-sm leading-relaxed" style={{ color: '#4C1D95' }}>
          <strong>How returns are dated:</strong> a return belongs to the month its <strong>credit
          note</strong> was raised, not the month the goods were sold. An order sold on 30 April and
          returned in May is a <strong>May</strong> credit note — April’s GST is already filed and is
          never reopened. So the {int(ret.count)} credit {ret.count === 1 ? 'note' : 'notes'} below
          {ret.count === 1 ? ' reduces ' : ' reduce '}<strong>{fmtMonth(m.month)}</strong>, whichever
          month the goods were sold in.
        </p>
      </div>

      <div className="grid gap-3.5 grid-cols-1 md:grid-cols-2 xl:grid-cols-4 mb-5">
        {kpis.map((c, i) => (
          <button key={i} onClick={() => onDrill({ kind: 'returns', month: m.month, months: [m.month] })}
                  className="text-left bg-white border border-slate-200 rounded-xl p-4 hover:shadow-md hover:border-slate-300 transition-all"
                  style={{ borderTop: `4px solid ${c.tone}` }}>
            <div className="text-[12.5px] font-bold text-slate-700 leading-tight min-h-[2.4em]">{c.q}</div>
            <div className="text-[26px] font-bold tracking-tight mt-1.5 tabular-nums" style={{ color: c.fg }}>
              ₹{inr(c.val)}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">{c.sub}</div>
            <div className="mt-2.5 pt-2 border-t border-slate-100">
              {c.lines.map(([k, v], j) => (
                <div key={j} className="flex justify-between gap-2 py-0.5">
                  <span className="text-[11.5px] text-slate-500">{k}</span>
                  <span className="text-[11.5px] font-bold text-slate-700 tabular-nums whitespace-nowrap">{v}</span>
                </div>
              ))}
            </div>
          </button>
        ))}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-slate-800">
              Every credit note raised in {fmtMonth(m.month)}
            </div>
            <div className="text-[11.5px] text-slate-500 mt-0.5">
              From the MTR sales report · Transaction Type = Refund · dated by Credit Note Date
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-slate-500">Total</div>
            <div className="text-base font-bold tabular-nums" style={{ color: T.violet }}>₹{inr(ret.total)}</div>
          </div>
        </div>
        {all.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No credit notes were raised in {fmtMonth(m.month)}.
          </div>
        ) : (
          <div className="overflow-x-auto" style={{ maxHeight: 520 }}>
            <table className="w-full text-sm">
              <thead className="sticky top-0" style={{ background: '#F8FAFC' }}>
                <tr className="text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-2.5 text-left font-semibold">Order</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Credit note</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Sold in</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Whose sales</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {all.map((x, i) => (
                  <tr key={x.orderId + i} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                      onClick={() => onDrill({ kind: 'returns', month: m.month, months: [m.month],
                                               focusOrder: x.orderId })}>
                    <td className="px-5 py-2 font-mono text-[12px] text-slate-700">{x.orderId}</td>
                    <td className="px-4 py-2 text-[12px] text-slate-600">{x.cn || '—'}</td>
                    <td className="px-4 py-2 text-[12px] text-slate-600">
                      {x.saleMonth && x.saleMonth !== '—' ? fmtMonth(x.saleMonth) : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                            style={x.own ? { background: '#DBEAFE', color: '#1E40AF' }
                                         : { background: '#FEF3C7', color: T.amberText }}>
                        {x.own ? 'this month' : 'earlier month'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold text-slate-800">
                      ₹{inr(x.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/* ── how a shelf full of orders becomes one "Net sales" figure ────────────
   The Cash Cycle opened on Net sales 83,19,418.98 with no parentage: an
   accountant comparing it with the order report found neither the gross figure
   nor the deductions, and concluded the report did not match the orders. It
   does. This is the walk, vertical because eleven rungs across a page cannot be
   read, and each rung names the file it came from.

   The rungs are the Order-vs-Invoice bridge plus returns — the same
   aggregation, so the two tabs cannot drift apart. */
function SalesWalk({ inv, shown, onDrill }) {
  if (!inv) return null;
  const { byKey, ordersPlaced, m, R } = invAgg(inv, shown);
  const L = [];
  L.push({ label: 'Everything customers ordered', v: R.allOrderValue, n: ordersPlaced, op: '',
           src: 'order', bucket: '__all', note: 'Every order placed in the period, cancellations included' });
  for (const b of inv.buckets || []) {
    if (b.key === 'matched' || b.key === 'mtrOnly') continue;
    const a = byKey[b.key] || { n: 0, order: 0 };
    if (!a.n && !a.order) continue;
    L.push({ label: String(b.label || b.key), v: -a.order, n: a.n, op: '−', src: 'order',
             bucket: b.key, note: b.meaning ? String(b.meaning).split('. ')[0] + '.' : '' });
  }
  L.push({ label: 'Goods on the orders that were invoiced', v: R.matchedOrderValue, n: m.n, op: '=',
           src: 'derived', bucket: 'matched', strong: true,
           note: 'The order report and the MTR agree on these to the paisa' });
  const add = (k, label, v, note) => {
    if (Math.abs(v) < 0.01) return;
    L.push({ label, v, op: v > 0 ? '+' : '−', src: 'mtr', note,
             bucket: k === 'mtrOnly' ? 'mtrOnly' : null, n: k === 'mtrOnly' ? byKey.mtrOnly?.n : null });
  };
  add('shipping', 'Delivery billed on the invoice', R.shipping,
      'The invoice carries a delivery charge the item price never did');
  add('promo', 'Promotional discount on the invoice', R.promo,
      'A discount applied on the invoice and not in the item price');
  add('giftWrap', 'Gift wrap billed on the invoice', R.giftWrap, '');
  add('mtrOnly', 'Invoiced with no order row in this period', R.mtrOnly,
      'Ordered just before the period opened, or just after midnight IST on the first');
  add('other', 'Other invoice differences', R.other,
      'Not explained by delivery, discount or gift wrap');
  L.push({ label: 'Invoiced', v: R.invoicedValue, n: null, op: '=', src: 'mtr', strong: true,
           note: 'Invoice Amount on every Shipment row of the MTR' });
  L.push({ label: 'Customer returns', v: -R.refundedValue, n: null, op: '−', src: 'mtr',
           bucket: null, note: 'Refunds credited against these orders' });
  L.push({ label: 'Net sales', v: R.netBilled, n: null, op: '=', src: 'derived', strong: true, final: true,
           note: 'What Amazon owes us before its own charges — the figure the Cash Cycle starts from' });

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden mb-5">
      <div className="px-4 py-2.5 flex items-center justify-between" style={{ background: '#F8FAFC' }}>
        <span className="text-[11px] uppercase tracking-wide font-bold text-slate-600">
          How we get to net sales
        </span>
        <span className="text-[11px] text-slate-500">GST-inclusive throughout · click any line</span>
      </div>
      {L.map((x, i) => {
        const f = FILES[x.src]; const Icon = f.icon;
        return (
          <button key={i} disabled={!x.bucket}
                  onClick={() => x.bucket && onDrill({ kind: 'invoicing', bucket: x.bucket, label: x.label,
                                                       side: x.src === 'mtr' ? 'mtr' : 'order', months: shown })}
                  className={`w-full flex items-baseline gap-3 px-4 py-2.5 border-t border-slate-100 text-left
                              ${x.bucket ? 'hover:bg-slate-50 cursor-pointer' : ''}`}
                  style={x.final ? { background: '#EFF6FF' } : x.strong ? { background: '#F8FAFC' } : {}}>
            <span className="w-4 shrink-0 text-[15px] text-slate-300 font-semibold">{x.op}</span>
            <span className="min-w-0 flex-1">
              <span className={`text-[13.5px] ${x.strong ? 'font-bold' : 'text-slate-700'}`}
                    style={x.final ? { color: '#1E3A8A' } : {}}>
                {x.label}
                {x.n != null && <span className="text-[11px] text-slate-400 ml-1.5">{int(x.n)} orders</span>}
              </span>
              {x.note && <span className="block text-[11px] text-slate-400 leading-snug mt-0.5">{x.note}</span>}
            </span>
            <span className="flex items-center gap-1 text-[10px] font-bold shrink-0 w-[92px] justify-end"
                  style={{ color: f.tone }}>
              <Icon className="h-3 w-3" /> {f.short}
            </span>
            <span className={`text-[13.5px] tabular-nums whitespace-nowrap w-[130px] text-right
                              ${x.strong ? 'font-bold' : ''}`}
                  style={x.final ? { color: '#1E3A8A' } : {}}>
              ₹{inr(Math.abs(x.v || 0))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── the order chain, as a ladder ─────────────────────────────────────────
   Every order leaves by exactly one door, so the rungs subtract to the next
   one and nothing sits between two cards unexplained. The screen used to show
   six side-by-side cards with no operators between them: 22,191 placed less
   1,913 cancelled is 20,278, the next card read 20,157, and the 121 orders in
   between were on no card at all. "Not an Amazon sale" sat alongside as a
   sixth number although 17 of its 124 were already counted inside Cancelled
   and the other 107 inside that gap — so the row could not be added up in any
   order without double-counting.

   Counts AND amounts on every rung, because "22,191 orders" is not a figure an
   accountant can tie to anything. Amounts are the order report's `item-price`,
   which is GST-INCLUSIVE — its `item-tax` is the tax already inside it, not an
   addition to it. */
const chainRungs = (t = {}) => [
  { key: 'placed', op: '', cap: 'Orders placed', n: t.placed, v: t.valuePlaced, src: 'order',
    note: 'Every order in the period, counted once each' },
  { key: 'cancelled', op: '−', cap: 'Cancelled', n: t.cancelled, v: t.valueCancelled, src: 'order',
    fg: T.amberText, note: 'Cancelled on every line — no invoice, no payment' },
  { key: 'mcf', op: '−', cap: 'Not an Amazon sale', n: t.mcf, v: t.valueMcf, src: 'order', fg: '#5B6472',
    note: 'Ordered on another website, only shipped by Amazon. Carries no price.' },
  { key: 'notInvoicedFree', op: '−', cap: 'Replaced at no charge', n: t.notInvoicedFree,
    v: t.valueNotInvoicedFree, src: 'order', fg: '#5B6472',
    note: 'Priced at nil, so there is nothing to invoice' },
  { key: 'notInvoiced', op: '−', cap: 'Shipped, never invoiced', n: t.notInvoiced, v: t.valueNotInvoiced,
    src: 'derived', fg: T.red, note: 'Goods went out with a price, no tax invoice in the MTR' },
  { key: 'invoiced', op: '=', cap: 'Invoiced', n: t.shipped, v: t.valueInvoiced, src: 'mtr', strong: true,
    note: 'A tax invoice for it exists in the MTR' },
  /* Amazon holds the money a median of 11.4 days, so a slice of every month is
     invoiced inside it and paid after it. The chain used to ask only "was this
     ever paid" — nought unpaid — while the MTR-vs-Settlement tab asked "paid by
     the period end" and answered 141. Both true, and together unreadable. It
     closes at the period end now, like a month statement, and names the three
     states separately. */
  { key: 'settledLater', op: '−', cap: 'Paid after the period', n: t.settledLater,
    v: t.valueSettledLater, src: 'settlement', fg: T.amberText,
    note: 'Invoiced inside the period, money released after it closed' },
  { key: 'unsettled', op: '−', cap: 'Not paid at all', n: t.unsettled, v: t.valueUnsettled,
    src: 'settlement', fg: T.red, note: 'No payment in any settlement held' },
  { key: 'settled', op: '=', cap: 'Paid by the period end', n: t.settled, v: t.valueSettled,
    src: 'settlement', fg: T.green, strong: true, note: 'Money actually released by the closing date' },
];

function ChainLadder({ t, months, onDrill, title, sub }) {
  const rungs = chainRungs(t);
  return (
    <Card title={title} sub={sub}>
      <div className="flex flex-wrap items-stretch">
        {rungs.map((r) => {
          const f = FILES[r.src]; const Icon = f.icon;
          return (
            <React.Fragment key={r.key}>
              {r.op && (
                <div className="flex items-center justify-center w-7 shrink-0 text-[17px] font-semibold text-slate-300 select-none">
                  {r.op}
                </div>
              )}
              <button onClick={() => onDrill({ kind: 'chain', step: r.key, months })}
                      className={`flex-1 min-w-[186px] p-4 text-left border transition-colors hover:bg-slate-50
                                  ${r.strong ? 'border-slate-300 bg-slate-50/60' : 'border-slate-200 bg-white'}`}>
                <div className="text-[10.5px] font-bold uppercase tracking-wider text-slate-400">{r.cap}</div>
                <div className="text-[27px] font-bold tracking-tight mt-1 tabular-nums leading-none"
                     style={{ color: r.fg || '#111927' }}>
                  {int(r.n || 0)}
                </div>
                <div className="text-[14px] font-semibold text-slate-700 mt-1.5 tabular-nums">
                  {inr(r.v || 0)}
                </div>
                <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">{r.note}</p>
                <div className="flex items-center gap-1 mt-2 text-[10px] font-bold" style={{ color: f.tone }}>
                  <Icon className="h-3 w-3" /> {f.short}
                </div>
              </button>
            </React.Fragment>
          );
        })}
      </div>
      <p className="text-[11.5px] text-slate-500 mt-3 leading-relaxed">
        Amounts are the order report&rsquo;s <span className="font-semibold">item-price</span>, which is
        <span className="font-semibold"> inclusive of GST</span> — {inr(t?.taxPlaced || 0)} of the
        {' '}{inr(t?.valuePlaced || 0)} placed is GST. Cancelled and &ldquo;not an Amazon sale&rdquo; orders are
        shown at the price the customer would have paid; an MCF order carries no price at all, which is why
        that rung reads nil. Click any rung for the orders behind it.
      </p>
    </Card>
  );
}

/* ── the whole period: volume, summary, cash cycle ───────────────────────── */
/* ── the Cash Cycle, for a period OR for one month ────────────────────────
   It only ever existed for a multi-month range. Opening a single month gave
   the four question cards and nothing else, so the month that an accountant
   actually closes was the one view with no walk from sales to cash. Same
   component, `led` is just one month long. */
function CashCycle({ led, data, shown, onDrill }) {
  const amt = (k) => led.reduce((a, m) => a + (m[k]?.amount || 0), 0);
  /* ── money that arrived in this period but belongs to an earlier one ─────
     "Received to date" is a COHORT figure: cash against the sales of the
     months on screen, whenever it turned up. That is the right number for a
     receivable, but it silently drops cash that landed inside the period for
     sales made before it — which is how the page could report receipts that
     did not agree with the bank, and why a period could look over-collected
     with no bucket saying why. It is not part of the subtraction; it is its
     own bucket, named. */
  const sel = new Set(shown);
  const oldMoney = (data?.ledger?.cash || [])
    .filter((c) => sel.has(c.month))
    .flatMap((c) => (c.bySaleMonth || []).filter((x) => !sel.has(x.saleMonth)))
    .reduce((a, x) => ({ amount: r2(a.amount + x.amount), orders: a.orders + x.orders }),
            { amount: 0, orders: 0 });
  /* ── THE PERIOD'S OWN CLOSING BALANCE ──────────────────────────────────
     A month view answers "what did this month close owing?" and the accountant
     reads it every month. A YEAR view could not answer the same question: it
     showed only "Still pending", which is what has never arrived AFTER every
     later file was loaded. Those are different questions with very different
     answers - FY25-26 closed 31 Mar owing 2,35,086.85, of which all but
     3,794.81 came in during April. Reading 3,794.81 as "the receivable at the
     year end" understates it by 61x, and summing the twelve month-end closings
     instead gives 20,27,983.89, which double counts every month that was paid
     in the next one. Neither is the balance sheet figure.

     So compute it the only way that is right: cash dated ON OR BEFORE the last
     month shown, against what was due on the period's own sales. `received` is
     each month's cash by ITS OWN end, and `laterBy` breaks the rest out by the
     month it actually arrived - so the part that arrived while the period was
     still open is the entries dated at or before the period end. Built from
     the month summaries alone, so it never waits on the per-order rows. */
  const periodEnd = shown.length ? shown.reduce((a, b) => (a > b ? a : b)) : null;
  const recdByEnd = periodEnd
    ? led.reduce((a, m) => a + (m.received?.amount || 0)
        + (m.laterBy || []).reduce((b, x) => b + (x.month <= periodEnd ? x.amount : 0), 0), 0)
    : 0;
  const asAtClose = r2(amt('expected') - recdByEnd);
  /* what happened to that balance afterwards, by the month it turned up -
     the same read-down the month view gives, so a year closes the same way */
  const afterEnd = Object.values(
    led.reduce((acc, m) => {
      (m.laterBy || []).forEach((x) => {
        if (periodEnd && x.month > periodEnd) {
          if (!acc[x.month]) acc[x.month] = { month: x.month, amount: 0, orders: 0 };
          acc[x.month].amount = r2(acc[x.month].amount + x.amount);
          acc[x.month].orders += (x.orders || 0);
        }
      });
      return acc;
    }, {}),
  ).sort((a, b) => (a.month < b.month ? -1 : 1));
  /* one month already has this, in its own words, on the card above */
  const showClose = shown.length > 1 && periodEnd;

  const EQ = [
    { cap: 'Net sales', v: amt('netBillable'), note: 'Sales after customer returns', op: '−', line: 'netBillable' },
    { cap: 'Amazon charges', v: amt('fees'), note: 'Commission, closing fee, FBA and storage', op: '−', fg: T.amberText, bg: '#FFFBF4', line: 'fees' },
    { cap: 'TDS u/s 194-O', v: amt('tds'), note: 'Against our PAN. Claim in the income-tax return.', op: '−', fg: T.amberText, bg: '#FFFBF4', line: 'tds' },
    { cap: 'TCS u/s 52 (GST)', v: amt('tcs'), note: 'Claim in the GST cash ledger.', op: '=', fg: T.amberText, bg: '#FFFBF4', line: 'tcs' },
    { cap: 'Due from Amazon', v: amt('expected'), note: 'Amount due on these invoices', op: '−', bg: '#F7F9FB', line: 'expected' },
    /* The value here is `settled` — every payment for these orders, in any
       month — so the drill and the provenance must be `settled` too. They
       pointed at `received`, which is the narrower "by the month end" figure,
       so the card opened a shorter list than the number it was printed under. */
    { cap: 'Received to date', v: amt('settled'), note: 'In this month or later', op: '=', fg: T.green, bg: '#F3FBF6', line: 'settled' },
    { cap: 'Still pending', v: amt('stillOpen'), note: 'Not received after every loaded file', op: '', fg: T.red, bg: '#FEF8F8', line: 'stillOpen' },
  ];
  /* Reimbursements, adjustments and fee refunds are money Amazon paid that is
     not payment for any invoice. They sit inside "received", so a month can
     close having been paid MORE than it billed — which reads as a negative
     amount still pending and looks like an error. Named here instead, between
     "Received to date" and "Still pending" and with NO operator, so it never
     reads as a term in the subtraction that produces the pending figure. */
  /* Amazon has RECORDED these sales and is HOLDING the money — not paid, not
     refused. That is part of what is still owed to us, so it sits beside
     "Still pending" as a slice of it, never as a separate pot. */
  const held = amt('deferred');
  if (Math.abs(held) > 1) {
    EQ.push({
      cap: 'Of which: Amazon is still holding it', v: held, op: '',
      note: 'Recorded in the settlement as deferred — no release date, so the money has not moved',
      fg: '#92400E', bg: '#FFFBEB', line: 'deferred', aside: true,
    });
  }
  const credits = amt('creditsNotAgainstInvoice');

  /* ── how much of that credit answers for an order shown as unpaid ───────
     The card and "Still pending" are built from different columns, so neither
     one is double counting on its own: a settlement row is EITHER a payment
     against the invoice or a credit, by its own type, never both.

     But the two can describe the SAME ORDER. Where Amazon lost the goods on
     the way back it never pays the sale, it pays a Reimbursement instead - so
     the invoice sits in "Still pending" while the money for it sits in this
     card. Measured on Koparo FY24-25, 1,763 orders carried a credit equal to
     their unpaid balance TO THE RUPEE; that is not coincidence, it is the
     same money described twice.

     So the overlap is named. It is capped at the unpaid balance per order -
     a credit larger than the balance is only "covering" up to the balance -
     and an order the settlement already paid in full contributes nothing. */
  const ovl = (data?.ledger?.rows || [])
    .filter((x) => shown.includes(x.month))
    .reduce((a, x) => {
      const unpaid = r2(x.invoiced - x.refunded - x.fees - x.tds - x.tcs - x.settled);
      if (unpaid > 0.01) {
        a.gross += unpaid;
        if ((x.credits || 0) > 0) a.covered += Math.min(x.credits, unpaid);
      } else if (unpaid < -0.01) { a.over += unpaid; a.overN += 1; }
      return a;
    }, { gross: 0, covered: 0, over: 0, overN: 0 });
  /* Gross, not the net "Still pending" - that nets off orders Amazon has
     OVER-settled, and comparing a gross cover against a net balance is how
     you end up reporting that nothing at all is owed. */
  const coveredByCredit = r2(ovl.covered);
  const grossOwing = r2(ovl.gross);
  const neverArrived = r2(Math.max(0, grossOwing - coveredByCredit));
  /* The card is drawn from the month summaries, which are in the payload, but
     the overlap needs the per-order rows, which arrive a moment later. Until
     they do, say nothing about the overlap: the old wording asserted that this
     money "settles no sale", so a reader who looked during that second was
     told the opposite of the answer. */
  const rowsReady = (data?.ledger?.rows || []).length > 0;
  /* "Still pending" is a NET figure: orders Amazon has OVERPAID are silently
     offset against orders it still owes. FY24-25 reads 3,56,096 because
     4,19,566 owed is netted against 63,469 overpaid on 471 orders - and
     nothing on the screen said so, which is no use to whoever has to explain
     the balance. Named here when it is not nil. */
  const overPaid = r2(Math.abs(ovl.over));

  if (rowsReady && overPaid > 1) {
    EQ.splice(6, 0, {
      cap: 'Of which: Amazon has overpaid', v: overPaid, op: '',
      note: `On ${int(ovl.overN)} order${ovl.overN === 1 ? '' : 's'} Amazon paid MORE than the invoice asked for. `
          + `Still pending is ₹${inr(grossOwing, 0)} owed less this — it is a net figure, not a gross one.`,
      fg: '#92400E', bg: '#FFFBEB', line: 'overPaid', aside: true,
    });
  }
  if (Math.abs(credits) > 1) {
    EQ.splice(6, 0, {
      cap: 'Of which: not against an invoice', v: credits, op: '',
      note: !rowsReady
        ? 'Reimbursements, adjustments, fee refunds — real money, already in the bank'
        : coveredByCredit > 1
          ? `Reimbursements, adjustments, fee refunds. ₹${inr(coveredByCredit, 0)} of it is money for orders that still read as unpaid`
          : 'Reimbursements, adjustments, fee refunds — none of it sits on an order still showing unpaid',
      fg: '#92400E', bg: '#FFFBEB', line: 'creditsNotAgainstInvoice', aside: true,
    });
  }
  return (
      <Card title="Cash Cycle" sub="From everything that was ordered, down to what is still to come in">
        <div className="px-5 pt-5">
          <SalesWalk inv={data?.invoicing} shown={shown} onDrill={onDrill} />
        </div>
        <div className="px-5 pb-5">
          <div className="flex items-stretch gap-2.5 flex-wrap">
            {EQ.map((e) => (
              <React.Fragment key={e.cap}>
                <button onClick={() => e.line && onDrill({ kind: 'line', line: e.line, months: shown })}
                        disabled={!e.line}
                        className={`flex-1 min-w-[170px] rounded-xl p-4 text-left transition-all ${e.line ? 'hover:shadow-md cursor-pointer' : ''}`}
                        style={{ background: e.bg || '#fff',
                                 border: e.aside ? '1px dashed #FDE68A' : '1px solid #E2E8F0' }}>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{e.cap}</div>
                  <div className="text-[22px] font-bold tracking-tight mt-1 tabular-nums"
                       style={{ color: e.fg || '#111927' }}>₹{inr(e.v)}</div>
                  <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">{e.note}</p>
                  {/* Which file, and WHICH ROWS OF IT. A file list at the foot
                      of the page does not tell an accountant whether a figure
                      took every order or only the live ones, which is exactly
                      what was being asked and could not be answered. */}
                  {(() => {
                    const pv = PROV[e.line];
                    if (!pv) return null;
                    const f = FILES[pv.file]; const Ic = f.icon;
                    return (
                      <div className="mt-2 pt-2 border-t border-slate-200/70">
                        <div className="flex items-center gap-1 text-[10px] font-bold" style={{ color: f.tone }}>
                          <Ic className="h-3 w-3" /> {f.short}
                        </div>
                        <div className="text-[10.5px] text-slate-400 leading-snug mt-0.5">
                          {pv.column}{pv.filter ? ` · ${pv.filter}` : ''}
                        </div>
                      </div>
                    );
                  })()}
                </button>
                {e.op
                  ? <div className="flex items-center text-xl font-bold text-slate-300">{e.op}</div>
                  : e.aside
                    ? <div className="flex items-center text-xs font-bold text-amber-300">↳</div>
                    : null}
              </React.Fragment>
            ))}
          </div>
          {showClose && (
            <div className="mt-4 bg-white border rounded-xl overflow-hidden"
                 style={{ borderColor: '#FBD5D5' }}>
              <div className="px-5 py-3 border-b"
                   style={{ background: '#FEF8F8', borderColor: '#FBD5D5' }}>
                <div className="flex items-baseline justify-between gap-4 flex-wrap">
                  <div className="text-[13.5px] font-bold" style={{ color: T.red }}>
                    The receivable as on {endLabel(periodEnd)} — what the period closed owing
                  </div>
                  <div className="text-[22px] font-bold tabular-nums" style={{ color: T.red }}>
                    ₹{inr(asAtClose)}
                  </div>
                </div>
                <div className="text-[12px] text-slate-500 mt-0.5">
                  This is the balance-sheet figure: what Amazon owed on these sales on the day the
                  period closed. It is <strong>not</strong> “Still pending” above — that is only the
                  part which never arrived at all, after every later file was loaded.
                </div>
              </div>
              <div className="px-5 py-2">
                <div className="flex justify-between items-baseline gap-3 py-2 border-b border-slate-100">
                  <span className="text-[13.5px] text-slate-700">Due from Amazon on these sales</span>
                  <span className="text-[13.5px] font-semibold tabular-nums text-slate-800">
                    ₹{inr(amt('expected'))}
                  </span>
                </div>
                <button onClick={() => onDrill({ kind: 'line', line: 'received', months: shown })}
                        className="w-full flex justify-between items-baseline gap-3 py-2 border-b border-slate-100 text-left hover:bg-slate-50">
                  <span className="text-[13.5px] text-slate-700">
                    Less received by {endLabel(periodEnd)}
                  </span>
                  <span className="text-[13.5px] font-semibold tabular-nums" style={{ color: T.green }}>
                    −₹{inr(recdByEnd)}
                  </span>
                </button>
                <div className="flex justify-between items-baseline gap-3 py-2.5 border-b border-slate-100">
                  <span className="text-[13.5px] font-bold text-slate-800">
                    = Receivable as on {endLabel(periodEnd)}
                  </span>
                  <span className="text-[15px] font-bold tabular-nums" style={{ color: T.red }}>
                    ₹{inr(asAtClose)}
                  </span>
                </div>
                <div className="text-[11.5px] font-bold uppercase tracking-wider text-slate-400 pt-3 pb-1">
                  What happened to it afterwards
                </div>
                {afterEnd.length === 0 && (
                  <div className="text-[13px] text-slate-500 py-2">
                    Nothing has come in since the period ended.
                  </div>
                )}
                {afterEnd.map((x) => (
                  <button key={x.month}
                          onClick={() => onDrill({ kind: 'line', line: 'receivedLater', months: shown })}
                          className="w-full flex justify-between items-baseline gap-3 py-2 border-b border-slate-100 text-left hover:bg-slate-50">
                    <span className="text-[13.5px] text-slate-700">
                      {x.amount < 0 ? 'Taken back in ' : 'Came in '}{fmtMonth(x.month)}
                      <span className="text-[11.5px] text-slate-400 ml-1.5">{int(x.orders)} orders</span>
                    </span>
                    <span className="text-[13.5px] font-semibold tabular-nums"
                          style={{ color: x.amount < 0 ? T.red : T.green }}>
                      {x.amount < 0 ? '−' : ''}₹{inr(Math.abs(x.amount))}
                    </span>
                  </button>
                ))}
                <div className="flex justify-between items-baseline gap-3 py-2.5">
                  <span className="text-[13.5px] font-bold text-slate-800">
                    Still not received
                    <span className="text-[11.5px] text-slate-400 ml-1.5">after every file loaded</span>
                  </span>
                  <span className="text-[14px] font-bold tabular-nums"
                        style={{ color: Math.abs(amt('stillOpen')) < 1 ? T.green : T.red }}>
                    ₹{inr(amt('stillOpen'))}
                  </span>
                </div>
              </div>
            </div>
          )}
          {Math.abs(credits) > 1 && (
            <div className="mt-3 rounded-xl px-4 py-2.5"
                 style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#92400E' }}>
                    Why that card is not part of the subtraction
                  </div>
                  <p className="text-[12px] leading-relaxed mt-1" style={{ color: '#78350F' }}>
                    Money Amazon paid that is <strong>not payment for an invoice</strong> — compensation
                    for goods lost or damaged on the way back, settlement adjustments, fee refunds. It
                    is real money and it is already in the bank, but it settles no sale — so it is
                    <strong> not</strong> netted against what Amazon still owes. Counting it as
                    settlement is what used to close almost every month with a negative amount
                    pending, as though Amazon overpaid every single month.
                    {' '}<strong>Still pending above is ₹{inr(amt('stillOpen'), 0)}</strong>, which is
                    what is genuinely unpaid on these invoices; this ₹{inr(credits, 0)} is separate
                    income.
                  </p>
                  {rowsReady && coveredByCredit > 1 && (
                    <p className="text-[12px] leading-relaxed mt-2 pt-2"
                       style={{ color: '#78350F', borderTop: '1px dashed #FCD34D' }}>
                      <strong>But the two can describe the same order.</strong> Of the
                      {' '}₹{inr(credits, 0)} above, <strong>₹{inr(coveredByCredit, 0)} sits on orders
                      that are still showing unpaid</strong> — typically goods lost on the way back,
                      where Amazon never pays the sale and pays compensation instead. Those orders
                      owe ₹{inr(grossOwing, 0)} between them, so once the compensation is allowed
                      for, only <strong>₹{inr(neverArrived, 0)}</strong> never arrived in any form.
                      {' '}Both figures are true — ₹{inr(grossOwing, 0)} is unpaid <em>on the
                      invoices</em>, ₹{inr(neverArrived, 0)} is unpaid <em>in the bank</em> — and the
                      second is the one to take to Amazon.
                    </p>
                  )}
                </div>
                <button onClick={() => onDrill({ kind: 'line', line: 'creditsNotAgainstInvoice', months: shown })}
                        className="text-[11px] font-bold shrink-0 underline underline-offset-2"
                        style={{ color: '#92400E' }}>see the orders</button>
              </div>
            </div>
          )}
          <div className="grid md:grid-cols-3 gap-3 mt-3">
            <button onClick={() => onDrill({ kind: 'cash', month: shown[0], months: shown })}
                    className="border rounded-xl p-4 text-left hover:shadow-md transition-all"
                    style={{ background: '#FFFBF4', borderColor: '#FFD591' }}>
              <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: T.amberText }}>
                Also credited in this period, for earlier sales
              </div>
              <div className="text-xl font-bold mt-1 tabular-nums" style={{ color: T.amberText }}>
                ₹{inr(oldMoney.amount)}
              </div>
              <p className="text-[11px] text-slate-500 mt-1">
                {int(oldMoney.orders)} orders sold before this period. Real cash, in the bank, but it
                settles sales that are not on this screen — so it is not part of the equation above.
              </p>
            </button>
            <button onClick={() => onDrill({ kind: 'line', line: 'invoiced', months: shown })}
                    className="border border-slate-200 rounded-xl p-4 bg-slate-50/50 text-left hover:shadow-md hover:border-slate-300 transition-all">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                GST included in the amount due (memo)
              </div>
              <div className="text-xl font-bold mt-1 tabular-nums">₹{inr(amt('gstMemo'))}</div>
              <p className="text-[11px] text-slate-500 mt-1">
                Amazon pays this to us along with the sale amount. It is not a deduction. We pay it to the government.
              </p>
            </button>
            <button onClick={() => onDrill({ kind: 'line', line: 'receivedLater', months: shown })}
                    className="border border-slate-200 rounded-xl p-4 bg-slate-50/50 text-left hover:shadow-md hover:border-slate-300 transition-all">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Received after the sale month ended
              </div>
              <div className="text-xl font-bold mt-1 tabular-nums">₹{inr(amt('receivedLater'))}</div>
              <p className="text-[11px] text-slate-500 mt-1">
                Sales of one month for which payment came in a later month.
              </p>
            </button>
          </div>
        </div>
      </Card>
  );
}

function PeriodOverview({ led, data, shown, onDrill, ST }) {
  const t = chainTotals(data?.three, shown);
  return (
    <>
      <ChainLadder t={t} months={shown} onDrill={onDrill}
        title="Order Cycle — what happened to every order"
        sub="Each step subtracts to the next, so the row adds up with nothing left over." />
      <CashCycle led={led} data={data} shown={shown} onDrill={onDrill} />
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
/* ── what needs attention, as tickets you can actually raise ──────────────
   The point of finding a discrepancy is to get the money back, and that means
   an email to Amazon Seller Support. Thirty-one findings printed open at full
   length is a wall nobody reads; what an accountant wants is a short list of
   claims, each one openable into the explanation, the evidence and a ready
   message. Same shape as the Marketplace Ticket Generator, so the two agents
   read alike. */
/* `label` names the row's badge; `subject`/`body` are present only where there
   is actually something to ask Amazon for. A finding that is ours to resolve —
   returns of sales from before the report starts — gets a badge and an
   explanation but no message, because sending one would waste the accountant's
   credibility on a non-issue. */
const TICKET = {
  'prior-period-refunds': { label: 'Sold before this period' },
  outstanding: {
    label: 'Payment not received',
    subject: (i) => `Settlement not received for ${i.month} — ₹${inr(Math.abs(i.amount), 0)}`,
    body: (i, brand, orders) =>
      `Hi Amazon Seller Support,\n\n`
      + `Our ${i.month} sales were invoiced but ₹${inr(Math.abs(i.amount), 0)} has still not been `
      + `settled to us.\n\n`
      + `Amount due on ${i.month} sales : ${i.expectedStr || '—'}\n`
      + `Received to date              : ${i.receivedStr || '—'}\n`
      + `Still outstanding             : ₹${inr(Math.abs(i.amount), 0)}\n`
      + `Orders with no payment at all : ${i.count || 0}\n\n`
      + `Please confirm, within 5 business days:\n`
      + `1. The settlement IDs covering these orders, or\n`
      + `2. Why payment is being withheld, order by order.\n\n`
      + (orders.length
          ? `Affected order IDs (first ${Math.min(orders.length, 20)} of ${orders.length}):\n`
            + orders.slice(0, 20).join('\n') + '\n\n'
          : '')
      + `Full order-level evidence is attached.\n\nBrand: ${brand}`,
  },
  'over-collected': {
    label: 'Paid more than billed',
    subject: (i) => `Excess received for ${i.month} — ₹${inr(Math.abs(i.amount), 0)}`,
    body: (i, brand) =>
      `Hi Amazon Seller Support,\n\n`
      + `For ${i.month} we received ₹${inr(Math.abs(i.amount), 0)} more than the amount billed on that `
      + `month's invoices.\n\n`
      + `This is usually payment made on dispatch for orders the customer returned afterwards, `
      + `recovered in a later settlement. Please confirm which settlement recovers it, so we do not `
      + `treat it as income.\n\nBrand: ${brand}`,
  },
};

function IssuesPanel({ audit, shown, onDrill, data, brand }) {
  const [open, setOpen] = useState(null);
  const [copied, setCopied] = useState(null);
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
  const rank = { blocker: 0, warning: 1, info: 2 };
  const sorted = issues.slice().sort((a, b) =>
    (rank[a.severity] - rank[b.severity]) || (Math.abs(b.amount || 0) - Math.abs(a.amount || 0)));

  const actionable = issues.filter((i) => i.severity !== 'info');
  /* only money we would actually ASK Amazon for — an over-collection is money
     we are holding, not money to claim, so it must not inflate the headline */
  const claimable = issues
    .filter((i) => i.key === 'outstanding' && (i.amount || 0) > 0)
    .reduce((a, i) => a + i.amount, 0);

  const ordersFor = (i) => {
    const rows = (data?.drills || {})[i.id] || [];
    return rows.map((r) => r.orderId).filter(Boolean);
  };
  const ticketFor = (i) => {
    const t = TICKET[i.key];
    /* an entry may carry only a `label` for the badge — that means this finding
       is ours to resolve and there is deliberately no message to send */
    if (!t || typeof t.subject !== 'function' || typeof t.body !== 'function') return null;
    /* and nothing informational gets a message either. The latest month always
       shows a balance because Amazon pays on a ~7 day cycle — the panel itself
       says "No action needed, upload the next month's file" — so offering an
       email asking where the money is contradicts the advice directly above it. */
    if (i.severity === 'info') return null;
    const orders = ordersFor(i);
    const enriched = { ...i,
      /* [\d,.]+ greedily eats the sentence's full stop, printing
         "₹1,64,785.69." — anchor the decimals so it cannot. */
      expectedStr: (i.what || '').match(/was ([\d,]+(?:\.\d{2})?)/)
        ? `₹${(i.what.match(/was ([\d,]+(?:\.\d{2})?)/))[1]}` : '',
      receivedStr: (i.what || '').match(/([\d,]+(?:\.\d{2})?) came in/)
        ? `₹${(i.what.match(/([\d,]+(?:\.\d{2})?) came in/))[1]}` : '' };
    return { subject: t.subject(enriched), body: t.body(enriched, brand || 'our account', orders), orders };
  };
  const copy = (i, text) => {
    try {
      navigator.clipboard.writeText(text);
      setCopied(i.id); setTimeout(() => setCopied(null), 1800);
    } catch { /* clipboard blocked — the text is on screen to select */ }
  };

  const KPIS = [
    ['Issues found', int(issues.length), '#111927'],
    ['Need action', int(actionable.length), actionable.length ? T.red : '#111927'],
    ['To claim from Amazon', `₹${inr(claimable, 0)}`, claimable > 0 ? T.green : '#94A3B8'],
    ['Period', rangeLabel(shown), '#111927'],
  ];

  return (
    <Card title="What needs attention"
          sub={`${audit.verdict} · open a line to see the explanation and a ready message for Amazon`}>
      <div className="grid gap-3 grid-cols-2 xl:grid-cols-4 p-4 pb-0">
        {KPIS.map(([k, v, c]) => (
          <div key={k} className="rounded-lg px-3.5 py-2.5" style={{ background: '#F8FAFC' }}>
            <div className="text-[10.5px] uppercase tracking-wide font-bold text-slate-500">{k}</div>
            <div className="text-lg font-bold tabular-nums mt-0.5" style={{ color: c }}>{v}</div>
          </div>
        ))}
      </div>

      <div className="p-4 space-y-2">
        {sorted.map((i) => {
          const s = SEV[i.severity];
          const isOpen = open === i.id;
          const t = isOpen ? ticketFor(i) : null;
          const ords = isOpen ? ordersFor(i) : [];
          return (
            <div key={i.id} className="border rounded-xl overflow-hidden"
                 style={{ borderColor: isOpen ? s.fg + '55' : '#E3E6EA' }}>
              <button onClick={() => setOpen(isOpen ? null : i.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors">
                <span className="text-[10px] font-bold px-2 py-1 rounded uppercase tracking-wide shrink-0"
                      style={{ background: s.bg, color: s.fg }}>
                  {TICKET[i.key]?.label || s.label}
                </span>
                <span className="font-semibold text-slate-800 text-sm flex-1 min-w-0 truncate">{i.title}</span>
                {Math.abs(i.amount || 0) > 1 && (
                  <span className="font-bold tabular-nums shrink-0"
                        style={{ color: i.key === 'outstanding' && i.amount > 0 ? T.green : '#64748B' }}>
                    ₹{inr(Math.abs(i.amount), 0)}
                  </span>
                )}
                <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition-transform"
                             style={{ transform: isOpen ? 'rotate(180deg)' : 'none' }} />
              </button>

              {isOpen && (
                <div className="px-4 pb-4 pt-1 border-t" style={{ borderColor: '#EEF1F4' }}>
                  <p className="text-sm text-slate-700 leading-relaxed mt-3">{i.what}</p>
                  <p className="text-sm text-slate-500 leading-relaxed mt-2">{i.why}</p>

                  <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mt-3.5">
                    {[['Month', i.month || rangeLabel(shown)],
                      ['Amount', `₹${inr(Math.abs(i.amount || 0))}`],
                      /* the count means a different thing per finding — calling
                         26 returns "orders with no payment" reads as a loss */
                      [i.key === 'prior-period-refunds' ? 'Orders returned'
                        : i.key === 'outstanding' ? 'Orders with no payment'
                        : 'Orders', int(i.count || 0)],
                      ['Severity', s.label]].map(([k, v]) => (
                      <div key={k} className="rounded-lg px-3 py-2" style={{ background: '#F8FAFC' }}>
                        <div className="text-[10px] uppercase tracking-wide font-bold text-slate-500">{k}</div>
                        <div className="text-sm font-bold text-slate-800 tabular-nums mt-0.5">{v}</div>
                      </div>
                    ))}
                  </div>

                  {ords.length > 0 && (
                    <div className="mt-3.5">
                      <div className="text-[10.5px] uppercase tracking-wide font-bold text-slate-500 mb-1.5">
                        {i.key === 'prior-period-refunds' ? 'Returned orders' : 'Affected orders'}
                        {' '}({int(ords.length)} total)
                      </div>
                      <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                        {ords.slice(0, 60).map((o) => (
                          <span key={o} className="text-[11px] font-mono px-2 py-0.5 rounded"
                                style={{ background: '#F1F5F9', color: '#475569' }}>{o}</span>
                        ))}
                        {ords.length > 60 && (
                          <span className="text-[11px] text-slate-400 px-1 py-0.5">
                            +{int(ords.length - 60)} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="mt-3.5 text-[11px] text-slate-600 leading-relaxed rounded-lg px-3.5 py-2.5"
                       style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
                    <strong>What to do:</strong> {i.howToFix}
                  </div>

                  {t ? (
                    <div className="mt-3.5">
                      <div className="text-[10.5px] uppercase tracking-wide font-bold mb-1.5"
                           style={{ color: T.blue }}>Message to Amazon Seller Support</div>
                      <pre className="text-[11.5px] leading-relaxed whitespace-pre-wrap font-mono rounded-lg px-3.5 py-3 text-slate-700 max-h-56 overflow-y-auto"
                           style={{ background: '#F8FAFC', border: '1px solid #E3E6EA' }}>
{`Subject: ${t.subject}\n\n${t.body}`}
                      </pre>
                      <div className="flex gap-2 mt-2.5">
                        <button onClick={() => copy(i, `Subject: ${t.subject}\n\n${t.body}`)}
                                className="text-xs font-bold px-3.5 py-2 rounded-lg border transition-colors"
                                style={copied === i.id
                                  ? { background: '#ECFDF3', borderColor: '#6EE7B7', color: '#047857' }
                                  : { background: '#fff', borderColor: '#E3E6EA', color: '#374151' }}>
                          {copied === i.id ? 'Copied' : 'Copy message'}
                        </button>
                        {i.drill && (
                          <button onClick={() => onDrill(i)}
                                  className="text-xs font-bold px-3.5 py-2 rounded-lg text-white transition-colors"
                                  style={{ background: T.ink }}>
                            Show the orders behind this
                          </button>
                        )}
                      </div>
                    </div>
                  ) : i.drill ? (
                    /* nothing to ask Amazon for, but the evidence is still worth
                       opening — this finding is ours to resolve, not theirs */
                    <div className="mt-3.5">
                      <button onClick={() => onDrill(i)}
                              className="text-xs font-bold px-3.5 py-2 rounded-lg text-white transition-colors"
                              style={{ background: T.ink }}>
                        Show the orders behind this
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

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
            <tr><td colSpan={99} className="px-5 pt-4 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Also received — not against any invoice
            </td></tr>
            {EXTRA.map((L) => row(L, true))}
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
  const t = chainTotals(data?.three, shown);
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
      {/* The order report is named by UTC but every month here is IST, which is
          what the GST return runs on. Measured on June 2025: 7 orders placed on
          30 June after 18:30 UTC are 1 July in IST, so they sit in July and the
          June file appears to be 7 short. Saying so here stops someone counting
          the file and concluding the report has lost orders. */}
      <div className="px-4 pt-3 pb-1">
        <p className="text-[11.5px] text-slate-500 leading-relaxed">
          <strong className="text-slate-600">Months are Indian time (IST).</strong> Amazon names the
          order report by UTC, so an order placed late on the 30th sits in the next month here — that
          is the month its GST belongs to. A month can therefore hold a few orders more or fewer than
          the file of the same name.
        </p>
      </div>
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
  if (drill.kind === 'returns') {
    /* every credit note RAISED in this month, whichever month was sold —
       so the list foots to card 5 and shows both halves of its split */
    const m = drill.month;
    return { kind: 'ledger', prov: PROV.returned,
             rows: all.filter((r) => r.refunded > 0 && r.refundMonth === m) };
  }
  if (drill.kind === 'invoicing') {
    /* order-vs-MTR rows, not ledger rows — a different population with a
       different question, so it carries its own columns and provenance */
    const all2 = (data?.invoicing?.rows || [])
      .filter((r) => (!ms.length || !r.month || ms.includes(r.month)));
    const rows = drill.bucket === '__all' ? all2
      : drill.buckets ? all2.filter((r) => drill.buckets.includes(r.bucket))
      : all2.filter((r) => r.bucket === drill.bucket);
    /* biggest difference first — the order anyone reads a reconciliation in */
    rows.sort((a, b) => Math.abs((b.orderValue || 0) - (b.invoicedValue || 0))
                      - Math.abs((a.orderValue || 0) - (a.invoicedValue || 0)));
    return { kind: 'invoicing', rows,
             prov: PROV[drill.side === 'mtr' ? 'invoiced' : 'placed'] || PROV.invoiced };
  }
  if (drill.kind === 'money') {
    const all3 = mmAgg(data?.moneyMatch, ms).rows;
    const rows = drill.bucket === '__all'
      ? all3.filter((r) => r.bucket !== 'settlementOnly')
      : all3.filter((r) => r.bucket === drill.bucket);
    rows.sort((a, b) => Math.abs(b.shortfall || 0) - Math.abs(a.shortfall || 0));
    return { kind: 'money', rows, prov: PROV.money };
  }
  if (drill.kind === 'chain') {
    const rows = (data?.three?.orderRows || []).filter(inSel);
    const pick = {
      placed: () => rows, cancelled: () => rows.filter((r) => r.cancelled),
      net: () => rows.filter((r) => !r.cancelled),
      mcf: () => rows.filter((r) => !r.cancelled && r.mcf),
      notInvoicedFree: () => rows.filter((r) => !r.cancelled && !r.mcf && !r.invoiced && !r.value),
      notInvoiced: () => rows.filter((r) => !r.cancelled && !r.mcf && !r.invoiced && r.value > 0),
      invoiced: () => rows.filter((r) => !r.cancelled && !r.mcf && r.invoiced),
      settled: () => rows.filter((r) => !r.cancelled && !r.mcf && r.invoiced && r.settled),
      settledLater: () => rows.filter((r) => !r.cancelled && !r.mcf && r.invoiced && r.settledLater),
      unsettled: () => rows.filter((r) => !r.cancelled && !r.mcf && r.invoiced
                                          && !r.settled && !r.settledLater),
    }[drill.step] || (() => rows);
    const pk = { placed: 'placed', cancelled: 'cancelled', net: 'net', invoiced: 'chainInvoiced',
                 mcf: 'mcf', notInvoiced: 'notInvoiced', notInvoicedFree: 'notInvoicedFree',
                 settled: 'chainSettled', settledLater: 'chainSettledLater',
                 unsettled: 'chainUnsettled' }[drill.step] || 'placed';
    return { kind: 'chain', rows: pick(), prov: PROV[pk] };
  }
  const mine = all.filter(inSel).filter(billable);
  const m0 = ms[0];
  const pick = {
    returned: () => mine.filter((r) => r.refunded > 0),
    creditsNotAgainstInvoice: () => mine.filter((r) => Math.abs(r.credits || 0) > 0.01),
    fees: () => mine.filter((r) => r.fees > 0),
    tds: () => mine.filter((r) => r.tds > 0),
    tcs: () => mine.filter((r) => r.tcs > 0),
    received: () => mine.filter((r) => recdBy(r, m0) !== 0),
    /* every order with a payment against it, in ANY month — the "received to
       date" card's own population, which it did not have before */
    settled: () => mine.filter((r) => r.settled !== 0),
    deferred: () => mine.filter((r) => Math.abs(r.deferred || 0) > 0.01),
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
  /* the status names its month — "Settled in a later month" made the reader
     go hunting for which one */
  { key: 'status', label: 'Status', calc: (r) => statusText(r) },
  { key: 'invoiced', label: 'Invoiced', num: true },
  { key: 'refunded', label: 'Returned', num: true },
  { key: 'refundMonth', label: 'Return month', fmt: (v) => (v ? fmtMonth(v) : '—') },
  { key: 'refundDate', label: 'Return date', fmt: fmtDay },
  { key: 'fees', label: 'Amazon charges', num: true },
  { key: 'tds', label: 'TDS', num: true },
  { key: 'tcs', label: 'TCS', num: true },
  { key: 'netDue', label: 'Net amount due', num: true, calc: (r) => +(r.invoiced - r.refunded - r.fees - r.tds - r.tcs).toFixed(2) },
  { key: 'settled', label: 'Received', num: true },
  { key: 'diff', label: 'Difference', num: true, calc: (r) => +(r.invoiced - r.refunded - r.fees - r.tds - r.tcs - r.settled).toFixed(2) },
  { key: 'settledMonth', label: 'Payment month', fmt: (v) => (v ? fmtMonth(v) : '—') },
  { key: 'settledDate', label: 'Payment date', fmt: (v) => (v ? fmtDay(v) : '—') },
];
/* Both files on one row, and the month the money actually moved — without that
   last column a "paid in a later month" row is indistinguishable from an unpaid
   one, which is the whole question the tab exists to answer. */
const MONEY_COLS = [
  { key: 'orderId', label: 'Order ID', mono: true, w: 22 },
  { key: 'month', label: 'Sale month', fmt: fmtMonth },
  { key: 'invoiceNo', label: 'Invoice no', mono: true, w: 20 },
  { key: 'invoiceDate', label: 'Invoice date', fmt: fmtDay },
  { key: 'mtrValue', label: 'Invoiced (MTR)', num: true },
  { key: 'settledGross', label: 'Credited by period end', num: true },
  { key: 'shortfall', label: 'Difference', num: true },
  { key: 'paidMonths', label: 'Paid in' },
  { key: 'fees', label: 'Amazon charges', num: true },
  { key: 'tds', label: 'TDS', num: true },
  { key: 'tcs', label: 'TCS', num: true },
  { key: 'settledNet', label: 'Net paid', num: true },
  { key: 'why', label: 'What happened', w: 60 },
];

const CHAIN_COLS = [
  { key: 'orderId', label: 'Order ID', mono: true, w: 22 },
  { key: 'month', label: 'Sale month', fmt: fmtMonth },
  { key: 'status', label: 'Order status' },
  { key: 'channel', label: 'Sales channel' },
  { key: 'invoiced', label: 'Invoiced?', bool: true },
  { key: 'settled', label: 'Paid?', bool: true },
  { key: 'value', label: 'Order value', num: true },
  { key: 'tax', label: 'GST within it', num: true },
  { key: 'shipState', label: 'Ship state' },
];

/* An invoicing drill has to show BOTH files on one row — the order side and
   the invoice side — otherwise the reader cannot see which one is missing. */
const INVOICING_COLS = [
  { key: 'orderId', label: 'Order ID', mono: true, w: 22 },
  { key: 'month', label: 'Month', fmt: fmtMonth },
  { key: 'status', label: 'Order status' },
  { key: 'qty', label: 'Qty', num: true },
  { key: 'orderValue', label: 'Order report', num: true },
  { key: 'invoicedValue', label: 'MTR', num: true },
  /* the point of the drill: the two reports on one row and what is between
     them. Without it the reader has to subtract 2,000 rows by eye. */
  { key: 'diff', label: 'Difference', num: true,
    calc: (r) => r2((r.orderValue || 0) - (r.invoicedValue || 0)) },
  { key: 'why', label: 'Why it is here' },
];

function DrillPanel({ drill, data, ST, base, onClose }) {
  const [busy, setBusy] = useState(false);
  const { kind, rows, prov } = useMemo(() => drillRows(drill, data, ST), [drill, data, ST]);
  const cols = kind === 'chain' ? CHAIN_COLS
             : kind === 'money' ? MONEY_COLS
             : kind === 'invoicing' ? INVOICING_COLS : LEDGER_COLS;
  const f = FILES[prov.file]; const FIcon = f.icon;
  const period = rangeLabel(drill.months || []);
  const title = drill.kind === 'issue' ? drill.issue.title
    : drill.kind === 'status' ? `${period} · ${drill.status}`
    : drill.kind === 'cash' ? `${period} · credited for earlier months’ sales`
    : drill.kind === 'returns' ? `${period} · credit notes raised in this month`
    : drill.kind === 'invoicing' ? `${period} · ${drill.label || drill.bucket}`
    : drill.kind === 'money' ? `${period} · ${drill.label || drill.bucket}`
    : drill.kind === 'chain' ? `${period} · ${{
        placed: 'Orders placed', cancelled: 'Cancelled', net: 'Net orders',
        mcf: 'Not an Amazon sale', notInvoiced: 'Shipped, never invoiced',
        settledLater: 'Paid after the period',
        notInvoicedFree: 'Replaced at no charge',
        invoiced: 'Invoiced', settled: 'Paid by the period end', unsettled: 'Not paid at all',
      }[drill.step] || drill.step}`
    : `${period} · ${[...LINES, ...AFTER].find((l) => l.key === drill.line)?.label
        || { settled: 'Received to date', received: 'Received by the month end',
             stillOpen: 'Still pending', closing: 'Not received at the month end',
             deferred: 'Held by Amazon (deferred)',
             creditsNotAgainstInvoice: 'Credits not against an invoice' }[drill.line]
        || drill.line}`;

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
/* The stored status is a category; what an accountant needs is the category
   AND the month it points at. Returned in Jul 2026, paid in Sep 2026 — the
   month is the fact that decides which period the entry belongs to. */
function statusText(r) {
  const st = String(r.status || '');
  if (/later/i.test(st) && r.settledMonth) return `Paid in ${fmtMonth(r.settledMonth)}`;
  if (/^Settled in the month/i.test(st) && r.settledMonth) return `Paid in ${fmtMonth(r.settledMonth)}`;
  if (/return|refund/i.test(st)) {
    return r.refundMonth ? `Returned in ${fmtMonth(r.refundMonth)}` : st;
  }
  return st;
}

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
            {/* Return month sits beside the amount returned, because the
                accountant's next question after "how much came back" is always
                "in which month" — it decides the GST period of the credit note. */}
            {['Order ID', 'Sale month', 'Invoiced', 'Returned', 'Return month', 'Amazon charges',
              'TDS', 'TCS', 'Net amount due', 'Received', 'Difference', 'Payment month',
              'Status'].map((h, i) => (
              <th key={h} className={`px-3 py-2.5 font-bold ${(i >= 2 && i <= 3) || (i >= 5 && i <= 10) ? 'text-right' : 'text-left'}`}>{h}</th>
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
                  <td className="px-3 py-2 text-slate-600">
                    {fmtMonth(r.month)}
                    {r.saleDate && <span className="block text-[10px] text-slate-400">{fmtDay(r.saleDate)}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{inr(r.invoiced)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.refunded ? inr(r.refunded) : '—'}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {r.refunded && r.refundMonth ? (
                      <>
                        {fmtMonth(r.refundMonth)}
                        {r.refundDate && <span className="block text-[10px] text-slate-400">{fmtDay(r.refundDate)}</span>}
                      </>
                    ) : '—'}
                  </td>
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
                  {/* the payment side carries its day too, exactly as the sale
                      does — the two are checked against each other and against
                      the bank, so one without a date is half an answer */}
                  <td className="px-3 py-2 text-slate-600">
                    {r.settledMonth ? fmtMonth(r.settledMonth) : '—'}
                    {r.settledDate && <span className="block text-[10px] text-slate-400">{fmtDay(r.settledDate)}</span>}
                  </td>
                  {/* "Settled in a later month" leaves the reader to go and find
                      WHICH month. Name it — that is the whole question. */}
                  <td className="px-3 py-2 text-slate-600">{statusText(r)}</td>
                </tr>
                {isOpen && (
                  <tr style={{ background: '#FAFBFC' }}>
                    <td colSpan={14} className="px-10 py-4">
                      <div className="grid md:grid-cols-4 gap-3">
                        {[
                          { f: 'order', rows: [['Sale month', fmtMonth(r.month)],
                                               ['Sale date', fmtDay(r.saleDate)],
                                               ['Order status', r.status]] },
                          { f: 'mtr', rows: [['Invoice value', `₹${inr(r.invoiced)}`],
                                             ['Returns', r.refunded ? `₹${inr(r.refunded)}` : 'none'],
                                             ...(r.refunded ? [['Returned in',
                                               r.refundMonth ? fmtMonth(r.refundMonth) : 'month not stated'],
                                               ['Return date', fmtDay(r.refundDate)]] : []),
                                             ...(r.creditNote ? [['Credit note', r.creditNote]] : []),
                                             ['GST within it', `₹${inr(r.gst)}`]] },
                          { f: 'settlement', rows: [['Received', `₹${inr(r.settled)}`],
                                                    ['Payment month', r.settledMonth ? fmtMonth(r.settledMonth) : 'no payment yet'],
                                                    ['Payment date', r.settledDate ? fmtDay(r.settledDate) : '—'],
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

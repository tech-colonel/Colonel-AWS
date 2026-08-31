import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../components/ui/modal';
import {
    Loader2, Plus, Download, Trash2, FileText, RefreshCw,
    ChevronRight, ChevronLeft, CheckCircle2, Package, CreditCard,
    ShoppingBag, UploadCloud, AlertCircle, Calendar, BarChart2,
    ArrowLeft, Eye, XCircle, Search, Info, Route, LayoutDashboard,
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import api from '../../lib/api';
import { loadOcDateRange, saveOcDateRange } from '../../lib/ocDateRange';

// ─── Constants ────────────────────────────────────────────────────────────────
const LOGISTICS_PARTNERS = [
    { id: 'delhivery',  label: 'Delhivery',            color: '#6366f1' },
    { id: 'xpressbees', label: 'Xpressbees (Busybees)', color: '#f59e0b' },
    { id: 'ekart',      label: 'Instakart (Ekart)',     color: '#10b981' },
    { id: 'bluedart',   label: 'Bluedart',              color: '#ef4444' },
];

const PAYMENT_GATEWAYS = [
    { id: 'razorpay', label: 'Razorpay',         color: '#3b82f6' },
    { id: 'snapmint', label: 'Snapmint',          color: '#8b5cf6' },
    { id: 'bharatx',  label: 'BharatX (AuroraX)', color: '#ec4899' },
];

const STEP_SELECT  = 1;
const STEP_UPLOAD  = 2;
const STEP_PREVIEW = 3;

const MONTHS = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December',
];
// Convert a stored month number (1-12) back to a name for display
function monthNumToName(n) {
    const num = parseInt(n);
    return num >= 1 && num <= 12 ? MONTHS[num - 1] : (n || '—');
}
const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: 5 }, (_, i) => currentYear - i);

// ─── Date-range picker helpers (Month/Year selects, same as the Receivable
// Dashboard's own picker — the underlying fromDate/toDate the API takes are
// still exact ISO dates, just derived from the selected month's first/last day) ──
function isoToMonthYear(iso) {
    if (!iso) return null;
    const [y, m] = iso.split('-');
    return { month: parseInt(m, 10), year: parseInt(y, 10) };
}
function monthYearToFromDate(month, year) {
    return `${year}-${String(month).padStart(2, '0')}-01`;
}
function monthYearToToDate(month, year) {
    const lastDay = new Date(year, month, 0).getDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDate(d) {
    if (!d) return '—';
    try { return format(new Date(d), 'dd MMM yyyy'); }
    catch { return d; }
}

function fmtINR(n) {
    if (n === null || n === undefined) return '—';
    const abs = Math.abs(n);
    let str;
    if (abs >= 1e7)      str = (n / 1e7).toFixed(2) + ' Cr';
    else if (abs >= 1e5) str = (n / 1e5).toFixed(2) + ' L';
    else                 str = abs.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    return `₹${n < 0 ? '-' : ''}${str}`;
}

function fmtFull(n) {
    if (n === null || n === undefined) return '—';
    return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// ─── Order-Cycle Overview sections (Page-1 spec: Volume / Cash / Funnel /
// Scenario Catalog / Package Status / Cash Action). Read-only summaries layered
// onto the Reconciliation Report; the "View Transaction Data" sheet is unchanged.
const OCV_VOLUME_CARDS = [
    { key: 'ordersPlaced',        label: 'Orders Placed',           calc: 'count of order lines in the Sales Order file (period / brand / channel filter)' },
    { key: 'cancelled',           label: 'Cancelled',               calc: 'reconciliation / delivery status = CANCELLED' },
    { key: 'dispatched',          label: 'Dispatched',              calc: 'dispatch date present / status in the Dispatch Scenarios list' },
    { key: 'delivered',           label: 'Delivered',               calc: 'courier status in the Delivered list (DELIVERED, DL-DELIVERED, …)' },
    { key: 'rtoLost',             label: 'RTO / Lost',              calc: 'status = RTO_*, LOST, LT-LOST, UNTRACEABLE' },
    { key: 'returnedPostDelivery', label: 'Returned (post-delivery)', calc: 'status = COURIER_RETURN-*, or matched in the SRN / Refunds file' },
];
const ocvCount = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN'));

// Uploaded files each overview table's numbers are derived from (shown behind a
// header "Sources" info toggle — secondary info, not the main content).
const OCV_SOURCES = {
    funnel: [
        'Sales Order Combined Report',
        'Export-Tally GST Report',
        'Delivery Partner status reports',
        'Return GST Report / SRN-Refunds',
    ],
    scenarios: [
        'Export-Tally GST Report',
        'Return GST Report / SRN-Refunds',
        'Courier settlement reports (Ekart / Delhivery / Xpressbees)',
        'Payment gateway reports (Snapmint / BharatX / Razorpay)',
    ],
    packageStatus: [
        'Sales Order Combined Report',
        'Delivery Partner status reports',
        'Return GST Report / SRN-Refunds',
    ],
    cashActions: [
        'Delivery Partner status reports',
        'Courier settlement reports (Ekart / Delhivery / Xpressbees)',
        'Payment gateway reports (Snapmint / BharatX / Razorpay)',
        'Return GST Report / SRN-Refunds',
    ],
};

function OcvVolumeStrip({ volume }) {
    if (!volume) return null;
    return (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100">
                <h3 className="text-sm font-bold text-slate-800">Order Cycle — Volume</h3>
                <p className="text-xs text-slate-400 mt-0.5">Where every order in the period ended up</p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 divide-x divide-y xl:divide-y-0 divide-slate-100">
                {OCV_VOLUME_CARDS.map(c => (
                    <div key={c.key} className="px-4 py-4">
                        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{c.label}</span>
                        <div className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{ocvCount(volume[c.key])}</div>
                        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">{c.calc}</p>
                    </div>
                ))}
            </div>
        </div>
    );
}

function OcvCashStrip({ cash }) {
    if (!cash) return null;
    const Card = ({ label, value, tone, calc }) => (
        <div className="flex-1 min-w-[180px] rounded-xl border border-slate-200 bg-white px-4 py-3.5">
            <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
            <div className={`mt-1 text-xl font-bold tabular-nums ${tone || 'text-slate-900'}`}>{fmtINR(value)}</div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">{calc}</p>
        </div>
    );
    return (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100">
                <h3 className="text-sm font-bold text-slate-800">Cash Cycle — Equation Strip</h3>
                <p className="text-xs text-slate-400 mt-0.5">How much of the period's net sales has actually landed</p>
            </div>
            <div className="p-4 space-y-3">
                <div className="flex flex-wrap items-stretch gap-2">
                    <Card label="Net Sales" value={cash.netSales} calc="SUM(Net Amount) across all invoiced lines in the period (Tally file)" />
                    <div className="flex items-center text-slate-300 font-bold text-lg px-1">−</div>
                    <Card label="Received" value={cash.received} tone="text-emerald-600" calc="SUM(settlement received): prepaid = same month as sale; COD = courier remittance file" />
                    <div className="flex items-center text-slate-300 font-bold text-lg px-1">=</div>
                    <Card label="Balance" value={cash.balance} tone="text-amber-600" calc="Net Sales − Received, for orders not yet returned" />
                </div>
                <div className="flex flex-wrap items-stretch gap-2">
                    <div className="flex-1 min-w-[220px] rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
                        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Advance Amount</span>
                        <div className="mt-1 text-lg font-bold text-slate-800 tabular-nums">{fmtINR(cash.advanceAmount)}</div>
                        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">PREPAID orders received but not yet dispatched (ADVANCE_ASOF)</p>
                    </div>
                    <div className="flex-1 min-w-[220px] rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
                        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Payable</span>
                        <div className="mt-1 text-lg font-bold text-slate-800 tabular-nums">{fmtINR(cash.payableAmount)}</div>
                        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">orders settled then returned — refund owed back to the customer (PAYABLE_ASOF)</p>
                    </div>
                </div>
            </div>
        </div>
    );
}

const ocvClickableCount = (value, filter, onDrill) => {
    const has = Number(value) > 0;
    return (
        <button
            type="button"
            disabled={!has}
            onClick={() => has && onDrill(filter)}
            className={`font-bold tabular-nums transition-colors ${
                has
                    ? 'text-indigo-600 hover:text-indigo-800 hover:underline decoration-dotted underline-offset-2 cursor-pointer'
                    : 'text-slate-300 cursor-default'}`}
            title={has ? 'View these orders' : undefined}
        >
            {ocvCount(value)}
        </button>
    );
};
const ocvPaymentPill = (pm) => (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide ${
        (pm || '').toUpperCase() === 'COD' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'}`}>
        {pm}
    </span>
);

// Shared "Amount" + "% share of amount" columns, appended to every overview
// table beside its order count(s). `amount` is the summed net amount of the
// row's orders; `pctAmount` its share (funnel → of orders placed; the other
// tables → of the table's own total).
const OCV_AMOUNT_COLUMNS = [
    { key: 'amount', label: 'Amount', align: 'right',
      render: r => <span className="font-semibold text-slate-700 tabular-nums">{fmtINR(r.amount)}</span> },
    { key: 'pctAmount', label: '% Share', align: 'right',
      render: r => <span className="text-slate-400 tabular-nums">{r.pctAmount == null ? '—' : `${Number(r.pctAmount).toFixed(1)}%`}</span> },
];

// Reference table with a per-row "how it's calculated" note, revealed by an info
// icon beside the row's name. The calc text lives on `row.calc`; `nameKey` marks
// which column carries the name the icon attaches to. `sources` (optional) lists
// the uploaded files the numbers are derived from — tucked behind a header info
// icon so it's available without being in the way.
function OcvRefTable({ title, subtitle, icon: Icon, columns, rows, nameKey, sources }) {
    const [openRow, setOpenRow] = useState(null);
    const [showSources, setShowSources] = useState(false);
    if (!rows || !rows.length) return null;
    return (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
            <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100">
                {Icon && (
                    <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-slate-100 text-slate-500 shrink-0">
                        <Icon className="w-4 h-4" />
                    </span>
                )}
                <div>
                    <h3 className="text-sm font-bold text-slate-800">{title}</h3>
                    {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
                </div>
                {sources && sources.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setShowSources(s => !s)}
                        aria-label="Data sources"
                        title="Data sources"
                        className={`ml-auto inline-flex items-center gap-1 shrink-0 text-[10px] font-semibold px-2 py-1 rounded-lg transition-colors ${
                            showSources ? 'bg-indigo-50 text-indigo-600' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}
                    >
                        <Info className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Sources</span>
                    </button>
                )}
            </div>
            {showSources && sources && sources.length > 0 && (
                <div className="px-5 py-3 bg-indigo-50/40 border-b border-slate-100">
                    <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Data sources</span>
                    <div className="flex flex-wrap gap-1.5">
                        {sources.map(s => (
                            <span key={s} className="inline-flex items-center text-[11px] text-slate-600 bg-white border border-slate-200 rounded-md px-2 py-0.5">{s}</span>
                        ))}
                    </div>
                </div>
            )}
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="bg-slate-50/80 border-b border-slate-200 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                            {columns.map(col => (
                                <th key={col.key} className={`px-4 py-3 whitespace-nowrap font-bold ${col.align === 'right' ? 'text-right' : 'text-left'}`}>{col.label}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r, i) => {
                            const isOpen = openRow === i;
                            return (
                                <React.Fragment key={i}>
                                    <tr className={`border-b border-slate-100 last:border-0 transition-colors ${isOpen ? 'bg-indigo-50/40' : 'hover:bg-slate-50/70'}`}>
                                        {columns.map(col => {
                                            let content;
                                            if (col.key === 'n') {
                                                content = (
                                                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-slate-100 text-[10px] font-bold text-slate-500">{r.n}</span>
                                                );
                                            } else if (col.render) {
                                                content = col.render(r);
                                            } else {
                                                content = <span className={col.strong ? 'font-semibold text-slate-800' : 'text-slate-600'}>{r[col.key]}</span>;
                                            }
                                            const isName = col.key === nameKey;
                                            return (
                                                <td key={col.key} className={`px-4 py-3 align-top ${col.align === 'right' ? 'text-right tabular-nums' : 'text-left'}`}>
                                                    {isName ? (
                                                        <span className="inline-flex items-center gap-1.5">
                                                            {content}
                                                            {r.calc && (
                                                                <button type="button" aria-label="How it's calculated"
                                                                    onClick={() => setOpenRow(isOpen ? null : i)}
                                                                    className={`inline-flex items-center justify-center w-4 h-4 rounded-full transition-colors ${isOpen ? 'bg-indigo-100 text-indigo-600' : 'text-slate-300 hover:text-slate-600 hover:bg-slate-100'}`}>
                                                                    <Info className="w-3 h-3" />
                                                                </button>
                                                            )}
                                                        </span>
                                                    ) : content}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                    {isOpen && r.calc && (
                                        <tr className="bg-indigo-50/40">
                                            <td colSpan={columns.length} className="px-4 pb-3 pt-0">
                                                <div className="flex items-start gap-2 rounded-lg bg-white border border-indigo-100 px-3 py-2">
                                                    <Info className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                                                    <div>
                                                        <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-400">How it's calculated</span>
                                                        <span className="text-[11px] leading-relaxed text-slate-600">{r.calc}</span>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function OcvSourceLegend() {
    const items = [
        { stage: 'Dispatch', src: 'Unicommerce' },
        { stage: 'Delivery', src: 'Delivery Partner Status Reports' },
        { stage: 'Settlement', src: 'Payment Gateway · Delivery Partner Settlement Reports' },
    ];
    return (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3.5 rounded-xl bg-white border border-slate-200 text-xs">
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Sources</span>
            {items.map((s, i) => (
                <span key={s.stage} className="flex items-center gap-2 text-slate-500">
                    {i > 0 && <span className="text-slate-300">→</span>}
                    <span className="font-semibold text-slate-700">{s.stage}</span>
                    <span className="text-slate-400">·</span>
                    <span>{s.src}</span>
                </span>
            ))}
        </div>
    );
}

// Drill modal — orders behind one clicked number in a Page-1 overview table.
function OcvDrillModal({ open, onClose, brandId, agentId, filename, fromDate, toDate, filter }) {
    const [rows, setRows] = useState([]);
    const [total, setTotal] = useState(0);
    const [totals, setTotals] = useState(null);
    const [totalPages, setTotalPages] = useState(1);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');

    useEffect(() => { setPage(1); setSearchInput(''); setSearch(''); }, [filter]);
    useEffect(() => {
        const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 350);
        return () => clearTimeout(t);
    }, [searchInput]);

    useEffect(() => {
        if (!open || !filter) return;
        let cancel = false;
        setLoading(true);
        const p = new URLSearchParams();
        Object.entries(filter).forEach(([k, v]) => { if (k !== 'title' && v != null && v !== '') p.set(k, v); });
        if (fromDate) p.set('fromDate', fromDate);
        if (toDate) p.set('toDate', toDate);
        p.set('page', page);
        p.set('pageSize', 50);
        if (search) p.set('search', search);
        api.get(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/files/${encodeURIComponent(filename)}/overview-transactions?${p}`)
            .then(r => {
                if (cancel) return;
                setRows(r.data.rows || []);
                setTotal(r.data.total || 0);
                setTotals(r.data.totals || null);
                setTotalPages(r.data.totalPages || 1);
            })
            .catch(() => { if (!cancel) { setRows([]); setTotal(0); setTotals(null); setTotalPages(1); } })
            .finally(() => { if (!cancel) setLoading(false); });
        return () => { cancel = true; };
    }, [open, filter, fromDate, toDate, page, search, brandId, agentId, filename]);

    if (!open) return null;

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent onClose={onClose} className="max-w-[92vw] w-[92vw] max-h-[90vh] flex flex-col gap-0 overflow-hidden p-0">
                <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-100 shrink-0">
                    <div className="min-w-0">
                        <h3 className="text-base font-bold text-slate-900 truncate">{filter?.title || 'Orders'}</h3>
                        <p className="text-xs text-slate-400 mt-0.5">{total.toLocaleString('en-IN')} order{total === 1 ? '' : 's'}</p>
                    </div>
                    <input
                        value={searchInput}
                        onChange={e => setSearchInput(e.target.value)}
                        placeholder="Order ID, invoice, AWB…"
                        className="mr-8 shrink-0 text-xs px-3 py-1.5 border border-slate-200 rounded-lg bg-slate-50 w-52 focus:outline-none focus:border-slate-400"
                    />
                </div>
                <div className="flex-1 min-h-0 overflow-auto bg-slate-50">
                    {loading ? (
                        <div className="flex items-center justify-center py-24 gap-3 text-slate-400 text-sm">
                            <Loader2 className="h-5 w-5 animate-spin" /> Loading…
                        </div>
                    ) : rows.length === 0 ? (
                        <div className="py-24 text-center text-sm text-slate-400">No orders</div>
                    ) : (
                        <table className="w-full text-xs bg-white">
                            <thead className="sticky top-0 z-10">
                                <tr className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                    <th className="px-3 py-2.5 text-left">Order ID</th>
                                    <th className="px-3 py-2.5 text-left">Invoice</th>
                                    <th className="px-3 py-2.5 text-left">Channel</th>
                                    <th className="px-3 py-2.5 text-left">Payment</th>
                                    <th className="px-3 py-2.5 text-left">Courier</th>
                                    <th className="px-3 py-2.5 text-right">Gross</th>
                                    <th className="px-3 py-2.5 text-right">Return</th>
                                    <th className="px-3 py-2.5 text-right">Net</th>
                                    <th className="px-3 py-2.5 text-right">Settled</th>
                                    <th className="px-3 py-2.5 text-right">Balance</th>
                                    <th className="px-3 py-2.5 text-left">Dispatch</th>
                                    <th className="px-3 py-2.5 text-left">Delivery</th>
                                    <th className="px-3 py-2.5 text-left">Reco</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {rows.map((r, i) => {
                                    const bal = Number(r.balance_amount_receivable) || 0;
                                    return (
                                        <tr key={r.id || r.sale_order_number || i} className="hover:bg-slate-50/60">
                                            <td className="px-3 py-2 font-semibold text-slate-800 whitespace-nowrap">{r.sale_order_number || '—'}</td>
                                            <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.invoice_number || '—'}</td>
                                            <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.platform || '—'}</td>
                                            <td className="px-3 py-2">{ocvPaymentPill(r.payment_method)}</td>
                                            <td className="px-3 py-2 text-slate-500 whitespace-nowrap capitalize">{(r.courier_group || r.shipping_partner || '—')}</td>
                                            <td className="px-3 py-2 text-right tabular-nums">{fmtFull(r.total_amount)}</td>
                                            <td className="px-3 py-2 text-right tabular-nums text-slate-500">{Number(r.return_amount) ? fmtFull(r.return_amount) : '—'}</td>
                                            <td className="px-3 py-2 text-right tabular-nums">{fmtFull(r.net_amount)}</td>
                                            <td className="px-3 py-2 text-right tabular-nums text-slate-600">{Number(r.total_settlement_received) ? fmtFull(r.total_settlement_received) : '—'}</td>
                                            <td className="px-3 py-2 text-right tabular-nums">
                                                <span className={bal === 0 ? 'text-emerald-600' : bal > 0 ? 'text-amber-600' : 'text-purple-600'}>{fmtFull(bal)}</span>
                                            </td>
                                            <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{formatDate(r.dispatch_or_cancellation_date)}</td>
                                            <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.delivery_status || '—'}</td>
                                            <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.reconciliation_status || '—'}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                            {totals && (
                                <tfoot className="sticky bottom-0 z-10">
                                    <tr className="bg-slate-800 text-white border-t-2 border-slate-900 shadow-[0_-4px_12px_rgba(15,23,42,0.15)]">
                                        <td className="px-3 py-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-300" colSpan={5}>
                                            <span className="inline-flex items-center gap-1.5">
                                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                                Totals · {total.toLocaleString('en-IN')} order{total === 1 ? '' : 's'}
                                            </span>
                                        </td>
                                        <td className="px-3 py-3 text-right tabular-nums text-sm font-bold">{fmtFull(totals.gross)}</td>
                                        <td className="px-3 py-3 text-right tabular-nums text-sm font-bold text-slate-300">{fmtFull(totals.ret)}</td>
                                        <td className="px-3 py-3 text-right tabular-nums text-sm font-bold">{fmtFull(totals.net)}</td>
                                        <td className="px-3 py-3 text-right tabular-nums text-sm font-bold text-slate-200">{fmtFull(totals.settled)}</td>
                                        <td className="px-3 py-3 text-right tabular-nums text-sm font-extrabold">
                                            <span className={totals.balance === 0 ? 'text-emerald-400' : totals.balance > 0 ? 'text-amber-300' : 'text-purple-300'}>{fmtFull(totals.balance)}</span>
                                        </td>
                                        <td colSpan={3} className="bg-slate-800" />
                                    </tr>
                                </tfoot>
                            )}
                        </table>
                    )}
                </div>
                {totalPages > 1 && (
                    <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 shrink-0 bg-white">
                        <span className="text-xs text-slate-400">
                            {((page - 1) * 50 + 1).toLocaleString()}–{Math.min(page * 50, total).toLocaleString()} of {total.toLocaleString()}
                        </span>
                        <div className="flex items-center gap-1">
                            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
                                className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50">← Prev</button>
                            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
                                className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50">Next →</button>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

const initModal = () => ({
    open: false,
    step: STEP_SELECT,
    month: MONTHS[new Date().getMonth()],
    year: String(currentYear),
    selectedGateways:  [],
    selectedLogistics: [],
    unicommerceFile: null,
    returnGSTFile: null,
    salesOrderReportFile: null,
    gatewayFiles:  {},
    logisticsFiles: {},
});

// ─── SVG Donut Chart ──────────────────────────────────────────────────────────
function DonutChart({ pct, size = 100, stroke = 10, color = '#10b981', label, sublabel }) {
    const r    = (size - stroke) / 2;
    const circ = 2 * Math.PI * r;
    const dash = Math.min(pct, 100) / 100 * circ;
    return (
        <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <circle cx={size/2} cy={size/2} r={r}
                    fill="none" stroke="#e2e8f0" strokeWidth={stroke} />
                <circle cx={size/2} cy={size/2} r={r}
                    fill="none" stroke={color} strokeWidth={stroke}
                    strokeDasharray={`${dash} ${circ}`}
                    strokeLinecap="round"
                    transform={`rotate(-90 ${size/2} ${size/2})`} />
            </svg>
            {label && (
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="font-bold text-slate-900 leading-none" style={{ fontSize: size * 0.15 }}>
                        {label}
                    </span>
                    {sublabel && (
                        <span className="text-slate-400 leading-none mt-0.5" style={{ fontSize: size * 0.09 }}>
                            {sublabel}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Drag-drop file zone ──────────────────────────────────────────────────────
function FileDropZone({ id, label, icon: Icon, accept, value, onChange, color = '#64748b' }) {
    const inputRef = useRef();
    const [dragging, setDragging] = useState(false);
    const handleDrop = (e) => {
        e.preventDefault(); setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onChange(file);
    };
    return (
        <div
            onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed cursor-pointer transition-all select-none py-5 px-4
                ${dragging ? 'border-emerald-400 bg-emerald-50' : value ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-200 bg-slate-50 hover:border-slate-300 hover:bg-white'}`}
        >
            <input ref={inputRef} id={id} type="file" accept={accept} className="hidden"
                onChange={e => onChange(e.target.files?.[0] || null)} />
            {value ? (
                <>
                    <CheckCircle2 className="h-7 w-7 text-emerald-500" />
                    <div className="text-center">
                        <p className="text-sm font-semibold text-emerald-700 truncate max-w-[180px]">{value.name}</p>
                        <p className="text-xs text-slate-500 mt-0.5">Click to replace</p>
                    </div>
                </>
            ) : (
                <>
                    <div className="w-10 h-10 rounded-full flex items-center justify-center bg-white border border-slate-200 shadow-sm">
                        <Icon className="h-5 w-5" style={{ color }} />
                    </div>
                    <div className="text-center">
                        <p className="text-sm font-semibold text-slate-700">{label}</p>
                        <p className="text-xs text-slate-400 mt-0.5">Drop or click · xlsx / csv</p>
                    </div>
                </>
            )}
        </div>
    );
}

// ─── Provider Segment Donut (multi-color) ─────────────────────────────────────
function SegmentDonut({ segments, size = 160, stroke = 18 }) {
    const r    = (size - stroke) / 2;
    const circ = 2 * Math.PI * r;
    const total = segments.reduce((s, sg) => s + sg.value, 0);
    let offset = 0;
    const slices = segments.map(sg => {
        const len = total > 0 ? (sg.value / total) * circ : 0;
        const slice = { ...sg, dash: len, offset };
        offset += len + 1;
        return slice;
    });
    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#f1f5f9" strokeWidth={stroke} />
            {slices.map((sl, i) => (
                <circle key={i}
                    cx={size/2} cy={size/2} r={r} fill="none"
                    stroke={sl.color} strokeWidth={stroke}
                    strokeDasharray={`${sl.dash} ${circ}`}
                    strokeDashoffset={-sl.offset}
                    strokeLinecap="butt"
                    transform={`rotate(-90 ${size/2} ${size/2})`}
                />
            ))}
        </svg>
    );
}

// ─── Transaction Sheet helpers ────────────────────────────────────────────────
function kvRow(k, v) {
    return (
        <div key={k} className="flex justify-between items-start gap-2 py-1 border-b border-slate-50 last:border-0">
            <span className="text-[10px] text-slate-400 shrink-0 leading-relaxed">{k}</span>
            <span className="text-[11px] text-right text-slate-700 leading-relaxed">{v != null && v !== '' ? v : '—'}</span>
        </div>
    );
}

function TxDrillRow({ row }) {
    const toNum = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
    const ekAmt  = toNum(row.ekart_cod_amount);
    const delAmt = toNum(row.delhivery_cod_amount);
    const xpAmt  = toNum(row.xpressbees_net_payment);
    const snAmt  = toNum(row.snapmint_settlement_value);
    const bhAmt  = toNum(row.bharatx_ledger_amount);
    const rzAmt  = toNum(row.razorpay_settlement_amount);
    const totalSettled = toNum(row.total_settlement_received);
    const bal = toNum(row.balance_amount_receivable);
    const sc = row.scenario || {};
    const courierName = ekAmt > 0 ? 'Ekart' : delAmt > 0 ? 'Delhivery' : xpAmt > 0 ? 'Xpressbees' : 'Courier';
    const gatewayName = snAmt !== 0 ? 'Snapmint' : bhAmt !== 0 ? 'BharatX' : rzAmt !== 0 ? 'Razorpay' : (sc.settledSource || 'Gateway');
    const srcSection = (dot, label, file, children) => (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-slate-100" style={{ background: `${dot}12` }}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
                <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: dot }}>{label}</span>
                <span className="text-[9px] text-slate-400 ml-auto truncate">{file}</span>
            </div>
            <div className="px-3 py-2">{children}</div>
        </div>
    );
    return (
        <tr>
            <td colSpan={10} className="p-0">
                <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-4">
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
                        {srcSection('#2a78d6', 'Tally GST', 'Export-Tally GST Report', <>
                            {kvRow('Invoice No.', row.invoice_number)}
                            {kvRow('Channel', row.platform)}
                            {kvRow('AWB No.', row.awb_number)}
                            {kvRow('Dispatch Date', formatDate(row.dispatch_or_cancellation_date))}
                            {kvRow('Amount', fmtFull(row.total_amount))}
                        </>)}
                        {srcSection('#b45309', 'Return GST', 'Return GST Report', <>
                            {kvRow('Return Date', formatDate(row.return_date))}
                            {kvRow('SRN', row.srn)}
                            {kvRow('SRN Status', sc.srnStatus || '—')}
                            {kvRow('Return Amount', fmtFull(row.return_amount))}
                            {kvRow('Net Amount', `${fmtFull(row.total_amount)} − ${fmtFull(row.return_amount)} = ${fmtFull(row.net_amount)}`)}
                            {kvRow('Refund Due', sc.refundDue > 0 ? fmtFull(sc.refundDue) : '—')}
                        </>)}
                        {srcSection('#1baf7a', courierName, `${courierName} settlement report`, <>
                            {kvRow('Join Key (AWB)', row.awb_number)}
                            {ekAmt > 0 && <>{kvRow('Remittance Date', formatDate(row.ekart_remittance_date))}{kvRow('Actual Date', formatDate(row.ekart_actual_remittance_date))}{kvRow('COD Amount', fmtFull(ekAmt))}</>}
                            {delAmt > 0 && <>{kvRow('Delivery Date', formatDate(row.delhivery_delivery_date))}{kvRow('COD Amount', fmtFull(delAmt))}</>}
                            {xpAmt > 0 && <>{kvRow('Delivery Date', formatDate(row.xpressbees_delivery_date))}{kvRow('Txn Date', formatDate(row.xpressbees_transaction_date))}{kvRow('Net Payment', fmtFull(xpAmt))}</>}
                            {ekAmt === 0 && delAmt === 0 && xpAmt === 0 && kvRow('Amount', '— No record found')}
                            {kvRow('Who Has Product', sc.holder || '—')}
                        </>)}
                        {srcSection('#7c3aed', gatewayName, `${gatewayName} settlement report`, <>
                            {kvRow('Payment', sc.paymentMethod || '—')}
                            {snAmt !== 0 && <>{kvRow('Join Key (Order No.)', row.sale_order_number)}{kvRow('Settlement Date', formatDate(row.snapmint_settlement_date))}{kvRow('Settlement Value', fmtFull(snAmt))}</>}
                            {bhAmt !== 0 && <>{kvRow('Join Key (Order ID)', row.sale_order_number)}{kvRow('Settlement Date', formatDate(row.bharatx_settlement_timestamp))}{kvRow('Ledger Amount', fmtFull(bhAmt))}</>}
                            {rzAmt !== 0 && <>{kvRow('receipt → SO', row.sale_order_number)}{kvRow('Settlement Date', formatDate(row.razorpay_settlement_date))}{kvRow('Amount', fmtFull(rzAmt))}</>}
                            {snAmt === 0 && bhAmt === 0 && rzAmt === 0 && sc.settledSource && <>{kvRow('Reconciled Gateway', sc.settledSource)}{kvRow('Reconciled Amount', fmtFull(sc.settledAmount))}</>}
                            {snAmt === 0 && bhAmt === 0 && rzAmt === 0 && !sc.settledSource && kvRow('Settlement', '— No record found')}
                        </>)}
                    </div>
                    <div className="flex flex-wrap gap-4 items-center bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-xs">
                        <div><span className="text-slate-400">Net Order Value: </span><span className="font-semibold">{fmtFull(row.net_amount)}</span></div>
                        <div className="text-slate-200">·</div>
                        <div><span className="text-slate-400">Total Settlement: </span><span className="font-semibold">{totalSettled !== 0 ? fmtFull(totalSettled) : '—'}</span></div>
                        <div className="text-slate-200">·</div>
                        <div>
                            <span className="text-slate-400">Balance: </span>
                            <span className={`font-bold ${bal === 0 ? 'text-emerald-600' : bal > 0 ? 'text-amber-600' : 'text-purple-600'}`}>{fmtFull(bal)}</span>
                        </div>
                        <div className="ml-auto text-[10px] italic text-slate-400">
                            {fmtFull(row.net_amount)} (net) − {fmtFull(totalSettled)} (settled) = {fmtFull(bal)}
                        </div>
                    </div>
                </div>
            </td>
        </tr>
    );
}

function TransactionSheet({ brandId, agentId, filename, reconciliation, fromDate, toDate }) {
    const [txTab, setTxTab]         = useState('all');
    const [mismatchSub, setMismatchSub] = useState('less');
    const [matchedSub, setMatchedSub]   = useState('all');
    const [expandedId, setExpandedId]   = useState(null);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch]       = useState('');
    const [page, setPage]           = useState(1);
    const [rows, setRows]           = useState([]);
    const [total, setTotal]         = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [loading, setLoading]     = useState(true);
    const [pageLoading, setPageLoading] = useState(false);
    const [downloading, setDownloading] = useState(false);

    // Debounce search input → trigger fetch
    useEffect(() => {
        const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 400);
        return () => clearTimeout(t);
    }, [searchInput]);

    // Fetch page whenever tab / sub / page / search changes
    useEffect(() => {
        let cancelled = false;
        const isFirstLoad = page === 1 && rows.length === 0;
        if (isFirstLoad) setLoading(true); else setPageLoading(true);

        const sub = txTab === 'matched' ? matchedSub : mismatchSub;
        const params = new URLSearchParams({ tab: txTab, sub, page, pageSize: 50 });
        if (search) params.set('search', search);
        if (fromDate) params.set('fromDate', fromDate);
        if (toDate) params.set('toDate', toDate);

        api.get(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/files/${encodeURIComponent(filename)}/transactions?${params}`)
            .then(r => {
                if (cancelled) return;
                setRows(r.data.rows);
                setTotal(r.data.total);
                setTotalPages(r.data.totalPages);
                setExpandedId(null);
            })
            .catch(() => { if (!cancelled) setRows([]); })
            .finally(() => { if (!cancelled) { setLoading(false); setPageLoading(false); } });

        return () => { cancelled = true; };
    }, [txTab, mismatchSub, matchedSub, page, search, brandId, agentId, filename, fromDate, toDate]);

    const toNum = v => { const n = Number(v); return isNaN(n) ? 0 : n; };

    // Tab counts from parent reconciliation (already loaded, no extra fetch).
    // rc.unsettled is the backend's own count of rows never returned AND never
    // settled by any courier/gateway (plus RTO/cancelled) — same definition the
    // /transactions?tab=unsettled query itself uses, so these stay in lockstep.
    const rc = reconciliation || {};
    const unsettledCount = rc.unsettled || 0;
    const tabs = [
        { key: 'matched',    label: 'Matched',     count: rc.reconciled },
        { key: 'mismatched', label: 'Mismatched',  count: (rc.pending || 0) + (rc.overpaid || 0) + (rc.advance || 0) },
        { key: 'unsettled',  label: 'Unsettled',   count: unsettledCount },
        { key: 'all',        label: 'All Orders',  count: rc.total },
    ];

    function switchTab(key) { setTxTab(key); setPage(1); setExpandedId(null); setRows([]); setLoading(true); }
    function switchSub(key) { setMismatchSub(key); setPage(1); setExpandedId(null); setRows([]); setLoading(true); }
    function switchMatchedSub(key) { setMatchedSub(key); setPage(1); setExpandedId(null); setRows([]); setLoading(true); }

    async function handleDownloadSheet() {
        setDownloading(true);
        try {
            const params = new URLSearchParams();
            if (search) params.set('search', search);
            if (fromDate) params.set('fromDate', fromDate);
            if (toDate) params.set('toDate', toDate);
            const res = await api.get(
                `/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/files/${encodeURIComponent(filename)}/transactions/download?${params}`,
                { responseType: 'blob' }
            );
            const cd = res.headers?.['content-disposition'] || '';
            const match = cd.match(/filename="([^"]+)"/);
            const outName = match ? match[1] : `${filename.replace(/\.[^.]+$/, '')}_transaction_sheet.xlsx`;
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const a = document.createElement('a'); a.href = url;
            a.setAttribute('download', outName); document.body.appendChild(a); a.click(); a.remove();
            window.URL.revokeObjectURL(url);
            toast.success('Transaction sheet downloaded');
        } catch {
            toast.error('Failed to download transaction sheet');
        } finally {
            setDownloading(false);
        }
    }

    function statusBadge(row) {
        const s = (row.reconciliation_status || '').toUpperCase().trim();
        const ds = (row.delivery_status || '').toUpperCase();
        if (s === 'RECONCILED')         return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-50 text-emerald-700">RECONCILED</span>;
        if (s === 'PENDING RECEIVABLE') return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-50 text-amber-700">PENDING</span>;
        if (s.startsWith('OVERPAID'))   return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-purple-50 text-purple-700">OVERPAID</span>;
        if (s === 'ADVANCE')            return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-indigo-50 text-indigo-700">PAYABLE</span>;
        if (ds === 'RTO')               return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-red-50 text-red-700">RTO</span>;
        if (ds === 'CANCELLED')         return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-slate-100 text-slate-500">CANCELLED</span>;
        return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-slate-100 text-slate-400">UNSETTLED</span>;
    }

    function diffBadge(row) {
        const bal = toNum(row.balance_amount_receivable);
        if (bal === 0) return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-50 text-emerald-700">₹0</span>;
        if (bal > 0)   return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-50 text-amber-700">−{fmtINR(bal)}</span>;
        return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-purple-50 text-purple-700">+{fmtINR(Math.abs(bal))}</span>;
    }

    function settlementDateOf(row) {
        return row.snapmint_settlement_date || row.bharatx_settlement_timestamp || row.razorpay_settlement_date;
    }

    return (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                    <h3 className="text-sm font-bold text-slate-800">Transaction Sheet</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Click any row to see source file attribution for each value</p>
                </div>
                <div className="flex items-center gap-2">
                    <input
                        className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg bg-slate-50 text-slate-700 placeholder-slate-400 focus:outline-none focus:border-slate-400 w-52"
                        type="text"
                        placeholder="Search order ID, invoice…"
                        value={searchInput}
                        onChange={e => setSearchInput(e.target.value)}
                    />
                    <button
                        onClick={handleDownloadSheet}
                        disabled={downloading}
                        title="Download the full Transaction Sheet as Excel (Matched, Mismatched, Advance, Unsettled, All Orders & Sales Report sheets)"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                        {downloading
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Download className="h-3.5 w-3.5" />}
                        {downloading ? 'Preparing…' : 'Download Sheet'}
                    </button>
                </div>
            </div>

            {/* Unsettled callout */}
            {unsettledCount > 0 && (
                <div className="mx-5 mt-3 mb-1 flex items-center gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg">
                    <AlertCircle className="h-4 w-4 text-slate-400 shrink-0" />
                    <p className="text-xs text-slate-600">
                        <span className="font-bold text-slate-800">{unsettledCount.toLocaleString()} orders</span> are Unsettled —
                        never returned and never received any settlement from a courier or payment gateway.
                    </p>
                </div>
            )}

            {/* Tabs */}
            <div className="flex gap-0 border-b border-slate-100">
                {tabs.map(t => (
                    <button key={t.key} onClick={() => switchTab(t.key)}
                        className={`px-4 py-2.5 text-xs font-semibold transition-colors whitespace-nowrap border-b-2 -mb-px
                            ${txTab === t.key ? 'border-emerald-500 text-emerald-700' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
                        {t.label}
                        {t.count != null && (
                            <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${txTab === t.key ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
                                {t.count.toLocaleString()}
                            </span>
                        )}
                    </button>
                ))}
            </div>

            {/* Matched sub-toggle — split the Matched population by whether a
                return was also matched against it (still fully reconciled either
                way; this just says whether that reconciliation happened before
                or after a return came back). */}
            {txTab === 'matched' && (
                <div className="px-5 pt-3 flex justify-between gap-2">
                    <div className="flex gap-2">
                        {[
                            { key: 'all', label: 'All Matched', cls: 'bg-emerald-50 border-emerald-300 text-emerald-700' },
                        ].map(({ key, label, cls }) => (
                            <button key={key} onClick={() => switchMatchedSub(key)}
                                className={`px-3 py-1.5 text-xs rounded-lg border font-semibold transition-colors
                                    ${matchedSub === key ? cls : 'bg-white border-slate-200 text-slate-500'}`}>
                                {label}
                            </button>
                        ))}
                    </div>
                    <div className="flex gap-2">
                        {[
                            { key: 'return',     label: 'Matched Returned',     cls: 'bg-rose-50 border-rose-300 text-rose-700' },
                            { key: 'notreturn',  label: 'Matched Not Returned', cls: 'bg-sky-50 border-sky-300 text-sky-700' },
                        ].map(({ key, label, cls }) => (
                            <button key={key} onClick={() => switchMatchedSub(key)}
                                className={`px-3 py-1.5 text-xs rounded-lg border font-semibold transition-colors
                                    ${matchedSub === key ? cls : 'bg-white border-slate-200 text-slate-500'}`}>
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Mismatched sub-toggle — Less/More Received on the left, the
                return-matching pair + Payable on the right. */}
            {txTab === 'mismatched' && (
                <div className="px-5 pt-3 flex justify-between gap-2">
                    <div className="flex gap-2">
                        {[
                            { key: 'less', label: 'Less Received', cls: 'bg-amber-50 border-amber-300 text-amber-700' },
                            { key: 'more', label: 'More Received', cls: 'bg-purple-50 border-purple-300 text-purple-700' },
                        ].map(({ key, label, cls }) => (
                            <button key={key} onClick={() => switchSub(key)}
                                className={`px-3 py-1.5 text-xs rounded-lg border font-semibold transition-colors
                                    ${mismatchSub === key ? cls : 'bg-white border-slate-200 text-slate-500'}`}>
                                {label}
                            </button>
                        ))}
                    </div>
                    <div className="flex gap-2">
                        {[
                            { key: 'return',    label: 'MismatchedReturn',    cls: 'bg-rose-50 border-rose-300 text-rose-700' },
                            { key: 'notreturn', label: 'MismatchedNotReturn', cls: 'bg-sky-50 border-sky-300 text-sky-700' },
                            { key: 'advance',   label: 'Payable',             cls: 'bg-indigo-50 border-indigo-300 text-indigo-700' },
                        ].map(({ key, label, cls }) => (
                            <button key={key} onClick={() => switchSub(key)}
                                className={`px-3 py-1.5 text-xs rounded-lg border font-semibold transition-colors
                                    ${mismatchSub === key ? cls : 'bg-white border-slate-200 text-slate-500'}`}>
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Table body */}
            {loading ? (
                <div className="flex items-center justify-center py-16 gap-3 text-slate-400 text-sm">
                    <Loader2 className="h-5 w-5 animate-spin" /> Loading transactions…
                </div>
            ) : (
                <div className={`overflow-x-auto relative transition-opacity ${pageLoading ? 'opacity-50 pointer-events-none' : ''}`}>
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="bg-slate-50 border-b border-slate-200">
                                <th className="w-8 px-3 py-2.5" />
                                <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Order ID</th>
                                <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Invoice No.</th>
                                <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Order Value</th>
                                <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Settlement</th>
                                <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Diff</th>
                                <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Order Date</th>
                                <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Settlement Date</th>
                                <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Status</th>
                                <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Courier</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.length === 0 ? (
                                <tr><td colSpan={10} className="text-center text-slate-400 py-10 text-xs">No records found</td></tr>
                            ) : rows.map(row => {
                                const rowId = row.id || row.sale_order_number;
                                const isExp = expandedId === rowId;
                                const totalSettled = toNum(row.total_settlement_received);
                                const sc = row.scenario || {};
                                return (
                                    <React.Fragment key={rowId}>
                                        <tr
                                            className={`border-b border-slate-100 cursor-pointer transition-colors ${isExp ? 'bg-emerald-50/30' : 'hover:bg-slate-50/50'}`}
                                            onClick={() => setExpandedId(isExp ? null : rowId)}
                                        >
                                            <td className="px-3 py-2.5">
                                                <ChevronRight className={`h-3.5 w-3.5 text-slate-400 transition-transform ${isExp ? 'rotate-90' : ''}`} />
                                            </td>
                                            <td className="px-3 py-2.5 font-semibold text-slate-800 whitespace-nowrap">{row.sale_order_number || '—'}</td>
                                            <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{row.invoice_number || '—'}</td>
                                            <td className="px-3 py-2.5 text-right font-medium tabular-nums whitespace-nowrap">{fmtFull(row.total_amount)}</td>
                                            <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap">{totalSettled > 0 ? fmtFull(totalSettled) : '—'}</td>
                                            <td className="px-3 py-2.5 text-right whitespace-nowrap">{diffBadge(row)}</td>
                                            <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{formatDate(row.dispatch_or_cancellation_date)}</td>
                                            <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{formatDate(settlementDateOf(row))}</td>
                                            <td className="px-3 py-2.5 whitespace-nowrap">{statusBadge(row)}</td>
                                            {/* Reconciled against receivable_ledger (sc.courier), falling back to shopify_order_cycle's own column. Gateway/Scenario/Who-Has-Product/SRN/Payment/Refund Due moved into the row drill-down (TxDrillRow) below. */}
                                            <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap capitalize">{(sc.courier || row.shipping_partner || '—').toLowerCase()}</td>
                                        </tr>
                                        {isExp && <TxDrillRow row={row} />}
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>

                    {/* Pagination */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100">
                            <span className="text-xs text-slate-400">
                                {((page - 1) * 50 + 1).toLocaleString()}–{Math.min(page * 50, total).toLocaleString()} of {total.toLocaleString()} orders
                            </span>
                            <div className="flex items-center gap-1">
                                <button
                                    disabled={page <= 1}
                                    onClick={() => setPage(p => p - 1)}
                                    className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors"
                                >
                                    ← Prev
                                </button>
                                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                                    const start = Math.max(1, Math.min(page - 2, totalPages - 4));
                                    const p = start + i;
                                    return (
                                        <button key={p} onClick={() => setPage(p)}
                                            className={`w-8 h-7 text-xs rounded-lg border transition-colors
                                                ${p === page ? 'bg-emerald-500 border-emerald-500 text-white font-bold' : 'border-slate-200 hover:bg-slate-50 text-slate-600'}`}>
                                            {p}
                                        </button>
                                    );
                                })}
                                <button
                                    disabled={page >= totalPages}
                                    onClick={() => setPage(p => p + 1)}
                                    className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors"
                                >
                                    Next →
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Reconciliation Visualization Panel ───────────────────────────────────────
function ReconciliationView({ file, brandId, agentId, onBack, onDownload }) {
    const navigate = useNavigate();
    const [data, setData]       = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [tab, setTab]         = useState('settled');   // 'settled' | 'unsettled'
    const [showTxSheet, setShowTxSheet] = useState(false);
    const [ocvDrill, setOcvDrill] = useState(null);   // { title, ...queryParams } for the overview drill modal

    // The upload is tagged with one month, but the underlying orders' own dates
    // routinely span a wider window (settlement/processing lag) — availableRange
    // is that real span, computed server-side from every row in this file, and
    // stays constant across narrowing (it always reflects the FULL file, not the
    // current selection). `range` is the committed narrowing (null = full range),
    // still exact ISO from/to dates for the API. draftFromMonth/Year and
    // draftToMonth/Year are what the Month/Year selects show/edit — nothing
    // refetches until Search is clicked, same picker pattern as the Receivable
    // Dashboard (draft vs. committed, Search button, disabled until dirty).
    // Session-shared range (persists across navigation + the Analytics Portal).
    const savedRangeRef = useRef();
    if (savedRangeRef.current === undefined) savedRangeRef.current = loadOcDateRange(brandId, agentId);
    const savedInit = savedRangeRef.current
        ? { f: isoToMonthYear(savedRangeRef.current.from), t: isoToMonthYear(savedRangeRef.current.to) }
        : null;

    const [availableRange, setAvailableRange] = useState(null);
    const [range, setRange] = useState(savedRangeRef.current);
    const [draftFromMonth, setDraftFromMonth] = useState(savedInit ? savedInit.f.month : null);
    const [draftFromYear, setDraftFromYear] = useState(savedInit ? savedInit.f.year : null);
    const [draftToMonth, setDraftToMonth] = useState(savedInit ? savedInit.t.month : null);
    const [draftToYear, setDraftToYear] = useState(savedInit ? savedInit.t.year : null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setLoadError(null);
        const params = new URLSearchParams();
        if (range?.from) params.set('fromDate', range.from);
        if (range?.to) params.set('toDate', range.to);
        const qs = params.toString();
        api.get(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/files/${encodeURIComponent(file.filename)}/report${qs ? `?${qs}` : ''}`)
            .then(r => {
                if (cancelled) return;
                setData(r.data);
                if (r.data?.availableRange?.from && !availableRange) {
                    setAvailableRange(r.data.availableRange);
                    // only default the picker to the full span when nothing is saved/narrowed
                    if (!savedRangeRef.current) {
                        const from = isoToMonthYear(r.data.availableRange.from);
                        const to = isoToMonthYear(r.data.availableRange.to);
                        setDraftFromMonth(from.month); setDraftFromYear(from.year);
                        setDraftToMonth(to.month); setDraftToYear(to.year);
                    }
                }
                setLoading(false);
            })
            .catch(err => {
                if (cancelled) return;
                // Narrowed to an empty sub-range still comes back with availableRange
                // (see getReportData) — keep the picker usable so the user can widen it.
                const ar = err.response?.data?.availableRange;
                if (ar?.from && !availableRange) { setAvailableRange(ar); }
                setData(null);
                setLoadError(err.response?.data?.error || 'Failed to load report data');
                setLoading(false);
            });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file.filename, brandId, agentId, range]);

    const committedFrom = range ? isoToMonthYear(range.from) : (availableRange ? isoToMonthYear(availableRange.from) : null);
    const committedTo = range ? isoToMonthYear(range.to) : (availableRange ? isoToMonthYear(availableRange.to) : null);
    const isDirty = !!availableRange && (
        draftFromMonth !== committedFrom.month || draftFromYear !== committedFrom.year
        || draftToMonth !== committedTo.month || draftToYear !== committedTo.year
    );
    const rangeInvalid = !!(draftFromYear && draftToYear
        && (draftFromYear * 12 + draftFromMonth) > (draftToYear * 12 + draftToMonth));
    const applyRange = () => {
        if (rangeInvalid) return;
        const next = {
            from: monthYearToFromDate(draftFromMonth, draftFromYear),
            to: monthYearToToDate(draftToMonth, draftToYear),
        };
        setRange(next);
        savedRangeRef.current = next;
        saveOcDateRange(brandId, agentId, next);
    };
    const resetRange = () => {
        setRange(null);
        savedRangeRef.current = null;
        saveOcDateRange(brandId, agentId, null);
        if (availableRange) {
            const from = isoToMonthYear(availableRange.from);
            const to = isoToMonthYear(availableRange.to);
            setDraftFromMonth(from.month); setDraftFromYear(from.year);
            setDraftToMonth(to.month); setDraftToYear(to.year);
        }
    };
    const isNarrowed = !!range && availableRange && (range.from !== availableRange.from || range.to !== availableRange.to);

    // Same picker span as the Receivable Dashboard's own "As of" year list —
    // clamped to years the file's data actually spans.
    const rangeYears = availableRange
        ? (() => {
            const lo = isoToMonthYear(availableRange.from).year;
            const hi = isoToMonthYear(availableRange.to).year;
            const ys = [];
            for (let y = lo; y <= hi; y++) ys.push(y);
            return ys.sort((a, b) => b - a);
        })()
        : [];

    // Same look & pattern as the Receivable Dashboard's range picker: a tinted
    // rounded-2xl bar, icon+label+subtitle field groups separated by a divider,
    // and a "Search" button that stays disabled until the draft actually differs
    // from what's applied — nothing refetches until it's clicked.
    const DateRangeBar = availableRange && (
        <div
            className="flex items-center justify-between flex-wrap gap-4 px-5 py-4 rounded-2xl"
            style={{ background: '#4F46E508', border: '1px solid #4F46E525' }}
        >
            <div className="flex items-center flex-wrap gap-x-6 gap-y-3">
                <div className="flex items-center gap-2.5">
                    <Calendar className="w-4 h-4 flex-shrink-0" style={{ color: '#4F46E5' }} />
                    <div>
                        <p className="text-xs font-bold whitespace-nowrap text-slate-800">From</p>
                        <p className="text-[10px] whitespace-nowrap text-slate-400">data available from {formatDate(availableRange.from)}</p>
                    </div>
                    <div className="flex items-center gap-1.5 ml-1">
                        <select
                            value={draftFromMonth ?? ''}
                            onChange={e => setDraftFromMonth(Number(e.target.value))}
                            className="text-sm font-semibold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-800"
                        >
                            {MONTHS.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
                        </select>
                        <select
                            value={draftFromYear ?? ''}
                            onChange={e => setDraftFromYear(Number(e.target.value))}
                            className="text-sm font-semibold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-800"
                        >
                            {rangeYears.map(y => <option key={y} value={y}>{y}</option>)}
                        </select>
                    </div>
                </div>

                <div className="w-px h-9 hidden sm:block bg-slate-200" />

                <div className="flex items-center gap-2.5">
                    <Calendar className="w-4 h-4 flex-shrink-0" style={{ color: '#4F46E5' }} />
                    <div>
                        <p className="text-xs font-bold whitespace-nowrap text-slate-800">To</p>
                        <p className="text-[10px] whitespace-nowrap text-slate-400">through {formatDate(availableRange.to)}</p>
                    </div>
                    <div className="flex items-center gap-1.5 ml-1">
                        <select
                            value={draftToMonth ?? ''}
                            onChange={e => setDraftToMonth(Number(e.target.value))}
                            className="text-sm font-semibold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-800"
                        >
                            {MONTHS.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
                        </select>
                        <select
                            value={draftToYear ?? ''}
                            onChange={e => setDraftToYear(Number(e.target.value))}
                            className="text-sm font-semibold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-800"
                        >
                            {rangeYears.map(y => <option key={y} value={y}>{y}</option>)}
                        </select>
                    </div>
                    {isNarrowed && (
                        <button
                            onClick={resetRange}
                            className="text-xs font-bold px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors"
                        >
                            Clear
                        </button>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-3 flex-shrink-0">
                {isNarrowed && (
                    <span className="text-[11px] font-bold px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                        Narrowed
                    </span>
                )}
                <button
                    onClick={applyRange}
                    disabled={!isDirty || rangeInvalid}
                    title={rangeInvalid ? '"From" must be on or before "To"' : (isDirty ? 'Apply the selected range' : 'Range already applied')}
                    className="flex items-center gap-1.5 text-sm font-bold px-4 py-2.5 rounded-xl flex-shrink-0 transition-all"
                    style={isDirty && !rangeInvalid
                        ? { background: '#4F46E5', color: '#fff', boxShadow: '0 2px 8px #4F46E540' }
                        : { background: '#fff', border: '1px solid #e2e8f0', color: '#94a3b8', cursor: 'default' }}
                >
                    <Search className="w-4 h-4" />
                    Search
                </button>
            </div>
        </div>
    );

    if (loading && !data) return (
        <div className="flex flex-col items-center justify-center py-32 gap-4">
            <Loader2 className="h-10 w-10 animate-spin text-slate-300" />
            <p className="text-sm text-slate-400">Loading reconciliation data…</p>
        </div>
    );

    if (!data) return (
        <div className="space-y-5">
            <div className="flex items-center gap-3">
                <button onClick={onBack}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-600 transition-colors">
                    <ArrowLeft className="h-4 w-4" /> Back
                </button>
                <h2 className="text-lg font-bold text-slate-900">Reconciliation Report</h2>
            </div>
            {DateRangeBar}
            <div className="flex flex-col items-center justify-center py-24 gap-3">
                <XCircle className="h-10 w-10 text-red-300" />
                <p className="text-sm text-slate-500">{loadError || 'Could not load data for this report'}</p>
                {isNarrowed && (
                    <button onClick={resetRange} className="text-sm text-emerald-700 underline">Reset to full range</button>
                )}
            </div>
        </div>
    );

    const { summary, reconciliation, settled, unsettled } = data;

    const active   = tab === 'unsettled' ? unsettled : settled;
    const providers = active.providers;

    const codProviders     = providers.filter(p => p.type === 'COD');
    const prepaidProviders = providers.filter(p => p.type === 'Prepaid');
    const providerSegments = providers.map(p => ({ value: p.amount, color: p.color, name: p.name }));

    return (
        <div className="space-y-5">
            {/* ── Header ── */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <button onClick={onBack}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-600 transition-colors">
                        <ArrowLeft className="h-4 w-4" /> Back
                    </button>
                    <div>
                        <h2 className="text-lg font-bold text-slate-900">Reconciliation Report</h2>
                        {isNarrowed && (
                            <p className="text-xs text-slate-400 mt-0.5">
                                {formatDate(range.from)} – {formatDate(range.to)}
                            </p>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => navigate(`/brands/${brandId}/agents/${agentId}/shopify-dashboard`)}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold border border-blue-200 rounded-lg bg-white hover:bg-blue-50 text-blue-700 transition-colors"
                    >
                        <LayoutDashboard className="h-4 w-4" /> Shopify Dashboard
                    </button>
                    <button
                        onClick={() => onDownload(file.filename)}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-700 transition-colors"
                    >
                        <Download className="h-4 w-4" /> Download Excel
                    </button>
                </div>
            </div>

            {DateRangeBar}

            <OcvVolumeStrip volume={data.volume} />

            {/* ── Reconciliation Summary ──
                Net Sales = Gross Sales − Returns is the exact identity this
                reconciles to (each row's own net_amount = total_amount −
                return_amount, summed — see getReportData/orderCycleShopifyProcessor's
                loadDataToStaging). Cancellations is deliberately NOT chained in as a
                third "−" term: a cancelled order's own value is already counted
                inside Gross Sales, and only reduces Net Sales if a return was
                separately matched against it — subtracting it again here would
                double-count whenever that overlap exists. Shown as its own
                informational callout instead. */}
            <div className="bg-white border border-slate-200 rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-bold text-slate-800">Reconciliation Summary</h3>
                    <span className="text-xs text-slate-400">{reconciliation.total.toLocaleString()} orders</span>
                </div>

                <div className="rounded-xl overflow-hidden border border-slate-100">
                    <div className="flex items-center justify-between gap-3 px-4 py-3.5">
                        <div>
                            <span className="text-sm font-semibold text-slate-700">Gross Sales</span>
                            <p className="text-[11px] text-slate-400 mt-0.5">Total order value across all {reconciliation.total.toLocaleString()} orders</p>
                        </div>
                        <span className="text-base font-bold text-slate-900 whitespace-nowrap">
                            {fmtFull(summary.grossSales)}
                            <span className="text-slate-400 font-medium text-xs ml-1.5">({fmtINR(summary.grossSales)})</span>
                        </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 px-4 py-3.5 bg-slate-50 border-t border-slate-100">
                        <div>
                            <span className="text-sm font-semibold text-red-600">− Returns</span>
                            <p className="text-[11px] text-slate-400 mt-0.5">Matched against the Return GST report</p>
                        </div>
                        <span className="text-base font-bold text-red-600 whitespace-nowrap">
                            {fmtFull(summary.totalReturns)}
                            <span className="text-red-300 font-medium text-xs ml-1.5">({fmtINR(summary.totalReturns)})</span>
                        </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-t border-slate-100 bg-emerald-50/60">
                        <span className="text-sm font-black text-emerald-700 uppercase tracking-wide">= Net Sales</span>
                        <span className="text-xl font-black text-emerald-700 whitespace-nowrap">
                            {fmtFull(summary.netSales)}
                            <span className="text-emerald-500 font-semibold text-xs ml-1.5">({fmtINR(summary.netSales)})</span>
                        </span>
                    </div>
                </div>

                {summary.cancelledCount > 0 && (
                    <div className="mt-3 flex items-start gap-2 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                        <AlertCircle className="h-3.5 w-3.5 text-slate-400 shrink-0 mt-0.5" />
                        <p className="text-xs text-slate-500 leading-relaxed">
                            <span className="font-bold text-slate-700">{summary.cancelledCount.toLocaleString()} orders ({fmtFull(summary.cancelledAmount)})</span> were
                            cancelled — already counted within Gross Sales above, not subtracted again separately here.
                        </p>
                    </div>
                )}
            </div>

            <OcvCashStrip cash={data.cash} />

            {/* ── Order Breakdown ── */}
            {(() => {
                const mismatchedCount = reconciliation.pending + reconciliation.overpaid + (reconciliation.advance || 0);
                const breakdown = [
                    { label: 'Matched',     count: reconciliation.reconciled, color: '#10b981' },
                    { label: 'Mismatched',  count: mismatchedCount,           color: '#f59e0b' },
                    { label: 'RTO',         count: reconciliation.rto,        color: '#ef4444' },
                    { label: 'Cancelled',   count: reconciliation.cancelled,  color: '#94a3b8' },
                    { label: 'Unsettled',   count: reconciliation.unsettled || 0, color: '#64748b' },
                ];
                const total = reconciliation.total || 0;
                const pctOf = n => (total ? (n / total) * 100 : 0);
                return (
                    <div className="bg-white border border-slate-200 rounded-xl p-5">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-sm font-bold text-slate-800">Order Breakdown</h3>
                            <span className="text-xs text-slate-400">{total.toLocaleString()} orders total</span>
                        </div>

                        {/* Proportional stacked bar — same 5 categories/colors as the legend below */}
                        <div className="h-3 w-full rounded-full overflow-hidden flex bg-slate-100">
                            {breakdown.map(b => (
                                <div
                                    key={b.label}
                                    style={{ width: `${pctOf(b.count)}%`, backgroundColor: b.color }}
                                    title={`${b.label}: ${b.count.toLocaleString()} (${pctOf(b.count).toFixed(1)}%)`}
                                />
                            ))}
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mt-5">
                            {breakdown.map(b => (
                                <div key={b.label}>
                                    <div className="flex items-center gap-1.5">
                                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: b.color }} />
                                        <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{b.label}</span>
                                    </div>
                                    <p className="text-lg font-bold text-slate-900 mt-1 leading-none">{b.count.toLocaleString()}</p>
                                    <p className="text-[11px] text-slate-400 mt-1">{pctOf(b.count).toFixed(1)}% of total</p>
                                </div>
                            ))}
                        </div>

                        <div className="mt-4 pt-4 border-t border-slate-100 flex items-center justify-between">
                            <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Total</span>
                            <span className="text-sm font-bold text-slate-900">{total.toLocaleString()} orders</span>
                        </div>
                    </div>
                );
            })()}

            {/* ── Table 1 — Order Journey Funnel ── */}
            <OcvRefTable
                title="Order Journey Funnel"
                subtitle="Every order, one row per lifecycle stage"
                icon={Route}
                nameKey="stage"
                sources={OCV_SOURCES.funnel}
                columns={[
                    { key: 'n', label: '#' },
                    { key: 'stage', label: 'Stage', strong: true },
                    { key: 'count', label: 'Orders', align: 'right', render: r => ocvClickableCount(r.count, { funnelMetric: r.metric, title: r.stage }, setOcvDrill) },
                    ...OCV_AMOUNT_COLUMNS,
                ]}
                rows={data.funnel}
            />

            {/* ── Table 2 — Scenario Catalog Summary ── */}
            <OcvRefTable
                title="Scenario Catalog Summary"
                subtitle="Every order mapped to one settlement scenario"
                icon={FileText}
                nameKey="key"
                sources={OCV_SOURCES.scenarios}
                columns={[
                    { key: 'n', label: '#' },
                    { key: 'key', label: 'Scenario', render: r => <span className="font-mono text-[11px] font-semibold text-slate-700">{r.key}</span> },
                    { key: 'payment', label: 'Payment', render: r => ocvPaymentPill(r.payment) },
                    { key: 'count', label: 'Orders', align: 'right', render: r => ocvClickableCount(r.count, { scenario: r.key, title: `Scenario · ${r.key}` }, setOcvDrill) },
                    ...OCV_AMOUNT_COLUMNS,
                ]}
                rows={data.scenarios}
            />

            {/* ── Table 3 — Package Status Snapshot ── */}
            <OcvRefTable
                title="Package Status Snapshot"
                subtitle="Where each package physically is, as of the period end"
                icon={Package}
                nameKey="label"
                sources={OCV_SOURCES.packageStatus}
                columns={[
                    { key: 'n', label: '#' },
                    { key: 'label', label: 'Package status bucket', strong: true },
                    { key: 'count', label: 'Orders', align: 'right', render: r => ocvClickableCount(r.count, { pkgBucket: r.key, title: r.label }, setOcvDrill) },
                    ...OCV_AMOUNT_COLUMNS,
                ]}
                rows={data.packageStatus}
            />

            {/* ── Table 4 — Cash Action Snapshot ── */}
            <OcvRefTable
                title="Cash Action Snapshot"
                subtitle="What to do with the money right now · Prepaid vs COD"
                icon={CreditCard}
                nameKey="label"
                sources={OCV_SOURCES.cashActions}
                columns={[
                    { key: 'n', label: '#' },
                    { key: 'label', label: 'Action needed', strong: true },
                    { key: 'prepaid', label: 'Prepaid', align: 'right', render: r => ocvClickableCount(r.prepaid, { cashAction: r.key, payment: 'Prepaid', title: `${r.label} · Prepaid` }, setOcvDrill) },
                    { key: 'cod', label: 'COD', align: 'right', render: r => ocvClickableCount(r.cod, { cashAction: r.key, payment: 'COD', title: `${r.label} · COD` }, setOcvDrill) },
                    ...OCV_AMOUNT_COLUMNS,
                ]}
                rows={(data.cashActions || []).map(r => ({ ...r, calc: r.when }))}
            />

            {(data.volume || data.cash) && <OcvSourceLegend />}

            {/* ── Transaction Data — floating side tab + full-screen modal ── */}
            <button
                onClick={() => setShowTxSheet(true)}
                title="View Transaction Data"
                className="fixed right-0 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-2 rounded-l-xl bg-emerald-600 hover:bg-emerald-700 text-white pl-2.5 pr-2 py-4 shadow-lg shadow-emerald-600/30 transition-colors"
            >
                <BarChart2 className="h-4 w-4" />
                <span className="text-[11px] font-bold tracking-wide rotate-180" style={{ writingMode: 'vertical-rl' }}>
                    Transaction Data
                </span>
            </button>

            <Dialog open={showTxSheet} onOpenChange={setShowTxSheet}>
                <DialogContent
                    onClose={() => setShowTxSheet(false)}
                    className="max-w-[96vw] w-[96vw] max-h-[94vh] flex flex-col gap-0 overflow-hidden p-0"
                >
                    <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
                        <div>
                            <h3 className="text-base font-bold text-slate-900">Transaction Data</h3>
                            <p className="text-xs text-slate-400 mt-0.5">Row-level order data with drill-down source attribution</p>
                        </div>
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50 p-4">
                        {showTxSheet && (
                            <TransactionSheet
                                brandId={brandId}
                                agentId={agentId}
                                filename={file.filename}
                                reconciliation={reconciliation}
                                fromDate={range?.from}
                                toDate={range?.to}
                            />
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            <OcvDrillModal
                open={!!ocvDrill}
                onClose={() => setOcvDrill(null)}
                brandId={brandId}
                agentId={agentId}
                filename={file.filename}
                fromDate={range?.from}
                toDate={range?.to}
                filter={ocvDrill}
            />

            {/* ── Settlements by Providers + Provider Breakdown ── */}
            <div className="grid grid-cols-5 gap-4">
                {/* Provider list */}
                <div className="col-span-3 bg-white border border-slate-200 rounded-xl overflow-hidden">
                    {/* Tabs */}
                    <div className="flex border-b border-slate-100">
                        {['settled','unsettled'].map(t => (
                            <button key={t} onClick={() => setTab(t)}
                                className={`flex-1 py-3 text-sm font-semibold transition-colors capitalize
                                    ${tab === t ? 'border-b-2 border-emerald-500 text-emerald-700 bg-white' : 'text-slate-400 hover:text-slate-600'}`}>
                                {t}
                            </button>
                        ))}
                    </div>

                    <div className="px-5 py-3 border-b border-slate-50">
                        <div className="flex items-baseline gap-3">
                            <p className="text-2xl font-bold text-slate-900">{fmtFull(active.total)}</p>
                            <p className="text-xs text-slate-400">
                                {active.orders.toLocaleString()} {tab === 'unsettled' ? 'Orders Unsettled' : 'Orders Matched'}
                            </p>
                            <div className="ml-auto text-right">
                                <p className="text-xs text-slate-400">Gross Sales</p>
                                <p className="text-sm font-bold text-slate-700">{fmtFull(summary.grossSales)}</p>
                                <p className="text-[10px] text-slate-400">{reconciliation.total.toLocaleString()} Orders</p>
                            </div>
                        </div>
                    </div>

                    <div className="p-4">
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Settlements by Providers</p>
                        <div className="space-y-3">
                            {providers.length === 0 ? (
                                <p className="text-sm text-slate-400 text-center py-4">No provider settlement data</p>
                            ) : providers.map(p => (
                                <div key={p.name} className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-semibold text-slate-800">{p.name}</span>
                                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${p.type === 'COD' ? 'bg-orange-50 text-orange-600' : 'bg-blue-50 text-blue-600'}`}>
                                                    {p.type}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-3 mt-0.5">
                                                <span className="text-xs text-slate-500">{p.orders.toLocaleString()} orders</span>
                                                <span className="text-xs font-semibold text-emerald-600">{p.matchPct}% matched</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="text-right ml-4 shrink-0">
                                        <p className="text-sm font-bold text-slate-900">{fmtFull(p.amount)}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Provider breakdown donut */}
                <div className="col-span-2 bg-white border border-slate-200 rounded-xl p-4">
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">Provider Breakdown</p>
                    {providers.length === 0 ? (
                        <div className="flex items-center justify-center h-32 text-slate-300 text-sm">No data</div>
                    ) : (
                        <>
                            <div className="flex justify-center mb-4">
                                <SegmentDonut segments={providerSegments} size={140} stroke={20} />
                            </div>
                            <div className="space-y-2">
                                {providers.map(p => (
                                    <div key={p.name} className="flex items-center gap-2">
                                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
                                        <span className="text-xs text-slate-600 flex-1 truncate">{p.name}</span>
                                        <span className="text-xs font-semibold text-slate-800">{fmtINR(p.amount)}</span>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>
            </div>

        </div>
    );
}

// ─── Main Component ───────────────────────────────────────────────────────────
const OrderCycleShopifyWorkspace = ({ agent }) => {
    const { brandId, agentId } = useParams();

    const [modal, setModal]               = useState(initModal());
    const [isGenerating, setIsGenerating] = useState(false);
    const [previewData, setPreviewData]   = useState(null);
    const [files, setFiles]               = useState([]);
    const [filesLoading, setFilesLoading] = useState(true);
    const [viewingFile, setViewingFile]   = useState(null); // file object being visualized
    const [searchParams, setSearchParams] = useSearchParams();

    // Keep the open report in the URL (?ocFile=…) so browser-Back — e.g. from the
    // Analytics Portal — lands back on the Reconciliation Report, not the list.
    const openFile = useCallback((file) => {
        setViewingFile(file);
        setSearchParams(prev => { const p = new URLSearchParams(prev); p.set('ocFile', file.filename); return p; });
    }, [setSearchParams]);
    const closeFile = useCallback(() => {
        setViewingFile(null);
        setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('ocFile'); return p; });
    }, [setSearchParams]);

    const fetchFiles = useCallback(async () => {
        setFilesLoading(true);
        try {
            const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/files`);
            setFiles(res.data || []);
        } catch { setFiles([]); }
        finally { setFilesLoading(false); }
    }, [brandId, agentId]);

    useEffect(() => { fetchFiles(); }, [fetchFiles]);

    // Restore / clear the report view from ?ocFile= (handles browser Back).
    useEffect(() => {
        const wanted = searchParams.get('ocFile');
        if (!wanted) { setViewingFile(f => (f ? null : f)); return; }
        if (viewingFile?.filename === wanted) return;
        const match = files.find(f => f.filename === wanted);
        if (match) setViewingFile(match);
    }, [searchParams, files, viewingFile]);

    const openModal  = () => setModal({ ...initModal(), open: true });
    const closeModal = () => { if (isGenerating) return; setModal(initModal()); setPreviewData(null); };

    const setField        = (k, v) => setModal(p => ({ ...p, [k]: v }));
    const toggleGateway   = (id) => setModal(p => {
        const has = p.selectedGateways.includes(id);
        return { ...p, selectedGateways: has ? p.selectedGateways.filter(g => g !== id) : [...p.selectedGateways, id],
            gatewayFiles: has ? { ...p.gatewayFiles, [id]: null } : p.gatewayFiles };
    });
    const toggleLogistics = (id) => setModal(p => {
        const has = p.selectedLogistics.includes(id);
        return { ...p, selectedLogistics: has ? p.selectedLogistics.filter(l => l !== id) : [...p.selectedLogistics, id],
            logisticsFiles: has ? { ...p.logisticsFiles, [id]: null } : p.logisticsFiles };
    });
    const setGatewayFile   = (id, f) => setModal(p => ({ ...p, gatewayFiles:  { ...p.gatewayFiles,  [id]: f } }));
    const setLogisticsFile = (id, f) => setModal(p => ({ ...p, logisticsFiles: { ...p.logisticsFiles, [id]: f } }));

    const validateStep1 = () => {
        if (!modal.month)                    { toast.error('Select a month'); return false; }
        if (!modal.year)                     { toast.error('Select a year');  return false; }
        if (!modal.selectedGateways.length)  { toast.error('Select at least one payment gateway'); return false; }
        if (!modal.selectedLogistics.length) { toast.error('Select at least one logistics partner'); return false; }
        return true;
    };
    const validateStep2 = () => {
        if (!modal.unicommerceFile)      { toast.error('Upload the Unicommerce file'); return false; }
        if (!modal.salesOrderReportFile) { toast.error('Upload the Sales Order Report'); return false; }
        for (const id of modal.selectedGateways)
            if (!modal.gatewayFiles[id]) { toast.error(`Upload file for ${PAYMENT_GATEWAYS.find(g => g.id === id)?.label}`); return false; }
        for (const id of modal.selectedLogistics)
            if (!modal.logisticsFiles[id]) { toast.error(`Upload file for ${LOGISTICS_PARTNERS.find(l => l.id === id)?.label}`); return false; }
        return true;
    };

    const nextStep = () => { if (modal.step === STEP_SELECT && !validateStep1()) return; setModal(p => ({ ...p, step: p.step + 1 })); };
    const prevStep = () => { if (modal.step > STEP_SELECT) setModal(p => ({ ...p, step: p.step - 1 })); };

    const handleGeneratePreview = async () => {
        if (!validateStep2()) return;
        const gwNames = modal.selectedGateways.map(id => PAYMENT_GATEWAYS.find(g => g.id === id)?.label || id);
        const lpNames = modal.selectedLogistics.map(id => LOGISTICS_PARTNERS.find(l => l.id === id)?.label || id);
        const fd = new FormData();
        fd.append('month', modal.month); fd.append('year', modal.year);
        fd.append('gatewayNames', JSON.stringify(gwNames));
        fd.append('logisticsNames', JSON.stringify(lpNames));
        fd.append('unicommerceFile', modal.unicommerceFile);
        fd.append('salesOrderReportFile', modal.salesOrderReportFile);
        if (modal.returnGSTFile) fd.append('returnGSTFile', modal.returnGSTFile);
        modal.selectedGateways.forEach((id, i) => { if (modal.gatewayFiles[id]) fd.append(`paymentGateway_${i}`, modal.gatewayFiles[id]); });
        modal.selectedLogistics.forEach((id, i) => { if (modal.logisticsFiles[id]) fd.append(`logistics_${i}`, modal.logisticsFiles[id]); });
        setIsGenerating(true);
        try {
            const res = await api.post(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/generate/preview`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
            setPreviewData(res.data);
            setModal(p => ({ ...p, step: STEP_PREVIEW }));
        } catch (err) { toast.error(err.response?.data?.error || 'Failed to process files'); }
        finally { setIsGenerating(false); }
    };

    const handleCommit = async () => {
        if (!previewData?.taskId) return;
        setIsGenerating(true);
        try {
            await api.post(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/generate/commit`, { taskId: previewData.taskId });
            toast.success('Reconciliation report saved successfully');
            closeModal(); fetchFiles();
        } catch (err) { toast.error(err.response?.data?.error || 'Failed to save'); }
        finally { setIsGenerating(false); }
    };

    const handleDiscard = async () => {
        if (previewData?.taskId) {
            try { await api.post(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/generate/discard`, { taskId: previewData.taskId }); }
            catch { /* TTL cleans up */ }
        }
        toast.info('Generation discarded'); closeModal();
    };

    const handleDownload = async (filename) => {
        try {
            const res = await api.get(
                `/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/files/${encodeURIComponent(filename)}/download`,
                { responseType: 'blob' }
            );
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const a = document.createElement('a'); a.href = url;
            a.setAttribute('download', filename); document.body.appendChild(a); a.click(); a.remove();
            toast.success('Downloaded');
        } catch { toast.error('Download failed'); }
    };

    const handleDelete = async (filename) => {
        if (!window.confirm(`Delete "${filename}"? This cannot be undone.`)) return;
        try {
            await api.delete(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/files`, { data: { filename } });
            toast.success('Report deleted');
            if (viewingFile?.filename === filename) closeFile();
            fetchFiles();
        } catch { toast.error('Delete failed'); }
    };

    const stepLabels = ['Select Partners', 'Upload Files', 'Preview & Save'];

    // ─── Visualization view ───────────────────────────────────────────────────
    if (viewingFile) {
        return (
            <ReconciliationView
                file={viewingFile}
                brandId={brandId}
                agentId={agentId}
                onBack={closeFile}
                onDownload={handleDownload}
            />
        );
    }

    // ─── Files list view ──────────────────────────────────────────────────────
    return (
        <div className="space-y-0">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h2 className="text-xl font-bold text-slate-900">Reconciliation Summary</h2>
                    <p className="text-sm text-slate-500 mt-0.5">Order Cycle</p>
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={fetchFiles} disabled={filesLoading}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-600 transition-colors">
                        <RefreshCw className={`h-4 w-4 ${filesLoading ? 'animate-spin' : ''}`} /> Refresh
                    </button>
                    <button onClick={openModal} data-testid="oc-generate-button"
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-700 transition-colors">
                        <Plus className="h-4 w-4" /> Generate Report
                    </button>
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-3 gap-4 mb-6">
                {[
                    { label: 'Total Reports',  value: filesLoading ? '—' : files.length,               sub: 'Generated files' },
                ].map(({ label, value, sub, small }) => (
                    <div key={label} className="bg-white border border-slate-200 rounded-xl p-4">
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">{label}</p>
                        <p className={`font-bold text-slate-900 ${small ? 'text-lg' : 'text-3xl'}`}>{value}</p>
                        <p className="text-xs text-slate-400 mt-1">{sub}</p>
                    </div>
                ))}
            </div>

            {/* Files table */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-slate-400" />
                        <span className="text-sm font-semibold text-slate-800">Report History</span>
                        {!filesLoading && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">
                                {files.length}
                            </span>
                        )}
                    </div>
                    <span className="text-xs text-slate-400">Click View to see reconciliation data</span>
                </div>

                {filesLoading ? (
                    <div className="flex items-center justify-center py-16 gap-3">
                        <Loader2 className="h-6 w-6 animate-spin text-slate-300" />
                        <span className="text-sm text-slate-400">Loading reports…</span>
                    </div>
                ) : files.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 gap-3">
                        <div className="w-14 h-14 rounded-full bg-slate-50 border border-slate-200 flex items-center justify-center">
                            <BarChart2 className="h-6 w-6 text-slate-300" />
                        </div>
                        <div className="text-center">
                            <p className="text-sm font-semibold text-slate-600">No reports generated yet</p>
                            <p className="text-xs text-slate-400 mt-1">Click "Generate Report" to process your first reconciliation</p>
                        </div>
                        <button onClick={openModal}
                            className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-700 transition-colors">
                            <Plus className="h-4 w-4" /> Generate Report
                        </button>
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-slate-50 border-b border-slate-100">
                                {['File', 'Period', 'Rows', 'Generated', 'Actions'].map((h, i) => (
                                    <th key={h} className={`text-xs font-semibold text-slate-500 uppercase tracking-wider px-5 py-3 ${i === 4 ? 'text-right' : 'text-left'}`}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {files.map((file, idx) => (
                                <tr key={idx} className="hover:bg-slate-50/70 transition-colors group">
                                    <td className="px-5 py-3.5">
                                        <div className="flex items-center gap-2.5">
                                            <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-100 flex items-center justify-center shrink-0">
                                                <FileText className="h-4 w-4 text-emerald-600" />
                                            </div>
                                            <span className="font-mono text-xs text-slate-600 max-w-[200px] truncate" title={file.filename}>
                                                {file.filename}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3.5">
                                        <div className="flex items-center gap-1.5">
                                            <Calendar className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                                            {file.data_from && file.data_to ? (
                                                <div className="leading-tight">
                                                    <span className="text-slate-700 font-medium whitespace-nowrap">
                                                        {formatDate(file.data_from)} – {formatDate(file.data_to)}
                                                    </span>
                                                    <p className="text-[10px] text-slate-400">
                                                        uploaded as {monthNumToName(file.month)} {file.year}
                                                    </p>
                                                </div>
                                            ) : (
                                                <span className="text-slate-700 font-medium">{monthNumToName(file.month)} {file.year}</span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3.5">
                                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100">
                                            {(file.row_count ?? 0).toLocaleString()} rows
                                        </span>
                                    </td>
                                    <td className="px-4 py-3.5 text-slate-500 text-xs">{formatDate(file.created_at)}</td>
                                    <td className="px-5 py-3.5">
                                        <div className="flex items-center justify-end gap-1.5">
                                            <button
                                                onClick={() => openFile(file)}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-700 transition-colors"
                                                data-testid={`oc-view-${idx}`}
                                            >
                                                <Eye className="h-3.5 w-3.5" /> View
                                            </button>
                                            <button
                                                onClick={() => handleDownload(file.filename)}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 transition-colors"
                                                data-testid={`oc-download-${idx}`}
                                            >
                                                <Download className="h-3.5 w-3.5" />
                                            </button>
                                            <button
                                                onClick={() => handleDelete(file.filename)}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-red-100 bg-red-50 hover:bg-red-100 text-red-600 transition-colors"
                                                data-testid={`oc-delete-${idx}`}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* ════ GENERATE MODAL ════ */}
            <Dialog open={modal.open} onOpenChange={open => { if (!open) closeModal(); }}>
                <DialogContent onClose={closeModal} className="max-w-2xl max-h-[92vh] flex flex-col overflow-hidden p-0">
                    {/* Modal header */}
                    <div className="px-6 pt-6 pb-4 border-b border-slate-100 shrink-0">
                        <DialogTitle className="text-base font-bold text-slate-900">Generate Reconciliation Report</DialogTitle>
                        <DialogDescription className="text-xs text-slate-500 mt-0.5">{agent?.name} · {modal.month} {modal.year}</DialogDescription>
                        {/* Step indicator */}
                        <div className="flex items-center mt-4">
                            {stepLabels.map((label, i) => {
                                const n = i + 1, active = modal.step === n, done = modal.step > n;
                                return (
                                    <React.Fragment key={label}>
                                        <div className="flex items-center gap-2">
                                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all
                                                ${done ? 'bg-emerald-500 text-white' : active ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-400'}`}>
                                                {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : n}
                                            </div>
                                            <span className={`text-xs font-medium ${active ? 'text-slate-900' : 'text-slate-400'}`}>{label}</span>
                                        </div>
                                        {i < stepLabels.length - 1 && (
                                            <div className={`flex-1 h-px mx-3 ${modal.step > n ? 'bg-emerald-400' : 'bg-slate-200'}`} />
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </div>
                    </div>

                    {/* STEP 1 */}
                    {modal.step === STEP_SELECT && (
                        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                            <div className="grid grid-cols-2 gap-3">
                                {[['month','Month',MONTHS.map(m => ({ v: m, l: m }))], ['year','Year',YEARS.map(y => ({ v: String(y), l: y }))]].map(([key, label, opts]) => (
                                    <div key={key}>
                                        <label className="block text-xs font-semibold text-slate-600 mb-1.5">{label} *</label>
                                        <select value={modal[key]} onChange={e => setField(key, e.target.value)}
                                            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-slate-300">
                                            {key === 'month' && <option value="">— Select Month —</option>}
                                            {opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                                        </select>
                                    </div>
                                ))}
                            </div>

                            {[
                                { title: 'Payment Gateways', icon: CreditCard, color: 'text-blue-500', items: PAYMENT_GATEWAYS,
                                  selected: modal.selectedGateways, toggle: toggleGateway,
                                  badgeClass: 'text-blue-600 bg-blue-50', selClass: 'border-blue-400 bg-blue-50 text-blue-900', chkClass: 'bg-blue-500 border-blue-500' },
                                { title: 'Logistics Partners', icon: Package, color: 'text-orange-500', items: LOGISTICS_PARTNERS,
                                  selected: modal.selectedLogistics, toggle: toggleLogistics,
                                  badgeClass: 'text-orange-600 bg-orange-50', selClass: 'border-orange-400 bg-orange-50 text-orange-900', chkClass: 'bg-orange-500 border-orange-500' },
                            ].map(({ title, icon: Icon, color, items, selected, toggle, badgeClass, selClass, chkClass }) => (
                                <div key={title}>
                                    <div className="flex items-center gap-2 mb-2">
                                        <Icon className={`h-4 w-4 ${color}`} />
                                        <span className="text-xs font-semibold text-slate-700 uppercase tracking-wider">{title}</span>
                                        {selected.length > 0 && (
                                            <span className={`ml-auto text-xs font-semibold ${badgeClass} px-2 py-0.5 rounded-full`}>{selected.length} selected</span>
                                        )}
                                    </div>
                                    <div className="grid grid-cols-1 gap-2">
                                        {items.map(item => {
                                            const sel = selected.includes(item.id);
                                            return (
                                                <button key={item.id} type="button" onClick={() => toggle(item.id)}
                                                    className={`flex items-center gap-3 w-full px-4 py-3 rounded-xl border-2 text-left text-sm font-medium transition-all
                                                        ${sel ? selClass : 'border-slate-150 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-white'}`}
                                                    data-testid={`toggle-${item.id}`}>
                                                    <span className={`w-4 h-4 rounded shrink-0 flex items-center justify-center border-2 transition-colors ${sel ? chkClass : 'border-slate-300 bg-white'}`}>
                                                        {sel && <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                                                    </span>
                                                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: item.color }} />
                                                    {item.label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* STEP 2 */}
                    {modal.step === STEP_UPLOAD && (
                        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
                            <div>
                                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Core Files</p>
                                <div className="grid grid-cols-2 gap-3">
                                    <FileDropZone id="oc-unicommerce" label="Unicommerce File" icon={ShoppingBag} color="#475569"
                                        accept=".xlsx,.xls,.csv" value={modal.unicommerceFile} onChange={f => setField('unicommerceFile', f)} />
                                    <FileDropZone id="oc-sales-order" label="Sales Order Report" icon={FileText} color="#475569"
                                        accept=".xlsx,.xls,.csv" value={modal.salesOrderReportFile} onChange={f => setField('salesOrderReportFile', f)} />
                                    <FileDropZone id="oc-return-gst" label="Return GST Report (optional)" icon={FileText} color="#b45309"
                                        accept=".xlsx,.xls,.csv" value={modal.returnGSTFile} onChange={f => setField('returnGSTFile', f)} />
                                </div>
                            </div>
                            {modal.selectedGateways.length > 0 && (
                                <div>
                                    <div className="flex items-center gap-2 mb-3">
                                        <CreditCard className="h-3.5 w-3.5 text-blue-500" />
                                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Payment Gateway Files</p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        {modal.selectedGateways.map(id => {
                                            const gw = PAYMENT_GATEWAYS.find(g => g.id === id);
                                            return <FileDropZone key={id} id={`gw-file-${id}`} label={gw?.label} icon={CreditCard} color={gw?.color}
                                                accept=".xlsx,.xls,.csv" value={modal.gatewayFiles[id]} onChange={f => setGatewayFile(id, f)} />;
                                        })}
                                    </div>
                                </div>
                            )}
                            {modal.selectedLogistics.length > 0 && (
                                <div>
                                    <div className="flex items-center gap-2 mb-3">
                                        <Package className="h-3.5 w-3.5 text-orange-500" />
                                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Logistics Partner Files</p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        {modal.selectedLogistics.map(id => {
                                            const lp = LOGISTICS_PARTNERS.find(l => l.id === id);
                                            return <FileDropZone key={id} id={`lp-file-${id}`} label={lp?.label} icon={Package} color={lp?.color}
                                                accept=".xlsx,.xls,.csv" value={modal.logisticsFiles[id]} onChange={f => setLogisticsFile(id, f)} />;
                                        })}
                                    </div>
                                </div>
                            )}
                            <p className="text-xs text-slate-400 flex items-center gap-1.5 pt-1">
                                <AlertCircle className="h-3.5 w-3.5" /> All files must be Excel (.xlsx / .xls) or CSV format
                            </p>
                        </div>
                    )}

                    {/* STEP 3 */}
                    {modal.step === STEP_PREVIEW && (
                        <div className="flex-1 overflow-y-auto px-6 py-5">
                            {isGenerating ? (
                                <div className="flex flex-col items-center justify-center py-16 gap-4">
                                    <div className="w-16 h-16 rounded-full border-4 border-slate-100 flex items-center justify-center">
                                        <Loader2 className="h-7 w-7 animate-spin text-slate-400" />
                                    </div>
                                    <div className="text-center">
                                        <p className="text-sm font-semibold text-slate-700">Processing files…</p>
                                        <p className="text-xs text-slate-400 mt-1">Reconciling order data across all partners</p>
                                    </div>
                                </div>
                            ) : previewData ? (
                                <div className="space-y-4">
                                    {/* Status ring */}
                                    <div className="flex items-center gap-6 p-5 bg-slate-50 rounded-xl border border-slate-200">
                                        <div className="relative shrink-0">
                                            <DonutChart pct={previewData.rowCount && previewData.summary?.unicommerceRows
                                                ? Math.round((previewData.rowCount / previewData.summary.unicommerceRows) * 100) : 100}
                                                size={96} stroke={10} color="#10b981"
                                                label={previewData.rowCount && previewData.summary?.unicommerceRows
                                                    ? `${Math.round((previewData.rowCount / previewData.summary.unicommerceRows) * 100)}%` : '100%'} />
                                        </div>
                                        <div className="flex-1 grid grid-cols-2 gap-4">
                                            <div>
                                                <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Output Rows</p>
                                                <p className="text-2xl font-bold text-slate-900">{(previewData.rowCount ?? 0).toLocaleString()}</p>
                                                <p className="text-xs text-emerald-600 font-medium mt-0.5">Order Cycle records</p>
                                            </div>
                                            <div>
                                                <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Source Rows</p>
                                                <p className="text-2xl font-bold text-slate-900">{(previewData.summary?.unicommerceRows ?? 0).toLocaleString()}</p>
                                                <p className="text-xs text-slate-400 font-medium mt-0.5">Unicommerce rows</p>
                                            </div>
                                        </div>
                                    </div>
                                    {/* Sales order row */}
                                    <div className="flex items-center justify-between px-4 py-3 bg-white rounded-xl border border-slate-200">
                                        <div className="flex items-center gap-2.5">
                                            <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center">
                                                <FileText className="h-4 w-4 text-slate-500" />
                                            </div>
                                            <span className="text-sm font-medium text-slate-700">Sales Order Report</span>
                                        </div>
                                        <span className="text-sm font-bold text-slate-900">{(previewData.summary?.salesOrderRows ?? 0).toLocaleString()} rows</span>
                                    </div>
                                    {/* Gateways */}
                                    {previewData.summary?.gateways && Object.entries(previewData.summary.gateways).map(([name, count]) => {
                                        const gw = PAYMENT_GATEWAYS.find(g => g.label === name || g.id === name.toLowerCase());
                                        return (
                                            <div key={name} className="flex items-center justify-between px-4 py-3 bg-white rounded-xl border border-slate-200">
                                                <div className="flex items-center gap-2.5">
                                                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: gw?.color || '#6366f1' }} />
                                                    <span className="text-sm font-medium text-slate-700">{name}</span>
                                                </div>
                                                <span className="text-sm font-bold text-slate-900">{Number(count).toLocaleString()} rows</span>
                                            </div>
                                        );
                                    })}
                                    {/* Logistics */}
                                    {previewData.summary?.logistics && Object.entries(previewData.summary.logistics).map(([name, count]) => {
                                        const lp = LOGISTICS_PARTNERS.find(l => l.label === name || l.id === name.toLowerCase());
                                        const total = Object.values(previewData.summary.logistics).reduce((s, v) => s + Number(v), 0);
                                        const pct   = total ? Math.round((Number(count) / total) * 100) : 0;
                                        return (
                                            <div key={name} className="px-4 py-3 bg-white rounded-xl border border-slate-200">
                                                <div className="flex items-center justify-between mb-1.5">
                                                    <div className="flex items-center gap-2.5">
                                                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: lp?.color || '#f59e0b' }} />
                                                        <span className="text-sm font-medium text-slate-700">{name}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs text-slate-400">{pct}%</span>
                                                        <span className="text-sm font-bold text-slate-900">{Number(count).toLocaleString()} rows</span>
                                                    </div>
                                                </div>
                                                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: lp?.color || '#f59e0b' }} />
                                                </div>
                                            </div>
                                        );
                                    })}
                                    <p className="text-xs text-slate-400 text-center pt-1">
                                        Review the counts · Click <strong>Confirm &amp; Save</strong> to write the Excel file
                                    </p>
                                </div>
                            ) : null}
                        </div>
                    )}

                    {/* Footer */}
                    <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 shrink-0 bg-slate-50/50">
                        <div>
                            {modal.step > STEP_SELECT && !isGenerating && (
                                <button onClick={prevStep}
                                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 transition-colors">
                                    <ChevronLeft className="h-4 w-4" /> Back
                                </button>
                            )}
                        </div>
                        <div className="flex gap-2">
                            {modal.step === STEP_SELECT && (
                                <button onClick={nextStep} data-testid="oc-next-btn"
                                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-700 transition-colors">
                                    Next <ChevronRight className="h-4 w-4" />
                                </button>
                            )}
                            {modal.step === STEP_UPLOAD && (
                                <button onClick={handleGeneratePreview} disabled={isGenerating} data-testid="oc-generate-preview-btn"
                                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50 transition-colors">
                                    {isGenerating ? <><Loader2 className="h-4 w-4 animate-spin" /> Processing…</> : <><UploadCloud className="h-4 w-4" /> Generate Preview</>}
                                </button>
                            )}
                            {modal.step === STEP_PREVIEW && previewData && !isGenerating && (
                                <>
                                    <button onClick={handleDiscard}
                                        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 transition-colors">
                                        Discard
                                    </button>
                                    <button onClick={handleCommit} data-testid="oc-confirm-btn"
                                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors">
                                        <CheckCircle2 className="h-4 w-4" /> Confirm &amp; Save
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
};

export default OrderCycleShopifyWorkspace;

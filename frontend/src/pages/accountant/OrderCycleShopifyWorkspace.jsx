import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../components/ui/modal';
import {
    Loader2, Plus, Download, Trash2, FileText, RefreshCw,
    ChevronRight, ChevronLeft, CheckCircle2, Package, CreditCard,
    ShoppingBag, UploadCloud, AlertCircle, Calendar, BarChart2,
    ArrowLeft, Eye, TrendingDown, TrendingUp, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import api from '../../lib/api';

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

const initModal = () => ({
    open: false,
    step: STEP_SELECT,
    month: MONTHS[new Date().getMonth()],
    year: String(currentYear),
    selectedGateways:  [],
    selectedLogistics: [],
    unicommerceFile: null,
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
    const courierName = ekAmt > 0 ? 'Ekart' : delAmt > 0 ? 'Delhivery' : xpAmt > 0 ? 'Xpressbees' : 'Courier';
    const gatewayName = snAmt > 0 ? 'Snapmint' : bhAmt > 0 ? 'BharatX' : rzAmt > 0 ? 'Razorpay' : 'Gateway';
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
            <td colSpan={11} className="p-0">
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
                            {kvRow('Return Amount', fmtFull(row.return_amount))}
                            {kvRow('Net Amount', `${fmtFull(row.total_amount)} − ${fmtFull(row.return_amount)} = ${fmtFull(row.net_amount)}`)}
                        </>)}
                        {srcSection('#1baf7a', courierName, `${courierName} settlement report`, <>
                            {kvRow('Join Key (AWB)', row.awb_number)}
                            {ekAmt > 0 && <>{kvRow('Remittance Date', formatDate(row.ekart_remittance_date))}{kvRow('Actual Date', formatDate(row.ekart_actual_remittance_date))}{kvRow('COD Amount', fmtFull(ekAmt))}</>}
                            {delAmt > 0 && <>{kvRow('Delivery Date', formatDate(row.delhivery_delivery_date))}{kvRow('COD Amount', fmtFull(delAmt))}</>}
                            {xpAmt > 0 && <>{kvRow('Delivery Date', formatDate(row.xpressbees_delivery_date))}{kvRow('Txn Date', formatDate(row.xpressbees_transaction_date))}{kvRow('Net Payment', fmtFull(xpAmt))}</>}
                            {ekAmt === 0 && delAmt === 0 && xpAmt === 0 && kvRow('Amount', '— No record found')}
                        </>)}
                        {srcSection('#7c3aed', gatewayName, `${gatewayName} settlement report`, <>
                            {snAmt > 0 && <>{kvRow('Join Key (Order No.)', row.sale_order_number)}{kvRow('Settlement Date', formatDate(row.snapmint_settlement_date))}{kvRow('Settlement Value', fmtFull(snAmt))}</>}
                            {bhAmt > 0 && <>{kvRow('Join Key (Order ID)', row.sale_order_number)}{kvRow('Settlement Date', formatDate(row.bharatx_settlement_timestamp))}{kvRow('Ledger Amount', fmtFull(bhAmt))}</>}
                            {rzAmt > 0 && <>{kvRow('receipt → SO', row.sale_order_number)}{kvRow('Settlement Date', formatDate(row.razorpay_settlement_date))}{kvRow('Amount', fmtFull(rzAmt))}</>}
                            {snAmt === 0 && bhAmt === 0 && rzAmt === 0 && kvRow('Settlement', '— No record found')}
                        </>)}
                    </div>
                    <div className="flex flex-wrap gap-4 items-center bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-xs">
                        <div><span className="text-slate-400">Net Order Value: </span><span className="font-semibold">{fmtFull(row.net_amount)}</span></div>
                        <div className="text-slate-200">·</div>
                        <div><span className="text-slate-400">Total Settlement: </span><span className="font-semibold">{totalSettled > 0 ? fmtFull(totalSettled) : '—'}</span></div>
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

function TransactionSheet({ brandId, agentId, filename, reconciliation }) {
    const [txTab, setTxTab]         = useState('all');
    const [mismatchSub, setMismatchSub] = useState('less');
    const [expandedId, setExpandedId]   = useState(null);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch]       = useState('');
    const [page, setPage]           = useState(1);
    const [rows, setRows]           = useState([]);
    const [total, setTotal]         = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [loading, setLoading]     = useState(true);
    const [pageLoading, setPageLoading] = useState(false);

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

        const params = new URLSearchParams({ tab: txTab, sub: mismatchSub, page, pageSize: 50 });
        if (search) params.set('search', search);

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
    }, [txTab, mismatchSub, page, search, brandId, agentId, filename]);

    const toNum = v => { const n = Number(v); return isNaN(n) ? 0 : n; };

    // Tab counts from parent reconciliation (already loaded, no extra fetch)
    const rc = reconciliation || {};
    const unsettledCount = Math.max(0, (rc.total || 0) - (rc.reconciled || 0) - (rc.pending || 0) - (rc.overpaid || 0));
    const tabs = [
        { key: 'matched',    label: 'Matched',     count: rc.reconciled },
        { key: 'mismatched', label: 'Mismatched',  count: (rc.pending || 0) + (rc.overpaid || 0) },
        { key: 'unsettled',  label: 'Unsettled',   count: unsettledCount },
        { key: 'all',        label: 'All Orders',  count: rc.total },
        { key: 'sales',      label: 'Sales Report', count: null },
    ];

    function switchTab(key) { setTxTab(key); setPage(1); setExpandedId(null); setRows([]); setLoading(true); }
    function switchSub(key) { setMismatchSub(key); setPage(1); setExpandedId(null); setRows([]); setLoading(true); }

    function statusBadge(row) {
        const s = (row.reconciliation_status || '').toUpperCase().trim();
        const ds = (row.delivery_status || '').toUpperCase();
        if (s === 'RECONCILED')         return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-50 text-emerald-700">RECONCILED</span>;
        if (s === 'PENDING RECEIVABLE') return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-50 text-amber-700">PENDING</span>;
        if (s.startsWith('OVERPAID'))   return <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-purple-50 text-purple-700">OVERPAID</span>;
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

    function gatewayOf(row) {
        if (toNum(row.snapmint_settlement_value) > 0) return 'Snapmint';
        if (toNum(row.bharatx_ledger_amount) > 0)     return 'BharatX';
        if (toNum(row.razorpay_settlement_amount) > 0) return 'Razorpay';
        return '—';
    }

    function settlementDateOf(row) {
        return row.snapmint_settlement_date || row.bharatx_settlement_timestamp || row.razorpay_settlement_date;
    }

    const showSales = txTab === 'sales';

    return (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                    <h3 className="text-sm font-bold text-slate-800">Transaction Sheet</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Click any row to see source file attribution for each value</p>
                </div>
                <input
                    className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg bg-slate-50 text-slate-700 placeholder-slate-400 focus:outline-none focus:border-slate-400 w-52"
                    type="text"
                    placeholder="Search order ID, invoice…"
                    value={searchInput}
                    onChange={e => setSearchInput(e.target.value)}
                />
            </div>

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

            {/* Mismatched sub-toggle */}
            {txTab === 'mismatched' && (
                <div className="px-5 pt-3 flex gap-2">
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
                                {!showSales ? (<>
                                    <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Order ID</th>
                                    <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Invoice No.</th>
                                    <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Order Value</th>
                                    <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Settlement</th>
                                    <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Diff</th>
                                    <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Order Date</th>
                                    <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Settlement Date</th>
                                    <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Status</th>
                                    <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Courier</th>
                                    <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Gateway</th>
                                </>) : (<>
                                    <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Order ID</th>
                                    <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Invoice No.</th>
                                    <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Invoice Date</th>
                                    <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Channel</th>
                                    <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">GMV</th>
                                    <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Return</th>
                                    <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Net Amount</th>
                                    <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Basic (÷1.12)</th>
                                    <th className="px-3 py-2.5 text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">GST @12%</th>
                                    <th className="px-3 py-2.5 text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap">Status</th>
                                </>)}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.length === 0 ? (
                                <tr><td colSpan={11} className="text-center text-slate-400 py-10 text-xs">No records found</td></tr>
                            ) : rows.map(row => {
                                const rowId = row.id || row.sale_order_number;
                                const isExp = expandedId === rowId;
                                const totalSettled = toNum(row.total_settlement_received);
                                const basic12 = Math.round(toNum(row.net_amount) / 1.12 * 100) / 100;
                                const gst12   = Math.round((toNum(row.net_amount) - basic12) * 100) / 100;
                                return (
                                    <React.Fragment key={rowId}>
                                        <tr
                                            className={`border-b border-slate-100 cursor-pointer transition-colors ${isExp ? 'bg-emerald-50/30' : 'hover:bg-slate-50/50'}`}
                                            onClick={() => setExpandedId(isExp ? null : rowId)}
                                        >
                                            <td className="px-3 py-2.5">
                                                <ChevronRight className={`h-3.5 w-3.5 text-slate-400 transition-transform ${isExp ? 'rotate-90' : ''}`} />
                                            </td>
                                            {!showSales ? (<>
                                                <td className="px-3 py-2.5 font-semibold text-slate-800 whitespace-nowrap">{row.sale_order_number || '—'}</td>
                                                <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{row.invoice_number || '—'}</td>
                                                <td className="px-3 py-2.5 text-right font-medium tabular-nums whitespace-nowrap">{fmtFull(row.total_amount)}</td>
                                                <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap">{totalSettled > 0 ? fmtFull(totalSettled) : '—'}</td>
                                                <td className="px-3 py-2.5 text-right whitespace-nowrap">{diffBadge(row)}</td>
                                                <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{formatDate(row.dispatch_or_cancellation_date)}</td>
                                                <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{formatDate(settlementDateOf(row))}</td>
                                                <td className="px-3 py-2.5 whitespace-nowrap">{statusBadge(row)}</td>
                                                <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap capitalize">{(row.shipping_partner || '—').toLowerCase()}</td>
                                                <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{gatewayOf(row)}</td>
                                            </>) : (<>
                                                <td className="px-3 py-2.5 font-semibold text-slate-800 whitespace-nowrap">{row.sale_order_number || '—'}</td>
                                                <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{row.invoice_number || '—'}</td>
                                                <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{formatDate(row.dispatch_or_cancellation_date)}</td>
                                                <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{row.platform || '—'}</td>
                                                <td className="px-3 py-2.5 text-right font-medium tabular-nums whitespace-nowrap">{fmtFull(row.total_amount)}</td>
                                                <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                                                    {toNum(row.return_amount) > 0 ? <span className="text-red-500">{fmtFull(row.return_amount)}</span> : '—'}
                                                </td>
                                                <td className="px-3 py-2.5 text-right font-medium tabular-nums whitespace-nowrap">{fmtFull(row.net_amount)}</td>
                                                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500 whitespace-nowrap">{fmtFull(basic12)}</td>
                                                <td className="px-3 py-2.5 text-right tabular-nums text-slate-500 whitespace-nowrap">{fmtFull(gst12)}</td>
                                                <td className="px-3 py-2.5 whitespace-nowrap">{statusBadge(row)}</td>
                                            </>)}
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
    const [data, setData]       = useState(null);
    const [loading, setLoading] = useState(true);
    const [tab, setTab]         = useState('settled');   // 'settled' | 'unsettled'
    const [showTxSheet, setShowTxSheet] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        api.get(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/files/${encodeURIComponent(file.filename)}/report`)
            .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
            .catch(() => { if (!cancelled) { toast.error('Failed to load report data'); setLoading(false); } });
        return () => { cancelled = true; };
    }, [file.filename, brandId, agentId]);

    if (loading) return (
        <div className="flex flex-col items-center justify-center py-32 gap-4">
            <Loader2 className="h-10 w-10 animate-spin text-slate-300" />
            <p className="text-sm text-slate-400">Loading reconciliation data…</p>
        </div>
    );

    if (!data) return (
        <div className="flex flex-col items-center justify-center py-32 gap-3">
            <XCircle className="h-10 w-10 text-red-300" />
            <p className="text-sm text-slate-500">Could not load data for this report</p>
            <button onClick={onBack} className="text-sm text-slate-600 underline">Go back</button>
        </div>
    );

    const { summary, reconciliation, providers, totalSettled, couriers } = data;

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
                        <p className="text-xs text-slate-400 mt-0.5">{monthNumToName(file.month)} {file.year} · {file.filename}</p>
                    </div>
                </div>
                <button
                    onClick={() => onDownload(file.filename)}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-700 transition-colors"
                >
                    <Download className="h-4 w-4" /> Download Excel
                </button>
            </div>

            {/* ── Reconciliation Summary ── */}
            <div className="bg-white border border-slate-200 rounded-xl p-5">
                <h3 className="text-sm font-bold text-slate-800 mb-4">Reconciliation Summary</h3>
                <div className="flex items-stretch gap-0 flex-wrap">
                    {/* NET SALES */}
                    <div className="flex-1 min-w-[140px] pr-6">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Net Sales</p>
                        <p className="text-2xl font-bold text-slate-900 mt-1 leading-none">{fmtINR(summary.netSales)}</p>
                        <p className="text-xs text-slate-400 mt-1">{reconciliation.total.toLocaleString()} orders</p>
                    </div>

                    <div className="flex items-center text-slate-300 font-light text-2xl mr-6">=</div>

                    {/* GROSS SALES */}
                    <div className="flex-1 min-w-[140px] pr-6">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Gross Sales</p>
                        <p className="text-2xl font-bold text-slate-900 mt-1 leading-none">{fmtINR(summary.grossSales)}</p>
                        <p className="text-xs text-slate-400 mt-1">{reconciliation.total.toLocaleString()} orders</p>
                    </div>

                    <div className="flex items-center text-slate-300 font-light text-2xl mr-6">−</div>

                    {/* RETURNS */}
                    <div className="flex-1 min-w-[120px] pr-6">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Returns</p>
                        <p className="text-2xl font-bold text-slate-900 mt-1 leading-none">{fmtINR(summary.totalReturns)}</p>
                        <p className="text-xs text-slate-400 mt-1">—</p>
                    </div>

                    <div className="flex items-center text-slate-300 font-light text-2xl mr-6">−</div>

                    {/* CANCELLATIONS */}
                    <div className="flex-1 min-w-[120px]">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Cancellations</p>
                        <p className="text-2xl font-bold text-slate-900 mt-1 leading-none">{fmtINR(summary.cancelledAmount)}</p>
                        <p className="text-xs text-slate-400 mt-1">{summary.cancelledCount.toLocaleString()} orders</p>
                    </div>

                    {/* Reconciliation Status donut */}
                    <div className="ml-auto flex items-center gap-6 border-l border-slate-100 pl-6">
                        <div className="text-right">
                            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Reconciliation Status</p>
                            <div className="flex items-center gap-6">
                                <div>
                                    <p className="text-[10px] text-slate-400 uppercase tracking-wide">Matched</p>
                                    <p className="text-lg font-bold text-slate-900">{reconciliation.reconciled.toLocaleString()}</p>
                                </div>
                                <div className="relative">
                                    <DonutChart
                                        pct={reconciliation.matchPct}
                                        size={90} stroke={10} color="#10b981"
                                        label={`${reconciliation.matchPct}%`}
                                    />
                                </div>
                                <div>
                                    <p className="text-[10px] text-slate-400 uppercase tracking-wide">Total</p>
                                    <p className="text-lg font-bold text-slate-900">{reconciliation.total.toLocaleString()}</p>
                                </div>
                            </div>
                            <div className="flex gap-5 mt-3">
                                <div>
                                    <p className="text-[10px] text-slate-400">Mismatched</p>
                                    <p className="text-sm font-bold text-orange-600">{(reconciliation.pending + reconciliation.overpaid).toLocaleString()}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] text-slate-400">RTO</p>
                                    <p className="text-sm font-bold text-red-500">{reconciliation.rto.toLocaleString()}</p>
                                </div>
                                <div>
                                    <p className="text-[10px] text-slate-400">Cancelled</p>
                                    <p className="text-sm font-bold text-slate-500">{reconciliation.cancelled.toLocaleString()}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Transaction Sheet ── */}
            {!showTxSheet ? (
                <div className="flex items-center justify-between bg-white border border-slate-200 rounded-xl px-5 py-4">
                    <div>
                        <p className="text-sm font-semibold text-slate-800">Transaction Data</p>
                        <p className="text-xs text-slate-400 mt-0.5">Row-level order data with drill-down source attribution</p>
                    </div>
                    <button
                        onClick={() => setShowTxSheet(true)}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors"
                    >
                        <BarChart2 className="h-4 w-4" /> View Transaction Data
                    </button>
                </div>
            ) : (
                <TransactionSheet
                    brandId={brandId}
                    agentId={agentId}
                    filename={file.filename}
                    reconciliation={reconciliation}
                />
            )}

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
                            <p className="text-2xl font-bold text-slate-900">{fmtFull(totalSettled)}</p>
                            <p className="text-xs text-slate-400">{reconciliation.reconciled.toLocaleString()} Orders Matched</p>
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

            {/* ── Party Composition (Courier Breakdown) ── */}
            <div className="bg-white border border-slate-200 rounded-xl p-5">
                <h3 className="text-sm font-bold text-slate-800 mb-4">Party Composition</h3>
                <div className="grid grid-cols-5 gap-6">
                    {/* Donut */}
                    <div className="col-span-2 flex items-center justify-center">
                        {couriers.length > 0 ? (
                            <SegmentDonut
                                segments={couriers.slice(0, 8).map((c, i) => ({
                                    value: c.sales,
                                    color: ['#6366f1','#f59e0b','#10b981','#ef4444','#3b82f6','#8b5cf6','#ec4899','#64748b'][i % 8],
                                    name: c.name,
                                }))}
                                size={180} stroke={24}
                            />
                        ) : (
                            <div className="text-slate-300 text-sm">No courier data</div>
                        )}
                    </div>

                    {/* Table */}
                    <div className="col-span-3">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-slate-100">
                                    <th className="text-left text-[10px] font-bold text-slate-400 uppercase tracking-wider pb-2">Courier</th>
                                    <th className="text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider pb-2">Orders</th>
                                    <th className="text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider pb-2">Sales</th>
                                    <th className="text-right text-[10px] font-bold text-slate-400 uppercase tracking-wider pb-2">Share</th>
                                </tr>
                            </thead>
                            <tbody>
                                {couriers.length === 0 ? (
                                    <tr><td colSpan={4} className="text-center text-slate-400 text-sm py-6">No data</td></tr>
                                ) : couriers.map((c, i) => {
                                    const color = ['#6366f1','#f59e0b','#10b981','#ef4444','#3b82f6','#8b5cf6','#ec4899','#64748b'][i % 8];
                                    return (
                                        <tr key={c.name} className="border-b border-slate-50 hover:bg-slate-50/50">
                                            <td className="py-2.5">
                                                <div className="space-y-1">
                                                    <span className="capitalize font-medium text-slate-700">{c.name}</span>
                                                    <div className="h-1 rounded-full bg-slate-100 overflow-hidden w-full max-w-[120px]">
                                                        <div className="h-full rounded-full" style={{ width: `${c.share}%`, background: color }} />
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="py-2.5 text-right text-slate-700 font-medium">
                                                {c.orders.toLocaleString()}
                                            </td>
                                            <td className="py-2.5 text-right text-slate-700 font-medium">
                                                {fmtFull(c.sales)}
                                            </td>
                                            <td className="py-2.5 text-right">
                                                <span className="text-slate-500 font-semibold">{c.share}%</span>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            {/* ── Status Breakdown Cards ── */}
            <div className="grid grid-cols-4 gap-3">
                {[
                    { label: 'Reconciled',    value: reconciliation.reconciled, color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-100', icon: CheckCircle2 },
                    { label: 'Pending',       value: reconciliation.pending,    color: 'text-amber-600',   bg: 'bg-amber-50',   border: 'border-amber-100',   icon: TrendingUp },
                    { label: 'Overpaid',      value: reconciliation.overpaid,   color: 'text-purple-600',  bg: 'bg-purple-50',  border: 'border-purple-100',  icon: TrendingDown },
                    { label: 'RTO',           value: reconciliation.rto,        color: 'text-red-600',     bg: 'bg-red-50',     border: 'border-red-100',     icon: XCircle },
                ].map(({ label, value, color, bg, border, icon: Icon }) => (
                    <div key={label} className={`${bg} border ${border} rounded-xl p-4`}>
                        <div className="flex items-center gap-2 mb-1">
                            <Icon className={`h-4 w-4 ${color}`} />
                            <p className="text-xs font-semibold text-slate-500">{label}</p>
                        </div>
                        <p className={`text-2xl font-bold ${color}`}>{value.toLocaleString()}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                            {reconciliation.total > 0 ? `${Math.round(value / reconciliation.total * 100)}%` : '—'} of total
                        </p>
                    </div>
                ))}
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

    const fetchFiles = useCallback(async () => {
        setFilesLoading(true);
        try {
            const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/files`);
            setFiles(res.data || []);
        } catch { setFiles([]); }
        finally { setFilesLoading(false); }
    }, [brandId, agentId]);

    useEffect(() => { fetchFiles(); }, [fetchFiles]);

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
            if (viewingFile?.filename === filename) setViewingFile(null);
            fetchFiles();
        } catch { toast.error('Delete failed'); }
    };

    const totalRows  = files.reduce((s, f) => s + (f.row_count || 0), 0);
    const latestFile = files[0] || null;
    const stepLabels = ['Select Partners', 'Upload Files', 'Preview & Save'];

    // ─── Visualization view ───────────────────────────────────────────────────
    if (viewingFile) {
        return (
            <ReconciliationView
                file={viewingFile}
                brandId={brandId}
                agentId={agentId}
                onBack={() => setViewingFile(null)}
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
                    <p className="text-sm text-slate-500 mt-0.5">{agent?.name} · Shopify Order Cycle</p>
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
                    { label: 'Total Rows',     value: filesLoading ? '—' : totalRows.toLocaleString(),  sub: 'Orders processed' },
                    { label: 'Latest Report',  value: latestFile ? `${monthNumToName(latestFile.month)} ${latestFile.year}` : '—', sub: latestFile ? formatDate(latestFile.created_at) : 'No reports yet', small: true },
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
                                            <Calendar className="h-3.5 w-3.5 text-slate-400" />
                                            <span className="text-slate-700 font-medium">{monthNumToName(file.month)} {file.year}</span>
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
                                                onClick={() => setViewingFile(file)}
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

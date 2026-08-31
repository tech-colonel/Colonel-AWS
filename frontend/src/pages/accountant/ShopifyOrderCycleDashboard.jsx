import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    Loader2, ArrowLeft, Download, Search, Calendar, ChevronRight,
    LayoutGrid, X, Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import api from '../../lib/api';
import { loadOcDateRange, saveOcDateRange, monthRangeToIso } from '../../lib/ocDateRange';

// ─── Constants ───────────────────────────────────────────────────────────────
const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const NAV_TABS = ['Shopify', 'Operations', 'Marketplaces'];
const LIVE_TABS = new Set(['Shopify', 'Operations', 'Marketplaces']);

const EXACT_BUCKETS = ['0D', '1D', '2D', '3D', '4D', '5D', '6-8D', '9-12D', '13-18D', '19+D'];
const RANGE_BUCKETS = ['0-2D', '3-5D', '6-8D', '9-12D', '13-18D', '19+D'];

// KPI catalogue per section+sub-tab. `drill` = the transaction metric a cell maps to.
const KPIS = {
    // Operations
    delivery: [
        { key: 'totalOrders', label: 'Total Orders', kind: 'count', drill: 'totalOrders' },
        { key: 'dispatched', label: 'Dispatched', kind: 'count', drill: 'dispatched' },
        { key: 'delivered', label: 'Delivered', kind: 'count', drill: 'delivered' },
        { key: 'notDelivered', label: 'Not Delivered', kind: 'count', drill: 'notDelivered' },
        { key: 'rto', label: 'RTO', kind: 'count', drill: 'rto' },
        { key: 'cancelled', label: 'Cancelled', kind: 'count', drill: 'cancelled' },
        { key: 'deliveredPct', label: 'Delivered %', kind: 'pct', drill: 'delivered' },
        { key: 'netAmount', label: 'Net Amount', kind: 'money', drill: 'totalOrders' },
    ],
    settlements: [
        { key: 'totalOrders', label: 'Total Orders', kind: 'count', drill: 'totalOrders' },
        { key: 'settledOrders', label: 'Settled', kind: 'count', drill: 'settled' },
        { key: 'unsettledOrders', label: 'Unsettled', kind: 'count', drill: 'unsettled' },
        { key: 'settledPct', label: 'Settled %', kind: 'pct', drill: 'settled' },
        { key: 'settlementAmount', label: 'Settlement Amount', kind: 'money', drill: 'settled' },
        { key: 'pendingAmount', label: 'Pending Amount', kind: 'money', drill: 'unsettled' },
        { key: 'grossAmount', label: 'Gross Amount', kind: 'money', drill: 'totalOrders' },
    ],
    // Shopify / Marketplaces — P&L
    pnl: [
        { key: 'grossSales', label: 'Gross Sales', kind: 'money', drill: 'orders' },
        { key: 'returns', label: 'Returns', kind: 'money', drill: 'returns' },
        { key: 'netSales', label: 'Net Sales', kind: 'money', drill: 'orders' },
        { key: 'returnPct', label: 'Return %', kind: 'pct', drill: 'returns' },
        { key: 'orders', label: 'Orders', kind: 'count', drill: 'orders' },
        { key: 'aov', label: 'AOV', kind: 'money', drill: 'orders' },
        { key: 'cancelledOrders', label: 'Cancelled Orders', kind: 'count', drill: 'cancelledOrders' },
        { key: 'cancelledAmount', label: 'Cancelled Amount', kind: 'money', drill: 'cancelledOrders' },
        { key: 'settledAmount', label: 'Settled Amount', kind: 'money', drill: 'settledAmount' },
        { key: 'receivableAmount', label: 'Receivable (Balance)', kind: 'money', drill: 'receivableAmount' },
    ],
    // Shopify / Marketplaces — Recovery
    recovery: [
        { key: 'netSales', label: 'Net Sales', kind: 'money', drill: 'orders' },
        { key: 'settledAmount', label: 'Settled Amount', kind: 'money', drill: 'settledAmount' },
        { key: 'receivableAmount', label: 'Receivable (Balance)', kind: 'money', drill: 'receivableAmount' },
        { key: 'settledPct', label: 'Settled %', kind: 'pct', drill: 'settledAmount' },
        { key: 'advanceOrders', label: 'Advance Orders', kind: 'count', drill: 'advanceOrders' },
        { key: 'advanceAmount', label: 'Advance Amount', kind: 'money', drill: 'advanceOrders' },
        { key: 'payableOrders', label: 'Payable Orders', kind: 'count', drill: 'payableOrders' },
        { key: 'payableAmount', label: 'Payable Amount', kind: 'money', drill: 'payableOrders' },
        { key: 'overpaidAmount', label: 'Overpaid Amount', kind: 'money', drill: 'overpaidAmount' },
    ],
};

const AGING_TABLES = {
    delivery: [
        { agingOf: 'delivered', title: 'Delivered — days from dispatch', buckets: EXACT_BUCKETS },
        { agingOf: 'notDelivered', title: 'Not Delivered — ageing (as of period end)', buckets: RANGE_BUCKETS },
    ],
    settlements: [
        { agingOf: 'settled', title: 'Settled — days from dispatch', buckets: EXACT_BUCKETS },
        { agingOf: 'unsettled', title: 'Unsettled — ageing (as of period end)', buckets: RANGE_BUCKETS },
    ],
};

// ─── Section configuration ──────────────────────────────────────────────────
const SECTIONS = {
    Shopify: {
        path: 'shopify',
        groupHeader: 'Payment Method',
        subtabs: [{ key: 'pnl', label: 'P&L' }, { key: 'recovery', label: 'Recovery' }],
        defaultKpi: { pnl: 'grossSales', recovery: 'receivableAmount' },
        aging: false,
    },
    Operations: {
        path: 'operations',
        groupHeader: 'Courier / Payment',
        subtabs: [{ key: 'delivery', label: 'Dispatch → Delivery' }, { key: 'settlements', label: 'Settlements' }],
        defaultKpi: { delivery: 'totalOrders', settlements: 'settledOrders' },
        aging: true,
    },
    Marketplaces: {
        path: 'marketplaces',
        groupHeader: 'Channel',
        subtabs: [{ key: 'pnl', label: 'Channel P&L' }, { key: 'recovery', label: 'Channel Recovery' }],
        defaultKpi: { pnl: 'netSales', recovery: 'receivableAmount' },
        aging: false,
        caveat: 'Settlement reconciliation in this agent covers Shopify COD/prepaid flows only. Marketplace payouts (Amazon/Flipkart/Zepto/…) are not tracked here, so "Settled" reads low and "Receivable" reads high for those channels — treat the P&L (Gross → Returns → Net) columns as the reliable ones.',
    },
};

const GROUP_COLOR = {
    Delhivery: '#6366f1', Xpressbees: '#f59e0b', Ekart: '#10b981', Bluedart: '#ef4444',
    DTDC: '#0ea5e9', 'Self Ship': '#a855f7', ATS: '#14b8a6', Other: '#64748b', Unknown: '#94a3b8',
    COD: '#f59e0b', Prepaid: '#3b82f6',
    Shopify: '#22c55e', Amazon: '#ff9900', Flipkart: '#2874f0', Zepto: '#7c3aed',
    Blinkit: '#f7cb45', Cred: '#111827', Pepperfry: '#e14eca', Woodenstreet: '#8b5cf6',
    Snapmint: '#8b5cf6', Influencers: '#ec4899', 'Custom / Adjustments': '#94a3b8',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtDate(d) {
    if (!d) return '—';
    try { return format(new Date(d), 'dd MMM yyyy'); } catch { return String(d); }
}
function fmtFull(n) {
    if (n === null || n === undefined || n === '') return '—';
    return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function fmtINR(n) {
    if (n === null || n === undefined) return '—';
    const abs = Math.abs(n);
    let s;
    if (abs >= 1e7) s = (n / 1e7).toFixed(2) + ' Cr';
    else if (abs >= 1e5) s = (n / 1e5).toFixed(2) + ' L';
    else s = abs.toLocaleString('en-IN', { maximumFractionDigits: 0 });
    return `₹${n < 0 ? '-' : ''}${s}`;
}
function monthLabel(mk) {
    if (!mk) return '';
    const [y, m] = mk.split('-');
    return `${MON_SHORT[parseInt(m, 10) - 1]} ${String(y).slice(2)}`;
}
function isoToMY(iso) {
    if (!iso) return null;
    const [y, m] = iso.split('-');
    return { month: parseInt(m, 10), year: parseInt(y, 10) };
}
function fmtCell(v, kind) {
    if (v === null || v === undefined) return '—';
    if (kind === 'money') return fmtINR(v);
    if (kind === 'pct') return `${v}%`;
    return Number(v).toLocaleString('en-IN');
}
// Normalise an operations group ({courier,paymentMethod}) or a P&L group ({group}) to one label
const groupLabelOf = (g) => (g.group != null ? g.group : `${g.courier} · ${g.paymentMethod}`);
const groupColorOf = (g) => GROUP_COLOR[g.courier || g.group] || '#94a3b8';

// ─── Period picker ──────────────────────────────────────────────────────────
function MonthYearPair({ label, m, y, years, onM, onY }) {
    return (
        <div className="flex items-center gap-2.5">
            <Calendar className="w-4 h-4 flex-shrink-0" style={{ color: '#1e3a8a' }} />
            <p className="text-xs font-bold whitespace-nowrap text-slate-800">{label}</p>
            <div className="flex items-center gap-1.5">
                <select value={m ?? ''} onChange={e => onM(Number(e.target.value))}
                    className="text-sm font-semibold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-800">
                    {MONTHS.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
                </select>
                <select value={y ?? ''} onChange={e => onY(Number(e.target.value))}
                    className="text-sm font-semibold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-800">
                    {years.map(yr => <option key={yr} value={yr}>{yr}</option>)}
                </select>
            </div>
        </div>
    );
}

// ─── Summary table (shared by all sections) ─────────────────────────────────
function SummaryTable({ data, kpiList, kpi, setKpi, groupHeader, onCell }) {
    const active = kpiList.find(k => k.key === kpi) || kpiList[0];
    const months = data.months || [];

    const monthlyTotals = {};
    for (const mk of months) {
        let sum = 0;
        for (const g of data.groups) sum += Number(g.monthly[mk]?.[active.key] || 0);
        monthlyTotals[mk] = active.kind === 'pct' ? null : Math.round(sum * 100) / 100;
    }

    const Row = ({ label, color, g, monthly, isTotal }) => {
        const curTotal = g.metrics[active.key];
        return (
            <tr className={isTotal ? 'bg-slate-50 font-bold' : 'hover:bg-slate-50/60'}>
                <td className="px-3 py-2 whitespace-nowrap text-left">
                    <span className="inline-flex items-center gap-2">
                        {!isTotal && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />}
                        <span className="font-semibold text-slate-700">{label}</span>
                    </span>
                </td>
                {months.map(mk => {
                    const v = monthly ? monthly[mk]?.[active.key] : undefined;
                    return (
                        <td key={mk} className="px-3 py-2 text-right tabular-nums">
                            <button className="hover:underline decoration-dotted disabled:no-underline disabled:text-slate-300"
                                disabled={!v} onClick={() => v && onCell({ g, month: mk, kpi: active })}>
                                {fmtCell(v, active.kind)}
                            </button>
                        </td>
                    );
                })}
                <td className="px-3 py-2 text-right tabular-nums font-semibold border-l border-slate-200">
                    <button className="hover:underline decoration-dotted disabled:no-underline disabled:text-slate-300"
                        disabled={!curTotal} onClick={() => curTotal && onCell({ g, month: null, kpi: active })}>
                        {fmtCell(curTotal, active.kind)}
                    </button>
                </td>
            </tr>
        );
    };

    return (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
                <div>
                    <h3 className="text-sm font-bold text-slate-800">Summary by {groupHeader}</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Monthly columns · click any number to drill into the orders</p>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-500">KPI</span>
                    <select value={kpi} onChange={e => setKpi(e.target.value)}
                        className="text-sm font-semibold px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-800">
                        {kpiList.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
                    </select>
                </div>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                            <th className="px-3 py-2.5 text-left">{groupHeader}</th>
                            {months.map(mk => <th key={mk} className="px-3 py-2.5 text-right whitespace-nowrap">{monthLabel(mk)}</th>)}
                            <th className="px-3 py-2.5 text-right border-l border-slate-200 whitespace-nowrap">Current Total</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {data.groups.map(g => (
                            <Row key={groupLabelOf(g)} label={groupLabelOf(g)} color={groupColorOf(g)} g={g} monthly={g.monthly} />
                        ))}
                        {data.totalsRow && (
                            <Row label="All" isTotal g={data.totalsRow}
                                monthly={months.reduce((o, mk) => (o[mk] = { [active.key]: monthlyTotals[mk] }, o), {})} />
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ─── Aging tables (Operations only) ────────────────────────────────────────
function AgingTables({ data, subtab, onCell }) {
    return (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {AGING_TABLES[subtab].map(tbl => (
                <div key={tbl.agingOf} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-5 py-3.5 border-b border-slate-100">
                        <h3 className="text-sm font-bold text-slate-800">{tbl.title}</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                    <th className="px-3 py-2.5 text-left">Courier / Payment</th>
                                    {tbl.buckets.map(b => <th key={b} className="px-3 py-2.5 text-right whitespace-nowrap">{b}</th>)}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {data.groups.map(g => {
                                    const cells = g.aging?.[tbl.agingOf] || {};
                                    return (
                                        <tr key={groupLabelOf(g)} className="hover:bg-slate-50/60">
                                            <td className="px-3 py-2 whitespace-nowrap">
                                                <span className="inline-flex items-center gap-2">
                                                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: groupColorOf(g) }} />
                                                    <span className="font-semibold text-slate-700">{groupLabelOf(g)}</span>
                                                </span>
                                            </td>
                                            {tbl.buckets.map(b => {
                                                const v = cells[b] || 0;
                                                return (
                                                    <td key={b} className="px-3 py-2 text-right tabular-nums">
                                                        <button className="hover:underline decoration-dotted disabled:no-underline disabled:text-slate-300"
                                                            disabled={!v} onClick={() => v && onCell({ g, agingOf: tbl.agingOf, bucket: b })}>
                                                            {v || '—'}
                                                        </button>
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            ))}
        </div>
    );
}

// ─── Drill-down row (source attribution) ────────────────────────────────────
function kvRow(k, v) {
    return (
        <div key={k} className="flex justify-between items-start gap-2 py-1 border-b border-slate-50 last:border-0">
            <span className="text-[10px] text-slate-400 shrink-0 leading-relaxed">{k}</span>
            <span className="text-[11px] text-right text-slate-700 leading-relaxed">{v != null && v !== '' ? v : '—'}</span>
        </div>
    );
}
function DrillRow({ row }) {
    const toNum = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
    const sc = row.scenario || {};
    const ekAmt = toNum(row.ekart_cod_amount);
    const delAmt = toNum(row.delhivery_cod_amount);
    const xpAmt = toNum(row.xpressbees_net_payment);
    const snAmt = toNum(row.snapmint_settlement_value);
    const bhAmt = toNum(row.bharatx_ledger_amount);
    const rzAmt = toNum(row.razorpay_settlement_amount);
    const totalSettled = toNum(row.total_settlement_received);
    const bal = toNum(row.balance_amount_receivable);
    const courierName = sc.courier || row.courier_group || 'Courier';
    const gatewayName = sc.settledSource && !['Ekart', 'Delhivery', 'Xpressbees'].includes(sc.settledSource)
        ? sc.settledSource : (snAmt ? 'Snapmint' : bhAmt ? 'BharatX' : rzAmt ? 'Razorpay' : 'Gateway');

    const panel = (dot, label, file, children) => (
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
                        {panel('#2a78d6', 'Tally GST', 'Export-Tally GST Report', <>
                            {kvRow('Invoice No.', row.invoice_number)}
                            {kvRow('Channel', row.channel_group || row.platform)}
                            {kvRow('AWB No.', row.awb_number)}
                            {kvRow('Dispatch Date', fmtDate(row.dispatch_or_cancellation_date))}
                            {kvRow('Order Value', fmtFull(row.total_amount))}
                        </>)}
                        {panel('#b45309', 'Return GST', 'Return GST Report', <>
                            {kvRow('Return Date', fmtDate(row.return_date))}
                            {kvRow('SRN', row.srn)}
                            {kvRow('SRN Status', sc.srnStatus || '—')}
                            {kvRow('Return Amount', fmtFull(row.return_amount))}
                            {kvRow('Net Amount', fmtFull(row.net_amount))}
                        </>)}
                        {panel('#1baf7a', courierName, `${courierName} settlement report`, <>
                            {kvRow('Join Key (AWB)', row.awb_number)}
                            {ekAmt > 0 && <>{kvRow('Remittance Date', fmtDate(row.ekart_remittance_date))}{kvRow('Actual Date', fmtDate(row.ekart_actual_remittance_date))}{kvRow('COD Amount', fmtFull(ekAmt))}</>}
                            {delAmt > 0 && <>{kvRow('Delivery Date', fmtDate(row.delhivery_delivery_date))}{kvRow('COD Amount', fmtFull(delAmt))}</>}
                            {xpAmt > 0 && <>{kvRow('Delivery Date', fmtDate(row.xpressbees_delivery_date))}{kvRow('Txn Date', fmtDate(row.xpressbees_transaction_date))}{kvRow('Net Payment', fmtFull(xpAmt))}</>}
                            {ekAmt === 0 && delAmt === 0 && xpAmt === 0 && kvRow('Amount', '— No record found')}
                            {kvRow('Delivery Status', row.delivery_status || '—')}
                        </>)}
                        {panel('#7c3aed', gatewayName, `${gatewayName} settlement report`, <>
                            {kvRow('Payment', sc.paymentMethod || row.payment_method || '—')}
                            {snAmt !== 0 && <>{kvRow('Join Key (Order No.)', row.sale_order_number)}{kvRow('Settlement Date', fmtDate(row.snapmint_settlement_date))}{kvRow('Settlement Value', fmtFull(snAmt))}</>}
                            {bhAmt !== 0 && <>{kvRow('Join Key (Order ID)', row.sale_order_number)}{kvRow('Settlement Date', fmtDate(row.bharatx_settlement_timestamp))}{kvRow('Ledger Amount', fmtFull(bhAmt))}</>}
                            {rzAmt !== 0 && <>{kvRow('receipt → SO', row.sale_order_number)}{kvRow('Settlement Date', fmtDate(row.razorpay_settlement_date))}{kvRow('Amount', fmtFull(rzAmt))}</>}
                            {snAmt === 0 && bhAmt === 0 && rzAmt === 0 && kvRow('Settlement', '— No gateway record')}
                            {sc.refundDue > 0 && kvRow('Refund Due', fmtFull(sc.refundDue))}
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
                    </div>
                </div>
            </td>
        </tr>
    );
}

// ─── Drill-down panel ──────────────────────────────────────────────────────
function DrillPanel({ brandId, agentId, sectionPath, period, filter, onClose }) {
    const [rows, setRows] = useState([]);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [expanded, setExpanded] = useState(null);
    const [downloading, setDownloading] = useState(false);

    useEffect(() => { setPage(1); }, [filter]);
    useEffect(() => {
        const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 350);
        return () => clearTimeout(t);
    }, [searchInput]);

    const qs = useMemo(() => {
        const p = new URLSearchParams({
            fromMonth: period.fromM, fromYear: period.fromY, toMonth: period.toM, toYear: period.toY,
            paymentMethod: filter.paymentMethod || 'all',
        });
        if (filter.courier) p.set('courier', filter.courier);
        if (filter.channel) p.set('channel', filter.channel);
        if (filter.month) p.set('month', filter.month);
        if (filter.agingOf) { p.set('agingOf', filter.agingOf); if (filter.bucket) p.set('bucket', filter.bucket); }
        else p.set('metric', filter.metric || 'orders');
        return p;
    }, [period, filter]);

    useEffect(() => {
        let cancel = false;
        setLoading(true);
        const p = new URLSearchParams(qs);
        p.set('page', page); p.set('pageSize', 50);
        if (search) p.set('search', search);
        api.get(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/shopify-dashboard/${sectionPath}/transactions?${p}`)
            .then(r => { if (cancel) return; setRows(r.data.rows); setTotal(r.data.total); setTotalPages(r.data.totalPages); setExpanded(null); })
            .catch(() => { if (!cancel) setRows([]); })
            .finally(() => { if (!cancel) setLoading(false); });
        return () => { cancel = true; };
    }, [qs, page, search, brandId, agentId, sectionPath]);

    async function handleDownload() {
        setDownloading(true);
        try {
            const p = new URLSearchParams(qs);
            if (search) p.set('search', search);
            const res = await api.get(
                `/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/shopify-dashboard/${sectionPath}/download?${p}`,
                { responseType: 'blob' });
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const a = document.createElement('a'); a.href = url;
            a.setAttribute('download', `shopify_dashboard_${sectionPath}.xlsx`);
            document.body.appendChild(a); a.click(); a.remove();
            window.URL.revokeObjectURL(url);
            toast.success('Downloaded');
        } catch { toast.error('Download failed'); }
        finally { setDownloading(false); }
    }

    const chips = [
        filter.courier && filter.courier !== 'all' && `Courier: ${filter.courier}`,
        filter.channel && filter.channel !== 'all' && `Channel: ${filter.channel}`,
        filter.paymentMethod && filter.paymentMethod !== 'all' && `Payment: ${filter.paymentMethod}`,
        filter.month && `Month: ${monthLabel(filter.month)}`,
        filter.metric && !filter.agingOf && `Metric: ${filter.metricLabel || filter.metric}`,
        filter.agingOf && `Ageing: ${filter.agingOf} ${filter.bucket || ''}`,
    ].filter(Boolean);

    return (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="text-sm font-bold text-slate-800">Orders</h3>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {chips.map(c => <span key={c} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{c}</span>)}
                        <span className="text-[10px] text-slate-400 px-1">{total.toLocaleString()} orders</span>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
                        placeholder="Order ID, invoice, AWB…"
                        className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg bg-slate-50 w-48 focus:outline-none focus:border-slate-400" />
                    <button onClick={handleDownload} disabled={downloading}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-slate-200 rounded-lg bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-50">
                        {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Excel
                    </button>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="h-4 w-4" /></button>
                </div>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-16 gap-3 text-slate-400 text-sm">
                    <Loader2 className="h-5 w-5 animate-spin" /> Loading…
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                <th className="w-8 px-3 py-2.5" />
                                <th className="px-3 py-2.5 text-left">Order ID</th>
                                <th className="px-3 py-2.5 text-left">Invoice</th>
                                <th className="px-3 py-2.5 text-left">Channel</th>
                                <th className="px-3 py-2.5 text-right">Gross</th>
                                <th className="px-3 py-2.5 text-right">Return</th>
                                <th className="px-3 py-2.5 text-right">Net</th>
                                <th className="px-3 py-2.5 text-right">Settled</th>
                                <th className="px-3 py-2.5 text-right">Balance</th>
                                <th className="px-3 py-2.5 text-left">Order Date</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.length === 0 ? (
                                <tr><td colSpan={10} className="text-center text-slate-400 py-10">No orders</td></tr>
                            ) : rows.map(row => {
                                const id = row.id || row.sale_order_number;
                                const isExp = expanded === id;
                                const bal = Number(row.balance_amount_receivable) || 0;
                                return (
                                    <React.Fragment key={id}>
                                        <tr className={`border-b border-slate-100 cursor-pointer ${isExp ? 'bg-indigo-50/30' : 'hover:bg-slate-50/60'}`}
                                            onClick={() => setExpanded(isExp ? null : id)}>
                                            <td className="px-3 py-2.5"><ChevronRight className={`h-3.5 w-3.5 text-slate-400 transition-transform ${isExp ? 'rotate-90' : ''}`} /></td>
                                            <td className="px-3 py-2.5 font-semibold text-slate-800 whitespace-nowrap">{row.sale_order_number || '—'}</td>
                                            <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{row.invoice_number || '—'}</td>
                                            <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{row.channel_group || row.platform || '—'}</td>
                                            <td className="px-3 py-2.5 text-right tabular-nums">{fmtFull(row.total_amount)}</td>
                                            <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{Number(row.return_amount) ? fmtFull(row.return_amount) : '—'}</td>
                                            <td className="px-3 py-2.5 text-right tabular-nums">{fmtFull(row.net_amount)}</td>
                                            <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{Number(row.total_settlement_received) ? fmtFull(row.total_settlement_received) : '—'}</td>
                                            <td className="px-3 py-2.5 text-right tabular-nums">
                                                <span className={bal === 0 ? 'text-emerald-600' : bal > 0 ? 'text-amber-600' : 'text-purple-600'}>{fmtFull(bal)}</span>
                                            </td>
                                            <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{fmtDate(row.dispatch_or_cancellation_date)}</td>
                                        </tr>
                                        {isExp && <DrillRow row={row} />}
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100">
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
                </div>
            )}
        </div>
    );
}

// ─── Main ───────────────────────────────────────────────────────────────────
export default function ShopifyOrderCycleDashboard() {
    const { brandId, agentId } = useParams();
    const navigate = useNavigate();

    const [sectionName, setSectionName] = useState('Operations');
    const section = SECTIONS[sectionName];
    const [subtab, setSubtab] = useState(section.subtabs[0].key);
    const [paymentMode, setPaymentMode] = useState('all');
    const [kpi, setKpi] = useState(section.defaultKpi[section.subtabs[0].key]);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    const [drill, setDrill] = useState(null);

    const [applied, setApplied] = useState(null);
    const [draft, setDraft] = useState(null);
    const [availRange, setAvailRange] = useState(null);

    // switching section → reset sub-tab + kpi + drill, keep the period
    function switchSection(name) {
        if (!SECTIONS[name]) return;
        setSectionName(name);
        const st = SECTIONS[name].subtabs[0].key;
        setSubtab(st);
        setKpi(SECTIONS[name].defaultKpi[st]);
        setDrill(null);
    }
    function switchSubtab(st) {
        setSubtab(st);
        setKpi(section.defaultKpi[st]);
        setDrill(null);
    }

    // first load for a section (no period params) → seed the picker from availableRange
    useEffect(() => {
        let cancel = false;
        setLoading(true); setErr(null); setData(null); setAvailRange(null); setApplied(null); setDraft(null);
        api.get(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/shopify-dashboard/${section.path}?subtab=${subtab}&paymentMethod=${paymentMode}`)
            .then(r => {
                if (cancel) return;
                setData(r.data);
                if (r.data.availableRange?.from) {
                    setAvailRange(r.data.availableRange);
                    // prefer the session-shared range (set on this dashboard or the
                    // Reconciliation view); fall back to this section's own full span
                    const saved = loadOcDateRange(brandId, agentId);
                    const src = saved || r.data.currentRange;
                    const from = isoToMY(src.from), to = isoToMY(src.to);
                    const seed = {
                        fromM: from.month, fromY: from.year, toM: to.month, toY: to.year,
                    };
                    setApplied(seed); setDraft(seed);
                }
                setLoading(false);
            })
            .catch(e => { if (!cancel) { setErr(e.response?.data?.error || 'Failed to load'); setLoading(false); } });
        return () => { cancel = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [brandId, agentId, section.path]);

    // subsequent loads — applied period / subtab / paymentMode
    useEffect(() => {
        if (!applied) return;
        let cancel = false;
        setLoading(true); setErr(null); setDrill(null);
        const p = new URLSearchParams({
            subtab, paymentMethod: paymentMode,
            fromMonth: applied.fromM, fromYear: applied.fromY, toMonth: applied.toM, toYear: applied.toY,
        });
        api.get(`/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/shopify-dashboard/${section.path}?${p}`)
            .then(r => { if (!cancel) { setData(r.data); setLoading(false); } })
            .catch(e => { if (!cancel) { setErr(e.response?.data?.error || 'Failed to load'); setLoading(false); } });
        return () => { cancel = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [applied, subtab, paymentMode, section.path, brandId, agentId]);

    const kpiList = KPIS[subtab];
    useEffect(() => {
        if (kpiList && !kpiList.some(k => k.key === kpi)) setKpi(kpiList[0].key);
    }, [kpiList, kpi]);

    const years = useMemo(() => {
        if (!availRange?.from) { const y = new Date().getFullYear(); return [y, y - 1, y - 2]; }
        const lo = parseInt(availRange.from.slice(0, 4)) - 1;
        const hi = parseInt(availRange.to.slice(0, 4)) + 1;
        const out = []; for (let y = hi; y >= lo; y--) out.push(y); return out;
    }, [availRange]);

    const isDirty = applied && draft && JSON.stringify(applied) !== JSON.stringify(draft);
    const rangeInvalid = draft && (draft.fromY * 12 + draft.fromM) > (draft.toY * 12 + draft.toM);

    function cellToFilter({ g, month, kpi: k }) {
        // group dimension differs by section: Operations → courier×payment,
        // Shopify → payment method, Marketplaces → channel.
        const f = {
            paymentMethod: g.paymentMethod
                || (section.path === 'shopify' && g.group ? g.group : paymentMode),
            month: month || null,
            metric: k.drill,
            metricLabel: k.label,
        };
        if (g.courier) f.courier = g.courier;
        if (section.path === 'marketplaces' && g.group) f.channel = g.group;
        setDrill(f);
    }
    function agingCellToFilter({ g, agingOf, bucket }) {
        setDrill({
            courier: g.courier || 'all',
            paymentMethod: g.paymentMethod || paymentMode,
            agingOf, bucket,
        });
    }
    async function downloadFull() {
        try {
            const p = new URLSearchParams({
                subtab, paymentMethod: paymentMode,
                fromMonth: applied.fromM, fromYear: applied.fromY, toMonth: applied.toM, toYear: applied.toY,
            });
            const res = await api.get(
                `/api/brands/${brandId}/agents/${agentId}/order-cycle-shopify/shopify-dashboard/${section.path}/download?${p}`,
                { responseType: 'blob' });
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const a = document.createElement('a'); a.href = url;
            a.setAttribute('download', `shopify_dashboard_${section.path}.xlsx`);
            document.body.appendChild(a); a.click(); a.remove();
            window.URL.revokeObjectURL(url);
            toast.success('Downloaded');
        } catch { toast.error('Download failed'); }
    }

    const noData = !loading && data && !data.availableRange?.from;

    return (
        <div className="min-h-screen bg-slate-50">
            {/* Top nav */}
            <div className="text-white" style={{ background: '#1e293b' }}>
                <div className="max-w-[1600px] mx-auto px-6">
                    <div className="flex items-center gap-4 py-3">
                        <div className="flex items-center gap-2 font-bold text-lg">
                            <LayoutGrid className="h-5 w-5" /> Analytics Portal
                        </div>
                        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-white/10">Order Cycle</span>
                        <div className="ml-auto flex items-center gap-2">
                            <button onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(`/brands/${brandId}/agents/${agentId}`))}
                                className="inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20">
                                <ArrowLeft className="h-4 w-4" /> Back
                            </button>
                            <button onClick={downloadFull} disabled={!applied}
                                className="inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-lg bg-white text-slate-800 hover:bg-slate-100 disabled:opacity-50">
                                <Download className="h-4 w-4" /> Download Excel
                            </button>
                        </div>
                    </div>
                    <div className="flex items-center gap-1 -mb-px overflow-x-auto">
                        {NAV_TABS.map(t => {
                            const live = LIVE_TABS.has(t);
                            const active = t === sectionName;
                            return (
                                <button key={t} disabled={!live} onClick={() => live && switchSection(t)}
                                    className={`px-4 py-2.5 text-sm font-semibold whitespace-nowrap rounded-t-lg transition-colors
                                        ${active ? 'bg-slate-50 text-slate-900' : live ? 'text-white/80 hover:bg-white/10' : 'text-white/40 cursor-default'}`}>
                                    {t}
                                    {!live && <span className="ml-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-white/10">Soon</span>}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            <div className="max-w-[1600px] mx-auto px-6 py-6 space-y-5">
                {/* Sub-tabs */}
                <div className="flex items-center gap-2">
                    {section.subtabs.map(s => (
                        <button key={s.key} onClick={() => switchSubtab(s.key)}
                            className={`px-4 py-2 text-sm font-semibold rounded-lg border transition-colors
                                ${subtab === s.key ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}>
                            {s.label}
                        </button>
                    ))}
                </div>

                {section.caveat && (
                    <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
                        <Info className="h-4 w-4 shrink-0 mt-0.5" />
                        <span>{section.caveat}</span>
                    </div>
                )}

                {noData ? (
                    <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
                        <p className="text-sm font-semibold text-slate-700">No data for this section</p>
                        <p className="text-xs text-slate-400 mt-1">
                            {sectionName === 'Marketplaces'
                                ? 'No non-Shopify channel orders found in the saved reconciliation data.'
                                : 'Generate a reconciliation report in the Order Cycle agent first.'}
                        </p>
                        <button onClick={() => navigate(`/brands/${brandId}/agents/${agentId}`)}
                            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-700">
                            <ArrowLeft className="h-4 w-4" /> Go to agent
                        </button>
                    </div>
                ) : (
                    <>
                        {draft && (
                            <div className="flex items-center justify-between flex-wrap gap-4 px-5 py-4 rounded-2xl"
                                style={{ background: '#1e3a8a08', border: '1px solid #1e3a8a25' }}>
                                <div className="flex items-center flex-wrap gap-x-6 gap-y-3">
                                    <MonthYearPair label="From" m={draft.fromM} y={draft.fromY} years={years}
                                        onM={v => setDraft(d => ({ ...d, fromM: v }))} onY={v => setDraft(d => ({ ...d, fromY: v }))} />
                                    <MonthYearPair label="To" m={draft.toM} y={draft.toY} years={years}
                                        onM={v => setDraft(d => ({ ...d, toM: v }))} onY={v => setDraft(d => ({ ...d, toY: v }))} />
                                    <div className="w-px h-9 hidden sm:block bg-slate-200" />
                                    <div className="flex items-center gap-2">
                                        <p className="text-xs font-bold text-slate-800">Payment</p>
                                        <select value={paymentMode} onChange={e => setPaymentMode(e.target.value)}
                                            className="text-sm font-semibold px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-800">
                                            <option value="all">All</option>
                                            <option value="COD">COD</option>
                                            <option value="Prepaid">Prepaid</option>
                                        </select>
                                    </div>
                                </div>
                                <button onClick={() => {
                                        if (rangeInvalid) return;
                                        setApplied(draft);
                                        saveOcDateRange(brandId, agentId,
                                            monthRangeToIso(draft.fromM, draft.fromY, draft.toM, draft.toY));
                                    }}
                                    disabled={!isDirty || rangeInvalid}
                                    title={rangeInvalid ? '"From" must be on or before "To"' : ''}
                                    className="flex items-center gap-1.5 text-sm font-bold px-4 py-2.5 rounded-xl transition-all"
                                    style={isDirty && !rangeInvalid
                                        ? { background: '#1e3a8a', color: '#fff' }
                                        : { background: '#fff', border: '1px solid #e2e8f0', color: '#94a3b8', cursor: 'default' }}>
                                    <Search className="w-4 h-4" /> Search
                                </button>
                            </div>
                        )}

                        {err ? (
                            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-sm text-red-500">{err}</div>
                        ) : loading || !data ? (
                            <div className="flex items-center justify-center py-24 gap-3 text-slate-400">
                                <Loader2 className="h-6 w-6 animate-spin" /> Loading…
                            </div>
                        ) : (
                            <>
                                <SummaryTable data={data} kpiList={kpiList} kpi={kpi} setKpi={setKpi}
                                    groupHeader={section.groupHeader} onCell={cellToFilter} />
                                {section.aging && <AgingTables data={data} subtab={subtab} onCell={agingCellToFilter} />}
                                {drill && (
                                    <DrillPanel
                                        brandId={brandId} agentId={agentId} sectionPath={section.path}
                                        period={{ fromM: applied.fromM, fromY: applied.fromY, toM: applied.toM, toY: applied.toY }}
                                        filter={drill} onClose={() => setDrill(null)} />
                                )}
                            </>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  ArrowLeft, Wallet, PackageX, Clock, LayoutDashboard, Bot, Loader2, X, Info,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import api from '../../lib/api';
import { sidebarFor } from '../../lib/adminNav';
import PayablesSheetBrowser from '../../components/reco/PayablesSheetBrowser';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Same validated palette as the other dashboards (dataviz skill) — reused as-is.
const COLOR_RETURNED = '#E11D48';
const COLOR_PRIMARY = '#4F46E5';
const COLOR_SALES = '#0748EE';
const COLOR_COD = '#0EA5E9';
const COLOR_MARKETPLACE = '#D97706';

const cardStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--card-border)',
  borderRadius: '1rem',
};

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }));
const money = (n) => `₹${fmt(n)}`;
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

const currentDate = new Date();

const KpiCard = ({ label, value, sub, icon: Icon, color, highlight, onClick }) => (
  <div
    className="p-5 transition-all"
    style={{
      ...cardStyle,
      ...(highlight ? { border: `1.5px solid ${color}50`, background: `${color}08` } : {}),
      cursor: onClick ? 'pointer' : 'default',
    }}
    onClick={onClick}
    role={onClick ? 'button' : undefined}
  >
    <div className="flex items-center justify-between mb-3">
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center"
        style={{ background: `${color}18`, border: `1px solid ${color}30` }}
      >
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      {onClick && <span className="text-xs font-semibold" style={{ color }}>Details →</span>}
    </div>
    <p className="text-2xl font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>{value}</p>
    <p className="text-xs font-semibold mt-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
    {sub && <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>{sub}</p>}
  </div>
);

const Num = ({ children, color, onClick, bold }) => (
  <span
    onClick={onClick}
    className={onClick ? 'cursor-pointer hover:underline underline-offset-2' : ''}
    style={{ color, fontWeight: bold ? 900 : undefined }}
    role={onClick ? 'button' : undefined}
    title={onClick ? 'Click to see the orders behind this figure' : undefined}
  >
    {children}
  </span>
);

const FormulaNote = ({ children }) => (
  <div className="mt-4 px-3 py-2.5 rounded-lg flex items-start gap-2" style={{ background: 'var(--page-bg)', border: '1px solid var(--card-border)' }}>
    <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: 'var(--text-muted)' }} />
    <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{children}</p>
  </div>
);

const SectionCard = ({ title, icon: Icon, children, right }) => (
  <div style={cardStyle} className="p-5">
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />}
        <h3 className="text-sm font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>{title}</h3>
      </div>
      {right}
    </div>
    {children}
  </div>
);

const BreakdownTable = ({ columns, rows, keyField, labelFormatter, total, emptyLabel, onRowClick }) => (
  <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--card-border)' }}>
    <table className="w-full text-sm">
      <thead>
        <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
          {columns.map((h) => (
            <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r[keyField]}-${i}`} style={{ borderBottom: '1px solid var(--card-border)' }}>
            <td className="px-2 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
              {labelFormatter ? labelFormatter(r[keyField]) : r[keyField]}
            </td>
            <td className="px-2 py-2.5" style={{ color: 'var(--text-body)' }}>
              <Num color="var(--text-body)" onClick={onRowClick ? () => onRowClick(r) : undefined}>{Number(r.orders).toLocaleString('en-IN')}</Num>
            </td>
            <td className="px-2 py-2.5 whitespace-nowrap font-semibold">
              <Num color={COLOR_RETURNED} onClick={onRowClick ? () => onRowClick(r) : undefined}>{money(r.amount)}</Num>
            </td>
            <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.amount, total)}</td>
          </tr>
        ))}
        {!rows.length && (
          <tr><td colSpan={4} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>{emptyLabel}</td></tr>
        )}
      </tbody>
      {rows.length > 0 && (
        <tfoot>
          <tr>
            <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
            <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: 'var(--text-body)' }}>
              {rows.reduce((s, r) => s + Number(r.orders || 0), 0).toLocaleString('en-IN')}
            </td>
            <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_RETURNED }}>{money(total)}</td>
            <td />
          </tr>
        </tfoot>
      )}
    </table>
  </div>
);

const TrendTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}>
      <p className="font-bold mb-1" style={{ color: 'var(--text-heading)' }}>{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: <span className="font-semibold">{money(p.value)}</span>
        </p>
      ))}
    </div>
  );
};

const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, '0')} ${MONTHS[dt.getMonth() + 1]} ${dt.getFullYear()}`;
};

const MODAL_PAGE_SIZE = 20;

// The order-level list behind ANY figure on this dashboard — a KPI card, a
// breakdown-table row, or an aging bucket. Same population as
// PayablesSheetBrowser's own endpoint, just scoped to one dimension and shown
// as a modal instead of an inline panel.
const FilteredOrdersModal = ({ brandId, range, filters, title, subtitle, onClose }) => {
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!range) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      fromMonth: String(range.fromMonth), fromYear: String(range.fromYear),
      toMonth: String(range.toMonth), toYear: String(range.toYear),
      page: String(page), pageSize: String(MODAL_PAGE_SIZE),
    });
    if (filters?.source) params.set('source', filters.source);
    if (filters?.channel) params.set('channel', filters.channel);
    if (filters?.agingBucket) params.set('agingBucket', filters.agingBucket);
    api.get(`/api/dashboard/payables/${brandId}/sheet?${params.toString()}`)
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.error || 'Failed to load orders'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, range?.fromMonth, range?.fromYear, range?.toMonth, range?.toYear, filters?.source, filters?.channel, filters?.agingBucket, page]);

  useEffect(() => { setPage(1); }, [filters?.source, filters?.channel, filters?.agingBucket]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / MODAL_PAGE_SIZE)) : 1;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.55)' }} onClick={onClose}>
      <div
        className="w-fit min-w-[36rem] max-w-[94vw] rounded-2xl overflow-hidden flex flex-col"
        style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--card-border)' }}>
          <div>
            <h3 className="text-base font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>{title}</h3>
            {subtitle && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin" style={{ color: COLOR_RETURNED }} />
            </div>
          )}
          {!loading && error && (
            <p className="text-sm font-semibold py-8 text-center" style={{ color: COLOR_RETURNED }}>{error}</p>
          )}
          {!loading && !error && data && (
            <>
              <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--card-border)' }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                      {['Return date', 'Order #', 'Invoice #', 'Source', 'Channel', 'Amount payable'].map((h) => (
                        <th key={h} className="px-3 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => (
                      <tr key={`${r.order_number}-${r.awb}-${i}`} style={{ borderBottom: '1px solid var(--card-border)' }}>
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{fmtDate(r.return_date)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-medium" style={{ color: 'var(--text-heading)' }}>{r.order_number || '—'}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{r.invoice_number || '—'}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{r.source}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{r.channel}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-semibold" style={{ color: COLOR_RETURNED }}>{money(r.amount)}</td>
                      </tr>
                    ))}
                    {!data.rows.length && (
                      <tr><td colSpan={6} className="px-3 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No orders match this filter.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between mt-3">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {data.total.toLocaleString('en-IN')} order{data.total === 1 ? '' : 's'} · page {page} of {totalPages}
                </p>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="p-1.5 rounded-lg disabled:opacity-40"
                    style={{ background: 'var(--page-bg)', border: '1px solid var(--card-border)', color: 'var(--text-muted)' }}
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="p-1.5 rounded-lg disabled:opacity-40"
                    style={{ background: 'var(--page-bg)', border: '1px solid var(--card-border)', color: 'var(--text-muted)' }}
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const PayablesDashboard = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();

  const [fromMonth, setFromMonth] = useState(null);
  const [fromYear, setFromYear] = useState(null);
  const [toMonth, setToMonth] = useState(null);
  const [toYear, setToYear] = useState(null);
  const [initialized, setInitialized] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [ordersRequest, setOrdersRequest] = useState(null);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot },
  ]);

  const load = useCallback(async (fm, fy, tm, ty) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (fm && fy) { params.set('fromMonth', fm); params.set('fromYear', fy); }
      if (tm && ty) { params.set('toMonth', tm); params.set('toYear', ty); }
      const qs = params.toString();
      const res = await api.get(`/api/dashboard/payables/${brandId}${qs ? `?${qs}` : ''}`);
      setData(res.data);
      if (res.data?.range) {
        setFromMonth(res.data.range.fromMonth);
        setFromYear(res.data.range.fromYear);
        setToMonth(res.data.range.toMonth);
        setToYear(res.data.range.toYear);
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load payables dashboard');
    } finally {
      setLoading(false);
      setInitialized(true);
    }
  }, [brandId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!initialized) return;
    load(fromMonth, fromYear, toMonth, toYear);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromMonth, fromYear, toMonth, toYear]);

  const uniqueYears = useMemo(() => {
    const span = data?.availableRange;
    const y = currentDate.getFullYear();
    const lo = span ? Math.min(span.from.year, y - 1) : y - 4;
    const hi = span ? Math.max(span.to.year, y) : y + 1;
    const years = [];
    for (let i = lo; i <= hi; i++) years.push(i);
    return years.sort((a, b) => b - a);
  }, [data?.availableRange]);

  const k = data?.kpis || {};
  const bySource = data?.bySource || [];
  const byChannel = data?.byChannel || [];
  const byGatewayChannel = byChannel.filter((r) => r.source === 'Prepaid Gateway');
  const byCourierChannel = byChannel.filter((r) => r.source === 'COD');
  const byMarketplaceChannel = byChannel.filter((r) => r.source === 'Marketplace Prepaid');
  const aging = data?.aging || [];
  const range = (fromMonth && fromYear && toMonth && toYear) ? { fromMonth, fromYear, toMonth, toYear } : null;

  const trendByMonth = useMemo(() => {
    const map = new Map();
    (data?.monthlyTrend || []).forEach((r) => {
      const key = `${r.year}-${r.month}`;
      const row = map.get(key) || { label: `${MONTHS[r.month]} ${String(r.year).slice(2)}`, month: r.month, year: r.year, 'Prepaid Gateway': 0, COD: 0, 'Marketplace Prepaid': 0 };
      row[r.source] = Number(r.amount || 0);
      map.set(key, row);
    });
    return [...map.values()].sort((a, b) => (a.year * 12 + a.month) - (b.year * 12 + b.month));
  }, [data?.monthlyTrend]);

  const rangeLabel = range
    ? `${MONTHS[fromMonth]} ${fromYear} → ${MONTHS[toMonth]} ${toYear}`
    : '';

  const openOrders = useCallback((filters, title) => {
    setOrdersRequest({ filters, title, range });
  }, [range]);

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6 max-w-7xl space-y-6">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-sm group transition-colors"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
          Back
        </button>

        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center"
              style={{ background: `${COLOR_RETURNED}15`, border: `1px solid ${COLOR_RETURNED}30` }}
            >
              <Wallet className="w-5 h-5" style={{ color: COLOR_RETURNED }} />
            </div>
            <div>
              <h1 className="text-xl font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow', letterSpacing: '-0.02em' }}>
                Payables Dashboard
              </h1>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Cash already collected for orders that were then returned — a refund liability, not revenue
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => navigate(`/brands/${brandId}/receivables`)}
              className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg transition-colors"
              style={{ background: `${COLOR_SALES}12`, color: COLOR_SALES, border: `1px solid ${COLOR_SALES}30` }}
            >
              Receivable Dashboard →
            </button>
            <button
              onClick={() => navigate(`/brands/${brandId}/advance-amount`)}
              className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg transition-colors mr-1"
              style={{ background: `${COLOR_PRIMARY}12`, color: COLOR_PRIMARY, border: `1px solid ${COLOR_PRIMARY}30` }}
            >
              Advance Amount Dashboard →
            </button>
            <span className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>From</span>
            <select
              value={fromMonth ?? ''}
              onChange={(e) => setFromMonth(Number(e.target.value))}
              className="text-sm font-semibold px-3 py-2 rounded-lg"
              style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
            >
              {MONTH_NAMES.slice(1).map((name, i) => (
                <option key={name} value={i + 1}>{name}</option>
              ))}
            </select>
            <select
              value={fromYear ?? ''}
              onChange={(e) => setFromYear(Number(e.target.value))}
              className="text-sm font-semibold px-3 py-2 rounded-lg"
              style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
            >
              {uniqueYears.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <span className="text-xs font-bold" style={{ color: 'var(--text-muted)' }}>To</span>
            <select
              value={toMonth ?? ''}
              onChange={(e) => setToMonth(Number(e.target.value))}
              className="text-sm font-semibold px-3 py-2 rounded-lg"
              style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
            >
              {MONTH_NAMES.slice(1).map((name, i) => (
                <option key={name} value={i + 1}>{name}</option>
              ))}
            </select>
            <select
              value={toYear ?? ''}
              onChange={(e) => setToYear(Number(e.target.value))}
              className="text-sm font-semibold px-3 py-2 rounded-lg"
              style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
            >
              {uniqueYears.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: COLOR_RETURNED }} />
          </div>
        )}

        {!loading && error && (
          <div className="p-5 text-sm font-semibold" style={{ ...cardStyle, color: COLOR_RETURNED }}>{error}</div>
        )}

        {!loading && !error && !data?.kpis && (
          <div className="p-8 text-center" style={cardStyle}>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>
              No payable orders found for this brand yet — this needs at least one Prepaid Gateway advance order
              that was returned, one COD order that was collected and then returned, or one non-Shopify Prepaid
              (Marketplace) order that was collected and then returned.
            </p>
          </div>
        )}

        {!loading && !error && data?.kpis && (
          <>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              {rangeLabel} — returns in this range
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard
                label="Total payable"
                value={money(k.total_payable_amount)}
                sub="Cash already collected for returned orders — owed back, not earned revenue. Click for breakdown by source & channel"
                icon={Wallet} color={COLOR_RETURNED} highlight
                onClick={() => openOrders({}, 'All payable orders')}
              />
              <KpiCard
                label="Orders"
                value={Number(k.total_orders || 0).toLocaleString('en-IN')}
                sub="Returned orders with a refund liability in this range. Click for breakdown"
                icon={PackageX} color={COLOR_SALES}
                onClick={() => openOrders({}, 'All payable orders')}
              />
              <KpiCard
                label="Avg. days outstanding"
                value={Number(k.avg_days_pending || 0).toFixed(0)}
                sub="Average age of this liability since the return, in days"
                icon={Clock} color={COLOR_PRIMARY}
              />
              <KpiCard
                label="Oldest payable"
                value={`${Number(k.oldest_days_pending || 0).toLocaleString('en-IN')} days`}
                sub="Longest any single refund has been outstanding"
                icon={Clock} color={COLOR_RETURNED}
              />
            </div>

            <SectionCard title="Payable — by month of return" icon={Clock}>
              <div style={{ width: '100%', height: 280 }}>
                <ResponsiveContainer>
                  <LineChart data={trendByMonth} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--card-border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={{ stroke: 'var(--card-border)' }} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
                      tickFormatter={(v) => `₹${(v / 100000).toFixed(0)}L`} />
                    <Tooltip content={<TrendTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="Prepaid Gateway" stroke={COLOR_PRIMARY} strokeWidth={2.5} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="COD" stroke={COLOR_COD} strokeWidth={2.5} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="Marketplace Prepaid" stroke={COLOR_MARKETPLACE} strokeWidth={2.5} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>
                Payable amount grouped by the month the return happened, split by source.
              </p>
            </SectionCard>

            <SectionCard title="By source" icon={Wallet}>
              <BreakdownTable
                columns={['Source', 'Orders', 'Amount', 'Share']}
                rows={bySource} keyField="source"
                total={k.total_payable_amount}
                emptyLabel="No payable orders in this range."
                onRowClick={(r) => openOrders({
                  source: r.source === 'COD' ? 'cod' : r.source === 'Marketplace Prepaid' ? 'marketplace_prepaid' : 'prepaid',
                }, `${r.source} — payable`)}
              />
              <FormulaNote>
                <strong>Prepaid Gateway</strong>: a Snapmint/BharatX/Razorpay advance was collected before dispatch,
                then the order was returned — the gateway's own settlement amount is what must be reconciled back.
                <strong> COD</strong>: the courier actually remitted the cash to us on delivery, then the order was
                returned — only this collected-then-returned subset counts; a COD order returned before it was ever
                collected (a plain RTO) has zero payable liability and isn't included here.
                <strong> Marketplace Prepaid</strong>: a non-Shopify channel (Amazon/Flipkart/Zepto/etc.) prepaid
                order that Tally already booked as settled, then returned — same collected-then-returned rule as
                COD, just without a courier remittance step in between.
              </FormulaNote>
            </SectionCard>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <SectionCard title="By gateway" icon={Wallet}>
                <BreakdownTable
                  columns={['Gateway', 'Orders', 'Amount', 'Share']}
                  rows={byGatewayChannel} keyField="channel"
                  total={byGatewayChannel.reduce((s, r) => s + Number(r.amount || 0), 0)}
                  emptyLabel="No Prepaid Gateway payables in this range."
                  onRowClick={(r) => openOrders({ source: 'prepaid', channel: r.channel }, `${r.channel} — payable`)}
                />
              </SectionCard>
              <SectionCard title="By courier" icon={PackageX}>
                <BreakdownTable
                  columns={['Courier', 'Orders', 'Amount', 'Share']}
                  rows={byCourierChannel} keyField="channel"
                  total={byCourierChannel.reduce((s, r) => s + Number(r.amount || 0), 0)}
                  emptyLabel="No COD payables in this range."
                  onRowClick={(r) => openOrders({ source: 'cod', channel: r.channel }, `${r.channel} — payable`)}
                />
              </SectionCard>
              <SectionCard title="By marketplace" icon={Wallet}>
                <BreakdownTable
                  columns={['Channel', 'Orders', 'Amount', 'Share']}
                  rows={byMarketplaceChannel} keyField="channel"
                  total={byMarketplaceChannel.reduce((s, r) => s + Number(r.amount || 0), 0)}
                  emptyLabel="No Marketplace Prepaid payables in this range."
                  onRowClick={(r) => openOrders({ source: 'marketplace_prepaid', channel: r.channel }, `${r.channel} — payable`)}
                />
              </SectionCard>
            </div>

            <SectionCard
              title="Aging — how long has this liability been outstanding"
              icon={Clock}
              right={<span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Days since the return, as of the end of the selected range</span>}
            >
              <BreakdownTable
                columns={['Age', 'Orders', 'Amount', 'Share']}
                rows={aging} keyField="bucket"
                total={k.total_payable_amount}
                emptyLabel="No payable orders in this range."
                onRowClick={(r) => openOrders({ agingBucket: r.bucket }, `${r.bucket} old — payable`)}
              />
              <FormulaNote>
                There's no data signal confirming a refund was ever actually paid back (only that a return was
                logged), so every payable order here stays outstanding indefinitely — this dashboard doesn't
                resolve an order out on its own the way Advance resolves on dispatch. COD rows only carry a
                return month, not an exact date, so they're dated to the 1st of that month for aging — the
                conservative (oldest-possible) choice.
              </FormulaNote>
            </SectionCard>

            <PayablesSheetBrowser brandId={brandId} range={range} />
          </>
        )}
      </div>

      {ordersRequest && (
        <FilteredOrdersModal
          brandId={brandId}
          range={ordersRequest.range}
          filters={ordersRequest.filters}
          title={ordersRequest.title}
          subtitle={rangeLabel}
          onClose={() => setOrdersRequest(null)}
        />
      )}
    </DashboardLayout>
  );
};

export default PayablesDashboard;

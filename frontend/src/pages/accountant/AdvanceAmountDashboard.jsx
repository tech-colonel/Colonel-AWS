import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  ArrowLeft, HandCoins, TrendingUp, Clock, PackageX, LayoutDashboard, Bot, Loader2,
  X, Info, ChevronLeft, ChevronRight, Search, RotateCcw, Wallet,
} from 'lucide-react';
import api from '../../lib/api';
import { sidebarFor } from '../../lib/adminNav';
import AdvanceAmountSheetBrowser from '../../components/reco/AdvanceAmountSheetBrowser';
import { OrderJourneyCard } from '../../components/reco/OrderJourney';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Same validated palette as ReceivableDashboard.jsx (dataviz skill) — reused as-is
// for visual consistency between the two dashboards, not re-picked.
const COLOR_SALES = '#0748EE';
const COLOR_PENDING = '#D97706';
const COLOR_RETURNED = '#E11D48';
const COLOR_PRIMARY = '#4F46E5';

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

// Any rupee/count figure on this dashboard, made clickable — opens the order-level
// list behind it. Plain text when no onClick, same pattern as ReceivableDashboard's Num.
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

const Operator = ({ symbol }) => (
  <div className="flex items-center justify-center flex-shrink-0 w-6" style={{ color: 'var(--text-muted)' }}>
    <span className="text-lg font-black">{symbol}</span>
  </div>
);

const SummaryStat = ({ label, value, color, big, onClick }) => (
  <div
    className="flex-1 min-w-[9rem] px-4 py-3.5 rounded-xl"
    style={{ background: `${color}0a`, border: `1px solid ${color}35`, cursor: onClick ? 'pointer' : 'default' }}
    onClick={onClick}
    role={onClick ? 'button' : undefined}
  >
    <div className="flex items-center justify-between gap-2">
      <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</p>
      {onClick && <span className="text-[10px] font-bold flex-shrink-0" style={{ color }}>Details →</span>}
    </div>
    <p className={big ? 'text-2xl font-black mt-1' : 'text-xl font-black mt-1'} style={{ color, fontFamily: 'Barlow' }}>{value}</p>
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
        {rows.map((r) => (
          <tr key={r[keyField]} style={{ borderBottom: '1px solid var(--card-border)' }}>
            <td className="px-2 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
              {labelFormatter ? labelFormatter(r[keyField]) : r[keyField]}
            </td>
            <td className="px-2 py-2.5" style={{ color: 'var(--text-body)' }}>
              <Num color="var(--text-body)" onClick={onRowClick ? () => onRowClick(r) : undefined}>{Number(r.orders).toLocaleString('en-IN')}</Num>
            </td>
            <td className="px-2 py-2.5 whitespace-nowrap font-semibold">
              <Num color={COLOR_PENDING} onClick={onRowClick ? () => onRowClick(r) : undefined}>{money(r.amount)}</Num>
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
            <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_PENDING }}>{money(total)}</td>
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
          {p.name}: <span className="font-semibold">{p.dataKey === 'Orders' ? p.value.toLocaleString('en-IN') : money(p.value)}</span>
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
// breakdown-table row, or a trend-chart point. Same population/filters as
// AdvanceAmountSheetBrowser's own endpoint, just scoped to one dimension and
// shown as a modal instead of an inline collapsible panel.
const FilteredOrdersModal = ({ brandId, range, filters, title, subtitle, sort, onClose }) => {
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
    if (filters?.gateway) params.set('gateway', filters.gateway);
    if (filters?.agingBucket) params.set('agingBucket', filters.agingBucket);
    if (sort) params.set('sort', sort);
    api.get(`/api/dashboard/advance-amount/${brandId}/sheet?${params.toString()}`)
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.error || 'Failed to load orders'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, range?.fromMonth, range?.fromYear, range?.toMonth, range?.toYear, filters?.gateway, filters?.agingBucket, sort, page]);

  useEffect(() => { setPage(1); }, [filters?.gateway, filters?.agingBucket]);

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
              <Loader2 className="w-6 h-6 animate-spin" style={{ color: COLOR_PENDING }} />
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
                      {['Date', 'Order #', 'Invoice #', 'Gateway', 'Advance received', 'Days pending'].map((h) => (
                        <th key={h} className="px-3 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => (
                      <tr key={`${r.sale_order_number}-${r.invoice_number}-${i}`} style={{ borderBottom: '1px solid var(--card-border)' }}>
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{fmtDate(r.date)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-medium" style={{ color: 'var(--text-heading)' }}>{r.sale_order_number || '—'}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{r.invoice_number || '—'}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{r.gateway}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-semibold" style={{ color: COLOR_PENDING }}>{money(r.gateway_amount)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{Number(r.days_pending).toLocaleString('en-IN')}</td>
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

// Backs the "Advance received" and "Orders" KPI cards — the same total, broken down
// by gateway, each row clickable through to its orders.
const AdvanceBreakdownModal = ({ data, k, period, onOpenOrders, onClose }) => {
  const byGateway = data?.byGateway || [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.45)' }} onClick={onClose}>
      <div
        className="w-fit min-w-[30rem] max-w-[92vw] rounded-2xl overflow-hidden flex flex-col"
        style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--card-border)' }}>
          <div>
            <h3 className="text-base font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
              Advance received — not yet delivered as of {period}
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Prepaid-gateway cash received for orders not yet resolved in the Sales Order Combined file as of this range's end — by gateway
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto space-y-5">
          <div className="flex items-stretch gap-2 flex-wrap">
            {byGateway.map((g, i) => (
              <Fragment key={g.gateway}>
                {i > 0 && <Operator symbol="+" />}
                <SummaryStat
                  label={g.gateway} value={money(g.amount)} color={COLOR_PENDING}
                  onClick={() => onOpenOrders({ gateway: g.gateway.toLowerCase() }, `${g.gateway} — advance received`)}
                />
              </Fragment>
            ))}
            <Operator symbol="=" />
            <SummaryStat label="Total" value={money(k.total_advance_amount)} color={COLOR_PRIMARY} big />
          </div>

          <div>
            <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>By gateway</p>
            <BreakdownTable
              columns={['Gateway', 'Orders', 'Amount', 'Share']}
              rows={byGateway} keyField="gateway"
              total={k.total_advance_amount}
              emptyLabel="No advance received in this range."
              onRowClick={(r) => onOpenOrders({ gateway: r.gateway.toLowerCase() }, `${r.gateway} — advance received`)}
            />
          </div>

          <FormulaNote>
            <strong>Formula:</strong> Advance received = Snapmint settlement + BharatX settlement + Razorpay
            settlement, summed for every Shopify Prepaid order whose gateway amount was received in the selected
            range <strong>and</strong> that is still not resolved in the Sales Order Combined file as of this
            range's end — either no entry was ever found there, or one was found but its own delivery/dispatch/
            cancellation date falls after the range you're viewing. Worked example: an order's cash arrives 25 May
            2024, it's delivered 3 June 2024. Viewing May 2024 → May 2024, it's still Advance (delivery hasn't
            happened as of the range's end). Viewing May 2024 → June 2024, it's no longer Advance (delivery now
            falls inside the range) — same order, same data, different as-of date. An order can appear in more
            than one gateway row if more than one gateway shows money against it.
          </FormulaNote>
        </div>
      </div>
    </div>
  );
};

// Backs the "Avg. days pending" and "Oldest advance" KPI cards — how long this cash
// has been outstanding, as a distribution plus the actual oldest orders.
const AgingModal = ({ brandId, range, aging, total, period, onOpenOrders, onClose }) => {
  const [oldest, setOldest] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!range) return;
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({
      fromMonth: String(range.fromMonth), fromYear: String(range.fromYear),
      toMonth: String(range.toMonth), toYear: String(range.toYear),
      sort: 'oldest', page: '1', pageSize: '10',
    });
    api.get(`/api/dashboard/advance-amount/${brandId}/sheet?${params.toString()}`)
      .then((res) => { if (!cancelled) setOldest(res.data.rows); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brandId, range?.fromMonth, range?.fromYear, range?.toMonth, range?.toYear]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.45)' }} onClick={onClose}>
      <div
        className="w-fit min-w-[30rem] max-w-[92vw] rounded-2xl overflow-hidden flex flex-col"
        style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--card-border)' }}>
          <div>
            <h3 className="text-base font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
              Aging — how long this cash has been sitting, {period}
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Days since the gateway amount was received, as of this range's end — still not resolved in the Sales Order Combined file
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto space-y-5">
          <BreakdownTable
            columns={['Age', 'Orders', 'Amount', 'Share']}
            rows={aging} keyField="bucket"
            total={total}
            emptyLabel="No advance received in this range."
            onRowClick={(r) => onOpenOrders({ agingBucket: r.bucket }, `${r.bucket} old — advance received`)}
          />

          <div>
            <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>Oldest outstanding advances (top 10)</p>
            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: COLOR_PENDING }} />
              </div>
            )}
            {!loading && (
              <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--card-border)' }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                      {['Date', 'Order #', 'Gateway', 'Advance received', 'Days pending'].map((h) => (
                        <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(oldest || []).map((r, i) => (
                      <tr key={`${r.sale_order_number}-${i}`} style={{ borderBottom: '1px solid var(--card-border)' }}>
                        <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{fmtDate(r.date)}</td>
                        <td className="px-2 py-2.5 whitespace-nowrap font-medium" style={{ color: 'var(--text-heading)' }}>{r.sale_order_number || '—'}</td>
                        <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{r.gateway}</td>
                        <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: COLOR_PENDING }}>{money(r.gateway_amount)}</td>
                        <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: COLOR_RETURNED }}>{Number(r.days_pending).toLocaleString('en-IN')}</td>
                      </tr>
                    ))}
                    {!(oldest || []).length && (
                      <tr><td colSpan={5} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No advance received in this range.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <FormulaNote>
            <strong>Formula:</strong> Days pending = the end of the selected range's "To" month (capped at today)
            minus the date the gateway amount was received — so picking Mar 2024 → Mar 2024 ages every row against
            31 Mar 2024, not the real calendar date; a same-month order tops out around 30 days. Avg. days pending
            averages this across every order in the selected range; Oldest advance is the single largest value.
          </FormulaNote>
        </div>
      </div>
    </div>
  );
};

// Lookup-by-order/invoice/AWB card for the Advance Amount Dashboard — deliberately
// NOT scoped to the dashboard's date range or its no-fulfillment-record-found filter
// (see getAdvanceOrderStatus), so it finds any order that took a gateway advance
// regardless of whether it was later found in the Sales Order Combined file.
const OrderTrackerCard = ({ brandId }) => {
  const [inputValue, setInputValue] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!query) { setResults(null); setError(null); return; }
    setLoading(true);
    setError(null);
    api.get(`/api/dashboard/advance-amount/${brandId}/order-status?${new URLSearchParams({ q: query })}`)
      .then((res) => setResults(res.data.results || []))
      .catch((e) => setError(e.response?.data?.error || 'Lookup failed'))
      .finally(() => setLoading(false));
  }, [brandId, query]);

  const submit = () => setQuery(inputValue.trim());

  return (
    <SectionCard title="Track an order" icon={Search}>
      <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
        Search an order number, invoice number, or AWB to see its gateway advance details — only finds orders
        that received a Snapmint/BharatX/Razorpay advance. An order paid another way won't turn up here even if
        the number matches.
      </p>
      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="Order #, invoice #, or AWB"
            className="text-sm pl-8 pr-3 py-2 rounded-lg w-full"
            style={{ background: 'var(--page-bg)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
          />
        </div>
        <button
          onClick={submit}
          className="text-xs font-bold px-4 py-2 rounded-lg flex-shrink-0"
          style={{ background: `${COLOR_PRIMARY}12`, color: COLOR_PRIMARY }}
        >
          Track
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching…
        </div>
      )}
      {!loading && error && <p className="text-xs font-semibold" style={{ color: COLOR_RETURNED }}>{error}</p>}
      {!loading && !error && query && results && results.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No order found matching "{query}".</p>
      )}
      {!loading && !error && results && results.length > 0 && (
        <div className="space-y-4">
          {results.map((order, i) => (
            <OrderJourneyCard key={`${order.sale_order_number}-${order.awb_number}-${i}`} order={order} />
          ))}
        </div>
      )}

      <FormulaNote>
        This lookup shows every order that ever took a Snapmint/BharatX/Razorpay advance, whether or not it was
        later resolved in the Sales Order Combined file — it's a general search, not scoped to the selected date
        range or the Advance list below. To see only the orders still counting as Advance as of a given range, use
        the order browser instead.
      </FormulaNote>
    </SectionCard>
  );
};

const AdvanceAmountDashboard = () => {
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
  const [showBreakdownModal, setShowBreakdownModal] = useState(false);
  const [showAgingModal, setShowAgingModal] = useState(false);
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
      const res = await api.get(`/api/dashboard/advance-amount/${brandId}${qs ? `?${qs}` : ''}`);
      setData(res.data);
      if (res.data?.range) {
        setFromMonth(res.data.range.fromMonth);
        setFromYear(res.data.range.fromYear);
        setToMonth(res.data.range.toMonth);
        setToYear(res.data.range.toYear);
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load advance amount dashboard');
    } finally {
      setLoading(false);
      setInitialized(true);
    }
  }, [brandId]);

  // First load: no range params, let the backend default to the full available span.
  useEffect(() => { load(); }, [load]);

  // Subsequent loads: user changed the range picker.
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
  const byGateway = data?.byGateway || [];
  const aging = data?.aging || [];
  const range = (fromMonth && fromYear && toMonth && toYear) ? { fromMonth, fromYear, toMonth, toYear } : null;

  const trend = (data?.monthlyTrend || []).map((r) => ({
    label: `${MONTHS[r.month]} ${String(r.year).slice(2)}`,
    month: r.month,
    year: r.year,
    'Advance outstanding': Number(r.amount || 0),
    Orders: Number(r.orders || 0),
  }));

  const rangeLabel = range
    ? `${MONTHS[fromMonth]} ${fromYear} → ${MONTHS[toMonth]} ${toYear}`
    : '';

  // Opens the order-level modal for one dimension slice — defaults to the dashboard's
  // current date range, but a trend-chart point click overrides it to that one month.
  const openOrders = useCallback((filters, title, rangeOverride) => {
    setOrdersRequest({ filters, title, range: rangeOverride || range });
  }, [range]);

  const openMonthOrders = (point) => openOrders(
    {},
    `${MONTHS[point.month]} ${point.year} — advance received`,
    { fromMonth: point.month, fromYear: point.year, toMonth: point.month, toYear: point.year },
  );

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
              style={{ background: `${COLOR_PENDING}15`, border: `1px solid ${COLOR_PENDING}30` }}
            >
              <HandCoins className="w-5 h-5" style={{ color: COLOR_PENDING }} />
            </div>
            <div>
              <h1 className="text-xl font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow', letterSpacing: '-0.02em' }}>
                Advance Amount Dashboard
              </h1>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Prepaid amounts received via BharatX, Razorpay &amp; Snapmint for orders not yet delivered as of the selected range
              </p>
            </div>
          </div>

          {/* Date range picker */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => navigate(`/brands/${brandId}/receivables`)}
              className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg transition-colors mr-1"
              style={{ background: `${COLOR_SALES}12`, color: COLOR_SALES, border: `1px solid ${COLOR_SALES}30` }}
            >
              <Wallet className="w-3.5 h-3.5" />
              Receivable Dashboard →
            </button>
            <button
              onClick={() => navigate(`/brands/${brandId}/payables`)}
              className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg transition-colors mr-1"
              style={{ background: `${COLOR_RETURNED}12`, color: COLOR_RETURNED, border: `1px solid ${COLOR_RETURNED}30` }}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Payables Dashboard →
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

        <OrderTrackerCard brandId={brandId} />

        {loading && (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: COLOR_PENDING }} />
          </div>
        )}

        {!loading && error && (
          <div className="p-5 text-sm font-semibold" style={{ ...cardStyle, color: COLOR_RETURNED }}>{error}</div>
        )}

        {!loading && !error && !data?.kpis && (
          <div className="p-8 text-center" style={cardStyle}>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>
              No orders with a Snapmint / BharatX / Razorpay advance found for this brand yet — check that the
              Receivable Cycle agent has been run with the Snapmint/Razorpay/BharatX gateway files loaded.
            </p>
          </div>
        )}

        {!loading && !error && data?.kpis && (
          <>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              {rangeLabel} — orders whose prepaid amount was received in this range and not yet delivered as of this range's end
            </p>

            {/* ── KPI row ───────────────────────────────────────────── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard
                label="Advance received — not yet delivered"
                value={money(k.total_advance_amount)}
                sub="Gateway amount received in the selected range for orders not yet resolved in the Sales Order Combined file as of this range's end. Once its own delivered/dispatched/cancelled date falls inside a range you're viewing, it drops off this figure — for that range and any later one. Click for breakdown by gateway"
                icon={HandCoins} color={COLOR_PENDING} highlight
                onClick={() => setShowBreakdownModal(true)}
              />
              <KpiCard
                label="Orders"
                value={Number(k.total_orders || 0).toLocaleString('en-IN')}
                sub="Orders with an advance received in this range, not yet resolved in the Sales Order Combined file as of this range's end. Click for breakdown"
                icon={PackageX} color={COLOR_SALES}
                onClick={() => setShowBreakdownModal(true)}
              />
              <KpiCard
                label="Avg. days pending"
                value={Number(k.avg_days_pending || 0).toFixed(0)}
                sub="Average age of this cash, in days since received, as of this range's end. Click for aging breakdown"
                icon={Clock} color={COLOR_PRIMARY}
                onClick={() => setShowAgingModal(true)}
              />
              <KpiCard
                label="Oldest advance"
                value={`${Number(k.oldest_days_pending || 0).toLocaleString('en-IN')} days`}
                sub="Longest any single advance has been outstanding. Click to see the oldest orders"
                icon={Clock} color={COLOR_RETURNED}
                onClick={() => setShowAgingModal(true)}
              />
            </div>

            {/* ── Trend chart ─────────────────────────────────────────── */}
            <SectionCard title="Advance received — by month" icon={TrendingUp}>
              <div style={{ width: '100%', height: 280 }}>
                <ResponsiveContainer>
                  <LineChart data={trend} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--card-border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={{ stroke: 'var(--card-border)' }} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
                      tickFormatter={(v) => `₹${(v / 100000).toFixed(0)}L`} />
                    <Tooltip content={<TrendTooltip />} />
                    <Line
                      type="monotone" dataKey="Advance outstanding" stroke={COLOR_PENDING} strokeWidth={2.5}
                      dot={(props) => {
                        const { cx, cy, payload, index } = props;
                        return (
                          <circle
                            key={`dot-${index}`} cx={cx} cy={cy} r={4} fill={COLOR_PENDING}
                            stroke="var(--surface)" strokeWidth={1.5} style={{ cursor: 'pointer' }}
                            onClick={() => openMonthOrders(payload)}
                          />
                        );
                      }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>
                Sum of prepaid-gateway amount received in that month, for orders not yet delivered as of the
                overall selected range's end. Click any point to see that month's orders.
              </p>
            </SectionCard>

            {/* ── Breakdowns ───────────────────────────────────────────── */}
            <SectionCard title="By gateway" icon={HandCoins}>
              <BreakdownTable
                columns={['Gateway', 'Orders', 'Amount', 'Share']}
                rows={byGateway} keyField="gateway"
                total={k.total_advance_amount}
                emptyLabel="No advance received in this range."
                onRowClick={(r) => openOrders({ gateway: r.gateway.toLowerCase() }, `${r.gateway} — advance received`)}
              />
            </SectionCard>

            <SectionCard
              title="Aging — how long has this cash been sitting"
              icon={Clock}
              right={<span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Days since the gateway amount was received</span>}
            >
              <BreakdownTable
                columns={['Age', 'Orders', 'Amount', 'Share']}
                rows={aging} keyField="bucket"
                total={k.total_advance_amount}
                emptyLabel="No advance received in this range."
                onRowClick={(r) => openOrders({ agingBucket: r.bucket }, `${r.bucket} old — advance received`)}
              />
            </SectionCard>

            {/* ── Order browser ───────────────────────────────────────── */}
            <AdvanceAmountSheetBrowser brandId={brandId} range={range} />
          </>
        )}
      </div>

      {showBreakdownModal && (
        <AdvanceBreakdownModal
          data={data} k={k} period={rangeLabel}
          onOpenOrders={(filters, title) => openOrders(filters, title)}
          onClose={() => setShowBreakdownModal(false)}
        />
      )}
      {showAgingModal && (
        <AgingModal
          brandId={brandId} range={range} aging={aging} total={k.total_advance_amount} period={rangeLabel}
          onOpenOrders={(filters, title) => openOrders(filters, title)}
          onClose={() => setShowAgingModal(false)}
        />
      )}
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

export default AdvanceAmountDashboard;

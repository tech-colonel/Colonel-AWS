import { useState, useEffect, useCallback } from 'react';
import {
  FileSpreadsheet, Search, ChevronLeft, ChevronRight, Loader2, Eye, EyeOff, X,
} from 'lucide-react';
import api from '../../lib/api';
import ColumnFilterPopover from './ColumnFilterPopover';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SHEET_TABS = ['Main Sheet', 'COD main sheet', 'Delivery', 'Ekart', 'Xpressbees', 'DTDC', 'Self shipping', 'Other COD'];

// Mirrors RECEIVABLE_SHEET_COLUMNS in dashboardController.js — the per-header
// Excel-style filter popovers, keyed to match the `filters` JSON the backend expects.
const FILTER_COLUMNS = [
  { key: 'date', label: 'Date' },
  { key: 'invoice', label: 'Invoice #' },
  { key: 'order', label: 'Order #' },
  { key: 'awb', label: 'AWB' },
  { key: 'channel', label: 'Channel' },
  { key: 'payment', label: 'Payment' },
  { key: 'total', label: 'Total' },
  { key: 'collection', label: 'Collection' },
  { key: 'return', label: 'Return' },
];

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'settled', label: 'Settled' },
  { key: 'returned', label: 'Returned' },
];

const COLOR_SALES = '#0748EE';
const COLOR_RECEIVED = '#059669';
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
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, '0')} ${MONTHS[dt.getMonth() + 1]} ${dt.getFullYear()}`;
};

const PAGE_SIZE = 25;

const Pill = ({ children, color, subtle }) => (
  <span
    className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap"
    style={{ background: subtle ? 'var(--page-bg)' : `${color}18`, color: subtle ? 'var(--text-muted)' : color, border: `1px solid ${subtle ? 'var(--card-border)' : `${color}40`}` }}
  >
    {children}
  </span>
);

const ReceivableSheetBrowser = ({ brandId, month, year, channel }) => {
  const [expanded, setExpanded] = useState(false);
  const [sheet, setSheet] = useState('Main Sheet');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [columnFilters, setColumnFilters] = useState({});
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const hasColumnFilters = Object.values(columnFilters).some((v) => v && v.length);
  const filtersParam = hasColumnFilters ? JSON.stringify(columnFilters) : '';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        month: String(month), year: String(year), sheet, status,
        page: String(page), pageSize: String(PAGE_SIZE),
      });
      if (channel) params.set('channel', channel);
      if (search) params.set('search', search);
      if (filtersParam) params.set('filters', filtersParam);
      const res = await api.get(`/api/dashboard/receivables/${brandId}/sheet?${params.toString()}`);
      setData(res.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load sheet data');
    } finally {
      setLoading(false);
    }
  }, [brandId, month, year, channel, sheet, status, page, search, filtersParam]);

  useEffect(() => {
    if (expanded) load();
  }, [expanded, load]);

  // Any filter/tab/month change resets to page 1.
  useEffect(() => { setPage(1); }, [sheet, status, search, month, year, filtersParam]);

  const setColumnFilter = (key, values) => {
    setColumnFilters((prev) => ({ ...prev, [key]: values }));
  };

  const fetchColumnValues = useCallback((column) => (q) => {
    const params = new URLSearchParams({
      month: String(month), year: String(year), sheet, status, column,
    });
    if (channel) params.set('channel', channel);
    if (search) params.set('search', search);
    if (filtersParam) params.set('filters', filtersParam);
    if (q) params.set('q', q);
    return api.get(`/api/dashboard/receivables/${brandId}/sheet/column-values?${params.toString()}`)
      .then((res) => res.data);
  }, [brandId, month, year, channel, sheet, status, search, filtersParam]);

  const formatColumnValue = (key, v) => {
    if (key === 'date') return fmtDate(v);
    if (key === 'total') return money(Number(v));
    return v;
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div style={cardStyle} className="overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: `${COLOR_PRIMARY}18`, border: `1px solid ${COLOR_PRIMARY}30` }}
          >
            <FileSpreadsheet className="w-4 h-4" style={{ color: COLOR_PRIMARY }} />
          </div>
          <div className="text-left">
            <p className="text-sm font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
              View sheet data — {MONTHS[month]} {year}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Row-level Main Sheet / COD / per-courier breakdown, same as the Receivable Cycle workbook
            </p>
          </div>
        </div>
        <span
          className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg flex-shrink-0"
          style={{ background: `${COLOR_PRIMARY}12`, color: COLOR_PRIMARY }}
        >
          {expanded ? <><EyeOff className="w-3.5 h-3.5" /> Hide</> : <><Eye className="w-3.5 h-3.5" /> View</>}
        </span>
      </button>

      {expanded && (
        <div style={{ borderTop: '1px solid var(--card-border)' }}>
          {/* Sheet tabs */}
          <div className="flex flex-wrap gap-2 px-5 pt-4">
            {SHEET_TABS.map((s) => (
              <button
                key={s}
                onClick={() => setSheet(s)}
                className="text-xs font-bold px-3 py-1.5 rounded-lg transition-all"
                style={sheet === s
                  ? { background: COLOR_PRIMARY, color: '#fff' }
                  : { background: 'var(--page-bg)', color: 'var(--text-muted)', border: '1px solid var(--card-border)' }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Filter row: status pills + search */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-2">
            <div className="flex items-center gap-1.5">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setStatus(f.key)}
                  className="text-xs font-semibold px-2.5 py-1 rounded-full transition-all"
                  style={status === f.key
                    ? { background: 'var(--text-heading)', color: 'var(--surface)' }
                    : { background: 'var(--page-bg)', color: 'var(--text-muted)', border: '1px solid var(--card-border)' }}
                >
                  {f.label}
                </button>
              ))}
              {hasColumnFilters && (
                <button
                  onClick={() => setColumnFilters({})}
                  className="text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1"
                  style={{ background: `${COLOR_RETURNED}12`, color: COLOR_RETURNED, border: `1px solid ${COLOR_RETURNED}30` }}
                >
                  <X className="w-3 h-3" /> Clear column filters
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setSearch(searchInput.trim()); }}
                  placeholder="Search invoice / AWB / order no."
                  className="text-xs pl-8 pr-3 py-1.5 rounded-lg w-56"
                  style={{ background: 'var(--page-bg)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
                />
              </div>
              {search && (
                <button
                  onClick={() => { setSearch(''); setSearchInput(''); }}
                  className="p-1.5 rounded-lg"
                  style={{ background: 'var(--page-bg)', border: '1px solid var(--card-border)', color: 'var(--text-muted)' }}
                  aria-label="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={() => setSearch(searchInput.trim())}
                className="text-xs font-bold px-3 py-1.5 rounded-lg"
                style={{ background: `${COLOR_PRIMARY}12`, color: COLOR_PRIMARY }}
              >
                Search
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="px-5 pb-5">
            {loading && (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-6 h-6 animate-spin" style={{ color: COLOR_PRIMARY }} />
              </div>
            )}
            {!loading && error && (
              <p className="text-sm font-semibold py-8 text-center" style={{ color: COLOR_RETURNED }}>{error}</p>
            )}
            {!loading && !error && data && (
              <>
                <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid var(--card-border)' }}>
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                        {FILTER_COLUMNS.map(({ key, label }) => (
                          <th key={key} className="px-3 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                            <span className="inline-flex items-center">
                              {label}
                              <ColumnFilterPopover
                                label={label}
                                selected={columnFilters[key] || []}
                                fetchValues={fetchColumnValues(key)}
                                formatValue={(v) => formatColumnValue(key, v)}
                                onApply={(values) => setColumnFilter(key, values)}
                              />
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((r, i) => (
                        <tr key={`${r.awb}-${r.invoice_number}-${i}`} style={{ borderBottom: '1px solid var(--card-border)' }}>
                          <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{fmtDate(r.order_date)}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap font-medium" style={{ color: 'var(--text-heading)' }}>{r.invoice_number || '—'}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{r.sale_order_number || '—'}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{r.awb || '—'}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{r.channel || '—'}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            <Pill color={r.payment_method === 'COD' ? COLOR_PENDING : COLOR_SALES}>{r.payment_method}</Pill>
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap font-semibold" style={{ color: 'var(--text-heading)' }}>{money(r.total_amount)}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            {r.settled_flag ? (
                              <div>
                                <Pill color={COLOR_RECEIVED}>Settled</Pill>
                                <p className="text-[10px] mt-0.5 capitalize" style={{ color: 'var(--text-muted)' }}>
                                  {r.settled_source} · {MONTHS[r.settled_month]} {r.settled_year}
                                </p>
                              </div>
                            ) : (
                              <Pill color={COLOR_PENDING}>Pending</Pill>
                            )}
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            {r.returned_flag ? (
                              <div>
                                <Pill color={COLOR_RETURNED}>Returned</Pill>
                                <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                  {money(r.returned_amount)} · {MONTHS[r.returned_month]} {r.returned_year}
                                </p>
                              </div>
                            ) : (
                              <Pill subtle>—</Pill>
                            )}
                          </td>
                        </tr>
                      ))}
                      {!data.rows.length && (
                        <tr><td colSpan={9} className="px-3 py-10 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No rows match this filter.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between mt-3">
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {data.total.toLocaleString('en-IN')} row{data.total === 1 ? '' : 's'} · page {page} of {totalPages}
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
      )}
    </div>
  );
};

export default ReceivableSheetBrowser;

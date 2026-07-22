import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  ArrowLeft, Wallet, TrendingUp, TrendingDown, RotateCcw, AlertTriangle,
  LayoutDashboard, Bot, Loader2, X, ChevronLeft, ChevronRight, Info,
} from 'lucide-react';
import api from '../../lib/api';
import { sidebarFor } from '../../lib/adminNav';
import ReceivableSheetBrowser from '../../components/reco/ReceivableSheetBrowser';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Validated categorical palette (dataviz skill, run through scripts/validate_palette.js —
// all checks pass; #D97706/#059669 sit in the CVD 6-8 floor band, legal only with the
// legend + direct tooltip labels this chart always shows).
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
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

const currentDate = new Date();

const KpiCard = ({ label, value, sub, icon: Icon, color, onClick, highlight }) => (
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

const ReceivedSplitTable = ({ title, rows, keyField }) => {
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  return (
    <>
      <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>{title}</p>
      <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--card-border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
              {[keyField === 'source' ? 'Source' : 'Portal', 'Received: this month\'s sale', 'Received: earlier months\' sale', 'Total received', 'Share'].map((h) => (
                <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r[keyField]} style={{ borderBottom: '1px solid var(--card-border)' }}>
                <td className="px-2 py-2.5 font-semibold capitalize whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>{r[keyField]}</td>
                <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: COLOR_RECEIVED }}>{money(r.from_this_month)}</td>
                <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: Number(r.from_earlier_months) > 0 ? COLOR_PENDING : 'var(--text-muted)' }}>{money(r.from_earlier_months)}</td>
                <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: 'var(--text-heading)' }}>{money(r.amount)}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.amount, total)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={5} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No collections recorded this month.</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_RECEIVED }}>
                {money(rows.reduce((s, r) => s + Number(r.from_this_month || 0), 0))}
              </td>
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_PENDING }}>
                {money(rows.reduce((s, r) => s + Number(r.from_earlier_months || 0), 0))}
              </td>
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>{money(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
};

const CarriedForwardCollectionsTable = ({ rows }) => {
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  return (
    <>
      <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
        Received this month, for earlier months' sale — by origin month &amp; partner
      </p>
      <div className="overflow-x-auto rounded-lg" style={{ border: `1px solid ${COLOR_PENDING}35` }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: `${COLOR_PENDING}0c`, borderBottom: '1.5px solid var(--card-border)' }}>
              {['Origin month', 'Partner', 'Orders', 'Amount', 'Share'].map((h) => (
                <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.order_year}-${r.order_month}-${r.source}`} style={{ borderBottom: '1px solid var(--card-border)' }}>
                <td className="px-2 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>{MONTHS[r.order_month]} {r.order_year}</td>
                <td className="px-2 py-2.5 capitalize whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{r.source}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-body)' }}>{Number(r.count).toLocaleString('en-IN')}</td>
                <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: COLOR_PENDING }}>{money(r.amount)}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.amount, total)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={5} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>Nothing collected this month was from an earlier month's sale.</td></tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
                <td /><td />
                <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_PENDING }}>{money(total)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
};

const ReceivedBreakdownModal = ({ data, period, onClose }) => {
  const bySource = data?.receivedBySource || [];
  const byChannel = data?.receivedByChannel || [];
  const carriedForward = data?.carriedForwardCollections || [];
  const k = data?.kpis || {};
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.45)' }}
      onClick={onClose}
    >
      <div
        className="w-fit min-w-[30rem] max-w-[92vw] rounded-2xl overflow-hidden flex flex-col"
        style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--card-border)' }}>
          <div>
            <h3 className="text-base font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
              Received in {MONTHS[period.month]} {period.year} — by source & portal
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Cash actually collected this month, not sales — includes prepaid (Razorpay-equivalent, always
              same-month) and courier COD settlements
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto space-y-5">
          <div className="flex items-stretch gap-2">
            <SummaryStat label={`Received — for ${MONTHS[period.month]} ${period.year}'s own sale`} value={k.received_from_this_months_sales} color={COLOR_RECEIVED} />
            <Operator symbol="+" />
            <SummaryStat label="Received — for earlier months' sale" value={k.received_from_carried_forward} color={COLOR_PENDING} />
            <Operator symbol="=" />
            <SummaryStat label="Total received" value={k.received_this_month} color={COLOR_PRIMARY} big />
          </div>

          <CarriedForwardCollectionsTable rows={carriedForward} />
          <ReceivedSplitTable title="By source (courier / prepaid)" rows={bySource} keyField="source" />
          <ReceivedSplitTable title="By portal / channel" rows={byChannel} keyField="channel" />
        </div>
      </div>
    </div>
  );
};

// A bigger, more legible stat block than a plain KPI chip — used for the "how it's
// calculated" arithmetic view (Carried forward + This month's own = Total).
const SummaryStat = ({ label, value, color, big, onClick }) => (
  <div
    className="flex-1 min-w-[11rem] px-4 py-3.5 rounded-xl"
    style={{ background: `${color}0a`, border: `1px solid ${color}35`, cursor: onClick ? 'pointer' : 'default' }}
    onClick={onClick}
    role={onClick ? 'button' : undefined}
  >
    <div className="flex items-center justify-between gap-2">
      <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{label}</p>
      {onClick && <span className="text-[10px] font-bold flex-shrink-0" style={{ color }}>Details →</span>}
    </div>
    <p className={big ? 'text-2xl font-black mt-1' : 'text-xl font-black mt-1'} style={{ color, fontFamily: 'Barlow' }}>{money(value)}</p>
  </div>
);

// Backs the reconciliation strip's "Settled to date" box — of THIS MONTH'S OWN
// sales, how much has settled and from where (courier / prepaid), regardless of
// which calendar month the settlement itself happened in. Not the same table as
// "Received → by source" (ReceivedSplitTable), which is filtered by settled_month
// instead of order_month — see RECEIVABLES_CYCLE.md §4/§5 for the distinction.
const SettledToDateModal = ({ rows, period, total, onClose }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center p-4"
    style={{ background: 'rgba(15,23,42,0.45)' }}
    onClick={onClose}
  >
    <div
      className="w-fit min-w-[26rem] max-w-[92vw] rounded-2xl overflow-hidden"
      style={{ background: 'var(--surface)', border: '1px solid var(--card-border)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--card-border)' }}>
        <div>
          <h3 className="text-base font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
            Settled to date — {MONTHS[period.month]} {period.year}'s own sales
          </h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            COD + Prepaid combined. Counts a settlement no matter which calendar month it landed in — an order sold
            this month but settled next month still counts here, under its actual source.
          </p>
        </div>
        <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-6 pb-4 pt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
              {['Source', 'Orders', 'Amount settled', 'Share'].map((h) => (
                <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.source} style={{ borderBottom: '1px solid var(--card-border)' }}>
                <td className="px-2 py-2.5 font-semibold capitalize whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>{r.source}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-body)' }}>{Number(r.count).toLocaleString('en-IN')}</td>
                <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: COLOR_RECEIVED }}>{money(r.amount)}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.amount, total)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={4} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>Nothing settled yet from this month's sales.</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
              <td />
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_RECEIVED }}>{money(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <FormulaNote>
          <strong>Formula:</strong> for every order sold in {MONTHS[period.month]} {period.year}, this sums
          <code> total_amount</code> where it is settled and not returned — grouped by <code>settled_source</code>
          (<code>ekart</code> / <code>xpressbees</code> / <code>delhivery</code> / <code>prepaid</code>). This is the
          exact breakdown behind the reconciliation strip's "Settled to date" figure.
        </FormulaNote>
      </div>
    </div>
  </div>
);

const Operator = ({ symbol }) => (
  <div className="flex items-center justify-center flex-shrink-0 w-6" style={{ color: 'var(--text-muted)' }}>
    <span className="text-lg font-black">{symbol}</span>
  </div>
);

// Generic "by origin month" breakdown — reused by both the "Total receivable" card
// (arithmetic summary + a by-partner table, no month table) and the "Carried forward"
// card (just the by-month table for earlier months, no summary, no partner table).
const ReceivableByMonthModal = ({ title, subtitle, rows, total, summary, showMonthTable = true, partnerRows, movementNote, onClose }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center p-4"
    style={{ background: 'rgba(15,23,42,0.45)' }}
    onClick={onClose}
  >
    <div
      className="w-fit min-w-[26rem] max-w-[92vw] rounded-2xl overflow-hidden flex flex-col"
      style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', maxHeight: '88vh' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--card-border)' }}>
        <div>
          <h3 className="text-base font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>{title}</h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>
        </div>
        <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-6 py-4 overflow-y-auto">
        {summary && (
          <div className="flex items-stretch gap-2 mb-5">
            <SummaryStat {...summary[0]} />
            <Operator symbol="+" />
            <SummaryStat {...summary[1]} />
            <Operator symbol="=" />
            <SummaryStat {...summary[2]} big />
          </div>
        )}

        {movementNote && (
          <div
            className="mb-5 px-3 py-2.5 rounded-lg flex items-start gap-2"
            style={{ background: `${COLOR_RECEIVED}0a`, border: `1px solid ${COLOR_RECEIVED}35` }}
          >
            <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: COLOR_RECEIVED }} />
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-body)' }}>{movementNote}</p>
          </div>
        )}

        {showMonthTable && (
          <>
            <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>By origin month</p>
            <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--card-border)' }}>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                    {['Month', 'COD sales', 'Settled', 'Returned', 'Still pending', '% pending'].map((h) => (
                      <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.year}-${r.month}`} style={{ borderBottom: '1px solid var(--card-border)' }}>
                      <td className="px-2 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>{MONTHS[r.month]} {r.year}</td>
                      <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{money(r.cod_sales)}</td>
                      <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: COLOR_RECEIVED }}>{money(r.settled_amount)}</td>
                      <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: Number(r.returned_amount) > 0 ? COLOR_RETURNED : 'var(--text-muted)' }}>{money(r.returned_amount)}</td>
                      <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: Number(r.pending) > 0 ? COLOR_PENDING : 'var(--text-muted)' }}>{money(r.pending)}</td>
                      <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.pending, r.cod_sales)}</td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr><td colSpan={6} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No COD data yet.</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
                    <td />
                    <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_RECEIVED }}>
                      {money(rows.reduce((s, r) => s + Number(r.settled_amount || 0), 0))}
                    </td>
                    <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_RETURNED }}>
                      {money(rows.reduce((s, r) => s + Number(r.returned_amount || 0), 0))}
                    </td>
                    <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_PENDING }}>{money(total)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <FormulaNote>
              <strong>Formula:</strong> COD sales = Settled + Returned + Still pending, exactly, for every month.
              An order counts as <strong>Settled</strong> only if it was paid out AND never returned; as{' '}
              <strong>Returned</strong> if it was ever returned (even if a courier had briefly remitted it first —
              that cash is not real revenue once the item comes back); and <strong>Still pending</strong> only if
              it's neither. A returned order never counts as receivable, no matter which month the return itself lands in.
            </FormulaNote>
          </>
        )}

        {partnerRows && (
          <>
            <p className="text-xs font-bold uppercase tracking-wide mt-5 mb-2" style={{ color: 'var(--text-muted)' }}>By partner / courier</p>
            <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--card-border)' }}>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                    {['Partner', 'Orders', 'Pending', '% of total'].map((h) => (
                      <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {partnerRows.map((r) => (
                    <tr key={r.courier} style={{ borderBottom: '1px solid var(--card-border)' }}>
                      <td className="px-2 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>{r.courier || 'Uncategorized'}</td>
                      <td className="px-2 py-2.5" style={{ color: 'var(--text-body)' }}>{Number(r.pending_orders).toLocaleString('en-IN')}</td>
                      <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: COLOR_PENDING }}>{money(r.pending_amount)}</td>
                      <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.pending_amount, total)}</td>
                    </tr>
                  ))}
                  {!partnerRows.length && (
                    <tr><td colSpan={4} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No pending COD orders.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  </div>
);

const ThisMonthByCourierModal = ({ rows, period, total, onClose }) => {
  const codSales = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0);
  const codSettled = rows.reduce((s, r) => s + Number(r.settled_amount || 0), 0);
  const codReturned = rows.reduce((s, r) => s + Number(r.returned_amount || 0), 0);
  return (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center p-4"
    style={{ background: 'rgba(15,23,42,0.45)' }}
    onClick={onClose}
  >
    <div
      className="w-fit min-w-[26rem] max-w-[92vw] rounded-2xl overflow-hidden"
      style={{ background: 'var(--surface)', border: '1px solid var(--card-border)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--card-border)' }}>
        <div>
          <h3 className="text-base font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
            {MONTHS[period.month]} {period.year}'s own receivable — by partner
          </h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            By courier/partner — COD only (Prepaid has no courier and always settles same-month, so it contributes
            ₹0 here; see the dashboard's reconciliation strip for the full COD+Prepaid identity)
          </p>
        </div>
        <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-6 pt-4">
        <div className="flex items-stretch gap-1.5 mb-5 flex-wrap">
          <SummaryStat label={`COD sales (${MONTHS[period.month]} ${period.year})`} value={codSales} color={COLOR_SALES} />
          <Operator symbol="−" />
          <SummaryStat label="Settled" value={codSettled} color={COLOR_RECEIVED} />
          <Operator symbol="−" />
          <SummaryStat label="Returned" value={codReturned} color={COLOR_RETURNED} />
          <Operator symbol="=" />
          <SummaryStat label="Pending (this card's number)" value={total} color={COLOR_PENDING} big />
        </div>
      </div>
      <div className="px-6 pb-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1.5px solid var(--card-border)' }}>
              {['Courier / partner', 'Orders', 'Sales this month', 'Settled', 'Returned (COD)', 'Pending', '% pending'].map((h) => (
                <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.courier} style={{ borderBottom: '1px solid var(--card-border)' }}>
                <td className="px-2 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>{r.courier || 'Uncategorized'}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-body)' }}>{Number(r.total_orders).toLocaleString('en-IN')}</td>
                <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{money(r.total_amount)}</td>
                <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: COLOR_RECEIVED }}>{money(r.settled_amount)}</td>
                <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: Number(r.returned_amount) > 0 ? COLOR_RETURNED : 'var(--text-muted)' }}>{money(r.returned_amount)}</td>
                <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: Number(r.pending_amount) > 0 ? COLOR_PENDING : COLOR_RECEIVED }}>{money(r.pending_amount)}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.pending_amount, r.total_amount)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={7} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No COD sales this month.</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
              <td />
              <td />
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_RECEIVED }}>
                {money(rows.reduce((s, r) => s + Number(r.settled_amount || 0), 0))}
              </td>
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_RETURNED }}>
                {money(rows.reduce((s, r) => s + Number(r.returned_amount || 0), 0))}
              </td>
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_PENDING }}>{money(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <FormulaNote>
          <strong>Formula:</strong> This month's sale = Settled + Returned + Pending, exactly, per partner. Pending
          only counts an order if it's neither settled nor returned — a returned order (even one a courier briefly
          remitted before the return) never counts as receivable.
          <br /><br />
          <strong>"Returned (COD)" here is not the same number as elsewhere on this dashboard</strong> — it's COD
          orders only (receivable is a COD-only concept), and it counts a return whenever it was recorded, even if
          that return is dated in a later month than this one. The <strong>Total Sales</strong> card's returns figure
          adds Prepaid on top of this; the <strong>Returns (SRN)</strong> card shows a different slice again — only
          returns dated in this specific calendar month, regardless of which month the sale itself was in.
        </FormulaNote>
      </div>
    </div>
  </div>
  );
};

// Small "how this number is calculated" note — plain-English formula + explicit
// callout of what is/isn't netted out, so a figure's methodology is visible right
// where it's used, not just in RECEIVABLES_CYCLE.md.
const FormulaNote = ({ children }) => (
  <div className="mt-4 px-3 py-2.5 rounded-lg flex items-start gap-2" style={{ background: 'var(--page-bg)', border: '1px solid var(--card-border)' }}>
    <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: 'var(--text-muted)' }} />
    <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{children}</p>
  </div>
);

const SalesByChannelModal = ({ rows, period, total, returnedOfThisMonth, onClose }) => {
  const net = Number(total || 0) - Number(returnedOfThisMonth || 0);
  return (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center p-4"
    style={{ background: 'rgba(15,23,42,0.45)' }}
    onClick={onClose}
  >
    <div
      className="w-fit min-w-[26rem] max-w-[92vw] rounded-2xl overflow-hidden"
      style={{ background: 'var(--surface)', border: '1px solid var(--card-border)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--card-border)' }}>
        <div>
          <h3 className="text-base font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
            Sales in {MONTHS[period.month]} {period.year} — by portal
          </h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            COD + Prepaid combined, this month's orders only, grouped by sales channel
          </p>
        </div>
        <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-6 pt-4">
        <div className="flex items-stretch gap-2 mb-5">
          <SummaryStat label={`Total sales (${MONTHS[period.month]} ${period.year})`} value={total} color={COLOR_SALES} />
          <Operator symbol="−" />
          <SummaryStat label="Returns of this month's sales" value={returnedOfThisMonth} color={COLOR_RETURNED} />
          <Operator symbol="=" />
          <SummaryStat label="Net sales this month" value={net} color={COLOR_PRIMARY} big />
        </div>
      </div>
      <div className="px-6 pb-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1.5px solid var(--card-border)' }}>
              {['Portal / channel', 'Orders', 'Sales', 'Share'].map((h) => (
                <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.channel} style={{ borderBottom: '1px solid var(--card-border)' }}>
                <td className="px-2 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>{r.channel}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-body)' }}>{Number(r.count).toLocaleString('en-IN')}</td>
                <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: COLOR_SALES }}>{money(r.amount)}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.amount, total)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={4} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No sales recorded this month.</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
              <td />
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_SALES }}>{money(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <FormulaNote>
          <strong>Formula:</strong> Total sales = SUM(Total) from every order (COD + Prepaid) whose own sale date
          falls in {MONTHS[period.month]} {period.year} — the portal table above is gross, un-netted. Net sales
          (top of this modal) = Total sales − Returns of this month's own sales, where the return can itself be
          processed in this month or a later one (an order sold in March that's returned in April still reduces
          March's net figure once the return is recorded).
          <br /><br />
          <strong>Three different "returns" figures live on this dashboard — they're not meant to match:</strong> this
          one is COD + Prepaid combined, counting a return whenever it happens (any month). The <strong>This month's
          own receivable</strong> card's "Returned" column is the COD-only subset of this same figure. The{' '}
          <strong>Returns (SRN)</strong> card is different again — it shows only returns <em>dated</em> in this
          specific calendar month, regardless of which month the original sale was in.
        </FormulaNote>
      </div>
    </div>
  </div>
  );
};

const ReturnsByMonthTable = ({ rows, period, total }) => (
  <>
    <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
      By origin month — which month's sale is actually being returned
    </p>
    <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--card-border)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
            {['Origin month', 'Returns', 'Amount', 'Share'].map((h) => (
              <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isCurrent = r.month === period.month && r.year === period.year;
            return (
              <tr key={`${r.year}-${r.month}`} style={{ borderBottom: '1px solid var(--card-border)' }}>
                <td className="px-2 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                  {MONTHS[r.month]} {r.year}
                  {isCurrent ? (
                    <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: `${COLOR_SALES}18`, color: COLOR_SALES }}>this month's own</span>
                  ) : (
                    <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: `${COLOR_PENDING}18`, color: COLOR_PENDING }}>carried forward</span>
                  )}
                </td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-body)' }}>{Number(r.count).toLocaleString('en-IN')}</td>
                <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: COLOR_RETURNED }}>{money(r.amount)}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.amount, total)}</td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr><td colSpan={4} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No returns this month.</td></tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
            <td />
            <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_RETURNED }}>{money(total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
    <FormulaNote>
      <strong>Formula:</strong> Every return <em>dated/processed</em> in {MONTHS[period.month]} {period.year}, grouped
      by the month the ORIGINAL sale happened in (not the month the return itself was recorded). A return processed
      this month is often for a sale from an earlier month — that's the "carried forward" tag above, distinct from
      "this month's own" (a sale made and returned in the same month).
      <br /><br />
      <strong>This total won't match the returns figures on the Total Sales or This Month's Own Receivable cards</strong> —
      this one only counts returns dated <em>this specific month</em>. Those other two count every return ever
      recorded for a sale made this month, even if the return itself is dated in a later month — so they can run
      higher than this figure.
    </FormulaNote>
  </>
);

const ReturnsBySourceModal = ({ rows, byMonth, period, total, count, onClose }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center p-4"
    style={{ background: 'rgba(15,23,42,0.45)' }}
    onClick={onClose}
  >
    <div
      className="w-fit min-w-[28rem] max-w-[92vw] rounded-2xl overflow-hidden flex flex-col"
      style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', maxHeight: '88vh' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--card-border)' }}>
        <div>
          <h3 className="text-base font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
            Returns (SRN) in {MONTHS[period.month]} {period.year}
          </h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {Number(count || 0).toLocaleString('en-IN')} return(s) — by origin month and by source
          </p>
        </div>
        <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-6 py-4 overflow-y-auto space-y-5">
        <ReturnsByMonthTable rows={byMonth || []} period={period} total={total} />
        <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>By source (courier / prepaid)</p>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1.5px solid var(--card-border)' }}>
              {['Source', 'Returns', 'Amount', 'Share'].map((h) => (
                <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.source} style={{ borderBottom: '1px solid var(--card-border)' }}>
                <td className="px-2 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>{r.source}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-body)' }}>{Number(r.count).toLocaleString('en-IN')}</td>
                <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: COLOR_RETURNED }}>{money(r.amount)}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.amount, total)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={4} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No returns this month.</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
              <td />
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_RETURNED }}>{money(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
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

const ReceivableDashboard = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();

  const [month, setMonth] = useState(currentDate.getMonth() + 1);
  const [year, setYear] = useState(currentDate.getFullYear());
  // Optional "cycle start" — null means no lower bound (today's default behavior).
  // When set, every figure on the dashboard treats anything sold before this month
  // as if it never existed, not just excludes it from carried-forward.
  const [startMonth, setStartMonth] = useState(null);
  const [startYear, setStartYear] = useState(null);
  const [initialized, setInitialized] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showReceivedModal, setShowReceivedModal] = useState(false);
  const [showReceivableByMonthModal, setShowReceivableByMonthModal] = useState(false);
  const [showThisMonthByCourierModal, setShowThisMonthByCourierModal] = useState(false);
  const [showSalesByChannelModal, setShowSalesByChannelModal] = useState(false);
  const [showCarriedForwardModal, setShowCarriedForwardModal] = useState(false);
  const [showReturnsModal, setShowReturnsModal] = useState(false);
  const [showSettledToDateModal, setShowSettledToDateModal] = useState(false);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot },
  ]);

  const uniqueYears = useMemo(() => {
    const y = currentDate.getFullYear();
    const years = [];
    for (let i = y - 4; i <= y + 1; i++) years.push(i);
    return years.sort((a, b) => b - a);
  }, []);

  const load = useCallback(async (m, y, sm, sy) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (m && y) { params.set('month', m); params.set('year', y); }
      if (sm && sy) { params.set('startMonth', sm); params.set('startYear', sy); }
      const qs = params.toString();
      const res = await api.get(`/api/dashboard/receivables/${brandId}${qs ? `?${qs}` : ''}`);
      setData(res.data);
      if (res.data?.period) {
        setMonth(res.data.period.month);
        setYear(res.data.period.year);
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load receivable dashboard');
    } finally {
      setLoading(false);
      setInitialized(true);
    }
  }, [brandId]);

  // First load: no month/year params, let the backend pick the latest month with data.
  useEffect(() => { load(); }, [load]);

  // Subsequent loads: user changed either picker.
  useEffect(() => {
    if (!initialized) return;
    load(month, year, startMonth, startYear);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, year, startMonth, startYear]);

  const shiftMonth = (delta) => {
    let m = month + delta;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setMonth(m);
    setYear(y);
  };

  const trend = (data?.monthlyTrend || []).map((r) => ({
    label: `${MONTHS[r.month]} ${String(r.year).slice(2)}`,
    Sales: Number(r.sales || 0),
    Received: Number(r.received_same_month || 0),
    'Still pending': Number(r.still_pending || 0),
    Returned: Number(r.returned_amount || 0),
  }));

  const courierAging = data?.courierAging || [];
  const dq = data?.dataQuality || { unmatched_count: 0, unmatched_amount: 0, bySource: [] };
  const k = data?.kpis || {};
  const netSalesThisMonth = Number(k.sales_this_month || 0) - Number(k.returned_of_this_months_sales || 0);

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

        {/* Cycle start picker — sits above the "as of" month/year picker. Setting this
            makes every figure on the dashboard treat anything sold before that month as
            if it never existed (not just excluded from carried-forward) — useful when
            data before a certain point is known-incomplete (e.g. a missing settlement file). */}
        <div
          className="flex items-center justify-between flex-wrap gap-3 px-4 py-3 rounded-2xl"
          style={{ background: `${COLOR_PRIMARY}08`, border: `1px solid ${COLOR_PRIMARY}25` }}
        >
          <div className="flex items-center gap-2.5">
            <RotateCcw className="w-4 h-4 flex-shrink-0" style={{ color: COLOR_PRIMARY }} />
            <div>
              <p className="text-xs font-bold" style={{ color: 'var(--text-heading)' }}>Receivable cycle starts from</p>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Sales before this month are treated as if they don't exist — no carried-forward from earlier data
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={startMonth ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setStartMonth(v === '' ? null : Number(v));
                if (v !== '' && !startYear) setStartYear(year);
              }}
              className="text-sm font-semibold px-3 py-2 rounded-lg"
              style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
            >
              <option value="">No start (use all data)</option>
              {MONTH_NAMES.slice(1).map((name, i) => (
                <option key={name} value={i + 1}>{name}</option>
              ))}
            </select>
            <select
              value={startYear ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setStartYear(v === '' ? null : Number(v));
                if (v !== '' && !startMonth) setStartMonth(1);
              }}
              className="text-sm font-semibold px-3 py-2 rounded-lg"
              style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
            >
              <option value="">—</option>
              {uniqueYears.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            {(startMonth || startYear) && (
              <button
                onClick={() => { setStartMonth(null); setStartYear(null); }}
                className="text-xs font-bold px-3 py-2 rounded-lg"
                style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-muted)' }}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center"
              style={{ background: `${COLOR_PRIMARY}15`, border: `1px solid ${COLOR_PRIMARY}30` }}
            >
              <Wallet className="w-5 h-5" style={{ color: COLOR_PRIMARY }} />
            </div>
            <div>
              <h1 className="text-xl font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow', letterSpacing: '-0.02em' }}>
                Receivable Dashboard
              </h1>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Global receivable position across every Receivable Cycle file loaded for this brand
              </p>
            </div>
          </div>

          {/* Month/year picker */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
              className="p-2 rounded-lg"
              style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-muted)' }}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="text-sm font-semibold px-3 py-2 rounded-lg"
              style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
            >
              {MONTH_NAMES.slice(1).map((name, i) => (
                <option key={name} value={i + 1}>{name}</option>
              ))}
            </select>
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="text-sm font-semibold px-3 py-2 rounded-lg"
              style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
            >
              {uniqueYears.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
              className="p-2 rounded-lg"
              style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-muted)' }}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: COLOR_PRIMARY }} />
          </div>
        )}

        {!loading && error && (
          <div className="p-5 text-sm font-semibold" style={{ ...cardStyle, color: COLOR_RETURNED }}>{error}</div>
        )}

        {!loading && !error && !data?.period && (
          <div className="p-8 text-center" style={cardStyle}>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>
              No Receivable Cycle data loaded for this brand yet.
            </p>
          </div>
        )}

        {!loading && !error && data?.beforeCycleStart && (
          <div className="p-8 text-center" style={{ ...cardStyle, border: `1px solid ${COLOR_PENDING}40` }}>
            <p className="text-sm font-bold" style={{ color: 'var(--text-heading)' }}>
              {MONTHS[month]} {year} is before the cycle start ({MONTHS[data.cycleStart?.month]} {data.cycleStart?.year})
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Pick a later month above, or move/clear the cycle-start picker.
            </p>
          </div>
        )}

        {!loading && !error && data?.period && !data?.beforeCycleStart && (
          <>
            {/* ── The headline equation ─────────────────────────────────
                This is the number a CFO actually wants: Net Sales − Received =
                Receivable, literally, as three cards read left to right. "Received"
                here means settled_of_this_months_sales — how much of THIS month's
                own sale has actually been collected, to date, no matter which later
                calendar month the collection itself landed in — which is what makes
                the subtraction land exactly on Receivable, every month, to the rupee. */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wide mb-3" style={{ color: 'var(--text-muted)' }}>
                {MONTHS[month]} {year} — Net sales − Received = Receivable
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex-1 min-w-[240px]">
                  <KpiCard
                    label={`Net sales — ${MONTHS[month]} ${year}`}
                    value={money(netSalesThisMonth)}
                    sub={`${money(k.sales_this_month)} gross − ${money(k.returned_of_this_months_sales)} returned. Click for breakdown by portal`}
                    icon={TrendingUp} color={COLOR_SALES}
                    onClick={() => setShowSalesByChannelModal(true)}
                  />
                </div>
                <Operator symbol="−" />
                <div className="flex-1 min-w-[240px]">
                  <KpiCard
                    label={`Received — ${MONTHS[month]} ${year}`}
                    value={money(k.settled_of_this_months_sales)}
                    sub="Collected against this month's own sale, as of today. Click for breakdown by source"
                    icon={TrendingUp} color={COLOR_RECEIVED}
                    onClick={() => setShowSettledToDateModal(true)}
                  />
                </div>
                <Operator symbol="=" />
                <div className="flex-1 min-w-[240px]">
                  <KpiCard
                    label={`Receivable — ${MONTHS[month]} ${year}`}
                    value={money(k.this_month_own_receivable)}
                    sub="Still uncollected from this month's own sale. Click for breakdown by partner"
                    icon={Wallet} color={COLOR_PENDING} highlight
                    onClick={() => setShowThisMonthByCourierModal(true)}
                  />
                </div>
              </div>
            </div>

            {/* ── Other figures ─────────────────────────────────────────
                All-time aging (not just this month's own sale) + the separate cash-
                flow view of "Received" — deliberately kept out of the equation above
                because it mixes in old carried-forward collections and excludes this
                month's sale that hasn't been paid yet, so it would never subtract
                cleanly against Net Sales. */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wide mb-3" style={{ color: 'var(--text-muted)' }}>
                All-time position &amp; cash flow
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <KpiCard
                  label={`Total receivable as of ${MONTHS[month]} ${year}`}
                  value={money(k.total_receivable_as_of_date)}
                  sub="Every month's sale combined, still uncollected today. Click for the month-by-month breakdown"
                  icon={Wallet} color={COLOR_PRIMARY}
                  onClick={() => setShowReceivableByMonthModal(true)}
                />
                <KpiCard
                  label="Carried forward (from earlier months)"
                  value={money(k.carried_forward_receivable)}
                  sub="The slice of the total above that's from BEFORE this month. Click to see which month it's from"
                  icon={RotateCcw} color={COLOR_PENDING}
                  onClick={() => setShowCarriedForwardModal(true)}
                />
                <KpiCard
                  label={`Cash collected — ${MONTHS[month]} ${year}`}
                  value={money(k.received_this_month)}
                  sub="Actual cash that arrived THIS calendar month (old dues + new) — a treasury figure, not part of the equation above"
                  icon={TrendingUp} color={COLOR_RECEIVED}
                  onClick={() => setShowReceivedModal(true)}
                />
                <KpiCard
                  label={`Returns (SRN) — ${MONTHS[month]} ${year}`}
                  value={money(k.returns_this_month_amount)}
                  sub={`${Number(k.returns_this_month_count || 0).toLocaleString('en-IN')} return(s) — click for breakdown`}
                  icon={TrendingDown} color={COLOR_RETURNED}
                  onClick={() => setShowReturnsModal(true)}
                />
              </div>
            </div>

            {/* ── Trend chart ─────────────────────────────────────────── */}
            <SectionCard title="Sales, collections & pending — last 12 months" icon={TrendingUp}>
              <div style={{ width: '100%', height: 320 }}>
                <ResponsiveContainer>
                  <LineChart data={trend} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--card-border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={{ stroke: 'var(--card-border)' }} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
                      tickFormatter={(v) => `₹${(v / 100000).toFixed(0)}L`} />
                    <Tooltip content={<TrendTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="Sales" stroke={COLOR_SALES} strokeWidth={2} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="Received" stroke={COLOR_RECEIVED} strokeWidth={2} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="Still pending" stroke={COLOR_PENDING} strokeWidth={2} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="Returned" stroke={COLOR_RETURNED} strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>
                "Still pending" reflects today's ledger state for orders sold in that month — not a historical
                point-in-time balance. It answers "of what we sold in month X, how much is still stuck today."
              </p>
            </SectionCard>

            {/* ── Courier aging ───────────────────────────────────────── */}
            <SectionCard
              title="Receivable aging by courier (all-time, COD only)"
              icon={RotateCcw}
              right={<span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Explains where pending amounts sit</span>}
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ borderBottom: '1.5px solid var(--card-border)' }}>
                      {['Courier', 'Orders', 'Total sales', 'Settled', 'Returned', 'Pending', 'Pending %'].map((h) => (
                        <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {courierAging.map((c) => {
                      const pendingPct = Number(c.pending_amount || 0) / Number(c.total_amount || 1);
                      const flagged = pendingPct > 0.85 && Number(c.total_orders) > 20;
                      return (
                        <tr key={c.courier} style={{ borderBottom: '1px solid var(--card-border)' }}>
                          <td className="px-2 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                            {c.courier}
                            {flagged && (
                              <span
                                className="ml-2 inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full align-middle"
                                style={{ background: `${COLOR_PENDING}18`, color: COLOR_PENDING, border: `1px solid ${COLOR_PENDING}40` }}
                                title="Unusually high pending rate — likely a missing settlement-file source, not a real collection problem"
                              >
                                <AlertTriangle className="w-2.5 h-2.5" /> check data
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2.5" style={{ color: 'var(--text-body)' }}>{Number(c.total_orders).toLocaleString('en-IN')}</td>
                          <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-body)' }}>{money(c.total_amount)}</td>
                          <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: COLOR_RECEIVED }}>{money(c.settled_amount)}</td>
                          <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: Number(c.returned_amount) > 0 ? COLOR_RETURNED : 'var(--text-muted)' }}>{money(c.returned_amount)}</td>
                          <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: COLOR_PENDING }}>{money(c.pending_amount)}</td>
                          <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(c.pending_amount, c.total_amount)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <FormulaNote>
                <strong>Formula:</strong> Total sales = Settled + Returned + Pending, exactly, per courier (all-time).
                Settled = paid out and never returned. Returned = ever returned, regardless of an earlier settlement.
                Pending = neither — the only bucket counted as still receivable.
              </FormulaNote>
            </SectionCard>

            {/* ── Data quality ─────────────────────────────────────────── */}
            {Number(dq.unmatched_count) > 0 && (
              <SectionCard title="Data quality — unmatched settlements & returns" icon={Info}>
                <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                  {Number(dq.unmatched_count).toLocaleString('en-IN')} settlement/return row(s) worth {money(dq.unmatched_amount)}{' '}
                  didn't match any known order — usually because that order's original sale file hasn't been loaded yet
                  (e.g. a settlement covering a period before the earliest Tally file we have). These amounts are
                  <strong> excluded</strong> from the figures above rather than guessed at.
                </p>
                <div className="flex flex-wrap gap-3">
                  {(dq.bySource || []).map((s) => (
                    <div key={s.source} className="px-3 py-2 rounded-lg text-xs" style={{ background: 'var(--page-bg)', border: '1px solid var(--card-border)' }}>
                      <span className="font-bold capitalize" style={{ color: 'var(--text-heading)' }}>{s.source}</span>
                      <span style={{ color: 'var(--text-muted)' }}> — {Number(s.count).toLocaleString('en-IN')} rows, {money(s.amount)}</span>
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}

            {/* ── Sheet data browser ───────────────────────────────────── */}
            <ReceivableSheetBrowser brandId={brandId} month={month} year={year} />
          </>
        )}
      </div>

      {showReceivedModal && (
        <ReceivedBreakdownModal data={data} period={{ month, year }} onClose={() => setShowReceivedModal(false)} />
      )}
      {showReceivableByMonthModal && (
        <ReceivableByMonthModal
          title={`Total receivable as of ${MONTHS[month]} ${year} — how it's made up`}
          subtitle="Carried forward from earlier months + this month's own sales, still uncollected today (COD+Prepaid combined — Prepaid always nets to ₹0 since it settles same-month; the partner breakdown below is COD only because Prepaid has no courier)"
          total={k.total_receivable_as_of_date}
          showMonthTable={false}
          summary={[
            { label: 'Carried forward (earlier months)', value: k.carried_forward_receivable, color: COLOR_PENDING },
            { label: `This month's own (${MONTHS[month]} ${year})`, value: k.this_month_own_receivable, color: COLOR_PENDING },
            { label: 'Total receivable', value: k.total_receivable_as_of_date, color: COLOR_PRIMARY },
          ]}
          partnerRows={data?.receivableByCourierAsOfDate || []}
          onClose={() => setShowReceivableByMonthModal(false)}
        />
      )}
      {showCarriedForwardModal && (
        <ReceivableByMonthModal
          title={`Carried forward as of ${MONTHS[month]} ${year} — by origin month`}
          subtitle="Orders sold BEFORE this month, still uncollected today — excludes this month's own sales (COD+Prepaid combined; Prepaid nets to ₹0)"
          rows={(data?.receivableByMonth || []).filter((r) => !(r.month === month && r.year === year))}
          total={k.carried_forward_receivable}
          movementNote={
            Number(k.received_from_carried_forward || 0) > 0
              ? `${money(k.received_from_carried_forward)} of this backlog was already collected in ${MONTHS[month]} ${year} (see the "Received" card's earlier-months breakdown) — it's already excluded from the ${money(k.carried_forward_receivable)} below, since those orders are now marked settled. Don't subtract it again; the figure below is the balance AFTER that collection, not before it.`
              : null
          }
          onClose={() => setShowCarriedForwardModal(false)}
        />
      )}
      {showThisMonthByCourierModal && (
        <ThisMonthByCourierModal
          rows={data?.thisMonthPendingByCourier || []}
          total={k.this_month_own_receivable}
          period={{ month, year }}
          onClose={() => setShowThisMonthByCourierModal(false)}
        />
      )}
      {showSettledToDateModal && (
        <SettledToDateModal
          rows={data?.settledOfThisMonthsSalesBySource || []}
          total={k.settled_of_this_months_sales}
          period={{ month, year }}
          onClose={() => setShowSettledToDateModal(false)}
        />
      )}
      {showSalesByChannelModal && (
        <SalesByChannelModal
          rows={data?.salesByChannel || []}
          total={k.sales_this_month}
          returnedOfThisMonth={k.returned_of_this_months_sales}
          period={{ month, year }}
          onClose={() => setShowSalesByChannelModal(false)}
        />
      )}
      {showReturnsModal && (
        <ReturnsBySourceModal
          rows={data?.returnsBySource || []}
          byMonth={data?.returnsByMonth || []}
          total={k.returns_this_month_amount}
          count={k.returns_this_month_count}
          period={{ month, year }}
          onClose={() => setShowReturnsModal(false)}
        />
      )}
    </DashboardLayout>
  );
};

export default ReceivableDashboard;

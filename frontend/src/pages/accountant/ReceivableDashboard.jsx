import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  ArrowLeft, Wallet, TrendingUp, TrendingDown, RotateCcw, AlertTriangle,
  LayoutDashboard, Bot, Loader2, X, ChevronLeft, ChevronRight, Info, HandCoins, Search, CalendarDays,
} from 'lucide-react';
import api from '../../lib/api';
import { sidebarFor } from '../../lib/adminNav';
import ReceivableSheetBrowser from '../../components/reco/ReceivableSheetBrowser';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// This dashboard is locked to Shopify only — every other portal (Amazon, Flipkart,
// Pepperfry, etc.) is excluded from every figure below, no picker to change it.
const RECEIVABLE_CHANNEL = 'Shopify';
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

// Crore/Lakh shorthand alongside the exact rupee figure in the detail modals'
// tables & bridges (e.g. "₹4,98,39,276 (₹4.98 Cr)") — the precise figure stays
// primary (it's what the formula footnotes reconcile against), this is just a
// faster read for anything a human would otherwise have to count commas on.
// Left out below ₹1 lakh, where the plain figure is already quick to read.
const shortIndian = (n) => {
  if (n == null) return null;
  const abs = Math.abs(Number(n));
  if (!Number.isFinite(abs) || abs < 100000) return null;
  if (abs < 10000000) return `₹${(Number(n) / 100000).toFixed(2)} L`;
  return `₹${(Number(n) / 10000000).toFixed(2)} Cr`;
};

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

const ReceivedSplitTable = ({ title, subtitle, rows, keyField, onOpenJourney, simplified }) => {
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const dimType = keyField === 'source' ? 'source' : 'channel';
  const j = (r, metricKey, label, color) => (onOpenJourney ? () => onOpenJourney({ metricKey, label: `${label} — ${r[keyField]}`, color, dimension: { type: dimType, value: r[keyField] } }) : undefined);

  // Simplified layout — same shape as the "by origin month & partner" table above it
  // (label | Orders | Amount | Share), so this table adds new information (which
  // source/portal) instead of repeating that one's this-month/earlier-months split.
  if (simplified) {
    return (
      <>
        <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>{title}</p>
        <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--card-border)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                {[keyField === 'source' ? 'Source' : 'Portal', 'Orders', 'Amount', 'Share'].map((h) => (
                  <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r[keyField]} style={{ borderBottom: '1px solid var(--card-border)' }}>
                  <td className="px-2 py-2.5 font-semibold capitalize whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>{r[keyField]}</td>
                  <td className="px-2 py-2.5" style={{ color: 'var(--text-body)' }}>{Number(r.count).toLocaleString('en-IN')}</td>
                  <td className="px-2 py-2.5 whitespace-nowrap font-semibold">
                    <Num value={r.amount} color={COLOR_RECEIVED} onClick={j(r, 'received_this_month', 'Total received', COLOR_RECEIVED)} />
                  </td>
                  <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.amount, total)}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={4} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No collections recorded this month.</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
                <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: 'var(--text-body)' }}>
                  {rows.reduce((s, r) => s + Number(r.count || 0), 0).toLocaleString('en-IN')}
                </td>
                <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_RECEIVED }}>{money(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="text-xs font-bold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)' }}>{title}</p>
      {subtitle && <p className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>}
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
                <td className="px-2 py-2.5 whitespace-nowrap"><Num value={r.from_this_month} color={COLOR_RECEIVED} onClick={j(r, 'received_from_own', 'Received: this month\'s sale', COLOR_RECEIVED)} /></td>
                <td className="px-2 py-2.5 whitespace-nowrap"><Num value={r.from_earlier_months} color={Number(r.from_earlier_months) > 0 ? COLOR_PENDING : 'var(--text-muted)'} onClick={j(r, 'received_from_carried_forward', 'Received: earlier months\' sale', COLOR_PENDING)} /></td>
                <td className="px-2 py-2.5 whitespace-nowrap font-semibold"><Num value={r.amount} color="var(--text-heading)" onClick={j(r, 'received_this_month', 'Total received', COLOR_PRIMARY)} /></td>
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

// A settled Prepaid order shows up as one lump row in a "by source" table
// (settled_source is the literal 'delivered' once a delivery_status upload
// confirms it, so it has no courier to split by) — this renders the
// same population split two ways instead, right under that row: by sales channel
// (the Tally-tagged portal — Amazon/Flipkart/Shopify/etc.) AND, per channel, by the
// actual payment gateway that financed it (Snapmint/BharatX/Razorpay), matched from
// the Shopify Order Cycle agent's own settlement columns. That match only ever
// exists for Shopify-side orders — every other channel legitimately shows "No
// gateway match", which is a fact about the data (Amazon/Flipkart/Zepto prepaid
// orders settle through the marketplace itself), not a missing join. Keeping both
// dimensions as explicit columns (rather than folding "Snapmint" into one bucket)
// is what stops a channel literally named "Snapmint" in Tally from being confused
// with the Snapmint payment gateway — they're unrelated facts that happen to share
// a name. `rows` is a flat [{channel, gateway, count, amount}] list, grouped by
// channel here for display. Not wired into the "click for journey" drill-down:
// NumberJourneyModal only filters by one dimension at a time (channel OR source),
// so a combined "Prepaid + this channel + this gateway" journey isn't representable
// without leaking in non-prepaid or other-channel orders.
const PrepaidChannelBreakdown = ({ rows, amountLabel = 'Amount', color = COLOR_PRIMARY }) => {
  if (!rows?.length) return null;
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);

  const byChannel = [];
  const idxOf = new Map();
  for (const r of rows) {
    if (!idxOf.has(r.channel)) { idxOf.set(r.channel, byChannel.length); byChannel.push({ channel: r.channel, count: 0, amount: 0, gateways: [] }); }
    const g = byChannel[idxOf.get(r.channel)];
    g.count += Number(r.count || 0);
    g.amount += Number(r.amount || 0);
    g.gateways.push(r);
  }
  byChannel.sort((a, b) => b.amount - a.amount);
  byChannel.forEach((g) => g.gateways.sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0)));

  return (
    <div className="mt-2 mb-3 pl-3" style={{ borderLeft: `2px solid ${color}30` }}>
      <p className="text-[11px] font-bold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)' }}>
        Prepaid — by sales channel &amp; payment gateway
      </p>
      <p className="text-[10px] mb-1.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        "Channel" = the sales portal an order came from (Tally). "Gateway" = the payment processor that actually
        financed it (Snapmint / BharatX / Razorpay), matched from the Shopify Order Cycle agent's settlement files —
        only ever available for Shopify-side orders, so every other channel shows "No gateway match" by design, not
        as a gap. A "Snapmint" or "Zepto" channel row here is a Tally channel tag, not the payment gateway.
      </p>
      <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--card-border)' }}>
        <table className="w-full text-xs">
          <thead>
            <tr style={{ background: 'var(--page-bg)', borderBottom: '1px solid var(--card-border)' }}>
              {['Channel', 'Gateway', 'Orders', amountLabel, 'Share of Prepaid'].map((h) => (
                <th key={h} className="px-2 py-1.5 text-left font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {byChannel.map((g) => g.gateways.map((r, i) => (
              <tr key={`${g.channel}-${r.gateway}`} style={{ borderBottom: i === g.gateways.length - 1 ? '1px solid var(--card-border)' : '1px dashed var(--card-border)' }}>
                {i === 0 && (
                  <td
                    rowSpan={g.gateways.length}
                    className="px-2 py-1.5 font-semibold whitespace-nowrap align-top"
                    style={{ color: 'var(--text-heading)', borderRight: '1px solid var(--card-border)' }}
                  >
                    {g.channel}
                  </td>
                )}
                <td
                  className="px-2 py-1.5 whitespace-nowrap"
                  style={{ color: r.gateway === 'No gateway match' ? 'var(--text-muted)' : 'var(--text-body)', fontStyle: r.gateway === 'No gateway match' ? 'italic' : 'normal' }}
                >
                  {r.gateway}
                </td>
                <td className="px-2 py-1.5" style={{ color: 'var(--text-body)' }}>{Number(r.count).toLocaleString('en-IN')}</td>
                <td className="px-2 py-1.5 whitespace-nowrap font-semibold" style={{ color }}>{money(r.amount)}</td>
                <td className="px-2 py-1.5" style={{ color: 'var(--text-muted)' }}>{pct(r.amount, total)}</td>
              </tr>
            )))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} className="px-2 py-1.5 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
              <td className="px-2 py-1.5 font-black whitespace-nowrap" style={{ color: 'var(--text-body)' }}>
                {rows.reduce((s, r) => s + Number(r.count || 0), 0).toLocaleString('en-IN')}
              </td>
              <td className="px-2 py-1.5 font-black whitespace-nowrap" style={{ color }}>{money(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
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

const ReceivedBreakdownModal = ({ data, period, onOpenJourney, onClose }) => {
  const bySource = data?.receivedBySource || [];
  const byChannel = data?.receivedByChannel || [];
  const prepaidByChannel = data?.receivedPrepaidByChannel || [];
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
              Cash actually collected this month, not sales — includes prepaid (settled once a delivery_status
              upload confirms delivery) and courier COD settlements, net of any of those orders later returned by
              this month's own close
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto space-y-5">
          <div className="flex items-stretch gap-2">
            <SummaryStat label={`Received — for ${MONTHS[period.month]} ${period.year}'s own sale`} value={k.received_from_this_months_sales} color={COLOR_RECEIVED} onClick={onOpenJourney ? () => onOpenJourney({ metricKey: 'received_from_own', label: "Received — this month's own sale", color: COLOR_RECEIVED }) : undefined} />
            <Operator symbol="+" />
            <SummaryStat label="Received — for earlier months' sale" value={k.received_from_carried_forward} color={COLOR_PENDING} onClick={onOpenJourney ? () => onOpenJourney({ metricKey: 'received_from_carried_forward', label: "Received — earlier months' sale", color: COLOR_PENDING }) : undefined} />
            <Operator symbol="=" />
            <SummaryStat label="Total received" value={k.received_this_month} color={COLOR_PRIMARY} big onClick={onOpenJourney ? () => onOpenJourney({ metricKey: 'received_this_month', label: 'Cash collected', color: COLOR_PRIMARY }) : undefined} />
          </div>

          <CarriedForwardCollectionsTable rows={carriedForward} />
          <ReceivedSplitTable title="Received this month" rows={bySource} keyField="source" onOpenJourney={onOpenJourney} simplified />
          <PrepaidChannelBreakdown rows={prepaidByChannel} amountLabel="Received" />
          <ReceivedSplitTable
            title="How the totals above split — by source"
            subtitle="Ties the summary strip to the two tables above: This month's sale + Earlier months' sale = the Amount in the table right above; Earlier months' sale here is that same source's rows in Table 1 combined."
            rows={bySource} keyField="source" onOpenJourney={onOpenJourney}
          />
          <ReceivedSplitTable title="By portal / channel" rows={byChannel} keyField="channel" onOpenJourney={onOpenJourney} />
        </div>
      </div>
    </div>
  );
};

// A bigger, more legible stat block than a plain KPI chip — used for the "how it's
// calculated" arithmetic view (Carried forward + This month's own = Total).
const SummaryStat = ({ label, value, color, big, onClick }) => {
  const short = shortIndian(value);
  return (
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
      <p className={big ? 'text-2xl font-black mt-1' : 'text-xl font-black mt-1'} style={{ color, fontFamily: 'Barlow' }}>
        {money(value)}
        {short && <span className="font-semibold ml-1.5" style={{ opacity: 0.6, fontSize: '0.6em' }}>({short})</span>}
      </p>
    </div>
  );
};

// Backs the reconciliation strip's "Settled to date" box — of THIS MONTH'S OWN
// sales, how much has settled and from where (courier / prepaid), regardless of
// which calendar month the settlement itself happened in. Not the same table as
// "Received → by source" (ReceivedSplitTable), which is filtered by settled_month
// instead of order_month — see RECEIVABLES_CYCLE.md §4/§5 for the distinction.
const SettledToDateModal = ({ rows, prepaidByChannel, period, total, onOpenJourney, onClose }) => (
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
            Settled as of {MONTHS[period.month]} {period.year}'s close — {MONTHS[period.month]} {period.year}'s own sales
          </h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            COD + Prepaid combined. Counts a settlement as long as it landed on or before this month's own close —
            an order sold this month but settled later in this same month still counts here, under its actual
            source; one settled after this month's close doesn't count until that later month is selected.
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
                <td className="px-2 py-2.5 whitespace-nowrap font-semibold">
                  <Num value={r.amount} color={COLOR_RECEIVED} onClick={onOpenJourney ? () => onOpenJourney({ metricKey: 'settled_of_own', label: `Settled — ${r.source}`, color: COLOR_RECEIVED, dimension: { type: 'source', value: r.source } }) : undefined} />
                </td>
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
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: 'var(--text-body)' }}>
                {rows.reduce((s, r) => s + Number(r.count || 0), 0).toLocaleString('en-IN')}
              </td>
              <td className="px-2 py-3 font-black whitespace-nowrap">
                <Num value={total} color={COLOR_RECEIVED} onClick={onOpenJourney ? () => onOpenJourney({ metricKey: 'settled_of_own', label: 'Settled to date', color: COLOR_RECEIVED }) : undefined} />
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
        <PrepaidChannelBreakdown rows={prepaidByChannel} amountLabel="Settled" />
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

// Numeric opening -> movements -> closing bridge — the actual rupee-by-rupee
// transformation behind a KPI, in place of prose. `rows` are the movements
// (each optionally signed "−"); the final band is the reconciled result.
const MovementBridge = ({ title, rows, resultLabel, resultValue, resultColor, resultJourney, onOpenJourney }) => (
  <div className="mb-5">
    {title && (
      <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>{title}</p>
    )}
    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--card-border)' }}>
      {rows.map((r, i) => (
        <div
          key={r.label}
          className="flex items-center justify-between gap-3 px-4 py-2.5"
          style={{ borderBottom: '1px solid var(--card-border)', background: i % 2 ? 'var(--page-bg)' : 'transparent' }}
        >
          <span className="text-xs font-semibold" style={{ color: 'var(--text-body)' }}>{r.label}</span>
          <span className="text-sm font-bold whitespace-nowrap">
            {r.sign ? `${r.sign} ` : ''}
            <Num value={r.value} color={r.color || 'var(--text-heading)'} onClick={r.journey && onOpenJourney ? () => onOpenJourney(r.journey) : undefined} />
          </span>
        </div>
      ))}
      <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ background: `${resultColor}12` }}>
        <span className="text-xs font-black uppercase tracking-wide" style={{ color: resultColor }}>{resultLabel}</span>
        <span className="text-base font-black whitespace-nowrap" style={{ fontFamily: 'Barlow' }}>
          <Num value={resultValue} color={resultColor} bold onClick={resultJourney && onOpenJourney ? () => onOpenJourney(resultJourney) : undefined} />
        </span>
      </div>
    </div>
  </div>
);

// Generic "by origin month" breakdown — reused by both the "Total receivable" card
// (arithmetic summary + a by-partner table, no month table) and the "Carried forward"
// card (just the by-month table for earlier months, no summary, no partner table).
const ReceivableByMonthModal = ({ title, subtitle, rows = [], total, summary, showMonthTable = true, partnerRows, bridges, onOpenJourney, onClose }) => {
  // `rows` only ever covers COD orders (receivableByMonth is a
  // payment_method = 'COD' query — see dashboardController.js), but `total` is
  // COD + Prepaid combined (a Prepaid order stays "receivable" until a
  // delivery_status upload confirms it). So the two don't sum to the same
  // number on their own — the gap is exactly the Prepaid slice, which isn't
  // tracked per origin month. Surfacing it as its own row (instead of a silent
  // gap between the table and the Total underneath it) is what actually makes
  // "Total" reconcile to the rupee against what's on screen.
  const codPendingSum = rows.reduce((s, r) => s + Number(r.pending || 0), 0);
  const prepaidPending = Number(total || 0) - codPendingSum;
  const showPrepaidRow = showMonthTable && Math.abs(prepaidPending) >= 1;

  return (
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

        {bridges && bridges.map((b) => <MovementBridge key={b.resultLabel} {...b} onOpenJourney={onOpenJourney} />)}

        {showMonthTable && (
          <>
            <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>By origin month</p>
            <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--card-border)' }}>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                    {['Month', 'COD sales', 'Settled', 'Returned', 'Still pending', '% of that month', 'Share of total'].map((h) => (
                      <th key={h} className="px-2 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const origin = { month: r.month, year: r.year };
                    const j = (metricKey, label, color) => (onOpenJourney ? () => onOpenJourney({ metricKey, label, color, origin }) : undefined);
                    return (
                      <tr key={`${r.year}-${r.month}`} style={{ borderBottom: '1px solid var(--card-border)' }}>
                        <td className="px-2 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>{MONTHS[r.month]} {r.year}</td>
                        <td className="px-2 py-2.5 whitespace-nowrap"><Num value={r.cod_sales} color="var(--text-body)" onClick={j('sales', `${MONTHS[r.month]} ${r.year} — COD sales`, COLOR_SALES)} /></td>
                        <td className="px-2 py-2.5 whitespace-nowrap"><Num value={r.settled_amount} color={COLOR_RECEIVED} onClick={j('settled_of_own', `${MONTHS[r.month]} ${r.year} — settled`, COLOR_RECEIVED)} /></td>
                        <td className="px-2 py-2.5 whitespace-nowrap"><Num value={r.returned_amount} color={Number(r.returned_amount) > 0 ? COLOR_RETURNED : 'var(--text-muted)'} onClick={j('returned_of_own', `${MONTHS[r.month]} ${r.year} — returned`, COLOR_RETURNED)} /></td>
                        <td className="px-2 py-2.5 whitespace-nowrap font-semibold"><Num value={r.pending} color={Number(r.pending) > 0 ? COLOR_PENDING : 'var(--text-muted)'} onClick={j('this_month_own_receivable', `${MONTHS[r.month]} ${r.year} — still pending`, COLOR_PENDING)} /></td>
                        <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.pending, r.cod_sales)}</td>
                        <td className="px-2 py-2.5 font-semibold" style={{ color: 'var(--text-muted)' }}>{pct(r.pending, total)}</td>
                      </tr>
                    );
                  })}
                  {showPrepaidRow && (
                    <tr style={{ borderBottom: '1px solid var(--card-border)', background: `${COLOR_PENDING}08` }}>
                      <td className="px-2 py-2.5 font-semibold italic whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>Prepaid (all months)</td>
                      <td className="px-2 py-2.5 text-xs italic" style={{ color: 'var(--text-muted)' }}>not tracked by month</td>
                      <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>—</td>
                      <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>—</td>
                      <td className="px-2 py-2.5 font-semibold"><Num value={prepaidPending} color={COLOR_PENDING} /></td>
                      <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>—</td>
                      <td className="px-2 py-2.5 font-semibold" style={{ color: 'var(--text-muted)' }}>{pct(prepaidPending, total)}</td>
                    </tr>
                  )}
                  {!rows.length && !showPrepaidRow && (
                    <tr><td colSpan={7} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No COD data yet.</td></tr>
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
                    <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_PENDING }}>
                      <Num value={total} color={COLOR_PENDING} bold />
                    </td>
                    <td />
                    <td className="px-2 py-3 font-black" style={{ color: 'var(--text-muted)' }}>100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <FormulaNote>
              <strong>Formula:</strong> COD sales = Settled + Returned + Still pending, exactly, for every month, all
              measured as of the selected month's own close. An order counts as <strong>Settled</strong> only if it
              was paid out on or before that close AND never returned by then; as <strong>Returned</strong> if it was
              returned by then (even if a courier had briefly remitted it first — that cash is not real revenue once
              the item comes back); and <strong>Still pending</strong> only if it's neither yet. A settlement or
              return that happens after the selected month's close doesn't count until that later month is selected.
              {showPrepaidRow && (
                <> The <strong>Prepaid (all months)</strong> row is the gap between this COD-only table and the
                combined COD+Prepaid Total above it — a Prepaid order stays "still receivable" until a
                delivery_status upload confirms delivery, but isn't itemized by origin month the way COD is.</>
              )}
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
                      <td className="px-2 py-2.5 whitespace-nowrap font-semibold">
                        <Num
                          value={r.pending_amount} color={COLOR_PENDING}
                          onClick={onOpenJourney && r.courier ? () => onOpenJourney({ metricKey: 'total_receivable_as_of', label: `Total receivable — ${r.courier}`, color: COLOR_PENDING, dimension: { type: 'courier', value: r.courier } }) : undefined}
                        />
                      </td>
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
};

const ThisMonthByCourierModal = ({ rows, period, total, onOpenJourney, onClose }) => {
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
            By courier/partner — COD only (Prepaid has no courier to group by, so it never appears in this table
            regardless of settlement status; see the dashboard's reconciliation strip for the full COD+Prepaid identity)
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
          <SummaryStat
            label="Pending (this card's number)" value={total} color={COLOR_PENDING} big
            onClick={onOpenJourney ? () => onOpenJourney({ metricKey: 'this_month_own_receivable', label: "This month's own receivable", color: COLOR_PENDING }) : undefined}
          />
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
            {rows.map((r) => {
              const j = (metricKey, label, color) => (onOpenJourney && r.courier ? () => onOpenJourney({ metricKey, label: `${label} — ${r.courier}`, color, dimension: { type: 'courier', value: r.courier } }) : undefined);
              return (
                <tr key={r.courier} style={{ borderBottom: '1px solid var(--card-border)' }}>
                  <td className="px-2 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>{r.courier || 'Uncategorized'}</td>
                  <td className="px-2 py-2.5" style={{ color: 'var(--text-body)' }}>{Number(r.total_orders).toLocaleString('en-IN')}</td>
                  <td className="px-2 py-2.5 whitespace-nowrap"><Num value={r.total_amount} color="var(--text-body)" onClick={j('sales', 'Sales', COLOR_SALES)} /></td>
                  <td className="px-2 py-2.5 whitespace-nowrap"><Num value={r.settled_amount} color={COLOR_RECEIVED} onClick={j('settled_of_own', 'Settled', COLOR_RECEIVED)} /></td>
                  <td className="px-2 py-2.5 whitespace-nowrap"><Num value={r.returned_amount} color={Number(r.returned_amount) > 0 ? COLOR_RETURNED : 'var(--text-muted)'} onClick={j('returned_of_own', 'Returned', COLOR_RETURNED)} /></td>
                  <td className="px-2 py-2.5 whitespace-nowrap font-semibold"><Num value={r.pending_amount} color={Number(r.pending_amount) > 0 ? COLOR_PENDING : COLOR_RECEIVED} onClick={j('this_month_own_receivable', 'Pending', COLOR_PENDING)} /></td>
                  <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.pending_amount, r.total_amount)}</td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan={7} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No COD sales this month.</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: 'var(--text-body)' }}>
                {rows.reduce((s, r) => s + Number(r.total_orders || 0), 0).toLocaleString('en-IN')}
              </td>
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_SALES }}>
                {money(rows.reduce((s, r) => s + Number(r.total_amount || 0), 0))}
              </td>
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
          orders only (receivable is a COD-only concept), and it counts a return as long as it was recorded on or
          before this month's own close, even if that return is dated in a later-but-still-closed month than this
          one; a return recorded after this month's close doesn't count until that later month is selected. The{' '}
          <strong>Total Sales</strong> card's returns figure adds Prepaid on top of this; the <strong>Returns
          (SRN)</strong> card shows a different slice again — only returns dated in this specific calendar month,
          regardless of which month the sale itself was in.
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

const SalesByChannelModal = ({ rows, period, total, returnedOfThisMonth, onOpenJourney, onClose }) => {
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
          <SummaryStat label={`Total sales (${MONTHS[period.month]} ${period.year})`} value={total} color={COLOR_SALES} onClick={onOpenJourney ? () => onOpenJourney({ metricKey: 'sales', label: 'Sales', color: COLOR_SALES }) : undefined} />
          <Operator symbol="−" />
          <SummaryStat label="Returns of this month's sales" value={returnedOfThisMonth} color={COLOR_RETURNED} onClick={onOpenJourney ? () => onOpenJourney({ metricKey: 'returned_of_own', label: "Returns — this month's own sale", color: COLOR_RETURNED }) : undefined} />
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
                <td className="px-2 py-2.5 whitespace-nowrap font-semibold">
                  <Num value={r.amount} color={COLOR_SALES} onClick={onOpenJourney ? () => onOpenJourney({ metricKey: 'sales', label: `Sales — ${r.channel}`, color: COLOR_SALES, dimension: { type: 'channel', value: r.channel } }) : undefined} />
                </td>
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
              <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: 'var(--text-body)' }}>
                {rows.reduce((s, r) => s + Number(r.count || 0), 0).toLocaleString('en-IN')}
              </td>
              <td className="px-2 py-3 font-black whitespace-nowrap">
                <Num value={total} color={COLOR_SALES} onClick={onOpenJourney ? () => onOpenJourney({ metricKey: 'sales', label: 'Sales', color: COLOR_SALES }) : undefined} />
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
        <FormulaNote>
          <strong>Formula:</strong> Total sales = SUM(Total) from every order (COD + Prepaid) whose own sale date
          falls in {MONTHS[period.month]} {period.year} — the portal table above is gross, un-netted. Net sales
          (top of this modal) = Total sales − Returns of this month's own sales, where the return can itself be
          processed in this same month or an earlier-closing one, as long as it landed on or before this month's
          own close (an order sold in March that's returned later in March still reduces March's net figure once
          the return is recorded; one only returned in April doesn't count until April is selected).
          <br /><br />
          <strong>Three different "returns" figures live on this dashboard — they're not meant to match:</strong> this
          one is COD + Prepaid combined, counting a return as of this month's own close (any same-or-earlier-closing
          month it was actually recorded in). The <strong>This month's own receivable</strong> card's "Returned"
          column is the COD-only subset of this same figure. The <strong>Returns (SRN)</strong> card is different
          again — it shows only returns <em>dated</em> in this specific calendar month, regardless of which month
          the original sale was in.
        </FormulaNote>
      </div>
    </div>
  </div>
  );
};

const ReturnsByMonthTable = ({ rows, period, total }) => (
  <>
    <p className="text-xs font-bold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)' }}>
      By origin month — which month's sale is actually being returned
    </p>
    <p className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
      A "carried forward" row's returns can include orders the courier had <strong>already settled</strong> and only
      got reversed this month — those already left the carried-forward balance before this return happened, so only
      the still-open portion is what the Carried Forward card's "Returned" movement shows.
    </p>
    <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--card-border)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
            {['Origin month', 'Returns', 'Already settled', 'Amount', 'Share'].map((h) => (
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
                <td className="px-2 py-2.5 whitespace-nowrap">
                  <div className="font-semibold" style={{ color: 'var(--text-body)' }}>{money(r.already_settled_amount)}</div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{Number(r.already_settled_count).toLocaleString('en-IN')} orders</div>
                </td>
                <td className="px-2 py-2.5 whitespace-nowrap font-semibold" style={{ color: COLOR_RETURNED }}>{money(r.amount)}</td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.amount, total)}</td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr><td colSpan={5} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No returns this month.</td></tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
            <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: 'var(--text-body)' }}>
              {rows.reduce((s, r) => s + Number(r.count || 0), 0).toLocaleString('en-IN')}
            </td>
            <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: 'var(--text-body)' }}>
              {money(rows.reduce((s, r) => s + Number(r.already_settled_amount || 0), 0))}
            </td>
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

// A return only creates a refund liability on the Payables Dashboard if cash had
// already landed before the return — courier remittance for COD (exact same
// predicate as PAYABLE_LEDGER_COLLECTED_THEN_RETURNED in dashboardController.js).
// A plain RTO before collection never touches Payables, by design. Without this
// strip a return can look like it "vanished" between the two dashboards; this
// makes the split (and the link to where the collected slice actually shows up)
// explicit instead of leaving it to be discovered by digging into the data.
// Covers COD couriers here — Shopify Prepaid is a separate leg entirely, tracked
// in shopify_order_cycle (Payables' "Prepaid Gateway" source), not this table.
const ReturnsPayablesBridge = ({ rows, brandId, period, onOpenJourney }) => {
  const navigate = useNavigate();
  const collected = rows.reduce((s, r) => s + Number(r.collected_amount || 0), 0);
  const collectedCount = rows.reduce((s, r) => s + Number(r.collected_count || 0), 0);
  const rto = rows.reduce((s, r) => s + Number(r.rto_amount || 0), 0);
  const rtoCount = rows.reduce((s, r) => s + Number(r.rto_count || 0), 0);
  if (!rows.length || (collected + rto) <= 0) return null;

  // Any source where every return this month shows as RTO (nothing collected)
  // is worth a nudge — could be genuine RTOs, or could be that courier's
  // settlement file for this period just hasn't been uploaded yet, which would
  // silently masquerade as "nothing collected" the same way a data gap does
  // elsewhere on this dashboard (see courierAging's near-100%-pending case).
  const allRto = rows.filter((r) => Number(r.rto_count || 0) > 0 && Number(r.collected_count || 0) === 0);

  return (
    <div className="mb-5">
      <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
        Returns — where the liability actually sits
      </p>
      <div className="flex items-stretch gap-2 mb-2">
        <SummaryStat
          label="Cash already collected — now a refund liability"
          value={collected}
          color={COLOR_RETURNED}
          onClick={collected > 0 ? () => navigate(`/brands/${brandId}/payables?fromMonth=${period.month}&fromYear=${period.year}&toMonth=${period.month}&toYear=${period.year}`) : undefined}
        />
        <Operator symbol="+" />
        <SummaryStat label="RTO before collection — no liability" value={rto} color="var(--text-muted)" />
        <Operator symbol="=" />
        <SummaryStat label="Total COD returns" value={collected + rto} color={COLOR_RETURNED} big />
      </div>
      {collected > 0 && (
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {collectedCount} of these {collectedCount + rtoCount} return(s) had cash already in hand — that
          {collectedCount === 1 ? ' order is' : ' amount is'} what shows up on the{' '}
          <button
            onClick={() => navigate(`/brands/${brandId}/payables?fromMonth=${period.month}&fromYear=${period.year}&toMonth=${period.month}&toYear=${period.year}`)}
            className="font-bold underline"
            style={{ color: COLOR_RETURNED }}
          >
            Payables Dashboard
          </button> for {MONTHS[period.month]} {period.year}.
        </p>
      )}
      {allRto.length > 0 && (
        <div className="mt-2 px-3 py-2 rounded-lg flex items-start gap-2" style={{ background: `${COLOR_PENDING}0c`, border: `1px solid ${COLOR_PENDING}30` }}>
          <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: COLOR_PENDING }} />
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-heading)' }}>
            <strong>{allRto.map((r) => r.source).join(', ')}</strong> shows every return this month as RTO with
            nothing collected first. That can be genuine — or it can mean that source's settlement file for this
            period hasn't been uploaded yet, which would look identical (no matched settlement → treated as never
            collected). Worth double-checking before trusting ₹0 payable liability from {allRto.length === 1 ? 'it' : 'them'}.
          </p>
        </div>
      )}
    </div>
  );
};

// Same "By source" table as before, plus a Collected/RTO split per row so a
// courier's returns are legible without opening the bridge strip's aggregate —
// "Collected" links straight through to that same courier's slice on Payables
// (the 'COD' source there).
const ReturnsBySourceTable = ({ rows, brandId, period, total, onOpenJourney }) => {
  const navigate = useNavigate();
  return (
    <>
      <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>By source (courier / prepaid)</p>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: '1.5px solid var(--card-border)' }}>
            {['Source', 'Returns', 'Amount', 'Collected → Payables', 'RTO (no liability)', 'Share'].map((h) => (
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
                <td className="px-2 py-2.5 whitespace-nowrap">
                  <Num
                    value={r.collected_amount}
                    color={Number(r.collected_amount) > 0 ? COLOR_RETURNED : 'var(--text-muted)'}
                    onClick={Number(r.collected_amount) > 0 ? () => navigate(`/brands/${brandId}/payables?fromMonth=${period.month}&fromYear=${period.year}&toMonth=${period.month}&toYear=${period.year}`) : undefined}
                  />
                </td>
                <td className="px-2 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                  {money(r.rto_amount)}
                </td>
                <td className="px-2 py-2.5" style={{ color: 'var(--text-muted)' }}>{pct(r.amount, total)}</td>
              </tr>
          ))}
          {!rows.length && (
            <tr><td colSpan={6} className="px-2 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No returns this month.</td></tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td className="px-2 py-3 font-black" style={{ color: 'var(--text-heading)' }}>Total</td>
            <td />
            <td className="px-2 py-3 font-black whitespace-nowrap">
              <Num value={total} color={COLOR_RETURNED} onClick={onOpenJourney ? () => onOpenJourney({ metricKey: 'returns_this_month', label: 'Returns (SRN)', color: COLOR_RETURNED }) : undefined} />
            </td>
            <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: COLOR_RETURNED }}>
              {money(rows.reduce((s, r) => s + Number(r.collected_amount || 0), 0))}
            </td>
            <td className="px-2 py-3 font-black whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
              {money(rows.reduce((s, r) => s + Number(r.rto_amount || 0), 0))}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </>
  );
};

const ReturnsBySourceModal = ({ rows, byMonth, prepaidByChannel, brandId, period, total, count, onOpenJourney, onClose }) => (
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
        <ReturnsPayablesBridge rows={rows} brandId={brandId} period={period} onOpenJourney={onOpenJourney} />
        <ReturnsByMonthTable rows={byMonth || []} period={period} total={total} />
        <ReturnsBySourceTable rows={rows} brandId={brandId} period={period} total={total} onOpenJourney={onOpenJourney} />
        <PrepaidChannelBreakdown rows={prepaidByChannel} amountLabel="Returned" color={COLOR_RETURNED} />
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

// Any rupee figure on this dashboard, made clickable — opens that figure's
// month-by-month journey (see NumberJourneyModal). Plain text when no onClick.
const Num = ({ value, color, onClick, bold, className = '' }) => {
  const short = shortIndian(value);
  return (
    <span
      onClick={onClick}
      className={`${className} ${onClick ? 'cursor-pointer hover:underline underline-offset-2' : ''}`}
      style={{ color, fontWeight: bold ? 900 : undefined }}
      role={onClick ? 'button' : undefined}
      title={onClick ? 'Click for the complete month-by-month journey' : undefined}
    >
      {money(value)}
      {short && (
        <span className="font-medium" style={{ opacity: 0.62, fontSize: '0.82em', marginLeft: '0.35em' }}>({short})</span>
      )}
    </span>
  );
};

// Ledger-mode journey field name -> origin-mode's equivalent field name (origin
// mode fixes the ORDER population to one specific month and only tracks that
// month's own settle/return progress, so it has no cumulative-as-of columns).
const ORIGIN_FIELD_MAP = {
  sales: 'origin_sales',
  settled_of_own: 'origin_settled_as_of',
  returned_of_own: 'origin_returned_as_of',
  this_month_own_receivable: 'origin_pending_as_of',
  total_receivable_as_of: 'origin_pending_as_of',
  carried_forward_as_of: 'origin_pending_as_of',
};

const JourneyTooltip = ({ active, payload, label, color }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}>
      <p className="font-bold mb-1" style={{ color: 'var(--text-heading)' }}>{label}</p>
      <p style={{ color }}>{money(payload[0].value)}</p>
    </div>
  );
};

// The "click any number, see its complete journey" drill-down — every calendar
// month from the ledger's own start (or the cycle start) through the selected
// month, re-evaluating the SAME figure at each month's own close, as a chart +
// table with the month-over-month change made explicit. No prose, just numbers.
const NumberJourneyModal = ({ brandId, period, cycleStart, metricKey, label, color, origin, dimension, onClose }) => {
  const [resp, setResp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ month: String(period.month), year: String(period.year) });
    if (cycleStart) {
      params.set('startMonth', String(cycleStart.month));
      params.set('startYear', String(cycleStart.year));
    }
    if (origin) {
      params.set('originMonth', String(origin.month));
      params.set('originYear', String(origin.year));
    }
    if (dimension) params.set(dimension.type, dimension.value);
    // Dashboard is locked to Shopify — keep the drill-down scoped the same way
    // even when the row clicked didn't carry its own channel dimension.
    if (!dimension || dimension.type !== 'channel') params.set('channel', RECEIVABLE_CHANNEL);
    api.get(`/api/dashboard/receivables/${brandId}/journey?${params.toString()}`)
      .then((res) => { if (!cancelled) setResp(res.data); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.error || 'Failed to load journey'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandId, period.month, period.year, cycleStart?.month, cycleStart?.year, origin?.month, origin?.year, dimension?.type, dimension?.value]);

  const field = resp?.mode === 'origin' ? ORIGIN_FIELD_MAP[metricKey] : metricKey;
  const series = (resp?.months || []).map((r, i, arr) => ({
    key: `${r.year}-${r.month}`,
    label: `${MONTHS[r.month]} ${r.year}`,
    month: r.month,
    year: r.year,
    value: Number(r[field] || 0),
    change: i > 0 ? Number(r[field] || 0) - Number(arr[i - 1][field] || 0) : null,
  }));
  const isCurrent = (r) => r.month === period.month && r.year === period.year;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.55)' }}
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
              {label} — complete journey
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {origin ? `${MONTHS[origin.month]} ${origin.year}'s own sale, ` : ''}
              {dimension ? `${dimension.type} = ${dimension.value}, ` : ''}
              every month from the start through {MONTHS[period.month]} {period.year}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin" style={{ color }} />
            </div>
          )}
          {!loading && error && (
            <p className="text-sm font-semibold py-8 text-center" style={{ color: COLOR_RETURNED }}>{error}</p>
          )}
          {!loading && !error && (
            <>
              <div style={{ width: '100%', height: 220 }} className="mb-5">
                <ResponsiveContainer>
                  <LineChart data={series} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--card-border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={{ stroke: 'var(--card-border)' }} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
                      tickFormatter={(v) => `₹${(v / 100000).toFixed(0)}L`} />
                    <Tooltip content={<JourneyTooltip color={color} />} />
                    <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2.5} dot={{ r: 3 }} name={label} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--card-border)' }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                      {['Month', label, 'Change'].map((h) => (
                        <th key={h} className="px-3 py-2 text-left text-xs font-bold uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {series.map((r) => (
                      <tr
                        key={r.key}
                        style={{
                          borderBottom: '1px solid var(--card-border)',
                          background: isCurrent(r) ? `${color}0c` : 'transparent',
                        }}
                      >
                        <td className="px-3 py-2.5 font-semibold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                          {r.label}{isCurrent(r) ? ' (selected)' : ''}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-semibold" style={{ color }}>{money(r.value)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: r.change == null ? 'var(--text-muted)' : r.change > 0 ? COLOR_SALES : r.change < 0 ? COLOR_RETURNED : 'var(--text-muted)' }}>
                          {r.change == null ? '—' : `${r.change > 0 ? '+' : ''}${money(r.change)}`}
                        </td>
                      </tr>
                    ))}
                    {!series.length && (
                      <tr><td colSpan={3} className="px-3 py-8 text-center text-xs" style={{ color: 'var(--text-muted)' }}>No data yet.</td></tr>
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
};

const ReceivableDashboard = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Seeded from the URL if present (e.g. returning via the Back button from
  // Advance Amount / Payables, which push a URL that already carries the range
  // this dashboard was on) — otherwise today's month, and the first load below
  // still lets the backend pick the actual latest month with data.
  const [month, setMonth] = useState(() => parseInt(searchParams.get('month'), 10) || currentDate.getMonth() + 1);
  const [year, setYear] = useState(() => parseInt(searchParams.get('year'), 10) || currentDate.getFullYear());
  // Optional "cycle start" — null means no lower bound (today's default behavior).
  // When set, every figure on the dashboard treats anything sold before this month
  // as if it never existed, not just excludes it from carried-forward.
  const [startMonth, setStartMonth] = useState(() => parseInt(searchParams.get('startMonth'), 10) || null);
  const [startYear, setStartYear] = useState(() => parseInt(searchParams.get('startYear'), 10) || null);
  // Locked to Shopify — see RECEIVABLE_CHANNEL. Applied inside every query behind
  // the period above, same as the old picker used to do, just no longer editable.
  const channel = RECEIVABLE_CHANNEL;

  // Draft picker values — what the dropdowns show and edit. Deliberately decoupled
  // from month/year/startMonth/startYear (the "committed" values that actually
  // drive the fetch + URL): picking a 4-field range one dropdown at a time used to fire a
  // fetch (and a URL update) after EVERY single field, so a reload landing between
  // two of those picks — or even just the normal in-between renders — could catch an
  // incomplete/mismatched combination. Now nothing commits until Search is clicked;
  // the effect below keeps draft in sync whenever committed changes some other way
  // (first load's backend-picked period, the prev/next chevrons, Clear).
  const [draftMonth, setDraftMonth] = useState(month);
  const [draftYear, setDraftYear] = useState(year);
  const [draftStartMonth, setDraftStartMonth] = useState(startMonth);
  const [draftStartYear, setDraftStartYear] = useState(startYear);
  useEffect(() => {
    setDraftMonth(month); setDraftYear(year);
    setDraftStartMonth(startMonth); setDraftStartYear(startYear);
  }, [month, year, startMonth, startYear]);
  const isDirty = draftMonth !== month || draftYear !== year
    || draftStartMonth !== startMonth || draftStartYear !== startYear;
  const applyDraft = () => {
    setMonth(draftMonth); setYear(draftYear);
    setStartMonth(draftStartMonth); setStartYear(draftStartYear);
  };

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
  const [journeyRequest, setJourneyRequest] = useState(null);
  const openJourney = useCallback((req) => setJourneyRequest(req), []);

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

  const load = useCallback(async (m, y, sm, sy, ch) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (m && y) { params.set('month', m); params.set('year', y); }
      if (sm && sy) { params.set('startMonth', sm); params.set('startYear', sy); }
      if (ch) params.set('channel', ch);
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

  // First load: if the URL already carries a range (e.g. arriving via Back with a
  // previously-visited URL), load it directly; otherwise no month/year params, let
  // the backend pick the latest month with data.
  useEffect(() => {
    if (searchParams.get('month') && searchParams.get('year')) load(month, year, startMonth, startYear, channel);
    else load(undefined, undefined, undefined, undefined, channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Subsequent loads: user changed either picker.
  useEffect(() => {
    if (!initialized) return;
    load(month, year, startMonth, startYear, channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, year, startMonth, startYear, channel]);

  // Mirror the picker into the URL as it changes, so navigating away and back
  // (the Advance Amount / Payables "← Back" button, a browser refresh, anything)
  // restores this exact range instead of resetting to the backend's own default.
  useEffect(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (month && year) { next.set('month', month); next.set('year', year); } else { next.delete('month'); next.delete('year'); }
      if (startMonth && startYear) { next.set('startMonth', startMonth); next.set('startYear', startYear); } else { next.delete('startMonth'); next.delete('startYear'); }
      if (channel) next.set('channel', channel); else next.delete('channel');
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, year, startMonth, startYear, channel]);

  // Same range as this dashboard's own picker (cycle start -> "as of" month) reused
  // to both total up and link to the Advance Amount / Payables dashboards' cards below,
  // so the figure shown and the dashboard it opens always agree on what range it covers.
  const crossRangeParams = useCallback(() => {
    const params = new URLSearchParams();
    if (startMonth && startYear) { params.set('fromMonth', startMonth); params.set('fromYear', startYear); }
    if (month && year) { params.set('toMonth', month); params.set('toYear', year); }
    return params;
  }, [month, year, startMonth, startYear]);

  const [advancePayable, setAdvancePayable] = useState({ advanceAmount: null, payableAmount: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAdvancePayable((s) => ({ ...s, loading: true }));
      const qs = crossRangeParams().toString();
      try {
        const [advRes, payRes] = await Promise.all([
          api.get(`/api/dashboard/advance-amount/${brandId}${qs ? `?${qs}` : ''}`),
          api.get(`/api/dashboard/payables/${brandId}${qs ? `?${qs}` : ''}`),
        ]);
        if (cancelled) return;
        setAdvancePayable({
          advanceAmount: advRes.data?.kpis?.total_advance_amount ?? 0,
          advanceOrders: advRes.data?.kpis?.total_orders ?? 0,
          payableAmount: payRes.data?.kpis?.total_payable_amount ?? 0,
          payableOrders: payRes.data?.kpis?.total_orders ?? 0,
          loading: false,
        });
      } catch (e) {
        if (!cancelled) setAdvancePayable((s) => ({ ...s, loading: false }));
      }
    })();
    return () => { cancelled = true; };
  }, [brandId, crossRangeParams]);

  // Prev/next is a single unambiguous step (unlike the multi-field range picker), so
  // it still applies immediately — no Search needed — and keeps draft in lockstep so
  // the Search button doesn't read as "dirty" right after using it.
  const shiftMonth = (delta) => {
    let m = month + delta;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setMonth(m);
    setYear(y);
    setDraftMonth(m);
    setDraftYear(y);
  };

  const trend = (data?.monthlyTrend || []).map((r) => ({
    label: `${MONTHS[r.month]} ${String(r.year).slice(2)}`,
    Sales: Number(r.sales || 0),
    Received: Number(r.received_same_month || 0),
    'Still pending': Number(r.still_pending || 0),
    Returned: Number(r.returned_amount || 0),
  }));

  const courierAging = data?.courierAging || [];
  const k = data?.kpis || {};
  const netSalesThisMonth = Number(k.sales_this_month || 0) - Number(k.returned_of_this_months_sales || 0);
  const prevPeriod = data?.previousPeriod;
  const prevLabel = prevPeriod ? `${MONTHS[prevPeriod.month]} ${prevPeriod.year}` : 'earlier';
  const cycleStart = (startMonth && startYear) ? { month: startMonth, year: startYear } : null;

  // Opening balance -> collected -> returned -> closing balance, in real rupees —
  // the exact transformation behind why "Carried forward" shrinks each time a
  // later month re-reads the same earlier orders (see receivableByMonth / kpis
  // fields added in dashboardController.js's getReceivableDashboard).
  const carriedForwardBridge = {
    title: `Carried forward — how ${prevLabel}'s balance became this`,
    rows: [
      { label: `Opening — as of ${prevLabel}'s close`, value: k.total_receivable_as_of_previous_month, journey: { metricKey: 'total_receivable_as_of', label: 'Total receivable', color: COLOR_PRIMARY } },
      { label: `Collected in ${MONTHS[month]} ${year}`, value: k.received_from_carried_forward, sign: '−', color: COLOR_RECEIVED, journey: { metricKey: 'received_from_carried_forward', label: "Collected — earlier months' sale", color: COLOR_RECEIVED } },
      { label: `Returned in ${MONTHS[month]} ${year}`, value: k.returned_of_carried_forward_this_month, sign: '−', color: COLOR_RETURNED, journey: { metricKey: 'returned_of_carried_forward', label: "Returned — earlier months' sale", color: COLOR_RETURNED } },
    ],
    resultLabel: `Carried forward into ${MONTHS[month]} ${year}`,
    resultValue: k.carried_forward_receivable,
    resultColor: COLOR_PENDING,
    resultJourney: { metricKey: 'carried_forward_as_of', label: 'Carried forward', color: COLOR_PENDING },
  };
  const thisMonthOwnBridge = {
    title: `This month's own — ${MONTHS[month]} ${year}'s sale, start to finish`,
    rows: [
      { label: `New sales — ${MONTHS[month]} ${year}`, value: k.sales_this_month, journey: { metricKey: 'sales', label: 'Sales', color: COLOR_SALES } },
      { label: `Collected in ${MONTHS[month]} ${year}`, value: k.settled_of_this_months_sales, sign: '−', color: COLOR_RECEIVED, journey: { metricKey: 'settled_of_own', label: "Collected — this month's own sale", color: COLOR_RECEIVED } },
      { label: `Returned in ${MONTHS[month]} ${year}`, value: k.returned_of_this_months_sales, sign: '−', color: COLOR_RETURNED, journey: { metricKey: 'returned_of_own', label: "Returned — this month's own sale", color: COLOR_RETURNED } },
    ],
    resultLabel: `Still pending — ${MONTHS[month]} ${year}'s own`,
    resultValue: k.this_month_own_receivable,
    resultColor: COLOR_PENDING,
    resultJourney: { metricKey: 'this_month_own_receivable', label: "This month's own receivable", color: COLOR_PENDING },
  };

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

        <div className="flex items-center gap-4">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ background: `${COLOR_PRIMARY}15`, border: `1px solid ${COLOR_PRIMARY}30` }}
          >
            <Wallet className="w-5 h-5" style={{ color: COLOR_PRIMARY }} />
          </div>
          <div>
            <h1 className="text-xl font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow', letterSpacing: '-0.02em' }}>
              Receivable Dashboard
            </h1>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Shopify-only receivable position — every figure below excludes every other portal (Amazon, Flipkart, Pepperfry, etc.)
            </p>
          </div>
        </div>

        {/* Unified range picker — cycle start (optional floor) + as-of month, one bar.
            Every field here edits a local draft only; nothing fetches or touches the
            URL until Search is clicked, so a selection in progress can never be caught
            half-done by a reload or re-render. Prev/next and Clear are single,
            unambiguous actions and still apply immediately (see shiftMonth). */}
        <div
          className="flex items-center justify-between flex-wrap gap-4 px-5 py-4 rounded-2xl"
          style={{ background: `${COLOR_PRIMARY}08`, border: `1px solid ${COLOR_PRIMARY}25` }}
        >
          <div className="flex items-center flex-wrap gap-x-6 gap-y-3">
            <div className="flex items-center gap-2.5">
              <RotateCcw className="w-4 h-4 flex-shrink-0" style={{ color: COLOR_PRIMARY }} />
              <div>
                <p className="text-xs font-bold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>Cycle starts from</p>
                <p className="text-[10px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>optional — excludes earlier sales entirely</p>
              </div>
              <div className="flex items-center gap-1.5 ml-1">
                <select
                  value={draftStartMonth ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDraftStartMonth(v === '' ? null : Number(v));
                    if (v !== '' && !draftStartYear) setDraftStartYear(draftYear);
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
                  value={draftStartYear ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDraftStartYear(v === '' ? null : Number(v));
                    if (v !== '' && !draftStartMonth) setDraftStartMonth(1);
                  }}
                  className="text-sm font-semibold px-3 py-2 rounded-lg"
                  style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
                >
                  <option value="">—</option>
                  {uniqueYears.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
                {(startMonth || startYear || draftStartMonth || draftStartYear) && (
                  <button
                    onClick={() => { setStartMonth(null); setStartYear(null); setDraftStartMonth(null); setDraftStartYear(null); }}
                    className="text-xs font-bold px-3 py-2 rounded-lg"
                    style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-muted)' }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            <div className="w-px h-9 hidden sm:block" style={{ background: 'var(--card-border)' }} />

            <div className="flex items-center gap-2.5">
              <CalendarDays className="w-4 h-4 flex-shrink-0" style={{ color: COLOR_PRIMARY }} />
              <p className="text-xs font-bold whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>As of</p>
              <div className="flex items-center gap-1.5 ml-1">
                <button
                  onClick={() => shiftMonth(-1)}
                  aria-label="Previous month"
                  className="p-2 rounded-lg"
                  style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-muted)' }}
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <select
                  value={draftMonth}
                  onChange={(e) => setDraftMonth(Number(e.target.value))}
                  className="text-sm font-semibold px-3 py-2 rounded-lg"
                  style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
                >
                  {MONTH_NAMES.slice(1).map((name, i) => (
                    <option key={name} value={i + 1}>{name}</option>
                  ))}
                </select>
                <select
                  value={draftYear}
                  onChange={(e) => setDraftYear(Number(e.target.value))}
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
          </div>

          <button
            onClick={applyDraft}
            disabled={!isDirty}
            title={isDirty ? 'Apply the selected range' : 'Range already applied'}
            className="flex items-center gap-1.5 text-sm font-bold px-4 py-2.5 rounded-xl flex-shrink-0 transition-all"
            style={isDirty
              ? { background: COLOR_PRIMARY, color: '#fff', boxShadow: `0 2px 8px ${COLOR_PRIMARY}40` }
              : { background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-muted)', cursor: 'default' }}
          >
            <Search className="w-4 h-4" />
            Search
          </button>
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
                own sale has been collected AS OF THIS MONTH'S OWN CLOSE, no matter
                which same-or-earlier-closing calendar month the collection itself
                landed in (a collection that only lands after this month doesn't
                count until that later month is selected) — which is what makes the
                subtraction land exactly on Receivable, every month, to the rupee,
                without an already-viewed month's numbers drifting later. */}
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
                    sub={`Collected against this month's own sale, as of ${MONTHS[month]}'s close. Click for breakdown by source`}
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
                  sub={`Every month's sale combined, still uncollected as of ${MONTHS[month]}'s close. Click for the month-by-month breakdown`}
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
                  sub="Actual cash that arrived THIS calendar month (old dues + new), net of orders later returned — a treasury figure, not part of the equation above"
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

            {/* ── Advance & Payable — related balances outside this cycle's own
                receivable, below the receivable data cards above ────────── */}
            <div>
              <p className="text-xs font-bold uppercase tracking-wide mb-3" style={{ color: 'var(--text-muted)' }}>
                Related balances
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <KpiCard
                  label="Advance Amount"
                  value={advancePayable.loading ? '…' : money(advancePayable.advanceAmount)}
                  sub={`${startMonth && startYear ? `${MONTHS[startMonth]} ${startYear} → ` : ''}${MONTHS[month]} ${year} · ${Number(advancePayable.advanceOrders || 0).toLocaleString('en-IN')} order(s) still open. Click to open the Advance Amount Dashboard →`}
                  icon={HandCoins} color={COLOR_PENDING}
                  onClick={() => navigate(`/brands/${brandId}/advance-amount${crossRangeParams().toString() ? `?${crossRangeParams().toString()}` : ''}`)}
                />
                <KpiCard
                  label="Payable Amount"
                  value={advancePayable.loading ? '…' : money(advancePayable.payableAmount)}
                  sub={`${startMonth && startYear ? `${MONTHS[startMonth]} ${startYear} → ` : ''}${MONTHS[month]} ${year} · ${Number(advancePayable.payableOrders || 0).toLocaleString('en-IN')} order(s). Click to open the Payables Dashboard →`}
                  icon={RotateCcw} color={COLOR_RETURNED}
                  onClick={() => navigate(`/brands/${brandId}/payables${crossRangeParams().toString() ? `?${crossRangeParams().toString()}` : ''}`)}
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
                "Still pending" is a historical point-in-time balance, as of {MONTHS[month]} {year}'s own close, for
                orders sold in that chart month — not today's live ledger state. It answers "of what we sold in
                month X, how much was still stuck as of {MONTHS[month]} {year}."
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

            {/* ── Sheet data browser ───────────────────────────────────── */}
            <ReceivableSheetBrowser brandId={brandId} month={month} year={year} channel={RECEIVABLE_CHANNEL} />
          </>
        )}
      </div>

      {showReceivedModal && (
        <ReceivedBreakdownModal data={data} period={{ month, year }} onOpenJourney={openJourney} onClose={() => setShowReceivedModal(false)} />
      )}
      {showReceivableByMonthModal && (
        <ReceivableByMonthModal
          title={`Total receivable as of ${MONTHS[month]} ${year} — how it's made up`}
          subtitle={`Carried forward from earlier months + this month's own sales, still uncollected as of ${MONTHS[month]} ${year}'s close (COD+Prepaid combined — a Prepaid order stays here until a delivery_status upload confirms it was actually delivered; the partner breakdown below is COD only because Prepaid has no courier)`}
          total={k.total_receivable_as_of_date}
          showMonthTable={false}
          summary={[
            { label: 'Carried forward (earlier months)', value: k.carried_forward_receivable, color: COLOR_PENDING, onClick: () => openJourney({ metricKey: 'carried_forward_as_of', label: 'Carried forward', color: COLOR_PENDING }) },
            { label: `This month's own (${MONTHS[month]} ${year})`, value: k.this_month_own_receivable, color: COLOR_PENDING, onClick: () => openJourney({ metricKey: 'this_month_own_receivable', label: "This month's own receivable", color: COLOR_PENDING }) },
            { label: 'Total receivable', value: k.total_receivable_as_of_date, color: COLOR_PRIMARY, onClick: () => openJourney({ metricKey: 'total_receivable_as_of', label: 'Total receivable', color: COLOR_PRIMARY }) },
          ]}
          bridges={[carriedForwardBridge, thisMonthOwnBridge]}
          partnerRows={data?.receivableByCourierAsOfDate || []}
          onOpenJourney={openJourney}
          onClose={() => setShowReceivableByMonthModal(false)}
        />
      )}
      {showCarriedForwardModal && (
        <ReceivableByMonthModal
          title={`Carried forward as of ${MONTHS[month]} ${year} — by origin month`}
          subtitle={`Orders sold BEFORE this month, still uncollected as of ${MONTHS[month]} ${year}'s close — excludes this month's own sales (COD+Prepaid combined — a Prepaid order stays here until a delivery_status upload confirms delivery)`}
          rows={(data?.receivableByMonth || []).filter((r) => !(r.month === month && r.year === year))}
          total={k.carried_forward_receivable}
          bridges={[carriedForwardBridge]}
          onOpenJourney={openJourney}
          onClose={() => setShowCarriedForwardModal(false)}
        />
      )}
      {showThisMonthByCourierModal && (
        <ThisMonthByCourierModal
          rows={data?.thisMonthPendingByCourier || []}
          total={k.this_month_own_receivable}
          period={{ month, year }}
          onOpenJourney={openJourney}
          onClose={() => setShowThisMonthByCourierModal(false)}
        />
      )}
      {showSettledToDateModal && (
        <SettledToDateModal
          rows={data?.settledOfThisMonthsSalesBySource || []}
          prepaidByChannel={data?.settledPrepaidByChannel || []}
          total={k.settled_of_this_months_sales}
          period={{ month, year }}
          onOpenJourney={openJourney}
          onClose={() => setShowSettledToDateModal(false)}
        />
      )}
      {showSalesByChannelModal && (
        <SalesByChannelModal
          rows={data?.salesByChannel || []}
          total={k.sales_this_month}
          returnedOfThisMonth={k.returned_of_this_months_sales}
          period={{ month, year }}
          onOpenJourney={openJourney}
          onClose={() => setShowSalesByChannelModal(false)}
        />
      )}
      {showReturnsModal && (
        <ReturnsBySourceModal
          rows={data?.returnsBySource || []}
          byMonth={data?.returnsByMonth || []}
          prepaidByChannel={data?.returnsPrepaidByChannel || []}
          brandId={brandId}
          total={k.returns_this_month_amount}
          count={k.returns_this_month_count}
          period={{ month, year }}
          onOpenJourney={openJourney}
          onClose={() => setShowReturnsModal(false)}
        />
      )}
      {journeyRequest && (
        <NumberJourneyModal
          brandId={brandId}
          period={{ month, year }}
          cycleStart={cycleStart}
          {...journeyRequest}
          onClose={() => setJourneyRequest(null)}
        />
      )}
    </DashboardLayout>
  );
};

export default ReceivableDashboard;

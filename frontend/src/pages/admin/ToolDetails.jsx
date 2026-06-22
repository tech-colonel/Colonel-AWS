import React, { useState, useEffect } from 'react';
import {
  ResponsiveContainer,
  LineChart, Line,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { ArrowLeft, Activity, FileSpreadsheet, Target, Clock, Users as UsersIcon, Building2 } from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';

/* ──────────────────────────────────────────────────────────────────────────
   ToolDetails — admin drill-down for a single agent/tool.
   Fetches GET /api/dashboard/admin/tool-details/:agentType and renders:
     • KPI cards (runs / rows / matchRate / lastRun)
     • Top Users horizontal bar
     • Per-Brand bar
     • 30-day runs trend line
     • Status-distribution donut
   Renders gracefully when every metric is zero (nightly purge).
   ────────────────────────────────────────────────────────────────────────── */

const nfmt = (n) => (n ?? 0).toLocaleString('en-IN');
const fmtDate = (s) => { try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); } catch { return '—'; } };
const fmtDateTime = (s) => { try { return new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } };

const CHART_MARGIN = { top: 5, right: 10, left: -20, bottom: 0 };
const AXIS_TICK = { fontSize: 11, fill: '#94A3B8' };
const GRID = { strokeDasharray: '3 3', stroke: '#F1F5F9' };

const STATUS_PALETTE = {
  Matched: '#059669',
  'Showing in 2B but Not in Books': '#D97706',
  'Showing in Books but Not in 2B': '#E11D48',
  'Amount Mismatch': '#F59E0B',
  High: '#059669',
  Medium: '#D97706',
  Low: '#E11D48',
};
const DONUT_CYCLE = ['#0748EE', '#7C3AED', '#0F766E', '#D97706', '#E11D48', '#059669', '#94A3B8'];
const statusColor = (name, i = 0) => STATUS_PALETTE[name] || DONUT_CYCLE[i % DONUT_CYCLE.length];

const matchColor = (r) => (r == null ? '#94A3B8' : r >= 80 ? '#059669' : r >= 50 ? '#D97706' : '#E11D48');

// ── small atoms ──────────────────────────────────────────────────────────────
const KpiCard = ({ icon: Icon, label, value, color, bg }) => (
  <div className="stat-card" style={{ padding: '16px 18px', background: bg, border: `1px solid ${color}22` }}>
    <div className="flex items-center gap-2.5 mb-2">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#FFFFFF', border: `1px solid ${color}33` }}>
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color, opacity: 0.85 }}>{label}</span>
    </div>
    <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: '28px', lineHeight: 1.05, color }}>{value}</div>
  </div>
);

const ChartCard = ({ title, subtitle, children, height = 220 }) => (
  <div className="glass-card" style={{ padding: '16px 18px' }}>
    <div className="mb-3">
      <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748B' }}>{title}</div>
      {subtitle && <div className="text-xs text-slate-400 mt-0.5">{subtitle}</div>}
    </div>
    <ResponsiveContainer width="100%" height={height}>{children}</ResponsiveContainer>
  </div>
);

const EmptyChart = ({ label = 'No data yet', height = 220 }) => (
  <div className="flex flex-col items-center justify-center text-center" style={{ height }}>
    <div className="w-10 h-10 rounded-full flex items-center justify-center mb-2" style={{ background: '#F1F5F9' }}>
      <Activity className="w-4 h-4 text-slate-300" />
    </div>
    <span className="text-sm text-slate-400">{label}</span>
  </div>
);

export default function ToolDetails({ agentType, label: labelHint, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    api.get(`/api/dashboard/admin/tool-details/${agentType}`)
      .then((r) => { if (alive) setData(r.data); })
      .catch(() => { if (alive) { setError(true); toast.error('Failed to load tool details'); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [agentType]);

  const label = data?.label || labelHint || agentType;

  const Header = (
    <div className="flex items-center gap-3 mb-6">
      <button onClick={onClose}
        className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg px-3 py-1.5 transition-colors"
        style={{ color: '#0748EE', background: '#E8EFFE', border: '1px solid #A3BFF8' }}>
        <ArrowLeft className="w-4 h-4" /> Back
      </button>
      <div>
        <h2 className="text-xl font-bold text-slate-900 tracking-tight" style={{ fontFamily: 'Manrope, sans-serif' }}>{label}</h2>
        <p className="text-xs text-slate-500 mt-0.5">Tool drill-down · across all brands &amp; users</p>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div>
        {Header}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">{[1, 2, 3, 4].map((i) => <div key={i} className="h-24 rounded-2xl bg-slate-100 animate-pulse" />)}</div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">{[1, 2, 3, 4].map((i) => <div key={i} className="h-64 rounded-2xl bg-slate-100 animate-pulse" />)}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {Header}
        <div className="glass-card text-center" style={{ padding: '48px 24px' }}>
          <p className="text-sm text-slate-500">Could not load details for this tool.</p>
        </div>
      </div>
    );
  }

  const totals = data?.totals || {};
  const topUsers = (data?.topUsers || []).slice(0, 8).map((u) => ({ ...u, name: (u.name || 'Unknown').length > 20 ? (u.name || 'Unknown').slice(0, 19) + '…' : (u.name || 'Unknown') }));
  const perBrand = (data?.perBrand || []).slice(0, 10).map((b) => ({ ...b, brandName: (b.brandName || '—').length > 18 ? (b.brandName || '—').slice(0, 17) + '…' : (b.brandName || '—') }));
  const runsTrend = data?.runsTrend || [];
  const statusDistribution = data?.statusDistribution || [];

  const trendHasRuns = runsTrend.some((d) => Number(d.runs) > 0);
  const matchRate = totals.matchRate;

  return (
    <div>
      {Header}

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <KpiCard icon={Activity}        label="Runs"       value={nfmt(totals.runs)} color="#0748EE" bg="#E8EFFE" />
        <KpiCard icon={FileSpreadsheet} label="Rows"       value={nfmt(totals.rows)} color="#7C3AED" bg="#F5F3FF" />
        <KpiCard icon={Target}          label="Match Rate" value={matchRate != null ? `${matchRate}%` : '—'} color="#059669" bg="#ECFDF5" />
        <KpiCard icon={Clock}           label="Last Run"   value={totals.lastRun ? fmtDate(totals.lastRun) : '—'} color="#D97706" bg="#FFFBEB" />
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <ChartCard title="Runs · last 30 days">
          {trendHasRuns ? (
            <LineChart data={runsTrend} margin={CHART_MARGIN}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="date" tickFormatter={fmtDate} tick={AXIS_TICK} minTickGap={24} />
              <YAxis allowDecimals={false} tick={AXIS_TICK} />
              <Tooltip labelFormatter={fmtDate} formatter={(v) => [nfmt(v), 'Runs']} />
              <Line type="monotone" dataKey="runs" stroke="#0748EE" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          ) : <EmptyChart label="No runs in the last 30 days" />}
        </ChartCard>

        <ChartCard title="Status distribution">
          {statusDistribution.length > 0 ? (
            <PieChart>
              <Pie data={statusDistribution} dataKey="count" nameKey="status" innerRadius={55} outerRadius={80} paddingAngle={2}>
                {statusDistribution.map((d, i) => <Cell key={d.status} fill={statusColor(d.status, i)} />)}
              </Pie>
              <Tooltip formatter={(v, n) => [nfmt(v), n]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          ) : <EmptyChart label="No status data yet" />}
        </ChartCard>

        <ChartCard title="Top users by runs" subtitle={topUsers.length ? `${topUsers.length} contributor${topUsers.length !== 1 ? 's' : ''}` : undefined}>
          {topUsers.length > 0 ? (
            <BarChart data={topUsers} layout="vertical" margin={{ top: 5, right: 16, left: 10, bottom: 0 }}>
              <CartesianGrid {...GRID} horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={AXIS_TICK} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#64748B' }} width={120} />
              <Tooltip formatter={(v) => [nfmt(v), 'Runs']} />
              <Bar dataKey="runs" fill="#0748EE" radius={[0, 4, 4, 0]} barSize={16} />
            </BarChart>
          ) : <EmptyChart label="No user activity yet" />}
        </ChartCard>

        <ChartCard title="Runs by brand" subtitle={perBrand.length ? `${perBrand.length} brand${perBrand.length !== 1 ? 's' : ''}` : undefined}>
          {perBrand.length > 0 ? (
            <BarChart data={perBrand} margin={CHART_MARGIN}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="brandName" tick={{ fontSize: 10, fill: '#94A3B8' }} interval={0} angle={-18} textAnchor="end" height={56} />
              <YAxis allowDecimals={false} tick={AXIS_TICK} />
              <Tooltip formatter={(v) => [nfmt(v), 'Runs']} />
              <Bar dataKey="runs" fill="#7C3AED" radius={[4, 4, 0, 0]} />
            </BarChart>
          ) : <EmptyChart label="No brand activity yet" />}
        </ChartCard>
      </div>

      {/* Top users table */}
      <div className="glass-card overflow-hidden">
        <div className="px-5 py-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500 border-b" style={{ borderColor: '#E2E8F0' }}>
          <UsersIcon className="w-3.5 h-3.5" /> Top users
        </div>
        {topUsers.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-400">No user runs yet (data resets nightly)</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: '560px' }}>
              <thead>
                <tr className="text-left text-xs text-slate-500" style={{ borderBottom: '1px solid #E2E8F0' }}>
                  <th className="px-5 py-2.5 font-semibold">User</th>
                  <th className="px-5 py-2.5 font-semibold text-right">Runs</th>
                  <th className="px-5 py-2.5 font-semibold text-right">Rows</th>
                  <th className="px-5 py-2.5 font-semibold text-right">Matched</th>
                  <th className="px-5 py-2.5 font-semibold text-right">Match&nbsp;%</th>
                </tr>
              </thead>
              <tbody>
                {(data?.topUsers || []).map((u) => (
                  <tr key={u.userId} className="border-b last:border-0" style={{ borderColor: '#F1F5F9' }}>
                    <td className="px-5 py-2.5 font-medium text-slate-800">{u.name || 'Unknown'}</td>
                    <td className="px-5 py-2.5 text-right text-slate-700" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{nfmt(u.runs)}</td>
                    <td className="px-5 py-2.5 text-right text-slate-700" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{nfmt(u.rows)}</td>
                    <td className="px-5 py-2.5 text-right text-slate-700" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{nfmt(u.matched)}</td>
                    <td className="px-5 py-2.5 text-right">
                      {u.matchRate != null
                        ? <span className="font-semibold" style={{ color: matchColor(u.matchRate) }}>{u.matchRate}%</span>
                        : <span className="text-slate-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {totals.lastRun && (
        <p className="text-xs text-slate-400 mt-4 flex items-center gap-1.5">
          <Clock className="w-3 h-3" /> Last run {fmtDateTime(totals.lastRun)}
        </p>
      )}
    </div>
  );
}

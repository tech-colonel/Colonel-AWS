import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LayoutDashboard, BarChart3, Activity, Rows3, Clock, Bot,
  Download, ChevronRight, TrendingUp,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import api from '../../lib/api';
import { sidebarFor } from '../../lib/adminNav';

// ── tokens / helpers ──
const BLUE = '#0748EE';
const CONF_COLORS = { High: '#059669', Medium: '#D97706', Low: '#E11D48' };
const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
const fmtDate = (s) => { if (!s) return '—'; try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return '—'; } };
const hoursSaved = (rows, runs) => { const m = (Number(rows) || 0) * 0.5 + (Number(runs) || 0) * 10; const h = m / 60; return h >= 10 ? Math.round(h) : Math.round(h * 10) / 10; };
const AGENT_LABELS = {
  gstr_2b_books: 'GSTR-2B vs Books', gstr_2b_books_multistate: 'GSTR-2B vs Books (Multi-State)',
  gstr_3b_tally_entry: 'GSTR-3B Tally Entry', universal_bank_statement: 'Universal Bank Statement',
  bank_reco: 'Bank Statement', gstr_1_vs_books: 'GSTR-1 vs Books', gstr_3b_vs_2b: 'GSTR-3B vs 2B',
  amazon_mtr_consolidator: 'Amazon MTR Consolidator', pdf_bank_extract: 'PDF Bank Extract',
};
const agentLabel = (t) => AGENT_LABELS[t] || String(t || '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

const Sparkline = ({ data, color }) => (
  <ResponsiveContainer width="100%" height={34}>
    <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
      <defs>
        <linearGradient id={`sp-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} /><stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#sp-${color.replace('#', '')})`} dot={false} />
    </AreaChart>
  </ResponsiveContainer>
);

const AnalysisPage = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const [brand, setBrand] = useState(null);
  const [summary, setSummary] = useState(null);
  const [activity, setActivity] = useState([]);
  const [compliance, setCompliance] = useState([]);
  const [statutory, setStatutory] = useState([]);

  useEffect(() => {
    api.get(`/api/brands/${brandId}`).then((r) => setBrand(r.data)).catch(() => {});
    api.get(`/api/dashboard/summary/${brandId}`).then((r) => setSummary(r.data)).catch(() => setSummary(null));
    api.get(`/api/dashboard/activity/${brandId}?days=30`).then((r) => setActivity(Array.isArray(r.data?.days) ? r.data.days : [])).catch(() => setActivity([]));
    api.get(`/api/brands/${brandId}/compliance`).then((r) => setCompliance(Array.isArray(r.data?.tasks) ? r.data.tasks : (Array.isArray(r.data) ? r.data : []))).catch(() => setCompliance([]));
    api.get(`/api/brands/${brandId}/statutory`).then((r) => setStatutory(Array.isArray(r.data?.filings) ? r.data.filings : (Array.isArray(r.data) ? r.data : []))).catch(() => setStatutory([]));
  }, [brandId]);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  const s = summary?.summary || {};
  const byAgent = summary?.by_agent || [];
  const monthly = summary?.monthly_trend || [];
  const confDist = summary?.confidence_dist || [];
  const totalRuns = s.total_jobs || 0;
  const totalRows = s.total_rows || 0;
  const matchRate = s.match_rate != null ? s.match_rate : (totalRows ? Math.round(((s.matched_rows || 0) / totalRows) * 100) : 0);
  const savedHrs = useMemo(() => hoursSaved(totalRows, totalRuns), [totalRows, totalRuns]);

  // Compliance analytics — merge Compliance Tracker + Statutory filings.
  const compStats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const items = [];
    (compliance || []).forEach((c) => items.push({ status: c.status === 'done' ? 'done' : 'open', due: c.due_date }));
    (statutory || []).forEach((f) => { if (f.status === 'not_applicable') return; items.push({ status: f.status === 'filed' ? 'done' : 'open', due: f.due_date }); });
    const total = items.length;
    const done = items.filter((i) => i.status === 'done').length;
    const overdue = items.filter((i) => i.status !== 'done' && i.due && String(i.due).slice(0, 10) < today).length;
    const pending = Math.max(0, total - done - overdue);
    const onTime = total ? Math.round((done / total) * 100) : 0;
    return { total, done, overdue, pending, onTime };
  }, [compliance, statutory]);

  const trend = useMemo(() => monthly.map((m) => ({ label: m.label, runs: Number(m.jobs) || 0, rows: Number(m.matched || 0) + Number(m.unmatched || 0) })), [monthly]);
  const spark = useMemo(() => (trend.length ? trend.map((t) => ({ v: t.runs })) : [{ v: 0 }, { v: 0 }]), [trend]);
  const toolBars = useMemo(() => byAgent.map((a) => ({ key: a.agent_type, name: agentLabel(a.agent_type), runs: Number(a.runs) || 0 })), [byAgent]);
  const confDonut = useMemo(() => ['High', 'Medium', 'Low'].filter((o) => confDist.some((c) => c.confidence === o)).map((o) => ({ name: o, value: Number(confDist.find((c) => c.confidence === o)?.count) || 0 })), [confDist]);
  const dailyBars = useMemo(() => activity.map((d) => ({ date: d.date.slice(5), runs: d.runs })), [activity]);
  const topAgent = byAgent[0] ? agentLabel(byAgent[0].agent_type) : '—';

  const downloadReport = () => {
    const rows = [['Tool', 'Runs', 'Rows', 'Matched', 'Time saved (hrs)', 'Last run']];
    byAgent.forEach((a) => rows.push([agentLabel(a.agent_type), a.runs, a.total_rows, a.matched_rows, hoursSaved(a.total_rows, a.runs), fmtDate(a.last_run)]));
    rows.push([]); rows.push(['Totals', totalRuns, totalRows, s.matched_rows || 0, savedHrs, '']);
    rows.push([]); rows.push(['Compliance', 'Tracked', 'On-time %', 'Pending', 'Overdue', '']);
    rows.push(['', compStats.total, compStats.onTime, compStats.pending, compStats.overdue, '']);
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? '')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `${brand?.name || 'brand'}-analysis.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const tabBtn = (active) => ({ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 9999, fontSize: 13, fontWeight: 700, cursor: 'pointer', background: active ? 'var(--text-heading)' : 'var(--surface)', color: active ? '#fff' : 'var(--text-heading)', border: `1px solid ${active ? 'var(--text-heading)' : 'var(--card-border)'}`, boxShadow: 'var(--card-shadow)' });
  const SECTION = { fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '22px 0 12px' };

  const Kpi = ({ icon: Icon, label, value, sub, color, bg, mkey }) => (
    <div className="glass-card" onClick={mkey ? () => navigate(`/brands/${brandId}/analysis/metric/${mkey}`) : undefined}
      style={{ padding: '16px 18px', cursor: mkey ? 'pointer' : 'default', transition: 'transform .18s ease, box-shadow .18s ease' }}
      onMouseEnter={(e) => { if (mkey) { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--card-shadow-hover)'; } }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = ''; }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>{label}</span>
        <span style={{ width: 32, height: 32, borderRadius: 9, background: bg, display: 'grid', placeItems: 'center' }}><Icon style={{ width: 16, height: 16, color }} /></span>
      </div>
      <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 28, lineHeight: 1, color: 'var(--text-heading)' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 5 }}>{sub}</div>}
    </div>
  );

  const Progress = ({ label, value, delta, up, color }) => (
    <div className="glass-card" style={{ padding: '16px 18px' }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-heading)' }}>{label}</div>
      <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 22, lineHeight: 1.1, marginTop: 3, color: 'var(--text-heading)' }}>{value}</div>
      {delta && <div style={{ fontSize: 11, fontWeight: 700, marginTop: 5, color: up ? '#059669' : '#E11D48' }}>{up ? '▲' : '▼'} {delta}</div>}
      <div style={{ marginTop: 8 }}><Sparkline data={spark} color={color} /></div>
    </div>
  );

  const Panel = ({ title, right, children, height = 260 }) => (
    <div className="glass-card" style={{ padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{title}</div>
        {right}
      </div>
      <div style={{ height }}>{children}</div>
    </div>
  );

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" style={{ maxWidth: 1320, margin: '0 auto' }}>
        {/* Hero */}
        <div className="glass-card" style={{ padding: '22px 24px', marginBottom: 16, background: 'linear-gradient(120deg, #EEF3FF 0%, #FFFFFF 60%)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
            <div>
              <button onClick={() => navigate('/brands')} style={{ fontSize: 12, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 8 }}>← Back to Brands</button>
              <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 28, color: 'var(--text-heading)', lineHeight: 1.1 }}>Analysis</h1>
              <p style={{ color: 'var(--text-muted)', marginTop: 6, fontSize: 14 }}>Deep analytics & drill-downs for <strong style={{ color: 'var(--text-heading)' }}>{brand?.name || 'this brand'}</strong>.</p>
            </div>
            <button onClick={downloadReport} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 12, padding: '9px 14px', fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', cursor: 'pointer', boxShadow: 'var(--card-shadow)' }}>
              <Download style={{ width: 15, height: 15, color: BLUE }} /> Download report
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button style={tabBtn(false)} onClick={() => navigate(`/brands/${brandId}/dashboard`)}><LayoutDashboard style={{ width: 15, height: 15 }} /> Overview</button>
          <button style={tabBtn(true)}><BarChart3 style={{ width: 15, height: 15 }} /> Analysis</button>
        </div>

        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
          <Kpi mkey="runs" icon={Activity} label="Total Runs" value={fmtNum(totalRuns)} sub="across all tools" color={BLUE} bg="#E8EFFE" />
          <Kpi mkey="rows" icon={Rows3} label="Rows Processed" value={fmtNum(totalRows)} sub={`${matchRate}% matched`} color="#7C3AED" bg="#F5F3FF" />
          <Kpi mkey="time" icon={Clock} label="Time Saved" value={`≈ ${savedHrs} hrs`} sub="vs. manual work" color="#059669" bg="#ECFDF5" />
          <Kpi mkey="agents" icon={Bot} label="Active Agents" value={fmtNum(byAgent.length)} sub="with runs" color="#EA580C" bg="#FFF7ED" />
        </div>

        {/* Usage & progress */}
        <div style={SECTION}>Usage &amp; progress</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
          <Progress label="Tools used" value={`${byAgent.length}`} delta="on this brand" up color={BLUE} />
          <div className="glass-card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-heading)' }}>Top agent used</div>
            <div style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 16, marginTop: 3, color: 'var(--text-heading)', lineHeight: 1.2 }}>{topAgent}</div>
            {byAgent[0] && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{fmtNum(byAgent[0].runs)} runs · {fmtNum(byAgent[0].total_rows)} rows</div>}
            <div style={{ marginTop: 8 }}><Sparkline data={spark} color="#7C3AED" /></div>
          </div>
          <Progress label="Match rate" value={`${matchRate}%`} delta="matched rows" up color="#059669" />
          <Progress label="Rows this month" value={fmtNum(trend.length ? trend[trend.length - 1].rows : 0)} delta="latest month" up color="#EA580C" />
        </div>

        {/* Charts */}
        <div style={SECTION}>Trends</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginBottom: 12 }}>
          <Panel title="Runs over time">
            {trend.length === 0 ? <Empty /> : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                  <defs><linearGradient id="rot" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={BLUE} stopOpacity={0.18} /><stop offset="100%" stopColor={BLUE} stopOpacity={0} /></linearGradient></defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94A3B8' }} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94A3B8' }} tickLine={false} axisLine={false} width={34} />
                  <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #E6EAF3', fontSize: 12 }} />
                  <Area type="monotone" dataKey="runs" name="Runs" stroke={BLUE} strokeWidth={2.5} fill="url(#rot)" dot={{ r: 3 }} activeDot={{ r: 5 }} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </Panel>
          <Panel title="Runs by tool" right={<span style={{ fontSize: 11, color: 'var(--text-faint,#94A0B8)' }}>click a bar to drill in</span>}>
            {toolBars.length === 0 ? <Empty /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={toolBars} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#94A3B8' }} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 10, fill: '#64748B' }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: '#F8FAFF' }} contentStyle={{ borderRadius: 10, border: '1px solid #E6EAF3', fontSize: 12 }} />
                  <Bar dataKey="runs" name="Runs" fill={BLUE} radius={[0, 4, 4, 0]} cursor="pointer"
                    onClick={(d) => d?.payload?.key && navigate(`/brands/${brandId}/analysis/agent/${d.payload.key}`)} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginBottom: 12 }}>
          <Panel title="Daily process (last 30 days)">
            {dailyBars.length === 0 ? <Empty /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyBars} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94A3B8' }} tickLine={false} axisLine={false} interval={4} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94A3B8' }} tickLine={false} axisLine={false} width={34} />
                  <Tooltip cursor={{ fill: '#F8FAFF' }} contentStyle={{ borderRadius: 10, border: '1px solid #E6EAF3', fontSize: 12 }} />
                  <Bar dataKey="runs" name="Runs" fill={BLUE} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>
          <Panel title="Confidence distribution">
            {confDonut.length === 0 ? <Empty note="Confidence is captured for bank reconciliations." /> : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 18, height: '100%' }}>
                <ResponsiveContainer width="55%" height="100%">
                  <PieChart>
                    <Pie data={confDonut} dataKey="value" nameKey="name" innerRadius={54} outerRadius={80} paddingAngle={2}>
                      {confDonut.map((d) => <Cell key={d.name} fill={CONF_COLORS[d.name]} stroke="#fff" strokeWidth={2} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [fmtNum(v), n]} contentStyle={{ borderRadius: 10, border: '1px solid #E6EAF3', fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {confDonut.map((d) => (
                    <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-2,#3A4356)' }}>
                      <span style={{ width: 9, height: 9, borderRadius: 3, background: CONF_COLORS[d.name] }} /> {d.name} confidence
                      <span style={{ marginLeft: 'auto', fontWeight: 800, color: 'var(--text-heading)' }}>{fmtNum(d.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Panel>
        </div>

        {/* Compliance analytics */}
        <div style={SECTION}>Compliance</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {[
            { l: 'Filings tracked', v: fmtNum(compStats.total), c: BLUE },
            { l: 'On-time', v: `${compStats.onTime}%`, c: '#059669' },
            { l: 'Pending', v: fmtNum(compStats.pending), c: '#D97706' },
            { l: 'Overdue', v: fmtNum(compStats.overdue), c: '#E11D48' },
          ].map((x) => (
            <div key={x.l} className="glass-card" style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>{x.l}</div>
              <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 26, lineHeight: 1.05, marginTop: 6, color: x.c }}>{x.v}</div>
            </div>
          ))}
        </div>

        {/* Per-agent breakdown */}
        <div style={SECTION}>Per-agent breakdown</div>
        <div className="glass-card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
              <thead><tr>{['Agent', 'Runs', 'Rows', 'Time saved', 'Last run', ''].map((h, i) => (
                <th key={h + i} style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', textAlign: i === 0 || i === 4 || i === 5 ? 'left' : 'right', padding: '11px 16px', background: 'var(--surface-2,#F8FAFF)', borderBottom: '1px solid var(--card-border)', whiteSpace: 'nowrap' }}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {byAgent.length === 0 ? (
                  <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No runs yet for this brand.</td></tr>
                ) : byAgent.map((a) => (
                  <tr key={a.agent_type} style={{ cursor: 'pointer' }} onClick={() => navigate(`/brands/${brandId}/analysis/agent/${a.agent_type}`)}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-2,#F8FAFF)'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ fontSize: 13, padding: '12px 16px', fontWeight: 700, color: 'var(--text-heading)' }}>{agentLabel(a.agent_type)}</td>
                    <td style={{ fontSize: 13, padding: '12px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(a.runs)}</td>
                    <td style={{ fontSize: 13, padding: '12px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(a.total_rows)}</td>
                    <td style={{ fontSize: 13, padding: '12px 16px', textAlign: 'right', fontWeight: 700, color: '#059669', fontVariantNumeric: 'tabular-nums' }}>≈ {hoursSaved(a.total_rows, a.runs)} hrs</td>
                    <td style={{ fontSize: 13, padding: '12px 16px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtDate(a.last_run)}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right' }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 700, color: BLUE }}>View<ChevronRight style={{ width: 13, height: 13 }} /></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

const Empty = ({ note }) => (
  <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-muted)', textAlign: 'center', fontSize: 13 }}>
    <div><TrendingUp style={{ width: 26, height: 26, margin: '0 auto 8px', color: '#CBD5E1' }} /><div>No data yet.{note ? ` ${note}` : ''}</div></div>
  </div>
);

export default AnalysisPage;

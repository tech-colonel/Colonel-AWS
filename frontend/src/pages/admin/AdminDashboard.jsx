import React, { useState, useEffect, useMemo } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  Building2, Bot, Users, Link as LinkIcon, Workflow,
  Activity, Layers, Target, TrendingUp, ArrowUpRight, Crown, ClipboardList, Flag,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  ResponsiveContainer,
  AreaChart, Area,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import api from '../../lib/api';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';

const sidebarItems = ADMIN_SIDEBAR;

/* ── number helpers (match ToolResultDashboard.jsx) ─────────────────────────── */
const cnt = (n) => Number(n || 0).toLocaleString('en-IN');
const compact = (n) => {
  const v = Number(n || 0);
  if (v >= 1e7) return (v / 1e7).toFixed(v >= 1e8 ? 0 : 1).replace(/\.0$/, '') + ' Cr';
  if (v >= 1e5) return (v / 1e5).toFixed(v >= 1e6 ? 0 : 1).replace(/\.0$/, '') + ' L';
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return cnt(v);
};
const pct = (x) => (x == null ? '—' : `${Math.round(Number(x))}%`);

/* ── shared style atoms ─────────────────────────────────────────────────────── */
const CHART_TITLE = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748B', marginBottom: '10px' };
const CHART_MARGIN = { top: 5, right: 10, left: -20, bottom: 0 };
const AXIS_TICK = { fontSize: 11, fill: '#94A3B8' };
const GRID = { strokeDasharray: '3 3', stroke: '#F1F5F9' };
const DONUT_CYCLE = ['#0748EE', '#7C3AED', '#0F766E', '#D97706', '#E11D48', '#059669', '#F115F8', '#0891B2', '#65A30D', '#DB2777', '#475569'];

/* ── hero KPI stat-card ─────────────────────────────────────────────────────── */
function KpiCard({ icon: Icon, label, value, sub, color, bg, border, onClick }) {
  return (
    <div
      className="stat-card"
      onClick={onClick}
      title={onClick ? `Open ${label}` : undefined}
      style={{
        padding: '18px 20px', background: bg, border: `1px solid ${border}`,
        display: 'flex', flexDirection: 'column', gap: '10px',
        cursor: onClick ? 'pointer' : 'default', transition: 'transform 0.12s, box-shadow 0.12s',
      }}
      onMouseEnter={(e) => { if (onClick) { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(15,23,42,0.10)'; } }}
      onMouseLeave={(e) => { if (onClick) { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = ''; } }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color, opacity: 0.85 }}>{label}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', borderRadius: '9px', background: '#ffffffaa', border: `1px solid ${border}` }}>
          <Icon style={{ width: '16px', height: '16px', color }} strokeWidth={2.2} />
        </span>
      </div>
      <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: '34px', lineHeight: 1, color, letterSpacing: '-0.01em' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: '12px', fontWeight: 600, color, opacity: 0.7 }}>{sub}{onClick && ' →'}</div>}
    </div>
  );
}

/* ── quick-action card ──────────────────────────────────────────────────────── */
function QuickAction({ icon: Icon, label, desc, color, onClick, testId }) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="glass-card"
      style={{
        display: 'flex', alignItems: 'center', gap: '14px', padding: '16px',
        textAlign: 'left', cursor: 'pointer', width: '100%', transition: 'transform 0.12s, box-shadow 0.12s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(15,23,42,0.10)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = ''; }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '40px', height: '40px', borderRadius: '11px', background: `${color}14`, border: `1px solid ${color}33`, flexShrink: 0 }}>
        <Icon style={{ width: '19px', height: '19px', color }} strokeWidth={2.1} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#0F172A' }}>{label}</span>
        <span style={{ display: 'block', fontSize: '12px', color: '#64748B', marginTop: '1px' }}>{desc}</span>
      </span>
      <ArrowUpRight style={{ width: '16px', height: '16px', color: '#CBD5E1', marginLeft: 'auto', flexShrink: 0 }} />
    </button>
  );
}

function ChartCard({ title, action, children, height = 240 }) {
  return (
    <div className="glass-card" style={{ padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
        <div style={CHART_TITLE}>{title}</div>
        {action}
      </div>
      <ResponsiveContainer width="100%" height={height}>{children}</ResponsiveContainer>
    </div>
  );
}

function ChartEmpty({ label }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#94A3B8', gap: '8px' }}>
      <Activity style={{ width: '24px', height: '24px', color: '#CBD5E1' }} strokeWidth={1.8} />
      <span style={{ fontSize: '13px' }}>{label}</span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   ADMIN DASHBOARD — premium end-to-end platform summary
   ════════════════════════════════════════════════════════════════════════════ */
const AdminDashboard = () => {
  const navigate = useNavigate();
  const [brandsCount, setBrandsCount] = useState(0);
  const [analytics, setAnalytics] = useState(null);   // tool-analytics payload
  const [usersData, setUsersData] = useState(null);   // users-overview payload
  const [taskStats, setTaskStats] = useState(null);   // /api/tasks/stats payload
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [brandsRes, toolRes, usersRes, tasksRes] = await Promise.allSettled([
        api.get('/api/brands'),
        api.get('/api/dashboard/admin/tool-analytics'),
        api.get('/api/dashboard/admin/users-overview'),
        api.get('/api/tasks/stats'),
      ]);
      if (brandsRes.status === 'fulfilled' && Array.isArray(brandsRes.value.data)) {
        setBrandsCount(brandsRes.value.data.length);
      }
      if (toolRes.status === 'fulfilled') setAnalytics(toolRes.value.data || null);
      if (usersRes.status === 'fulfilled') setUsersData(usersRes.value.data || null);
      if (tasksRes.status === 'fulfilled') setTaskStats(tasksRes.value.data || null);
    } catch (e) {
      console.error('Admin dashboard load failed:', e);
    } finally {
      setLoading(false);
    }
  };

  /* — derive everything from the two payloads, zero-safe — */
  const totals = analytics?.totals || {};
  const timeline = Array.isArray(analytics?.timeline) ? analytics.timeline : [];
  const runsShare = Array.isArray(analytics?.runsShare) ? analytics.runsShare : [];
  const usersSummary = usersData?.usersSummary || {};
  const topUsers = Array.isArray(usersData?.topUsers) ? usersData.topUsers : [];

  // prefer brands from /api/brands, fall back to analytics totals
  const brands = brandsCount || Number(totals.brands || 0);
  const totalTools = Number(totals.totalTools || 0);
  const totalRuns = Number(totals.runs || 0);
  const totalRows = Number(totals.rows || 0);
  const matchRate = totals.matchRate;
  const totalUsers = Number(usersSummary.totalUsers || 0);
  const activeUsers = Number(usersSummary.activeUsers || 0);

  const hasRuns = totalRuns > 0;
  const timelineHasData = timeline.some((d) => Number(d.runs) > 0);

  // — task stats (overall platform picture, not just reco) —
  const ts = taskStats || {};
  const taskTotal = Number(ts.total || 0);
  const taskPending = Number(ts.pending || 0);
  const taskInProgress = Number(ts.in_progress || 0);
  const taskDone = Number(ts.done || 0);
  const taskOverdue = Number(ts.overdue || 0);
  const taskOpen = taskPending + taskInProgress;
  const feedbackTotal = Number(ts.feedbackTotal || 0);
  const feedbackResolved = Number(ts.feedbackResolved || 0);
  const feedbackOpen = Number(ts.feedbackOpen || 0);
  const taskBreakdown = [
    { label: 'Pending', value: taskPending, color: '#64748B', bg: '#F1F5F9' },
    { label: 'In Progress', value: taskInProgress, color: '#0748EE', bg: '#E8EFFE' },
    { label: 'Done', value: taskDone, color: '#059669', bg: '#ECFDF5' },
    { label: 'Overdue', value: taskOverdue, color: '#E11D48', bg: '#FEF2F2' },
  ];

  const donutData = useMemo(
    () => runsShare.filter((d) => Number(d.runs) > 0).map((d) => ({ name: d.name, value: Number(d.runs) })),
    [runsShare],
  );

  const top5Users = useMemo(() => topUsers.slice(0, 5), [topUsers]);

  // Lead with the platform / people / work picture; reconciliation metrics follow.
  // Every card is clickable → drills into its own page.
  const kpis = [
    { icon: Building2, label: 'Brands',       value: cnt(brands),      sub: `${cnt(totals.brandsWithData || 0)} with reco data`, color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8', onClick: () => navigate('/admin/brands') },
    { icon: Users,     label: 'Active Users', value: cnt(activeUsers), sub: `of ${cnt(totalUsers)} total`,                       color: '#0F766E', bg: '#ECFEFF', border: '#A5F3FC', onClick: () => navigate('/admin/users') },
    { icon: Bot,       label: 'Agents',       value: cnt(totalTools),  sub: `${cnt(totals.activeTools || 0)} actively run`,      color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE', onClick: () => navigate('/admin/agents') },
    { icon: ClipboardList, label: 'Tasks',    value: cnt(taskTotal),   sub: taskTotal ? `${cnt(taskOpen)} open · ${cnt(taskOverdue)} overdue` : 'none yet', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE', onClick: () => navigate('/admin/tasks') },
    { icon: Flag,      label: 'Feedback',     value: cnt(feedbackTotal), sub: feedbackTotal ? `${cnt(feedbackOpen)} open · ${cnt(feedbackResolved)} resolved` : 'none yet', color: '#DB2777', bg: '#FDF2F8', border: '#FBCFE8', onClick: () => navigate('/admin/feedback') },
    { icon: Activity,  label: 'Total Runs',   value: cnt(totalRuns),   sub: hasRuns ? 'across all tools' : 'no runs yet',        color: '#D97706', bg: '#FFFBEB', border: '#FDE68A', onClick: () => navigate('/admin/agents') },
    { icon: Layers,    label: 'Rows Processed', value: compact(totalRows), sub: `${cnt(totalRows)} rows`,                        color: '#0F172A', bg: '#F8FAFC', border: '#E2E8F0', onClick: () => navigate('/admin/agents') },
    { icon: Target,    label: 'Match Rate',   value: pct(matchRate),   sub: matchRate == null ? 'awaiting data' : `${cnt(totals.matched || 0)} matched`, color: '#059669', bg: '#ECFDF5', border: '#A7F3D0', onClick: () => navigate('/admin/agents') },
  ];

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div style={{ padding: '28px 28px 40px', maxWidth: '1280px', margin: '0 auto' }} data-testid="admin-dashboard">

        {/* ── header ── */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', marginBottom: '24px' }}>
          <div>
            <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: '28px', color: '#0F172A', letterSpacing: '-0.02em', margin: 0 }}>
              Platform Overview
            </h1>
            <p style={{ fontSize: '14px', color: '#64748B', marginTop: '4px' }}>
              End-to-end view of brands, agents, users &amp; reconciliation activity.
            </p>
          </div>
          <button
            onClick={() => navigate('/admin/agents')}
            data-testid="view-detailed-analytics"
            className="btn-glow"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              background: '#0748EE', color: '#fff', border: 'none', borderRadius: '12px',
              padding: '10px 18px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
              boxShadow: '0 2px 10px rgba(7,72,238,0.28)',
            }}>
            <TrendingUp style={{ width: '15px', height: '15px' }} />
            View detailed analytics
          </button>
        </div>

        {/* ── hero KPI row ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
          {kpis.map((k) => <KpiCard key={k.label} {...k} />)}
        </div>

        {/* ── reconciliation activity (one section of the overall picture) ── */}
        <div style={{ fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#94A3B8', margin: '4px 2px 12px' }}>
          Reconciliation activity
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', gap: '16px', marginBottom: '24px' }}>
          <ChartCard
            title="Reconciliation Runs — Last 30 Days"
            action={<span style={{ fontSize: '11px', color: '#94A3B8' }}>{cnt(totalRuns)} total</span>}
          >
            {timelineHasData ? (
              <AreaChart data={timeline} margin={CHART_MARGIN}>
                <defs>
                  <linearGradient id="runsFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0748EE" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="#0748EE" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...GRID} />
                <XAxis
                  dataKey="date" tick={AXIS_TICK} interval="preserveStartEnd" minTickGap={28}
                  tickFormatter={(d) => { const [, m, day] = String(d).split('-'); return `${day}/${m}`; }}
                />
                <YAxis tick={AXIS_TICK} allowDecimals={false} width={32} />
                <Tooltip
                  formatter={(v) => [cnt(v), 'Runs']}
                  labelFormatter={(d) => String(d)}
                  contentStyle={{ fontSize: '12px', borderRadius: '10px', border: '1px solid #E2E8F0' }}
                />
                <Area type="monotone" dataKey="runs" stroke="#0748EE" strokeWidth={2} fill="url(#runsFill)" />
              </AreaChart>
            ) : <ChartEmpty label="No runs in the last 30 days" />}
          </ChartCard>

          <ChartCard title="Runs by Tool">
            {donutData.length > 0 ? (
              <PieChart>
                <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={2}>
                  {donutData.map((d, i) => <Cell key={d.name} fill={DONUT_CYCLE[i % DONUT_CYCLE.length]} />)}
                </Pie>
                <Tooltip formatter={(v, n) => [cnt(v), n]} contentStyle={{ fontSize: '12px', borderRadius: '10px', border: '1px solid #E2E8F0' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
              </PieChart>
            ) : <ChartEmpty label="No tool runs yet" />}
          </ChartCard>
        </div>

        {/* ── tasks breakdown (overall platform work, not just reco) ── */}
        <div className="glass-card" style={{ padding: '16px 18px', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <div style={CHART_TITLE}>Tasks</div>
            <button onClick={() => navigate('/admin/tasks')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: '#0748EE' }}>
              Manage tasks →
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '14px' }}>
            {taskBreakdown.map((t) => (
              <div key={t.label} className="stat-card" style={{ padding: '12px 14px', background: t.bg, border: `1px solid ${t.color}22` }}>
                <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: '24px', lineHeight: 1.05, color: t.color }}>{cnt(t.value)}</div>
                <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: t.color, marginTop: '4px', opacity: 0.85 }}>{t.label}</div>
              </div>
            ))}
          </div>
          {/* thin stacked progress bar */}
          {taskTotal > 0 ? (
            <div style={{ display: 'flex', height: '8px', borderRadius: '9999px', overflow: 'hidden', background: '#F1F5F9' }}>
              {taskBreakdown.filter((t) => t.value > 0).map((t) => (
                <div key={t.label} title={`${t.label}: ${t.value}`} style={{ width: `${(t.value / taskTotal) * 100}%`, background: t.color }} />
              ))}
            </div>
          ) : (
            <div style={{ fontSize: '13px', color: '#94A3B8' }}>No tasks yet — assign work from the Tasks page.</div>
          )}
        </div>

        {/* ── bottom row: top users mini-list + quick actions ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.1fr)', gap: '16px' }}>

          {/* Top users */}
          <div className="glass-card" style={{ padding: '16px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={CHART_TITLE}>Top Users by Runs</div>
              <button onClick={() => navigate('/admin/users')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: '#0748EE' }}>
                All users →
              </button>
            </div>
            {top5Users.length === 0 ? (
              <div style={{ padding: '28px 0', textAlign: 'center', color: '#94A3B8', fontSize: '13px' }}>
                No user activity yet
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {top5Users.map((u, i) => (
                  <button
                    key={u.userId || i}
                    onClick={() => navigate('/admin/users')}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '12px', padding: '9px 8px',
                      borderRadius: '10px', border: 'none', background: 'transparent', cursor: 'pointer',
                      textAlign: 'left', transition: 'background 0.12s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#F8FAFC'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{
                      width: '30px', height: '30px', borderRadius: '50%', flexShrink: 0,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: '13px',
                      color: i === 0 ? '#D97706' : '#0748EE',
                      background: i === 0 ? '#FFFBEB' : '#E8EFFE',
                      border: `1px solid ${i === 0 ? '#FDE68A' : '#A3BFF8'}`,
                    }}>
                      {i === 0 ? <Crown style={{ width: '14px', height: '14px' }} /> : i + 1}
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {u.name || 'Unknown'}
                      </span>
                      <span style={{ display: 'block', fontSize: '11px', color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {u.topAgentLabel || (u.role ? u.role : '—')}
                      </span>
                    </span>
                    <span style={{ textAlign: 'right', flexShrink: 0 }}>
                      <span style={{ display: 'block', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, fontSize: '14px', color: '#0F172A' }}>
                        {cnt(u.totalRuns)}
                      </span>
                      <span style={{ display: 'block', fontSize: '10px', color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>runs</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Quick actions / nav */}
          <div className="glass-card" style={{ padding: '16px 18px' }}>
            <div style={{ ...CHART_TITLE, marginBottom: '12px' }}>Manage Platform</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' }}>
              <QuickAction icon={Building2} label="Brands"       desc="Create & assign brands"     color="#0748EE" onClick={() => navigate('/admin/brands')}      testId="view-brands-button" />
              <QuickAction icon={Bot}       label="Agents"       desc="Tools & analytics"          color="#7C3AED" onClick={() => navigate('/admin/agents')}      testId="view-agents-button" />
              <QuickAction icon={Users}     label="Users"        desc="Accounts & roles"           color="#0F766E" onClick={() => navigate('/admin/users')}       testId="view-users-button" />
              <QuickAction icon={LinkIcon}  label="Integrations" desc="Connected services"         color="#D97706" onClick={() => navigate('/admin/integrations')} testId="view-integrations-button" />
              <QuickAction icon={Workflow}  label="Plans"        desc="Workflow plan builder"      color="#E11D48" onClick={() => navigate('/admin/plans')}       testId="view-plans-button" />
            </div>
          </div>
        </div>

        {loading && (
          <div style={{ marginTop: '16px', fontSize: '12px', color: '#94A3B8', textAlign: 'center' }}>
            Loading platform data…
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default AdminDashboard;

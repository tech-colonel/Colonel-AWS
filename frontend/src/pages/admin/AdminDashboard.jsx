import React, { useState, useEffect, useMemo } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  Building2, Bot, Users, Activity, Layers, Target, ClipboardList, Flag,
  BarChart3, LayoutDashboard, Plus, CalendarDays, Sparkles, Briefcase, Crown, Video, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import api from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';

const sidebarItems = ADMIN_SIDEBAR;

/* ── Admin theme: Prodify VIOLET (scoped here; global blue tokens untouched) ── */
const V = '#6D5AE6';        // primary violet
const V_D = '#5A48D6';      // darker
const V_WASH = '#F1EEFC';   // violet wash

const cnt = (n) => Number(n || 0).toLocaleString('en-IN');
const compact = (n) => { const v = Number(n || 0); if (v >= 1e7) return (v / 1e7).toFixed(1).replace(/\.0$/, '') + ' Cr'; if (v >= 1e5) return (v / 1e5).toFixed(1).replace(/\.0$/, '') + ' L'; if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'; return cnt(v); };
const pct = (x) => (x == null ? '—' : `${Math.round(Number(x))}%`);

const CHART_TITLE = { fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748B', marginBottom: 10 };
const SECTION = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#94A3B8', margin: '22px 2px 12px' };
const DONUT_CYCLE = [V, '#0EA5E9', '#EC4899', '#F59E0B', '#059669', '#0748EE', '#14B8A6', '#DB2777', '#65A30D', '#7C3AED', '#475569'];

/* dummy entities (Projects + Goals are new concepts — real tables can come later) */
const PROJECTS = [
  { name: 'Q1 Reconciliation Cleanup', tasks: 12, teammates: 5, color: '#6D5AE6', progress: 72, due: '18 Jul', status: 'On track', lead: 'Priya', members: ['Priya', 'Rahul', 'Amjad', 'Vidhi', 'Kunal'], items: ['Close Koparo Apr–Jun', 'Fix GSTR-2B mismatches', 'Vendor ledger cleanup', 'Client sign-off pack'] },
  { name: 'Amazon Settlement Automation', tasks: 8, teammates: 3, color: '#0EA5E9', progress: 45, due: '25 Jul', status: 'At risk', lead: 'Rahul', members: ['Rahul', 'Shrikant', 'Manisha'], items: ['MTR consolidator run', 'Settlement reconciliation', 'Fee validation'] },
  { name: 'New Brand Onboarding — Amama', tasks: 6, teammates: 4, color: '#EC4899', progress: 30, due: '30 Jul', status: 'On track', lead: 'Riya', members: ['Riya', 'Jayesh', 'Akshat', 'Vidhi'], items: ['Create brand DB', 'Assign agents', 'Upload masters', 'Kickoff call'] },
  { name: 'Statutory Filing Sprint — July', tasks: 15, teammates: 7, color: '#F59E0B', progress: 88, due: '20 Jul', status: 'On track', lead: 'Prashant', members: ['Prashant', 'Priya', 'Rahul', 'Amjad', 'Vidhi', 'Kunal', 'Riya'], items: ['GSTR-3B all brands', 'TDS 26Q', 'PF / ESIC', 'ROC annual'] },
];
// fake calendar events per weekday (0=Mon … 6=Sun)
const CAL_EVENTS = {
  0: [{ t: 'Team standup', time: '10:00 am', c: '#6D5AE6' }, { t: 'Koparo reco review', time: '02:30 pm', c: '#0EA5E9' }],
  1: [{ t: 'Client call — Amama onboarding', time: '11:00 am', c: '#EC4899' }],
  2: [{ t: 'GSTR-3B checkpoint', time: '04:00 pm', c: '#F59E0B' }],
  3: [{ t: 'GST Filing Review — June', time: '11:00 am', c: '#059669' }, { t: 'Board review — Q1 FY27', time: '05:00 pm', c: '#6D5AE6' }],
  4: [{ t: 'Bank reco walkthrough', time: '03:00 pm', c: '#0EA5E9' }],
  5: [{ t: 'Portfolio review', time: '12:00 pm', c: '#6D5AE6' }],
  6: [],
};
const GOALS = [
  { label: 'Onboard 3 new brands this quarter', ctx: 'Growth', pctv: 66, color: V },
  { label: 'Close all June reconciliations', ctx: 'Operations', pctv: 82, color: '#059669' },
  { label: 'Resolve open feedback under 24h', ctx: 'Quality', pctv: 45, color: '#F59E0B' },
];
const PRIORITY = {
  urgent: { c: '#E11D48', bg: '#FEF2F2', label: 'Urgent' }, high: { c: '#EA580C', bg: '#FFF7ED', label: 'High' },
  medium: { c: V, bg: V_WASH, label: 'Medium' }, low: { c: '#64748B', bg: '#F1F5F9', label: 'Low' },
};
const TSTATUS = { pending: { c: '#64748B', bg: '#F1F5F9', label: 'To do' }, in_progress: { c: V, bg: V_WASH, label: 'In progress' }, done: { c: '#059669', bg: '#ECFDF5', label: 'Done' }, overdue: { c: '#E11D48', bg: '#FEF2F2', label: 'Overdue' } };

function KpiCard({ icon: Icon, label, value, sub, color, bg, border, onClick }) {
  return (
    <div className="stat-card" onClick={onClick} title={onClick ? `Open ${label}` : undefined}
      style={{ padding: '16px 18px', background: bg, border: `1px solid ${border}`, display: 'flex', flexDirection: 'column', gap: 8, cursor: onClick ? 'pointer' : 'default', transition: 'transform .12s, box-shadow .12s' }}
      onMouseEnter={(e) => { if (onClick) { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(15,23,42,.10)'; } }}
      onMouseLeave={(e) => { if (onClick) { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = ''; } }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color, opacity: 0.85 }}>{label}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 9, background: '#ffffffaa', border: `1px solid ${border}` }}><Icon style={{ width: 16, height: 16, color }} strokeWidth={2.2} /></span>
      </div>
      <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 30, lineHeight: 1, color, letterSpacing: '-0.01em' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, fontWeight: 600, color, opacity: 0.7 }}>{sub}{onClick && ' →'}</div>}
    </div>
  );
}
function ChartCard({ title, action, children, height = 240 }) {
  return (
    <div className="glass-card" style={{ padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}><div style={CHART_TITLE}>{title}</div>{action}</div>
      <ResponsiveContainer width="100%" height={height}>{children}</ResponsiveContainer>
    </div>
  );
}
const ChartEmpty = ({ label }) => (
  <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#94A3B8', gap: 8 }}>
    <Activity style={{ width: 24, height: 24, color: '#CBD5E1' }} strokeWidth={1.8} /><span style={{ fontSize: 13 }}>{label}</span>
  </div>
);

const AdminDashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [brandsCount, setBrandsCount] = useState(0);
  const [analytics, setAnalytics] = useState(null);
  const [usersData, setUsersData] = useState(null);
  const [taskStats, setTaskStats] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [projectModal, setProjectModal] = useState(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const todayIdx = (new Date().getDay() + 6) % 7;
  const [selDay, setSelDay] = useState(todayIdx);

  useEffect(() => { fetchAll(); }, []);
  const fetchAll = async () => {
    setLoading(true);
    try {
      const [brandsRes, toolRes, usersRes, tasksStatRes, tasksRes, meetRes] = await Promise.allSettled([
        api.get('/api/brands'), api.get('/api/dashboard/admin/tool-analytics'),
        api.get('/api/dashboard/admin/users-overview'), api.get('/api/tasks/stats'),
        api.get('/api/tasks'), api.get('/api/meetings/upcoming'),
      ]);
      if (brandsRes.status === 'fulfilled' && Array.isArray(brandsRes.value.data)) setBrandsCount(brandsRes.value.data.length);
      if (toolRes.status === 'fulfilled') setAnalytics(toolRes.value.data || null);
      if (usersRes.status === 'fulfilled') setUsersData(usersRes.value.data || null);
      if (tasksStatRes.status === 'fulfilled') setTaskStats(tasksStatRes.value.data || null);
      if (tasksRes.status === 'fulfilled' && Array.isArray(tasksRes.value.data)) setTasks(tasksRes.value.data);
      if (meetRes.status === 'fulfilled') setMeetings(Array.isArray(meetRes.value.data?.events) ? meetRes.value.data.events : []);
    } catch (e) { /* graceful */ } finally { setLoading(false); }
  };

  const totals = analytics?.totals || {};
  const timeline = Array.isArray(analytics?.timeline) ? analytics.timeline : [];
  const runsShare = Array.isArray(analytics?.runsShare) ? analytics.runsShare : [];
  const usersSummary = usersData?.usersSummary || {};
  const topUsers = Array.isArray(usersData?.topUsers) ? usersData.topUsers : [];

  const brands = brandsCount || Number(totals.brands || 0);
  const totalTools = Number(totals.totalTools || 0);
  const totalRuns = Number(totals.runs || 0);
  const totalRows = Number(totals.rows || 0);
  const matchRate = totals.matchRate;
  const totalUsers = Number(usersSummary.totalUsers || 0);
  const activeUsers = Number(usersSummary.activeUsers || 0);
  const timelineHasData = timeline.some((d) => Number(d.runs) > 0);

  const ts = taskStats || {};
  const taskTotal = Number(ts.total || 0), taskOverdue = Number(ts.overdue || 0);
  const taskOpen = Number(ts.pending || 0) + Number(ts.in_progress || 0);
  const feedbackTotal = Number(ts.feedbackTotal || 0), feedbackOpen = Number(ts.feedbackOpen || 0), feedbackResolved = Number(ts.feedbackResolved || 0);

  const donutData = useMemo(() => runsShare.filter((d) => Number(d.runs) > 0).map((d) => ({ name: d.name, value: Number(d.runs) })), [runsShare]);
  const top5 = useMemo(() => topUsers.slice(0, 5), [topUsers]);

  // My Tasks (admin's own, grouped)
  const myTasks = useMemo(() => (tasks || []).filter((t) => t.category !== 'feedback'), [tasks]);
  const groups = useMemo(() => {
    const g = { in_progress: [], pending: [], done: [] };
    myTasks.forEach((t) => { (g[t.status] || (g[t.status] = [])).push(t); });
    return g;
  }, [myTasks]);
  const nextMeeting = meetings.find((e) => e.joinLink) || meetings[0] || null;
  const firstName = (user?.name || 'Admin').split(' ')[0];

  // week strip
  const week = useMemo(() => {
    const now = new Date(); const day = (now.getDay() + 6) % 7; const mon = new Date(now); mon.setDate(now.getDate() - day);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return { dow: d.toLocaleDateString('en-IN', { weekday: 'short' }), day: d.getDate(), today: d.toDateString() === now.toDateString() }; });
  }, []);

  const kpis = [
    { icon: Building2, label: 'Brands', value: cnt(brands), sub: `${cnt(totals.brandsWithData || 0)} with reco data`, color: V, bg: V_WASH, border: '#DDD6FE', onClick: () => navigate('/admin/brands') },
    { icon: Users, label: 'Active Users', value: cnt(activeUsers), sub: `of ${cnt(totalUsers)} total`, color: '#0891B2', bg: '#ECFEFF', border: '#A5F3FC', onClick: () => navigate('/admin/users') },
    { icon: Bot, label: 'Agents', value: cnt(totalTools), sub: `${cnt(totals.activeTools || 0)} actively run`, color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE', onClick: () => navigate('/admin/agents') },
    { icon: ClipboardList, label: 'Tasks', value: cnt(taskTotal), sub: taskTotal ? `${cnt(taskOpen)} open · ${cnt(taskOverdue)} overdue` : 'none yet', color: '#2563EB', bg: '#EFF6FF', border: '#BFDBFE', onClick: () => navigate('/admin/tasks') },
    { icon: Flag, label: 'Feedback', value: cnt(feedbackTotal), sub: feedbackTotal ? `${cnt(feedbackOpen)} open · ${cnt(feedbackResolved)} resolved` : 'none yet', color: '#DB2777', bg: '#FDF2F8', border: '#FBCFE8', onClick: () => navigate('/admin/feedback') },
    { icon: Activity, label: 'Total Runs', value: cnt(totalRuns), sub: totalRuns ? 'across all tools' : 'no runs yet', color: '#D97706', bg: '#FFFBEB', border: '#FDE68A', onClick: () => navigate('/admin/analysis') },
    { icon: Layers, label: 'Rows Processed', value: compact(totalRows), sub: `${cnt(totalRows)} rows`, color: '#0F172A', bg: '#F8FAFC', border: '#E2E8F0', onClick: () => navigate('/admin/analysis') },
    { icon: Target, label: 'Match Rate', value: pct(matchRate), sub: matchRate == null ? 'awaiting data' : `${cnt(totals.matched || 0)} matched`, color: '#059669', bg: '#ECFDF5', border: '#A7F3D0', onClick: () => navigate('/admin/analysis') },
  ];

  const tabBtn = (active) => ({ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 9999, fontSize: 13, fontWeight: 700, cursor: 'pointer', background: active ? V : '#fff', color: active ? '#fff' : '#0F172A', border: `1px solid ${active ? V : '#E6EAF3'}`, boxShadow: '0 1px 3px rgba(10,15,46,.05)' });

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div data-testid="admin-dashboard" style={{ padding: '28px 28px 48px', maxWidth: 1320, margin: '0 auto',
        background: 'radial-gradient(1100px 520px at 12% -12%, #EFEBFF 0%, transparent 58%), radial-gradient(900px 440px at 100% -6%, #FBEAF5 0%, transparent 52%)' }}>

        {/* Hero */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
          <div>
            <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 28, color: '#0F172A', letterSpacing: '-0.02em', margin: 0 }}>Welcome, {firstName} <span style={{ fontWeight: 400 }}>👋</span></h1>
            <div style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 700, fontSize: 18, color: V, marginTop: 3 }}>How can I help you today?</div>
            <p style={{ fontSize: 14, color: '#64748B', marginTop: 4 }}>End-to-end view of brands, agents, users &amp; reconciliation activity.</p>
          </div>
          <button onClick={() => navigate('/chat')} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: `linear-gradient(135deg, ${V}, #8B5CF6)`, color: '#fff', border: 'none', borderRadius: 12, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', boxShadow: '0 4px 14px rgba(109,90,230,.32)' }}>
            <Sparkles style={{ width: 15, height: 15 }} /> Ask Colonel AI
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          <button style={tabBtn(true)}><LayoutDashboard style={{ width: 15, height: 15 }} /> Overview</button>
          <button style={tabBtn(false)} onClick={() => navigate('/admin/analysis')}><BarChart3 style={{ width: 15, height: 15 }} /> Analysis</button>
        </div>

        {/* Stat cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
          {kpis.map((k) => <KpiCard key={k.label} {...k} />)}
        </div>

        {/* My Tasks | Projects + Calendar */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)', gap: 16, marginTop: 22 }}>
          {/* My Tasks */}
          <div className="glass-card" style={{ padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, color: '#0F172A' }}><ClipboardList style={{ width: 17, height: 17, color: V }} /> My Tasks</div>
              <button onClick={() => navigate('/admin/tasks')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: V, display: 'inline-flex', alignItems: 'center', gap: 3 }}><Plus style={{ width: 14, height: 14 }} /> New task</button>
            </div>
            {myTasks.length === 0 ? (
              <div style={{ padding: '18px 0', color: '#94A3B8', fontSize: 13 }}>No tasks assigned to you yet.</div>
            ) : (
              ['in_progress', 'pending', 'done'].filter((k) => (groups[k] || []).length).map((k) => (
                <div key={k} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: (TSTATUS[k] || {}).c, background: (TSTATUS[k] || {}).bg, padding: '3px 9px', borderRadius: 9999, margin: '6px 0' }}>{(TSTATUS[k] || {}).label} · {(groups[k] || []).length}</div>
                  {(groups[k] || []).slice(0, 4).map((t) => {
                    const pr = PRIORITY[t.priority] || PRIORITY.medium;
                    return (
                      <div key={t.id} onClick={() => navigate('/admin/tasks')} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid #EEF1F8', cursor: 'pointer' }}>
                        <span style={{ width: 16, height: 16, borderRadius: 5, border: `1.8px solid ${k === 'done' ? '#059669' : '#C6D0E4'}`, background: k === 'done' ? '#059669' : 'transparent', flexShrink: 0 }} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: k === 'done' ? 'line-through' : 'none' }}>{t.title}</span>
                        <span style={{ fontSize: 10, fontWeight: 800, color: pr.c, background: pr.bg, padding: '2px 8px', borderRadius: 9999 }}>{pr.label}</span>
                        {t.due_date && <span style={{ fontSize: 11, color: '#94A3B8', whiteSpace: 'nowrap' }}>{new Date(t.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span>}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
            <button onClick={() => navigate('/admin/tasks')} style={{ marginTop: 8, fontSize: 13, fontWeight: 700, color: V, background: 'none', border: 'none', cursor: 'pointer' }}>Manage tasks →</button>
          </div>

          {/* Right column: Projects + Calendar */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="glass-card" style={{ padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, color: '#0F172A' }}><Briefcase style={{ width: 16, height: 16, color: V }} /> Projects</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <button onClick={() => setNewProjectOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px', borderRadius: 12, border: '1px dashed #CBD5E1', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                  <span style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: V_WASH, color: V }}><Plus style={{ width: 16, height: 16 }} /></span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A' }}>New project</span>
                </button>
                {PROJECTS.map((p) => (
                  <div key={p.name} onClick={() => setProjectModal(p)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px', borderRadius: 12, border: '1px solid #EEF1F8', cursor: 'pointer', minWidth: 0 }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFF'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                    <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, background: `${p.color}1A`, color: p.color, display: 'grid', placeItems: 'center', fontWeight: 900, fontSize: 13, fontFamily: 'Barlow' }}>{p.name[0]}</span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      <span style={{ display: 'block', fontSize: 11, color: '#94A3B8' }}>{p.tasks} tasks · {p.teammates} teammates</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="glass-card" style={{ padding: '18px 20px' }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, color: '#0F172A', marginBottom: 12 }}><CalendarDays style={{ width: 16, height: 16, color: V }} /> Calendar</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginBottom: 12 }}>
                {week.map((d, i) => {
                  const sel = i === selDay;
                  return (
                    <button key={i} onClick={() => setSelDay(i)} style={{ flex: 1, textAlign: 'center', padding: '8px 0', borderRadius: 10, border: 'none', cursor: 'pointer', background: sel ? V : (d.today ? V_WASH : 'transparent'), color: sel ? '#fff' : '#0F172A', transition: 'background .14s' }}>
                      <div style={{ fontSize: 10, fontWeight: 700, opacity: sel ? 0.85 : 0.5 }}>{d.dow}</div>
                      <div style={{ fontSize: 15, fontWeight: 800, fontFamily: 'Barlow' }}>{d.day}</div>
                    </button>
                  );
                })}
              </div>
              {(() => {
                const clock = (s) => { try { return new Date(s).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
                const evs = [
                  ...(selDay === todayIdx && nextMeeting ? [{ t: nextMeeting.title, time: clock(nextMeeting.start), c: V, join: nextMeeting.joinLink }] : []),
                  ...(CAL_EVENTS[selDay] || []),
                ];
                if (!evs.length) return <div style={{ fontSize: 13, color: '#94A3B8', padding: '8px 0' }}>Nothing scheduled — enjoy the quiet 🌿</div>;
                return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{evs.map((e, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-2,#F8FAFF)', borderRadius: 10, padding: '10px 12px' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: e.c, flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.t}</span>
                    <span style={{ fontSize: 11.5, color: '#64748B', whiteSpace: 'nowrap' }}>{e.time}</span>
                    {e.join && <a href={e.join} target="_blank" rel="noreferrer" style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: V, borderRadius: 8, padding: '4px 9px', textDecoration: 'none' }}>Join</a>}
                  </div>
                ))}</div>;
              })()}
            </div>

            {/* Meetings */}
            <div className="glass-card" style={{ padding: '18px 20px' }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, color: '#0F172A', marginBottom: 12 }}><Video style={{ width: 16, height: 16, color: V }} /> My Meetings</div>
              {meetings.length === 0 ? <div style={{ fontSize: 13, color: '#94A3B8' }}>No upcoming meetings.</div> : meetings.slice(0, 4).map((m, i) => (
                <div key={m.id || i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderTop: i ? '1px solid #EEF1F8' : 'none' }}>
                  <span style={{ width: 30, height: 30, borderRadius: 8, background: V_WASH, color: V, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Video style={{ width: 14, height: 14 }} /></span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</div>
                    <div style={{ fontSize: 11, color: '#94A3B8' }}>{(() => { try { return new Date(m.start).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } })()}</div>
                  </div>
                  {m.joinLink && <a href={m.joinLink} target="_blank" rel="noreferrer" style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: V, borderRadius: 8, padding: '5px 10px', textDecoration: 'none' }}>Join</a>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* My Goals | Reconciliation activity */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)', gap: 16, marginTop: 16 }}>
          <div className="glass-card" style={{ padding: '18px 20px' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, color: '#0F172A', marginBottom: 14 }}><Target style={{ width: 16, height: 16, color: V }} /> My Goals</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {GOALS.map((g) => (
                <div key={g.label} style={{ cursor: 'pointer' }} onClick={() => navigate('/admin/tasks')}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
                    <span style={{ minWidth: 0 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{g.label}</span><span style={{ fontSize: 11, color: '#94A3B8' }}>{g.ctx}</span></span>
                    <span style={{ fontFamily: 'Barlow', fontWeight: 900, fontSize: 15, color: g.color }}>{g.pctv}%</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 6, background: '#F1F5F9', overflow: 'hidden' }}><div style={{ height: '100%', width: `${g.pctv}%`, borderRadius: 6, background: g.color }} /></div>
                </div>
              ))}
            </div>
          </div>

          <ChartCard title="Reconciliation runs — last 30 days" action={<span style={{ fontSize: 11, color: '#94A3B8' }}>{cnt(totalRuns)} total</span>}>
            {timelineHasData ? (
              <AreaChart data={timeline} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <defs><linearGradient id="arv" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={V} stopOpacity={0.28} /><stop offset="100%" stopColor={V} stopOpacity={0.02} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#94A3B8' }} interval="preserveStartEnd" minTickGap={28} tickFormatter={(d) => { const p = String(d).split('-'); return `${p[2]}/${p[1]}`; }} />
                <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} allowDecimals={false} width={32} />
                <Tooltip formatter={(v) => [cnt(v), 'Runs']} contentStyle={{ fontSize: 12, borderRadius: 10, border: '1px solid #E2E8F0' }} />
                <Area type="monotone" dataKey="runs" stroke={V} strokeWidth={2} fill="url(#arv)" />
              </AreaChart>
            ) : <ChartEmpty label="No runs in the last 30 days" />}
          </ChartCard>
        </div>

        {/* Runs by tool | Top users */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 16, marginTop: 16 }}>
          <ChartCard title="Runs by tool">
            {donutData.length > 0 ? (
              <PieChart>
                <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={2}>
                  {donutData.map((d, i) => <Cell key={d.name} fill={DONUT_CYCLE[i % DONUT_CYCLE.length]} />)}
                </Pie>
                <Tooltip formatter={(v, n) => [cnt(v), n]} contentStyle={{ fontSize: 12, borderRadius: 10, border: '1px solid #E2E8F0' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
              </PieChart>
            ) : <ChartEmpty label="No tool runs yet" />}
          </ChartCard>

          <div className="glass-card" style={{ padding: '16px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={CHART_TITLE}>Top users by runs</div>
              <button onClick={() => navigate('/admin/users')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: V }}>All users →</button>
            </div>
            {top5.length === 0 ? <div style={{ padding: '24px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No user activity yet</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {top5.map((u, i) => (
                  <button key={u.userId || i} onClick={() => navigate('/admin/users')} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 8px', borderRadius: 10, border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFF'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                    <span style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Barlow', fontWeight: 900, fontSize: 13, color: i === 0 ? '#D97706' : V, background: i === 0 ? '#FFFBEB' : V_WASH, border: `1px solid ${i === 0 ? '#FDE68A' : '#DDD6FE'}` }}>{i === 0 ? <Crown style={{ width: 14, height: 14 }} /> : i + 1}</span>
                    <span style={{ minWidth: 0, flex: 1 }}><span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name || 'Unknown'}</span><span style={{ display: 'block', fontSize: 11, color: '#64748B' }}>{u.topAgentLabel || u.role || '—'}</span></span>
                    <span style={{ textAlign: 'right', flexShrink: 0 }}><span style={{ display: 'block', fontFamily: 'Barlow', fontWeight: 900, fontSize: 15, color: '#0F172A' }}>{cnt(u.totalRuns)}</span><span style={{ display: 'block', fontSize: 10, color: '#94A3B8', textTransform: 'uppercase' }}>runs</span></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {loading && <div style={{ marginTop: 16, fontSize: 12, color: '#94A3B8', textAlign: 'center' }}>Loading platform data…</div>}
      </div>

      {/* Project detail modal (fake) */}
      {projectModal && (
        <div onClick={() => setProjectModal(null)} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(10,15,46,.45)', display: 'grid', placeItems: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} className="glass-card" style={{ width: 'min(560px, 100%)', maxHeight: '85vh', overflowY: 'auto', padding: 0 }}>
            <div style={{ padding: '20px 22px', borderBottom: '1px solid #E6EAF3', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 44, height: 44, borderRadius: 13, background: `${projectModal.color}1A`, color: projectModal.color, display: 'grid', placeItems: 'center', fontWeight: 900, fontFamily: 'Barlow', fontSize: 17, flexShrink: 0 }}>{projectModal.name[0]}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: '#0F172A' }}>{projectModal.name}</div>
                <div style={{ fontSize: 12, color: '#64748B' }}>Lead {projectModal.lead} · due {projectModal.due} · <span style={{ color: projectModal.status === 'At risk' ? '#E11D48' : '#059669', fontWeight: 700 }}>{projectModal.status}</span></div>
              </div>
              <button onClick={() => setProjectModal(null)} style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid #E6EAF3', background: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer', color: '#64748B' }}><X style={{ width: 15, height: 15 }} /></button>
            </div>
            <div style={{ padding: '18px 22px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}><span style={{ color: '#64748B', fontWeight: 700 }}>Progress</span><span style={{ fontWeight: 800, color: '#0F172A' }}>{projectModal.progress}%</span></div>
              <div style={{ height: 8, borderRadius: 6, background: '#F1F5F9', overflow: 'hidden', marginBottom: 18 }}><div style={{ height: '100%', width: `${projectModal.progress}%`, background: `linear-gradient(90deg, ${projectModal.color}, ${projectModal.color}CC)` }} /></div>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94A3B8', marginBottom: 8 }}>Team · {projectModal.teammates}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 18 }}>{projectModal.members.map((m) => (
                <span key={m} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#0F172A', background: '#F8FAFF', border: '1px solid #E6EAF3', borderRadius: 9999, padding: '4px 10px' }}><span style={{ width: 20, height: 20, borderRadius: '50%', background: `linear-gradient(135deg, ${V}, #8B5CF6)`, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 800 }}>{m[0]}</span>{m}</span>
              ))}</div>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94A3B8', marginBottom: 6 }}>Tasks · {projectModal.tasks}</div>
              <div>{projectModal.items.map((it, idx) => { const doneCount = Math.round(projectModal.items.length * projectModal.progress / 100); const done = idx < doneCount; return (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: idx ? '1px solid #EEF1F8' : 'none' }}>
                  <span style={{ width: 16, height: 16, borderRadius: 5, border: `1.8px solid ${done ? '#059669' : '#C6D0E4'}`, background: done ? '#059669' : 'transparent', flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: '#0F172A', textDecoration: done ? 'line-through' : 'none', opacity: done ? 0.6 : 1 }}>{it}</span>
                </div>
              ); })}</div>
            </div>
          </div>
        </div>
      )}

      {/* New project modal (fake) */}
      {newProjectOpen && (
        <div onClick={() => setNewProjectOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(10,15,46,.45)', display: 'grid', placeItems: 'center', padding: 24 }}>
          <div onClick={(e) => e.stopPropagation()} className="glass-card" style={{ width: 'min(460px, 100%)', padding: '22px 24px' }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: '#0F172A' }}>New project</div>
            <p style={{ fontSize: 13, color: '#64748B', margin: '4px 0 16px' }}>Spin up a client engagement.</p>
            <label style={{ fontSize: 12, fontWeight: 700, color: '#64748B' }}>Project name</label>
            <input placeholder="e.g. Q2 Reconciliation Cleanup" style={{ width: '100%', margin: '5px 0 12px', fontSize: 14, borderRadius: 10, border: '1px solid #E2E8F0', padding: '9px 12px', outline: 'none' }} />
            <label style={{ fontSize: 12, fontWeight: 700, color: '#64748B' }}>Description</label>
            <input placeholder="What's this project about?" style={{ width: '100%', margin: '5px 0 4px', fontSize: 14, borderRadius: 10, border: '1px solid #E2E8F0', padding: '9px 12px', outline: 'none' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
              <button onClick={() => setNewProjectOpen(false)} style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', color: '#334155', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => { setNewProjectOpen(false); toast.success('Project created'); }} style={{ padding: '9px 18px', borderRadius: 10, border: 'none', background: V, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Create project</button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
};

export default AdminDashboard;

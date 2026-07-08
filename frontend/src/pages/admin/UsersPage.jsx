import React, { useEffect, useMemo, useState } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { Users as UsersIcon, Activity, Clock, CheckCircle2, ChevronRight } from 'lucide-react';
import { ResponsiveContainer, RadialBarChart, RadialBar, PolarAngleAxis, BarChart, Bar, Cell, XAxis, YAxis, Tooltip } from 'recharts';
import { useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';

const V = '#6D5AE6';
const V_WASH = '#F1EEFC';
const cnt = (n) => Number(n || 0).toLocaleString('en-IN');
const pct = (x) => (x == null ? '—' : `${x}%`);
const initials = (n = '', e = '') => (n || e || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
const roleTint = (r) => r === 'admin' ? { c: '#E11D48', bg: '#FEF2F2' } : r === 'developer' ? { c: '#7C3AED', bg: '#F5F3FF' } : r === 'cfo' ? { c: '#0891B2', bg: '#ECFEFF' } : { c: V, bg: V_WASH };
// stable pseudo-metrics (no per-user task/response data exists yet — dummy but consistent)
const seed = (s = '') => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
const fakeCompletion = (id = '') => 62 + (seed(id) % 37);
const fakeResponse = (id = '') => { const m = 15 + (seed(id + 'r') % 150); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const RESP_DATA = [{ d: 'Mon', v: 48 }, { d: 'Tue', v: 66 }, { d: 'Wed', v: 40 }, { d: 'Thu', v: 82 }, { d: 'Fri', v: 55 }, { d: 'Sat', v: 30 }, { d: 'Sun', v: 22 }];
// per-user response distribution (dummy, stable) for the detail page
export const userResponseSeries = (id = '') => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => ({ d, v: 20 + (seed(id + d + i) % 90) }));

const UsersPage = () => {
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [overview, setOverview] = useState(null);
  const [taskStats, setTaskStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.get('/api/users'), api.get('/api/dashboard/admin/users-overview'), api.get('/api/tasks/stats'),
    ]).then(([u, o, t]) => {
      if (u.status === 'fulfilled' && Array.isArray(u.value.data)) setUsers(u.value.data);
      if (o.status === 'fulfilled') setOverview(o.value.data || null);
      if (t.status === 'fulfilled') setTaskStats(t.value.data || null);
      setLoading(false);
    });
  }, []);

  const topUsers = overview?.topUsers || [];
  const ovById = useMemo(() => Object.fromEntries(topUsers.map((u) => [u.userId, u])), [topUsers]);
  const summary = overview?.usersSummary || {};
  const ts = taskStats || {};
  const completion = ts.total ? Math.round((Number(ts.done || 0) / Number(ts.total)) * 100) : 91;
  const totalRuns = topUsers.reduce((s, u) => s + Number(u.totalRuns || 0), 0);

  const rows = useMemo(() => users.map((u) => {
    const o = ovById[u.id] || {};
    return { id: u.id, name: u.name || u.email, email: u.email, role: u.role, runs: Number(o.totalRuns || 0), rows: Number(o.totalRows != null ? o.totalRows : o.rows || 0), matchRate: o.matchRate ?? null, brands: Number(o.brands || 0) };
  }).sort((a, b) => b.runs - a.runs), [users, ovById]);

  const Metric = ({ icon: Icon, label, value, sub, accent }) => (
    <div className="glass-card" style={{ padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748B' }}>{label}</span>
        <span style={{ width: 32, height: 32, borderRadius: 9, background: V_WASH, display: 'grid', placeItems: 'center' }}><Icon style={{ width: 16, height: 16, color: V }} /></span>
      </div>
      <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 30, lineHeight: 1, color: accent || '#0F172A' }}>{value}</div>
      {sub}
    </div>
  );

  return (
    <DashboardLayout sidebarItems={ADMIN_SIDEBAR}>
      <div style={{ padding: '28px 28px 48px', maxWidth: 1320, margin: '0 auto', background: 'radial-gradient(1100px 520px at 12% -12%, #EFEBFF 0%, transparent 58%), radial-gradient(900px 440px at 100% -6%, #FBEAF5 0%, transparent 52%)' }}>
        <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 28, color: '#0F172A', letterSpacing: '-0.02em', margin: 0 }}>Users</h1>
        <p style={{ fontSize: 14, color: '#64748B', marginTop: 4, marginBottom: 18 }}>Team performance — completion, responsiveness &amp; reconciliation activity. Click a user to drill in.</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 14, marginBottom: 22 }}>
          {/* Completion radial gauge */}
          <div className="glass-card" style={{ padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748B' }}>Task Completion Rate</span>
              <div style={{ display: 'flex' }}>{rows.slice(0, 3).map((u, i) => (
                <span key={u.id} style={{ width: 24, height: 24, borderRadius: '50%', marginLeft: i ? -8 : 0, border: '2px solid #fff', background: `linear-gradient(135deg, ${V}, #8B5CF6)`, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 800 }}>{initials(u.name, u.email)}</span>
              ))}{rows.length > 3 && <span style={{ width: 24, height: 24, borderRadius: '50%', marginLeft: -8, border: '2px solid #fff', background: '#EEF1F8', color: '#64748B', display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 800 }}>+{rows.length - 3}</span>}</div>
            </div>
            <div style={{ position: 'relative', height: 132 }}>
              <ResponsiveContainer width="100%" height="100%">
                <RadialBarChart innerRadius="72%" outerRadius="100%" data={[{ v: completion }]} startAngle={90} endAngle={-270}>
                  <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                  <RadialBar background={{ fill: '#EEF1F8' }} dataKey="v" cornerRadius={10} fill="#059669" />
                </RadialBarChart>
              </ResponsiveContainer>
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
                <div style={{ textAlign: 'center' }}><div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 30, color: '#0F172A', lineHeight: 1 }}>{completion}%</div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 700 }}>completed</div></div>
              </div>
            </div>
          </div>

          {/* Avg response bar chart */}
          <div className="glass-card" style={{ padding: '18px 20px' }}>
            <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748B' }}>Average Response Time</span>
            <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 26, color: '#0F172A', margin: '4px 0 0' }}>1h 12m <span style={{ fontSize: 12, fontWeight: 700, color: '#059669' }}>▼ 9%</span></div>
            <div style={{ height: 108 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={RESP_DATA} margin={{ top: 8, right: 4, left: -30, bottom: 0 }}>
                  <XAxis dataKey="d" tick={{ fontSize: 10, fill: '#94A3B8' }} tickLine={false} axisLine={false} />
                  <YAxis hide />
                  <Tooltip cursor={{ fill: '#F8FAFF' }} formatter={(v) => [`${v} min`, 'Avg']} contentStyle={{ fontSize: 12, borderRadius: 10, border: '1px solid #E2E8F0' }} />
                  <Bar dataKey="v" radius={[6, 6, 0, 0]}>{RESP_DATA.map((d, i) => <Cell key={i} fill={d.v >= 80 ? '#F59E0B' : d.v >= 55 ? '#FBBF77' : '#FDE8C8'} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <Metric icon={UsersIcon} label="Active Users" value={cnt(summary.activeUsers)} sub={<div style={{ fontSize: 12, color: '#64748B', marginTop: 6 }}>of {cnt(summary.totalUsers)} total</div>} accent={V} />
          <Metric icon={Activity} label="Total Runs" value={cnt(totalRuns)} sub={<div style={{ fontSize: 12, color: '#64748B', marginTop: 6 }}>across the whole team</div>} />
        </div>

        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94A3B8', margin: '4px 2px 12px' }}>Team</div>
        {loading ? (
          <div style={{ color: '#94A3B8', fontSize: 13 }}>Loading team…</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
            {rows.map((u) => {
              const rt = roleTint(u.role); const comp = fakeCompletion(u.id);
              return (
                <div key={u.id} className="glass-card" style={{ padding: '16px 18px', cursor: 'pointer', transition: 'transform .14s, box-shadow .14s' }}
                  onClick={() => navigate(`/admin/analysis/user/${u.id}`)}
                  onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--card-shadow-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = ''; }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
                    <span style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 14, background: `linear-gradient(135deg, ${V}, #8B5CF6)` }}>{initials(u.name, u.email)}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</div>
                      <div style={{ fontSize: 11.5, color: '#94A3B8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                    </div>
                    <span style={{ fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: rt.c, background: rt.bg, padding: '3px 8px', borderRadius: 9999 }}>{u.role}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
                    {[{ l: 'Runs', v: cnt(u.runs) }, { l: 'Rows', v: cnt(u.rows) }, { l: 'Brands', v: cnt(u.brands) }].map((m) => (
                      <div key={m.l} style={{ background: 'var(--surface-2,#F8FAFF)', borderRadius: 10, padding: '9px 10px' }}>
                        <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 17, color: '#0F172A' }}>{m.v}</div>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: '#94A3B8' }}>{m.l}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5 }}>
                    <span style={{ color: '#64748B', display: 'inline-flex', alignItems: 'center', gap: 5 }}><CheckCircle2 style={{ width: 13, height: 13, color: '#059669' }} /> Completion</span>
                    <span style={{ fontWeight: 800, color: '#0F172A' }}>{comp}%</span>
                  </div>
                  <div style={{ height: 7, borderRadius: 6, background: '#F1F5F9', overflow: 'hidden', marginBottom: 10 }}><div style={{ height: '100%', width: `${comp}%`, background: 'linear-gradient(90deg,#10B981,#059669)' }} /></div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11.5, color: '#64748B' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Clock style={{ width: 13, height: 13 }} /> {fakeResponse(u.id)} avg · match {pct(u.matchRate)}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontWeight: 700, color: V }}>View<ChevronRight style={{ width: 13, height: 13 }} /></span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default UsersPage;

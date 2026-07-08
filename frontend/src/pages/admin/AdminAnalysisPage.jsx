import React, { useEffect, useMemo, useState } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, BarChart3, Activity, Layers, Target, Bot, Building2, ChevronRight, Crown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import api from '../../lib/api';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';

const V = '#6D5AE6';
const V_WASH = '#F1EEFC';
const DONUT = [V, '#0EA5E9', '#EC4899', '#F59E0B', '#059669', '#0748EE', '#14B8A6', '#DB2777', '#65A30D', '#7C3AED', '#475569'];
const cnt = (n) => Number(n || 0).toLocaleString('en-IN');
const compact = (n) => { const v = Number(n || 0); if (v >= 1e5) return (v / 1e5).toFixed(1).replace(/\.0$/, '') + ' L'; if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'; return cnt(v); };
const pct = (x) => (x == null ? '—' : `${x}%`);
const fmtDate = (s) => { if (!s) return '—'; try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return '—'; } };

const tabBtn = (active) => ({ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 9999, fontSize: 13, fontWeight: 700, cursor: 'pointer', background: active ? V : '#fff', color: active ? '#fff' : '#0F172A', border: `1px solid ${active ? V : '#E6EAF3'}`, boxShadow: '0 1px 3px rgba(10,15,46,.05)' });
const CT = { fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748B', marginBottom: 10 };
const th = (right) => ({ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#64748B', textAlign: right ? 'right' : 'left', padding: '11px 16px', background: '#F8FAFF', borderBottom: '1px solid #E6EAF3', whiteSpace: 'nowrap' });
const td = (extra) => ({ fontSize: 13, padding: '12px 16px', color: '#3A4356', ...extra });

const AdminAnalysisPage = () => {
  const navigate = useNavigate();
  const [a, setA] = useState(null);
  const [users, setUsers] = useState([]);

  useEffect(() => {
    api.get('/api/dashboard/admin/tool-analytics').then((r) => setA(r.data)).catch(() => {});
    api.get('/api/dashboard/admin/users-overview').then((r) => setUsers(Array.isArray(r.data?.topUsers) ? r.data.topUsers : [])).catch(() => {});
  }, []);

  const t = a?.totals || {};
  const tools = Array.isArray(a?.tools) ? a.tools : [];
  const timeline = Array.isArray(a?.timeline) ? a.timeline : [];
  const runsShare = Array.isArray(a?.runsShare) ? a.runsShare : [];
  const donut = useMemo(() => runsShare.filter((d) => Number(d.runs) > 0).map((d) => ({ name: d.name, value: Number(d.runs) })), [runsShare]);
  const hasTl = timeline.some((d) => Number(d.runs) > 0);

  const Kpi = ({ icon: Icon, label, value }) => (
    <div className="glass-card" style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: V_WASH, display: 'grid', placeItems: 'center' }}><Icon style={{ width: 17, height: 17, color: V }} /></span>
      <div><div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 24, lineHeight: 1.05, color: '#0F172A' }}>{value}</div><div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#64748B' }}>{label}</div></div>
    </div>
  );

  return (
    <DashboardLayout sidebarItems={ADMIN_SIDEBAR}>
      <div style={{ padding: '28px 28px 48px', maxWidth: 1320, margin: '0 auto', background: 'radial-gradient(1100px 520px at 12% -12%, #EFEBFF 0%, transparent 58%), radial-gradient(900px 440px at 100% -6%, #FBEAF5 0%, transparent 52%)' }}>
        <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 28, color: '#0F172A', letterSpacing: '-0.02em', margin: 0 }}>Platform Analysis</h1>
        <p style={{ fontSize: 14, color: '#64748B', marginTop: 4 }}>Cross-brand analytics &amp; drill-downs across every tool and user.</p>
        <div style={{ display: 'flex', gap: 8, margin: '16px 0 18px' }}>
          <button style={tabBtn(false)} onClick={() => navigate('/admin')}><LayoutDashboard style={{ width: 15, height: 15 }} /> Overview</button>
          <button style={tabBtn(true)}><BarChart3 style={{ width: 15, height: 15 }} /> Analysis</button>
        </div>

        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 18 }}>
          <Kpi icon={Activity} label="Total Runs" value={cnt(t.runs)} />
          <Kpi icon={Layers} label="Rows Processed" value={compact(t.rows)} />
          <Kpi icon={Target} label="Match Rate" value={pct(t.matchRate)} />
          <Kpi icon={Bot} label="Active Agents" value={cnt(t.activeTools)} />
          <Kpi icon={Building2} label="Brands w/ data" value={cnt(t.brandsWithData)} />
        </div>

        {/* charts */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', gap: 16, marginBottom: 16 }}>
          <div className="glass-card" style={{ padding: '16px 18px' }}>
            <div style={CT}>Reconciliation runs — last 30 days</div>
            <div style={{ height: 240 }}>
              {hasTl ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timeline} margin={{ top: 6, right: 10, left: -20, bottom: 0 }}>
                    <defs><linearGradient id="av" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={V} stopOpacity={0.28} /><stop offset="100%" stopColor={V} stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#94A3B8' }} interval="preserveStartEnd" minTickGap={28} tickFormatter={(d) => { const p = String(d).split('-'); return `${p[2]}/${p[1]}`; }} />
                    <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} allowDecimals={false} width={32} />
                    <Tooltip formatter={(v) => [cnt(v), 'Runs']} contentStyle={{ fontSize: 12, borderRadius: 10, border: '1px solid #E2E8F0' }} />
                    <Area type="monotone" dataKey="runs" stroke={V} strokeWidth={2} fill="url(#av)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#94A3B8', fontSize: 13 }}>No runs in the last 30 days</div>}
            </div>
          </div>
          <div className="glass-card" style={{ padding: '16px 18px' }}>
            <div style={CT}>Runs by tool</div>
            <div style={{ height: 240 }}>
              {donut.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={donut} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={2}>{donut.map((d, i) => <Cell key={d.name} fill={DONUT[i % DONUT.length]} />)}</Pie>
                    <Tooltip formatter={(v, n) => [cnt(v), n]} contentStyle={{ fontSize: 12, borderRadius: 10, border: '1px solid #E2E8F0' }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
                  </PieChart>
                </ResponsiveContainer>
              ) : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#94A3B8', fontSize: 13 }}>No tool runs yet</div>}
            </div>
          </div>
        </div>

        {/* Tools table → drill */}
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94A3B8', margin: '4px 2px 12px' }}>Tools</div>
        <div className="glass-card" style={{ overflow: 'hidden', marginBottom: 20 }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
              <thead><tr><th style={th()}>Tool</th><th style={th(true)}>Runs</th><th style={th(true)}>Rows</th><th style={th(true)}>Match rate</th><th style={th()}>Last run</th><th style={th(true)}></th></tr></thead>
              <tbody>
                {tools.length === 0 ? <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No tool activity yet.</td></tr> : tools.map((tl) => (
                  <tr key={tl.agent_type} style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/analysis/tool/${tl.agent_type}`)} onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFF'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                    <td style={td({ fontWeight: 700, color: '#0F172A' })}>{tl.label}</td>
                    <td style={td({ textAlign: 'right', fontVariantNumeric: 'tabular-nums' })}>{cnt(tl.runs)}</td>
                    <td style={td({ textAlign: 'right', fontVariantNumeric: 'tabular-nums' })}>{cnt(tl.rows)}</td>
                    <td style={td({ textAlign: 'right', fontWeight: 700, color: tl.matchRate == null ? '#94A3B8' : '#059669' })}>{pct(tl.matchRate)}</td>
                    <td style={td({ color: '#64748B', whiteSpace: 'nowrap' })}>{fmtDate(tl.lastRun)}</td>
                    <td style={td({ textAlign: 'right' })}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 700, color: V }}>View<ChevronRight style={{ width: 13, height: 13 }} /></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Users table → drill */}
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94A3B8', margin: '4px 2px 12px' }}>Users</div>
        <div className="glass-card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
              <thead><tr><th style={th()}>User</th><th style={th()}>Top agent</th><th style={th(true)}>Runs</th><th style={th(true)}>Rows</th><th style={th(true)}>Match rate</th><th style={th(true)}></th></tr></thead>
              <tbody>
                {users.length === 0 ? <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No user activity yet.</td></tr> : users.map((u, i) => (
                  <tr key={u.userId || i} style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/analysis/user/${u.userId}`)} onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFF'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                    <td style={td({ fontWeight: 700, color: '#0F172A' })}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{i === 0 && <Crown style={{ width: 14, height: 14, color: '#D97706' }} />}{u.name || 'Unknown'}</span></td>
                    <td style={td({ color: '#64748B' })}>{u.topAgentLabel || '—'}</td>
                    <td style={td({ textAlign: 'right', fontVariantNumeric: 'tabular-nums' })}>{cnt(u.totalRuns)}</td>
                    <td style={td({ textAlign: 'right', fontVariantNumeric: 'tabular-nums' })}>{cnt(u.totalRows != null ? u.totalRows : u.rows)}</td>
                    <td style={td({ textAlign: 'right', fontWeight: 700, color: u.matchRate == null ? '#94A3B8' : '#059669' })}>{pct(u.matchRate)}</td>
                    <td style={td({ textAlign: 'right' })}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 700, color: V }}>View<ChevronRight style={{ width: 13, height: 13 }} /></span></td>
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

export default AdminAnalysisPage;

import React, { useState, useEffect, useMemo } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { Building2, ChevronRight, Activity, FileSpreadsheet, Users as UsersIcon, Zap, Target, TrendingUp, Crown } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import api from '../../lib/api';
import { toast } from 'sonner';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';

const sidebarItems = ADMIN_SIDEBAR;

const nfmt = (n) => (n ?? 0).toLocaleString('en-IN');
const fmtDate = (s) => { try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); } catch { return '—'; } };
const roleColor = (r) => r === 'admin' ? { bg: '#FFF1F2', c: '#E11D48' } : r === 'cfo' ? { bg: '#F5F3FF', c: '#7C3AED' } : { bg: '#E8EFFE', c: '#0748EE' };

// ─── Shared chart atoms (match ToolResultDashboard) ──────────────────────────
const AXIS_TICK = { fontSize: 11, fill: '#94A3B8' };
const GRID = { strokeDasharray: '3 3', stroke: '#F1F5F9' };
const BAR_CYCLE = ['#0748EE', '#7C3AED', '#0F766E', '#D97706', '#059669', '#E11D48', '#0EA5E9', '#DB2777'];

// ─── Big stat number card (matches ToolResultDashboard StatCard) ─────────────
function StatCard({ label, value, sub, color = '#0748EE', bg = '#E8EFFE', Icon }) {
  return (
    <div className="stat-card" style={{ padding: '16px 18px', background: bg, border: `1px solid ${color}22` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: '30px', lineHeight: 1.05, color }}>
          {value}
        </div>
        {Icon && <Icon style={{ width: 18, height: 18, color, opacity: 0.55 }} />}
      </div>
      <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color, marginTop: '6px', opacity: 0.85 }}>
        {label}
      </div>
      {sub && <div style={{ fontSize: '11px', color, opacity: 0.6, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const SECTION_TITLE = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#64748B' };

// ─── Tooltip for the team ranking bar chart ──────────────────────────────────
function RankTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;
  return (
    <div className="glass-card" style={{ padding: '10px 12px', fontSize: 12 }}>
      <div style={{ fontWeight: 700, color: '#0F172A', marginBottom: 2 }}>{d.fullName}</div>
      <div style={{ color: '#0748EE', fontWeight: 600 }}>{nfmt(d.totalRuns)} runs</div>
      {d.topAgentLabel && d.topAgentLabel !== '—' && (
        <div style={{ color: '#64748B', marginTop: 2 }}>Top: {d.topAgentLabel}</div>
      )}
    </div>
  );
}

const UsersPage = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [activity, setActivity] = useState(null);
  const [loadingA, setLoadingA] = useState(false);

  // Team Activity overview
  const [overview, setOverview] = useState(null);
  const [loadingO, setLoadingO] = useState(true);

  useEffect(() => {
    api.get('/api/users')
      .then(r => { setUsers(r.data); if (r.data.length) selectUser(r.data[0]); })
      .catch(() => toast.error('Failed to load users'))
      .finally(() => setLoading(false));

    api.get('/api/dashboard/admin/users-overview')
      .then(r => setOverview(r.data))
      .catch(() => { /* graceful — overview is supplementary */ })
      .finally(() => setLoadingO(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectUser = (u) => {
    setSelected(u);
    setActivity(null);
    setLoadingA(true);
    api.get(`/api/dashboard/admin/user-activity/${u.id}`)
      .then(r => setActivity(r.data))
      .catch(() => toast.error('Failed to load activity'))
      .finally(() => setLoadingA(false));
  };

  // Select a user from the overview chart (find the matching list user; fall back to a synthetic stub)
  const selectByOverviewRow = (row) => {
    const match = users.find(u => u.id === row.userId);
    if (match) { selectUser(match); }
    else { selectUser({ id: row.userId, name: row.name, email: '', role: row.role }); }
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const summary = overview?.usersSummary;
  const topUsers = overview?.topUsers || [];

  // Ranking bar data (cap at 10 for readability)
  const rankData = useMemo(() => topUsers.slice(0, 10).map(u => ({
    name: (u.name || '—').length > 16 ? (u.name || '—').slice(0, 15) + '…' : (u.name || '—'),
    fullName: u.name || '—',
    userId: u.userId,
    role: u.role,
    totalRuns: u.totalRuns || 0,
    topAgentLabel: u.topAgentLabel || '—',
  })), [topUsers]);
  const anyRuns = rankData.some(d => d.totalRuns > 0);

  // The selected user's row in the overview (for the mini-dashboard KPIs / top agent)
  const selectedOv = useMemo(
    () => topUsers.find(u => u.userId === selected?.id) || null,
    [topUsers, selected]
  );

  // Per-brand runs for the selected user (from user-activity)
  const perBrandRuns = useMemo(() => {
    const brands = activity?.brands || [];
    return brands
      .map(b => ({
        name: (b.brandName || '—').length > 14 ? (b.brandName || '—').slice(0, 13) + '…' : (b.brandName || '—'),
        runs: b.totals?.runs || 0,
      }))
      .filter(b => b.runs > 0)
      .sort((a, b) => b.runs - a.runs);
  }, [activity]);

  // Aggregate match-rate from user-activity tools when overview row is absent
  const aggMatchRate = useMemo(() => {
    if (selectedOv?.matchRate != null) return selectedOv.matchRate;
    const tools = (activity?.brands || []).flatMap(b => b.tools || []);
    const rated = tools.filter(t => t.matchRate != null);
    if (!rated.length) return null;
    return Math.round(rated.reduce((s, t) => s + t.matchRate, 0) / rated.length);
  }, [selectedOv, activity]);

  const miniRuns = selectedOv?.totalRuns ?? activity?.totals?.runs ?? 0;
  const miniRows = selectedOv?.totalRows ?? activity?.totals?.rows ?? 0;
  const miniBrands = selectedOv?.brands ?? activity?.totals?.brands ?? 0;
  const miniTopAgent = selectedOv?.topAgentLabel && selectedOv.topAgentLabel !== '—' ? selectedOv.topAgentLabel : null;

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="users-page">
        <div className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight" style={{ color: 'var(--text-heading)' }}>Users</h1>
          <p className="mt-1" style={{ color: 'var(--text-muted)' }}>See what each user is doing — drill into their brands &amp; tool usage</p>
        </div>

        {/* ═══════════════ TEAM ACTIVITY OVERVIEW ═══════════════ */}
        <div className="mb-7">
          <div className="flex items-center gap-2 mb-3">
            <Activity className="w-4 h-4" style={{ color: '#0748EE' }} />
            <span style={SECTION_TITLE}>Team Activity</span>
          </div>

          {loadingO ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
              {[1, 2, 3, 4].map(i => <div key={i} className="h-24 rounded-2xl bg-slate-100 animate-pulse" />)}
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
              <StatCard label="Total Users" value={nfmt(summary?.totalUsers)} Icon={UsersIcon} color="#0748EE" bg="#E8EFFE"
                sub={summary?.activeUsers != null ? `${nfmt(summary.activeUsers)} active` : undefined} />
              <StatCard label="Active Users" value={nfmt(summary?.activeUsers)} Icon={Target} color="#059669" bg="#ECFDF5" />
              <StatCard label="Total Runs" value={nfmt(summary?.totalRuns)} Icon={Zap} color="#7C3AED" bg="#F5F3FF" />
              <StatCard label="Rows Processed" value={nfmt(summary?.totalRows)} Icon={FileSpreadsheet} color="#0F766E" bg="#ECFEFF" />
            </div>
          )}

          {/* Ranking bar chart */}
          <div className="glass-card" style={{ padding: '16px 18px' }}>
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="w-3.5 h-3.5" style={{ color: '#64748B' }} />
              <span style={SECTION_TITLE}>Most Active Users — by runs</span>
            </div>
            {loadingO ? (
              <div className="h-[260px] rounded-xl bg-slate-100 animate-pulse" />
            ) : !anyRuns ? (
              <div style={{ padding: '40px', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
                No runs yet — usage will appear here as users run tools.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(220, rankData.length * 38)}>
                <BarChart data={rankData} layout="vertical" margin={{ top: 5, right: 24, left: 10, bottom: 0 }}>
                  <CartesianGrid {...GRID} horizontal={false} />
                  <XAxis type="number" tick={AXIS_TICK} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: '#334155' }} width={120} />
                  <Tooltip content={<RankTooltip />} cursor={{ fill: '#F1F5F9' }} />
                  <Bar dataKey="totalRuns" radius={[0, 4, 4, 0]} barSize={20}
                    cursor="pointer" onClick={(d) => d?.payload && selectByOverviewRow(d.payload)}>
                    {rankData.map((d, i) => (
                      <Cell key={d.userId || i} fill={d.userId === selected?.id ? '#0748EE' : BAR_CYCLE[i % BAR_CYCLE.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Users list */}
          <div className="lg:col-span-1">
            <div className="rounded-2xl border bg-white overflow-hidden" style={{ borderColor: '#E2E8F0' }}>
              <div className="px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-500 border-b" style={{ borderColor: '#E2E8F0' }}>
                {users.length} users
              </div>
              {loading ? (
                <div className="p-4 space-y-2">{[1,2,3,4].map(i => <div key={i} className="h-12 rounded-lg bg-slate-100 animate-pulse" />)}</div>
              ) : (
                <div className="max-h-[70vh] overflow-y-auto">
                  {users.map(u => {
                    const rc = roleColor(u.role);
                    const active = selected?.id === u.id;
                    return (
                      <button key={u.id} onClick={() => selectUser(u)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left border-b transition-colors hover:bg-slate-50"
                        style={{ borderColor: '#F1F5F9', background: active ? '#F8FAFC' : 'transparent' }}>
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0"
                          style={{ background: rc.bg, color: rc.c }}>
                          {(u.name || u.email || '?')[0].toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-slate-800 truncate">{u.name || u.email}</div>
                          <div className="text-xs text-slate-400 truncate">{u.email}</div>
                        </div>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase" style={{ background: rc.bg, color: rc.c }}>{u.role}</span>
                        {active && <ChevronRight className="w-4 h-4 text-slate-400" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Activity detail */}
          <div className="lg:col-span-2">
            {!selected ? (
              <div className="rounded-2xl border bg-white p-10 text-center text-sm text-slate-400" style={{ borderColor: '#E2E8F0' }}>
                Select a user to see their activity
              </div>
            ) : (
              <div className="space-y-5">
                {/* User header */}
                <div className="rounded-2xl border bg-white p-5" style={{ borderColor: '#E2E8F0' }}>
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                      <h2 className="text-xl font-bold text-slate-900">{selected.name || selected.email}</h2>
                      <p className="text-sm text-slate-500">{selected.email ? selected.email : '—'} · <span className="capitalize">{selected.role}</span></p>
                    </div>
                    {activity?.totals && (
                      <div className="flex gap-5">
                        <div className="text-center"><div className="text-xl font-bold text-slate-900">{nfmt(activity.totals.runs)}</div><div className="text-xs text-slate-400">runs</div></div>
                        <div className="text-center"><div className="text-xl font-bold text-slate-900">{nfmt(activity.totals.rows)}</div><div className="text-xs text-slate-400">rows</div></div>
                        <div className="text-center"><div className="text-xl font-bold text-slate-900">{activity.totals.brands}</div><div className="text-xs text-slate-400">brands</div></div>
                      </div>
                    )}
                  </div>
                </div>

                {/* ─── PER-USER MINI-DASHBOARD ─── */}
                {!loadingA && (
                  <div className="rounded-2xl border bg-white p-5" style={{ borderColor: '#E2E8F0' }}>
                    <div className="flex items-center gap-2 mb-4">
                      <Activity className="w-3.5 h-3.5" style={{ color: '#0748EE' }} />
                      <span style={SECTION_TITLE}>Activity Summary</span>
                    </div>

                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-1">
                      <StatCard label="Runs" value={nfmt(miniRuns)} Icon={Zap} color="#0748EE" bg="#E8EFFE" />
                      <StatCard label="Rows" value={nfmt(miniRows)} Icon={FileSpreadsheet} color="#0F766E" bg="#ECFEFF" />
                      <StatCard label="Match Rate"
                        value={aggMatchRate != null ? `${aggMatchRate}%` : '—'}
                        Icon={Target}
                        color={aggMatchRate == null ? '#64748B' : aggMatchRate >= 80 ? '#059669' : aggMatchRate >= 50 ? '#D97706' : '#E11D48'}
                        bg={aggMatchRate == null ? '#F8FAFC' : aggMatchRate >= 80 ? '#ECFDF5' : aggMatchRate >= 50 ? '#FFFBEB' : '#FEF2F2'} />
                      <StatCard label="Brands" value={nfmt(miniBrands)} Icon={Building2} color="#7C3AED" bg="#F5F3FF" />
                    </div>

                    {/* Top agent + per-brand runs chart */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
                      <div className="rounded-xl p-4 flex flex-col justify-center" style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Crown className="w-3.5 h-3.5" style={{ color: '#D97706' }} />
                          <span style={{ ...SECTION_TITLE, color: '#D97706' }}>Top Tool</span>
                        </div>
                        {miniTopAgent ? (
                          <div style={{ fontSize: 15, fontWeight: 700, color: '#92400E', lineHeight: 1.3 }}>{miniTopAgent}</div>
                        ) : (
                          <div style={{ fontSize: 13, color: '#B45309', opacity: 0.7 }}>No tool used yet</div>
                        )}
                      </div>

                      <div className="lg:col-span-2 rounded-xl p-3" style={{ background: '#F8FAFC', border: '1px solid #E2E8F0' }}>
                        <div style={{ ...SECTION_TITLE, marginBottom: 6 }}>Runs by Brand</div>
                        {perBrandRuns.length === 0 ? (
                          <div style={{ padding: '24px', textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>
                            No runs yet — data resets nightly.
                          </div>
                        ) : (
                          <ResponsiveContainer width="100%" height={Math.max(120, perBrandRuns.length * 34)}>
                            <BarChart data={perBrandRuns} layout="vertical" margin={{ top: 0, right: 18, left: 6, bottom: 0 }}>
                              <CartesianGrid {...GRID} horizontal={false} />
                              <XAxis type="number" tick={AXIS_TICK} allowDecimals={false} />
                              <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#334155' }} width={96} />
                              <Tooltip formatter={(v) => [nfmt(v), 'runs']} cursor={{ fill: '#F1F5F9' }} />
                              <Bar dataKey="runs" fill="#0748EE" radius={[0, 4, 4, 0]} barSize={16} />
                            </BarChart>
                          </ResponsiveContainer>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* ─── EXISTING PER-BRAND TABLES (preserved) ─── */}
                {loadingA ? (
                  <div className="space-y-3">{[1,2].map(i => <div key={i} className="h-32 rounded-2xl bg-slate-100 animate-pulse" />)}</div>
                ) : (activity?.brands || []).length === 0 ? (
                  <div className="rounded-2xl border bg-white p-10 text-center text-sm text-slate-400" style={{ borderColor: '#E2E8F0' }}>
                    No brands assigned to this user.
                  </div>
                ) : (
                  activity.brands.map(b => (
                    <div key={b.brandId} className="rounded-2xl border bg-white overflow-hidden" style={{ borderColor: '#E2E8F0' }}>
                      <div className="px-5 py-3 flex items-center justify-between border-b" style={{ borderColor: '#E2E8F0' }}>
                        <div className="flex items-center gap-2">
                          <Building2 className="w-4 h-4 text-slate-400" />
                          <span className="text-sm font-bold text-slate-800">{b.brandName}</span>
                        </div>
                        <span className="text-xs text-slate-400 flex items-center gap-3">
                          <span className="flex items-center gap-1"><Activity className="w-3 h-3" />{nfmt(b.totals.runs)} runs</span>
                          <span className="flex items-center gap-1"><FileSpreadsheet className="w-3 h-3" />{nfmt(b.totals.rows)} rows</span>
                        </span>
                      </div>
                      {b.tools.length === 0 ? (
                        <div className="px-5 py-6 text-center text-sm text-slate-400">No tool runs yet (data resets nightly)</div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-xs text-slate-500" style={{ borderBottom: '1px solid #F1F5F9' }}>
                                <th className="px-5 py-2 font-semibold">Tool</th>
                                <th className="px-5 py-2 font-semibold text-right">Runs</th>
                                <th className="px-5 py-2 font-semibold text-right">Rows</th>
                                <th className="px-5 py-2 font-semibold text-right">Match&nbsp;%</th>
                                <th className="px-5 py-2 font-semibold text-right">Last&nbsp;run</th>
                              </tr>
                            </thead>
                            <tbody>
                              {b.tools.map(t => (
                                <tr key={t.agent_type} className="border-b last:border-0" style={{ borderColor: '#F8FAFC' }}>
                                  <td className="px-5 py-2 font-medium text-slate-800">{t.label}</td>
                                  <td className="px-5 py-2 text-right text-slate-700">{nfmt(t.runs)}</td>
                                  <td className="px-5 py-2 text-right text-slate-700">{nfmt(t.rows)}</td>
                                  <td className="px-5 py-2 text-right">
                                    {t.matchRate != null
                                      ? <span className="font-semibold" style={{ color: t.matchRate >= 80 ? '#059669' : t.matchRate >= 50 ? '#D97706' : '#E11D48' }}>{t.matchRate}%</span>
                                      : <span className="text-slate-400">—</span>}
                                  </td>
                                  <td className="px-5 py-2 text-right text-slate-500">{t.lastRun ? fmtDate(t.lastRun) : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default UsersPage;

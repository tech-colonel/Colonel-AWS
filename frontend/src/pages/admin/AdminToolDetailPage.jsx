import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { ChevronLeft, Activity, Layers, CheckCircle2, Target, Users, Building2 } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import api from '../../lib/api';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';

const V = '#6D5AE6';
const V_WASH = '#F1EEFC';
const cnt = (n) => Number(n || 0).toLocaleString('en-IN');
const pct = (x) => (x == null ? '—' : `${x}%`);
const fmtDate = (s) => { if (!s) return '—'; try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return '—'; } };
const initials = (n = '') => n.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || 'U';

const AdminToolDetailPage = () => {
  const { agentType } = useParams();
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/api/dashboard/admin/tool-details/${agentType}`).then((r) => setD(r.data)).catch(() => setD(null)); }, [agentType]);

  const t = d?.totals || {};
  const trend = useMemo(() => (d?.runsTrend || []).map((x) => ({ date: x.date, runs: Number(x.runs) || 0 })), [d]);
  const topUsers = d?.topUsers || [];
  const perBrand = d?.perBrand || [];
  const maxRuns = Math.max(1, ...topUsers.map((u) => u.runs));
  const hasTl = trend.some((x) => x.runs > 0);

  const Kpi = ({ icon: Icon, label, value }) => (
    <div className="glass-card" style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: V_WASH, display: 'grid', placeItems: 'center' }}><Icon style={{ width: 17, height: 17, color: V }} /></span>
      <div><div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 24, lineHeight: 1.05, color: '#0F172A' }}>{value}</div><div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#64748B' }}>{label}</div></div>
    </div>
  );
  const th = (r) => ({ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#64748B', textAlign: r ? 'right' : 'left', padding: '11px 16px', background: '#F8FAFF', borderBottom: '1px solid #E6EAF3' });
  const tdc = (e) => ({ fontSize: 13, padding: '12px 16px', color: '#3A4356', ...e });

  return (
    <DashboardLayout sidebarItems={ADMIN_SIDEBAR}>
      <div style={{ padding: '28px 28px 48px', maxWidth: 1100, margin: '0 auto', background: 'radial-gradient(1100px 520px at 12% -12%, #EFEBFF 0%, transparent 58%)' }}>
        <button onClick={() => navigate('/admin/analysis')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 600, color: '#64748B', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 12 }}><ChevronLeft style={{ width: 14, height: 14 }} /> Back to Analysis</button>
        <div className="glass-card" style={{ padding: '22px 24px', marginBottom: 16, background: `linear-gradient(120deg, ${V_WASH} 0%, #FFFFFF 60%)` }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: V }}>Tool analysis</div>
          <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 26, color: '#0F172A', marginTop: 4 }}>{d?.label || agentType}</h1>
          <p style={{ color: '#64748B', marginTop: 6, fontSize: 14 }}>Usage, trend, per-user and per-brand across the whole platform.</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 18 }}>
          <Kpi icon={Activity} label="Runs" value={cnt(t.runs)} />
          <Kpi icon={Layers} label="Rows" value={cnt(t.rows)} />
          <Kpi icon={CheckCircle2} label="Matched" value={cnt(t.matched)} />
          <Kpi icon={Target} label="Match rate" value={pct(t.matchRate)} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)', gap: 16, marginBottom: 16 }}>
          <div className="glass-card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748B', marginBottom: 10 }}>Runs — last 30 days</div>
            <div style={{ height: 220 }}>
              {hasTl ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trend} margin={{ top: 6, right: 10, left: -20, bottom: 0 }}>
                    <defs><linearGradient id="tv" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={V} stopOpacity={0.26} /><stop offset="100%" stopColor={V} stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94A3B8' }} interval="preserveStartEnd" minTickGap={26} tickFormatter={(x) => { const p = String(x).split('-'); return `${p[2]}/${p[1]}`; }} />
                    <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} allowDecimals={false} width={30} />
                    <Tooltip formatter={(v) => [cnt(v), 'Runs']} contentStyle={{ fontSize: 12, borderRadius: 10, border: '1px solid #E2E8F0' }} />
                    <Area type="monotone" dataKey="runs" stroke={V} strokeWidth={2} fill="url(#tv)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#94A3B8', fontSize: 13 }}>No runs in the last 30 days</div>}
            </div>
          </div>
          <div className="glass-card" style={{ padding: '16px 18px' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748B', marginBottom: 12 }}><Users style={{ width: 14, height: 14 }} /> Who ran this tool</div>
            {topUsers.length === 0 ? <div style={{ color: '#94A3B8', fontSize: 13, padding: '12px 0' }}>No runs recorded.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {topUsers.map((u) => (
                  <div key={u.userId || u.name}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
                      <span style={{ width: 26, height: 26, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center', color: '#fff', fontSize: 10.5, fontWeight: 700, background: `linear-gradient(135deg, ${V}, #8B5CF6)` }}>{initials(u.name)}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
                      <span style={{ fontSize: 12, color: '#64748B', whiteSpace: 'nowrap' }}>{cnt(u.runs)} runs</span>
                    </div>
                    <div style={{ height: 8, borderRadius: 6, background: '#F1F5F9', overflow: 'hidden' }}><div style={{ height: '100%', width: `${Math.round((u.runs / maxRuns) * 100)}%`, background: `linear-gradient(90deg, ${V}, #8B5CF6)` }} /></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="glass-card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid #E6EAF3', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748B' }}><Building2 style={{ width: 14, height: 14 }} /> Per brand</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
              <thead><tr><th style={th()}>Brand</th><th style={th(true)}>Runs</th><th style={th(true)}>Rows</th><th style={th(true)}>Matched</th><th style={th(true)}>Match rate</th></tr></thead>
              <tbody>
                {perBrand.length === 0 ? <tr><td colSpan={5} style={{ padding: 20, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No brand activity.</td></tr> : perBrand.map((b) => (
                  <tr key={b.brandId} style={{ cursor: 'pointer' }} onClick={() => navigate(`/brands/${b.brandId}/dashboard`)} onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFF'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                    <td style={tdc({ fontWeight: 700, color: '#0F172A' })}>{b.brandName}</td>
                    <td style={tdc({ textAlign: 'right', fontVariantNumeric: 'tabular-nums' })}>{cnt(b.runs)}</td>
                    <td style={tdc({ textAlign: 'right', fontVariantNumeric: 'tabular-nums' })}>{cnt(b.rows)}</td>
                    <td style={tdc({ textAlign: 'right', fontVariantNumeric: 'tabular-nums' })}>{cnt(b.matched)}</td>
                    <td style={tdc({ textAlign: 'right', fontWeight: 700, color: b.matchRate == null ? '#94A3B8' : '#059669' })}>{pct(b.matchRate)}</td>
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

export default AdminToolDetailPage;

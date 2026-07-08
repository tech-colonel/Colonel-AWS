import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Bot, Activity, Rows3, CheckCircle2, Clock, ChevronLeft, Users } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import api from '../../lib/api';
import { sidebarFor } from '../../lib/adminNav';

const BLUE = '#0748EE';
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

const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || 'U';

const AnalysisAgentPage = () => {
  const { brandId, agentType } = useParams();
  const navigate = useNavigate();
  const [brand, setBrand] = useState(null);
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    api.get(`/api/brands/${brandId}`).then((r) => setBrand(r.data)).catch(() => {});
    api.get(`/api/dashboard/agent-detail/${brandId}/${agentType}`).then((r) => setDetail(r.data)).catch(() => setDetail(null));
  }, [brandId, agentType]);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  const t = detail?.totals || {};
  const byUser = detail?.byUser || [];
  const monthly = useMemo(() => (detail?.monthly || []).map((m) => ({ label: m.label, runs: Number(m.runs) || 0 })), [detail]);
  const maxRuns = Math.max(1, ...byUser.map((u) => u.runs));

  const Kpi = ({ icon: Icon, label, value, color, bg }) => (
    <div className="glass-card" style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: bg, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon style={{ width: 17, height: 17, color }} /></span>
      <div><div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 24, lineHeight: 1.05, color: 'var(--text-heading)' }}>{value}</div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>{label}</div></div>
    </div>
  );

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" style={{ maxWidth: 1100, margin: '0 auto' }}>
        <button onClick={() => navigate(`/brands/${brandId}/analysis`)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 12 }}>
          <ChevronLeft style={{ width: 14, height: 14 }} /> Back to Analysis
        </button>

        <div className="glass-card" style={{ padding: '22px 24px', marginBottom: 16, background: 'linear-gradient(120deg, #EEF3FF 0%, #FFFFFF 60%)' }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: BLUE }}>{brand?.name || 'Brand'} · Tool analysis</div>
          <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 26, color: 'var(--text-heading)', lineHeight: 1.1, marginTop: 4 }}>{agentLabel(agentType)}</h1>
          <p style={{ color: 'var(--text-muted)', marginTop: 6, fontSize: 14 }}>Usage, trend, and who ran this tool on {brand?.name || 'this brand'}.</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 18 }}>
          <Kpi icon={Activity} label="Runs" value={fmtNum(t.runs)} color={BLUE} bg="#E8EFFE" />
          <Kpi icon={Rows3} label="Rows" value={fmtNum(t.rows)} color="#7C3AED" bg="#F5F3FF" />
          <Kpi icon={CheckCircle2} label="Matched" value={fmtNum(t.matched)} color="#059669" bg="#ECFDF5" />
          <Kpi icon={Clock} label="Time saved" value={`≈ ${hoursSaved(t.rows, t.runs)} hrs`} color="#EA580C" bg="#FFF7ED" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
          {/* Monthly trend */}
          <div className="glass-card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>Runs over time</div>
            <div style={{ height: 240 }}>
              {monthly.length === 0 ? (
                <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No runs yet.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={monthly} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                    <defs><linearGradient id="agt" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={BLUE} stopOpacity={0.18} /><stop offset="100%" stopColor={BLUE} stopOpacity={0} /></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94A3B8' }} tickLine={false} axisLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94A3B8' }} tickLine={false} axisLine={false} width={34} />
                    <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #E6EAF3', fontSize: 12 }} />
                    <Area type="monotone" dataKey="runs" name="Runs" stroke={BLUE} strokeWidth={2.5} fill="url(#agt)" dot={{ r: 3 }} activeDot={{ r: 5 }} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* User-wise breakdown */}
          <div className="glass-card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Users style={{ width: 14, height: 14 }} /> Who ran this tool
            </div>
            {byUser.length === 0 ? (
              <div style={{ padding: '16px 0', color: 'var(--text-muted)', fontSize: 13 }}>No runs recorded.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {byUser.map((u) => (
                  <div key={u.userId || u.name}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
                      <span style={{ width: 28, height: 28, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', color: '#fff', fontSize: 11, fontWeight: 700, background: 'linear-gradient(135deg,#0748EE,#7C3AED)' }}>{initials(u.name)}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtNum(u.runs)} runs · {fmtNum(u.rows)} rows</span>
                    </div>
                    <div style={{ height: 8, borderRadius: 6, background: 'var(--surface-2,#F8FAFF)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.round((u.runs / maxRuns) * 100)}%`, borderRadius: 6, background: 'linear-gradient(90deg,#0748EE,#4F86FF)' }} />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-faint,#94A0B8)', marginTop: 3 }}>Last run {fmtDate(u.last_run)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default AnalysisAgentPage;

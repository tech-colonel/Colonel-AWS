import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Bot, ChevronLeft, ChevronRight } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
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

const AnalysisMetricPage = () => {
  const { brandId, metric } = useParams();
  const navigate = useNavigate();
  const [brand, setBrand] = useState(null);
  const [summary, setSummary] = useState(null);
  const [activity, setActivity] = useState([]);

  useEffect(() => {
    api.get(`/api/brands/${brandId}`).then((r) => setBrand(r.data)).catch(() => {});
    api.get(`/api/dashboard/summary/${brandId}`).then((r) => setSummary(r.data)).catch(() => setSummary(null));
    api.get(`/api/dashboard/activity/${brandId}?days=30`).then((r) => setActivity(Array.isArray(r.data?.days) ? r.data.days : [])).catch(() => setActivity([]));
  }, [brandId]);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  const s = summary?.summary || {};
  const byAgent = summary?.by_agent || [];
  const totalRows = s.total_rows || 0;
  const savedHrs = hoursSaved(totalRows, s.total_jobs || 0);

  const CFG = {
    runs:   { label: 'Total Runs', color: BLUE, value: fmtNum(s.total_jobs), unit: 'runs', pick: (a) => Number(a.runs) || 0 },
    rows:   { label: 'Rows Processed', color: '#7C3AED', value: fmtNum(totalRows), unit: 'rows', pick: (a) => Number(a.total_rows) || 0 },
    time:   { label: 'Time Saved', color: '#059669', value: `≈ ${savedHrs} hrs`, unit: 'hrs', pick: (a) => hoursSaved(a.total_rows, a.runs) },
    agents: { label: 'Active Agents', color: '#EA580C', value: fmtNum(byAgent.length), unit: 'agents', pick: (a) => Number(a.runs) || 0 },
  };
  const cfg = CFG[metric] || CFG.runs;

  const bars = useMemo(() => byAgent.map((a) => ({ key: a.agent_type, name: agentLabel(a.agent_type), v: cfg.pick(a) })).sort((x, y) => y.v - x.v), [byAgent, metric]);
  const daily = useMemo(() => activity.map((d) => ({ date: d.date.slice(5), v: metric === 'rows' ? d.rows : d.runs })), [activity, metric]);
  const showDaily = metric === 'runs' || metric === 'rows';

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" style={{ maxWidth: 1100, margin: '0 auto' }}>
        <button onClick={() => navigate(`/brands/${brandId}/analysis`)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 12 }}>
          <ChevronLeft style={{ width: 14, height: 14 }} /> Back to Analysis
        </button>

        <div className="glass-card" style={{ padding: '22px 24px', marginBottom: 16, background: 'linear-gradient(120deg, #EEF3FF 0%, #FFFFFF 60%)' }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: cfg.color }}>{brand?.name || 'Brand'} · Metric</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 4 }}>
            <h1 style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 40, color: 'var(--text-heading)', lineHeight: 1 }}>{cfg.value}</h1>
            <span style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 18, color: 'var(--text-heading)' }}>{cfg.label}</span>
          </div>
          <p style={{ color: 'var(--text-muted)', marginTop: 6, fontSize: 14 }}>Breakdown across tools{showDaily ? ' and days' : ''} for {brand?.name || 'this brand'}.</p>
        </div>

        {showDaily && (
          <div className="glass-card" style={{ padding: '16px 18px', marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>{cfg.label} · last 30 days</div>
            <div style={{ height: 220 }}>
              {daily.length === 0 ? <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No activity yet.</div> : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={daily} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94A3B8' }} tickLine={false} axisLine={false} interval={4} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94A3B8' }} tickLine={false} axisLine={false} width={34} />
                    <Tooltip cursor={{ fill: '#F8FAFF' }} contentStyle={{ borderRadius: 10, border: '1px solid #E6EAF3', fontSize: 12 }} />
                    <Bar dataKey="v" name={cfg.label} fill={cfg.color} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        )}

        <div className="glass-card" style={{ padding: '16px 18px' }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>{cfg.label} by tool</div>
          <div style={{ height: Math.max(160, bars.length * 42) }}>
            {bars.length === 0 ? <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No runs yet.</div> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={bars} layout="vertical" margin={{ top: 4, right: 20, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#94A3B8' }} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10, fill: '#64748B' }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: '#F8FAFF' }} contentStyle={{ borderRadius: 10, border: '1px solid #E6EAF3', fontSize: 12 }} formatter={(v) => [fmtNum(v), cfg.unit]} />
                  <Bar dataKey="v" name={cfg.label} fill={cfg.color} radius={[0, 4, 4, 0]} cursor="pointer"
                    onClick={(d) => d?.payload?.key && navigate(`/brands/${brandId}/analysis/agent/${d.payload.key}`)} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column' }}>
            {byAgent.map((a) => (
              <div key={a.agent_type} onClick={() => navigate(`/brands/${brandId}/analysis/agent/${a.agent_type}`)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 6px', borderTop: '1px solid var(--border-soft,#EEF1F8)', cursor: 'pointer' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-2,#F8FAFF)'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agentLabel(a.agent_type)}</span>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--text-heading)', fontVariantNumeric: 'tabular-nums' }}>{metric === 'time' ? `≈ ${hoursSaved(a.total_rows, a.runs)} hrs` : fmtNum(cfg.pick(a))}</span>
                <span style={{ fontSize: 11, color: 'var(--text-faint,#94A0B8)', whiteSpace: 'nowrap' }}>{fmtDate(a.last_run)}</span>
                <ChevronRight style={{ width: 14, height: 14, color: '#CBD5E1' }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default AnalysisMetricPage;

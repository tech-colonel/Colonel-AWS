import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, BarChart3, Activity, Rows3, Clock, Bot } from 'lucide-react';
import api from '../../lib/api';
import { sidebarFor } from '../../lib/adminNav';

const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
const hoursSaved = (rows, runs) => {
  const mins = (Number(rows) || 0) * 0.5 + (Number(runs) || 0) * 10;
  const hrs = mins / 60;
  return hrs >= 10 ? Math.round(hrs) : Math.round(hrs * 10) / 10;
};

// Phase-2 sections coming to this page (kept visible so the scope is legible).
const COMING = [
  'KPI drill-downs — click a metric to open its mini-dashboard',
  'Runs over time (day / week / month) + daily process diagram',
  'Runs by tool, confidence / remark distribution, weekly progress',
  'Per-agent breakdown → click an agent for its user-wise analysis',
  'Meetings & compliance analytics · downloadable brand report',
];

const AnalysisPage = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const [brand, setBrand] = useState(null);
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    api.get(`/api/brands/${brandId}`).then((r) => setBrand(r.data)).catch(() => {});
    api.get(`/api/dashboard/summary/${brandId}`).then((r) => setSummary(r.data)).catch(() => setSummary(null));
  }, [brandId]);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  const s = summary?.summary || {};
  const byAgent = summary?.by_agent || [];
  const totalRuns = s.total_jobs || 0;
  const totalRows = s.total_rows || 0;
  const savedHrs = useMemo(() => hoursSaved(totalRows, totalRuns), [totalRows, totalRuns]);

  const tabBtn = (active) => ({
    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 9999,
    fontSize: 13, fontWeight: 700, cursor: 'pointer',
    background: active ? 'var(--text-heading)' : 'var(--surface)',
    color: active ? '#fff' : 'var(--text-heading)',
    border: `1px solid ${active ? 'var(--text-heading)' : 'var(--card-border)'}`, boxShadow: 'var(--card-shadow)',
  });

  const Kpi = ({ icon: Icon, label, value, color, bg }) => (
    <div className="glass-card" style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: bg, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <Icon style={{ width: 17, height: 17, color }} />
      </span>
      <div>
        <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 24, lineHeight: 1.05, color: 'var(--text-heading)' }}>{value}</div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>{label}</div>
      </div>
    </div>
  );

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" style={{ maxWidth: 1320, margin: '0 auto' }}>
        <div className="glass-card" style={{ padding: '22px 24px', marginBottom: 16, background: 'linear-gradient(120deg, #EEF3FF 0%, #FFFFFF 60%)' }}>
          <button onClick={() => navigate('/brands')} style={{ fontSize: 12, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 8 }}>← Back to Brands</button>
          <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 28, color: 'var(--text-heading)', lineHeight: 1.1 }}>Analysis</h1>
          <p style={{ color: 'var(--text-muted)', marginTop: 6, fontSize: 14 }}>Deep analytics & drill-downs for <strong style={{ color: 'var(--text-heading)' }}>{brand?.name || 'this brand'}</strong>.</p>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button style={tabBtn(false)} onClick={() => navigate(`/brands/${brandId}/dashboard`)}><LayoutDashboard style={{ width: 15, height: 15 }} /> Overview</button>
          <button style={tabBtn(true)}><BarChart3 style={{ width: 15, height: 15 }} /> Analysis</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 18 }}>
          <Kpi icon={Activity} label="Total Runs" value={fmtNum(totalRuns)} color="#0748EE" bg="#E8EFFE" />
          <Kpi icon={Rows3} label="Rows Processed" value={fmtNum(totalRows)} color="#7C3AED" bg="#F5F3FF" />
          <Kpi icon={Clock} label="Time Saved" value={`≈ ${savedHrs} hrs`} color="#059669" bg="#ECFDF5" />
          <Kpi icon={Bot} label="Active Agents" value={fmtNum(byAgent.length)} color="#EA580C" bg="#FFF7ED" />
        </div>

        <div className="glass-card" style={{ padding: '20px 22px' }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12 }}>Coming to Analysis (Phase 2)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {COMING.map((c, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--text-heading)' }}>
                <span style={{ width: 22, height: 22, borderRadius: 7, background: '#E8EFFE', color: '#0748EE', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, flexShrink: 0 }}>{i + 1}</span>
                {c}
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default AnalysisPage;

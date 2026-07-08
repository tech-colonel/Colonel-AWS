import React, { useEffect, useMemo, useState } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, BarChart3, Activity, Layers, Target, Bot } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';

const V = '#6D5AE6';
const V_WASH = '#F1EEFC';
const cnt = (n) => Number(n || 0).toLocaleString('en-IN');
const compact = (n) => { const v = Number(n || 0); if (v >= 1e5) return (v / 1e5).toFixed(1).replace(/\.0$/, '') + ' L'; if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'; return cnt(v); };
const pct = (x) => (x == null ? '—' : `${Math.round(Number(x))}%`);

// Phase 3B scope (kept visible so the plan is legible).
const COMING = [
  'Time-tracked / work-activity charts (HorizonHub style)',
  'Per-tool drill-down (top users, per-brand, status mix) — reuse getToolDetails',
  'Per-user activity drill-down — reuse getUserActivity',
  'Crextio-style sortable platform table + downloadable report',
];

const AdminAnalysisPage = () => {
  const navigate = useNavigate();
  const [analytics, setAnalytics] = useState(null);
  useEffect(() => { api.get('/api/dashboard/admin/tool-analytics').then((r) => setAnalytics(r.data)).catch(() => {}); }, []);
  const t = analytics?.totals || {};

  const tabBtn = (active) => ({ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 9999, fontSize: 13, fontWeight: 700, cursor: 'pointer', background: active ? V : '#fff', color: active ? '#fff' : '#0F172A', border: `1px solid ${active ? V : '#E6EAF3'}`, boxShadow: '0 1px 3px rgba(10,15,46,.05)' });
  const Kpi = ({ icon: Icon, label, value }) => (
    <div className="glass-card" style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: V_WASH, display: 'grid', placeItems: 'center' }}><Icon style={{ width: 17, height: 17, color: V }} /></span>
      <div><div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 24, lineHeight: 1.05, color: '#0F172A' }}>{value}</div><div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#64748B' }}>{label}</div></div>
    </div>
  );

  return (
    <DashboardLayout sidebarItems={ADMIN_SIDEBAR}>
      <div style={{ padding: '28px 28px 48px', maxWidth: 1320, margin: '0 auto', background: 'radial-gradient(1100px 520px at 12% -12%, #EFEBFF 0%, transparent 58%)' }}>
        <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 28, color: '#0F172A', letterSpacing: '-0.02em', margin: 0 }}>Platform Analysis</h1>
        <p style={{ fontSize: 14, color: '#64748B', marginTop: 4 }}>Cross-brand analytics &amp; drill-downs.</p>
        <div style={{ display: 'flex', gap: 8, margin: '16px 0 18px' }}>
          <button style={tabBtn(false)} onClick={() => navigate('/admin')}><LayoutDashboard style={{ width: 15, height: 15 }} /> Overview</button>
          <button style={tabBtn(true)}><BarChart3 style={{ width: 15, height: 15 }} /> Analysis</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 18 }}>
          <Kpi icon={Activity} label="Total Runs" value={cnt(t.runs)} />
          <Kpi icon={Layers} label="Rows Processed" value={compact(t.rows)} />
          <Kpi icon={Target} label="Match Rate" value={pct(t.matchRate)} />
          <Kpi icon={Bot} label="Agents" value={cnt(t.totalTools)} />
        </div>
        <div className="glass-card" style={{ padding: '20px 22px' }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#64748B', marginBottom: 12 }}>Coming to Analysis (Phase 3B)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {COMING.map((c, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#0F172A' }}>
                <span style={{ width: 22, height: 22, borderRadius: 7, background: V_WASH, color: V, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, flexShrink: 0 }}>{i + 1}</span>{c}
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default AdminAnalysisPage;

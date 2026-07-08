import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { ChevronLeft, Activity, Layers, Building2 } from 'lucide-react';
import api from '../../lib/api';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';

const V = '#6D5AE6';
const V_WASH = '#F1EEFC';
const cnt = (n) => Number(n || 0).toLocaleString('en-IN');
const pct = (x) => (x == null ? '—' : `${x}%`);
const fmtDate = (s) => { if (!s) return '—'; try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return '—'; } };
const initials = (n = '') => n.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || 'U';

const AdminUserDetailPage = () => {
  const { userId } = useParams();
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/api/dashboard/admin/user-activity/${userId}`).then((r) => setD(r.data)).catch(() => setD(null)); }, [userId]);

  const u = d?.user || {};
  const brands = d?.brands || [];
  const t = d?.totals || {};

  const Kpi = ({ icon: Icon, label, value }) => (
    <div className="glass-card" style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: V_WASH, display: 'grid', placeItems: 'center' }}><Icon style={{ width: 17, height: 17, color: V }} /></span>
      <div><div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 24, lineHeight: 1.05, color: '#0F172A' }}>{value}</div><div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#64748B' }}>{label}</div></div>
    </div>
  );
  const th = (r) => ({ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#64748B', textAlign: r ? 'right' : 'left', padding: '10px 14px', background: '#F8FAFF', borderBottom: '1px solid #E6EAF3' });
  const tdc = (e) => ({ fontSize: 13, padding: '11px 14px', color: '#3A4356', ...e });

  return (
    <DashboardLayout sidebarItems={ADMIN_SIDEBAR}>
      <div style={{ padding: '28px 28px 48px', maxWidth: 1100, margin: '0 auto', background: 'radial-gradient(1100px 520px at 12% -12%, #EFEBFF 0%, transparent 58%)' }}>
        <button onClick={() => navigate('/admin/analysis')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, fontWeight: 600, color: '#64748B', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 12 }}><ChevronLeft style={{ width: 14, height: 14 }} /> Back to Analysis</button>

        <div className="glass-card" style={{ padding: '22px 24px', marginBottom: 16, background: `linear-gradient(120deg, ${V_WASH} 0%, #FFFFFF 60%)`, display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ width: 48, height: 48, borderRadius: 14, flexShrink: 0, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 17, background: `linear-gradient(135deg, ${V}, #8B5CF6)` }}>{initials(u.name)}</span>
          <div>
            <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 24, color: '#0F172A', margin: 0 }}>{u.name || 'User'}</h1>
            <p style={{ color: '#64748B', marginTop: 3, fontSize: 13.5 }}>{u.email}{u.role ? ` · ${u.role}` : ''}</p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 18 }}>
          <Kpi icon={Activity} label="Total Runs" value={cnt(t.runs)} />
          <Kpi icon={Layers} label="Rows Processed" value={cnt(t.rows)} />
          <Kpi icon={Building2} label="Brands" value={cnt(t.brands)} />
        </div>

        {brands.length === 0 ? (
          <div className="glass-card" style={{ padding: 28, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No activity recorded for this user.</div>
        ) : brands.map((b) => (
          <div key={b.brandId} className="glass-card" style={{ overflow: 'hidden', marginBottom: 14 }}>
            <div style={{ padding: '13px 16px', borderBottom: '1px solid #E6EAF3', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button onClick={() => navigate(`/brands/${b.brandId}/dashboard`)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 800, color: '#0F172A' }}><Building2 style={{ width: 15, height: 15, color: V }} /> {b.brandName}</button>
              <span style={{ fontSize: 12, color: '#64748B' }}>{cnt(b.totals?.runs)} runs · {cnt(b.totals?.rows)} rows</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
                <thead><tr><th style={th()}>Tool</th><th style={th(true)}>Runs</th><th style={th(true)}>Rows</th><th style={th(true)}>Match rate</th><th style={th()}>Last run</th></tr></thead>
                <tbody>
                  {(b.tools || []).map((tl, i) => (
                    <tr key={i}>
                      <td style={tdc({ fontWeight: 600, color: '#0F172A' })}>{tl.label || tl.agent_type}</td>
                      <td style={tdc({ textAlign: 'right', fontVariantNumeric: 'tabular-nums' })}>{cnt(tl.runs)}</td>
                      <td style={tdc({ textAlign: 'right', fontVariantNumeric: 'tabular-nums' })}>{cnt(tl.rows)}</td>
                      <td style={tdc({ textAlign: 'right', fontWeight: 700, color: tl.matchRate == null ? '#94A3B8' : '#059669' })}>{pct(tl.matchRate)}</td>
                      <td style={tdc({ color: '#64748B', whiteSpace: 'nowrap' })}>{fmtDate(tl.lastRun)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </DashboardLayout>
  );
};

export default AdminUserDetailPage;

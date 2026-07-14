import React, { useState, useEffect } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { Landmark, ChevronLeft, ChevronRight, Loader2, Building2 } from 'lucide-react';
import api from '../../lib/api';
import { sidebarFor } from '../../lib/adminNav';
import { STATUTORY_CATEGORIES, STATUTORY_STATUS_COLUMNS } from '../../lib/statutoryMeta';

/* Admin cross-brand statutory completion — which brand has filed/completed what.
   Each brand carries its OWN dynamic categories + statuses (filing types for
   Stroom, monthly-workflow fields for Shumee/M-Brands/Urban Plant, etc.), so
   every brand renders a card with its own chips and completion. */
export default function AdminStatutory() {
  const [brands, setBrands] = useState(null);
  const [year, setYear] = useState(2026);

  useEffect(() => {
    setBrands(null);
    api.get('/api/statutory/admin/summary', { params: { year } })
      .then(r => setBrands(r.data?.brands || []))
      .catch(() => setBrands([]));
  }, [year]);

  return (
    <DashboardLayout sidebarItems={sidebarFor()}>
      <div style={{ padding: 24, maxWidth: 1200 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20, flexWrap: 'wrap' }}>
          <div style={{ width: 46, height: 46, borderRadius: 14, background: '#0748EE15', border: '1px solid #0748EE30', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Landmark style={{ width: 22, height: 22, color: '#0748EE' }} />
          </div>
          <div>
            <h1 style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 22, color: 'var(--text-heading)', lineHeight: 1.1 }}>Statutory Compliance</h1>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Cross-brand status — what's done vs pending, per brand</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 12, padding: '6px 8px' }}>
            <button onClick={() => setYear(y => y - 1)} style={iconBtn}><ChevronLeft style={{ width: 16, height: 16 }} /></button>
            <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-heading)', minWidth: 54, textAlign: 'center' }}>{year}</span>
            <button onClick={() => setYear(y => y + 1)} style={iconBtn}><ChevronRight style={{ width: 16, height: 16 }} /></button>
          </div>
        </div>

        {brands === null ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Loader2 className="animate-spin" style={{ width: 30, height: 30, color: '#0748EE' }} /></div>
        ) : brands.length === 0 ? (
          <div className="glass-card" style={{ padding: '56px 24px', textAlign: 'center' }}>
            <Landmark style={{ width: 26, height: 26, color: 'var(--text-muted)', marginBottom: 10 }} />
            <div style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 16, color: 'var(--text-heading)' }}>No statutory data for {year}</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>Brands with a statutory register will appear here.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {brands.map(b => <BrandCard key={b.brand_id} b={b} />)}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

function BrandCard({ b }) {
  const categories = (b.categories?.length ? b.categories : STATUTORY_CATEGORIES);
  const statuses = (b.statuses?.length ? b.statuses : STATUTORY_STATUS_COLUMNS);
  const doneKeys = statuses.filter(s => s.terminal).map(s => s.key);
  const effDone = doneKeys.length ? doneKeys : [statuses[statuses.length - 1]?.key];
  const nonTerminal = statuses.filter(s => !effDone.includes(s.key));
  const pct = b.total ? Math.round((b.done / b.total) * 100) : 0;

  return (
    <div className="glass-card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Building2 style={{ width: 17, height: 17, color: '#0748EE' }} />
        <span style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 16, color: 'var(--text-heading)' }}>{b.brand_name}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, minWidth: 200 }}>
          <div style={{ flex: 1, height: 7, borderRadius: 999, background: 'var(--card-border)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? '#059669' : '#0748EE', borderRadius: 999 }} />
          </div>
          <span style={{ fontFamily: 'Barlow', fontWeight: 900, fontSize: 15, color: 'var(--text-heading)', minWidth: 78, textAlign: 'right' }}>{b.done}/{b.total} · {pct}%</span>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        {categories.map(cat => {
          const byStatus = b.counts?.[cat.key] || {};
          const total = Object.values(byStatus).reduce((a, n) => a + n, 0);
          const done = effDone.reduce((a, k) => a + (byStatus[k] || 0), 0);
          const p = total ? Math.round((done / total) * 100) : 0;
          const complete = total > 0 && done === total;
          return (
            <div key={cat.key} style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid var(--card-border)', background: 'var(--page-bg)', opacity: total ? 1 : 0.5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: cat.color }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-heading)' }}>{cat.name}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: complete ? '#059669' : 'var(--text-muted)' }}>
                  {total ? `${done}/${total}` : '—'}
                </span>
              </div>
              <div style={{ height: 5, borderRadius: 999, background: 'var(--card-border)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${p}%`, background: cat.color, borderRadius: 999 }} />
              </div>
              {total > 0 && (() => {
                const parts = nonTerminal
                  .filter(s => byStatus[s.key])
                  .map(s => `${byStatus[s.key]} ${s.label.toLowerCase()}`);
                return parts.length ? (
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6 }}>{parts.join(' · ')}</div>
                ) : null;
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text-heading)', cursor: 'pointer' };

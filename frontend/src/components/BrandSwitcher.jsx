import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronsUpDown, Check, Building2 } from 'lucide-react';
import api from '../lib/api';

/**
 * Compact brand switcher for agent workspaces. Navigation IS the switch — picking
 * a brand navigates to /brands/<newId>/agents/<agentId>, so the URL stays the
 * source of truth (same mechanism as the RECO workspace). Admin sees all brands,
 * accountant sees only assigned (GET /my-brands handles both).
 */
export default function BrandSwitcher({ brandId, agentId }) {
  const navigate = useNavigate();
  const [brands, setBrands] = useState([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    let on = true;
    api.get('/api/brands/my-brands')
      .then((r) => { if (on) setBrands(Array.isArray(r.data) ? r.data : []); })
      .catch(() => {});
    return () => { on = false; };
  }, []);

  useEffect(() => {
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    if (open) document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, [open]);

  const current = brands.find((b) => b.id === brandId);
  const label = current?.name || 'Select brand';
  const pick = (id) => { setOpen(false); setSearch(''); if (id !== brandId) navigate(`/brands/${id}/agents/${agentId}`); };
  const filtered = brands.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginRight: 8 }}>Brand</span>
      <button
        onClick={() => setOpen((v) => !v)}
        data-testid="brand-switcher"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px',
          borderRadius: 9, border: '1px solid var(--card-border)', background: 'var(--surface)',
          cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--text-heading)',
        }}
      >
        <span style={{
          width: 22, height: 22, borderRadius: 6, flexShrink: 0, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 700,
          background: `hsl(${((label[0] || '?').charCodeAt(0) * 37) % 360},60%,50%)`,
        }}>{(label[0] || '?').toUpperCase()}</span>
        {label}
        <ChevronsUpDown style={{ width: 14, height: 14, color: 'var(--text-muted)' }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 60, width: 260,
          background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 12,
          boxShadow: '0 12px 32px rgba(0,0,0,0.14)', padding: 8,
        }}>
          <input
            autoFocus placeholder="Search brands…" value={search} onChange={(e) => setSearch(e.target.value)}
            style={{
              width: '100%', padding: '8px 10px', marginBottom: 6, borderRadius: 8, fontSize: 13, outline: 'none',
              background: 'var(--page-bg)', border: '1px solid var(--card-border)', color: 'var(--text-heading)', boxSizing: 'border-box',
            }}
          />
          <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {filtered.map((b) => (
              <button key={b.id} onClick={() => pick(b.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, textAlign: 'left',
                  background: b.id === brandId ? 'rgba(7,72,238,0.06)' : 'transparent',
                  border: b.id === brandId ? '1px solid rgba(7,72,238,0.15)' : '1px solid transparent', cursor: 'pointer',
                }}
                onMouseEnter={(e) => { if (b.id !== brandId) e.currentTarget.style.background = 'var(--page-bg)'; }}
                onMouseLeave={(e) => { if (b.id !== brandId) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{
                  width: 26, height: 26, borderRadius: 6, flexShrink: 0, display: 'inline-flex', alignItems: 'center',
                  justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 700,
                  background: `hsl(${(b.name.charCodeAt(0) * 37) % 360},60%,50%)`,
                }}>{b.name[0].toUpperCase()}</span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>{b.name}</span>
                {b.id === brandId && <Check style={{ width: 14, height: 14, color: '#0748EE' }} />}
              </button>
            ))}
            {filtered.length === 0 && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '14px 0' }}>
                <Building2 style={{ width: 14, height: 14, display: 'inline', marginRight: 4 }} />No brands found
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

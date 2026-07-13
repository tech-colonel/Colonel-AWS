import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import api from '../../lib/api';
import { STATUTORY_OWNER_EMAIL } from '../../lib/statutoryMeta';

/**
 * Brandless entry point for Statutory Compliance (sidebar link → /statutory-compliance).
 * Resolves the brand at navigation time instead of depending on a possibly-empty
 * localStorage 'lastBrandId' (which caused the intermittent bounce to /brands).
 * Order: lastBrandId → first assigned brand → /brands (only if the user truly has none).
 */
export default function StatutoryRedirect() {
  const [target, setTarget] = useState(null);

  useEffect(() => {
    let on = true;
    const last = (() => { try { return localStorage.getItem('lastBrandId') || ''; } catch { return ''; } })();
    if (last) { setTarget(`/brands/${last}/statutory-compliance`); return; }
    api.get('/api/brands/my-brands')
      .then((r) => {
        if (!on) return;
        const brands = Array.isArray(r.data) ? r.data : [];
        if (brands.length) {
          try { localStorage.setItem('lastBrandId', brands[0].id); } catch (_) {}
          setTarget(`/brands/${brands[0].id}/statutory-compliance`);
        } else {
          setTarget('/brands');
        }
      })
      .catch(() => { if (on) setTarget('/brands'); });
    return () => { on = false; };
  }, []);

  // Owner-gate mirrors the page's own gate; non-owners never see the sidebar item,
  // but guard here too for safety.
  const email = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}').email; } catch { return ''; } })();
  if (email && email !== STATUTORY_OWNER_EMAIL) return <Navigate to="/brands" replace />;

  if (!target) {
    return (
      <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
        Loading Statutory Compliance…
      </div>
    );
  }
  return <Navigate to={target} replace />;
}

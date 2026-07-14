import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import api from '../../lib/api';

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

  if (!target) {
    return (
      <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
        Loading Statutory Compliance…
      </div>
    );
  }
  return <Navigate to={target} replace />;
}

import React, { useState, useEffect, useCallback } from 'react';
import { Plug, CheckCircle2, Loader2, X, Building2, Activity, ListChecks, Eye, AlertTriangle } from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';

/* ──────────────────────────────────────────────────────────────────────────────
   ShopifyCard — first-party Shopify connection, per brand.

   Deliberately separate from BOTH neighbours on this page:
     • the curated connectors (server-driven /api/integrations, per user)
     • the Composio marketplace (brokered OAuth, and Composio can reach only
       ~19 of our 30 Shopify scopes — hence this direct integration)
   Talks only to /api/shopify/*. Additive: nothing else on the page changes.

   Connections are per BRAND — one store per brand, a brand's whole team shares
   it — so the brand picker is part of the card's identity, not a convenience.
   ────────────────────────────────────────────────────────────────────────────── */

const BLUE = '#0748EE';

const btn = (bg, fg, border) => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  background: bg, color: fg, border: border || 'none', borderRadius: 9,
  padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
});

export default function ShopifyCard() {
  const [brands, setBrands] = useState([]);
  const [brandId, setBrandId] = useState(() => {
    try { return localStorage.getItem('lastBrandId') || ''; } catch { return ''; }
  });
  const [conn, setConn] = useState(null);
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(null);
  const [shop, setShop] = useState('');
  const [busy, setBusy] = useState(null);      // 'connect' | 'ping' | 'coverage' | 'preview'
  const [result, setResult] = useState(null);  // { kind, data }

  /* Load brands + whether the server has Shopify OAuth env configured. */
  useEffect(() => {
    (async () => {
      try {
        const [s, br] = await Promise.all([
          api.get('/api/shopify/status'),
          api.get('/api/brands/my-brands').catch(() => ({ data: [] })),
        ]);
        setConfigured(!!s.data?.configured);
        const list = Array.isArray(br.data) ? br.data : [];
        setBrands(list);
        setBrandId((cur) => cur || (list[0]?.id != null ? String(list[0].id) : ''));
      } catch { setConfigured(false); }
      finally { setLoading(false); }
    })();
  }, []);

  const loadConnection = useCallback(async (bid) => {
    if (!bid) { setConn(null); return; }
    try {
      const r = await api.get(`/api/shopify/${encodeURIComponent(bid)}/connection`);
      setConn(r.data?.connection || null);
    } catch { setConn(null); }
  }, []);

  useEffect(() => {
    setResult(null);
    loadConnection(brandId);
    try { if (brandId) localStorage.setItem('lastBrandId', brandId); } catch (_) {}
  }, [brandId, loadConnection]);

  /* The OAuth callback bounces back here with ?shopify_connected= or ?shopify_error=. */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const ok = q.get('shopify_connected');
    const err = q.get('shopify_error');
    if (ok) toast.success(`Shopify connected — ${ok}`);
    if (err) toast.error(err);
    if (ok || err) {
      const brand = q.get('brand');
      if (brand) setBrandId(brand);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const connect = async () => {
    if (!shop.trim()) return toast.error('Enter the store name, e.g. dchica');
    setBusy('connect');
    try {
      const r = await api.post(`/api/shopify/${encodeURIComponent(brandId)}/install`, { shop: shop.trim() });
      if (r.data?.url) window.location.href = r.data.url;   // hand off to Shopify consent
      else { toast.error('Could not start the connection.'); setBusy(null); }
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not start the connection.');
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy('connect');
    try {
      await api.post(`/api/shopify/${encodeURIComponent(brandId)}/disconnect`, {});
      toast.success('Shopify disconnected');
      setResult(null);
      loadConnection(brandId);
    } catch { toast.error('Could not disconnect.'); }
    finally { setBusy(null); }
  };

  /* The three test actions — each hits a read-only endpoint and shows raw truth. */
  const run = async (kind, path, label) => {
    setBusy(kind); setResult(null);
    try {
      const r = await api.get(`/api/shopify/${encodeURIComponent(brandId)}${path}`);
      setResult({ kind, data: r.data });
    } catch (e) {
      toast.error(e?.response?.data?.error || `${label} failed`);
      setResult({ kind, data: { error: e?.response?.data?.error || e.message } });
    } finally { setBusy(null); }
  };

  if (loading) return null;
  if (!configured) {
    return (
      <div className="glass-card" style={{ padding: 16, marginTop: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#92400E' }}>
          <AlertTriangle style={{ width: 15, height: 15 }} />
          Shopify OAuth isn’t configured on this server (SHOPIFY_API_KEY / SECRET / REDIRECT_URI).
        </div>
      </div>
    );
  }

  const connected = !!conn;

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-heading, #0F172A)' }}>Shopify</h3>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 9999,
                       background: '#EEF4FF', color: BLUE, border: `1px solid #C7D7FE` }}>
          Direct · 30 scopes
        </span>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted, #64748B)', marginBottom: 12 }}>
        Connected straight to Shopify’s Admin API — orders, returns, settlements, stock. One store per brand.
      </p>

      <div className="glass-card" style={{ padding: 16, border: connected ? '1px solid #A7F3D0' : '1px solid var(--card-border, #E2E8F0)' }}>
        {/* brand picker + status */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Building2 style={{ width: 15, height: 15, color: '#64748B' }} />
            <select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              style={{ fontSize: 13, padding: '7px 10px', borderRadius: 9, border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A' }}
            >
              <option value="">Select a brand…</option>
              {brands.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
            </select>
          </div>
          {connected && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700,
                           padding: '4px 9px', borderRadius: 9999, background: '#ECFDF5', color: '#059669',
                           border: '1px solid #A7F3D0', textTransform: 'uppercase', letterSpacing: '.04em' }}>
              <CheckCircle2 style={{ width: 11, height: 11 }} /> {conn.shop_domain}
            </span>
          )}
        </div>

        {!brandId ? (
          <p style={{ fontSize: 12, color: '#64748B' }}>Pick a brand to connect its Shopify store.</p>
        ) : connected ? (
          <>
            <div style={{ fontSize: 11.5, color: '#64748B', marginBottom: 12 }}>
              {conn.scopes ? `${conn.scopes.split(',').length} scopes granted` : 'scopes unknown'}
              {conn.installed_at ? ` · connected ${new Date(conn.installed_at).toLocaleString()}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => run('ping', '/ping', 'Test connection')} disabled={!!busy} style={btn('#fff', BLUE, '1px solid #C7D7FE')}>
                {busy === 'ping' ? <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> : <Activity style={{ width: 13, height: 13 }} />}
                Test connection
              </button>
              <button onClick={() => run('coverage', '/coverage', 'Scope check')} disabled={!!busy} style={btn('#fff', BLUE, '1px solid #C7D7FE')}>
                {busy === 'coverage' ? <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> : <ListChecks style={{ width: 13, height: 13 }} />}
                Check all 30 scopes
              </button>
              <button onClick={() => run('preview', '/orders/preview?limit=5', 'Order preview')} disabled={!!busy} style={btn('#fff', BLUE, '1px solid #C7D7FE')}>
                {busy === 'preview' ? <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> : <Eye style={{ width: 13, height: 13 }} />}
                Preview orders
              </button>
              <button onClick={disconnect} disabled={!!busy} style={btn('#fff', '#E11D48', '1px solid #FECACA')}>
                <X style={{ width: 13, height: 13 }} /> Disconnect
              </button>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <input
                value={shop}
                onChange={(e) => setShop(e.target.value)}
                placeholder="Store name *"
                onKeyDown={(e) => e.key === 'Enter' && connect()}
                style={{ fontSize: 12, padding: '8px 10px', borderRadius: 9, border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', minWidth: 220 }}
              />
              <p style={{ fontSize: 10.5, color: '#64748B', margin: '4px 0 0', maxWidth: 260, lineHeight: 1.45 }}>
                Store name only — e.g. <code>dchica</code> for <code>dchica.myshopify.com</code>. Not the full URL.
              </p>
            </div>
            <button onClick={connect} disabled={busy === 'connect'} style={{ ...btn(BLUE, '#fff'), boxShadow: '0 2px 8px rgba(7,72,238,.22)' }}>
              {busy === 'connect'
                ? <><Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> Redirecting…</>
                : <><Plug style={{ width: 13, height: 13 }} /> Connect</>}
            </button>
          </div>
        )}

        {/* ── results ─────────────────────────────────────────────────────── */}
        {result && <ResultPanel result={result} />}
      </div>
    </div>
  );
}

/* Renders whichever of the three test calls just ran. Kept dumb on purpose —
   it shows what the API actually returned rather than a prettified summary,
   because the point of these buttons is verification. */
function ResultPanel({ result }) {
  const { kind, data } = result;
  const box = { marginTop: 14, padding: 12, borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0' };

  if (data?.error) {
    return <div style={{ ...box, background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', fontSize: 12 }}>{data.error}</div>;
  }

  if (kind === 'ping') {
    const s = data.shop || {};
    return (
      <div style={box}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#059669', marginBottom: 6 }}>✅ Token works</div>
        <div style={{ fontSize: 12, color: '#334155', display: 'grid', gap: 3 }}>
          <span><b>{s.name}</b> · {s.domain}</span>
          <span>{s.plan} plan · {s.currency} · {s.country} · {s.timezone}</span>
        </div>
      </div>
    );
  }

  if (kind === 'coverage') {
    const rows = data.results || [];
    return (
      <div style={box}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8,
                      color: data.working === data.total ? '#059669' : '#B45309' }}>
          {data.working}/{data.total} scope groups reachable
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px,1fr))', gap: 4 }}>
          {rows.map((r) => (
            <div key={r.scope} style={{ fontSize: 11.5, color: r.ok ? '#334155' : '#B91C1C', display: 'flex', gap: 6 }}>
              <span>{r.ok ? '✅' : '❌'}</span>
              <span style={{ flex: 1 }}>
                <code>{r.scope}</code>
                {r.ok
                  ? <span style={{ color: '#64748B' }}> · {r.rows} row(s){r.note ? ` · ${r.note}` : ''}</span>
                  : <span style={{ color: '#B91C1C' }}> · {r.error}</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // preview → order-cycle rows
  const rows = data.rows || [];
  const cols = ['sale_order_number', 'date', 'total_amount', 'return_amount', 'net_amount',
                'awb_number', 'shipping_partner', 'delivery_status'];
  return (
    <div style={box}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: '#334155' }}>
        {rows.length} order(s) → shopify_order_cycle mapping
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11.5, minWidth: 640 }}>
          <thead>
            <tr>{cols.map((c) => (
              <th key={c} style={{ textAlign: 'left', padding: '5px 9px', color: '#64748B',
                                   borderBottom: '1px solid #E2E8F0', whiteSpace: 'nowrap', fontWeight: 700 }}>{c}</th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{cols.map((c) => (
                <td key={c} style={{ padding: '5px 9px', borderBottom: '1px solid #F1F5F9', whiteSpace: 'nowrap', color: '#334155' }}>
                  {c === 'date' && r[c] ? new Date(r[c]).toLocaleDateString() : (r[c] ?? <span style={{ color: '#CBD5E1' }}>—</span>)}
                </td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 10.5, color: '#64748B', marginTop: 8 }}>
        Preview only — nothing is written to the database.
      </p>
    </div>
  );
}

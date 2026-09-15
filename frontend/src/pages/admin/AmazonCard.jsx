import React, { useState, useEffect, useCallback } from 'react';
import { Plug, CheckCircle2, Loader2, X, Building2, Activity, Receipt, Eye, AlertTriangle, KeyRound } from 'lucide-react';
import api from '../../lib/api';
import ChannelLogo from '../../components/ChannelLogo';
import { toast } from 'sonner';

/* ──────────────────────────────────────────────────────────────────────────────
   AmazonCard — first-party Amazon SP-API connection, per brand.

   Sits beside ShopifyCard and behaves the same way, but the two are NOT two
   halves of one thing: connections are per BRAND, so in practice Amazon is
   connected for Koparo and Shopify for D'Chicha. The brand picker is the
   identity of the card, not a convenience — pick the brand, connect that brand's
   account, and a third brand needs no code at all.

   Connecting takes a refresh token pasted from Seller Central (self-
   authorization — what a private app does). The OAuth "Connect with Amazon"
   button appears only once the server has an app id + redirect URI configured,
   i.e. once our app is public and clients can authorise us themselves.

   Talks only to /api/amazon/*. Additive: nothing else on the page changes.
   ────────────────────────────────────────────────────────────────────────────── */

const BLUE = '#0748EE';
const AMBER = '#FF9900';                 // Amazon's own, used only as an accent

/* amazon.in is the default; the rest are here so brand #2 on another marketplace
   is a dropdown choice rather than a migration. */
const MARKETPLACES = [
  { id: 'A21TJRUUN4KGV', label: 'India · amazon.in',   region: 'eu' },
  { id: 'ATVPDKIKX0DER', label: 'US · amazon.com',     region: 'na' },
  { id: 'A2VIGQ35RCS4UG', label: 'UAE · amazon.ae',    region: 'eu' },
  { id: 'A1F83G8C2ARO7P', label: 'UK · amazon.co.uk',  region: 'eu' },
];

const btn = (bg, fg, border) => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  background: bg, color: fg, border: border || 'none', borderRadius: 9,
  padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
});

export default function AmazonCard() {
  const [brands, setBrands] = useState([]);
  const [brandId, setBrandId] = useState(() => {
    try { return localStorage.getItem('lastBrandId') || ''; } catch { return ''; }
  });
  const [conn, setConn] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cfg, setCfg] = useState(null);           // { configured, oauthConfigured, sandbox }
  const [token, setToken] = useState('');
  const [marketplaceId, setMarketplaceId] = useState('A21TJRUUN4KGV');
  const [busy, setBusy] = useState(null);         // 'connect' | 'ping' | 'settlements' | 'orders'
  const [result, setResult] = useState(null);     // { kind, data }

  useEffect(() => {
    (async () => {
      try {
        const [s, br] = await Promise.all([
          api.get('/api/amazon/status'),
          api.get('/api/brands/my-brands').catch(() => ({ data: [] })),
        ]);
        setCfg(s.data || { configured: false });
        const list = Array.isArray(br.data) ? br.data : [];
        setBrands(list);
        setBrandId((cur) => cur || (list[0]?.id != null ? String(list[0].id) : ''));
      } catch { setCfg({ configured: false }); }
      finally { setLoading(false); }
    })();
  }, []);

  const loadConnection = useCallback(async (bid) => {
    if (!bid) { setConn(null); return; }
    try {
      const r = await api.get(`/api/amazon/${encodeURIComponent(bid)}/connection`);
      setConn(r.data?.connection || null);
    } catch { setConn(null); }
  }, []);

  useEffect(() => {
    setResult(null);
    setToken('');
    loadConnection(brandId);
    try { if (brandId) localStorage.setItem('lastBrandId', brandId); } catch (_) {}
  }, [brandId, loadConnection]);

  /* The OAuth callback bounces back here with ?amazon_connected= or ?amazon_error=. */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const ok = q.get('amazon_connected');
    const err = q.get('amazon_error');
    if (ok) toast.success(`Amazon connected — ${ok}`);
    if (err) toast.error(err);
    if (ok || err) {
      const brand = q.get('brand');
      if (brand) setBrandId(brand);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  /* Self-authorization: paste the refresh token Seller Central showed. */
  const connect = async () => {
    if (!token.trim()) return toast.error('Paste the refresh token from Seller Central.');
    setBusy('connect');
    try {
      const mkt = MARKETPLACES.find((m) => m.id === marketplaceId);
      await api.post(`/api/amazon/${encodeURIComponent(brandId)}/connect`, {
        refreshToken: token.trim(),
        marketplaceId,
        region: mkt?.region,
      });
      toast.success('Amazon connected');
      setToken('');
      loadConnection(brandId);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not connect.');
    } finally { setBusy(null); }
  };

  /* OAuth: only offered once the app is public and configured server-side. */
  const connectOAuth = async () => {
    setBusy('connect');
    try {
      const r = await api.post(`/api/amazon/${encodeURIComponent(brandId)}/install`, { marketplaceId });
      if (r.data?.url) window.location.href = r.data.url;
      else { toast.error('Could not start the connection.'); setBusy(null); }
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not start the connection.');
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy('connect');
    try {
      await api.post(`/api/amazon/${encodeURIComponent(brandId)}/disconnect`, {});
      toast.success('Amazon disconnected');
      setResult(null);
      loadConnection(brandId);
    } catch { toast.error('Could not disconnect.'); }
    finally { setBusy(null); }
  };

  const run = async (kind, path, label) => {
    setBusy(kind); setResult(null);
    try {
      const r = await api.get(`/api/amazon/${encodeURIComponent(brandId)}${path}`);
      setResult({ kind, data: r.data });
    } catch (e) {
      toast.error(e?.response?.data?.error || `${label} failed`);
      setResult({ kind, data: { error: e?.response?.data?.error || e.message } });
    } finally { setBusy(null); }
  };

  if (loading) return null;
  if (!cfg?.configured) {
    return (
      <div className="glass-card" style={{ padding: 16, marginTop: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#92400E' }}>
          <AlertTriangle style={{ width: 15, height: 15 }} />
          Amazon SP-API isn’t configured on this server (AMAZON_LWA_CLIENT_ID / AMAZON_LWA_CLIENT_SECRET / AMAZON_TOKEN_KEY).
        </div>
      </div>
    );
  }

  const connected = !!conn;

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <ChannelLogo name="amazon" size={22} />
        <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-heading, #0F172A)' }}>Amazon</h3>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 9999,
                       background: '#FFF7ED', color: '#B45309', border: '1px solid #FED7AA' }}>
          SP-API · 6 roles
        </span>
        {cfg?.sandbox && (
          <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 9999,
                         background: '#F1F5F9', color: '#475569', border: '1px solid #E2E8F0' }}>
            Sandbox
          </span>
        )}
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted, #64748B)', marginBottom: 12 }}>
        Settlements, orders, FBA fees and inventory straight from Amazon’s Selling Partner API. One seller account per brand.
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
              <CheckCircle2 style={{ width: 11, height: 11 }} />
              {conn.selling_partner_id || 'connected'}
            </span>
          )}
        </div>

        {!brandId ? (
          <p style={{ fontSize: 12, color: '#64748B' }}>Pick a brand to connect its Amazon seller account.</p>
        ) : connected ? (
          <>
            <div style={{ fontSize: 11.5, color: '#64748B', marginBottom: 12 }}>
              {(MARKETPLACES.find((m) => m.id === conn.marketplace_id)?.label) || conn.marketplace_id}
              {` · ${conn.auth_method === 'oauth' ? 'OAuth' : 'self-authorized'}`}
              {conn.installed_at ? ` · connected ${new Date(conn.installed_at).toLocaleString()}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => run('ping', '/ping', 'Test connection')} disabled={!!busy} style={btn('#fff', BLUE, '1px solid #C7D7FE')}>
                {busy === 'ping' ? <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> : <Activity style={{ width: 13, height: 13 }} />}
                Test connection
              </button>
              <button onClick={() => run('settlements', '/settlements/preview?limit=1&rows=20', 'Settlements')} disabled={!!busy} style={btn('#fff', BLUE, '1px solid #C7D7FE')}>
                {busy === 'settlements' ? <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> : <Receipt style={{ width: 13, height: 13 }} />}
                Latest settlement
              </button>
              <button onClick={() => run('orders', '/orders/preview?days=7&rows=20', 'Orders')} disabled={!!busy} style={btn('#fff', BLUE, '1px solid #C7D7FE')}>
                {busy === 'orders' ? <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> : <Eye style={{ width: 13, height: 13 }} />}
                Preview orders
              </button>
              <button onClick={disconnect} disabled={!!busy} style={btn('#fff', '#E11D48', '1px solid #FECACA')}>
                <X style={{ width: 13, height: 13 }} /> Disconnect
              </button>
            </div>
            {busy === 'orders' && (
              <p style={{ fontSize: 10.5, color: '#64748B', marginTop: 8 }}>
                Amazon builds this report on demand — it can take a minute or two.
              </p>
            )}
          </>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 320px', minWidth: 260 }}>
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Refresh token (Atzr|…) *"
                  onKeyDown={(e) => e.key === 'Enter' && connect()}
                  style={{ width: '100%', fontSize: 12, padding: '8px 10px', borderRadius: 9,
                           border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A',
                           fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                />
                <p style={{ fontSize: 10.5, color: '#64748B', margin: '4px 0 0', lineHeight: 1.45 }}>
                  Solution Provider Portal → Apps → your app → <b>Authorize</b> → self-authorize. Amazon shows the
                  refresh token once — paste it here. It is encrypted before it is stored.
                </p>
              </div>
              <select
                value={marketplaceId}
                onChange={(e) => setMarketplaceId(e.target.value)}
                style={{ fontSize: 12, padding: '8px 10px', borderRadius: 9, border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A' }}
              >
                {MARKETPLACES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <button onClick={connect} disabled={busy === 'connect'} style={{ ...btn(BLUE, '#fff'), boxShadow: '0 2px 8px rgba(7,72,238,.22)' }}>
                {busy === 'connect'
                  ? <><Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> Connecting…</>
                  : <><KeyRound style={{ width: 13, height: 13 }} /> Connect</>}
              </button>
            </div>

            {cfg?.oauthConfigured && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2 }}>
                <span style={{ fontSize: 11, color: '#94A3B8' }}>or</span>
                <button onClick={connectOAuth} disabled={!!busy} style={btn('#fff', '#B45309', `1px solid #FED7AA`)}>
                  <Plug style={{ width: 13, height: 13, color: AMBER }} /> Connect with Amazon (OAuth)
                </button>
                <span style={{ fontSize: 10.5, color: '#94A3B8' }}>
                  the client approves from their own Seller Central
                </span>
              </div>
            )}
          </div>
        )}

        {result && <ResultPanel result={result} />}
      </div>
    </div>
  );
}

/* Shows what the API actually returned rather than a prettified summary — the
   point of these buttons is verification, same as the Shopify card. */
function ResultPanel({ result }) {
  const { kind, data } = result;
  const box = { marginTop: 14, padding: 12, borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0' };

  if (data?.error) {
    return <div style={{ ...box, background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C', fontSize: 12 }}>{data.error}</div>;
  }

  if (kind === 'ping') {
    const rows = data.marketplaces || [];
    return (
      <div style={box}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#059669', marginBottom: 6 }}>✅ Token works</div>
        {!data.marketplaceMatches && (
          <div style={{ fontSize: 11.5, color: '#B45309', marginBottom: 8 }}>
            ⚠️ This seller isn’t participating in the marketplace this brand is set to
            ({data.configuredMarketplaceId}) — reports will come back empty.
          </div>
        )}
        <div style={{ fontSize: 12, color: '#334155', display: 'grid', gap: 3 }}>
          {rows.map((m) => (
            <span key={m.id}>
              {m.participating ? '✅' : '—'} <b>{m.name}</b> · {m.country} · {m.currency} · <code>{m.id}</code>
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (kind === 'settlements') {
    const reports = data.reports || [];
    if (!reports.length) {
      return (
        <div style={box}>
          <div style={{ fontSize: 12, color: '#64748B' }}>
            No settlement reports in the last 90 days. Amazon generates these on its own fortnightly
            schedule — they cannot be requested on demand.
          </div>
        </div>
      );
    }
    const r = reports[0];
    return (
      <div style={box}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: '#334155' }}>
          Settlement {r.dataStartTime ? `${new Date(r.dataStartTime).toLocaleDateString()} → ${new Date(r.dataEndTime).toLocaleDateString()}` : ''}
          {' · '}{r.count} row(s) shown
        </div>
        <RawTable headers={r.headers.slice(0, 10)} rows={r.rows} />
      </div>
    );
  }

  // orders
  const rows = data.rows || [];
  return (
    <div style={box}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: '#334155' }}>
        {rows.length} order row(s) · report {data.reportId}
      </div>
      <RawTable headers={(data.headers || []).slice(0, 10)} rows={rows} />
      <p style={{ fontSize: 10.5, color: '#64748B', marginTop: 8 }}>
        Preview only — nothing is written to the database.
      </p>
    </div>
  );
}

function RawTable({ headers, rows }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11.5, minWidth: 640 }}>
        <thead>
          <tr>{headers.map((c) => (
            <th key={c} style={{ textAlign: 'left', padding: '5px 9px', color: '#64748B',
                                 borderBottom: '1px solid #E2E8F0', whiteSpace: 'nowrap', fontWeight: 700 }}>{c}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{headers.map((c) => (
              <td key={c} style={{ padding: '5px 9px', borderBottom: '1px solid #F1F5F9', whiteSpace: 'nowrap', color: '#334155' }}>
                {r[c] ? String(r[c]).slice(0, 40) : <span style={{ color: '#CBD5E1' }}>—</span>}
              </td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

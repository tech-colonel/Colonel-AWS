import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Plug, CheckCircle2, Loader2, Search, RefreshCw, Boxes, X, Building2, KeyRound } from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';

/* ──────────────────────────────────────────────────────────────────────────────
   ComposioMarketplace — showcases the full Composio catalog (1000+ apps) and lets
   the logged-in user connect any of them via Composio-managed OAuth.

   Additive & self-contained: rendered below the curated connectors on
   IntegrationsPage. Talks only to the new /api/composio/* endpoints. If the
   server has no COMPOSIO_API_KEY it renders a quiet "not configured" note.
   ────────────────────────────────────────────────────────────────────────────── */

const PAGE_SIZE = 60;                       // cards rendered per "page" (1000+ total)
const norm = (s) => (s || '').toLowerCase();

const isSecret = (key) => /key|secret|token|password|pat/i.test(key || '');
const AUTH_LABEL = { api_key: 'API key', bearer: 'Bearer token', basic: 'Username & password', none: 'No auth' };

/* ── One toolkit card ───────────────────────────────────────────────────────── */
function ToolkitCard({ toolkit, connection, busy, onConnect, onConnectCreds, onDisconnect }) {
  const connected = !!connection;
  const credType = ['api_key', 'bearer', 'basic', 'none'].includes(toolkit.authType) && !toolkit.oneClick;

  const [formOpen, setFormOpen] = useState(false);
  const [fldLoading, setFldLoading] = useState(false);
  const [flds, setFlds] = useState([]);
  const [scheme, setScheme] = useState(null);
  const [vals, setVals] = useState({});
  const [submitting, setSubmitting] = useState(false);

  const openForm = async () => {
    setFormOpen(true);
    setFldLoading(true);
    try {
      const r = await api.get(`/api/composio/${encodeURIComponent(toolkit.slug)}/fields`);
      const f = Array.isArray(r.data?.fields) ? r.data.fields : [];
      setFlds(f);
      setScheme(r.data?.authScheme || null);
      setVals(f.reduce((a, x) => ({ ...a, [x.name]: '' }), {}));
    } catch {
      toast.error('Could not load the connect form for this app.');
      setFormOpen(false);
    } finally {
      setFldLoading(false);
    }
  };

  const submitCreds = async (e) => {
    e.preventDefault();
    const credentials = {};
    flds.forEach((f) => { const v = (vals[f.name] || '').trim(); if (v) credentials[f.name] = v; });
    const missing = flds.some((f) => f.required && !credentials[f.name]);
    if (missing) { toast.error('Please fill the required fields.'); return; }
    setSubmitting(true);
    const ok = await onConnectCreds(toolkit.slug, scheme || toolkit.authType, credentials, toolkit.name);
    setSubmitting(false);
    if (ok) { setFormOpen(false); setVals({}); }
  };

  return (
    <div
      className="glass-card"
      style={{
        padding: 16, display: 'flex', flexDirection: 'column',
        border: connected ? '1px solid #A7F3D0' : '1px solid var(--card-border, #E2E8F0)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div
          style={{
            width: 44, height: 44, borderRadius: 12, background: '#fff',
            border: '1px solid #EceFF3', display: 'flex', alignItems: 'center',
            justifyContent: 'center', flexShrink: 0, overflow: 'hidden',
          }}
        >
          {toolkit.logo
            ? <img src={toolkit.logo} alt="" referrerPolicy="no-referrer" style={{ width: 26, height: 26, objectFit: 'contain' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
            : <Boxes style={{ width: 22, height: 22, color: '#94A3B8' }} />}
        </div>
        {connected && (
          <span
            className="inline-flex items-center gap-1"
            style={{
              fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 9999,
              background: '#ECFDF5', color: '#059669', border: '1px solid #A7F3D0',
              textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap',
            }}
          >
            <CheckCircle2 style={{ width: 11, height: 11 }} /> Connected
          </span>
        )}
      </div>

      <h4 style={{ marginTop: 12, fontSize: 14, fontWeight: 800, color: 'var(--text-heading, #0F172A)', lineHeight: 1.25 }}>
        {toolkit.name}
      </h4>
      <p
        style={{
          marginTop: 4, fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted, #64748B)', flex: 1,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}
      >
        {toolkit.description || 'Connect this app via Composio.'}
      </p>

      <div style={{ marginTop: 12 }}>
        {connected ? (
          <button
            onClick={() => onDisconnect(connection.id, toolkit.name)}
            disabled={busy}
            style={{
              width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              background: '#fff', color: '#E11D48', border: '1px solid #FECACA', borderRadius: 10,
              padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> : <X style={{ width: 13, height: 13 }} />}
            Disconnect
          </button>
        ) : toolkit.oneClick ? (
          <button
            onClick={() => onConnect(toolkit.slug, toolkit.name)}
            disabled={busy}
            style={{
              width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              background: '#0748EE', color: '#fff', border: 'none', borderRadius: 10,
              padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.7 : 1,
              boxShadow: '0 2px 8px rgba(7,72,238,0.22)',
            }}
          >
            {busy
              ? <><Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> Connecting…</>
              : <><Plug style={{ width: 13, height: 13 }} /> Connect</>}
          </button>
        ) : credType ? (
          // API key / bearer / basic — collect the user's own credentials inline.
          formOpen ? (
            <form onSubmit={submitCreds} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {fldLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748B', padding: '4px 0' }}>
                  <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> Loading form…
                </div>
              ) : (
                <>
                  {flds.length === 0 && (
                    <p style={{ fontSize: 11, color: '#64748B' }}>No fields required — click connect.</p>
                  )}
                  {flds.map((f) => (
                    <input
                      key={f.name}
                      type={isSecret(f.name) ? 'password' : 'text'}
                      value={vals[f.name] || ''}
                      placeholder={f.label + (f.required ? ' *' : '')}
                      autoComplete="off"
                      onChange={(e) => setVals((v) => ({ ...v, [f.name]: e.target.value }))}
                      style={{ width: '100%', fontSize: 12, padding: '8px 10px', borderRadius: 9, border: '1px solid #E2E8F0', outline: 'none', color: '#0F172A', background: '#fff' }}
                    />
                  ))}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="submit" disabled={submitting}
                      style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: '#0748EE', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 10px', fontSize: 12, fontWeight: 700, cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.7 : 1 }}>
                      {submitting ? <><Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> Connecting…</> : <><Plug style={{ width: 13, height: 13 }} /> Connect</>}
                    </button>
                    <button type="button" onClick={() => setFormOpen(false)} disabled={submitting}
                      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', color: '#64748B', border: '1px solid #E2E8F0', borderRadius: 9, padding: '8px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                      <X style={{ width: 13, height: 13 }} />
                    </button>
                  </div>
                </>
              )}
            </form>
          ) : (
            <button
              onClick={openForm}
              title={`Connect with your ${AUTH_LABEL[toolkit.authType] || 'credentials'}`}
              style={{
                width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                background: '#fff', color: '#0748EE', border: '1px solid #C7D7FE', borderRadius: 10,
                padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}
            >
              <KeyRound style={{ width: 13, height: 13 }} /> Connect with {AUTH_LABEL[toolkit.authType] || 'key'}
            </button>
          )
        ) : (
          // OAuth apps that need a developer-provided OAuth app (client id/secret).
          <button
            disabled
            title="This app uses OAuth and needs a developer-configured OAuth app before it can be connected."
            style={{
              width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              background: '#F8FAFC', color: '#94A3B8', border: '1px dashed #CBD5E1', borderRadius: 10,
              padding: '8px 12px', fontSize: 12, fontWeight: 700, cursor: 'not-allowed',
            }}
          >
            <KeyRound style={{ width: 13, height: 13 }} /> Needs OAuth setup
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Marketplace section ────────────────────────────────────────────────────── */
export default function ComposioMarketplace() {
  const [configured, setConfigured] = useState(null); // null = unknown/loading
  const [toolkits, setToolkits] = useState([]);
  const [connections, setConnections] = useState([]); // [{ id, slug, status }] for the selected brand
  const [brands, setBrands] = useState([]);
  const [brandId, setBrandId] = useState(() => { try { return localStorage.getItem('lastBrandId') || ''; } catch { return ''; } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busySlug, setBusySlug] = useState(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [oneClickOnly, setOneClickOnly] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);

  // Load the global catalog + brand list once (catalog is not brand-specific).
  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const s = await api.get('/api/composio/status');
      if (!s.data?.configured) { setConfigured(false); setLoading(false); return; }
      setConfigured(true);
      const [tk, br] = await Promise.all([
        api.get('/api/composio/toolkits'),
        api.get('/api/brands/my-brands').catch(() => ({ data: [] })),
      ]);
      setToolkits(Array.isArray(tk.data?.toolkits) ? tk.data.toolkits : []);
      const bl = Array.isArray(br.data) ? br.data : [];
      setBrands(bl);
      // Default the selected brand: remembered → first available.
      setBrandId((cur) => cur || (bl[0]?.id != null ? String(bl[0].id) : ''));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Connections are per-brand — (re)load whenever the selected brand changes.
  const loadConnections = useCallback((bid) => {
    const q = bid ? `?brandId=${encodeURIComponent(bid)}` : '';
    api.get(`/api/composio/connections${q}`)
      .then((cn) => setConnections(Array.isArray(cn.data?.connections) ? cn.data.connections : []))
      .catch(() => setConnections([]));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!configured) return;
    loadConnections(brandId);
    try { if (brandId) localStorage.setItem('lastBrandId', brandId); } catch (_) {}
  }, [configured, brandId, loadConnections]);

  // Handle the return trip after connecting on the provider's consent screen.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const slug = p.get('composio_connected');
    const b = p.get('brand');
    if (slug) {
      toast.success(`${slug} connected`);
      if (b) setBrandId(b);            // restore the brand the user connected for
      window.history.replaceState({}, '', window.location.pathname);
      loadConnections(b || brandId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadConnections]);

  // Fast lookup of a connection by (lower-cased) toolkit slug.
  const connBySlug = useMemo(() => {
    const m = {};
    connections.forEach((c) => { if (c.slug) m[norm(c.slug)] = c; });
    return m;
  }, [connections]);

  // Category options derived from the catalog.
  const categories = useMemo(() => {
    const set = new Map();
    toolkits.forEach((t) => (t.categories || []).forEach((c) => { if (c.slug) set.set(c.slug, c.name || c.slug); }));
    return Array.from(set, ([slug, name]) => ({ slug, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [toolkits]);

  const oneClickCount = useMemo(() => toolkits.filter((t) => t.oneClick).length, [toolkits]);

  const filtered = useMemo(() => {
    const q = norm(query);
    return toolkits.filter((t) => {
      if (oneClickOnly && !t.oneClick) return false;
      if (category !== 'all' && !(t.categories || []).some((c) => c.slug === category)) return false;
      if (!q) return true;
      return norm(t.name).includes(q) || norm(t.slug).includes(q) || norm(t.description).includes(q);
    });
  }, [toolkits, query, category, oneClickOnly]);

  useEffect(() => { setVisible(PAGE_SIZE); }, [query, category, oneClickOnly]);

  const handleConnect = async (slug, name) => {
    setBusySlug(slug);
    try {
      const r = await api.post(`/api/composio/${encodeURIComponent(slug)}/connect`, { brandId });
      if (r.data?.redirectUrl) {
        window.location.href = r.data.redirectUrl; // hand off to provider consent
      } else {
        toast.error('Could not start connection for this app.');
        setBusySlug(null);
      }
    } catch (e) {
      toast.error(e?.response?.data?.error || `Could not connect ${name}`);
      setBusySlug(null);
    }
  };

  const handleConnectCreds = async (slug, authScheme, credentials, name) => {
    try {
      const r = await api.post(`/api/composio/${encodeURIComponent(slug)}/connect`, { brandId, authScheme, credentials });
      if (r.data?.connected) {
        toast.success(`${name} connected`);
        loadConnections(brandId);
        return true;
      }
      toast.error('Could not connect — please check the details.');
      return false;
    } catch (e) {
      toast.error(e?.response?.data?.error || `Could not connect ${name}`);
      return false;
    }
  };

  const handleDisconnect = async (connectionId, name) => {
    setBusySlug(connectionId);
    try {
      await api.post(`/api/composio/connections/${encodeURIComponent(connectionId)}/disconnect`, {});
      toast.success(`${name} disconnected`);
    } catch (e) {
      toast.error(e?.response?.data?.error || `Could not disconnect ${name}`);
    } finally {
      loadConnections(brandId);   // resync with Composio's real state either way
      setBusySlug(null);
    }
  };

  /* ── Render ───────────────────────────────────────────────────────────────── */
  // Not configured → quiet inline note (doesn't disrupt the page).
  if (configured === false) {
    return (
      <div style={{ marginTop: 40 }}>
        <SectionHeader count={null} onRefresh={load} loading={loading} />
        <div className="glass-card" style={{ padding: 28, textAlign: 'center' }}>
          <Boxes style={{ width: 28, height: 28, color: '#94A3B8', margin: '0 auto 10px' }} />
          <p style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>Composio isn't connected yet</p>
          <p style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>
            Add <code style={{ background: '#F1F5F9', padding: '1px 6px', borderRadius: 6 }}>COMPOSIO_API_KEY</code> to the backend
            <code style={{ background: '#F1F5F9', padding: '1px 6px', borderRadius: 6, marginLeft: 4 }}>.env</code> and restart to unlock 1000+ apps.
          </p>
        </div>
      </div>
    );
  }

  const connectedCount = connections.length;

  return (
    <div style={{ marginTop: 40 }}>
      <SectionHeader
        count={configured ? toolkits.length : null}
        connected={connectedCount}
        onRefresh={load}
        loading={loading}
      />

      {/* Search + category filter */}
      {!loading && !error && toolkits.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
          {/* Brand selector — connections are shared across a brand's team */}
          {brands.length > 0 && (
            <div style={{ position: 'relative', minWidth: 200 }}>
              <Building2 style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 15, height: 15, color: '#0748EE', pointerEvents: 'none' }} />
              <select
                value={brandId}
                onChange={(e) => setBrandId(e.target.value)}
                title="Connections are shared by everyone on this brand"
                style={{
                  fontSize: 13, fontWeight: 700, padding: '10px 12px 10px 34px', borderRadius: 10,
                  border: '1px solid #C7D7FE', background: '#F5F8FF', color: '#0F172A', outline: 'none', minWidth: 200,
                }}
              >
                {brands.map((b) => <option key={b.id} value={String(b.id)}>{b.name}</option>)}
              </select>
            </div>
          )}
          <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 220 }}>
            <Search style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 15, height: 15, color: '#94A3B8' }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 1000+ apps — Gmail, Slack, Notion, Stripe…"
              style={{
                width: '100%', fontSize: 13, padding: '10px 12px 10px 36px', borderRadius: 10,
                border: '1px solid #E2E8F0', background: '#fff', color: '#0F172A', outline: 'none',
              }}
            />
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={{
              fontSize: 13, padding: '10px 12px', borderRadius: 10, border: '1px solid #E2E8F0',
              background: '#fff', color: '#0F172A', outline: 'none', minWidth: 180,
            }}
          >
            <option value="all">All categories</option>
            {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
          <label
            title="Show only apps that connect instantly with Composio-managed OAuth (no API key needed)"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10,
              border: `1px solid ${oneClickOnly ? '#0748EE' : '#E2E8F0'}`, background: oneClickOnly ? '#EEF4FF' : '#fff',
              color: oneClickOnly ? '#0748EE' : '#475569', fontSize: 13, fontWeight: 700, cursor: 'pointer', userSelect: 'none',
            }}
          >
            <input type="checkbox" checked={oneClickOnly} onChange={(e) => setOneClickOnly(e.target.checked)} style={{ accentColor: '#0748EE', cursor: 'pointer' }} />
            One-click only{oneClickCount ? ` (${oneClickCount})` : ''}
          </label>
        </div>
      )}

      {/* States */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
          {[...Array(8)].map((_, i) => (
            <div key={i} className="glass-card animate-pulse" style={{ height: 160, background: '#F1F5F9', border: '1px solid #E2E8F0' }} />
          ))}
        </div>
      ) : error ? (
        <div className="glass-card" style={{ padding: 32, textAlign: 'center' }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>Couldn't load the Composio catalog</p>
          <button onClick={load} style={{ marginTop: 12, background: '#0748EE', color: '#fff', border: 'none', borderRadius: 10, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Retry</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass-card" style={{ padding: 32, textAlign: 'center' }}>
          <p style={{ fontSize: 13, color: '#64748B' }}>No apps match “{query}”.</p>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
            {filtered.slice(0, visible).map((t) => (
              <ToolkitCard
                key={t.slug}
                toolkit={t}
                connection={connBySlug[norm(t.slug)]}
                busy={busySlug === t.slug || busySlug === connBySlug[norm(t.slug)]?.id}
                onConnect={handleConnect}
                onConnectCreds={handleConnectCreds}
                onDisconnect={handleDisconnect}
              />
            ))}
          </div>
          {visible < filtered.length && (
            <div style={{ textAlign: 'center', marginTop: 20 }}>
              <button
                onClick={() => setVisible((v) => v + PAGE_SIZE)}
                style={{ background: '#fff', color: '#0748EE', border: '1px solid #C7D7FE', borderRadius: 10, padding: '9px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
              >
                Show more ({filtered.length - visible} left)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── Section header (title + count pill + refresh) ──────────────────────────── */
function SectionHeader({ count, connected, onRefresh, loading }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-heading, #0F172A)' }}>Composio Marketplace</h2>
          {count != null && (
            <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 10px', borderRadius: 9999, background: '#EEF2FF', color: '#4338CA', border: '1px solid #C7D2FE' }}>
              {count.toLocaleString('en-IN')} apps
            </span>
          )}
          {connected > 0 && (
            <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 10px', borderRadius: 9999, background: '#ECFDF5', color: '#059669', border: '1px solid #A7F3D0' }}>
              {connected} connected
            </span>
          )}
        </div>
        <p style={{ marginTop: 4, fontSize: 13, color: 'var(--text-muted, #64748B)' }}>
          Connect any of 1000+ apps through Composio — OAuth handled securely, credentials never touch our servers.
        </p>
      </div>
      <button
        onClick={onRefresh}
        disabled={loading}
        className="inline-flex items-center gap-2"
        style={{ background: '#fff', color: '#475569', border: '1px solid #E2E8F0', borderRadius: 10, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer' }}
      >
        <RefreshCw className={loading ? 'animate-spin' : ''} style={{ width: 14, height: 14 }} />
        Refresh
      </button>
    </div>
  );
}

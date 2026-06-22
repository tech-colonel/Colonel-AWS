import React, { useState, useEffect, useCallback } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  Plug, CheckCircle2, X, Loader2, ShieldCheck, KeyRound, RefreshCw, Plug2,
} from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';
import BrandLogo from '../../components/BrandLogos';

const sidebarItems = ADMIN_SIDEBAR;

/* ── Status pill (matches ToolResultDashboard pill atoms) ───────────────────── */
function StatusPill({ connected }) {
  const cfg = connected
    ? { text: 'Connected',    color: '#059669', bg: '#ECFDF5', border: '#A7F3D0' }
    : { text: 'Disconnected', color: '#64748B', bg: '#F1F5F9', border: '#E2E8F0' };
  return (
    <span
      className="inline-flex items-center gap-1"
      style={{
        fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: '9999px',
        background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
        textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap',
      }}
    >
      {connected
        ? <CheckCircle2 style={{ width: 12, height: 12 }} />
        : <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#94A3B8', display: 'inline-block' }} />}
      {cfg.text}
    </span>
  );
}

/* ── Inline connect form (rendered inside the card when "Connect" is clicked) ─ */
function ConnectForm({ connector, onCancel, onSubmit, submitting }) {
  const fields = Array.isArray(connector.fields) ? connector.fields : [];
  const [values, setValues] = useState(() =>
    fields.reduce((acc, f) => ({ ...acc, [f.key]: '' }), {})
  );

  const isSecret = (key) => /key|secret|token|password/i.test(key);

  const handleSubmit = (e) => {
    e.preventDefault();
    const payload = {};
    fields.forEach((f) => {
      const v = (values[f.key] || '').trim();
      if (!v) return;
      // normalise to the backend's documented body keys
      if (/key|secret|token/i.test(f.key)) payload.apiKey = v;
      else if (/account|email|user|workspace/i.test(f.key)) payload.account = v;
      else payload[f.key] = v;
    });
    onSubmit(payload);
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        marginTop: 14, paddingTop: 14, borderTop: '1px dashed #E2E8F0',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      {fields.length === 0 ? (
        <p style={{ fontSize: 12, color: '#64748B' }}>
          No credentials required — click connect to enable.
        </p>
      ) : (
        fields.map((f) => (
          <label key={f.key} style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 4, letterSpacing: '0.02em' }}>
              {f.label}
            </span>
            <div style={{ position: 'relative' }}>
              {isSecret(f.key) && (
                <KeyRound style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: '#94A3B8' }} />
              )}
              <input
                type={isSecret(f.key) ? 'password' : 'text'}
                value={values[f.key] || ''}
                placeholder={f.placeholder || ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                autoComplete="off"
                style={{
                  width: '100%', fontSize: 13, padding: isSecret(f.key) ? '9px 12px 9px 32px' : '9px 12px',
                  borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff',
                  color: '#0F172A', outline: 'none',
                }}
              />
            </div>
          </label>
        ))
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
        <button
          type="submit"
          disabled={submitting}
          style={{
            flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: '#0748EE', color: '#fff', border: 'none', borderRadius: 10,
            padding: '9px 14px', fontSize: 13, fontWeight: 700,
            cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.7 : 1,
            boxShadow: '0 2px 8px rgba(7,72,238,0.22)',
          }}
        >
          {submitting
            ? <><Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> Connecting…</>
            : <><Plug style={{ width: 14, height: 14 }} /> Connect</>}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: '#fff', color: '#64748B', border: '1px solid #E2E8F0', borderRadius: 10,
            padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <X style={{ width: 14, height: 14 }} />
        </button>
      </div>
    </form>
  );
}

/* ── Connector card ─────────────────────────────────────────────────────────── */
function ConnectorCard({ connector, onConnect, onDisconnect, busy }) {
  const [open, setOpen] = useState(false);
  const connected = connector.status === 'connected';

  const handleSubmit = async (payload) => {
    const ok = await onConnect(connector.type, payload);
    if (ok) setOpen(false);
  };

  return (
    <div
      className="glass-card"
      style={{
        padding: 20, display: 'flex', flexDirection: 'column',
        border: connected ? '1px solid #A7F3D0' : '1px solid var(--card-border, #E2E8F0)',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {/* Header row: icon tile + status */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div
          style={{
            width: 48, height: 48, borderRadius: 14, background: '#fff',
            border: '1px solid #EceFF3', boxShadow: '0 1px 2px rgba(15,23,42,0.06)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}
        >
          <BrandLogo type={connector.type} size={28} />
        </div>
        <StatusPill connected={connected} />
      </div>

      {/* Name + blurb */}
      <h3 style={{ marginTop: 14, fontSize: 16, fontWeight: 800, color: 'var(--text-heading, #0F172A)' }}>
        {connector.name || connector.type}
      </h3>
      <p style={{ marginTop: 4, fontSize: 13, lineHeight: 1.5, color: 'var(--text-muted, #64748B)', flex: 1 }}>
        {connector.blurb || 'Connect this service to automate workflows.'}
      </p>

      {/* Connected account line */}
      {connected && connector.account && (
        <div
          style={{
            marginTop: 12, display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 12, color: '#059669', fontWeight: 600,
            background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 10, padding: '7px 10px',
          }}
        >
          <ShieldCheck style={{ width: 14, height: 14 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{connector.account}</span>
        </div>
      )}

      {/* Action area */}
      {!open && (
        <div style={{ marginTop: 16 }}>
          {connected ? (
            <button
              onClick={() => onDisconnect(connector.type)}
              disabled={busy}
              style={{
                width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                background: '#fff', color: '#E11D48', border: '1px solid #FECACA', borderRadius: 10,
                padding: '9px 14px', fontSize: 13, fontWeight: 700,
                cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.7 : 1,
              }}
            >
              {busy
                ? <><Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> Working…</>
                : <><Plug2 style={{ width: 14, height: 14 }} /> Disconnect</>}
            </button>
          ) : (
            <button
              onClick={() => setOpen(true)}
              disabled={busy}
              style={{
                width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                background: '#0748EE', color: '#fff', border: 'none', borderRadius: 10,
                padding: '9px 14px', fontSize: 13, fontWeight: 700,
                cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.7 : 1,
                boxShadow: '0 2px 8px rgba(7,72,238,0.22)',
              }}
            >
              <Plug style={{ width: 14, height: 14 }} /> Connect
            </button>
          )}
        </div>
      )}

      {open && (
        <ConnectForm
          connector={connector}
          submitting={busy}
          onCancel={() => setOpen(false)}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}

/* ── Stat strip ─────────────────────────────────────────────────────────────── */
function StatCard({ label, value, color, bg }) {
  return (
    <div className="stat-card" style={{ padding: '16px 18px', background: bg, border: `1px solid ${color}22` }}>
      <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 30, lineHeight: 1.05, color }}>
        {value}
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color, marginTop: 4, opacity: 0.85 }}>
        {label}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ════════════════════════════════════════════════════════════════════════════ */
const IntegrationsPage = () => {
  const [connectors, setConnectors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyType, setBusyType] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    api.get('/api/integrations')
      .then((r) => setConnectors(Array.isArray(r.data) ? r.data : []))
      .catch(() => { setError(true); toast.error('Failed to load integrations'); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const patchConnector = (type, patch) =>
    setConnectors((list) => list.map((c) => (c.type === type ? { ...c, ...patch } : c)));

  const handleConnect = async (type, payload) => {
    setBusyType(type);
    try {
      const r = await api.post(`/api/integrations/${type}/connect`, payload || {});
      const updated = r.data && r.data.type ? r.data : null;
      patchConnector(type, updated || {
        status: 'connected',
        hasKey: !!(payload && payload.apiKey),
        account: (payload && payload.account) || null,
      });
      toast.success(`${connectors.find((c) => c.type === type)?.name || type} connected`);
      return true;
    } catch {
      toast.error('Could not connect — check the details and try again');
      return false;
    } finally {
      setBusyType(null);
    }
  };

  const handleDisconnect = async (type) => {
    setBusyType(type);
    try {
      await api.post(`/api/integrations/${type}/disconnect`, {});
      patchConnector(type, { status: 'disconnected', hasKey: false, account: null });
      toast.success(`${connectors.find((c) => c.type === type)?.name || type} disconnected`);
    } catch {
      toast.error('Could not disconnect — please try again');
    } finally {
      setBusyType(null);
    }
  };

  const total = connectors.length;
  const connectedCount = connectors.filter((c) => c.status === 'connected').length;

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="integrations-page">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight" style={{ color: 'var(--text-heading, #0F172A)' }}>
              Integrations
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-muted, #64748B)' }}>
              Connect the tools your team already uses — sync data, trigger automations, and keep everything in one place.
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2"
            style={{
              background: '#fff', color: '#475569', border: '1px solid #E2E8F0', borderRadius: 10,
              padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} style={{ width: 14, height: 14 }} />
            Refresh
          </button>
        </div>

        {/* Stat strip */}
        {!loading && !error && total > 0 && (
          <div
            style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 14, marginBottom: 24,
            }}
          >
            <StatCard label="Available" value={total.toLocaleString('en-IN')} color="#0748EE" bg="#E8EFFE" />
            <StatCard label="Connected" value={connectedCount.toLocaleString('en-IN')} color="#059669" bg="#ECFDF5" />
            <StatCard label="Not Connected" value={(total - connectedCount).toLocaleString('en-IN')} color="#D97706" bg="#FFFBEB" />
          </div>
        )}

        {/* States */}
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 18 }}>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="glass-card animate-pulse" style={{ height: 220, background: '#F1F5F9', border: '1px solid #E2E8F0' }} />
            ))}
          </div>
        ) : error ? (
          <div className="glass-card" style={{ padding: 48, textAlign: 'center' }}>
            <Plug style={{ width: 32, height: 32, color: '#94A3B8', margin: '0 auto 12px' }} />
            <p style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>Couldn't load integrations</p>
            <p style={{ fontSize: 13, color: '#64748B', marginTop: 4 }}>The integrations service may be unavailable. Try refreshing.</p>
            <button
              onClick={load}
              style={{
                marginTop: 16, background: '#0748EE', color: '#fff', border: 'none', borderRadius: 10,
                padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        ) : total === 0 ? (
          <div className="glass-card" style={{ padding: 48, textAlign: 'center' }}>
            <Plug style={{ width: 32, height: 32, color: '#94A3B8', margin: '0 auto 12px' }} />
            <p style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>No integrations available yet</p>
            <p style={{ fontSize: 13, color: '#64748B', marginTop: 4 }}>Connectors will appear here once configured.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 18 }}>
            {connectors.map((c) => (
              <ConnectorCard
                key={c.type}
                connector={c}
                busy={busyType === c.type}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
              />
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default IntegrationsPage;

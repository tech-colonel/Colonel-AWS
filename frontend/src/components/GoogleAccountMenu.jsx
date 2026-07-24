import React from 'react';
import { Check, X, Plus } from 'lucide-react';
import { useGoogleAccounts, connect, disconnect } from '../lib/googleAccount';

const ACCENT = '#0748EE';

// Inline fallback "G" mark used when the backend doesn't hand us a logo URL.
function GoogleGlyph({ size = 18 }) {
  return (
    <span
      aria-hidden
      style={{
        width: size, height: size, borderRadius: 4, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: '#fff', border: '1px solid var(--card-border)',
        color: '#4285F4', fontWeight: 800, fontFamily: 'Manrope, sans-serif',
        fontSize: Math.round(size * 0.72), lineHeight: 1,
      }}
    >
      G
    </span>
  );
}

function GoogleLogo({ logo, size = 18 }) {
  if (logo) {
    return (
      <img
        src={logo}
        alt="Google"
        referrerPolicy="no-referrer"
        style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0 }}
        onError={(e) => { e.currentTarget.style.display = 'none'; }}
      />
    );
  }
  return <GoogleGlyph size={size} />;
}

// One selectable account row (central or personal).
function AccountRow({ logo, email, tag, active, onSelect, onDisconnect }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className="w-full flex items-center gap-2 rounded-lg px-2 py-2 transition-colors"
      style={{ background: active ? '#EFF6FF' : 'transparent', cursor: 'pointer' }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#F8FAFC'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <GoogleLogo logo={logo} size={18} />
      <span
        style={{
          flex: 1, minWidth: 0, textAlign: 'left', fontSize: 13,
          fontWeight: active ? 700 : 500,
          color: active ? ACCENT : 'var(--text-heading)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {email || 'Personal account'}
      </span>
      {tag && (
        <span
          style={{
            fontSize: 10, fontWeight: 700, color: ACCENT, background: '#EFF6FF',
            padding: '1px 7px', borderRadius: 9999, textTransform: 'uppercase',
            letterSpacing: '0.04em', flexShrink: 0,
          }}
        >
          {tag}
        </span>
      )}
      {active && <Check style={{ width: 14, height: 14, color: ACCENT, flexShrink: 0 }} />}
      {onDisconnect && (
        <button
          type="button"
          title="Disconnect"
          onClick={(e) => { e.stopPropagation(); onDisconnect(); }}
          className="rounded-md transition-colors"
          style={{ display: 'inline-flex', padding: 2, color: '#94A3B8', flexShrink: 0 }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#E11D48'; e.currentTarget.style.background = '#FEF2F2'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#94A3B8'; e.currentTarget.style.background = 'transparent'; }}
        >
          <X style={{ width: 13, height: 13 }} />
        </button>
      )}
    </div>
  );
}

// Renders inside the existing profile popover. `user` gates the admin-only
// central-connect button.
export default function GoogleAccountMenu({ user }) {
  const { accounts, loading, activeId, setActive, refresh } = useGoogleAccounts();
  const [busy, setBusy] = React.useState(false);

  const isAdmin = user?.role === 'admin';
  // Accountants own the central-account / Composio features (per project setup),
  // so they can connect the firm's team@ account too — not just admins.
  const canManageCentral = user?.role === 'admin' || user?.role === 'accountant';
  const central = accounts?.central || null;
  const personal = Array.isArray(accounts?.personal) ? accounts.personal : [];
  const logo = accounts?.logo || null;
  const centralConnected = !!central && central.status !== 'disconnected';

  const doConnect = async (kind) => {
    setBusy(true);
    try {
      await connect(kind); // navigates away on success
    } catch {
      setBusy(false);
    }
  };

  const doDisconnect = async (id, kind) => {
    setBusy(true);
    try {
      await disconnect(id, kind);
      await refresh();
    } catch {
      /* ignore — leave state */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: '8px 8px', borderBottom: '1px solid var(--card-border)' }}>
      <div
        style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.05em', color: '#94A3B8', padding: '4px 8px',
        }}
      >
        Google account
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 8px' }}>Loading…</div>
      ) : (
        <>
          {/* Central / work account */}
          {centralConnected ? (
            <AccountRow
              logo={logo}
              email={central.email || 'team@colonel.co.in'}
              tag="Work"
              active={activeId === 'central'}
              onSelect={() => setActive('central')}
            />
          ) : (
            canManageCentral && (
              <button
                type="button"
                disabled={busy}
                onClick={() => doConnect('central')}
                className="w-full flex items-center gap-2 rounded-lg px-2 py-2 transition-colors"
                style={{ background: 'transparent', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
                onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = '#F8FAFC'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <GoogleLogo logo={logo} size={18} />
                <span style={{ flex: 1, textAlign: 'left', fontSize: 13, fontWeight: 600, color: 'var(--text-heading)' }}>
                  Connect team@colonel.co.in
                </span>
                <Plus style={{ width: 14, height: 14, color: '#94A3B8', flexShrink: 0 }} />
              </button>
            )
          )}

          {/* Personal accounts */}
          {personal.map((p) => (
            <AccountRow
              key={p.id}
              logo={logo}
              email={p.email}
              active={activeId === p.id}
              onSelect={() => setActive(p.id)}
              onDisconnect={() => doDisconnect(p.id, 'personal')}
            />
          ))}

          {!centralConnected && !isAdmin && personal.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 8px 6px' }}>
              No Google account connected yet.
            </div>
          )}

          {/* Sign in with work mail (personal connect) */}
          <button
            type="button"
            disabled={busy}
            onClick={() => doConnect('personal')}
            className="w-full flex items-center justify-center gap-2 rounded-lg px-3 py-2 transition-opacity"
            style={{
              marginTop: 6, background: ACCENT, color: '#fff',
              fontSize: 13, fontWeight: 700, border: 'none',
              cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            <span
              style={{
                width: 18, height: 18, borderRadius: 4, background: '#fff',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}
            >
              <GoogleLogo logo={logo} size={14} />
            </span>
            Sign in with your work mail
          </button>
        </>
      )}
    </div>
  );
}

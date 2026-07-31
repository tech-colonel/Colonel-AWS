import React from 'react';
import { useAuth } from '../../context/AuthContext';
import { useNavigate, useLocation } from 'react-router-dom';
import { LogOut, Menu, X, ChevronsUpDown, Building2, Check, UserCog } from 'lucide-react';
import api from '../../lib/api';
import GoogleAccountMenu from '../GoogleAccountMenu';

const initialsOf = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || 'U';

// Avatar: real Google picture when present (filled in once Google OAuth is
// connected), otherwise a gradient initials badge.
function Avatar({ user, size = 38 }) {
  const radius = Math.round(size * 0.29);
  if (user?.picture) {
    return <img src={user.picture} alt={user?.name || 'User'} referrerPolicy="no-referrer"
      style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover', flexShrink: 0 }} />;
  }
  return (
    <span style={{
      width: size, height: size, borderRadius: radius, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #0748EE 0%, #7C3AED 100%)',
      color: '#fff', fontWeight: 700, fontSize: Math.round(size * 0.37), fontFamily: 'Manrope, sans-serif',
    }}>
      {initialsOf(user?.name)}
    </span>
  );
}

const Sidebar = ({ items, isOpen, setIsOpen }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [brands, setBrands] = React.useState([]);
  const [googlePic, setGooglePic] = React.useState(null);
  const menuRef = React.useRef(null);

  const handleLogout = () => { logout(); navigate('/login'); };

  // The accountant's assigned brands act as their "teams" in the switcher.
  // Also pull the connected Google profile picture (if any) for the avatar.
  React.useEffect(() => {
    let on = true;
    api.get('/api/brands/my-brands').then((r) => { if (on) setBrands(Array.isArray(r.data) ? r.data : []); }).catch(() => {});
    api.get('/api/integrations').then((r) => {
      const g = (Array.isArray(r.data) ? r.data : []).find((x) => x.type === 'google');
      if (on && g && g.status === 'connected' && g.picture) setGooglePic(g.picture);
    }).catch(() => {});
    return () => { on = false; };
  }, []);

  // Effective user for the avatar: prefer the user's own picture, else the
  // connected Google profile picture.
  const avatarUser = { ...(user || {}), picture: user?.picture || googlePic };

  // After a Google OAuth round-trip the backend redirects back with
  // ?google_connected=… — surface it briefly, then strip the param so a
  // refresh doesn't re-trigger it. Non-breaking; no-op when absent.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.has('google_connected')) {
      try { console.info('Google account connected'); } catch { /* noop */ }
      params.delete('google_connected');
      const qs = params.toString();
      const newUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
      window.history.replaceState({}, '', newUrl);
    }
  }, []);

  // Close the popover on outside click.
  React.useEffect(() => {
    const fn = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    if (menuOpen) document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, [menuOpen]);

  // Let other pages (e.g. the dashboard "connect your Google account" nudge) open this
  // profile popover so the user can connect from here.
  React.useEffect(() => {
    const open = () => setMenuOpen(true);
    window.addEventListener('colonel:open-profile', open);
    return () => window.removeEventListener('colonel:open-profile', open);
  }, []);

  const activeBrandId = (location.pathname.match(/\/brands\/([^/]+)/) || [])[1];

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/30 z-40 lg:hidden transition-opacity ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setIsOpen(false)}
      />

      <aside
        className={`fixed lg:sticky top-0 left-0 z-50 h-screen w-64 transition-transform lg:translate-x-0 ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
        data-testid="sidebar"
        style={{ background: 'var(--surface)', borderRight: '1px solid var(--card-border)' }}
      >
        <div className="flex flex-col h-full">
          {/* Brand wordmark + user chip (opens profile popover) */}
          <div className="px-5 pt-5 pb-4" style={{ borderBottom: '1px solid var(--card-border)', position: 'relative' }} ref={menuRef}>
            <div className="flex items-center justify-between mb-4">
              <span style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 20, color: 'var(--text-heading)', letterSpacing: '-0.01em' }}>
                Colonel
              </span>
              <button onClick={() => setIsOpen(false)} className="lg:hidden" style={{ color: '#94A3B8' }}>
                <X className="h-5 w-5" />
              </button>
            </div>

            <button
              onClick={() => setMenuOpen((v) => !v)}
              data-testid="account-chip"
              className="w-full flex items-center gap-3 rounded-xl p-2 -mx-2 transition-colors"
              style={{ background: menuOpen ? '#F1F5F9' : 'transparent', cursor: 'pointer' }}
              onMouseEnter={(e) => { if (!menuOpen) e.currentTarget.style.background = '#F8FAFC'; }}
              onMouseLeave={(e) => { if (!menuOpen) e.currentTarget.style.background = 'transparent'; }}
            >
              <Avatar user={avatarUser} size={38} />
              <div style={{ minWidth: 0, textAlign: 'left', flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name || 'User'}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{user?.role?.replace('_', ' ') || ''}</div>
                {user?.email && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div>
                )}
              </div>
              <ChevronsUpDown style={{ width: 15, height: 15, color: '#94A3B8', flexShrink: 0 }} />
            </button>

            {/* Profile popover */}
            {menuOpen && (
              <div className="glass-card" style={{ position: 'absolute', left: 16, right: 16, top: '100%', marginTop: 6, zIndex: 60, padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--card-border)', textAlign: 'center' }}>
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}><Avatar user={avatarUser} size={52} /></div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-heading)' }}>{user?.name || 'User'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{user?.email || ''}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#0748EE', background: '#EFF6FF', display: 'inline-block', padding: '2px 10px', borderRadius: 9999, marginTop: 6, textTransform: 'capitalize' }}>{user?.role?.replace('_', ' ') || 'member'}</div>
                </div>

                <GoogleAccountMenu user={user} />

                {brands.length > 0 && (
                  <div style={{ padding: '8px 8px', borderBottom: '1px solid var(--card-border)', maxHeight: 200, overflowY: 'auto' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94A3B8', padding: '4px 8px' }}>Your brands</div>
                    {brands.map((b) => {
                      const on = b.id === activeBrandId;
                      return (
                        <button key={b.id} onClick={() => { setMenuOpen(false); navigate(`/brands/${b.id}/dashboard`); }}
                          className="w-full flex items-center gap-2 rounded-lg px-2 py-2 transition-colors"
                          style={{ background: on ? '#EFF6FF' : 'transparent' }}
                          onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = '#F8FAFC'; }}
                          onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
                          <Building2 style={{ width: 15, height: 15, color: on ? '#0748EE' : '#94A3B8' }} />
                          <span style={{ flex: 1, textAlign: 'left', fontSize: 13, fontWeight: on ? 700 : 500, color: on ? '#0748EE' : 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
                          {on && <Check style={{ width: 14, height: 14, color: '#0748EE' }} />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {user?.role === 'admin' && (
                  <button onClick={() => { setMenuOpen(false); navigate('/admin'); }}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-colors"
                    style={{ color: '#475569' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFC'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                    <UserCog style={{ width: 16, height: 16 }} /> Admin panel
                  </button>
                )}
                <button onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-colors"
                  style={{ color: '#64748B' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#FEF2F2'; e.currentTarget.style.color = '#E11D48'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748B'; }}>
                  <LogOut style={{ width: 16, height: 16 }} /> Log Out
                </button>
              </div>
            )}
          </div>

          {/* Nav */}
          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" data-testid="sidebar-nav">
            {items.map((item, idx) => {
              const active = location.pathname === item.path;
              return (
                <button
                  // Key by unique testId (falls back to path+index). Brand-scoped
                  // items (Dashboard/Agents/Tracker) all resolve to /brands when no
                  // brand is selected yet, so keying by path collided → React
                  // "duplicate key" warning on global pages (Tasks/Plans).
                  key={item.testId || `${item.path}-${idx}`}
                  onClick={() => { navigate(item.path); setIsOpen(false); }}
                  data-testid={item.testId}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                  style={{ background: active ? '#EFF6FF' : 'transparent', color: active ? '#0748EE' : '#475569' }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#F1F5F9'; }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                >
                  <item.icon className="h-5 w-5" style={{ color: active ? '#0748EE' : '#94A3B8' }} />
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Logout */}
          <div className="px-3 py-4" style={{ borderTop: '1px solid var(--card-border)' }}>
            <button
              onClick={handleLogout}
              data-testid="logout-button"
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors"
              style={{ color: '#64748B' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#FEF2F2'; e.currentTarget.style.color = '#E11D48'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748B'; }}
            >
              <LogOut className="h-5 w-5" />
              Logout
            </button>
          </div>
        </div>
      </aside>
    </>
  );
};

const DashboardLayout = ({ children, sidebarItems }) => {
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(false);

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--page-bg)' }}>
      <Sidebar items={sidebarItems} isOpen={isSidebarOpen} setIsOpen={setIsSidebarOpen} />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 px-4 py-3 lg:hidden" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--card-border)' }}>
          <button onClick={() => setIsSidebarOpen(true)} style={{ color: '#475569' }} data-testid="menu-button">
            <Menu className="h-6 w-6" />
          </button>
        </header>

        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
};

export default DashboardLayout;

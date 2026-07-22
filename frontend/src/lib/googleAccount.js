// Small client helper for the Google-account section of the profile menu.
// Talks to the already-built backend under /api/google/*. All additive —
// nothing here changes agent/reco behavior.
import { useCallback, useEffect, useState } from 'react';
import api from './api';

const ACTIVE_KEY = 'colonel.activeGoogleAccount'; // 'central' | <personal account id>

// ---- raw API calls -------------------------------------------------------

export async function fetchAccounts() {
  // { configured, central|null, personal:[], logo }
  const { data } = await api.get('/api/google/accounts');
  return data || {};
}

export async function fetchStatus() {
  // { configured, central:{connected,email}, driveOk, mailOk, serviceAccountEmail }
  const { data } = await api.get('/api/google/status');
  return data || {};
}

// Kick off an OAuth connect. On success the browser navigates to the
// provider's redirectUrl (full-page redirect — this never returns).
export async function connect(kind, slug) {
  const body = { kind };
  if (slug) body.slug = slug;
  const { data } = await api.post('/api/google/connect', body);
  if (data && data.redirectUrl) {
    window.location.href = data.redirectUrl;
  }
  return data;
}

export async function disconnect(id, kind) {
  const { data } = await api.post(
    `/api/google/accounts/${encodeURIComponent(id)}/disconnect?kind=${encodeURIComponent(kind || '')}`
  );
  return data;
}

// ---- active-account (localStorage) --------------------------------------

export function getActiveId() {
  try {
    return localStorage.getItem(ACTIVE_KEY) || 'central';
  } catch {
    return 'central';
  }
}

export function setActiveId(id) {
  try {
    localStorage.setItem(ACTIVE_KEY, id || 'central');
  } catch {
    /* ignore storage errors */
  }
}

// ---- React hook ----------------------------------------------------------

// Returns { accounts:{central,personal,logo}, status, loading, activeId, setActive, refresh }.
// Degrades gracefully when Google is not configured / not connected: never
// throws, just returns empty structures.
export function useGoogleAccounts() {
  const [accounts, setAccounts] = useState({ configured: false, central: null, personal: [], logo: null });
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveIdState] = useState(getActiveId());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [acc, st] = await Promise.all([
        fetchAccounts().catch(() => ({})),
        fetchStatus().catch(() => null),
      ]);
      setAccounts({
        configured: !!acc.configured,
        central: acc.central || null,
        personal: Array.isArray(acc.personal) ? acc.personal : [],
        logo: acc.logo || null,
      });
      setStatus(st || null);
    } catch {
      // Leave prior state; never crash the menu.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let on = true;
    (async () => {
      await refresh();
      if (!on) return;
    })();
    return () => { on = false; };
  }, [refresh]);

  const setActive = useCallback((id) => {
    const val = id || 'central';
    setActiveId(val);
    setActiveIdState(val);
  }, []);

  return { accounts, status, loading, activeId, setActive, refresh };
}

export default {
  fetchAccounts,
  fetchStatus,
  connect,
  disconnect,
  getActiveId,
  setActiveId,
  useGoogleAccounts,
};

import React, { useState, useEffect, useCallback, useRef } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { MessageCircle, Send, Loader2, Building2 } from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';
import { sidebarFor } from '../../lib/adminNav';

/* Admin inbox for the accountant "Chat with admin" threads (one per brand+accountant). */
export default function AdminChats() {
  const [threads, setThreads] = useState(null);
  const [active, setActive] = useState(null);        // { brand_id, thread_user_id, brand_name, user_name }
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);

  const loadThreads = useCallback(() => {
    api.get('/api/admin-chat/threads').then(r => setThreads(r.data || [])).catch(() => setThreads([]));
  }, []);
  useEffect(() => { loadThreads(); const t = setInterval(loadThreads, 10000); return () => clearInterval(t); }, [loadThreads]);

  const loadMsgs = useCallback(() => {
    if (!active) return;
    api.get(`/api/brands/${active.brand_id}/admin-chat`, { params: { userId: active.thread_user_id } })
      .then(r => setMsgs(r.data || [])).catch(() => setMsgs([]));
  }, [active]);
  useEffect(() => { loadMsgs(); if (!active) return; const t = setInterval(loadMsgs, 8000); return () => clearInterval(t); }, [loadMsgs, active]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  const send = async () => {
    const m = text.trim(); if (!m || !active || sending) return;
    setSending(true); setText('');
    try {
      await api.post(`/api/brands/${active.brand_id}/admin-chat`, { userId: active.thread_user_id, message: m });
      loadMsgs(); loadThreads();
    } catch { toast.error('Could not send'); setText(m); }
    finally { setSending(false); }
  };

  const fmt = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  const initials = (n) => (n || '?').split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase();

  return (
    <DashboardLayout sidebarItems={sidebarFor()}>
      <div style={{ padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div style={{ width: 44, height: 44, borderRadius: 13, background: '#0748EE15', border: '1px solid #0748EE30', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <MessageCircle style={{ width: 21, height: 21, color: '#0748EE' }} />
          </div>
          <div>
            <h1 style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 22, color: 'var(--text-heading)', lineHeight: 1.1 }}>Chats</h1>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Accountant conversations, one thread per brand</div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16, height: 'calc(100vh - 190px)' }}>
          {/* thread list */}
          <div className="glass-card" style={{ padding: 8, overflowY: 'auto' }}>
            {threads === null ? (
              <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 30 }}><Loader2 className="animate-spin" style={{ width: 22, height: 22, color: '#0748EE' }} /></div>
            ) : threads.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>No conversations yet.</div>
            ) : threads.map(t => {
              const on = active && active.brand_id === t.brand_id && active.thread_user_id === t.thread_user_id;
              return (
                <button key={`${t.brand_id}-${t.thread_user_id}`} onClick={() => setActive(t)} style={{
                  width: '100%', textAlign: 'left', display: 'flex', gap: 10, alignItems: 'center', padding: '11px 12px',
                  borderRadius: 12, border: 'none', cursor: 'pointer', marginBottom: 4,
                  background: on ? '#0748EE12' : 'transparent',
                }}>
                  <div style={{ width: 38, height: 38, borderRadius: 999, background: '#0748EE', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                    {initials(t.user_name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)' }}>{t.user_name}</span>
                      {Number(t.unread) > 0 && (
                        <span style={{ fontSize: 10, fontWeight: 800, background: '#E11D48', color: '#fff', borderRadius: 999, padding: '1px 6px', marginLeft: 'auto' }}>{t.unread}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: '#0748EE', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <Building2 style={{ width: 11, height: 11 }} /> {t.brand_name}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.last_message}</div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* conversation */}
          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {!active ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                <MessageCircle style={{ width: 30, height: 30, marginBottom: 10, opacity: 0.5 }} />
                <span style={{ fontSize: 13 }}>Select a conversation</span>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--card-border)' }}>
                  <div style={{ width: 34, height: 34, borderRadius: 999, background: '#0748EE', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12 }}>{initials(active.user_name)}</div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-heading)' }}>{active.user_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{active.brand_name}</div>
                  </div>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--page-bg)' }}>
                  {msgs.map(m => {
                    const mine = m.sender_role === 'admin';
                    return (
                      <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '72%' }}>
                        <div style={{
                          padding: '9px 13px', borderRadius: 14,
                          borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4,
                          background: mine ? '#0748EE' : 'var(--surface)', color: mine ? '#fff' : 'var(--text-heading)',
                          border: mine ? 'none' : '1px solid var(--card-border)', fontSize: 13, lineHeight: 1.4,
                        }}>{m.message}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, textAlign: mine ? 'right' : 'left' }}>
                          {mine ? 'You' : (m.sender_name || active.user_name)} · {fmt(m.created_at)}
                        </div>
                      </div>
                    );
                  })}
                  <div ref={endRef} />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--card-border)' }}>
                  <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
                    placeholder="Reply…"
                    style={{ flex: 1, padding: '10px 16px', border: '1px solid var(--card-border)', borderRadius: 999, background: 'var(--page-bg)', color: 'var(--text-heading)', fontSize: 13, outline: 'none' }} />
                  <button onClick={send} disabled={sending} style={{ width: 40, height: 40, borderRadius: 999, border: 'none', background: '#0748EE', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                    {sending ? <Loader2 className="animate-spin" style={{ width: 16, height: 16 }} /> : <Send style={{ width: 16, height: 16 }} />}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

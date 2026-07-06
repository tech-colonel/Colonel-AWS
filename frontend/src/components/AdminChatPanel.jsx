import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MessageCircle, Send, Loader2, X } from 'lucide-react';
import api from '../lib/api';
import { toast } from 'sonner';

/* Chat-with-admin slide-over (accountant side). Reuses the per-brand thread
   backend at /api/brands/:brandId/admin-chat — shared by Tracker + Statutory. */
export default function AdminChatPanel({ brandId, brandName, onClose }) {
  const [msgs, setMsgs] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);

  const load = useCallback(() => {
    api.get(`/api/brands/${brandId}/admin-chat`).then(r => setMsgs(r.data || [])).catch(() => setMsgs([]));
  }, [brandId]);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  const send = async () => {
    const m = text.trim(); if (!m || sending) return;
    setSending(true); setText('');
    try { await api.post(`/api/brands/${brandId}/admin-chat`, { message: m }); load(); }
    catch { toast.error('Could not send'); setText(m); }
    finally { setSending(false); }
  };
  const fmt = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid var(--card-border)', flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: '#0748EE15', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <MessageCircle style={{ width: 17, height: 17, color: '#0748EE' }} />
          </div>
          <div>
            <div style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)' }}>Chat with Admin</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{brandName} · Colonel admin team</div>
          </div>
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'var(--page-bg)', cursor: 'pointer', width: 30, height: 30, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <X style={{ width: 16, height: 16, color: 'var(--text-muted)' }} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--page-bg)' }}>
          {msgs === null ? (
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 30 }}><Loader2 className="animate-spin" style={{ width: 22, height: 22, color: '#0748EE' }} /></div>
          ) : msgs.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, paddingTop: 40 }}>
              <MessageCircle style={{ width: 28, height: 28, margin: '0 auto 10px', opacity: 0.5 }} />
              No messages yet. Start a conversation with the admin team.
            </div>
          ) : msgs.map(m => {
            const mine = m.sender_role === 'accountant';
            return (
              <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
                <div style={{ padding: '9px 13px', borderRadius: 14, borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4, background: mine ? '#0748EE' : 'var(--surface)', color: mine ? '#fff' : 'var(--text-heading)', border: mine ? 'none' : '1px solid var(--card-border)', fontSize: 13, lineHeight: 1.4 }}>{m.message}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, textAlign: mine ? 'right' : 'left' }}>{mine ? 'You' : (m.sender_name || 'Admin')} · {fmt(m.created_at)}</div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--card-border)', flexShrink: 0 }}>
          <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="Type a message…"
            style={{ flex: 1, padding: '10px 16px', border: '1px solid var(--card-border)', borderRadius: 999, background: 'var(--page-bg)', color: 'var(--text-heading)', fontSize: 13, outline: 'none' }} />
          <button onClick={send} disabled={sending} style={{ width: 40, height: 40, borderRadius: 999, border: 'none', background: '#0748EE', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            {sending ? <Loader2 className="animate-spin" style={{ width: 16, height: 16 }} /> : <Send style={{ width: 16, height: 16 }} />}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(10,15,46,0.35)', zIndex: 60, display: 'flex', justifyContent: 'flex-end' };
const panel = { width: 'min(420px, 100%)', height: '100%', background: 'var(--surface)', display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 40px rgba(10,15,46,0.15)' };

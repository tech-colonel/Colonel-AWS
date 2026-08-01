import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { Sparkles, Send, X, MessageSquarePlus, Loader2, History, ChevronLeft } from 'lucide-react';
import { toast } from 'sonner';
import api, { API_URL } from '../lib/api';
import { useAuth } from '../context/AuthContext';

/* ── Ask Colonel AI ──────────────────────────────────────────────────────────
   Floating "✨ Ask Colonel AI" button + slide-over panel, mounted app-wide so
   it appears on every authenticated screen. Sends the current screen context to
   POST /api/ai/ask (SSE), reuses the existing per-user /api/conversations store
   for history (same chats as the /chat page), and shows screen-aware suggested
   prompts from GET /api/ai/suggestions. Hidden on public Landing/Login.

   Additive: this touches no agent/reco logic. Data/run-agent buckets are
   backend-deferred; the widget just streams the answer.                        */

const MODEL = 'claude-haiku-4-5';

// Public routes where the assistant must not render.
const PUBLIC_ROUTES = new Set(['/', '/login', '/unauthorized']);

/* Derive screen context from the URL so the assistant knows the agent/brand. */
function deriveScreen(pathname) {
  const screen = { route: pathname };
  let m = pathname.match(/^\/brands\/([^/]+)\/reco\/([^/]+?)(\/results\/[^/]+)?$/);
  if (m) {
    screen.brandId = m[1];
    screen.agentType = m[2];
    if (m[3]) screen.hasResult = true;
    return screen;
  }
  m = pathname.match(/^\/brands\/([^/]+)\/pdf-bank/);
  if (m) { screen.brandId = m[1]; screen.agentType = 'pdf_bank_extract'; return screen; }
  m = pathname.match(/^\/brands\/([^/]+)\/receivables/);
  if (m) { screen.brandId = m[1]; screen.agentType = 'receivable_cycle'; return screen; }
  return screen; // global scope (Colonel AI page / any other screen)
}

export default function AskColonelAI() {
  const location = useLocation();
  const { user } = useAuth();

  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [convos, setConvos] = useState([]);
  const [convoId, setConvoId] = useState(null);
  const scrollRef = useRef(null);

  const loadConvos = useCallback(async () => {
    try { const { data } = await api.get('/api/conversations'); setConvos(data || []); }
    catch (_) { /* non-fatal */ }
  }, []);

  // On open (and on route change while open) refresh suggestions + history.
  useEffect(() => {
    if (!open) return;
    const s = deriveScreen(location.pathname);
    api.get('/api/ai/suggestions', {
      params: { route: s.route, agentType: s.agentType || '', hasResult: s.hasResult ? 'true' : '' },
    }).then(({ data }) => setSuggestions(data?.suggestions || [])).catch(() => setSuggestions([]));
    loadConvos();
  }, [open, location.pathname, loadConvos]);

  // Keep the thread scrolled to the newest message.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streamText, open]);

  // Open ALWAYS starts a fresh chat (so users don't pile onto one thread).
  const startNewChat = () => {
    setMessages([]); setConvoId(null); setInput(''); setStreamText(''); setShowHistory(false);
  };
  const openPanel = () => { startNewChat(); setOpen(true); };

  const resumeChat = async (id) => {
    try {
      const { data } = await api.get(`/api/conversations/${id}`);
      setMessages(Array.isArray(data?.messages) ? data.messages : []);
      setConvoId(id);
      setShowHistory(false);
    } catch (_) { toast.error('Could not open that chat'); }
  };

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || streaming) return;
    const nextMsgs = [...messages, { role: 'user', content }];
    setMessages(nextMsgs);
    setInput('');
    setStreaming(true);
    setStreamText('');

    // Persist the user turn (create or update the caller's own conversation).
    let cid = convoId;
    try {
      if (!cid) {
        const { data } = await api.post('/api/conversations', { messages: nextMsgs, model: MODEL });
        cid = data.id; setConvoId(cid);
      } else {
        await api.patch(`/api/conversations/${cid}`, { messages: nextMsgs });
      }
    } catch (_) { /* history is best-effort; continue with the answer */ }

    let acc = '';
    try {
      const resp = await fetch(`${API_URL}/api/ai/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
          'ngrok-skip-browser-warning': 'true',
        },
        body: JSON.stringify({ conversationId: cid, messages: nextMsgs, screen: deriveScreen(location.pathname) }),
      });
      if (!resp.ok || !resp.body) {
        const m = await resp.json().catch(() => ({}));
        throw new Error(m.error || `Colonel AI failed (${resp.status})`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop() || '';
        for (const block of blocks) {
          const ev = /event:\s*(.+)/.exec(block)?.[1]?.trim();
          const dl = /data:\s*([\s\S]+)/.exec(block)?.[1]?.trim();
          if (!ev || !dl) continue;
          let p = {};
          try { p = JSON.parse(dl); } catch { continue; }
          if (ev === 'delta') { acc += p.text || ''; setStreamText(acc); }
          else if (ev === 'error') { throw new Error(p.error || 'Colonel AI failed'); }
          else if (ev === 'done') { acc = p.text || acc; }
        }
      }
    } catch (err) {
      toast.error(err.message || 'Colonel AI failed');
    } finally {
      setStreaming(false);
      setStreamText('');
      if (acc) {
        setMessages((prev) => [...prev, { role: 'assistant', content: acc }]);
        loadConvos(); // backend persisted the assistant turn; refresh titles
      }
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // Never render on public screens or when signed out.
  if (!user || PUBLIC_ROUTES.has(location.pathname)) return null;

  return (
    <>
      <style>{CSS}</style>

      {!open && (
        <button className="cai-fab" onClick={openPanel} aria-label="Ask Colonel AI">
          <Sparkles size={18} />
          <span>Ask Colonel AI</span>
        </button>
      )}

      {open && (
        <div className="cai-panel" role="dialog" aria-label="Colonel AI assistant">
          <div className="cai-head">
            <div className="cai-title"><Sparkles size={16} /> Colonel AI</div>
            <div className="cai-head-actions">
              <button className="cai-icon" title="Previous chats" onClick={() => setShowHistory((v) => !v)}>
                <History size={16} />
              </button>
              <button className="cai-icon" title="New chat" onClick={startNewChat}>
                <MessageSquarePlus size={16} />
              </button>
              <button className="cai-icon" title="Close" onClick={() => setOpen(false)}>
                <X size={16} />
              </button>
            </div>
          </div>

          {showHistory ? (
            <div className="cai-history">
              <button className="cai-back" onClick={() => setShowHistory(false)}><ChevronLeft size={14} /> Back</button>
              {convos.length === 0 && <p className="cai-empty">No previous chats yet.</p>}
              {convos.map((c) => (
                <button key={c.id} className="cai-histrow" onClick={() => resumeChat(c.id)}>
                  {c.title || 'Chat'}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="cai-body" ref={scrollRef}>
                {messages.length === 0 && !streaming && (
                  <div className="cai-welcome">
                    <p>Hi{user?.name ? `, ${user.name.split(' ')[0]}` : ''}! Ask me about this screen, your reconciliation data, or Indian GST/TDS.</p>
                    {suggestions.length > 0 && (
                      <div className="cai-chips">
                        {suggestions.map((s, i) => (
                          <button key={i} className="cai-chip" onClick={() => send(s)}>{s}</button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`cai-msg cai-${m.role}`}>
                    <div className="cai-bubble">{m.content}</div>
                  </div>
                ))}
                {streaming && (
                  <div className="cai-msg cai-assistant">
                    <div className="cai-bubble">
                      {streamText || <Loader2 className="cai-spin" size={14} />}
                    </div>
                  </div>
                )}
              </div>

              <div className="cai-input">
                <textarea
                  rows={1}
                  placeholder="Ask Colonel AI…"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKey}
                  disabled={streaming}
                />
                <button className="cai-send" onClick={() => send()} disabled={streaming || !input.trim()}>
                  {streaming ? <Loader2 className="cai-spin" size={16} /> : <Send size={16} />}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

/* Scoped styles — all colors via the app's theme CSS variables (light/dark). */
const CSS = `
.cai-fab{position:fixed;right:20px;bottom:20px;z-index:1200;display:flex;align-items:center;gap:8px;
  padding:10px 16px;border:none;border-radius:999px;cursor:pointer;font-size:14px;font-weight:600;
  background:var(--primary);color:var(--primary-foreground);box-shadow:0 6px 20px rgba(0,0,0,.18);}
.cai-fab:hover{filter:brightness(1.05);}
.cai-panel{position:fixed;right:20px;bottom:20px;z-index:1200;display:flex;flex-direction:column;
  width:380px;max-width:calc(100vw - 40px);height:560px;max-height:calc(100vh - 40px);
  background:var(--card,var(--background));color:var(--foreground);border:1px solid var(--border);
  border-radius:var(--radius,12px);box-shadow:0 12px 40px rgba(0,0,0,.28);overflow:hidden;}
.cai-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;
  border-bottom:1px solid var(--border);background:var(--surface,var(--card));}
.cai-title{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;}
.cai-head-actions{display:flex;gap:4px;}
.cai-icon{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;
  border:none;background:transparent;color:var(--muted-foreground,var(--foreground));border-radius:8px;cursor:pointer;}
.cai-icon:hover{background:var(--muted);color:var(--foreground);}
.cai-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}
.cai-welcome{color:var(--muted-foreground);font-size:14px;line-height:1.5;}
.cai-chips{display:flex;flex-direction:column;gap:8px;margin-top:12px;}
.cai-chip{text-align:left;padding:9px 12px;border:1px solid var(--border);background:var(--surface,var(--card));
  color:var(--foreground);border-radius:10px;cursor:pointer;font-size:13px;}
.cai-chip:hover{border-color:var(--primary);}
.cai-msg{display:flex;}
.cai-user{justify-content:flex-end;}
.cai-assistant{justify-content:flex-start;}
.cai-bubble{max-width:88%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.5;
  white-space:pre-wrap;word-wrap:break-word;}
.cai-user .cai-bubble{background:var(--primary);color:var(--primary-foreground);border-bottom-right-radius:4px;}
.cai-assistant .cai-bubble{background:var(--muted);color:var(--foreground);border-bottom-left-radius:4px;}
.cai-input{display:flex;gap:8px;padding:12px;border-top:1px solid var(--border);background:var(--surface,var(--card));}
.cai-input textarea{flex:1;resize:none;max-height:120px;padding:9px 12px;border:1px solid var(--border);
  border-radius:10px;background:var(--background);color:var(--foreground);font-size:14px;font-family:inherit;outline:none;}
.cai-input textarea:focus{border-color:var(--primary);}
.cai-send{display:inline-flex;align-items:center;justify-content:center;width:40px;border:none;border-radius:10px;
  background:var(--primary);color:var(--primary-foreground);cursor:pointer;}
.cai-send:disabled{opacity:.5;cursor:not-allowed;}
.cai-history{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:6px;}
.cai-back{align-self:flex-start;display:inline-flex;align-items:center;gap:4px;border:none;background:transparent;
  color:var(--muted-foreground);cursor:pointer;font-size:13px;padding:6px;}
.cai-histrow{text-align:left;padding:10px 12px;border:1px solid var(--border);background:var(--surface,var(--card));
  color:var(--foreground);border-radius:10px;cursor:pointer;font-size:13px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cai-histrow:hover{border-color:var(--primary);}
.cai-empty{color:var(--muted-foreground);font-size:13px;padding:8px;}
.cai-spin{animation:cai-rot 1s linear infinite;}
@keyframes cai-rot{to{transform:rotate(360deg);}}
`;

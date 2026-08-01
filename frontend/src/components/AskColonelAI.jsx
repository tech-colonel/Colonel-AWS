import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { Sparkles, Send, X, MessageSquarePlus, Loader2, History, ChevronLeft } from 'lucide-react';
import { toast } from 'sonner';
import api, { API_URL } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { RECO_ID_TO_TYPE } from '../pages/accountant/AgentDispatch';

/* ── Ask Colonel AI ──────────────────────────────────────────────────────────
   Floating "✨ Ask Colonel AI" button + slide-over panel, mounted app-wide so
   it appears on every authenticated screen. Sends the current screen context to
   POST /api/ai/ask (SSE), reuses the existing per-user /api/conversations store
   for history (same chats as the /chat page), and shows screen-aware suggested
   prompts from GET /api/ai/suggestions. Hidden on public Landing/Login.

   Additive: this touches no agent/reco logic. Data/run-agent buckets are
   backend-deferred; the widget just streams the answer.                        */

const MODEL = 'claude-haiku-4-5';

/* Minimal, XSS-safe markdown → HTML (escapes <,>,& first). Mirrors the
   /chat page's renderer so answers read the same in both places. */
function renderMarkdown(src) {
  if (!src) return '';
  let s = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_, code) =>
    `<pre class="cai-pre"><code>${code.replace(/\n$/, '')}</code></pre>`);
  s = s.replace(/`([^`]+)`/g, '<code class="cai-code">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/^### (.*)$/gm, '<h4 class="cai-h">$1</h4>');
  s = s.replace(/^## (.*)$/gm, '<h3 class="cai-h">$1</h3>');
  s = s.replace(/^# (.*)$/gm, '<h2 class="cai-h">$1</h2>');
  s = s.replace(/(?:^[-*] .*(?:\n|$))+/gm, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('');
    return `<ul class="cai-ul">${items}</ul>`;
  });
  s = s.replace(/(?:^\d+\. .*(?:\n|$))+/gm, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol class="cai-ol">${items}</ol>`;
  });
  s = s.split('\n\n').map((p) =>
    /^\s*<(h\d|ul|ol|pre)/.test(p) ? p : `<p>${p.replace(/\n/g, '<br/>')}</p>`
  ).join('');
  return s;
}

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
  // AgentDispatch screen: /brands/:brandId/agents/:agentId (agentId is a UUID).
  // Map it to the real agent_type so the assistant is scoped + shows the right
  // suggested questions (this is the main way users open an agent).
  m = pathname.match(/^\/brands\/([^/]+)\/agents\/([^/]+)$/);
  if (m) {
    screen.brandId = m[1];
    const t = RECO_ID_TO_TYPE[m[2]];
    if (t) screen.agentType = t;
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
                    {m.role === 'assistant'
                      ? <div className="cai-bubble cai-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                      : <div className="cai-bubble">{m.content}</div>}
                  </div>
                ))}
                {streaming && (
                  <div className="cai-msg cai-assistant">
                    <div className="cai-bubble cai-md">
                      {streamText
                        ? <span dangerouslySetInnerHTML={{ __html: renderMarkdown(streamText) }} />
                        : <Loader2 className="cai-spin" size={14} />}
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

/* Scoped styles — Colonel AI blue→purple brand accent for interactive surfaces;
   neutrals use the app theme vars via hsl() (shadcn HSL-triplet convention), so
   the panel adapts to light/dark. Accent is explicit so it reads the same in both. */
const CSS = `
.cai-fab,.cai-panel{
  --cai-grad:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);
  --cai-accent:#6d28d9;--cai-accent-soft:rgba(109,40,217,.12);}
.cai-fab{position:fixed;right:20px;bottom:20px;z-index:1200;display:flex;align-items:center;gap:8px;
  padding:11px 18px;border:none;border-radius:999px;cursor:pointer;font-size:14px;font-weight:600;
  background:var(--cai-grad);color:#fff;box-shadow:0 8px 24px rgba(91,60,229,.38);}
.cai-fab:hover{filter:brightness(1.06);box-shadow:0 10px 28px rgba(91,60,229,.5);}
.cai-panel{position:fixed;right:20px;bottom:20px;z-index:1200;display:flex;flex-direction:column;
  width:380px;max-width:calc(100vw - 40px);height:560px;max-height:calc(100vh - 40px);
  background:hsl(var(--card));color:hsl(var(--card-foreground));border:1px solid hsl(var(--border));
  border-radius:16px;box-shadow:0 16px 48px rgba(49,29,120,.28);overflow:hidden;}
.cai-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;
  border-bottom:1px solid hsl(var(--border));background:var(--cai-grad);color:#fff;}
.cai-title{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;color:#fff;}
.cai-head-actions{display:flex;gap:4px;}
.cai-icon{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;
  border:none;background:transparent;color:rgba(255,255,255,.85);border-radius:8px;cursor:pointer;}
.cai-icon:hover{background:rgba(255,255,255,.18);color:#fff;}
.cai-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}
.cai-welcome{color:hsl(var(--muted-foreground));font-size:14px;line-height:1.5;}
.cai-chips{display:flex;flex-direction:column;gap:8px;margin-top:12px;}
.cai-chip{text-align:left;padding:9px 12px;border:1px solid hsl(var(--border));background:hsl(var(--card));
  color:hsl(var(--card-foreground));border-radius:10px;cursor:pointer;font-size:13px;transition:all .12s;}
.cai-chip:hover{border-color:var(--cai-accent);background:var(--cai-accent-soft);color:var(--cai-accent);}
.cai-msg{display:flex;}
.cai-user{justify-content:flex-end;}
.cai-assistant{justify-content:flex-start;}
.cai-bubble{max-width:88%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.5;
  white-space:pre-wrap;word-wrap:break-word;}
.cai-user .cai-bubble{background:var(--cai-grad);color:#fff;border-bottom-right-radius:4px;}
.cai-assistant .cai-bubble{background:hsl(var(--muted));color:hsl(var(--foreground));border-bottom-left-radius:4px;}
.cai-input{display:flex;gap:8px;padding:12px;border-top:1px solid hsl(var(--border));background:hsl(var(--card));}
.cai-input textarea{flex:1;resize:none;max-height:120px;padding:9px 12px;border:1px solid hsl(var(--border));
  border-radius:10px;background:hsl(var(--background));color:hsl(var(--foreground));font-size:14px;font-family:inherit;outline:none;}
.cai-input textarea:focus{border-color:var(--cai-accent);box-shadow:0 0 0 3px var(--cai-accent-soft);}
.cai-send{display:inline-flex;align-items:center;justify-content:center;width:40px;border:none;border-radius:10px;
  background:var(--cai-grad);color:#fff;cursor:pointer;}
.cai-send:disabled{opacity:.5;cursor:not-allowed;}
.cai-history{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:6px;}
.cai-back{align-self:flex-start;display:inline-flex;align-items:center;gap:4px;border:none;background:transparent;
  color:hsl(var(--muted-foreground));cursor:pointer;font-size:13px;padding:6px;}
.cai-histrow{text-align:left;padding:10px 12px;border:1px solid hsl(var(--border));background:hsl(var(--card));
  color:hsl(var(--card-foreground));border-radius:10px;cursor:pointer;font-size:13px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cai-histrow:hover{border-color:var(--cai-accent);background:var(--cai-accent-soft);}
.cai-empty{color:hsl(var(--muted-foreground));font-size:13px;padding:8px;}
.cai-spin{animation:cai-rot 1s linear infinite;}
@keyframes cai-rot{to{transform:rotate(360deg);}}
.cai-md p{margin:0 0 8px;}
.cai-md p:last-child{margin-bottom:0;}
.cai-md .cai-h{margin:10px 0 6px;font-weight:700;line-height:1.3;}
.cai-md h2.cai-h{font-size:15px;}
.cai-md h3.cai-h{font-size:14px;}
.cai-md h4.cai-h{font-size:13px;}
.cai-md .cai-ul,.cai-md .cai-ol{margin:4px 0 8px;padding-left:20px;}
.cai-md li{margin:2px 0;}
.cai-md .cai-code{background:var(--cai-accent-soft);color:var(--cai-accent);padding:1px 5px;border-radius:5px;font-size:12px;}
.cai-md .cai-pre{background:hsl(var(--muted));padding:10px;border-radius:8px;overflow-x:auto;margin:6px 0;font-size:12px;}
.cai-md a{color:var(--cai-accent);}
.cai-md strong{font-weight:700;}
`;

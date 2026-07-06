import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import DashboardLayout from '../components/layout/DashboardLayout';
import {
  Sparkles, Plus, Send, Paperclip, Bot, Plug, Server, ChevronDown,
  Loader2, X, Trash2, MessageSquarePlus, PanelRightClose, PanelRightOpen,
  FileSpreadsheet, CheckCircle2, Play, CornerDownLeft, Flag, Download,
  Maximize2, Minimize2, PanelLeft,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { toast } from 'sonner';
import api, { API_URL } from '../lib/api';
import { sidebarFor } from '../lib/adminNav';
import { RECO_AGENT_SPECS, specByType } from '../lib/recoAgentSpecs';
import ToolResultDashboard from '../components/reco/ToolResultDashboard';
import BrandLogo from '../components/BrandLogos';

/* Tolerant accessors for live + persisted + nested-multistate row shapes. */
const rget = (r, ...paths) => {
  for (const p of paths) {
    const v = typeof p === 'function' ? p(r) : r?.[p];
    if (v != null && v !== '') return v;
  }
  return '';
};
const rowSupplier = (r) => rget(r, 'supplier', 'supplier_name', (x) => x.gstr2b?.supplier_name, (x) => x.purchase?.supplier_name, 'customer_name', 'particulars', 'description', 'itc_type');
const rowInvoice  = (r) => rget(r, 'invoice_no', 'invoice_number', (x) => x.gstr2b?.invoice_number, (x) => x.purchase?.invoice_number);
const rowRemark1  = (r) => rget(r, 'suggested_action', 'remark_1');
const rowRemark2  = (r) => rget(r, 'remark_2', 'suggested_action_2', 'explanation', 'remark');
const rowRemark3  = (r) => rget(r, 'remark_3', 'suggested_action_3');

/* Build a compact textual digest of a run so the model can answer per-row
   questions ("why is invoice 123 partially matched?"). Capped for token budget. */
function buildAgentContext({ agentLabel, brandName, counts, rows }) {
  const c = counts || {};
  const head = `Agent: ${agentLabel}${brandName ? ` · Brand: ${brandName}` : ''}. ` +
    `Rows: ${rows.length}` +
    (c.matched != null ? ` · Matched: ${c.matched}` : '') +
    (c.mismatch != null ? ` · Mismatch: ${c.mismatch}` : '') + '.';
  const lines = rows.slice(0, 80).map((r, i) => {
    const parts = [`#${i + 1} ${String(rowSupplier(r)).slice(0, 40)}`];
    const inv = rowInvoice(r); if (inv) parts.push(`Inv ${inv}`);
    const r1 = rowRemark1(r); if (r1) parts.push(`Remark1: ${r1}`);
    const r2 = rowRemark2(r); if (r2) parts.push(`Remark2: ${r2}`);
    const r3 = rowRemark3(r); if (r3) parts.push(`Remark3: ${r3}`);
    return parts.join(' | ');
  });
  let out = head + '\nEntries:\n' + lines.join('\n');
  if (rows.length > 80) out += `\n…and ${rows.length - 80} more rows (download the Excel for all).`;
  return out.slice(0, 11000);
}

/* Trim agent-message rows before persisting a thread to history (bound JSONB size). */
const slimForStore = (msgs) =>
  msgs.map((m) => (m.type === 'agent' ? { ...m, rows: (m.rows || []).slice(0, 500) } : m));

/* Compact snapshot of rows to attach to a feedback task (mirrors the workspace). */
function feedbackRowSnapshots(rows) {
  return (rows || []).slice(0, 50).map((r) => ({
    supplier: String(rowSupplier(r) || ''),
    invoice_no: String(rowInvoice(r) || ''),
    remark_1: String(rowRemark1(r) || ''),
    remark_2: String(rowRemark2(r) || ''),
    remark_3: String(rowRemark3(r) || ''),
  }));
}

/* ── Models the picker offers (must match the backend whitelist) ──────────── */
const MODELS = [
  { id: 'claude-sonnet-4-6',          label: 'Sonnet 4.6', sub: 'Balanced · default' },
  { id: 'claude-haiku-4-5-20251001',  label: 'Haiku 4.5',  sub: 'Fastest · cheapest' },
  { id: 'claude-opus-4-8',            label: 'Opus 4.8',   sub: 'Most capable' },
];
const modelLabel = (id) => MODELS.find((m) => m.id === id)?.label || 'Sonnet 4.6';

/* ── Tiny, safe markdown → HTML (escape first, then format) ───────────────── */
function renderMarkdown(src) {
  if (!src) return '';
  let s = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // fenced code
  s = s.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_, code) =>
    `<pre class="cai-pre"><code>${code.replace(/\n$/, '')}</code></pre>`);
  // inline code
  s = s.replace(/`([^`]+)`/g, '<code class="cai-code">$1</code>');
  // bold / italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // headings
  s = s.replace(/^### (.*)$/gm, '<h4 class="cai-h">$1</h4>');
  s = s.replace(/^## (.*)$/gm, '<h3 class="cai-h">$1</h3>');
  s = s.replace(/^# (.*)$/gm, '<h2 class="cai-h">$1</h2>');
  // bullet / numbered lists (group consecutive lines)
  s = s.replace(/(?:^[-*] .*(?:\n|$))+/gm, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^[-*] /, '')}</li>`).join('');
    return `<ul class="cai-ul">${items}</ul>`;
  });
  s = s.replace(/(?:^\d+\. .*(?:\n|$))+/gm, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol class="cai-ol">${items}</ol>`;
  });
  // paragraphs / line breaks (skip lines already wrapped in a block tag)
  s = s.split('\n\n').map((p) =>
    /^\s*<(h\d|ul|ol|pre)/.test(p) ? p : `<p>${p.replace(/\n/g, '<br/>')}</p>`
  ).join('');
  return s;
}

/* ════════════════════════════════════════════════════════════════════════ */
export default function ColonelChat() {
  const sidebarItems = useMemo(() => sidebarFor([]), []);

  // conversations (left rail) — strictly the caller's own (backend-scoped)
  const [convos, setConvos] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);     // [{role, content}]
  const [model, setModel] = useState('claude-sonnet-4-6');

  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [railOpen, setRailOpen] = useState(true);   // collapsible history rail

  // feedback mode (+ → Feedback) + latest agent-run context (for explain + feedback)
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [agentContext, setAgentContext] = useState('');   // digest fed to /api/chat
  const [lastRun, setLastRun] = useState(null);            // {agentType,agentLabel,brandId,brandName,jobId,rows}

  // + menu + panels
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [panel, setPanel] = useState(null);          // 'connectors' | 'mcp' | null
  const [attachment, setAttachment] = useState(null); // File

  // right canvas
  const [canvas, setCanvas] = useState(null);         // { kind:'agent', ... }
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  const [canvasWidth, setCanvasWidth] = useState(460);  // draggable panel width

  const threadRef = useRef(null);
  const fileRef = useRef(null);
  const abortRef = useRef(null);

  // An incoming ?prompt (e.g. "Draft summary email" from Meetings) auto-sends.
  const location = useLocation();
  const navigate = useNavigate();
  const promptFired = useRef(false);

  /* ── load conversation list ── */
  const loadConvos = useCallback(async () => {
    try { const { data } = await api.get('/api/conversations'); setConvos(data || []); }
    catch { /* silent */ }
  }, []);
  useEffect(() => { loadConvos(); }, [loadConvos]);

  /* autoscroll */
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, streamText, streaming]);

  /* ── drag the divider to resize the Excel panel ── */
  const startResize = (e) => {
    e.preventDefault();
    const onMove = (ev) => {
      const x = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const w = Math.min(Math.max(window.innerWidth - x, 360), window.innerWidth - 420);
      setCanvasWidth(w);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  };

  /* ── new chat ── */
  const newChat = () => {
    if (abortRef.current) abortRef.current.abort();
    setActiveId(null); setMessages([]); setStreamText(''); setStreaming(false);
    setCanvas(null); setCanvasOpen(false); setCanvasExpanded(false); setAttachment(null);
    setFeedbackMode(false); setAgentContext(''); setLastRun(null);
  };

  /* ── open an existing conversation (owner-scoped fetch) ── */
  const openConvo = async (id) => {
    try {
      const { data } = await api.get(`/api/conversations/${id}`);
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      setActiveId(data.id);
      setMessages(msgs);
      setModel(data.model || 'claude-sonnet-4-6');
      setStreamText(''); setStreaming(false);
      setCanvas(null); setCanvasOpen(false); setCanvasExpanded(false);
      // Restore run context from the most recent agent message (so "why
      // partially matched?" still works on a reopened conversation).
      const lastAgent = [...msgs].reverse().find((m) => m.type === 'agent');
      if (lastAgent) {
        setAgentContext(buildAgentContext({ agentLabel: lastAgent.agentLabel, brandName: lastAgent.brandName, counts: lastAgent.counts, rows: lastAgent.rows || [] }));
        setLastRun({ agentType: lastAgent.agentType, agentLabel: lastAgent.agentLabel, brandId: null, brandName: lastAgent.brandName, jobId: lastAgent.jobId, rows: lastAgent.rows || [] });
      } else {
        setAgentContext(''); setLastRun(null);
      }
    } catch (err) {
      toast.error(err.response?.status === 404 ? 'Conversation not found' : 'Failed to open chat');
    }
  };

  const deleteConvo = async (id, e) => {
    e.stopPropagation();
    try {
      await api.delete(`/api/conversations/${id}`);
      setConvos((c) => c.filter((x) => x.id !== id));
      if (activeId === id) newChat();
    } catch { toast.error('Delete failed'); }
  };

  /* ── submit feedback (+ → Feedback) — becomes a task for the engineers ── */
  const submitFeedback = async (text) => {
    setInput('');
    try {
      await api.post('/api/feedback', {
        comment: text,
        ...(lastRun ? {
          agentType: lastRun.agentType,
          agentLabel: lastRun.agentLabel,
          brandId: lastRun.brandId,
          brandName: lastRun.brandName,
          jobId: lastRun.jobId,
          rows: feedbackRowSnapshots(lastRun.rows),
        } : {}),
      });
      setMessages((m) => [...m, { role: 'user', type: 'note', content: text },
        { role: 'assistant', type: 'note', content: '✓ Feedback sent to the engineering team — it’s now a task they can turn into a plan.' }]);
      toast.success('Feedback sent');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to send feedback');
    } finally {
      setFeedbackMode(false);
    }
  };

  /* ── send a message + stream the reply ── */
  const send = async (overrideText) => {
    const text = (typeof overrideText === 'string' ? overrideText : input).trim();
    if (!text || streaming) return;

    if (feedbackMode) { submitFeedback(text); return; }

    // attachment → fold into the message text as context (Claude reads text only)
    let content = text;
    if (attachment) content = `${text}\n\n[Attached file: ${attachment.name}]`;

    const userMsg = { role: 'user', content };
    const visibleAfterUser = [...messages, userMsg];
    setMessages(visibleAfterUser);
    setInput(''); setAttachment(null); setStreamText(''); setStreaming(true);

    // What Claude actually sees: text turns only (agent dashboards + notes are
    // visual-only; the run data reaches the model via the `context` field).
    const payloadMsgs = visibleAfterUser
      .filter((m) => !m.type)
      .map(({ role, content: c }) => ({ role, content: c }));

    // What gets PERSISTED to history: the full visible thread (incl. agent
    // dashboards + notes), so reopening a conversation restores everything.
    const persistMsgs = slimForStore(visibleAfterUser);

    // ensure a conversation exists (owned by the caller) so history persists
    let convoId = activeId;
    try {
      if (!convoId) {
        const { data } = await api.post('/api/conversations', { messages: persistMsgs, model });
        convoId = data.id; setActiveId(data.id);
        setConvos((c) => [{ id: data.id, title: data.title, model, updatedAt: data.updatedAt }, ...c]);
      } else {
        await api.patch(`/api/conversations/${convoId}`, { messages: persistMsgs, model });
      }
    } catch { /* persistence is best-effort; streaming still proceeds */ }

    // stream via fetch (axios doesn't expose a token stream cleanly)
    const controller = new AbortController();
    abortRef.current = controller;
    let acc = '';
    try {
      const resp = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
          'ngrok-skip-browser-warning': 'true',
        },
        body: JSON.stringify({ conversationId: convoId, model, messages: payloadMsgs, context: agentContext || undefined }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        const msg = await resp.json().catch(() => ({}));
        throw new Error(msg.error || `Chat failed (${resp.status})`);
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
          const dataLine = /data:\s*([\s\S]+)/.exec(block)?.[1]?.trim();
          if (!ev || !dataLine) continue;
          let payload = {};
          try { payload = JSON.parse(dataLine); } catch { continue; }
          if (ev === 'delta') { acc += payload.text || ''; setStreamText(acc); }
          else if (ev === 'error') { throw new Error(payload.error || 'Chat failed'); }
          else if (ev === 'done') { acc = payload.text || acc; }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') toast.error(err.message || 'Chat failed');
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setStreamText('');
      if (acc) {
        // append to whatever the visible thread is now (keeps agent dashboards)
        setMessages((prev) => [...prev, { role: 'assistant', content: acc }]);
        loadConvos();   // backend persists the assistant turn; refresh rail title
      }
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // Consume a prompt passed via navigation (e.g. Meetings → "Draft summary
  // email") and auto-send it once, then clear it so it doesn't re-fire.
  useEffect(() => {
    const p = location.state?.prompt;
    if (!p || promptFired.current || streaming) return;
    promptFired.current = true;
    setInput(p);
    navigate(location.pathname, { replace: true, state: {} });
    const t = setTimeout(() => send(p), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  /* ── an agent run finished: dashboard inline in chat, Excel on the right,
        capture run context (for "why partially matched?") + feedback target ── */
  const onAgentResult = async (run) => {
    const { agentType, agentLabel, brandId, brandName, summary, counts, rows, jobId, recoType } = run;
    const agentMsg = {
      role: 'assistant', type: 'agent',
      agentType, agentLabel, brandName, summary, counts, rows, jobId, recoType,
    };
    const next = [...messages, agentMsg];
    setMessages(next);
    setAgentContext(buildAgentContext({ agentLabel, brandName, counts, rows }));
    setLastRun({ agentType, agentLabel, brandId, brandName, jobId, rows });
    setCanvas({ kind: 'excel', jobId, recoType: recoType || agentType, agentLabel });
    setCanvasOpen(true);

    // Persist to history so an agent run shows in the left rail + reopens.
    const persistMsgs = slimForStore(next);
    const title = `${agentLabel}${brandName ? ' · ' + brandName : ''}`;
    try {
      if (!activeId) {
        const { data } = await api.post('/api/conversations', { messages: persistMsgs, model, title });
        setActiveId(data.id);
        setConvos((c) => [{ id: data.id, title: data.title, model, updatedAt: data.updatedAt }, ...c]);
      } else {
        await api.patch(`/api/conversations/${activeId}`, { messages: persistMsgs, model });
        loadConvos();
      }
    } catch { /* best-effort */ }
  };

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <style>{CHAT_CSS}</style>
      <div className="cai-root">
        {/* ── Left rail: conversation history (owner-only, collapsible) ── */}
        {railOpen && (
        <aside className="cai-rail">
          <button className="cai-newchat" onClick={newChat} data-testid="cai-new-chat">
            <MessageSquarePlus className="h-4 w-4" /> New chat
          </button>
          <div className="cai-rail-list">
            {convos.length === 0 && <p className="cai-rail-empty">No conversations yet</p>}
            {convos.map((c) => (
              <button
                key={c.id}
                className={`cai-rail-item ${activeId === c.id ? 'active' : ''}`}
                onClick={() => openConvo(c.id)}
                title={c.title}
              >
                <span className="cai-rail-title">{c.title}</span>
                <span className="cai-rail-del" onClick={(e) => deleteConvo(c.id, e)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
              </button>
            ))}
          </div>
        </aside>
        )}

        {/* ── Center: header + thread + composer ── */}
        <section className="cai-main">
          <header className="cai-head">
            <div className="cai-head-title">
              <button className="cai-rail-toggle" onClick={() => setRailOpen((o) => !o)} title={railOpen ? 'Hide history' : 'Show history'}>
                <PanelLeft className="h-4 w-4" />
              </button>
              <Sparkles className="h-5 w-5" style={{ color: '#7C3AED' }} />
              <span>Colonel AI</span>
            </div>
            <div className="cai-head-right">
              {/* model picker */}
              <div className="cai-modelpick">
                <button className="cai-modelbtn" onClick={() => setModelOpen((o) => !o)}>
                  {modelLabel(model)} <ChevronDown className="h-3.5 w-3.5" />
                </button>
                {modelOpen && (
                  <div className="cai-modelmenu" onMouseLeave={() => setModelOpen(false)}>
                    {MODELS.map((m) => (
                      <button key={m.id} className={`cai-modelopt ${model === m.id ? 'active' : ''}`}
                        onClick={() => { setModel(m.id); setModelOpen(false); }}>
                        <span className="cai-modelopt-label">{m.label}</span>
                        <span className="cai-modelopt-sub">{m.sub}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {canvas && (
                <button className="cai-canvastoggle" onClick={() => setCanvasOpen((o) => !o)}>
                  {canvasOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
                </button>
              )}
            </div>
          </header>

          <div className="cai-thread" ref={threadRef}>
            {messages.length === 0 && !streaming && (
              <div className="cai-welcome">
                <div className="cai-welcome-icon"><Sparkles className="h-7 w-7" /></div>
                <h2>How can I help with your reconciliation today?</h2>
                <p>Ask about GST, ITC, bank classification, or use <strong>+ → Agent</strong> to run a reconciliation and see the dashboard here.</p>
              </div>
            )}
            {messages.map((m, i) => (
              <Bubble key={i} msg={m} onOpenExcel={() => { if (m.jobId) { setCanvas({ kind: 'excel', jobId: m.jobId, recoType: m.recoType || m.agentType, agentLabel: m.agentLabel }); setCanvasOpen(true); } }} />
            ))}
            {streaming && (
              <Bubble msg={{ role: 'assistant', content: streamText }} streaming />
            )}
          </div>

          {/* composer */}
          <div className="cai-composer-wrap">
            {feedbackMode && (
              <div className="cai-attach-chip" style={{ background: '#FEF2F2', color: '#B91C1C' }}>
                <Flag className="h-3.5 w-3.5" />
                <span>Feedback mode — your next message becomes a task</span>
                <button onClick={() => setFeedbackMode(false)}><X className="h-3 w-3" /></button>
              </div>
            )}
            {attachment && (
              <div className="cai-attach-chip">
                <FileSpreadsheet className="h-3.5 w-3.5" />
                <span>{attachment.name}</span>
                <button onClick={() => setAttachment(null)}><X className="h-3 w-3" /></button>
              </div>
            )}
            <div className="cai-composer">
              {/* + menu */}
              <div className="cai-plus">
                <button className="cai-plusbtn" onClick={() => setMenuOpen((o) => !o)} data-testid="cai-plus">
                  <Plus className="h-5 w-5" />
                </button>
                {menuOpen && (
                  <div className="cai-menu" onMouseLeave={() => setMenuOpen(false)}>
                    <button onClick={() => { setMenuOpen(false); fileRef.current?.click(); }}>
                      <Paperclip className="h-4 w-4" /> Attach file
                    </button>
                    <button onClick={() => { setMenuOpen(false); setCanvas({ kind: 'agent-setup' }); setCanvasOpen(true); }}>
                      <Bot className="h-4 w-4" /> Agent
                    </button>
                    <button onClick={() => { setMenuOpen(false); setPanel('connectors'); }}>
                      <Plug className="h-4 w-4" /> Connectors
                    </button>
                    <button onClick={() => { setMenuOpen(false); setPanel('mcp'); }}>
                      <Server className="h-4 w-4" /> MCP servers
                    </button>
                    <button onClick={() => { setMenuOpen(false); setFeedbackMode(true); }}>
                      <Flag className="h-4 w-4" /> Feedback
                    </button>
                  </div>
                )}
                <input ref={fileRef} type="file" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) setAttachment(f); e.target.value = ''; }} />
              </div>

              <textarea
                className="cai-textarea"
                placeholder={feedbackMode ? 'Describe the issue you found…' : 'Message Colonel AI…'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
                rows={1}
                data-testid="cai-input"
              />

              {streaming ? (
                <button className="cai-send stop" onClick={() => abortRef.current?.abort()} title="Stop">
                  <span className="cai-stop-sq" />
                </button>
              ) : (
                <button className="cai-send" onClick={send} disabled={!input.trim()} data-testid="cai-send">
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
            <p className="cai-hint"><CornerDownLeft className="h-3 w-3" /> Enter to send · Shift+Enter for newline · {modelLabel(model)}</p>
          </div>
        </section>

        {/* ── Right canvas: agent setup / the output Excel ── */}
        {canvasOpen && canvas && (
          <aside className={`cai-canvas ${canvasExpanded ? 'expanded' : ''}`}
            style={canvasExpanded ? undefined : { width: canvasWidth }}>
            {!canvasExpanded && (
              <div className="cai-canvas-resizer" onMouseDown={startResize} onTouchStart={startResize} title="Drag to resize" />
            )}
            <div className="cai-canvas-head">
              <span>{canvas.kind === 'excel' ? 'Excel output' : 'Agent mode'}</span>
              <div className="cai-canvas-head-actions">
                {canvas.kind === 'excel' && (
                  <button onClick={() => setCanvasExpanded((e) => !e)} title={canvasExpanded ? 'Restore' : 'Expand'}>
                    {canvasExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                  </button>
                )}
                <button onClick={() => { setCanvasOpen(false); setCanvasExpanded(false); }}><X className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="cai-canvas-body" style={canvas.kind === 'excel' ? { padding: 0 } : undefined}>
              {canvas.kind === 'agent-setup' && (
                <AgentSetup onResult={onAgentResult} />
              )}
              {canvas.kind === 'excel' && (
                <ExcelPreview jobId={canvas.jobId} recoType={canvas.recoType} agentLabel={canvas.agentLabel}
                  expanded={canvasExpanded} onToggleExpand={() => setCanvasExpanded((e) => !e)} />
              )}
            </div>
          </aside>
        )}
      </div>

      {/* ── Connectors / MCP slide-over (from + menu) ── */}
      {panel === 'connectors' && <ConnectorsPanel onClose={() => setPanel(null)} />}
      {panel === 'mcp' && <McpPanel onClose={() => setPanel(null)} />}
    </DashboardLayout>
  );
}

/* ── Chat bubble (text · note · inline agent dashboard) ─────────────────────── */
function Bubble({ msg, streaming, onOpenExcel }) {
  const { role, content, type } = msg;
  const isUser = role === 'user';

  // Agent run → full-width inline dashboard (KPIs + donut + charts, NO row table)
  if (type === 'agent') {
    const c = msg.counts || {};
    const matched = c.matched ?? (msg.rows || []).filter((r) => /matched/i.test(rowRemark1(r))).length;
    const cross = (msg.rows || []).filter((r) => rowRemark3(r)).length;
    return (
      <div className="cai-agent-msg">
        <div className="cai-agent-msg-head">
          <Sparkles className="h-4 w-4" style={{ color: '#7C3AED' }} />
          <span><strong>{msg.agentLabel}</strong>{msg.brandName ? ` · ${msg.brandName}` : ''} — {(msg.rows || []).length} records{matched ? ` · ${matched} matched` : ''}{cross ? ` · ${cross} cross-state` : ''}</span>
          <button className="cai-agent-msg-excel" onClick={onOpenExcel}>
            <FileSpreadsheet className="h-3.5 w-3.5" /> View Excel
          </button>
        </div>
        <div className="cai-agent-msg-dash">
          <ToolResultDashboard embedded agentType={msg.agentType} agentLabel={msg.agentLabel}
            summary={msg.summary} counts={msg.counts} rows={msg.rows} />
        </div>
      </div>
    );
  }

  // Lightweight system note (e.g. feedback confirmation)
  if (type === 'note') {
    return (
      <div className={`cai-row ${isUser ? 'user' : 'assistant'}`}>
        <div className="cai-note">{content}</div>
      </div>
    );
  }

  return (
    <div className={`cai-row ${isUser ? 'user' : 'assistant'}`}>
      {!isUser && <div className="cai-avatar"><Sparkles className="h-4 w-4" /></div>}
      <div className={`cai-bubble ${isUser ? 'user' : 'assistant'}`}>
        {isUser
          ? <span className="cai-usertext">{content}</span>
          : (content
              ? <div className="cai-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
              : <span className="cai-typing"><span /><span /><span /></span>)}
        {streaming && content && <span className="cai-caret" />}
      </div>
    </div>
  );
}

/* ── Excel viewer (right canvas) — Claude-style spreadsheet artifact ─────────
   Renders the real exported workbook as a grid (A/B/C columns + row numbers,
   frozen header + gutter), full-name bottom tabs, plus Open-in-Google-Sheets
   and Download. */
function ExcelPreview({ jobId, recoType, agentLabel }) {
  const [wb, setWb] = React.useState(null);
  const [active, setActive] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [opening, setOpening] = React.useState(false);
  const blobRef = useRef(null);
  const ROW_CAP = 500;

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null); setWb(null); setActive(0);
    (async () => {
      try {
        const resp = await api.get(`/api/reco/export/${jobId}`, { responseType: 'arraybuffer' });
        if (cancelled) return;
        blobRef.current = new Blob([resp.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const book = XLSX.read(resp.data, { type: 'array' });
        const sheets = book.SheetNames.map((name) => {
          const grid = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '' });
          const cols = grid.reduce((m, r) => Math.max(m, r.length), 0);
          return { name, rows: grid.slice(0, ROW_CAP), total: grid.length, cols };
        });
        setWb({ sheets });
      } catch (e) {
        if (!cancelled) setErr(e.response?.status === 404 ? 'Output not found' : 'Could not load the Excel file');
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  const download = () => {
    if (!blobRef.current) return;
    const url = window.URL.createObjectURL(blobRef.current);
    const a = document.createElement('a'); a.href = url;
    a.download = `${recoType || 'reco'}_${jobId}.xlsx`; a.click();
    window.URL.revokeObjectURL(url);
  };

  const openInSheets = async () => {
    setOpening(true);
    // open the tab synchronously so the browser doesn't block the popup
    const tab = window.open('', '_blank');
    try {
      const { data } = await api.post(`/api/reco/open-in-sheets/${jobId}`, {}, { params: { name: agentLabel || recoType } });
      if (tab) tab.location = data.url; else window.open(data.url, '_blank');
    } catch (e) {
      if (tab) tab.close();
      toast.error(e.response?.data?.error || 'Could not open in Google Sheets');
    } finally { setOpening(false); }
  };

  if (loading) return <div className="cai-xl-center"><Loader2 className="h-5 w-5 animate-spin" /><span>Loading spreadsheet…</span></div>;
  if (err) return <div className="cai-xl-center"><span>{err}</span><button className="cai-xl-dl" onClick={download} style={{ marginTop: 12 }}><Download className="h-3.5 w-3.5" /> Download instead</button></div>;
  if (!wb || wb.sheets.length === 0) return <div className="cai-xl-center"><span>No data in the output file</span></div>;

  const sheet = wb.sheets[active] || wb.sheets[0];
  const colLetters = Array.from({ length: sheet.cols }, (_, i) => XLSX.utils.encode_col(i));

  return (
    <div className="cai-xl">
      {/* toolbar */}
      <div className="cai-xl-bar">
        <span className="cai-xl-name" title={agentLabel}>{agentLabel || 'Reconciliation'} · XLSX</span>
        <div className="cai-xl-actions">
          <button className="cai-xl-btn drive" onClick={openInSheets} disabled={opening} title="Open in Google Sheets">
            {opening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BrandLogo type="google" size={15} />}
            <span>Google Sheets</span>
          </button>
          <button className="cai-xl-btn" onClick={download} title="Download .xlsx"><Download className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      {/* spreadsheet grid */}
      <div className="cai-xl-scroll">
        <table className="cai-xl-grid">
          <thead>
            <tr>
              <th className="cai-xl-corner" />
              {colLetters.map((L) => <th key={L} className="cai-xl-collbl">{L}</th>)}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri}>
                <td className="cai-xl-rownum">{ri + 1}</td>
                {colLetters.map((_, ci) => {
                  const v = row[ci];
                  const isNum = typeof v === 'number';
                  return (
                    <td key={ci} className={isNum ? 'cai-xl-cell num' : 'cai-xl-cell'}>
                      {v === '' || v == null ? '' : String(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sheet.total > ROW_CAP && (
        <div className="cai-xl-note">Showing first {ROW_CAP} of {sheet.total} rows — open in Google Sheets or download for the full file.</div>
      )}

      {/* bottom sheet tabs (Excel-style, full names) */}
      <div className="cai-xl-tabs">
        {wb.sheets.map((s, i) => (
          <button key={s.name} className={`cai-xl-tab ${i === active ? 'active' : ''}`} onClick={() => setActive(i)} title={s.name}>
            {s.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Agent mode setup (runs through /api/reco/run — NOT Claude API) ────────── */
function AgentSetup({ onResult }) {
  const [recoType, setRecoType] = useState('');
  const [brands, setBrands] = useState([]);
  const [brandId, setBrandId] = useState('');
  const [tolerance, setTolerance] = useState('1.0');
  const [running, setRunning] = useState(false);

  const spec = specByType(recoType);
  // single-state: {key:file}. multistate: array of {gstr2b,purchase,debit}
  const [files, setFiles] = useState({});
  const [states, setStates] = useState([{ gstr2b: null, purchase: null, debit: null }]);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/api/brands/my-brands');
        const list = Array.isArray(data) ? data : (data?.brands || []);
        setBrands(list);
        if (list[0]) setBrandId(list[0].id);
      } catch { /* admin sandbox fallback below */ }
    })();
  }, []);

  const pickAgent = (t) => {
    setRecoType(t); setFiles({});
    setStates([{ gstr2b: null, purchase: null, debit: null }]);
  };

  const run = async () => {
    if (!brandId) { toast.error('Select a brand first'); return; }
    const fd = new FormData();
    fd.append('reco_type', recoType);
    fd.append('tolerance', tolerance);
    fd.append('brand_id', brandId);
    fd.append('is_demo', 'false');

    if (spec.multistate) {
      const ok = states.every((s) => s.gstr2b && s.purchase);
      if (!ok) { toast.error('Each state needs at least a GSTR-2B and Purchase file'); return; }
      for (const s of states) {
        fd.append('gstr2b', s.gstr2b);
        fd.append('purchase', s.purchase);
        if (s.debit) fd.append('debit', s.debit);
        else fd.append('debit', new Blob([]), 'empty.xlsx');
      }
    } else {
      const missing = spec.files.filter((f) => f.required && !files[f.key]);
      if (missing.length) { toast.error(`Upload: ${missing.map((f) => f.label).join(', ')}`); return; }
      for (const f of spec.files) if (files[f.key]) fd.append(f.key, files[f.key]);
    }

    setRunning(true);
    try {
      const { data } = await api.post('/api/reco/run', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const rows = data.results || [];
      const brandName = brands.find((b) => b.id === brandId)?.name || '';
      onResult({
        agentType: recoType, recoType, agentLabel: spec.name,
        brandId, brandName,
        summary: data.summary || {}, counts: data.counts || {}, rows,
        jobId: data.job_id,
      });
      toast.success(`Reconciliation complete — ${rows.length} records`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Reconciliation failed');
    } finally { setRunning(false); }
  };

  /* agent picker */
  if (!recoType) {
    return (
      <div className="cai-agent">
        <p className="cai-agent-lead">Pick a reconciliation to run. Files are processed by Colonel's own engine — not the chat model.</p>
        <div className="cai-agent-grid">
          {RECO_AGENT_SPECS.map((s) => (
            <button key={s.reco_type} className="cai-agent-card" onClick={() => pickAgent(s.reco_type)}>
              <Bot className="h-4 w-4" />
              <span>{s.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="cai-agent">
      <button className="cai-agent-back" onClick={() => setRecoType('')}>← All agents</button>
      <h3 className="cai-agent-name">{spec.name}</h3>

      <label className="cai-field-label">Brand</label>
      <select className="cai-select" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
        <option value="">Select a brand…</option>
        {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>

      {spec.multistate ? (
        <>
          {states.map((st, idx) => (
            <div key={idx} className="cai-state-group">
              <div className="cai-state-head">State {idx + 1}
                {states.length > 1 && (
                  <button onClick={() => setStates((s) => s.filter((_, i) => i !== idx))}><X className="h-3 w-3" /></button>
                )}
              </div>
              {spec.files.map((f) => (
                <FileSlot key={f.key} label={f.label} hint={f.hint} accept={f.accept}
                  file={st[f.key]}
                  onPick={(file) => setStates((s) => s.map((x, i) => i === idx ? { ...x, [f.key]: file } : x))} />
              ))}
            </div>
          ))}
          <button className="cai-addstate" onClick={() => setStates((s) => [...s, { gstr2b: null, purchase: null, debit: null }])}>
            <Plus className="h-3.5 w-3.5" /> Add another state
          </button>
        </>
      ) : (
        spec.files.map((f) => (
          <FileSlot key={f.key} label={f.label} hint={f.hint} accept={f.accept} required={f.required}
            file={files[f.key]}
            onPick={(file) => setFiles((prev) => ({ ...prev, [f.key]: file }))} />
        ))
      )}

      <div className="cai-tol">
        <label className="cai-field-label">Tolerance (₹)</label>
        <input type="number" step="0.5" min="0" value={tolerance}
          onChange={(e) => setTolerance(e.target.value)} className="cai-tol-input" />
      </div>

      <button className="cai-runbtn" onClick={run} disabled={running}>
        {running ? <><Loader2 className="h-4 w-4 animate-spin" /> Running…</> : <><Play className="h-4 w-4" /> Run reconciliation</>}
      </button>
    </div>
  );
}

function FileSlot({ label, hint, accept, required, file, onPick }) {
  const ref = useRef(null);
  return (
    <div className="cai-slot" onClick={() => ref.current?.click()}>
      <div className="cai-slot-left">
        {file ? <CheckCircle2 className="h-4 w-4" style={{ color: '#059669' }} /> : <FileSpreadsheet className="h-4 w-4" style={{ color: '#94A3B8' }} />}
        <div>
          <div className="cai-slot-label">{label}{required && <span className="cai-req">*</span>}</div>
          <div className="cai-slot-hint">{file ? file.name : hint}</div>
        </div>
      </div>
      <input ref={ref} type="file" className="hidden" accept={accept || '.xlsx,.xls,.csv'}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ''; }} />
    </div>
  );
}

/* ── Connectors panel (reuses /api/integrations + BrandLogo) ──────────────── */
function ConnectorsPanel({ onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try { const { data } = await api.get('/api/integrations'); setItems(data || []); }
      catch { toast.error('Connectors are admin-managed — open Integrations from the admin menu.'); }
      finally { setLoading(false); }
    })();
  }, []);
  return (
    <SlideOver title="Connectors" onClose={onClose}>
      {loading ? <Centered><Loader2 className="h-5 w-5 animate-spin" /></Centered> : (
        items.length === 0
          ? <p className="cai-so-empty">No connectors available. Admins manage these under Integrations.</p>
          : <div className="cai-so-grid">
              {items.map((c) => (
                <div key={c.type} className="cai-so-card">
                  <BrandLogo type={c.type} size={26} />
                  <div className="cai-so-meta">
                    <div className="cai-so-name">{c.name}</div>
                    <div className={`cai-so-status ${c.status === 'connected' ? 'on' : ''}`}>
                      {c.status === 'connected' ? 'Connected' : 'Not connected'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
      )}
    </SlideOver>
  );
}

/* ── MCP registry panel (add by URL + list) ───────────────────────────────── */
function McpPanel({ onClose }) {
  const [items, setItems] = useState([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    try { const { data } = await api.get('/api/mcp'); setItems(data || []); } catch { /* */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    if (!name.trim() || !url.trim()) { toast.error('Name and URL are required'); return; }
    setSaving(true);
    try { await api.post('/api/mcp', { name, url }); setName(''); setUrl(''); load(); toast.success('MCP server added'); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed to add'); }
    finally { setSaving(false); }
  };
  const remove = async (id) => { try { await api.delete(`/api/mcp/${id}`); load(); } catch { /* */ } };
  return (
    <SlideOver title="MCP servers" onClose={onClose}>
      <div className="cai-mcp-form">
        <input className="cai-input" placeholder="Server name (e.g. Tally MCP)" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="cai-input" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="cai-runbtn" onClick={add} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add MCP server
        </button>
      </div>
      <div className="cai-mcp-list">
        {items.length === 0 && <p className="cai-so-empty">No MCP servers registered yet.</p>}
        {items.map((s) => (
          <div key={s.id} className="cai-mcp-item">
            <Server className="h-4 w-4" style={{ color: '#7C3AED' }} />
            <div className="cai-mcp-meta">
              <div className="cai-so-name">{s.name}</div>
              <div className="cai-mcp-url">{s.url}</div>
            </div>
            <span className="cai-mcp-badge">registered</span>
            <button className="cai-mcp-del" onClick={() => remove(s.id)}><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}
      </div>
    </SlideOver>
  );
}

function SlideOver({ title, onClose, children }) {
  return (
    <div className="cai-so-backdrop" onClick={onClose}>
      <div className="cai-so" onClick={(e) => e.stopPropagation()}>
        <div className="cai-so-head"><span>{title}</span><button onClick={onClose}><X className="h-4 w-4" /></button></div>
        <div className="cai-so-body">{children}</div>
      </div>
    </div>
  );
}
const Centered = ({ children }) => <div className="cai-centered">{children}</div>;

/* ════════════════════════════════════════════════════════════════════════ */
const CHAT_CSS = `
.cai-root{display:flex;height:calc(100vh - 0px);background:#F8FAFC;color:#0F172A;font-family:Inter,system-ui,sans-serif;}
.cai-rail{width:248px;flex-shrink:0;background:#fff;border-right:1px solid #E2E8F0;display:flex;flex-direction:column;}
.cai-newchat{margin:14px;display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid #E2E8F0;border-radius:10px;font-size:13px;font-weight:600;color:#0F172A;background:#fff;cursor:pointer;transition:.15s;}
.cai-newchat:hover{background:#F1F5F9;border-color:#CBD5E1;}
.cai-rail-list{flex:1;overflow-y:auto;padding:0 8px 12px;}
.cai-rail-empty{font-size:12px;color:#94A3B8;text-align:center;margin-top:24px;}
.cai-rail-item{width:100%;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:8px 10px;border-radius:8px;font-size:13px;color:#475569;background:transparent;border:none;cursor:pointer;text-align:left;}
.cai-rail-item:hover{background:#F1F5F9;}
.cai-rail-item.active{background:#EDE9FE;color:#5B21B6;font-weight:600;}
.cai-rail-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
.cai-rail-del{opacity:0;color:#94A3B8;display:flex;}
.cai-rail-item:hover .cai-rail-del{opacity:1;}
.cai-rail-del:hover{color:#E11D48;}

.cai-main{flex:1;display:flex;flex-direction:column;min-width:0;}
.cai-head{display:flex;align-items:center;justify-content:space-between;padding:12px 22px;border-bottom:1px solid #E2E8F0;background:#fff;}
.cai-head-title{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:700;}
.cai-rail-toggle{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;border:1px solid #E2E8F0;background:#fff;color:#475569;cursor:pointer;}
.cai-rail-toggle:hover{background:#F1F5F9;}
.cai-head-right{display:flex;align-items:center;gap:10px;}
.cai-modelpick{position:relative;}
.cai-modelbtn{display:flex;align-items:center;gap:6px;padding:6px 12px;font-size:13px;font-weight:600;color:#334155;background:#F1F5F9;border:1px solid #E2E8F0;border-radius:8px;cursor:pointer;}
.cai-modelbtn:hover{background:#E2E8F0;}
.cai-modelmenu{position:absolute;right:0;top:38px;width:200px;background:#fff;border:1px solid #E2E8F0;border-radius:10px;box-shadow:0 12px 30px rgba(15,23,42,.12);padding:6px;z-index:30;}
.cai-modelopt{width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:8px 10px;border-radius:7px;border:none;background:transparent;cursor:pointer;text-align:left;}
.cai-modelopt:hover{background:#F1F5F9;}
.cai-modelopt.active{background:#EDE9FE;}
.cai-modelopt-label{font-size:13px;font-weight:600;color:#0F172A;}
.cai-modelopt-sub{font-size:11px;color:#94A3B8;}
.cai-canvastoggle{padding:6px;border:1px solid #E2E8F0;border-radius:8px;background:#fff;color:#475569;cursor:pointer;}

.cai-thread{flex:1;overflow-y:auto;padding:26px 0;}
.cai-welcome{max-width:560px;margin:8vh auto 0;text-align:center;padding:0 24px;}
.cai-welcome-icon{width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#7C3AED,#A78BFA);color:#fff;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;}
.cai-welcome h2{font-size:22px;font-weight:700;margin-bottom:10px;}
.cai-welcome p{font-size:14px;color:#64748B;line-height:1.6;}

.cai-row{max-width:760px;margin:0 auto;padding:8px 24px;display:flex;gap:12px;}
.cai-row.user{justify-content:flex-end;}
.cai-avatar{width:30px;height:30px;flex-shrink:0;border-radius:9px;background:linear-gradient(135deg,#7C3AED,#A78BFA);color:#fff;display:flex;align-items:center;justify-content:center;}
.cai-bubble{max-width:88%;border-radius:14px;padding:11px 15px;font-size:14px;line-height:1.65;}
.cai-bubble.user{background:#0F172A;color:#fff;border-bottom-right-radius:4px;}
.cai-bubble.assistant{background:#fff;border:1px solid #E2E8F0;color:#0F172A;border-bottom-left-radius:4px;}
.cai-usertext{white-space:pre-wrap;}
.cai-caret{display:inline-block;width:7px;height:15px;background:#7C3AED;margin-left:2px;vertical-align:text-bottom;animation:caiblink 1s steps(2) infinite;}
@keyframes caiblink{0%,50%{opacity:1}50.01%,100%{opacity:0}}
.cai-typing{display:inline-flex;gap:4px;}
.cai-typing span{width:6px;height:6px;border-radius:50%;background:#CBD5E1;animation:caibounce 1.2s infinite;}
.cai-typing span:nth-child(2){animation-delay:.15s}.cai-typing span:nth-child(3){animation-delay:.3s}
@keyframes caibounce{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-4px);opacity:1}}

.cai-md p{margin:0 0 8px;}.cai-md p:last-child{margin-bottom:0;}
.cai-md .cai-h{font-weight:700;margin:10px 0 6px;}
.cai-md h2{font-size:17px;}.cai-md h3{font-size:15px;}.cai-md h4{font-size:14px;}
.cai-md .cai-ul,.cai-md .cai-ol{margin:4px 0 8px;padding-left:20px;}
.cai-md li{margin:2px 0;}
.cai-md .cai-code{background:#F1F5F9;border-radius:4px;padding:1px 5px;font-family:'JetBrains Mono',monospace;font-size:12.5px;}
.cai-md .cai-pre{background:#0F172A;color:#E2E8F0;border-radius:8px;padding:12px;overflow-x:auto;margin:8px 0;font-size:12.5px;}
.cai-md .cai-pre code{font-family:'JetBrains Mono',monospace;}

.cai-composer-wrap{padding:14px 24px 18px;border-top:1px solid #E2E8F0;background:#fff;}
.cai-attach-chip{display:inline-flex;align-items:center;gap:6px;max-width:280px;margin:0 auto 8px;padding:5px 10px;background:#EDE9FE;color:#5B21B6;border-radius:8px;font-size:12px;font-weight:600;}
.cai-attach-chip button{display:flex;color:#7C3AED;}
.cai-composer{max-width:760px;margin:0 auto;display:flex;align-items:flex-end;gap:8px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:16px;padding:8px 8px 8px 8px;}
.cai-composer:focus-within{border-color:#A78BFA;box-shadow:0 0 0 3px rgba(124,58,237,.1);}
.cai-plus{position:relative;}
.cai-plusbtn{width:36px;height:36px;border-radius:10px;border:none;background:#fff;border:1px solid #E2E8F0;color:#475569;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.cai-plusbtn:hover{background:#F1F5F9;}
.cai-menu{position:absolute;bottom:46px;left:0;width:190px;background:#fff;border:1px solid #E2E8F0;border-radius:12px;box-shadow:0 12px 30px rgba(15,23,42,.14);padding:6px;z-index:30;}
.cai-menu button{width:100%;display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:8px;border:none;background:transparent;font-size:13px;color:#334155;cursor:pointer;text-align:left;}
.cai-menu button:hover{background:#F1F5F9;}
.cai-textarea{flex:1;resize:none;border:none;background:transparent;outline:none;font-size:14px;line-height:1.5;padding:8px 4px;max-height:180px;font-family:inherit;color:#0F172A;}
.cai-send{width:36px;height:36px;border-radius:10px;border:none;background:#7C3AED;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.15s;}
.cai-send:hover{background:#6D28D9;}
.cai-send:disabled{background:#CBD5E1;cursor:not-allowed;}
.cai-send.stop{background:#0F172A;}
.cai-stop-sq{width:11px;height:11px;background:#fff;border-radius:2px;}
.cai-hint{max-width:760px;margin:8px auto 0;font-size:11px;color:#94A3B8;display:flex;align-items:center;gap:5px;justify-content:center;}

.cai-canvas{width:460px;flex-shrink:0;background:#fff;border-left:1px solid #E2E8F0;display:flex;flex-direction:column;overflow:hidden;position:relative;}
.cai-canvas-resizer{position:absolute;left:0;top:0;bottom:0;width:8px;cursor:col-resize;z-index:8;}
.cai-canvas-resizer:hover{background:linear-gradient(90deg,rgba(124,58,237,.25),transparent);}
.cai-canvas-resizer:active{background:linear-gradient(90deg,rgba(124,58,237,.4),transparent);}
.cai-canvas-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #E2E8F0;font-size:13px;font-weight:700;color:#0F172A;}
.cai-canvas-head button{color:#94A3B8;display:flex;}
.cai-canvas-body{flex:1;overflow-y:auto;padding:14px;}

/* inline agent dashboard message (full thread width, no row table) */
.cai-agent-msg{max-width:900px;margin:10px auto;padding:0 24px;}
.cai-agent-msg-head{display:flex;align-items:center;gap:9px;font-size:13.5px;color:#0F172A;margin-bottom:10px;}
.cai-agent-msg-head span{flex:1;}
.cai-agent-msg-excel{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#7C3AED;background:#F5F3FF;border:1px solid #DDD6FE;border-radius:8px;padding:5px 10px;cursor:pointer;}
.cai-agent-msg-excel:hover{background:#EDE9FE;}
.cai-agent-msg-dash{background:#fff;border:1px solid #E2E8F0;border-radius:14px;padding:16px;}
.cai-note{max-width:760px;margin:0 auto;font-size:12.5px;color:#64748B;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:8px 14px;}
.cai-row.user .cai-note{margin-right:0;}

/* canvas expand + head actions */
.cai-canvas.expanded{position:fixed;inset:0;width:100%;z-index:60;border-left:none;}
.cai-canvas-head-actions{display:flex;align-items:center;gap:10px;}
.cai-canvas-head-actions button{color:#94A3B8;display:flex;}
.cai-canvas-head-actions button:hover{color:#475569;}

/* Excel viewer (right canvas) — Claude-style spreadsheet */
.cai-xl{display:flex;flex-direction:column;height:100%;}
.cai-xl-center{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;color:#94A3B8;font-size:13px;padding:24px;text-align:center;}
.cai-xl-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border-bottom:1px solid #E2E8F0;background:#fff;flex-shrink:0;}
.cai-xl-name{font-size:12px;font-weight:600;color:#475569;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cai-xl-actions{display:flex;align-items:center;gap:7px;flex-shrink:0;}
.cai-xl-btn{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#334155;background:#fff;border:1px solid #E2E8F0;border-radius:8px;padding:6px 10px;cursor:pointer;}
.cai-xl-btn:hover{background:#F1F5F9;}
.cai-xl-btn.drive{border-color:#C7D2FE;}
.cai-xl-btn:disabled{opacity:.6;cursor:default;}
.cai-xl-scroll{flex:1;overflow:auto;background:#fff;}
.cai-xl-grid{border-collapse:separate;border-spacing:0;font-size:12px;font-variant-numeric:tabular-nums;}
.cai-xl-grid th,.cai-xl-grid td{border-right:1px solid #E7EBF0;border-bottom:1px solid #E7EBF0;white-space:nowrap;}
.cai-xl-corner{position:sticky;top:0;left:0;z-index:3;background:#EEF2F6;width:42px;min-width:42px;}
.cai-xl-collbl{position:sticky;top:0;z-index:2;background:#EEF2F6;color:#64748B;font-weight:600;text-align:center;padding:4px 10px;min-width:90px;}
.cai-xl-rownum{position:sticky;left:0;z-index:1;background:#F4F7FA;color:#94A3B8;font-weight:600;text-align:center;width:42px;min-width:42px;padding:4px 6px;}
.cai-xl-cell{padding:5px 10px;color:#0F172A;max-width:340px;overflow:hidden;text-overflow:ellipsis;}
.cai-xl-cell.num{text-align:right;font-variant-numeric:tabular-nums;}
.cai-xl-note{padding:7px 12px;font-size:11px;color:#94A3B8;border-top:1px solid #E2E8F0;background:#fff;flex-shrink:0;}
.cai-xl-tabs{display:flex;gap:3px;overflow-x:auto;padding:6px 10px;border-top:1px solid #E2E8F0;background:#F8FAFC;flex-shrink:0;}
.cai-xl-tab{font-size:12px;font-weight:600;color:#64748B;background:#fff;border:1px solid #E2E8F0;border-radius:0;border-bottom:2px solid transparent;padding:6px 14px;cursor:pointer;white-space:nowrap;}
.cai-xl-tab:hover{background:#F1F5F9;}
.cai-xl-tab.active{color:#0F766E;background:#fff;border-bottom-color:#0F766E;}

.cai-agent{display:flex;flex-direction:column;gap:10px;}
.cai-agent-lead{font-size:12.5px;color:#64748B;line-height:1.5;}
.cai-agent-grid{display:flex;flex-direction:column;gap:8px;}
.cai-agent-card{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #E2E8F0;border-radius:10px;background:#fff;font-size:13px;font-weight:600;color:#334155;cursor:pointer;text-align:left;}
.cai-agent-card:hover{border-color:#A78BFA;background:#FAF5FF;}
.cai-agent-back{align-self:flex-start;font-size:12px;color:#7C3AED;background:none;border:none;cursor:pointer;padding:0;}
.cai-agent-name{font-size:16px;font-weight:700;}
.cai-field-label{font-size:11px;font-weight:700;color:#64748B;text-transform:uppercase;letter-spacing:.04em;margin-top:4px;}
.cai-select,.cai-tol-input,.cai-input{width:100%;padding:9px 11px;border:1px solid #E2E8F0;border-radius:9px;font-size:13px;color:#0F172A;background:#fff;outline:none;}
.cai-select:focus,.cai-tol-input:focus,.cai-input:focus{border-color:#A78BFA;}
.cai-state-group{border:1px solid #E2E8F0;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:7px;background:#F8FAFC;}
.cai-state-head{font-size:12px;font-weight:700;color:#475569;display:flex;align-items:center;justify-content:space-between;}
.cai-state-head button{color:#94A3B8;display:flex;}
.cai-addstate{display:flex;align-items:center;gap:6px;align-self:flex-start;font-size:12px;font-weight:600;color:#7C3AED;background:none;border:1px dashed #C4B5FD;border-radius:8px;padding:7px 11px;cursor:pointer;}
.cai-slot{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border:1px solid #E2E8F0;border-radius:9px;background:#fff;cursor:pointer;}
.cai-slot:hover{border-color:#A78BFA;}
.cai-slot-left{display:flex;align-items:center;gap:10px;}
.cai-slot-label{font-size:13px;font-weight:600;color:#0F172A;}
.cai-req{color:#E11D48;margin-left:2px;}
.cai-slot-hint{font-size:11px;color:#94A3B8;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cai-tol{display:flex;flex-direction:column;gap:4px;}
.cai-runbtn{display:flex;align-items:center;justify-content:center;gap:8px;padding:11px;border-radius:10px;border:none;background:#7C3AED;color:#fff;font-size:13px;font-weight:700;cursor:pointer;margin-top:4px;}
.cai-runbtn:hover{background:#6D28D9;}
.cai-runbtn:disabled{background:#CBD5E1;cursor:not-allowed;}

.cai-so-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.4);z-index:60;display:flex;justify-content:flex-end;}
.cai-so{width:420px;max-width:92vw;height:100%;background:#fff;display:flex;flex-direction:column;box-shadow:-12px 0 40px rgba(15,23,42,.2);}
.cai-so-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #E2E8F0;font-size:15px;font-weight:700;}
.cai-so-head button{color:#94A3B8;display:flex;}
.cai-so-body{flex:1;overflow-y:auto;padding:16px 18px;}
.cai-so-empty{font-size:13px;color:#94A3B8;text-align:center;margin-top:20px;}
.cai-so-grid{display:flex;flex-direction:column;gap:10px;}
.cai-so-card{display:flex;align-items:center;gap:12px;padding:12px;border:1px solid #E2E8F0;border-radius:10px;}
.cai-so-meta{flex:1;}
.cai-so-name{font-size:13px;font-weight:600;color:#0F172A;}
.cai-so-status{font-size:11px;color:#94A3B8;font-weight:600;}
.cai-so-status.on{color:#059669;}
.cai-mcp-form{display:flex;flex-direction:column;gap:8px;margin-bottom:18px;}
.cai-mcp-list{display:flex;flex-direction:column;gap:8px;}
.cai-mcp-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #E2E8F0;border-radius:10px;}
.cai-mcp-meta{flex:1;min-width:0;}
.cai-mcp-url{font-size:11px;color:#94A3B8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cai-mcp-badge{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#5B21B6;background:#EDE9FE;padding:3px 8px;border-radius:9999px;}
.cai-mcp-del{color:#94A3B8;display:flex;}.cai-mcp-del:hover{color:#E11D48;}
.cai-centered{display:flex;justify-content:center;padding:30px;color:#94A3B8;}
.hidden{display:none;}
`;

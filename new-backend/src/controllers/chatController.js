/* ── Colonel AI — GenSpark chat (streaming) ─────────────────────────────────
   POST /api/chat  — auth required.
   Body: { conversationId?, model?, messages: [{role, content}], system? }

   Streams the assistant reply to the browser as Server-Sent Events (SSE):
     event: delta   data: {"text": "..."}      ← incremental text tokens
     event: usage   data: {"input_tokens": N, "output_tokens": N}
     event: done    data: {"text": "<full>"}   ← full assistant text once
     event: error   data: {"error": "..."}

   Uses GenSpark's OpenAI-compatible LLM proxy (real Claude models) — the same
   proxy the workflow builder uses. Node fetch, no SDK. If the proxy streams
   (text/event-stream) we forward token deltas; otherwise we emit the full reply
   as one delta. File processing / reco runs (Agent mode) go through the Python
   reco engine and never touch this endpoint.                                   */

const { Conversation } = require('../models/master');
const { llmComplete } = require('../ai/llmProviders');
const { buildDashboardContext } = require('../ai/dashboardContext');

// GenSpark LLM proxy — OpenAI-compatible chat completions, proxying real Claude
// model IDs (confirmed live in workflowAiController). Configured via env.
const GSK_BASE_URL = process.env.GSK_BASE_URL || 'https://www.genspark.ai/api/llm_proxy/v1';
// Chat uses its own model var (NOT GSK_MODEL, which the workflow builder points
// at a heavier model). Default: Haiku 4.5 — fast + cheap for interactive chat.
const DEFAULT_MODEL = process.env.CHAT_MODEL || 'claude-haiku-4-5';
// Claude model IDs GenSpark accepts. Anything else the UI sends (e.g. legacy
// gemini-* picker values) falls back to the default so chat always works.
const MODEL_WHITELIST = new Set([
  'claude-haiku-4-5',
  'claude-opus-4-8',
  'claude-sonnet-4-5',
]);

const SYSTEM_PROMPT = `You are Colonel AI, the in-app assistant for Colonel — an automation platform built for an Indian Chartered Accountancy firm that manages reconciliation and accounting for multiple D2C / e-commerce brands.

You help accountants and admins understand and work with the platform. You are knowledgeable about Indian GST (GSTR-1, GSTR-2B, GSTR-3B, ITC, RCM), reconciliation, Tally, bank statement classification, and e-commerce settlement.

The platform has these reconciliation agents:
- GSTR-2B vs Books — GSTR-2B portal data vs Purchase Register + Debit Note Register.
- GSTR-2B vs Books (Multi-State) — same, for brands with multiple GSTINs; flags cross-state booking errors.
- GSTR-3B Tally Entry — parses GSTR-3B into ready-to-post Tally journal entries.
- Universal Bank Statement — classifies any Indian bank statement against the Tally chart of accounts.
- GSTR-1 vs Books — GSTR-1 outward supplies vs Tally sales register.

IMPORTANT: To actually RUN a reconciliation on real files, the user uses "Agent mode" — you do NOT run reconciliations or process uploaded files yourself. Agent mode runs the platform's own engine; the dashboard appears inline in this chat and the output Excel opens on the right.

HOW TO GUIDE USERS THROUGH THE UI (use these exact steps when someone asks "how do I use / run X"):
- Run a reconciliation: "Click the **+** button below the chat → **Agent** → pick the tool (e.g. **GSTR-2B vs Books (Multi-State)**) → choose your **brand** → upload the required files (or paste a **Google Drive** link) → click **Run**. The dashboard appears here in the chat and the output Excel opens on the right — use **Download Excel** there for the full file."
  - GSTR-2B vs Books: upload GSTR-2B, Purchase Register, Debit Note Register.
  - GSTR-2B vs Books (Multi-State): per state upload GSTR-2B, Purchase Register, Debit Note; use **Add another state** for more GSTINs.
  - GSTR-2A vs 2B vs Books (3-way): GSTR-2B, Purchase Register, Debit Note Register.
  - GSTR-3B vs GSTR-2B: GSTR-3B working file + GSTR-2B file.
  - GSTR-1 vs Books: Tally Sales Register + GSTR-1 OCTA report (optional GSTR-1 PDF, Credit Note Register).
  - Universal Bank Statement: the bank statement (optional Ledger Master / chart of accounts, saved for next time).
  - GSTR-3B Tally Entry: the GSTR-3B file.
- Attach a file to a message: **+ → Attach file**.
- Report a problem / give feedback: **+ → Feedback**, then type what's wrong and send — it becomes a task for the engineering team.
- Connectors (Google, Tally, Zoho, etc.): **+ → Connectors**. Register an MCP server: **+ → MCP servers**.

When a CURRENT RECONCILIATION CONTEXT section is present below, the user has just run a reconciliation — use that data to answer questions about specific entries (e.g. "why is invoice 123 partially matched?") by citing its remarks (Remark 1 = match status; Remark 2 = the reason, such as "Tax Amount Mismatch, Excess in 2B"; Remark 3 = cross-state booking error). If they ask about an entry not in the context, say you can only see the rows from the last run.

When a DASHBOARD DATA section is present below, the chat has been scoped to a specific brand (and possibly one agent). It is a live snapshot of that brand's reconciliation dashboard — run counts, rows processed, matched vs unmatched, match rate, per-agent breakdown, and recent runs. Answer the user's questions about their usage and history from those figures and cite the numbers. If the user asks you to "summarise the dashboard" (or anything similar), write the summary directly from that section — the key totals, the match rate, the busiest agents, and what the recent runs show — and never ask them for a screenshot, a link, or which report they mean. Do not invent data that is not in that section; if something is not shown, say the dashboard does not cover it.

Be concise, accurate, and practical. Use Indian accounting terminology. Format with markdown (headings, lists, bold, tables, code) when it helps.`;

/* Coerce incoming messages → OpenAI chat messages (role: user | assistant). */
const toOpenAiMessages = (messages) =>
  (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
    }))
    .filter((m) => m.content.trim().length > 0);

const streamChat = async (req, res, next) => {
  if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Colonel AI is not configured. Set GEMINI_API_KEY or ANTHROPIC_API_KEY on the backend.' });
  }

  const { conversationId, system, context, brandId, agentType, brandName, agentLabel } = req.body || {};
  const model = MODEL_WHITELIST.has(req.body?.model) ? req.body.model : DEFAULT_MODEL;
  const convo = toOpenAiMessages(req.body?.messages);

  if (convo.length === 0) {
    return res.status(400).json({ error: 'messages is required' });
  }

  let systemPrompt = system && String(system).trim() ? String(system) : SYSTEM_PROMPT;
  if (context && String(context).trim()) {
    systemPrompt += `\n\nCURRENT RECONCILIATION CONTEXT (the user just ran this — use it to answer questions about specific entries):\n${String(context).slice(0, 12000)}`;
  }

  // Scoped-to-a-brand chat → attach a live snapshot of that brand's dashboard
  // (reco_jobs). Read-only + brand-access gated inside buildDashboardContext;
  // returns null on no access / no data / any error, so chat still works.
  if (brandId) {
    try {
      const dash = await buildDashboardContext({ user: req.user, brandId, agentType, brandName, agentLabel });
      if (dash) {
        systemPrompt += `\n\n${dash}`;
        console.log('[chat] dashboard context attached', { brandId, agentType: agentType || null, chars: dash.length });
      } else {
        console.log('[chat] dashboard context skipped (no access / no data)', { brandId });
      }
    } catch (e) { console.warn('[chat] dashboard context error:', e.message); }
  }

  // SSE handshake
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let fullText = '';
  let aborted = false;
  let usage = null;
  req.on('close', () => { aborted = true; });

  try {
    // GenSpark retired (credits exhausted) → Gemini primary, Claude fallback.
    // Non-streaming under the hood; emit the full reply as one delta so the
    // SSE contract (delta/usage/done) stays identical for the chat UI.
    const { text, usage: u } = await llmComplete({ system: systemPrompt, messages: convo, maxTokens: 4096, temperature: 0.7 });
    fullText = text || '';
    usage = u || null;
    if (fullText && !aborted) send('delta', { text: fullText });

    if (!aborted) {
      if (usage) send('usage', { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 });
      send('done', { text: fullText, model });
    }

    // Persist the completed turn to the owner's conversation (fire-and-forget).
    if (conversationId && fullText) {
      setImmediate(async () => {
        try {
          const c = await Conversation.findOne({ where: { id: conversationId, user_id: req.user.id } });
          if (!c) return;
          const next = [...(c.messages || []), { role: 'assistant', content: fullText }];
          await c.update({ messages: next, model });
        } catch (e) { console.warn('[chat] persist failed:', e.message); }
      });
    }
  } catch (err) {
    console.error('[chat] stream error:', err);
    if (!aborted) { try { send('error', { error: err?.message || 'Chat failed' }); } catch (_) {} }
  } finally {
    if (!aborted) res.end();
  }
};

module.exports = { streamChat };

/* ── Colonel AI — Anthropic chat (streaming) ────────────────────────────────
   POST /api/chat  — auth required.
   Body: { conversationId?, model?, messages: [{role, content}], system? }

   Streams the assistant reply to the browser as Server-Sent Events (SSE):
     event: delta   data: {"text": "..."}      ← incremental text tokens
     event: usage   data: {"input_tokens": N, "output_tokens": N}
     event: done    data: {"text": "<full>"}   ← full assistant text once
     event: error   data: {"error": "..."}

   Claude API is used ONLY for this freeform conversation. File processing,
   reco runs, and dashboards (Agent mode) go through the Python reco engine and
   ToolResultDashboard — they never touch this endpoint.                       */

const { Conversation } = require('../models/master');

// Lazy-load the SDK so the backend still boots if the package isn't installed
// yet (the /api/chat route then returns a clean 503 instead of crashing boot).
let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { /* not installed yet */ }

// Models the picker is allowed to use. Default = Sonnet (cost-controlled).
const MODEL_WHITELIST = new Set([
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);
const DEFAULT_MODEL = 'claude-sonnet-4-6';

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
- Run a reconciliation: "Click the **+** button below the chat → **Agent** → pick the tool (e.g. **GSTR-2B vs Books (Multi-State)**) → choose your **brand** → upload the required files → click **Run**. The dashboard appears here in the chat and the output Excel opens on the right — use **Download Excel** there for the full file."
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

Be concise, accurate, and practical. Use Indian accounting terminology. Format with markdown (headings, lists, bold, tables, code) when it helps.`;

const getClient = () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !Anthropic) return null;
  return new Anthropic({ apiKey });
};

/* Coerce the incoming messages to the Anthropic shape and drop anything empty. */
const normalizeMessages = (messages) =>
  (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
    }))
    .filter((m) => m.content.trim().length > 0);

const streamChat = async (req, res, next) => {
  const client = getClient();
  if (!client) {
    return res.status(503).json({
      error: 'Colonel AI is not configured. Set ANTHROPIC_API_KEY on the backend.',
    });
  }

  const { conversationId, system, context } = req.body || {};
  const model = MODEL_WHITELIST.has(req.body?.model) ? req.body.model : DEFAULT_MODEL;
  const messages = normalizeMessages(req.body?.messages);

  // Base system prompt (caller override or the Colonel prompt) + optional
  // run context (the latest Agent run) so the model can explain specific rows.
  let systemPrompt = system && String(system).trim() ? String(system) : SYSTEM_PROMPT;
  if (context && String(context).trim()) {
    systemPrompt += `\n\nCURRENT RECONCILIATION CONTEXT (the user just ran this — use it to answer questions about specific entries):\n${String(context).slice(0, 12000)}`;
  }

  if (messages.length === 0) {
    return res.status(400).json({ error: 'messages is required' });
  }

  // SSE handshake
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',           // disable proxy buffering (nginx/ngrok)
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let fullText = '';
  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });

    stream.on('text', (delta) => {
      if (aborted) return;
      fullText += delta;
      send('delta', { text: delta });
    });

    const final = await stream.finalMessage();

    if (!aborted) {
      if (final?.usage) {
        send('usage', {
          input_tokens: final.usage.input_tokens,
          output_tokens: final.usage.output_tokens,
        });
      }
      send('done', { text: fullText, model });
    }

    // Persist the completed turn to the owner's conversation (fire-and-forget,
    // strictly scoped to the caller so it can't write to someone else's chat).
    if (conversationId && fullText) {
      setImmediate(async () => {
        try {
          const convo = await Conversation.findOne({
            where: { id: conversationId, user_id: req.user.id },
          });
          if (!convo) return;
          const next = [...(convo.messages || []), { role: 'assistant', content: fullText }];
          await convo.update({ messages: next, model });
        } catch (e) {
          console.warn('[chat] persist failed:', e.message);
        }
      });
    }
  } catch (err) {
    console.error('[chat] stream error:', err);
    if (!aborted) {
      try { send('error', { error: err?.message || 'Chat failed' }); } catch (_) {}
    }
  } finally {
    if (!aborted) res.end();
  }
};

module.exports = { streamChat };

/* ── Colonel AI — Gemini chat (streaming) ───────────────────────────────────
   POST /api/chat  — auth required.
   Body: { conversationId?, model?, messages: [{role, content}], system? }

   Streams the assistant reply to the browser as Server-Sent Events (SSE):
     event: delta   data: {"text": "..."}      ← incremental text tokens
     event: usage   data: {"input_tokens": N, "output_tokens": N}
     event: done    data: {"text": "<full>"}   ← full assistant text once
     event: error   data: {"error": "..."}

   Uses Google Gemini (generativelanguage API) via streaming REST — no SDK
   needed (Node fetch). File processing, reco runs and dashboards (Agent mode)
   go through the Python reco engine and never touch this endpoint.            */

const { Conversation } = require('../models/master');

// Gemini models the picker may use. Anything else (e.g. legacy Claude ids the
// UI might still send) falls back to the default so chat always works.
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MODEL_WHITELIST = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
]);
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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

/* Coerce incoming messages → Gemini "contents" (role: user | model). */
const toGeminiContents = (messages) =>
  (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content ?? '') }],
    }))
    .filter((m) => m.parts[0].text.trim().length > 0);

const streamChat = async (req, res, next) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Colonel AI is not configured. Set GEMINI_API_KEY on the backend.' });
  }

  const { conversationId, system, context } = req.body || {};
  const model = MODEL_WHITELIST.has(req.body?.model) ? req.body.model : DEFAULT_MODEL;
  const contents = toGeminiContents(req.body?.messages);

  let systemPrompt = system && String(system).trim() ? String(system) : SYSTEM_PROMPT;
  if (context && String(context).trim()) {
    systemPrompt += `\n\nCURRENT RECONCILIATION CONTEXT (the user just ran this — use it to answer questions about specific entries):\n${String(context).slice(0, 12000)}`;
  }

  if (contents.length === 0) {
    return res.status(400).json({ error: 'messages is required' });
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
    const url = `${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 4096, temperature: 0.7 },
      }),
    });

    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '');
      let msg = `Gemini error ${resp.status}`;
      try { msg = JSON.parse(errText)?.error?.message || msg; } catch (_) {}
      send('error', { error: msg });
      return res.end();
    }

    // Parse the SSE stream from Gemini (data: {chunk}\n\n).
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      if (aborted) { try { await reader.cancel(); } catch (_) {} break; }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let obj; try { obj = JSON.parse(payload); } catch (_) { continue; }
        const parts = obj?.candidates?.[0]?.content?.parts || [];
        for (const p of parts) {
          if (p && typeof p.text === 'string' && !p.thought) {
            fullText += p.text;
            if (!aborted) send('delta', { text: p.text });
          }
        }
        if (obj?.usageMetadata) usage = obj.usageMetadata;
      }
    }

    if (!aborted) {
      if (usage) send('usage', { input_tokens: usage.promptTokenCount || 0, output_tokens: usage.candidatesTokenCount || 0 });
      send('done', { text: fullText, model });
    }

    // Persist the completed turn to the owner's conversation (fire-and-forget).
    if (conversationId && fullText) {
      setImmediate(async () => {
        try {
          const convo = await Conversation.findOne({ where: { id: conversationId, user_id: req.user.id } });
          if (!convo) return;
          const next = [...(convo.messages || []), { role: 'assistant', content: fullText }];
          await convo.update({ messages: next, model });
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

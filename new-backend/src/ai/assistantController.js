/* ── Colonel AI — "Ask Colonel AI" assistant controller ─────────────────────
   POST /api/ai/ask            — auth required. Streams the answer as SSE.
     Body: { messages:[{role,content}], screen?, conversationId?, model? }
     screen = { route, agentType, agentLabel, brandId, brandName, hasResult, resultSummary? }
   GET  /api/ai/suggestions    — auth required. { route?, agentType?, hasResult? }

   Router (cheapest gate first), reusing the GenSpark chat + per-user history:
     [0] pre-gate (NO LLM)   — secrets/infra + code requests → canned refusal, 0 tokens.
     [1] heuristic intent    — app_help / finance / general → scoped system prompt.
     [ ] data / run_agent    — DEFERRED (read-only DB tool + reco-engine dispatch are
                               follow-on plans). Until then those questions are answered
                               by the scoped model WITHOUT inventing data, and the prompt
                               tells the user to use the agent's Run flow for processing.

   Additive: no agent/reco logic touched. Read-only w.r.t. the DB except the
   fire-and-forget append of the assistant turn to the caller's own conversation
   (same pattern + same per-user scoping as chatController).                    */

const { streamGenspark, pickModel } = require('./genspark');
const { preGate, heuristicIntent } = require('./router');
const { resolveScope } = require('./scope');
const { getHelp } = require('./help/screenHelp');
const { buildSystemPrompt } = require('./prompts');
const { Conversation } = require('../models/master');

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/* Coerce incoming messages → {role:'user'|'assistant', content} (drop empties). */
const toMessages = (messages) =>
  (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
    }))
    .filter((m) => m.content.trim().length > 0);

const lastUserText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
};

/* Fire-and-forget: append the assistant turn to the OWNER's conversation only.
   Never widens scope — mirrors chatController's persistence + per-user rule. */
const persistAssistant = (conversationId, userId, text, model) => {
  if (!conversationId || !text) return;
  setImmediate(async () => {
    try {
      const c = await Conversation.findOne({ where: { id: conversationId, user_id: userId } });
      if (!c) return;
      const next = [...(c.messages || []), { role: 'assistant', content: text }];
      await c.update({ messages: next, model });
    } catch (e) {
      console.warn('[ai] persist failed:', e.message);
    }
  });
};

/* POST /api/ai/ask */
async function ask(req, res) {
  const { screen, conversationId } = req.body || {};
  const messages = toMessages(req.body?.messages);
  if (messages.length === 0) {
    return res.status(400).json({ error: 'messages is required' });
  }
  const userText = lastUserText(messages);

  // [0] Pre-gate — canned refusal, NO LLM call (0 tokens). This is the
  // security fence: secrets/infra fishing and code-writing never reach the model.
  const gate = preGate(userText);
  if (gate) {
    res.writeHead(200, SSE_HEADERS);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    send('delta', { text: gate.text });
    send('done', { text: gate.text, model: 'guard' });
    res.end();
    persistAssistant(conversationId, req.user.id, gate.text, 'guard');
    return;
  }

  // [1] Scope + intent → scoped, guardrailed system prompt (no DB in this plan).
  const scope = resolveScope({ screen, user: req.user });
  const intent = heuristicIntent(userText);
  const help =
    intent === 'app_help'
      ? getHelp({ route: screen?.route, agentType: screen?.agentType, hasResult: screen?.hasResult })
      : null;
  const system = buildSystemPrompt({ scope: scope.mode, screen, helpBlurb: help?.blurb, intent });
  const model = pickModel(req.body?.model);

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const { fullText } = await streamGenspark({
      res,
      model,
      system,
      messages,
      isAborted: () => aborted,
    });
    persistAssistant(conversationId, req.user.id, fullText, model);
  } catch (err) {
    console.error('[ai] ask error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'Colonel AI failed' });
    } else if (!res.writableEnded) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: err?.message || 'Colonel AI failed' })}\n\n`);
      } catch (_) { /* ignore */ }
      res.end();
    }
  }
}

/* GET /api/ai/suggestions?route=&agentType=&hasResult= */
async function suggestions(req, res) {
  const { route, agentType, hasResult } = req.query || {};
  const h = getHelp({ route, agentType, hasResult: hasResult === 'true' });
  res.json({ title: h.title, suggestions: h.suggestions });
}

module.exports = { ask, suggestions };

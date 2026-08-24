/* ── Colonel AI — reusable GenSpark helper ──────────────────────────────────
   Extracted from `controllers/chatController.js`'s inline fetch/SSE logic so
   any route (chat, screen-scoped "Ask Colonel AI", internal short calls) can
   share one implementation of the GenSpark OpenAI-compatible LLM proxy.

   Exposes:
     - streamGenspark({ res, model, system, messages, maxTokens, temperature })
       Streams an SSE reply onto an Express `res` using the same wire format
       as chatController: `delta`, `usage`, `done`, `error`.
     - callGenspark({ model, system, messages, maxTokens, temperature })
       Non-streaming, for short internal calls (e.g. intent routing). Returns
       { text, usage } or throws.
     - pickModel(m) — validates a client-supplied model id against the
       whitelist, falling back to CHAT_MODEL.

   Nothing here changes reco/agent logic — additive only.               */

const { llmComplete } = require('./llmProviders');

const GSK_BASE_URL = process.env.GSK_BASE_URL || 'https://www.genspark.ai/api/llm_proxy/v1';

// Assistant chat/help uses its own model var (NOT GSK_MODEL, which the
// workflow builder points at a heavier model). Default: Haiku 4.5 — fast +
// cheap for interactive use.
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-haiku-4-5';

// Claude model IDs GenSpark accepts. Anything else a caller passes falls
// back to CHAT_MODEL so the assistant always works.
const MODEL_WHITELIST = new Set([
  'claude-haiku-4-5',
  'claude-opus-4-8',
  'claude-sonnet-4-5',
]);

function pickModel(m) {
  return MODEL_WHITELIST.has(m) ? m : CHAT_MODEL;
}

/**
 * Stream a GenSpark chat completion onto an Express response as SSE.
 * Mirrors chatController's fetch/parse logic exactly so the wire contract
 * (`delta`, `usage`, `done`, `error`) stays identical for every caller.
 *
 * @param {object} opts
 * @param {import('express').Response} opts.res
 * @param {string} [opts.model]
 * @param {string} opts.system
 * @param {{role:'user'|'assistant', content:string}[]} opts.messages
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {() => boolean} [opts.isAborted] - optional external abort getter
 * @returns {Promise<{fullText: string, usage: object|null}>}
 */
async function streamGenspark({ res, model, system, messages, maxTokens = 2048, temperature = 0.4, isAborted } = {}) {
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const apiKey = process.env.GSK_API_KEY;
  if (!apiKey) {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
    }
    send('error', { error: 'Colonel AI is not configured. Set GSK_API_KEY on the backend.' });
    if (!res.writableEnded) res.end();
    return { fullText: '', usage: null };
  }

  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  }

  const aborted = () => (typeof isAborted === 'function' ? isAborted() : false) || res.writableEnded;

  let fullText = '';
  let usage = null;

  try {
    // GenSpark retired (credits exhausted) → Gemini primary, Claude fallback.
    // Non-streaming under the hood; emit the full reply as one delta so the
    // wire contract (delta/usage/done) stays identical for every caller.
    const { text, usage: u, provider } = await llmComplete({ system, messages, maxTokens, temperature });
    fullText = text || '';
    usage = u || null;
    if (fullText && !aborted()) send('delta', { text: fullText });

    if (!aborted()) {
      if (usage) send('usage', { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 });
      send('done', { text: fullText, model: provider });
    }

    console.log('[ai] llm', { provider, in: usage?.prompt_tokens, out: usage?.completion_tokens });
  } catch (err) {
    console.error('[ai] genspark stream error:', err);
    if (!aborted()) { try { send('error', { error: err?.message || 'Colonel AI failed' }); } catch (_) {} }
  } finally {
    if (!aborted() && !res.writableEnded) res.end();
  }

  return { fullText, usage };
}

/**
 * Non-streaming GenSpark chat completion. For short internal calls (intent
 * routing, summarization, etc).
 *
 * @param {object} opts
 * @param {string} [opts.model]
 * @param {string} opts.system
 * @param {{role:'user'|'assistant', content:string}[]} opts.messages
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @returns {Promise<{text: string, usage: object|null}>}
 */
async function callGenspark({ model, system, messages, maxTokens = 256, temperature = 0 } = {}) {
  // GenSpark retired (credits exhausted) → Gemini primary, Claude fallback.
  const { text, usage, provider } = await llmComplete({ system, messages, maxTokens, temperature });
  console.log('[ai] llm', { provider, in: usage?.prompt_tokens, out: usage?.completion_tokens });
  return { text, usage };
}

module.exports = { streamGenspark, callGenspark, pickModel, CHAT_MODEL, MODEL_WHITELIST };

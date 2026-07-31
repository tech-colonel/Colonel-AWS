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

  const chosenModel = pickModel(model);
  const openAiMessages = [{ role: 'system', content: system || '' }, ...(Array.isArray(messages) ? messages : [])];

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
    const resp = await fetch(`${GSK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: chosenModel,
        messages: openAiMessages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '');
      let msg = `Colonel AI error ${resp.status}`;
      try { msg = JSON.parse(errText)?.error?.message || msg; } catch (_) {}
      send('error', { error: msg });
      if (!res.writableEnded) res.end();
      return { fullText: '', usage: null };
    }

    const contentType = resp.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      // OpenAI-style streaming: data: {choices:[{delta:{content}}]} … data: [DONE]
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        if (aborted()) { try { await reader.cancel(); } catch (_) {} break; }
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
          const delta = obj?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length) {
            fullText += delta;
            if (!aborted()) send('delta', { text: delta });
          }
          if (obj?.usage) usage = obj.usage;
        }
      }
    } else {
      // Proxy ignored `stream` → single JSON body. Emit the full reply at once.
      const data = await resp.json().catch(() => null);
      const text = data?.choices?.[0]?.message?.content || '';
      fullText = text;
      if (text && !aborted()) send('delta', { text });
      if (data?.usage) usage = data.usage;
    }

    if (!aborted()) {
      if (usage) send('usage', { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 });
      send('done', { text: fullText, model: chosenModel });
    }

    console.log('[ai] genspark', { model: chosenModel, in: usage?.prompt_tokens, out: usage?.completion_tokens });
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
  const apiKey = process.env.GSK_API_KEY;
  if (!apiKey) {
    throw new Error('Colonel AI is not configured. Set GSK_API_KEY on the backend.');
  }

  const chosenModel = pickModel(model);
  const openAiMessages = [{ role: 'system', content: system || '' }, ...(Array.isArray(messages) ? messages : [])];

  const resp = await fetch(`${GSK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: chosenModel,
      messages: openAiMessages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    let msg = `Colonel AI error ${resp.status}`;
    try { msg = JSON.parse(errText)?.error?.message || msg; } catch (_) {}
    throw new Error(msg);
  }

  const data = await resp.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content || '';
  const usage = data?.usage || null;

  console.log('[ai] genspark', { model: chosenModel, in: usage?.prompt_tokens, out: usage?.completion_tokens });

  return { text, usage };
}

module.exports = { streamGenspark, callGenspark, pickModel, CHAT_MODEL, MODEL_WHITELIST };

/* ── Colonel AI — provider fallback (Gemini primary → Claude fallback) ────────
   GenSpark credits are exhausted (it returns HTTP 200 with a "credits exhausted"
   message), so this module replaces it for the general-purpose AI features.

   Primary  : Gemini (native generateContent) — GEMINI_API_KEY / GEMINI_MODEL
   Fallback : Claude (Anthropic Messages)      — ANTHROPIC_API_KEY / ANTHROPIC_MODEL

   Exposes the same {text, usage} contract the old GenSpark helpers used, so the
   callers keep working unchanged. Nothing here touches reco/agent logic.        */

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

// GenSpark returns this text (HTTP 200) once credits run out — treat as a failure.
const EXHAUSTED_RE = /credits? (have|has)? ?been exhausted|purchase more credits/i;

function normMessages(system, messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  return { system: system || '', msgs };
}

/* ── Gemini (primary) ─────────────────────────────────────────────────────── */
async function geminiComplete({ system, messages, maxTokens = 2048, temperature = 0.4 } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const { system: sys, msgs } = normMessages(system, messages);
  const contents = msgs.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content == null ? '' : m.content) }],
  }));
  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      // 2.5-flash spends "thinking" tokens by default, which can swallow a small
      // budget and return empty. Disable it so output tokens go to the answer.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Gemini ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => null);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p?.text || '').join('');
  if (!text) throw new Error('Gemini returned empty text');
  const u = data?.usageMetadata || {};
  return {
    text,
    usage: { prompt_tokens: u.promptTokenCount || 0, completion_tokens: u.candidatesTokenCount || 0 },
  };
}

/* ── Claude (fallback) ────────────────────────────────────────────────────── */
async function claudeComplete({ system, messages, maxTokens = 2048, temperature = 0.4 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const { system: sys, msgs } = normMessages(system, messages);
  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    temperature,
    messages: msgs.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content == null ? '' : m.content) })),
  };
  if (sys) body.system = sys;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Claude ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => null);
  const text = (data?.content || []).map((b) => b?.text || '').join('');
  if (!text) throw new Error('Claude returned empty text');
  const u = data?.usage || {};
  return { text, usage: { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0 } };
}

/* ── Fallback wrapper: Gemini → Claude ────────────────────────────────────── */
async function llmComplete(opts = {}) {
  try {
    const r = await geminiComplete(opts);
    if (r.text && !EXHAUSTED_RE.test(r.text)) return { ...r, provider: 'gemini' };
    throw new Error('Gemini empty/unusable');
  } catch (e1) {
    console.warn('[ai] Gemini failed, falling back to Claude:', e1.message);
    const r = await claudeComplete(opts);
    return { ...r, provider: 'claude' };
  }
}

module.exports = { llmComplete, geminiComplete, claudeComplete, EXHAUSTED_RE, GEMINI_MODEL, ANTHROPIC_MODEL };

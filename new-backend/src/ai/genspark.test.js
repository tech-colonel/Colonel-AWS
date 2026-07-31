const test = require('node:test');
const assert = require('node:assert');
const { streamGenspark, callGenspark } = require('./genspark');

const MISSING_KEY_MSG = 'Colonel AI is not configured. Set GSK_API_KEY on the backend.';

let savedFetch;
let savedApiKey;

test.beforeEach(() => {
  savedFetch = global.fetch;
  savedApiKey = process.env.GSK_API_KEY;
  process.env.GSK_API_KEY = 'test-key';
});

test.afterEach(() => {
  global.fetch = savedFetch;
  if (savedApiKey === undefined) delete process.env.GSK_API_KEY;
  else process.env.GSK_API_KEY = savedApiKey;
});

/* ── test doubles ──────────────────────────────────────────────────────── */

// Minimal Express-response double: records writeHead/write/end calls so we
// can assert on the raw SSE bytes without a real HTTP connection.
function makeFakeRes() {
  const frames = [];
  return {
    headersSent: false,
    writableEnded: false,
    frames,
    writeHead(status, headers) {
      this.headersSent = true;
      this.statusCode = status;
      this.sentHeaders = headers;
    },
    flushHeaders() {
      this.flushed = true;
    },
    write(chunk) {
      frames.push(chunk);
    },
    end() {
      this.writableEnded = true;
    },
  };
}

// Parses the raw text written to a fake res back into { event, data } frames.
// streamGenspark always writes an event line then a data line as two
// separate res.write() calls, so joined output is "event: X\ndata: Y\n\n...".
function parseSSE(raw) {
  return raw
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event:'));
      const dataLine = lines.find((l) => l.startsWith('data:'));
      return {
        event: eventLine ? eventLine.slice('event:'.length).trim() : null,
        data: dataLine ? JSON.parse(dataLine.slice('data:'.length).trim()) : null,
      };
    });
}

// A ReadableStream-reader double that yields one already-encoded chunk of
// OpenAI-style `data: {...}` SSE text, then signals done.
function makeSSEReader(text) {
  const encoder = new TextEncoder();
  let sent = false;
  return {
    async read() {
      if (!sent) {
        sent = true;
        return { value: encoder.encode(text), done: false };
      }
      return { value: undefined, done: true };
    },
    async cancel() {},
  };
}

/* ── streamGenspark: streaming branch ─────────────────────────────────── */

test('streamGenspark streaming branch: emits delta chunks then usage then done', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    '',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":7}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  global.fetch = async (url, opts) => {
    assert.ok(String(url).includes('/chat/completions'));
    const body = JSON.parse(opts.body);
    assert.equal(body.stream, true);
    assert.equal(body.model, 'claude-haiku-4-5');
    return {
      ok: true,
      headers: { get: () => 'text/event-stream' },
      body: { getReader: () => makeSSEReader(sse) },
    };
  };

  const res = makeFakeRes();
  const result = await streamGenspark({
    res,
    model: 'claude-haiku-4-5',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.fullText, 'Hello world');
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 7 });

  const events = parseSSE(res.frames.join(''));
  assert.deepEqual(events.map((e) => e.event), ['delta', 'delta', 'usage', 'done']);
  assert.equal(events[0].data.text, 'Hello');
  assert.equal(events[1].data.text, ' world');
  assert.deepEqual(events[2].data, { input_tokens: 12, output_tokens: 7 });
  assert.deepEqual(events[3].data, { text: 'Hello world', model: 'claude-haiku-4-5' });

  assert.equal(res.headersSent, true);
  assert.equal(res.writableEnded, true);
});

/* ── streamGenspark: single-JSON branch ───────────────────────────────── */

test('streamGenspark single-JSON branch: emits one delta with the full text then done', async () => {
  global.fetch = async () => ({
    ok: true,
    // Real fetch Response objects always carry a (possibly-unread) `body`
    // ReadableStream even when the caller reads via `.json()` instead —
    // streamGenspark's `!resp.body` guard only trips on network transport
    // failures, so the double must reflect that.
    body: {},
    headers: { get: () => 'application/json' },
    json: async () => ({
      choices: [{ message: { content: 'Full text reply' } }],
      usage: { prompt_tokens: 3, completion_tokens: 9 },
    }),
  });

  const res = makeFakeRes();
  const result = await streamGenspark({
    res,
    model: 'claude-haiku-4-5',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.fullText, 'Full text reply');
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 9 });

  const events = parseSSE(res.frames.join(''));
  assert.deepEqual(events.map((e) => e.event), ['delta', 'usage', 'done']);
  assert.equal(events[0].data.text, 'Full text reply');
  assert.deepEqual(events[1].data, { input_tokens: 3, output_tokens: 9 });
  assert.deepEqual(events[2].data, { text: 'Full text reply', model: 'claude-haiku-4-5' });
  assert.equal(res.writableEnded, true);
});

/* ── missing GSK_API_KEY ───────────────────────────────────────────────── */

test('missing GSK_API_KEY: streamGenspark emits error SSE and returns empty; callGenspark throws', async () => {
  delete process.env.GSK_API_KEY;

  // fetch must never be called when the key is missing.
  global.fetch = async () => { throw new Error('fetch should not be called when GSK_API_KEY is missing'); };

  const res = makeFakeRes();
  const result = await streamGenspark({ res, system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(result, { fullText: '', usage: null });

  const events = parseSSE(res.frames.join(''));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'error');
  assert.equal(events[0].data.error, MISSING_KEY_MSG);
  assert.equal(res.headersSent, true);
  assert.equal(res.writableEnded, true);

  await assert.rejects(
    () => callGenspark({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.equal(err.message, MISSING_KEY_MSG);
      return true;
    }
  );
});

/* ── callGenspark: happy path ─────────────────────────────────────────── */

test('callGenspark happy path: returns { text, usage } from a single JSON response', async () => {
  global.fetch = async (url, opts) => {
    assert.ok(String(url).includes('/chat/completions'));
    const body = JSON.parse(opts.body);
    assert.equal(body.stream, false);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'internal reply' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    };
  };

  const result = await callGenspark({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(result, { text: 'internal reply', usage: { prompt_tokens: 5, completion_tokens: 2 } });
});

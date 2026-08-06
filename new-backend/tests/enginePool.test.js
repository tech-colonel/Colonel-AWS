/**
 * Engine pool tests — stdlib node:test only, no framework dependency
 * (neither the dev Mac nor the EC2 box has jest/mocha installed).
 *
 * Run: node --test tests/enginePool.test.js
 */

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

// Must be set before the module is required — engines are resolved at load.
process.env.PYTHON_RECO_URLS = 'http://localhost:8765,http://localhost:8766';
const pool = require('../src/lib/enginePool');

beforeEach(() => pool._resetForTests());

test('lists both configured engines, trailing slashes stripped', () => {
  assert.deepStrictEqual(pool.listEngines(), [
    'http://localhost:8765',
    'http://localhost:8766',
  ]);
});

test('spreads concurrent work across engines', () => {
  const a = pool.acquireEngine();
  const b = pool.acquireEngine();
  assert.notStrictEqual(a, b, 'second concurrent job must land on the other engine');
});

test('reuses an engine once its slot is released', () => {
  const a = pool.acquireEngine();
  pool.acquireEngine();
  pool.releaseEngine(a);
  assert.strictEqual(pool.acquireEngine(), a, 'freed engine should be chosen again');
});

test('release never drives a counter negative', () => {
  pool.releaseEngine('http://localhost:8765');
  pool.releaseEngine('http://localhost:8765');
  const a = pool.acquireEngine();
  const b = pool.acquireEngine();
  assert.notStrictEqual(a, b, 'counters stayed sane so dispatch still alternates');
});

test('releasing an unknown url is a no-op', () => {
  pool.releaseEngine('http://localhost:9999');
  assert.deepStrictEqual(pool._inFlightSnapshot(), {
    'http://localhost:8765': 0,
    'http://localhost:8766': 0,
  });
});

test('remembered engine is tried first, sibling kept as fallback', () => {
  pool.rememberJob('job-1', 'http://localhost:8766');
  assert.deepStrictEqual(pool.enginesForJob('job-1'), [
    'http://localhost:8766',
    'http://localhost:8765',
  ]);
});

test('unknown job falls back to every engine in order', () => {
  assert.deepStrictEqual(pool.enginesForJob('never-seen'), [
    'http://localhost:8765',
    'http://localhost:8766',
  ]);
});

test('a job remembered against a now-removed engine still returns all engines', () => {
  pool.rememberJob('job-2', 'http://localhost:9999');
  assert.deepStrictEqual(pool.enginesForJob('job-2'), [
    'http://localhost:8765',
    'http://localhost:8766',
  ]);
});

test('rememberJob ignores empty input', () => {
  pool.rememberJob(null, 'http://localhost:8766');
  pool.rememberJob('job-3', null);
  assert.deepStrictEqual(pool.enginesForJob('job-3'), [
    'http://localhost:8765',
    'http://localhost:8766',
  ]);
});

test('acquire/release round-trip leaves counters at zero', () => {
  const a = pool.acquireEngine();
  const b = pool.acquireEngine();
  pool.releaseEngine(a);
  pool.releaseEngine(b);
  assert.deepStrictEqual(pool._inFlightSnapshot(), {
    'http://localhost:8765': 0,
    'http://localhost:8766': 0,
  });
});

const test = require('node:test');
const assert = require('node:assert');
const store = require('./loginNonceStore');

test('issue returns a long unguessable string', () => {
  const n = store.issue();
  assert.equal(typeof n, 'string');
  assert.ok(n.length >= 24);
  assert.notEqual(store.issue(), store.issue()); // unique
});

test('consume is true once, then false (single-use)', () => {
  const n = store.issue();
  assert.equal(store.consume(n), true);
  assert.equal(store.consume(n), false); // replay rejected
});

test('consume rejects unknown / empty / non-string', () => {
  assert.equal(store.consume('never-issued'), false);
  assert.equal(store.consume(''), false);
  assert.equal(store.consume(undefined), false);
  assert.equal(store.consume(null), false);
});

test('consume rejects an expired nonce', () => {
  const n = store.issue();
  const entry = store._store.get(n);
  entry.createdAt = Date.now() - store.TTL_MS - 1000; // force-expire
  assert.equal(store.consume(n), false);
});

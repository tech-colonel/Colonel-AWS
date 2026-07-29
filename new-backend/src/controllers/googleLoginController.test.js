const test = require('node:test');
const assert = require('node:assert');
require('dotenv').config();
const ctrl = require('./googleLoginController');

const users = [{ id: 'u1', name: 'Priya', email: 'Priya@Colonel.App', role: 'accountant' }];

test('matches an existing email case-insensitively', () => {
  const found = ctrl._matchEmailIn(users, 'priya@colonel.app');
  assert.ok(found && found.id === 'u1');
});

test('returns null for an unregistered email (security gate)', () => {
  assert.equal(ctrl._matchEmailIn(users, 'ghost@nowhere.com'), null);
});

test('returns null for empty / missing email', () => {
  assert.equal(ctrl._matchEmailIn(users, ''), null);
  assert.equal(ctrl._matchEmailIn(users, undefined), null);
});

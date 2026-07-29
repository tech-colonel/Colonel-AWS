const test = require('node:test');
const assert = require('node:assert');
require('dotenv').config();
const composio = require('./composioClient');

// Live test against the already-connected central googlesuper account.
test('getGoogleEmail resolves a googlesuper connection', async () => {
  if (!composio.isConfigured()) return; // skip when no key
  const email = await composio.getGoogleEmail('central', true);
  assert.ok(email && /@/.test(email), `expected an email, got ${email}`);
});

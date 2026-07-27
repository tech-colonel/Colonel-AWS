#!/usr/bin/env node
/**
 * Parity test for the payee-key extractor (JS side, the WRITER).
 *
 * Runs the shared fixtures in payee_key_fixtures.json through
 * bankCorrectionsController.extractPayeeKeys and asserts the identity keys match.
 * The Python reader (tests/test_payee_keys.py) asserts the SAME fixtures, so any drift
 * between writer and reader becomes a test failure instead of a silent 0% match rate.
 *
 * Usage: node scripts/tests/test_payee_keys_parity.js
 */
const path = require('path');
const fs = require('fs');

const { extractPayeeKeys } = require(path.join(__dirname, '../../src/controllers/bankCorrectionsController'));
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'payee_key_fixtures.json'), 'utf8'));

const IDENTITY = ['phone', 'vpa', 'name', 'neft_name'];
let failed = 0;

for (const c of fixtures.cases) {
  const got = extractPayeeKeys(c.narration);
  const actual = {};
  for (const k of IDENTITY) if (got[k]) actual[k] = got[k];

  const want = c.keys || {};
  const keysMatch = Object.keys(want).length === Object.keys(actual).length
    && Object.entries(want).every(([k, v]) => actual[k] === v);

  if (keysMatch) {
    console.log(`PASS  ${c.narration.slice(0, 58)}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${c.narration}`);
    console.log(`        want ${JSON.stringify(want)}`);
    console.log(`        got  ${JSON.stringify(actual)}`);
    console.log(`        why  ${c.why}`);
  }
}

if (failed) {
  console.log(`\n${failed} FAILURE(S) — the JS writer and Python reader will disagree.`);
  process.exit(1);
}
console.log('\nALL PASS');

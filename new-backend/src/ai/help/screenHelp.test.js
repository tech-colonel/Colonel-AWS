const test = require('node:test');
const assert = require('node:assert');
const { getHelp, RECO_SUGGESTIONS, RESULT_SUGGESTIONS } = require('./screenHelp');

test('getHelp returns a non-empty blurb + 2-3 suggestions for a known agentType', () => {
  const h = getHelp({ agentType: 'einvoice_reco' });
  assert.ok(h.title);
  assert.ok(h.blurb && h.blurb.length > 50);
  assert.ok(Array.isArray(h.suggestions));
  assert.ok(h.suggestions.length >= 2 && h.suggestions.length <= 3);
  assert.deepEqual(h.suggestions, RECO_SUGGESTIONS);
  // blurb mentions this tool's specifics + the Drive sharing hint.
  assert.match(h.blurb, /E-Invoice/i);
  assert.match(h.blurb, /Anyone with the link/i);
});

test('getHelp swaps to result-context suggestions when hasResult is set', () => {
  const h = getHelp({ agentType: 'gstr_2b_books', hasResult: true });
  assert.deepEqual(h.suggestions, RESULT_SUGGESTIONS);
});

test('getHelp returns the Colonel AI default for unknown/empty screen', () => {
  for (const ctx of [{}, undefined, { route: '/colonel-ai' }, { agentType: 'nope' }]) {
    const h = getHelp(ctx);
    assert.equal(h.title, 'Colonel AI');
    assert.ok(h.blurb && h.blurb.length > 50);
    assert.ok(h.suggestions.length >= 2 && h.suggestions.length <= 3);
  }
});

test('getHelp never throws on missing input', () => {
  assert.doesNotThrow(() => getHelp());
  assert.doesNotThrow(() => getHelp(null));
});

test('every registered agent produces a distinct titled blurb', () => {
  const keys = [
    'gstr_2b_vs_purchase', 'gstr_2a_vs_2b_vs_books', 'gstr_2b_books',
    'gstr_2b_books_multistate', 'gstr_3b_vs_2b', 'gstr_1_vs_books',
    'einvoice_reco', 'bank_statement', 'universal_bank_statement',
    'gstr_3b_tally_entry', 'receivable_cycle', 'bank_tally_reco',
    'credit_card_booking', 'pdf_bank_extract',
  ];
  for (const k of keys) {
    const h = getHelp({ agentType: k });
    assert.notEqual(h.title, 'Colonel AI', `expected specific help for ${k}`);
    assert.ok(h.blurb.includes('How to run this tool'), `expected run steps for ${k}`);
  }
});

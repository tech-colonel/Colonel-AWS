const test = require('node:test');
const assert = require('node:assert');
const router = require('./driveRouter');
const agentSlots = require('./agentSlots');

const f = (name) => ({ fileId: name, name, ext: router.extOf(name) });

test('parseAnyId reads folder, file, and open?id links', () => {
  assert.equal(router.parseAnyId('https://drive.google.com/drive/folders/ABC123def').id, 'ABC123def');
  assert.equal(router.parseAnyId('https://drive.google.com/drive/folders/ABC123def').kind, 'folder');
  assert.equal(router.parseAnyId('https://drive.google.com/file/d/FILEID999/view').id, 'FILEID999');
  assert.equal(router.parseAnyId('https://drive.google.com/file/d/FILEID999/view').kind, 'file');
  assert.equal(router.parseAnyId('https://drive.google.com/open?id=OPENID77').id, 'OPENID77');
  assert.equal(router.parseAnyId('   '), null);
});

test('extOf lowercases and extracts extension', () => {
  assert.equal(router.extOf('GSTR-2B_July.XLSX'), '.xlsx');
  assert.equal(router.extOf('noext'), '');
});

test('routes a clean 2B-vs-Purchase folder to the right slots', () => {
  const slots = agentSlots.get('gstr_2b_vs_purchase');
  const files = [f('GSTR-2B_July2024.xlsx'), f('Purchase Register July.xlsx')];
  const r = router.route(files, slots);
  assert.equal(r.mapping.gstr2b.length, 1);
  assert.equal(r.mapping.gstr2b[0].name, 'GSTR-2B_July2024.xlsx');
  assert.equal(r.mapping.purchase.length, 1);
  assert.equal(r.mapping.purchase[0].name, 'Purchase Register July.xlsx');
  assert.equal(r.unmatched.length, 0);
  assert.equal(r.ambiguous.length, 0);
});

test('extension gate rejects a wrong-type file (pdf into an xlsx-only slot)', () => {
  const slots = agentSlots.get('gstr_2b_vs_purchase');
  const r = router.route([f('random_notes.pdf')], slots);
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.mapping.gstr2b.length, 0);
});

test('unrelated file lands in unmatched, not a slot', () => {
  const slots = agentSlots.get('gstr_2b_vs_purchase');
  const files = [f('2b.xlsx'), f('holiday_photos.xlsx')];
  const r = router.route(files, slots);
  assert.equal(r.mapping.gstr2b.length, 1);
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0].name, 'holiday_photos.xlsx');
});

test('a single-value slot with two candidates keeps the best and marks the extra ambiguous', () => {
  const slots = agentSlots.get('gstr_2b_vs_purchase');
  // both look like GSTR-2B; the more specific keyword ("gstr-2b") wins the slot
  const files = [f('gstr-2b_final.xlsx'), f('2b.xlsx')];
  const r = router.route(files, slots);
  assert.equal(r.mapping.gstr2b.length, 1);
  assert.equal(r.mapping.gstr2b[0].name, 'gstr-2b_final.xlsx');
  assert.equal(r.ambiguous.length, 1);
  assert.equal(r.ambiguous[0].name, '2b.xlsx');
});

test('multiple-value slot collects all matches (receivable_cycle courier files)', () => {
  const slots = agentSlots.get('receivable_cycle');
  const files = [
    f('Combine Tally GST.xlsx'),
    f('Sales Order Combine.xlsx'),
    f('Delhivery COD 1.xlsx'),
    f('Delhivery COD 2.xlsx'),
  ];
  const r = router.route(files, slots);
  assert.equal(r.mapping.tally_gst.length, 1);
  assert.equal(r.mapping.sales_order.length, 1);
  assert.equal(r.mapping.delhivery.length, 2);
  assert.equal(r.ambiguous.length, 0);
});

test('gstr_3b_tally_entry accepts multiple month PDFs in one slot', () => {
  const slots = agentSlots.get('gstr_3b_tally_entry');
  const files = [f('GSTR-3B April.pdf'), f('GSTR-3B May.pdf'), f('GSTR-3B June.pdf')];
  const r = router.route(files, slots);
  assert.equal(r.mapping.gstr3b.length, 3);
  assert.equal(r.unmatched.length, 0);
});

test('agentSlots.isSupported gates unknown agents', () => {
  assert.equal(agentSlots.isSupported('gstr_2b_books'), true);
  assert.equal(agentSlots.isSupported('not_a_real_agent'), false);
  assert.equal(agentSlots.get('not_a_real_agent'), null);
});

// import-tracker.js — import the monthly Compliance-Tracker workflow from the
// Excel trackers into compliance_tasks, repeated for every month (Jan–Dec of YEAR),
// per brand. Mirrors the existing Stroom pattern (source='template'). 3000 only.
// Idempotent: clears prior source='template' rows for the TARGET brands first.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const NB = path.join(__dirname, '..', 'new-backend');
require(path.join(NB, 'node_modules', 'dotenv')).config({ path: path.join(NB, '.env') });
const { masterSequelize } = require(path.join(NB, 'src', 'config', 'database'));

const YEAR = 2026;
const data = JSON.parse(fs.readFileSync('/tmp/tracker_import.json', 'utf8'));

// brand → (brand_id, user_id for NOT-NULL/FK, source sheet key)
const BRANDS = [
  { name: 'Shumee Toys',     id: '91c1a721-4b1d-46de-9cd1-361e179c878e', user: '23c8fada-ccb9-410d-b755-99d856a128ff', key: 'SHUMEE' },
  { name: 'Shumee Playroom', id: '91b89bb0-fb8c-477e-824d-a3136e6cbce6', user: '23c8fada-ccb9-410d-b755-99d856a128ff', key: 'SHUMEE' },
  { name: 'M Brands',        id: 'bbd59c4f-c164-42bd-90b8-0325cbb4e1b6', user: 'a0000000-0000-0000-0000-000000000003', key: 'MBRANDS' },
  { name: 'Urban Plant',     id: 'dd0107f5-f36a-4244-b7e0-c298a65d4e6a', user: 'a0000000-0000-0000-0000-000000000004', key: 'URBAN' },
];
const COLORS = { Accounting: '#7C3AED', GST: '#0748EE', Reporting: '#0EA5E9', TDS: '#D97706',
  Certification: '#059669', 'Follow Up': '#EC4899', General: '#64748B' };

(async () => {
  const s = masterSequelize;
  for (const b of BRANDS) {
    const tasks = data[b.key] || [];
    if (!tasks.length) { console.log(`  ${b.name}: no source tasks, skip`); continue; }

    // clear any prior template import for THIS brand (idempotent; Stroom untouched)
    await s.query(`DELETE FROM compliance_tasks WHERE brand_id=:bid AND source='template'`, { replacements: { bid: b.id } });

    // ensure categories from the distinct Field values
    const fields = [...new Set(tasks.map(t => t.field || 'General'))];
    const catId = {};
    for (const name of fields) {
      const color = COLORS[name] || '#64748B';
      const [rows] = await s.query(
        `INSERT INTO compliance_categories (brand_id, name, color, is_system, created_by)
         VALUES (:bid,:name,:color,false,:uid)
         ON CONFLICT (brand_id, lower(name)) DO UPDATE SET color=EXCLUDED.color
         RETURNING id`, { replacements: { bid: b.id, name, color, uid: b.user } });
      catId[name] = rows[0].id;
    }

    // insert tasks × 12 months
    let n = 0;
    for (let month = 1; month <= 12; month++) {
      let seq = 0; // global running order within the month (unique → satisfies uq_compliance_template_row)
      for (const t of tasks) {
        seq++;
        await s.query(
          `INSERT INTO compliance_tasks
             (id, brand_id, user_id, year, month, period, period_order, seq, title,
              category_id, status, priority, progress, data_source, frequency, remarks, source, created_at)
           VALUES (:id,:bid,:uid,:yr,:mo,:period,:po,:seq,:title,:cat,'todo','medium',0,:ds,:fr,:rm,'template',now())`,
          { replacements: {
              id: crypto.randomUUID(), bid: b.id, uid: b.user, yr: YEAR, mo: month,
              period: t.period || null, po: t.period_order || null, seq,
              title: t.task, cat: catId[t.field || 'General'] || null,
              ds: t.source || null, fr: t.freq || null, rm: t.remarks || null } });
        n++;
      }
    }
    console.log(`  ✅ ${b.name}: ${fields.length} categories, ${n} tasks (${tasks.length} × 12 months)`);
  }
  console.log('Done.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

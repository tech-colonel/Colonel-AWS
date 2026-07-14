// import-statutory.js — import the monthly-workflow trackers into the DYNAMIC
// Statutory Compliance feature (statutory_config + statutory_filings), repeated
// for every month of YEAR, per brand. 3000 only. Stroom is NOT touched.
//
//   Shumee Toys + Shumee Playroom  ← SHUMEE sheet
//   M Brands                       ← MBRANDS sheet
//   Urban Plant                    ← URBAN sheet
//
// Each brand gets a statutory_config row (its own categories = the sheet's Field
// values; statuses = To Do / In Progress / Done). Filings become one row per
// task per month. Idempotent: clears the target brand's filings first.
const path = require('path');
const fs = require('fs');
const NB = path.join(__dirname, '..', 'new-backend');
require(path.join(NB, 'node_modules', 'dotenv')).config({ path: path.join(NB, '.env') });
const { masterSequelize } = require(path.join(NB, 'src', 'config', 'database'));

const YEAR = 2026;
// Parsed workflow data, committed alongside for reproducibility on a fresh clone.
// Regenerate from the source Excel with parse-statutory-xlsx.py. Override with STATUTORY_JSON.
const SRC = process.env.STATUTORY_JSON || path.join(__dirname, 'statutory_import.json');
const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// brand → source sheet key
const BRANDS = [
  { name: 'Shumee Toys',     id: '91c1a721-4b1d-46de-9cd1-361e179c878e', key: 'SHUMEE' },
  { name: 'Shumee Playroom', id: '91b89bb0-fb8c-477e-824d-a3136e6cbce6', key: 'SHUMEE' },
  { name: 'M Brands',        id: 'bbd59c4f-c164-42bd-90b8-0325cbb4e1b6', key: 'MBRANDS' },
  { name: 'Urban Plant',     id: 'dd0107f5-f36a-4244-b7e0-c298a65d4e6a', key: 'URBAN' },
];

const COLORS = { Accounting: '#7C3AED', GST: '#0748EE', Reporting: '#0EA5E9', TDS: '#D97706',
  Certification: '#059669', 'Follow Up': '#EC4899', General: '#64748B' };

// Workflow statuses — flexible, NOT the filing-type Due/Not-Due set.
const STATUSES = [
  { key: 'todo',        label: 'To Do',       color: '#64748B' },
  { key: 'in_progress', label: 'In Progress', color: '#D97706' },
  { key: 'done',        label: 'Done',        color: '#059669', terminal: true },
];

const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const daysIn = (m) => new Date(YEAR, m, 0).getDate();
const dueDay = (win) => { const nums = (win || '').match(/\d+/g); return nums ? Number(nums[nums.length - 1]) : null; };
const noteOf = (t) => [
  t.window && `Window: ${t.window}`,
  t.source && `Source: ${t.source}`,
  t.freq && `Frequency: ${t.freq}`,
  t.remarks && `Remarks: ${t.remarks}`,
].filter(Boolean).join('\n') || null;

(async () => {
  const s = masterSequelize;
  for (const b of BRANDS) {
    const tasks = data[b.key] || [];
    if (!tasks.length) { console.log(`  ${b.name}: no source tasks, skip`); continue; }

    // categories = distinct Field values in order of appearance
    const cats = [];
    const seenField = new Set();
    for (const t of tasks) {
      if (!seenField.has(t.field)) {
        seenField.add(t.field);
        cats.push({ key: slug(t.field), name: t.field, color: COLORS[t.field] || '#64748B' });
      }
    }

    // upsert config
    await s.query(
      `INSERT INTO statutory_config (brand_id, categories, statuses, updated_at)
       VALUES (:bid, CAST(:cats AS jsonb), CAST(:stat AS jsonb), now())
       ON CONFLICT (brand_id) DO UPDATE SET categories = EXCLUDED.categories, statuses = EXCLUDED.statuses, updated_at = now()`,
      { replacements: { bid: b.id, cats: JSON.stringify(cats), stat: JSON.stringify(STATUSES) } });

    // idempotent: clear this brand's filings (Stroom is not a target → untouched)
    await s.query(`DELETE FROM statutory_filings WHERE brand_id = :bid`, { replacements: { bid: b.id } });

    let n = 0;
    for (let m = 1; m <= 12; m++) {
      const dim = daysIn(m);
      for (const t of tasks) {
        const win = t.window || '';
        const period_label = `${win ? win + ' · ' : ''}${MONTHS[m]} ${YEAR}`;
        const dd = dueDay(win);
        const due_date = dd ? `${YEAR}-${String(m).padStart(2, '0')}-${String(Math.min(dd, dim)).padStart(2, '0')}` : null;
        await s.query(
          `INSERT INTO statutory_filings
             (brand_id, compliance_type, title, period_label, period_type, year, month, quarter,
              state, status, due_date, filing_date, ack_no, applicability, note)
           VALUES (:bid,:ct,:title,:pl,'monthly',:yr,:mo,NULL,NULL,'todo',:due,NULL,NULL,NULL,:note)
           ON CONFLICT (brand_id, compliance_type, COALESCE(state,''), COALESCE(period_label,''), COALESCE(title,''))
           DO NOTHING`,
          { replacements: { bid: b.id, ct: slug(t.field), title: t.task, pl: period_label,
              yr: YEAR, mo: m, due: due_date, note: noteOf(t) } });
        n++;
      }
    }
    console.log(`  ✅ ${b.name}: ${cats.length} categories [${cats.map(c => c.name).join(', ')}], ${n} filings (${tasks.length} × 12)`);
  }
  console.log('Done.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); console.error(e); process.exit(1); });

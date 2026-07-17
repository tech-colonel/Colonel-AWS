/**
 * Database Explorer (admin-only) — serves the live schema of the unified DB as a
 * grouped tree with row counts, foreign-key edges and one redacted sample row per
 * table. Read-only. Runs through masterSequelize (which, in unified mode, points
 * at colonel_agent_accountant as the superuser — so it can read information_schema
 * and every brand's data for the visualisation).
 */
const { masterSequelize } = require('../config/database');

const GROUPS = [
  { name: 'Org / global', shared: true, tables: ['users','brands','agents','brand_users','brand_agents','plans','integrations','conversations','mcp_servers','agent_workflows','tasks','task_messages','meeting_pins','user_google_accounts','compliance_categories','compliance_tasks','compliance_chat_messages','compliance_attachments','statutory_filings','zoho_organizations','zoho_accounts','zoho_contacts','zoho_items','zoho_vouchers','zoho_bank_accounts','zoho_bank_transactions','zoho_sync_log'] },
  { name: 'Reconciliation', rls: true, tables: ['reco_jobs','bank_reco_results','bank_reco_corrections','bank_payee_directory','gstr_2b_results','gstr_2a_2b_results','gstr_3b_results','gstr_1_results','gstr_3b_tally_results','ledger_master'] },
  { name: 'GSTR-3B Tally', rls: true, tables: ['gstr3b_runs','gstr3b_coa_master','gstr3b_vt_master'] },
  { name: 'Marketplace / Sales (dynamic)', rls: true, tables: ['invoice_process','invoice_agent','flipkart','amazon','nykaa','myntra','meesho','sales_amazon','ajio','sales_cread','total_sales_analyzer','shopify_order_cycle','settlement_amazon','sales_shopify','sales_mirrow','sales_zepto','sales_myntra','sales_jiomart','sales_flipkart','sales_blinkit','sales_firstcry','sales_limeroad','sales_nykaa','gstr_2b_books'] },
];

const REDACT = new Set(['password','access_token','refresh_token','token','secret','raw','graph','messages','config','source_meta','sheets','columns','sample_columns']);
const trunc = (v) => { if (v === null || v === undefined) return null; const s = String(v); return s.length > 70 ? s.slice(0, 70) + '…' : s; };

const getSchema = async (req, res) => {
  try {
    const seq = masterSequelize;
    const [cols] = await seq.query(`
      SELECT table_name, column_name, data_type,
             character_maximum_length AS len, is_nullable
      FROM information_schema.columns
      WHERE table_schema='public'
      ORDER BY table_name, ordinal_position`);

    const [pks] = await seq.query(`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
      WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema='public'`);

    const [fks] = await seq.query(`
      SELECT tc.table_name AS src, kcu.column_name AS col, ccu.table_name AS ref
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema
      WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'`);

    const [rowsec] = await seq.query(`SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'`);
    const [counts] = await seq.query(`SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname='public'`);

    const pkSet = new Set(pks.map(r => r.table_name + '.' + r.column_name));
    const fkMap = {}; fks.forEach(f => { fkMap[f.src + '.' + f.col] = f.ref; });
    const rlsMap = {}; rowsec.forEach(r => { rlsMap[r.tablename] = r.rowsecurity; });
    const cntMap = {}; counts.forEach(c => { cntMap[c.relname] = Number(c.n_live_tup); });

    const colsBy = {};
    cols.forEach(c => {
      (colsBy[c.table_name] = colsBy[c.table_name] || []).push({
        name: c.column_name,
        type: c.len ? `${c.data_type}(${c.len})` : c.data_type,
        nullable: c.is_nullable === 'YES',
        pk: pkSet.has(c.table_name + '.' + c.column_name),
        fk: fkMap[c.table_name + '.' + c.column_name] || null,
      });
    });

    const edges = [];
    const groups = [];
    for (const g of GROUPS) {
      const tables = [];
      for (const t of g.tables) {
        if (!colsBy[t]) continue;
        // sample row (redacted)
        let sample = {};
        try {
          const [srows] = await seq.query(`SELECT to_jsonb(x) AS j FROM "${t}" x LIMIT 1`);
          const row = srows && srows[0] && srows[0].j;
          if (row) colsBy[t].forEach(c => { sample[c.name] = REDACT.has(c.name) ? '«redacted»' : trunc(row[c.name]); });
        } catch (e) { /* leave empty */ }
        tables.push({ name: t, rows: cntMap[t] || 0, rls: !!rlsMap[t], fields: colsBy[t], sample });
        colsBy[t].forEach(c => { if (c.fk && c.fk !== t) edges.push({ from: t, to: c.fk, col: c.name }); });
      }
      groups.push({ name: g.name, rls: !!g.rls, shared: !!g.shared, tables });
    }

    const totalTables = groups.reduce((a, g) => a + g.tables.length, 0);
    const totalRows = groups.reduce((a, g) => a + g.tables.reduce((s, t) => s + t.rows, 0), 0);

    res.json({ db: process.env.UNIFIED_DB_NAME || 'colonel_agent_accountant', totalTables, totalRows, groups, edges });
  } catch (err) {
    console.error('[DB-EXPLORER] getSchema error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getSchema };

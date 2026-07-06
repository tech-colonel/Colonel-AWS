/**
 * zohoSync.js — pull-only Zoho Books → master DB mirror.
 *
 * Walks every organization (brand) and pulls chart of accounts, contacts
 * (customers + vendors), items, and every voucher/transaction type, upserting
 * into the zoho_* tables. Read-only: never writes back to Zoho.
 */

const { masterSequelize } = require('../config/database');
const { fetchAll } = require('./zohoClient');
const { QueryTypes } = require('sequelize');

// Every transaction ("voucher") type → its Books endpoint + field names.
const VOUCHER_TYPES = [
  { type: 'invoice',          path: '/invoices',         key: 'invoices',        idK: 'invoice_id',       numK: 'invoice_number',      dateK: 'date',         cidK: 'customer_id', cnameK: 'customer_name' },
  { type: 'credit_note',      path: '/creditnotes',      key: 'creditnotes',     idK: 'creditnote_id',    numK: 'creditnote_number',   dateK: 'date',         cidK: 'customer_id', cnameK: 'customer_name' },
  { type: 'sales_order',      path: '/salesorders',      key: 'salesorders',     idK: 'salesorder_id',    numK: 'salesorder_number',   dateK: 'date',         cidK: 'customer_id', cnameK: 'customer_name' },
  { type: 'estimate',         path: '/estimates',        key: 'estimates',       idK: 'estimate_id',      numK: 'estimate_number',     dateK: 'date',         cidK: 'customer_id', cnameK: 'customer_name' },
  { type: 'customer_payment', path: '/customerpayments', key: 'customerpayments',idK: 'payment_id',       numK: 'payment_number',      dateK: 'date',         cidK: 'customer_id', cnameK: 'customer_name' },
  { type: 'bill',             path: '/bills',            key: 'bills',           idK: 'bill_id',          numK: 'bill_number',         dateK: 'date',         cidK: 'vendor_id',   cnameK: 'vendor_name' },
  { type: 'purchase_order',   path: '/purchaseorders',   key: 'purchaseorders',  idK: 'purchaseorder_id', numK: 'purchaseorder_number',dateK: 'date',         cidK: 'vendor_id',   cnameK: 'vendor_name' },
  { type: 'vendor_credit',    path: '/vendorcredits',    key: 'vendor_credits',  idK: 'vendor_credit_id', numK: 'vendor_credit_number',dateK: 'date',         cidK: 'vendor_id',   cnameK: 'vendor_name' },
  { type: 'vendor_payment',   path: '/vendorpayments',   key: 'vendorpayments',  idK: 'payment_id',       numK: 'payment_number',      dateK: 'date',         cidK: 'vendor_id',   cnameK: 'vendor_name' },
  { type: 'expense',          path: '/expenses',         key: 'expenses',        idK: 'expense_id',       numK: 'expense_number',      dateK: 'date',         cidK: 'vendor_id',   cnameK: 'vendor_name' },
  { type: 'journal',          path: '/journals',         key: 'journals',        idK: 'journal_id',       numK: 'entry_number',        dateK: 'journal_date', cidK: null,          cnameK: null },
];

const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : null; };
const toDate = (v) => { if (!v) return null; const s = String(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

async function up(sql, replacements) {
  await masterSequelize.query(sql, { replacements, type: QueryTypes.INSERT });
}

async function syncOrganization(org) {
  const orgId = org.organization_id;
  const counts = {};

  // Organization row
  await up(
    `INSERT INTO zoho_organizations (organization_id, name, currency_code, raw, synced_at)
     VALUES (:id, :name, :cur, :raw, now())
     ON CONFLICT (organization_id) DO UPDATE SET name=EXCLUDED.name, currency_code=EXCLUDED.currency_code, raw=EXCLUDED.raw, synced_at=now()`,
    { id: orgId, name: org.name || null, cur: org.currency_code || null, raw: JSON.stringify(org) }
  );

  // Chart of accounts
  const accounts = await fetchAll('/chartofaccounts', 'chartofaccounts', { organization_id: orgId });
  for (const a of accounts) {
    await up(
      `INSERT INTO zoho_accounts (account_id, organization_id, account_name, account_type, is_active, raw, synced_at)
       VALUES (:id,:org,:name,:type,:active,:raw,now())
       ON CONFLICT (account_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, account_name=EXCLUDED.account_name, account_type=EXCLUDED.account_type, is_active=EXCLUDED.is_active, raw=EXCLUDED.raw, synced_at=now()`,
      { id: a.account_id, org: orgId, name: a.account_name || null, type: a.account_type || null, active: a.is_active !== false, raw: JSON.stringify(a) }
    );
  }
  counts.accounts = accounts.length;

  // Contacts (customers + vendors — contact_type on each row)
  const contacts = await fetchAll('/contacts', 'contacts', { organization_id: orgId });
  for (const c of contacts) {
    await up(
      `INSERT INTO zoho_contacts (contact_id, organization_id, contact_name, company_name, contact_type, email, phone, outstanding, raw, synced_at)
       VALUES (:id,:org,:name,:co,:type,:email,:phone,:out,:raw,now())
       ON CONFLICT (contact_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, contact_name=EXCLUDED.contact_name, company_name=EXCLUDED.company_name, contact_type=EXCLUDED.contact_type, email=EXCLUDED.email, phone=EXCLUDED.phone, outstanding=EXCLUDED.outstanding, raw=EXCLUDED.raw, synced_at=now()`,
      { id: c.contact_id, org: orgId, name: c.contact_name || null, co: c.company_name || null, type: c.contact_type || null, email: c.email || null, phone: c.phone || c.mobile || null, out: num(c.outstanding_receivable_amount ?? c.outstanding_payable_amount), raw: JSON.stringify(c) }
    );
  }
  counts.contacts = contacts.length;

  // Items
  const items = await fetchAll('/items', 'items', { organization_id: orgId });
  for (const it of items) {
    await up(
      `INSERT INTO zoho_items (item_id, organization_id, name, rate, status, raw, synced_at)
       VALUES (:id,:org,:name,:rate,:status,:raw,now())
       ON CONFLICT (item_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, name=EXCLUDED.name, rate=EXCLUDED.rate, status=EXCLUDED.status, raw=EXCLUDED.raw, synced_at=now()`,
      { id: it.item_id, org: orgId, name: it.name || null, rate: num(it.rate), status: it.status || null, raw: JSON.stringify(it) }
    );
  }
  counts.items = items.length;

  // Vouchers (all transaction types)
  for (const v of VOUCHER_TYPES) {
    let rows = [];
    try {
      rows = await fetchAll(v.path, v.key, { organization_id: orgId });
    } catch (e) {
      counts[v.type] = `err: ${e.message.slice(0, 60)}`;
      continue;
    }
    for (const r of rows) {
      await up(
        `INSERT INTO zoho_vouchers (organization_id, voucher_type, zoho_id, number, voucher_date, contact_id, contact_name, status, total, raw, synced_at)
         VALUES (:org,:vt,:zid,:num,:dt,:cid,:cname,:status,:total,:raw,now())
         ON CONFLICT (voucher_type, zoho_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, number=EXCLUDED.number, voucher_date=EXCLUDED.voucher_date, contact_id=EXCLUDED.contact_id, contact_name=EXCLUDED.contact_name, status=EXCLUDED.status, total=EXCLUDED.total, raw=EXCLUDED.raw, synced_at=now()`,
        {
          org: orgId, vt: v.type, zid: String(r[v.idK]), num: v.numK ? (r[v.numK] || null) : null,
          dt: toDate(r[v.dateK]), cid: v.cidK ? (r[v.cidK] || null) : null, cname: v.cnameK ? (r[v.cnameK] || null) : null,
          status: r.status || null, total: num(r.total ?? r.amount ?? r.total_amount), raw: JSON.stringify(r),
        }
      );
    }
    counts[v.type] = rows.length;
  }

  // Bank accounts + their statement transactions (org → account → txns drill-down)
  const bankAccounts = await fetchAll('/bankaccounts', 'bankaccounts', { organization_id: orgId });
  for (const b of bankAccounts) {
    await up(
      `INSERT INTO zoho_bank_accounts (account_id, organization_id, account_name, account_type, bank_name, account_number, balance, currency_code, is_active, raw, synced_at)
       VALUES (:id,:org,:name,:type,:bank,:no,:bal,:cur,:active,:raw,now())
       ON CONFLICT (account_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, account_name=EXCLUDED.account_name, account_type=EXCLUDED.account_type, bank_name=EXCLUDED.bank_name, account_number=EXCLUDED.account_number, balance=EXCLUDED.balance, currency_code=EXCLUDED.currency_code, is_active=EXCLUDED.is_active, raw=EXCLUDED.raw, synced_at=now()`,
      { id: b.account_id, org: orgId, name: b.account_name || null, type: b.account_type || null, bank: b.bank_name || null, no: b.account_number || null, bal: num(b.balance), cur: b.currency_code || null, active: b.is_active !== false, raw: JSON.stringify(b) }
    );
  }
  counts.bank_accounts = bankAccounts.length;

  let bankTxns = 0;
  for (const b of bankAccounts) {
    // Zoho splits bank transactions by status: the default ("Status.All") returns
    // only matched/categorized/manually-added — UNCATEGORIZED (and excluded) rows
    // must be fetched with an explicit filter_by and merged, else the statement is
    // incomplete (the "money in/out that hasn't been categorized yet").
    let txns = [];
    const seenTxn = new Set();
    for (const fb of ['Status.All', 'Status.Uncategorized', 'Status.Excluded']) {
      let batch = [];
      try { batch = await fetchAll('/banktransactions', 'banktransactions', { organization_id: orgId, account_id: b.account_id, filter_by: fb }); }
      catch (e) { continue; }
      for (const t of batch) { const id = String(t.transaction_id); if (id && !seenTxn.has(id)) { seenTxn.add(id); txns.push(t); } }
    }
    for (const t of txns) {
      await up(
        `INSERT INTO zoho_bank_transactions (transaction_id, organization_id, account_id, txn_date, amount, debit_or_credit, transaction_type, status, payee, reference_number, description, running_balance, raw, synced_at)
         VALUES (:id,:org,:acct,:dt,:amt,:dc,:tt,:status,:payee,:ref,:desc,:rb,:raw,now())
         ON CONFLICT (transaction_id) DO UPDATE SET organization_id=EXCLUDED.organization_id, account_id=EXCLUDED.account_id, txn_date=EXCLUDED.txn_date, amount=EXCLUDED.amount, debit_or_credit=EXCLUDED.debit_or_credit, transaction_type=EXCLUDED.transaction_type, status=EXCLUDED.status, payee=EXCLUDED.payee, reference_number=EXCLUDED.reference_number, description=EXCLUDED.description, running_balance=EXCLUDED.running_balance, raw=EXCLUDED.raw, synced_at=now()`,
        { id: String(t.transaction_id), org: orgId, acct: b.account_id, dt: toDate(t.date), amt: num(t.amount), dc: t.debit_or_credit || null, tt: t.transaction_type || null, status: t.status || null, payee: t.payee || null, ref: t.reference_number || null, desc: t.description || null, rb: num(t.running_balance), raw: JSON.stringify(t) }
      );
    }
    bankTxns += txns.length;
  }
  counts.bank_transactions = bankTxns;

  return counts;
}

/** Full pull across every organization. Returns per-org counts. */
async function syncAll() {
  const [log] = await masterSequelize.query(
    `INSERT INTO zoho_sync_log (status) VALUES ('running') RETURNING id`, { type: QueryTypes.INSERT }
  );
  const logId = log?.[0]?.id;
  try {
    const orgs = await fetchAll('/organizations', 'organizations');
    const result = {};
    for (const org of orgs) {
      result[org.organization_id] = { name: org.name, ...(await syncOrganization(org)) };
    }
    if (logId) await masterSequelize.query(
      `UPDATE zoho_sync_log SET status='ok', finished_at=now(), counts=:c WHERE id=:id`,
      { replacements: { c: JSON.stringify(result), id: logId }, type: QueryTypes.UPDATE }
    );
    return { ok: true, organizations: orgs.length, result };
  } catch (e) {
    if (logId) await masterSequelize.query(
      `UPDATE zoho_sync_log SET status='error', finished_at=now(), error=:e WHERE id=:id`,
      { replacements: { e: e.message, id: logId }, type: QueryTypes.UPDATE }
    );
    throw e;
  }
}

module.exports = { syncAll, syncOrganization, VOUCHER_TYPES };

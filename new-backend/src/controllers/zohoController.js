/**
 * zohoController.js — read-only Zoho Books mirror API (master DB).
 * Sync + status + drill-down: organizations (brands) → contacts (vendors/
 * customers) → vouchers (all transactions), plus accounts & items.
 */

const { masterSequelize } = require('../config/database');
const { QueryTypes } = require('sequelize');
const zoho = require('../services/zohoClient');
const { syncAll } = require('../services/zohoSync');

const q = (sql, replacements) => masterSequelize.query(sql, { replacements, type: QueryTypes.SELECT });

let _syncing = false;

/** POST /api/zoho/sync — pull everything from Zoho into the DB (read-only). */
const syncNow = async (req, res) => {
  if (!zoho.isConfigured()) return res.status(400).json({ error: 'Zoho is not configured on this server.' });
  if (_syncing) return res.status(409).json({ error: 'A sync is already running.' });
  _syncing = true;
  try {
    const result = await syncAll();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    _syncing = false;
  }
};

/** GET /api/zoho/status — configured?, last sync, table counts. */
const getStatus = async (req, res) => {
  try {
    const configured = zoho.isConfigured();
    let counts = {}; let lastSync = null;
    if (configured) {
      const [c] = await q(`SELECT
        (SELECT count(*) FROM zoho_organizations) AS organizations,
        (SELECT count(*) FROM zoho_contacts WHERE contact_type='vendor') AS vendors,
        (SELECT count(*) FROM zoho_contacts WHERE contact_type='customer') AS customers,
        (SELECT count(*) FROM zoho_accounts) AS accounts,
        (SELECT count(*) FROM zoho_items) AS items,
        (SELECT count(*) FROM zoho_vouchers) AS vouchers,
        (SELECT count(*) FROM zoho_bank_accounts) AS bank_accounts,
        (SELECT count(*) FROM zoho_bank_transactions) AS bank_transactions`);
      counts = c || {};
      const [log] = await q(`SELECT started_at, finished_at, status, error FROM zoho_sync_log ORDER BY id DESC LIMIT 1`);
      lastSync = log || null;
    }
    res.json({ configured, syncing: _syncing, counts, lastSync });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

/** GET /api/zoho/organizations — brands + a quick roll-up per org. */
const getOrganizations = async (req, res) => {
  try {
    const rows = await q(`
      SELECT o.organization_id, o.name, o.currency_code,
        (SELECT count(*) FROM zoho_contacts c WHERE c.organization_id=o.organization_id AND c.contact_type='vendor')   AS vendors,
        (SELECT count(*) FROM zoho_contacts c WHERE c.organization_id=o.organization_id AND c.contact_type='customer') AS customers,
        (SELECT count(*) FROM zoho_vouchers v WHERE v.organization_id=o.organization_id) AS vouchers
      FROM zoho_organizations o ORDER BY o.name`);
    res.json({ organizations: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

/** GET /api/zoho/organizations/:orgId/contacts?type=vendor|customer */
const getContacts = async (req, res) => {
  try {
    const { orgId } = req.params; const { type } = req.query;
    const rows = await q(
      `SELECT contact_id, contact_name, company_name, contact_type, email, phone, outstanding
       FROM zoho_contacts WHERE organization_id=:org ${type ? 'AND contact_type=:type' : ''}
       ORDER BY contact_name`,
      { org: orgId, type }
    );
    res.json({ contacts: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

/** GET /api/zoho/vouchers?organization_id=&contact_id=&voucher_type=&limit= */
const getVouchers = async (req, res) => {
  try {
    const { organization_id, contact_id, voucher_type } = req.query;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const where = []; const r = { limit };
    if (organization_id) { where.push('organization_id=:org'); r.org = organization_id; }
    if (contact_id) { where.push('contact_id=:cid'); r.cid = contact_id; }
    if (voucher_type) { where.push('voucher_type=:vt'); r.vt = voucher_type; }
    const rows = await q(
      `SELECT id, organization_id, voucher_type, zoho_id, number, voucher_date, contact_id, contact_name, status, total
       FROM zoho_vouchers ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY voucher_date DESC NULLS LAST, id DESC LIMIT :limit`,
      r
    );
    res.json({ vouchers: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

/** GET /api/zoho/vouchers/:id — full raw payload of one voucher. */
const getVoucher = async (req, res) => {
  try {
    const [row] = await q(`SELECT * FROM zoho_vouchers WHERE id=:id`, { id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ voucher: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

/** GET /api/zoho/organizations/:orgId/accounts — chart of accounts. */
const getAccounts = async (req, res) => {
  try {
    const rows = await q(`SELECT account_id, account_name, account_type, is_active FROM zoho_accounts WHERE organization_id=:org ORDER BY account_type, account_name`, { org: req.params.orgId });
    res.json({ accounts: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

/** GET /api/zoho/organizations/:orgId/items */
const getItems = async (req, res) => {
  try {
    const rows = await q(`SELECT item_id, name, rate, status FROM zoho_items WHERE organization_id=:org ORDER BY name`, { org: req.params.orgId });
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

/** GET /api/zoho/organizations/:orgId/bank-accounts */
const getBankAccounts = async (req, res) => {
  try {
    const rows = await q(
      `SELECT b.account_id, b.account_name, b.account_type, b.bank_name, b.account_number, b.balance, b.currency_code, b.is_active,
        (SELECT count(*) FROM zoho_bank_transactions t WHERE t.account_id=b.account_id) AS transactions
       FROM zoho_bank_accounts b WHERE b.organization_id=:org ORDER BY b.account_type, b.account_name`,
      { org: req.params.orgId }
    );
    res.json({ bankAccounts: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

/** GET /api/zoho/bank-accounts/:accountId/transactions — the statement. */
const getBankTransactions = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const rows = await q(
      `SELECT transaction_id, txn_date, amount, debit_or_credit, transaction_type, status, payee, reference_number, description, running_balance
       FROM zoho_bank_transactions WHERE account_id=:acct ORDER BY txn_date DESC NULLS LAST, transaction_id DESC LIMIT :limit`,
      { acct: req.params.accountId, limit }
    );
    res.json({ transactions: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

module.exports = { syncNow, getStatus, getOrganizations, getContacts, getVouchers, getVoucher, getAccounts, getItems, getBankAccounts, getBankTransactions };

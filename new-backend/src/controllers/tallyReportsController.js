/**
 * tallyReportsController.js — the read side of the Tally Dashboard.
 *
 * Everything here is computed from what the connector stored (tallyController.js):
 * ledgers + groups give the chart of accounts, voucher ledger lines give every
 * movement, so statements can be drawn for ANY period and drilled from a group
 * down to the voucher that moved it. Nothing is asked of Tally at read time.
 *
 * Tally's sign convention is kept throughout: negative = Debit, positive = Credit.
 * Every query is scoped by company_id (= req.params.id); the brand routes add a
 * middleware that checks the company belongs to the brand.
 */

const { masterSequelize } = require('../config/database');

const q = (sql, bind) => masterSequelize.query(sql, { bind, type: masterSequelize.QueryTypes.SELECT });
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });
const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const n = (v) => Number(v) || 0;
const r2 = (v) => Math.round(n(v) * 100) / 100;

// Voucher types that never touch the books (orders, notes, memos). Matched on
// Tally's own base type, so a company's renamed/derived types are handled too.
const NON_ACCOUNTING = new Set(['sales order', 'purchase order', 'delivery note', 'receipt note', 'rejections in',
  'rejections out', 'stock journal', 'physical stock', 'memorandum', 'reversing journal', 'material in', 'material out',
  'job work in order', 'job work out order', 'attendance']);

/* ── chart of accounts ──────────────────────────────────────────────────────
   Groups form a tree; each group says whether it is P&L (is_revenue) and whether
   it is debit-natured (is_deemed_positive). From those two flags every ledger is
   an asset, a liability, income or an expense — no group names are assumed. */
async function loadChart(companyId) {
  const groups = await q(`SELECT name, parent, data FROM tally_masters WHERE company_id = $1 AND kind = 'group'`, [companyId]);
  const vtypes = await q(`SELECT name, parent, data FROM tally_masters WHERE company_id = $1 AND kind = 'voucher_type'`, [companyId]);
  const byName = new Map(groups.map((g) => [g.name, g]));

  const pathCache = new Map();
  /** [root … this group], following parents; stops at a primary group. */
  const pathOf = (name) => {
    if (pathCache.has(name)) return pathCache.get(name);
    const out = []; const seen = new Set();
    for (let cur = name; cur && byName.has(cur) && !seen.has(cur); cur = byName.get(cur).parent) { seen.add(cur); out.unshift(cur); }
    pathCache.set(name, out);
    return out;
  };
  /** Tally's built-in name of each group on the path (survives a rename). */
  const reservedOf = (name) => pathOf(name).map((g) => ((byName.get(g).data || {}).reserved || g).toLowerCase());
  const natureOf = (groupName) => {
    const g = byName.get(groupName);
    if (!g) return 'unclassified';
    const d = g.data || {};
    return d.is_revenue ? (d.is_deemed_positive ? 'expense' : 'income') : (d.is_deemed_positive ? 'asset' : 'liability');
  };

  const vt = new Map(vtypes.map((v) => [v.name, v]));
  const baseCache = new Map();
  /** Tally's base voucher type (Sales, Purchase, Receipt…) for a company-defined type. */
  const baseOf = (typeName) => {
    if (baseCache.has(typeName)) return baseCache.get(typeName);
    let cur = typeName; const seen = new Set(); let base = typeName;
    while (cur && vt.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const row = vt.get(cur);
      base = (row.data && row.data.reserved) || cur;
      if (row.data && row.data.reserved) break;
      if (!row.parent || row.parent === cur) break;
      cur = row.parent;
    }
    baseCache.set(typeName, base);
    return base;
  };
  const nonAccounting = vtypes.map((v) => v.name).filter((name) => NON_ACCOUNTING.has(String(baseOf(name)).toLowerCase()));
  // Before the masters have synced there is no type tree: fall back to the names themselves.
  for (const name of NON_ACCOUNTING) nonAccounting.push(name);

  return { groups, byName, pathOf, reservedOf, natureOf, baseOf, nonAccounting };
}

/* Ledger balances for a period: opening (as at `from`), debits and credits inside
   it, and closing. With no dates it is the life of the books. */
async function loadBooks(companyId, from, to) {
  const chart = await loadChart(companyId);
  const ledgers = await q(
    `SELECT id, name, parent, opening_balance, closing_balance FROM tally_ledgers WHERE company_id = $1 ORDER BY name`, [companyId]);
  const moves = await q(
    `SELECT e->>'ledger' AS ledger,
            COALESCE(sum(a.amt) FILTER (WHERE $2::date IS NOT NULL AND v.voucher_date < $2::date), 0) AS before,
            COALESCE(sum(a.amt) FILTER (WHERE ($2::date IS NULL OR v.voucher_date >= $2::date) AND a.amt < 0), 0) AS debit,
            COALESCE(sum(a.amt) FILTER (WHERE ($2::date IS NULL OR v.voucher_date >= $2::date) AND a.amt > 0), 0) AS credit
       FROM tally_vouchers v
      CROSS JOIN LATERAL jsonb_array_elements(v.ledger_entries) e
      CROSS JOIN LATERAL (SELECT (e->>'amount')::numeric AS amt) a
      WHERE v.company_id = $1 AND NOT v.is_cancelled AND NOT v.is_optional
        AND v.voucher_type <> ALL($4::text[])
        AND ($3::date IS NULL OR v.voucher_date <= $3::date)
      GROUP BY 1`,
    [companyId, from, to, chart.nonAccounting]);
  const mv = new Map(moves.map((m) => [m.ledger, m]));

  // Closing stock is not posted by vouchers — Tally works it out (or the accountant
  // keys it in) on the Stock-in-Hand ledgers. We only hold its CURRENT value, so
  // it can be used for the life of the books, not for an arbitrary period.
  const allTime = !from && !to;
  const stock = { opening: 0, closing: 0, adjusted: false, current: null };
  let matched = 0; let compared = 0;
  const rows = ledgers.map((l) => {
    const m = mv.get(l.name) || {};
    const opening = r2(n(l.opening_balance) + n(m.before));
    const debit = r2(m.debit); const credit = r2(m.credit);
    let closing = r2(opening + debit + credit);
    const isStock = chart.reservedOf(l.parent).includes('stock-in-hand');
    if (isStock) {
      // What Tally holds on the ledger right now — the same whatever period is asked for.
      if (l.closing_balance !== null) stock.current = (stock.current || 0) - n(l.closing_balance);
      stock.opening += -opening;
      if (allTime && l.closing_balance !== null) { closing = n(l.closing_balance); stock.adjusted = true; }
      stock.closing += -closing;
    }
    if (allTime) { compared++; if (Math.abs(closing - n(l.closing_balance)) < 1) matched++; }
    return {
      id: l.id, name: l.name, parent: l.parent, nature: chart.natureOf(l.parent),
      opening, debit, credit, closing, tally_closing: l.closing_balance === null ? null : n(l.closing_balance),
    };
  });
  stock.opening = r2(stock.opening); stock.closing = r2(stock.closing);
  if (stock.current !== null) stock.current = r2(stock.current);
  stock.change = stock.adjusted ? r2(stock.closing - stock.opening) : 0;
  return { chart, ledgers: rows, stock, reconciled: allTime ? { matched, total: compared } : null };
}

const period = (req) => ({ from: date(req.query.from), to: date(req.query.to) });
const underAny = (chart, group, names) => { const p = chart.reservedOf(group); return names.some((x) => p.includes(x)); };

/** Indian financial years covered by the vouchers, newest first. */
const financialYears = (minDate, maxDate) => {
  if (!minDate || !maxDate) return [];
  const fyStart = (d) => { const x = new Date(d); return x.getUTCMonth() >= 3 ? x.getUTCFullYear() : x.getUTCFullYear() - 1; };
  const out = [];
  for (let y = fyStart(maxDate); y >= fyStart(minDate); y--) {
    out.push({ label: `FY ${y}-${String(y + 1).slice(2)}`, from: `${y}-04-01`, to: `${y + 1}-03-31` });
  }
  return out;
};

const daysBetween = (asOf, d) => Math.floor((new Date(asOf).getTime() - new Date(d).getTime()) / 86400000);
const ageBucket = (asOf, billDate) => {
  if (!billDate) return 4;
  const days = daysBetween(asOf, billDate);
  return days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : days <= 180 ? 3 : 4;
};

/* Bill-wise outstanding, per party. A party is a receivable if its bills net to
   a debit, a payable if they net to a credit. Bills the other way round (receipts
   or payments not yet set against an invoice) are shown as "unadjusted" and
   reduce the party's total, so the totals agree with the party ledgers.
   Age is counted to the date of the last voucher in the books, not to today —
   books that are a few months behind would otherwise all read as overdue. */
async function loadOutstanding(companyId) {
  const [meta] = await q(`SELECT max(voucher_date) AS as_of FROM tally_vouchers WHERE company_id = $1`, [companyId]);
  const today = new Date().toISOString().slice(0, 10);
  const asOf = meta && meta.as_of && meta.as_of < today ? meta.as_of : today;
  const bills = await q(
    `SELECT b.party, b.name, b.bill_date, b.credit_period, b.closing, b.is_advance, l.id AS ledger_id, l.parent AS party_group
       FROM tally_bills b JOIN tally_companies co ON co.id = b.company_id AND co.bills_run_id = b.sync_run_id
       LEFT JOIN tally_ledgers l ON l.company_id = b.company_id AND l.name = b.party
      WHERE b.company_id = $1 ORDER BY b.bill_date NULLS LAST`, [companyId]);
  const byParty = new Map();
  for (const b of bills) {
    const p = byParty.get(b.party) || { party: b.party, ledger_id: b.ledger_id, group: b.party_group, net: 0, rows: [] };
    p.net += n(b.closing); p.rows.push(b); byParty.set(b.party, p);
  }
  const sides = { receivable: [], payable: [] };
  for (const p of byParty.values()) {
    if (Math.abs(p.net) < 0.005) continue;
    const dir = p.net < 0 ? -1 : 1;                 // -1: they owe us (Dr) · +1: we owe them (Cr)
    const out = { party: p.party, ledger_id: p.ledger_id, group: p.group, total: r2(Math.abs(p.net)), buckets: [0, 0, 0, 0, 0], unadjusted: 0, bills: [], oldest: null };
    for (const b of p.rows) {
      const c = n(b.closing); const owed = Math.sign(c) === dir;
      if (owed) { out.buckets[ageBucket(asOf, b.bill_date)] += Math.abs(c); if (b.bill_date && (!out.oldest || b.bill_date < out.oldest)) out.oldest = b.bill_date; }
      else out.unadjusted += Math.abs(c);
      out.bills.push({ name: b.name, bill_date: b.bill_date, credit_period: b.credit_period, amount: r2(owed ? Math.abs(c) : -Math.abs(c)),
        is_advance: b.is_advance, unadjusted: !owed, days: b.bill_date ? daysBetween(asOf, b.bill_date) : null });
    }
    out.buckets = out.buckets.map(r2); out.unadjusted = r2(out.unadjusted);
    sides[dir < 0 ? 'receivable' : 'payable'].push(out);
  }
  const pack = (parties) => {
    parties.sort((a, b) => b.total - a.total);
    const buckets = [0, 0, 0, 0, 0];
    for (const p of parties) p.buckets.forEach((v, i) => { buckets[i] += v; });
    return { total: r2(parties.reduce((s, p) => s + p.total, 0)), buckets: buckets.map(r2),
      unadjusted: r2(parties.reduce((s, p) => s + p.unadjusted, 0)), parties, bill_count: parties.reduce((s, p) => s + p.bills.length, 0) };
  };
  return { as_of: asOf, labels: AGE_LABELS, receivable: pack(sides.receivable), payable: pack(sides.payable) };
}
const AGE_LABELS = ['0–30 days', '31–60 days', '61–90 days', '91–180 days', 'Over 180 days'];

// ═════════════════════════════════════════════════════════════════════════════

/* GET …/companies/:id/overview?from=&to= — the dashboard landing: KPIs, trends, rankings. */
const getOverview = async (req, res, next) => {
  try {
    const id = req.params.id; const { from, to } = period(req);
    const [company] = await q(
      `SELECT co.id, co.name, co.books_from, co.profile, co.last_sync_at, co.last_sync_status, co.last_error, co.data_version,
              c.machine_name, c.tally_host, c.tally_port, c.last_seen_at, c.last_status, c.connector_version
         FROM tally_companies co LEFT JOIN tally_connectors c ON c.id = co.connector_id WHERE co.id = $1`, [id]);
    if (!company) return bad(res, 'Company not found', 404);

    const { chart, ledgers, stock: bookStock, reconciled } = await loadBooks(id, from, to);
    const [counts] = await q(
      `SELECT (SELECT count(*)::int FROM tally_ledgers WHERE company_id = $1) AS ledgers,
              (SELECT count(*)::int FROM tally_vouchers WHERE company_id = $1) AS vouchers,
              (SELECT count(*)::int FROM tally_masters WHERE company_id = $1 AND kind = 'group') AS groups,
              (SELECT count(*)::int FROM tally_masters WHERE company_id = $1 AND kind = 'stock_item') AS stock_items,
              (SELECT count(*)::int FROM tally_masters WHERE company_id = $1 AND kind = 'voucher_type') AS voucher_types,
              (SELECT count(*)::int FROM tally_masters WHERE company_id = $1 AND kind = 'godown') AS godowns,
              (SELECT count(*)::int FROM tally_bills b JOIN tally_companies co ON co.id = b.company_id AND co.bills_run_id = b.sync_run_id WHERE b.company_id = $1) AS bills,
              (SELECT min(voucher_date) FROM tally_vouchers WHERE company_id = $1) AS min_date,
              (SELECT max(voucher_date) FROM tally_vouchers WHERE company_id = $1) AS max_date`, [id]);

    // ── KPIs from the ledger balances ──────────────────────────────────────
    const k = { revenue: 0, other_income: 0, cost_of_sales: 0, operating_expenses: 0, receivables: 0, payables: 0,
      cash_bank: 0, duties_taxes: 0, loans: 0, capital: 0, fixed_assets: 0, customer_credits: 0, supplier_debits: 0 };
    const cashBank = [];
    for (const l of ledgers) {
      const move = l.debit + l.credit;
      const g = chart.byName.get(l.parent); const d = (g && g.data) || {};
      if (l.nature === 'income') { if (underAny(chart, l.parent, ['sales accounts'])) k.revenue += move; else k.other_income += move; }
      if (l.nature === 'expense') { if (d.affects_gross_profit) k.cost_of_sales += -move; else k.operating_expenses += -move; }
      // A customer in credit (paid ahead) is not a receivable, and a supplier in debit is not a payable.
      if (underAny(chart, l.parent, ['sundry debtors'])) { if (l.closing < 0) k.receivables += -l.closing; else k.customer_credits += l.closing; }
      if (underAny(chart, l.parent, ['sundry creditors'])) { if (l.closing > 0) k.payables += l.closing; else k.supplier_debits += -l.closing; }
      if (underAny(chart, l.parent, ['bank accounts', 'cash-in-hand', 'bank od a/c', 'bank occ a/c'])) {
        k.cash_bank += -l.closing;
        if (l.closing || l.debit || l.credit) cashBank.push({ id: l.id, name: l.name, group: l.parent, closing: l.closing });
      }
      if (underAny(chart, l.parent, ['duties & taxes'])) k.duties_taxes += l.closing;
      if (underAny(chart, l.parent, ['loans (liability)'])) k.loans += l.closing;
      if (underAny(chart, l.parent, ['capital account'])) k.capital += l.closing;
      if (underAny(chart, l.parent, ['fixed assets'])) k.fixed_assets += -l.closing;
    }
    const [stock] = await q(
      `SELECT COALESCE(sum(abs((data->>'closing_value')::numeric)), 0) AS closing, COALESCE(sum(abs((data->>'opening_value')::numeric)), 0) AS opening
         FROM tally_masters WHERE company_id = $1 AND kind = 'stock_item'`, [id]);
    const income = k.revenue + k.other_income; const expenses = k.cost_of_sales + k.operating_expenses;
    const kpis = {
      revenue: r2(k.revenue), other_income: r2(k.other_income), cost_of_sales: r2(k.cost_of_sales),
      operating_expenses: r2(k.operating_expenses), total_income: r2(income), total_expenses: r2(expenses),
      // With the stock change included these are Tally's own P&L figures; without it
      // (any period other than the life of the books) they are before stock adjustment.
      stock_adjusted: bookStock.adjusted, opening_stock: bookStock.opening, closing_stock: bookStock.closing, stock_change: bookStock.change,
      gross_margin: r2(k.revenue - k.cost_of_sales + bookStock.change), net_profit: r2(income - expenses + bookStock.change),
      receivables: r2(k.receivables), payables: r2(k.payables), customer_credits: r2(k.customer_credits), supplier_debits: r2(k.supplier_debits),
      cash_bank: r2(k.cash_bank), duties_taxes: r2(k.duties_taxes), loans: r2(k.loans), capital: r2(k.capital), fixed_assets: r2(k.fixed_assets),
      stock_value: bookStock.current !== null ? bookStock.current : r2(stock.closing),
      stock_basis: bookStock.current !== null ? 'books' : 'items', item_valuation: r2(stock.closing),
    };

    // ── monthly trend, from every ledger line ──────────────────────────────
    const lines = await q(
      `SELECT to_char(date_trunc('month', v.voucher_date), 'YYYY-MM') AS month, e->>'ledger' AS ledger, sum((e->>'amount')::numeric) AS amt
         FROM tally_vouchers v CROSS JOIN LATERAL jsonb_array_elements(v.ledger_entries) e
        WHERE v.company_id = $1 AND NOT v.is_cancelled AND NOT v.is_optional AND v.voucher_type <> ALL($4::text[])
          AND v.voucher_date IS NOT NULL
          AND ($2::date IS NULL OR v.voucher_date >= $2::date) AND ($3::date IS NULL OR v.voucher_date <= $3::date)
        GROUP BY 1, 2`, [id, from, to, chart.nonAccounting]);
    const groupOfLedger = new Map(ledgers.map((l) => [l.name, l]));
    const months = new Map();
    const bucket = (m) => { if (!months.has(m)) months.set(m, { month: m, sales: 0, other_income: 0, cost_of_sales: 0, operating_expenses: 0, receipts: 0, payments: 0, vouchers: 0 }); return months.get(m); };
    for (const row of lines) {
      const l = groupOfLedger.get(row.ledger); if (!l) continue;
      const b = bucket(row.month); const amt = n(row.amt);
      const d = (chart.byName.get(l.parent) || {}).data || {};
      if (l.nature === 'income') { if (underAny(chart, l.parent, ['sales accounts'])) b.sales += amt; else b.other_income += amt; }
      else if (l.nature === 'expense') { if (d.affects_gross_profit) b.cost_of_sales += -amt; else b.operating_expenses += -amt; }
    }

    // ── voucher mix, receipts/payments, top parties ────────────────────────
    const byType = await q(
      `SELECT voucher_type, to_char(date_trunc('month', voucher_date), 'YYYY-MM') AS month, count(*)::int AS count, COALESCE(sum(amount), 0) AS amount
         FROM tally_vouchers WHERE company_id = $1 AND NOT is_cancelled AND NOT is_optional AND voucher_date IS NOT NULL
          AND ($2::date IS NULL OR voucher_date >= $2::date) AND ($3::date IS NULL OR voucher_date <= $3::date)
        GROUP BY 1, 2`, [id, from, to]);
    const mix = new Map();
    for (const row of byType) {
      const base = chart.baseOf(row.voucher_type);
      const m = mix.get(base) || { base, count: 0, amount: 0, types: new Map() };
      m.count += row.count; m.amount += n(row.amount);
      const t = m.types.get(row.voucher_type) || { type: row.voucher_type, count: 0, amount: 0 };
      t.count += row.count; t.amount += n(row.amount); m.types.set(row.voucher_type, t);
      mix.set(base, m);
      const b = bucket(row.month); b.vouchers += row.count;
      if (base === 'Receipt') b.receipts += n(row.amount);
      if (base === 'Payment') b.payments += n(row.amount);
    }
    const typesOfBase = (base) => [...mix.values()].filter((m) => m.base === base).flatMap((m) => [...m.types.keys()]);
    const topParties = (types) => (types.length ? q(
      `SELECT party_name AS name, count(*)::int AS count, sum(amount) AS amount FROM tally_vouchers
        WHERE company_id = $1 AND NOT is_cancelled AND NOT is_optional AND party_name IS NOT NULL AND voucher_type = ANY($4::text[])
          AND ($2::date IS NULL OR voucher_date >= $2::date) AND ($3::date IS NULL OR voucher_date <= $3::date)
        GROUP BY 1 ORDER BY 3 DESC LIMIT 10`, [id, from, to, types]) : []);
    const salesTypes = typesOfBase('Sales'); const purchaseTypes = typesOfBase('Purchase');
    const [topCustomers, topVendors] = await Promise.all([topParties(salesTypes), topParties(purchaseTypes)]);
    const topItems = salesTypes.length ? await q(
      `SELECT i->>'item' AS item, sum((i->>'qty')::numeric) AS qty, sum(abs((i->>'amount')::numeric)) AS amount, count(*)::int AS lines
         FROM tally_vouchers v CROSS JOIN LATERAL jsonb_array_elements(v.details->'inventory') i
        WHERE v.company_id = $1 AND NOT v.is_cancelled AND NOT v.is_optional AND v.voucher_type = ANY($4::text[])
          AND ($2::date IS NULL OR v.voucher_date >= $2::date) AND ($3::date IS NULL OR v.voucher_date <= $3::date)
        GROUP BY 1 ORDER BY 3 DESC LIMIT 10`, [id, from, to, salesTypes]) : [];

    // ── ageing of what is owed either way ──────────────────────────────────
    const os = await loadOutstanding(id);
    // Where Tally keeps bill-wise details, the headline uses them (the same figures
    // as the Receivables / Payables tabs); otherwise the debtor/creditor ledgers.
    kpis.outstanding_basis = os.receivable.parties.length || os.payable.parties.length ? 'bills' : 'ledgers';
    if (kpis.outstanding_basis === 'bills') { kpis.receivables = os.receivable.total; kpis.payables = os.payable.total; }
    const ageing = { labels: os.labels, as_of: os.as_of, receivable: os.receivable.buckets, payable: os.payable.buckets,
      receivable_total: os.receivable.total, payable_total: os.payable.total };

    res.json({
      company: { id: company.id, name: company.name, books_from: company.books_from, profile: company.profile || {},
        last_sync_at: company.last_sync_at, last_sync_status: company.last_sync_status, last_error: company.last_error, data_version: company.data_version },
      connector: company.machine_name ? { machine_name: company.machine_name, tally_host: company.tally_host, tally_port: company.tally_port,
        last_seen_at: company.last_seen_at, last_status: company.last_status, version: company.connector_version } : null,
      counts,
      period: { from, to, min_date: counts.min_date, max_date: counts.max_date, years: financialYears(counts.min_date, counts.max_date) },
      kpis,
      monthly: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({
        month: m.month, sales: r2(m.sales), other_income: r2(m.other_income), cost_of_sales: r2(m.cost_of_sales),
        operating_expenses: r2(m.operating_expenses), surplus: r2(m.sales + m.other_income - m.cost_of_sales - m.operating_expenses),
        receipts: r2(m.receipts), payments: r2(m.payments), vouchers: m.vouchers })),
      voucher_mix: [...mix.values()].map((m) => ({ base: m.base, count: m.count, amount: r2(m.amount),
        types: [...m.types.values()].map((t) => ({ ...t, amount: r2(t.amount) })).sort((a, b) => b.count - a.count) })).sort((a, b) => b.count - a.count),
      top_customers: topCustomers.map((p) => ({ ...p, amount: r2(p.amount) })),
      top_vendors: topVendors.map((p) => ({ ...p, amount: r2(p.amount) })),
      top_items: topItems.map((p) => ({ ...p, qty: n(p.qty), amount: r2(p.amount) })),
      cash_bank: cashBank.sort((a, b) => a.closing - b.closing),
      ageing, reconciled,
    });
  } catch (e) { next(e); }
};

/* GET …/companies/:id/books?from=&to= — the chart of accounts with balances; the UI
   draws Trial Balance, P&L and Balance Sheet from it and drills group → ledger. */
const getBooks = async (req, res, next) => {
  try {
    const { from, to } = period(req);
    const { chart, ledgers, stock, reconciled } = await loadBooks(req.params.id, from, to);
    res.json({
      period: { from, to }, stock,
      groups: chart.groups.map((g) => ({ name: g.name, parent: chart.byName.has(g.parent) ? g.parent : null,
        reserved: (g.data || {}).reserved || null, nature: chart.natureOf(g.name), affects_gross_profit: !!(g.data || {}).affects_gross_profit })),
      ledgers, reconciled,
    });
  } catch (e) { next(e); }
};

/* GET …/companies/:id/ledger-statement?ledger_id=|name=&from=&to=&limit=&offset=
   One ledger: its master details, every voucher that touched it with a running
   balance, the month-by-month movement, and (for a party) its open bills. */
const getLedgerStatement = async (req, res, next) => {
  try {
    const id = req.params.id; const { from, to } = period(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const byId = /^\d+$/.test(String(req.query.ledger_id || ''));
    const [ledger] = await q(
      `SELECT id, name, parent, opening_balance, closing_balance, gstin, details FROM tally_ledgers
        WHERE company_id = $1 AND ${byId ? 'id = $2::bigint' : 'name = $2'}`, [id, byId ? req.query.ledger_id : String(req.query.name || '')]);
    if (!ledger) return bad(res, 'Ledger not found', 404);
    const chart = await loadChart(id);
    const contains = JSON.stringify([{ ledger: ledger.name }]);
    const lineAmount = `(SELECT COALESCE(sum((e->>'amount')::numeric), 0) FROM jsonb_array_elements(v.ledger_entries) e WHERE e->>'ledger' = $2)`;
    const scope = `v.company_id = $1 AND v.ledger_entries @> $3::jsonb AND NOT v.is_cancelled AND NOT v.is_optional AND v.voucher_type <> ALL($4::text[])`;

    const [before] = await q(
      `SELECT COALESCE(sum(${lineAmount}), 0) AS amt FROM tally_vouchers v WHERE ${scope} AND $5::date IS NOT NULL AND v.voucher_date < $5::date`,
      [id, ledger.name, contains, chart.nonAccounting, from]);
    const opening = r2(n(ledger.opening_balance) + n(before.amt));
    const inPeriod = `${scope} AND ($5::date IS NULL OR v.voucher_date >= $5::date) AND ($6::date IS NULL OR v.voucher_date <= $6::date)`;
    const bind = [id, ledger.name, contains, chart.nonAccounting, from, to];

    const rows = await q(
      `SELECT * FROM (
         SELECT v.id, v.voucher_date, v.voucher_type, v.voucher_number, v.party_name, v.narration, v.alter_id, ${lineAmount} AS amount,
                (SELECT e->>'ledger' FROM jsonb_array_elements(v.ledger_entries) e WHERE e->>'ledger' <> $2
                  ORDER BY abs((e->>'amount')::numeric) DESC NULLS LAST LIMIT 1) AS particulars,
                sum(${lineAmount}) OVER (ORDER BY v.voucher_date, v.alter_id) AS running
           FROM tally_vouchers v WHERE ${inPeriod}) s
        ORDER BY voucher_date DESC NULLS LAST, alter_id DESC LIMIT $7 OFFSET $8`, [...bind, limit, offset]);
    const [tot] = await q(
      `SELECT count(*)::int AS total, COALESCE(sum(x.amt) FILTER (WHERE x.amt < 0), 0) AS debit, COALESCE(sum(x.amt) FILTER (WHERE x.amt > 0), 0) AS credit
         FROM (SELECT ${lineAmount} AS amt FROM tally_vouchers v WHERE ${inPeriod}) x`, bind);
    const monthly = await q(
      `SELECT to_char(date_trunc('month', v.voucher_date), 'YYYY-MM') AS month,
              COALESCE(sum(x.amt) FILTER (WHERE x.amt < 0), 0) AS debit, COALESCE(sum(x.amt) FILTER (WHERE x.amt > 0), 0) AS credit, count(*)::int AS count
         FROM tally_vouchers v CROSS JOIN LATERAL (SELECT ${lineAmount} AS amt) x
        WHERE ${inPeriod} AND v.voucher_date IS NOT NULL GROUP BY 1 ORDER BY 1`, bind);
    const bills = await q(
      `SELECT b.name, b.bill_date, b.credit_period, b.closing, b.is_advance FROM tally_bills b
         JOIN tally_companies co ON co.id = b.company_id AND co.bills_run_id = b.sync_run_id
        WHERE b.company_id = $1 AND b.party = $2 ORDER BY b.bill_date NULLS LAST`, [id, ledger.name]);

    res.json({
      ledger: { id: ledger.id, name: ledger.name, parent: ledger.parent, path: chart.pathOf(ledger.parent), nature: chart.natureOf(ledger.parent),
        gstin: ledger.gstin, details: ledger.details || {}, tally_closing: ledger.closing_balance === null ? null : n(ledger.closing_balance) },
      period: { from, to }, opening, debit: r2(tot.debit), credit: r2(tot.credit), closing: r2(opening + n(tot.debit) + n(tot.credit)),
      total: tot.total, limit, offset,
      rows: rows.map((r) => ({ ...r, amount: r2(r.amount), balance: r2(opening + n(r.running)), running: undefined })),
      monthly: monthly.map((m) => ({ month: m.month, debit: r2(m.debit), credit: r2(m.credit), count: m.count })),
      bills: bills.map((b) => ({ ...b, closing: n(b.closing) })),
    });
  } catch (e) { next(e); }
};

/* GET …/companies/:id/vouchers/:vid — one voucher in full. */
const getVoucher = async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.vid)) return bad(res, 'Invalid voucher id');
    const [v] = await q(
      `SELECT id, guid, voucher_date, voucher_type, voucher_number, party_name, amount, narration, is_cancelled, is_optional,
              alter_id, ledger_entries, details, synced_at FROM tally_vouchers WHERE company_id = $1 AND id = $2::bigint`,
      [req.params.id, req.params.vid]);
    if (!v) return bad(res, 'Voucher not found', 404);
    const chart = await loadChart(req.params.id);
    const names = [...new Set((v.ledger_entries || []).map((e) => e.ledger))];
    const ids = names.length ? await q(`SELECT id, name, parent FROM tally_ledgers WHERE company_id = $1 AND name = ANY($2::text[])`, [req.params.id, names]) : [];
    const byName = new Map(ids.map((l) => [l.name, l]));
    res.json({
      ...v, amount: n(v.amount), base_type: chart.baseOf(v.voucher_type), details: v.details || {},
      ledger_entries: (v.ledger_entries || []).map((e) => ({ ...e, ledger_id: (byName.get(e.ledger) || {}).id || null, group: (byName.get(e.ledger) || {}).parent || null })),
    });
  } catch (e) { next(e); }
};

/* GET …/companies/:id/outstanding — bill-wise receivables and payables by party, aged. */
const getOutstanding = async (req, res, next) => {
  try { res.json(await loadOutstanding(req.params.id)); } catch (e) { next(e); }
};

/* GET …/companies/:id/inventory?from=&to= — stock items with what moved in and out. */
const getInventory = async (req, res, next) => {
  try {
    const id = req.params.id; const { from, to } = period(req);
    const chart = await loadChart(id);
    const items = await q(`SELECT guid, name, parent, data FROM tally_masters WHERE company_id = $1 AND kind = 'stock_item' ORDER BY name`, [id]);
    const groups = await q(`SELECT name, parent FROM tally_masters WHERE company_id = $1 AND kind = 'stock_group' ORDER BY name`, [id]);
    const godowns = await q(`SELECT name, parent FROM tally_masters WHERE company_id = $1 AND kind = 'godown' ORDER BY name`, [id]);
    const moves = await q(
      `SELECT i->>'item' AS item, v.voucher_type, sum((i->>'qty')::numeric) AS qty, sum(abs((i->>'amount')::numeric)) AS amount, count(*)::int AS lines
         FROM tally_vouchers v CROSS JOIN LATERAL jsonb_array_elements(v.details->'inventory') i
        WHERE v.company_id = $1 AND NOT v.is_cancelled AND NOT v.is_optional
          AND ($2::date IS NULL OR v.voucher_date >= $2::date) AND ($3::date IS NULL OR v.voucher_date <= $3::date)
        GROUP BY 1, 2`, [id, from, to]);
    const agg = new Map();
    for (const m of moves) {
      const base = String(chart.baseOf(m.voucher_type)).toLowerCase();
      const a = agg.get(m.item) || { sold_qty: 0, sold_value: 0, bought_qty: 0, bought_value: 0, returned_qty: 0, returned_value: 0, lines: 0 };
      const key = base === 'sales' ? 'sold' : base === 'purchase' ? 'bought' : (base === 'credit note' || base === 'debit note') ? 'returned' : null;
      if (key) { a[`${key}_qty`] += n(m.qty); a[`${key}_value`] += n(m.amount); }
      a.lines += m.lines; agg.set(m.item, a);
    }
    const rows = items.map((it) => {
      const d = it.data || {}; const a = agg.get(it.name) || {};
      return { guid: it.guid, name: it.name, group: it.parent, unit: d.unit || null, category: d.category || null, hsn: d.hsn || null,
        gst_rate: d.gst_rate ?? null, closing_qty: n(d.closing_qty), closing_value: Math.abs(n(d.closing_value)), closing_rate: n(d.closing_rate),
        opening_qty: n(d.opening_qty), opening_value: Math.abs(n(d.opening_value)),
        sold_qty: n(a.sold_qty), sold_value: r2(a.sold_value), bought_qty: n(a.bought_qty), bought_value: r2(a.bought_value),
        returned_qty: n(a.returned_qty), returned_value: r2(a.returned_value), lines: a.lines || 0 };
    });
    res.json({
      period: { from, to }, groups, godowns, items: rows,
      totals: { items: rows.length, in_stock: rows.filter((x) => x.closing_qty > 0).length, closing_value: r2(rows.reduce((s, x) => s + x.closing_value, 0)),
        sold_value: r2(rows.reduce((s, x) => s + x.sold_value, 0)), bought_value: r2(rows.reduce((s, x) => s + x.bought_value, 0)) },
    });
  } catch (e) { next(e); }
};

// Tally does not say whether a GST ledger collects output tax or holds input credit.
// The ledger's own name usually does ("HR Input CGST", "Output IGST 12%"); when it
// does not, the direction it mostly moved in decides.
const gstSide = (l) => (/\b(input|itc)\b/i.test(l.name) ? 'input'
  : /\b(output|payable)\b/i.test(l.name) ? 'output'
    : Math.abs(l.debit) > l.credit ? 'input' : 'output');

/* GET …/companies/:id/gst?from=&to= — registrations, every GST ledger, month-wise tax, HSN and rate summaries. */
const getGst = async (req, res, next) => {
  try {
    const id = req.params.id; const { from, to } = period(req);
    const [company] = await q(`SELECT profile FROM tally_companies WHERE id = $1`, [id]);
    const { chart, ledgers } = await loadBooks(id, from, to);
    const detail = await q(`SELECT name, details FROM tally_ledgers WHERE company_id = $1 AND details->>'tax_type' = 'GST'`, [id]);
    const head = new Map(detail.map((d) => [d.name, (d.details || {}).gst_duty_head || 'GST']));
    const taxLedgers = ledgers.filter((l) => head.has(l.name)).map((l) => ({
      id: l.id, name: l.name, group: l.parent, head: head.get(l.name), opening: l.opening, debit: l.debit, credit: l.credit, closing: l.closing,
      side: gstSide(l) }));
    const side = new Map(taxLedgers.map((l) => [l.name, l]));
    const lines = taxLedgers.length ? await q(
      `SELECT to_char(date_trunc('month', v.voucher_date), 'YYYY-MM') AS month, e->>'ledger' AS ledger, sum((e->>'amount')::numeric) AS amt
         FROM tally_vouchers v CROSS JOIN LATERAL jsonb_array_elements(v.ledger_entries) e
        WHERE v.company_id = $1 AND NOT v.is_cancelled AND NOT v.is_optional AND v.voucher_type <> ALL($4::text[]) AND v.voucher_date IS NOT NULL
          AND e->>'ledger' = ANY($5::text[])
          AND ($2::date IS NULL OR v.voucher_date >= $2::date) AND ($3::date IS NULL OR v.voucher_date <= $3::date)
        GROUP BY 1, 2`, [id, from, to, chart.nonAccounting, taxLedgers.map((l) => l.name)]) : [];
    const months = new Map();
    for (const r of lines) {
      const l = side.get(r.ledger); if (!l) continue;
      const m = months.get(r.month) || { month: r.month, output: 0, input: 0 };
      if (l.side === 'output') m.output += n(r.amt); else m.input += -n(r.amt);
      months.set(r.month, m);
    }
    const salesTypes = (await q(`SELECT DISTINCT voucher_type FROM tally_vouchers WHERE company_id = $1`, [id]))
      .map((x) => x.voucher_type).filter((t) => chart.baseOf(t) === 'Sales');
    const hsn = salesTypes.length ? await q(
      `SELECT COALESCE(i->>'hsn', '—') AS hsn, (i->>'gst_rate')::numeric AS gst_rate, sum((i->>'qty')::numeric) AS qty,
              sum(abs((i->>'amount')::numeric)) AS taxable, count(DISTINCT v.id)::int AS vouchers
         FROM tally_vouchers v CROSS JOIN LATERAL jsonb_array_elements(v.details->'inventory') i
        WHERE v.company_id = $1 AND NOT v.is_cancelled AND NOT v.is_optional AND v.voucher_type = ANY($4::text[])
          AND ($2::date IS NULL OR v.voucher_date >= $2::date) AND ($3::date IS NULL OR v.voucher_date <= $3::date)
        GROUP BY 1, 2 ORDER BY 4 DESC`, [id, from, to, salesTypes]) : [];
    const rates = new Map();
    for (const h of hsn) { const key = h.gst_rate === null ? 'n/a' : String(n(h.gst_rate)); rates.set(key, (rates.get(key) || 0) + n(h.taxable)); }
    res.json({
      period: { from, to },
      registrations: ((company && company.profile) || {}).gst_registrations || [],
      tax_ledgers: taxLedgers.sort((a, b) => Math.abs(b.debit) + b.credit - (Math.abs(a.debit) + a.credit)),
      totals: { output: r2(taxLedgers.filter((l) => l.side === 'output').reduce((s, l) => s + l.credit + l.debit, 0)),
        input: r2(taxLedgers.filter((l) => l.side === 'input').reduce((s, l) => s - l.debit - l.credit, 0)),
        net_payable: r2(taxLedgers.reduce((s, l) => s + l.closing, 0)) },
      monthly: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({ month: m.month, output: r2(m.output), input: r2(m.input) })),
      hsn: hsn.map((h) => ({ hsn: h.hsn, gst_rate: h.gst_rate === null ? null : n(h.gst_rate), qty: n(h.qty), taxable: r2(h.taxable), vouchers: h.vouchers })),
      rates: [...rates.entries()].map(([rate, taxable]) => ({ rate, taxable: r2(taxable) })).sort((a, b) => b.taxable - a.taxable),
    });
  } catch (e) { next(e); }
};

/* GET …/companies/:id/masters?kind= — any master list as Tally holds it. */
const getMasters = async (req, res, next) => {
  try {
    const kind = String(req.query.kind || '');
    const counts = await q(`SELECT kind, count(*)::int AS count FROM tally_masters WHERE company_id = $1 GROUP BY 1`, [req.params.id]);
    const rows = kind ? await q(`SELECT guid, name, parent, data FROM tally_masters WHERE company_id = $1 AND kind = $2 ORDER BY name`, [req.params.id, kind]) : [];
    res.json({ kind, counts, rows });
  } catch (e) { next(e); }
};

module.exports = { getOverview, getBooks, getLedgerStatement, getVoucher, getOutstanding, getInventory, getGst, getMasters };

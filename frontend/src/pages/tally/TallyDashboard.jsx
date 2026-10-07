import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from 'recharts';
import { Cable, ChevronRight, ChevronDown, RefreshCw, CircleCheck, CircleAlert } from 'lucide-react';
import api from '../../lib/api';
import {
  C, inr, num, compact, drcr, fmtDate, monthLabel, monthRange, ago, th, thR, td, tdR, input, linkBtn,
  Pill, Card, Kpi, Empty, Loading, useFetch, DrillContext, useDrill, LedgerLink, axisTick, tooltipStyle, axisMoney, legendProps,
} from './tallyUi';
import DrillDrawer, { VoucherList } from './TallyDrill';

/* Tally Dashboard — a company's books as synced from Tally, readable top-down:
   headline figures → statements → groups → ledgers → vouchers → items.
   `base` is '/api/tally' (admin: every company) or '/api/brands/:id/tally'. */

const TABS = [
  ['overview', 'Overview'], ['pnl', 'Profit & Loss'], ['bs', 'Balance Sheet'], ['tb', 'Trial Balance'],
  ['receivable', 'Receivables'], ['payable', 'Payables'], ['inventory', 'Inventory'], ['gst', 'GST'],
  ['daybook', 'Day Book'], ['masters', 'Masters'], ['company', 'Company & Sync'],
];

/* ── chart of accounts as a tree, with balances rolled up ─────────────────── */
function buildTree(books) {
  if (!books) return null;
  const byName = new Map();
  for (const g of books.groups) byName.set(g.name, { ...g, children: [], ledgers: [], opening: 0, debit: 0, credit: 0, closing: 0, path: [] });
  const orphans = { name: 'Profit & Loss A/c and ungrouped', parent: null, nature: 'unclassified', children: [], ledgers: [], opening: 0, debit: 0, credit: 0, closing: 0, path: ['Profit & Loss A/c and ungrouped'] };
  for (const l of books.ledgers) (byName.get(l.parent) || orphans).ledgers.push(l);
  const roots = [];
  for (const g of byName.values()) { const p = g.parent && byName.get(g.parent); if (p) p.children.push(g); else roots.push(g); }
  const roll = (node, path) => {
    node.path = [...path, node.name];
    for (const c of node.children) { roll(c, node.path); for (const k of ['opening', 'debit', 'credit', 'closing']) node[k] += c[k]; }
    for (const l of node.ledgers) for (const k of ['opening', 'debit', 'credit', 'closing']) node[k] += l[k];
    node.children.sort((a, b) => Math.abs(b.closing) + Math.abs(b.debit) + b.credit - (Math.abs(a.closing) + Math.abs(a.debit) + a.credit));
    node.ledgers.sort((a, b) => Math.abs(b.closing) + Math.abs(b.debit) + b.credit - (Math.abs(a.closing) + Math.abs(a.debit) + a.credit));
  };
  roots.forEach((r) => roll(r, []));
  if (orphans.ledgers.length) { roll(orphans, []); roots.push(orphans); byName.set(orphans.name, orphans); }
  return { roots, byName };
}

/* Expandable statement rows. `cols` = [{ label, value(node) → number|null, tag? }].
   The tree is walked into a flat list of the rows currently visible, so the
   component never renders itself. */
function visibleRows(nodes, expanded, live) {
  const out = [];
  const stack = nodes.filter(live).map((g) => ({ kind: 'group', node: g, depth: 0 })).reverse();
  while (stack.length) {
    const row = stack.pop();
    out.push(row);
    if (row.kind !== 'group' || !expanded.has(row.node.name)) continue;
    const kids = [
      ...row.node.children.filter(live).map((g) => ({ kind: 'group', node: g, depth: row.depth + 1 })),
      ...row.node.ledgers.filter(live).map((l) => ({ kind: 'ledger', node: l, depth: row.depth + 1 })),
    ];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

function TreeRows({ nodes, cols, expanded, toggle, hideZero }) {
  const { open } = useDrill();
  const live = (x) => !hideZero || cols.some((c) => Math.abs(c.value(x) || 0) >= 0.005);
  return visibleRows(nodes, expanded, live).map(({ kind, node, depth }) => {
    if (kind === 'ledger') {
      return (
        <tr key={`l:${node.id}`} style={{ cursor: 'pointer' }} onClick={() => open({ type: 'ledger', id: node.id, name: node.name })}>
          <td style={{ ...td, paddingLeft: 12 + depth * 20 + 21, color: C.v, fontWeight: 600 }}>{node.name}</td>
          {cols.map((c) => <td key={c.label} style={tdR}>{fig(c.value(node), c.tag && c.tag(node))}</td>)}
        </tr>
      );
    }
    const isOpen = expanded.has(node.name);
    return (
      <tr key={`g:${node.name}`} style={{ background: depth === 0 ? '#FAFBFE' : undefined }}>
        <td style={{ ...td, paddingLeft: 12 + depth * 20 }}>
          <button type="button" onClick={() => toggle(node.name)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.name}`}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, marginRight: 6, verticalAlign: 'middle', color: C.muted, display: 'inline-flex' }}>
            {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          <button type="button" style={{ ...linkBtn, color: C.ink, fontWeight: depth === 0 ? 800 : 700 }} onClick={() => open({ type: 'group', name: node.name })}>{node.name}</button>
        </td>
        {cols.map((c) => <td key={c.label} style={{ ...tdR, fontWeight: depth === 0 ? 800 : 600 }}>{fig(c.value(node), c.tag && c.tag(node))}</td>)}
      </tr>
    );
  });
}
const fig = (v, tag) => (v === null || v === undefined || Math.abs(v) < 0.005 ? '' : <>{v < 0 ? '(' : ''}{inr(v)}{v < 0 ? ')' : ''}{tag && <span style={{ color: C.faint, fontSize: 11.5 }}> {tag}</span>}</>);

function useExpanded(initial = []) {
  const [set, setSet] = useState(() => new Set(initial));
  const toggle = useCallback((name) => setSet((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; }), []);
  return [set, toggle, setSet];
}

const TotalRow = ({ label, value, strong, cols = 1, note }) => (
  <tr>
    <td style={{ ...td, fontWeight: 800, background: strong ? C.vbg : '#F8FAFC' }}>{label}{note && <span style={{ fontWeight: 500, color: C.muted, fontSize: 12 }}> — {note}</span>}</td>
    {Array.from({ length: Math.max(0, cols - 2) }).map((_, i) => <td key={i} style={{ ...td, background: strong ? C.vbg : '#F8FAFC' }} />)}
    <td style={{ ...tdR, fontWeight: 900, background: strong ? C.vbg : '#F8FAFC', color: value < 0 ? C.bad : C.ink }}>{value < 0 ? '(' : ''}₹{inr(value)}{value < 0 ? ')' : ''}</td>
  </tr>
);

/* ── Profit & Loss ────────────────────────────────────────────────────────── */
function ProfitLoss({ tree, stock }) {
  const [expanded, toggle] = useExpanded();
  if (!tree) return <Loading />;
  const move = (n) => n.debit + n.credit;                       // credit-positive
  const pick = (nature, trading) => tree.roots.filter((r) => r.nature === nature && !!r.affects_gross_profit === trading);
  const sum = (nodes) => nodes.reduce((s, n) => s + move(n), 0);
  const sales = pick('income', true); const cost = pick('expense', true); const other = pick('income', false); const opex = pick('expense', false);
  const adj = !!(stock && stock.adjusted);
  const gross = sum(sales) + sum(cost) + (adj ? stock.change : 0); const net = gross + sum(other) + sum(opex);
  const plain = (label, value) => (
    <tr><td style={{ ...td, paddingLeft: 33, fontWeight: 700 }}>{label}</td><td style={{ ...tdR, fontWeight: 700 }}>{fig(value)}</td></tr>
  );
  const block = (label, nodes, sign) => (
    <>
      <tr><td colSpan={2} style={{ ...td, fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.faint, paddingTop: 16 }}>{label}</td></tr>
      <TreeRows nodes={nodes} cols={[{ label: 'Amount', value: (n) => sign * move(n) }]} expanded={expanded} toggle={toggle} hideZero />
      {!nodes.some((n) => Math.abs(move(n)) >= 0.005) && <tr><td colSpan={2} style={{ ...td, color: C.faint }}>Nothing in this period.</td></tr>}
    </>
  );
  return (
    <Card title="Profit & Loss" sub="Built from every voucher line in the period. Expand a group, or click a name to open it.">
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Particulars</th><th style={thR}>Amount (₹)</th></tr></thead>
          <tbody>
            {block('Revenue from operations', sales, 1)}
            {block('Cost of sales', cost, -1)}
            {adj && plain('Add: opening stock', stock.opening)}
            {adj && plain('Less: closing stock (as valued in Tally)', -stock.closing)}
            <TotalRow label="Gross margin" value={gross} cols={2} />
            {block('Other income', other, 1)}
            {block('Operating expenses', opex, -1)}
            <TotalRow label={adj ? 'Net profit' : 'Net surplus'} value={net} strong cols={2} note={adj ? 'after stock adjustment — the figure Tally reports' : 'before stock adjustment'} />
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: C.muted }}>
        {adj
          ? 'Income and expenses are added up from the vouchers; opening and closing stock are the balances Tally holds on the Stock-in-Hand ledgers.'
          : 'Closing stock is only known as at today, so for a single year this is shown before the change in stock. Choose “All periods” for the stock-adjusted profit.'}
      </div>
    </Card>
  );
}

/* ── Balance Sheet ────────────────────────────────────────────────────────── */
function BalanceSheet({ tree, stock }) {
  const [expanded, toggle] = useExpanded();
  if (!tree) return <Loading />;
  const liabilities = tree.roots.filter((r) => r.nature === 'liability' || r.nature === 'unclassified');
  const assets = tree.roots.filter((r) => r.nature === 'asset');
  const adj = !!(stock && stock.adjusted);
  const surplus = tree.roots.filter((r) => r.nature === 'income' || r.nature === 'expense').reduce((s, n) => s + n.closing, 0) + (adj ? stock.change : 0);
  const totalL = liabilities.reduce((s, n) => s + n.closing, 0) + surplus;
  const totalA = -assets.reduce((s, n) => s + n.closing, 0);
  const side = (label, nodes, sign, extra, total) => (
    <div style={{ flex: '1 1 420px', minWidth: 0 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>{label}</th><th style={thR}>Amount (₹)</th></tr></thead>
        <tbody>
          <TreeRows nodes={nodes} cols={[{ label: 'Amount', value: (n) => sign * n.closing }]} expanded={expanded} toggle={toggle} hideZero />
          {extra}
          <TotalRow label="Total" value={total} strong cols={2} />
        </tbody>
      </table>
    </div>
  );
  return (
    <Card title="Balance Sheet" sub="Closing balances as at the end of the period. Expand a group, or click a name to open it.">
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {side('Liabilities', liabilities, 1, (
          <tr><td style={{ ...td, fontWeight: 700 }}>{surplus < 0 ? 'Loss to date' : 'Profit to date'} <span style={{ color: C.muted, fontWeight: 500, fontSize: 12 }}>— Profit &amp; Loss A/c, since the books began</span></td>
            <td style={{ ...tdR, fontWeight: 700 }}>{fig(surplus)}</td></tr>
        ), totalL)}
        {side('Assets', assets, -1, null, totalA)}
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: Math.abs(totalL - totalA) < 1 ? C.good : C.warn, display: 'flex', gap: 6, alignItems: 'center' }}>
        {Math.abs(totalL - totalA) < 1 ? <><CircleCheck size={14} /> Both sides agree.</> : <><CircleAlert size={14} /> Sides differ by ₹{inr(totalL - totalA)}.</>}
        <span style={{ color: C.muted }}>{adj ? 'Stock-in-hand is at the closing value held in Tally.' : 'For a single year, stock-in-hand is at its opening value.'}</span>
      </div>
    </Card>
  );
}

/* ── Trial Balance ────────────────────────────────────────────────────────── */
function TrialBalance({ tree, reconciled }) {
  const [expanded, toggle] = useExpanded();
  if (!tree) return <Loading />;
  const cols = [
    { label: 'Opening', value: (n) => Math.abs(n.opening), tag: (n) => drcr(n.opening) },
    { label: 'Debits', value: (n) => Math.abs(n.debit) },
    { label: 'Credits', value: (n) => n.credit },
    { label: 'Closing Dr', value: (n) => (n.closing < 0 ? -n.closing : null) },
    { label: 'Closing Cr', value: (n) => (n.closing > 0 ? n.closing : null) },
  ];
  const dr = tree.roots.reduce((s, n) => s + Math.abs(n.debit), 0); const cr = tree.roots.reduce((s, n) => s + n.credit, 0);
  return (
    <Card title="Trial Balance" sub="Every group and ledger: opening, movement in the period, and closing."
      right={reconciled && <Pill c={reconciled.matched === reconciled.total ? C.good : C.warn} bg={reconciled.matched === reconciled.total ? C.goodBg : C.warnBg}>
        {num(reconciled.matched)} of {num(reconciled.total)} ledgers match Tally&apos;s closing balance</Pill>}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
          <thead><tr><th style={th}>Particulars</th>{cols.map((c) => <th key={c.label} style={thR}>{c.label}</th>)}</tr></thead>
          <tbody>
            <TreeRows nodes={tree.roots} cols={cols} expanded={expanded} toggle={toggle} hideZero />
            <tr><td style={{ ...td, fontWeight: 800, background: C.vbg }}>Total movement</td><td style={{ ...td, background: C.vbg }} />
              <td style={{ ...tdR, fontWeight: 900, background: C.vbg }}>{inr(dr)}</td><td style={{ ...tdR, fontWeight: 900, background: C.vbg }}>{inr(cr)}</td>
              <td style={{ ...td, background: C.vbg }} /><td style={{ ...td, background: C.vbg }} /></tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ── Overview ─────────────────────────────────────────────────────────────── */
const RankList = ({ rows, onPick, valueKey = 'amount', sub }) => {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r[valueKey])));
  return rows.length ? rows.map((r) => (
    <button type="button" key={r.name || r.item} onClick={() => onPick(r)} style={{ display: 'block', width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', padding: '6px 0', textAlign: 'left', font: 'inherit' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13 }}>
        <span style={{ color: C.ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || r.item}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums', color: C.ink, whiteSpace: 'nowrap' }}>₹{inr(r[valueKey])}</span>
      </div>
      <div style={{ height: 5, borderRadius: 4, background: '#EEF2F7', marginTop: 4 }}>
        <div style={{ height: 5, borderRadius: 4, background: C.s1, width: `${Math.max(2, (Math.abs(r[valueKey]) / max) * 100)}%` }} />
      </div>
      {sub && <div style={{ fontSize: 11.5, color: C.faint, marginTop: 2 }}>{sub(r)}</div>}
    </button>
  )) : <Empty>No data in this period.</Empty>;
};

const AgeBar = ({ labels, values }) => {
  const total = values.reduce((s, v) => s + v, 0);
  if (!total) return <Empty>Nothing outstanding.</Empty>;
  return (
    <>
      <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', gap: 2 }}>
        {values.map((v, i) => (v > 0 ? <div key={labels[i]} title={`${labels[i]}: ₹${inr(v)}`} style={{ flex: v, background: C.ramp[i], minWidth: 3 }} /> : null))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 10 }}>
        {labels.map((l, i) => (
          <div key={l} style={{ fontSize: 12, color: C.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: C.ramp[i], display: 'inline-block' }} />
            {l} <b style={{ color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{compact(values[i])}</b>
          </div>
        ))}
      </div>
    </>
  );
};

function Overview({ ov, go }) {
  const { open } = useDrill();
  if (!ov) return <Loading />;
  const k = ov.kpis;
  const months = ov.monthly.map((m) => ({ ...m, label: monthLabel(m.month), Sales: m.sales, 'Cost of sales': m.cost_of_sales, 'Operating expenses': m.operating_expenses, Receipts: m.receipts, Payments: m.payments, Surplus: m.surplus }));
  const openMonth = (m, what) => open({ type: 'vouchers', title: `${what} · ${monthLabel(m.month)}`, params: monthRange(m.month) });
  const margin = k.revenue ? ` · ${((k.gross_margin / k.revenue) * 100).toFixed(1)}% of revenue` : '';
  const stockNote = k.stock_adjusted ? 'after stock adjustment, as in Tally' : 'before stock adjustment';
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 14 }}>
        <Kpi label="Revenue" value={compact(k.revenue)} sub={`₹${inr(k.revenue)}`} onClick={() => go('pnl')} />
        <Kpi label="Gross margin" value={compact(k.gross_margin)} sub={`after cost of sales${margin}`} onClick={() => go('pnl')} tone={k.gross_margin < 0 ? 'bad' : undefined} />
        <Kpi label={k.net_profit < 0 ? 'Net loss' : 'Net profit'} value={compact(k.net_profit)} sub={stockNote} onClick={() => go('pnl')} tone={k.net_profit < 0 ? 'bad' : undefined} />
        <Kpi label="Cash & bank" value={compact(k.cash_bank)} sub={`${ov.cash_bank.length} accounts`} onClick={() => go('bs')} tone={k.cash_bank < 0 ? 'bad' : undefined} />
        <Kpi label="Receivables" value={compact(k.receivables)} sub={k.outstanding_basis === 'bills' ? 'bill-wise, net of unadjusted receipts' : 'owed to the company'} onClick={() => go('receivable')} />
        <Kpi label="Payables" value={compact(k.payables)} sub={k.outstanding_basis === 'bills' ? 'bill-wise, net of unadjusted payments' : 'owed by the company'} onClick={() => go('payable')} />
        <Kpi label="Stock on hand" value={compact(k.stock_value)} sub={k.stock_basis === 'books' ? 'closing stock held in Tally, as of now' : `${num(ov.counts.stock_items)} items, item-wise valuation`} onClick={() => go('inventory')} />
        <Kpi label="Duties & taxes" value={compact(k.duties_taxes)} sub={k.duties_taxes >= 0 ? 'net payable' : 'net credit available'} onClick={() => go('gst')} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))', gap: 14, marginBottom: 14 }}>
        <Card title="Sales against costs, by month" sub="Click a month to see its vouchers.">
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={months} barGap={2} margin={{ top: 4, right: 4, left: 4, bottom: 0 }} onClick={(e) => e && e.activePayload && openMonth(e.activePayload[0].payload, 'Vouchers')}>
                <CartesianGrid vertical={false} stroke={C.grid} />
                <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: C.grid }} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={axisMoney} width={64} />
                <Tooltip {...tooltipStyle} formatter={(v) => `₹${inr(v)}`} />
                <Legend {...legendProps} />
                <Bar dataKey="Sales" fill={C.s1} radius={[4, 4, 0, 0]} maxBarSize={18} cursor="pointer" />
                <Bar dataKey="Cost of sales" fill={C.s2} radius={[4, 4, 0, 0]} maxBarSize={18} cursor="pointer" />
                <Bar dataKey="Operating expenses" fill={C.s3} radius={[4, 4, 0, 0]} maxBarSize={18} cursor="pointer" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Money in and out, by month" sub="Receipt and payment vouchers. Click a month to see them.">
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={months} barGap={2} margin={{ top: 4, right: 4, left: 4, bottom: 0 }} onClick={(e) => e && e.activePayload && openMonth(e.activePayload[0].payload, 'Vouchers')}>
                <CartesianGrid vertical={false} stroke={C.grid} />
                <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: C.grid }} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={axisMoney} width={64} />
                <Tooltip {...tooltipStyle} formatter={(v) => `₹${inr(v)}`} />
                <Legend {...legendProps} />
                <Bar dataKey="Receipts" fill={C.s1} radius={[4, 4, 0, 0]} maxBarSize={22} cursor="pointer" />
                <Bar dataKey="Payments" fill={C.s2} radius={[4, 4, 0, 0]} maxBarSize={22} cursor="pointer" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, marginBottom: 14 }}>
        <Card title="Top customers" sub="By sales invoiced"><RankList rows={ov.top_customers} onPick={(r) => open({ type: 'ledger', name: r.name })} sub={(r) => `${num(r.count)} invoices`} /></Card>
        <Card title="Top suppliers" sub="By purchases booked"><RankList rows={ov.top_vendors} onPick={(r) => open({ type: 'ledger', name: r.name })} sub={(r) => `${num(r.count)} bills`} /></Card>
        <Card title="Best-selling items" sub="By sales value"><RankList rows={ov.top_items} onPick={(r) => open({ type: 'item', name: r.item })} sub={(r) => `${num(r.qty)} units`} /></Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
        <Card title="Receivables by age" sub={`₹${inr(ov.ageing.receivable_total)} net of unadjusted receipts · aged to ${fmtDate(ov.ageing.as_of)}`} right={<button type="button" style={linkBtn} onClick={() => go('receivable')}>By customer →</button>}>
          <AgeBar labels={ov.ageing.labels} values={ov.ageing.receivable} />
        </Card>
        <Card title="Payables by age" sub={`₹${inr(ov.ageing.payable_total)} net of unadjusted payments · aged to ${fmtDate(ov.ageing.as_of)}`} right={<button type="button" style={linkBtn} onClick={() => go('payable')}>By supplier →</button>}>
          <AgeBar labels={ov.ageing.labels} values={ov.ageing.payable} />
        </Card>
        <Card title="Cash and bank accounts" sub="Closing balance of each">
          {ov.cash_bank.length ? ov.cash_bank.map((a) => (
            <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '6px 0', borderTop: `1px solid ${C.hair}`, fontSize: 13 }}>
              <LedgerLink id={a.id} name={a.name} />
              <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>₹{inr(a.closing)} <span style={{ color: C.faint, fontSize: 11.5 }}>{drcr(a.closing)}</span></span>
            </div>
          )) : <Empty>No cash or bank ledgers.</Empty>}
        </Card>
        <Card title="Voucher activity" sub="By Tally voucher type. Click one to list its vouchers.">
          {ov.voucher_mix.map((m) => (
            <div key={m.base} style={{ padding: '6px 0', borderTop: `1px solid ${C.hair}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13 }}>
                <span style={{ fontWeight: 700, color: C.ink }}>{m.base}</span>
                <span style={{ color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{num(m.count)} · {compact(m.amount)}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
                {m.types.map((t) => (
                  <button type="button" key={t.type} onClick={() => open({ type: 'vouchers', title: t.type, params: { type: t.type, from: ov.period.from || undefined, to: ov.period.to || undefined } })}
                    style={{ border: `1px solid ${C.line}`, background: '#fff', borderRadius: 9999, padding: '2px 9px', fontSize: 11.5, color: C.muted, cursor: 'pointer' }}>{t.type} <b style={{ color: C.ink }}>{num(t.count)}</b></button>
                ))}
              </div>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}

/* ── Receivables / Payables ───────────────────────────────────────────────── */
function Outstanding({ sideKey }) {
  const { cb, open } = useDrill();
  const { data, loading } = useFetch(`${cb}/outstanding`, undefined, [cb]);
  const [openParty, setOpenParty] = useState(null);
  const [search, setSearch] = useState('');
  if (loading || !data) return <Loading />;
  const side = data[sideKey];
  const who = sideKey === 'receivable' ? 'customer' : 'supplier';
  const parties = side.parties.filter((p) => !search || p.party.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 14 }}>
        <Kpi label={sideKey === 'receivable' ? 'Total receivable' : 'Total payable'} value={compact(side.total)} sub={`₹${inr(side.total)}`} />
        <Kpi label={`${who}s`} value={num(side.parties.length)} sub={`${num(side.bill_count)} open bills`} />
        <Kpi label="Over 90 days" value={compact(side.buckets[3] + side.buckets[4])} sub={`aged to ${fmtDate(data.as_of)}, the last entry in the books`} />
        <Kpi label={sideKey === 'receivable' ? 'Unadjusted receipts' : 'Unadjusted payments'} value={compact(side.unadjusted)} sub="not yet set against a bill; already netted off" />
      </div>
      <Card title="By age" style={{ marginBottom: 14 }}><AgeBar labels={data.labels} values={side.buckets} /></Card>
      <Card title={`By ${who}`} sub={`Bill-wise, as Tally holds it. Expand a ${who} for its bills, or click the name for the full ledger.`}
        right={<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${who}`} aria-label={`Search ${who}`} style={{ ...input, width: 220 }} />}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
            <thead><tr><th style={th}>{who}</th><th style={thR}>Net outstanding</th>{data.labels.map((l) => <th key={l} style={thR}>{l}</th>)}<th style={thR}>Unadjusted</th><th style={thR}>Bills</th></tr></thead>
            <tbody>
              {parties.map((p) => (
                <React.Fragment key={p.party}>
                  <tr>
                    <td style={td}>
                      <button type="button" aria-expanded={openParty === p.party} aria-label={`Show bills of ${p.party}`} onClick={() => setOpenParty(openParty === p.party ? null : p.party)}
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, marginRight: 6, verticalAlign: 'middle', color: C.muted, display: 'inline-flex' }}>
                        {openParty === p.party ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </button>
                      <LedgerLink id={p.ledger_id} name={p.party} />
                    </td>
                    <td style={{ ...tdR, fontWeight: 800 }}>{inr(p.total)}</td>
                    {p.buckets.map((b, i) => <td key={i} style={tdR}>{b ? inr(b) : ''}</td>)}
                    <td style={tdR}>{p.unadjusted ? `(${inr(p.unadjusted)})` : ''}</td>
                    <td style={tdR}>{p.bills.length}</td>
                  </tr>
                  {openParty === p.party && (
                    <tr><td colSpan={9} style={{ ...td, background: '#F8F7FF', padding: '6px 12px 12px 40px' }}>
                      <table style={{ borderCollapse: 'collapse', minWidth: 460 }}>
                        <thead><tr><th style={th}>Bill</th><th style={th}>Date</th><th style={thR}>Age</th><th style={thR}>Pending</th></tr></thead>
                        <tbody>{p.bills.map((b, i) => (
                          <tr key={i}><td style={td}>{b.name}{b.unadjusted && <span style={{ marginLeft: 6 }}><Pill>Unadjusted</Pill></span>}</td>
                            <td style={td}>{fmtDate(b.bill_date)}</td><td style={tdR}>{b.days !== null ? `${num(b.days)} d` : ''}</td><td style={tdR}>{b.amount < 0 ? `(${inr(b.amount)})` : inr(b.amount)}</td></tr>
                        ))}</tbody>
                      </table>
                      <button type="button" style={{ ...linkBtn, marginTop: 8, fontSize: 12.5 }} onClick={() => open({ type: 'ledger', id: p.ledger_id, name: p.party })}>Open full ledger →</button>
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          {!parties.length && <Empty>Nothing outstanding.</Empty>}
        </div>
      </Card>
    </>
  );
}

/* ── Inventory ────────────────────────────────────────────────────────────── */
function Inventory() {
  const { cb, open, period } = useDrill();
  const { data, loading } = useFetch(`${cb}/inventory`, period, [cb, period.from, period.to]);
  const [search, setSearch] = useState(''); const [group, setGroup] = useState(''); const [sort, setSort] = useState('closing_value'); const [shown, setShown] = useState(100);
  if (loading || !data) return <Loading />;
  const rows = data.items.filter((i) => (!group || i.group === group) && (!search || `${i.name} ${i.hsn || ''}`.toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => b[sort] - a[sort]);
  const t = data.totals;
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 14 }}>
        <Kpi label="Item-wise valuation" value={compact(t.closing_value)} sub="quantity × Tally's rate, summed over items" />
        <Kpi label="Items" value={num(t.items)} sub={`${num(t.in_stock)} in stock now`} />
        <Kpi label="Sold" value={compact(t.sold_value)} sub="item value on sales vouchers" />
        <Kpi label="Purchased" value={compact(t.bought_value)} sub="item value on purchase vouchers" />
      </div>
      <Card title="Stock items" sub="Click an item for every voucher it appears on."
        right={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search item or HSN" aria-label="Search item" style={{ ...input, width: 200 }} />
          <select value={group} onChange={(e) => setGroup(e.target.value)} style={input} aria-label="Stock group"><option value="">All stock groups</option>{data.groups.map((g) => <option key={g.name}>{g.name}</option>)}</select>
          <select value={sort} onChange={(e) => setSort(e.target.value)} style={input} aria-label="Sort by">
            <option value="closing_value">Sort: stock value</option><option value="sold_value">Sort: sales</option><option value="bought_value">Sort: purchases</option><option value="closing_qty">Sort: quantity</option>
          </select></div>}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
            <thead><tr><th style={th}>Item</th><th style={th}>Group</th><th style={th}>HSN</th><th style={thR}>GST %</th><th style={thR}>In stock</th><th style={thR}>Stock value</th><th style={thR}>Sold</th><th style={thR}>Purchased</th></tr></thead>
            <tbody>
              {rows.slice(0, shown).map((i) => (
                <tr key={i.guid} style={{ cursor: 'pointer' }} onClick={() => open({ type: 'item', name: i.name })}>
                  <td style={{ ...td, color: C.v, fontWeight: 600 }}>{i.name}</td><td style={{ ...td, color: C.muted }}>{i.group || ''}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{i.hsn || ''}</td>
                  <td style={tdR}>{i.gst_rate !== null ? `${num(i.gst_rate)}%` : ''}</td>
                  <td style={tdR}>{i.closing_qty ? `${num(i.closing_qty)} ${i.unit || ''}` : ''}</td>
                  <td style={tdR}>{i.closing_value ? inr(i.closing_value) : ''}</td>
                  <td style={tdR}>{i.sold_value ? inr(i.sold_value) : ''}</td>
                  <td style={tdR}>{i.bought_value ? inr(i.bought_value) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty>No items match.</Empty>}
        </div>
        {rows.length > shown && <div style={{ textAlign: 'center', paddingTop: 12 }}><button type="button" style={linkBtn} onClick={() => setShown(shown + 200)}>Show more ({num(rows.length - shown)} remaining)</button></div>}
      </Card>
    </>
  );
}

/* ── GST ──────────────────────────────────────────────────────────────────── */
function Gst() {
  const { cb, period } = useDrill();
  const { data, loading } = useFetch(`${cb}/gst`, period, [cb, period.from, period.to]);
  if (loading || !data) return <Loading />;
  const months = data.monthly.map((m) => ({ ...m, label: monthLabel(m.month), 'Output tax': m.output, 'Input credit': m.input }));
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 14 }}>
        <Kpi label="Output tax" value={compact(data.totals.output)} sub="charged on sales in the period" />
        <Kpi label="Input credit" value={compact(data.totals.input)} sub="paid on purchases in the period" />
        <Kpi label={data.totals.net_payable >= 0 ? 'Net GST payable' : 'Net GST credit'} value={compact(Math.abs(data.totals.net_payable))} sub="closing balance of all GST ledgers" />
        <Kpi label="GST registrations" value={num(data.registrations.length)} sub="in this company" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14, marginBottom: 14 }}>
        <Card title="Output tax against input credit, by month">
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={months} barGap={2} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={C.grid} />
                <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: C.grid }} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={axisMoney} width={64} />
                <Tooltip {...tooltipStyle} formatter={(v) => `₹${inr(v)}`} />
                <Legend {...legendProps} />
                <Bar dataKey="Output tax" fill={C.s1} radius={[4, 4, 0, 0]} maxBarSize={22} />
                <Bar dataKey="Input credit" fill={C.s2} radius={[4, 4, 0, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="GST registrations" sub="As set up in Tally">
          {data.registrations.length ? data.registrations.map((r) => (
            <div key={r.gstin} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderTop: `1px solid ${C.hair}`, fontSize: 13 }}>
              <span style={{ fontWeight: 700 }}>{r.name}</span>
              <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }}>{r.gstin}</span>
            </div>
          )) : <Empty>No registrations received.</Empty>}
          {data.rates.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.faint, marginBottom: 6 }}>Sales by GST rate (taxable value)</div>
              {data.rates.map((r) => (
                <div key={r.rate} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                  <span>{r.rate === 'n/a' ? 'Rate not set' : `${r.rate}%`}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>₹{inr(r.taxable)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      <Card title="GST ledgers" sub="Every tax ledger Tally marks as GST. Click one for its vouchers." style={{ marginBottom: 14 }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead><tr><th style={th}>Ledger</th><th style={th}>Head</th><th style={th}>Side</th><th style={thR}>Debits</th><th style={thR}>Credits</th><th style={thR}>Closing</th></tr></thead>
            <tbody>
              {data.tax_ledgers.filter((l) => l.debit || l.credit || l.closing).map((l) => (
                <tr key={l.id}><td style={td}><LedgerLink id={l.id} name={l.name} /></td><td style={td}>{l.head}</td>
                  <td style={td}><Pill>{l.side === 'output' ? 'Output' : 'Input'}</Pill></td>
                  <td style={tdR}>{l.debit ? inr(l.debit) : ''}</td><td style={tdR}>{l.credit ? inr(l.credit) : ''}</td>
                  <td style={tdR}>{inr(l.closing)} <span style={{ color: C.faint, fontSize: 11.5 }}>{drcr(l.closing)}</span></td></tr>
              ))}
            </tbody>
          </table>
          {!data.tax_ledgers.length && <Empty>No GST ledgers found.</Empty>}
        </div>
      </Card>
      <Card title="HSN summary of sales" sub="Taxable value of items on sales vouchers">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>HSN</th><th style={thR}>GST %</th><th style={thR}>Quantity</th><th style={thR}>Taxable value</th><th style={thR}>Vouchers</th></tr></thead>
            <tbody>
              {data.hsn.slice(0, 200).map((h, i) => (
                <tr key={i}><td style={{ ...td, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5 }}>{h.hsn}</td><td style={tdR}>{h.gst_rate !== null ? `${num(h.gst_rate)}%` : ''}</td>
                  <td style={tdR}>{num(h.qty)}</td><td style={tdR}>{inr(h.taxable)}</td><td style={tdR}>{num(h.vouchers)}</td></tr>
              ))}
            </tbody>
          </table>
          {!data.hsn.length && <Empty>No item-wise sales in this period.</Empty>}
        </div>
      </Card>
    </>
  );
}

/* ── Masters ──────────────────────────────────────────────────────────────── */
const KIND_LABEL = { group: 'Groups', voucher_type: 'Voucher types', stock_item: 'Stock items', stock_group: 'Stock groups', godown: 'Godowns', unit: 'Units', currency: 'Currencies', cost_centre: 'Cost centres' };
const pretty = (k) => k.replace(/_/g, ' ');
function Masters({ ledgerCount }) {
  const { cb, open } = useDrill();
  const [kind, setKind] = useState('group'); const [search, setSearch] = useState('');
  const { data, loading } = useFetch(`${cb}/masters`, { kind }, [cb, kind]);
  const counts = Object.fromEntries((data?.counts || []).map((c) => [c.kind, c.count]));
  const rows = (data?.rows || []).filter((r) => !search || `${r.name} ${r.parent || ''}`.toLowerCase().includes(search.toLowerCase()));
  const keys = [...new Set(rows.slice(0, 300).flatMap((r) => Object.keys(r.data || {})))].filter((k) => k !== 'reserved').slice(0, 7);
  const show = (v) => (v === true ? 'Yes' : v === false ? 'No' : typeof v === 'number' ? num(v) : v === null || v === undefined ? '' : String(v));
  return (
    <Card title="Masters" sub={`Everything Tally holds as a master for this company. Ledgers (${num(ledgerCount)}) are under Trial Balance.`}
      right={<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" aria-label="Search masters" style={{ ...input, width: 200 }} />}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {Object.entries(KIND_LABEL).map(([k, label]) => (
          <button type="button" key={k} onClick={() => setKind(k)}
            style={{ border: `1px solid ${k === kind ? C.v : '#E2E8F0'}`, background: k === kind ? C.vbg : '#fff', color: k === kind ? C.v : C.ink, borderRadius: 9999, padding: '6px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
            {label} <span style={{ color: C.faint }}>{num(counts[k] || 0)}</span></button>
        ))}
      </div>
      {loading && !data ? <Loading /> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Name</th><th style={th}>Under</th>{keys.map((k) => <th key={k} style={th}>{pretty(k)}</th>)}</tr></thead>
            <tbody>
              {rows.slice(0, 500).map((r) => (
                <tr key={r.guid} style={{ cursor: kind === 'group' || kind === 'stock_item' ? 'pointer' : 'default' }}
                  onClick={() => (kind === 'group' ? open({ type: 'group', name: r.name }) : kind === 'stock_item' ? open({ type: 'item', name: r.name }) : null)}>
                  <td style={{ ...td, fontWeight: 600, color: kind === 'group' || kind === 'stock_item' ? C.v : C.ink }}>{r.name}</td>
                  <td style={{ ...td, color: C.muted }}>{r.parent || ''}</td>
                  {keys.map((k) => <td key={k} style={td}>{show((r.data || {})[k])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty>None in this company.</Empty>}
        </div>
      )}
    </Card>
  );
}

/* ── Company & Sync ───────────────────────────────────────────────────────── */
function CompanyTab({ ov }) {
  const { cb } = useDrill();
  const { data: runs } = useFetch(`${cb}/runs`, undefined, [cb]);
  if (!ov) return <Loading />;
  const p = ov.company.profile || {}; const f = p.features || {}; const c = ov.connector;
  const Row = ({ k, children }) => (children ? <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderTop: `1px solid ${C.hair}`, fontSize: 13 }}><span style={{ width: 150, color: C.muted, flexShrink: 0 }}>{k}</span><span style={{ color: C.ink, overflowWrap: 'anywhere' }}>{children}</span></div> : null);
  const feats = [['Inventory', f.inventory], ['GST', f.gst], ['Bill-wise details', f.bill_wise], ['TDS', f.tds], ['Payroll', f.payroll], ['Cost centres', f.cost_centres]];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 14 }}>
      <Card title="Company" sub="As recorded in Tally">
        <Row k="Name">{ov.company.name}</Row><Row k="Mailing name">{p.mailing_name}</Row><Row k="Address">{p.address}</Row>
        <Row k="State">{[p.state, p.country, p.pincode].filter(Boolean).join(', ')}</Row><Row k="Phone">{p.phone}</Row><Row k="Email">{p.email}</Row>
        <Row k="Website">{p.website}</Row><Row k="PAN">{p.pan}</Row><Row k="Books from">{fmtDate(ov.company.books_from)}</Row>
        <Row k="Current year">{p.fy_from && `${fmtDate(p.fy_from)} to ${fmtDate(p.fy_to)}`}</Row><Row k="Last voucher">{p.last_voucher_date && fmtDate(p.last_voucher_date)}</Row>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
          {feats.map(([label, on]) => <Pill key={label} c={on ? C.good : C.faint} bg={on ? C.goodBg : '#F1F5F9'}>{label} {on ? 'on' : 'off'}</Pill>)}
        </div>
      </Card>
      <Card title="What has been synced" sub="Counts held for this company">
        {[['Ledgers', ov.counts.ledgers], ['Groups', ov.counts.groups], ['Vouchers', ov.counts.vouchers], ['Voucher types', ov.counts.voucher_types],
          ['Stock items', ov.counts.stock_items], ['Godowns', ov.counts.godowns], ['Open bills', ov.counts.bills], ['GST registrations', (p.gst_registrations || []).length]]
          .map(([k, v]) => <Row key={k} k={k}><b>{num(v)}</b></Row>)}
        <Row k="Vouchers dated">{ov.counts.min_date && `${fmtDate(ov.counts.min_date)} to ${fmtDate(ov.counts.max_date)}`}</Row>
        {ov.reconciled && <Row k="Check against Tally">{num(ov.reconciled.matched)} of {num(ov.reconciled.total)} ledger closing balances rebuilt from vouchers equal Tally&apos;s own</Row>}
      </Card>
      <Card title="Connector" sub="The Colonel Tally Connector app that feeds this company">
        {c ? (<>
          <Row k="PC">{c.machine_name}</Row><Row k="Tally at">{c.tally_host}:{c.tally_port}</Row><Row k="Last seen">{ago(c.last_seen_at)}</Row>
          <Row k="Status">{c.last_status}</Row><Row k="Version">{c.version}</Row>
        </>) : <Empty>No connector linked.</Empty>}
        <Row k="Last sync">{ago(ov.company.last_sync_at)} {ov.company.last_sync_status === 'ok' ? '· OK' : ov.company.last_sync_status ? `· ${ov.company.last_sync_status}` : ''}</Row>
        {ov.company.last_error && <Row k="Last error">{ov.company.last_error}</Row>}
      </Card>
      <Card title="Sync history" sub="Most recent first" style={{ gridColumn: '1 / -1' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Started</th><th style={th}>Status</th><th style={thR}>Ledgers</th><th style={thR}>Vouchers</th><th style={thR}>Took</th></tr></thead>
            <tbody>
              {(runs || []).map((r) => (
                <tr key={r.id}><td style={{ ...td, whiteSpace: 'nowrap' }}>{new Date(r.started_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td style={td}>{r.status === 'ok' ? <Pill c={C.good} bg={C.goodBg}>OK</Pill> : r.status === 'running' ? <Pill c={C.v} bg={C.vbg}>Running</Pill> : <Pill c={C.bad} bg={C.badBg}>Error</Pill>}</td>
                  <td style={tdR}>{num(r.counts?.ledgers)}</td><td style={tdR}>{num(r.counts?.vouchers)}</td>
                  <td style={tdR}>{r.finished_at ? `${Math.max(0, Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000))}s` : '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════

export default function TallyDashboard({ base = '/api/tally' }) {
  const [list, setList] = useState(null);
  const [companyId, setCompanyId] = useState(null);
  const [tab, setTab] = useState('overview');
  const [range, setRange] = useState('all');       // 'all' or an index into overview.period.years
  const [stack, setStack] = useState([]);
  const [tick, setTick] = useState(0);
  const [years, setYears] = useState([]);
  const [month, setMonth] = useState('');          // '' or 'YYYY-MM'
  const [bounds, setBounds] = useState({ min: null, max: null });   // first and last voucher date in the books

  useEffect(() => {
    let live = true;
    api.get(`${base}/overview`).then((r) => {
      if (!live) return;
      setList(r.data);
      setCompanyId((cur) => (cur && r.data.companies.some((c) => c.id === cur) ? cur : r.data.companies[0]?.id || null));
    }).catch(() => { if (live) setList({ companies: [] }); });
    return () => { live = false; };
  }, [base, tick]);

  // A single month narrows the year (or "All periods") it was picked from.
  const months = useMemo(() => {
    if (!bounds.min || !bounds.max) return [];
    const lo = String(range !== 'all' && years[range] ? years[range].from : bounds.min).slice(0, 7);
    const hi = String(range !== 'all' && years[range] ? years[range].to : bounds.max).slice(0, 7);
    const first = String(bounds.min).slice(0, 7); const last = String(bounds.max).slice(0, 7);
    const out = [];
    let [y, m] = (hi < last ? hi : last).split('-').map(Number);
    const stop = lo > first ? lo : first;
    for (let key = `${y}-${String(m).padStart(2, '0')}`; key >= stop; key = `${y}-${String(m).padStart(2, '0')}`) {
      out.push(key);
      m -= 1; if (m === 0) { m = 12; y -= 1; }
    }
    return out;
  }, [bounds, range, years]);
  const period = useMemo(() => {
    if (month && months.includes(month)) return monthRange(month);
    return range === 'all' || !years[range] ? {} : { from: years[range].from, to: years[range].to };
  }, [range, years, month, months]);
  const cb = companyId ? `${base}/companies/${companyId}` : '';
  const { data: ov, error: ovError } = useFetch(cb && `${cb}/overview`, period, [cb, period.from, period.to, tick]);
  const { data: books } = useFetch(cb && `${cb}/books`, period, [cb, period.from, period.to, tick]);
  useEffect(() => {
    if (!ov?.period) return;
    if (ov.period.years) setYears(ov.period.years);
    setBounds((b) => (b.min === ov.period.min_date && b.max === ov.period.max_date ? b : { min: ov.period.min_date, max: ov.period.max_date }));
  }, [ov]);
  const tree = useMemo(() => buildTree(books), [books]);

  const open = useCallback((entry) => setStack((s) => [...s, entry]), []);
  const ctx = useMemo(() => ({ open, cb, period, tree }), [open, cb, period, tree]);
  useEffect(() => { setStack([]); }, [companyId]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setStack((s) => s.slice(0, -1)); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  const companies = list?.companies || [];
  const company = companies.find((c) => c.id === companyId);

  return (
    <DrillContext.Provider value={ctx}>
      <div style={{ padding: '28px 28px 56px', maxWidth: 1400, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
          <div>
            <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 28, color: C.ink, letterSpacing: '-0.02em', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              <Cable size={24} color={C.v} /> Tally Dashboard
            </h1>
            <p style={{ fontSize: 14, color: C.muted, margin: '4px 0 0' }}>
              {company ? <>{company.name} · live from Tally · last sync {ago(company.last_sync_at)}</> : 'The company’s books, live from Tally.'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {companies.length > 1 && (
              <select value={companyId || ''} onChange={(e) => setCompanyId(e.target.value)} style={{ ...input, fontWeight: 700 }} aria-label="Company">
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <select value={range} onChange={(e) => { setRange(e.target.value === 'all' ? 'all' : Number(e.target.value)); setMonth(''); }} style={{ ...input, fontWeight: 700 }} aria-label="Financial year">
              <option value="all">All periods</option>
              {years.map((y, i) => <option key={y.label} value={i}>{y.label}</option>)}
            </select>
            <select value={months.includes(month) ? month : ''} onChange={(e) => setMonth(e.target.value)} style={{ ...input, fontWeight: 700 }} aria-label="Month">
              <option value="">{range === 'all' ? 'All months' : 'Whole year'}</option>
              {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
            <button type="button" onClick={() => setTick((t) => t + 1)} style={{ ...input, display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontWeight: 700 }}><RefreshCw size={14} /> Refresh</button>
          </div>
        </div>

        {list && !companies.length && (
          <Card title="No Tally company to show yet">
            <div style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.7 }}>
              {base.includes('/brands/')
                ? 'No Tally company is linked to this brand. An admin links one from the brand’s Tally Connector agent after its first sync.'
                : 'Run the Colonel Tally Connector on the Tally PC, log in, and the company appears here after its first sync.'}
            </div>
          </Card>
        )}
        {ovError && <Card><Empty>{ovError}</Empty></Card>}

        {company && (
          <>
            {ov && Number(ov.company.data_version) < 2 && (
              <div style={{ background: C.warnBg, color: C.warn, borderRadius: 12, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}>
                This company was synced by an older connector. Update the connector and let it sync once to fill in groups, stock, bills and voucher detail.
              </div>
            )}
            <div role="tablist" style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${C.line}`, marginBottom: 16, overflowX: 'auto' }}>
              {TABS.map(([k, label]) => (
                <button type="button" role="tab" aria-selected={tab === k} key={k} onClick={() => setTab(k)}
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '9px 14px', fontSize: 13.5, fontWeight: 700, whiteSpace: 'nowrap',
                    color: tab === k ? C.v : C.muted, borderBottom: `2px solid ${tab === k ? C.v : 'transparent'}`, marginBottom: -1 }}>{label}</button>
              ))}
            </div>
            {tab === 'overview' && <Overview ov={ov} go={setTab} />}
            {tab === 'pnl' && <ProfitLoss tree={tree} stock={books?.stock} />}
            {tab === 'bs' && <BalanceSheet tree={tree} stock={books?.stock} />}
            {tab === 'tb' && <TrialBalance tree={tree} reconciled={books?.reconciled} />}
            {tab === 'receivable' && <Outstanding sideKey="receivable" />}
            {tab === 'payable' && <Outstanding sideKey="payable" />}
            {tab === 'inventory' && <Inventory />}
            {tab === 'gst' && <Gst />}
            {tab === 'daybook' && <Card title="Day Book" sub="Every voucher. Click one to open it."><VoucherList params={period} /></Card>}
            {tab === 'masters' && <Masters ledgerCount={ov?.counts.ledgers} />}
            {tab === 'company' && <CompanyTab ov={ov} />}
          </>
        )}
      </div>
      <DrillDrawer stack={stack} setStack={setStack} />
    </DrillContext.Provider>
  );
}

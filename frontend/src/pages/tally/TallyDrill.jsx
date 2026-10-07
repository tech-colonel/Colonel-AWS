import React, { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from 'recharts';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  C, inr, num, drcr, fmtDate, monthLabel, th, thR, td, tdR, input, linkBtn, Pill, Empty, Loading,
  useFetch, useDrill, LedgerLink, axisTick, tooltipStyle, axisMoney, legendProps,
} from './tallyUi';

/* The drill-down drawer. Every figure on the dashboard opens a panel here, and
   every panel links onward: group → ledger → voucher → another ledger or item.
   The trail at the top is the path taken; any step in it can be jumped back to. */

const PAGE = 50;
const title = (e) => (e.type === 'voucher' ? (e.label || 'Voucher') : e.type === 'vouchers' ? (e.title || 'Vouchers') : e.name);
const KIND = { group: 'Group', ledger: 'Ledger', voucher: 'Voucher', item: 'Stock item', vouchers: 'Vouchers' };

const Fact = ({ label, children }) => (children ? (
  <div style={{ minWidth: 130 }}>
    <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.faint }}>{label}</div>
    <div style={{ fontSize: 13, color: C.ink, marginTop: 2, overflowWrap: 'anywhere' }}>{children}</div>
  </div>
) : null);

const Stat = ({ label, value, tag }) => (
  <div style={{ flex: '1 1 130px', background: '#F8FAFC', borderRadius: 12, padding: '10px 12px' }}>
    <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.faint }}>{label}</div>
    <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 800, fontSize: 18, color: C.ink, whiteSpace: 'nowrap' }}>{value} <span style={{ fontSize: 11, color: C.faint, fontWeight: 700 }}>{tag}</span></div>
  </div>
);

const Section = ({ title: t, children, count }) => (
  <div style={{ marginTop: 20 }}>
    <div style={{ fontWeight: 800, fontSize: 13.5, color: C.ink, marginBottom: 8 }}>{t}{count !== undefined && <span style={{ color: C.faint, fontWeight: 700 }}> · {count}</span>}</div>
    {children}
  </div>
);

function Pager({ total, offset, setOffset, page = PAGE }) {
  if (total <= page) return null;
  const btn = (off) => ({ ...input, padding: '5px 8px', cursor: off ? 'default' : 'pointer', opacity: off ? 0.4 : 1, display: 'inline-flex' });
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, paddingTop: 10, fontSize: 12.5, color: C.muted }}>
      <span>{num(offset + 1)}–{num(Math.min(offset + page, total))} of {num(total)}</span>
      <button type="button" aria-label="Previous page" style={btn(offset === 0)} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - page))}><ChevronLeft size={15} /></button>
      <button type="button" aria-label="Next page" style={btn(offset + page >= total)} disabled={offset + page >= total} onClick={() => setOffset(offset + page)}><ChevronRight size={15} /></button>
    </div>
  );
}

/* ── a list of vouchers (Day Book, a month, a voucher type, an item's movements) ── */
export function VoucherList({ params = {}, showSearch = true }) {
  const { cb, open } = useDrill();
  const [search, setSearch] = useState('');
  const [type, setType] = useState(params.type || '');
  const [offset, setOffset] = useState(0);
  const key = JSON.stringify([params, search, type, offset]);
  const { data, loading } = useFetch(`${cb}/vouchers`, { ...params, search, type, limit: PAGE, offset }, [key]);
  return (
    <>
      {showSearch && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <input value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} placeholder="Search party, voucher no., narration" aria-label="Search vouchers"
            style={{ ...input, flex: '1 1 240px', maxWidth: 360 }} />
          <select value={type} onChange={(e) => { setType(e.target.value); setOffset(0); }} style={input} aria-label="Voucher type">
            <option value="">All voucher types</option>
            {(data?.types || []).map((t) => <option key={t.voucher_type} value={t.voucher_type}>{`${t.voucher_type} (${num(t.count)})`}</option>)}
          </select>
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Date</th><th style={th}>Type</th><th style={th}>No.</th><th style={th}>Party</th><th style={thR}>Amount</th></tr></thead>
          <tbody>
            {(data?.rows || []).map((v) => (
              <tr key={v.id} onClick={() => open({ type: 'voucher', id: v.id, label: `${v.voucher_type} ${v.voucher_number || ''}`.trim() })} style={{ cursor: 'pointer' }}>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(v.voucher_date)}</td>
                <td style={td}>{v.voucher_type}{v.is_cancelled && <span style={{ marginLeft: 6 }}><Pill c={C.bad} bg={C.badBg}>Cancelled</Pill></span>}</td>
                <td style={td}>{v.voucher_number || '—'}</td>
                <td style={td}>{v.party_name || <span style={{ color: C.faint }}>{(v.narration || '').slice(0, 60)}</span>}</td>
                <td style={tdR}>{inr(v.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && !data && <Loading />}
        {data && !data.rows.length && <Empty>No vouchers match.</Empty>}
      </div>
      <Pager total={data?.total || 0} offset={offset} setOffset={setOffset} />
    </>
  );
}

/* ── one voucher, in full ─────────────────────────────────────────────────── */
function VoucherPanel({ entry }) {
  const { cb, open } = useDrill();
  const { data: v, loading, error } = useFetch(`${cb}/vouchers/${entry.id}`, undefined, [entry.id]);
  if (loading) return <Loading />;
  if (error || !v) return <Empty>{error || 'Voucher not found'}</Empty>;
  const d = v.details || {};
  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <Pill c={C.v} bg={C.vbg}>{v.base_type}</Pill>
        {v.is_cancelled && <Pill c={C.bad} bg={C.badBg}>Cancelled</Pill>}
        {v.is_optional && <Pill c={C.warn} bg={C.warnBg}>Optional</Pill>}
        {d.is_invoice && <Pill>Invoice</Pill>}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Amount" value={`₹${inr(v.amount)}`} />
        <Stat label="Date" value={fmtDate(v.voucher_date)} />
        <Stat label="Voucher no." value={v.voucher_number || '—'} />
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 14 }}>
        <Fact label="Party">{v.party_name && <LedgerLink name={v.party_name} />}</Fact>
        <Fact label="Party GSTIN">{d.party_gstin}</Fact>
        <Fact label="Place of supply">{d.place_of_supply}</Fact>
        <Fact label="Reference">{d.reference && `${d.reference}${d.reference_date ? ` · ${fmtDate(d.reference_date)}` : ''}`}</Fact>
        <Fact label="Buyer">{d.buyer_name !== v.party_name ? d.buyer_name : null}</Fact>
        <Fact label="IRN">{d.irn}</Fact>
        <Fact label="Entered by">{d.entered_by}</Fact>
      </div>
      {v.narration && <div style={{ marginTop: 14, fontSize: 13, color: C.muted, whiteSpace: 'pre-wrap', background: '#F8FAFC', borderRadius: 10, padding: '10px 12px' }}>{v.narration}</div>}

      <Section title="Ledger entries" count={v.ledger_entries.length}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Ledger</th><th style={th}>Group</th><th style={thR}>Debit</th><th style={thR}>Credit</th></tr></thead>
          <tbody>
            {v.ledger_entries.map((e, i) => (
              <tr key={i}>
                <td style={td}><LedgerLink id={e.ledger_id} name={e.ledger} /></td>
                <td style={{ ...td, color: C.muted }}>{e.group && <button type="button" style={{ ...linkBtn, color: C.muted, fontWeight: 500 }} onClick={() => open({ type: 'group', name: e.group })}>{e.group}</button>}</td>
                <td style={tdR}>{e.amount < 0 ? inr(e.amount) : ''}</td>
                <td style={tdR}>{e.amount > 0 ? inr(e.amount) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!v.ledger_entries.length && <Empty>Tally sent no ledger lines for this voucher{v.is_cancelled ? ' (it is cancelled)' : ''}.</Empty>}
      </Section>

      {(d.inventory || []).length > 0 && (
        <Section title="Items" count={d.inventory.length}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Item</th><th style={th}>HSN</th><th style={thR}>Qty</th><th style={thR}>Rate</th><th style={thR}>GST %</th><th style={thR}>Amount</th></tr></thead>
              <tbody>
                {d.inventory.map((it, i) => (
                  <tr key={i}>
                    <td style={td}><button type="button" style={linkBtn} onClick={() => open({ type: 'item', name: it.item })}>{it.item}</button>
                      {it.godown && <div style={{ fontSize: 11.5, color: C.faint }}>{it.godown}</div>}</td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{it.hsn || ''}</td>
                    <td style={tdR}>{it.qty !== undefined ? `${num(it.qty)} ${it.unit || ''}` : ''}</td>
                    <td style={tdR}>{it.rate !== undefined ? inr(it.rate) : ''}</td>
                    <td style={tdR}>{it.gst_rate !== undefined ? `${num(it.gst_rate)}%` : ''}</td>
                    <td style={tdR}>{inr(it.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {(d.bills || []).length > 0 && (
        <Section title="Bill allocations" count={d.bills.length}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Bill</th><th style={th}>Type</th><th style={th}>Ledger</th><th style={thR}>Amount</th></tr></thead>
            <tbody>
              {d.bills.map((b, i) => (
                <tr key={i}><td style={td}>{b.name || '—'}</td><td style={{ ...td, color: C.muted }}>{b.type || ''}</td>
                  <td style={td}><LedgerLink name={b.ledger} /></td><td style={tdR}>{inr(b.amount)} <span style={{ color: C.faint, fontSize: 11.5 }}>{drcr(b.amount)}</span></td></tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {(d.bank || []).length > 0 && (
        <Section title="Bank details" count={d.bank.length}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Bank ledger</th><th style={th}>Mode</th><th style={th}>Instrument</th><th style={th}>Favouring</th><th style={thR}>Amount</th></tr></thead>
            <tbody>
              {d.bank.map((b, i) => (
                <tr key={i}><td style={td}><LedgerLink name={b.ledger} /></td><td style={{ ...td, color: C.muted }}>{b.type || ''}</td>
                  <td style={td}>{b.instrument_no || ''}{b.instrument_date ? ` · ${fmtDate(b.instrument_date)}` : ''}</td>
                  <td style={td}>{b.favouring || ''}</td><td style={tdR}>{inr(b.amount)}</td></tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      <div style={{ marginTop: 18, fontSize: 11.5, color: C.faint }}>Tally GUID {v.guid} · AlterID {v.alter_id} · synced {fmtDate(v.synced_at)}</div>
    </>
  );
}

/* ── one ledger: who it is, how it moved, every voucher ───────────────────── */
function LedgerPanel({ entry }) {
  const { cb, open, period } = useDrill();
  const [offset, setOffset] = useState(0);
  const params = { ...(entry.id ? { ledger_id: entry.id } : { name: entry.name }), ...period, limit: PAGE, offset };
  const { data, loading, error } = useFetch(`${cb}/ledger-statement`, params, [entry.id, entry.name, period.from, period.to, offset]);
  if (loading && !data) return <Loading />;
  if (error || !data) return <Empty>{error || 'Ledger not found'}</Empty>;
  const l = data.ledger; const d = l.details || {};
  const months = data.monthly.map((m) => ({ ...m, label: monthLabel(m.month), Debit: Math.abs(m.debit), Credit: m.credit }));
  return (
    <>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, fontSize: 12.5, color: C.muted }}>
        {l.path.map((g, i) => (
          <React.Fragment key={g}>{i > 0 && <span style={{ color: C.faint }}>›</span>}
            <button type="button" style={{ ...linkBtn, fontWeight: 600 }} onClick={() => open({ type: 'group', name: g })}>{g}</button></React.Fragment>
        ))}
        <Pill>{l.nature}</Pill>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Opening" value={`₹${inr(data.opening)}`} tag={drcr(data.opening)} />
        <Stat label="Debits" value={`₹${inr(data.debit)}`} />
        <Stat label="Credits" value={`₹${inr(data.credit)}`} />
        <Stat label="Closing" value={`₹${inr(data.closing)}`} tag={drcr(data.closing)} />
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 14 }}>
        <Fact label="GSTIN">{l.gstin}</Fact>
        <Fact label="GST registration">{d.gst_registration_type}</Fact>
        <Fact label="PAN">{d.pan}</Fact>
        <Fact label="State">{[d.state, d.country].filter(Boolean).join(', ')}</Fact>
        <Fact label="Address">{[d.address, d.pincode].filter(Boolean).join(' – ')}</Fact>
        <Fact label="Email">{d.email}</Fact>
        <Fact label="Phone">{d.phone || d.mobile}</Fact>
        <Fact label="Credit period">{d.credit_period}</Fact>
        <Fact label="Bank">{[d.bank_name, d.bank_account, d.bank_ifsc, d.bank_holder].filter(Boolean).join(' · ')}</Fact>
        <Fact label="Tax head">{d.gst_duty_head && `${d.gst_duty_head}${d.tax_rate ? ` @ ${d.tax_rate}%` : ''}`}</Fact>
      </div>

      {months.length > 1 && (
        <Section title="Month by month">
          <div style={{ height: 190 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={months} barGap={2} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={C.grid} />
                <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: C.grid }} />
                <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={axisMoney} width={64} />
                <Tooltip {...tooltipStyle} formatter={(v) => `₹${inr(v)}`} />
                <Legend {...legendProps} />
                <Bar dataKey="Debit" fill={C.s1} radius={[4, 4, 0, 0]} maxBarSize={22} />
                <Bar dataKey="Credit" fill={C.s2} radius={[4, 4, 0, 0]} maxBarSize={22} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      {data.bills.length > 0 && (
        <Section title="Open bills" count={data.bills.length}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Bill</th><th style={th}>Date</th><th style={th}>Credit period</th><th style={thR}>Pending</th></tr></thead>
            <tbody>
              {data.bills.map((b, i) => (
                <tr key={i}><td style={td}>{b.name}{b.is_advance && <span style={{ marginLeft: 6 }}><Pill>Advance</Pill></span>}</td>
                  <td style={td}>{fmtDate(b.bill_date)}</td><td style={{ ...td, color: C.muted }}>{b.credit_period || ''}</td>
                  <td style={tdR}>{inr(b.closing)} <span style={{ color: C.faint, fontSize: 11.5 }}>{drcr(b.closing)}</span></td></tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="Transactions" count={num(data.total)}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Date</th><th style={th}>Particulars</th><th style={th}>Voucher</th><th style={thR}>Debit</th><th style={thR}>Credit</th><th style={thR}>Balance</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => open({ type: 'voucher', id: r.id, label: `${r.voucher_type} ${r.voucher_number || ''}`.trim() })}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(r.voucher_date)}</td>
                  <td style={td}>{r.particulars || r.party_name || '—'}</td>
                  <td style={{ ...td, color: C.muted }}>{r.voucher_type} {r.voucher_number || ''}</td>
                  <td style={tdR}>{r.amount < 0 ? inr(r.amount) : ''}</td>
                  <td style={tdR}>{r.amount > 0 ? inr(r.amount) : ''}</td>
                  <td style={tdR}>{inr(r.balance)} <span style={{ color: C.faint, fontSize: 11.5 }}>{drcr(r.balance)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.rows.length && <Empty>No transactions in this period.</Empty>}
        </div>
        <Pager total={data.total} offset={offset} setOffset={setOffset} />
      </Section>
    </>
  );
}

/* ── one group: its sub-groups and ledgers ────────────────────────────────── */
function GroupPanel({ entry }) {
  const { open, tree } = useDrill();
  const node = tree && tree.byName.get(entry.name);
  if (!tree) return <Loading />;
  if (!node) return <Empty>Group not found.</Empty>;
  const rows = [...node.children.map((c) => ({ kind: 'group', ...c })), ...node.ledgers.map((l) => ({ kind: 'ledger', ...l }))]
    .sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing));
  return (
    <>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, fontSize: 12.5 }}>
        {node.path.slice(0, -1).map((g) => (
          <React.Fragment key={g}><button type="button" style={{ ...linkBtn, fontWeight: 600 }} onClick={() => open({ type: 'group', name: g })}>{g}</button><span style={{ color: C.faint }}>›</span></React.Fragment>
        ))}
        <Pill>{node.nature}</Pill>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Opening" value={`₹${inr(node.opening)}`} tag={drcr(node.opening)} />
        <Stat label="Debits" value={`₹${inr(node.debit)}`} />
        <Stat label="Credits" value={`₹${inr(node.credit)}`} />
        <Stat label="Closing" value={`₹${inr(node.closing)}`} tag={drcr(node.closing)} />
      </div>
      <Section title="Inside this group" count={rows.length}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Name</th><th style={thR}>Debits</th><th style={thR}>Credits</th><th style={thR}>Closing</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.kind}:${r.name}`} style={{ cursor: 'pointer' }} onClick={() => open(r.kind === 'group' ? { type: 'group', name: r.name } : { type: 'ledger', id: r.id, name: r.name })}>
                <td style={td}><span style={{ fontWeight: r.kind === 'group' ? 800 : 500 }}>{r.name}</span>
                  {r.kind === 'group' && <span style={{ color: C.faint, fontSize: 11.5 }}> · group</span>}</td>
                <td style={tdR}>{r.debit ? inr(r.debit) : ''}</td>
                <td style={tdR}>{r.credit ? inr(r.credit) : ''}</td>
                <td style={tdR}>{inr(r.closing)} <span style={{ color: C.faint, fontSize: 11.5 }}>{drcr(r.closing)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty>This group is empty.</Empty>}
      </Section>
    </>
  );
}

/* ── one stock item: its master and every voucher it appears on ───────────── */
function ItemPanel({ entry }) {
  const { cb, period } = useDrill();
  const { data } = useFetch(`${cb}/inventory`, period, [period.from, period.to]);
  const it = (data?.items || []).find((x) => x.name === entry.name);
  return (
    <>
      {it && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Stat label="In stock" value={`${num(it.closing_qty)} ${it.unit || ''}`} />
            <Stat label="Stock value" value={`₹${inr(it.closing_value)}`} />
            <Stat label="Sold" value={`₹${inr(it.sold_value)}`} tag={`${num(it.sold_qty)} ${it.unit || ''}`} />
            <Stat label="Bought" value={`₹${inr(it.bought_value)}`} tag={`${num(it.bought_qty)} ${it.unit || ''}`} />
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 14 }}>
            <Fact label="Stock group">{it.group}</Fact>
            <Fact label="HSN">{it.hsn}</Fact>
            <Fact label="GST rate">{it.gst_rate !== null ? `${num(it.gst_rate)}%` : null}</Fact>
            <Fact label="Valuation rate">{it.closing_rate ? `₹${inr(it.closing_rate)}` : null}</Fact>
            <Fact label="Returns">{it.returned_value ? `₹${inr(it.returned_value)}` : null}</Fact>
          </div>
        </>
      )}
      <Section title="Vouchers with this item">
        <VoucherList params={{ item: entry.name, ...period }} />
      </Section>
    </>
  );
}

export default function DrillDrawer({ stack, setStack }) {
  if (!stack.length) return null;
  const entry = stack[stack.length - 1];
  const close = () => setStack([]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title(entry)} style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={close} style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.35)' }} />
      <div style={{ position: 'relative', width: 'min(860px, 100vw)', height: '100%', background: '#fff', boxShadow: '-12px 0 40px rgba(15,23,42,0.18)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 20px 12px', borderBottom: `1px solid ${C.line}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: C.muted, marginBottom: 6 }}>
            {stack.map((e, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span style={{ color: C.faint }}>›</span>}
                {i < stack.length - 1
                  ? <button type="button" style={{ ...linkBtn, fontWeight: 600 }} onClick={() => setStack(stack.slice(0, i + 1))}>{title(e)}</button>
                  : <span style={{ color: C.ink, fontWeight: 700 }}>{title(e)}</span>}
              </React.Fragment>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {stack.length > 1 && (
              <button type="button" aria-label="Back" onClick={() => setStack(stack.slice(0, -1))} style={{ ...input, padding: '6px 8px', cursor: 'pointer', display: 'inline-flex' }}><ChevronLeft size={16} /></button>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.v }}>{KIND[entry.type]}</div>
              <div style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 19, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title(entry)}</div>
            </div>
            <button type="button" aria-label="Close" onClick={close} style={{ ...input, padding: '6px 8px', cursor: 'pointer', display: 'inline-flex' }}><X size={16} /></button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 32px' }} key={`${stack.length}:${entry.type}:${entry.id || entry.name || entry.title}`}>
          {entry.type === 'ledger' && <LedgerPanel entry={entry} />}
          {entry.type === 'voucher' && <VoucherPanel entry={entry} />}
          {entry.type === 'group' && <GroupPanel entry={entry} />}
          {entry.type === 'item' && <ItemPanel entry={entry} />}
          {entry.type === 'vouchers' && <VoucherList params={entry.params} />}
        </div>
      </div>
    </div>
  );
}

import React, { useMemo } from 'react';
import { Download } from 'lucide-react';
import {
  ResponsiveContainer,
  PieChart, Pie, Cell,
  BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

/* ──────────────────────────────────────────────────────────────────────────
   ToolResultDashboard — reusable, presentational reco result dashboard.
   Used by RecoWorkspace (live runs) AND RecoJobDashboard (persisted jobs).
   Tolerant of BOTH live and persisted row naming conventions.
   ────────────────────────────────────────────────────────────────────────── */

// ─── Number helpers ──────────────────────────────────────────────────────────
const NAN_TOKENS = new Set(['', 'nan', 'nat', 'none', 'null', 'n/a', '-']);

// raw → Number for sums (null/empty/nan ⇒ 0)
function num(x) {
  if (x == null) return 0;
  if (typeof x === 'number') return isNaN(x) ? 0 : x;
  const s = String(x).trim().toLowerCase();
  if (NAN_TOKENS.has(s)) return 0;
  const n = Number(String(x).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

// did this value originally hold a real number?
function isEmptyVal(x) {
  if (x == null) return true;
  if (typeof x === 'number') return isNaN(x);
  return NAN_TOKENS.has(String(x).trim().toLowerCase());
}

// display a numeric cell with en-IN formatting; '—' when empty
function money(x) {
  if (isEmptyVal(x)) return '—';
  return num(x).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// display a plain count
const cnt = (n) => Number(n || 0).toLocaleString('en-IN');

// ─── Canonical field accessors (tolerant of live OR persisted names) ─────────
const F = {
  // GST invoice agents
  supplier:  (r) => r.supplier ?? r.supplier_name ?? '—',
  gstin:     (r) => r.gstin ?? r.supplier_gstin ?? '—',
  invoiceNo: (r) => r.invoice_no ?? r.invoice_number ?? '—',
  invDate:   (r) => r.date ?? r.invoice_date ?? '—',
  taxable:   (r) => r.taxable_value,
  igst:      (r) => r.igst,
  cgst:      (r) => r.cgst,
  sgst:      (r) => r.sgst,
  remark1:   (r) => r.suggested_action ?? r.remark_1 ?? '—',
  remark2:   (r) => r.remark_2 ?? r.suggested_action_2 ?? r.explanation ?? '—',
  remark3:   (r) => r.remark_3 ?? r.suggested_action_3 ?? null,
  // Bank agents
  txnDate:    (r) => r.txn_date ?? r.date ?? '—',
  desc:       (r) => r.description ?? '—',
  debit:      (r) => r.debit,
  credit:     (r) => r.credit,
  balance:    (r) => r.balance,
  ledger:     (r) => r.ledger_name ?? r.predicted_ledger ?? '—',
  confidence: (r) => r.confidence,
  corrected:  (r) => !!r.corrected,
  // GSTR-3B vs 2B
  itcType:   (r) => r.itc_type ?? '—',
  claimed:   (r) => r.claimed_value,
  available: (r) => r.available_value,
  diff:      (r) => r.difference,
  remark:    (r) => r.remark ?? '—',
  // GSTR-3B Tally entry
  rowType:     (r) => r.row_type ?? 'data',
  sno:         (r) => r.sno ?? '—',
  particulars: (r) => r.particulars ?? '—',
};

// ─── Agent grouping ───────────────────────────────────────────────────────────
const GST_2B_AGENTS = new Set([
  'gstr_2b_books', 'gstr_2b_books_multistate', 'gstr_2a_vs_2b_vs_books',
  'gstr_2b_vs_purchase', 'gstr_2a_2b_books', 'einvoice_reco',
]);
const BANK_AGENTS = new Set(['universal_bank_statement', 'bank_reco', 'bank_statement']);

function classifyAgent(t) {
  if (GST_2B_AGENTS.has(t)) return '2b';
  if (t === 'bank_tally_reco') return 'bankreco';
  if (BANK_AGENTS.has(t)) return 'bank';
  if (t === 'gstr_3b_vs_2b') return '3b2b';
  if (t === 'gstr_3b_tally_entry') return 'tally';
  return 'generic';
}

// ─── Palettes ─────────────────────────────────────────────────────────────────
const STATUS_COLORS = {
  'Matched': '#059669',
  'Showing in 2B but Not in Books': '#D97706',
  'Showing in Books but Not in 2B': '#E11D48',
  'Amount Mismatch': '#F59E0B',
};
const FALLBACK_CYCLE = ['#0748EE', '#7C3AED', '#F115F8', '#0F766E', '#94A3B8'];
const statusColor = (name, i = 0) => STATUS_COLORS[name] || FALLBACK_CYCLE[i % FALLBACK_CYCLE.length];

const CONF_COLORS = { High: '#059669', Medium: '#D97706', Low: '#E11D48' };
const CONF_BG = {
  High:   { bg: '#ECFDF5', color: '#059669', border: '#A7F3D0' },
  Medium: { bg: '#FFFBEB', color: '#D97706', border: '#FDE68A' },
  Low:    { bg: '#FEF2F2', color: '#E11D48', border: '#FECACA' },
};

// ─── Shared style atoms ───────────────────────────────────────────────────────
const TH = {
  fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
  padding: '8px 10px', textAlign: 'left', color: '#64748B', background: '#F8FAFC',
  whiteSpace: 'nowrap', borderBottom: '1.5px solid #E2E8F0', position: 'sticky', top: 0, zIndex: 1,
};
const THr = { ...TH, textAlign: 'right' };
const TD = { fontSize: '12px', padding: '6px 10px', textAlign: 'left', color: '#334155', borderBottom: '1px solid #F1F5F9', whiteSpace: 'nowrap' };
const TDn = { ...TD, textAlign: 'right', fontFamily: 'monospace' };
const CHART_TITLE = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748B', marginBottom: '8px' };
const CHART_MARGIN = { top: 5, right: 10, left: -20, bottom: 0 };
const AXIS_TICK = { fontSize: 11, fill: '#94A3B8' };
const GRID = { strokeDasharray: '3 3', stroke: '#F1F5F9' };

// ─── Small presentational pieces ──────────────────────────────────────────────
function StatCard({ label, value, color = '#0748EE', bg = '#E8EFFE' }) {
  return (
    <div className="stat-card" style={{ padding: '14px 16px', background: bg, border: `1px solid ${color}22` }}>
      <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: '26px', lineHeight: 1.05, color }}>
        {value}
      </div>
      <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color, marginTop: '4px', opacity: 0.85 }}>
        {label}
      </div>
    </div>
  );
}

function Pill({ text, color, bg, border }) {
  return (
    <span className="inline-flex items-center" style={{
      fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '9999px',
      background: bg, color, border: `1px solid ${border}`, whiteSpace: 'nowrap',
    }}>
      {text}
    </span>
  );
}

function StatusPill({ status, i = 0 }) {
  const c = statusColor(status, i);
  return <Pill text={status} color={c} bg={`${c}14`} border={`${c}55`} />;
}

function ConfPill({ value }) {
  const cfg = CONF_BG[value] || { bg: '#F1F5F9', color: '#64748B', border: '#CBD5E1' };
  return <Pill text={value || '—'} {...cfg} />;
}

function ChartCard({ title, children, height = 210 }) {
  return (
    <div className="glass-card" style={{ padding: '14px 16px' }}>
      <div style={CHART_TITLE}>{title}</div>
      <ResponsiveContainer width="100%" height={height}>{children}</ResponsiveContainer>
    </div>
  );
}

function ChartsRow({ children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginBottom: '20px' }}>
      {children}
    </div>
  );
}

function Empty({ label = 'No records to display' }) {
  return (
    <div className="glass-card" style={{ padding: '40px', textAlign: 'center', color: '#94A3B8', fontSize: '13px' }}>
      {label}
    </div>
  );
}

function TableWrap({ children, minWidth = '900px' }) {
  return (
    <div className="glass-card" style={{ overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth }}>{children}</table>
      </div>
    </div>
  );
}

// ─── Header row: KPIs + download ───────────────────────────────────────────────
function KpiHeader({ cards, onDownload, downloading }) {
  return (
    <div style={{ marginBottom: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: '13px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748B', margin: 0 }}>
          Summary
        </h3>
        {onDownload && (
          <button
            onClick={onDownload}
            disabled={downloading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              background: '#0748EE', color: '#fff', border: 'none', borderRadius: '12px',
              padding: '9px 16px', fontSize: '13px', fontWeight: 600,
              cursor: downloading ? 'not-allowed' : 'pointer', opacity: downloading ? 0.7 : 1,
              boxShadow: '0 2px 8px rgba(7,72,238,0.25)', transition: 'all 0.15s',
            }}>
            {downloading
              ? (<><span className="animate-spin" style={{ width: '14px', height: '14px', border: '2px solid #ffffff80', borderTopColor: '#fff', borderRadius: '50%', display: 'inline-block' }} /> Preparing…</>)
              : (<><Download style={{ width: '15px', height: '15px' }} /> Download Excel</>)}
          </button>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
        {cards.map((c) => <StatCard key={c.label} {...c} />)}
      </div>
    </div>
  );
}

// ─── Filter chips ───────────────────────────────────────────────────────────────
function FilterChips({ chips, filter, setFilter }) {
  if (!setFilter || chips.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
      {chips.map((chip) => {
        const active = (filter || 'All') === chip.value;
        const c = chip.color || '#0748EE';
        return (
          <button key={chip.value} onClick={() => setFilter(chip.value)}
            style={{
              fontSize: '12px', fontWeight: 600, padding: '5px 13px', borderRadius: '9999px', cursor: 'pointer',
              transition: 'all 0.12s',
              background: active ? `${c}1A` : '#F8FAFC',
              border: `1.5px solid ${active ? c : '#E2E8F0'}`,
              color: active ? c : '#64748B',
            }}>
            {chip.label} ({cnt(chip.count)})
          </button>
        );
      })}
    </div>
  );
}

// ─── Banner ─────────────────────────────────────────────────────────────────────
function MoreBanner({ shown, total }) {
  if (total <= shown) return null;
  return (
    <div style={{ fontSize: '12px', color: '#64748B', marginBottom: '8px', padding: '6px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: '8px', display: 'inline-block' }}>
      Showing first {cnt(shown)} of {cnt(total)} rows — download the Excel for the full dataset.
    </div>
  );
}

// ─── "By Reason" breakdown (the settlement-dashboard "Unreconciled by Reasons") ──
// Distribution of a row accessor, skipping clean/empty buckets so only real
// observations (mismatches, RCM, duplicates, excess-in-2B vs excess-in-books…) show.
export function distOf(rows, accessor) {
  const m = new Map();
  for (const r of rows) {
    let k = accessor(r);
    if (k == null) k = '—';
    k = String(k).trim();
    const low = k.toLowerCase();
    if (k === '' || k === '—' || low === 'matched' || NAN_TOKENS.has(low)) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

// Reason → colour. Highlights the "less/more received" analog: Excess in 2B (amber)
// vs Excess in Books (rose), plus mismatch / RCM / duplicate / date families.
function reasonColor(name, i = 0) {
  const n = String(name).toLowerCase();
  if (n.includes('excess in 2b')) return '#D97706';
  if (n.includes('excess in books')) return '#E11D48';
  if (n.includes('mismatch')) return '#F59E0B';
  if (n.includes('rcm') || n.includes('reverse charge')) return '#7C3AED';
  if (n.includes('duplicate')) return '#0F766E';
  if (n.includes('date')) return '#0748EE';
  return FALLBACK_CYCLE[i % FALLBACK_CYCLE.length];
}

// Reusable status donut (used by 2b dashboard + multistate workspace).
export function StatusDonut({ title = 'Status Distribution', data, height = 210 }) {
  if (!data || data.length === 0) return null;
  return (
    <div className="glass-card" style={{ padding: '14px 16px' }}>
      <div style={CHART_TITLE}>{title}</div>
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={2}>
            {data.map((d, i) => <Cell key={d.name} fill={statusColor(d.name, i)} />)}
          </Pie>
          <Tooltip formatter={(v, n) => [cnt(v), n]} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ByReasons({ title = 'By Reason', data, colorFor = reasonColor }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div className="glass-card" style={{ padding: '14px 16px' }}>
      <div style={CHART_TITLE}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
        {data.map((d, i) => {
          const c = colorFor(d.name, i);
          return (
            <div key={d.name} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px', alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '12px', color: '#334155', marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.name}>{d.name}</div>
                <div style={{ height: '6px', borderRadius: '9999px', background: '#F1F5F9', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(d.count / max) * 100}%`, background: c, borderRadius: '9999px' }} />
                </div>
              </div>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '13px', fontWeight: 700, color: c }}>{cnt(d.count)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ROW_CAP = 200;
const altBg = (i) => (i % 2 === 1 ? '#FAFBFF' : undefined);

// Default friendly labels (used in the feedback title when the parent doesn't pass one).
const AGENT_LABELS = {
  gstr_2b_books: 'GSTR-2B vs Books', gstr_2b_books_multistate: 'GSTR-2B vs Books (Multi-State)',
  gstr_2a_vs_2b_vs_books: 'GSTR-2A vs 2B vs Books', gstr_2b_vs_purchase: 'GSTR-2B vs Purchase',
  gstr_2a_2b_books: 'GSTR-2A + 2B vs Books', gstr_3b_vs_2b: 'GSTR-3B vs 2B',
  gstr_3b_tally_entry: 'GSTR-3B Tally Entry', universal_bank_statement: 'Universal Bank Statement',
  bank_reco: 'Bank Statement', gstr_1_vs_books: 'GSTR-1 vs Books',
};

// One-line human summary of a row for the feedback picker.
function rowLine(kind, r) {
  if (kind === 'bank') return `${F.txnDate(r)} · ${String(F.desc(r)).slice(0, 44)} · ${F.ledger(r)} · ${F.confidence(r) || '—'}`;
  if (kind === '3b2b') return `${F.itcType(r)} · diff ₹${money(F.diff(r))} · ${F.remark(r)}`;
  if (kind === 'tally') return `${F.sno(r)} · ${String(F.particulars(r)).slice(0, 60)}`;
  if (kind === '2b') return `${F.supplier(r)} · ${F.invoiceNo(r)} · ₹${money(F.taxable(r))} · ${F.remark1(r)}`;
  const keys = Object.keys(r || {}).filter((k) => !['raw', 'raw_books', 'raw_gstr', 'gstr2b', 'purchase'].includes(k)).slice(0, 3);
  return keys.map((k) => `${r[k]}`).join(' · ');
}

// Compact snapshot stored on the feedback task so the engineer sees the exact rows.
function rowSnapshot(kind, r) {
  if (kind === 'bank') return { txn_date: F.txnDate(r), description: F.desc(r), debit: F.debit(r), credit: F.credit(r), ledger: F.ledger(r), confidence: F.confidence(r) };
  if (kind === '3b2b') return { itc_type: F.itcType(r), claimed: F.claimed(r), available: F.available(r), difference: F.diff(r), remark: F.remark(r) };
  if (kind === 'tally') return { sno: F.sno(r), particulars: F.particulars(r), debit: F.debit(r), credit: F.credit(r) };
  if (kind === '2b') return { supplier: F.supplier(r), gstin: F.gstin(r), invoice_no: F.invoiceNo(r), date: F.invDate(r), taxable: F.taxable(r), remark_1: F.remark1(r), remark_2: F.remark2(r) };
  const out = {}; Object.keys(r || {}).filter((k) => !['raw', 'raw_books', 'raw_gstr', 'gstr2b', 'purchase'].includes(k)).slice(0, 8).forEach((k) => { out[k] = r[k]; }); return out;
}

// Feedback modal — pick rows + write a comment → onSend({ comment, rows:[snapshots] }).
export function FeedbackModal({ kind, rows, agentLabel, onClose, onSend }) {
  const [sel, setSel] = React.useState(() => new Set());
  const [comment, setComment] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const list = rows.slice(0, ROW_CAP);
  const toggle = (i) => setSel((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const allOn = list.length > 0 && sel.size === list.length;
  const toggleAll = () => setSel(allOn ? new Set() : new Set(list.map((_, i) => i)));

  const send = async () => {
    if (!comment.trim() || sending) return;
    setSending(true);
    try {
      const picked = [...sel].sort((a, b) => a - b).map((i) => rowSnapshot(kind, list[i]));
      await onSend({ comment: comment.trim(), rows: picked });
      onClose();
    } catch (_) { /* parent toasts the error; keep the modal open to retry */ }
    finally { setSending(false); }
  };

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div className="glass-card" style={{ width: 'min(640px, 100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 18px', borderBottom: '1px solid #E2E8F0' }}>
          <div style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: '16px', color: '#0F172A' }}>Send feedback{agentLabel ? ` · ${agentLabel}` : ''}</div>
          <div style={{ fontSize: '12px', color: '#64748B', marginTop: '2px' }}>Select the rows that look wrong and describe the issue. This becomes a task for the engineering team.</div>
        </div>

        <div style={{ padding: '12px 18px', overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748B' }}>
              Rows {sel.size > 0 ? `(${sel.size} selected)` : '(optional)'}
            </div>
            {list.length > 0 && (
              <button onClick={toggleAll} style={{ background: 'none', border: 'none', color: '#0748EE', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                {allOn ? 'Clear all' : 'Select all'}
              </button>
            )}
          </div>
          <div style={{ border: '1px solid #E2E8F0', borderRadius: '10px', overflow: 'hidden', maxHeight: '34vh', overflowY: 'auto' }}>
            {list.length === 0 ? (
              <div style={{ padding: '16px', fontSize: '13px', color: '#94A3B8' }}>No rows to attach — you can still send a general comment.</div>
            ) : list.map((r, i) => (
              <label key={i} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 12px', borderBottom: '1px solid #F1F5F9', cursor: 'pointer', background: sel.has(i) ? '#EFF6FF' : (i % 2 ? '#FAFBFF' : '#fff') }}>
                <input type="checkbox" checked={sel.has(i)} onChange={() => toggle(i)} style={{ marginTop: '2px' }} />
                <span style={{ fontSize: '12px', color: '#334155', lineHeight: 1.4 }}>{rowLine(kind, r)}</span>
              </label>
            ))}
          </div>

          <div style={{ marginTop: '14px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748B', marginBottom: '6px' }}>What's wrong? *</div>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={4}
              placeholder="e.g. These invoices are matched in reality but flagged as mismatch — the date tolerance seems off."
              style={{ width: '100%', borderRadius: '10px', border: '1px solid #E2E8F0', padding: '10px 12px', fontSize: '13px', color: '#334155', resize: 'vertical', outline: 'none', fontFamily: 'inherit' }} />
          </div>
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid #E2E8F0', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button onClick={onClose} style={{ padding: '9px 16px', borderRadius: '10px', border: '1px solid #E2E8F0', background: '#fff', color: '#334155', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={send} disabled={!comment.trim() || sending}
            style={{ padding: '9px 18px', borderRadius: '10px', border: 'none', background: (!comment.trim() || sending) ? '#94A3B8' : '#0748EE', color: '#fff', fontSize: '13px', fontWeight: 600, cursor: (!comment.trim() || sending) ? 'not-allowed' : 'pointer' }}>
            {sending ? 'Sending…' : `Send feedback${sel.size ? ` (${sel.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════
export default function ToolResultDashboard({
  agentType,
  summary = {},
  counts = {},
  rows = [],
  filter,
  setFilter,
  onDownload,
  downloading,
  isUniversal,
  editedLedgers,
  setEditedLedgers,
  onSendFeedback,   // async ({comment, rows}) => …  (enables the feedback UI when provided)
  agentLabel,
  embedded = false, // chat/inline mode: KPIs + charts only, no row table / download
  columns,          // optional explicit column order (generic dashboard only) — see GenericDashboard
}) {
  const kind = classifyAgent(agentType);
  const safeRows = Array.isArray(rows) ? rows : [];
  const [feedbackOpen, setFeedbackOpen] = React.useState(false);
  const label = agentLabel || AGENT_LABELS[agentType] || agentType;

  // Distinct status / confidence distribution (for chips, donut, KPIs)
  const dist = useMemo(() => {
    const m = new Map();
    if (kind === '2b') {
      for (const r of safeRows) {
        const k = F.remark1(r) || '—';
        m.set(k, (m.get(k) || 0) + 1);
      }
    } else if (kind === 'bank') {
      for (const r of safeRows) {
        const k = F.confidence(r) || 'Unknown';
        m.set(k, (m.get(k) || 0) + 1);
      }
    }
    return m;
  }, [safeRows, kind]);

  // Pair every row with its ABSOLUTE index in the full unfiltered set. Edits
  // (bank ledger corrections) MUST key off this absolute idx — the parent saves
  // corrections by indexing into its full result.results array, so a filtered/
  // capped position would write the wrong narration into bank_reco_corrections.
  const indexed = useMemo(() => safeRows.map((row, idx) => ({ row, idx })), [safeRows]);

  // Self-filtering. Parents pass the FULL row set + the active filter value, and
  // this component owns all filtering — so chip counts (from `dist`/`safeRows`)
  // always reflect the whole dataset, never a pre-filtered subset.
  const displayed = useMemo(() => {
    if (!filter || filter === 'All') return indexed;
    if (kind === '2b') return indexed.filter((p) => (F.remark1(p.row) || '—') === filter);
    if (kind === 'bank') return indexed.filter((p) => (F.confidence(p.row) || 'Unknown') === filter);
    if (kind === 'bankreco') return indexed.filter((p) => (p.row.reco_status || '—') === filter);
    return indexed;
  }, [indexed, filter, kind]);

  const capped = displayed.slice(0, ROW_CAP);

  // In embedded (chat) mode the inline Download button is hidden — download
  // lives on the Excel pane — so pass a falsy onDownload to KpiHeader.
  const dld = embedded ? undefined : onDownload;

  // Dispatch by agent kind ----------------------------------------------------
  let dash;
  if (kind === '2b') dash = <Gst2bDashboard {...{ agentType, summary, safeRows, displayed, capped, dist, filter, setFilter, onDownload: dld, downloading, embedded }} />;
  else if (kind === 'bankreco') dash = <BankRecoDashboard {...{ summary, counts, safeRows, displayed, capped, filter, setFilter, onDownload: dld, downloading, embedded }} />;
  else if (kind === 'bank') dash = <BankDashboard {...{ summary, counts, safeRows, displayed, capped, dist, filter, setFilter, onDownload: dld, downloading, isUniversal, editedLedgers, setEditedLedgers, embedded }} />;
  else if (kind === '3b2b') dash = <Gst3b2bDashboard {...{ safeRows, capped, displayed, onDownload: dld, downloading, embedded }} />;
  else if (kind === 'tally') dash = <TallyDashboard {...{ safeRows, capped, displayed, onDownload: dld, downloading, embedded }} />;
  else dash = <GenericDashboard {...{ safeRows, capped, displayed, onDownload: dld, downloading, embedded, columns }} />;

  if (!onSendFeedback) return dash;

  // Feedback-enabled wrapper (accountant/admin viewing a brand's result).
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
        <button onClick={() => setFeedbackOpen(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', background: '#fff', color: '#0748EE', border: '1.5px solid #A3BFF8', borderRadius: '10px', padding: '7px 14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
          🚩 Flag rows / Send feedback
        </button>
      </div>
      {dash}
      {feedbackOpen && (
        <FeedbackModal
          kind={kind}
          rows={safeRows}
          agentLabel={label}
          onClose={() => setFeedbackOpen(false)}
          onSend={onSendFeedback}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  2B FAMILY
// ════════════════════════════════════════════════════════════════════════════
function Gst2bDashboard({ agentType, summary, safeRows, displayed, capped, dist, filter, setFilter, onDownload, downloading, embedded }) {
  const isMulti = agentType === 'gstr_2b_books_multistate';

  const total = summary.total != null ? Number(summary.total) : safeRows.length;
  const matched = summary.matched != null ? Number(summary.matched) : (dist.get('Matched') || 0);
  const issues = Math.max(0, total - matched);

  const cards = [
    { label: 'Total Invoices', value: cnt(total), color: '#0748EE', bg: '#E8EFFE' },
    { label: 'Matched', value: cnt(matched), color: '#059669', bg: '#ECFDF5' },
    { label: 'Issues', value: cnt(issues), color: '#E11D48', bg: '#FEF2F2' },
  ];

  // donut data
  const donut = useMemo(() => [...dist.entries()].map(([name, value]) => ({ name, value })), [dist]);

  // top suppliers by taxable
  const topSuppliers = useMemo(() => {
    const m = new Map();
    for (const r of safeRows) {
      const s = F.supplier(r);
      if (!s || s === '—') continue;
      m.set(s, (m.get(s) || 0) + num(F.taxable(r)));
    }
    return [...m.entries()].map(([name, taxable]) => ({ name: name.length > 18 ? name.slice(0, 17) + '…' : name, taxable }))
      .sort((a, b) => b.taxable - a.taxable).slice(0, 8);
  }, [safeRows]);

  // by state (multistate)
  const byState = useMemo(() => {
    if (!isMulti) return [];
    const m = new Map();
    for (const r of safeRows) {
      const g = F.gstin(r);
      const st = g && g !== '—' ? String(g).slice(0, 2) : '??';
      m.set(st, (m.get(st) || 0) + 1);
    }
    return [...m.entries()].map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count);
  }, [safeRows, isMulti]);

  const showRemark3 = isMulti && safeRows.some((r) => F.remark3(r));

  // "By reason" = the secondary observations (Remark 2): tax/value mismatch,
  // Excess in 2B vs Excess in Books, date mismatch, RCM, duplicate…
  const reasons = useMemo(() => distOf(safeRows, F.remark2), [safeRows]);

  const chips = useMemo(() => {
    const arr = [{ value: 'All', label: 'All', count: safeRows.length, color: '#0748EE' }];
    let i = 0;
    for (const [name, count] of dist.entries()) {
      arr.push({ value: name, label: name, count, color: statusColor(name, i++) });
    }
    return arr;
  }, [dist, safeRows.length]);

  return (
    <div>
      <KpiHeader cards={cards} onDownload={onDownload} downloading={downloading} />

      {safeRows.length > 0 && (
        <ChartsRow>
          <ChartCard title="Status Distribution">
            <PieChart>
              <Pie data={donut} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={2}>
                {donut.map((d, i) => <Cell key={d.name} fill={statusColor(d.name, i)} />)}
              </Pie>
              <Tooltip formatter={(v, n) => [cnt(v), n]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ChartCard>
          <ChartCard title="Top Suppliers by Taxable Value">
            <BarChart data={topSuppliers} margin={CHART_MARGIN}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="name" tick={AXIS_TICK} interval={0} angle={-25} textAnchor="end" height={60} />
              <YAxis tick={AXIS_TICK} />
              <Tooltip formatter={(v) => money(v)} />
              <Bar dataKey="taxable" fill="#0748EE" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartCard>
          {isMulti && byState.length > 0 && (
            <ChartCard title="Invoices by State Code">
              <BarChart data={byState} margin={CHART_MARGIN}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="state" tick={AXIS_TICK} />
                <YAxis tick={AXIS_TICK} />
                <Tooltip formatter={(v) => cnt(v)} />
                <Bar dataKey="count" fill="#7C3AED" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartCard>
          )}
          {reasons.length > 0 && <ByReasons title="Issues by Reason" data={reasons} />}
        </ChartsRow>
      )}

      {!embedded && <>
      <FilterChips chips={chips} filter={filter} setFilter={setFilter} />
      <MoreBanner shown={ROW_CAP} total={displayed.length} />

      {displayed.length === 0 ? <Empty /> : (
        <TableWrap minWidth={showRemark3 ? '1200px' : '1080px'}>
          <thead>
            <tr>
              <th style={TH}>Supplier</th>
              <th style={TH}>GSTIN</th>
              <th style={TH}>Invoice #</th>
              <th style={TH}>Date</th>
              <th style={THr}>Taxable</th>
              <th style={THr}>IGST</th>
              <th style={THr}>CGST</th>
              <th style={THr}>SGST</th>
              <th style={TH}>Remark 1</th>
              <th style={TH}>Remark 2</th>
              {showRemark3 && <th style={TH}>Remark 3</th>}
            </tr>
          </thead>
          <tbody>
            {capped.map(({ row: r, idx }, i) => {
              const r1 = F.remark1(r);
              const r3 = F.remark3(r);
              return (
                <tr key={idx} style={{ background: altBg(i) }}>
                  <td style={{ ...TD, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{F.supplier(r)}</td>
                  <td style={{ ...TD, fontFamily: 'monospace', fontSize: '11px' }}>{F.gstin(r)}</td>
                  <td style={TD}>{F.invoiceNo(r)}</td>
                  <td style={TD}>{F.invDate(r)}</td>
                  <td style={TDn}>{money(F.taxable(r))}</td>
                  <td style={TDn}>{money(F.igst(r))}</td>
                  <td style={TDn}>{money(F.cgst(r))}</td>
                  <td style={TDn}>{money(F.sgst(r))}</td>
                  <td style={TD}>{r1 && r1 !== '—' ? <StatusPill status={r1} /> : '—'}</td>
                  <td style={{ ...TD, color: '#64748B', maxWidth: '220px', whiteSpace: 'normal' }}>{F.remark2(r)}</td>
                  {showRemark3 && <td style={{ ...TD, color: '#C45911', maxWidth: '220px', whiteSpace: 'normal' }}>{r3 || '—'}</td>}
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      </>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  BANK FAMILY
// ════════════════════════════════════════════════════════════════════════════
function BankDashboard({ summary, counts, safeRows, displayed, capped, dist, filter, setFilter, onDownload, downloading, isUniversal, editedLedgers, setEditedLedgers, embedded }) {
  const total = counts.total_records != null ? Number(counts.total_records)
    : summary.total_transactions != null ? Number(summary.total_transactions)
    : safeRows.length;
  const high = counts.high != null ? Number(counts.high) : (dist.get('High') || 0);
  const medium = counts.medium != null ? Number(counts.medium) : (dist.get('Medium') || 0);
  const low = counts.low != null ? Number(counts.low) : (dist.get('Low') || 0);

  const cards = [
    { label: 'Transactions', value: cnt(total), color: '#0748EE', bg: '#E8EFFE' },
    { label: 'High Confidence', value: cnt(high), color: '#059669', bg: '#ECFDF5' },
    { label: 'Medium', value: cnt(medium), color: '#D97706', bg: '#FFFBEB' },
    { label: 'Low', value: cnt(low), color: '#E11D48', bg: '#FEF2F2' },
  ];
  if (counts.master_ledgers != null) {
    cards.push({ label: 'Master Ledgers', value: cnt(counts.master_ledgers), color: '#0F766E', bg: '#ECFEFF' });
  }

  const confDonut = useMemo(() => {
    const order = ['High', 'Medium', 'Low'];
    const seen = [...dist.keys()];
    const ordered = [...order.filter((o) => dist.has(o)), ...seen.filter((s) => !order.includes(s))];
    return ordered.map((name) => ({ name, value: dist.get(name) || 0 }));
  }, [dist]);

  const topLedgers = useMemo(() => {
    const m = new Map();
    for (const r of safeRows) {
      const l = F.ledger(r);
      if (!l || l === '—') continue;
      m.set(l, (m.get(l) || 0) + 1);
    }
    return [...m.entries()].map(([name, count]) => ({ name: name.length > 20 ? name.slice(0, 19) + '…' : name, count }))
      .sort((a, b) => b.count - a.count).slice(0, 8);
  }, [safeRows]);

  const chips = useMemo(() => {
    const arr = [{ value: 'All', label: 'All', count: safeRows.length, color: '#0748EE' }];
    for (const name of ['High', 'Medium', 'Low']) {
      if (dist.has(name)) arr.push({ value: name, label: name, count: dist.get(name), color: CONF_COLORS[name] });
    }
    return arr;
  }, [dist, safeRows.length]);

  const editable = isUniversal && editedLedgers && setEditedLedgers;
  const onLedgerChange = (idx, val) => {
    setEditedLedgers({ ...editedLedgers, [idx]: val });
  };

  return (
    <div>
      <KpiHeader cards={cards} onDownload={onDownload} downloading={downloading} />

      {safeRows.length > 0 && (
        <ChartsRow>
          <ChartCard title="Confidence Distribution">
            <PieChart>
              <Pie data={confDonut} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={2}>
                {confDonut.map((d, i) => <Cell key={d.name} fill={CONF_COLORS[d.name] || FALLBACK_CYCLE[i % FALLBACK_CYCLE.length]} />)}
              </Pie>
              <Tooltip formatter={(v, n) => [cnt(v), n]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ChartCard>
          <ChartCard title="Top Ledgers by Transaction Count">
            <BarChart data={topLedgers} margin={CHART_MARGIN}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="name" tick={AXIS_TICK} interval={0} angle={-25} textAnchor="end" height={60} />
              <YAxis tick={AXIS_TICK} />
              <Tooltip formatter={(v) => cnt(v)} />
              <Bar dataKey="count" fill="#0748EE" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartCard>
        </ChartsRow>
      )}

      {!embedded && <>
      <FilterChips chips={chips} filter={filter} setFilter={setFilter} />
      <MoreBanner shown={ROW_CAP} total={displayed.length} />

      {displayed.length === 0 ? <Empty /> : (
        <TableWrap minWidth="980px">
          <thead>
            <tr>
              <th style={TH}>Txn Date</th>
              <th style={TH}>Description</th>
              <th style={THr}>Debit</th>
              <th style={THr}>Credit</th>
              <th style={THr}>Balance</th>
              <th style={TH}>Ledger</th>
              <th style={TH}>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {capped.map(({ row: r, idx }, i) => {
              const corrected = F.corrected(r);
              return (
                <tr key={idx} style={{ background: altBg(i) }}>
                  <td style={TD}>{F.txnDate(r)}</td>
                  <td style={{ ...TD, maxWidth: '320px', whiteSpace: 'normal' }}>{F.desc(r)}</td>
                  <td style={TDn}>{money(F.debit(r))}</td>
                  <td style={TDn}>{money(F.credit(r))}</td>
                  <td style={TDn}>{money(F.balance(r))}</td>
                  <td style={TD}>
                    {editable ? (
                      <input
                        value={editedLedgers[idx] != null ? editedLedgers[idx] : F.ledger(r)}
                        onChange={(e) => onLedgerChange(idx, e.target.value)}
                        style={{
                          fontSize: '12px', padding: '4px 8px', borderRadius: '6px',
                          border: '1px solid #E2E8F0', background: '#fff', color: '#334155',
                          width: '200px', outline: 'none',
                        }}
                      />
                    ) : (
                      <span>{F.ledger(r)}{corrected && <span style={{ marginLeft: 6, fontSize: 10, color: '#059669', fontWeight: 700 }}>✓</span>}</span>
                    )}
                  </td>
                  <td style={TD}><ConfPill value={F.confidence(r)} /></td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      </>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  BANK-VS-TALLY RECO (dedicated dashboard — real reco buckets, not confidence)
// ════════════════════════════════════════════════════════════════════════════
const RECO_STATUS_COLORS = {
  'Already in Tally': '#059669',
  'Date updated': '#D97706',
  'Partially matched': '#EA580C',
  'Bank-only — add': '#E11D48',
  'Tally-only — check': '#64748B',
};
const recoStatusColor = (name) => RECO_STATUS_COLORS[name] || '#64748B';

function RecoStatusPill({ status }) {
  const c = recoStatusColor(status);
  return <Pill text={status || '—'} color={c} bg={`${c}14`} border={`${c}55`} />;
}

function BankRecoDashboard({ summary, counts, safeRows, displayed, capped, filter, setFilter, onDownload, downloading, embedded }) {
  const cards = [
    { label: 'Matched', value: cnt(counts.matched), color: '#059669', bg: '#ECFDF5' },
    { label: 'Date-updated', value: cnt(counts.date_updated), color: '#D97706', bg: '#FFFBEB' },
    { label: 'Partially matched', value: cnt(counts.partial), color: '#EA580C', bg: '#FFF1E9' },
    { label: 'Bank-only → paste', value: cnt(counts.bank_only), color: '#E11D48', bg: '#FEF2F2' },
    { label: 'Tally-only → check', value: cnt(counts.tally_only), color: '#64748B', bg: '#F1F5F9' },
  ];

  const chips = useMemo(() => {
    const order = ['Already in Tally', 'Date updated', 'Partially matched', 'Bank-only — add', 'Tally-only — check'];
    const m = new Map();
    for (const r of safeRows) {
      const k = r.reco_status || '—';
      m.set(k, (m.get(k) || 0) + 1);
    }
    const arr = [{ value: 'All', label: 'All', count: safeRows.length, color: '#0748EE' }];
    for (const name of order) {
      if (m.has(name)) arr.push({ value: name, label: name, count: m.get(name), color: recoStatusColor(name) });
    }
    return arr;
  }, [safeRows]);

  return (
    <div>
      <KpiHeader cards={cards} onDownload={onDownload} downloading={downloading} />

      {!embedded && <>
      <FilterChips chips={chips} filter={filter} setFilter={setFilter} />
      <MoreBanner shown={ROW_CAP} total={displayed.length} />

      {displayed.length === 0 ? <Empty /> : (
        <TableWrap minWidth="980px">
          <thead>
            <tr>
              <th style={TH}>Txn Date</th>
              <th style={TH}>Description</th>
              <th style={THr}>Debit</th>
              <th style={THr}>Credit</th>
              <th style={TH}>Ledger Name</th>
              <th style={TH}>Reco Status</th>
              <th style={TH}>Tally Party</th>
            </tr>
          </thead>
          <tbody>
            {capped.map(({ row: r, idx }, i) => (
              <tr key={idx} style={{ background: altBg(i) }}>
                <td style={TD}>{r.txn_date || '—'}</td>
                <td style={{ ...TD, maxWidth: '320px', whiteSpace: 'normal' }}>{r.description || '—'}</td>
                <td style={TDn}>{money(r.debit)}</td>
                <td style={TDn}>{money(r.credit)}</td>
                <td style={TD}>{r.ledger_name || '—'}</td>
                <td style={TD}><RecoStatusPill status={r.reco_status} /></td>
                <td style={TD}>{r.tally_party || '—'}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      </>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  GSTR-3B vs 2B
// ════════════════════════════════════════════════════════════════════════════
function Gst3b2bDashboard({ safeRows, capped, displayed, onDownload, downloading, embedded }) {
  const totalClaimed = useMemo(() => safeRows.reduce((s, r) => s + num(F.claimed(r)), 0), [safeRows]);
  const totalAvail = useMemo(() => safeRows.reduce((s, r) => s + num(F.available(r)), 0), [safeRows]);
  const netDiff = useMemo(() => safeRows.reduce((s, r) => s + num(F.diff(r)), 0), [safeRows]);

  const cards = [
    { label: 'ITC Lines', value: cnt(safeRows.length), color: '#0748EE', bg: '#E8EFFE' },
    { label: 'Total Claimed', value: money(totalClaimed), color: '#7C3AED', bg: '#F5F3FF' },
    { label: 'Total Available', value: money(totalAvail), color: '#0F766E', bg: '#ECFEFF' },
    { label: 'Net Difference', value: money(netDiff), color: netDiff > 0.5 ? '#059669' : netDiff < -0.5 ? '#E11D48' : '#64748B', bg: '#F8FAFC' },
  ];

  const barData = useMemo(() => safeRows.map((r) => ({
    name: String(F.itcType(r)).length > 14 ? String(F.itcType(r)).slice(0, 13) + '…' : String(F.itcType(r)),
    Claimed: num(F.claimed(r)),
    Available: num(F.available(r)),
  })), [safeRows]);

  const reasons = useMemo(() => distOf(safeRows, F.remark), [safeRows]);

  return (
    <div>
      <KpiHeader cards={cards} onDownload={onDownload} downloading={downloading} />

      {safeRows.length > 0 && (
        <ChartsRow>
          <ChartCard title="Claimed vs Available by ITC Type" height={220}>
            <BarChart data={barData} margin={CHART_MARGIN}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="name" tick={AXIS_TICK} interval={0} angle={-20} textAnchor="end" height={56} />
              <YAxis tick={AXIS_TICK} />
              <Tooltip formatter={(v) => money(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Claimed" fill="#7C3AED" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Available" fill="#0F766E" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartCard>
          {reasons.length > 0 && <ByReasons title="By Remark" data={reasons} />}
        </ChartsRow>
      )}

      {!embedded && <>
      <MoreBanner shown={ROW_CAP} total={displayed.length} />

      {displayed.length === 0 ? <Empty /> : (
        <TableWrap minWidth="760px">
          <thead>
            <tr>
              <th style={TH}>ITC Type</th>
              <th style={THr}>Claimed</th>
              <th style={THr}>Available</th>
              <th style={THr}>Difference</th>
              <th style={TH}>Remark</th>
            </tr>
          </thead>
          <tbody>
            {capped.map(({ row: r, idx }, i) => {
              const d = num(F.diff(r));
              const dColor = d > 0.5 ? '#059669' : d < -0.5 ? '#E11D48' : '#64748B';
              return (
                <tr key={idx} style={{ background: altBg(i) }}>
                  <td style={TD}>{F.itcType(r)}</td>
                  <td style={TDn}>{money(F.claimed(r))}</td>
                  <td style={TDn}>{money(F.available(r))}</td>
                  <td style={{ ...TDn, color: dColor, fontWeight: Math.abs(d) > 0.5 ? 700 : 400 }}>{money(F.diff(r))}</td>
                  <td style={{ ...TD, color: '#64748B', whiteSpace: 'normal', maxWidth: '260px' }}>{F.remark(r)}</td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      </>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  GSTR-3B TALLY ENTRY
// ════════════════════════════════════════════════════════════════════════════
function TallyDashboard({ safeRows, capped, displayed, onDownload, downloading, embedded }) {
  const dataRows = useMemo(() => safeRows.filter((r) => F.rowType(r) === 'data'), [safeRows]);
  const totalDebit = useMemo(() => dataRows.reduce((s, r) => s + num(F.debit(r)), 0), [dataRows]);
  const totalCredit = useMemo(() => dataRows.reduce((s, r) => s + num(F.credit(r)), 0), [dataRows]);

  const cards = [
    { label: 'Entries', value: cnt(dataRows.length), color: '#0748EE', bg: '#E8EFFE' },
    { label: 'Total Debit', value: money(totalDebit), color: '#7C3AED', bg: '#F5F3FF' },
    { label: 'Total Credit', value: money(totalCredit), color: '#0F766E', bg: '#ECFEFF' },
  ];

  return (
    <div>
      <KpiHeader cards={cards} onDownload={onDownload} downloading={downloading} />

      {dataRows.length > 0 && (
        <ChartsRow>
          <ChartCard title="Debit vs Credit" height={200}>
            <BarChart data={[{ name: 'Totals', Debit: totalDebit, Credit: totalCredit }]} margin={CHART_MARGIN}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="name" tick={AXIS_TICK} />
              <YAxis tick={AXIS_TICK} />
              <Tooltip formatter={(v) => money(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Debit" fill="#7C3AED" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Credit" fill="#0F766E" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartCard>
        </ChartsRow>
      )}

      {!embedded && <>
      <MoreBanner shown={ROW_CAP} total={displayed.length} />

      {displayed.length === 0 ? <Empty /> : (
        <TableWrap minWidth="680px">
          <thead>
            <tr>
              <th style={{ ...TH, width: '70px' }}>S.No</th>
              <th style={TH}>Particulars</th>
              <th style={THr}>Debit ₹</th>
              <th style={THr}>Credit ₹</th>
            </tr>
          </thead>
          <tbody>
            {capped.map(({ row: r, idx }, i) => {
              const isData = F.rowType(r) === 'data';
              if (!isData) {
                return (
                  <tr key={idx}>
                    <td colSpan={4} style={{
                      padding: '8px 12px', fontSize: '12px', fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      color: '#1F3864', background: '#EBF1FB', borderBottom: '1px solid #D7E3F5',
                    }}>
                      {F.particulars(r)}
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={idx} style={{ background: altBg(i) }}>
                  <td style={{ ...TD, textAlign: 'center' }}>{F.sno(r)}</td>
                  <td style={TD}>{F.particulars(r)}</td>
                  <td style={TDn}>{money(F.debit(r))}</td>
                  <td style={TDn}>{money(F.credit(r))}</td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      </>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  GENERIC FALLBACK (unknown agentType, incl. gstr_1_vs_books)
// ════════════════════════════════════════════════════════════════════════════
const SKIP_KEYS = new Set(['raw', 'raw_books', 'raw_gstr', 'gstr2b', 'purchase']);

function GenericDashboard({ safeRows, capped, displayed, onDownload, downloading, embedded, columns }) {
  const cards = [{ label: 'Total Rows', value: cnt(safeRows.length), color: '#0748EE', bg: '#E8EFFE' }];

  // Prefer an explicit column order when the caller has one (e.g. Receivable
  // Cycle passes its real MAIN_SHEET_COLUMNS/cod_columns list) — deriving the
  // order from Object.keys() is unreliable for any row whose keys include
  // array-index-looking strings ("2", "3", "4", ...): JavaScript forces those
  // to the front of any object's own-property order regardless of insertion
  // order, no matter what the source JSON or database preserved.
  const keys = useMemo(() => {
    if (Array.isArray(columns) && columns.length) {
      const present = new Set(safeRows.length ? Object.keys(safeRows[0]) : []);
      return columns.filter((k) => !SKIP_KEYS.has(k) && (present.size === 0 || present.has(k)));
    }
    if (safeRows.length === 0) return [];
    return Object.keys(safeRows[0]).filter((k) => !SKIP_KEYS.has(k));
  }, [safeRows, columns]);

  return (
    <div>
      <KpiHeader cards={cards} onDownload={onDownload} downloading={downloading} />
      {!embedded && <>
      <MoreBanner shown={ROW_CAP} total={displayed.length} />

      {displayed.length === 0 || keys.length === 0 ? <Empty /> : (
        <TableWrap minWidth={`${Math.max(600, keys.length * 130)}px`}>
          <thead>
            <tr>{keys.map((k) => <th key={k} style={TH}>{k.replace(/_/g, ' ')}</th>)}</tr>
          </thead>
          <tbody>
            {capped.map(({ row: r, idx }, i) => (
              <tr key={idx} style={{ background: altBg(i) }}>
                {keys.map((k) => {
                  const v = r[k];
                  const numeric = typeof v === 'number';
                  return (
                    <td key={k} style={numeric ? TDn : { ...TD, whiteSpace: 'normal', maxWidth: '240px' }}>
                      {v == null || v === '' ? '—' : numeric ? money(v) : String(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      </>}
    </div>
  );
}

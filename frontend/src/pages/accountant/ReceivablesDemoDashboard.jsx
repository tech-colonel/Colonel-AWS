/* ── Receivables Demo Dashboard (FAKE — demo only) ─────────────────────────────
   A parameterised clone of ZeptoReceivablesDashboard used for the Amazon and
   Shopify Receivables demo cards. NO backend, NO reco engine — it generates a
   deterministic fake dataset on the client and renders the exact same KPI tiles
   + aging pie + gaps bar + issue-ticket UI as the real Zepto dashboard.

   Local demo only. Not wired to /api/reco, not persisted, not on AWS.        */
import React, { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  ChevronDown, ChevronUp, Copy, Download, Check, AlertTriangle,
  ArrowLeft, LayoutDashboard, Bot, ClipboardList, Zap,
} from 'lucide-react';
import DashboardLayout from '../../components/layout/DashboardLayout';

// ── helpers ──────────────────────────────────────────────────────────────────
const num = (v) => { const n = Number(v); return Number.isNaN(n) ? 0 : n; };
const inr = (n) => '₹' + Math.round(num(n)).toLocaleString('en-IN');
const has = (v) => v != null && String(v).trim() !== '';

const PRIORITY = {
  HIGH:   { label: 'HIGH PRIORITY', bg: '#FEE2E2', fg: '#B91C1C' },
  MEDIUM: { label: 'MEDIUM',        bg: '#FEF3C7', fg: '#B45309' },
  INFO:   { label: 'ACTION NEEDED', bg: '#DBEAFE', fg: '#1D4ED8' },
};
const AGING_COLORS = { Overdue: '#DC2626', Due: '#D97706', 'Not Due': '#16A34A' };
const GAP_COLORS = ['#DC2626', '#D97706', '#2563EB'];

const GmailIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#4caf50" d="M45,16.2l-5,2.75l-5,4.75L35,40h7c1.657,0,3-1.343,3-3V16.2z" />
    <path fill="#1e88e5" d="M3,16.2l3.614,1.71L13,23.7V40H6c-1.657,0-3-1.343-3-3V16.2z" />
    <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
    <path fill="#c62828" d="M3,12.298V16.2l10,7.5V11.2L9.876,8.859C9.132,8.301,8.228,8,7.298,8h0C4.924,8,3,9.924,3,12.298z" />
    <path fill="#fbc02d" d="M45,12.298V16.2l-10,7.5V11.2l3.124-2.341C38.868,8.301,39.772,8,40.702,8h0C43.076,8,45,9.924,45,12.298z" />
  </svg>
);
const GmailChip = () => (
  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', borderRadius: 4, padding: 2 }}>
    <GmailIcon size={14} />
  </span>
);

// ── deterministic fake data ──────────────────────────────────────────────────
// Tiny seeded PRNG so the demo shows the SAME numbers on every load.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const pad = (n, w) => String(n).padStart(w, '0');
const fmtDate = (d) => `${pad(d.getDate(), 2)}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}-${d.getFullYear()}`;

// Generate a realistic receivables ledger for a marketplace. `terms` supplies
// the ID prefixes so Amazon and Shopify read differently.
function generateRows({ seed, count, terms, names }) {
  const rng = makeRng(seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const today = new Date(2026, 7, 7); // 07-Aug-2026, fixed for a stable demo
  const rows = [];
  for (let i = 0; i < count; i++) {
    const r = rng();
    const paid = r < 0.55;
    // aging skew: more overdue among the unpaid to make the demo interesting
    const dr = rng();
    const due_status = paid ? 'Not Due' : dr < 0.5 ? 'Overdue' : dr < 0.8 ? 'Due' : 'Not Due';

    // data gaps — a minority of rows miss a PO / GRN / POD
    const g = rng();
    const missPO  = g < 0.10;
    const missGRN = !missPO && g < 0.24;
    const missPOD = g >= 0.24 && g < 0.42;

    const invDate = new Date(today); invDate.setDate(today.getDate() - Math.floor(rng() * 75) - 5);
    const dueDate = new Date(invDate); dueDate.setDate(invDate.getDate() + 30);
    const amount = Math.round((4000 + rng() * 196000) / 100) * 100;

    rows.push({
      invoice_number: `${terms.invPfx}-${1000 + i}`,
      po:        missPO  ? '' : `${terms.poPfx}${pad(70000 + Math.floor(rng() * 9999), 5)}`,
      grn_no:    missGRN ? '' : `${terms.grnPfx}${pad(50000 + Math.floor(rng() * 9999), 5)}`,
      pod_no:    missPOD ? '' : `${terms.podPfx}${pad(80000 + Math.floor(rng() * 9999), 5)}`,
      name:      pick(names),
      date:      fmtDate(invDate),
      due_date:  fmtDate(dueDate),
      status:    paid ? 'Paid' : 'Not Paid',
      due_status,
      net_outstanding: paid ? 0 : amount,
    });
  }
  return rows;
}

// ── ticket builders (parameterised by marketplace terminology) ───────────────
function tableToText(cols, data) {
  const w = cols.map((c) => Math.max(String(c).length, ...data.map((row) => String(row[c] ?? '').length)));
  const padc = (s, i) => { s = String(s ?? ''); return s + ' '.repeat(Math.max(0, w[i] - s.length)); };
  const line = (cells) => cells.map((v, i) => padc(v, i)).join('  |  ');
  const sep = w.map((x) => '-'.repeat(x)).join('--+--');
  return [line(cols), sep, ...data.map((row) => line(cols.map((c) => row[c])))].join('\n');
}

function buildTickets(rows, T) {
  const notPaid = rows.filter((r) => r.status === 'Not Paid');
  const overdue = (r) => r.due_status === 'Overdue';
  const realGrn = (r) => has(r.grn_no);
  const hasPod = (r) => has(r.pod_no);
  const hasPo  = (r) => has(r.po);
  const sumNet = (arr) => Math.round(arr.reduce((a, r) => a + num(r.net_outstanding), 0));
  const tickets = [];

  const chase = notPaid.filter((r) => overdue(r) && realGrn(r) && hasPod(r));
  if (chase.length) {
    const cols = ['Invoice', T.po, T.grn, T.pod, 'Due Date', 'Amount'];
    const data = chase.map((r) => ({
      Invoice: r.invoice_number, [T.po]: r.po, [T.grn]: r.grn_no, [T.pod]: r.pod_no,
      'Due Date': r.due_date, Amount: inr(r.net_outstanding),
    }));
    const total = sumNet(chase);
    tickets.push({
      id: 'chase', priority: 'HIGH', amount: total, count: chase.length,
      title: `${chase.length} overdue invoices to collect — fully documented`,
      desc: `These ${T.marketplace} receivables are overdue and fully documented (${T.grn} + ${T.pod} on record). They are ready to chase for payment. Total outstanding ${inr(total)}.`,
      cols, data,
      subject: `Payment reminder — ${chase.length} overdue ${T.marketplace} invoices (${inr(total)})`,
      body:
        `Dear ${T.teamName},\n\n` +
        `The following ${chase.length} invoices are overdue for payment. All are fully documented ` +
        `(${T.grn} and ${T.pod} on record). We request settlement at the earliest.\n\n` +
        tableToText(cols, data) +
        `\n\nTotal outstanding: ${inr(total)}\n\nRegards,\nAccounts Team`,
    });
  }

  const missingPO = rows.filter((r) => !hasPo(r));
  if (missingPO.length) {
    const cols = ['Invoice', 'Name', 'Invoice Date', 'Amount'];
    const data = missingPO.map((r) => ({
      Invoice: r.invoice_number, Name: r.name, 'Invoice Date': r.date, Amount: inr(r.net_outstanding),
    }));
    tickets.push({
      id: 'missing_po', priority: 'HIGH', amount: sumNet(missingPO), count: missingPO.length,
      title: `${missingPO.length} invoices with NO ${T.po}`,
      desc: `No ${T.po} is mapped for these invoices, so they cannot be tracked to ${T.grn}/${T.pod} or collected. Add / confirm the ${T.po} numbers.`,
      cols, data,
      subject: `${missingPO.length} ${T.marketplace} invoices without a ${T.po}`,
      body:
        `Team,\n\nThe following ${missingPO.length} invoices have NO ${T.po} mapped. ` +
        `Please add / confirm them so they can be reconciled and collected:\n\n` +
        tableToText(cols, data) + `\n\nRegards,\nAccounts Team`,
    });
  }

  const missingGRN = rows.filter((r) => hasPo(r) && !realGrn(r));
  if (missingGRN.length) {
    const cols = ['Invoice', T.po, 'Name', 'Amount'];
    const data = missingGRN.map((r) => ({
      Invoice: r.invoice_number, [T.po]: r.po, Name: r.name, Amount: inr(r.net_outstanding),
    }));
    tickets.push({
      id: 'missing_grn', priority: 'MEDIUM', amount: sumNet(missingGRN), count: missingGRN.length,
      title: `${missingGRN.length} invoices with a ${T.po} but NO ${T.grn}`,
      desc: `A ${T.po} exists but no ${T.grn} was found. Ask ${T.marketplace} to share the ${T.grn} for these orders.`,
      cols, data,
      subject: `${missingGRN.length} ${T.marketplace} orders without a ${T.grn}`,
      body:
        `Dear ${T.teamName},\n\nThe following ${missingGRN.length} orders have a ${T.po} but no ${T.grn} ` +
        `on record. Please share the ${T.grn} for each:\n\n` +
        tableToText(cols, data) + `\n\nRegards,\nAccounts Team`,
    });
  }

  const missingPOD = rows.filter((r) => !hasPod(r));
  if (missingPOD.length) {
    const cols = ['Invoice', T.po, 'Name', 'Amount'];
    const data = missingPOD.map((r) => ({
      Invoice: r.invoice_number, [T.po]: r.po, Name: r.name, Amount: inr(r.net_outstanding),
    }));
    tickets.push({
      id: 'missing_pod', priority: 'MEDIUM', amount: sumNet(missingPOD), count: missingPOD.length,
      title: `${missingPOD.length} invoices with NO ${T.pod}`,
      desc: `No ${T.pod} (proof of settlement) is on record for these invoices. Get it from ${T.marketplace} so overdue amounts can be chased with proof.`,
      cols, data,
      subject: `${missingPOD.length} ${T.marketplace} invoices without a ${T.pod}`,
      body:
        `Team,\n\nThe following ${missingPOD.length} invoices have no ${T.pod} on record:\n\n` +
        tableToText(cols, data) + `\n\nRegards,\nAccounts Team`,
    });
  }

  return tickets;
}

function analyze(rows, T) {
  const notPaid = rows.filter((r) => r.status === 'Not Paid');
  const sumNet = (arr) => Math.round(arr.reduce((a, r) => a + num(r.net_outstanding), 0));
  const hasPo = (r) => has(r.po), realGrn = (r) => has(r.grn_no), hasPod = (r) => has(r.pod_no);

  const aging = ['Overdue', 'Due', 'Not Due'].map((b) => ({
    name: b, value: Math.max(0, sumNet(notPaid.filter((r) => r.due_status === b))),
  })).filter((d) => d.value > 0);

  const gaps = [
    { name: `Missing ${T.po}`,  value: rows.filter((r) => !hasPo(r)).length },
    { name: `Missing ${T.grn}`, value: rows.filter((r) => hasPo(r) && !realGrn(r)).length },
    { name: `Missing ${T.pod}`, value: rows.filter((r) => !hasPod(r)).length },
  ];

  const tiles = {
    total: rows.length,
    paid: rows.filter((r) => r.status === 'Paid').length,
    toCollect: sumNet(notPaid),
    overdue: sumNet(notPaid.filter((r) => r.due_status === 'Overdue')),
    gaps: rows.filter((r) => !hasPo(r) || (hasPo(r) && !realGrn(r)) || !hasPod(r)).length,
  };

  return { tiles, aging, gaps, tickets: buildTickets(rows, T) };
}

// ── small UI atoms ───────────────────────────────────────────────────────────
function Tile({ label, value, accent }) {
  return (
    <div style={{
      flex: '1 1 150px', background: 'var(--card-bg, #fff)', border: '1.5px solid var(--card-border, #E2E8F6)',
      borderRadius: 12, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'Barlow', color: accent || 'var(--text-heading, #0F172A)' }}>{value}</div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-muted, #64748B)', fontFamily: 'DM Sans', marginTop: 2 }}>{label}</div>
    </div>
  );
}

function openTeamMail(subject, body) {
  const full = `Subject: ${subject}\n\n${body}`;
  try { navigator.clipboard?.writeText(full)?.catch(() => {}); } catch (_) {}
  const MAX = 1000;
  let b = body;
  if (b.length > MAX) {
    const cut = b.slice(0, MAX);
    b = cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0)) +
      '\n\n…(the full list is copied to your clipboard — press Cmd/Ctrl+V to paste it in)';
  }
  const url = 'https://mail.google.com/mail/?view=cm&fs=1&su=' +
    encodeURIComponent(subject) + '&body=' + encodeURIComponent(b);
  window.open(url, '_blank', 'noopener');
}

function downloadCsv(name, cols, data) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...data.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

function TicketCard({ t }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const p = PRIORITY[t.priority] || PRIORITY.INFO;
  const template = `Subject: ${t.subject}\n\n${t.body}`;
  const btn = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8,
    fontSize: 12, fontWeight: 700, fontFamily: 'Barlow', cursor: 'pointer', border: '1.5px solid var(--card-border, #E2E8F6)',
    background: 'var(--card-bg, #fff)', color: 'var(--text-body, #334155)',
  };

  return (
    <div style={{ border: '1.5px solid var(--card-border, #E2E8F6)', borderRadius: 12, background: 'var(--card-bg, #fff)', overflow: 'hidden' }}>
      <button onClick={() => setOpen((o) => !o)} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px',
        background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
      }}>
        <span style={{ fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 20, background: p.bg, color: p.fg, whiteSpace: 'nowrap', fontFamily: 'DM Sans' }}>{p.label}</span>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 700, fontFamily: 'Barlow', color: 'var(--text-heading, #0F172A)' }}>{t.title}</span>
        <span style={{ fontSize: 14, fontWeight: 800, fontFamily: 'Barlow', color: '#16A34A' }}>{inr(t.amount)}</span>
        {open ? <ChevronUp style={{ width: 16, height: 16, color: 'var(--text-muted, #64748B)' }} />
              : <ChevronDown style={{ width: 16, height: 16, color: 'var(--text-muted, #64748B)' }} />}
      </button>

      {open && (
        <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-body, #475569)' }}>{t.desc}</div>

          <div style={{ border: '1px solid var(--card-border, #E2E8F6)', borderRadius: 8, maxHeight: 220, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ position: 'sticky', top: 0, background: 'var(--page-bg, #F8FAFC)' }}>
                  {t.cols.map((c) => (
                    <th key={c} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted, #64748B)', whiteSpace: 'nowrap', borderBottom: '1.5px solid var(--card-border, #E2E8F6)' }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.data.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--card-border, #EEF2F9)' }}>
                    {t.cols.map((c) => (
                      <td key={c} style={{ padding: '7px 12px', fontFamily: 'monospace', color: 'var(--text-body, #334155)', whiteSpace: 'nowrap' }}>{r[c]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted, #64748B)', marginBottom: 6, fontFamily: 'DM Sans' }}>Ticket template</div>
            <pre style={{ margin: 0, padding: 12, background: 'var(--page-bg, #F8FAFC)', border: '1px solid var(--card-border, #E2E8F6)', borderRadius: 8, fontSize: 12, lineHeight: 1.55, color: 'var(--text-body, #334155)', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', fontFamily: 'ui-monospace, monospace' }}>{template}</pre>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button style={btn} onClick={() => { navigator.clipboard.writeText(template); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? <Check style={{ width: 14, height: 14, color: '#16A34A' }} /> : <Copy style={{ width: 14, height: 14 }} />}
              {copied ? 'Copied' : 'Copy template'}
            </button>
            <button style={btn} onClick={() => downloadCsv(`${t.id}.csv`, t.cols, t.data)}>
              <Download style={{ width: 14, height: 14 }} /> Download ({t.count})
            </button>
            <button style={{ ...btn, background: '#0748EE', color: '#fff', border: 'none' }} onClick={() => openTeamMail(t.subject, t.body)}>
              <GmailChip /> Email team
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Legend2({ items }) {
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
      {items.map((it) => (
        <span key={it.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-body, #475569)', fontFamily: 'DM Sans' }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: it.color }} />
          {it.name} <b style={{ fontFamily: 'Barlow' }}>{it.value}</b>
        </span>
      ))}
    </div>
  );
}

function Empty() {
  return <div style={{ height: 210, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--text-muted, #94A3B8)' }}>Nothing outstanding 🎉</div>;
}

// ── page ─────────────────────────────────────────────────────────────────────
// config = { marketplace, icon, accent, gradient, seed, count, terms, names }
export default function ReceivablesDemoDashboard({ config }) {
  const { brandId } = useParams();
  const navigate = useNavigate();

  const rows = useMemo(
    () => generateRows({ seed: config.seed, count: config.count, terms: config.terms, names: config.names }),
    [config],
  );
  const { tiles, aging, gaps, tickets } = useMemo(() => analyze(rows, config.terms), [rows, config.terms]);
  const highCount = tickets.filter((t) => t.priority === 'HIGH').length;

  const sidebarItems = [
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
    { path: `/brands/${brandId}/reco`, label: 'Reconciliation', icon: ClipboardList, testId: 'nav-reco' },
  ];

  const card = { background: 'var(--card-bg, #fff)', border: '1.5px solid var(--card-border, #E2E8F6)', borderRadius: 14, padding: 16 };
  const chartTitle = { fontSize: 12, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-muted, #64748B)', fontFamily: 'DM Sans', marginBottom: 10 };

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6 max-w-7xl">
        <button onClick={() => navigate(`/brands/${brandId}/reco`)}
          className="flex items-center gap-1.5 text-sm mb-6 group transition-colors hover:text-blue-600"
          style={{ color: '#64748B' }}>
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
          Reconciliation Suite
        </button>

        {/* Hero */}
        <div className="mb-6" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, background: `${config.accent}18`, border: `1px solid ${config.accent}44` }}>
            {config.icon}
          </div>
          <div>
            <h1 className="text-2xl font-black" style={{ color: '#0F172A', fontFamily: 'Barlow', letterSpacing: '-0.02em' }}>
              {config.marketplace}{' '}
              <span style={{ background: config.gradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>Receivables</span>
            </h1>
            <p className="text-xs" style={{ color: '#64748B' }}>
              Track {config.marketplace} settlements, chase overdue receivables, raise issue tickets.
            </p>
          </div>
          <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full"
            style={{ background: '#FEF3C7', color: '#B45309', border: '1px solid #FDE68A' }}>
            <Zap className="w-3 h-3" /> Demo data
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* KPI tiles */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Tile label="Total invoices" value={tiles.total} />
            <Tile label="Paid" value={tiles.paid} accent="#16A34A" />
            <Tile label="To collect" value={inr(tiles.toCollect)} accent="#0748EE" />
            <Tile label="Overdue" value={inr(tiles.overdue)} accent="#DC2626" />
            <Tile label="Data gaps" value={tiles.gaps} accent={tiles.gaps ? '#D97706' : '#16A34A'} />
          </div>

          {/* Charts */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ ...card, flex: '1 1 300px', minWidth: 280 }}>
              <div style={chartTitle}>Unpaid receivables by aging</div>
              {aging.length ? (
                <ResponsiveContainer width="100%" height={210}>
                  <PieChart>
                    <Pie data={aging} dataKey="value" nameKey="name" innerRadius={52} outerRadius={80} paddingAngle={2}>
                      {aging.map((d) => <Cell key={d.name} fill={AGING_COLORS[d.name]} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [inr(v), n]} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <Empty />}
              <Legend2 items={aging.map((d) => ({ name: d.name, color: AGING_COLORS[d.name], value: inr(d.value) }))} />
            </div>

            <div style={{ ...card, flex: '1 1 300px', minWidth: 280 }}>
              <div style={chartTitle}>Data completeness gaps (invoices)</div>
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={gaps} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--text-muted, #64748B)' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-muted, #64748B)' }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: 'rgba(0,0,0,.04)' }} />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                    {gaps.map((d, i) => <Cell key={d.name} fill={GAP_COLORS[i]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Issues / tickets */}
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <AlertTriangle style={{ width: 16, height: 16, color: '#D97706' }} />
              <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'Barlow', color: 'var(--text-heading, #0F172A)' }}>Issues to raise</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted, #64748B)', fontFamily: 'DM Sans' }}>
                {tickets.length} total · {highCount} high priority
              </span>
            </div>
            {tickets.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {tickets.map((t) => <TicketCard key={t.id} t={t} />)}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#16A34A', fontWeight: 600 }}>No issues — every invoice is fully documented. 🎉</div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

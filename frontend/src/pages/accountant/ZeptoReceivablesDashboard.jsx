import React, { useMemo, useState } from 'react';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { ChevronDown, ChevronUp, Copy, Download, Check, AlertTriangle } from 'lucide-react';

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

// Solid envelope — reads as a real mail icon on the (blue) Email-team button.
const MailSolid = ({ size = 15, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
    <path d="M3.5 4h17A1.5 1.5 0 0 1 22 5.5v.35l-10 6.02L2 5.85V5.5A1.5 1.5 0 0 1 3.5 4Z" />
    <path d="M22 8.18l-9.48 5.71a1 1 0 0 1-1.04 0L2 8.18V18.5A1.5 1.5 0 0 0 3.5 20h17a1.5 1.5 0 0 0 1.5-1.5V8.18Z" />
  </svg>
);

// ── ticket builders (real, enumerated data — never just a count) ─────────────
// Renders a fixed-width table: every column padded to its widest cell so the
// "|" separators line up perfectly in the monospace template (no ragged edges).
function tableToText(cols, data) {
  const w = cols.map((c) => Math.max(String(c).length, ...data.map((r) => String(r[c] ?? '').length)));
  const pad = (s, i) => { s = String(s ?? ''); return s + ' '.repeat(Math.max(0, w[i] - s.length)); };
  const line = (cells) => cells.map((v, i) => pad(v, i)).join('  |  ');
  const sep = w.map((x) => '-'.repeat(x)).join('--+--');
  return [line(cols), sep, ...data.map((r) => line(cols.map((c) => r[c])))].join('\n');
}

function buildTickets(rows) {
  const notPaid = rows.filter((r) => r.status === 'Not Paid');
  const overdue = (r) => r.due_status === 'Overdue';
  const realGrn = (r) => has(r.grn_no);
  const hasPod = (r) => has(r.pod_no);
  const hasPo  = (r) => has(r.po);
  const sumNet = (arr) => Math.round(arr.reduce((a, r) => a + num(r.net_outstanding), 0));

  const tickets = [];

  // 1) Overdue receivables to collect — delivered (GRN) + proof (POD) on record.
  const chase = notPaid.filter((r) => overdue(r) && realGrn(r) && hasPod(r));
  if (chase.length) {
    const cols = ['Invoice', 'PO', 'GRN No', 'POD No', 'Due Date', 'Amount'];
    const data = chase.map((r) => ({
      Invoice: r.invoice_number, PO: r.po, 'GRN No': r.grn_no, 'POD No': r.pod_no,
      'Due Date': r.due_date, Amount: inr(r.net_outstanding),
    }));
    const total = sumNet(chase);
    tickets.push({
      id: 'chase', priority: 'HIGH', amount: total, count: chase.length,
      title: `${chase.length} overdue invoices to collect — delivered, GRN + POD on record`,
      desc: `These invoices are overdue and fully documented (GRN generated, proof of delivery on record). They are ready to chase for payment. Total outstanding ${inr(total)}.`,
      cols, data,
      subject: `Payment reminder — ${chase.length} overdue Zepto invoices (${inr(total)})`,
      body:
        `Dear Zepto Payments Team,\n\n` +
        `The following ${chase.length} invoices are overdue for payment. All have been delivered ` +
        `(GRN generated) with proof of delivery on record. We request settlement at the earliest.\n\n` +
        tableToText(cols, data) +
        `\n\nTotal outstanding: ${inr(total)}\n\nRegards,\nAccounts Team`,
    });
  }

  // 2) Invoices with NO PO.
  const missingPO = rows.filter((r) => !hasPo(r));
  if (missingPO.length) {
    const cols = ['Invoice', 'Name', 'Invoice Date', 'Amount'];
    const data = missingPO.map((r) => ({
      Invoice: r.invoice_number, Name: r.name, 'Invoice Date': r.date, Amount: inr(r.net_outstanding),
    }));
    tickets.push({
      id: 'missing_po', priority: 'HIGH', amount: sumNet(missingPO), count: missingPO.length,
      title: `${missingPO.length} invoices with NO PO`,
      desc: `No PO is mapped in the Zepto Payment track for these invoices, so they cannot be tracked to GRN/POD or collected. Add / confirm the PO numbers.`,
      cols, data,
      subject: `${missingPO.length} Zepto invoices without a PO number`,
      body:
        `Team,\n\nThe following ${missingPO.length} invoices have NO PO mapped in the Zepto Payment track. ` +
        `Please add / confirm the PO numbers so they can be reconciled and collected:\n\n` +
        tableToText(cols, data) + `\n\nRegards,\nAccounts Team`,
    });
  }

  // 3) PO raised but NO GRN.
  const missingGRN = rows.filter((r) => hasPo(r) && !realGrn(r));
  if (missingGRN.length) {
    const cols = ['Invoice', 'PO', 'Name', 'Amount'];
    const data = missingGRN.map((r) => ({
      Invoice: r.invoice_number, PO: r.po, Name: r.name, Amount: inr(r.net_outstanding),
    }));
    tickets.push({
      id: 'missing_grn', priority: 'MEDIUM', amount: sumNet(missingGRN), count: missingGRN.length,
      title: `${missingGRN.length} invoices with a PO but NO GRN`,
      desc: `A PO exists but no GRN was found in the GRN_List or the Payment track. Ask Zepto to share the GrnCode (goods receipt) for these POs.`,
      cols, data,
      subject: `${missingGRN.length} Zepto POs without a GRN`,
      body:
        `Dear Zepto Team,\n\nThe following ${missingGRN.length} POs have been raised but we have no GRN ` +
        `(goods receipt) on record. Please share the GrnCode for each:\n\n` +
        tableToText(cols, data) + `\n\nRegards,\nAccounts Team`,
    });
  }

  // 4) No POD / tracking.
  const missingPOD = rows.filter((r) => !hasPod(r));
  if (missingPOD.length) {
    const cols = ['Invoice', 'PO', 'Name', 'Amount'];
    const data = missingPOD.map((r) => ({
      Invoice: r.invoice_number, PO: r.po, Name: r.name, Amount: inr(r.net_outstanding),
    }));
    tickets.push({
      id: 'missing_pod', priority: 'MEDIUM', amount: sumNet(missingPOD), count: missingPOD.length,
      title: `${missingPOD.length} invoices with NO POD / tracking number`,
      desc: `No LRN / POD (proof of delivery) is on record for these invoices. Get the tracking number from the courier so overdue amounts can be chased with proof.`,
      cols, data,
      subject: `${missingPOD.length} Zepto invoices without a POD`,
      body:
        `Team,\n\nThe following ${missingPOD.length} invoices have no POD / tracking number on record:\n\n` +
        tableToText(cols, data) + `\n\nRegards,\nAccounts Team`,
    });
  }

  return tickets;
}

function analyze(rows) {
  const notPaid = rows.filter((r) => r.status === 'Not Paid');
  const sumNet = (arr) => Math.round(arr.reduce((a, r) => a + num(r.net_outstanding), 0));
  const hasPo = (r) => has(r.po), realGrn = (r) => has(r.grn_no), hasPod = (r) => has(r.pod_no);

  const aging = ['Overdue', 'Due', 'Not Due'].map((b) => ({
    name: b,
    value: Math.max(0, sumNet(notPaid.filter((r) => r.due_status === b))),
  })).filter((d) => d.value > 0);

  const gaps = [
    { name: 'Missing PO', value: rows.filter((r) => !hasPo(r)).length },
    { name: 'Missing GRN', value: rows.filter((r) => hasPo(r) && !realGrn(r)).length },
    { name: 'Missing POD', value: rows.filter((r) => !hasPod(r)).length },
  ];

  const tiles = {
    total: rows.length,
    paid: rows.filter((r) => r.status === 'Paid').length,
    toCollect: sumNet(notPaid),
    overdue: sumNet(notPaid.filter((r) => r.due_status === 'Overdue')),
    gaps: rows.filter((r) => !hasPo(r) || (hasPo(r) && !realGrn(r)) || !hasPod(r)).length,
  };

  return { tiles, aging, gaps, tickets: buildTickets(rows) };
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
  // Opens a fresh Gmail compose (team account the user is signed into) with the
  // subject + body pre-filled. No personal recipient hard-coded — the user adds
  // the team / Zepto address before sending.
  //
  // Gmail's compose URL caps out around ~2 KB, so a long enumerated body (e.g.
  // 200+ invoices) overflows it and Gmail returns HTTP 400. So we ALWAYS copy
  // the complete subject+body to the clipboard, and put only a URL-safe slice
  // (trimmed on a line boundary) in the compose — with a note to paste the rest.
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

          {/* Affected rows — small, scrollable, real data */}
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

          {/* Ticket template */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted, #64748B)', marginBottom: 6, fontFamily: 'DM Sans' }}>Ticket template</div>
            <pre style={{ margin: 0, padding: 12, background: 'var(--page-bg, #F8FAFC)', border: '1px solid var(--card-border, #E2E8F6)', borderRadius: 8, fontSize: 12, lineHeight: 1.55, color: 'var(--text-body, #334155)', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', fontFamily: 'ui-monospace, monospace' }}>{template}</pre>
          </div>

          {/* Actions: Copy · Download · Email team */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button style={btn} onClick={() => { navigator.clipboard.writeText(template); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? <Check style={{ width: 14, height: 14, color: '#16A34A' }} /> : <Copy style={{ width: 14, height: 14 }} />}
              {copied ? 'Copied' : 'Copy template'}
            </button>
            <button style={btn} onClick={() => downloadCsv(`${t.id}.csv`, t.cols, t.data)}>
              <Download style={{ width: 14, height: 14 }} /> Download ({t.count})
            </button>
            <button style={{ ...btn, background: '#0748EE', color: '#fff', border: 'none' }} onClick={() => openTeamMail(t.subject, t.body)}>
              <MailSolid size={15} color="#fff" /> Email team
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── main ─────────────────────────────────────────────────────────────────────
export default function ZeptoReceivablesDashboard({ result }) {
  const rows = result?.results || [];
  const { tiles, aging, gaps, tickets } = useMemo(() => analyze(rows), [rows]);
  if (!rows.length) return null;
  const highCount = tickets.filter((t) => t.priority === 'HIGH').length;

  const card = { background: 'var(--card-bg, #fff)', border: '1.5px solid var(--card-border, #E2E8F6)', borderRadius: 14, padding: 16 };
  const chartTitle = { fontSize: 12, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-muted, #64748B)', fontFamily: 'DM Sans', marginBottom: 10 };

  return (
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
          <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'Barlow', color: 'var(--text-heading, #0F172A)' }}>
            Issues to raise
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted, #64748B)', fontFamily: 'DM Sans' }}>
            {tickets.length} total · {highCount} high priority
          </span>
        </div>
        {tickets.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {tickets.map((t) => <TicketCard key={t.id} t={t} />)}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: '#16A34A', fontWeight: 600 }}>No issues — every invoice has a PO, GRN and POD. 🎉</div>
        )}
      </div>
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

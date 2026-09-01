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

// Real Gmail logo (opens a Gmail compose). Colourful envelope, so it sits on a
// small white chip to read cleanly on the blue Email-team button.
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

function buildTickets(rows, rejectedAdvices = []) {
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

  // 5) Payment advices excluded (header total didn't reconcile within tolerance).
  // These are NOT in any figure above — flag so the accountant can reshare/fix.
  if (rejectedAdvices && rejectedAdvices.length) {
    const cols = ['Payment Advice No', 'Doc No', 'Payment Date', 'Header Total', 'Extracted', 'Difference'];
    const data = rejectedAdvices.map((r) => ({
      'Payment Advice No': r.advice_no || '', 'Doc No': r.doc || '',
      'Payment Date': r.payment_date || '', 'Header Total': inr(r.header_total),
      Extracted: inr(r.extracted), Difference: inr(r.diff),
    }));
    const total = Math.round(rejectedAdvices.reduce((a, r) => a + num(r.header_total), 0));
    tickets.push({
      id: 'rejected_advices', priority: 'HIGH', amount: total, count: rejectedAdvices.length,
      title: `${rejectedAdvices.length} payment advice${rejectedAdvices.length > 1 ? 's' : ''} EXCLUDED — total didn't reconcile`,
      desc: `The line items in these payment-advice PDFs don't add up to the advice's own header total (beyond the ₹100 tolerance), so they were left OUT of every figure to avoid a false total. Reshare / check these advices with Zepto.`,
      cols, data,
      subject: `${rejectedAdvices.length} Zepto payment advice(s) not reconciling`,
      body:
        `Dear Zepto Payments Team,\n\nThe following payment advice(s) do not reconcile — the line items do ` +
        `not sum to the advice's stated total. Please re-share the corrected advice(s):\n\n` +
        tableToText(cols, data) + `\n\nRegards,\nAccounts Team`,
    });
  }

  return tickets;
}

function analyze(rows, rejectedAdvices = []) {
  const notPaid = rows.filter((r) => r.status === 'Not Paid');
  const sumNet = (arr) => Math.round(arr.reduce((a, r) => a + num(r.net_outstanding), 0));
  const hasPo = (r) => has(r.po), realGrn = (r) => has(r.grn_no), hasPod = (r) => has(r.pod_no);
  const hasGrnDate = (r) => has(r.grn_date);

  const aging = ['Overdue', 'Due', 'Not Due'].map((b) => ({
    name: b,
    value: Math.max(0, sumNet(notPaid.filter((r) => r.due_status === b))),
  })).filter((d) => d.value > 0);

  // Excess Paid = invoices settled with MORE than owed (Zepto overpaid): net < 0.
  // Negative, so it can't be a pie slice — shown as its own tile + legend line.
  const excessPaid = sumNet(rows.filter((r) => r.due_status === 'Excess Paid'));

  // Data completeness gaps counted on UNPAID (collectible) invoices only — a
  // missing document on an already-paid invoice is moot. This keeps the number
  // actionable instead of being dominated by settled invoices.
  const gapRow = (r) => !hasPo(r) || (hasPo(r) && !realGrn(r)) || (realGrn(r) && !hasGrnDate(r)) || !hasPod(r);
  const gaps = [
    { name: 'Missing PO', value: notPaid.filter((r) => !hasPo(r)).length },
    { name: 'Missing GRN', value: notPaid.filter((r) => hasPo(r) && !realGrn(r)).length },
    { name: 'Missing GRN Date', value: notPaid.filter((r) => realGrn(r) && !hasGrnDate(r)).length },
    { name: 'Missing POD', value: notPaid.filter((r) => !hasPod(r)).length },
  ];

  const tiles = {
    total: rows.length,
    paid: rows.filter((r) => r.status === 'Paid').length,
    // "To collect" = NET receivable (= Excel Net Receivables): nets the overpaid
    // (Excess Paid) invoices, so it no longer over-states by ignoring them.
    toCollect: sumNet(rows),
    overdue: sumNet(notPaid.filter((r) => r.due_status === 'Overdue')),
    excessPaid,
    gaps: notPaid.filter(gapRow).length,
  };

  // Data quality: % of UNPAID invoices that are fully documented (PO+GRN+POD).
  const fullyDoc = notPaid.filter((r) => hasPo(r) && realGrn(r) && hasPod(r)).length;
  const dataQuality = notPaid.length ? Math.round((fullyDoc / notPaid.length) * 100) : 100;

  // Collections forecast: unpaid invoices becoming due in the next 7 / 30 days
  // (Due Date = GRN Date + 30). Overdue (already past) excluded here.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dueWithin = (days) => {
    let count = 0, amount = 0;
    for (const r of notPaid) {
      const d = r.due_date ? new Date(r.due_date) : null;
      if (!d || isNaN(d)) continue;
      const diff = Math.round((d - today) / 86400000);
      if (diff >= 0 && diff <= days) { count += 1; amount += num(r.net_outstanding); }
    }
    return { count, amount: Math.round(amount) };
  };
  const forecast = { next7: dueWithin(7), next30: dueWithin(30) };

  // Receivables by month (collectible / unpaid net, chronological) — from the
  // Month column, sorted oldest-first.
  const byMonth = {};
  for (const r of notPaid) {
    const m = r.month || '—';
    byMonth[m] = (byMonth[m] || 0) + num(r.net_outstanding);
  }
  const monthWise = Object.entries(byMonth)
    .map(([name, v]) => ({ name, value: Math.round(v) }))
    .filter((d) => d.name !== '—')
    .sort((a, b) => new Date('1 ' + a.name.replace('-', ' ')) - new Date('1 ' + b.name.replace('-', ' ')));

  return {
    tiles, aging, gaps, dataQuality, forecast, monthWise,
    tickets: buildTickets(rows, rejectedAdvices),
  };
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

// One step in the money-flow strip.
function FlowStep({ label, value, accent, strong }) {
  return (
    <div style={{ padding: '2px 6px' }}>
      <div style={{ fontSize: strong ? 19 : 16, fontWeight: strong ? 800 : 700, fontFamily: 'Barlow', color: accent || 'var(--text-heading, #0F172A)' }}>{value}</div>
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted, #64748B)', fontFamily: 'DM Sans', marginTop: 1 }}>{label}</div>
    </div>
  );
}
function FlowArrow({ sub }) {
  return (
    <div style={{ textAlign: 'center', color: 'var(--text-muted, #94A3B8)', padding: '0 2px' }}>
      <div style={{ fontSize: 16, lineHeight: 1 }}>→</div>
      {sub && <div style={{ fontSize: 9, fontFamily: 'DM Sans', marginTop: 1 }}>{sub}</div>}
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
              <GmailChip /> Email team
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
  const rejectedAdvices = result?.rejected_advices || [];
  const unknownTypes = result?.unknown_types || [];
  const summary = result?.summary || {};
  const { tiles, aging, gaps, dataQuality, forecast, monthWise, tickets } =
    useMemo(() => analyze(rows, rejectedAdvices), [rows, rejectedAdvices]);
  if (!rows.length) return null;
  const highCount = tickets.filter((t) => t.priority === 'HIGH').length;
  const hasMoney = summary.net_receivables !== undefined;

  const card = { background: 'var(--card-bg, #fff)', border: '1.5px solid var(--card-border, #E2E8F6)', borderRadius: 14, padding: 16 };
  const chartTitle = { fontSize: 12, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-muted, #64748B)', fontFamily: 'DM Sans', marginBottom: 10 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* New payment-advice document type detected (catch-all) — review its treatment */}
      {unknownTypes.length > 0 && (
        <div style={{
          background: '#FEF3C7', border: '1.5px solid #FCD34D', borderRadius: 12,
          padding: '10px 14px', color: '#92400E', fontSize: 13, fontFamily: 'DM Sans', fontWeight: 600,
        }}>
          ⚠ New payment-advice document type{unknownTypes.length > 1 ? 's' : ''} seen: {unknownTypes.join(', ')}.
          These were routed to Adjustments (not dropped) — review how they should be treated.
        </div>
      )}
      {/* KPI tiles */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Tile label="Total invoices" value={tiles.total} />
        <Tile label="Paid" value={tiles.paid} accent="#16A34A" />
        <Tile label="To collect" value={inr(tiles.toCollect)} accent="#0748EE" />
        <Tile label="Overdue" value={inr(tiles.overdue)} accent="#DC2626" />
        {tiles.excessPaid !== 0 && (
          <Tile label="Excess paid" value={inr(tiles.excessPaid)} accent="#7C3AED" />
        )}
        <Tile label="Data gaps" value={tiles.gaps} accent={tiles.gaps ? '#D97706' : '#16A34A'} />
      </div>

      {/* Money-flow strip (Sales -> Net Receivables) + bank/adjustments */}
      {hasMoney && (
        <div style={{ ...card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, rowGap: 12 }}>
          <FlowStep label="Net Sales" value={inr(summary.net_sales)} />
          <FlowArrow sub={`− Payment ${inr(summary.payment_received)}`} />
          <FlowStep label="Payment Received" value={inr(summary.payment_received)} />
          <FlowArrow sub={`− TDS ${inr(summary.tds_deducted)}`} />
          <FlowStep label="Net Receivables" value={inr(summary.net_receivables)} accent="#0748EE" strong />
          <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--card-border,#E2E8F6)', margin: '0 4px' }} />
          <FlowStep label="Received in Bank" value={inr(summary.amount_received_in_bank)} accent="#16A34A" />
          <FlowStep label="Adjustments (PMDDN/AP-AR/Adv)" value={inr(summary.adjustments)} accent="#D97706" />
        </div>
      )}

      {/* Collections forecast + data quality */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Tile label="Due in next 7 days" value={`${inr(forecast.next7.amount)} · ${forecast.next7.count}`} accent="#D97706" />
        <Tile label="Due in next 30 days" value={`${inr(forecast.next30.amount)} · ${forecast.next30.count}`} accent="#D97706" />
        <Tile label="Docs complete (unpaid)" value={`${dataQuality}%`} accent={dataQuality >= 80 ? '#16A34A' : dataQuality >= 50 ? '#D97706' : '#DC2626'} />
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
          {/* Excess Paid is a NEGATIVE offset (Zepto overpaid) — it can't be a pie
              slice, so it lives in its own "Excess paid" tile above, not here. */}
        </div>

        <div style={{ ...card, flex: '1 1 300px', minWidth: 280 }}>
          <div style={chartTitle}>Data completeness gaps (unpaid invoices)</div>
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

      {/* Receivables to collect, month-wise (oldest first) */}
      {monthWise.length > 1 && (
        <div style={card}>
          <div style={chartTitle}>Receivables to collect, month-wise (unpaid net)</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthWise} margin={{ top: 8, right: 8, left: 6, bottom: 0 }}>
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--text-muted, #64748B)' }} axisLine={false} tickLine={false} interval={0} angle={-30} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted, #64748B)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${Math.round(v / 100000)}L`} />
              <Tooltip cursor={{ fill: 'rgba(0,0,0,.04)' }} formatter={(v) => [inr(v), 'To collect']} />
              <Bar dataKey="value" fill="#0748EE" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

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

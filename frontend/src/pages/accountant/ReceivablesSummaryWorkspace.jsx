/* Receivables Summary — the workspace.
   This file belongs to this agent alone; nothing else imports it, so the
   Amazon settlement agent and every other workspace are untouched by anything
   in here. The API calls are the ones the agent already exposes.

   The page is laid out like the workbook it produces — same lettered tables,
   same colours — so a figure on screen and a figure in the file look alike as
   well as read alike. */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  Upload, FileText, Download, Trash2, Loader2, CheckCircle2, AlertTriangle,
  FileSpreadsheet, X, ChevronRight, Scale, Banknote, Truck, ClipboardList, Inbox,
  CalendarDays, Layers, Package, Link as LinkIcon, Zap, RotateCcw, Eye,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import api from '../../lib/api';
import { toast } from 'sonner';
import { format } from 'date-fns';

/* This agent's identity, in the same shape the reco workspaces use — a colour,
   a slug, a watermark — so the page belongs to the same family as GSTR-1 vs
   Books rather than looking like a different product. Teal, because the other
   five are taken. */
const AGENT = {
  name: 'Receivables Summary',
  slug: 'SHOPIFY · GSTR-1 · PAYMENTS',
  color: '#0F766E',
  bg: 'rgba(15,118,110,0.08)',
  border: 'rgba(15,118,110,0.2)',
  description: 'Reads the delivered, refund and RTO sheets of each GST registration\'s sales workbook '
    + 'together with the payment reconciliation, joins them order by order, and states what is still '
    + 'recoverable — with the schedule behind every figure.',
};

/* Two type styles the rest of the app uses, so headings and captions match. */
const SECTION = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  color: 'var(--text-muted)', fontFamily: 'DM Sans', marginBottom: 14,
};
const TITLE = { fontFamily: 'Barlow', fontWeight: 800, letterSpacing: '-0.01em', color: 'var(--text-heading)' };

/* An input, drawn the way a file slot is drawn on the reco pages: a ghost
   numeral, a tile, the name, and the accepted form underneath in monospace. */
const Slot = ({ n, icon: Icon, label, hint, required, filled, children, onClick }) => (
  <div onClick={onClick}
       role={onClick ? 'button' : undefined}
       style={{
         position: 'relative', padding: '14px 16px 14px 20px', borderRadius: 10,
         cursor: onClick ? 'pointer' : 'default',
         background: filled ? 'rgba(5,150,105,0.06)' : 'var(--surface)',
         border: `1px solid ${filled ? 'rgba(5,150,105,0.25)' : 'var(--card-border)'}`,
         borderLeft: `3px solid ${filled ? '#059669' : AGENT.color}`,
         transition: 'all 0.18s ease',
       }}>
    <span style={{
      position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
      fontFamily: 'Barlow', fontWeight: 700, fontSize: 40, lineHeight: 1,
      color: filled ? 'rgba(5,150,105,0.1)' : 'rgba(0,0,0,0.04)',
      pointerEvents: 'none', userSelect: 'none',
    }}>{String(n).padStart(2, '0')}</span>
    <div className="flex items-start gap-3">
      <div style={{
        width: 34, height: 34, borderRadius: 8, flexShrink: 0, marginTop: 1,
        background: filled ? 'rgba(5,150,105,0.12)' : AGENT.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon style={{ width: 15, height: 15, color: filled ? '#059669' : AGENT.color }} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold" style={{ ...TITLE, margin: 0 }}>
          {label}
          {required && <span style={{ color: '#E11D48', marginLeft: 4, fontWeight: 400 }}>*</span>}
        </p>
        <p className="mt-0.5 font-mono text-xs" style={{ color: 'var(--text-muted)' }}>{hint}</p>
        {children}
      </div>
      {filled && <CheckCircle2 style={{ width: 16, height: 16, flexShrink: 0, color: '#059669' }} />}
    </div>
  </div>
);

/* One line of the status rail: what it is, and whether it is in hand. */
const StatusLine = ({ label, state }) => {
  const C = { ready: '#059669', required: '#E11D48', optional: 'var(--text-muted)' };
  const T = { ready: '✓ READY', required: 'REQUIRED', optional: 'OPTIONAL' };
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12, color: 'var(--text-body)' }}>{label}</span>
      <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', flexShrink: 0, color: C[state] }}>
        {T[state]}
      </span>
    </div>
  );
};

/* The workbook's palette, so the two match. */
const CLR = { sales: '#FFF7CC', returns: '#FCE4D6', recon: '#DDEBF7', cash: '#E2EFDA',
              due: '#FFE1E1', notes: '#EDEDED' };
const STATE_NAME = { HR: 'Haryana', KAR: 'Karnataka', MH: 'Maharashtra' };
const HEADS = ['taxable_value', 'cgst', 'sgst', 'igst'];

const MON3 = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (p) => {
  if (!p) return '';
  const [y, m] = String(p).split('-').map(Number);
  return `${MON3[m] || p} ${String(y).slice(2)}`;
};

const rup = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }));
const money = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
const int = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
const inv = (o) => HEADS.reduce((a, h) => a + (Number(o[h]) || 0), 0);

/* ── small pieces ─────────────────────────────────────────────────────────── */

const Card = ({ children, className = '', ...rest }) => (
  <div className={`rounded-2xl ${className}`}
       style={{ background: 'var(--surface)', border: '1px solid var(--card-border)',
                boxShadow: 'var(--card-shadow)' }} {...rest}>
    {children}
  </div>
);

const Stat = ({ icon: Icon, label, value, sub, accent, big }) => (
  <div className="rounded-2xl p-5" style={{
    background: 'var(--surface)', border: `1px solid ${accent ? `${accent}55` : 'var(--card-border)'}`,
    boxShadow: 'var(--card-shadow)' }}>
    <div className="flex items-center gap-2">
      {Icon && <span className="flex h-7 w-7 items-center justify-center rounded-lg"
                     style={{ background: accent ? `${accent}18` : '#F1F5F9' }}>
        <Icon className="h-4 w-4" style={{ color: accent || '#64748B' }} />
      </span>}
      <span className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
    </div>
    <div className={`mt-2 font-semibold tabular-nums ${big ? 'text-3xl' : 'text-2xl'}`}
         style={{ color: accent || 'var(--text-heading)' }}>{value}</div>
    {sub && <div className="mt-1 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
  </div>
);

/* A check is the point of the sheet, so it shows the number either way. */
const CheckPill = ({ label, value }) => {
  const ok = Math.abs(Number(value) || 0) < 0.005;
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-snug ${
      ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>
      {ok ? <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" />
          : <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />}
      <span>{label}<span className="ml-1.5 font-mono font-semibold">{Number(value || 0).toFixed(2)}</span></span>
    </div>
  );
};

/* The lettered tables. `rows` is [label, orders, amount, remark, kind]. */
const Tbl = ({ caption, colour, cols, rows, dense }) => (
  <div className="mb-7 overflow-hidden rounded-xl border" style={{ borderColor: '#CBD5E1' }}>
    {caption && (
      <div className="px-3 py-2 text-sm font-semibold" style={{ background: colour, color: '#1E3A57' }}>
        {caption}
      </div>
    )}
    <table className="w-full text-sm">
      <thead>
        <tr style={{ background: colour }}>
          {cols.map((c, i) => (
            <th key={c}
                className={`border-t px-3 py-1.5 font-semibold ${i === 0 ? 'text-left' : i === cols.length - 1 && !dense ? 'text-left' : 'text-right'}`}
                style={{ borderColor: '#CBD5E1', color: '#1E3A57' }}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, ...rest], i) => {
          const kind = rest[rest.length - 1];
          const cells = rest.slice(0, cols.length - 1);
          const strong = kind === 'total';
          const good = kind === 'ok';
          return (
            <tr key={i}
                className={strong ? 'font-semibold' : ''}
                style={{ background: strong ? colour : good ? '#ECFDF5' : undefined,
                         color: good ? '#166534' : undefined }}>
              <td className="border-t px-3 py-1.5 align-top" style={{ borderColor: '#E2E8F0' }}>{label}</td>
              {cells.map((v, j) => (
                <td key={j}
                    className={`border-t px-3 py-1.5 align-top ${j === cells.length - 1 && !dense ? 'text-left text-xs' : 'text-right tabular-nums'}`}
                    style={{ borderColor: '#E2E8F0',
                             color: j === cells.length - 1 && !dense ? 'var(--text-muted)' : undefined,
                             maxWidth: j === cells.length - 1 && !dense ? 460 : undefined }}>
                  {v}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

const TABS = [
  { key: 'position', label: 'The position' },
  { key: 'sales', label: 'Sales' },
  { key: 'recon', label: 'Reconciliation' },
  { key: 'notes', label: 'Notes' },
  { key: 'records', label: 'Records' },
];

/* ── the page ─────────────────────────────────────────────────────────────── */

/* ── the year ─────────────────────────────────────────────────────────────
   What the page opens on. Twelve rows and a ranked list of what is wrong says
   more in one screen than a single position over a year of orders ever did. */

const SEV = {
  critical:  { label: 'Needs correcting', bg: '#FFF1F2', border: '#FCA5A5', text: '#9F1239', dot: '#E11D48' },
  attention: { label: 'Needs a decision', bg: '#FFFBEB', border: '#FCD34D', text: '#92400E', dot: '#D97706' },
  note:      { label: 'Limit of the records', bg: '#F8FAFC', border: '#CBD5E1', text: '#475569', dot: '#94A3B8' },
};

/* One finding: how big, in which months, what it is, and what to do. */
const Finding = ({ f, onMonth }) => {
  const c = SEV[f.severity] || SEV.note;
  return (
    <div className="rounded-xl border p-4" style={{ background: c.bg, borderColor: c.border }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: c.dot }} />
          <div>
            <div className="text-sm font-semibold" style={{ color: c.text }}>{f.label}</div>
            <div className="mt-0.5 text-xs" style={{ color: c.text, opacity: 0.8 }}>
              {int(f.orders)} order{f.orders === 1 ? '' : 's'}
              {f.months ? ` · across ${f.months.length} month${f.months.length === 1 ? '' : 's'}` : ''}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums" style={{ color: c.text }}>{money(f.amount)}</div>
          <div className="text-[11px]" style={{ color: c.text, opacity: 0.75 }}>{f.basis || 'Amount'}</div>
        </div>
      </div>

      <p className="mt-2 text-xs leading-relaxed" style={{ color: c.text, opacity: 0.9 }}>{f.why}</p>
      {f.action && (
        <p className="mt-1.5 text-xs font-medium leading-relaxed" style={{ color: c.text }}>
          What to do: <span className="font-normal">{f.action}</span>
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap gap-1">
        {(f.months || []).slice().sort((a, b) => b.amount - a.amount).map((m) => (
          <button key={m.month} onClick={() => onMonth(m.month)}
                  title={`${int(m.orders)} orders · ${money(m.amount)} — open ${monthLabel(m.month)}`}
                  className="rounded-md border bg-white/70 px-1.5 py-0.5 text-[11px] font-medium transition hover:bg-white"
                  style={{ borderColor: c.border, color: c.text }}>
            {monthLabel(m.month)} <span className="tabular-nums opacity-70">{rup(m.amount)}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

/* The month-by-month table. Column groups are coloured the way the workbook
   colours them: sales yellow, returns orange, collections green, what is still
   owed red — so the eye finds the same block in both. */
const YearTable = ({ ov, onMonth }) => {
  const Y = ov.year;
  const bandHead = (bg) => ({ background: bg, color: '#1E3A57', borderColor: '#CBD5E1' });
  const cell = 'border-t px-3 py-2 text-right tabular-nums';
  return (
    <div className="overflow-x-auto rounded-xl border" style={{ borderColor: '#CBD5E1' }}>
      <table className="w-full min-w-[980px] text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide">
            <th className="border-b px-3 py-1.5 text-left" style={bandHead('#F1F5F9')}>Month</th>
            <th className="border-b border-l px-3 py-1.5 text-right" style={bandHead('#F1F5F9')}>Orders</th>
            <th className="border-b border-l px-3 py-1.5 text-right" style={bandHead(CLR.sales)}>Sales</th>
            <th className="border-b px-3 py-1.5 text-right" style={bandHead(CLR.returns)}>Less: RTO</th>
            <th className="border-b px-3 py-1.5 text-right" style={bandHead(CLR.returns)}>Less: refunds</th>
            <th className="border-b px-3 py-1.5 text-right" style={bandHead(CLR.sales)}>Net sales</th>
            <th className="border-b px-3 py-1.5 text-right" style={bandHead(CLR.sales)}>GST on net</th>
            <th className="border-b border-l px-3 py-1.5 text-right" style={bandHead(CLR.cash)}>Collected</th>
            <th className="border-b border-l px-3 py-1.5 text-right" style={bandHead(CLR.due)}>Recoverable</th>
            <th className="border-b px-3 py-1.5 text-right" style={bandHead(CLR.recon)}>In transit</th>
            <th className="border-b border-l px-3 py-1.5 text-left" style={bandHead('#F1F5F9')}>Status</th>
          </tr>
        </thead>
        <tbody>
          {ov.months.map((m) => {
            const dup = (m.duplicateTabs || []).length > 0;
            return (
              <tr key={m.month} onClick={() => onMonth(m.month)}
                  className="cursor-pointer transition hover:bg-slate-50">
                <td className="border-t px-3 py-2 font-medium" style={{ borderColor: '#E2E8F0' }}>
                  {m.label}
                </td>
                <td className={`${cell} border-l`} style={{ borderColor: '#E2E8F0' }}>{int(m.orders)}</td>
                <td className={`${cell} border-l`} style={{ borderColor: '#E2E8F0' }}>{rup(m.salesTaxable)}</td>
                <td className={cell} style={{ borderColor: '#E2E8F0', color: m.rtoProduced ? '#B91C1C' : '#B45309' }}>
                  {m.rtoProduced ? rup(m.rtoTaxable)
                                 : <span className="text-xs">not produced</span>}
                </td>
                <td className={cell} style={{ borderColor: '#E2E8F0', color: '#B91C1C' }}>{rup(m.refundTaxable)}</td>
                <td className={`${cell} font-semibold`} style={{ borderColor: '#E2E8F0' }}>{rup(m.netTaxable)}</td>
                <td className={cell} style={{ borderColor: '#E2E8F0' }}>{rup(m.netTax)}</td>
                <td className={`${cell} border-l`} style={{ borderColor: '#E2E8F0' }}>
                  {m.hasPayment ? rup(m.collected) : <span className="text-amber-700">not produced</span>}
                </td>
                <td className={`${cell} border-l font-semibold`}
                    style={{ borderColor: '#E2E8F0', color: m.receivable > 0 ? '#B45309' : undefined }}>
                  {m.hasPayment ? rup(m.receivable) : '—'}
                </td>
                <td className={cell} style={{ borderColor: '#E2E8F0' }}>
                  {m.hasPayment ? rup(m.inTransit) : '—'}
                </td>
                <td className="border-t border-l px-3 py-2" style={{ borderColor: '#E2E8F0' }}>
                  <div className="flex flex-wrap gap-1">
                    {!m.hasPayment && <Chip tone="amber">no payment file</Chip>}
                    {!m.rtoProduced && <Chip tone="amber">no RTO tab</Chip>}
                    {dup && <Chip tone="rose">tab copied</Chip>}
                    {!m.checksOk && <Chip tone="rose">does not tie</Chip>}
                    {m.exceptions.taxedNowhere.orders > 0 &&
                      <Chip tone="rose">{int(m.exceptions.taxedNowhere.orders)} not in GSTR-1</Chip>}
                    {m.hasPayment && m.checksOk && !dup && m.exceptions.taxedNowhere.orders === 0 &&
                      <Chip tone="emerald">ties</Chip>}
                  </div>
                </td>
              </tr>
            );
          })}
          <tr className="font-semibold" style={{ background: '#F1F5F9' }}>
            <td className="border-t px-3 py-2" style={{ borderColor: '#CBD5E1' }}>The year</td>
            <td className={`${cell} border-l`} style={{ borderColor: '#CBD5E1' }}>{int(Y.orders)}</td>
            <td className={`${cell} border-l`} style={{ borderColor: '#CBD5E1' }}>{rup(Y.salesTaxable)}</td>
            <td className={cell} style={{ borderColor: '#CBD5E1' }}>
              {rup(Y.rtoTaxable)}
              {ov.months.some((m) => !m.rtoProduced) && (
                <div className="text-[10px] font-normal" style={{ color: '#B45309' }}>
                  {ov.months.filter((m) => m.rtoProduced).length} of {ov.months.length} months
                </div>
              )}
            </td>
            <td className={cell} style={{ borderColor: '#CBD5E1' }}>{rup(Y.refundTaxable)}</td>
            <td className={cell} style={{ borderColor: '#CBD5E1' }}>{rup(Y.netTaxable)}</td>
            <td className={cell} style={{ borderColor: '#CBD5E1' }}>{rup(Y.netTax)}</td>
            <td className={`${cell} border-l`} style={{ borderColor: '#CBD5E1' }}>{rup(Y.collected)}</td>
            <td className={`${cell} border-l`} style={{ borderColor: '#CBD5E1' }}>{rup(Y.receivableAllMonths)}</td>
            <td className={cell} style={{ borderColor: '#CBD5E1' }}>{rup(Y.inTransitAllMonths)}</td>
            <td className="border-t border-l px-3 py-2" style={{ borderColor: '#CBD5E1' }} />
          </tr>
        </tbody>
      </table>
    </div>
  );
};

const Chip = ({ tone, children }) => {
  const T = { amber: 'bg-amber-100 text-amber-800', rose: 'bg-rose-100 text-rose-800',
              emerald: 'bg-emerald-100 text-emerald-800', slate: 'bg-slate-100 text-slate-700' };
  return <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${T[tone]}`}>{children}</span>;
};


/* A month, registration by registration — the same table as the year, with a
   row per GST registration instead of a row per month. */
const MonthTable = ({ s }) => {
  const byE = {};
  (s.byEntity || []).forEach((e) => { byE[e.entity] = e; });
  const blocks = (s.gstBlocks || []).filter((b) => !b.entity.includes('+'));
  const split = (s.byEntity || []).filter((e) => e.split_shipment);
  const tax = (o) => (o ? (o.cgst || 0) + (o.sgst || 0) + (o.igst || 0) : 0);
  const head = (bg) => ({ background: bg, color: '#1E3A57', borderColor: '#CBD5E1' });
  const cell = 'border-t px-3 py-2 text-right tabular-nums';
  const rtoProduced = blocks.some((b) => b.rto && b.rto.lines > 0);
  const C = s.gst?.consolidated;

  return (
    <div className="overflow-x-auto rounded-xl border" style={{ borderColor: '#CBD5E1' }}>
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide">
            <th className="border-b px-3 py-1.5 text-left" style={head('#F1F5F9')}>GST registration</th>
            <th className="border-b border-l px-3 py-1.5 text-right" style={head('#F1F5F9')}>Orders</th>
            <th className="border-b border-l px-3 py-1.5 text-right" style={head(CLR.sales)}>Sales</th>
            <th className="border-b px-3 py-1.5 text-right" style={head(CLR.returns)}>Less: RTO</th>
            <th className="border-b px-3 py-1.5 text-right" style={head(CLR.returns)}>Less: refunds</th>
            <th className="border-b px-3 py-1.5 text-right" style={head(CLR.sales)}>Net sales</th>
            <th className="border-b px-3 py-1.5 text-right" style={head(CLR.sales)}>GST on net</th>
            <th className="border-b border-l px-3 py-1.5 text-right" style={head(CLR.cash)}>Realised</th>
            <th className="border-b border-l px-3 py-1.5 text-right" style={head(CLR.due)}>Recoverable</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b) => {
            const e = byE[b.entity] || {};
            return (
              <tr key={b.entity}>
                <td className="border-t px-3 py-2 font-medium" style={{ borderColor: '#E2E8F0' }}>
                  {STATE_NAME[b.entity] || b.entity}
                </td>
                <td className={`${cell} border-l`} style={{ borderColor: '#E2E8F0' }}>{int(e.orders)}</td>
                <td className={`${cell} border-l`} style={{ borderColor: '#E2E8F0' }}>{rup(b.sales?.taxable_value)}</td>
                <td className={cell} style={{ borderColor: '#E2E8F0', color: '#B91C1C' }}>
                  {b.rto && b.rto.lines > 0 ? rup(b.rto.taxable_value)
                    : <span className="text-xs" style={{ color: '#B45309' }}>not produced</span>}
                </td>
                <td className={cell} style={{ borderColor: '#E2E8F0', color: '#B91C1C' }}>{rup(b.refund?.taxable_value)}</td>
                <td className={`${cell} font-semibold`} style={{ borderColor: '#E2E8F0' }}>{rup(b.net?.taxable_value)}</td>
                <td className={cell} style={{ borderColor: '#E2E8F0' }}>{rup(tax(b.net))}</td>
                <td className={`${cell} border-l`} style={{ borderColor: '#E2E8F0' }}>{rup(e.collected)}</td>
                <td className={`${cell} border-l font-semibold`}
                    style={{ borderColor: '#E2E8F0', color: e.receivable > 0 ? '#B45309' : undefined }}>
                  {rup(e.receivable)}
                </td>
              </tr>
            );
          })}
          {split.map((e) => (
            <tr key={e.entity} style={{ background: '#FAFAFA' }}>
              <td className="border-t px-3 py-2 text-xs" style={{ borderColor: '#E2E8F0', color: 'var(--text-muted)' }}>
                {e.entity} — one order billed from two registrations
              </td>
              <td className={`${cell} border-l`} style={{ borderColor: '#E2E8F0' }}>{int(e.orders)}</td>
              <td className={`${cell} border-l`} style={{ borderColor: '#E2E8F0' }} colSpan={5}>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  counted once at order level, inside the registrations above
                </span>
              </td>
              <td className={`${cell} border-l`} style={{ borderColor: '#E2E8F0' }}>{rup(e.collected)}</td>
              <td className={`${cell} border-l`} style={{ borderColor: '#E2E8F0' }}>{rup(e.receivable)}</td>
            </tr>
          ))}
          <tr className="font-semibold" style={{ background: '#F1F5F9' }}>
            <td className="border-t px-3 py-2" style={{ borderColor: '#CBD5E1' }}>All registrations</td>
            <td className={`${cell} border-l`} style={{ borderColor: '#CBD5E1' }}>{int(s.orders)}</td>
            <td className={`${cell} border-l`} style={{ borderColor: '#CBD5E1' }}>{rup(C?.sales?.taxable_value)}</td>
            <td className={cell} style={{ borderColor: '#CBD5E1' }}>
              {rtoProduced ? rup(C?.rto?.taxable_value)
                           : <span className="text-xs font-normal" style={{ color: '#B45309' }}>not produced</span>}
            </td>
            <td className={cell} style={{ borderColor: '#CBD5E1' }}>{rup(C?.refund?.taxable_value)}</td>
            <td className={cell} style={{ borderColor: '#CBD5E1' }}>{rup(C?.net?.taxable_value)}</td>
            <td className={cell} style={{ borderColor: '#CBD5E1' }}>{rup(tax(C?.net))}</td>
            <td className={`${cell} border-l`} style={{ borderColor: '#CBD5E1' }}>{rup(s.collected)}</td>
            <td className={`${cell} border-l`} style={{ borderColor: '#CBD5E1' }}>{rup(s.position?.receivable)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

const ReceivablesSummaryWorkspace = ({ agent }) => {
  const { brandId, agentId } = useParams();
  const base = `/api/brands/${brandId}/agents/${agentId}/receivables-summary`;

  const [files, setFiles] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [picked, setPicked] = useState([]);
  const [uploadReport, setUploadReport] = useState(null);
  const [tab, setTab] = useState('position');
  /* The page opens on the YEAR. A single position built over a year of orders
     took two minutes to draw and told the reader less than twelve rows do, so
     the year is its own view: what each month came to, and what is wrong.
     A month is opened from it. */
  const [view, setView] = useState('reports');    // reports | year | month | input
  const [overview, setOverview] = useState(null);
  const [monthLoading, setMonthLoading] = useState(false);
  const [ovLoading, setOvLoading] = useState(true);
  /* The year is no longer built when the page opens — it is READ from the
     statement stored when somebody last built it. These two carry what the
     store said about it. */
  const [needsBuild, setNeedsBuild] = useState(false);
  const [buildingYear, setBuildingYear] = useState(false);
  /* The reports produced so far. This is what the agent opens on — the work
     already done, not a form asking for more. */
  const [reports, setReports] = useState([]);
  /* The year's zip, if one was produced. Every month is a sheet inside it, so
     it is the fallback for a month that has no file of its own. */
  const yearFile = (reports.find((r) => r.scope === 'YEAR') || {}).savedFile || null;
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef(null);
  const [resetting, setResetting] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  /* One month, or several. The accountant files monthly, so a single month is
     the default; "several" exists for the year-end pack. */
  const [mode, setMode] = useState('one');
  const [month, setMonth] = useState(null);       // null = everything held
  const [picks, setPicks] = useState([]);         // for mode === 'many'
  const [bundling, setBundling] = useState(false);
  /* Three ways the records arrive: the accountant picks files off the desktop,
     or gives a Drive folder per kind, or one folder holding the lot. A year is
     46 workbooks and a million and a half lines, so the Drive paths run as a
     background job the page polls — which lets it say which month is being
     read rather than show a spinner that might be dead. */
  const [source, setSource] = useState('upload');   // upload | split | combined
  const [links, setLinks] = useState({ month: '', payment: '', shopify: '', combined: '' });
  const [replaceHeld, setReplaceHeld] = useState(true);
  const [job, setJob] = useState(null);
  const [sched, setSched] = useState(null);
  const [schedRows, setSchedRows] = useState([]);
  const [schedLoading, setSchedLoading] = useState(false);

  /* The records are read first and the page is drawn from them at once: the
     input, the records on hand and the month picker are all usable in the time
     one query takes. The year is a twenty-second build over a million and a
     half lines, so it is fetched SEPARATELY and fills in when it is ready.
     Waiting for it before drawing anything left the accountant looking at a
     spinner with no way to add a file — which is what it did. */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const f = await api.get(`${base}/files`);
      setFiles(f.data?.files || []);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load the records');
    } finally { setLoading(false); }

    try {
      const r = await api.get(`${base}/statements`);
      setReports(r.data?.reports || []);
    } catch { /* the list is a convenience; the views below still work */ }

    setOvLoading(true);
    try {
      const o = await api.get(`${base}/overview`);
      const d = o.data || {};
      setNeedsBuild(!!d.needsBuild);
      setOverview(d.empty || d.needsBuild ? null : d);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not build the year');
    } finally { setOvLoading(false); }
  }, [base]);

  useEffect(() => { refresh(); }, [refresh]);

  /* A month's own statement is fetched only when a month is open. This is the
     one call that used to be made with no month at all — a year of orders in a
     single position, which is what made the page hang. */
  useEffect(() => {
    if (!month) { setSummary(null); return; }
    let live = true;
    setMonthLoading(true);
    api.get(`${base}/summary`, { params: { month } })
      .then((r) => { if (live) setSummary(r.data?.empty ? null : r.data); })
      .catch((e) => toast.error(e.response?.data?.error || 'Could not load that month'))
      .finally(() => { if (live) setMonthLoading(false); });
    return () => { live = false; };
  }, [base, month]);

  /* Build the year and every month, once, and store them. The only thing that
     computes — everything else reads what this produced. */
  const buildYear = async () => {
    setBuildingYear(true);
    setJob({ state: 'running', stage: 'month', detail: 'starting', done: 0, total: 0, log: [] });
    try {
      const r = await api.post(`${base}/build`);
      watchJob(r.data.jobId, () => { setNeedsBuild(false); });
    } catch (e) {
      setJob(null);
      toast.error(e.response?.data?.error || 'Could not start the build');
    } finally { setBuildingYear(false); }
  };

  /* Download the workbook for one month, straight from the history row. */
  const downloadMonth = async (m) => {
    try {
      const res = await api.post(`${base}/workbook`, { month: m });
      await downloadFile(res.data.filename);
    } catch (e) { toast.error(e.response?.data?.error || 'Could not build that workbook'); }
  };

  /* Every month plus the consolidated, zipped — the year row's download.
     Sent with no month list, which means "all of them" to the server. That is
     also the only form it remembers the file for, and the only form that can
     fall back to the zip produced earlier once the records have been cleared —
     so this must NOT go through the month picks. */
  const handleBundleAll = async () => {
    setBundling(true);
    try {
      const res = await api.post(`${base}/bundle-job`, {});
      setJob({ state: 'running', stage: 'reading', detail: '', done: 0,
               total: (monthsHeld || []).length, log: [] });
      watchJob(res.data.jobId, (j) => { if (j.result?.filename) downloadFile(j.result.filename); });
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not build the year');
    } finally { setBundling(false); }
  };

  /* Remove a produced statement. The records it was built from are untouched —
     this deletes the report, not the data. */
  const removeReport = async (r) => {
    try {
      const url = r.scope === 'YEAR'
        ? `${base}/statements/YEAR`
        : `${base}/statements/MONTH/${r.period}`;
      await api.delete(url);
      toast.success(`${r.label} removed`);
      refresh();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not remove that statement'); }
  };

  /* Open a month from anywhere on the year view. */
  const openMonth = useCallback((m) => {
    setMonth(m); setMode('one'); setTab('position'); setView('month');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleUpload = async () => {
    if (!picked.length) return toast.error('Choose at least one file');
    setUploading(true);
    try {
      const fd = new FormData();
      picked.forEach((f) => fd.append('files', f));
      const res = await api.post(`${base}/upload`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setUploadReport(res.data);
      setPicked([]);
      toast.success(`${int(res.data.stored)} lines read from ${res.data.files.length} record(s)`);
      refresh();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Upload failed');
    } finally { setUploading(false); }
  };

  const handleBuild = async () => {
    setBuilding(true);
    try {
      const res = await api.post(`${base}/workbook`, month ? { month } : {});
      const name = res.data.filename;
      const dl = await api.get(`${base}/download/${encodeURIComponent(name)}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([dl.data]));
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      a.remove(); window.URL.revokeObjectURL(url);
      toast.success(`${res.data.sheets.length} sheets built`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not build the statement');
    } finally { setBuilding(false); }
  };

  /* Poll a background job until it stops. The interval is deliberately short:
     the stage text is the whole point, and a year moves through it quickly. */
  const watchJob = useCallback(async (jobId, onDone) => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await api.get(`${base}/job/${jobId}`);
        setJob(r.data);
        if (r.data.state === 'running') { setTimeout(tick, 1200); return; }
        stop = true;
        if (r.data.state === 'failed') toast.error(r.data.error || 'The job failed');
        else { toast.success('Done'); if (onDone) onDone(r.data); refresh(); }
      } catch (e) {
        stop = true;
        setJob((j) => (j ? { ...j, state: 'failed', error: 'Lost contact with the job' } : j));
      }
    };
    tick();
  }, [base, refresh]);

  const startDrive = async () => {
    const url = source === 'combined'
      ? links.combined
      : [links.month, links.payment, links.shopify].filter(Boolean).join(' ');
    if (!url.trim()) return toast.error('Paste at least one Drive folder link');
    setJob({ state: 'running', stage: 'starting', detail: '', done: 0, total: 0, log: [] });
    try {
      const r = await api.post(`${base}/ingest-drive`, { url, replace: replaceHeld, build: true });
      watchJob(r.data.jobId);
    } catch (e) {
      setJob(null);
      toast.error(e.response?.data?.error || 'Could not start');
    }
  };

  const downloadFile = async (name) => {
    const dl = await api.get(`${base}/download/${encodeURIComponent(name)}`, { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([dl.data]));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    a.remove(); window.URL.revokeObjectURL(url);
  };

  /* A statement per month plus one consolidated, zipped. */
  const handleBundle = async () => {
    if (!picks.length) return toast.error('Choose at least one month');
    setBundling(true);
    try {
      /* through the job, so a year reports which month it is on instead of
         hanging the request until it is finished */
      const res = await api.post(`${base}/bundle-job`, { months: picks });
      setJob({ state: 'running', stage: 'reading', detail: '', done: 0, total: picks.length, log: [] });
      watchJob(res.data.jobId, (j) => { if (j.result?.filename) downloadFile(j.result.filename); });
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not build the statements');
    } finally { setBundling(false); }
  };

  const openSched = async (key, label) => {
    setSched({ key, label }); setSchedLoading(true); setSchedRows([]);
    try {
      const res = await api.get(`${base}/ledger`,
        { params: { worklist: key, limit: 500, ...(month ? { month } : {}) } });
      setSchedRows(res.data.rows || []);
    } catch (e) { toast.error('Could not load that schedule'); }
    finally { setSchedLoading(false); }
  };

  /* Clear everything held so the next run starts from nothing. Confirmed on
     its own screen with the counts named, because it cannot be undone. */
  const handleReset = async () => {
    setResetting(true);
    try {
      const r = await api.post(`${base}/reset`);
      const mb = Math.round((r.data.freedBytes || 0) / 1048576);
      toast.success(`${int(r.data.heldRows)} lines from ${int(r.data.heldFiles)} records cleared`
        + (mb ? ` · ${mb} MB freed` : '')
        + ' · your reports are untouched');
      setConfirmReset(false);
      setSummary(null); setMonth(null); setPicks([]);
      setUploadReport(null); setJob(null);
      /* Back to the reports, not to the upload form — the work that survives is
         the point of clearing the run. */
      setView('reports');
      refresh();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not clear the records');
    } finally { setResetting(false); }
  };

  const handleDelete = async (filename) => {
    try {
      await api.delete(`${base}/files/${encodeURIComponent(filename)}`);
      toast.success('Removed'); refresh();
    } catch (e) { toast.error('Could not remove that record'); }
  };

  const s = summary;
  const ov = overview;
  /* The months held, and whether each was reconciled. Taken from the year once
     it is built, and until then from the records themselves — so a month can be
     opened in the first second, before any statement exists. */
  const monthsHeld = useMemo(() => {
    if (ov) return ov.months;
    const m = new Map();
    (files || []).forEach((f) => (f.periods || []).forEach((p) => {
      const e = m.get(p) || { month: p, hasPayment: false };
      if ((f.kinds || []).includes('PAYMENT')) e.hasPayment = true;
      m.set(p, e);
    }));
    return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
  }, [ov, files]);
  const br = s?.bridge;
  const P = useMemo(() => {
    const m = {};
    (s?.byPosition || []).forEach((p) => { m[p.key] = p; });
    return m;
  }, [s]);

  /* ── what the job is doing, in the words of the work ──────────────────── */
  const STAGES = [
    ['extracting', 'Reading the Drive folder'],
    ['processing', 'Reading each workbook'],
    ['month', 'Building each month'],
    ['consolidating', 'Building the consolidated statement'],
    ['zipping', 'Packing the download'],
  ];
  const stageIndex = job ? STAGES.findIndex(([k]) => k === job.stage) : -1;
  const progressPanel = job && (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-base font-semibold" style={{ color: 'var(--text-heading)' }}>
          {job.state === 'running' && <Loader2 className="h-4 w-4 animate-spin" />}
          {job.state === 'done' && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
          {job.state === 'failed' && <AlertTriangle className="h-4 w-4 text-rose-600" />}
          {job.state === 'running' ? 'Working…' : job.state === 'done' ? 'Finished' : 'Stopped'}
        </div>
        <div className="flex items-center gap-3">
          {job.seconds != null && (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{job.seconds}s</span>
          )}
          {job.state !== 'running' && (
            <Button size="sm" variant="ghost" onClick={() => setJob(null)}><X className="h-4 w-4" /></Button>
          )}
        </div>
      </div>

      <ol className="mb-3 space-y-1.5">
        {STAGES.map(([k, label], i) => {
          const state = job.state === 'done' ? 'done'
            : stageIndex < 0 ? 'todo'
            : i < stageIndex ? 'done' : i === stageIndex ? 'now' : 'todo';
          return (
            <li key={k} className="flex items-start gap-2 text-sm">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                state === 'done' ? 'bg-emerald-500' : state === 'now' ? 'animate-pulse bg-slate-800' : 'bg-slate-300'}`} />
              <span style={{ color: state === 'todo' ? 'var(--text-muted)' : 'var(--text-heading)',
                             fontWeight: state === 'now' ? 600 : 400 }}>
                {label}
                {state === 'now' && job.detail && (
                  <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>— {job.detail}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      {job.total > 0 && (
        <div className="mb-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-slate-800 transition-all"
                 style={{ width: `${Math.round((job.done / job.total) * 100)}%` }} />
          </div>
          <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {int(job.done)} of {int(job.total)}
          </div>
        </div>
      )}

      {job.state === 'failed' && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {job.error}
        </div>
      )}

      {job.state === 'done' && job.result && (
        <div className="space-y-2">
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {job.result.stored != null && <>{int(job.result.stored)} lines read. </>}
            {job.result.statements != null && <>{job.result.statements} statements{job.result.consolidated ? ', including the consolidated one' : ''}.</>}
          </div>
          {job.result.filename && (
            <Button onClick={() => downloadFile(job.result.filename)} className="bg-slate-800 hover:bg-slate-900">
              <Download className="mr-2 h-4 w-4" /> Download {job.result.filename.endsWith('.zip') ? 'the statements' : 'the statement'}
            </Button>
          )}
          {(job.result.files || []).some((f) => f.error) && (
            <div className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--card-border)', color: 'var(--text-muted)' }}>
              {(job.result.files || []).filter((f) => f.error).map((f) => (
                <div key={f.file}><span className="font-medium">{f.file}</span> — {f.error}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );

  /* ── where the records come from ──────────────────────────────────────── */
  const SOURCES = [
    ['upload', 'Upload files', Upload],
    ['split', 'Three Drive links', Layers],
    ['combined', 'One Drive link', LinkIcon],
  ];
  const LINK_BOXES = [
    ['month', 'Month-wise GSTR-1 workbooks', 'the folder holding each month\'s HR / KAR / MH workbooks'],
    ['payment', 'Payment reconciliations', 'one file per month'],
    ['shopify', 'Shopify exports', 'optional — the payment reconciliation already carries these orders'],
  ];
  /* What a run does, always on show — greyed out when nothing is running, lit
     as each stage is reached. The accountant asked to SEE the work: extracting,
     then processing, then each month's workbook, then the consolidation. Left
     invisible until something ran, it could not be found at all. */
  const stageList = (
    <Card className="p-5">
      <div className="mb-1 text-base font-semibold" style={{ color: 'var(--text-heading)' }}>
        What happens when it runs
      </div>
      <p className="mb-4 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {job?.state === 'running'
          ? 'Live. The stage in bold is the one being worked now.'
          : job?.state === 'done'
            ? 'The last run finished. These are the stages it went through.'
            : 'Nothing is running. A run moves through these five stages and reports each one as it '
              + 'reaches it, month by month, so the memory never has to hold the whole year.'}
      </p>
      <ol className="space-y-2.5">
        {STAGES.map(([k, lbl], i) => {
          const at = job && stageIndex === i;
          const past = job && stageIndex > i;
          return (
            <li key={k} className="flex items-start gap-3">
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                at ? 'bg-slate-800 text-white' : past ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>
                {past ? '✓' : i + 1}
              </span>
              <div>
                <div className={`text-sm ${at ? 'font-semibold' : ''}`}
                     style={{ color: at ? 'var(--text-heading)' : past ? '#047857' : 'var(--text-muted)' }}>
                  {lbl}
                </div>
                {at && job.detail && (
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{job.detail}</div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        The download that comes out is a zip: one statement per month, plus a consolidated statement
        carrying the month-by-month table.
      </p>
    </Card>
  );

  /* Every record on hand, and what each was read as. */
  const recordsTable = (
              <Card className="p-5">
                <div className="mb-1 text-base font-semibold" style={{ color: 'var(--text-heading)' }}>
                  Records on hand
                </div>
                <p className="mb-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                  Removing a record withdraws its lines from every figure above.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                        <th className="pb-2">Record</th><th className="pb-2">Read as</th>
                        <th className="pb-2">Registration</th><th className="pb-2">Period</th>
                        <th className="pb-2 text-right">Lines</th><th className="pb-2">Uploaded</th><th />
                      </tr>
                    </thead>
                    <tbody>
                      {files.map((f) => (
                        <tr key={f.filename} className="border-t" style={{ borderColor: 'var(--card-border)' }}>
                          <td className="max-w-[220px] truncate py-2 text-xs" style={{ color: 'var(--text-muted)' }}>{f.filename}</td>
                          <td className="py-2">{f.kinds.join(', ')}</td>
                          <td className="py-2">{f.entities.join(', ') || '—'}</td>
                          <td className="py-2">{f.periods.join(', ') || '—'}</td>
                          <td className="py-2 text-right tabular-nums">{int(f.rows)}</td>
                          <td className="py-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                            {f.uploadedAt ? format(new Date(f.uploadedAt), 'dd MMM yyyy HH:mm') : '—'}
                          </td>
                          <td className="py-2 text-right">
                            <Button size="sm" variant="ghost" onClick={() => handleDelete(f.filename)}>
                              <Trash2 className="h-4 w-4 text-rose-600" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                      {!files.length && (
                        <tr><td colSpan={7} className="py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                          No records held.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
  );

  /* Which inputs this run needs, so the slots and the status rail are cast
     from one list and can never disagree with each other. */
  const SLOTS = source === 'upload'
    ? [{ key: 'files', n: 1, icon: FileSpreadsheet, required: true,
         label: 'The month\'s workbooks',
         hint: '.xlsx / .xls — GSTR-1 workbook per registration + the payment reconciliation',
         filled: picked.length > 0 }]
    : source === 'combined'
      ? [{ key: 'combined', n: 1, icon: LinkIcon, required: true,
           label: 'One Drive folder',
           hint: 'holding the workbooks, in subfolders or not',
           filled: !!links.combined.trim() }]
      : [{ key: 'month', n: 1, icon: LinkIcon, required: true,
           label: 'Month-wise GSTR-1 workbooks',
           hint: 'one folder — delivered, refund and RTO sheets per registration',
           filled: !!links.month.trim() },
         { key: 'payment', n: 2, icon: LinkIcon, required: true,
           label: 'Payment reconciliation',
           hint: 'one folder — either format, old Final tab or the newer All_Data',
           filled: !!links.payment.trim() },
         { key: 'shopify', n: 3, icon: LinkIcon, required: false,
           label: 'Shopify orders',
           hint: 'optional — the base the two above are joined to',
           filled: !!links.shopify.trim() }];

  const canRun = source === 'upload'
    ? picked.length > 0
    : SLOTS.filter((x) => x.required).every((x) => x.filled);

  const inputScreen = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 20 }}
           className="max-lg:!grid-cols-1">
        {/* ── left: what goes in ─────────────────────────────────────── */}
        <div className="glass-card" style={{ padding: 24 }}>
          <p style={SECTION}>Records to be produced</p>

          <div className="mb-4 flex flex-wrap gap-1 rounded-lg border p-0.5"
               style={{ borderColor: 'var(--card-border)' }}>
            {SOURCES.map(([k, label, Ic]) => (
              <button key={k} onClick={() => setSource(k)}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
                      style={source === k
                        ? { background: AGENT.color, color: '#fff' }
                        : { color: 'var(--text-muted)' }}>
                <Ic className="h-3.5 w-3.5" />{label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {SLOTS.map((sl) => (
              <Slot key={sl.key} n={sl.n} icon={sl.icon} label={sl.label} hint={sl.hint}
                    required={sl.required} filled={sl.filled}
                    onClick={sl.key === 'files' ? () => fileRef.current?.click() : undefined}>
                {sl.key === 'files' ? (
                  <>
                    <input ref={fileRef} type="file" multiple accept=".xlsx,.xls" className="hidden"
                           onChange={(e) => setPicked(Array.from(e.target.files || []))} />
                    {picked.length > 0 && (
                      <div className="mt-2 max-h-40 space-y-1 overflow-auto">
                        {picked.map((f) => (
                          <div key={f.name} className="flex items-center gap-2 rounded-md px-2 py-1"
                               style={{ background: 'var(--page-bg)', border: '1px solid var(--card-border)' }}>
                            <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            <span className="flex-1 truncate text-xs" style={{ color: 'var(--text-body)' }}>{f.name}</span>
                            <span className="shrink-0 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {(f.size / 1024 / 1024).toFixed(1)} MB
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <Input className="mt-2" value={links[sl.key]}
                         placeholder="https://drive.google.com/drive/folders/…"
                         onClick={(e) => e.stopPropagation()}
                         onChange={(e) => setLinks((l) => ({ ...l, [sl.key]: e.target.value }))} />
                )}
              </Slot>
            ))}
          </div>

          <p className="mt-4 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {source === 'upload'
              ? 'Only the delivered, refund and RTO sheets are read; every other sheet pertains to a '
                + 'different sales channel and is excluded. Each file is identified from its contents, '
                + 'so the order does not matter.'
              : 'The folder must be shared with the service account. Workbooks are read one at a time '
                + 'and each month is built on its own, so a year does not have to fit in memory at once.'}
          </p>
        </div>

        {/* ── right: configuration, the run, and what is in hand ──────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="glass-card" style={{ padding: 20 }}>
            <p style={SECTION}>Configuration</p>
            <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
              <input type="checkbox" className="mt-1" checked={replaceHeld}
                     disabled={source === 'upload'}
                     onChange={(e) => setReplaceHeld(e.target.checked)} />
              <span>
                <span className="font-medium" style={{ color: 'var(--text-heading)' }}>Replace what is held</span>
                <br />
                {source === 'upload'
                  ? 'An upload always adds to what is held. Use “Start a new run” below to clear first.'
                  : 'Leave this ticked for a fresh year — reading the same workbooks twice would count every line twice.'}
              </span>
            </label>
          </div>

          <button onClick={source === 'upload' ? handleUpload : startDrive}
                  disabled={!canRun || uploading || job?.state === 'running'}
                  className="btn-glow flex w-full items-center justify-center gap-2"
                  style={{ padding: '13px 0', opacity: (!canRun || uploading || job?.state === 'running') ? 0.5 : 1,
                           cursor: canRun ? 'pointer' : 'not-allowed' }}>
            {uploading || job?.state === 'running'
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Working…</>
              : <><Zap className="h-4 w-4" /> {source === 'upload' ? 'Read the files' : 'Read from Drive and build'}</>}
          </button>

          <div className="glass-card" style={{ padding: 16 }}>
            <p style={{ ...SECTION, marginBottom: 10 }}>Files status</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {SLOTS.map((sl) => (
                <StatusLine key={sl.key} label={sl.label}
                            state={sl.filled ? 'ready' : sl.required ? 'required' : 'optional'} />
              ))}
              <div style={{ paddingTop: 8, marginTop: 2, borderTop: '1px solid var(--card-border)' }}>
                <StatusLine label={`Held already — ${int(files.length)} workbooks`}
                            state={files.length ? 'ready' : 'optional'} />
              </div>
            </div>
          </div>

          {stageList}
        </div>
      </div>

      {recordsTable}

      {files.length > 0 && (
        <div className="glass-card" style={{ padding: 20, borderColor: 'rgba(225,29,72,0.25)' }}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p style={{ ...TITLE, fontSize: 15, color: '#9F1239', margin: 0 }}>Start a new run</p>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Clears every record held — {int(files.reduce((a, f) => a + (f.rows || 0), 0))} lines from{' '}
                {int(files.length)} workbooks — so the next run starts from nothing. Statements already
                downloaded are not touched. This cannot be undone.
              </p>
            </div>
            <Button variant="outline" onClick={() => setConfirmReset(true)}
                    className="border-rose-300 text-rose-700 hover:bg-rose-50">
              <Trash2 className="mr-2 h-4 w-4" /> Clear everything held
            </Button>
          </div>
        </div>
      )}
    </>
  );

  /* Input beside the records, for the tab inside a month. */
  /* The month's Records tab shows what is held and how to add more — the same
     screen as the Add records view, so there is only one of it to learn. */
  const recordsPanel = inputScreen;

  const hero = (
    <div style={{
      position: 'relative', overflow: 'hidden', borderRadius: 14,
      background: 'var(--surface)', border: '1px solid var(--card-border)',
      borderTop: `3px solid ${AGENT.color}`, padding: '24px 28px',
      boxShadow: `0 4px 32px ${AGENT.color}12`,
    }}>
      <div style={{ position: 'absolute', right: -8, bottom: -12, opacity: 0.045, pointerEvents: 'none' }}>
        <Scale style={{ width: 140, height: 140, color: AGENT.color }} />
      </div>
      {/* Reset, top right — the same place and the same shape as every other
          agent's, so it is where it is looked for. */}
      {files.length > 0 && (
        <button onClick={() => setConfirmReset(true)}
                aria-label="Reset — clear every record held and start a new run"
                style={{
                  position: 'absolute', top: 18, right: 20, zIndex: 1,
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                  background: 'var(--page-bg)', border: '1px solid var(--card-border)',
                  color: 'var(--text-muted)', cursor: 'pointer',
                }}>
          <RotateCcw style={{ width: 13, height: 13 }} /> Reset
        </button>
      )}

      <div className="flex items-start gap-4">
        <div style={{
          width: 52, height: 52, borderRadius: 12, flexShrink: 0,
          background: AGENT.bg, border: `1.5px solid ${AGENT.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 4px 16px ${AGENT.color}20`,
        }}>
          <Scale style={{ width: 24, height: 24, color: AGENT.color }} />
        </div>
        <div className="min-w-0">
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: AGENT.color,
                      fontFamily: 'monospace', marginBottom: 4, opacity: 0.85 }}>
            {AGENT.slug}
          </p>
          <h1 style={{ fontFamily: 'Barlow', fontWeight: 900, fontSize: 26, color: 'var(--text-heading)',
                       letterSpacing: '-0.02em', lineHeight: 1.1, margin: '0 0 6px' }}>
            {AGENT.name}
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: 620, margin: 0 }}>
            {AGENT.description}
          </p>
          {ov && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10,
              padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              background: AGENT.bg, border: `1px solid ${AGENT.border}`, color: AGENT.color,
            }}>
              {ov.brand} · {ov.year.from} to {ov.year.to}
            </span>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6" data-testid="receivables-summary-workspace">
      {hero}

      {/* what the work is doing, above everything, while it runs */}
      {progressPanel}

      {loading && (
        <div className="py-16 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" />
          <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>Reading the records held…</p>
        </div>
      )}

      {/* ── the year, a month, or the records themselves ──────────────── */}
      {!loading && (files.length > 0 || ov) && (
        <div className="flex flex-wrap items-center gap-1 rounded-xl border p-1"
             style={{ borderColor: 'var(--card-border)', background: 'var(--surface)' }}>
          {[['reports', `Statements${reports.length ? ` (${reports.length})` : ''}`, FileText],
            ['year', ov ? `The year — ${ov.year.from} to ${ov.year.to}`
                        : ovLoading ? 'The year — reading…'
                        : needsBuild ? 'The year — not built yet' : 'The year', Layers],
            ['month', month ? `${monthLabel(month)} in full` : 'One month in full', CalendarDays],
            ['input', 'Add records', Upload]].map(([k, lbl, Ic]) => (
            <button key={k} onClick={() => setView(k)}
                    className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition ${
                      view === k ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
              <Ic className="h-4 w-4" />{lbl}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-2 pr-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            {ovLoading && <Loader2 className="h-3 w-3 animate-spin" />}
            {ov ? `${int(ov.rows)} lines from ${int(ov.files)} workbooks${
                    ov.builtAt ? ` · built ${format(new Date(ov.builtAt), 'dd MMM HH:mm')}` : ''}`
                : `${int(files.reduce((a, f) => a + (f.rows || 0), 0))} lines from ${int(files.length)} records`}
          </span>
        </div>
      )}

      {/* ── the reports produced so far: what the agent opens on ───────── */}
      {!loading && view === 'reports' && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div style={{ ...TITLE, fontSize: 19 }}>Statements produced</div>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                Already built and stored. Opening one is a read — nothing is recomputed.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={refresh} disabled={loading}>
                <RotateCcw className="mr-2 h-4 w-4" /> Refresh
              </Button>
              <Button onClick={() => setView('input')} className="bg-slate-800 hover:bg-slate-900">
                <Zap className="mr-2 h-4 w-4" /> Generate report
              </Button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Stat icon={FileSpreadsheet} label="Statements" value={int(reports.length)}
                  sub="One for the year, one per month." />
            <Stat icon={Inbox} label="Records held" value={int(files.reduce((a, f) => a + (f.rows || 0), 0))}
                  sub={`From ${int(files.length)} workbooks.`} />
            <Stat icon={CalendarDays} label="Months covered"
                  value={int(reports.filter((r) => r.scope === 'MONTH').length)}
                  sub={reports.some((r) => r.stale)
                        ? 'Some were built before the records changed.'
                        : 'All current with the records held.'} />
          </div>

          <Card className="p-0">
            <div className="flex items-center justify-between px-5 py-3.5 border-b"
                 style={{ borderColor: 'var(--card-border)' }}>
              <div className="flex items-center gap-2 text-base font-semibold"
                   style={{ color: 'var(--text-heading)' }}>
                <FileText className="h-4 w-4" /> Report history
                <span className="rounded-full px-2 py-0.5 text-xs"
                      style={{ background: 'var(--page-bg)', color: 'var(--text-muted)' }}>
                  {reports.length}
                </span>
              </div>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Click View to open the statement
              </span>
            </div>

            {reports.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <FileText className="mx-auto mb-3 h-8 w-8 text-slate-300" />
                <div style={{ ...TITLE, fontSize: 16 }}>Nothing produced yet</div>
                <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed"
                   style={{ color: 'var(--text-muted)' }}>
                  {files.length
                    ? 'The records are held. Generate the report and it is stored — after that, opening it costs nothing.'
                    : 'Add the records first, then generate the report.'}
                </p>
                <Button onClick={() => (files.length ? buildYear() : setView('input'))}
                        disabled={buildingYear || job?.state === 'running'}
                        className="mt-4 bg-slate-800 hover:bg-slate-900">
                  {buildingYear || job?.state === 'running'
                    ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Building…</>
                    : <><Zap className="mr-2 h-4 w-4" /> {files.length ? 'Generate report' : 'Add records'}</>}
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide"
                        style={{ color: 'var(--text-muted)' }}>
                      <th className="px-5 py-2.5">Statement</th>
                      <th className="px-3 py-2.5">Covers</th>
                      <th className="px-3 py-2.5 text-right">Orders</th>
                      <th className="px-3 py-2.5">Built</th>
                      <th className="px-3 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((r) => (
                      <tr key={`${r.scope}-${r.period || 'year'}`} className="border-t"
                          style={{ borderColor: 'var(--card-border)' }}>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-7 w-7 items-center justify-center rounded-lg"
                                  style={{ background: r.scope === 'YEAR' ? AGENT.bg : 'var(--page-bg)' }}>
                              {r.scope === 'YEAR'
                                ? <Layers className="h-3.5 w-3.5" style={{ color: AGENT.color }} />
                                : <CalendarDays className="h-3.5 w-3.5 text-slate-400" />}
                            </span>
                            <span className="font-medium" style={{ color: 'var(--text-heading)' }}>
                              {r.label}
                            </span>
                            {r.stale && <Chip tone="amber">records changed</Chip>}
                            {r.recordsCleared && (
                              <Chip tone={r.savedFile ? 'slate' : 'amber'}>
                                {r.savedFile ? 'records cleared · file kept' : 'records cleared'}
                              </Chip>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3" style={{ color: 'var(--text-muted)' }}>
                          {r.scope === 'YEAR' ? 'All months held' : r.period}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{int(r.orders)}</td>
                        <td className="px-3 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                          {r.builtAt ? format(new Date(r.builtAt), 'dd MMM yyyy HH:mm') : '—'}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button size="sm"
                                    onClick={() => (r.scope === 'YEAR' ? setView('year') : openMonth(r.period))}
                                    className="bg-slate-800 hover:bg-slate-900">
                              <Eye className="mr-1.5 h-3.5 w-3.5" /> View
                            </Button>
                            {/* A month whose own workbook was never written is
                                still a sheet inside the year's zip, so the year
                                is offered rather than nothing. */}
                            <Button size="sm" variant="ghost"
                                    disabled={r.downloadable === false && !yearFile}
                                    onClick={() => ((r.scope === 'YEAR' || r.downloadable === false)
                                      ? handleBundleAll() : downloadMonth(r.period))}
                                    title={r.downloadable !== false
                                      ? (r.savedFile ? `Download ${r.savedFile}` : 'Download the workbook')
                                      : yearFile
                                        ? `This month was never written to its own file, but it is a sheet `
                                          + `inside the year's download. Click to get the year.`
                                        : 'The records were cleared before this workbook was produced. '
                                          + 'Read the records in again to produce it.'}>
                              <Download className="h-4 w-4" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => removeReport(r)}
                                    title="Remove this report and its workbook — any records held stay">

                              <Trash2 className="h-4 w-4 text-rose-600" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}


      {/* ── the year ──────────────────────────────────────────────────── */}
      {!loading && ovLoading && !ov && view === 'year' && (
        <Card className="p-8 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" />
          <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>Reading the stored statement…</p>
        </Card>
      )}

      {/* Nothing has been built for these records yet. The page does NOT build
          one on its own — that is a minute of work on the shared backend and
          nobody asked for it by opening a page. */}
      {!loading && !ovLoading && needsBuild && view === 'year' && (
        <Card className="p-8 text-center">
          <Layers className="mx-auto mb-3 h-8 w-8" style={{ color: AGENT.color, opacity: 0.45 }} />
          <div style={{ ...TITLE, fontSize: 17 }}>No statement has been built yet</div>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            The records are held and ready. Building produces one statement per month and the year
            across them, and stores the lot — after that, opening this page is a read and costs
            nothing. It is the only step that spends real time.
          </p>
          <Button onClick={buildYear} disabled={buildingYear || job?.state === 'running'}
                  className="mt-4 bg-slate-800 hover:bg-slate-900">
            {buildingYear || job?.state === 'running'
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Building…</>
              : <><Zap className="mr-2 h-4 w-4" /> Build the statements</>}
          </Button>
        </Card>
      )}

      {/* The records moved after this statement was built. The figures are still
          shown — an accountant who produced a statement should not lose sight of
          it because a file was added — but the page says so and offers a rebuild
          rather than quietly serving an old number. */}
      {!loading && ov && ov.stale && view === 'year' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3"
             style={{ borderColor: '#FCD34D', background: '#FFFBEB' }}>
          <div className="text-sm" style={{ color: '#92400E' }}>
            <span className="font-semibold">The records have changed since this was built.</span>{' '}
            {ov.reason} The figures below are the ones last produced.
          </div>
          <Button size="sm" onClick={buildYear} disabled={buildingYear || job?.state === 'running'}
                  className="bg-amber-600 hover:bg-amber-700">
            {buildingYear || job?.state === 'running'
              ? <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Rebuilding…</>
              : <><Zap className="mr-2 h-3.5 w-3.5" /> Rebuild</>}
          </Button>
        </div>
      )}

      {!loading && ov && view === 'year' && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {ov.brand} · the year in one page
              </div>
              <div className="mt-0.5 text-xl font-semibold" style={{ color: 'var(--text-heading)' }}>
                {ov.year.from} to {ov.year.to}
                <span className="ml-3 text-sm font-normal" style={{ color: 'var(--text-muted)' }}>
                  {ov.year.months} months read · {ov.year.monthsWithPayment} reconciled · {int(ov.year.orders)} orders
                </span>
              </div>
            </div>
            <Button onClick={() => { setMode('many'); setPicks(ov.months.map((m) => m.month)); setView('month'); }}
                    className="bg-slate-800 hover:bg-slate-900">
              <Package className="mr-2 h-4 w-4" /> Download all {ov.year.months} statements
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat icon={Scale} label="Net sales for the year" value={money(ov.year.netTaxable)} big
                  sub={`Sales ${money(ov.year.salesTaxable)} less RTO and refunds ${money(Math.abs(ov.year.returnsTaxable))}. GST on net ${money(ov.year.netTax)}.`} />
            <Stat icon={Banknote} label="Realised" value={money(ov.year.collected)}
                  sub={`Against ${money(ov.year.billed)} of orders passing through the payment reconciliation, over the ${ov.year.monthsWithPayment} months that were reconciled.`} />
            <Stat icon={ClipboardList} label="Still recoverable" value={money(ov.year.receivableAllMonths)}
                  accent="#B45309"
                  sub="Added across the months. Each order is counted in the one month its statement covers, so these do add." />
            <Stat icon={Truck} label="Goods in transit" value={money(ov.year.inTransitAllMonths)}
                  sub="Dispatched inside a month and delivered after it ended. Not a trade receivable on a delivery basis." />
          </div>

          {/* what is wrong, largest first */}
          <Card className="p-5">
            <div className="mb-1 flex items-center gap-2 text-base font-semibold"
                 style={{ color: 'var(--text-heading)' }}>
              <AlertTriangle className="h-4 w-4 text-amber-500" /> What needs attention
            </div>
            <p className="mb-4 text-sm" style={{ color: 'var(--text-muted)' }}>
              Every exception found in the year, largest first. Click a month to open it.
            </p>
            {['critical', 'attention'].map((sev) => {
              const list = (ov.findings || []).filter((f) => f.severity === sev);
              if (!list.length) return null;
              return (
                <div key={sev} className="mb-4">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide"
                       style={{ color: SEV[sev].text }}>{SEV[sev].label}</div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {list.map((f) => <Finding key={f.key} f={f} onMonth={openMonth} />)}
                  </div>
                </div>
              );
            })}
            {(ov.findings || []).some((f) => f.severity === 'note') && (
              <>
                <button onClick={() => setShowNotes((v) => !v)}
                        className="text-sm font-medium underline" style={{ color: 'var(--text-muted)' }}>
                  {showNotes ? 'Hide' : 'Show'} the {(ov.findings || []).filter((f) => f.severity === 'note').length} limits
                  of the records — these are not errors, but they change how the figures above should be read
                </button>
                {showNotes && (
                  <div className="mt-3 grid gap-3 lg:grid-cols-2">
                    {(ov.findings || []).filter((f) => f.severity === 'note')
                      .map((f) => <Finding key={f.key} f={f} onMonth={openMonth} />)}
                  </div>
                )}
              </>
            )}
          </Card>

          {/* month by month */}
          <Card className="p-5">
            <div className="mb-1 text-base font-semibold" style={{ color: 'var(--text-heading)' }}>
              Month by month
            </div>
            <p className="mb-4 text-sm" style={{ color: 'var(--text-muted)' }}>
              Cast the way the sales summary is cast: sales, less RTO and refunds, net, and then what was
              realised against it. <span className="font-medium">Recoverable</span> is the position at that
              month end. Click any row for the month in full.
            </p>
            <YearTable ov={ov} onMonth={openMonth} />
            <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Every month above ties to its own schedules and its bridge from the GSTR-1 workbooks to the
              payment reconciliation closes to nil. The two months marked <span className="font-medium">no
              payment file</span> carry complete sales and returns; no receivable is reported for them because
              no payment reconciliation was produced, not because nothing is owed.
            </p>
          </Card>
        </>
      )}

      {/* ── the records held ──────────────────────────────────────────── */}
      {!loading && view === 'input' && inputScreen}

      {!loading && view === 'month' && monthLoading && (
        <div className="py-16 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" />
          <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
            Building {monthLabel(month)}…
          </p>
        </div>
      )}

      {/* ── empty ─────────────────────────────────────────────────────── */}
      {!loading && !ov && !ovLoading && (
        <>
          <div className="glass-card" style={{ padding: 20 }}>
            <Inbox className="mb-3 h-8 w-8" style={{ color: AGENT.color, opacity: 0.4 }} />
            <div style={{ ...TITLE, fontSize: 16 }}>
              Nothing read yet
            </div>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Once the records are in, this page shows what was sold, what was taxed, what was collected
              and what is still owed — each figure traceable to the file it came from, and every total
              checked against its own parts.
            </p>
          </div>
          {inputScreen}
        </>
      )}

      {/* ── which month, and what to download ─────────────────────────── */}
      {!loading && view === 'month' && (monthsHeld || []).length > 0 && (
            <Card className="p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wide"
                      style={{ color: 'var(--text-muted)' }}>Statement</span>
                <div className="flex rounded-lg border p-0.5" style={{ borderColor: 'var(--card-border)' }}>
                  {[['one', 'One month', CalendarDays], ['many', 'Several months', Layers]].map(([k, lbl, Ic]) => (
                    <button key={k}
                            onClick={() => { setMode(k); if (k === 'many' && !picks.length)
                                             setPicks((monthsHeld || []).map((x) => x.month)); }}
                            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                              mode === k ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                      <Ic className="h-3.5 w-3.5" />{lbl}
                    </button>
                  ))}
                </div>
                {mode === 'many' && (
                  <div className="ml-auto flex items-center gap-2">
                    <button onClick={() => setPicks((monthsHeld || []).map((x) => x.month))}
                            className="text-xs underline" style={{ color: 'var(--text-muted)' }}>all</button>
                    <button onClick={() => setPicks([])}
                            className="text-xs underline" style={{ color: 'var(--text-muted)' }}>none</button>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5">

                {(monthsHeld || []).map((x) => {
                  const on = mode === 'one' ? month === x.month : picks.includes(x.month);
                  return (
                    <button key={x.month}
                            onClick={() => mode === 'one'
                              ? setMonth(x.month)
                              : setPicks((p) => p.includes(x.month) ? p.filter((m) => m !== x.month) : [...p, x.month])}
                            title={x.hasPayment ? `${int(x.orders)} orders`
                                                : 'No payment reconciliation for this month — sales and returns only'}
                            className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                              on ? 'border-slate-800 bg-slate-800 text-white' : 'hover:bg-slate-50'}`}
                            style={on ? {} : { borderColor: 'var(--card-border)' }}>
                      {monthLabel(x.month)}
                      {!x.hasPayment && (
                        <span className={`ml-1.5 rounded px-1 py-px text-[10px] font-semibold ${
                          on ? 'bg-white/20' : 'bg-amber-100 text-amber-800'}`}>no payment file</span>
                      )}
                    </button>
                  );
                })}
              </div>

              {mode === 'many' && (
                <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3"
                     style={{ borderColor: 'var(--card-border)' }}>
                  <Button onClick={handleBundle} disabled={bundling || !picks.length}
                          className="bg-slate-800 hover:bg-slate-900">
                    {bundling ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Building…</>
                              : <><Package className="mr-2 h-4 w-4" /> Download {picks.length} statement{picks.length === 1 ? '' : 's'}
                                  {picks.length > 1 ? ' + consolidated' : ''}</>}
                  </Button>
                  <span className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
                    A zip holding one statement per month{picks.length > 1 ? ', plus a consolidated statement with the month-by-month table' : ''}.
                    {picks.some((m) => !((monthsHeld || []).find((x) => x.month === m) || {}).hasPayment)
                      && ' Months without a payment reconciliation carry their sales and returns and state plainly that no receivable is reported.'}
                  </span>
                </div>
              )}
            </Card>
      )}

      {/* nothing chosen yet — say so rather than show a blank page */}
      {!loading && view === 'month' && !month && !monthLoading && (
        <Card className="p-8 text-center">
          <CalendarDays className="mx-auto mb-3 h-7 w-7 text-slate-300" />
          <div className="text-base font-semibold" style={{ color: 'var(--text-heading)' }}>
            Choose a month above
          </div>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            A month opens its full statement — the position at the month end, the sales cast by
            registration, the bridge to the payment reconciliation, and every schedule behind them.
            The year as a whole is on <button onClick={() => setView('year')} className="underline">the
            year</button>.
          </p>
        </Card>
      )}

      {!loading && view === 'month' && s && !monthLoading && (
        <>
          {/* ── header ──────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Off Duty · Statement of trade receivables
              </div>
              <div className="mt-0.5 text-xl font-semibold" style={{ color: 'var(--text-heading)' }}>
                As on {s.asAt}
                <span className="ml-3 text-sm font-normal" style={{ color: 'var(--text-muted)' }}>
                  {s.periods.join(', ')} · {int(s.orders)} orders · {s.entities.filter((e) => !e.includes('+')).join(', ')}
                </span>
              </div>
            </div>
            <Button onClick={handleBuild} disabled={building} className="bg-slate-800 hover:bg-slate-900">
              {building ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Building…</>
                        : <><Download className="mr-2 h-4 w-4" /> Download the statement</>}
            </Button>
          </div>

          {s.receivableNote && (
            <div className="rounded-xl border px-4 py-3 text-sm"
                 style={{ borderColor: '#FCA5A5', background: '#FFF1F2', color: '#9F1239' }}>
              <span className="font-semibold">No receivable is reported for this month.</span>{' '}
              {s.receivableNote} The sales and returns below are complete; the collection figures are
              nil because there is no record, not because nothing is owed.
            </div>
          )}

          {/* ── the numbers that matter ─────────────────────────────── */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat icon={Scale} label={`Trade receivables`} value={money(s.position.receivable)}
                  accent="#B45309" big
                  sub={`Delivered by ${s.asAt}, realised later or not at all. Up to ${money(s.position.receivableUpperBound)} if the undated receipts fell after the date.`} />
            <Stat icon={Truck} label="Goods in transit" value={money(s.position.inTransit)}
                  sub="Dispatched within the period, delivered thereafter. Not a trade receivable on a delivery basis." />
            <Stat icon={Banknote} label="Total recoverable" value={money(s.position.totalOwed)}
                  sub="Trade receivables plus goods in transit." />
            <Stat icon={ClipboardList} label="Unrealised as on date" value={money(s.stillShortToday)}
                  sub="A recovery list, not a month-end figure — most collections had arrived by the date of preparation, though not by the reporting date." />
          </div>

          {/* ── checks ──────────────────────────────────────────────── */}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            <CheckPill label="Collection channels rebuild the remittance" value={s.checks.collectors} />
            <CheckPill label="Status split rebuilds gross orders" value={s.checks.statusSplit} />
            <CheckPill label="Channel split rebuilds trade receivables" value={s.checks.receivableSplit} />
            <CheckPill label="Registrations rebuild trade receivables" value={s.checks.entitySplit} />
            <CheckPill label="Every order under one head only" value={s.checks.positionSplit} />
          </div>

          {/* ── the month at a glance, cast like the year ───────────── */}
          <Card className="p-5">
            <div className="mb-1 text-base font-semibold" style={{ color: 'var(--text-heading)' }}>
              {monthLabel(month)} — registration by registration
            </div>
            <p className="mb-4 text-sm" style={{ color: 'var(--text-muted)' }}>
              The same table the year carries, with a row per GST registration instead of a row per
              month. <span className="font-medium">Recoverable</span> is the position at {s.asAt}.
            </p>
            <MonthTable s={s} />
          </Card>

          {/* ── what needs attention IN THIS MONTH ──────────────────── */}
          {(s.limits || []).length > 0 && (
            <Card className="p-5">
              <div className="mb-1 flex items-center gap-2 text-base font-semibold"
                   style={{ color: 'var(--text-heading)' }}>
                <AlertTriangle className="h-4 w-4 text-amber-500" /> What needs attention in {monthLabel(month)}
              </div>
              <p className="mb-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                Everything found in this month, largest first — the same headings the year uses, so the
                two never call one thing by two names.
              </p>
              {['critical', 'attention'].map((sev) => {
                const list = (s.limits || []).filter((l) => l.severity === sev);
                if (!list.length) return null;
                return (
                  <div key={sev} className="mb-4">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide"
                         style={{ color: SEV[sev].text }}>{SEV[sev].label}</div>
                    <div className="grid gap-3 lg:grid-cols-2">
                      {list.map((f) => <Finding key={f.key} f={f} onMonth={openMonth} />)}
                    </div>
                  </div>
                );
              })}
              {(s.limits || []).some((l) => l.severity === 'note') && (
                <>
                  <button onClick={() => setShowNotes((v) => !v)}
                          className="text-sm font-medium underline" style={{ color: 'var(--text-muted)' }}>
                    {showNotes ? 'Hide' : 'Show'} the {(s.limits || []).filter((l) => l.severity === 'note').length} limits
                    of the records for this month
                  </button>
                  {showNotes && (
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      {(s.limits || []).filter((l) => l.severity === 'note')
                        .map((f) => <Finding key={f.key} f={f} onMonth={openMonth} />)}
                    </div>
                  )}
                </>
              )}
            </Card>
          )}

          {/* ── tabs ────────────────────────────────────────────────── */}
          <div className="mt-2 text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
            The statement in full
          </div>
          <div className="flex gap-1 border-b" style={{ borderColor: 'var(--card-border)' }}>
            {TABS.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)}
                      className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
                        tab === t.key ? 'border-slate-800 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* ── the position ────────────────────────────────────────── */}
          {tab === 'position' && (
            <Card className="p-5">
              <Tbl caption={`E.  Amounts unsettled as on ${s.asAt}`} colour={CLR.due}
                   cols={['Particulars', 'No. of orders', 'Amount (₹)', 'Remarks']}
                   rows={[
                     ['Delivered on or before the reporting date, realised subsequently',
                      int(P.RECEIVABLE_LATE?.orders), rup(P.RECEIVABLE_LATE?.amount),
                      'The goods were with the customer and the money was not. Recovered since.'],
                     ['Delivered on or before the reporting date, not realised',
                      int(P.RECEIVABLE_UNPAID?.orders), rup(P.RECEIVABLE_UNPAID?.amount),
                      'No realisation received against these at all.'],
                     ['Trade receivables (sundry debtors)', int(s.position.receivable != null
                        ? (P.RECEIVABLE_LATE?.orders || 0) + (P.RECEIVABLE_UNPAID?.orders || 0) : null),
                      rup(s.position.receivable), 'Recoverable from customers on the reporting date.', 'total'],
                     ['Realised, but date of receipt not recorded',
                      int(P.RECEIVABLE_UNDATED?.orders), rup(P.RECEIVABLE_UNDATED?.amount),
                      'The money came but no date is recorded, so it cannot be placed either side of the date.'],
                     ['Maximum, if the above are treated as unrealised', '',
                      rup(s.position.receivableUpperBound), 'The figure above is the minimum.', 'total'],
                     ['Goods in transit — dispatched within the period, delivered thereafter',
                      int(P.IN_TRANSIT?.orders), rup(P.IN_TRANSIT?.amount),
                      'Include only where revenue is recognised on dispatch.'],
                     ['Total amount recoverable', '', rup(s.position.totalOwed),
                      'Trade receivables plus goods in transit.', 'total'],
                   ]} />
              <Tbl caption="Trade receivables — collection channel wise" colour={CLR.due}
                   cols={['Collection channel', 'No. of orders', 'Amount recoverable (₹)']} dense
                   rows={[...(s.receivableSplit || []).map((r) => [r.label, int(r.orders), rup(r.receivable)]),
                          ['Total', int((s.receivableSplit || []).reduce((a, r) => a + r.orders, 0)),
                           rup(s.position.receivable), 'total']]} />
              <div className="text-sm font-semibold" style={{ color: 'var(--text-heading)' }}>Schedules</div>
              <p className="mb-3 mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                Each is a tab in the workbook with the order numbers. Click to see them here.
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(s.worklists || []).map((w) => (
                  <button key={w.key} onClick={() => openSched(w.key, w.label)}
                          className="group flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition hover:border-slate-400 hover:bg-slate-50"
                          style={{ borderColor: 'var(--card-border)' }}>
                    <span className="text-sm" style={{ color: 'var(--text-heading)' }}>{w.label}</span>
                    <span className="flex items-center gap-1 text-sm font-semibold tabular-nums"
                          style={{ color: 'var(--text-muted)' }}>
                      {int(w.rows)}
                      <ChevronRight className="h-3.5 w-3.5 opacity-0 transition group-hover:opacity-100" />
                    </span>
                  </button>
                ))}
              </div>
            </Card>
          )}

          {/* ── sales ───────────────────────────────────────────────── */}
          {tab === 'sales' && s.gst && (
            <Card className="p-5">
              <p className="mb-4 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Cast from the delivered, refund and RTO sheets of each registration's GSTR-1 workbook.
                Other channels in those workbooks — Nykaa, Myntra, Slikk, B2B and the stores — are not
                included. Agrees with the Sales Summary of each workbook.
              </p>
              {[...s.gst.blocks, ...(s.gst.consolidated ? [s.gst.consolidated] : [])].map((blk) => (
                <Tbl key={blk.entity}
                     caption={`Off Duty : Summary of Shopify Sales — ${STATE_NAME[blk.entity] || blk.entity}`}
                     colour={CLR.sales} dense
                     cols={['Particulars', 'Taxable', 'CGST', 'SGST', 'IGST', 'Invoice value']}
                     rows={[
                       ['Shopify', ...HEADS.map((h) => rup(blk.sales[h])), rup(inv(blk.sales))],
                       ['Shopify- Rto', ...HEADS.map((h) => rup(blk.rto[h])), rup(inv(blk.rto))],
                       ['Shopify- Refunded', ...HEADS.map((h) => rup(blk.refund[h])), rup(inv(blk.refund))],
                       ['Net Sales', ...HEADS.map((h) => rup(blk.net[h])), rup(inv(blk.net)), 'total'],
                     ]} />
              ))}
            </Card>
          )}

          {/* ── reconciliation ──────────────────────────────────────── */}
          {tab === 'recon' && br && (
            <Card className="p-5">
              <Tbl caption="C.  What Shopify delivered, against what the GSTR-1 workbooks taxed"
                   colour={CLR.recon} cols={['Particulars', 'No. of orders', 'Amount (₹)', 'Remarks']}
                   rows={[
                     ['Delivered — per Shopify', int(br.payDelivered.orders), rup(br.payDelivered.amount),
                      'Every Shopify order marked delivered, whether taxed or not.'],
                     ['Delivered — per the GSTR-1 workbooks', int(br.salesDelivered.orders),
                      rup(br.salesDelivered.amount), 'The part of the above that reached a GSTR-1 workbook.'],
                     ['Difference to be explained', int(br.payDelivered.orders - br.salesDelivered.orders),
                      rup(br.payDelivered.amount - br.salesDelivered.amount),
                      'Both lines are the SAME Shopify orders. The difference is not sales from anywhere else.',
                      'total'],
                   ]} />
              <Tbl caption="Explained by" colour={CLR.recon}
                   cols={['Particulars', 'No. of orders', 'Amount (₹)', 'Remarks']}
                   rows={[
                     ['Orders Shopify does not call delivered, but the workbooks taxed as delivered',
                      int(-br.salesOnly.orders), rup(-br.salesOnly.amount),
                      'Returns and RTOs in Shopify, still taxed as sales.'],
                     ['Orders only part delivered', '0', rup(br.partDelivered.amount),
                      `${int(br.partDelivered.orders)} orders, in both records — so the count does not change, only the value. The workbook taxes the lines delivered; Shopify carries the whole order.`],
                     ['Orders in Shopify appearing in no GSTR-1 workbook', int(br.payOnly.orders),
                      rup(br.payOnly.amount),
                      'Delivered and realised, but their order numbers appear on no sheet of any workbook.'],
                     ['Total explained', int(br.payDelivered.orders - br.salesDelivered.orders),
                      rup(br.payDelivered.amount - br.salesDelivered.amount), '', 'total'],
                     ['Difference (to be Nil)', '0', rup(br.difference), '', 'ok'],
                   ]} />
              <Tbl caption="D.  Collections against delivered sales" colour={CLR.cash}
                   cols={['Particulars', 'No. of orders', 'Amount (₹)', 'Remarks']}
                   rows={[
                     ['Delivered — per Shopify', int(br.payDelivered.orders), rup(br.payDelivered.amount),
                      'As above.'],
                     ['Less: collections received', '', rup(-br.collections),
                      'Money received through all five collection channels.'],
                     ['Unsettled', int((s.worklists || []).find((w) => w.key === 'unsettled')?.rows),
                      rup(br.unsettled),
                      'Every one of these is on the "Unsettled Orders" schedule with the reason it is short.',
                      'total'],
                   ]} />
            </Card>
          )}

          {/* ── notes ───────────────────────────────────────────────── */}
          {tab === 'notes' && (
            <Card className="p-5">
              <p className="mb-4 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Each matter below is a separate schedule in the workbook, giving the order numbers.
                No amount has been adjusted, netted off or excluded.
              </p>
              <Tbl caption="F.  Notes and qualifications" colour={CLR.notes}
                   cols={['Particulars', 'No. of orders', 'Amount (₹)', 'Amount is / remarks']}
                   rows={(s.limits || []).map((l) => [
                     l.label, int(l.orders), rup(l.amount),
                     <span key={l.key}>
                       {l.basis && <span className="mr-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">{l.basis}</span>}
                       {l.why}
                     </span>,
                   ])} />
            </Card>
          )}

          {/* ── records ─────────────────────────────────────────────── */}
          {tab === 'records' && recordsPanel}
        </>
      )}

      {/* ── what was read, after an upload ──────────────────────────── */}
      {uploadReport && (
        <Card className="p-5">
          <div className="mb-3 flex items-start justify-between">
            <div>
              <div className="text-base font-semibold" style={{ color: 'var(--text-heading)' }}>Records read</div>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Each sheet, the row its header was found on, and the number of lines read.
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setUploadReport(null)}><X className="h-4 w-4" /></Button>
          </div>
          <div className="space-y-3">
            {uploadReport.files.map((f) => (
              <div key={f.file} className="rounded-xl border p-3" style={{ borderColor: 'var(--card-border)' }}>
                <div className="mb-1.5 flex flex-wrap items-center gap-2 text-sm font-medium"
                     style={{ color: 'var(--text-heading)' }}>
                  <FileSpreadsheet className="h-4 w-4 text-slate-400" />{f.file}
                  {f.entity && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{f.entity}</span>}
                  {f.kind && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{f.kind}</span>}
                </div>
                {f.error ? <div className="text-sm text-rose-700">{f.error}</div> : (
                  <table className="w-full text-sm">
                    <tbody>
                      {(f.tabs || []).map((t) => (
                        <tr key={t.tab} className="border-t" style={{ borderColor: '#F1F5F9' }}>
                          <td className="py-1">{t.tab}</td>
                          <td className="py-1 text-xs" style={{ color: 'var(--text-muted)' }}>{t.kind}</td>
                          <td className="py-1 text-xs" style={{ color: 'var(--text-muted)' }}>header at row {t.headerRow}</td>
                          <td className="py-1 text-right font-medium tabular-nums">{int(t.rows)}</td>
                        </tr>
                      ))}
                      {(f.skipped || []).map((sk) => (
                        <tr key={sk.tab} className="border-t text-xs" style={{ borderColor: '#F1F5F9', color: '#94A3B8' }}>
                          <td className="py-1">{sk.tab}</td>
                          <td className="py-1" colSpan={3}>skipped — {sk.why}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── clearing everything is confirmed on its own, with the counts ── */}
      <Dialog open={confirmReset} onOpenChange={(o) => !o && setConfirmReset(false)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Clear the records and start a new run?</DialogTitle></DialogHeader>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            This removes <span className="font-semibold" style={{ color: 'var(--text-heading)' }}>
            {int(files.reduce((a, f) => a + (f.rows || 0), 0))} lines from {int(files.length)} workbooks</span>
            {monthsHeld.length > 0 && <> covering {monthsHeld.length} month{monthsHeld.length === 1 ? '' : 's'}</>},
            and deletes the uploaded workbooks themselves. To work on this data again it would
            have to be read in again.
          </p>
          {/* The distinction the button used to get wrong: the run goes, the
              reports do not. */}
          <div className="rounded-lg border px-3 py-2.5 text-sm leading-relaxed"
               style={{ borderColor: '#A7F3D0', background: '#ECFDF5', color: '#065F46' }}>
            <span className="font-semibold">
              {reports.length > 0
                ? `Your ${reports.length} report${reports.length === 1 ? '' : 's'} stay.`
                : 'Reports are never cleared by this.'}
            </span>{' '}
            They stay readable on screen, and any whose workbook has been produced stays
            downloadable. Removing a report is its own button, on its own row.
          </div>
          <p className="text-sm font-medium" style={{ color: '#9F1239' }}>
            Clearing the records cannot be undone.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmReset(false)} disabled={resetting}>Keep them</Button>
            <Button onClick={handleReset} disabled={resetting} className="bg-rose-600 hover:bg-rose-700">
              {resetting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Clearing…</>
                         : <><Trash2 className="mr-2 h-4 w-4" /> Clear everything</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── schedule ────────────────────────────────────────────────── */}
      <Dialog open={!!sched} onOpenChange={(o) => !o && setSched(null)}>
        <DialogContent className="max-w-7xl">
          <DialogHeader><DialogTitle>{sched?.label}</DialogTitle></DialogHeader>
          {schedLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
          ) : (
            <div className="max-h-[68vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0" style={{ background: 'var(--surface)' }}>
                  <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    <th className="pb-2">Order no.</th><th className="pb-2">Registration</th>
                    <th className="pb-2">Delivered</th><th className="pb-2">Realised on</th>
                    <th className="pb-2">Channel</th>
                    <th className="pb-2 text-right">Invoice value</th>
                    <th className="pb-2 text-right">Realised</th>
                    <th className="pb-2 text-right">Recoverable</th>
                    <th className="pb-2">Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {schedRows.map((r) => (
                    <tr key={r.order_id} className="border-t align-top" style={{ borderColor: 'var(--card-border)' }}>
                      <td className="py-1.5 font-mono text-xs">{r.order_id}</td>
                      <td className="py-1.5 text-xs">{r.entity || '—'}</td>
                      <td className="py-1.5 text-xs">{r.delivered_date || '—'}</td>
                      <td className="py-1.5 text-xs">{r.payment_date || '—'}</td>
                      <td className="py-1.5 text-xs">{r.collector || '—'}</td>
                      <td className="py-1.5 text-right tabular-nums">{rup(r.billed)}</td>
                      <td className="py-1.5 text-right tabular-nums">{rup(r.collected)}</td>
                      <td className="py-1.5 text-right font-medium tabular-nums">{rup(r.owed)}</td>
                      <td className="max-w-[420px] py-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                        {r.unsettled_reason || r.remark}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {schedRows.length >= 500 && (
                <p className="py-3 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
                  First 500 shown — the workbook carries the complete schedule.
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ReceivablesSummaryWorkspace;

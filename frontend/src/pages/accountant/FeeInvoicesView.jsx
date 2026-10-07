/* ── Fee invoices vs the settlement ───────────────────────────────────────
   Amazon takes its fees out of the settlement, then raises a tax invoice for
   the same fees. One question: is every rupee it took backed by a document?

   TWO SUB-TABS, and the missing third is deliberate:
     As Amazon bills       the posted date - the only basis that ties
     Against the month's   the cohort, and where a fee drifts to the next
       own sales           month's invoice
   A release-date view was designed and dropped: it answers a bank question,
   not an invoice question, and a red figure there is never an over-charge.
   The data layer still dates cash that way, so it can come back unchanged.

   THE DRILL SITS ABOVE THE TABLE, not below it. It first rendered underneath,
   which meant picking a month at the top of a seventeen-row table scrolled the
   answer off the screen - the accountant clicked and saw nothing happen.

   The invoice names eleven fees. The settlement names four money columns and
   never says which fee is which. So the page matches TOTALS and says plainly
   that a kind-by-kind match needs the weekly ledgers - rather than inventing
   a mapping that would look authoritative and be wrong. */

import React, { useMemo, useState, useEffect } from 'react';
import { FileText, Receipt, AlertTriangle, Info, X } from 'lucide-react';

const T = {
  ink: '#232F3E', amber: '#FF9900', amberText: '#8A5200', blue: '#146EB4',
  green: '#067647', red: '#B42318', slate: '#64748B',
};

const inr = (n, dp = 2) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('en-IN',
      { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const int = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
              'September', 'October', 'November', 'December'];
const label = (m) => {
  const [y, mm] = String(m || '').split('-');
  return mm ? `${MON[+mm - 1]} '${String(y).slice(2)}` : m;
};
const longLabel = (m) => {
  const [y, mm] = String(m || '').split('-');
  return mm ? `${FULL[+mm - 1]} ${y}` : m;
};

const BUCKETS = [
  ['selling', 'Commission on', 'selling fees', false],
  ['fba', 'Delivery and', 'fba fees', false],
  ['otherTxn', 'Closing and', 'other transaction fees', false],
  ['storage', 'Storage and', 'other', true],
];

function Card({ children, tone = '#E2E8F0', bg = '#fff', className = '' }) {
  return (
    <div className={`rounded-xl border ${className}`} style={{ borderColor: tone, background: bg }}>
      {children}
    </div>
  );
}

/* ── re-aggregate for the period the picker is showing ───────────────────
   The tab first rendered `fees.totals`, which is the WHOLE run - so narrowing
   the period at the top changed nothing on this tab while every other tab
   moved. Totals are recomputed from the rows the period actually covers. */
function agg(fees, shown) {
  if (!fees) return null;
  const sel = new Set(shown && shown.length ? shown : fees.rows.map((r) => r.month));
  const rows = fees.rows.filter((r) => sel.has(r.month));
  const sum = (k) => r2(rows.reduce((a, r) => a + (r[k] || 0), 0));
  const comparable = rows.filter((r) => r.invoiced !== null && !r.basisMismatch);
  const kinds = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.byKind || {})) kinds[k] = r2((kinds[k] || 0) + v);
  }
  const totals = {
    invoiced: sum('invoiced'), took: sum('took'),
    selling: sum('selling'), fba: sum('fba'), otherTxn: sum('otherTxn'), storage: sum('storage'),
    invoiceFee: sum('invoiceFee'), invoiceGst: sum('invoiceGst'),
    ownOrderFees: sum('ownOrderFees'), billedLater: sum('billedLater'),
    billedHere: sum('billedHere'), outsideOrderFile: sum('outsideOrderFile'),
    documents: rows.reduce((a, r) => a + r.documents, 0),
    invoiceCount: rows.reduce((a, r) => a + r.invoiceCount, 0),
    creditNotes: rows.reduce((a, r) => a + r.creditNotes, 0),
    settlementRows: rows.reduce((a, r) => a + r.settlementRows, 0),
    monthsTying: rows.filter((r) => r.ties).length,
    comparableMonths: comparable.length,
    unexplained: r2(comparable.reduce((a, r) => a + (r.diff || 0), 0)),
    basisMonths: rows.filter((r) => r.basisMismatch).map((r) => r.month),
  };
  totals.diff = r2(totals.took - totals.invoiced);
  totals.basisGap = r2(rows.filter((r) => r.basisMismatch)
    .reduce((a, r) => a + (r.diff || 0), 0));
  return { ...fees, rows, totals, kinds };
}

function Empty({ source }) {
  return (
    <Card tone="#FCD9A8" bg="#FFFBF3" className="p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 mt-0.5" style={{ color: T.amberText }} />
        <div>
          <div className="text-sm font-bold" style={{ color: T.amberText }}>
            No fee invoices have been read for this brand
          </div>
          <p className="text-[13px] mt-1.5 leading-relaxed" style={{ color: '#5B4A2E' }}>
            Upload Amazon&rsquo;s monthly fee tax invoices (the PDFs, one folder per month) and this
            page will put them against what the settlement actually took.
            {source && source.error ? <> <strong>The reader failed:</strong> {source.error}</> : null}
          </p>
        </div>
      </div>
    </Card>
  );
}

function Provenance({ fees, mode }) {
  const t = fees.totals;
  const src = fees.source || {};
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
      <Card tone="#BFDBFE" bg="#F6FAFF" className="p-3">
        <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: T.blue }}>
          {mode === 'posted' ? 'Side A — what Amazon invoiced' : 'The invoice column'}
        </div>
        <div className="font-mono text-[11px] mt-1.5 px-1.5 py-1 rounded inline-block"
             style={{ background: '#E6F0FA', color: '#1F2430' }}>
          invoices / &lt;YYYY-MM&gt; / *.pdf
        </div>
        <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: '#334155' }}>
          <strong>{int(t.documents)} documents</strong> &mdash; {int(t.invoiceCount)} tax invoices and{' '}
          {int(t.creditNotes)} credit notes. Each PDF&rsquo;s{' '}
          <span className="font-mono text-[10.5px]">Total:</span> line is read once and the GST split
          at 18%; a credit note subtracts.
        </p>
      </Card>

      <Card tone="#FCD9A8" bg="#FFFCF6" className="p-3">
        <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: T.amberText }}>
          {mode === 'posted' ? 'Side B — what Amazon actually took' : 'The fee columns'}
        </div>
        <div className="font-mono text-[11px] mt-1.5 px-1.5 py-1 rounded inline-block"
             style={{ background: '#FBEEDC', color: '#1F2430' }}>
          settlement &rsaquo; selling + fba + other transaction fees
        </div>
        <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: '#44403C' }}>
          <strong>{int(t.settlementRows)} fee-bearing rows.</strong> Four columns and nothing else,
          plus <span className="font-mono text-[10.5px]">other</span> on{' '}
          <span className="font-mono text-[10.5px]">FBA Inventory Fee</span> rows. Overlapping Date
          Range Reports are de-duplicated across files; a genuinely repeated payment inside one file
          is kept.
        </p>
      </Card>

      <Card className="p-3" bg="#F8FAFC">
        <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: T.slate }}>
          {mode === 'posted' ? 'How the two are lined up' : 'Which month a fee belongs to'}
        </div>
        <p className="text-[11.5px] mt-2 leading-relaxed" style={{ color: '#475569' }}>
          {mode === 'posted' ? (
            <>A row belongs to the month in its{' '}
              <span className="font-mono text-[10.5px] px-1 rounded" style={{ background: '#EDF2F7' }}>date/time</span>{' '}
              column &mdash; <strong>the day Amazon recorded the charge</strong>, which is the day it
              bills it. Nothing is re-dated or netted.</>
          ) : (
            <>A fee belongs to the month its <strong>order sold in</strong> &mdash;{' '}
              <span className="font-mono text-[10.5px] px-1 rounded" style={{ background: '#EDF2F7' }}>orders_*.tsv › purchase-date</span>,
              used on this tab only, because Koparo books on the order date. The fees that drift to
              another month&rsquo;s invoice are shown moving.</>
          )}
          {src.parsedAt
            ? <span className="block mt-1 text-[10.5px]" style={{ color: '#94A3B8' }}>
                PDFs last read {new Date(src.parsedAt).toLocaleString('en-IN')}</span>
            : null}
        </p>
      </Card>
    </div>
  );
}

function Headline({ fees }) {
  const t = fees.totals;
  const clean = Math.abs(t.unexplained) < 0.005;
  return (
    <Card tone="#86EFAC" bg="#F0FDF4" className="p-4 mb-3 ar-tie">
      <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
        <div>
          <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: T.green }}>Tax invoice</div>
          <div className="text-2xl font-bold tabular-nums" style={{ color: T.ink }}>&#8377;{inr(t.invoiced)}</div>
          <div className="text-[11px]" style={{ color: '#5B6472' }}>
            {int(t.documents)} PDFs &middot; fee &#8377;{inr(t.invoiceFee)} + GST &#8377;{inr(t.invoiceGst)}
          </div>
        </div>
        <div className="text-lg font-bold" style={{ color: '#94A3B8' }}>vs</div>
        <div>
          <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: T.green }}>Taken in the settlement</div>
          <div className="text-2xl font-bold tabular-nums" style={{ color: T.ink }}>&#8377;{inr(t.took)}</div>
          <div className="text-[11px]" style={{ color: '#5B6472' }}>order-wise fees <strong>+ storage &amp; removals</strong></div>
        </div>
        <div className="ml-auto text-right pl-6 border-l" style={{ borderColor: '#BBF7D0' }}>
          <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: T.green }}>Unexplained</div>
          <div className="text-[27px] font-bold tabular-nums leading-tight"
               style={{ color: clean ? T.green : T.amberText }}>&#8377;{inr(t.unexplained)}</div>
          <div className="text-[11px] mt-0.5" style={{ color: '#3F5B4D' }}>
            across {t.comparableMonths} comparable month{t.comparableMonths === 1 ? '' : 's'} &middot;{' '}
            {t.monthsTying} tie exactly
          </div>
        </div>
      </div>
      {(t.basisMonths || []).length ? (
        <div className="mt-3 pt-2.5 border-t text-[11.5px] leading-relaxed"
             style={{ borderColor: '#BBF7D0', color: '#3F5B4D' }}>
          <strong>{(t.basisMonths || []).map(label).join(' and ')}</strong>{' '}
          {(t.basisMonths || []).length > 1 ? 'are' : 'is'} held out of that figure
          (&#8377;{inr(t.basisGap)}). Those months were restored from retained settlement ledgers,
          which carry the date Amazon <strong>released</strong> the money, not the date it recorded
          the charge &mdash; so they hold a fortnight of the previous month&rsquo;s tail and cannot
          tie to an invoice however good the data is.
        </div>
      ) : null}
    </Card>
  );
}

/* ── the step-by-step walk, for whichever month is open ─────────────────── */
function Walk({ row }) {
  const steps = [
    ['Fees on ' + longLabel(row.month).split(' ')[0] + '’s orders', row.ownOrderFees, '#1F2430',
     'every fee Amazon charged on an order sold that month', '−'],
    ['Billed on a later invoice', row.billedLater, T.red,
     'the fee exists — Amazon recorded it the next month', '+'],
    ['Billed here, sold earlier', row.billedHere, T.blue,
     'earlier orders whose fee Amazon recorded in this month', '+'],
    ['Storage & removals', row.storage, T.amberText,
     'billed for the month, not for an order', row.outsideOrderFile ? '+' : '='],
  ];
  if (row.outsideOrderFile) {
    steps.push(['Orders outside our order file', row.outsideOrderFile, '#94A3B8',
      'the order report does not reach these orders', '=']);
  }
  steps.push(['= what Amazon billed', row.took, T.green,
    row.invoiced !== null && row.ties ? 'matches the invoice to the paisa'
      : row.invoiced !== null ? `against an invoice of ₹${inr(row.invoiced)}` : 'no invoice read', '']);

  return (
    <Card tone="#86EFAC" bg="#F0FDF4" className="p-3.5 ar-rise">
      <div className="text-[10.5px] font-bold uppercase tracking-wider mb-2.5" style={{ color: T.green }}>
        {longLabel(row.month)}, step by step &mdash; click any month below to open its own walk
      </div>
      <div className="flex items-stretch flex-wrap gap-y-3">
        {steps.map(([k, v, c, note, op], i) => (
          <React.Fragment key={k}>
            <div className="flex-1 min-w-[150px] px-3"
                 style={i === steps.length - 1
                   ? { background: '#DCFCE7', borderRadius: 9, padding: '6px 14px' } : undefined}>
              <div className="text-[11px] font-semibold leading-snug" style={{ color: c }}>{k}</div>
              <div className="text-[19px] font-bold tabular-nums mt-0.5" style={{ color: c }}>
                {v < 0 ? '−' : ''}&#8377;{inr(Math.abs(v))}
              </div>
              <div className="text-[10px] mt-0.5 leading-snug" style={{ color: '#6B7B74' }}>{note}</div>
            </div>
            {op ? <div className="flex items-center text-[17px] font-bold px-0.5"
                       style={{ color: '#9CC9AE' }}>{op}</div> : null}
          </React.Fragment>
        ))}
      </div>
    </Card>
  );
}

/* ── the month drill-down: the documents, and how the settlement gets there ── */
function MonthDetail({ row, onClose }) {
  const kinds = Object.entries(row.byKind || {}).sort((a, b) => b[1] - a[1]);
  const maxKind = Math.max(1, ...kinds.map(([, v]) => v));
  const docs = row.docs || [];
  const maxDoc = Math.max(1, ...docs.map((d) => Math.abs(d.total)));
  const inFrom = Object.entries(row.carryInFrom || {});
  const outTo = Object.entries(row.carryOutTo || {});

  return (
    <div className="ar-rise mb-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[15px] font-bold" style={{ color: T.ink }}>
          {longLabel(row.month)}
          <span className="ml-2 text-[11.5px] font-medium" style={{ color: '#94A3B8' }}>
            {row.invoiceCount} tax invoice{row.invoiceCount === 1 ? '' : 's'}, {row.creditNotes} credit
            note{row.creditNotes === 1 ? '' : 's'} &middot; {int(row.settlementRows)} settlement rows over{' '}
            {int(row.settlementOrders)} orders
          </span>
        </h3>
        <button onClick={onClose} className="flex items-center gap-1 text-[11.5px] px-2 py-1 rounded hover:bg-slate-100"
                style={{ color: '#64748B' }}>
          <X className="h-3.5 w-3.5" /> close
        </button>
      </div>

      <div className="mb-3"><Walk row={row} /></div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card tone="#BFDBFE" className="overflow-hidden">
          <div className="px-4 py-2" style={{ background: '#EFF6FF', borderBottom: '1px solid #DBEAFE' }}>
            <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: T.blue }}>
              The documents
            </div>
            <div className="text-[10.5px]" style={{ color: '#475569' }}>
              one tax invoice per state, plus any credit note
              {row.unreadable ? ` · ${row.unreadable} could not be read` : ''}
            </div>
          </div>
          <div style={{ maxHeight: 290, overflowY: 'auto' }}>
            {docs.length ? docs.map((d) => (
              <div key={d.number + d.total} className="flex items-center gap-2 px-4 py-1.5"
                   style={{ borderBottom: '1px solid #F3F6F9', background: d.creditNote ? '#FFFBFA' : undefined }}>
                <span className="flex-1 min-w-0">
                  <span className="block text-[12.5px] font-semibold truncate" style={{ color: '#1F2430' }}>{d.number}</span>
                  <span className="block text-[10px]" style={{ color: '#8A93A3' }}>
                    {d.state}{d.creditNote ? ' · credit note' : ''}{d.date ? ` · ${d.date}` : ''}
                  </span>
                </span>
                <span className="w-24 h-1.5 rounded-sm overflow-hidden" style={{ background: '#F1F3F6' }}>
                  <span className="ar-bar block h-full rounded-sm"
                        style={{ width: `${(100 * Math.abs(d.total)) / maxDoc}%`,
                                 background: d.creditNote ? T.red : T.blue, opacity: 0.75 }} />
                </span>
                <span className="w-28 text-right text-[12.5px] tabular-nums font-medium"
                      style={{ color: d.creditNote ? T.red : '#1F2430' }}>
                  {d.total < 0 ? '−' : ''}&#8377;{inr(Math.abs(d.total))}
                </span>
              </div>
            )) : (
              <div className="px-4 py-3 text-[12px]" style={{ color: '#94A3B8' }}>No invoice read for this month.</div>
            )}
          </div>
          <div className="flex items-center px-4 py-2 text-[12.5px] font-bold"
               style={{ background: '#EFF6FF', borderTop: '1px solid #DBEAFE' }}>
            <span className="flex-1">Net charged</span>
            <span className="tabular-nums" style={{ color: T.blue }}>&#8377;{inr(row.invoiced)}</span>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="px-4 py-2" style={{ background: '#F8FAFC', borderBottom: '1px solid #E8ECF1' }}>
            <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: '#475569' }}>
              What Amazon billed for
            </div>
            <div className="text-[10.5px]" style={{ color: '#8A93A3' }}>before GST, before credit notes</div>
          </div>
          <div style={{ maxHeight: 290, overflowY: 'auto' }}>
            {kinds.length ? kinds.map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 px-4 py-1.5" style={{ borderBottom: '1px solid #F3F6F9' }}>
                <span className="flex-1 text-[12.5px]" style={{ color: '#1F2430' }}>{k}</span>
                <span className="w-24 h-1.5 rounded-sm overflow-hidden" style={{ background: '#F1F3F6' }}>
                  <span className="ar-bar block h-full rounded-sm"
                        style={{ width: `${(100 * v) / maxKind}%`, background: T.blue, opacity: 0.7 }} />
                </span>
                <span className="w-28 text-right text-[12.5px] tabular-nums" style={{ color: '#1F2430' }}>&#8377;{inr(v)}</span>
              </div>
            )) : <div className="px-4 py-3 text-[12px]" style={{ color: '#94A3B8' }}>—</div>}
          </div>
          <div className="px-4 py-2" style={{ background: '#F8FAFC', borderTop: '1px solid #E8ECF1' }}>
            {[['Fee lines on the invoices', row.invoiceFee, '#334155'],
              ['GST on the fees', row.invoiceGst, '#334155'],
              ['Net charged', row.invoiced, T.blue]].map(([k, v, c], i) => (
              <div key={k} className="flex items-center text-[12.5px]"
                   style={{ fontWeight: i === 2 ? 700 : 500, color: c }}>
                <span className="flex-1">{k}</span>
                <span className="tabular-nums">&#8377;{inr(v)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {(inFrom.length || outTo.length) ? (
        <Card tone="#FCD9A8" bg="#FFFBF3" className="px-4 py-2 mt-3 text-[11.5px] leading-relaxed"
              style={{ color: '#5B4A2E' }}>
          {outTo.length ? <div><strong>Billed later:</strong>{' '}
            {outTo.map(([m, v]) => `₹${inr(v)} on ${label(m)}'s invoice`).join(', ')}</div> : null}
          {inFrom.length ? <div><strong>Billed here, sold earlier:</strong>{' '}
            {inFrom.map(([m, v]) => `₹${inr(v)} from ${label(m)}`).join(', ')}</div> : null}
        </Card>
      ) : null}
    </div>
  );
}

/* ── sub-tab 1: as Amazon bills ─────────────────────────────────────────── */
const GRID = '66px 42px 1fr 46px 1fr 1fr 1fr 1fr 1fr 132px 104px';

function PostedTable({ fees, onPick, picked }) {
  const { rows, totals: t } = fees;
  const max = Math.max(1, ...rows.filter((r) => !r.basisMismatch).map((r) => Math.abs(r.diff || 0)));
  const Bar = ({ v, muted }) => {
    const w = (100 * Math.abs(v || 0)) / max;
    return (
      <span className="flex items-center w-[46px]">
        <span className="flex-1 flex justify-end">
          {v < 0 ? <span className="ar-bar block h-[7px] rounded-sm"
                         style={{ width: `${w}%`, background: muted ? '#CBD5E1' : '#F0A14B', opacity: .85 }} /> : null}
        </span>
        <span className="w-px h-3" style={{ background: '#D7DEE8' }} />
        <span className="flex-1">
          {v > 0 ? <span className="ar-bar block h-[7px] rounded-sm"
                         style={{ width: `${w}%`, background: muted ? '#CBD5E1' : '#7DADD9', opacity: .85 }} /> : null}
        </span>
      </span>
    );
  };
  return (
    <Card className="overflow-hidden">
      <div className="grid items-end gap-2 px-4 py-2 text-[9.5px] font-bold uppercase tracking-wide"
           style={{ gridTemplateColumns: GRID, background: '#F8FAFC', borderBottom: '1px solid #E8ECF1', color: '#475569' }}>
        <span>Month</span>
        <span className="text-right">Docs</span>
        <span className="text-right">Invoiced</span>
        <span className="text-right" style={{ color: '#94A3B8' }}>Rows</span>
        {BUCKETS.map(([k, name, col, amberish]) => (
          <span key={k} className="text-right" style={{ color: amberish ? T.amberText : '#475569' }}>
            {name}
            <span className="block font-mono text-[8.5px] font-normal normal-case" style={{ color: '#A7B0BD' }}>{col}</span>
          </span>
        ))}
        <span className="text-right">Total taken</span>
        <span className="text-right">Difference</span>
      </div>

      {rows.map((r) => {
        const muted = r.basisMismatch || r.invoiced === null;
        const on = picked === r.month;
        return (
          <button key={r.month} onClick={() => onPick(on ? null : r.month)}
                  className="w-full grid items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-slate-50"
                  style={{ gridTemplateColumns: GRID, borderBottom: '1px solid #F3F6F9',
                           background: on ? '#EFF6FF' : r.ties ? '#F2FBF6' : muted ? '#FAFBFC' : undefined,
                           boxShadow: on ? `inset 3px 0 0 ${T.blue}` : undefined }}>
            <span className="text-[12.5px] font-semibold" style={{ color: muted ? '#8A93A3' : '#1F2430' }}>
              {label(r.month)}
              {r.basisMismatch ? <span className="block text-[9px] font-medium" style={{ color: '#94A3B8' }}>release-dated</span> : null}
            </span>
            <span className="text-right text-[11px] tabular-nums" style={{ color: '#8A93A3' }}>{r.documents || '—'}</span>
            <span className="text-right text-[12.5px] tabular-nums font-semibold" style={{ color: T.blue }}>
              {r.invoiced === null ? '—' : `₹${inr(r.invoiced)}`}</span>
            <span className="text-right text-[10.5px] tabular-nums" style={{ color: '#A7B0BD' }}>{int(r.settlementRows)}</span>
            {BUCKETS.map(([k, , , amberish]) => (
              <span key={k} className="text-right text-[12px] tabular-nums"
                    style={{ color: amberish ? T.amberText : '#475569', fontWeight: amberish ? 600 : 400 }}>
                {r[k] ? `₹${inr(r[k])}` : '—'}</span>
            ))}
            <span className="text-right text-[12.5px] tabular-nums font-bold" style={{ color: '#1F2430' }}>₹{inr(r.took)}</span>
            <span className="flex items-center justify-end gap-1.5">
              <Bar v={r.diff} muted={muted} />
              <span className="text-[12.5px] tabular-nums font-bold text-right" style={{
                color: r.ties ? T.green : muted ? '#8A93A3' : (r.diff < 0 ? T.amberText : T.blue) }}>
                {r.invoiced === null ? '—' : r.ties ? 'tallies' : `₹${inr(r.diff)}`}</span>
            </span>
          </button>
        );
      })}

      <div className="grid items-center gap-2 px-4 py-2 text-[12px] font-bold"
           style={{ gridTemplateColumns: GRID, background: '#F8FAFC', borderTop: '1px solid #E8ECF1' }}>
        <span>{rows.length} mo</span>
        <span className="text-right text-[11px]" style={{ color: '#475569' }}>{int(t.documents)}</span>
        <span className="text-right tabular-nums" style={{ color: T.blue }}>₹{inr(t.invoiced)}</span>
        <span className="text-right text-[10px]" style={{ color: '#94A3B8' }}>{int(t.settlementRows)}</span>
        {BUCKETS.map(([k, , , amberish]) => (
          <span key={k} className="text-right text-[11.5px] tabular-nums"
                style={{ color: amberish ? T.amberText : '#475569' }}>₹{inr(t[k])}</span>
        ))}
        <span className="text-right tabular-nums">₹{inr(t.took)}</span>
        <span className="text-right tabular-nums" style={{ color: T.amberText }}>₹{inr(t.diff)}</span>
      </div>
    </Card>
  );
}

/* ── sub-tab 2: against the month's own sales ───────────────────────────── */
const CGRID = '66px 1fr 1fr 1fr 1fr 1fr 1fr 1fr 74px';

function CohortTable({ fees, onPick, picked }) {
  const { rows, totals: t } = fees;
  return (
    <Card className="overflow-hidden">
      <div className="grid items-end gap-2 px-4 py-2 text-[9.5px] font-bold uppercase tracking-wide"
           style={{ gridTemplateColumns: CGRID, background: '#F8FAFC', borderBottom: '1px solid #E8ECF1', color: '#475569' }}>
        <span>Month</span>
        <span className="text-right">Fees on its orders</span>
        <span className="text-right" style={{ color: T.red }}>&rarr; billed later</span>
        <span className="text-right" style={{ color: T.blue }}>&larr; billed here</span>
        <span className="text-right" style={{ color: T.amberText }}>Storage &amp; removals</span>
        <span className="text-right" style={{ color: '#94A3B8' }}>Outside our file</span>
        <span className="text-right">= Amazon billed</span>
        <span className="text-right">Invoice</span>
        <span className="text-right">Diff</span>
      </div>

      {rows.map((r) => {
        const on = picked === r.month;
        return (
          <button key={r.month} onClick={() => onPick(on ? null : r.month)}
                  className="w-full grid items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-slate-50"
                  style={{ gridTemplateColumns: CGRID, borderBottom: '1px solid #F3F6F9',
                           background: on ? '#EFF6FF' : r.ties ? '#F7FCF9' : undefined,
                           boxShadow: on ? `inset 3px 0 0 ${T.blue}` : undefined }}>
            <span className="text-[12.5px] font-semibold" style={{ color: '#1F2430' }}>{label(r.month)}</span>
            <span className="text-right text-[12.5px] tabular-nums" style={{ color: '#1F2430' }}>₹{inr(r.ownOrderFees)}</span>
            <span className="text-right text-[12.5px] tabular-nums" style={{ color: T.red }}>
              {r.billedLater ? `−₹${inr(Math.abs(r.billedLater))}` : '—'}</span>
            <span className="text-right text-[12.5px] tabular-nums" style={{ color: T.blue }}>
              {r.billedHere ? `₹${inr(r.billedHere)}` : '—'}</span>
            <span className="text-right text-[12.5px] tabular-nums font-semibold" style={{ color: T.amberText }}>
              {r.storage ? `₹${inr(r.storage)}` : '—'}</span>
            <span className="text-right text-[11.5px] tabular-nums" style={{ color: '#94A3B8' }}>
              {r.outsideOrderFile ? `₹${inr(r.outsideOrderFile)}` : '—'}</span>
            <span className="text-right text-[12.5px] tabular-nums font-bold" style={{ color: '#1F2430' }}>₹{inr(r.took)}</span>
            <span className="text-right text-[12.5px] tabular-nums" style={{ color: T.blue }}>
              {r.invoiced === null ? '—' : `₹${inr(r.invoiced)}`}</span>
            <span className="text-right text-[12px] tabular-nums font-bold"
                  style={{ color: r.ties ? T.green : r.basisMismatch ? '#94A3B8' : (r.diff < 0 ? T.amberText : T.blue) }}>
              {r.invoiced === null ? '—' : r.ties ? '✓' : inr(r.diff, 0)}</span>
          </button>
        );
      })}

      <div className="grid items-center gap-2 px-4 py-2 text-[12px] font-bold"
           style={{ gridTemplateColumns: CGRID, background: '#F8FAFC', borderTop: '1px solid #E8ECF1' }}>
        <span>Total</span>
        <span className="text-right tabular-nums">₹{inr(t.ownOrderFees)}</span>
        <span className="text-right tabular-nums" style={{ color: T.red }}>−₹{inr(Math.abs(t.billedLater))}</span>
        <span className="text-right tabular-nums" style={{ color: T.blue }}>₹{inr(t.billedHere)}</span>
        <span className="text-right tabular-nums" style={{ color: T.amberText }}>₹{inr(t.storage)}</span>
        <span className="text-right tabular-nums" style={{ color: '#94A3B8' }}>₹{inr(t.outsideOrderFile)}</span>
        <span className="text-right tabular-nums">₹{inr(t.took)}</span>
        <span className="text-right tabular-nums" style={{ color: T.blue }}>₹{inr(t.invoiced)}</span>
        <span className="text-right tabular-nums" style={{ color: T.amberText }}>{inr(t.diff, 0)}</span>
      </div>
    </Card>
  );
}

/* ── the view ───────────────────────────────────────────────────────────── */
export default function FeeInvoicesView({ fees: raw, shown }) {
  const [mode, setMode] = useState('posted');
  const [picked, setPicked] = useState(null);

  const fees = useMemo(() => agg(raw, shown), [raw, shown]);

  /* Narrowing the period must not leave a month open that is no longer in it. */
  useEffect(() => {
    if (picked && fees && !fees.rows.some((r) => r.month === picked)) setPicked(null);
  }, [fees, picked]);

  /* One month in the period is itself a choice - open it rather than making
     the accountant click the only row there is. */
  useEffect(() => {
    if (fees && fees.rows.length === 1) setPicked(fees.rows[0].month);
  }, [fees]);

  const row = useMemo(() => (fees && picked
    ? fees.rows.find((r) => r.month === picked) : null), [fees, picked]);

  if (!fees) {
    return (
      <Card bg="#F8FAFC" className="p-6 text-[13px]">
        <span style={{ color: '#64748B' }}>
          The fee-invoice comparison could not be built for this period.
        </span>
      </Card>
    );
  }
  const t = fees.totals;

  return (
    <div>
      <div className="mb-3">
        <h2 className="text-[19px] font-bold tracking-tight" style={{ color: T.ink }}>
          Fee invoices &mdash; {mode === 'posted'
            ? 'the tax invoice against the settlement'
            : 'against the month’s own sales'}
        </h2>
        <p className="text-[12.5px] mt-0.5" style={{ color: '#5B6472' }}>
          {mode === 'posted'
            ? 'Amazon takes its fees out of the settlement, then raises a tax invoice for the same fees. Left is what it billed, right is what it took, and the gap is the only thing to chase.'
            : 'Start from the fees on this month’s orders, move the stragglers to the month Amazon actually billed them, add what is billed for the month rather than the order — and it lands on the invoice.'}
        </p>
      </div>

      <div className="flex gap-2 mb-3">
        {[['posted', 'As Amazon bills', 'posted date — the one that ties', Receipt],
          ['cohort', 'Against the month’s sales', 'cohort — and where fees drift', FileText],
        ].map(([k, lab, sub, Ic]) => (
          <button key={k} onClick={() => setMode(k)}
                  className="px-4 py-2 rounded-lg border text-left transition-colors"
                  style={mode === k
                    ? { borderColor: T.blue, background: T.blue, color: '#fff' }
                    : { borderColor: '#E2E8F0', background: '#fff', color: '#64748B' }}>
            <span className="flex items-center gap-1.5 text-[12.5px] font-bold"><Ic className="h-3.5 w-3.5" />{lab}</span>
            <span className="block text-[10.5px] mt-0.5 opacity-80">{sub}</span>
          </button>
        ))}
      </div>

      {!fees.hasInvoices ? <Empty source={fees.source} /> : (
        <>
          <Provenance fees={fees} mode={mode} />
          {/* The drill sits ABOVE the table: picking a month at the top of a
              seventeen-row list used to push the answer below the fold. */}
          {row ? <MonthDetail row={row} onClose={() => setPicked(null)} /> : <Headline fees={fees} />}

          {mode === 'posted'
            ? <PostedTable fees={fees} onPick={setPicked} picked={picked} />
            : <CohortTable fees={fees} onPick={setPicked} picked={picked} />}

          {!row ? (
            <div className="mt-2 text-[11.5px] flex items-center gap-1.5" style={{ color: '#94A3B8' }}>
              <Info className="h-3.5 w-3.5" /> Click any month to open its invoices and the settlement rows behind them.
            </div>
          ) : null}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mt-3">
            <Card tone="#FCD9A8" bg="#FFFBF3" className="p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: T.amberText }}>
                Storage &amp; removals &mdash; charged for the month, not for an order
              </div>
              <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: '#5B4A2E' }}>
                Every other charge is attached to an order. Storage, long-term storage, removals and
                inbound transport are not &mdash; Amazon bills them for holding the goods that month,
                and many rows carry <strong>no order id at all</strong>, so the order-by-order report
                has never shown them: <strong>&#8377;{inr(t.storage)}</strong> over this period. They
                stay a <strong>cost line of their own</strong>, outside the receivable.
              </p>
            </Card>
            <Card className="p-3" bg="#F8FAFC">
              <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: T.slate }}>
                Why the invoice names eleven fees and the settlement four
              </div>
              <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: '#475569' }}>
                The <strong>invoice names every fee</strong>. The <strong>settlement does not</strong>{' '}
                &mdash; it only drops each one into a money column. So the totals can be matched today,
                and a <strong>Fixed Closing against Fixed Closing</strong> match needs the weekly
                settlement ledgers, which do name each fee.
              </p>
            </Card>
            <Card tone="#BFDBFE" bg="#F6FAFF" className="p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: T.blue }}>In neither side</div>
              <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: '#334155' }}>
                <strong>Advertising</strong> &mdash; not on these PDFs, and not in our four columns; it
                sits in <span className="font-mono text-[10.5px]">other</span> on a Service Fee row.{' '}
                <strong>GST on sales, TCS and TDS</strong> are out too &mdash; tax, not Amazon&rsquo;s
                fee. Both sides leave out the same things, which is part of why they tie.
              </p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

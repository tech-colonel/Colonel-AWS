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

   The invoice names eleven fees. The settlement names four money columns and
   never says which fee is which. So the page matches TOTALS and says plainly
   that a kind-by-kind match needs the weekly ledgers - rather than inventing
   a mapping that would look authoritative and be wrong. */

import React, { useMemo, useState } from 'react';
import { FileText, Receipt, AlertTriangle, Info } from 'lucide-react';

const T = {
  ink: '#232F3E', amber: '#FF9900', amberText: '#8A5200', blue: '#146EB4',
  green: '#067647', red: '#B42318', slate: '#64748B',
};

const inr = (n, dp = 2) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('en-IN',
      { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const int = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const label = (m) => {
  const [y, mm] = String(m || '').split('-');
  return mm ? `${MON[+mm - 1]} '${String(y).slice(2)}` : m;
};

/* The four money columns, in the words an accountant uses, with Amazon's own
   column name kept beside each so a figure can always be traced back. */
const BUCKETS = [
  ['selling', 'Commission on each sale', 'selling fees', T.ink],
  ['fba', 'Delivery and packing', 'fba fees', T.ink],
  ['otherTxn', 'Closing and other per-order fees', 'other transaction fees', T.ink],
  ['storage', 'Storage and removals', 'other, on FBA Inventory Fee rows', T.amberText],
];

function Card({ children, tone = '#E2E8F0', bg = '#fff', className = '' }) {
  return (
    <div className={`rounded-xl border ${className}`} style={{ borderColor: tone, background: bg }}>
      {children}
    </div>
  );
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
            Upload Amazon&rsquo;s monthly fee tax invoices (the PDFs, one folder per
            month) and this page will put them against what the settlement actually
            took. Until then only the settlement side is known.
            {source && source.error
              ? <> <strong>The reader failed:</strong> {source.error}</>
              : null}
          </p>
        </div>
      </div>
    </Card>
  );
}

/* ── where the two sides come from ──────────────────────────────────────── */
function Provenance({ fees, mode }) {
  const t = fees.totals;
  const src = fees.source || {};
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
      <Card tone="#BFDBFE" bg="#F6FAFF" className="p-3">
        <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: T.blue }}>
          Side A &mdash; what Amazon invoiced
        </div>
        <div className="font-mono text-[11px] mt-1.5 px-1.5 py-1 rounded inline-block"
             style={{ background: '#E6F0FA', color: '#1F2430' }}>
          invoices / &lt;YYYY-MM&gt; / *.pdf
        </div>
        <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: '#334155' }}>
          <strong>{int(t.documents)} documents</strong> &mdash; {int(t.invoiceCount)} tax
          invoices and {int(t.creditNotes)} credit notes. Each PDF&rsquo;s{' '}
          <span className="font-mono text-[10.5px]">Total:</span> line is read once and the
          GST split at 18%; a credit note subtracts.
        </p>
      </Card>

      <Card tone="#FCD9A8" bg="#FFFCF6" className="p-3">
        <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: T.amberText }}>
          Side B &mdash; what Amazon actually took
        </div>
        <div className="font-mono text-[11px] mt-1.5 px-1.5 py-1 rounded inline-block"
             style={{ background: '#FBEEDC', color: '#1F2430' }}>
          settlement &rsaquo; selling + fba + other transaction fees
        </div>
        <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: '#44403C' }}>
          <strong>{int(t.settlementRows)} fee-bearing rows.</strong> Four columns and nothing
          else, plus <span className="font-mono text-[10.5px]">other</span> on{' '}
          <span className="font-mono text-[10.5px]">FBA Inventory Fee</span> rows. Overlapping
          Date Range Reports are de-duplicated across files, and a genuinely repeated payment
          inside one file is kept.
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
              <span className="font-mono text-[10.5px] px-1 rounded" style={{ background: '#EDF2F7' }}>purchase-date</span>{' '}
              on the order report, because Koparo books on the order date. The fees that drift to
              another month&rsquo;s invoice are shown moving.</>
          )}
          {src.parsedAt
            ? <span className="block mt-1 text-[10.5px]" style={{ color: '#94A3B8' }}>
                PDFs last read {new Date(src.parsedAt).toLocaleString('en-IN')}
              </span>
            : null}
        </p>
      </Card>
    </div>
  );
}

/* ── the headline: invoiced vs taken, and what the gap is made of ───────── */
function Headline({ fees }) {
  const t = fees.totals;
  const clean = Math.abs(t.unexplained) < 0.005;
  return (
    <Card tone={clean ? '#86EFAC' : '#BBF7D0'} bg="#F0FDF4" className="p-4 mb-3 ar-tie">
      <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
        <div>
          <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: T.green }}>
            Tax invoice
          </div>
          <div className="text-2xl font-bold tabular-nums" style={{ color: T.ink }}>
            &#8377;{inr(t.invoiced)}
          </div>
          <div className="text-[11px]" style={{ color: '#5B6472' }}>
            {int(t.documents)} PDFs &middot; fee &#8377;{inr(t.invoiceFee)} + GST &#8377;{inr(t.invoiceGst)}
          </div>
        </div>
        <div className="text-lg font-bold" style={{ color: '#94A3B8' }}>vs</div>
        <div>
          <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: T.green }}>
            Taken in the settlement
          </div>
          <div className="text-2xl font-bold tabular-nums" style={{ color: T.ink }}>
            &#8377;{inr(t.took)}
          </div>
          <div className="text-[11px]" style={{ color: '#5B6472' }}>
            order-wise fees <strong>+ storage &amp; removals</strong>
          </div>
        </div>
        <div className="ml-auto text-right pl-6 border-l" style={{ borderColor: '#BBF7D0' }}>
          <div className="text-[10px] font-bold tracking-wider uppercase" style={{ color: T.green }}>
            Unexplained
          </div>
          <div className="text-[27px] font-bold tabular-nums leading-tight"
               style={{ color: clean ? T.green : T.amberText }}>
            &#8377;{inr(t.unexplained)}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: '#3F5B4D' }}>
            across {t.comparableMonths} comparable months &middot; {t.monthsTying} tie exactly
          </div>
        </div>
      </div>

      {(t.basisMonths || []).length ? (
        <div className="mt-3 pt-2.5 border-t text-[11.5px] leading-relaxed"
             style={{ borderColor: '#BBF7D0', color: '#3F5B4D' }}>
          <strong>{(t.basisMonths || []).map(label).join(' and ')}</strong> {(t.basisMonths || []).length > 1 ? 'are' : 'is'} held
          out of that figure (&#8377;{inr(t.basisGap)}). Those months were restored from retained
          settlement ledgers, which carry the date Amazon <strong>released</strong> the money, not
          the date it recorded the charge &mdash; so they hold a fortnight of the previous
          month&rsquo;s tail and cannot tie to an invoice however good the data is.
        </div>
      ) : null}
    </Card>
  );
}

/* ── sub-tab 1: as Amazon bills ─────────────────────────────────────────── */
function PostedTable({ fees, onPick, picked }) {
  const rows = fees.rows;
  const t = fees.totals;
  const max = Math.max(1, ...rows.filter((r) => !r.basisMismatch)
    .map((r) => Math.abs(r.diff || 0)));

  const Bar = ({ v, muted }) => {
    const w = (100 * Math.abs(v || 0)) / max;
    return (
      <span className="flex items-center px-2">
        <span className="flex-1 flex justify-end">
          {v < 0 ? <span className="ar-bar block h-[7px] rounded-sm"
                         style={{ width: `${w}%`, background: muted ? '#CBD5E1' : '#F0A14B', opacity: 0.85 }} /> : null}
        </span>
        <span className="w-px h-3" style={{ background: '#D7DEE8' }} />
        <span className="flex-1">
          {v > 0 ? <span className="ar-bar block h-[7px] rounded-sm"
                         style={{ width: `${w}%`, background: muted ? '#CBD5E1' : '#7DADD9', opacity: 0.85 }} /> : null}
        </span>
      </span>
    );
  };

  return (
    <Card className="overflow-hidden">
      <div className="grid items-end gap-2 px-4 py-2 text-[9.5px] font-bold uppercase tracking-wide"
           style={{ gridTemplateColumns: '70px 46px 1fr 50px 1fr 1fr 1fr 1fr 1fr 150px 1fr',
                    background: '#F8FAFC', borderBottom: '1px solid #E8ECF1', color: '#475569' }}>
        <span>Month</span>
        <span className="text-right">Docs</span>
        <span className="text-right">Invoiced</span>
        <span className="text-right" style={{ color: '#94A3B8' }}>Rows</span>
        {BUCKETS.map(([k, name, col, tone]) => (
          <span key={k} className="text-right" style={{ color: tone === T.amberText ? T.amberText : '#475569' }}>
            {name.split(' ').slice(0, 2).join(' ')}
            <span className="block font-mono text-[8.5px] font-normal normal-case"
                  style={{ color: '#A7B0BD' }}>{col.split(',')[0]}</span>
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
                  style={{ gridTemplateColumns: '70px 46px 1fr 50px 1fr 1fr 1fr 1fr 1fr 150px 1fr',
                           borderBottom: '1px solid #F3F6F9',
                           background: on ? '#EFF6FF' : r.ties ? '#F2FBF6' : muted ? '#FAFBFC' : undefined,
                           boxShadow: on ? `inset 3px 0 0 ${T.blue}` : undefined }}>
            <span className="text-[12.5px] font-semibold" style={{ color: muted ? '#8A93A3' : '#1F2430' }}>
              {label(r.month)}
              {r.basisMismatch
                ? <span className="block text-[9px] font-medium" style={{ color: '#94A3B8' }}>release-dated</span>
                : null}
            </span>
            <span className="text-right text-[11px] tabular-nums" style={{ color: '#8A93A3' }}>{r.documents || '—'}</span>
            <span className="text-right text-[12.5px] tabular-nums font-semibold" style={{ color: T.blue }}>
              {r.invoiced === null ? '—' : `₹${inr(r.invoiced)}`}
            </span>
            <span className="text-right text-[10.5px] tabular-nums" style={{ color: '#A7B0BD' }}>{int(r.settlementRows)}</span>
            {BUCKETS.map(([k, , , tone]) => (
              <span key={k} className="text-right text-[12px] tabular-nums"
                    style={{ color: tone === T.amberText ? T.amberText : '#475569',
                             fontWeight: tone === T.amberText ? 600 : 400 }}>
                {r[k] ? `₹${inr(r[k])}` : '—'}
              </span>
            ))}
            <span className="text-right text-[12.5px] tabular-nums font-bold" style={{ color: '#1F2430' }}>
              ₹{inr(r.took)}
            </span>
            <span className="flex items-center justify-end gap-2">
              <Bar v={r.diff} muted={muted} />
              <span className="text-[12.5px] tabular-nums font-bold w-[92px] text-right"
                    style={{ color: r.ties ? T.green : muted ? '#8A93A3' : (r.diff < 0 ? T.amberText : T.blue) }}>
                {r.invoiced === null ? '—' : r.ties ? 'tallies' : `₹${inr(r.diff)}`}
              </span>
            </span>
          </button>
        );
      })}

      <div className="grid items-center gap-2 px-4 py-2 text-[12px] font-bold"
           style={{ gridTemplateColumns: '70px 46px 1fr 50px 1fr 1fr 1fr 1fr 1fr 150px 1fr',
                    background: '#F8FAFC', borderTop: '1px solid #E8ECF1' }}>
        <span>{rows.length} mo</span>
        <span className="text-right text-[11px]" style={{ color: '#475569' }}>{int(t.documents)}</span>
        <span className="text-right tabular-nums" style={{ color: T.blue }}>₹{inr(t.invoiced)}</span>
        <span className="text-right text-[10px]" style={{ color: '#94A3B8' }}>{int(t.settlementRows)}</span>
        {BUCKETS.map(([k, , , tone]) => (
          <span key={k} className="text-right text-[11.5px] tabular-nums"
                style={{ color: tone === T.amberText ? T.amberText : '#475569' }}>₹{inr(t[k])}</span>
        ))}
        <span className="text-right tabular-nums">₹{inr(t.took)}</span>
        <span className="text-right tabular-nums" style={{ color: T.amberText }}>₹{inr(t.diff)}</span>
      </div>
    </Card>
  );
}

/* ── sub-tab 2: against the month's own sales ───────────────────────────── */
function CohortTable({ fees, onPick, picked }) {
  const rows = fees.rows;
  return (
    <Card className="overflow-hidden">
      <div className="grid items-end gap-2 px-4 py-2 text-[9.5px] font-bold uppercase tracking-wide"
           style={{ gridTemplateColumns: '70px 1fr 1fr 1fr 1fr 1fr 1fr 1fr',
                    background: '#F8FAFC', borderBottom: '1px solid #E8ECF1', color: '#475569' }}>
        <span>Month</span>
        <span className="text-right">Fees on its orders</span>
        <span className="text-right" style={{ color: T.red }}>&rarr; billed later</span>
        <span className="text-right" style={{ color: T.blue }}>&larr; billed here</span>
        <span className="text-right" style={{ color: T.amberText }}>Storage &amp; removals</span>
        <span className="text-right" style={{ color: '#94A3B8' }}>Outside our file</span>
        <span className="text-right">= Amazon billed</span>
        <span className="text-right">Invoice</span>
      </div>

      {rows.map((r) => {
        const on = picked === r.month;
        return (
          <button key={r.month} onClick={() => onPick(on ? null : r.month)}
                  className="w-full grid items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-slate-50"
                  style={{ gridTemplateColumns: '70px 1fr 1fr 1fr 1fr 1fr 1fr 1fr',
                           borderBottom: '1px solid #F3F6F9',
                           background: on ? '#EFF6FF' : r.ties ? '#F7FCF9' : undefined,
                           boxShadow: on ? `inset 3px 0 0 ${T.blue}` : undefined }}>
            <span className="text-[12.5px] font-semibold" style={{ color: '#1F2430' }}>{label(r.month)}</span>
            <span className="text-right text-[12.5px] tabular-nums" style={{ color: '#1F2430' }}>₹{inr(r.ownOrderFees)}</span>
            <span className="text-right text-[12.5px] tabular-nums" style={{ color: T.red }}>
              {r.billedLater ? `₹${inr(r.billedLater)}` : '—'}</span>
            <span className="text-right text-[12.5px] tabular-nums" style={{ color: T.blue }}>
              {r.billedHere ? `₹${inr(r.billedHere)}` : '—'}</span>
            <span className="text-right text-[12.5px] tabular-nums font-semibold" style={{ color: T.amberText }}>
              {r.storage ? `₹${inr(r.storage)}` : '—'}</span>
            <span className="text-right text-[11.5px] tabular-nums" style={{ color: '#94A3B8' }}>
              {r.outsideOrderFile ? `₹${inr(r.outsideOrderFile)}` : '—'}</span>
            <span className="text-right text-[12.5px] tabular-nums font-bold" style={{ color: '#1F2430' }}>₹{inr(r.took)}</span>
            <span className="text-right text-[12.5px] tabular-nums" style={{ color: T.blue }}>
              {r.invoiced === null ? '—' : `₹${inr(r.invoiced)}`}</span>
          </button>
        );
      })}
    </Card>
  );
}

/* ── the month drill-down ───────────────────────────────────────────────── */
function MonthDetail({ row }) {
  const kinds = Object.entries(row.byKind || {}).sort((a, b) => b[1] - a[1]);
  const maxKind = Math.max(1, ...kinds.map(([, v]) => v));
  const inFrom = Object.entries(row.carryInFrom || {});
  const outTo = Object.entries(row.carryOutTo || {});
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3 ar-rise">
      <Card tone="#BFDBFE" className="overflow-hidden">
        <div className="px-4 py-2" style={{ background: '#EFF6FF', borderBottom: '1px solid #DBEAFE' }}>
          <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: T.blue }}>
            {label(row.month)} &mdash; what the invoices billed for
          </div>
          <div className="text-[10.5px]" style={{ color: '#475569' }}>
            {row.invoiceCount} tax invoices, {row.creditNotes} credit notes &middot; before credit notes
          </div>
        </div>
        {kinds.length ? kinds.map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 px-4 py-1.5" style={{ borderBottom: '1px solid #F3F6F9' }}>
            <span className="flex-1 text-[12.5px]" style={{ color: '#1F2430' }}>{k}</span>
            <span className="w-24 h-1.5 rounded-sm overflow-hidden" style={{ background: '#F1F3F6' }}>
              <span className="ar-bar block h-full rounded-sm"
                    style={{ width: `${(100 * v) / maxKind}%`, background: T.blue, opacity: 0.7 }} />
            </span>
            <span className="w-28 text-right text-[12.5px] tabular-nums" style={{ color: '#1F2430' }}>₹{inr(v)}</span>
          </div>
        )) : (
          <div className="px-4 py-3 text-[12px]" style={{ color: '#94A3B8' }}>No invoice read for this month.</div>
        )}
        <div className="flex items-center px-4 py-2 text-[12.5px] font-bold"
             style={{ background: '#EFF6FF', borderTop: '1px solid #DBEAFE' }}>
          <span className="flex-1">Fee + GST</span>
          <span className="tabular-nums" style={{ color: T.blue }}>₹{inr(row.invoiced)}</span>
        </div>
      </Card>

      <Card tone="#FCD9A8" className="overflow-hidden">
        <div className="px-4 py-2" style={{ background: '#FFFBF3', borderBottom: '1px solid #FBE2BE' }}>
          <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: T.amberText }}>
            {label(row.month)} &mdash; how the settlement gets there
          </div>
          <div className="text-[10.5px]" style={{ color: '#475569' }}>
            {int(row.settlementRows)} rows over {int(row.settlementOrders)} orders
          </div>
        </div>
        {[['Fees on this month&rsquo;s own orders', row.ownOrderFees, '#1F2430'],
          ['Billed on a later month&rsquo;s invoice', row.billedLater, T.red],
          ['Earlier orders billed here', row.billedHere, T.blue],
          ['Storage &amp; removals (no order)', row.storage, T.amberText],
          ['Orders outside our order file', row.outsideOrderFile, '#94A3B8']].map(([k, v, c]) => (
          <div key={k} className="flex items-center px-4 py-1.5" style={{ borderBottom: '1px solid #F3F6F9' }}>
            <span className="flex-1 text-[12.5px]" dangerouslySetInnerHTML={{ __html: k }} style={{ color: '#475569' }} />
            <span className="text-[12.5px] tabular-nums font-medium" style={{ color: c }}>
              {v ? `₹${inr(v)}` : '—'}
            </span>
          </div>
        ))}
        <div className="flex items-center px-4 py-2 text-[12.5px] font-bold"
             style={{ background: '#FFFBF3', borderTop: '1px solid #FBE2BE' }}>
          <span className="flex-1">What Amazon took</span>
          <span className="tabular-nums" style={{ color: T.amberText }}>₹{inr(row.took)}</span>
        </div>
        {(inFrom.length || outTo.length) ? (
          <div className="px-4 py-2 text-[11px] leading-relaxed" style={{ color: '#5B4A2E', background: '#FFFDF8' }}>
            {outTo.length ? <div><strong>Billed later:</strong>{' '}
              {outTo.map(([m, v]) => `₹${inr(v)} on ${label(m)}'s invoice`).join(', ')}</div> : null}
            {inFrom.length ? <div><strong>Billed here, sold earlier:</strong>{' '}
              {inFrom.map(([m, v]) => `₹${inr(v)} from ${label(m)}`).join(', ')}</div> : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

/* ── the view ───────────────────────────────────────────────────────────── */
export default function FeeInvoicesView({ fees }) {
  const [mode, setMode] = useState('posted');
  const [picked, setPicked] = useState(null);
  const row = useMemo(() => (fees && picked
    ? fees.rows.find((r) => r.month === picked) : null), [fees, picked]);

  if (!fees) {
    return (
      <Card tone="#E2E8F0" bg="#F8FAFC" className="p-6 text-[13px]" >
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
          Fee invoices &mdash; the tax invoice against the settlement
        </h2>
        <p className="text-[12.5px] mt-0.5" style={{ color: '#5B6472' }}>
          Amazon takes its fees out of the settlement, then raises a tax invoice for the same
          fees. Left is what it billed, right is what it took, and the gap is the only thing
          to chase.
        </p>
      </div>

      <div className="flex gap-2 mb-3">
        {[['posted', 'As Amazon bills', 'posted date — the one that ties', Receipt],
          ['cohort', 'Against the month’s sales', 'where a fee drifts to the next invoice', FileText],
        ].map(([k, lab, sub, Ic]) => (
          <button key={k} onClick={() => setMode(k)}
                  className="px-4 py-2 rounded-lg border text-left transition-colors"
                  style={mode === k
                    ? { borderColor: T.blue, background: T.blue, color: '#fff' }
                    : { borderColor: '#E2E8F0', background: '#fff', color: '#64748B' }}>
            <span className="flex items-center gap-1.5 text-[12.5px] font-bold">
              <Ic className="h-3.5 w-3.5" />{lab}
            </span>
            <span className="block text-[10.5px] mt-0.5 opacity-80">{sub}</span>
          </button>
        ))}
      </div>

      {!fees.hasInvoices ? <Empty source={fees.source} /> : (
        <>
          <Provenance fees={fees} mode={mode} />
          <Headline fees={fees} />
          {mode === 'posted'
            ? <PostedTable fees={fees} onPick={setPicked} picked={picked} />
            : <CohortTable fees={fees} onPick={setPicked} picked={picked} />}
          {row ? <MonthDetail row={row} /> : (
            <div className="mt-2 text-[11.5px] flex items-center gap-1.5" style={{ color: '#94A3B8' }}>
              <Info className="h-3.5 w-3.5" /> Click any month to open its invoices and the settlement rows behind them.
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mt-3">
            <Card tone="#FCD9A8" bg="#FFFBF3" className="p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: T.amberText }}>
                Storage &amp; removals &mdash; charged for the month, not for an order
              </div>
              <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: '#5B4A2E' }}>
                Every other charge is attached to an order. Storage, long-term storage, removals
                and inbound transport are not &mdash; Amazon bills them for holding the goods that
                month, and many rows carry <strong>no order id at all</strong>, so the
                order-by-order report has never shown them: <strong>&#8377;{inr(t.storage)}</strong> over
                this period. They stay a <strong>cost line of their own</strong>, outside the
                receivable &mdash; Amazon does not deduct them from any order&rsquo;s payout.
              </p>
            </Card>
            <Card className="p-3" bg="#F8FAFC">
              <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: T.slate }}>
                Why the invoice names eleven fees and the settlement four
              </div>
              <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: '#475569' }}>
                The <strong>invoice names every fee</strong>. The <strong>settlement does not</strong> &mdash;
                it only drops each one into a money column. So the totals can be matched today, and a
                <strong> Fixed Closing against Fixed Closing</strong> match needs the weekly settlement
                ledgers, which do name each fee.
              </p>
            </Card>
            <Card tone="#BFDBFE" bg="#F6FAFF" className="p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: T.blue }}>
                In neither side
              </div>
              <p className="text-[11.5px] mt-1.5 leading-relaxed" style={{ color: '#334155' }}>
                <strong>Advertising</strong> &mdash; not on these PDFs, and not in our four columns; it
                sits in <span className="font-mono text-[10.5px]">other</span> on a Service Fee row.
                <strong> GST on sales, TCS and TDS</strong> are out too &mdash; tax, not Amazon&rsquo;s fee.
                Both sides leave out the same things, which is part of why they tie.
              </p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

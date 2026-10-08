/* ── Bank — when the money actually arrived ───────────────────────────────
   Every other tab stops at "Amazon released it". This one asks what happened
   after: did it reach the bank, and if not, who is holding it?

   ONE MONTH AT A TIME, on purpose. The bank question is asked of a statement
   period; a seventeen-month roll-up of deposits answers nothing an accountant
   would act on. The month is the last one in the period picker.

   THE MONEY BANKED IN A MONTH IS MOSTLY THE PREVIOUS MONTH'S - of July's
   2,51,925.35, only 84,016.15 was July's own sales. Panel 2 exists entirely
   to stop that cash figure being read as a cohort one. Every panel names
   which of the two it is. */

import React from 'react';
import { Landmark, AlertTriangle, Lock } from 'lucide-react';

const T = {
  ink: '#232F3E', amberText: '#8A5200', blue: '#146EB4',
  green: '#067647', red: '#B42318', slate: '#64748B',
};
const inr = (n, dp = 2) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('en-IN',
      { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const int = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
              'September', 'October', 'November', 'December'];
const label = (m) => { const [y, mm] = String(m || '').split('-'); return mm ? `${MON[+mm - 1]} '${String(y).slice(2)}` : m; };
const longLabel = (m) => { const [y, mm] = String(m || '').split('-'); return mm ? `${FULL[+mm - 1]} ${y}` : m; };
const day = (d) => { const [y, m, dd] = String(d || '').split('-'); return dd ? `${+dd} ${MON[+m - 1]} ${y}` : '—'; };

function Card({ children, tone = '#E2E8F0', bg = '#fff', className = '' }) {
  return <div className={`rounded-xl border ${className}`} style={{ borderColor: tone, background: bg }}>{children}</div>;
}

function PanelHead({ n, title, right, tone = '#475569', bg = '#F8FAFC', bd = '#E8ECF1' }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2" style={{ background: bg, borderBottom: `1px solid ${bd}` }}>
      <span className="text-[10px] font-bold" style={{ color: '#A7B0BD' }}>{n}</span>
      <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: tone }}>{title}</span>
      {right ? <span className="ml-auto">{right}</span> : null}
    </div>
  );
}

export default function BankView({ bank: all, shown }) {
  /* One month at a time. The picker chooses which: the LAST month of the
     selected period, because that is the statement an accountant is closing.
     Only months whose ledgers are held can be answered at all. */
  const avail = (all && all.available) || [];
  const wanted = (shown || []).filter((m) => avail.includes(m));
  const month = wanted.length ? wanted[wanted.length - 1] : (avail[avail.length - 1] || null);
  const bank = month && all && all.byMonth ? all.byMonth[month] : null;

  if (all && avail.length && !bank) {
    return (
      <Card tone="#FCD9A8" bg="#FFFBF3" className="p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 mt-0.5" style={{ color: T.amberText }} />
          <div>
            <div className="text-sm font-bold" style={{ color: T.amberText }}>
              No settlement ledgers for the months you have selected
            </div>
            <p className="text-[13px] mt-1.5 leading-relaxed" style={{ color: '#5B4A2E' }}>
              This view can be answered for <strong>{avail.map(longLabel).join(', ')}</strong>.
              Only the weekly settlement ledger carries a deposit date and the reserve &mdash; the
              uploaded transaction report has neither.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (!bank) {
    return (
      <Card bg="#F8FAFC" className="p-6 text-[13px]">
        <span style={{ color: '#64748B' }}>The bank view could not be built for this period.</span>
      </Card>
    );
  }

  if (!bank.hasLedgers) {
    return (
      <Card tone="#FCD9A8" bg="#FFFBF3" className="p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 mt-0.5" style={{ color: T.amberText }} />
          <div>
            <div className="text-sm font-bold" style={{ color: T.amberText }}>
              No settlement ledgers are held for {longLabel(bank.month)}
            </div>
            <p className="text-[13px] mt-1.5 leading-relaxed" style={{ color: '#5B4A2E' }}>
              This is the one view the uploaded transaction report cannot answer: it carries no
              deposit date and no reserve &mdash; those words do not appear in it. Only the weekly
              <strong> settlement ledger</strong> has <span className="font-mono text-[11px]">deposit-date</span>,
              the payout actually sent, and Amazon&rsquo;s own reserve lines.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const c = bank.cohort || {};
  const b = bank.bank || {};
  const tr = bank.transit;
  const maxWhose = Math.max(1, ...(b.whose || []).map((w) => Math.abs(w.amount)),
                            Math.abs((b.unknown && b.unknown.amount) || 0));

  return (
    <div>
      <div className="mb-3 flex items-end justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-[19px] font-bold tracking-tight flex items-center gap-2" style={{ color: T.ink }}>
            <Landmark className="h-[18px] w-[18px]" style={{ color: T.green }} />
            Bank &mdash; {longLabel(bank.month)}
          </h2>
          <p className="text-[12.5px] mt-0.5" style={{ color: '#5B6472' }}>
            What we sold, what Amazon released, what reached the bank, and what Amazon is holding
            &mdash; each one separately, and then tied together.
          </p>
        </div>
        <div className="text-[10.5px] text-right" style={{ color: '#94A3B8' }}>
          from the retained settlement ledgers<br />
          {bank.coverage.settlements} held &middot; {day(bank.coverage.from)} &ndash; {day(bank.coverage.to)}
          {avail.length > 1
            ? <span className="block">answerable for {avail.map(label).join(' · ')}</span>
            : null}
        </div>
      </div>

      {/* 1 — the cohort side */}
      <Card className="overflow-hidden mb-3">
        <PanelHead n="1" title={`What happened to ${longLabel(bank.month).split(' ')[0]}’s own sales`}
                   right={<span className="text-[10.5px]" style={{ color: '#94A3B8' }}>a COHORT view — this month’s orders</span>} />
        <div className="grid grid-cols-2 lg:grid-cols-5 divide-x" style={{ borderColor: '#F1F3F6' }}>
          {[['Sold in the month', c.sold, '#1F2430', 'invoiced in the MTR, GST included'],
            ['Amazon owed us', c.owed, '#1F2430', 'after returns, commission, TDS, TCS'],
            ['Released by month end', c.released, T.green, 'Amazon let the money go'],
            ['Still not released', c.notReleased, T.amberText, 'inside Amazon’s hold'],
            ['Held as reserve', c.heldAsReserve, T.amberText, 'released, then withheld at payout'],
          ].map(([k, v, col, note]) => (
            <div key={k} className="px-4 py-2.5">
              <div className="text-[10px] font-bold uppercase tracking-wide" style={{ color: '#8A93A3' }}>{k}</div>
              <div className="text-[19px] font-bold tabular-nums mt-0.5" style={{ color: col }}>&#8377;{inr(v)}</div>
              <div className="text-[10px] mt-0.5 leading-snug" style={{ color: '#94A3B8' }}>{note}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* 2 — the cash side */}
      <Card tone="#86EFAC" className="overflow-hidden mb-3">
        <PanelHead n="2" title={`What reached the bank during ${longLabel(bank.month).split(' ')[0]}`}
                   tone={T.green} bg="#F0FDF4" bd="#BBF7D0"
                   right={<span className="text-[15px] font-bold tabular-nums" style={{ color: T.green }}>
                     &#8377;{inr(b.banked)} <span className="text-[10.5px] font-medium" style={{ color: '#3F5B4D' }}>
                       {b.deposits} deposit{b.deposits === 1 ? '' : 's'}</span></span>} />
        <div className="flex items-center gap-2 px-4 py-1.5 text-[9.5px] font-bold uppercase tracking-wide"
             style={{ background: '#FAFDFB', borderBottom: '1px solid #F1F3F6', color: '#64748B' }}>
          <span className="flex-1">Whose sale the money was for</span>
          <span className="w-16 text-right">Orders</span>
          <span className="w-40" />
          <span className="w-32 text-right">Amount</span>
        </div>
        {(b.whose || []).map((w) => {
          const own = w.month === bank.month;
          return (
            <div key={w.month} className="flex items-center gap-2 px-4 py-1.5"
                 style={{ borderBottom: '1px solid #F3F6F9', background: own ? '#F6FAFF' : undefined }}>
              <span className="flex-1">
                <span className="text-[12.5px] font-semibold" style={{ color: '#1F2430' }}>
                  {longLabel(w.month)} sales{own ? ' — this month’s own' : ''}
                </span>
                <span className="block text-[10px]" style={{ color: '#8A93A3' }}>
                  {own ? `the only part of the ₹${inr(b.banked)} that belongs to ${label(bank.month)}`
                       : w.amount < 0 ? 'a refund taken back out of the bank'
                       : 'released earlier, swept in this month'}
                </span>
              </span>
              <span className="w-16 text-right text-[11.5px] tabular-nums" style={{ color: '#64748B' }}>{int(w.orders)}</span>
              <span className="w-40 h-1.5 rounded-sm overflow-hidden" style={{ background: '#F1F3F6' }}>
                <span className="ar-bar block h-full rounded-sm"
                      style={{ width: `${(100 * Math.abs(w.amount)) / maxWhose}%`,
                               background: w.amount < 0 ? T.red : own ? T.blue : T.green, opacity: .8 }} />
              </span>
              <span className="w-32 text-right text-[13px] tabular-nums font-bold"
                    style={{ color: w.amount < 0 ? T.red : own ? T.blue : T.green }}>
                {w.amount < 0 ? '−' : ''}&#8377;{inr(Math.abs(w.amount))}
              </span>
            </div>
          );
        })}
        {b.unknown ? (
          <div className="px-4 py-2" style={{ borderBottom: '1px solid #F3F6F9', background: '#FFFBF3' }}>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[12.5px] font-semibold" style={{ color: T.amberText }}>
                Sales from before we hold the orders
                <span className="block text-[10px] font-normal" style={{ color: '#8A6A3A' }}>
                  real orders, named by the settlement but absent from the order reports &mdash; so we
                  cannot say which month sold them, only which week paid them
                </span>
              </span>
              <span className="w-16 text-right text-[11.5px] tabular-nums" style={{ color: '#8A6A3A' }}>
                {int(b.unknown.orders)}</span>
              <span className="w-40 h-1.5 rounded-sm overflow-hidden" style={{ background: '#F1F3F6' }}>
                <span className="ar-bar block h-full rounded-sm"
                      style={{ width: `${(100 * Math.abs(b.unknown.amount)) / maxWhose}%`,
                               background: T.amber, opacity: .85 }} />
              </span>
              <span className="w-32 text-right text-[13px] tabular-nums font-bold" style={{ color: T.amberText }}>
                {b.unknown.amount < 0 ? '−' : ''}&#8377;{inr(Math.abs(b.unknown.amount))}
              </span>
            </div>
            <div className="mt-1.5 pl-3 flex flex-wrap gap-x-4 gap-y-0.5"
                 style={{ borderLeft: `2px solid ${T.amber}` }}>
              {b.unknown.byPeriod.map((w) => (
                <span key={w.start} className="text-[10.5px] tabular-nums" style={{ color: '#8A6A3A' }}>
                  settlement {day(w.start)}&ndash;{day(w.end)}
                  <span className="font-semibold"> &#8377;{inr(Math.abs(w.amount))}</span>
                  <span style={{ color: '#B08A52' }}> · {int(w.orders)} orders</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {b.noOrder ? (
          <div className="flex items-center gap-2 px-4 py-1.5" style={{ borderBottom: '1px solid #F3F6F9' }}>
            <span className="flex-1 text-[12.5px]" style={{ color: '#475569' }}>
              Fees and adjustments
              <span className="block text-[10px]" style={{ color: '#8A93A3' }}>inside those deposits, carrying no order id</span>
            </span>
            <span className="w-16 text-right text-[11.5px]" style={{ color: '#94A3B8' }}>—</span>
            <span className="w-40" />
            <span className="w-32 text-right text-[13px] tabular-nums font-bold" style={{ color: T.red }}>
              {b.noOrder < 0 ? '−' : ''}&#8377;{inr(Math.abs(b.noOrder))}
            </span>
          </div>
        ) : null}
      </Card>

      {/* 3 — the two tied together */}
      {tr ? (
        <Card tone="#FCD9A8" bg="#FFFBF3" className="overflow-hidden mb-3">
          <PanelHead n="3" title={`${longLabel(bank.month).split(' ')[0]}’s own money — released, but where is it?`}
                     tone={T.amberText} bg="#FFFBF3" bd="#FBE2BE" />
          <div className="px-4 py-1">
            {[['Released on this month’s sales', tr.released, '#1F2430', 'from panel 1', ''],
              ['Of that, reached the bank inside the month', tr.ownBanked, T.blue, 'from panel 2', '−'],
              ['Released but still not in the bank', tr.inTransit, T.amberText, 'in transit at month end', '='],
            ].map(([k, v, col, note, op], i) => (
              <div key={k} className="flex items-center gap-2 py-1.5"
                   style={{ borderBottom: i === 2 ? '1px solid #FBE2BE' : '1px solid #FDF3E3',
                            background: i === 2 ? '#FFF8EC' : undefined,
                            marginLeft: i === 2 ? -16 : 0, marginRight: i === 2 ? -16 : 0,
                            paddingLeft: i === 2 ? 16 : 0, paddingRight: i === 2 ? 16 : 0 }}>
                <span className="w-4 text-[13px] font-bold" style={{ color: '#C9A878' }}>{op}</span>
                <span className="flex-1">
                  <span className="text-[12.5px] font-semibold" style={{ color: '#1F2430' }}>{k}</span>
                  <span className="block text-[10px]" style={{ color: '#8A93A3' }}>{note}</span>
                </span>
                <span className="text-[14px] tabular-nums font-bold" style={{ color: col }}>&#8377;{inr(v)}</span>
              </div>
            ))}
            {[['of which: held back as reserve', tr.reserve, T.amberText, 'Amazon’s own line: Current Reserve Amount'],
              ['of which: ordinary settlement lag', tr.lag, '#64748B', 'released late in the month, deposited early next'],
            ].map(([k, v, col, note]) => (
              <div key={k} className="flex items-center gap-2 py-1.5 pl-6" style={{ borderBottom: '1px solid #FDF3E3' }}>
                <span className="flex-1">
                  <span className="text-[12px]" style={{ color: '#475569' }}>{k}</span>
                  <span className="block text-[10px]" style={{ color: '#A7B0BD' }}>{note}</span>
                </span>
                <span className="text-[13px] tabular-nums font-semibold" style={{ color: col }}>&#8377;{inr(v)}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* 4 — the reserve */}
      {(bank.reserveWeeks || []).length ? (
        <Card tone="#FCD9A8" className="overflow-hidden mb-3">
          <PanelHead n="4" title="The reserve, week by week" tone={T.amberText} bg="#FFFBF3" bd="#FBE2BE"
                     right={<span className="text-[10.5px]" style={{ color: '#94A3B8' }}>
                       Amazon’s own wording, from the ledger</span>} />
          <div className="grid grid-cols-1 md:grid-cols-2 divide-x" style={{ borderColor: '#FBE2BE' }}>
            {bank.reserveWeeks.map((w) => (
              <div key={w.id} className="px-4 py-2.5">
                <div className="text-[12.5px] font-bold" style={{ color: '#1F2430' }}>
                  {day(w.start)} &ndash; {day(w.end)}
                </div>
                <div className="mt-1.5 space-y-1">
                  {w.held ? (
                    <>
                      <div className="flex text-[12px]"><span className="flex-1" style={{ color: '#475569' }}>Released into this settlement</span>
                        <span className="tabular-nums">&#8377;{inr(w.held)}</span></div>
                      <div className="flex text-[12px]" style={{ color: T.amberText }}>
                        <span className="flex-1">Held back as reserve</span>
                        <span className="tabular-nums">&minus;&#8377;{inr(w.held)}</span></div>
                    </>
                  ) : null}
                  {w.returned ? (
                    <div className="flex text-[12px]" style={{ color: T.green }}>
                      <span className="flex-1">Reserve released</span>
                      <span className="tabular-nums">+&#8377;{inr(w.returned)}</span></div>
                  ) : null}
                  <div className="flex text-[12.5px] font-bold pt-1 border-t" style={{ borderColor: '#FBE2BE' }}>
                    <span className="flex-1" style={{ color: w.payout ? T.green : T.red }}>Paid to the bank</span>
                    <span className="tabular-nums" style={{ color: w.payout ? T.green : T.red }}>&#8377;{inr(w.payout)}</span>
                  </div>
                  <div className="text-[10px]" style={{ color: '#94A3B8' }}>deposited {day(w.deposit)}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* 5 — every settlement week */}
      <Card className="overflow-hidden">
        <PanelHead n="5" title="Every settlement week"
                   right={<span className="text-[10.5px]" style={{ color: '#94A3B8' }}>
                     the weeks that deposited in {label(bank.month)} are highlighted</span>} />
        <div className="flex items-center gap-2 px-4 py-1.5 text-[9.5px] font-bold uppercase tracking-wide"
             style={{ background: '#FAFBFC', borderBottom: '1px solid #F1F3F6', color: '#64748B' }}>
          <span className="flex-1">Statement period</span>
          <span className="w-24 text-right">Orders</span>
          <span className="w-32 text-right">Released</span>
          <span className="w-28 text-right">Reserve</span>
          <span className="w-32 text-right">Payout</span>
          <span className="w-28 text-right">In the bank</span>
        </div>
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {(bank.settlements || []).map((s) => (
            <div key={s.id + s.deposit} className="flex items-center gap-2 px-4 py-1.5"
                 style={{ borderBottom: '1px solid #F3F6F9',
                          background: s.inMonth ? '#F6FAFF' : undefined,
                          boxShadow: s.inMonth ? `inset 3px 0 0 ${T.blue}` : undefined }}>
              <span className="flex-1">
                <span className="text-[12.5px] font-semibold" style={{ color: s.inMonth ? '#1F2430' : '#64748B' }}>
                  {day(s.start)} &ndash; {day(s.end)}
                </span>
                <span className="block font-mono text-[9.5px]" style={{ color: '#A7B0BD' }}>settlement {s.id}</span>
              </span>
              <span className="w-24 text-right text-[11px] tabular-nums" style={{ color: '#94A3B8' }}>{int(s.orders)}</span>
              <span className="w-32 text-right text-[12px] tabular-nums" style={{ color: '#475569' }}>&#8377;{inr(s.released)}</span>
              <span className="w-28 text-right text-[12px] tabular-nums"
                    style={{ color: s.reserve ? T.amberText : '#CBD5E1', fontWeight: s.reserve ? 600 : 400 }}>
                {s.reserve ? `−₹${inr(s.reserve)}` : '—'}</span>
              <span className="w-32 text-right text-[12.5px] tabular-nums font-bold"
                    style={{ color: s.payout > 0 ? T.green : s.payout < 0 ? T.red : '#94A3B8' }}>&#8377;{inr(s.payout)}</span>
              <span className="w-28 text-right text-[11.5px]" style={{ color: '#64748B' }}>{day(s.deposit)}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card tone="#BFDBFE" bg="#F6FAFF" className="p-3 mt-3">
        <div className="flex items-start gap-2">
          <Lock className="h-4 w-4 mt-0.5 flex-shrink-0" style={{ color: T.blue }} />
          <p className="text-[11.5px] leading-relaxed" style={{ color: '#334155' }}>
            <strong>Only the settlement ledger can answer this.</strong> The uploaded transaction
            report has no deposit date and no reserve &mdash; neither word appears in it. The ledger
            carries <span className="font-mono text-[10.5px]">deposit-date</span>, the payout actually
            sent, and Amazon&rsquo;s own <em>Current Reserve Amount</em> / <em>Previous Reserve Amount
            Balance</em> lines, which is why this view exists only for the weeks whose ledgers are
            held. <strong>Released is not banked:</strong> the sweep lands a day or two after the
            release, and a whole week&rsquo;s payout can be withheld.
          </p>
        </div>
      </Card>
    </div>
  );
}

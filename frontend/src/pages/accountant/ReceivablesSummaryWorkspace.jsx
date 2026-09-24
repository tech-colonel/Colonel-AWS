/* Receivables Summary — the workspace.
   This file belongs to this agent alone; nothing else imports it, so the
   Amazon settlement agent and every other workspace are untouched by anything
   in here. The API calls are the ones the agent already exposes.

   The page is laid out like the workbook it produces — same lettered tables,
   same colours — so a figure on screen and a figure in the file look alike as
   well as read alike. */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  Upload, FileText, Download, Trash2, Loader2, CheckCircle2, AlertTriangle,
  FileSpreadsheet, X, ChevronRight, Scale, Banknote, Truck, ClipboardList, Inbox,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import api from '../../lib/api';
import { toast } from 'sonner';
import { format } from 'date-fns';

/* The workbook's palette, so the two match. */
const CLR = { sales: '#FFF7CC', returns: '#FCE4D6', recon: '#DDEBF7', cash: '#E2EFDA',
              due: '#FFE1E1', notes: '#EDEDED' };
const STATE_NAME = { HR: 'Haryana', KAR: 'Karnataka', MH: 'Maharashtra' };
const HEADS = ['taxable_value', 'cgst', 'sgst', 'igst'];

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
  const [sched, setSched] = useState(null);
  const [schedRows, setSchedRows] = useState([]);
  const [schedLoading, setSchedLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [f, s] = await Promise.all([api.get(`${base}/files`), api.get(`${base}/summary`)]);
      setFiles(f.data?.files || []);
      setSummary(s.data?.empty ? null : s.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load the receivables data');
    } finally { setLoading(false); }
  }, [base]);

  useEffect(() => { refresh(); }, [refresh]);

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
      const res = await api.post(`${base}/workbook`);
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

  const openSched = async (key, label) => {
    setSched({ key, label }); setSchedLoading(true); setSchedRows([]);
    try {
      const res = await api.get(`${base}/ledger`, { params: { worklist: key, limit: 500 } });
      setSchedRows(res.data.rows || []);
    } catch (e) { toast.error('Could not load that schedule'); }
    finally { setSchedLoading(false); }
  };

  const handleDelete = async (filename) => {
    try {
      await api.delete(`${base}/files/${encodeURIComponent(filename)}`);
      toast.success('Removed'); refresh();
    } catch (e) { toast.error('Could not remove that record'); }
  };

  const s = summary;
  const br = s?.bridge;
  const P = useMemo(() => {
    const m = {};
    (s?.byPosition || []).forEach((p) => { m[p.key] = p; });
    return m;
  }, [s]);

  /* ── upload panel, used empty and on the Records tab ──────────────────── */
  const uploadPanel = (
    <Card className="p-5">
      <div className="mb-1 flex items-center gap-2 text-base font-semibold" style={{ color: 'var(--text-heading)' }}>
        <Upload className="h-4 w-4" /> Records to be produced
      </div>
      <p className="mb-4 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        The GSTR-1 workbook of each registration and the payment reconciliation for the month. Only the
        delivered, refund and RTO sheets are read; every other sheet pertains to a different sales channel
        and is excluded. Upload them together — each is identified from its contents.
      </p>
      <Input type="file" multiple accept=".xlsx,.xls"
             onChange={(e) => setPicked(Array.from(e.target.files || []))} />
      {picked.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          {picked.map((f) => (
            <li key={f.name} className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 shrink-0 text-slate-400" />
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-slate-400">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
            </li>
          ))}
        </ul>
      )}
      <Button onClick={handleUpload} disabled={uploading || !picked.length} className="mt-4 w-full">
        {uploading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reading…</>
                   : <><Upload className="mr-2 h-4 w-4" /> Read {picked.length || ''} record(s)</>}
      </Button>
    </Card>
  );

  return (
    <div className="space-y-6" data-testid="receivables-summary-workspace">
      {loading && <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>}

      {/* ── empty ─────────────────────────────────────────────────────── */}
      {!loading && !s && (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">{uploadPanel}</div>
          <Card className="lg:col-span-2 p-6">
            <Inbox className="mb-3 h-8 w-8 text-slate-300" />
            <div className="text-base font-semibold" style={{ color: 'var(--text-heading)' }}>
              Nothing read yet
            </div>
            <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Once the records are in, this page shows what was sold, what was taxed, what was collected
              and what is still owed — each figure traceable to the file it came from, and every total
              checked against its own parts.
            </p>
          </Card>
        </div>
      )}

      {!loading && s && (
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
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <CheckPill label="Collection channels rebuild the remittance" value={s.checks.collectors} />
            <CheckPill label="Status split rebuilds gross orders" value={s.checks.statusSplit} />
            <CheckPill label="Channel split rebuilds trade receivables" value={s.checks.receivableSplit} />
            <CheckPill label="Every order under one head only" value={s.checks.positionSplit} />
          </div>

          {/* ── tabs ────────────────────────────────────────────────── */}
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
          {tab === 'records' && (
            <div className="grid gap-6 lg:grid-cols-5">
              <div className="lg:col-span-2">{uploadPanel}</div>
              <Card className="lg:col-span-3 p-5">
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
            </div>
          )}
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

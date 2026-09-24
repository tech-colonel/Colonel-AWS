/* Receivables Summary — the workspace.
   Built alongside the Amazon settlement workspace, never on top of it: the
   Amazon agent keeps its own page and its own routes, untouched. */
import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  Upload, FileText, Download, Trash2, Loader2, CheckCircle2, AlertTriangle,
  FileSpreadsheet, ListChecks, X,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import api from '../../lib/api';
import { toast } from 'sonner';
import { format } from 'date-fns';

const money = (n) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));

const STATE_NAME = { HR: 'Haryana', KAR: 'Karnataka', MH: 'Maharashtra' };
const HEADS = ['taxable_value', 'cgst', 'sgst', 'igst'];
const rup = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }));

/* The GST sales summary, laid out as the accountant's own working already has
   it: sales, less returns, net — by registration, across the four heads. */
const SalesSummaryBlock = ({ block, caption }) => (
  <div className="mb-6">
    <div className="mb-1 text-sm font-semibold text-slate-800">{caption}</div>
    <table className="w-full border border-slate-300 text-sm">
      <thead>
        <tr style={{ background: '#FFF7CC' }}>
          <th className="border border-slate-300 px-3 py-1.5 text-left font-semibold">Particulars</th>
          {['Taxable', 'CGST', 'SGST', 'IGST'].map((h) => (
            <th key={h} className="border border-slate-300 px-3 py-1.5 text-center font-semibold">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {[
          ['Shopify', block.sales, false],
          ['Total Sales', block.sales, true],
          [null],
          ['Shopify- Rto', block.rto, false],
          ['Shopify- Refunded', block.refund, false],
          ['Total Return', block.totalReturn, true],
          [null],
          ['Net Sales', block.net, true],
        ].map(([label, o, bold], i) => (
          label === null
            ? <tr key={i}><td colSpan={5} className="h-2" /></tr>
            : (
              <tr key={i} className={bold ? 'font-semibold' : ''}>
                <td className="border-x border-slate-300 px-3 py-1">{label}</td>
                {HEADS.map((h) => (
                  <td key={h} className="border-x border-slate-300 px-3 py-1 text-right tabular-nums">
                    {rup(o[h])}
                  </td>
                ))}
              </tr>
            )
        ))}
      </tbody>
    </table>
  </div>
);

const Kpi = ({ label, value, sub, tone }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-4">
    <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
    <div className={`mt-1 text-2xl font-semibold ${tone || 'text-slate-900'}`}>{value}</div>
    {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
  </div>
);

/* A check is the whole point of the sheet, so it is shown as a check — pass or
   fail with the number — never as a silent success. */
const Check = ({ label, value }) => {
  const ok = Math.abs(Number(value) || 0) < 0.005;
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
      ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{label}<span className="ml-2 font-mono font-semibold">{Number(value || 0).toFixed(2)}</span></span>
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
  const [worklist, setWorklist] = useState(null);
  const [worklistRows, setWorklistRows] = useState([]);
  const [worklistLoading, setWorklistLoading] = useState(false);

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
      toast.success(`${int(res.data.stored)} rows read from ${res.data.files.length} file(s)`);
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
      toast.error(e.response?.data?.error || 'Could not build the workbook');
    } finally { setBuilding(false); }
  };

  const openWorklist = async (key, label) => {
    setWorklist({ key, label }); setWorklistLoading(true); setWorklistRows([]);
    try {
      const res = await api.get(`${base}/ledger`, { params: { worklist: key, limit: 500 } });
      setWorklistRows(res.data.rows || []);
    } catch (e) {
      toast.error('Could not load that worklist');
    } finally { setWorklistLoading(false); }
  };

  const handleDelete = async (filename) => {
    try {
      await api.delete(`${base}/files/${encodeURIComponent(filename)}`);
      toast.success('Removed');
      refresh();
    } catch (e) { toast.error('Could not remove that file'); }
  };

  return (
    <div className="space-y-6" data-testid="receivables-summary-workspace">
      {/* ── upload ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Upload className="h-5 w-5" /> Records to be produced</CardTitle>
          <CardDescription>
            Upload the GST sales register of each registration and the payment reconciliation for the month.
            Only the delivered, refund and RTO sheets are read; every other sheet pertains to a different
            sales channel and is excluded. All of them may be uploaded together — each is identified from
            its contents.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input type="file" multiple accept=".xlsx,.xls"
                 onChange={(e) => setPicked(Array.from(e.target.files || []))} />
          {picked.length > 0 && (
            <ul className="space-y-1 text-sm text-slate-600">
              {picked.map((f) => (
                <li key={f.name} className="flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-slate-400" />
                  {f.name}<span className="text-slate-400">({(f.size / 1024 / 1024).toFixed(1)} MB)</span>
                </li>
              ))}
            </ul>
          )}
          <Button onClick={handleUpload} disabled={uploading || !picked.length} className="w-full">
            {uploading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reading…</>
                       : <><Upload className="mr-2 h-4 w-4" /> Read {picked.length || ''} file(s)</>}
          </Button>
        </CardContent>
      </Card>

      {/* what was actually read — shown, not assumed */}
      {uploadReport && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle>Records read</CardTitle>
              <CardDescription>Each sheet, the row at which its header was found, and the number of lines read.</CardDescription>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setUploadReport(null)}><X className="h-4 w-4" /></Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {uploadReport.files.map((f) => (
              <div key={f.file} className="rounded-lg border border-slate-200 p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-800">
                  <FileSpreadsheet className="h-4 w-4 text-slate-400" />
                  {f.file}
                  {f.entity && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{f.entity}</span>}
                  {f.kind && <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{f.kind}</span>}
                </div>
                {f.error ? <div className="text-sm text-rose-700">{f.error}</div> : (
                  <table className="w-full text-sm">
                    <tbody>
                      {(f.tabs || []).map((t) => (
                        <tr key={t.tab} className="border-t border-slate-100">
                          <td className="py-1 text-slate-700">{t.tab}</td>
                          <td className="py-1 text-slate-500">{t.kind}</td>
                          <td className="py-1 text-slate-500">header at row {t.headerRow}</td>
                          <td className="py-1 text-right font-medium text-slate-800">{int(t.rows)} rows</td>
                        </tr>
                      ))}
                      {(f.skipped || []).map((s) => (
                        <tr key={s.tab} className="border-t border-slate-100 text-slate-400">
                          <td className="py-1">{s.tab}</td>
                          <td className="py-1" colSpan={3}>skipped — {s.why}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {loading && <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>}

      {!loading && summary && (
        <>
          {summary.gst && (
            <Card>
              <CardHeader>
                <CardTitle>
                  Off Duty : Summary of Shopify Sales for {summary.periods.join(', ')}
                </CardTitle>
                <CardDescription>
                  Cast from the delivered, refund and RTO sheets of each registration's GST sales
                  register. Other sales channels in those workbooks — Nykaa, Myntra, Slikk, B2B and the
                  stores — are not included. Agrees with the Sales Summary of each workbook.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {summary.gst.blocks.map((blk) => (
                  <SalesSummaryBlock key={blk.entity} block={blk}
                                     caption={STATE_NAME[blk.entity] || blk.entity} />
                ))}
                {summary.gst.consolidated && (
                  <SalesSummaryBlock block={summary.gst.consolidated}
                                     caption="All registrations — consolidated" />
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Kpi label={`Trade receivables as on ${summary.asAt}`} value={money(summary.position.receivable)}
                 tone="text-amber-700" sub="delivered within the period, realised later or not at all" />
            <Kpi label="Maximum trade receivables" value={money(summary.position.receivableUpperBound)}
                 sub={`includes ${money(summary.position.uncertain)} whose period of realisation is unascertained`} />
            <Kpi label="Goods in transit" value={money(summary.position.inTransit)}
                 sub="dispatched within the period, delivered thereafter" />
            <Kpi label="Total amount recoverable" value={money(summary.position.totalOwed)}
                 sub="trade receivables plus goods in transit" />
          </div>

          {/* The number people reach for by mistake, named as what it is. */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <span className="font-medium">Unrealised as on date: {money(summary.stillShortToday)}</span>
            {' '}— amounts remaining unrealised on the date of this statement, after the recovery already
            effected. This is a recovery schedule and not the figure of trade receivables as on the
            reporting date: most collections had been received by the date of preparation, though not by
            the reporting date. Stating it as trade receivables would understate the position.
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Verification</CardTitle>
              <CardDescription>
                No stated total is accepted on its own. Each of the following aggregates a figure from its
                constituents, and the difference must be Nil.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 md:grid-cols-2">
              <Check label="Collection-channel columns aggregate to the remittance stated" value={summary.checks.collectors} />
              <Check label="Status-wise break-up aggregates to gross orders" value={summary.checks.statusSplit} />
              <Check label="Channel-wise break-up aggregates to trade receivables" value={summary.checks.receivableSplit} />
              <Check label="Every order classified under one head only" value={summary.checks.positionSplit} />
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Statement of trade receivables as on {summary.asAt}</CardTitle>
                <CardDescription>
                  Trade receivables are stated as at a date. Every order is classified under one head only.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Particulars</TableHead><TableHead className="text-right">No. of orders</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {summary.byPosition.map((p) => (
                      <TableRow key={p.key}>
                        <TableCell className="font-medium">{p.label}</TableCell>
                        <TableCell className="text-right">{int(p.orders)}</TableCell>
                        <TableCell className="text-right">{money(p.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Trade receivables — collection channel wise</CardTitle>
                <CardDescription>The party from whom recovery is due, and the amount.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Collection channel</TableHead><TableHead className="text-right">No. of orders</TableHead>
                    <TableHead className="text-right">Amount recoverable</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {summary.receivableSplit.map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="font-medium">{r.label}</TableCell>
                        <TableCell className="text-right">{int(r.orders)}</TableCell>
                        <TableCell className={`text-right ${r.receivable > 0 ? 'font-semibold text-amber-700' : ''}`}>
                          {money(r.receivable)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-600" /> Notes and qualifications
              </CardTitle>
              <CardDescription>
                Each of the matters below is annexed as a separate schedule in the workbook, giving the
                order numbers. No amount has been adjusted, netted off or excluded.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Particulars</TableHead><TableHead className="text-right">No. of orders</TableHead>
                  <TableHead className="text-right">Amount</TableHead><TableHead>Remarks</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {summary.limits.map((l) => (
                    <TableRow key={l.key}>
                      <TableCell className="font-medium align-top">{l.label}</TableCell>
                      <TableCell className="text-right align-top">{int(l.orders)}</TableCell>
                      <TableCell className="text-right align-top">{money(l.amount)}</TableCell>
                      <TableCell className="max-w-xl text-xs text-slate-500">{l.why}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ListChecks className="h-5 w-5" /> Schedules</CardTitle>
              <CardDescription>Click any schedule to see the orders comprising it.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {summary.worklists.map((w) => (
                <button key={w.key} onClick={() => openWorklist(w.key, w.label)}
                        className="rounded-lg border border-slate-200 p-3 text-left transition hover:border-slate-400 hover:bg-slate-50">
                  <div className="text-sm font-medium text-slate-800">{w.label}</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">{int(w.rows)}</div>
                  <div className="text-xs text-slate-500">orders</div>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Generate the statement</CardTitle>
              <CardDescription>
                The statement, the order ledger, a schedule for each matter reported, and a basis of
                preparation naming the record behind every figure. Percentages and totals are live formulas.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={handleBuild} disabled={building} className="w-full bg-slate-700 hover:bg-slate-800">
                {building ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Building…</>
                          : <><Download className="mr-2 h-4 w-4" /> Build &amp; download</>}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {!loading && !summary && !uploadReport && (
        <Card><CardContent className="py-10 text-center text-slate-600">
          <FileText className="mx-auto mb-3 h-10 w-10 text-slate-300" />
          No records produced yet. Upload the GST sales registers and the payment reconciliation to begin.
        </CardContent></Card>
      )}

      {/* ── files held ─────────────────────────────────────────────────── */}
      {files.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Records on hand</CardTitle>
            <CardDescription>Removing a record withdraws its lines from every figure above.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow>
                <TableHead>Record</TableHead><TableHead>Read as</TableHead><TableHead>Registration</TableHead>
                <TableHead>Period</TableHead><TableHead className="text-right">Lines</TableHead>
                <TableHead>Uploaded</TableHead><TableHead />
              </TableRow></TableHeader>
              <TableBody>
                {files.map((f) => (
                  <TableRow key={f.filename}>
                    <TableCell className="max-w-[240px] truncate text-sm text-slate-600">{f.filename}</TableCell>
                    <TableCell className="text-sm">{f.kinds.join(', ')}</TableCell>
                    <TableCell className="text-sm">{f.entities.join(', ') || '—'}</TableCell>
                    <TableCell className="text-sm">{f.periods.join(', ') || '—'}</TableCell>
                    <TableCell className="text-right text-sm">{int(f.rows)}</TableCell>
                    <TableCell className="text-sm text-slate-500">
                      {f.uploadedAt ? format(new Date(f.uploadedAt), 'dd MMM yyyy HH:mm') : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="destructive" onClick={() => handleDelete(f.filename)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* ── worklist modal ─────────────────────────────────────────────── */}
      <Dialog open={!!worklist} onOpenChange={(o) => !o && setWorklist(null)}>
        <DialogContent className="max-w-6xl">
          <DialogHeader><DialogTitle>{worklist?.label}</DialogTitle></DialogHeader>
          {worklistLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
          ) : (
            <div className="max-h-[65vh] overflow-auto">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Order no.</TableHead><TableHead>Registration</TableHead><TableHead>Order date</TableHead>
                  <TableHead>Order status</TableHead><TableHead>Collection channel</TableHead><TableHead>Place of supply</TableHead>
                  <TableHead className="text-right">Invoice value</TableHead><TableHead className="text-right">Realised</TableHead>
                  <TableHead className="text-right">Recoverable</TableHead>
                  <TableHead className="min-w-[320px]">Basis</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {worklistRows.map((r) => (
                    <TableRow key={r.order_id}>
                      <TableCell className="font-mono text-sm">{r.order_id}</TableCell>
                      <TableCell className="text-sm">{r.entity || '—'}</TableCell>
                      <TableCell className="text-sm">{r.order_date || '—'}</TableCell>
                      <TableCell className="text-sm">{r.status || '—'}</TableCell>
                      <TableCell className="text-sm">{r.collector || '—'}</TableCell>
                      <TableCell className="text-sm">{r.shipping_state || '—'}</TableCell>
                      <TableCell className="text-right text-sm">{money(r.billed)}</TableCell>
                      <TableCell className="text-right text-sm">{money(r.collected)}</TableCell>
                      <TableCell className="text-right text-sm font-medium">{money(r.owed)}</TableCell>
                      <TableCell className="text-xs text-slate-600">{r.remark}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {worklistRows.length >= 500 && (
                <p className="py-3 text-center text-xs text-slate-500">
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

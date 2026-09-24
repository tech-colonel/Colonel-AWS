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
          <CardTitle className="flex items-center gap-2"><Upload className="h-5 w-5" /> Source files</CardTitle>
          <CardDescription>
            Upload the sales workbook for each GST registration and the payment reconciliation for the month.
            Only the delivered, refund and RTO tabs are read — every other tab belongs to a different sales
            channel and is left alone. You can drop them all in at once; each file is recognised by its contents.
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
              <CardTitle>What was read</CardTitle>
              <CardDescription>Every tab, the row its header was found on, and how many rows came out.</CardDescription>
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
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Kpi label="Orders" value={int(summary.orders)}
                 sub={`${summary.periods.join(', ')} · ${summary.entities.filter((e) => !e.includes('+')).join(', ')}`} />
            <Kpi label="Billed" value={money(summary.billed)} sub="every order in the files" />
            <Kpi label="Collected" value={money(summary.collected)} sub="remitted to you" />
            <Kpi label="Receivable" value={money(summary.receivable)} tone="text-amber-700"
                 sub="delivered orders only" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Checks</CardTitle>
              <CardDescription>
                The sheet never trusts a stated total on its own. Each of these rebuilds a figure from its
                parts and must come to zero.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 md:grid-cols-3">
              <Check label="Collector columns rebuild the remittance" value={summary.checks.collectors} />
              <Check label="Status split rebuilds the gross" value={summary.checks.statusSplit} />
              <Check label="Collector split rebuilds the receivable" value={summary.checks.receivableSplit} />
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Where the money went</CardTitle>
                <CardDescription>
                  Only a delivered order can be owed — an RTO came back, a cancellation never shipped,
                  and a refund was given back on purpose.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Status</TableHead><TableHead className="text-right">Orders</TableHead>
                    <TableHead className="text-right">Billed</TableHead><TableHead className="text-right">Collected</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {summary.groups.map((g) => (
                      <TableRow key={g.key}>
                        <TableCell className="font-medium">{g.label}</TableCell>
                        <TableCell className="text-right">{int(g.orders)}</TableCell>
                        <TableCell className="text-right">{money(g.billed)}</TableCell>
                        <TableCell className="text-right">{money(g.collected)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Where the receivable sits</CardTitle>
                <CardDescription>Who to chase, and for how much.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Collector</TableHead><TableHead className="text-right">Delivered orders</TableHead>
                    <TableHead className="text-right">Still owed</TableHead>
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
              <CardTitle className="flex items-center gap-2"><ListChecks className="h-5 w-5" /> Worklists</CardTitle>
              <CardDescription>Each one is a list someone can act on. Click to see the orders.</CardDescription>
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
              <CardTitle>Build the workbook</CardTitle>
              <CardDescription>
                The summary, the per-order ledger, a tab per worklist, and a Basis &amp; Checks sheet naming
                the file behind every figure. Percentages and totals are live formulas.
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
          Nothing read yet. Upload the sales workbooks and the payment reconciliation to begin.
        </CardContent></Card>
      )}

      {/* ── files held ─────────────────────────────────────────────────── */}
      {files.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Files held</CardTitle>
            <CardDescription>Remove a file to take its rows out of every figure above.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow>
                <TableHead>File</TableHead><TableHead>Read as</TableHead><TableHead>GSTIN</TableHead>
                <TableHead>Period</TableHead><TableHead className="text-right">Rows</TableHead>
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
                  <TableHead>Order ID</TableHead><TableHead>GSTIN</TableHead><TableHead>Order date</TableHead>
                  <TableHead>Status</TableHead><TableHead>Collector</TableHead><TableHead>State</TableHead>
                  <TableHead className="text-right">Billed</TableHead><TableHead className="text-right">Collected</TableHead>
                  <TableHead className="text-right">Gap</TableHead><TableHead>UTR</TableHead>
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
                      <TableCell className="text-right text-sm font-medium">{money(r.gap)}</TableCell>
                      <TableCell className="max-w-[160px] truncate text-sm text-slate-500">{r.utr_id || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {worklistRows.length >= 500 && (
                <p className="py-3 text-center text-xs text-slate-500">
                  First 500 shown — the workbook carries the full list.
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

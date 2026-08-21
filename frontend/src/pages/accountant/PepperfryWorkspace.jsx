import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Upload, FileText, Download, Trash2, Loader2, Plus, CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import api from '../../lib/api';
import { toast } from 'sonner';
import { format } from 'date-fns';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const fmt2 = (n) => typeof n === 'number' ? n.toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 }) : '—';
const fmtCount = (n) => typeof n === 'number' ? n.toLocaleString('en-IN') : '—';

const ReportBadge = ({ label, color }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${color}`}>{label}</span>
);

const PepperfryWorkspace = ({ agent }) => {
  const { brandId, agentId } = useParams();
  const [files, setFiles] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [formData, setFormData] = useState({ month:'', year: new Date().getFullYear().toString(), salesFile:null, refundFile:null });
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [isCommitting, setIsCommitting] = useState(false);

  const fetchFiles = useCallback(async () => {
    try {
      setLoadingFiles(true);
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/working-files`);
      setFiles(res.data || []);
    } catch { } finally { setLoadingFiles(false); }
  }, [brandId, agentId]);

  useEffect(() => { fetchFiles(); }, [fetchFiles]);

  const handleDownload = async (fileId, filename) => {
    try {
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/working-files/${fileId}/download`, { responseType:'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a'); a.href = url; a.download = filename || `pepperfry_${fileId}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url);
      toast.success('File downloaded');
    } catch { toast.error('Download failed'); }
  };

  const handleDelete = async (fileId) => {
    if (!window.confirm('Delete this working file?')) return;
    try {
      await api.delete(`/api/brands/${brandId}/agents/${agentId}/working-files/${fileId}`);
      toast.success('File deleted'); fetchFiles();
    } catch { toast.error('Delete failed'); }
  };

  const resetForm = () => setFormData({ month:'', year: new Date().getFullYear().toString(), salesFile:null, refundFile:null });

  const handleGeneratePreview = async (e) => {
    e.preventDefault();
    if (!formData.month) { toast.error('Please select a month'); return; }
    if (!formData.salesFile) { toast.error('Please upload the GSTR-1 Sales report'); return; }
    if (!formData.refundFile) { toast.error('Please upload the GSTR-1 Refunds report'); return; }
    const data = new FormData();
    data.append('month', formData.month); data.append('year', formData.year);
    data.append('salesFile', formData.salesFile); data.append('refundFile', formData.refundFile);
    setIsGenerating(true);
    try {
      const res = await api.post(`/api/brands/${brandId}/agents/${agentId}/pepperfry/generate/preview`, data, { headers:{ 'Content-Type':'multipart/form-data' } });
      setPreviewData(res.data); setShowGenerateModal(false); setShowPreviewModal(true);
    } catch (err) { toast.error(err.response?.data?.error || 'Preview generation failed'); }
    finally { setIsGenerating(false); }
  };

  const handleCommit = async () => {
    if (!previewData?.taskId) return;
    setIsCommitting(true);
    try {
      const res = await api.post(`/api/brands/${brandId}/agents/${agentId}/pepperfry/generate/commit`, { taskId: previewData.taskId });
      toast.success(`Saved: ${res.data.count} rows committed`);
      setShowPreviewModal(false); setPreviewData(null); resetForm(); fetchFiles();
    } catch (err) { toast.error(err.response?.data?.error || 'Commit failed'); }
    finally { setIsCommitting(false); }
  };

  const handleDiscard = async () => {
    if (!previewData?.taskId) return;
    try { await api.post(`/api/brands/${brandId}/agents/${agentId}/pepperfry/generate/discard`, { taskId: previewData.taskId }); }
    catch { }
    finally { toast.info('Generation discarded'); setShowPreviewModal(false); setPreviewData(null); }
  };

  const FileLabel = ({ file, placeholder }) => file
    ? <span className="text-green-700 font-medium truncate max-w-xs">{file.name}</span>
    : <span className="text-slate-400">{placeholder}</span>;

  const s = previewData?.summary?.workingFile;

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <Card>
          <CardHeader>
            <CardTitle>Pepperfry GSTR-1 Merge</CardTitle>
            <CardDescription>Sales + Refunds merge as per Pepperfry SOP</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-600">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-blue-50 border border-blue-100">
              <ReportBadge label="Sales" color="bg-blue-100 text-blue-800" />
              <p>GSTR1 Sales report from Seller Portal &rarr; Reports &rarr; GSTR1 Report.</p>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50 border border-amber-100">
              <ReportBadge label="Refunds" color="bg-amber-100 text-amber-800" />
              <p>GSTR1 Refunds report from the same download. Rows already present in the Sales
                report (returned line items) are matched by OrderID-SKU and merged in as a
                credit, not duplicated.</p>
            </div>
            <p className="text-xs text-slate-400 pt-1">Output: B2C Sales, B2B Sales and HSN Summary sheets, plus the full merged report.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Working File Generation</CardTitle>
            <CardDescription>Upload both reports and generate the working file</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => { resetForm(); setShowGenerateModal(true); }} className="w-full">
              <Plus className="mr-2 h-4 w-4" />Create New Working File
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Generated Working Files</CardTitle>
          <CardDescription>Download or delete previously generated files</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingFiles ? (
            <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
          ) : files.length === 0 ? (
            <div className="py-10 text-center text-slate-500">
              <FileText className="h-10 w-10 text-slate-300 mx-auto mb-3" />
              No working files yet. Generate one above.
            </div>
          ) : (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead><TableHead>Year</TableHead>
                    <TableHead>Created</TableHead><TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {files.map((file) => (
                    <TableRow key={file.id}>
                      <TableCell className="font-medium">{file.month}</TableCell>
                      <TableCell>{file.year}</TableCell>
                      <TableCell className="text-sm text-slate-500">
                        {file.created_at ? format(new Date(file.created_at), 'dd MMM yyyy') : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button size="sm" variant="secondary" onClick={() => handleDownload(file.id, file.filename)}><Download className="h-4 w-4" /></Button>
                          <Button size="sm" variant="destructive" onClick={() => handleDelete(file.id)}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Generate Modal */}
      <Dialog open={showGenerateModal} onOpenChange={setShowGenerateModal}>
        <DialogContent onClose={() => setShowGenerateModal(false)} className="max-w-lg">
          <DialogHeader><DialogTitle>Generate Pepperfry Working File</DialogTitle></DialogHeader>
          <form onSubmit={handleGeneratePreview} className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="pepperfry-month">Month *</Label>
                <select id="pepperfry-month" value={formData.month} onChange={(e) => setFormData({ ...formData, month: e.target.value })} required
                  className="flex h-9 w-full rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm mt-2">
                  <option value="">Select month</option>
                  {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <Label htmlFor="pepperfry-year">Year *</Label>
                <Input id="pepperfry-year" type="number" value={formData.year}
                  onChange={(e) => setFormData({ ...formData, year: e.target.value })} required className="mt-2" />
              </div>
            </div>

            {/* Sales report */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <ReportBadge label="Sales" color="bg-blue-200 text-blue-800" />
                <span className="text-sm font-medium text-slate-700">GSTR-1 Sales Report</span>
              </div>
              <p className="text-xs text-slate-500">e.g. <code className="bg-white px-1 rounded">GSTR-1_&lt;gstin&gt;_&lt;state&gt;_&lt;date&gt;.csv</code></p>
              <label htmlFor="pepperfry-sales-file"
                className="flex items-center gap-3 cursor-pointer rounded-md border border-dashed border-blue-300 bg-white px-3 py-2.5 hover:bg-blue-50 transition-colors">
                <Upload className="h-4 w-4 text-blue-400 shrink-0" />
                <FileLabel file={formData.salesFile} placeholder="Click to upload the Sales report" />
              </label>
              <Input id="pepperfry-sales-file" type="file" accept=".csv,.xlsx,.xls" className="hidden"
                onChange={(e) => setFormData({ ...formData, salesFile: e.target.files[0] || null })} />
            </div>

            {/* Refund report */}
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <ReportBadge label="Refunds" color="bg-amber-200 text-amber-800" />
                <span className="text-sm font-medium text-slate-700">GSTR-1 Refunds Report</span>
              </div>
              <p className="text-xs text-slate-500">e.g. <code className="bg-white px-1 rounded">GSTR-1_Refunds_&lt;gstin&gt;_&lt;state&gt;_&lt;date&gt;.csv</code></p>
              <label htmlFor="pepperfry-refund-file"
                className="flex items-center gap-3 cursor-pointer rounded-md border border-dashed border-amber-300 bg-white px-3 py-2.5 hover:bg-amber-50 transition-colors">
                <Upload className="h-4 w-4 text-amber-400 shrink-0" />
                <FileLabel file={formData.refundFile} placeholder="Click to upload the Refunds report" />
              </label>
              <Input id="pepperfry-refund-file" type="file" accept=".csv,.xlsx,.xls" className="hidden"
                onChange={(e) => setFormData({ ...formData, refundFile: e.target.files[0] || null })} />
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={() => setShowGenerateModal(false)} className="flex-1" disabled={isGenerating}>Cancel</Button>
              <Button type="submit" className="flex-1" disabled={isGenerating}>
                {isGenerating ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Processing…</> : 'Preview & Verify'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Preview Modal */}
      <Dialog open={showPreviewModal} onOpenChange={() => {}}>
        <DialogContent onClose={handleDiscard} className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">📊 Processing Summary</DialogTitle>
          </DialogHeader>
          {s && (
            <div className="space-y-5 py-1">
              <p className="text-sm text-slate-600">
                Files merged for <span className="font-semibold text-slate-900">{formData.month} {formData.year}</span>. Review the totals below before saving.
              </p>
              <div className="rounded-lg border border-slate-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b">
                      <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">Metric</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-slate-600 uppercase tracking-wide">Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    <tr>
                      <td className="px-4 py-2.5 text-slate-700">Merged Rows</td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmtCount(previewData?.rowCount)}</td>
                    </tr>
                    <tr className="bg-slate-50/50">
                      <td className="px-4 py-2.5 text-slate-700">Net Quantity</td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmtCount(s.quantity)}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2.5 text-slate-700 font-medium">Taxable Value</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold text-slate-900">₹ {fmt2(s.taxableValue)}</td>
                    </tr>
                    <tr className="bg-slate-50/50">
                      <td className="px-4 py-2.5 text-slate-500">IGST</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-700">₹ {fmt2(s.igst)}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2.5 text-slate-500">CGST</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-700">₹ {fmt2(s.cgst)}</td>
                    </tr>
                    <tr className="bg-slate-50/50">
                      <td className="px-4 py-2.5 text-slate-500">SGST / UGST</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-700">₹ {fmt2(s.sgst)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="flex gap-3 pt-1">
                <Button type="button" variant="outline" className="flex-1 border-red-200 text-red-600 hover:bg-red-50" onClick={handleDiscard} disabled={isCommitting}>
                  <XCircle className="mr-2 h-4 w-4" />Discard
                </Button>
                <Button type="button" className="flex-1 bg-green-600 hover:bg-green-700 text-white" onClick={handleCommit} disabled={isCommitting}>
                  {isCommitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : <><CheckCircle2 className="mr-2 h-4 w-4" />Accept & Save</>}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

export default PepperfryWorkspace;

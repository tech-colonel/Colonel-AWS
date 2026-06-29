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

const CycleBadge = ({ label, color }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${color}`}>{label}</span>
);

const NykaaWorkspace = ({ agent }) => {
  const { brandId, agentId } = useParams();
  const [files, setFiles] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [formData, setFormData] = useState({ month:'', year: new Date().getFullYear().toString(), cycle1File:null, cycle2File:null });
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
      const a = document.createElement('a'); a.href = url; a.download = filename || `nykaa_${fileId}.xlsx`;
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

  const resetForm = () => setFormData({ month:'', year: new Date().getFullYear().toString(), cycle1File:null, cycle2File:null });

  const handleGeneratePreview = async (e) => {
    e.preventDefault();
    if (!formData.month) { toast.error('Please select a month'); return; }
    if (!formData.cycle1File) { toast.error('Please upload the Cycle 1 (1–15) file'); return; }
    if (!formData.cycle2File) { toast.error('Please upload the Cycle 2 (16–30) file'); return; }
    const data = new FormData();
    data.append('month', formData.month); data.append('year', formData.year);
    data.append('cycle1File', formData.cycle1File); data.append('cycle2File', formData.cycle2File);
    setIsGenerating(true);
    try {
      const res = await api.post(`/api/brands/${brandId}/agents/${agentId}/nykaa/generate/preview`, data, { headers:{ 'Content-Type':'multipart/form-data' } });
      setPreviewData(res.data); setShowGenerateModal(false); setShowPreviewModal(true);
    } catch (err) { toast.error(err.response?.data?.error || 'Preview generation failed'); }
    finally { setIsGenerating(false); }
  };

  const handleCommit = async () => {
    if (!previewData?.taskId) return;
    setIsCommitting(true);
    try {
      const res = await api.post(`/api/brands/${brandId}/agents/${agentId}/nykaa/generate/commit`, { taskId: previewData.taskId });
      toast.success(`Saved: ${res.data.count} rows committed`);
      setShowPreviewModal(false); setPreviewData(null); resetForm(); fetchFiles();
    } catch (err) { toast.error(err.response?.data?.error || 'Commit failed'); }
    finally { setIsCommitting(false); }
  };

  const handleDiscard = async () => {
    if (!previewData?.taskId) return;
    try { await api.post(`/api/brands/${brandId}/agents/${agentId}/nykaa/generate/discard`, { taskId: previewData.taskId }); }
    catch { }
    finally { toast.info('Generation discarded'); setShowPreviewModal(false); setPreviewData(null); }
  };

  const FileLabel = ({ file, placeholder }) => file
    ? <span className="text-green-700 font-medium truncate max-w-xs">{file.name}</span>
    : <span className="text-slate-400">{placeholder}</span>;

  const s = previewData?.summary;

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <Card>
          <CardHeader>
            <CardTitle>Nykaa Bi-Cycle Processing</CardTitle>
            <CardDescription>Two-cycle VLOOKUP method as per Nykaa SOP</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-600">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-blue-50 border border-blue-100">
              <CycleBadge label="Cycle 1  1–15" color="bg-blue-100 text-blue-800" />
              <p>Status cross-referenced with Cycle 2 file.<br />
                <span className="text-green-700 font-medium">Delivered / Shipped</span> → Sales &nbsp;|&nbsp;
                <span className="text-red-600 font-medium">Return</span> → Credit Note
              </p>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50 border border-amber-100">
              <CycleBadge label="Cycle 2  16–30" color="bg-amber-100 text-amber-800" />
              <p>Unmatched orders (not in Cycle 1).<br />
                <span className="text-green-700 font-medium">Delivered / Shipped / Not Shipped</span> → Provisional Sales &nbsp;|&nbsp;
                <span className="text-red-600 font-medium">Return</span> → Credit Note
              </p>
            </div>
            <p className="text-xs text-slate-400 pt-1">Output: Tally-ready "Excel to Tally" sheet with 109 columns and state-wise voucher grouping.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Working File Generation</CardTitle>
            <CardDescription>Upload both cycle files and generate Tally output</CardDescription>
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
          <CardDescription>Tally-ready files — download or delete</CardDescription>
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
          <DialogHeader><DialogTitle>Generate Nykaa Working File</DialogTitle></DialogHeader>
          <form onSubmit={handleGeneratePreview} className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="nykaa-month">Month *</Label>
                <select id="nykaa-month" value={formData.month} onChange={(e) => setFormData({ ...formData, month: e.target.value })} required
                  className="flex h-9 w-full rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm mt-2">
                  <option value="">Select month</option>
                  {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <Label htmlFor="nykaa-year">Year *</Label>
                <Input id="nykaa-year" type="number" value={formData.year}
                  onChange={(e) => setFormData({ ...formData, year: e.target.value })} required className="mt-2" />
              </div>
            </div>

            {/* Cycle 1 */}
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <CycleBadge label="Cycle 1" color="bg-blue-200 text-blue-800" />
                <span className="text-sm font-medium text-slate-700">Sales Report: 1st – 15th</span>
              </div>
              <p className="text-xs text-slate-500">e.g. <code className="bg-white px-1 rounded">May_01_15.xlsx</code></p>
              <label htmlFor="cycle1-file"
                className="flex items-center gap-3 cursor-pointer rounded-md border border-dashed border-blue-300 bg-white px-3 py-2.5 hover:bg-blue-50 transition-colors">
                <Upload className="h-4 w-4 text-blue-400 shrink-0" />
                <FileLabel file={formData.cycle1File} placeholder="Click to upload (1–15) file" />
              </label>
              <Input id="cycle1-file" type="file" accept=".xlsx,.xls" className="hidden"
                onChange={(e) => setFormData({ ...formData, cycle1File: e.target.files[0] || null })} />
            </div>

            {/* Cycle 2 */}
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <CycleBadge label="Cycle 2" color="bg-amber-200 text-amber-800" />
                <span className="text-sm font-medium text-slate-700">Sales Report: 16th – 30th</span>
              </div>
              <p className="text-xs text-slate-500">e.g. <code className="bg-white px-1 rounded">May_16_30.xlsx</code></p>
              <label htmlFor="cycle2-file"
                className="flex items-center gap-3 cursor-pointer rounded-md border border-dashed border-amber-300 bg-white px-3 py-2.5 hover:bg-amber-50 transition-colors">
                <Upload className="h-4 w-4 text-amber-400 shrink-0" />
                <FileLabel file={formData.cycle2File} placeholder="Click to upload (16–30) file" />
              </label>
              <Input id="cycle2-file" type="file" accept=".xlsx,.xls" className="hidden"
                onChange={(e) => setFormData({ ...formData, cycle2File: e.target.files[0] || null })} />
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
                Files processed for <span className="font-semibold text-slate-900">{formData.month} {formData.year}</span>. Review the totals below before saving.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-center">
                  <p className="text-xs text-blue-600 font-medium uppercase tracking-wide mb-1">Cycle 1 (1–15)</p>
                  <p className="text-2xl font-bold text-blue-800">{fmtCount(s.c1Count)}</p>
                  <p className="text-xs text-blue-500 mt-0.5">entries resolved</p>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-center">
                  <p className="text-xs text-amber-600 font-medium uppercase tracking-wide mb-1">Cycle 2 (16–30)</p>
                  <p className="text-2xl font-bold text-amber-800">{fmtCount(s.c2Count)}</p>
                  <p className="text-xs text-amber-500 mt-0.5">provisional entries</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-green-200 bg-green-50 p-3 flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
                  <div><p className="text-xs text-slate-500">Sales Entries</p><p className="text-lg font-bold text-green-700">{fmtCount(s.salesCount)}</p></div>
                </div>
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 flex items-center gap-3">
                  <XCircle className="h-5 w-5 text-red-400 shrink-0" />
                  <div><p className="text-xs text-slate-500">Credit Notes</p><p className="text-lg font-bold text-red-600">{fmtCount(s.cnCount)}</p></div>
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b">
                      <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">Metric</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-green-600 uppercase tracking-wide">Sales</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-red-500 uppercase tracking-wide">Returns (CN)</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-slate-600 uppercase tracking-wide">Net</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    <tr>
                      <td className="px-4 py-2.5 text-slate-700">Rows</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-700">{fmtCount(s.salesCount)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-red-600">{fmtCount(s.cnCount)}</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold">{fmtCount(s.totalRows)}</td>
                    </tr>
                    <tr className="bg-slate-50/50">
                      <td className="px-4 py-2.5 text-slate-700 font-medium">Taxable Value</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-700">₹ {fmt2(s.salesAmount)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-red-600">₹ {fmt2(s.cnAmount)}</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold text-slate-900">₹ {fmt2(s.totalAmount)}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2.5 text-slate-500">IGST</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-600">₹ {fmt2(s.salesIGST)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-red-500">₹ {fmt2(s.cnIGST)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-700">₹ {fmt2(s.totalIGST)}</td>
                    </tr>
                    <tr className="bg-slate-50/50">
                      <td className="px-4 py-2.5 text-slate-500">CGST</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-600">₹ {fmt2(s.salesCGST)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-red-500">₹ {fmt2(s.cnCGST)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-700">₹ {fmt2(s.totalCGST)}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2.5 text-slate-500">SGST / UGST</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-600">₹ {fmt2(s.salesSGST)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-red-500">₹ {fmt2(s.cnSGST)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-700">₹ {fmt2(s.totalSGST)}</td>
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

export default NykaaWorkspace;

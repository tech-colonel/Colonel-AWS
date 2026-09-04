import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Upload, FileText, Download, Trash2, Loader2, Plus, CheckCircle2, XCircle, Eye, Search, X } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import api from '../../lib/api';
import { toast } from 'sonner';
import { format } from 'date-fns';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const fmt2 = (n) => (typeof n === 'number' ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
const fmtCount = (n) => (typeof n === 'number' ? n.toLocaleString('en-IN') : '—');

const skuKey = (row) => (row['Sales portal SKU'] || row['Sales Portal SKU'] || row.salesPortalSku || row.sku || row.identifier || row.Identifier || '').toString();
const skuVal = (row) => (row['Tally new SKU'] || row['Tally New SKU'] || row.tallyNewSku || row.fg || row.FG || '').toString();

const MeeshoWorkspace = ({ agent }) => {
  const { brandId, agentId } = useParams();

  const [files, setFiles] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(true);

  const [master, setMaster] = useState({ sku_master: [], ledger_master: [] });
  const [showUploadSkuModal, setShowUploadSkuModal] = useState(false);
  const [showUploadLedgerModal, setShowUploadLedgerModal] = useState(false);
  const [showViewSkuModal, setShowViewSkuModal] = useState(false);
  const [showViewLedgerModal, setShowViewLedgerModal] = useState(false);
  const [skuFile, setSkuFile] = useState(null);
  const [ledgerFile, setLedgerFile] = useState(null);
  const [uploadingMaster, setUploadingMaster] = useState(false);
  const [skuSearch, setSkuSearch] = useState('');

  // Manual add / delete of single master rows (matches the Flipkart master modal)
  const [newSkuPortal, setNewSkuPortal] = useState('');
  const [newSkuTally, setNewSkuTally] = useState('');
  const [isAddingSku, setIsAddingSku] = useState(false);
  const [deletingSkuKey, setDeletingSkuKey] = useState(null);
  const [newLedgerState, setNewLedgerState] = useState('');
  const [newLedgerName, setNewLedgerName] = useState('');
  const [newLedgerInvoice, setNewLedgerInvoice] = useState('');
  const [isAddingLedger, setIsAddingLedger] = useState(false);
  const [deletingLedgerIdx, setDeletingLedgerIdx] = useState(null);

  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [formData, setFormData] = useState({ month: '', year: new Date().getFullYear().toString(), inventory_type: 'With', salesFile: null, returnFile: null });

  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [isCommitting, setIsCommitting] = useState(false);

  const fetchFiles = useCallback(async () => {
    try {
      setLoadingFiles(true);
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/working-files`);
      setFiles(res.data || []);
    } catch { /* none yet */ } finally { setLoadingFiles(false); }
  }, [brandId, agentId]);

  const fetchMaster = useCallback(async () => {
    try {
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/meesho/master`);
      setMaster({ sku_master: res.data?.sku_master || [], ledger_master: res.data?.ledger_master || [] });
    } catch { /* none yet */ }
  }, [brandId, agentId]);

  useEffect(() => { fetchFiles(); fetchMaster(); }, [fetchFiles, fetchMaster]);

  const handleDownload = async (fileId, filename) => {
    try {
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/working-files/${fileId}/download`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a'); a.href = url; a.download = filename || `meesho_${fileId}.xlsx`;
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

  const uploadMaster = async (type, file) => {
    if (!file) { toast.error('Please select a file'); return; }
    const data = new FormData();
    data.append('file', file);
    setUploadingMaster(true);
    try {
      await api.post(`/api/brands/${brandId}/agents/${agentId}/meesho/master/${type}`, data, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(`${type === 'sku' ? 'SKU' : 'Ledger'} Master uploaded successfully`);
      setShowUploadSkuModal(false); setShowUploadLedgerModal(false); setSkuFile(null); setLedgerFile(null);
      fetchMaster();
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    finally { setUploadingMaster(false); }
  };

  const handleAddSku = async () => {
    if (!newSkuPortal.trim() || !newSkuTally.trim()) {
      toast.error('Both Sales Portal SKU and Tally New SKU are required');
      return;
    }
    setIsAddingSku(true);
    try {
      await api.post(`/api/brands/${brandId}/agents/${agentId}/master/sku/add`, {
        salesPortalSku: newSkuPortal.trim(),
        tallyNewSku: newSkuTally.trim(),
      });
      toast.success('SKU added');
      setNewSkuPortal(''); setNewSkuTally('');
      fetchMaster();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to add SKU'); }
    finally { setIsAddingSku(false); }
  };

  const handleDeleteSku = async (tallySku) => {
    if (!tallySku || !window.confirm(`Delete SKU "${tallySku}"? This cannot be undone.`)) return;
    setDeletingSkuKey(tallySku);
    try {
      await api.delete(`/api/brands/${brandId}/agents/${agentId}/master/sku/delete`, { params: { tallySku } });
      toast.success('SKU deleted');
      fetchMaster();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to delete SKU'); }
    finally { setDeletingSkuKey(null); }
  };

  const handleAddLedger = async () => {
    if (!newLedgerState.trim() || !newLedgerName.trim()) {
      toast.error('States and Ledger are required');
      return;
    }
    setIsAddingLedger(true);
    try {
      await api.post(`/api/brands/${brandId}/agents/${agentId}/master/ledger/add-entry`, {
        fields: {
          'States': newLedgerState.trim(),
          'Ledger': newLedgerName.trim(),
          'Invoice No.': newLedgerInvoice.trim(),
        },
      });
      toast.success('Ledger row added');
      setNewLedgerState(''); setNewLedgerName(''); setNewLedgerInvoice('');
      fetchMaster();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to add ledger row'); }
    finally { setIsAddingLedger(false); }
  };

  const handleDeleteLedger = async (index, label) => {
    if (!window.confirm(`Delete ledger row "${label}"? This cannot be undone.`)) return;
    setDeletingLedgerIdx(index);
    try {
      await api.delete(`/api/brands/${brandId}/agents/${agentId}/master/entry/ledger/${index}`);
      toast.success('Ledger row deleted');
      fetchMaster();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to delete ledger row'); }
    finally { setDeletingLedgerIdx(null); }
  };

  const resetForm = () => setFormData({ month: '', year: new Date().getFullYear().toString(), inventory_type: 'With', salesFile: null, returnFile: null });

  const submitPreview = async (proceedWithoutMaster = false) => {
    const data = new FormData();
    data.append('month', formData.month); data.append('year', formData.year);
    data.append('inventory_type', formData.inventory_type || 'With');
    data.append('salesFile', formData.salesFile); data.append('returnFile', formData.returnFile);
    if (proceedWithoutMaster) data.append('proceedWithoutMaster', 'true');
    setIsGenerating(true);
    try {
      const res = await api.post(`/api/brands/${brandId}/agents/${agentId}/meesho/generate/preview`, data, { headers: { 'Content-Type': 'multipart/form-data' } });
      setPreviewData(res.data); setShowGenerateModal(false); setShowPreviewModal(true);
    } catch (err) {
      const missing = err.response?.data?.missingMasterValues;
      if (missing?.length && !proceedWithoutMaster) {
        const preview = missing.slice(0, 15).map((m) => `• ${m.value}${m.occurrences ? ` (${m.occurrences} rows)` : ''}`).join('\n');
        const more = missing.length > 15 ? `\n…and ${missing.length - 15} more` : '';
        if (window.confirm(`${missing.length} SKU-Master value(s) not found (identifier → FG):\n\n${preview}${more}\n\nGenerate anyway with a blank FG for these rows?`)) {
          return submitPreview(true);
        }
      } else {
        toast.error(err.response?.data?.error || 'Preview generation failed');
      }
    } finally { setIsGenerating(false); }
  };

  const handleGenerateFile = (e) => {
    e.preventDefault();
    if (!formData.month) { toast.error('Please select a month'); return; }
    if (!formData.salesFile) { toast.error('Please upload the tcs_sales file'); return; }
    if (!formData.returnFile) { toast.error('Please upload the tcs_sales_return file'); return; }
    return submitPreview(false);
  };

  const handleCommit = async () => {
    if (!previewData?.taskId) return;
    setIsCommitting(true);
    try {
      const res = await api.post(`/api/brands/${brandId}/agents/${agentId}/meesho/generate/commit`, { taskId: previewData.taskId });
      toast.success(`Saved: ${res.data.count} rows committed`);
      setShowPreviewModal(false); setPreviewData(null); resetForm(); fetchFiles();
    } catch (err) { toast.error(err.response?.data?.error || 'Commit failed'); }
    finally { setIsCommitting(false); }
  };

  const handleDiscard = async () => {
    if (!previewData?.taskId) return;
    try { await api.post(`/api/brands/${brandId}/agents/${agentId}/meesho/generate/discard`, { taskId: previewData.taskId }); }
    catch { /* best effort */ }
    finally { toast.info('Generation discarded'); setShowPreviewModal(false); setPreviewData(null); }
  };

  const s = previewData?.summary;
  const filteredSku = master.sku_master.filter((row) => {
    if (!skuSearch.trim()) return true;
    const q = skuSearch.toLowerCase();
    return skuVal(row).toLowerCase().includes(q) || skuKey(row).toLowerCase().includes(q);
  });

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <Card>
          <CardHeader>
            <CardTitle>Master Data Management</CardTitle>
            <CardDescription>Upload and view SKU and Ledger master data</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" onClick={() => { setSkuFile(null); setShowUploadSkuModal(true); }} className="w-full">
                <Upload className="mr-2 h-4 w-4" />Upload SKU
              </Button>
              <Button variant="outline" onClick={() => { setSkuSearch(''); setShowViewSkuModal(true); }} className="w-full">
                <Eye className="mr-2 h-4 w-4" />View SKU
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Button variant="outline" onClick={() => { setLedgerFile(null); setShowUploadLedgerModal(true); }} className="w-full">
                <Upload className="mr-2 h-4 w-4" />Upload Ledger
              </Button>
              <Button variant="outline" onClick={() => setShowViewLedgerModal(true)} className="w-full">
                <Eye className="mr-2 h-4 w-4" />View Ledger
              </Button>
            </div>
            <div className="pt-2 text-xs text-slate-500 space-y-1">
              <p>SKU Master: {master.sku_master.length} records <span className="text-slate-400">(identifier → Tally FG · With Inventory)</span></p>
              <p>Ledger Master: {master.ledger_master.length} records <span className="text-slate-400">(State → Ledger / Invoice No.)</span></p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Working File Generation</CardTitle>
            <CardDescription>Merge the tcs_sales + tcs_sales_return TCS extracts with master information</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => { resetForm(); setShowGenerateModal(true); }} className="w-full">
              <Plus className="mr-2 h-4 w-4" />Create New File
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Generated Files</CardTitle>
          <CardDescription>Download or delete previously generated working files</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingFiles ? (
            <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
          ) : files.length === 0 ? (
            <div className="py-8 text-center text-slate-600">
              <FileText className="h-12 w-12 text-slate-400 mx-auto mb-4" />
              No files generated yet
            </div>
          ) : (
            <div className="border border-slate-200 rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead>Year</TableHead>
                    <TableHead>Inventory</TableHead>
                    <TableHead>Created At</TableHead>
                    <TableHead>Created By</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {files.map((file) => (
                    <TableRow key={file.id}>
                      <TableCell className="font-medium">{file.month}</TableCell>
                      <TableCell>{file.year}</TableCell>
                      <TableCell>{file.inventory_type || '—'}</TableCell>
                      <TableCell className="text-sm text-slate-600">
                        {file.created_at ? format(new Date(file.created_at), 'dd MMM yyyy, hh:mm a') : 'N/A'}
                      </TableCell>
                      <TableCell className="text-sm text-slate-600">{file.created_by_name || 'N/A'}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button size="sm" variant="secondary" onClick={() => handleDownload(file.id, file.filename)}>
                            <Download className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => handleDelete(file.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
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

      {/* Upload SKU Master Modal */}
      <Dialog open={showUploadSkuModal} onOpenChange={setShowUploadSkuModal}>
        <DialogContent onClose={() => setShowUploadSkuModal(false)}>
          <DialogHeader><DialogTitle>Upload SKU Master</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="meesho-sku-file">Select Excel File *</Label>
              <Input id="meesho-sku-file" type="file" accept=".xlsx,.xls" className="mt-2"
                onChange={(e) => setSkuFile(e.target.files[0] || null)} />
              <p className="text-xs text-slate-500 mt-2">
                Upload Excel file with columns: <strong>Sales Portal SKU</strong> (the Meesho <code>identifier</code>), <strong>Tally New SKU</strong>
              </p>
            </div>
            <div className="flex gap-3 pt-4">
              <Button type="button" variant="secondary" className="flex-1" onClick={() => setShowUploadSkuModal(false)} disabled={uploadingMaster}>Cancel</Button>
              <Button type="button" className="flex-1" onClick={() => uploadMaster('sku', skuFile)} disabled={uploadingMaster}>
                {uploadingMaster ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Uploading…</> : 'Upload'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Upload Ledger Master Modal */}
      <Dialog open={showUploadLedgerModal} onOpenChange={setShowUploadLedgerModal}>
        <DialogContent onClose={() => setShowUploadLedgerModal(false)}>
          <DialogHeader><DialogTitle>Upload Ledger Master</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="meesho-ledger-file">Select Excel File *</Label>
              <Input id="meesho-ledger-file" type="file" accept=".xlsx,.xls" className="mt-2"
                onChange={(e) => setLedgerFile(e.target.files[0] || null)} />
              <p className="text-xs text-slate-500 mt-2">
                Upload Excel file with columns: <strong>States</strong>, <strong>Ledger</strong>, <strong>Invoice No.</strong>
              </p>
            </div>
            <div className="flex gap-3 pt-4">
              <Button type="button" variant="secondary" className="flex-1" onClick={() => setShowUploadLedgerModal(false)} disabled={uploadingMaster}>Cancel</Button>
              <Button type="button" className="flex-1" onClick={() => uploadMaster('ledger', ledgerFile)} disabled={uploadingMaster}>
                {uploadingMaster ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Uploading…</> : 'Upload'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* View SKU Master Modal */}
      <Dialog open={showViewSkuModal} onOpenChange={(open) => { setShowViewSkuModal(open); if (!open) setSkuSearch(''); }}>
        <DialogContent onClose={() => { setShowViewSkuModal(false); setSkuSearch(''); }} className="max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader><DialogTitle>SKU Master Data ({master.sku_master.length} records)</DialogTitle></DialogHeader>

          {/* Add New SKU Manually */}
          <div className="border border-slate-200 rounded-lg p-4 bg-slate-50 space-y-3">
            <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Add New SKU Manually</p>
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Label htmlFor="meesho-new-tally-sku" className="text-xs text-slate-600">Tally New SKU (FG) *</Label>
                <Input id="meesho-new-tally-sku" placeholder="e.g. DCHICA-KIDS-TEE" value={newSkuTally}
                  onChange={(e) => setNewSkuTally(e.target.value)} className="mt-1 h-8 text-sm" />
              </div>
              <div className="flex-1">
                <Label htmlFor="meesho-new-portal-sku" className="text-xs text-slate-600">Sales Portal SKU (identifier) *</Label>
                <Input id="meesho-new-portal-sku" placeholder="e.g. ujhnl" value={newSkuPortal}
                  onChange={(e) => setNewSkuPortal(e.target.value)} className="mt-1 h-8 text-sm" />
              </div>
              <Button onClick={handleAddSku} disabled={isAddingSku} size="sm" className="h-8 px-4 shrink-0">
                {isAddingSku ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
                {isAddingSku ? 'Adding…' : 'Add SKU'}
              </Button>
            </div>
          </div>

          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input placeholder="Search by Tally New SKU or Sales Portal SKU…" value={skuSearch}
              onChange={(e) => setSkuSearch(e.target.value)} className="pl-9 h-9 text-sm" />
            {skuSearch && (
              <button onClick={() => setSkuSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="flex-1 overflow-auto border rounded-lg mt-3">
            {master.sku_master.length === 0 ? (
              <p className="text-sm text-slate-600 py-8 text-center">No SKU master data uploaded</p>
            ) : filteredSku.length === 0 ? (
              <div className="py-12 text-center text-slate-500 text-sm">
                <Search className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                No SKUs found for "{skuSearch}"
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Sales Portal SKU (identifier)</TableHead>
                    <TableHead className="text-xs">Tally New SKU (FG)</TableHead>
                    <TableHead className="text-right text-xs">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSku.slice(0, 200).map((row, idx) => {
                    const tally = skuVal(row);
                    return (
                      <TableRow key={idx}>
                        <TableCell className="text-xs">{skuKey(row) || <span className="text-slate-400 italic">—</span>}</TableCell>
                        <TableCell className="text-xs font-medium">{tally || <span className="text-slate-400 italic">—</span>}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleDeleteSku(tally)} disabled={deletingSkuKey === tally} title="Delete this SKU">
                            {deletingSkuKey === tally ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
          {filteredSku.length > 200 && (
            <p className="text-xs text-slate-500 text-center pt-2">Showing 200 of {filteredSku.length} matching records</p>
          )}
        </DialogContent>
      </Dialog>

      {/* View Ledger Master Modal */}
      <Dialog open={showViewLedgerModal} onOpenChange={setShowViewLedgerModal}>
        <DialogContent onClose={() => setShowViewLedgerModal(false)} className="max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader><DialogTitle>Ledger Master Data ({master.ledger_master.length} records)</DialogTitle></DialogHeader>

          {/* Add New Ledger Row */}
          <div className="border border-slate-200 rounded-lg p-4 bg-slate-50 space-y-3">
            <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Add New Ledger Row</p>
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Label htmlFor="meesho-new-ledger-state" className="text-xs text-slate-600">States *</Label>
                <Input id="meesho-new-ledger-state" placeholder="e.g. Gujarat" value={newLedgerState}
                  onChange={(e) => setNewLedgerState(e.target.value)} className="mt-1 h-8 text-sm" />
              </div>
              <div className="flex-1">
                <Label htmlFor="meesho-new-ledger-name" className="text-xs text-slate-600">Ledger *</Label>
                <Input id="meesho-new-ledger-name" placeholder="e.g. Meesho Gujarat" value={newLedgerName}
                  onChange={(e) => setNewLedgerName(e.target.value)} className="mt-1 h-8 text-sm" />
              </div>
              <div className="w-28">
                <Label htmlFor="meesho-new-ledger-inv" className="text-xs text-slate-600">Invoice No.</Label>
                <Input id="meesho-new-ledger-inv" placeholder="e.g. Mee-GJ" value={newLedgerInvoice}
                  onChange={(e) => setNewLedgerInvoice(e.target.value)} className="mt-1 h-8 text-sm" />
              </div>
              <Button onClick={handleAddLedger} disabled={isAddingLedger} size="sm" className="h-8 px-4 shrink-0">
                {isAddingLedger ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
                {isAddingLedger ? 'Adding…' : 'Add Row'}
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-auto border rounded-lg mt-3">
            {master.ledger_master.length === 0 ? (
              <p className="text-sm text-slate-600 py-8 text-center">No ledger master data uploaded</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs font-semibold">States</TableHead>
                    <TableHead className="text-xs font-semibold">Ledger</TableHead>
                    <TableHead className="text-xs font-semibold">Invoice No.</TableHead>
                    <TableHead className="text-right text-xs font-semibold">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {master.ledger_master.slice(0, 100).map((row, idx) => {
                    const st = row['States'] || row['State'] || row.states || row.state || '';
                    return (
                      <TableRow key={idx}>
                        <TableCell className="text-xs">{st || <span className="text-slate-400 italic">—</span>}</TableCell>
                        <TableCell className="text-xs">{(row['Ledger'] || row.ledger || '') || <span className="text-slate-400 italic">—</span>}</TableCell>
                        <TableCell className="text-xs">{(row['Invoice No.'] || row['Invoice No'] || row['Invoice Number'] || row.invoiceNo || '') || <span className="text-slate-400 italic">—</span>}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleDeleteLedger(idx, st)} disabled={deletingLedgerIdx === idx} title="Delete this row">
                            {deletingLedgerIdx === idx ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
          {master.ledger_master.length > 100 && (
            <p className="text-xs text-slate-500 text-center pt-2">Showing 100 of {master.ledger_master.length} records</p>
          )}
        </DialogContent>
      </Dialog>

      {/* Generate Working File Modal */}
      <Dialog open={showGenerateModal} onOpenChange={setShowGenerateModal}>
        <DialogContent onClose={() => setShowGenerateModal(false)}>
          <DialogHeader><DialogTitle>Generate Working File</DialogTitle></DialogHeader>
          <form onSubmit={handleGenerateFile} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="meesho-month">Month *</Label>
                <select id="meesho-month" value={formData.month} onChange={(e) => setFormData({ ...formData, month: e.target.value })} required
                  className="flex h-9 w-full rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm mt-2">
                  <option value="">Select</option>
                  {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <Label htmlFor="meesho-year">Year *</Label>
                <Input id="meesho-year" type="number" value={formData.year}
                  onChange={(e) => setFormData({ ...formData, year: e.target.value })} required className="mt-2" />
              </div>
            </div>

            <div>
              <Label htmlFor="meesho-inventory-type">Inventory *</Label>
              <select id="meesho-inventory-type" value={formData.inventory_type}
                onChange={(e) => setFormData({ ...formData, inventory_type: e.target.value })}
                className="flex h-9 w-full rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm mt-2">
                <option value="With">With Inventory</option>
                <option value="Without">Without Inventory</option>
              </select>
              <p className="text-xs text-slate-500 mt-2">
                Working columns, Party Name / Invoice No. and the GSTR sheets are the same either way — "With Inventory" adds one FG column (identifier → FG) and flags any identifier missing from the SKU Master.
              </p>
            </div>

            <div>
              <Label htmlFor="meesho-sales-file">Sales File — tcs_sales *</Label>
              <Input id="meesho-sales-file" type="file" accept=".xlsx,.xls" required className="mt-2"
                onChange={(e) => setFormData({ ...formData, salesFile: e.target.files[0] || null })} />
              <p className="text-xs text-slate-500 mt-2">e.g. <code>tcs_sales Jul-26.xlsx</code></p>
            </div>

            <div>
              <Label htmlFor="meesho-return-file">Return File — tcs_sales_return *</Label>
              <Input id="meesho-return-file" type="file" accept=".xlsx,.xls" required className="mt-2"
                onChange={(e) => setFormData({ ...formData, returnFile: e.target.files[0] || null })} />
              <p className="text-xs text-slate-500 mt-2">e.g. <code>tcs_sales_return Jul-26.xlsx</code> — quantity / taxable / tax / invoice values are flipped negative</p>
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

      {/* Preview / Processing Summary Modal */}
      <Dialog open={showPreviewModal} onOpenChange={() => {}}>
        <DialogContent onClose={handleDiscard} className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">📊 Processing Summary</DialogTitle>
          </DialogHeader>
          {s && (
            <div className="space-y-5 py-1">
              <p className="text-sm text-slate-600">
                Files processed for <span className="font-semibold text-slate-900">{formData.month} {formData.year}</span> ({formData.inventory_type} Inventory). Review the totals before saving.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-green-200 bg-green-50 p-3 flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
                  <div><p className="text-xs text-slate-500">Sales rows</p><p className="text-lg font-bold text-green-700">{fmtCount(s.sales?.rows)}</p></div>
                </div>
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 flex items-center gap-3">
                  <XCircle className="h-5 w-5 text-red-400 shrink-0" />
                  <div><p className="text-xs text-slate-500">Return rows</p><p className="text-lg font-bold text-red-600">{fmtCount(s.returns?.rows)}</p></div>
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b">
                      <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">Metric</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-green-600 uppercase tracking-wide">Sales</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-red-500 uppercase tracking-wide">Returns</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-slate-600 uppercase tracking-wide">Net</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    <tr>
                      <td className="px-4 py-2.5 text-slate-700">Quantity</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-700">{fmtCount(s.sales?.quantity)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-red-600">{fmtCount(s.returns?.quantity)}</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold">{fmtCount(s.net?.quantity)}</td>
                    </tr>
                    <tr className="bg-slate-50/50">
                      <td className="px-4 py-2.5 text-slate-700 font-medium">Taxable Value</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-700">₹ {fmt2(s.sales?.taxableValue)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-red-600">₹ {fmt2(s.returns?.taxableValue)}</td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold text-slate-900">₹ {fmt2(s.net?.taxableValue)}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2.5 text-slate-500">IGST</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-600">₹ {fmt2(s.sales?.igst)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-red-500">₹ {fmt2(s.returns?.igst)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-700">₹ {fmt2(s.net?.igst)}</td>
                    </tr>
                    <tr className="bg-slate-50/50">
                      <td className="px-4 py-2.5 text-slate-500">CGST</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-600">₹ {fmt2(s.sales?.cgst)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-red-500">₹ {fmt2(s.returns?.cgst)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-700">₹ {fmt2(s.net?.cgst)}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2.5 text-slate-500">SGST / UGST</td>
                      <td className="px-4 py-2.5 text-right font-mono text-green-600">₹ {fmt2(s.sales?.sgst)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-red-500">₹ {fmt2(s.returns?.sgst)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-700">₹ {fmt2(s.net?.sgst)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="flex gap-3 pt-1">
                <Button type="button" variant="outline" className="flex-1 border-red-200 text-red-600 hover:bg-red-50" onClick={handleDiscard} disabled={isCommitting}>
                  <XCircle className="mr-2 h-4 w-4" />Discard
                </Button>
                <Button type="button" className="flex-1 bg-green-600 hover:bg-green-700 text-white" onClick={handleCommit} disabled={isCommitting}>
                  {isCommitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : <><CheckCircle2 className="mr-2 h-4 w-4" />Accept &amp; Save</>}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

export default MeeshoWorkspace;

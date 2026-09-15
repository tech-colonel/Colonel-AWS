import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Upload, FileText, Download, Trash2, Loader2, Eye, X, BarChart3, CloudDownload, CheckCircle2, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import api from '../../lib/api';
import { toast } from 'sonner';
import { format } from 'date-fns';
import * as XLSX from 'xlsx';

const SettlementAmazonWorkspace = ({ agent }) => {
  const { brandId, agentId } = useParams();

  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  /* Amazon connection for THIS brand. Null means the brand has no connection,
     and the "Fetch from Amazon" button stays hidden — so today it appears for
     Koparo only, and for any brand connected later without a code change. */
  const [amazonConn, setAmazonConn] = useState(null);
  const [fetchingAmazon, setFetchingAmazon] = useState(false);
  const [amazonSummary, setAmazonSummary] = useState(null);

  // Upload modal
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [settlementFile, setSettlementFile] = useState(null);

  // View data modal
  const [showDataModal, setShowDataModal] = useState(false);
  const [viewData, setViewData] = useState([]);
  const [viewDataLoading, setViewDataLoading] = useState(false);
  const [viewFilename, setViewFilename] = useState('');

  // MIS states
  const [showConfigMISModal, setShowConfigMISModal] = useState(false);
  const [showMISResultModal, setShowMISResultModal] = useState(false);
  const [misConfig, setMisConfig] = useState({ startMonth: '', endMonth: '', startYear: new Date().getFullYear().toString(), endYear: new Date().getFullYear().toString() });
  const [misData, setMisData] = useState({ columns: [], data: [] });
  const [isGeneratingMIS, setIsGeneratingMIS] = useState(false);

  useEffect(() => {
    fetchFiles();
  }, [brandId, agentId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/api/amazon/${brandId}/connection`);
        if (cancelled) return;
        const conn = r.data?.connection || null;
        setAmazonConn(conn);
        if (conn) {
          const sum = await api
            .get(`/api/brands/${brandId}/agents/${agentId}/settlement-amazon/summary`)
            .catch(() => null);
          if (!cancelled && sum) setAmazonSummary(sum.data);
        }
      } catch {
        if (!cancelled) setAmazonConn(null);   // not connected, or no permission
      }
    })();
    return () => { cancelled = true; };
  }, [brandId, agentId]);

  const fetchFiles = async () => {
    try {
      setLoading(true);
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/settlement-amazon/files`);
      setFiles(res.data || []);
    } catch (error) {
      console.error('Failed to load settlement files:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async () => {
    if (!settlementFile) {
      toast.error('Please select a file');
      return;
    }

    const formData = new FormData();
    formData.append('file', settlementFile);

    setUploading(true);
    try {
      const res = await api.post(
        `/api/brands/${brandId}/agents/${agentId}/settlement-amazon/upload`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      toast.success(`Settlement uploaded: ${res.data.data.count} rows`);
      setShowUploadModal(false);
      setSettlementFile(null);
      fetchFiles();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  /* Pull settlements straight from Amazon. The server refuses to store a
     settlement whose figures do not balance, so a rejection is reported here
     rather than silently swallowed. */
  const handleFetchFromAmazon = async () => {
    setFetchingAmazon(true);
    try {
      const res = await api.post(
        `/api/brands/${brandId}/agents/${agentId}/settlement-amazon/fetch-amazon?limit=5&days=90`
      );
      const { imported = [], skipped = [], rejected = [] } = res.data || {};

      if (rejected.length) {
        toast.error(
          `${rejected.length} settlement(s) could not be imported — the figures did not balance. Nothing was stored.`
        );
      }
      if (imported.length) {
        const rows = imported.reduce((n, s) => n + (s.stored_rows || 0), 0);
        toast.success(`Imported ${imported.length} settlement(s) · ${rows} rows`);
      } else if (!rejected.length) {
        toast.info(
          skipped.length
            ? 'Already up to date — those settlements are imported.'
            : 'No new settlements found in the last 90 days.'
        );
      }
      fetchFiles();
      api.get(`/api/brands/${brandId}/agents/${agentId}/settlement-amazon/summary`)
        .then((r) => setAmazonSummary(r.data))
        .catch(() => {});
    } catch (error) {
      toast.error(error.response?.data?.error || 'Could not fetch from Amazon');
    } finally {
      setFetchingAmazon(false);
    }
  };

  const handleDownload = async (fileId) => {
    try {
      const response = await api.get(
        `/api/brands/${brandId}/agents/${agentId}/settlement-amazon/files/${fileId}/download`,
        { responseType: 'blob' }
      );
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `settlement_${fileId}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success('File downloaded');
    } catch (error) {
      toast.error('Download failed');
    }
  };

  const handleDelete = async (fileId) => {
    if (!window.confirm('Are you sure you want to delete this settlement file?')) return;
    try {
      await api.delete(`/api/brands/${brandId}/agents/${agentId}/settlement-amazon/files/${fileId}`);
      toast.success('File deleted');
      fetchFiles();
    } catch (error) {
      toast.error('Delete failed');
    }
  };

  const handleViewData = async (filename) => {
    setViewFilename(filename);
    setViewDataLoading(true);
    setShowDataModal(true);
    try {
      const res = await api.get(
        `/api/brands/${brandId}/agents/${agentId}/settlement-amazon/data`,
        { params: { filename } }
      );
      setViewData(res.data.data || []);
    } catch (error) {
      toast.error('Failed to load data');
      setViewData([]);
    } finally {
      setViewDataLoading(false);
    }
  };

  // Columns to display in data view
  const dataColumns = [
    { key: 'date_time', label: 'Date/Time' },
    { key: 'settlement_id', label: 'Settlement ID' },
    { key: 'type', label: 'Type' },
    { key: 'order_id', label: 'Order ID' },
    { key: 'sku', label: 'SKU' },
    { key: 'description', label: 'Description' },
    { key: 'quantity', label: 'Qty' },
    { key: 'product_sales', label: 'Product Sales' },
    { key: 'selling_fees', label: 'Selling Fees' },
    { key: 'fba_fees', label: 'FBA Fees' },
    { key: 'total', label: 'Total' },
  ];

  const fmt = (val) => {
    if (val === null || val === undefined || val === '') return '—';
    const n = Number(val);
    if (!isNaN(n) && typeof val !== 'string') {
      return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    }
    return String(val);
  };

  const handleGenerateMIS = async (e) => {
    if (e) e.preventDefault();
    if (!misConfig.startMonth || !misConfig.endMonth || !misConfig.startYear || !misConfig.endYear) {
      toast.error('Please select start and end month/year');
      return;
    }
    setIsGeneratingMIS(true);
    try {
      const res = await api.post(`/api/brands/${brandId}/agents/${agentId}/settlement-amazon/mis`, misConfig);
      setMisData(res.data);
      setShowConfigMISModal(false);
      setShowMISResultModal(true);
      toast.success('MIS Generated Successfully');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to generate MIS');
    } finally {
      setIsGeneratingMIS(false);
    }
  };

  const handleExportMIS = () => {
    if (!misData.data || misData.data.length === 0) {
      toast.error('No data to export');
      return;
    }
    
    // Map with dynamic columns
    const exportData = misData.data.map(row => {
      let r = {};
      misData.columns.forEach(col => {
        r[col.title] = row[col.key];
      });
      return r;
    });

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Settlement_MIS");
    XLSX.writeFile(wb, `Settlement_MIS_Amazon_${misConfig.startMonth}_${misConfig.endMonth}.xlsx`);
  };

  return (
    <div className="space-y-6">
      {/* Upload & MIS Card */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {amazonConn ? (
          <AmazonSettlementPanel
            conn={amazonConn}
            summary={amazonSummary}
            fetching={fetchingAmazon}
            onFetch={handleFetchFromAmazon}
            onUpload={() => setShowUploadModal(true)}
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Settlement File Upload</CardTitle>
              <CardDescription>Upload Amazon settlement reports to store data</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => setShowUploadModal(true)}
                className="w-full"
                data-testid="upload-settlement-button"
              >
                <Upload className="mr-2 h-4 w-4" />
                Upload Settlement File
              </Button>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Management Information System</CardTitle>
            <CardDescription>Generate Settlement MIS Reports</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => setShowConfigMISModal(true)}
              variant="default"
              className="w-full bg-slate-700 hover:bg-slate-800"
              data-testid="mis-settlement-button"
            >
              <BarChart3 className="mr-2 h-4 w-4" />
              MIS Settlement
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Files Table */}
      <Card>
        <CardHeader>
          <CardTitle>Uploaded Settlement Files</CardTitle>
          <CardDescription>View, download, or delete previously uploaded settlement files</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
            </div>
          ) : files.length === 0 ? (
            <div className="py-8 text-center text-slate-600" data-testid="no-files-message">
              <FileText className="h-12 w-12 text-slate-400 mx-auto mb-4" />
              No settlement files uploaded yet
            </div>
          ) : (
            <div className="border border-slate-200 rounded-lg" data-testid="settlement-files-table">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Settlement ID</TableHead>
                    <TableHead>Filename</TableHead>
                    <TableHead>Uploaded</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {files.map((file) => (
                    <TableRow key={file.id} data-testid={`settlement-file-${file.id}`}>
                      <TableCell className="font-medium">{file.settlement_id || '—'}</TableCell>
                      <TableCell className="text-sm text-slate-600 max-w-[250px] truncate">
                        {file.filename}
                      </TableCell>
                      <TableCell className="text-sm text-slate-600">
                        {file.created_at ? format(new Date(file.created_at), 'dd MMM yyyy HH:mm') : 'N/A'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleViewData(file.filename)}
                            title="View data"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => handleDownload(file.id)}
                            title="Download"
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleDelete(file.id)}
                            title="Delete"
                          >
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

      {/* Upload Modal */}
      <Dialog open={showUploadModal} onOpenChange={setShowUploadModal}>
        <DialogContent onClose={() => setShowUploadModal(false)}>
          <DialogHeader>
            <DialogTitle>Upload Settlement File</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="settlement-file">Select Excel File *</Label>
              <Input
                id="settlement-file"
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => setSettlementFile(e.target.files[0])}
                data-testid="settlement-file-input"
                className="mt-2"
              />
              <p className="text-xs text-slate-500 mt-2">
                Upload an Amazon settlement report (.xlsx or .csv)
              </p>
            </div>
            <div className="flex gap-3 pt-4">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowUploadModal(false)}
                className="flex-1"
                disabled={uploading}
              >
                Cancel
              </Button>
              <Button
                onClick={handleUpload}
                className="flex-1"
                disabled={uploading}
                data-testid="settlement-upload-submit"
              >
                {uploading ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Uploading...</>
                ) : (
                  'Upload'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* View Data Modal */}
      <Dialog open={showDataModal} onOpenChange={setShowDataModal}>
        <DialogContent
          onClose={() => setShowDataModal(false)}
          className="max-w-[95vw] max-h-[90vh] flex flex-col overflow-hidden"
        >
          <DialogHeader className="pb-2 border-b">
            <DialogTitle>
              Settlement Data {viewData.length > 0 && `(${viewData.length} rows)`}
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-auto bg-white pt-2">
            {viewDataLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-slate-400 mr-2" />
                <span className="text-slate-500 text-sm">Loading data...</span>
              </div>
            ) : viewData.length > 0 ? (
              <Table className="relative">
                <TableHeader className="bg-slate-50 sticky top-0 z-10 shadow-sm">
                  <TableRow>
                    {dataColumns.map((col) => (
                      <TableHead key={col.key} className="text-xs whitespace-nowrap p-3">
                        {col.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {viewData.map((row, rIdx) => (
                    <TableRow key={rIdx}>
                      {dataColumns.map((col) => (
                        <TableCell key={col.key} className="text-xs whitespace-nowrap p-3">
                          {['product_sales', 'selling_fees', 'fba_fees', 'total'].includes(col.key)
                            ? fmt(row[col.key])
                            : (row[col.key] ?? '—')}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="py-12 text-center text-slate-500">No data found.</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* MIS Configuration Modal */}
      <Dialog open={showConfigMISModal} onOpenChange={setShowConfigMISModal}>
        <DialogContent onClose={() => setShowConfigMISModal(false)}>
          <DialogHeader>
            <DialogTitle>Generate Settlement MIS</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleGenerateMIS} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Start Month</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 mt-1"
                  value={misConfig.startMonth}
                  onChange={(e) => setMisConfig({ ...misConfig, startMonth: e.target.value })}
                  required
                >
                  <option value="">Select Month</option>
                  {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Start Year</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 mt-1"
                  value={misConfig.startYear}
                  onChange={(e) => setMisConfig({ ...misConfig, startYear: e.target.value })}
                  required
                >
                  {[2023, 2024, 2025, 2026, 2027].map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>End Month</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 mt-1"
                  value={misConfig.endMonth}
                  onChange={(e) => setMisConfig({ ...misConfig, endMonth: e.target.value })}
                  required
                >
                  <option value="">Select Month</option>
                  {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>End Year</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 mt-1"
                  value={misConfig.endYear}
                  onChange={(e) => setMisConfig({ ...misConfig, endYear: e.target.value })}
                  required
                >
                  {[2023, 2024, 2025, 2026, 2027].map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex gap-3 pt-4">
              <Button type="button" variant="secondary" onClick={() => setShowConfigMISModal(false)} className="flex-1">
                Cancel
              </Button>
              <Button type="submit" className="flex-1" disabled={isGeneratingMIS}>
                {isGeneratingMIS ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : 'Generate MIS'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* MIS Result Modal */}
      <Dialog open={showMISResultModal} onOpenChange={setShowMISResultModal}>
        <DialogContent className="max-w-[95vw] max-h-[95vh] flex flex-col" onClose={() => setShowMISResultModal(false)}>
          <DialogHeader className="flex flex-row items-center justify-between border-b pb-4 shrink-0">
            <div>
              <DialogTitle className="text-xl font-bold">Settlement MIS Report</DialogTitle>
              <p className="text-sm text-slate-500 mt-1">
                {misConfig.startMonth} {misConfig.startYear} to {misConfig.endMonth} {misConfig.endYear}
              </p>
            </div>
            <Button onClick={handleExportMIS} variant="outline" className="mr-8">
              <Download className="mr-2 h-4 w-4" />
              Export Excel
            </Button>
          </DialogHeader>
          <div className="flex-1 overflow-auto bg-white p-4">
            <Table>
              <TableHeader className="bg-slate-50 sticky top-0 z-10 shadow-sm">
                <TableRow>
                  {misData.columns.map(col => (
                    <TableHead key={col.key} className={`font-semibold ${col.key === 'particulars' ? 'w-[300px]' : 'text-right'}`}>
                      {col.title}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {misData.data.map((row, idx) => {
                  const isHeaderRow = row.isHeader;
                  return (
                    <TableRow key={idx} className={isHeaderRow ? 'bg-slate-100/80 hover:bg-slate-100/80' : ''}>
                      {misData.columns.map(col => {
                        let val = row[col.key];
                        let formattedVal = val;
                        
                        if (col.key !== 'particulars' && !isHeaderRow) {
                          if (val === null || val === undefined || isNaN(val)) {
                            formattedVal = '—';
                          } else {
                            // Determine if it's a percentage row or units row
                            const rName = row.particulars || '';
                            if (rName.includes('%') || rName.includes('Rate')) {
                              formattedVal = `${Number(val).toFixed(2)}%`;
                            } else if (rName.includes('No. of Orders') || rName.includes('Units')) {
                              formattedVal = Number(val).toLocaleString('en-IN');
                            } else {
                              formattedVal = `₹${Number(val).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
                            }
                          }
                        }

                        return (
                          <TableCell
                            key={col.key}
                            className={`
                              ${col.key === 'particulars' ? (isHeaderRow ? 'font-bold text-slate-800 uppercase text-xs tracking-wider pt-6' : 'font-medium pl-6 text-slate-600') : 'text-right font-medium text-slate-700'}
                              ${isHeaderRow && col.key !== 'particulars' ? 'opacity-0' : ''}
                            `}
                          >
                            {formattedVal}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};


/* ──────────────────────────────────────────────────────────────────────────────
   AmazonSettlementPanel — shown only for brands with a live Amazon connection.

   Brands without one keep the original upload card untouched, so this is purely
   additive: today that means Koparo sees this and the other eighteen do not.

   The figures are the brand's real imported position, not decoration — which is
   the point of the panel. An accountant opening this should be able to see what
   has been brought in and what it came to before deciding to do anything.
   ────────────────────────────────────────────────────────────────────────────── */
const inr = (n) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? '—'
    : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const Stat = ({ label, value, tone = 'default', sub }) => (
  <div className="flex flex-col gap-0.5 px-4 py-3 rounded-lg bg-slate-50/80 border border-slate-200/70">
    <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">{label}</span>
    <span
      className={`text-[19px] font-semibold tabular-nums leading-tight ${
        tone === 'negative' ? 'text-rose-600' : tone === 'positive' ? 'text-emerald-600' : 'text-slate-900'
      }`}
    >
      {value}
    </span>
    {sub ? <span className="text-[11px] text-slate-500">{sub}</span> : null}
  </div>
);

const AmazonSettlementPanel = ({ conn, summary, fetching, onFetch, onUpload }) => {
  const synced = summary?.lastSync ? new Date(summary.lastSync) : null;
  const hasData = !!summary && summary.settlements > 0;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      {/* connection strip */}
      <div className="flex items-center gap-3 px-5 py-3.5 bg-gradient-to-r from-amber-50/80 to-white border-b border-slate-200">
        <img src="/logos/amazon.svg" alt="Amazon" className="h-5 w-5 object-contain shrink-0" />
        <div className="flex flex-col min-w-0">
          <span className="text-[13.5px] font-semibold text-slate-900 leading-tight">Amazon Seller Central</span>
          <span className="text-[11.5px] text-slate-500 truncate">
            {conn.marketplace_id === 'A21TJRUUN4KGV' ? 'Amazon.in' : conn.marketplace_id}
            {conn.selling_partner_id ? ` · ${conn.selling_partner_id}` : ''}
          </span>
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 shrink-0 rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-emerald-700">
          <CheckCircle2 className="h-3 w-3" /> Connected
        </span>
      </div>

      <div className="p-5 flex flex-col gap-4">
        {/* imported position */}
        {hasData ? (
          <div className="grid grid-cols-2 xl:grid-cols-5 gap-2.5">
            {/* Read left to right as a bridge: sales + GST − fees ≈ payout.
                "Product sales" is taxable value — ex-GST and net of refunds — so
                the payout can legitimately exceed it; the GST tile is what makes
                that visible instead of looking like an error. */}
            <Stat label="Settlements" value={summary.settlements} sub={`${inr(summary.rows)} lines`} />
            <Stat label="Product sales" value={`₹${inr(summary.grossSales)}`} sub="ex-GST · net of refunds" />
            <Stat label="GST collected" value={`₹${inr(summary.gstCollected)}`} sub="passed through · payable" />
            <Stat label="Amazon fees" value={`₹${inr(summary.amazonFees)}`} tone="negative" sub="incl. GST on fees" />
            <Stat label="Net payout" value={`₹${inr(summary.netPayout)}`} tone="positive" sub="received in bank" />
          </div>
        ) : (
          <p className="text-[13px] text-slate-500">
            Nothing imported yet. Fetch the last 90 days of settlements straight from Amazon.
          </p>
        )}

        {/* actions */}
        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            onClick={onFetch}
            disabled={fetching}
            className="flex-1 bg-[#0748EE] hover:bg-[#0640d0] text-white shadow-sm"
            data-testid="fetch-amazon-settlement-button"
          >
            {fetching ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Fetching from Amazon…</>
            ) : (
              <><CloudDownload className="mr-2 h-4 w-4" /> {hasData ? 'Sync latest settlements' : 'Fetch from Amazon'}</>
            )}
          </Button>
          <Button onClick={onUpload} variant="outline" className="sm:w-auto" data-testid="upload-settlement-button">
            <Upload className="mr-2 h-4 w-4" />
            Upload file
          </Button>
        </div>

        <div className="flex items-center gap-1.5 text-[11.5px] text-slate-500">
          <RefreshCw className="h-3 w-3 shrink-0" />
          {synced
            ? <span>Last synced {synced.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · settlements already imported are skipped</span>
            : <span>Amazon issues settlements on its own fortnightly schedule — they cannot be requested for a chosen period</span>}
        </div>
      </div>
    </div>
  );
};

export default SettlementAmazonWorkspace;

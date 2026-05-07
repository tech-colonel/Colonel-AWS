import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Upload, FileText, Download, Trash2, Loader2, Eye, X, BarChart3 } from 'lucide-react';
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

export default SettlementAmazonWorkspace;

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Bot, Upload, FileText, Download, Trash2, Eye, Plus, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import api from '../../lib/api';
import { toast } from 'sonner';
import { format } from 'date-fns';

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const AgentWorkspace = () => {
  const { brandId, agentId } = useParams();
  const navigate = useNavigate();
  const [agent, setAgent] = useState(null);
  const [masterData, setMasterData] = useState({ sku_master: [], ledger_master: [] });
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);

  // Modal states
  const [showUploadSkuModal, setShowUploadSkuModal] = useState(false);
  const [showUploadLedgerModal, setShowUploadLedgerModal] = useState(false);
  const [showViewSkuModal, setShowViewSkuModal] = useState(false);
  const [showViewLedgerModal, setShowViewLedgerModal] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);

  const [skuFile, setSkuFile] = useState(null);
  const [ledgerFile, setLedgerFile] = useState(null);

  const [formData, setFormData] = useState({
    month: '',
    year: new Date().getFullYear().toString(),
    file_type: 'B2B',
    inventory_type: 'With',
    salesFile: null,
    rtoFile: null,
    rtFile: null,
    packedFile: null
  });

  const sidebarItems = [
    { path: `/brands/${brandId}/dashboard`, label: 'Agent Workspace', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'Agents', icon: Bot, testId: 'nav-agents' },
    { path: `/brands/${brandId}/agents`, label: `${agent?.name} Dashboard`, icon: Bot, testId: 'nav-agents' }
  ];

  useEffect(() => {
    fetchData();
  }, [brandId, agentId]);

  const fetchData = async () => {
    try {
      const agentType = await detectAgentType();
      const [agentRes, masterRes, filesRes] = await Promise.all([
        api.get(`/api/agents`),
        api.get(`/api/brands/${brandId}/agents/${agentId}/${agentType}/master`),
        api.get(`/api/brands/${brandId}/agents/${agentId}/working-files`)
      ]);

      const currentAgent = agentRes.data.find(a => a.id === agentId);
      console.log("currect agent", currentAgent);
      setAgent(currentAgent);
      setMasterData(masterRes.data);

      const sortedFiles = filesRes.data.sort((a, b) => {
        const yearA = parseInt(a.year) || 0;
        const yearB = parseInt(b.year) || 0;
        if (yearA !== yearB) return yearB - yearA;
        return (parseInt(b.month) || 0) - (parseInt(a.month) || 0);
      });

      setFiles(sortedFiles);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  };

  const detectAgentType = async () => {
    try {
      const response = await api.get(`/api/agents`);
      const currentAgent = response.data.find(a => a.id === agentId);
      if (currentAgent?.name?.toLowerCase().includes('amazon')) return 'amazon';
      if (currentAgent?.name?.toLowerCase().includes('flipkart')) return 'flipkart';
      if (currentAgent?.name?.toLowerCase().includes('myntra')) return 'myntra';
      if (currentAgent?.name?.toLowerCase().includes('blinkit')) return 'blinkit';
      if (currentAgent?.name?.toLowerCase().includes('firstcry')) return 'firstcry';
      return 'amazon';
    } catch (error) {
      return 'amazon';
    }
  };

  const handleUploadSku = async () => {
    if (!skuFile) {
      toast.error('Please select a file');
      return;
    }

    const formData = new FormData();
    formData.append('file', skuFile);

    try {
      const agentType = await detectAgentType();
      await api.post(`/api/brands/${brandId}/agents/${agentId}/${agentType}/master/sku`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      toast.success('SKU Master uploaded successfully');
      setShowUploadSkuModal(false);
      setSkuFile(null);
      fetchData();
    } catch (error) {
      toast.error('Upload failed');
    }
  };

  const handleUploadLedger = async () => {
    if (!ledgerFile) {
      toast.error('Please select a file');
      return;
    }

    const formData = new FormData();
    formData.append('file', ledgerFile);

    try {
      const agentType = await detectAgentType();
      await api.post(`/api/brands/${brandId}/agents/${agentId}/${agentType}/master/ledger`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      toast.success('Ledger Master uploaded successfully');
      setShowUploadLedgerModal(false);
      setLedgerFile(null);
      fetchData();
    } catch (error) {
      toast.error('Upload failed');
    }
  };

  const handleGenerateFile = async (e) => {
    e.preventDefault();
    const data = new FormData();
    if (isMyntra) {
      if (!formData.rtoFile && !formData.packedFile && !formData.rtFile) {
        toast.error('Please upload at least one Myntra report');
        return;
      }
      if (formData.rtoFile) data.append('rtoFile', formData.rtoFile);
      if (formData.packedFile) data.append('packedFile', formData.packedFile);
      if (formData.rtFile) data.append('rtFile', formData.rtFile);
    } else {
      if (!formData.salesFile) {
        toast.error('Please select a sales file');
        return;
      }
      data.append('file', formData.salesFile);
    }
    data.append('month', formData.month);
    data.append('year', formData.year);
    data.append('file_type', formData.file_type);
    data.append('inventory_type', formData.inventory_type);

    setIsGenerating(true);

    try {
      const agentType = await detectAgentType();
      await api.post(`/api/brands/${brandId}/agents/${agentId}/${agentType}/generate`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      toast.success('Working file generated successfully');
      setShowGenerateModal(false);
      fetchData();
      setFormData({ ...formData, salesFile: null, rtoFile: null, packedFile: null, rtFile: null });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to generate file');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = async (fileId) => {
    try {
      const agentType = await detectAgentType();
      const response = await api.get(
        `/api/brands/${brandId}/agents/${agentId}/working-files/${fileId}/download`,
        { responseType: 'blob' }
      );

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `working_file_${fileId}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success('File downloaded');
    } catch (error) {
      toast.error('Download failed');
    }
  };

  const handleDelete = async (fileId) => {
    if (!window.confirm('Are you sure you want to delete this file?')) return;

    try {
      const agentType = await detectAgentType();
      await api.delete(`/api/brands/${brandId}/agents/${agentId}/working-files/${fileId}`);
      toast.success('File deleted');
      fetchData();
    } catch (error) {
      toast.error('Delete failed');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-slate-900"></div>
      </div>
    );
  }

  const isFlipkart = agent?.name?.toLowerCase().includes('flipkart');
  const isMyntra = agent?.name?.toLowerCase().includes('myntra');
  const isBlinkit = agent?.name?.toLowerCase().includes('blinkit');
  const isFirstcry = agent?.name?.toLowerCase().includes('firstcry');

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="agent-workspace">
        <div className="mb-8">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/brands/${brandId}/dashboard`)}
            className="mb-4"
            data-testid="back-button"
          >
            ← Back to Dashboard
          </Button>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">{agent?.name}</h1>
          <p className="text-slate-600 mt-1">{agent?.description}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <Card>
            <CardHeader>
              <CardTitle>Master Data Management</CardTitle>
              <CardDescription>Upload and view SKU and Ledger master data</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  onClick={() => setShowUploadSkuModal(true)}
                  data-testid="upload-sku-button"
                  className="w-full"
                >
                  <Upload className="mr-2 h-4 w-4" />
                  Upload SKU
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowViewSkuModal(true)}
                  data-testid="view-sku-button"
                  className="w-full"
                >
                  <Eye className="mr-2 h-4 w-4" />
                  View SKU
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  onClick={() => setShowUploadLedgerModal(true)}
                  data-testid="upload-ledger-button"
                  className="w-full"
                >
                  <Upload className="mr-2 h-4 w-4" />
                  Upload Ledger
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowViewLedgerModal(true)}
                  data-testid="view-ledger-button"
                  className="w-full"
                >
                  <Eye className="mr-2 h-4 w-4" />
                  View Ledger
                </Button>
              </div>
              <div className="pt-2 text-xs text-slate-500 space-y-1">
                <p>SKU Master: {masterData.sku_master?.length || 0} records</p>
                <p>Ledger Master: {masterData.ledger_master?.length || 0} records</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Working File Generation</CardTitle>
              <CardDescription>Process sales data with master information</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => setShowGenerateModal(true)}
                className="w-full"
                data-testid="create-file-button"
              >
                <Plus className="mr-2 h-4 w-4" />
                Create New File
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
            {files.length === 0 ? (
              <div className="py-8 text-center text-slate-600" data-testid="no-files-message">
                <FileText className="h-12 w-12 text-slate-400 mx-auto mb-4" />
                No files generated yet
              </div>
            ) : (
              <div className="border border-slate-200 rounded-lg" data-testid="files-table">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead>Year</TableHead>
                      {!isFlipkart && !isBlinkit && !isFirstcry && <TableHead>Type</TableHead>}
                      <TableHead>Inventory</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {files.map((file) => (
                      <TableRow key={file.id} data-testid={`file-row-${file.id}`}>
                        <TableCell className="font-medium">{MONTH_NAMES[file.month] || file.month}</TableCell>
                        <TableCell>{file.year}</TableCell>
                        {!isFlipkart && !isBlinkit && !isFirstcry && <TableCell><Badge variant="secondary">{file.file_type}</Badge></TableCell>}
                        <TableCell>{file.inventory_type}</TableCell>
                        <TableCell className="text-sm text-slate-600">
                          {file.created_at ? format(new Date(file.created_at), 'dd MMM yyyy') : 'N/A'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => handleDownload(file.id)}
                              data-testid={`download-${file.id}`}
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => handleDelete(file.id)}
                              data-testid={`delete-${file.id}`}
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
      </div>

      {/* Upload SKU Master Modal */}
      <Dialog open={showUploadSkuModal} onOpenChange={setShowUploadSkuModal}>
        <DialogContent onClose={() => setShowUploadSkuModal(false)}>
          <DialogHeader>
            <DialogTitle>Upload SKU Master</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="sku-file">Select Excel File *</Label>
              <Input
                id="sku-file"
                type="file"
                accept=".xlsx,.xls"
                onChange={(e) => setSkuFile(e.target.files[0])}
                data-testid="sku-file-input"
                className="mt-2"
              />
              <p className="text-xs text-slate-500 mt-2">
                Upload Excel file with columns: Sales Portal SKU, Tally New SKU
              </p>
            </div>
            <div className="flex gap-3 pt-4">
              <Button type="button" variant="secondary" onClick={() => setShowUploadSkuModal(false)} className="flex-1">
                Cancel
              </Button>
              <Button onClick={handleUploadSku} className="flex-1" data-testid="sku-upload-submit">
                Upload
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Upload Ledger Master Modal */}
      <Dialog open={showUploadLedgerModal} onOpenChange={setShowUploadLedgerModal}>
        <DialogContent onClose={() => setShowUploadLedgerModal(false)}>
          <DialogHeader>
            <DialogTitle>Upload Ledger Master</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="ledger-file">Select Excel File *</Label>
              <Input
                id="ledger-file"
                type="file"
                accept=".xlsx,.xls"
                onChange={(e) => setLedgerFile(e.target.files[0])}
                data-testid="ledger-file-input"
                className="mt-2"
              />
              <p className="text-xs text-slate-500 mt-2">
                Upload Excel file with columns: State, Ledger, Invoice No.
              </p>
            </div>
            <div className="flex gap-3 pt-4">
              <Button type="button" variant="secondary" onClick={() => setShowUploadLedgerModal(false)} className="flex-1">
                Cancel
              </Button>
              <Button onClick={handleUploadLedger} className="flex-1" data-testid="ledger-upload-submit">
                Upload
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* View SKU Master Modal */}
      <Dialog open={showViewSkuModal} onOpenChange={setShowViewSkuModal}>
        <DialogContent onClose={() => setShowViewSkuModal(false)} className="max-w-4xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>SKU Master Data ({masterData.sku_master?.length || 0} records)</DialogTitle>
          </DialogHeader>
          <div>
            {masterData.sku_master?.length > 0 ? (
              <div className="border rounded-lg overflow-auto max-h-[500px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {Object.keys(masterData.sku_master[0]).map(key => (
                        <TableHead key={key}>{key}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {masterData.sku_master.slice(0, 50).map((row, idx) => (
                      <TableRow key={idx}>
                        {Object.values(row).map((val, i) => (
                          <TableCell key={i} className="text-xs">{val}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {masterData.sku_master.length > 50 && (
                  <p className="text-xs text-slate-500 p-3 text-center border-t">
                    Showing 50 of {masterData.sku_master.length} records
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-600 py-8 text-center">No SKU master data uploaded</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* View Ledger Master Modal */}
      <Dialog open={showViewLedgerModal} onOpenChange={setShowViewLedgerModal}>
        <DialogContent onClose={() => setShowViewLedgerModal(false)} className="max-w-4xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Ledger Master Data ({masterData.ledger_master?.length || 0} records)</DialogTitle>
          </DialogHeader>
          <div>
            {masterData.ledger_master?.length > 0 ? (
              <div className="border rounded-lg overflow-auto max-h-[500px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {Object.keys(masterData.ledger_master[0]).map(key => (
                        <TableHead key={key}>{key}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {masterData.ledger_master.slice(0, 50).map((row, idx) => (
                      <TableRow key={idx}>
                        {Object.values(row).map((val, i) => (
                          <TableCell key={i} className="text-xs">{val}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {masterData.ledger_master.length > 50 && (
                  <p className="text-xs text-slate-500 p-3 text-center border-t">
                    Showing 50 of {masterData.ledger_master.length} records
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-600 py-8 text-center">No ledger master data uploaded</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Generate Working File Modal */}
      <Dialog open={showGenerateModal} onOpenChange={setShowGenerateModal}>
        <DialogContent onClose={() => setShowGenerateModal(false)}>
          <DialogHeader>
            <DialogTitle>Generate Working File</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleGenerateFile} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="month">Month *</Label>
                <select
                  id="month"
                  value={formData.month}
                  onChange={(e) => setFormData({ ...formData, month: e.target.value })}
                  required
                  data-testid="month-select"
                  className="flex h-9 w-full rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm mt-2"
                >
                  <option value="">Select</option>
                  {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="year">Year *</Label>
                <Input
                  id="year"
                  type="number"
                  value={formData.year}
                  onChange={(e) => setFormData({ ...formData, year: e.target.value })}
                  required
                  data-testid="year-input"
                  className="mt-2"
                />
              </div>
            </div>

            {!isFlipkart && !isBlinkit && !isFirstcry && (
              <div>
                <Label htmlFor="file-type">File Type *</Label>
                <select
                  id="file-type"
                  value={formData.file_type}
                  onChange={(e) => setFormData({ ...formData, file_type: e.target.value })}
                  data-testid="file-type-select"
                  className="flex h-9 w-full rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm mt-2"
                >
                  <option value="B2B">B2B</option>
                  <option value="B2C">B2C</option>
                </select>
              </div>
            )}

            <div>
              <Label htmlFor="inventory-type">Inventory *</Label>
              <select
                id="inventory-type"
                value={formData.inventory_type}
                onChange={(e) => setFormData({ ...formData, inventory_type: e.target.value })}
                data-testid="inventory-select"
                className="flex h-9 w-full rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm mt-2"
              >
                <option value="With">With Inventory</option>
                <option value="Without">Without Inventory</option>
              </select>
            </div>

            {isMyntra ? (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="packed-file">Packed File (Sales) *</Label>
                  <Input
                    id="packed-file"
                    type="file"
                    onChange={(e) => setFormData({ ...formData, packedFile: e.target.files[0] })}
                    className="mt-2"
                  />
                </div>
                <div>
                  <Label htmlFor="rto-file">RTO File</Label>
                  <Input
                    id="rto-file"
                    type="file"
                    onChange={(e) => setFormData({ ...formData, rtoFile: e.target.files[0] })}
                    className="mt-2"
                  />
                </div>
                <div>
                  <Label htmlFor="rt-file">RT File (Returns)</Label>
                  <Input
                    id="rt-file"
                    type="file"
                    onChange={(e) => setFormData({ ...formData, rtFile: e.target.files[0] })}
                    className="mt-2"
                  />
                </div>
              </div>
            ) : (
              <div>
                <Label htmlFor="sales-file">Sales File *</Label>
                <Input
                  id="sales-file"
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={(e) => setFormData({ ...formData, salesFile: e.target.files[0] })}
                  required
                  data-testid="sales-file-upload"
                  className="mt-2"
                />
                <p className="text-xs text-slate-500 mt-2">
                  Upload sales Excel file to be processed
                </p>
              </div>
            )}

            <div className="flex gap-3 pt-4">
              <Button type="button" variant="secondary" onClick={() => setShowGenerateModal(false)} className="flex-1" disabled={isGenerating}>
                Cancel
              </Button>
              <Button type="submit" className="flex-1" data-testid="generate-submit" disabled={isGenerating}>
                {isGenerating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  'Generate File'
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
};

export default AgentWorkspace;

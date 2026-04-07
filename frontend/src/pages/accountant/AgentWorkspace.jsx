import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Bot, Upload, FileText, Download, Trash2, Eye, Plus, Loader2, BarChart3 } from 'lucide-react';
import CFODashboardLauncher from '../cfo/CFODashboardLauncher';
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

const AgentWorkspace = () => {
  const { brandId, agentId } = useParams();
  const navigate = useNavigate();
  const [agent, setAgent] = useState(null);
  const [masterData, setMasterData] = useState({ sku_master: [], ledger_master: [] });
  const [ledgerPreviewData, setLedgerPreviewData] = useState([]);
  const [ledgerPreviewLoading, setLedgerPreviewLoading] = useState(false);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showVerificationModal, setShowVerificationModal] = useState(false);
  const [verificationData, setVerificationData] = useState(null);

  const location = useLocation();
  const [allAgents, setAllAgents] = useState([]);

  const [cfoConfig, setCfoConfig] = useState({
    isOpen: location.state?.openCfo || false,
    startMonth: location.state?.startMonth || '',
    startYear: location.state?.startYear || '',
    endMonth: location.state?.endMonth || '',
    endYear: location.state?.endYear || ''
  });

  // Sync state when location.state changes (from Agent Switch)
  useEffect(() => {
    if (location.state?.openCfo) {
      setCfoConfig(prev => ({
        ...prev,
        isOpen: true,
        startMonth: location.state.startMonth || prev.startMonth,
        startYear: location.state.startYear || prev.startYear,
        endMonth: location.state.endMonth || prev.endMonth,
        endYear: location.state.endYear || prev.endYear
      }));
      // Clear history state to avoid sticking
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location.state, navigate, location.pathname]);

  // Modal states
  const [showUploadSkuModal, setShowUploadSkuModal] = useState(false);
  const [showUploadLedgerModal, setShowUploadLedgerModal] = useState(false);
  const [showViewSkuModal, setShowViewSkuModal] = useState(false);
  const [showViewLedgerModal, setShowViewLedgerModal] = useState(false);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [showInvoicePreviewModal, setShowInvoicePreviewModal] = useState(false);

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

      const currentAgent = agentRes.data.find(a => a.id.toString() === agentId.toString());
      console.log("currect agent", currentAgent);
      setAllAgents(agentRes.data);
      setAgent(currentAgent);
      setMasterData(masterRes.data);

      const monthOrder = {
        'January': 1, 'February': 2, 'March': 3, 'April': 4,
        'May': 5, 'June': 6, 'July': 7, 'August': 8,
        'September': 9, 'October': 10, 'November': 11, 'December': 12
      };

      const sortedFiles = filesRes.data.sort((a, b) => {
        const yearA = parseInt(a.year) || 0;
        const yearB = parseInt(b.year) || 0;
        if (yearA !== yearB) {
          return yearB - yearA;
        }
        const monthA = monthOrder[a.month] || 0;
        const monthB = monthOrder[b.month] || 0;
        return monthB - monthA;
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
      const currentAgent = response.data.find(a => a.id.toString() === agentId.toString());
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

  // Month abbreviation + number map
  const monthAbbr = {
    'January': { abbr: 'Jan', num: '01' },
    'February': { abbr: 'Feb', num: '02' },
    'March': { abbr: 'Mar', num: '03' },
    'April': { abbr: 'Apr', num: '04' },
    'May': { abbr: 'May', num: '05' },
    'June': { abbr: 'Jun', num: '06' },
    'July': { abbr: 'Jul', num: '07' },
    'August': { abbr: 'Aug', num: '08' },
    'September': { abbr: 'Sep', num: '09' },
    'October': { abbr: 'Oct', num: '10' },
    'November': { abbr: 'Nov', num: '11' },
    'December': { abbr: 'Dec', num: '12' }
  };

  // Fetch ledger data fresh from API for the preview modal
  const fetchLedgerPreview = async () => {
    try {
      setLedgerPreviewLoading(true);
      // First try to use already-loaded masterData (avoids redundant API call that could fail)
      if (masterData?.ledger_master?.length > 0) {
        setLedgerPreviewData(masterData.ledger_master);
        return;
      }
      // Fallback: fetch fresh from API
      const agentType = await detectAgentType();
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/${agentType}/master`);
      setLedgerPreviewData(res.data?.ledger_master || []);
    } catch {
      // If API fails but we have masterData, still use it
      setLedgerPreviewData(masterData?.ledger_master || []);
    } finally {
      setLedgerPreviewLoading(false);
    }
  };

  // Build preview rows: only State + Final Invoice Number
  const buildInvoicePreviews = () => {
    const m = monthAbbr[formData.month];
    const suffix = m ? `-${m.num}` : `-${formData.month}`;
    return ledgerPreviewData.map(row => {
      const base = row.invoice_no || row['Invoice No.'] || row['Invoice No'] || row.invoice_number || '';
      const state = row.states || row.States || '';
      return { state, preview: base ? `${base}${suffix}` : `(No base number)${suffix}` };
    });
  };

  // Intercept form submit — show preview first
  const handleGenerateFile = async (e) => {
    e.preventDefault();
    // Validate files before showing preview
    if (isMyntra) {
      if (!formData.rtoFile && !formData.packedFile && !formData.rtFile) {
        toast.error('Please upload at least one Myntra report');
        return;
      }
    } else {
      if (!formData.salesFile) {
        toast.error('Please select a sales file');
        return;
      }
    }
    if (!formData.month) {
      toast.error('Please select a month');
      return;
    }
    // Show invoice preview confirmation
    setShowGenerateModal(false);
    await fetchLedgerPreview();
    setShowInvoicePreviewModal(true);
  };

  // Phase 1: call /preview — runs processor, returns summary, does NOT save yet
  const confirmAndGenerate = async () => {
    const data = new FormData();
    if (isMyntra) {
      if (formData.rtoFile)    data.append('rtoFile',    formData.rtoFile);
      if (formData.packedFile) data.append('packedFile', formData.packedFile);
      if (formData.rtFile)     data.append('rtFile',     formData.rtFile);
    } else {
      data.append('file', formData.salesFile);
    }
    data.append('month',          formData.month);
    data.append('year',           formData.year);
    data.append('file_type',      formData.file_type);
    data.append('inventory_type', formData.inventory_type);

    setIsGenerating(true);
    setShowInvoicePreviewModal(false);

    try {
      const agentType = await detectAgentType();
      const res = await api.post(
        `/api/brands/${brandId}/agents/${agentId}/${agentType}/generate/preview`,
        data,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      setVerificationData(res.data); // { taskId, rowCount, summary }
      setShowVerificationModal(true);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to process file');
    } finally {
      setIsGenerating(false);
    }
  };

  // Phase 2a: accountant accepts — commit to DB + disk
  const handleCommit = async () => {
    if (!verificationData?.taskId) return;
    setIsGenerating(true);
    try {
      const agentType = await detectAgentType();
      await api.post(`/api/brands/${brandId}/agents/${agentId}/${agentType}/generate/commit`, {
        taskId: verificationData.taskId
      });
      toast.success('File accepted and saved successfully ✅');
      setShowVerificationModal(false);
      setVerificationData(null);
      fetchData();
      setFormData({ ...formData, salesFile: null, rtoFile: null, packedFile: null, rtFile: null });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to save file');
    } finally {
      setIsGenerating(false);
    }
  };

  // Phase 2b: accountant rejects — discard without saving
  const handleDiscard = async () => {
    if (!verificationData?.taskId) return;
    try {
      const agentType = await detectAgentType();
      await api.post(`/api/brands/${brandId}/agents/${agentId}/${agentType}/generate/discard`, {
        taskId: verificationData.taskId
      });
    } catch (_) { /* silent — TTL will clean up anyway */ }
    toast.info('Generation discarded.');
    setShowVerificationModal(false);
    setVerificationData(null);
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
  const isAmazon = agent?.name?.toLowerCase().includes('amazon');

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      {cfoConfig.isOpen ? (
        <CFODashboardLauncher
          brandId={brandId}
          agentId={agentId}
          agent={agent}
          allAgents={allAgents}
          cfoConfig={cfoConfig}
          setCfoConfig={setCfoConfig}
        />
      ) : (
        <>
          <div className="p-6" data-testid="agent-workspace">
            <div className="mb-8 flex justify-between items-start">
              <div>
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
              <div>
                <Button
                  onClick={() => setCfoConfig(prev => ({ ...prev, isOpen: true }))}
                  variant="default"
                >
                  <BarChart3 className="mr-2 h-4 w-4" />
                  📊 CFO Dashboard
                </Button>
              </div>
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
                          {isAmazon && <TableHead>Type</TableHead>}
                          <TableHead>Inventory</TableHead>
                          <TableHead>Created</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {files.map((file) => (
                          <TableRow key={file.id} data-testid={`file-row-${file.id}`}>
                            <TableCell className="font-medium">{file.month}</TableCell>
                            <TableCell>{file.year}</TableCell>
                            {isAmazon && <TableCell><Badge variant="secondary">{file.file_type}</Badge></TableCell>}
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

                {isAmazon && (
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

          {/* Invoice Preview Confirmation Modal */}
          <Dialog open={showInvoicePreviewModal} onOpenChange={setShowInvoicePreviewModal}>
            <DialogContent onClose={() => setShowInvoicePreviewModal(false)} className="max-w-2xl">
              <DialogHeader>
                <DialogTitle className="text-xl font-bold flex items-center gap-2">
                  🧾 Invoice Number Preview
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <p className="text-sm text-slate-600">
                  Based on your uploaded <strong>Ledger Master</strong> and selected month{' '}
                  <span className="font-semibold text-slate-900">{formData.month} {formData.year}</span>,
                  the invoice numbers will be generated as follows:
                </p>

                {ledgerPreviewLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin text-slate-400 mr-2" />
                    <span className="text-slate-500 text-sm">Loading ledger data...</span>
                  </div>
                ) : ledgerPreviewData.length === 0 ? (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
                    <span className="text-amber-500 text-lg mt-0.5">⚠️</span>
                    <div>
                      <p className="font-semibold text-amber-800">No Ledger Master uploaded</p>
                      <p className="text-sm text-amber-700 mt-1">
                        Invoice numbers will not be generated correctly without ledger data.
                        We recommend uploading your ledger master before generating files.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50 border-b">
                          <th className="p-3 text-left font-semibold text-slate-700">State</th>
                          <th className="p-3 text-left font-semibold text-slate-700">Final Invoice No. (Preview)</th>
                        </tr>
                      </thead>
                    </table>
                    <div className="overflow-y-auto max-h-64">
                      <table className="w-full text-sm">
                        <tbody>
                          {buildInvoicePreviews().map((row, idx) => (
                            <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                              <td className="p-3 text-slate-600 w-1/3">{row.state || '—'}</td>
                              <td className="p-3 font-mono font-semibold text-green-700 bg-green-50">{row.preview}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-center text-slate-400 py-2 border-t">
                      {ledgerPreviewData.length} ledger {ledgerPreviewData.length === 1 ? 'entry' : 'entries'} found
                    </p>
                  </div>
                )}

                <p className="text-xs text-slate-400">
                  Suffix format: <code className="bg-slate-100 px-1.5 py-0.5 rounded font-mono">
                    -{monthAbbr[formData.month]?.num ?? '??'}
                  </code> appended to each base invoice number.
                </p>

                <div className="flex gap-3 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1 text-amber-700 border-amber-300 hover:bg-amber-50"
                    onClick={() => {
                      setShowInvoicePreviewModal(false);
                      setShowUploadLedgerModal(true);
                    }}
                  >
                    📤 Update Ledger Data
                  </Button>
                  <Button
                    type="button"
                    className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                    disabled={isGenerating}
                    onClick={confirmAndGenerate}
                  >
                    {isGenerating ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating...</>
                    ) : (
                      '✓ Continue & Generate File'
                    )}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* Generation Verification Modal */}
          <Dialog open={showVerificationModal} onOpenChange={setShowVerificationModal}>
            <DialogContent onClose={() => setShowVerificationModal(false)} className="max-w-2xl">
              <DialogHeader>
                <DialogTitle className="text-xl font-bold flex items-center gap-2">
                  📊 Generation Verification
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <p className="text-sm text-slate-600">
                  The file has been processed. Please verify the totals below before saving.
                  <span className="block mt-1 font-medium text-slate-800">
                    {verificationData?.rowCount?.toLocaleString()} rows &bull; {formData.month} {formData.year}
                  </span>
                </p>

                {verificationData?.summary && (() => {
                  const wf = verificationData.summary.workingFile;
                  const pf = verificationData.summary.pivotFile;
                  const hasPivot = !!pf;
                  const fmt  = (n) => n?.toLocaleString('en-IN', { minimumFractionDigits: 2 });
                  const fmtQ = (n) => n?.toLocaleString('en-IN');
                  const match = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.01;

                  let wfTitle = 'Working File';
                  let pfTitle = 'Pivot File';

                  if (isMyntra) {
                      wfTitle = 'Accounting Sheet';
                      pfTitle = 'Pivot Table';
                  } else if (isBlinkit) {
                      wfTitle = 'Sales Report';
                      pfTitle = 'GT Report';
                  }

                  let rows = [
                    { label: 'Total Quantity',    wf: fmtQ(wf.quantity),          pf: hasPivot ? fmtQ(pf.quantity) : null,          ok: hasPivot ? match(wf.quantity,     pf.quantity) : true },
                    { label: isMyntra ? 'Base Value' : isBlinkit ? 'Sum of Taxable Value' : 'Taxable Value',     wf: `₹${fmt(wf.taxableValue)}`, pf: hasPivot ? `₹${fmt(pf.taxableValue)}` : null, ok: hasPivot ? match(wf.taxableValue, pf.taxableValue) : true },
                    { label: isMyntra ? 'CGST Amount' : isBlinkit ? 'Sum of CGST Value' : 'Final CGST',        wf: `₹${fmt(wf.cgst)}`,        pf: hasPivot ? `₹${fmt(pf.cgst)}` : null,        ok: hasPivot ? match(wf.cgst,         pf.cgst) : true },
                    { label: isMyntra ? 'SGST Amount' : isBlinkit ? 'Sum of SGST Value' : 'Final SGST',        wf: `₹${fmt(wf.sgst)}`,        pf: hasPivot ? `₹${fmt(pf.sgst)}` : null,        ok: hasPivot ? match(wf.sgst,         pf.sgst) : true },
                    { label: isMyntra ? 'IGST Amount' : isBlinkit ? 'Sum of IGST Value' : 'Final IGST',        wf: `₹${fmt(wf.igst)}`,        pf: hasPivot ? `₹${fmt(pf.igst)}` : null,        ok: hasPivot ? match(wf.igst,         pf.igst) : true },
                  ];

                  if (isMyntra || isBlinkit) {
                    rows = rows.filter(r => r.label !== 'Total Quantity');
                  }

                  const allMatch = rows.every(r => r.ok);

                  return (
                    <div className="space-y-3">
                      {hasPivot && (
                        allMatch ? (
                          <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-2">
                            <span className="text-green-600 text-lg">✅</span>
                            <p className="text-green-800 text-sm font-medium">All totals match between {wfTitle} and {pfTitle}.</p>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
                            <span className="text-red-600 text-lg">⚠️</span>
                            <p className="text-red-800 text-sm font-medium">Mismatch detected — please review before accepting.</p>
                          </div>
                        )
                      )}

                      <div className="border rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-slate-50 border-b">
                              <th className="p-3 text-left font-semibold text-slate-700">Metric</th>
                              <th className="p-3 text-right font-semibold text-slate-700">{wfTitle}</th>
                              {hasPivot && <th className="p-3 text-right font-semibold text-slate-700">{pfTitle}</th>}
                              {hasPivot && <th className="p-3 text-center font-semibold text-slate-700">Match</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((row, idx) => (
                              <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                                <td className="p-3 font-medium text-slate-700">{row.label}</td>
                                <td className="p-3 text-right font-mono text-slate-800">{row.wf}</td>
                                {hasPivot && <td className="p-3 text-right font-mono text-slate-800">{row.pf}</td>}
                                {hasPivot && (
                                  <td className="p-3 text-center text-lg">
                                    {row.ok ? <span className="text-green-600">✔</span> : <span className="text-red-600">✘</span>}
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}

                <div className="flex gap-3 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1 text-red-700 border-red-300 hover:bg-red-50"
                    disabled={isGenerating}
                    onClick={handleDiscard}
                  >
                    ✗ Reject &amp; Discard
                  </Button>
                  <Button
                    type="button"
                    className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                    disabled={isGenerating}
                    onClick={handleCommit}
                  >
                    {isGenerating
                      ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...</>
                      : '✓ Accept & Save File'
                    }
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </DashboardLayout>
  );
};

export default AgentWorkspace;

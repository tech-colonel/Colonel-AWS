import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Building2, Bot, Users, Link as LinkIcon, ArrowLeft, FileText, CheckCircle2, XCircle, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import { Badge } from '../../components/ui/badge';
import { Download } from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';

const sidebarItems = ADMIN_SIDEBAR;

const BrandOverviewPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  // Modal states
  const [showFilesModal, setShowFilesModal] = useState(false);
  const [selectedAgentForFiles, setSelectedAgentForFiles] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);

  // SKU / Ledger master modal state
  const [showMasterModal, setShowMasterModal] = useState(false);
  const [masterModalType, setMasterModalType] = useState('sku'); // 'sku' | 'ledger'
  const [selectedAgentForMaster, setSelectedAgentForMaster] = useState(null);
  const [masterEntries, setMasterEntries] = useState([]);
  const [isLoadingMaster, setIsLoadingMaster] = useState(false);
  const [deletingMasterIndex, setDeletingMasterIndex] = useState(null);
  const [isClearingMaster, setIsClearingMaster] = useState(false);

  // Bank-agent assets modal (Chart of Accounts / learned directory / corrections / side rules).
  // The bank agent stores nothing in brand_agents.sku_master|ledger_master, so it needs its
  // own view instead of the sales portals' SKU/Ledger cards.
  const [showBankModal, setShowBankModal] = useState(false);
  const [bankAssetType, setBankAssetType] = useState(null);
  const [bankAssetData, setBankAssetData] = useState(null);
  const [isLoadingBank, setIsLoadingBank] = useState(false);
  const [isClearingBank, setIsClearingBank] = useState(false);

  const BANK_ASSET_META = {
    coa:         { label: 'Chart of Accounts',       unit: 'ledgers',     hint: 'Every side rule and learned key is validated against this. Replacing or clearing it affects all bank runs for this brand.' },
    directory:   { label: 'Learned Payee Directory', unit: 'learned keys', hint: 'Vendor identity keys learned from accountant corrections. Clearing means those vendors must be taught again.' },
    corrections: { label: 'Stored Corrections',      unit: 'corrections',  hint: 'Exact-narration corrections saved from reviewed output files.' },
    side_rules:  { label: 'Debit/Credit Side Rules', unit: 'rules',        hint: 'Per-vendor credit-side / debit-side ledger rules. Auto-learning is enabled for Urban Plant and M Brands only.' },
  };

  const openBankModal = async (agent, type) => {
    setSelectedAgentForMaster(agent);
    setBankAssetType(type);
    setShowBankModal(true);
    setIsLoadingBank(true);
    setBankAssetData(null);
    try {
      const res = await api.get(`/bank-reco/assets/${id}`);
      setBankAssetData(res.data?.[type] || null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load bank data');
    } finally {
      setIsLoadingBank(false);
    }
  };

  // Approve a 'suggested' side rule (or disable a live one). Rules derived for brands
  // outside the auto-activation allow-list land as 'suggested' and do nothing until
  // approved here — loadSideRules only ever reads status='active'.
  const setSideRuleStatus = async (ruleId, nextStatus) => {
    try {
      await api.patch(`/bank-reco/assets/${id}/side-rules/${ruleId}`, { status: nextStatus });
      toast.success(nextStatus === 'active' ? 'Rule approved — now live' : `Rule ${nextStatus}`);
      setBankAssetData(prev => prev && ({
        ...prev,
        sample: prev.sample.map(r => (r.id === ruleId ? { ...r, status: nextStatus } : r)),
      }));
      fetchStatus();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update rule');
    }
  };

  const handleClearBankAsset = async () => {
    const meta = BANK_ASSET_META[bankAssetType];
    const n = bankAssetData?.count || 0;
    if (!window.confirm(
      `Delete ALL ${n} ${meta.unit} in "${meta.label}" for ${status?.brandName}?\n\n${meta.hint}\n\nThis cannot be undone.`
    )) return;
    setIsClearingBank(true);
    try {
      const res = await api.delete(`/bank-reco/assets/${id}/${bankAssetType}`);
      toast.success(`Deleted ${res.data?.deleted ?? n} ${meta.unit} from ${meta.label}`);
      setShowBankModal(false);
      fetchStatus();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Delete failed');
    } finally {
      setIsClearingBank(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, [id]);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      const response = await api.get(`/api/brands/${id}/status`);
      setStatus(response.data);
    } catch (error) {
      toast.error('Failed to load brand overview');
      navigate('/admin/brands');
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (agentId, fileId, filename) => {
    try {
      setIsDownloading(true);
      const res = await api.get(`/api/brands/${id}/agents/${agentId}/working-files/${fileId}/download`, {
        responseType: 'blob'
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename || `generated_file_${fileId}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      toast.error('Failed to download file');
    } finally {
      setIsDownloading(false);
    }
  };

  const openMasterModal = async (agent, type) => {
    setMasterModalType(type);
    setSelectedAgentForMaster(agent);
    setShowMasterModal(true);
    setIsLoadingMaster(true);
    try {
      const res = await api.get(`/api/brands/${id}/agents/${agent.agentId}/master`);
      setMasterEntries(res.data?.[type === 'sku' ? 'sku_master' : 'ledger_master'] || []);
    } catch (error) {
      toast.error(`Failed to load ${type === 'sku' ? 'SKU' : 'Ledger'} master`);
      setMasterEntries([]);
    } finally {
      setIsLoadingMaster(false);
    }
  };

  const handleDeleteMasterEntry = async (index) => {
    if (!window.confirm(`Delete this ${masterModalType === 'sku' ? 'SKU' : 'ledger'} entry? This cannot be undone.`)) return;
    setDeletingMasterIndex(index);
    try {
      await api.delete(`/api/brands/${id}/agents/${selectedAgentForMaster.agentId}/master/entry/${masterModalType}/${index}`);
      toast.success(`${masterModalType === 'sku' ? 'SKU' : 'Ledger'} entry deleted successfully`);
      setMasterEntries(prev => prev.filter((_, i) => i !== index));
      // Keep the count badges on the underlying page in sync without a full reload.
      setStatus(prev => {
        if (!prev) return prev;
        const field = masterModalType === 'sku' ? 'skuMasterCount' : 'ledgerMasterCount';
        return {
          ...prev,
          agents: prev.agents.map(a => a.agentId === selectedAgentForMaster.agentId
            ? { ...a, masterStatus: { ...a.masterStatus, [field]: Math.max(0, (a.masterStatus?.[field] || 0) - 1) } }
            : a)
        };
      });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to delete entry');
    } finally {
      setDeletingMasterIndex(null);
    }
  };

  const handleClearAllMasterEntries = async () => {
    const label = masterModalType === 'sku' ? 'SKU' : 'ledger';
    if (!window.confirm(`Delete ALL ${masterEntries.length} ${label} entries for ${selectedAgentForMaster?.agentName}? This cannot be undone.`)) return;
    setIsClearingMaster(true);
    try {
      await api.delete(`/api/brands/${id}/agents/${selectedAgentForMaster.agentId}/master/${masterModalType}/clear-all`);
      toast.success(`All ${label} entries deleted successfully`);
      setMasterEntries([]);
      setStatus(prev => {
        if (!prev) return prev;
        const countField = masterModalType === 'sku' ? 'skuMasterCount' : 'ledgerMasterCount';
        const hasField = masterModalType === 'sku' ? 'hasSkuMaster' : 'hasLedgerMaster';
        return {
          ...prev,
          agents: prev.agents.map(a => a.agentId === selectedAgentForMaster.agentId
            ? { ...a, masterStatus: { ...a.masterStatus, [countField]: 0, [hasField]: false } }
            : a)
        };
      });
    } catch (error) {
      toast.error(error.response?.data?.error || `Failed to delete all ${label} entries`);
    } finally {
      setIsClearingMaster(false);
    }
  };

  if (loading) {
    return (
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="flex h-full items-center justify-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600"></div>
        </div>
      </DashboardLayout>
    );
  }

  if (!status) return null;

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6 max-w-6xl mx-auto">
        <Button variant="ghost" onClick={() => navigate('/admin/brands')} className="mb-6 -ml-4">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Brands
        </Button>

        <div className="mb-8 flex items-center gap-4 border-b pb-6">
          <div className="w-16 h-16 bg-slate-100 rounded-xl flex items-center justify-center overflow-hidden shrink-0 shadow-sm border">
            {status.brandImage ? (
              <img src={status.brandImage} alt={status.brandName} className="w-full h-full object-cover" />
            ) : (
              <Building2 className="w-8 h-8 text-slate-400" />
            )}
          </div>
          <div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">{status.brandName} <span className="text-xl font-normal text-slate-500">Overview</span></h1>
            <p className="text-slate-600 mt-1">Full activity and generation progress report for all assigned agents.</p>
          </div>
        </div>

        <div className="space-y-8">
          {status.agents.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center text-slate-500">
                No agents configured for this brand yet.
              </CardContent>
            </Card>
          ) : (
            status.agents.map(agent => (
              <Card key={agent.agentId} className="shadow-sm border-slate-200">
                <CardHeader className="bg-slate-50 border-b">
                  <div className="flex items-center gap-3">
                    <Bot className="w-6 h-6 text-indigo-600" />
                    <CardTitle className="capitalize text-xl">{agent.agentName} Portal</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="p-6">
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    {/* Master Files Column */}
                    <div>
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-4 flex items-center gap-2">
                        <FileText className="w-4 h-4" /> 
                        Master Files Uploaded
                      </h3>
                      
                      {/* Bank agents keep their masters in real tables, not in
                          brand_agents JSONB — so they get their own cards. */}
                      {agent.bankAssets ? (
                      <div className="space-y-4">
                        {Object.entries(BANK_ASSET_META).map(([key, meta]) => {
                          const count = agent.bankAssets[key] || 0;
                          return (
                            <div key={key} className="flex items-center justify-between p-3 border rounded-lg bg-white">
                              <div>
                                <p className="font-medium text-slate-700 text-sm">{meta.label}</p>
                                <p className="text-xs text-slate-500 mt-0.5">{count} {meta.unit}</p>
                              </div>
                              <div className="flex items-center gap-2">
                                {count > 0 ? (
                                  <Badge variant="success" className="gap-1 bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100">
                                    <CheckCircle2 className="w-3 h-3" /> Uploaded
                                  </Badge>
                                ) : (
                                  <Badge variant="secondary" className="gap-1 text-slate-500">
                                    <XCircle className="w-3 h-3" /> Missing
                                  </Badge>
                                )}
                                {count > 0 && (
                                  <Button variant="outline" size="sm" onClick={() => openBankModal(agent, key)}>
                                    Manage
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      ) : (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between p-3 border rounded-lg bg-white">
                          <div>
                            <p className="font-medium text-slate-700 text-sm">SKU Master</p>
                            <p className="text-xs text-slate-500 mt-0.5">{agent.masterStatus?.skuMasterCount || 0} mapping entries</p>
                          </div>
                          <div className="flex items-center gap-2">
                            {agent.masterStatus?.hasSkuMaster ? (
                              <Badge variant="success" className="gap-1 bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100">
                                <CheckCircle2 className="w-3 h-3" /> Uploaded
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="gap-1 text-slate-500">
                                <XCircle className="w-3 h-3" /> Missing
                              </Badge>
                            )}
                            {agent.masterStatus?.hasSkuMaster && (
                              <Button variant="outline" size="sm" onClick={() => openMasterModal(agent, 'sku')}>
                                Manage
                              </Button>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center justify-between p-3 border rounded-lg bg-white">
                          <div>
                            <p className="font-medium text-slate-700 text-sm">Ledger Configurations (State)</p>
                            <p className="text-xs text-slate-500 mt-0.5">{agent.masterStatus?.ledgerMasterCount || 0} ledger configurations</p>
                          </div>
                          <div className="flex items-center gap-2">
                            {agent.masterStatus?.hasLedgerMaster ? (
                              <Badge variant="success" className="gap-1 bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100">
                                <CheckCircle2 className="w-3 h-3" /> Uploaded
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="gap-1 text-slate-500">
                                <XCircle className="w-3 h-3" /> Missing
                              </Badge>
                            )}
                            {agent.masterStatus?.hasLedgerMaster && (
                              <Button variant="outline" size="sm" onClick={() => openMasterModal(agent, 'ledger')}>
                                Manage
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                      )}
                    </div>

                    {/* Timeline Column */}
                    <div>
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-4 flex items-center gap-2">
                        <LayoutDashboard className="w-4 h-4" /> 
                        Generated Output Files
                      </h3>
                      
                      <div className="bg-slate-50 border rounded-lg p-5 flex flex-col items-center justify-center text-center gap-3">
                        <p className="text-sm text-slate-600">
                          {agent.generatedFiles.length} file{agent.generatedFiles.length !== 1 ? 's' : ''} generated for this portal.
                        </p>
                        <Button 
                          variant="secondary" 
                          className="w-full max-w-xs"
                          onClick={() => {
                            setSelectedAgentForFiles(agent);
                            setShowFilesModal(true);
                          }}
                        >
                          <FileText className="w-4 h-4 mr-2" />
                          See Generated Files
                        </Button>
                      </div>
                    </div>
                  </div>

                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>

      <Dialog open={showFilesModal} onOpenChange={setShowFilesModal}>
        <DialogContent onClose={() => setShowFilesModal(false)} className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="capitalize text-xl font-bold flex items-center gap-2">
              <Bot className="w-5 h-5 text-indigo-600" />
              {selectedAgentForFiles?.agentName} File Generation Status
            </DialogTitle>
          </DialogHeader>
          
          <div className="mt-6 space-y-4">
            {selectedAgentForFiles?.generatedFiles.length === 0 ? (
              <div className="text-center p-8 border border-dashed rounded-lg bg-slate-50">
                <p className="text-slate-500 italic">No output files generated yet for this agent.</p>
              </div>
            ) : (
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 font-medium text-slate-600 uppercase text-xs tracking-wider">Month / Year</th>
                      <th className="px-4 py-3 font-medium text-slate-600 uppercase text-xs tracking-wider">Type</th>
                      <th className="px-4 py-3 font-medium text-slate-600 uppercase text-xs tracking-wider">File Name</th>
                      <th className="px-4 py-3 font-medium text-slate-600 uppercase text-xs tracking-wider text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {selectedAgentForFiles?.generatedFiles.map((file, idx) => (
                      <tr key={idx} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-medium text-slate-900 whitespace-nowrap">
                          {file.month} {file.year}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="secondary" className="uppercase text-[10px] tracking-wider bg-slate-100 text-slate-600">
                            {file.fileType || 'working'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-slate-600 font-mono text-xs max-w-xs truncate">
                          {file.filename}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button 
                            variant={file.fileExists ? "default" : "secondary"} 
                            size="sm"
                            disabled={isDownloading || file.fileExists === false}
                            onClick={() => handleDownload(selectedAgentForFiles.agentId, file.fileId, file.filename)}
                            className={file.fileExists ? "bg-indigo-600 hover:bg-indigo-700" : "opacity-50 cursor-not-allowed"}
                            title={file.fileExists === false ? "File no longer exists on disk" : "Download File"}
                          >
                            <Download className="w-3.5 h-3.5 mr-1.5" />
                            {file.fileExists === false ? "Missing" : "Download"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showMasterModal} onOpenChange={setShowMasterModal}>
        <DialogContent onClose={() => setShowMasterModal(false)} className="sm:max-w-6xl w-[95vw] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between gap-4 pr-8">
              <DialogTitle className="capitalize text-xl font-bold flex items-center gap-2">
                <Bot className="w-5 h-5 text-indigo-600 shrink-0" />
                <span>{selectedAgentForMaster?.agentName} {masterModalType === 'sku' ? 'SKU Master' : 'Ledger Configurations'}</span>
              </DialogTitle>
              {masterEntries.length > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0"
                  disabled={isClearingMaster}
                  onClick={handleClearAllMasterEntries}
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  {isClearingMaster ? 'Deleting…' : `Delete All (${masterEntries.length})`}
                </Button>
              )}
            </div>
          </DialogHeader>

          <div className="mt-6 space-y-4">
            {isLoadingMaster ? (
              <div className="flex justify-center p-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
              </div>
            ) : masterEntries.length === 0 ? (
              <div className="text-center p-8 border border-dashed rounded-lg bg-slate-50">
                <p className="text-slate-500 italic">
                  No {masterModalType === 'sku' ? 'SKU' : 'ledger'} entries found.
                </p>
              </div>
            ) : (
              <div className="border border-slate-200 rounded-lg overflow-x-auto">
                <table className="w-full text-sm text-left table-fixed">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      {Object.keys(masterEntries[0]).map(col => (
                        <th key={col} className="px-4 py-3 font-medium text-slate-600 uppercase text-xs tracking-wider w-48">
                          {col}
                        </th>
                      ))}
                      <th className="px-4 py-3 font-medium text-slate-600 uppercase text-xs tracking-wider text-right w-28">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {masterEntries.map((entry, idx) => (
                      <tr key={idx} className="hover:bg-slate-50">
                        {Object.keys(masterEntries[0]).map(col => (
                          <td key={col} className="px-4 py-3 text-slate-700 align-top break-words">
                            {entry[col] ?? ''}
                          </td>
                        ))}
                        <td className="px-4 py-3 text-right align-top">
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={deletingMasterIndex === idx}
                            onClick={() => handleDeleteMasterEntry(idx)}
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                            {deletingMasterIndex === idx ? 'Deleting…' : 'Delete'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Bank agent assets — Chart of Accounts / learned directory / corrections / side rules */}
      <Dialog open={showBankModal} onOpenChange={setShowBankModal}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-indigo-600" />
              <span>{bankAssetType ? BANK_ASSET_META[bankAssetType].label : ''} — {status?.brandName}</span>
            </DialogTitle>
          </DialogHeader>

          <div className="mt-2">
            {bankAssetType && (
              <p className="text-xs text-slate-500 mb-4">{BANK_ASSET_META[bankAssetType].hint}</p>
            )}

            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-slate-600">
                {isLoadingBank ? 'Loading…'
                  : `${bankAssetData?.count ?? 0} ${bankAssetType ? BANK_ASSET_META[bankAssetType].unit : ''}`}
                {bankAssetData?.count > (bankAssetData?.sample?.length || 0) && (
                  <span className="text-slate-400"> · showing first {bankAssetData.sample.length}</span>
                )}
              </p>
              {!isLoadingBank && (bankAssetData?.count || 0) > 0 && (
                <Button variant="destructive" size="sm" disabled={isClearingBank} onClick={handleClearBankAsset}>
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                  {isClearingBank ? 'Deleting…' : `Delete All (${bankAssetData.count})`}
                </Button>
              )}
            </div>

            {bankAssetData?.breakdown?.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {bankAssetData.breakdown.map(b => (
                  <Badge key={b.key_type} variant="secondary" className="text-slate-600">
                    {b.key_type}: {b.n}
                  </Badge>
                ))}
              </div>
            )}

            {isLoadingBank ? (
              <div className="py-10 text-center text-slate-500 text-sm">Loading…</div>
            ) : !bankAssetData || bankAssetData.count === 0 ? (
              <div className="py-10 text-center text-slate-500 text-sm">Nothing stored yet.</div>
            ) : (
              <div className="max-h-[55vh] overflow-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium text-slate-600">Entry</th>
                      <th className="px-4 py-2 text-left font-medium text-slate-600">Maps to</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bankAssetData.sample.map((row, idx) => (
                      <tr key={row.id || idx} className={`border-t ${row.status === 'suggested' ? 'bg-amber-50' : ''}`}>
                        <td className="px-4 py-2 align-top break-words max-w-md text-slate-700">
                          {row.a}
                          {row.status && (
                            <span className="ml-2 text-[11px] text-slate-400">
                              {row.status}{row.source ? ` · ${row.source}` : ''}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 align-top break-words max-w-md text-slate-500">
                          <div className="flex items-start justify-between gap-3">
                            <span>{row.b}</span>
                            {row.id && bankAssetType === 'side_rules' && (
                              row.status === 'suggested' ? (
                                <Button size="sm" variant="outline" className="shrink-0"
                                  onClick={() => setSideRuleStatus(row.id, 'active')}>
                                  Approve
                                </Button>
                              ) : row.status === 'active' ? (
                                <Button size="sm" variant="ghost" className="shrink-0 text-slate-400"
                                  onClick={() => setSideRuleStatus(row.id, 'disabled')}>
                                  Disable
                                </Button>
                              ) : (
                                <Button size="sm" variant="outline" className="shrink-0"
                                  onClick={() => setSideRuleStatus(row.id, 'active')}>
                                  Enable
                                </Button>
                              )
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
};

export default BrandOverviewPage;

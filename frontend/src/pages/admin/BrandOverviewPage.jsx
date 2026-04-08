import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Building2, Bot, Users, Link as LinkIcon, ArrowLeft, FileText, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import { Badge } from '../../components/ui/badge';
import { Download } from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';

const sidebarItems = [
  { path: '/admin', label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
  { path: '/admin/brands', label: 'Brands', icon: Building2, testId: 'nav-brands' },
  { path: '/admin/agents', label: 'Agents', icon: Bot, testId: 'nav-agents' },
  { path: '/admin/users', label: 'Users', icon: Users, testId: 'nav-users' },
  { path: '/admin/assignments', label: 'Assignments', icon: LinkIcon, testId: 'nav-assignments' }
];

const BrandOverviewPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  // Modal states
  const [showFilesModal, setShowFilesModal] = useState(false);
  const [selectedAgentForFiles, setSelectedAgentForFiles] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);

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
                      
                      <div className="space-y-4">
                        <div className="flex items-center justify-between p-3 border rounded-lg bg-white">
                          <div>
                            <p className="font-medium text-slate-700 text-sm">SKU Master</p>
                            <p className="text-xs text-slate-500 mt-0.5">{agent.masterStatus?.skuMasterCount || 0} mapping entries</p>
                          </div>
                          {agent.masterStatus?.hasSkuMaster ? (
                            <Badge variant="success" className="gap-1 bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100">
                              <CheckCircle2 className="w-3 h-3" /> Uploaded
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="gap-1 text-slate-500">
                              <XCircle className="w-3 h-3" /> Missing
                            </Badge>
                          )}
                        </div>

                        <div className="flex items-center justify-between p-3 border rounded-lg bg-white">
                          <div>
                            <p className="font-medium text-slate-700 text-sm">Ledger Configurations (State)</p>
                            <p className="text-xs text-slate-500 mt-0.5">{agent.masterStatus?.ledgerMasterCount || 0} ledger configurations</p>
                          </div>
                          {agent.masterStatus?.hasLedgerMaster ? (
                            <Badge variant="success" className="gap-1 bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100">
                              <CheckCircle2 className="w-3 h-3" /> Uploaded
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="gap-1 text-slate-500">
                              <XCircle className="w-3 h-3" /> Missing
                            </Badge>
                          )}
                        </div>
                      </div>
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
    </DashboardLayout>
  );
};

export default BrandOverviewPage;

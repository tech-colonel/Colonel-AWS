import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { GitBranch, Upload, Download, Loader2, Check, ChevronRight, TableIcon, GitMerge } from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';
import MissingMasterDataModal from '../../components/reco/MissingMasterDataModal';

// ─── Step 1: Select workflow ──────────────────────────────────────────────────

const WorkflowSelector = ({ agentId, onSelect }) => {
  const [workflows, setWorkflows] = useState([]);
  const [loading,   setLoading]   = useState(true);

  useEffect(() => {
    api.get(`/api/agents/${agentId}/workflows`)
      .then(res => setWorkflows(res.data || []))
      .catch(() => toast.error('Failed to load workflows'))
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading workflows...
      </div>
    );
  }

  if (workflows.length === 0) {
    return (
      <div className="py-12 text-center text-slate-400">
        <GitBranch className="h-10 w-10 text-slate-200 mx-auto mb-3" />
        <p className="text-sm font-medium">No workflows available</p>
        <p className="text-xs mt-1">An admin needs to create workflows for this agent first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-500 mb-3">Select a workflow to apply to your file:</p>
      {workflows.map(wf => {
        const sheets        = wf.sheets || [];
        const computedCount = sheets.reduce((n, s) => n + (s.columns || []).filter(c => c.type === 'computed').length, 0);
        const groupedCount  = sheets.filter(s => s.groupBy?.enabled && s.groupBy?.columns?.length > 0).length;
        return (
          <button
            key={wf.id}
            type="button"
            onClick={() => onSelect(wf)}
            className="w-full text-left flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3.5 hover:border-indigo-300 hover:bg-indigo-50 transition-all group"
          >
            <div className="flex-1 min-w-0 mr-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm text-slate-900">{wf.name}</span>
                <Badge variant="secondary" className="text-xs">
                  {sheets.length} sheet{sheets.length !== 1 ? 's' : ''}
                </Badge>
                {computedCount > 0 && (
                  <Badge variant="outline" className="text-xs text-amber-700 border-amber-200">
                    {computedCount} computed
                  </Badge>
                )}
                {groupedCount > 0 && (
                  <Badge variant="outline" className="text-xs text-teal-700 border-teal-200">
                    {groupedCount} grouped
                  </Badge>
                )}
              </div>
              {wf.description && (
                <p className="text-xs text-slate-400 mt-0.5">{wf.description}</p>
              )}
              {/* Sheet previews */}
              <div className="flex flex-wrap gap-1.5 mt-2">
                {sheets.map(s => {
                  const srcCount  = (s.columns || []).filter(c => c.type === 'source').length;
                  const compCount = (s.columns || []).filter(c => c.type === 'computed').length;
                  const isGrouped = s.groupBy?.enabled && s.groupBy?.columns?.length > 0;
                  return (
                    <div key={s.id} className={`flex items-center gap-1 rounded-lg border px-2 py-1 ${
                      s.type === 'merge' ? 'bg-purple-50 border-purple-200' : 'bg-slate-50 border-slate-200'
                    }`}>
                      {s.type === 'merge'
                        ? <GitMerge className="h-3 w-3 text-purple-400" />
                        : <TableIcon className="h-3 w-3 text-slate-400" />}
                      <span className={`text-xs font-medium ${s.type === 'merge' ? 'text-purple-700' : 'text-slate-700'}`}>{s.name}</span>
                      {s.type === 'merge'
                        ? <span className="text-xs text-purple-400">{s.mergeConfig?.mergeType || 'join'}</span>
                        : <span className="text-xs text-slate-400">{srcCount}src{compCount > 0 ? ` +${compCount}` : ''}</span>}
                      {isGrouped && (
                        <span className="text-xs font-medium text-teal-600">· grouped</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-indigo-400 shrink-0" />
          </button>
        );
      })}
    </div>
  );
};

// ─── Step 2: Upload & apply ───────────────────────────────────────────────────

const ApplyStep = ({ workflow, agentId, brandId, onBack, onClose }) => {
  const fileInputs = workflow.fileInputs?.length > 0
    ? workflow.fileInputs
    : [{ id: 'file_0', label: 'Input File' }];

  const [files,          setFiles]          = useState({});
  const [applying,       setApplying]       = useState(false);
  const [outputFilename, setOutputFilename] = useState(null);
  const [downloading,    setDownloading]    = useState(false);
  const [showMissingMasterModal, setShowMissingMasterModal] = useState(false);
  const [missingMasterValues,    setMissingMasterValues]    = useState([]);
  const [masterData,             setMasterData]             = useState({ sku_master: [], ledger_master: [] });

  const sheets           = workflow.sheets || [];
  const allFilesSelected = fileInputs.every(fi => !!files[fi.id]);

  const setFile = (fileInputId, file) => {
    setFiles(prev => ({ ...prev, [fileInputId]: file || undefined }));
    setOutputFilename(null);
  };

  const fetchMasterData = () => {
    if (!brandId || !agentId) return;
    api.get(`/api/brands/${brandId}/agents/${agentId}/master`)
      .then(res => setMasterData(res.data || { sku_master: [], ledger_master: [] }))
      .catch(() => {});
  };

  const handleApply = async (proceedWithoutMaster = false) => {
    if (!allFilesSelected) { toast.error('Please select all required files'); return; }
    setApplying(true);
    setOutputFilename(null);
    try {
      const fd = new FormData();
      if (brandId) fd.append('brandId', brandId);
      if (agentId) fd.append('agentId', agentId);
      if (fileInputs.length === 1) {
        fd.append('file', files[fileInputs[0].id]);
      } else {
        fileInputs.forEach((fi, i) => fd.append(`file_${i}`, files[fi.id]));
      }
      if (proceedWithoutMaster) {
        fd.append('proceedWithoutMaster', 'true');
      }
      const res = await api.post(`/api/workflows/${workflow.id}/apply`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setOutputFilename(res.data.filename);
      toast.success('Workflow applied! Output ready to download.');
    } catch (err) {
      const missing = err.response?.data?.missingMasterValues;
      if (missing?.length > 0) {
        fetchMasterData();
        setMissingMasterValues(missing);
        setShowMissingMasterModal(true);
      } else {
        toast.error(err.response?.data?.error || 'Failed to apply workflow');
      }
    } finally {
      setApplying(false);
    }
  };

  const handleDownload = async () => {
    if (!outputFilename) return;
    setDownloading(true);
    try {
      const res = await api.get(`/api/workflows/download/${encodeURIComponent(outputFilename)}`, {
        responseType: 'blob'
      });
      const url  = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href  = url;
      link.setAttribute('download', outputFilename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error('Failed to download file');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Workflow summary */}
      <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3">
        <div className="flex items-center justify-between">
          <p className="font-semibold text-sm text-indigo-800">{workflow.name}</p>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="text-xs text-indigo-500 hover:text-indigo-700 underline underline-offset-2"
            >
              Change
            </button>
          )}
        </div>
        {workflow.description && (
          <p className="text-xs text-indigo-500 mt-0.5">{workflow.description}</p>
        )}
        {/* Per-sheet summary */}
        <div className="flex flex-wrap gap-2 mt-3">
          {sheets.map(s => (
            <div key={s.id} className="rounded-lg bg-white/60 border border-indigo-200 px-3 py-2 min-w-0">
              <div className="flex items-center gap-1 mb-1">
                <TableIcon className="h-3 w-3 text-indigo-400" />
                <span className="text-xs font-semibold text-indigo-800">{s.name}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {(s.columns || []).slice(0, 5).map(col => (
                  <span
                    key={col.id || col.key}
                    className={`rounded px-1 py-0.5 text-xs ${
                      col.type === 'computed'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-indigo-100/50 text-indigo-700'
                    }`}
                  >
                    {col.type === 'computed' ? '✦ ' : ''}{col.label}
                  </span>
                ))}
                {(s.columns || []).length > 5 && (
                  <span className="text-xs text-indigo-400">+{s.columns.length - 5} more</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* File upload(s) */}
      <div className="space-y-3">
        <p className="text-sm font-medium text-slate-700">
          {fileInputs.length === 1 ? 'Upload your file' : `Upload ${fileInputs.length} files`}
        </p>
        {fileInputs.map((fi, i) => (
          <div key={fi.id}>
            {fileInputs.length > 1 && (
              <p className="text-xs font-semibold text-slate-500 mb-1.5 flex items-center gap-1.5">
                <span className="w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
                {fi.label}
              </p>
            )}
            <label className="flex items-center gap-3 border-2 border-dashed border-slate-200 rounded-xl px-4 py-3.5 cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/30 transition-all">
              <Upload className="h-5 w-5 text-slate-300 shrink-0" />
              {files[fi.id] ? (
                <span className="text-sm font-medium text-slate-700 truncate">{files[fi.id].name}</span>
              ) : (
                <div>
                  <span className="text-sm text-slate-500">Click to choose file</span>
                  <span className="text-xs text-slate-400 block">.xlsx, .xls, .csv</span>
                </div>
              )}
              <input
                type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => setFile(fi.id, e.target.files[0])}
              />
            </label>
          </div>
        ))}
      </div>

      {/* Output result */}
      {outputFilename && (
        <div className="flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3">
          <Check className="h-5 w-5 text-green-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-green-800">
              Output ready — {sheets.length} sheet{sheets.length !== 1 ? 's' : ''}
            </p>
            <p className="text-xs text-green-600 truncate">{outputFilename}</p>
          </div>
          <Button
            size="sm"
            onClick={handleDownload}
            disabled={downloading}
            className="shrink-0 bg-green-600 hover:bg-green-700 text-white h-8"
          >
            {downloading
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <><Download className="h-3.5 w-3.5 mr-1" /> Download</>}
          </Button>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <Button variant="secondary" onClick={onClose} className="flex-1">Close</Button>
        <Button onClick={() => handleApply(false)} disabled={!allFilesSelected || applying} className="flex-1">
          {applying
            ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Applying...</>
            : 'Apply Workflow'}
        </Button>
      </div>

      <MissingMasterDataModal
        open={showMissingMasterModal}
        onOpenChange={setShowMissingMasterModal}
        missingValues={missingMasterValues}
        brandId={brandId}
        agentId={agentId}
        masterData={masterData}
        onResolved={fetchMasterData}
        onProceed={() => {
          setShowMissingMasterModal(false);
          handleApply(true);
        }}
      />
    </div>
  );
};

// ─── Main Modal ────────────────────────────────────────────────────────────────

// initialWorkflow: if provided, skips the selector and goes straight to ApplyStep
const WorkflowApplyModal = ({ agentId, brandId, open, onClose, initialWorkflow = null }) => {
  const [selectedWorkflow, setSelectedWorkflow] = useState(initialWorkflow);

  useEffect(() => {
    if (open) setSelectedWorkflow(initialWorkflow || null);
  }, [open, initialWorkflow]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent onClose={onClose} className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-indigo-600" />
            Apply Workflow
          </DialogTitle>
        </DialogHeader>

        {!selectedWorkflow ? (
          <>
            <WorkflowSelector agentId={agentId} onSelect={setSelectedWorkflow} />
            <div className="flex justify-end pt-2">
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>
          </>
        ) : (
          <ApplyStep
            workflow={selectedWorkflow}
            agentId={agentId}
            brandId={brandId}
            onBack={initialWorkflow ? null : () => setSelectedWorkflow(null)}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};

export default WorkflowApplyModal;

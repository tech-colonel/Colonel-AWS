import React, { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LayoutDashboard, Bot, ArrowLeft, Upload, Download,
  Play, CheckCircle2, XCircle, AlertTriangle, RotateCcw,
  FileSpreadsheet, Loader2, ChevronDown, ChevronUp, Database, Info, CheckSquare,
  BarChart3, ArrowRight, Save
} from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';

const AGENT_CONFIG = {
  gstr_2b_vs_purchase: {
    name: 'GSTR-2B vs Purchase Register',
    icon: '📋',
    color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8',
    files: [
      { key: 'gstr2b', label: 'GSTR-2B File', hint: '.xlsx / .xls', required: true },
      { key: 'purchase', label: 'Purchase Register', hint: '.xlsx / .xls', required: true },
    ],
  },
  gstr_2a_vs_2b_vs_books: {
    name: 'GSTR2 vs Books',
    icon: '🔄',
    color: '#F115F8', bg: '#FEE8FF', border: '#F9A8FD',
    files: [
      { key: 'gstr2b', label: 'GSTR-2B File', hint: '.xlsx / .xls', required: true },
      { key: 'purchase', label: 'Purchase Register', hint: '.xlsx / .xls', required: true },
      { key: 'debit', label: 'Debit Note Register', hint: '.xlsx / .xls', required: true },
    ],
  },
  gstr_2b_books: {
    name: 'GSTR-2B vs Books',
    icon: '📂',
    color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8',
    files: [
      { key: 'gstr2b', label: 'GSTR-2B File', hint: '.xlsx / .xls', required: true },
      { key: 'purchase', label: 'Purchase Register', hint: '.xlsx / .xls', required: true },
      { key: 'debit', label: 'Debit Note Register', hint: '.xlsx / .xls', required: true },
    ],
  },
  gstr_3b_vs_2b: {
    name: 'GSTR-3B vs GSTR-2B',
    icon: '⚖️',
    color: '#059669', bg: '#ECFDF5', border: '#A7F3D0',
    files: [
      { key: 'gstr3b', label: 'GSTR-3B Working File', hint: '.xlsx / .xls', required: true },
      { key: 'gstr2b_3b', label: 'GSTR-2B File', hint: '.xlsx / .xls', required: true },
    ],
  },
  gstr_1_vs_books: {
    name: 'GSTR-1 vs Books',
    icon: '📊',
    color: '#D97706', bg: '#FFFBEB', border: '#FDE68A',
    files: [
      { key: 'tally_sales', label: 'Tally Sales Export', hint: '.xlsx / .xls', required: true },
      { key: 'gstr1', label: 'GSTR-1 File', hint: '.xlsx / .xls', required: true },
      { key: 'amazon', label: 'Amazon RTF (Optional)', hint: '.xlsx / .xls', required: false },
    ],
  },
  bank_statement: {
    name: 'Bank Statement Classifier',
    icon: '🏦',
    color: '#E11D48', bg: '#FFF1F2', border: '#FECDD3',
    files: [
      { key: 'bank_statement', label: 'Bank Statement', hint: '.xlsx / .xls / .csv', required: true },
    ],
    demoFiles: [
      { key: 'bank_statement', label: 'Bank Statement', hint: '.xlsx / .xls / .csv', required: true },
      { key: 'ledger_master', label: 'Ledger Master', hint: '.xlsx / .xls', required: false, isDemo: true },
    ],
  },
  universal_bank_statement: {
    name: 'Universal Bank Statement',
    icon: '🌍',
    color: '#059669', bg: '#ECFDF5', border: '#A7F3D0',
    files: [
      { key: 'bank_statement', label: 'Bank Statement', hint: '.xlsx / .xls / .csv', required: true },
    ],
    demoFiles: [
      { key: 'bank_statement', label: 'Bank Statement', hint: '.xlsx / .xls / .csv', required: true },
      { key: 'ledger_master', label: 'Ledger Master', hint: '.xlsx / .xls', required: false, isDemo: true },
    ],
  },
  gstr_3b_tally_entry: {
    name: 'GSTR-3B Tally Entry',
    icon: '📒',
    color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4',
    files: [
      { key: 'gstr3b', label: 'GSTR-3B File', hint: '.pdf / .xlsx / .xls', accept: '.pdf,.xlsx,.xls', required: true },
    ],
  },
};

const STATUS_CFG = {
  Matched: { color: '#059669', bg: '#ECFDF5', border: '#A7F3D0', icon: CheckCircle2 },
  'Missing in GSTR-1': { color: '#D97706', bg: '#FFFBEB', border: '#FDE68A', icon: AlertTriangle },
  'Missing in Books': { color: '#E11D48', bg: '#FFF1F2', border: '#FECDD3', icon: XCircle },
  Difference: { color: '#F115F8', bg: '#FEE8FF', border: '#F9A8FD', icon: AlertTriangle },
  Missing: { color: '#E11D48', bg: '#FFF1F2', border: '#FECDD3', icon: XCircle },
  Classified: { color: '#059669', bg: '#ECFDF5', border: '#A7F3D0', icon: CheckCircle2 },
  Unclassified: { color: '#64748B', bg: '#F8FAFC', border: '#E2E8F0', icon: AlertTriangle },
};

const getStatusCfg = (status = '') => {
  for (const [key, val] of Object.entries(STATUS_CFG)) {
    if (status.toLowerCase().includes(key.toLowerCase())) return val;
  }
  return { color: '#64748B', bg: '#F8FAFC', border: '#E2E8F0', icon: AlertTriangle };
};

// ── File Dropzone ─────────────────────────────────────────────────────────────
const FileDropzone = ({ fileConfig, file, onChange }) => {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) onChange(f);
  };

  const active = dragging || hovered;

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      style={{
        padding: '16px 20px', borderRadius: '14px', cursor: 'pointer',
        background: file ? '#ECFDF5' : active ? '#E8EFFE' : '#F8FAFC',
        border: `1.5px ${active ? 'solid' : 'dashed'} ${file ? '#A7F3D0' : active ? '#A3BFF8' : '#CBD5E1'}`,
        transition: 'all 0.2s ease',
      }}
    >
      <input ref={inputRef} type="file" accept={fileConfig.accept || '.xlsx,.xls,.csv'} className="hidden"
        onChange={e => onChange(e.target.files[0])} />
      {file ? (
        <div className="flex items-center gap-3">
          <FileSpreadsheet className="w-5 h-5 flex-shrink-0" style={{ color: '#059669' }} />
          <div className="text-left flex-1 min-w-0">
            <p className="text-sm font-semibold truncate" style={{ color: '#059669' }}>{file.name}</p>
            <p className="text-xs" style={{ color: '#6EE7B7' }}>{(file.size / 1024).toFixed(1)} KB · Ready</p>
          </div>
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" style={{ color: '#059669' }} />
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Upload className="w-5 h-5 flex-shrink-0" style={{ color: active ? '#0748EE' : '#94A3B8' }} />
          <div className="text-left">
            <p className="text-sm font-semibold" style={{ color: '#334155' }}>
              {fileConfig.label}
              {fileConfig.required && <span style={{ color: '#E11D48' }} className="ml-1">*</span>}
            </p>
            <p className="text-xs" style={{ color: '#94A3B8' }}>{fileConfig.hint} · Click or drag &amp; drop</p>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Main Component ────────────────────────────────────────────────────────────
const RecoWorkspace = () => {
  const { brandId, agentType } = useParams();
  const navigate = useNavigate();
  const config = AGENT_CONFIG[agentType];
  const isDemo = localStorage.getItem('token') === 'demo-mode-token';

  const [uploadedFiles, setUploadedFiles] = useState({});
  const [tolerance, setTolerance] = useState('1.0');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [filter, setFilter] = useState('All');
  const [downloading, setDownloading] = useState(false);
  const [showMonthly, setShowMonthly] = useState(false);
  const [ledgerStatus, setLedgerStatus] = useState(null);

  // Universal bank statement: brand selector + correction state
  const isUniversal = agentType === 'universal_bank_statement';
  const [brands, setBrands] = useState([]);
  const [selectedBrand, setSelectedBrand] = useState(brandId && brandId !== 'other' ? brandId : '');
  const [editedLedgers, setEditedLedgers] = useState({}); // { rowIndex: newLedgerName }
  const [savingCorrections, setSavingCorrections] = useState(false);
  const corrExcelRef = useRef(null);
  const outputUploadRef = useRef(null);
  const effectiveBrandId = isUniversal ? (selectedBrand || null) : brandId;
  const cacheKey = `reco_result_${agentType}_${effectiveBrandId || brandId}`;

  useEffect(() => {
    if (agentType === 'bank_statement' && !isDemo && brandId !== 'demo') {
      checkLedgerMaster();
    }
    if (isUniversal) {
      api.get('/api/brands').then(r => setBrands(r.data?.brands || r.data || [])).catch(() => {});
      // Restore last result from sessionStorage so navigating to analytics and back
      // doesn't wipe the results — accountant doesn't need to re-upload the file.
      if (!result) {
        try {
          const cached = sessionStorage.getItem(cacheKey);
          if (cached) setResult(JSON.parse(cached));
        } catch (_) {}
      }
    }
  }, [agentType, brandId, isDemo, isUniversal]);

  const checkLedgerMaster = async () => {
    try {
      const res = await api.get(`/api/reco/ledger-status/${brandId}`);
      setLedgerStatus(res.data.hasLedger ? 'loaded' : 'missing');
    } catch { setLedgerStatus('missing'); }
  };

  const activeFiles = (() => {
    if (agentType === 'bank_statement' && isDemo && config.demoFiles) return config.demoFiles;
    return config?.files || [];
  })();

  const sidebarItems = [
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
    { path: '/tasks', label: 'Tasks', icon: CheckSquare, testId: 'nav-tasks' },
  ];

  if (!config) {
    return (
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="p-6 text-center text-sm" style={{ color: '#94A3B8' }}>Agent not found</div>
      </DashboardLayout>
    );
  }

  const handleFileChange = (key, file) => setUploadedFiles(prev => ({ ...prev, [key]: file }));

  const handleRun = async () => {
    const missing = activeFiles.filter(f => f.required && !uploadedFiles[f.key]);
    if (missing.length > 0) { toast.error(`Please upload: ${missing.map(f => f.label).join(', ')}`); return; }
    if (agentType === 'bank_statement' && isDemo && !uploadedFiles['ledger_master']) {
      toast.error('In demo mode, please upload the Ledger Master file'); return;
    }
    setRunning(true); setResult(null); setEditedLedgers({});
    try {
      const formData = new FormData();
      formData.append('reco_type', agentType);
      formData.append('tolerance', tolerance);
      formData.append('brand_id', effectiveBrandId || brandId);
      formData.append('is_demo', isDemo ? 'true' : 'false');
      for (const [key, file] of Object.entries(uploadedFiles)) { if (file) formData.append(key, file); }
      const response = await api.post('/api/reco/run', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      setResult(response.data);
      // Persist so "View Analytics → Back" doesn't lose the results
      if (isUniversal) {
        try { sessionStorage.setItem(cacheKey, JSON.stringify(response.data)); } catch (_) {}
      }
      toast.success(`Reconciliation complete! ${response.data.results?.length || 0} records processed.`);
    } catch (err) { toast.error(err.response?.data?.error || 'Reconciliation failed'); }
    finally { setRunning(false); }
  };

  // Save inline ledger edits as corrections for this brand
  const handleSaveCorrections = async () => {
    const edits = Object.entries(editedLedgers);
    if (!edits.length) return;
    if (!effectiveBrandId || effectiveBrandId === 'other') {
      toast.error('Select a brand before saving corrections'); return;
    }
    setSavingCorrections(true);
    try {
      const rows = result?.results || [];
      const corrections = edits.map(([idx, correct_ledger]) => {
        const row = rows[parseInt(idx)];
        return { description: row?.original_description || row?.description, correct_ledger, correct_type: row?.predicted_type || row?.type };
      }).filter(c => c.description && c.correct_ledger);
      await api.post(`/api/bank-reco/corrections/${effectiveBrandId}`, {
        corrections, job_id: result?.job_id
      });
      toast.success(`${corrections.length} correction${corrections.length > 1 ? 's' : ''} saved — will apply on next run`);
      setEditedLedgers({});
    } catch { toast.error('Failed to save corrections'); }
    finally { setSavingCorrections(false); }
  };

  // Upload a previous output Excel — imports all High confidence rows as corrections
  const handleUploadOutputExcel = async (file) => {
    if (!file || !effectiveBrandId || effectiveBrandId === 'other') {
      toast.error('Select a brand before uploading'); return;
    }
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await api.post(`/api/bank-reco/corrections/${effectiveBrandId}/upload-output`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      toast.success(`${res.data.saved} correction${res.data.saved !== 1 ? 's' : ''} imported from output Excel`);
    } catch { toast.error('Failed to upload output Excel'); }
  };

  // Upload a reviewed Excel file to extract corrections
  const handleUploadCorrectionsExcel = async (file) => {
    if (!file || !effectiveBrandId || effectiveBrandId === 'other') {
      toast.error('Select a brand before uploading corrections'); return;
    }
    const fd = new FormData();
    fd.append('file', file);
    if (result?.job_id) fd.append('job_id', result.job_id);
    try {
      const res = await api.post(`/api/bank-reco/corrections/${effectiveBrandId}/upload-excel`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      toast.success(`${res.data.saved} correction${res.data.saved !== 1 ? 's' : ''} saved from Excel`);
    } catch { toast.error('Failed to upload corrections Excel'); }
  };

  const handleDownload = async () => {
    if (!result?.job_id) return;
    setDownloading(true);
    try {
      const response = await api.get(`/api/reco/export/${result.job_id}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const a = document.createElement('a'); a.href = url;
      a.download = `${agentType}_${result.job_id}.xlsx`; a.click();
      window.URL.revokeObjectURL(url);
      toast.success('Excel downloaded!');
    } catch { toast.error('Download failed'); }
    finally { setDownloading(false); }
  };

  const handleReset = () => {
    if (isUniversal) { try { sessionStorage.removeItem(cacheKey); } catch (_) {} }
    setUploadedFiles({}); setResult(null); setFilter('All'); setEditedLedgers({});
  };

  // Flatten GST MatchResult objects (gstr2b/purchase are nested NormalizedInvoice dicts)
  const flattenResult = (row) => {
    if (!('category' in row) || !('gstr2b' in row || 'purchase' in row)) return row;
    const inv = row.gstr2b || row.purchase || {};
    return {
      category:          row.category,
      confidence:        row.confidence,
      supplier:          inv.supplier_name || '—',
      gstin:             inv.supplier_gstin || '—',
      invoice_no:        inv.doc_no || '—',
      date:              inv.doc_date || '—',
      taxable_value:     inv.taxable_value,
      igst:              inv.igst,
      cgst:              inv.cgst,
      sgst:              inv.sgst,
      suggested_action:  row.suggested_action || '—',
      remark_2:          row.suggested_action_2 || row.explanation || '—',
    };
  };

  const isGstResult = result?.results?.[0] && 'category' in result.results[0];

  const statusCounts = (result?.results || []).reduce((acc, r) => {
    let s;
    if (isGstResult) s = r.category || 'Unknown';
    else if (isUniversal) s = (r.confidence || 'Low') + ' Confidence';
    else s = r.status || 'Unknown';
    acc[s] = (acc[s] || 0) + 1; return acc;
  }, {});

  const filterTabs = ['All', ...Object.keys(statusCounts)];

  const filteredResults = (result?.results || [])
    .map(flattenResult)
    .filter(r => {
      if (filter === 'All') return true;
      const key = isGstResult ? r.category : r.status;
      return (key || 'Unknown') === filter;
    });

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6 max-w-7xl">

        {/* Breadcrumb */}
        <button onClick={() => navigate(`/brands/${brandId}/agents`)}
          className="flex items-center gap-1.5 text-sm mb-6 group transition-colors hover:text-[#0748EE]"
          style={{ color: '#64748B' }}>
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
          All Agents
        </button>

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl flex-shrink-0"
              style={{ background: config.bg, border: `1px solid ${config.border}`, boxShadow: `0 4px 20px ${config.color}20` }}>
              {config.icon}
            </div>
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-xs font-semibold" style={{ color: '#059669' }}>Reconciliation Agent</span>
              </div>
              <h1 className="text-2xl font-black" style={{ color: '#0F172A', fontFamily: 'Barlow', letterSpacing: '-0.02em' }}>
                {config.name}
              </h1>
              <p className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>Upload files and run reconciliation</p>
            </div>
          </div>
          {result && (
            <button onClick={handleReset}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl transition-colors hover:bg-slate-100"
              style={{ color: '#64748B', border: '1px solid #E2E8F0' }}>
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </button>
          )}
        </div>

        {/* Upload + Config */}
        {!result && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            {/* File uploads */}
            <div className="lg:col-span-2 glass-card p-6">
              <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: '#475569' }}>
                Upload Files
              </h2>
              <div className="space-y-3">

                {/* Brand selector — universal bank statement only */}
                {isUniversal && (
                  <div>
                    <label className="block text-xs font-semibold mb-1.5" style={{ color: '#64748B' }}>
                      Brand <span style={{ color: '#E11D48' }}>*</span>
                    </label>
                    <select
                      value={selectedBrand}
                      onChange={e => setSelectedBrand(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-xl text-sm outline-none"
                      style={{ background: '#F8FAFC', border: '1.5px solid #E2E8F0', color: '#0F172A' }}
                    >
                      <option value="">Select brand…</option>
                      {brands.map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                      <option value="other">Other (no corrections / dev mode)</option>
                    </select>
                    <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>
                      Selecting a brand loads past corrections and saves new ones automatically.
                    </p>
                  </div>
                )}
                {activeFiles.map(f => (
                  <React.Fragment key={f.key}>
                    <FileDropzone fileConfig={f} file={uploadedFiles[f.key]} onChange={(file) => handleFileChange(f.key, file)} />
                    {f.isDemo && (
                      <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl text-xs"
                        style={{ background: '#FFFBEB', border: '1px solid #FDE68A' }}>
                        <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#D97706' }} />
                        <p style={{ color: '#92400E' }}>
                          <strong>Demo mode:</strong> Ledger Master required here. In production, it's auto-loaded from your brand's saved master data.
                        </p>
                      </div>
                    )}
                  </React.Fragment>
                ))}

                {agentType === 'bank_statement' && !isDemo && (
                  <div className="flex items-start gap-3 px-4 py-3 rounded-xl"
                    style={{ background: ledgerStatus === 'missing' ? '#FFF1F2' : '#ECFDF5', border: `1px solid ${ledgerStatus === 'missing' ? '#FECDD3' : '#A7F3D0'}` }}>
                    <Database className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: ledgerStatus === 'missing' ? '#E11D48' : '#059669' }} />
                    <div className="flex-1">
                      <p className="text-sm font-semibold" style={{ color: ledgerStatus === 'missing' ? '#E11D48' : '#059669' }}>
                        Ledger Master — {ledgerStatus === 'loaded' ? 'Auto Loaded' : ledgerStatus === 'missing' ? 'Not Found' : 'Checking...'}
                      </p>
                      <p className="text-xs mt-0.5" style={{ color: '#64748B' }}>
                        {ledgerStatus === 'loaded'
                          ? "Your brand's ledger master is saved and will be used automatically."
                          : ledgerStatus === 'missing'
                            ? 'No ledger master found. Please upload one via the Admin panel first.'
                            : "Checking your brand's ledger master..."}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Config + Run */}
            <div className="space-y-4">
              <div className="glass-card p-5">
                <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: '#475569' }}>Configuration</h2>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: '#64748B' }}>Tolerance (₹)</label>
                  <input type="number" step="0.5" min="0" value={tolerance}
                    onChange={e => setTolerance(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl text-sm outline-none transition-all"
                    style={{ background: '#F8FAFC', border: '1.5px solid #E2E8F0', color: '#0F172A' }} />
                  <p className="text-xs mt-2" style={{ color: '#94A3B8' }}>Amounts within this range are considered matched</p>
                </div>
              </div>

              <button onClick={handleRun} disabled={running} className="btn-glow w-full flex items-center justify-center gap-2 py-3">
                {running ? <><Loader2 className="w-4 h-4 animate-spin" /> Running...</> : <><Play className="w-4 h-4" /> Run Reconciliation</>}
              </button>

              {/* Files status */}
              <div className="glass-card p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: '#64748B' }}>Files Status</h3>
                <div className="space-y-2.5">
                  {activeFiles.map(f => {
                    const uploaded = !!uploadedFiles[f.key];
                    return (
                      <div key={f.key} className="flex items-center justify-between">
                        <span className="text-xs truncate flex-1" style={{ color: '#475569' }}>{f.label}</span>
                        <span className="text-xs ml-2 font-semibold" style={{ color: uploaded ? '#059669' : f.required ? '#E11D48' : '#94A3B8' }}>
                          {uploaded ? '✓ Ready' : f.required ? 'Required' : 'Optional'}
                        </span>
                      </div>
                    );
                  })}
                  {agentType === 'bank_statement' && !isDemo && (
                    <div className="flex items-center justify-between pt-2 mt-1" style={{ borderTop: '1px solid #F1F5F9' }}>
                      <div className="flex items-center gap-1.5">
                        <Database className="w-3 h-3" style={{ color: '#94A3B8' }} />
                        <span className="text-xs" style={{ color: '#475569' }}>Ledger Master (DB)</span>
                      </div>
                      <span className="text-xs font-semibold"
                        style={{ color: ledgerStatus === 'loaded' ? '#059669' : ledgerStatus === 'missing' ? '#E11D48' : '#94A3B8' }}>
                        {ledgerStatus === 'loaded' ? '✓ Auto' : ledgerStatus === 'missing' ? '✗ Missing' : '...'}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-6">
            {/* Summary cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {Object.entries(statusCounts).map(([status, count]) => {
                const cfg = getStatusCfg(status);
                const Icon = cfg.icon;
                return (
                  <button key={status} onClick={() => setFilter(filter === status ? 'All' : status)}
                    className="glass-card p-4 text-left transition-all"
                    style={{ border: filter === status ? `2px solid ${cfg.border}` : undefined, boxShadow: filter === status ? `0 4px 16px ${cfg.color}20` : undefined }}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}>
                        <Icon className="w-4 h-4" style={{ color: cfg.color }} />
                      </div>
                      <span className="text-2xl font-black" style={{ color: '#0F172A', fontFamily: 'Barlow' }}>{count}</span>
                    </div>
                    <p className="text-xs font-semibold" style={{ color: cfg.color }}>{status}</p>
                  </button>
                );
              })}
              {result.results && (
                <div className="glass-card p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: config.bg, border: `1px solid ${config.border}` }}>
                      <FileSpreadsheet className="w-4 h-4" style={{ color: config.color }} />
                    </div>
                    <span className="text-2xl font-black" style={{ color: '#0F172A', fontFamily: 'Barlow' }}>{result.results.length}</span>
                  </div>
                  <p className="text-xs font-semibold" style={{ color: config.color }}>Total Records</p>
                </div>
              )}
            </div>

            {/* Monthly Summary */}
            {result.monthly_summary?.length > 0 && (
              <div className="glass-card overflow-hidden">
                <button onClick={() => setShowMonthly(!showMonthly)}
                  className="w-full flex items-center justify-between p-4 text-left transition-colors hover:bg-slate-50">
                  <span className="text-sm font-bold" style={{ color: '#0F172A', fontFamily: 'Barlow' }}>Monthly Summary</span>
                  {showMonthly ? <ChevronUp className="w-4 h-4" style={{ color: '#94A3B8' }} /> : <ChevronDown className="w-4 h-4" style={{ color: '#94A3B8' }} />}
                </button>
                {showMonthly && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr style={{ background: '#F8FAFC', borderBottom: '1.5px solid #E2E8F0' }}>
                          {Object.keys(result.monthly_summary[0] || {}).map(k => (
                            <th key={k} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider" style={{ color: '#64748B' }}>
                              {k.replace(/_/g, ' ')}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.monthly_summary.map((row, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #F1F5F9' }} className="hover:bg-slate-50 transition-colors">
                            {Object.values(row).map((v, j) => (
                              <td key={j} className="px-4 py-3 font-mono text-xs" style={{ color: '#334155' }}>
                                {typeof v === 'number' ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : v}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Actions bar */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex gap-2 flex-wrap">
                {filterTabs.map(tab => {
                  const active = filter === tab;
                  const tabCfg = tab !== 'All' ? getStatusCfg(tab) : null;
                  return (
                    <button key={tab} onClick={() => setFilter(tab)}
                      className="text-xs font-semibold px-3 py-1.5 rounded-full transition-all"
                      style={{
                        background: active ? (tabCfg ? tabCfg.bg : '#E8EFFE') : '#F8FAFC',
                        border: `1.5px solid ${active ? (tabCfg ? tabCfg.border : '#A3BFF8') : '#E2E8F0'}`,
                        color: active ? (tabCfg ? tabCfg.color : '#0748EE') : '#64748B',
                      }}>
                      {tab}{tab !== 'All' && statusCounts[tab] ? ` (${statusCounts[tab]})` : ''}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Correction actions — universal bank statement only */}
                {isUniversal && (
                  <>
                    {Object.keys(editedLedgers).length > 0 && (
                      <button onClick={handleSaveCorrections} disabled={savingCorrections}
                        className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all disabled:opacity-50"
                        style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#059669' }}>
                        {savingCorrections ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Save {Object.keys(editedLedgers).length} Correction{Object.keys(editedLedgers).length > 1 ? 's' : ''}
                      </button>
                    )}
                    <input ref={corrExcelRef} type="file" accept=".xlsx,.xls" className="hidden"
                      onChange={e => { if (e.target.files[0]) handleUploadCorrectionsExcel(e.target.files[0]); e.target.value = ''; }} />
                    <button onClick={() => corrExcelRef.current?.click()}
                      className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all"
                      style={{ background: '#FFFBEB', border: '1px solid #FDE68A', color: '#D97706' }}>
                      <Upload className="w-4 h-4" />
                      Upload Reviewed Excel
                    </button>
                    <input ref={outputUploadRef} type="file" accept=".xlsx,.xls" className="hidden"
                      onChange={e => { if (e.target.files[0]) handleUploadOutputExcel(e.target.files[0]); e.target.value = ''; }} />
                    <button onClick={() => outputUploadRef.current?.click()}
                      className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all"
                      style={{ background: '#F0FDF4', border: '1px solid #86EFAC', color: '#16A34A' }}>
                      <Upload className="w-4 h-4" />
                      Upload Previous Output
                    </button>
                  </>
                )}
                <button onClick={handleDownload} disabled={downloading}
                  className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all disabled:opacity-50"
                  style={{ background: '#E8EFFE', border: '1px solid #A3BFF8', color: '#0748EE' }}>
                  {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  Download Excel
                </button>
                <button
                  onClick={() => navigate(`/brands/${brandId}/reco/${agentType}/results/${result?.job_id}`)}
                  className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all text-white"
                  style={{ background: '#0748EE' }}>
                  <BarChart3 className="w-4 h-4" />
                  View Analytics
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Results table */}
            <div className="glass-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: '#F8FAFC', borderBottom: '1.5px solid #E2E8F0' }}>
                      {filteredResults[0] && Object.keys(filteredResults[0])
                        .filter(k => !['raw_books', 'raw_gstr'].includes(k))
                        .map(k => (
                          <th key={k} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider whitespace-nowrap" style={{ color: '#64748B' }}>
                            {k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                          </th>
                        ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredResults.slice(0, 200).map((row, i) => {
                      const sCfg = getStatusCfg(row.status || row.confidence || '');
                      const originalIdx = (result?.results || []).findIndex(
                        r => (r.original_description || r.description) === (row.original_description || row.description) && r.debit === row.debit && r.credit === row.credit
                      );
                      const isEdited = editedLedgers[originalIdx] !== undefined;
                      const isVerified = row.corrected;
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid #F1F5F9', background: isVerified ? '#F0FDF4' : undefined }}
                          className="hover:bg-slate-50 transition-colors">
                          {Object.entries(row)
                            .filter(([k]) => !['raw_books', 'raw_gstr', 'corrected', 'cleaned_description', 'category'].includes(k))
                            .map(([k, v], j) => (
                              <td key={j} className="px-4 py-3 whitespace-nowrap" style={{ color: '#334155' }}>
                                {/* Editable ledger cell for universal bank statement */}
                                {isUniversal && (k === 'ledger_name' || k === 'predicted_ledger') ? (
                                  <div className="flex items-center gap-1.5 min-w-[180px]">
                                    {isVerified && !isEdited && (
                                      <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#059669' }} title="Accountant-verified" />
                                    )}
                                    <input
                                      className="text-xs px-2 py-1 rounded-lg w-full outline-none transition-all"
                                      style={{
                                        background: isEdited ? '#FEF3C7' : isVerified ? '#DCFCE7' : '#F8FAFC',
                                        border: `1px solid ${isEdited ? '#FDE68A' : isVerified ? '#86EFAC' : '#E2E8F0'}`,
                                        color: '#0F172A',
                                      }}
                                      value={isEdited ? editedLedgers[originalIdx] : (String(v ?? ''))}
                                      onChange={e => setEditedLedgers(prev => ({ ...prev, [originalIdx]: e.target.value }))}
                                      onFocus={() => { if (!isEdited) setEditedLedgers(prev => ({ ...prev, [originalIdx]: String(v ?? '') })); }}
                                      title={isVerified ? 'Accountant-verified correction' : 'Click to correct ledger name'}
                                    />
                                    {isEdited && (
                                      <button className="text-xs text-slate-400 hover:text-slate-600 flex-shrink-0"
                                        onClick={() => setEditedLedgers(prev => { const n = {...prev}; delete n[originalIdx]; return n; })}>
                                        ✕
                                      </button>
                                    )}
                                  </div>
                                ) : k === 'status' ? (
                                  <span className="inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full font-semibold"
                                    style={{ background: sCfg.bg, color: sCfg.color, border: `1px solid ${sCfg.border}` }}>
                                    {v}
                                  </span>
                                ) : k === 'confidence' ? (
                                  <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold"
                                    style={{
                                      background: v === 'High' ? '#ECFDF5' : v === 'Medium' ? '#FFFBEB' : '#FFF1F2',
                                      color: v === 'High' ? '#059669' : v === 'Medium' ? '#D97706' : '#E11D48',
                                      border: `1px solid ${v === 'High' ? '#A7F3D0' : v === 'Medium' ? '#FDE68A' : '#FECDD3'}`,
                                    }}>
                                    {v}
                                  </span>
                                ) : typeof v === 'number' ? (
                                  <span className="font-mono">{v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                                ) : (
                                  String(v ?? '')
                                )}
                              </td>
                            ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filteredResults.length > 200 && (
                  <p className="text-xs text-center py-3" style={{ color: '#94A3B8' }}>
                    Showing 200 of {filteredResults.length} records — download Excel for full data
                  </p>
                )}
                {filteredResults.length === 0 && (
                  <div className="text-center py-12">
                    <p className="text-sm" style={{ color: '#94A3B8' }}>No records match this filter</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default RecoWorkspace;

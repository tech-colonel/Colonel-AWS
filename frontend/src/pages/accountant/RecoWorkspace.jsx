import React, { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import Gstr1Dashboard from './Gstr1Dashboard';
import {
  LayoutDashboard, Bot, ArrowLeft, Upload, Download,
  Play, CheckCircle2, XCircle, AlertTriangle, RotateCcw,
  FileSpreadsheet, Loader2, ChevronDown, ChevronUp, Database, Info,
  BarChart3, ArrowRight, Save, Search, X, Scale, ClipboardList,
  FolderOpen, Globe, TrendingUp, Landmark, BookOpen, GitCompare, AlertCircle,
  Zap,
} from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';

const AGENT_CONFIG = {
  gstr_2b_vs_purchase: {
    name: 'GSTR-2B vs Purchase Register',
    slug: 'GSTR-2B · PURCHASE',
    icon: ClipboardList,
    description: 'Matches invoices from your GSTR-2B download against your Purchase Register to flag missing or mismatched entries.',
    color: '#0748EE', bg: 'rgba(7,72,238,0.08)', border: 'rgba(7,72,238,0.2)',
    files: [
      { key: 'gstr2b', label: 'GSTR-2B File', hint: '.xlsx / .xls', required: true },
      { key: 'purchase', label: 'Purchase Register', hint: '.xlsx / .xls', required: true },
    ],
  },
  gstr_2a_vs_2b_vs_books: {
    name: 'GSTR2 vs Books',
    slug: 'GSTR-2A · 2B · BOOKS',
    icon: GitCompare,
    description: '3-way reconciliation comparing GSTR-2B, GSTR-2A, and your Purchase + Debit Note registers in a single pass.',
    color: '#F115F8', bg: 'rgba(241,21,248,0.08)', border: 'rgba(241,21,248,0.2)',
    files: [
      { key: 'gstr2b', label: 'GSTR-2B File', hint: '.xlsx / .xls', required: true },
      { key: 'purchase', label: 'Purchase Register', hint: '.xlsx / .xls', required: true },
      { key: 'debit', label: 'Debit Note Register', hint: '.xlsx / .xls', required: true },
    ],
  },
  gstr_2b_books: {
    name: 'GSTR-2B vs Books',
    slug: 'GSTR-2B · BOOKS',
    icon: FolderOpen,
    description: 'Reconciles GSTR-2B against both your Purchase Register and Debit Note Register. Produces a two-column remark output with Vendor Summary.',
    color: '#0748EE', bg: 'rgba(7,72,238,0.08)', border: 'rgba(7,72,238,0.2)',
    files: [
      { key: 'gstr2b', label: 'GSTR-2B File', hint: '.xlsx / .xls', required: true },
      { key: 'purchase', label: 'Purchase Register', hint: '.xlsx / .xls', required: true },
      { key: 'debit', label: 'Debit Note Register', hint: '.xlsx / .xls', required: true },
    ],
  },
  gstr_3b_vs_2b: {
    name: 'GSTR-3B vs GSTR-2B',
    slug: 'GSTR-3B · 2B · ITC',
    icon: Scale,
    description: 'Compares filed GSTR-3B ITC values against available ITC in GSTR-2B to catch over-claims or under-utilisation.',
    color: '#059669', bg: 'rgba(5,150,105,0.08)', border: 'rgba(5,150,105,0.2)',
    files: [
      { key: 'gstr3b', label: 'GSTR-3B Working File', hint: '.xlsx / .xls', required: true },
      { key: 'gstr2b_3b', label: 'GSTR-2B File', hint: '.xlsx / .xls', required: true },
    ],
  },
  gstr_1_vs_books: {
    name: 'GSTR-1 vs Books',
    slug: 'GSTR-1 · TALLY · OCTA',
    icon: TrendingUp,
    description: 'Validates outward supply filings in GSTR-1 against your Tally Sales Register and OCTA report. Optional PDF upload enables Pivot validation.',
    color: '#D97706', bg: 'rgba(217,119,6,0.08)', border: 'rgba(217,119,6,0.2)',
    files: [
      { key: 'tally_sales', label: 'Tally Sales Register', hint: '.xlsx / .xls', required: true },
      { key: 'gstr1_octa', label: 'GSTR-1 OCTA Report', hint: '.xlsx (Final GSTR-1 + GSTR2B + GSTR3B sheets)', required: true },
      { key: 'gstr1_pdf', label: 'GSTR-1 PDF from GST Portal (Optional)', hint: '.pdf — enables Pivot validation', required: false, accept: '.pdf' },
      { key: 'credit_note', label: 'Credit Note Register (Optional)', hint: '.xlsx / .xls', required: false },
    ],
  },
  bank_statement: {
    name: 'Bank Statement Classifier',
    slug: 'AI · LEDGER · TAGGING',
    icon: Landmark,
    description: 'AI-powered ledger tagging for bank transactions. Classifies each debit/credit entry and maps it to your Tally ledger master.',
    color: '#E11D48', bg: 'rgba(225,29,72,0.08)', border: 'rgba(225,29,72,0.2)',
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
    slug: 'ANY BANK · AUTO-DETECT',
    icon: Globe,
    description: 'Classifies bank transactions from any bank format — auto-detects columns, applies learned corrections from prior runs.',
    color: '#059669', bg: 'rgba(5,150,105,0.08)', border: 'rgba(5,150,105,0.2)',
    files: [
      { key: 'bank_statement', label: 'Bank Statement', hint: '.xlsx / .xls / .csv', required: true },
      { key: 'ledger_master', label: 'Ledger Master (Chart of Accounts)', hint: '.xlsx / .xls — optional, saved for future runs', required: false },
    ],
    demoFiles: [
      { key: 'bank_statement', label: 'Bank Statement', hint: '.xlsx / .xls / .csv', required: true },
      { key: 'ledger_master', label: 'Ledger Master', hint: '.xlsx / .xls', required: false, isDemo: true },
    ],
  },
  gstr_3b_tally_entry: {
    name: 'GSTR-3B Tally Entry',
    slug: 'GSTR-3B · JOURNAL ENTRY',
    icon: BookOpen,
    description: 'Extracts liability and ITC values from a GSTR-3B file and formats them as a ready-to-paste Tally journal entry.',
    color: '#0F766E', bg: 'rgba(15,118,110,0.08)', border: 'rgba(15,118,110,0.2)',
    files: [
      { key: 'gstr3b', label: 'GSTR-3B File', hint: '.pdf / .xlsx / .xls', accept: '.pdf,.xlsx,.xls', required: true },
    ],
  },
};

const STATUS_CFG = {
  Matched:              { color: '#059669', bg: 'rgba(5,150,105,0.08)',   border: 'rgba(5,150,105,0.2)',   icon: CheckCircle2 },
  'Missing in GSTR-1':  { color: '#D97706', bg: 'rgba(217,119,6,0.08)',  border: 'rgba(217,119,6,0.2)',   icon: AlertTriangle },
  'Missing in Books':   { color: '#E11D48', bg: 'rgba(225,29,72,0.08)',  border: 'rgba(225,29,72,0.2)',   icon: XCircle },
  Difference:           { color: '#F115F8', bg: 'rgba(241,21,248,0.08)', border: 'rgba(241,21,248,0.2)',  icon: AlertTriangle },
  Missing:              { color: '#E11D48', bg: 'rgba(225,29,72,0.08)',  border: 'rgba(225,29,72,0.2)',   icon: XCircle },
  Classified:           { color: '#059669', bg: 'rgba(5,150,105,0.08)',  border: 'rgba(5,150,105,0.2)',   icon: CheckCircle2 },
  Unclassified:         { color: '#64748B', bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.2)', icon: AlertTriangle },
};

const getStatusCfg = (status = '') => {
  for (const [key, val] of Object.entries(STATUS_CFG)) {
    if (status.toLowerCase().includes(key.toLowerCase())) return val;
  }
  return { color: '#64748B', bg: 'rgba(100,116,139,0.08)', border: 'rgba(100,116,139,0.2)', icon: AlertTriangle };
};

// ── File Dropzone ─────────────────────────────────────────────────────────────
const FileDropzone = ({ fileConfig, file, onChange, disabled, stepIndex }) => {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault();
    if (disabled) return;
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) onChange(f);
  };

  const active = !disabled && (dragging || hovered);
  const stepNum = String(stepIndex + 1).padStart(2, '0');

  return (
    <div
      role="button"
      aria-label={`Upload ${fileConfig.label}${fileConfig.required ? ' (required)' : ' (optional)'}`}
      tabIndex={disabled ? -1 : 0}
      onClick={() => { if (!disabled) inputRef.current?.click(); }}
      onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) inputRef.current?.click(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      style={{
        position: 'relative',
        padding: '14px 16px 14px 20px',
        borderRadius: '10px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        background: file
          ? 'rgba(5,150,105,0.06)'
          : active
          ? 'rgba(7,72,238,0.05)'
          : 'var(--surface)',
        border: `1px solid ${
          file
            ? 'rgba(5,150,105,0.25)'
            : active
            ? 'rgba(7,72,238,0.35)'
            : 'var(--card-border)'
        }`,
        borderLeft: `3px solid ${
          file ? '#059669' : active ? '#0748EE' : 'transparent'
        }`,
        transition: 'all 0.18s ease',
        overflow: 'hidden',
      }}
    >
      {/* Watermark step number */}
      <span style={{
        position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
        fontFamily: 'Barlow', fontWeight: 700, fontSize: 40, lineHeight: 1,
        color: file ? 'rgba(5,150,105,0.1)' : 'rgba(0,0,0,0.04)',
        pointerEvents: 'none', userSelect: 'none',
      }}>{stepNum}</span>

      <input
        ref={inputRef} type="file"
        accept={fileConfig.accept || '.xlsx,.xls,.csv'}
        className="hidden" disabled={disabled}
        onChange={e => onChange(e.target.files[0])}
      />

      {file ? (
        <div className="flex items-center gap-3">
          <div style={{
            width: 34, height: 34, borderRadius: 8, flexShrink: 0,
            background: 'rgba(5,150,105,0.12)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <FileSpreadsheet style={{ width: 16, height: 16, color: '#059669' }} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate" style={{ color: '#059669', fontFamily: 'Barlow' }}>
              {file.name}
            </p>
            <p className="text-xs font-mono mt-0.5" style={{ color: 'rgba(5,150,105,0.55)' }}>
              {(file.size / 1024).toFixed(1)} KB · READY
            </p>
          </div>
          <CheckCircle2 style={{ width: 16, height: 16, flexShrink: 0, color: '#059669' }} />
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <div style={{
            width: 34, height: 34, borderRadius: 8, flexShrink: 0,
            background: active ? 'rgba(7,72,238,0.1)' : 'var(--page-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.18s ease',
          }}>
            <Upload style={{ width: 15, height: 15, color: active ? '#0748EE' : 'var(--text-muted)' }} />
          </div>
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
              {fileConfig.label}
              {fileConfig.required
                ? <span style={{ color: '#E11D48', marginLeft: 4, fontWeight: 400 }}>*</span>
                : <span className="ml-2 text-xs font-normal" style={{ color: 'var(--text-muted)', fontFamily: 'DM Sans' }}>optional</span>
              }
            </p>
            <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {fileConfig.hint}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Stat Card (post-run) ──────────────────────────────────────────────────────
const StatCard = ({ status, count, active, onClick, cfg }) => {
  const Icon = cfg.icon;
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? cfg.bg : 'var(--surface)',
        border: `1px solid ${active ? cfg.border : 'var(--card-border)'}`,
        borderLeft: `4px solid ${cfg.color}`,
        borderRadius: 10,
        padding: '14px 18px',
        textAlign: 'left',
        transition: 'all 0.18s ease',
        boxShadow: active ? `0 4px 20px ${cfg.color}18` : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Icon style={{ width: 13, height: 13, color: cfg.color }} />
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: cfg.color, fontFamily: 'DM Sans' }}>
          {status}
        </span>
      </div>
      <p style={{ fontSize: 34, fontWeight: 900, fontFamily: 'Barlow', lineHeight: 1, color: 'var(--text-heading)', margin: 0 }}>
        {count.toLocaleString('en-IN')}
      </p>
    </button>
  );
};

// ── Main Component ────────────────────────────────────────────────────────────
const RecoWorkspace = ({ agentTypeProp } = {}) => {
  const { brandId, agentType: agentTypeParam } = useParams();
  const agentType = agentTypeProp || agentTypeParam;
  const navigate = useNavigate();
  const config = AGENT_CONFIG[agentType];
  const isDemo = localStorage.getItem('token') === 'demo-mode-token';

  const [uploadedFiles, setUploadedFiles] = useState({});
  const [tolerance, setTolerance] = useState('1.0');
  const [running, setRunning] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [filter, setFilter] = useState('All');
  const [downloading, setDownloading] = useState(false);
  const [showMonthly, setShowMonthly] = useState(true);
  const [ledgerStatus, setLedgerStatus] = useState(null);

  const isUniversal = agentType === 'universal_bank_statement';
  const [brands, setBrands] = useState([]);
  const [selectedBrand, setSelectedBrand] = useState(brandId && brandId !== 'other' ? brandId : '');
  const [editedLedgers, setEditedLedgers] = useState({});
  const [savingCorrections, setSavingCorrections] = useState(false);
  const [brandPickerOpen, setBrandPickerOpen] = useState(false);
  const [brandSearch, setBrandSearch] = useState('');
  const corrExcelRef = useRef(null);
  const outputUploadRef = useRef(null);
  const effectiveBrandId = selectedBrand || brandId || null;
  const effectiveBrandName = brands.find(b => b.id === effectiveBrandId)?.name || null;
  const cacheKey = `reco_result_${agentType}_${effectiveBrandId || brandId}`;
  const editsKey = `reco_edits_${agentType}_${effectiveBrandId || brandId}`;

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(editsKey);
      if (saved) setEditedLedgers(JSON.parse(saved));
    } catch (_) {}
  }, [editsKey]);

  useEffect(() => {
    try {
      if (Object.keys(editedLedgers).length > 0) {
        sessionStorage.setItem(editsKey, JSON.stringify(editedLedgers));
      } else {
        sessionStorage.removeItem(editsKey);
      }
    } catch (_) {}
  }, [editedLedgers, editsKey]);

  useEffect(() => {
    if (agentType === 'bank_statement' && !isDemo && brandId !== 'demo') checkLedgerMaster(brandId);
    api.get('/api/brands').then(r => {
      const list = r.data?.brands || r.data || [];
      setBrands(list);
      const urlBrandValid = brandId && brandId !== 'other' &&
        (list.length === 0 || list.some(b => b.id === brandId));
      if (!urlBrandValid && list.length > 0) setBrandPickerOpen(true);
    }).catch(() => {});
    if (!result) {
      try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) setResult(JSON.parse(cached));
      } catch (_) {}
    }
  }, [agentType, brandId, isDemo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-check saved CoA when brand changes for universal bank statement
  useEffect(() => {
    if (isUniversal && effectiveBrandId && effectiveBrandId !== 'other' && !isDemo) {
      checkLedgerMaster(effectiveBrandId);
    } else if (isUniversal) {
      setLedgerStatus(null);
    }
  }, [effectiveBrandId]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkLedgerMaster = async (bid) => {
    try {
      const res = await api.get(`/api/reco/ledger-status/${bid}`);
      setLedgerStatus(res.data.hasLedger ? 'loaded' : 'missing');
    } catch { setLedgerStatus('missing'); }
  };

  const activeFiles = (() => {
    if (agentType === 'bank_statement' && isDemo && config.demoFiles) return config.demoFiles;
    if (isUniversal && isDemo && config.demoFiles) return config.demoFiles;
    return config?.files || [];
  })();

  const sidebarItems = [
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
  ];

  if (!config) {
    return (
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Agent not found</div>
      </DashboardLayout>
    );
  }

  const AgentIcon = config.icon;

  const handleFileChange = (key, file) => setUploadedFiles(prev => ({ ...prev, [key]: file }));

  const handleRun = async () => {
    const missing = activeFiles.filter(f => f.required && !uploadedFiles[f.key]);
    if (missing.length > 0) { toast.error(`Please upload: ${missing.map(f => f.label).join(', ')}`); return; }
    if (agentType === 'bank_statement' && isDemo && !uploadedFiles['ledger_master']) {
      toast.error('In demo mode, please upload the Ledger Master file'); return;
    }
    setRunning(true); setResult(null); setEditedLedgers({}); setUploadProgress(0);
    try {
      const formData = new FormData();
      formData.append('reco_type', agentType);
      formData.append('tolerance', tolerance);
      formData.append('brand_id', effectiveBrandId || brandId);
      formData.append('is_demo', isDemo ? 'true' : 'false');
      for (const [key, file] of Object.entries(uploadedFiles)) { if (file) formData.append(key, file); }
      const response = await api.post('/api/reco/run', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (evt) => {
          if (evt.total) setUploadProgress(Math.round((evt.loaded / evt.total) * 100));
        },
      });
      setUploadProgress(null);
      setResult(response.data);
      if (isUniversal) {
        try { sessionStorage.setItem(cacheKey, JSON.stringify(response.data)); } catch (_) {}
      }
      toast.success(`Reconciliation complete! ${response.data.results?.length || 0} records processed.`);
    } catch (err) {
      setUploadProgress(null);
      toast.error(err.response?.data?.error || 'Reconciliation failed');
    } finally { setRunning(false); }
  };

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
      await api.post(`/api/bank-reco/corrections/${effectiveBrandId}`, { corrections, job_id: result?.job_id });
      toast.success(`${corrections.length} correction${corrections.length > 1 ? 's' : ''} saved — will apply on next run`);
      setEditedLedgers({});
    } catch { toast.error('Failed to save corrections'); }
    finally { setSavingCorrections(false); }
  };

  const handleUploadOutputExcel = async (file) => {
    if (!file || !effectiveBrandId || effectiveBrandId === 'other') { toast.error('Select a brand before uploading'); return; }
    const fd = new FormData(); fd.append('file', file);
    try {
      const res = await api.post(`/api/bank-reco/corrections/${effectiveBrandId}/upload-output`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      if (res.data.saved > 0) {
        toast.success(`${res.data.saved} correction${res.data.saved !== 1 ? 's' : ''} imported from output Excel`);
      } else {
        toast.warning(res.data.message || 'No corrections imported — upload the classified output Excel, not the raw bank statement');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to upload output Excel');
    }
  };

  const handleUploadCorrectionsExcel = async (file) => {
    if (!file || !effectiveBrandId || effectiveBrandId === 'other') { toast.error('Select a brand before uploading corrections'); return; }
    const fd = new FormData(); fd.append('file', file);
    if (result?.job_id) fd.append('job_id', result.job_id);
    try {
      const res = await api.post(`/api/bank-reco/corrections/${effectiveBrandId}/upload-excel`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
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
    if (!window.confirm('Clear all results and uploaded files? This cannot be undone.')) return;
    try { sessionStorage.removeItem(cacheKey); sessionStorage.removeItem(editsKey); } catch (_) {}
    setUploadedFiles({}); setResult(null); setFilter('All'); setEditedLedgers({});
  };

  const flattenResult = (row) => {
    if (!('category' in row) || !('gstr2b' in row || 'purchase' in row)) return row;
    const inv = row.gstr2b || row.purchase || {};
    return {
      category: row.category, confidence: row.confidence,
      supplier: inv.supplier_name || '—', gstin: inv.supplier_gstin || '—',
      invoice_no: inv.doc_no || '—', date: inv.doc_date || '—',
      taxable_value: inv.taxable_value, igst: inv.igst, cgst: inv.cgst, sgst: inv.sgst,
      suggested_action: row.suggested_action || '—',
      remark_2: row.suggested_action_2 || row.explanation || '—',
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

  // ── Brand Picker Modal ────────────────────────────────────────────────────
  const canDismissPicker = !!(selectedBrand);
  const BrandPickerOverlay = brandPickerOpen ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(10,15,46,0.6)', backdropFilter: 'blur(8px)' }}
      onClick={e => { if (e.target === e.currentTarget && canDismissPicker) { setBrandPickerOpen(false); setBrandSearch(''); } }}
    >
      <div style={{
        width: '100%', maxWidth: 360,
        background: 'var(--surface)',
        border: '1px solid var(--card-border)',
        borderRadius: 16, padding: 24,
        boxShadow: '0 24px 80px rgba(0,0,0,0.25)',
        position: 'relative',
      }}>
        {canDismissPicker && (
          <button
            aria-label="Close brand picker"
            onClick={() => { setBrandPickerOpen(false); setBrandSearch(''); }}
            style={{
              position: 'absolute', top: 16, right: 16,
              width: 28, height: 28, borderRadius: 8,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--page-bg)', border: '1px solid var(--card-border)',
              color: 'var(--text-muted)', cursor: 'pointer',
            }}>
            <X style={{ width: 14, height: 14 }} />
          </button>
        )}

        {/* Modal header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: config.bg, border: `1.5px solid ${config.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <AgentIcon style={{ width: 18, height: 18, color: config.color }} />
          </div>
          <div>
            <h3 style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 16, color: 'var(--text-heading)', margin: 0 }}>
              Select Brand
            </h3>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', letterSpacing: '0.06em', marginTop: 2 }}>
              {config.slug}
            </p>
          </div>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 14px' }}>
          Choose which brand to run this reconciliation for. Results will be saved to that brand's database.
        </p>

        {/* Search */}
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <Search style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: 'var(--text-muted)' }} />
          <input
            autoFocus value={brandSearch} onChange={e => setBrandSearch(e.target.value)}
            placeholder="Search brands…"
            style={{
              width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8,
              borderRadius: 8, fontSize: 13, outline: 'none',
              background: 'var(--page-bg)', border: '1px solid var(--card-border)',
              color: 'var(--text-heading)', boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Brand list */}
        <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {brands.filter(b => b.name.toLowerCase().includes(brandSearch.toLowerCase())).map(b => (
            <button key={b.id}
              onClick={() => { setSelectedBrand(b.id); setBrandPickerOpen(false); setBrandSearch(''); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 10px', borderRadius: 8, textAlign: 'left',
                background: b.id === effectiveBrandId ? 'rgba(7,72,238,0.06)' : 'transparent',
                border: b.id === effectiveBrandId ? '1px solid rgba(7,72,238,0.15)' : '1px solid transparent',
                cursor: 'pointer', transition: 'all 0.15s',
              }}
              onMouseEnter={e => { if (b.id !== effectiveBrandId) e.currentTarget.style.background = 'var(--page-bg)'; }}
              onMouseLeave={e => { if (b.id !== effectiveBrandId) e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{
                width: 30, height: 30, borderRadius: 7, flexShrink: 0,
                background: `hsl(${(b.name.charCodeAt(0) * 37) % 360},60%,50%)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#fff', fontSize: 12, fontWeight: 700, fontFamily: 'Barlow',
              }}>
                {b.name[0].toUpperCase()}
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1, color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
                {b.name}
              </span>
              {b.id === effectiveBrandId && <CheckCircle2 style={{ width: 14, height: 14, color: '#0748EE', flexShrink: 0 }} />}
            </button>
          ))}
          {brands.filter(b => b.name.toLowerCase().includes(brandSearch.toLowerCase())).length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>No brands found</p>
          )}
          <div style={{ borderTop: '1px solid var(--card-border)', marginTop: 6, paddingTop: 6 }}>
            <button
              onClick={() => { setSelectedBrand('other'); setBrandPickerOpen(false); setBrandSearch(''); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', padding: '8px 10px', borderRadius: 8, textAlign: 'left',
                background: 'transparent', border: '1px solid transparent', cursor: 'pointer',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--page-bg)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{
                width: 30, height: 30, borderRadius: 7, flexShrink: 0,
                background: 'var(--page-bg)', border: '1px solid var(--card-border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14,
              }}>⚙</div>
              <div>
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', fontFamily: 'Barlow', margin: 0 }}>Other / Testing</p>
                <p style={{ fontSize: 11, color: 'var(--text-muted)', opacity: 0.6, margin: 0 }}>No corrections loaded, no DB save</p>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      {BrandPickerOverlay}
      <div style={{ padding: '24px 28px', maxWidth: 1200 }}>

        {/* Breadcrumb */}
        <button
          onClick={() => navigate(`/brands/${brandId}/agents`)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 13, color: 'var(--text-muted)',
            background: 'none', border: 'none', cursor: 'pointer',
            marginBottom: 24, padding: 0,
            transition: 'color 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.color = '#0748EE'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
        >
          <ArrowLeft style={{ width: 14, height: 14 }} />
          All Agents
        </button>

        {/* ── Agent Identity Card ─────────────────────────────────────── */}
        <div style={{
          position: 'relative', overflow: 'hidden',
          borderRadius: 14,
          background: 'var(--surface)',
          border: `1px solid var(--card-border)`,
          borderTop: `3px solid ${config.color}`,
          padding: '24px 28px',
          marginBottom: 28,
          boxShadow: `0 4px 32px ${config.color}12`,
        }}>
          {/* Watermark icon — huge, bottom-right */}
          <div style={{
            position: 'absolute', right: -8, bottom: -12,
            opacity: 0.045, pointerEvents: 'none', userSelect: 'none',
          }}>
            <AgentIcon style={{ width: 140, height: 140, color: config.color }} />
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              {/* Icon badge */}
              <div style={{
                width: 52, height: 52, borderRadius: 12, flexShrink: 0,
                background: config.bg,
                border: `1.5px solid ${config.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: `0 4px 16px ${config.color}20`,
              }}>
                <AgentIcon style={{ width: 24, height: 24, color: config.color }} />
              </div>

              <div>
                {/* Slug */}
                <p style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                  color: config.color, fontFamily: 'monospace',
                  marginBottom: 4, opacity: 0.85,
                }}>
                  {config.slug}
                </p>
                {/* Title */}
                <h1 style={{
                  fontFamily: 'Barlow', fontWeight: 900, fontSize: 26,
                  color: 'var(--text-heading)', letterSpacing: '-0.02em',
                  lineHeight: 1.1, margin: 0, marginBottom: 6,
                }}>
                  {config.name}
                </h1>
                {/* Description */}
                <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: 560, margin: 0 }}>
                  {config.description}
                </p>

                {/* Brand badge */}
                {effectiveBrandName && (
                  <button
                    onClick={() => setBrandPickerOpen(true)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      marginTop: 10, padding: '4px 10px 4px 6px',
                      borderRadius: 20, fontSize: 12, fontWeight: 600,
                      background: 'rgba(7,72,238,0.06)',
                      border: '1px solid rgba(7,72,238,0.15)',
                      color: '#0748EE', cursor: 'pointer',
                      fontFamily: 'Barlow',
                    }}
                  >
                    <div style={{
                      width: 18, height: 18, borderRadius: 4,
                      background: `hsl(${((brands.find(b => b.id === effectiveBrandId)?.name || '?').charCodeAt(0) * 37) % 360},60%,50%)`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontSize: 9, fontWeight: 800,
                    }}>
                      {(brands.find(b => b.id === effectiveBrandId)?.name || '?')[0].toUpperCase()}
                    </div>
                    {effectiveBrandName}
                    <Search style={{ width: 10, height: 10, opacity: 0.6 }} />
                  </button>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {isUniversal && (
                <>
                  <input ref={outputUploadRef} type="file" accept=".xlsx,.xls" className="hidden"
                    onChange={e => { if (e.target.files[0]) handleUploadOutputExcel(e.target.files[0]); e.target.value = ''; }} />
                  <button onClick={() => outputUploadRef.current?.click()} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                    background: 'rgba(5,150,105,0.08)', border: '1px solid rgba(5,150,105,0.2)',
                    color: '#059669', cursor: 'pointer',
                  }}>
                    <Upload style={{ width: 13, height: 13 }} />
                    Upload Previous Output
                  </button>
                </>
              )}
              {result && (
                <button onClick={handleReset} aria-label="Reset — clear all results and files" style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                  background: 'var(--page-bg)', border: '1px solid var(--card-border)',
                  color: 'var(--text-muted)', cursor: 'pointer',
                }}>
                  <RotateCcw style={{ width: 13, height: 13 }} /> Reset
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Upload Form ─────────────────────────────────────────────── */}
        {!result && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, marginBottom: 28 }}>

            {/* Left: Files */}
            <div className="glass-card" style={{ padding: 24 }}>
              <p style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--text-muted)',
                fontFamily: 'DM Sans', marginBottom: 16,
              }}>Upload Files</p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Brand selector */}
                <div style={{ marginBottom: 4 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'DM Sans' }}>
                    Brand <span style={{ color: '#E11D48' }}>*</span>
                  </p>
                  {selectedBrand && selectedBrand !== 'other' ? (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '10px 14px', borderRadius: 10,
                      background: 'var(--page-bg)', border: '1px solid var(--card-border)',
                      borderLeft: '3px solid #0748EE',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{
                          width: 26, height: 26, borderRadius: 6,
                          background: `hsl(${((brands.find(b => b.id === selectedBrand)?.name || '?').charCodeAt(0) * 37) % 360},60%,50%)`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: '#fff', fontSize: 10, fontWeight: 800, fontFamily: 'Barlow',
                        }}>
                          {(brands.find(b => b.id === selectedBrand)?.name || '?')[0].toUpperCase()}
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
                          {brands.find(b => b.id === selectedBrand)?.name || selectedBrand}
                        </span>
                        <CheckCircle2 style={{ width: 13, height: 13, color: '#0748EE' }} />
                      </div>
                      <button onClick={() => setBrandPickerOpen(true)} style={{
                        fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                        background: 'var(--surface)', border: '1px solid var(--card-border)',
                        color: 'var(--text-muted)', cursor: 'pointer',
                      }}>Change</button>
                    </div>
                  ) : selectedBrand === 'other' ? (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '10px 14px', borderRadius: 10,
                      background: 'var(--page-bg)', border: '1px solid var(--card-border)',
                    }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>Other / Testing (no DB save)</span>
                      <button onClick={() => setBrandPickerOpen(true)} style={{
                        fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                        background: 'var(--surface)', border: '1px solid var(--card-border)',
                        color: 'var(--text-muted)', cursor: 'pointer',
                      }}>Change</button>
                    </div>
                  ) : (
                    <button onClick={() => setBrandPickerOpen(true)} style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                      padding: '10px 14px', borderRadius: 10, textAlign: 'left',
                      background: 'var(--page-bg)', border: '1px dashed var(--card-border)',
                      color: 'var(--text-muted)', cursor: 'pointer',
                      fontSize: 13, fontFamily: 'Barlow',
                    }}>
                      <Search style={{ width: 14, height: 14 }} />
                      Select brand…
                    </button>
                  )}
                </div>

                {/* File slots */}
                {activeFiles.map((f, idx) => (
                  <React.Fragment key={f.key}>
                    <FileDropzone
                      fileConfig={f} file={uploadedFiles[f.key]}
                      onChange={(file) => handleFileChange(f.key, file)}
                      disabled={running} stepIndex={idx}
                    />
                    {f.isDemo && (
                      <div style={{
                        display: 'flex', alignItems: 'flex-start', gap: 8,
                        padding: '10px 14px', borderRadius: 8,
                        background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.18)',
                      }}>
                        <Info style={{ width: 13, height: 13, color: '#D97706', flexShrink: 0, marginTop: 2 }} />
                        <p style={{ fontSize: 11, color: 'var(--text-body)', margin: 0, lineHeight: 1.5 }}>
                          <strong>Demo mode:</strong> Ledger Master required here. In production, it's auto-loaded from your brand's saved master data.
                        </p>
                      </div>
                    )}
                  </React.Fragment>
                ))}

                {agentType === 'bank_statement' && !isDemo && (
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', borderRadius: 10,
                    background: ledgerStatus === 'missing' ? 'rgba(225,29,72,0.06)' : 'rgba(5,150,105,0.06)',
                    border: `1px solid ${ledgerStatus === 'missing' ? 'rgba(225,29,72,0.2)' : 'rgba(5,150,105,0.2)'}`,
                  }}>
                    <Database style={{ width: 15, height: 15, flexShrink: 0, marginTop: 1, color: ledgerStatus === 'missing' ? '#E11D48' : '#059669' }} />
                    <div>
                      <p style={{ fontSize: 13, fontWeight: 700, fontFamily: 'Barlow', margin: '0 0 2px', color: ledgerStatus === 'missing' ? '#E11D48' : '#059669' }}>
                        Ledger Master — {ledgerStatus === 'loaded' ? 'Auto Loaded' : ledgerStatus === 'missing' ? 'Not Found' : 'Checking...'}
                      </p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
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

            {/* Right: Config + Run */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* Config card */}
              <div className="glass-card" style={{ padding: 20 }}>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', fontFamily: 'DM Sans', marginBottom: 14 }}>
                  Configuration
                </p>
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'DM Sans', marginBottom: 6 }}>
                    Tolerance
                  </label>
                  <div style={{
                    display: 'flex', borderRadius: 8, overflow: 'hidden',
                    border: '1px solid var(--card-border)',
                    opacity: running ? 0.6 : 1,
                  }}>
                    <span style={{
                      display: 'flex', alignItems: 'center', padding: '0 12px',
                      background: 'var(--page-bg)', borderRight: '1px solid var(--card-border)',
                      fontSize: 14, fontWeight: 700, color: 'var(--text-muted)', flexShrink: 0,
                      fontFamily: 'Barlow',
                    }}>₹</span>
                    <input
                      type="number" step="0.5" min="0" value={tolerance}
                      onChange={e => setTolerance(e.target.value)}
                      disabled={running}
                      aria-label="Tolerance in rupees"
                      style={{
                        flex: 1, padding: '9px 12px', fontSize: 14, outline: 'none',
                        background: 'var(--surface)', color: 'var(--text-heading)',
                        border: 'none', fontFamily: 'monospace',
                      }}
                    />
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                    Amounts within this range are considered matched
                  </p>
                </div>
              </div>

              {/* Run button */}
              <button
                onClick={handleRun} disabled={running}
                className="btn-glow"
                style={{ width: '100%', padding: '13px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
              >
                {running
                  ? uploadProgress !== null && uploadProgress < 100
                    ? <><Upload style={{ width: 15, height: 15 }} /> Uploading {uploadProgress}%</>
                    : <><Loader2 style={{ width: 15, height: 15 }} className="animate-spin" /> Processing…</>
                  : <><Zap style={{ width: 15, height: 15 }} /> Run Reconciliation</>
                }
              </button>

              {/* Progress bar */}
              {running && uploadProgress !== null && (
                <div style={{ borderRadius: 4, overflow: 'hidden', background: 'var(--page-bg)', height: 3 }}>
                  <div style={{
                    height: '100%', width: `${uploadProgress}%`,
                    background: uploadProgress < 100 ? config.color : '#059669',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
              )}

              {/* Files status panel */}
              <div className="glass-card" style={{ padding: 16 }}>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', fontFamily: 'DM Sans', marginBottom: 10 }}>
                  Files Status
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {activeFiles.map(f => {
                    const uploaded = !!uploadedFiles[f.key];
                    return (
                      <div key={f.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-body)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {f.label}
                        </span>
                        <span style={{
                          fontSize: 11, fontWeight: 700, marginLeft: 8, flexShrink: 0, fontFamily: 'monospace',
                          color: uploaded ? '#059669' : f.required ? '#E11D48' : 'var(--text-muted)',
                        }}>
                          {uploaded ? '✓ READY' : f.required ? 'REQUIRED' : 'OPTIONAL'}
                        </span>
                      </div>
                    );
                  })}
                  {(agentType === 'bank_statement' || isUniversal) && !isDemo && (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      paddingTop: 8, marginTop: 2, borderTop: '1px solid var(--card-border)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Database style={{ width: 11, height: 11, color: 'var(--text-muted)' }} />
                        <span style={{ fontSize: 12, color: 'var(--text-body)' }}>
                          {isUniversal ? 'Chart of Accounts (Saved)' : 'Ledger Master (DB)'}
                        </span>
                      </div>
                      <span style={{
                        fontSize: 11, fontWeight: 700, fontFamily: 'monospace',
                        color: ledgerStatus === 'loaded' ? '#059669' : ledgerStatus === 'missing' ? '#D97706' : 'var(--text-muted)',
                      }}>
                        {ledgerStatus === 'loaded' ? '✓ SAVED' : ledgerStatus === 'missing' ? '— NONE' : isUniversal && effectiveBrandId ? '...' : '—'}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Results ─────────────────────────────────────────────────── */}
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* Stat cards — left-bordered, flat */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
              {Object.entries(statusCounts).map(([status, count]) => {
                const cfg = getStatusCfg(status);
                return (
                  <StatCard
                    key={status} status={status} count={count}
                    active={filter === status} cfg={cfg}
                    onClick={() => setFilter(filter === status ? 'All' : status)}
                  />
                );
              })}
              {result.results && (
                <div style={{
                  background: 'var(--surface)',
                  border: `1px solid var(--card-border)`,
                  borderLeft: `4px solid ${config.color}`,
                  borderRadius: 10, padding: '14px 18px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <FileSpreadsheet style={{ width: 13, height: 13, color: config.color }} />
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: config.color, fontFamily: 'DM Sans' }}>
                      Total Records
                    </span>
                  </div>
                  <p style={{ fontSize: 34, fontWeight: 900, fontFamily: 'Barlow', lineHeight: 1, color: 'var(--text-heading)', margin: 0 }}>
                    {(result.counts?.total_records ?? result.results.length).toLocaleString('en-IN')}
                  </p>
                </div>
              )}
            </div>

            {/* Monthly Summary */}
            {result.monthly_summary?.length > 0 && (
              <div className="glass-card" style={{ overflow: 'hidden' }}>
                <button
                  onClick={() => setShowMonthly(!showMonthly)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '14px 20px', textAlign: 'left', cursor: 'pointer',
                    background: 'none', border: 'none',
                  }}
                >
                  <span style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)' }}>
                    Monthly Summary
                  </span>
                  {showMonthly
                    ? <ChevronUp style={{ width: 15, height: 15, color: 'var(--text-muted)' }} />
                    : <ChevronDown style={{ width: 15, height: 15, color: 'var(--text-muted)' }} />
                  }
                </button>
                {showMonthly && (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                          {Object.keys(result.monthly_summary[0] || {}).map(k => (
                            <th key={k} style={{
                              padding: '10px 16px', textAlign: 'left',
                              fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                              textTransform: 'uppercase', color: 'var(--text-muted)', fontFamily: 'DM Sans',
                              whiteSpace: 'nowrap',
                            }}>
                              {k.replace(/_/g, ' ')}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.monthly_summary.map((row, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--card-border)' }}>
                            {Object.values(row).map((v, j) => (
                              <td key={j} style={{ padding: '10px 16px', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-body)' }}>
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

            {/* Filter tabs + action bar */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {agentType !== 'gstr_1_vs_books' && filterTabs.map(tab => {
                  const active = filter === tab;
                  const tabCfg = tab !== 'All' ? getStatusCfg(tab) : null;
                  return (
                    <button key={tab} onClick={() => setFilter(tab)} style={{
                      padding: '5px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                      letterSpacing: '0.04em', fontFamily: 'DM Sans', cursor: 'pointer',
                      background: active ? (tabCfg ? tabCfg.bg : 'rgba(7,72,238,0.08)') : 'var(--surface)',
                      border: `1px solid ${active ? (tabCfg ? tabCfg.border : 'rgba(7,72,238,0.2)') : 'var(--card-border)'}`,
                      color: active ? (tabCfg ? tabCfg.color : '#0748EE') : 'var(--text-muted)',
                    }}>
                      {tab}{tab !== 'All' && statusCounts[tab] ? ` · ${statusCounts[tab]}` : ''}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {isUniversal && (
                  <>
                    {Object.keys(editedLedgers).length > 0 && (
                      <button onClick={handleSaveCorrections} disabled={savingCorrections} style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                        borderRadius: 8, fontSize: 12, fontWeight: 700,
                        background: 'rgba(5,150,105,0.08)', border: '1px solid rgba(5,150,105,0.2)',
                        color: '#059669', cursor: 'pointer', opacity: savingCorrections ? 0.6 : 1,
                        fontFamily: 'Barlow',
                      }}>
                        {savingCorrections ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Save style={{ width: 13, height: 13 }} />}
                        Save {Object.keys(editedLedgers).length} Correction{Object.keys(editedLedgers).length > 1 ? 's' : ''}
                      </button>
                    )}
                    <input ref={corrExcelRef} type="file" accept=".xlsx,.xls" className="hidden"
                      onChange={e => { if (e.target.files[0]) handleUploadCorrectionsExcel(e.target.files[0]); e.target.value = ''; }} />
                    <button onClick={() => corrExcelRef.current?.click()} style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                      borderRadius: 8, fontSize: 12, fontWeight: 700,
                      background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.2)',
                      color: '#D97706', cursor: 'pointer', fontFamily: 'Barlow',
                    }}>
                      <Upload style={{ width: 13, height: 13 }} />
                      Upload Reviewed Excel
                    </button>
                  </>
                )}
                <button onClick={handleDownload} disabled={downloading} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                  borderRadius: 8, fontSize: 12, fontWeight: 700,
                  background: 'rgba(7,72,238,0.08)', border: '1px solid rgba(7,72,238,0.2)',
                  color: '#0748EE', cursor: 'pointer', opacity: downloading ? 0.6 : 1,
                  fontFamily: 'Barlow',
                }}>
                  {downloading ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Download style={{ width: 13, height: 13 }} />}
                  Download Excel
                </button>
                <button
                  onClick={() => navigate(`/brands/${effectiveBrandId || brandId}/reco/${agentType}/results/${result?.job_id}`)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                    borderRadius: 8, fontSize: 12, fontWeight: 700,
                    background: '#0748EE', color: '#fff', border: 'none', cursor: 'pointer',
                    fontFamily: 'Barlow',
                  }}
                >
                  <BarChart3 style={{ width: 13, height: 13 }} />
                  View Analytics
                  <ArrowRight style={{ width: 12, height: 12 }} />
                </button>
              </div>
            </div>

            {/* GSTR-1 vs Books dashboard */}
            {agentType === 'gstr_1_vs_books' && (
              <div className="glass-card" style={{ padding: 16 }}>
                <Gstr1Dashboard result={result} />
              </div>
            )}

            {/* Results table */}
            {agentType !== 'gstr_1_vs_books' && (
              <div className="glass-card" style={{ overflow: 'hidden' }}>
                {/* Pagination banner */}
                {filteredResults.length > 200 && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 18px',
                    background: 'rgba(217,119,6,0.06)', borderBottom: '1px solid rgba(217,119,6,0.15)',
                  }}>
                    <AlertCircle style={{ width: 14, height: 14, color: '#D97706', flexShrink: 0 }} />
                    <p style={{ fontSize: 12, fontWeight: 600, color: '#D97706', margin: 0 }}>
                      Showing first 200 of {filteredResults.length} records.
                      <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 4 }}>
                        Download the Excel file to view all.
                      </span>
                    </p>
                    <button onClick={handleDownload} disabled={downloading} style={{
                      marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5,
                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                      background: 'rgba(217,119,6,0.1)', border: '1px solid rgba(217,119,6,0.25)',
                      color: '#D97706', cursor: 'pointer', flexShrink: 0,
                      opacity: downloading ? 0.6 : 1, fontFamily: 'Barlow',
                    }}>
                      {downloading ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : <Download style={{ width: 12, height: 12 }} />}
                      Download All
                    </button>
                  </div>
                )}
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                        {filteredResults[0] && Object.keys(filteredResults[0])
                          .filter(k => !['raw_books', 'raw_gstr'].includes(k))
                          .map(k => (
                            <th key={k} style={{
                              padding: '10px 14px', textAlign: 'left',
                              fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                              textTransform: 'uppercase', color: 'var(--text-muted)',
                              whiteSpace: 'nowrap', fontFamily: 'DM Sans',
                            }}>
                              {k.replace(/_/g, ' ')}
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
                          <tr key={i}
                            style={{
                              borderBottom: '1px solid var(--card-border)',
                              background: isVerified ? 'rgba(5,150,105,0.03)' : undefined,
                            }}
                          >
                            {Object.entries(row)
                              .filter(([k]) => !['raw_books', 'raw_gstr', 'corrected', 'cleaned_description', 'category'].includes(k))
                              .map(([k, v], j) => (
                                <td key={j} style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: 'var(--text-body)' }}>
                                  {isUniversal && (k === 'ledger_name' || k === 'predicted_ledger') ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 180 }}>
                                      {isVerified && !isEdited && (
                                        <CheckCircle2 style={{ width: 12, height: 12, flexShrink: 0, color: '#059669' }} title="Accountant-verified" />
                                      )}
                                      <input
                                        aria-label={`Edit ledger for row ${i + 1}`}
                                        style={{
                                          fontSize: 12, padding: '3px 8px', borderRadius: 6,
                                          width: '100%', outline: 'none',
                                          background: isEdited ? 'rgba(217,119,6,0.08)' : isVerified ? 'rgba(5,150,105,0.06)' : 'var(--page-bg)',
                                          border: `1px solid ${isEdited ? 'rgba(217,119,6,0.25)' : isVerified ? 'rgba(5,150,105,0.2)' : 'var(--card-border)'}`,
                                          color: 'var(--text-heading)',
                                          fontFamily: 'DM Sans',
                                        }}
                                        value={isEdited ? editedLedgers[originalIdx] : (String(v ?? ''))}
                                        onChange={e => setEditedLedgers(prev => ({ ...prev, [originalIdx]: e.target.value }))}
                                        onFocus={() => { if (!isEdited) setEditedLedgers(prev => ({ ...prev, [originalIdx]: String(v ?? '') })); }}
                                        title={isVerified ? 'Accountant-verified correction' : 'Click to correct ledger name'}
                                      />
                                      {isEdited && (
                                        <button
                                          aria-label="Discard ledger edit"
                                          onClick={() => setEditedLedgers(prev => { const n = {...prev}; delete n[originalIdx]; return n; })}
                                          style={{
                                            width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            background: 'var(--page-bg)', border: '1px solid var(--card-border)',
                                            color: 'var(--text-muted)', cursor: 'pointer',
                                          }}>
                                          <X style={{ width: 10, height: 10 }} />
                                        </button>
                                      )}
                                    </div>
                                  ) : k === 'status' ? (
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 4,
                                      fontSize: 11, fontWeight: 700, padding: '2px 8px',
                                      borderRadius: 4, fontFamily: 'DM Sans',
                                      background: sCfg.bg, color: sCfg.color, border: `1px solid ${sCfg.border}`,
                                    }}>
                                      {v}
                                    </span>
                                  ) : k === 'confidence' ? (
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 4,
                                      fontSize: 11, fontWeight: 700, padding: '2px 8px',
                                      borderRadius: 4, fontFamily: 'DM Sans',
                                      background: v === 'High' ? 'rgba(5,150,105,0.08)' : v === 'Medium' ? 'rgba(217,119,6,0.08)' : 'rgba(225,29,72,0.08)',
                                      color: v === 'High' ? '#059669' : v === 'Medium' ? '#D97706' : '#E11D48',
                                      border: `1px solid ${v === 'High' ? 'rgba(5,150,105,0.2)' : v === 'Medium' ? 'rgba(217,119,6,0.2)' : 'rgba(225,29,72,0.2)'}`,
                                    }}>
                                      {v}
                                    </span>
                                  ) : typeof v === 'number' ? (
                                    <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
                                      {v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                                    </span>
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
                  {filteredResults.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '48px 0' }}>
                      <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No records match this filter</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default RecoWorkspace;

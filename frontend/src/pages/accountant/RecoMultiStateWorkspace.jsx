import React, { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LayoutDashboard, Bot, ArrowLeft, Upload, Download, Play,
  CheckCircle2, XCircle, AlertTriangle, RotateCcw, FileSpreadsheet,
  Loader2, Plus, Trash2, CheckSquare, BarChart3, ArrowRight,
} from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';

const COLOR = '#7C3AED';
const BG    = '#F5F3FF';
const BORD  = '#C4B5FD';

// ── Session persistence helpers ───────────────────────────────────────────────
const SESSION_KEY = 'colonel_multistate_slots';
const DEFAULT_SLOT_COUNT = 4;

const fileToB64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve({ name: file.name, size: file.size, b64: reader.result.split(',')[1] });
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

const b64ToFile = ({ name, b64 }) => {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new File([arr], name);
};

const loadSlotsFromSession = () => {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw).map(slot => ({
      gstr2b:   slot.gstr2b   ? b64ToFile(slot.gstr2b)   : null,
      purchase: slot.purchase ? b64ToFile(slot.purchase) : null,
      debit:    slot.debit    ? b64ToFile(slot.debit)    : null,
    }));
  } catch { return null; }
};

const AGENT_META = {
  name: 'GSTR-2B vs Books (Multi-State)',
  icon: '🗺️',
  color: COLOR, bg: BG, border: BORD,
};

// ── Tiny single-file dropzone ─────────────────────────────────────────────────
const MiniDropzone = ({ label, hint, file, onChange, required }) => {
  const inputRef = useRef(null);
  const [drag, setDrag] = useState(false);

  const handleDrop = (e) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files[0]; if (f) onChange(f);
  };

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={handleDrop}
      style={{
        padding: '12px 14px', borderRadius: '10px', cursor: 'pointer',
        background: file ? '#ECFDF5' : drag ? BG : '#F8FAFC',
        border: `1.5px ${drag ? 'solid' : 'dashed'} ${file ? '#A7F3D0' : drag ? BORD : '#CBD5E1'}`,
        transition: 'all 0.18s ease',
      }}
    >
      <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
        onChange={e => onChange(e.target.files[0])} />
      {file ? (
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="w-4 h-4 flex-shrink-0" style={{ color: '#059669' }} />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold truncate" style={{ color: '#059669' }}>{file.name}</p>
            <p className="text-xs" style={{ color: '#6EE7B7' }}>{(file.size / 1024).toFixed(1)} KB</p>
          </div>
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#059669' }} />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Upload className="w-4 h-4 flex-shrink-0" style={{ color: drag ? COLOR : '#94A3B8' }} />
          <div>
            <p className="text-xs font-semibold" style={{ color: '#334155' }}>
              {label}{required && <span style={{ color: '#E11D48' }}> *</span>}
            </p>
            <p className="text-xs" style={{ color: '#94A3B8' }}>{hint}</p>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Status helpers ────────────────────────────────────────────────────────────
const STATUS_CFG = {
  Matched:         { color: '#059669', bg: '#ECFDF5', border: '#A7F3D0', icon: CheckCircle2 },
  'Amount Mismatch': { color: '#D97706', bg: '#FFFBEB', border: '#FDE68A', icon: AlertTriangle },
  'In GSTR-2B not in Books': { color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8', icon: AlertTriangle },
  'In Books not in GSTR-2B': { color: '#E11D48', bg: '#FFF1F2', border: '#FECDD3', icon: XCircle },
  'Showing in 2B but Not in Books': { color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8', icon: AlertTriangle },
  'Showing in Books but Not in 2B': { color: '#E11D48', bg: '#FFF1F2', border: '#FECDD3', icon: XCircle },
};
const getStatusCfg = (s = '') => {
  for (const [key, val] of Object.entries(STATUS_CFG)) {
    if ((s || '').toLowerCase().includes(key.toLowerCase())) return val;
  }
  return { color: '#64748B', bg: '#F8FAFC', border: '#E2E8F0', icon: AlertTriangle };
};

// ── Main component ────────────────────────────────────────────────────────────
const RecoMultiStateWorkspace = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();

  // stateSlots: array of { gstr2b: File|null, purchase: File|null, debit: File|null }
  // Initialise from session (persists across refresh) or default to 4 empty slots
  const [stateSlots, setStateSlots] = useState(
    () => loadSlotsFromSession() || Array.from({ length: DEFAULT_SLOT_COUNT }, () => ({ gstr2b: null, purchase: null, debit: null }))
  );
  const [tolerance, setTolerance] = useState('1.0');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [filter, setFilter] = useState('All');
  const [downloading, setDownloading] = useState(false);

  // Persist slots to sessionStorage whenever files change
  useEffect(() => {
    const persist = async () => {
      try {
        const serialised = await Promise.all(
          stateSlots.map(async slot => ({
            gstr2b:   slot.gstr2b   ? await fileToB64(slot.gstr2b)   : null,
            purchase: slot.purchase ? await fileToB64(slot.purchase) : null,
            debit:    slot.debit    ? await fileToB64(slot.debit)    : null,
          }))
        );
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(serialised));
      } catch {
        // sessionStorage quota exceeded or unavailable — silently skip
      }
    };
    persist();
  }, [stateSlots]);

  const sidebarItems = [
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
    { path: '/tasks', label: 'Tasks', icon: CheckSquare, testId: 'nav-tasks' },
  ];

  const addState = () => setStateSlots(prev => [...prev, { gstr2b: null, purchase: null, debit: null }]);
  const removeState = (idx) => setStateSlots(prev => prev.filter((_, i) => i !== idx));
  const setSlotFile = (slotIdx, fieldKey, file) => setStateSlots(prev => {
    const next = [...prev];
    next[slotIdx] = { ...next[slotIdx], [fieldKey]: file };
    return next;
  });

  const handleRun = async () => {
    const missing = stateSlots.some(s => !s.gstr2b || !s.purchase);
    if (missing) {
      toast.error('Each state must have a GSTR-2B file and a Purchase Register file.'); return;
    }
    setRunning(true); setResult(null);
    try {
      const formData = new FormData();
      formData.append('reco_type', 'gstr_2b_books_multistate');
      formData.append('tolerance', tolerance);
      formData.append('brand_id', brandId);
      formData.append('is_demo', localStorage.getItem('token') === 'demo-mode-token' ? 'true' : 'false');
      // All files use the same field name — Python server accumulates them into lists
      for (const slot of stateSlots) {
        if (slot.gstr2b)   formData.append('gstr2b',   slot.gstr2b);
        if (slot.purchase) formData.append('purchase', slot.purchase);
        if (slot.debit)    formData.append('debit',    slot.debit);
        else               formData.append('debit',    new Blob([]), 'empty.xlsx');
      }
      const response = await api.post('/api/reco/run', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(response.data);
      toast.success(`Reconciliation complete! ${response.data.results?.length || 0} records processed.`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Reconciliation failed');
    } finally {
      setRunning(false);
    }
  };

  const handleDownload = async () => {
    if (!result?.job_id) return;
    setDownloading(true);
    try {
      const response = await api.get(`/api/reco/export/${result.job_id}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const a = document.createElement('a'); a.href = url;
      a.download = `gstr2b_books_multistate_${result.job_id}.xlsx`; a.click();
      window.URL.revokeObjectURL(url);
      toast.success('Excel downloaded!');
    } catch { toast.error('Download failed'); }
    finally { setDownloading(false); }
  };

  const handleReset = () => {
    setResult(null); setFilter('All');
  };

  const handleClearFiles = () => {
    sessionStorage.removeItem(SESSION_KEY);
    setStateSlots(Array.from({ length: DEFAULT_SLOT_COUNT }, () => ({ gstr2b: null, purchase: null, debit: null })));
    setResult(null);
    toast.success('All files cleared');
  };

  // Flatten result row for table display, exposing Remark 3
  const flattenResult = (row) => {
    const inv = row.gstr2b || row.purchase || {};
    return {
      category:     row.category       || '—',
      supplier:     inv.supplier_name  || '—',
      gstin:        inv.supplier_gstin || '—',
      invoice_no:   inv.doc_no         || '—',
      date:         inv.doc_date       || '—',
      taxable_value: inv.taxable_value ?? '',
      remark_1:     row.suggested_action  || '—',
      remark_2:     row.suggested_action_2 || '',
      remark_3:     row.suggested_action_3 || '',
    };
  };

  const statusCounts = (result?.results || []).reduce((acc, r) => {
    const s = r.category || 'Unknown';
    acc[s] = (acc[s] || 0) + 1; return acc;
  }, {});

  const filterTabs = ['All', ...Object.keys(statusCounts)];
  const filteredResults = (result?.results || [])
    .map(flattenResult)
    .filter(r => filter === 'All' || r.category === filter);

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6 max-w-7xl">

        {/* Breadcrumb */}
        <button onClick={() => navigate(`/brands/${brandId}/agents`)}
          className="flex items-center gap-1.5 text-sm mb-6 group transition-colors hover:text-purple-600"
          style={{ color: '#64748B' }}>
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
          All Agents
        </button>

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl flex-shrink-0"
              style={{ background: BG, border: `1px solid ${BORD}`, boxShadow: `0 4px 20px ${COLOR}20` }}>
              {AGENT_META.icon}
            </div>
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <span className="w-2 h-2 rounded-full bg-purple-500" />
                <span className="text-xs font-semibold" style={{ color: COLOR }}>Multi-State Reconciliation Agent</span>
              </div>
              <h1 className="text-2xl font-black" style={{ color: '#0F172A', fontFamily: 'Barlow', letterSpacing: '-0.02em' }}>
                {AGENT_META.name}
              </h1>
              <p className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
                Upload files for each state — detects cross-state booking errors in Remark 3
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {result && (
              <button onClick={handleReset}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl transition-colors hover:bg-slate-100"
                style={{ color: '#64748B', border: '1px solid #E2E8F0' }}>
                <RotateCcw className="w-3.5 h-3.5" /> Reset
              </button>
            )}
            <button onClick={handleClearFiles}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl transition-colors hover:bg-red-50"
              style={{ color: '#E11D48', border: '1px solid #FECDD3' }}>
              <Trash2 className="w-3.5 h-3.5" /> Clear Files
            </button>
          </div>
        </div>

        {/* How it works banner */}
        {!result && (
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl mb-6"
            style={{ background: BG, border: `1px solid ${BORD}` }}>
            <span className="text-lg mt-0.5">🗺️</span>
            <div>
              <p className="text-sm font-semibold" style={{ color: COLOR }}>Multi-State Mode</p>
              <p className="text-xs mt-0.5" style={{ color: '#64748B' }}>
                Add one row per state/GSTIN. All files are merged and reconciled together.
                If an invoice appears as "missing" but actually belongs to another state's file,
                <strong style={{ color: COLOR }}> Remark 3</strong> will explain why.
              </p>
            </div>
          </div>
        )}

        {/* Upload panel */}
        {!result && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            <div className="lg:col-span-2 space-y-4">

              {stateSlots.map((slot, idx) => (
                <div key={idx} className="glass-card p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
                        style={{ background: BG, color: COLOR, border: `1px solid ${BORD}` }}>
                        {idx + 1}
                      </span>
                      <h3 className="text-sm font-bold" style={{ color: '#0F172A' }}>
                        State {idx + 1}
                      </h3>
                    </div>
                    {stateSlots.length > 1 && (
                      <button onClick={() => removeState(idx)}
                        className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-lg transition-colors hover:bg-red-50"
                        style={{ color: '#E11D48', border: '1px solid #FECDD3' }}>
                        <Trash2 className="w-3 h-3" /> Remove
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <MiniDropzone label="GSTR-2B" hint=".xlsx / .xls" required
                      file={slot.gstr2b} onChange={f => setSlotFile(idx, 'gstr2b', f)} />
                    <MiniDropzone label="Purchase Register" hint=".xlsx / .xls" required
                      file={slot.purchase} onChange={f => setSlotFile(idx, 'purchase', f)} />
                    <MiniDropzone label="Debit Note Register" hint=".xlsx / .xls (optional)"
                      file={slot.debit} onChange={f => setSlotFile(idx, 'debit', f)} />
                  </div>
                </div>
              ))}

              <button onClick={addState}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all hover:shadow-sm"
                style={{ background: BG, border: `1.5px dashed ${BORD}`, color: COLOR }}>
                <Plus className="w-4 h-4" /> Add Another State
              </button>
            </div>

            {/* Config + Run */}
            <div className="space-y-4">
              <div className="glass-card p-5">
                <h2 className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: '#475569' }}>
                  Configuration
                </h2>
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: '#64748B' }}>Tolerance (₹)</label>
                  <input type="number" step="0.5" min="0" value={tolerance}
                    onChange={e => setTolerance(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl text-sm outline-none transition-all"
                    style={{ background: '#F8FAFC', border: '1.5px solid #E2E8F0', color: '#0F172A' }} />
                  <p className="text-xs mt-2" style={{ color: '#94A3B8' }}>Amounts within this range are considered matched</p>
                </div>
              </div>

              <button onClick={handleRun} disabled={running}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-50 text-white"
                style={{ background: `linear-gradient(135deg, ${COLOR}, #9333EA)` }}>
                {running
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Running…</>
                  : <><Play className="w-4 h-4" /> Run Reconciliation</>}
              </button>

              <div className="glass-card p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: '#64748B' }}>
                  States Loaded — {stateSlots.length}
                </h3>
                <div className="space-y-2">
                  {stateSlots.map((slot, idx) => (
                    <div key={idx} className="flex items-center justify-between text-xs">
                      <span style={{ color: '#475569' }}>State {idx + 1}</span>
                      <span style={{ color: slot.gstr2b && slot.purchase ? '#059669' : '#E11D48', fontWeight: 600 }}>
                        {slot.gstr2b && slot.purchase ? '✓ Ready' : 'Missing files'}
                      </span>
                    </div>
                  ))}
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
                    style={{ border: filter === status ? `2px solid ${cfg.border}` : undefined }}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                        style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}>
                        <Icon className="w-4 h-4" style={{ color: cfg.color }} />
                      </div>
                      <span className="text-2xl font-black" style={{ color: '#0F172A', fontFamily: 'Barlow' }}>{count}</span>
                    </div>
                    <p className="text-xs font-semibold" style={{ color: cfg.color }}>{status}</p>
                  </button>
                );
              })}
              <div className="glass-card p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                    style={{ background: BG, border: `1px solid ${BORD}` }}>
                    <FileSpreadsheet className="w-4 h-4" style={{ color: COLOR }} />
                  </div>
                  <span className="text-2xl font-black" style={{ color: '#0F172A', fontFamily: 'Barlow' }}>
                    {result.results?.length || 0}
                  </span>
                </div>
                <p className="text-xs font-semibold" style={{ color: COLOR }}>Total Records</p>
              </div>
            </div>

            {/* Cross-state count badge */}
            {(() => {
              const crossCount = (result.results || []).filter(r => r.suggested_action_3).length;
              return crossCount > 0 ? (
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl"
                  style={{ background: '#FFF7ED', border: '1.5px solid #FDBA74' }}>
                  <span className="text-xl">🗺️</span>
                  <div>
                    <p className="text-sm font-bold" style={{ color: '#C2410C' }}>
                      {crossCount} cross-state booking {crossCount === 1 ? 'issue' : 'issues'} detected
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: '#9A3412' }}>
                      See Remark 3 column in the table below or download the Excel for the full explanation.
                    </p>
                  </div>
                </div>
              ) : null;
            })()}

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
                        background: active ? (tabCfg ? tabCfg.bg : BG) : '#F8FAFC',
                        border: `1.5px solid ${active ? (tabCfg ? tabCfg.border : BORD) : '#E2E8F0'}`,
                        color: active ? (tabCfg ? tabCfg.color : COLOR) : '#64748B',
                      }}>
                      {tab}{tab !== 'All' && statusCounts[tab] ? ` (${statusCounts[tab]})` : ''}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={handleDownload} disabled={downloading}
                  className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all disabled:opacity-50"
                  style={{ background: BG, border: `1px solid ${BORD}`, color: COLOR }}>
                  {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  Download Excel
                </button>
                <button
                  onClick={() => navigate(`/brands/${brandId}/reco/gstr_2b_books_multistate/results/${result?.job_id}`)}
                  className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all text-white"
                  style={{ background: COLOR }}>
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
                      {['Category', 'Supplier', 'GSTIN', 'Invoice No', 'Date', 'Taxable Value', 'Remark 1', 'Remark 2', 'Remark 3'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider whitespace-nowrap"
                          style={{ color: h === 'Remark 3' ? '#C2410C' : '#64748B' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredResults.slice(0, 200).map((row, i) => {
                      const sCfg = getStatusCfg(row.category);
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid #F1F5F9' }}
                          className="hover:bg-slate-50 transition-colors">
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className="inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-full font-semibold"
                              style={{ background: sCfg.bg, color: sCfg.color, border: `1px solid ${sCfg.border}` }}>
                              {row.category}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs" style={{ color: '#334155', maxWidth: 160 }}>{row.supplier}</td>
                          <td className="px-4 py-3 font-mono text-xs" style={{ color: '#64748B' }}>{row.gstin}</td>
                          <td className="px-4 py-3 text-xs" style={{ color: '#334155' }}>{row.invoice_no}</td>
                          <td className="px-4 py-3 text-xs" style={{ color: '#64748B' }}>{row.date}</td>
                          <td className="px-4 py-3 font-mono text-xs text-right" style={{ color: '#334155' }}>
                            {typeof row.taxable_value === 'number'
                              ? row.taxable_value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
                              : row.taxable_value}
                          </td>
                          <td className="px-4 py-3 text-xs" style={{ color: '#334155', maxWidth: 140 }}>{row.remark_1}</td>
                          <td className="px-4 py-3 text-xs" style={{ color: '#64748B', maxWidth: 140 }}>{row.remark_2}</td>
                          <td className="px-4 py-3 text-xs font-semibold" style={{ color: row.remark_3 ? '#C2410C' : '#94A3B8', maxWidth: 200 }}>
                            {row.remark_3 || '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filteredResults.length > 200 && (
                  <p className="text-xs text-center py-3" style={{ color: '#94A3B8' }}>
                    Showing 200 of {filteredResults.length} — download Excel for full data
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

export default RecoMultiStateWorkspace;

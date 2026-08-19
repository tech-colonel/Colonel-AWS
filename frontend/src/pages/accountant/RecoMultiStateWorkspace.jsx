import { useState, useRef, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LayoutDashboard, Bot, ArrowLeft, Upload, Download, Play,
  CheckCircle2, RotateCcw, FileSpreadsheet,
  Loader2, Plus, Trash2, BarChart3, ArrowRight,
  Search, ChevronLeft, ChevronRight, MapPin, Layers, Zap, X,
  AlertCircle,
} from 'lucide-react';
import api from '../../lib/api';
import { sidebarFor, isAdminUser } from '../../lib/adminNav';
import { MULTISTATE_SAMPLE, urlToFile } from '../../lib/demoSamples';
import { toast } from 'sonner';
import { StatusDonut, ByReasons, FeedbackModal, distOf } from '../../components/reco/ToolResultDashboard';
import DriveMultiState from '../../components/DriveMultiState';
import OpenInSheetsButton from '../../components/OpenInSheetsButton';

const COLOR  = '#7C3AED';
const PAGE_SIZE = 100;

const storageKey = (brandId) => `colonel_multistate_slots_${brandId}`;
// Books mode + the shared register, persisted alongside the per-state slots.
const combinedKey = (brandId) => `colonel_multistate_combined_${brandId}`;
const sharedKey   = (brandId) => `colonel_multistate_shared_${brandId}`;

// The full reco result (with every row's raw source dict) is ~18MB for a large
// multi-state job — far over sessionStorage's ~5MB quota, so caching it whole
// silently failed and Back lost the result. The table never reads `.raw`, so we
// cache a slim copy (raw stripped) — ~3MB, well within quota.
const slimResultForCache = (data) => {
  if (!data) return data;
  const stripRaw = (o) => { if (!o || typeof o !== 'object') return o; const { raw, ...rest } = o; return rest; };
  return {
    ...data,
    results: (data.results || []).map(r => ({ ...r, gstr2b: stripRaw(r.gstr2b), purchase: stripRaw(r.purchase) })),
  };
};

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

const loadSlotsFromStorage = (brandId) => {
  try {
    const raw = localStorage.getItem(storageKey(brandId));
    if (!raw) return null;
    return JSON.parse(raw).map(slot => ({
      gstr2b:   slot.gstr2b   ? b64ToFile(slot.gstr2b)   : null,
      purchase: slot.purchase ? b64ToFile(slot.purchase) : null,
      debit:    slot.debit    ? b64ToFile(slot.debit)    : null,
    }));
  } catch { return null; }
};

const loadSharedFromStorage = (brandId) => {
  try {
    const raw = localStorage.getItem(sharedKey(brandId));
    if (!raw) return null;
    const s = JSON.parse(raw);
    return {
      purchase: s.purchase ? b64ToFile(s.purchase) : null,
      debit:    s.debit    ? b64ToFile(s.debit)    : null,
    };
  } catch { return null; }
};

// ── Category config (rgba for dark mode compat) ───────────────────────────────
const CAT_CFG = {
  'Matched':                        { bg: 'rgba(5,150,105,0.08)',   color: '#059669', border: 'rgba(5,150,105,0.2)' },
  'Amount Mismatch':                { bg: 'rgba(217,119,6,0.08)',   color: '#D97706', border: 'rgba(217,119,6,0.2)' },
  'Partially Matched':              { bg: 'rgba(217,119,6,0.08)',   color: '#D97706', border: 'rgba(217,119,6,0.2)' },
  'Showing in 2B but Not in Books': { bg: 'rgba(29,78,216,0.08)',   color: '#1D4ED8', border: 'rgba(29,78,216,0.2)' },
  'In GSTR-2B not in Books':        { bg: 'rgba(29,78,216,0.08)',   color: '#1D4ED8', border: 'rgba(29,78,216,0.2)' },
  'Showing in Books but Not in 2B': { bg: 'rgba(225,29,72,0.08)',   color: '#E11D48', border: 'rgba(225,29,72,0.2)' },
  'In Books not in GSTR-2B':        { bg: 'rgba(225,29,72,0.08)',   color: '#E11D48', border: 'rgba(225,29,72,0.2)' },
};

const getCatCfg = (cat = '') => {
  for (const [key, val] of Object.entries(CAT_CFG))
    if ((cat || '').toLowerCase() === key.toLowerCase()) return val;
  return { bg: 'rgba(100,116,139,0.08)', color: '#64748B', border: 'rgba(100,116,139,0.2)' };
};

const isMatched   = (cat) => /^matched$/i.test(cat?.trim() || '');
const isMismatch  = (cat) => /mismatch|partially/i.test(cat || '');
const is2BOnly    = (cat) => /2b.*not.*book|not in book/i.test(cat || '');
const isBooksOnly = (cat) => /book.*not.*2b|not in.*2b|not in gstr/i.test(cat || '');

const fmt = (n) => {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const DiffCell = ({ v }) => {
  if (v == null) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const abs = Math.abs(v);
  const color = abs < 1 ? 'var(--text-muted)' : v > 0 ? '#DC2626' : '#059669';
  return (
    <span style={{ color, fontWeight: abs >= 1 ? 700 : 400, fontFamily: 'monospace', fontSize: 12 }}>
      {fmt(v)}
    </span>
  );
};

// ── Mini file dropzone (per state slot) ──────────────────────────────────────
const MiniDropzone = ({ label, hint, file, onChange, required, stepIndex }) => {
  const inputRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const [hovered, setHovered] = useState(false);
  const active = drag || hovered;

  return (
    <div
      role="button"
      aria-label={`Upload ${label}${required ? ' (required)' : ' (optional)'}`}
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) onChange(f); }}
      style={{
        position: 'relative', overflow: 'hidden',
        padding: '12px 14px', borderRadius: 9, cursor: 'pointer',
        background: file ? 'rgba(5,150,105,0.06)' : active ? 'rgba(124,58,237,0.05)' : 'var(--surface)',
        border: `1px solid ${file ? 'rgba(5,150,105,0.25)' : active ? 'rgba(124,58,237,0.3)' : 'var(--card-border)'}`,
        borderLeft: `2px solid ${file ? '#059669' : active ? COLOR : 'transparent'}`,
        transition: 'all 0.15s ease',
      }}
    >
      {/* Step watermark */}
      <span style={{
        position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
        fontFamily: 'Barlow', fontWeight: 700, fontSize: 28, lineHeight: 1,
        color: file ? 'rgba(5,150,105,0.08)' : 'rgba(0,0,0,0.04)',
        pointerEvents: 'none', userSelect: 'none',
      }}>
        {String(stepIndex + 1).padStart(2, '0')}
      </span>

      <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
        onChange={e => onChange(e.target.files[0])} />

      {file ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6, flexShrink: 0,
            background: 'rgba(5,150,105,0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <FileSpreadsheet style={{ width: 13, height: 13, color: '#059669' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 12, fontWeight: 700, fontFamily: 'Barlow', color: '#059669', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {file.name}
            </p>
            <p style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(5,150,105,0.55)', margin: 0 }}>
              {(file.size / 1024).toFixed(1)} KB · READY
            </p>
          </div>
          <CheckCircle2 style={{ width: 13, height: 13, color: '#059669', flexShrink: 0 }} />
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6, flexShrink: 0,
            background: active ? 'rgba(124,58,237,0.1)' : 'var(--page-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Upload style={{ width: 12, height: 12, color: active ? COLOR : 'var(--text-muted)' }} />
          </div>
          <div>
            <p style={{ fontSize: 12, fontWeight: 700, fontFamily: 'Barlow', color: 'var(--text-heading)', margin: 0 }}>
              {label}{required && <span style={{ color: '#E11D48', marginLeft: 3, fontWeight: 400 }}>*</span>}
            </p>
            <p style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)', margin: 0 }}>{hint}</p>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Month Summary Table ───────────────────────────────────────────────────────
const MonthSummaryTab = ({ rows }) => {
  const thMain = {
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
    padding: '9px 12px', color: '#fff', whiteSpace: 'nowrap', fontFamily: 'DM Sans',
  };
  const tdAmt = { fontSize: 12, padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', whiteSpace: 'nowrap', color: 'var(--text-body)' };
  const tdCnt = { fontSize: 12, padding: '8px 12px', textAlign: 'center', whiteSpace: 'nowrap', color: 'var(--text-body)', fontWeight: 600 };

  const totals = rows.reduce((acc, r) => ({
    g_taxable: acc.g_taxable + r.g_taxable,
    b_taxable: acc.b_taxable + r.b_taxable,
    matched: acc.matched + r.matched,
    only_2b: acc.only_2b + r.only_2b,
    only_bk: acc.only_bk + r.only_bk,
    cross: acc.cross + r.cross,
  }), { g_taxable: 0, b_taxable: 0, matched: 0, only_2b: 0, only_bk: 0, cross: 0 });

  const renderRow = (r, isTotal) => {
    const diff = r.g_taxable - r.b_taxable;
    return (
      <tr key={r.month || 'total'} style={{
        background: isTotal ? 'rgba(29,78,216,0.06)' : undefined,
        borderBottom: '1px solid var(--card-border)',
      }}>
        <td style={{ padding: '8px 12px', fontSize: 12, fontWeight: isTotal ? 800 : 600, fontFamily: 'Barlow', color: isTotal ? '#1D4ED8' : 'var(--text-heading)', whiteSpace: 'nowrap' }}>
          {isTotal ? 'TOTAL' : r.month}
        </td>
        <td style={{ ...tdAmt, fontWeight: isTotal ? 700 : 400 }}>{fmt(r.g_taxable)}</td>
        <td style={{ ...tdAmt, fontWeight: isTotal ? 700 : 400 }}>{fmt(r.b_taxable)}</td>
        <td style={{ ...tdAmt, fontWeight: isTotal ? 700 : 400 }}><DiffCell v={diff} /></td>
        <td style={{ ...tdCnt, color: '#059669' }}>{r.matched.toLocaleString('en-IN')}</td>
        <td style={{ ...tdCnt, color: '#1D4ED8' }}>{r.only_2b.toLocaleString('en-IN')}</td>
        <td style={{ ...tdCnt, color: '#E11D48' }}>{r.only_bk.toLocaleString('en-IN')}</td>
        {r.cross != null && <td style={{ ...tdCnt, color: '#C2410C' }}>{r.cross.toLocaleString('en-IN')}</td>}
      </tr>
    );
  };

  return (
    <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid var(--card-border)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
        <thead>
          <tr>
            <th rowSpan={2} style={{ ...thMain, textAlign: 'left', background: '#1F3864', borderRight: '2px solid #3B5998', padding: '9px 12px' }}>Month</th>
            <th colSpan={3} style={{ ...thMain, background: '#2E75B6', textAlign: 'center' }}>Amount (₹)</th>
            <th colSpan={4} style={{ ...thMain, background: '#1F3864', textAlign: 'center' }}>Invoice Count</th>
          </tr>
          <tr>
            <th style={{ ...thMain, background: '#2E75B6', textAlign: 'right' }}>2B Taxable</th>
            <th style={{ ...thMain, background: '#375623', textAlign: 'right' }}>Books Taxable</th>
            <th style={{ ...thMain, background: '#C45911', textAlign: 'right' }}>Difference</th>
            <th style={{ ...thMain, background: '#059669', textAlign: 'center' }}>Matched</th>
            <th style={{ ...thMain, background: '#1D4ED8', textAlign: 'center' }}>2B Only</th>
            <th style={{ ...thMain, background: '#BE123C', textAlign: 'center' }}>Books Only</th>
            <th style={{ ...thMain, background: '#C2410C', textAlign: 'center' }}>Cross-State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => renderRow({ ...r, cross: r.cross }, false))}
          {renderRow({ ...totals, month: 'TOTAL' }, true)}
        </tbody>
      </table>
    </div>
  );
};

// ── Main Component ────────────────────────────────────────────────────────────
const RecoMultiStateWorkspace = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();

  // Persist the last reco result so navigating to Analytics and back (or a refresh)
  // restores it instead of forcing a full re-run.
  const resultKey = `reco_result_gstr_2b_books_multistate_${brandId}`;

  const [stateSlots, setStateSlots] = useState(
    () => loadSlotsFromStorage(brandId) || Array.from({ length: 4 }, () => ({ gstr2b: null, purchase: null, debit: null }))
  );
  // Books mode. GSTR-2B is always one file per state/GSTIN, but Tally commonly exports
  // a SINGLE Purchase/Debit register covering every state. Feeding that same register
  // into each state slot parsed it once per slot and doubled every Books total, so in
  // combined mode it gets one shared pair of dropzones instead.
  const [combinedBooks, setCombinedBooks] = useState(
    () => localStorage.getItem(combinedKey(brandId)) === 'true'
  );
  const [sharedBooks, setSharedBooks] = useState(
    () => loadSharedFromStorage(brandId) || { purchase: null, debit: null }
  );
  const [tolerance, setTolerance] = useState('1.0');
  const [driveStates, setDriveStates] = useState(null); // [{gstr2b,purchase,debit}] from Drive once confirmed
  const [running, setRunning] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [phase, setPhase] = useState(null); // 'uploading' | 'reconciling' | 'preparing' | null
  const phaseTimer = useRef(null);
  const [result, setResult] = useState(() => {
    try { const c = sessionStorage.getItem(resultKey); return c ? JSON.parse(c) : null; }
    catch { return null; }
  });
  const [downloading, setDownloading] = useState(false);
  const [activeTab, setActiveTab] = useState('All');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

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
        localStorage.setItem(storageKey(brandId), JSON.stringify(serialised));
      } catch {}
    };
    persist();
  }, [stateSlots, brandId]);

  // Same treatment for the combined register so a refresh keeps the chosen mode.
  useEffect(() => {
    localStorage.setItem(combinedKey(brandId), String(combinedBooks));
  }, [combinedBooks, brandId]);

  useEffect(() => {
    (async () => {
      try {
        localStorage.setItem(sharedKey(brandId), JSON.stringify({
          purchase: sharedBooks.purchase ? await fileToB64(sharedBooks.purchase) : null,
          debit:    sharedBooks.debit    ? await fileToB64(sharedBooks.debit)    : null,
        }));
      } catch {}
    })();
  }, [sharedBooks, brandId]);

  // Admin demo: auto-load the 2-state sample set so Anshul can run with one click.
  useEffect(() => {
    if (!isAdminUser()) return;
    let cancelled = false;
    (async () => {
      try {
        const slots = await Promise.all(MULTISTATE_SAMPLE.map(async (s, i) => ({
          gstr2b:   await urlToFile(s.gstr2b,   `State${i + 1}_GSTR2B.xlsx`),
          purchase: await urlToFile(s.purchase, `State${i + 1}_Purchase.xlsx`),
          debit:    await urlToFile(s.debit,    `State${i + 1}_DebitNote.xlsx`),
        })));
        if (!cancelled) { setStateSlots(slots); toast.success('Sample files loaded — click Run Reconciliation'); }
      } catch (_) { /* skip on failure */ }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`,    label: 'All Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  const addState    = () => setStateSlots(prev => [...prev, { gstr2b: null, purchase: null, debit: null }]);
  const removeState = (idx) => setStateSlots(prev => prev.filter((_, i) => i !== idx));
  const setSlotFile = (slotIdx, fieldKey, file) => setStateSlots(prev => {
    const next = [...prev];
    next[slotIdx] = { ...next[slotIdx], [fieldKey]: file };
    return next;
  });

  const handleRun = async () => {
    const useDrive = !!(driveStates && driveStates.length > 0);
    if (!useDrive) {
      if (combinedBooks) {
        if (stateSlots.some(s => !s.gstr2b)) {
          toast.error('Each state needs its own GSTR-2B file.'); return;
        }
        if (!sharedBooks.purchase) {
          toast.error('Add the combined Purchase Register that covers all states.'); return;
        }
      } else if (stateSlots.some(s => !s.gstr2b || !s.purchase)) {
        toast.error('Each state needs a GSTR-2B file and a Purchase Register.'); return;
      }
    }
    setRunning(true); setResult(null); setActiveTab('All'); setSearch(''); setPage(0); setUploadProgress(0);
    setPhase('uploading');
    try {
      const formData = new FormData();
      formData.append('reco_type', 'gstr_2b_books_multistate');
      formData.append('tolerance', tolerance);
      formData.append('brand_id', brandId);
      formData.append('is_demo', localStorage.getItem('token') === 'demo-mode-token' ? 'true' : 'false');
      if (useDrive) {
        // Files come from Drive, grouped per state — backend downloads via the SA.
        formData.append('drive_states', JSON.stringify(driveStates));
      } else if (combinedBooks) {
        // One register for every state: 2B still goes per state, Books goes ONCE.
        // The engine is told so it can skip the per-state cross-state remarks, which
        // compare Books file numbers that a shared register does not have.
        formData.append('books_combined', 'true');
        for (const slot of stateSlots) {
          if (slot.gstr2b) formData.append('gstr2b', slot.gstr2b);
        }
        formData.append('purchase', sharedBooks.purchase);
        if (sharedBooks.debit) formData.append('debit', sharedBooks.debit);
        else                   formData.append('debit', new Blob([]), 'empty.xlsx');
      } else {
        for (const slot of stateSlots) {
          if (slot.gstr2b)   formData.append('gstr2b',   slot.gstr2b);
          if (slot.purchase) formData.append('purchase', slot.purchase);
          if (slot.debit)    formData.append('debit',    slot.debit);
          else               formData.append('debit',    new Blob([]), 'empty.xlsx');
        }
      }
      const response = await api.post('/api/reco/run', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (evt) => {
          if (evt.total) {
            const pct = Math.round((evt.loaded / evt.total) * 100);
            setUploadProgress(pct);
            if (pct >= 100) {
              // Upload finished — server now reconciles, then builds the Excel
              // (the long tail). Advance the status so the user knows why it waits.
              setPhase('reconciling');
              clearTimeout(phaseTimer.current);
              phaseTimer.current = setTimeout(() => setPhase('preparing'), 5000);
            }
          }
        },
      });
      clearTimeout(phaseTimer.current);
      setUploadProgress(null);
      setPhase('done');
      setResult(response.data);
      try { sessionStorage.setItem(resultKey, JSON.stringify(slimResultForCache(response.data))); } catch (_) {}
      toast.success(`Done! ${response.data.results?.length || 0} records processed.`);
    } catch (err) {
      clearTimeout(phaseTimer.current);
      setUploadProgress(null);
      setPhase(null);
      toast.error(err.response?.data?.error || 'Reconciliation failed');
    } finally { setRunning(false); }
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

  const handleReset = async () => {
    // Multi-State persists row-level results — purge this run from the brand DB.
    if (result?.job_id && brandId && brandId !== 'other' && brandId !== 'demo') {
      try { await api.delete(`/api/reco/job/${brandId}/${result.job_id}`); } catch (_) {}
    }
    try { sessionStorage.removeItem(resultKey); } catch (_) {}
    setResult(null); setActiveTab('All'); setSearch(''); setPage(0);
  };

  const handleClearFiles = () => {
    if (!window.confirm('Clear all uploaded state files? This cannot be undone.')) return;
    localStorage.removeItem(storageKey(brandId));
    localStorage.removeItem(sharedKey(brandId));
    try { sessionStorage.removeItem(resultKey); } catch (_) {}
    setStateSlots(Array.from({ length: 4 }, () => ({ gstr2b: null, purchase: null, debit: null })));
    setSharedBooks({ purchase: null, debit: null });
    setResult(null);
    toast.success('All files cleared');
  };

  // ── Derived data ─────────────────────────────────────────────────────────────
  const flatRows = useMemo(() => (result?.results || []).map(row => {
    const g = row.gstr2b   || null;
    const b = row.purchase || null;
    const inv = g || b || {};
    const g_tax = g?.taxable_value ?? null;
    const b_tax = b?.taxable_value ?? null;
    const diff  = (g_tax != null && b_tax != null) ? g_tax - b_tax : null;
    return {
      category:   row.category || '—',
      supplier:   inv.supplier_name  || '—',
      gstin:      inv.supplier_gstin || '—',
      invoice_no: inv.doc_no         || '—',
      date:       inv.doc_date       || '—',
      g_tax, b_tax, diff,
      remark_1: row.suggested_action   || '—',
      remark_2: row.suggested_action_2 || '',
      remark_3: row.suggested_action_3 || '',
    };
  }), [result]);

  const totals = useMemo(() => {
    let matched = 0, mismatch = 0, only2b = 0, onlyBk = 0, cross = 0;
    for (const r of flatRows) {
      if (isMatched(r.category))        matched++;
      else if (isMismatch(r.category))  mismatch++;
      else if (is2BOnly(r.category))    only2b++;
      else if (isBooksOnly(r.category)) onlyBk++;
      if (r.remark_3) cross++;
    }
    return { matched, mismatch, only2b, onlyBk, cross, total: flatRows.length };
  }, [flatRows]);

  // Status donut = full remark_1 distribution (incl. Matched).
  const donutData = useMemo(() => {
    const m = {};
    for (const r of flatRows) { const k = r.remark_1 || '—'; m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).map(([name, value]) => ({ name, value }));
  }, [flatRows]);

  // "By reason" = secondary observations (Remark 2: tax/value mismatch, Excess in
  // 2B vs Books…) + cross-state reasons (Remark 3).
  const reasonsData = useMemo(
    () => [...distOf(flatRows, (r) => r.remark_2), ...distOf(flatRows, (r) => r.remark_3)],
    [flatRows],
  );

  const [fbOpen, setFbOpen] = useState(false);
  const handleSendFeedback = async ({ comment, rows }) => {
    try {
      await api.post('/api/feedback', {
        agentType: 'gstr_2b_books_multistate',
        agentLabel: 'GSTR-2B vs Books (Multi-State)',
        brandId, jobId: result?.job_id, comment, rows,
      });
      toast.success('Feedback sent — the engineering team has been notified');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not send feedback');
      throw e;
    }
  };

  const monthSummary = useMemo(() => {
    const months = {};
    for (const row of result?.results || []) {
      const g = row.gstr2b   || null;
      const b = row.purchase || null;
      const raw = (String(g?.doc_date || '') || String(b?.doc_date || '')).slice(0, 7);
      let month = raw;
      try {
        const yr = parseInt(raw.slice(0, 4));
        const mn = parseInt(raw.slice(5, 7));
        if (!raw || raw.length < 7 || !(2000 <= yr && yr <= 2099) || !(1 <= mn && mn <= 12)) month = null;
      } catch { month = null; }
      if (!month) continue;
      if (!months[month]) months[month] = { month, g_taxable: 0, b_taxable: 0, matched: 0, only_2b: 0, only_bk: 0, cross: 0 };
      const m = months[month];
      if (g) m.g_taxable += g.taxable_value || 0;
      if (b) m.b_taxable += b.taxable_value || 0;
      const cat = row.category || '';
      if (isMatched(cat))        m.matched++;
      else if (is2BOnly(cat))    m.only_2b++;
      else if (isBooksOnly(cat)) m.only_bk++;
      if (row.suggested_action_3) m.cross++;
    }
    return Object.values(months).sort((a, z) => a.month.localeCompare(z.month));
  }, [result]);

  const showMonthTab = monthSummary.length >= 2;

  const TABS = useMemo(() => [
    { key: 'All',       label: 'All Records',    count: totals.total   },
    { key: 'Matched',   label: 'Matched',        count: totals.matched },
    { key: 'Mismatch',  label: 'Mismatch',       count: totals.mismatch },
    { key: '2B Only',   label: 'In 2B Not Books', count: totals.only2b },
    { key: 'Books Only',label: 'In Books Not 2B', count: totals.onlyBk },
    { key: 'Cross',     label: 'Cross-State',    count: totals.cross   },
    ...(showMonthTab ? [{ key: 'Month', label: 'Month Summary', count: null }] : []),
  ], [totals, showMonthTab]);

  const tabFilter = (r) => {
    switch (activeTab) {
      case 'Matched':    return isMatched(r.category);
      case 'Mismatch':   return isMismatch(r.category);
      case '2B Only':    return is2BOnly(r.category);
      case 'Books Only': return isBooksOnly(r.category);
      case 'Cross':      return !!r.remark_3;
      default:           return true;
    }
  };

  const filtered = useMemo(() => {
    if (activeTab === 'Month') return [];
    let rows = flatRows.filter(tabFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(r =>
        r.invoice_no.toLowerCase().includes(q) ||
        r.supplier.toLowerCase().includes(q)   ||
        r.gstin.toLowerCase().includes(q)
      );
    }
    return rows;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatRows, activeTab, search]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged      = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const switchTab  = (key) => { setActiveTab(key); setPage(0); };
  const onSearch   = (v)   => { setSearch(v); setPage(0); };

  // table style helpers
  const thStyle = {
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
    padding: '9px 12px', textAlign: 'right', color: 'var(--text-muted)',
    background: 'var(--page-bg)', whiteSpace: 'nowrap', borderBottom: '1.5px solid var(--card-border)',
    fontFamily: 'DM Sans',
  };
  const tdAmt  = { fontSize: 12, padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', whiteSpace: 'nowrap', color: 'var(--text-body)' };
  const tdText = { fontSize: 12, padding: '8px 12px', textAlign: 'left', color: 'var(--text-body)', whiteSpace: 'nowrap' };

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div style={{ padding: '24px 28px', maxWidth: 1200 }}>

        {/* Breadcrumb */}
        <button
          onClick={() => navigate(isAdminUser() ? '/admin/agents' : `/brands/${brandId}/agents`)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 13, color: 'var(--text-muted)', background: 'none',
            border: 'none', cursor: 'pointer', marginBottom: 24, padding: 0,
            transition: 'color 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.color = COLOR}
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
          border: '1px solid var(--card-border)',
          borderTop: `3px solid ${COLOR}`,
          padding: '24px 28px',
          marginBottom: 28,
          boxShadow: `0 4px 32px ${COLOR}12`,
        }}>
          {/* Watermark */}
          <div style={{ position: 'absolute', right: -8, bottom: -12, opacity: 0.04, pointerEvents: 'none' }}>
            <Layers style={{ width: 140, height: 140, color: COLOR }} />
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              {/* Icon badge */}
              <div style={{
                width: 52, height: 52, borderRadius: 12, flexShrink: 0,
                background: 'rgba(124,58,237,0.08)',
                border: '1.5px solid rgba(124,58,237,0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: `0 4px 16px ${COLOR}20`,
              }}>
                <Layers style={{ width: 24, height: 24, color: COLOR }} />
              </div>

              <div>
                <p style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                  color: COLOR, fontFamily: 'monospace', marginBottom: 4, opacity: 0.85,
                }}>
                  GSTR-2B · BOOKS · MULTI-STATE
                </p>
                <h1 style={{
                  fontFamily: 'Barlow', fontWeight: 900, fontSize: 26,
                  color: 'var(--text-heading)', letterSpacing: '-0.02em',
                  lineHeight: 1.1, margin: 0, marginBottom: 6,
                }}>
                  GSTR-2B vs Books (Multi-State)
                </h1>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: 520, margin: 0 }}>
                  Upload one set of files per state registration. The engine reconciles all states together
                  and flags cross-state booking errors in <strong style={{ color: '#C2410C' }}>Remark 3</strong>.
                </p>
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {result && (
                <button onClick={handleReset} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                  background: 'var(--page-bg)', border: '1px solid var(--card-border)',
                  color: 'var(--text-muted)', cursor: 'pointer',
                }}>
                  <RotateCcw style={{ width: 13, height: 13 }} /> Reset
                </button>
              )}
              <button onClick={handleClearFiles} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                background: 'rgba(225,29,72,0.06)', border: '1px solid rgba(225,29,72,0.2)',
                color: '#E11D48', cursor: 'pointer',
              }}>
                <Trash2 style={{ width: 13, height: 13 }} /> Clear Files
              </button>
            </div>
          </div>
        </div>

        {/* ── Upload Panel ─────────────────────────────────────────────── */}
        {!result && (
          <>
            {/* Info banner */}
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 12,
              padding: '14px 18px', borderRadius: 10, marginBottom: 20,
              background: 'rgba(124,58,237,0.06)', border: '1px solid rgba(124,58,237,0.2)',
            }}>
              <MapPin style={{ width: 16, height: 16, color: COLOR, flexShrink: 0, marginTop: 1 }} />
              <div>
                <p style={{ fontSize: 13, fontWeight: 700, fontFamily: 'Barlow', color: COLOR, margin: 0, marginBottom: 3 }}>
                  Multi-State Mode
                </p>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55, margin: 0 }}>
                  Add one row per state/GSTIN. All files are merged and reconciled together.
                  If an invoice appears "missing" but belongs to another state's file,{' '}
                  <strong style={{ color: '#C2410C' }}>Remark 3</strong> will explain why.
                </p>
              </div>
            </div>

            {/* ── Books mode switch ──────────────────────────────────────────
                GSTR-2B is always per state. The Purchase / Debit registers may be
                one combined export covering every state — uploading that into each
                state slot double-counted it, so it gets a single shared card. */}
            <div className="glass-card" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 16, padding: '13px 18px', marginBottom: 20,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <Layers style={{ width: 15, height: 15, color: COLOR, flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <p style={{
                    fontSize: 13, fontWeight: 700, fontFamily: 'Barlow',
                    color: 'var(--text-heading)', margin: 0, marginBottom: 2,
                  }}>
                    Combined Purchase / Debit Register
                  </p>
                  <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                    {combinedBooks
                      ? 'One register covers every state — upload it once. GSTR-2B stays per state.'
                      : 'Each state has its own register. Turn on if one Tally export covers all states.'}
                  </p>
                </div>
              </div>

              {/* Track + knob. Whole control is the button so the label is clickable. */}
              <button
                role="switch"
                aria-checked={combinedBooks}
                aria-label="Combined Purchase and Debit Register for all states"
                data-testid="toggle-combined-books"
                onClick={() => setCombinedBooks(v => !v)}
                style={{
                  position: 'relative', flexShrink: 0,
                  width: 46, height: 26, borderRadius: 999, padding: 0, cursor: 'pointer',
                  background: combinedBooks ? COLOR : 'var(--card-border)',
                  border: `1px solid ${combinedBooks ? COLOR : 'var(--card-border)'}`,
                  transition: 'background 0.28s cubic-bezier(0.4,0,0.2,1), border-color 0.28s',
                }}
              >
                <span style={{
                  position: 'absolute', top: 2, left: 2,
                  width: 20, height: 20, borderRadius: '50%', background: '#fff',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                  transform: combinedBooks ? 'translateX(20px)' : 'translateX(0)',
                  transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
                }} />
              </button>
            </div>

            {/* Shared register — collapses/expands with the switch */}
            <div style={{
              overflow: 'hidden',
              maxHeight: combinedBooks ? 240 : 0,
              opacity: combinedBooks ? 1 : 0,
              transform: combinedBooks ? 'translateY(0)' : 'translateY(-6px)',
              marginBottom: combinedBooks ? 20 : 0,
              transition: 'max-height 0.32s cubic-bezier(0.4,0,0.2,1), opacity 0.24s ease, transform 0.28s ease, margin-bottom 0.32s',
            }}>
              <div className="glass-card" style={{ padding: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: 6, flexShrink: 0,
                    background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Layers style={{ width: 13, height: 13, color: COLOR }} />
                  </div>
                  <h3 style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0 }}>
                    Books — All States
                  </h3>
                  {sharedBooks.purchase && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                      background: 'rgba(5,150,105,0.08)', color: '#059669',
                      border: '1px solid rgba(5,150,105,0.2)', fontFamily: 'DM Sans',
                    }}>READY</span>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                  <MiniDropzone label="Purchase Register" hint=".xlsx / .xls" required stepIndex={1}
                    file={sharedBooks.purchase} onChange={f => setSharedBooks(p => ({ ...p, purchase: f }))} />
                  <MiniDropzone label="Debit Note Register" hint=".xlsx (optional)" stepIndex={2}
                    file={sharedBooks.debit} onChange={f => setSharedBooks(p => ({ ...p, debit: f }))} />
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 20, marginBottom: 28 }}>

              {/* State slots */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {stateSlots.map((slot, idx) => (
                  <div key={idx} className="glass-card" style={{ padding: 18 }}>
                    {/* Slot header */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{
                          width: 26, height: 26, borderRadius: 6, flexShrink: 0,
                          background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.2)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 11, fontWeight: 800, fontFamily: 'Barlow', color: COLOR,
                        }}>
                          {idx + 1}
                        </div>
                        <h3 style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0 }}>
                          State {idx + 1}
                        </h3>
                        {slot.gstr2b && (combinedBooks ? sharedBooks.purchase : slot.purchase) && (
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                            background: 'rgba(5,150,105,0.08)', color: '#059669',
                            border: '1px solid rgba(5,150,105,0.2)', fontFamily: 'DM Sans',
                          }}>READY</span>
                        )}
                      </div>
                      {stateSlots.length > 1 && (
                        <button onClick={() => removeState(idx)} style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          padding: '4px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                          background: 'rgba(225,29,72,0.06)', border: '1px solid rgba(225,29,72,0.2)',
                          color: '#E11D48', cursor: 'pointer', fontFamily: 'Barlow',
                        }}>
                          <X style={{ width: 10, height: 10 }} /> Remove
                        </button>
                      )}
                    </div>

                    {/* File dropzones. In combined mode only GSTR-2B stays per state —
                        the columns animate from three to one as the switch flips. */}
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: combinedBooks ? '1fr 0fr 0fr' : '1fr 1fr 1fr',
                      gap: combinedBooks ? 0 : 10,
                      transition: 'grid-template-columns 0.32s cubic-bezier(0.4,0,0.2,1), gap 0.32s',
                    }}>
                      <MiniDropzone label="GSTR-2B" hint=".xlsx / .xls" required stepIndex={0}
                        file={slot.gstr2b} onChange={f => setSlotFile(idx, 'gstr2b', f)} />
                      <div style={{
                        overflow: 'hidden', minWidth: 0,
                        opacity: combinedBooks ? 0 : 1,
                        pointerEvents: combinedBooks ? 'none' : 'auto',
                        transition: 'opacity 0.2s ease',
                      }} aria-hidden={combinedBooks}>
                        <MiniDropzone label="Purchase Register" hint=".xlsx / .xls" required stepIndex={1}
                          file={slot.purchase} onChange={f => setSlotFile(idx, 'purchase', f)} />
                      </div>
                      <div style={{
                        overflow: 'hidden', minWidth: 0,
                        opacity: combinedBooks ? 0 : 1,
                        pointerEvents: combinedBooks ? 'none' : 'auto',
                        transition: 'opacity 0.2s ease',
                      }} aria-hidden={combinedBooks}>
                        <MiniDropzone label="Debit Note Register" hint=".xlsx (optional)" stepIndex={2}
                          file={slot.debit} onChange={f => setSlotFile(idx, 'debit', f)} />
                      </div>
                    </div>
                  </div>
                ))}

                {/* Add state button */}
                <button onClick={addState} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  padding: '12px 0', borderRadius: 10, fontSize: 13, fontWeight: 700,
                  background: 'rgba(124,58,237,0.04)', border: '1.5px dashed rgba(124,58,237,0.25)',
                  color: COLOR, cursor: 'pointer', fontFamily: 'Barlow',
                  transition: 'all 0.15s',
                }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(124,58,237,0.08)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'rgba(124,58,237,0.04)'}
                >
                  <Plus style={{ width: 15, height: 15 }} />
                  Add Another State
                </button>

                {/* From Google Drive — one folder, grouped per state by GSTIN code */}
                <DriveMultiState onConfirmed={setDriveStates} />
              </div>

              {/* Config + Run */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

                {/* Config */}
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
                    ? phase === 'uploading'
                      ? <><Upload style={{ width: 15, height: 15 }} /> Uploading {uploadProgress ?? 0}%</>
                      : <><Loader2 style={{ width: 15, height: 15 }} className="animate-spin" /> {
                          phase === 'reconciling' ? 'Reconciling…'
                          : phase === 'preparing' ? 'Preparing Excel…'
                          : 'Processing…'
                        }</>
                    : <><Zap style={{ width: 15, height: 15 }} /> Run Reconciliation</>
                  }
                </button>

                {/* Progress bar */}
                {running && uploadProgress !== null && (
                  <div style={{ borderRadius: 4, overflow: 'hidden', background: 'var(--page-bg)', height: 3 }}>
                    <div style={{
                      height: '100%', width: `${uploadProgress}%`,
                      background: uploadProgress < 100 ? COLOR : '#059669',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                )}

                {/* Phased progress — tells the user which stage is running and why
                    a large multi-state job takes time (Excel is prepared up-front). */}
                {running && (() => {
                  const order = ['uploading', 'reconciling', 'preparing'];
                  const steps = [
                    { key: 'uploading',   label: 'Uploading files' },
                    { key: 'reconciling', label: 'Running reconciliation' },
                    { key: 'preparing',   label: 'Preparing Excel for download' },
                  ];
                  const cur = order.indexOf(phase);
                  return (
                    <div className="glass-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
                      {steps.map((s, i) => {
                        const done = cur > i, active = cur === i;
                        return (
                          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                            {done
                              ? <CheckCircle2 style={{ width: 15, height: 15, color: '#059669', flexShrink: 0 }} />
                              : active
                                ? <Loader2 style={{ width: 15, height: 15, color: COLOR, flexShrink: 0 }} className="animate-spin" />
                                : <div style={{ width: 13, height: 13, margin: 1, borderRadius: '50%', border: '2px solid var(--border)', flexShrink: 0 }} />}
                            <span style={{
                              fontSize: 12.5, fontFamily: 'Barlow',
                              fontWeight: active ? 700 : 600,
                              color: done ? '#059669' : active ? 'var(--text-body)' : 'var(--text-muted)',
                            }}>{s.label}{active && '…'}</span>
                          </div>
                        );
                      })}
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'DM Sans', margin: '2px 0 0', lineHeight: 1.4 }}>
                        Large multi-state files can take a minute — the Excel is built now so your download is instant.
                      </p>
                    </div>
                  );
                })()}

                {/* States status panel */}
                <div className="glass-card" style={{ padding: 16 }}>
                  <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-muted)', fontFamily: 'DM Sans', marginBottom: 10 }}>
                    States Loaded — {stateSlots.length}
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {stateSlots.map((slot, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-body)', fontFamily: 'Barlow', fontWeight: 600 }}>
                          State {idx + 1}
                        </span>
                        <span style={{
                          fontSize: 11, fontWeight: 700, fontFamily: 'monospace',
                          color: slot.gstr2b && slot.purchase ? '#059669' : '#E11D48',
                        }}>
                          {slot.gstr2b && slot.purchase ? '✓ READY' : 'MISSING'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── Results ─────────────────────────────────────────────────── */}
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* Stat cards — left-bordered flat design */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
              {[
                { label: 'Matched',         count: totals.matched,  color: '#059669', tabKey: 'Matched'    },
                { label: 'Amount Mismatch', count: totals.mismatch, color: '#D97706', tabKey: 'Mismatch'   },
                { label: 'In 2B Not Books', count: totals.only2b,   color: '#1D4ED8', tabKey: '2B Only'    },
                { label: 'In Books Not 2B', count: totals.onlyBk,   color: '#E11D48', tabKey: 'Books Only' },
                { label: 'Cross-State',     count: totals.cross,    color: '#C2410C', tabKey: 'Cross'      },
                { label: 'Total Records',   count: totals.total,    color: COLOR,     tabKey: 'All'        },
              ].map(c => (
                <button key={c.label} onClick={() => switchTab(c.tabKey)} style={{
                  background: activeTab === c.tabKey ? `${c.color}08` : 'var(--surface)',
                  border: `1px solid ${activeTab === c.tabKey ? `${c.color}30` : 'var(--card-border)'}`,
                  borderLeft: `4px solid ${c.color}`,
                  borderRadius: 10, padding: '14px 16px', textAlign: 'left', cursor: 'pointer',
                  transition: 'all 0.18s ease',
                  boxShadow: activeTab === c.tabKey ? `0 4px 16px ${c.color}15` : 'none',
                }}>
                  <p style={{ fontSize: 10, fontWeight: 700, color: c.color, textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'DM Sans', margin: '0 0 6px' }}>
                    {c.label}
                  </p>
                  <p style={{ fontSize: 34, fontWeight: 900, fontFamily: 'Barlow', lineHeight: 1, color: 'var(--text-heading)', margin: 0 }}>
                    {c.count.toLocaleString('en-IN')}
                  </p>
                </button>
              ))}
            </div>

            {/* Cross-state alert */}
            {totals.cross > 0 && (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: 12,
                padding: '14px 18px', borderRadius: 10,
                background: 'rgba(194,65,12,0.06)', border: '1px solid rgba(194,65,12,0.2)',
                borderLeft: '3px solid #C2410C',
              }}>
                <MapPin style={{ width: 16, height: 16, color: '#C2410C', flexShrink: 0, marginTop: 1 }} />
                <div>
                  <p style={{ fontSize: 13, fontWeight: 800, fontFamily: 'Barlow', color: '#C2410C', margin: 0, marginBottom: 3 }}>
                    {totals.cross} cross-state booking {totals.cross === 1 ? 'issue' : 'issues'} detected
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                    See Remark 3 below — invoice booked in a different state's books than the GSTR-2B file it appeared in.
                  </p>
                </div>
              </div>
            )}

            {/* Analysis charts — status donut + issues by reason (same as other agents) */}
            {flatRows.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
                <StatusDonut data={donutData} />
                {reasonsData.length > 0 && <ByReasons title="Issues by Reason" data={reasonsData} />}
              </div>
            )}

            {/* Tab bar */}
            <div style={{ borderBottom: '2px solid var(--card-border)', display: 'flex', gap: 0, overflowX: 'auto' }}>
              {TABS.map(tab => {
                const active = activeTab === tab.key;
                return (
                  <button key={tab.key} onClick={() => switchTab(tab.key)} style={{
                    padding: '9px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    border: 'none', outline: 'none', background: 'transparent',
                    borderBottom: active ? `3px solid ${COLOR}` : '3px solid transparent',
                    color: active ? COLOR : 'var(--text-muted)',
                    marginBottom: -2, whiteSpace: 'nowrap', transition: 'all 0.15s',
                    fontFamily: 'Barlow',
                  }}>
                    {tab.label}
                    {tab.count != null && tab.count > 0 && (
                      <span style={{
                        marginLeft: 6, fontSize: 10, fontWeight: 800,
                        background: active ? `${COLOR}15` : 'var(--page-bg)',
                        color: active ? COLOR : 'var(--text-muted)',
                        padding: '1px 6px', borderRadius: 4, fontFamily: 'DM Sans',
                      }}>
                        {tab.count.toLocaleString('en-IN')}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Month Summary */}
            {activeTab === 'Month' && <MonthSummaryTab rows={monthSummary} />}

            {/* Records */}
            {activeTab !== 'Month' && (
              <>
                {/* Search + actions */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ position: 'relative' }}>
                    <Search style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 13, color: 'var(--text-muted)' }} />
                    <input
                      value={search} onChange={e => onSearch(e.target.value)}
                      placeholder="Search invoice / supplier / GSTIN…"
                      style={{
                        paddingLeft: 30, paddingRight: 14, paddingTop: 8, paddingBottom: 8,
                        fontSize: 12, borderRadius: 9, border: '1px solid var(--card-border)',
                        outline: 'none', width: 280,
                        background: 'var(--surface)', color: 'var(--text-body)',
                      }}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={() => setFbOpen(true)} style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                      borderRadius: 8, fontSize: 12, fontWeight: 700,
                      background: '#fff', border: '1.5px solid #A3BFF8',
                      color: '#0748EE', cursor: 'pointer', fontFamily: 'Barlow',
                    }}>
                      🚩 Flag / Feedback
                    </button>
                    <button onClick={handleDownload} disabled={downloading} style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                      borderRadius: 8, fontSize: 12, fontWeight: 700,
                      background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)',
                      color: COLOR, cursor: 'pointer', opacity: downloading ? 0.6 : 1,
                      fontFamily: 'Barlow',
                    }}>
                      {downloading ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Download style={{ width: 13, height: 13 }} />}
                      Download Excel
                    </button>
                    <OpenInSheetsButton jobId={result?.job_id} name="GSTR-2B vs Books Multi-State" style={{ padding: '8px 14px', fontSize: 12 }} />
                    <button
                      onClick={() => navigate(`/brands/${brandId}/reco/gstr_2b_books_multistate/results/${result?.job_id}`)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                        borderRadius: 8, fontSize: 12, fontWeight: 700,
                        background: COLOR, color: '#fff', border: 'none', cursor: 'pointer',
                        fontFamily: 'Barlow',
                      }}
                    >
                      <BarChart3 style={{ width: 13, height: 13 }} />
                      View Analytics
                      <ArrowRight style={{ width: 12, height: 12 }} />
                    </button>
                  </div>
                </div>

                {/* Results table */}
                <div className="glass-card" style={{ overflow: 'hidden' }}>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1100 }}>
                      <thead>
                        {/* Group row */}
                        <tr>
                          <th colSpan={5} style={{ ...thStyle, textAlign: 'left', borderRight: '2px solid var(--card-border)' }}>Invoice Details</th>
                          <th style={{ ...thStyle, background: 'rgba(29,78,216,0.06)', textAlign: 'center' }}>2B Taxable</th>
                          <th style={{ ...thStyle, background: 'rgba(5,150,105,0.06)', textAlign: 'center', borderRight: '1px solid var(--card-border)' }}>Books Taxable</th>
                          <th style={{ ...thStyle, background: 'rgba(194,65,12,0.06)', textAlign: 'center', borderRight: '2px solid var(--card-border)' }}>Difference</th>
                          <th colSpan={3} style={{ ...thStyle, textAlign: 'center' }}>Remarks</th>
                        </tr>
                        {/* Column row */}
                        <tr>
                          <th style={{ ...thStyle, textAlign: 'left' }}>Category</th>
                          <th style={{ ...thStyle, textAlign: 'left' }}>Supplier</th>
                          <th style={{ ...thStyle, textAlign: 'left' }}>GSTIN</th>
                          <th style={{ ...thStyle, textAlign: 'left' }}>Invoice No</th>
                          <th style={{ ...thStyle, textAlign: 'left', borderRight: '2px solid var(--card-border)' }}>Date</th>
                          <th style={{ ...thStyle, background: 'rgba(29,78,216,0.06)' }}>2B (₹)</th>
                          <th style={{ ...thStyle, background: 'rgba(5,150,105,0.06)', borderRight: '1px solid var(--card-border)' }}>Books (₹)</th>
                          <th style={{ ...thStyle, background: 'rgba(194,65,12,0.06)', borderRight: '2px solid var(--card-border)' }}>Diff (₹)</th>
                          <th style={{ ...thStyle, textAlign: 'left' }}>Remark 1</th>
                          <th style={{ ...thStyle, textAlign: 'left' }}>Remark 2</th>
                          <th style={{ ...thStyle, textAlign: 'left', color: '#C2410C' }}>Remark 3</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paged.map((row, i) => {
                          const cfg = getCatCfg(row.category);
                          return (
                            <tr key={i} style={{ borderBottom: '1px solid var(--card-border)' }}>
                              <td style={{ ...tdText }}>
                                <span style={{
                                  display: 'inline-flex', alignItems: 'center',
                                  fontSize: 10, padding: '2px 7px', borderRadius: 4,
                                  fontWeight: 700, whiteSpace: 'nowrap', fontFamily: 'DM Sans',
                                  background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
                                }}>
                                  {row.category}
                                </span>
                              </td>
                              <td style={{ ...tdText, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.supplier}</td>
                              <td style={{ ...tdText, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)' }}>{row.gstin}</td>
                              <td style={{ ...tdText, fontFamily: 'monospace', fontSize: 11 }}>{row.invoice_no}</td>
                              <td style={{ ...tdText, color: 'var(--text-muted)', borderRight: '2px solid var(--card-border)' }}>{row.date}</td>
                              <td style={{ ...tdAmt }}>{fmt(row.g_tax)}</td>
                              <td style={{ ...tdAmt, borderRight: '1px solid var(--card-border)' }}>{fmt(row.b_tax)}</td>
                              <td style={{ ...tdAmt, borderRight: '2px solid var(--card-border)' }}><DiffCell v={row.diff} /></td>
                              <td style={{ ...tdText, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11 }}>
                                {row.remark_1 !== '—' ? (
                                  <span style={{ color: cfg.color, fontWeight: 600 }}>{row.remark_1}</span>
                                ) : '—'}
                              </td>
                              <td style={{ ...tdText, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11, color: 'var(--text-muted)', fontStyle: row.remark_2 ? 'italic' : 'normal' }}>
                                {row.remark_2 || '—'}
                              </td>
                              <td style={{ ...tdText, maxWidth: 200, fontSize: 11, fontWeight: row.remark_3 ? 700 : 400, color: row.remark_3 ? '#C2410C' : 'var(--text-muted)' }}>
                                {row.remark_3 || '—'}
                              </td>
                            </tr>
                          );
                        })}
                        {paged.length === 0 && (
                          <tr>
                            <td colSpan={11} style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                              {search ? 'No records match your search' : 'No records in this category'}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                      {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length.toLocaleString('en-IN')}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={{
                        padding: '6px 10px', borderRadius: 7, border: '1px solid var(--card-border)',
                        background: 'var(--surface)', cursor: page === 0 ? 'not-allowed' : 'pointer',
                        opacity: page === 0 ? 0.4 : 1,
                      }}>
                        <ChevronLeft style={{ width: 13, color: 'var(--text-muted)' }} />
                      </button>
                      {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                        const pg = totalPages <= 7 ? i : (page < 4 ? i : page > totalPages - 5 ? totalPages - 7 + i : page - 3 + i);
                        return (
                          <button key={pg} onClick={() => setPage(pg)} style={{
                            width: 32, height: 32, borderRadius: 7, fontSize: 12, fontWeight: 700,
                            cursor: 'pointer', fontFamily: 'Barlow',
                            border: `1px solid ${pg === page ? COLOR : 'var(--card-border)'}`,
                            background: pg === page ? COLOR : 'var(--surface)',
                            color: pg === page ? '#fff' : 'var(--text-muted)',
                          }}>
                            {pg + 1}
                          </button>
                        );
                      })}
                      <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={{
                        padding: '6px 10px', borderRadius: 7, border: '1px solid var(--card-border)',
                        background: 'var(--surface)', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer',
                        opacity: page >= totalPages - 1 ? 0.4 : 1,
                      }}>
                        <ChevronRight style={{ width: 13, color: 'var(--text-muted)' }} />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {fbOpen && (
              <FeedbackModal
                kind="2b"
                rows={flatRows.map((r) => ({ ...r, taxable_value: r.g_tax ?? r.b_tax }))}
                agentLabel="GSTR-2B vs Books (Multi-State)"
                onClose={() => setFbOpen(false)}
                onSend={handleSendFeedback}
              />
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default RecoMultiStateWorkspace;

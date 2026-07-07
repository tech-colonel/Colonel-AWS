import React, { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  BookOpen, LayoutDashboard, Bot, ArrowLeft, Upload, Download, Zap,
  RotateCcw, CheckCircle2, FileSpreadsheet, Loader2, Database, X, BarChart3,
} from 'lucide-react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { sidebarFor, isAdminUser } from '../../lib/adminNav';
import api from '../../lib/api';
import { toast } from 'sonner';

const AGENT_COLOR  = '#0F766E';
const AGENT_BG     = 'rgba(15,118,110,0.08)';
const AGENT_BORDER = 'rgba(15,118,110,0.2)';

const fmt = (n) =>
  typeof n === 'number'
    ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';

// ── Multi-file dropzone (GSTR-3B PDFs) ────────────────────────────────────────
const MultiFileDropzone = ({ fileConfig, files, onChange, disabled, stepIndex }) => {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const maxFiles = fileConfig.maxFiles || 15;
  const list = files || [];
  const active = !disabled && (dragging || hovered);
  const stepNum = String(stepIndex + 1).padStart(2, '0');

  const addFiles = (newFiles) => {
    const combined = [...list, ...Array.from(newFiles)].slice(0, maxFiles);
    onChange(combined);
  };
  const removeFile = (e, idx) => {
    e.stopPropagation();
    onChange(list.filter((_, i) => i !== idx));
  };

  return (
    <div>
      <div
        role="button" tabIndex={disabled ? -1 : 0}
        onClick={() => { if (!disabled) inputRef.current?.click(); }}
        onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) inputRef.current?.click(); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          if (!disabled) { setDragging(false); addFiles(e.dataTransfer.files); }
        }}
        style={{
          position: 'relative', padding: '14px 16px 14px 20px', borderRadius: '10px',
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
          background: list.length > 0
            ? 'rgba(5,150,105,0.06)'
            : active ? 'rgba(15,118,110,0.05)' : 'var(--surface)',
          border: `1px solid ${
            list.length > 0
              ? 'rgba(5,150,105,0.25)'
              : active ? 'rgba(15,118,110,0.35)' : 'var(--card-border)'
          }`,
          borderLeft: `3px solid ${list.length > 0 ? '#059669' : active ? AGENT_COLOR : 'transparent'}`,
          transition: 'all 0.18s ease',
        }}
      >
        <span style={{
          position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
          fontFamily: 'Barlow', fontWeight: 700, fontSize: 40, lineHeight: 1,
          color: list.length > 0 ? 'rgba(5,150,105,0.1)' : 'rgba(0,0,0,0.04)',
          pointerEvents: 'none', userSelect: 'none',
        }}>{stepNum}</span>

        <input
          ref={inputRef} type="file"
          accept={fileConfig.accept || '.pdf,.xlsx,.xls'}
          multiple className="hidden" disabled={disabled}
          onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
        />

        <div className="flex items-center gap-3">
          <div style={{
            width: 34, height: 34, borderRadius: 8, flexShrink: 0,
            background: list.length > 0
              ? 'rgba(5,150,105,0.12)'
              : active ? 'rgba(15,118,110,0.1)' : 'var(--page-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.18s ease',
          }}>
            {list.length > 0
              ? <FileSpreadsheet style={{ width: 16, height: 16, color: '#059669' }} />
              : <Upload style={{ width: 15, height: 15, color: active ? AGENT_COLOR : 'var(--text-muted)' }} />
            }
          </div>
          <div className="flex-1 min-w-0">
            {list.length > 0 ? (
              <p className="text-sm font-semibold" style={{ color: '#059669', fontFamily: 'Barlow', margin: 0 }}>
                {list.length} file{list.length > 1 ? 's' : ''} selected
                {list.length < maxFiles && (
                  <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 8, opacity: 0.7 }}>+ drop more</span>
                )}
              </p>
            ) : (
              <>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow', margin: 0 }}>
                  {fileConfig.label}
                  <span style={{ color: '#E11D48', marginLeft: 4, fontWeight: 400 }}>*</span>
                </p>
                <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>{fileConfig.hint}</p>
              </>
            )}
          </div>
          {list.length > 0 && (
            <CheckCircle2 style={{ width: 16, height: 16, flexShrink: 0, color: '#059669' }} />
          )}
        </div>
      </div>

      {list.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {list.map((f, idx) => (
            <div key={idx} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
              borderRadius: 7, background: 'var(--page-bg)', border: '1px solid var(--card-border)',
            }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', minWidth: 20 }}>
                {String(idx + 1).padStart(2, '0')}
              </span>
              <span style={{
                fontSize: 12, color: 'var(--text-body)', flex: 1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{f.name}</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', flexShrink: 0 }}>
                {(f.size / 1024).toFixed(0)} KB
              </span>
              <button
                onClick={e => removeFile(e, idx)} disabled={disabled}
                style={{
                  width: 18, height: 18, borderRadius: 4, border: 'none', cursor: 'pointer',
                  background: 'rgba(225,29,72,0.08)', color: '#E11D48', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <X style={{ width: 10, height: 10 }} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Single-file dropzone (COA, VT) ────────────────────────────────────────────
const FileDropzone = ({ fileConfig, file, onChange, disabled, stepIndex }) => {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const active = !disabled && (dragging || hovered);
  const stepNum = String(stepIndex + 1).padStart(2, '0');

  return (
    <div
      role="button" tabIndex={disabled ? -1 : 0}
      onClick={() => { if (!disabled) inputRef.current?.click(); }}
      onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) inputRef.current?.click(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        if (!disabled) { setDragging(false); const f = e.dataTransfer.files[0]; if (f) onChange(f); }
      }}
      style={{
        position: 'relative', padding: '14px 16px 14px 20px', borderRadius: '10px',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        background: file
          ? 'rgba(5,150,105,0.06)'
          : active ? 'rgba(15,118,110,0.05)' : 'var(--surface)',
        border: `1px solid ${
          file ? 'rgba(5,150,105,0.25)' : active ? 'rgba(15,118,110,0.35)' : 'var(--card-border)'
        }`,
        borderLeft: `3px solid ${file ? '#059669' : active ? AGENT_COLOR : 'transparent'}`,
        transition: 'all 0.18s ease', overflow: 'hidden',
      }}
    >
      <span style={{
        position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
        fontFamily: 'Barlow', fontWeight: 700, fontSize: 40, lineHeight: 1,
        color: file ? 'rgba(5,150,105,0.1)' : 'rgba(0,0,0,0.04)',
        pointerEvents: 'none', userSelect: 'none',
      }}>{stepNum}</span>

      <input
        ref={inputRef} type="file"
        accept={fileConfig.accept || '.xlsx,.xls'}
        className="hidden" disabled={disabled}
        onChange={e => onChange(e.target.files[0])}
      />

      {file ? (
        <div className="flex items-center gap-3">
          <div style={{
            width: 34, height: 34, borderRadius: 8, flexShrink: 0,
            background: 'rgba(5,150,105,0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <FileSpreadsheet style={{ width: 16, height: 16, color: '#059669' }} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate" style={{ color: '#059669', fontFamily: 'Barlow', margin: 0 }}>
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
            background: active ? 'rgba(15,118,110,0.1)' : 'var(--page-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.18s ease',
          }}>
            <Upload style={{ width: 15, height: 15, color: active ? AGENT_COLOR : 'var(--text-muted)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow', margin: 0 }}>
              {fileConfig.label}
              {!fileConfig.required && (
                <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11, marginLeft: 6 }}>
                  optional
                </span>
              )}
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

// ── Main component ────────────────────────────────────────────────────────────
const Gstr3bTallyWorkspace = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();

  const [gstr3bFiles,   setGstr3bFiles]   = useState([]);
  const [coaFile,       setCoaFile]       = useState(null);
  const [vtFile,        setVtFile]        = useState(null);
  const [tolerance,     setTolerance]     = useState('1.0');
  const [running,       setRunning]       = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [result,        setResult]        = useState(null);
  const [coaStatus,     setCoaStatus]     = useState({ hasLedger: false, count: 0, hasVt: false, vtCount: 0 });
  const [active3bMonth, setActive3bMonth] = useState(0);
  const [active3bSummaryTab, setActive3bSummaryTab] = useState('entries');
  const [brandName,     setBrandName]     = useState('');
  const [downloading,   setDownloading]   = useState(false);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard',  icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`,    label: 'All Agents', icon: Bot,             testId: 'nav-agents' },
  ]);

  useEffect(() => {
    if (!brandId) return;
    fetchCoaStatus();
    api.get('/api/brands').then(r => {
      const list = r.data?.brands || r.data || [];
      const b = list.find(b => b.id === brandId);
      if (b) setBrandName(b.name);
    }).catch(() => {});
  }, [brandId]); // eslint-disable-line

  const fetchCoaStatus = async () => {
    try {
      const res = await api.get(`/api/brands/${brandId}/gstr3b/coa-status`);
      setCoaStatus(res.data);
    } catch (_) {}
  };

  const handleRun = async () => {
    if (gstr3bFiles.length === 0) {
      toast.error('Please select at least one GSTR-3B file');
      return;
    }
    setRunning(true);
    setResult(null);
    setActive3bMonth(0);
    setActive3bSummaryTab('entries');
    setUploadProgress(0);
    try {
      const form = new FormData();
      for (const f of gstr3bFiles) form.append('gstr3b', f);
      if (coaFile)  form.append('coa', coaFile);
      if (vtFile)   form.append('vouchertype', vtFile);
      form.append('tolerance', tolerance);

      const res = await api.post(`/api/brands/${brandId}/gstr3b/upload`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 180000,
        onUploadProgress: (evt) => {
          if (evt.total) setUploadProgress(Math.round((evt.loaded / evt.total) * 100));
        },
      });

      setUploadProgress(null);
      setResult(res.data);
      const months = res.data?.monthly_data?.length;
      toast.success(months
        ? `${months} month${months !== 1 ? 's' : ''} processed — ${res.data.counts?.entry_rows || 0} entry rows`
        : 'GSTR-3B processed successfully');
      fetchCoaStatus();
    } catch (err) {
      setUploadProgress(null);
      toast.error(err.response?.data?.error || err.message || 'Processing failed');
    } finally {
      setRunning(false);
    }
  };

  const handleDownload = async () => {
    if (!result?.job_id) return;
    setDownloading(true);
    try {
      const res = await api.get(`/api/brands/${brandId}/gstr3b/download/${result.job_id}`, {
        responseType: 'blob',
      });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `gstr3b_tally_entry_${result.job_id}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const handleReset = () => {
    setResult(null);
    setGstr3bFiles([]);
    setCoaFile(null);
    setVtFile(null);
    setActive3bMonth(0);
    setActive3bSummaryTab('entries');
  };

  // ── Derived data ──────────────────────────────────────────────────────────
  const monthly  = result?.monthly_data || [];
  const stateSum = result?.state_summary || [];
  const activeMon     = monthly[active3bMonth] || monthly[0] || {};
  const allMonEntries = activeMon.entries || [];

  const chartData = monthly.map(m => {
    const entries = (m.entries || []).filter(e => e._type === 'data');
    const debit  = entries.reduce((s, e) => s + (typeof e.debit  === 'number' ? e.debit  : 0), 0);
    const credit = entries.reduce((s, e) => s + (typeof e.credit === 'number' ? e.credit : 0), 0);
    return { month: m.period, debit, credit };
  });

  const files3bConfig = {
    label: 'GSTR-3B Files',
    hint: '.pdf / .xlsx / .xls — up to 15 files (one per month)',
    accept: '.pdf,.xlsx,.xls',
    required: true, multiple: true, maxFiles: 15,
  };
  const coaConfig = {
    label: 'Chart of Accounts (Optional)',
    hint: '.xlsx / .xls — upload once, auto-applies to future runs',
    accept: '.xlsx,.xls', required: false,
  };
  const vtConfig = {
    label: 'Voucher Type Master (Optional)',
    hint: '.xls / .xlsx — upload once to map Journal → Journal UP etc.',
    accept: '.xlsx,.xls', required: false,
  };

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div style={{ padding: '24px 28px', maxWidth: 1200 }}>

        {/* Breadcrumb */}
        <button
          onClick={() => navigate(isAdminUser() ? '/admin/agents' : `/brands/${brandId}/agents`)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
            color: 'var(--text-muted)', background: 'none', border: 'none',
            cursor: 'pointer', marginBottom: 24, padding: 0, transition: 'color 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.color = AGENT_COLOR}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}
        >
          <ArrowLeft style={{ width: 14, height: 14 }} />
          All Agents
        </button>

        {/* ── Agent Identity Card ─────────────────────────────────────── */}
        <div style={{
          position: 'relative', overflow: 'hidden', borderRadius: 14,
          background: 'var(--surface)', border: `1px solid var(--card-border)`,
          borderTop: `3px solid ${AGENT_COLOR}`,
          padding: '24px 28px', marginBottom: 28,
          boxShadow: `0 4px 32px ${AGENT_COLOR}12`,
        }}>
          {/* Watermark icon */}
          <div style={{
            position: 'absolute', right: -8, bottom: -12,
            opacity: 0.045, pointerEvents: 'none', userSelect: 'none',
          }}>
            <BookOpen style={{ width: 140, height: 140, color: AGENT_COLOR }} />
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              {/* Icon badge */}
              <div style={{
                width: 52, height: 52, borderRadius: 12, flexShrink: 0,
                background: AGENT_BG, border: `1.5px solid ${AGENT_BORDER}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: `0 4px 16px ${AGENT_COLOR}20`,
              }}>
                <BookOpen style={{ width: 24, height: 24, color: AGENT_COLOR }} />
              </div>

              <div>
                <p style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                  color: AGENT_COLOR, fontFamily: 'monospace',
                  marginBottom: 4, opacity: 0.85,
                }}>
                  GSTR-3B · JOURNAL ENTRY
                </p>
                <h1 style={{
                  fontFamily: 'Barlow', fontWeight: 900, fontSize: 26,
                  color: 'var(--text-heading)', letterSpacing: '-0.02em',
                  lineHeight: 1.1, margin: 0, marginBottom: 6,
                }}>
                  GSTR-3B Tally Entry
                </h1>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: 560, margin: 0 }}>
                  Extracts liability and ITC values from GSTR-3B files and generates ready-to-paste Tally journal entries.
                  Upload 1–15 months in one shot.
                </p>
                {brandName && (
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    marginTop: 10, padding: '4px 10px 4px 6px', borderRadius: 20,
                    fontSize: 12, fontWeight: 600,
                    background: 'rgba(15,118,110,0.06)', border: '1px solid rgba(15,118,110,0.15)',
                    color: AGENT_COLOR, fontFamily: 'Barlow',
                  }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: 4,
                      background: `hsl(${(brandName.charCodeAt(0) * 37) % 360},60%,50%)`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontSize: 9, fontWeight: 800,
                    }}>
                      {brandName[0].toUpperCase()}
                    </div>
                    {brandName}
                  </div>
                )}
              </div>
            </div>

            {result && (
              <button onClick={handleReset} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px',
                borderRadius: 8, fontSize: 12, fontWeight: 600,
                background: 'var(--page-bg)', border: '1px solid var(--card-border)',
                color: 'var(--text-muted)', cursor: 'pointer',
              }}>
                <RotateCcw style={{ width: 13, height: 13 }} /> Reset
              </button>
            )}
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
              }}>
                Upload Files
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

                {/* Brand indicator */}
                {brandName && (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 14px', borderRadius: 10,
                    background: 'var(--page-bg)', border: '1px solid var(--card-border)',
                    borderLeft: `3px solid ${AGENT_COLOR}`, marginBottom: 4,
                  }}>
                    <div>
                      <p style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                        textTransform: 'uppercase', color: 'var(--text-muted)',
                        fontFamily: 'DM Sans', margin: '0 0 2px',
                      }}>Brand</p>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
                        {brandName}
                      </span>
                    </div>
                    <CheckCircle2 style={{ width: 14, height: 14, color: AGENT_COLOR }} />
                  </div>
                )}

                <MultiFileDropzone
                  fileConfig={files3bConfig} files={gstr3bFiles}
                  onChange={setGstr3bFiles} disabled={running} stepIndex={0}
                />
                <FileDropzone
                  fileConfig={coaConfig} file={coaFile}
                  onChange={setCoaFile} disabled={running} stepIndex={1}
                />
                <FileDropzone
                  fileConfig={vtConfig} file={vtFile}
                  onChange={setVtFile} disabled={running} stepIndex={2}
                />

                {/* COA status banner */}
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '10px 14px', borderRadius: 10,
                  background: coaStatus.hasLedger
                    ? 'rgba(15,118,110,0.06)'
                    : 'rgba(100,116,139,0.05)',
                  border: `1px solid ${
                    coaStatus.hasLedger ? 'rgba(15,118,110,0.2)' : 'var(--card-border)'
                  }`,
                }}>
                  <Database style={{
                    width: 14, height: 14, flexShrink: 0, marginTop: 1,
                    color: coaStatus.hasLedger ? AGENT_COLOR : 'var(--text-muted)',
                  }} />
                  <div>
                    <p style={{
                      fontSize: 12, fontWeight: 700, fontFamily: 'Barlow',
                      margin: '0 0 2px',
                      color: coaStatus.hasLedger ? AGENT_COLOR : 'var(--text-muted)',
                    }}>
                      {coaStatus.hasLedger
                        ? `✓ COA saved — ${coaStatus.count} ledgers auto-matched`
                        : 'No COA saved yet — upload optional COA above to enable ledger matching'}
                    </p>
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                      {coaStatus.hasLedger
                        ? 'Tally ledger names will be matched to your saved Chart of Accounts.'
                        : 'Without COA, default generated ledger names are used (no matching).'}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Right: Config + Run + Files Status */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* Config card */}
              <div className="glass-card" style={{ padding: 20 }}>
                <p style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: 'var(--text-muted)',
                  fontFamily: 'DM Sans', marginBottom: 14,
                }}>
                  Configuration
                </p>
                <div>
                  <label style={{
                    display: 'block', fontSize: 11, fontWeight: 700,
                    color: 'var(--text-muted)', letterSpacing: '0.06em',
                    textTransform: 'uppercase', fontFamily: 'DM Sans', marginBottom: 6,
                  }}>Tolerance</label>
                  <div style={{
                    display: 'flex', borderRadius: 8, overflow: 'hidden',
                    border: '1px solid var(--card-border)', opacity: running ? 0.6 : 1,
                  }}>
                    <span style={{
                      display: 'flex', alignItems: 'center', padding: '0 12px',
                      background: 'var(--page-bg)', borderRight: '1px solid var(--card-border)',
                      fontSize: 14, fontWeight: 700, color: 'var(--text-muted)',
                      flexShrink: 0, fontFamily: 'Barlow',
                    }}>₹</span>
                    <input
                      type="number" step="0.5" min="0" value={tolerance}
                      onChange={e => setTolerance(e.target.value)} disabled={running}
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
                onClick={handleRun} disabled={running} className="btn-glow"
                style={{
                  width: '100%', padding: '13px 0',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
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
                    background: uploadProgress < 100 ? AGENT_COLOR : '#059669',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
              )}

              {/* Files status */}
              <div className="glass-card" style={{ padding: 16 }}>
                <p style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: 'var(--text-muted)',
                  fontFamily: 'DM Sans', marginBottom: 10,
                }}>
                  Files Status
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    { label: 'GSTR-3B Files',                  uploaded: gstr3bFiles.length > 0, required: true  },
                    { label: 'Chart of Accounts (Optional)',    uploaded: !!coaFile,              required: false },
                    { label: 'Voucher Type Master (Optional)',  uploaded: !!vtFile,               required: false },
                  ].map(f => (
                    <div key={f.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{
                        fontSize: 12, color: 'var(--text-body)', flex: 1,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{f.label}</span>
                      <span style={{
                        fontSize: 11, fontWeight: 700, marginLeft: 8, flexShrink: 0,
                        fontFamily: 'monospace',
                        color: f.uploaded ? '#059669' : f.required ? '#E11D48' : 'var(--text-muted)',
                      }}>
                        {f.uploaded ? '✓ READY' : f.required ? 'REQUIRED' : 'OPTIONAL'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Results ─────────────────────────────────────────────────── */}
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Download + Reset row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={handleDownload} disabled={downloading}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 16px', borderRadius: 8, fontSize: 13,
                  fontWeight: 700, fontFamily: 'Barlow',
                  background: AGENT_COLOR, color: '#fff', border: 'none', cursor: 'pointer',
                }}
              >
                {downloading
                  ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />
                  : <Download style={{ width: 14, height: 14 }} />
                }
                Download Excel
              </button>
              <button onClick={handleReset} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: 'Barlow',
                background: 'var(--page-bg)', border: '1px solid var(--card-border)',
                color: 'var(--text-muted)', cursor: 'pointer',
              }}>
                <RotateCcw style={{ width: 13, height: 13 }} /> Reset
              </button>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <div style={{
                  padding: '6px 14px', borderRadius: 8,
                  background: 'rgba(15,118,110,0.06)', border: '1px solid rgba(15,118,110,0.18)',
                  fontSize: 12, color: AGENT_COLOR, fontWeight: 700, fontFamily: 'Barlow',
                }}>
                  {monthly.length} month{monthly.length !== 1 ? 's' : ''} processed
                </div>
                {result.coa_ledgers_parsed?.length > 0 && (
                  <div style={{
                    padding: '6px 14px', borderRadius: 8,
                    background: 'rgba(5,150,105,0.06)', border: '1px solid rgba(5,150,105,0.18)',
                    fontSize: 12, color: '#059669', fontWeight: 700, fontFamily: 'Barlow',
                  }}>
                    ✓ COA matched ({result.coa_ledgers_parsed.length} ledgers saved)
                  </div>
                )}
              </div>
            </div>

            {/* Month tabs */}
            {monthly.length > 1 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {monthly.map((m, idx) => (
                  <button key={idx} onClick={() => setActive3bMonth(idx)} style={{
                    padding: '6px 14px', borderRadius: 20, fontSize: 12,
                    fontWeight: 700, fontFamily: 'Barlow', cursor: 'pointer',
                    background: active3bMonth === idx ? AGENT_COLOR : 'var(--surface)',
                    color: active3bMonth === idx ? '#fff' : 'var(--text-muted)',
                    border: `1px solid ${active3bMonth === idx ? AGENT_COLOR : 'var(--card-border)'}`,
                    transition: 'all 0.15s',
                  }}>
                    {m.period || `Month ${idx + 1}`}
                  </button>
                ))}
              </div>
            )}

            {/* 6 Stat cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
              {[
                { label: 'GSTIN',        value: activeMon.gstin        || '—' },
                { label: 'State',        value: activeMon.state        || '—' },
                { label: 'Period',       value: activeMon.period       || '—' },
                { label: 'Voucher Date', value: activeMon.voucher_date || '—' },
                { label: 'Total Debit',  value: `₹${fmt(activeMon.total_debit)}`  },
                { label: 'Total Credit', value: `₹${fmt(activeMon.total_credit)}` },
              ].map(({ label, value }) => (
                <div key={label} style={{
                  background: 'var(--surface)', border: '1px solid var(--card-border)',
                  borderLeft: `4px solid ${AGENT_COLOR}`, borderRadius: 10, padding: '12px 16px',
                }}>
                  <p style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                    textTransform: 'uppercase', color: AGENT_COLOR,
                    fontFamily: 'DM Sans', margin: '0 0 4px',
                  }}>{label}</p>
                  <p style={{
                    fontSize: 14, fontWeight: 800, fontFamily: 'Barlow',
                    color: 'var(--text-heading)', margin: 0, wordBreak: 'break-all',
                  }}>{value}</p>
                </div>
              ))}
            </div>

            {/* Sub-tab bar */}
            <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--card-border)' }}>
              {[
                ['entries',   'Journal Entries', null],
                ['month',     'Month Summary',   null],
                ['state',     'State Summary',   null],
                ['dashboard', 'Dashboard',       BarChart3],
              ].map(([key, label, Icon]) => (
                <button key={key} onClick={() => setActive3bSummaryTab(key)} style={{
                  padding: '8px 16px', fontSize: 12, fontWeight: 700, fontFamily: 'Barlow',
                  background: 'none', border: 'none', cursor: 'pointer',
                  borderBottom: `2px solid ${active3bSummaryTab === key ? AGENT_COLOR : 'transparent'}`,
                  color: active3bSummaryTab === key ? AGENT_COLOR : 'var(--text-muted)',
                  transition: 'all 0.15s',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}>
                  {Icon && <Icon style={{ width: 13, height: 13 }} />}
                  {label}
                </button>
              ))}
            </div>

            {/* ── Journal Entries tab ─────────────────────────────────── */}
            {active3bSummaryTab === 'entries' && (
              <div className="glass-card" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <colgroup>
                    <col style={{ width: 50 }} /><col />
                    <col style={{ width: 160 }} /><col style={{ width: 160 }} />
                    <col style={{ width: 120 }} /><col style={{ width: 100 }} />
                  </colgroup>
                  <tbody>
                    {allMonEntries.length === 0 && (
                      <tr>
                        <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                          No entries for selected period
                        </td>
                      </tr>
                    )}
                    {allMonEntries.map((entry, i) => {
                      if (entry._type === 'blank') {
                        return <tr key={i}><td colSpan={6} style={{ height: 8 }} /></tr>;
                      }
                      if (entry._type === 'section') {
                        return (
                          <tr key={i}>
                            <td colSpan={6} style={{
                              padding: '8px 16px', fontWeight: 800, fontFamily: 'Barlow',
                              fontSize: 13, background: 'rgba(15,118,110,0.08)',
                              color: AGENT_COLOR, borderRadius: 6,
                            }}>
                              {entry.particulars}
                            </td>
                          </tr>
                        );
                      }
                      if (entry._type === 'header') {
                        return (
                          <tr key={i} style={{ background: 'var(--page-bg)' }}>
                            {['sno', 'particulars', 'debit', 'credit', 'date', 'voucher_type'].map(k => (
                              <th key={k} style={{
                                padding: '8px 12px', fontSize: 11, fontWeight: 700,
                                color: 'var(--text-muted)',
                                textAlign: k === 'particulars' ? 'left' : 'right',
                                borderBottom: '1px solid var(--card-border)',
                                letterSpacing: '0.04em', textTransform: 'uppercase', fontFamily: 'DM Sans',
                              }}>
                                {entry[k]}
                              </th>
                            ))}
                          </tr>
                        );
                      }
                      return (
                        <tr key={i} style={{
                          opacity: (entry.debit === 0 || entry.credit === 0) ? 0.5 : 1,
                          borderBottom: '1px solid var(--card-border)',
                        }}>
                          <td style={{ padding: '6px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                            {entry.sno}
                          </td>
                          <td style={{ padding: '6px 12px', color: 'var(--text-heading)', fontFamily: 'Barlow', fontWeight: 600 }}>
                            {entry.particulars}
                          </td>
                          <td style={{
                            padding: '6px 12px', textAlign: 'right', fontFamily: 'monospace',
                            color: typeof entry.debit === 'number' && entry.debit > 0 ? '#059669' : 'var(--text-muted)',
                          }}>
                            {typeof entry.debit === 'number' ? `₹${fmt(entry.debit)}` : ''}
                          </td>
                          <td style={{
                            padding: '6px 12px', textAlign: 'right', fontFamily: 'monospace',
                            color: typeof entry.credit === 'number' && entry.credit > 0 ? '#E11D48' : 'var(--text-muted)',
                          }}>
                            {typeof entry.credit === 'number' ? `₹${fmt(entry.credit)}` : ''}
                          </td>
                          <td style={{
                            padding: '6px 12px', textAlign: 'right', fontSize: 12,
                            color: 'var(--text-muted)', fontFamily: 'monospace',
                          }}>
                            {entry.date || ''}
                          </td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>
                            {entry.voucher_type || ''}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* ── Month Summary tab ───────────────────────────────────── */}
            {active3bSummaryTab === 'month' && (
              <div className="glass-card" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--page-bg)' }}>
                      {['Period', 'GSTIN', 'State', 'Total Debit', 'Total Credit', 'J1 Debit', 'J2 Debit', 'J3 Debit'].map(h => (
                        <th key={h} style={{
                          padding: '10px 14px', fontSize: 11, fontWeight: 700,
                          color: 'var(--text-muted)',
                          textAlign: ['GSTIN', 'Period', 'State'].includes(h) ? 'left' : 'right',
                          borderBottom: '1px solid var(--card-border)',
                          textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: 'DM Sans',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {monthly.map((m, idx) => (
                      <tr
                        key={idx}
                        onClick={() => setActive3bMonth(idx)}
                        style={{
                          borderBottom: '1px solid var(--card-border)', cursor: 'pointer',
                          background: idx === active3bMonth ? 'rgba(15,118,110,0.04)' : 'transparent',
                        }}
                      >
                        <td style={{ padding: '8px 14px', fontWeight: 700, fontFamily: 'Barlow', color: AGENT_COLOR }}>
                          {m.period}
                        </td>
                        <td style={{ padding: '8px 14px', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>
                          {m.gstin}
                        </td>
                        <td style={{ padding: '8px 14px', color: 'var(--text-body)' }}>{m.state}</td>
                        {['total_debit', 'total_credit', 'j1_debit', 'j2_debit', 'j3_debit'].map(k => (
                          <td key={k} style={{ padding: '8px 14px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-heading)' }}>
                            ₹{fmt(m[k] || 0)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* ── State Summary tab ───────────────────────────────────── */}
            {active3bSummaryTab === 'state' && (
              <div className="glass-card" style={{ overflowX: 'auto' }}>
                {stateSum.length === 0 ? (
                  <p style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    No state data available
                  </p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: 'var(--page-bg)' }}>
                        {['State', 'Code', 'Months', 'Total Debit', 'Total Credit'].map(h => (
                          <th key={h} style={{
                            padding: '10px 14px', fontSize: 11, fontWeight: 700,
                            color: 'var(--text-muted)',
                            textAlign: h === 'State' ? 'left' : 'right',
                            borderBottom: '1px solid var(--card-border)',
                            textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: 'DM Sans',
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {stateSum.map((s, idx) => (
                        <tr key={idx} style={{ borderBottom: '1px solid var(--card-border)' }}>
                          <td style={{ padding: '8px 14px', fontWeight: 700, fontFamily: 'Barlow', color: 'var(--text-heading)' }}>
                            {s.state}
                          </td>
                          <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: AGENT_COLOR, fontWeight: 700 }}>
                            {s.state_short}
                          </td>
                          <td style={{ padding: '8px 14px', textAlign: 'right', color: 'var(--text-body)' }}>
                            {s.months}
                          </td>
                          <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-heading)' }}>
                            ₹{fmt(s.total_debit || 0)}
                          </td>
                          <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-heading)' }}>
                            ₹{fmt(s.total_credit || 0)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* ── Dashboard tab (charts) ──────────────────────────────── */}
            {active3bSummaryTab === 'dashboard' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

                {/* Debit vs Credit by Month */}
                {chartData.length > 0 && (
                  <div className="glass-card" style={{ padding: 24 }}>
                    <p style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                      textTransform: 'uppercase', color: 'var(--text-muted)',
                      fontFamily: 'DM Sans', marginBottom: 16,
                    }}>
                      Debit vs Credit by Month
                    </p>
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={chartData} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--card-border)" />
                        <XAxis
                          dataKey="month"
                          tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                          tickFormatter={(v) => {
                            const p = v.split(' ');
                            return p.length === 2 ? `${p[0].slice(0, 3)} ${p[1].slice(2)}` : v;
                          }}
                        />
                        <YAxis
                          tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                          tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`}
                        />
                        <Tooltip
                          formatter={(value, name) => [
                            `₹${fmt(value)}`,
                            name === 'debit' ? 'Total Debit' : 'Total Credit',
                          ]}
                          labelStyle={{ fontWeight: 600 }}
                          contentStyle={{
                            background: 'var(--surface)',
                            border: '1px solid var(--card-border)',
                            borderRadius: 8, fontSize: 12,
                          }}
                        />
                        <Legend formatter={(v) => v === 'debit' ? 'Total Debit' : 'Total Credit'} />
                        <Bar dataKey="debit"  fill="#0F766E" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="credit" fill="#34D399" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* State-wise summary bar chart */}
                {stateSum.length > 0 && (
                  <div className="glass-card" style={{ padding: 24 }}>
                    <p style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                      textTransform: 'uppercase', color: 'var(--text-muted)',
                      fontFamily: 'DM Sans', marginBottom: 16,
                    }}>
                      State-wise Summary
                    </p>
                    <ResponsiveContainer width="100%" height={Math.max(200, stateSum.length * 56)}>
                      <BarChart
                        layout="vertical"
                        data={stateSum.map(s => ({
                          state: s.state_short || s.state,
                          debit: s.total_debit || 0,
                          credit: s.total_credit || 0,
                        }))}
                        margin={{ top: 5, right: 20, left: 60, bottom: 5 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--card-border)" />
                        <XAxis
                          type="number"
                          tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                          tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`}
                        />
                        <YAxis
                          type="category" dataKey="state"
                          tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                        />
                        <Tooltip
                          formatter={(value, name) => [
                            `₹${fmt(value)}`,
                            name === 'debit' ? 'Total Debit' : 'Total Credit',
                          ]}
                          contentStyle={{
                            background: 'var(--surface)',
                            border: '1px solid var(--card-border)',
                            borderRadius: 8, fontSize: 12,
                          }}
                        />
                        <Legend formatter={(v) => v === 'debit' ? 'Total Debit' : 'Total Credit'} />
                        <Bar dataKey="debit"  fill="#0F766E" radius={[0, 4, 4, 0]} />
                        <Bar dataKey="credit" fill="#34D399" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Month stat summary cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
                  {monthly.map((m, idx) => (
                    <div
                      key={idx}
                      onClick={() => { setActive3bMonth(idx); setActive3bSummaryTab('entries'); }}
                      style={{
                        background: 'var(--surface)', border: '1px solid var(--card-border)',
                        borderLeft: `4px solid ${AGENT_COLOR}`, borderRadius: 10, padding: '14px 16px',
                        cursor: 'pointer', transition: 'box-shadow 0.15s',
                      }}
                      onMouseEnter={e => e.currentTarget.style.boxShadow = `0 4px 20px ${AGENT_COLOR}18`}
                      onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
                    >
                      <p style={{
                        fontSize: 12, fontWeight: 800, fontFamily: 'Barlow',
                        color: AGENT_COLOR, margin: '0 0 8px',
                      }}>
                        {m.period || `Month ${idx + 1}`}
                      </p>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <div>
                          <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '0 0 2px', fontFamily: 'DM Sans', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Debit</p>
                          <p style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: '#059669', margin: 0 }}>
                            ₹{fmt(m.total_debit)}
                          </p>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '0 0 2px', fontFamily: 'DM Sans', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Credit</p>
                          <p style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: '#E11D48', margin: 0 }}>
                            ₹{fmt(m.total_credit)}
                          </p>
                        </div>
                      </div>
                      <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '8px 0 0', fontFamily: 'DM Sans' }}>
                        {m.state || ''} · Click to view entries
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default Gstr3bTallyWorkspace;

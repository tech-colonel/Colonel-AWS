import React, { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import Gstr1Dashboard from './Gstr1Dashboard';
import ToolResultDashboard from '../../components/reco/ToolResultDashboard';
import {
  LayoutDashboard, Bot, ArrowLeft, Upload, Download,
  Play, CheckCircle2, XCircle, AlertTriangle, RotateCcw,
  FileSpreadsheet, Loader2, ChevronDown, ChevronUp, Database, Info,
  BarChart3, ArrowRight, Save, Search, X, Scale, ClipboardList,
  FolderOpen, Globe, TrendingUp, Landmark, BookOpen, GitCompare, AlertCircle,
  Zap, CreditCard, History, Eye, Calendar, Trash2,
} from 'lucide-react';
import api from '../../lib/api';
import { sidebarFor, isAdminUser } from '../../lib/adminNav';
import OtherBrandReset from '../../components/OtherBrandReset';
import { DEMO_SAMPLES, urlToFile } from '../../lib/demoSamples';
import { toast } from 'sonner';
import GoogleDriveFolderInput from './GoogleDriveFolderInput';

const HISTORY_MONTHS_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Formats a reco_jobs row's period as "Mar 2025" or, when period_end_month/year differ
// from the start, "Mar 2025 – May 2025".
const formatJobPeriod = (job) => {
  if (!job.month) return '—';
  const start = `${HISTORY_MONTHS_SHORT[job.month]} ${job.year || ''}`;
  const hasEnd = job.period_end_month && job.period_end_year &&
    (job.period_end_month !== job.month || job.period_end_year !== job.year);
  if (!hasEnd) return start;
  return `${start} – ${HISTORY_MONTHS_SHORT[job.period_end_month]} ${job.period_end_year}`;
};

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
  einvoice_reco: {
    name: 'E-Invoice Reconciliation',
    slug: 'E-INVOICE · BOOKS',
    icon: FileSpreadsheet,
    description: 'Reconciles the GST Portal E-Invoice Register (B2B/SEZ/DE + CDNR) against Books (combined Sales + Credit Note). Outputs Pivot, After Pivot, and a side-by-side RECO sheet.',
    color: '#0284C7', bg: 'rgba(2,132,199,0.08)', border: 'rgba(2,132,199,0.2)',
    files: [
      { key: 'einvoice', label: 'E-Invoice Register', hint: '.xlsx — portal download (b2b, sez, de + cdnr sheets)', required: true },
      { key: 'books', label: 'Books — Combined (Sales + Credit Note)', hint: '.xlsx — single workbook with the Combined sheet', required: true },
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
    description: 'Extracts liability and ITC values from GSTR-3B files and generates ready-to-paste Tally journal entries. Upload 1–15 months in one shot.',
    color: '#0F766E', bg: 'rgba(15,118,110,0.08)', border: 'rgba(15,118,110,0.2)',
    files: [
      { key: 'gstr3b', label: 'GSTR-3B Files', hint: '.pdf / .xlsx / .xls — up to 15 files (one per month)', accept: '.pdf,.xlsx,.xls', required: true, multiple: true, maxFiles: 15 },
      { key: 'coa', label: 'Chart of Accounts (Optional)', hint: '.xlsx / .xls — upload once, auto-applies to future runs', accept: '.xlsx,.xls', required: false },
      { key: 'vouchertype', label: 'Voucher Type Master (Optional)', hint: '.xls / .xlsx — upload once to map Journal → Journal UP etc.', accept: '.xlsx,.xls', required: false },
    ],
  },
  zepto_receivables: {
    name: 'Zepto Receivables',
    slug: 'GOOGLE DRIVE · RECEIVABLES',
    icon: CreditCard,
    description: 'Paste a Google Drive folder URL. We auto-detect Zepto/Tally files, reconcile receivables, and generate the Invoice Tracker with live formulas.',
    color: '#6366F1', bg: 'rgba(99,102,241,0.08)', border: 'rgba(99,102,241,0.2)',
    driveMode: true,
    files: [],
  },
  receivable_cycle: {
    name: 'Receivable Cycle',
    slug: 'TALLY · COD · SRN',
    icon: RotateCcw,
    description: 'Combines the Tally GST report, Sales Order Combine, courier COD settlement exports (Delhivery/Ekart/Xpressbees), and the combined SRN report into a Main Sheet plus per-courier COD sheets.',
    color: '#7C3AED', bg: 'rgba(124,58,237,0.08)', border: 'rgba(124,58,237,0.2)',
    files: [
      { key: 'tally_gst', label: 'Combine Tally GST Report', hint: '.xlsx / .xls', required: true },
      { key: 'sales_order', label: 'Sales Order Combine', hint: '.xlsx / .xls', required: true },
      { key: 'delhivery', label: 'Delhivery COD Settlement (Optional)', hint: '.xlsx / .xls — one or more files', required: false, multiple: true },
      { key: 'ekart', label: 'Ekart COD Settlement (Optional)', hint: '.xlsx / .xls — one or more files', required: false, multiple: true },
      { key: 'xpressbees', label: 'Xpressbees COD Settlement (Optional)', hint: '.xlsx / .xls — one or more files', required: false, multiple: true },
      { key: 'srn', label: 'Combined SRN Report (Optional)', hint: '.xlsx / .xls — one or more files', required: false, multiple: true },
    ],
  },
  bank_tally_reco: {
    name: 'Bank Reco',
    slug: 'TALLY ↔ BANK · RECONCILE',
    icon: Globe,
    description: 'Reconciles your Tally bank-ledger daybook against the Universal Bank Statement output — matches on amount + party, updates clearing dates, and lists bank-only entries ready to paste.',
    color: '#0748EE', bg: 'rgba(7,72,238,0.08)', border: 'rgba(7,72,238,0.2)',
    files: [
      { key: 'tally_daybook', label: 'Tally Bank Daybook', hint: '.xls / .xlsx — books side', accept: '.xls,.xlsx', required: true },
      { key: 'bank_output', label: 'Universal Bank Statement Output', hint: '.xlsx — from the Universal Bank tool (auto-loaded via handoff)', accept: '.xlsx', required: false },
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

// ── Multi-File Dropzone (for gstr3b slot) ────────────────────────────────────
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
        role="button"
        tabIndex={disabled ? -1 : 0}
        onClick={() => { if (!disabled) inputRef.current?.click(); }}
        onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) inputRef.current?.click(); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); if (!disabled) { setDragging(false); addFiles(e.dataTransfer.files); } }}
        style={{
          position: 'relative', padding: '14px 16px 14px 20px', borderRadius: '10px',
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
          background: list.length > 0 ? 'rgba(5,150,105,0.06)' : active ? 'rgba(7,72,238,0.05)' : 'var(--surface)',
          border: `1px solid ${list.length > 0 ? 'rgba(5,150,105,0.25)' : active ? 'rgba(7,72,238,0.35)' : 'var(--card-border)'}`,
          borderLeft: `3px solid ${list.length > 0 ? '#059669' : active ? '#0748EE' : 'transparent'}`,
          transition: 'all 0.18s ease',
        }}
      >
        <span style={{
          position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
          fontFamily: 'Barlow', fontWeight: 700, fontSize: 40, lineHeight: 1,
          color: list.length > 0 ? 'rgba(5,150,105,0.1)' : 'rgba(0,0,0,0.04)',
          pointerEvents: 'none', userSelect: 'none',
        }}>{stepNum}</span>
        <input ref={inputRef} type="file" accept={fileConfig.accept || '.xlsx,.xls'} multiple className="hidden"
          disabled={disabled} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        <div className="flex items-center gap-3">
          <div style={{
            width: 34, height: 34, borderRadius: 8, flexShrink: 0,
            background: list.length > 0 ? 'rgba(5,150,105,0.12)' : active ? 'rgba(7,72,238,0.1)' : 'var(--page-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.18s ease',
          }}>
            {list.length > 0
              ? <FileSpreadsheet style={{ width: 16, height: 16, color: '#059669' }} />
              : <Upload style={{ width: 15, height: 15, color: active ? '#0748EE' : 'var(--text-muted)' }} />
            }
          </div>
          <div className="flex-1 min-w-0">
            {list.length > 0 ? (
              <p className="text-sm font-semibold" style={{ color: '#059669', fontFamily: 'Barlow', margin: 0 }}>
                {list.length} file{list.length > 1 ? 's' : ''} selected
                {list.length < maxFiles && <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 8, opacity: 0.7 }}>+ drop more</span>}
              </p>
            ) : (
              <>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow', margin: 0 }}>
                  {fileConfig.label}<span style={{ color: '#E11D48', marginLeft: 4, fontWeight: 400 }}>*</span>
                </p>
                <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>{fileConfig.hint}</p>
              </>
            )}
          </div>
          {list.length > 0 && <CheckCircle2 style={{ width: 16, height: 16, flexShrink: 0, color: '#059669' }} />}
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
              <span style={{ fontSize: 12, color: 'var(--text-body)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.name}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace', flexShrink: 0 }}>
                {(f.size / 1024).toFixed(0)} KB
              </span>
              <button onClick={e => removeFile(e, idx)} disabled={disabled} style={{
                width: 18, height: 18, borderRadius: 4, border: 'none', cursor: 'pointer',
                background: 'rgba(225,29,72,0.08)', color: '#E11D48', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <X style={{ width: 10, height: 10 }} />
              </button>
            </div>
          ))}
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
  const location = useLocation();
  const sourceJobId = new URLSearchParams(location.search).get('source_job_id');

  // Switch the active brand AND keep the URL in sync (URL = source of truth).
  // The 'other' sentinel is a local testing mode (not a real brand route) → no nav.
  const switchBrand = (bid) => {
    setSelectedBrand(bid);
    setBrandPickerOpen(false);
    setBrandSearch('');
    if (bid && bid !== 'other') {
      navigate(location.pathname.replace(/\/brands\/[^/]+/, `/brands/${bid}`));
    }
  };
  const config = AGENT_CONFIG[agentType];
  const isDemo = localStorage.getItem('token') === 'demo-mode-token';
  const isDriveMode = !!config?.driveMode;

  const [driveUrl, setDriveUrl] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState({});
  const [tolerance, setTolerance] = useState('1.0');
  const [running, setRunning] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [phase, setPhase] = useState(null); // 'uploading' | 'reconciling' | 'preparing' | null
  const phaseTimer = useRef(null);
  const [result, setResult] = useState(null);
  const [filter, setFilter] = useState('All');
  const [downloading, setDownloading] = useState(false);
  const [showMonthly, setShowMonthly] = useState(true);
  const [ledgerStatus, setLedgerStatus] = useState(null);

  // GSTR-3B Tally Entry specific state
  const [active3bMonth, setActive3bMonth] = useState(0);    // index into monthly_data
  const [active3bSummaryTab, setActive3bSummaryTab] = useState('entries'); // 'entries'|'month'|'state'
  const is3b = agentType === 'gstr_3b_tally_entry';

  const isUniversal = agentType === 'universal_bank_statement';
  const isReceivableCycle = agentType === 'receivable_cycle';
  const [recoHistory, setRecoHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [deletingJobId, setDeletingJobId] = useState(null);

  // "Generate Receivables" form (Receivable Cycle only) — files + a manually-picked
  // month or month-range, tagging the resulting job (metadata only, doesn't filter
  // the uploaded rows — see reco_jobs.period_end_month/year).
  const [generateModalOpen, setGenerateModalOpen] = useState(false);
  const [periodMode, setPeriodMode] = useState('single'); // 'single' | 'range'
  const [periodMonth, setPeriodMonth] = useState('');
  const [periodYear, setPeriodYear] = useState('');
  const [periodEndMonth, setPeriodEndMonth] = useState('');
  const [periodEndYear, setPeriodEndYear] = useState('');
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
  const FLO_BRAND_ID = '099c8de8-5ff8-49eb-81a9-1f89658a6bb8';
  const BANK_RECO_AGENT_ID = '290c797b-ec07-4caa-984f-45935e5c6b2a';
  const isFloBrand = (effectiveBrandId || brandId) === FLO_BRAND_ID;

  // Cache a slim copy (raw source dicts stripped) so large results stay under
  // sessionStorage's ~5MB quota — otherwise the save throws and Back loses the
  // result. The results table never reads `.raw`.
  const slimResultForCache = (data) => {
    if (!data) return data;
    const stripRaw = (o) => { if (!o || typeof o !== 'object') return o; const { raw, ...rest } = o; return rest; };
    return {
      ...data,
      results: (data.results || []).map(r => ({ ...r, gstr2b: stripRaw(r.gstr2b), purchase: stripRaw(r.purchase) })),
    };
  };

  // Previously generated Receivable Cycle files for this brand — re-fetched after every
  // run too, so a just-completed job appears once its fire-and-forget DB save lands.
  useEffect(() => {
    if (!isReceivableCycle || !effectiveBrandId || effectiveBrandId === 'other' || effectiveBrandId === 'demo') {
      setRecoHistory([]);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    api.get(`/api/dashboard/reco/history/${effectiveBrandId}`)
      .then(res => {
        if (cancelled) return;
        setRecoHistory((res.data?.jobs || []).filter(j => j.agent_type === 'receivable_cycle'));
      })
      .catch(() => { if (!cancelled) setRecoHistory([]); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [isReceivableCycle, effectiveBrandId, result]);

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
    if ((agentType === 'bank_statement' || agentType === 'gstr_3b_tally_entry') && !isDemo && brandId !== 'demo') checkLedgerMaster(brandId);
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
    if ((isUniversal || agentType === 'gstr_3b_tally_entry') && effectiveBrandId && effectiveBrandId !== 'other' && !isDemo) {
      checkLedgerMaster(effectiveBrandId);
    } else if (isUniversal || agentType === 'gstr_3b_tally_entry') {
      setLedgerStatus(null);
    }
  }, [effectiveBrandId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Admin demo: auto-load engine-valid sample files so Anshul can run with one click.
  useEffect(() => {
    if (!isAdminUser()) return;
    const samples = DEMO_SAMPLES[agentType];
    if (!samples) return;
    let cancelled = false;
    (async () => {
      let loaded = 0;
      for (const s of samples) {
        try {
          const file = await urlToFile(s.url, s.filename);
          if (cancelled) return;
          setUploadedFiles(prev => ({ ...prev, [s.key]: file }));
          loaded++;
        } catch (_) { /* skip missing sample */ }
      }
      if (!cancelled && loaded) toast.success('Sample files loaded — click Run Reconciliation');
    })();
    return () => { cancelled = true; };
  }, [agentType]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  if (!config) {
    return (
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>Agent not found</div>
      </DashboardLayout>
    );
  }

  const AgentIcon = config.icon;

  const handleFileChange = (key, fileOrArray) => setUploadedFiles(prev => ({ ...prev, [key]: fileOrArray }));

  const handleRun = async () => {
    if (isDriveMode) {
      if (!driveUrl) { toast.error('Paste a Google Drive folder URL'); return; }
      setRunning(true); setResult(null); setEditedLedgers({});
      setPhase('reconciling');
      try {
        const formData = new FormData();
        formData.append('reco_type', agentType);
        formData.append('brand_id', effectiveBrandId || brandId);
        formData.append('folder_url', driveUrl);
        const { data } = await api.post('/api/reco/run', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          timeout: 600000,
        });
        setPhase('done');
        setResult(data);
        try { sessionStorage.setItem(cacheKey, JSON.stringify(slimResultForCache(data))); } catch (_) {}
        toast.success(`Reconciliation complete! ${data.results?.length || 0} records processed.`);
      } catch (err) {
        setPhase(null);
        toast.error(err.response?.data?.error || 'Reconciliation failed');
      } finally { setRunning(false); }
      return;
    }
    const missing = activeFiles.filter(f => {
      if (!f.required) return false;
      const v = uploadedFiles[f.key];
      return f.multiple ? (!v || (Array.isArray(v) && v.length === 0)) : !v;
    });
    if (missing.length > 0) { toast.error(`Please upload: ${missing.map(f => f.label).join(', ')}`); return; }
    if (agentType === 'bank_statement' && isDemo && !uploadedFiles['ledger_master']) {
      toast.error('In demo mode, please upload the Ledger Master file'); return;
    }
    if (isReceivableCycle) {
      if (!periodMonth || !periodYear) { toast.error('Pick the month and year this run represents'); return; }
      if (periodMode === 'range') {
        if (!periodEndMonth || !periodEndYear) { toast.error('Pick the end month and year for the range'); return; }
        if (Number(periodEndYear) < Number(periodYear) ||
            (Number(periodEndYear) === Number(periodYear) && Number(periodEndMonth) < Number(periodMonth))) {
          toast.error('Range end must be on or after the start month'); return;
        }
      }
    }
    setRunning(true); setResult(null); setEditedLedgers({}); setUploadProgress(0);
    setPhase('uploading');
    setActive3bMonth(0); setActive3bSummaryTab('entries');
    try {
      const formData = new FormData();
      formData.append('reco_type', agentType);
      formData.append('tolerance', tolerance);
      formData.append('brand_id', effectiveBrandId || brandId);
      formData.append('is_demo', isDemo ? 'true' : 'false');
      if (sourceJobId) formData.append('source_job_id', sourceJobId);
      if (effectiveBrandName) formData.append('brand_name', effectiveBrandName);
      if (isReceivableCycle) {
        formData.append('month', periodMonth);
        formData.append('year', periodYear);
        if (periodMode === 'range') {
          formData.append('period_end_month', periodEndMonth);
          formData.append('period_end_year', periodEndYear);
        }
      }
      for (const [key, val] of Object.entries(uploadedFiles)) {
        if (!val) continue;
        if (Array.isArray(val)) {
          for (const f of val) formData.append(key, f);
        } else {
          formData.append(key, val);
        }
      }
      const response = await api.post('/api/reco/run', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (evt) => {
          if (evt.total) {
            const pct = Math.round((evt.loaded / evt.total) * 100);
            setUploadProgress(pct);
            if (pct >= 100) {
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
      if (agentType === 'gstr_3b_tally_entry' && uploadedFiles['coa'] && effectiveBrandId && effectiveBrandId !== 'other') {
        checkLedgerMaster(effectiveBrandId);
      }
      if (isReceivableCycle) setGenerateModalOpen(false);
      try { sessionStorage.setItem(cacheKey, JSON.stringify(slimResultForCache(response.data))); } catch (_) {}
      toast.success(`Reconciliation complete! ${response.data.results?.length || 0} records processed.`);
    } catch (err) {
      clearTimeout(phaseTimer.current);
      setUploadProgress(null);
      setPhase(null);
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

  const handleSendFeedback = async ({ comment, rows }) => {
    try {
      await api.post('/api/feedback', {
        agentType,
        agentLabel: config?.name,
        brandId: effectiveBrandId || brandId,
        brandName: effectiveBrandName,
        jobId: result?.job_id,
        comment, rows,
      });
      toast.success('Feedback sent — the engineering team has been notified');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not send feedback');
      throw e;
    }
  };

  const handleReset = async () => {
    if (!window.confirm('Clear all results and uploaded files? This also purges this run from the database. This cannot be undone.')) return;
    const bId = effectiveBrandId || brandId;
    if (result?.job_id && bId && bId !== 'other' && bId !== 'demo') {
      try { await api.delete(`/api/reco/job/${bId}/${result.job_id}`); } catch (_) {}
    }
    try { sessionStorage.removeItem(cacheKey); sessionStorage.removeItem(editsKey); } catch (_) {}
    setUploadedFiles({}); setResult(null); setFilter('All'); setEditedLedgers({});
  };

  // Delete one previously-generated file from the "Previously Generated Files" list
  // (Receivable Cycle). Reuses the same per-run purge endpoint Reset already uses —
  // CASCADE removes the row-level receivable_cycle_results for that job too.
  const handleDeleteHistoryJob = async (job) => {
    if (!window.confirm('Delete this generated file? This removes it from history permanently and cannot be undone.')) return;
    const bId = effectiveBrandId || brandId;
    if (!bId || bId === 'other' || bId === 'demo') return;
    setDeletingJobId(job.id);
    try {
      await api.delete(`/api/reco/job/${bId}/${job.output_file_id || job.id}`);
      setRecoHistory(prev => prev.filter(j => j.id !== job.id));
      toast.success('Deleted');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete');
    } finally {
      setDeletingJobId(null);
    }
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
      suggested_action_3: row.suggested_action_3 || null,
    };
  };

  // Full, UNFILTERED rows for the premium dashboard — same order/length as
  // result.results, so the dashboard's absolute row index lines up with the
  // index handleSaveCorrections uses (result.results[idx]) when persisting
  // ledger edits. The dashboard owns filtering + the 200-row cap internally.
  const dashboardRows = (result?.results || []).map(flattenResult);

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
              onClick={() => switchBrand(b.id)}
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
              onClick={() => switchBrand('other')}
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

  // Extracted so it can be reused both in the standard upload grid (every agent)
  // and inside the Receivable Cycle "Generate Receivables" modal.
  const brandSelectorField = (
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
  );

  const periodSelectStyle = {
    padding: '8px 10px', borderRadius: 8, fontSize: 13, outline: 'none',
    background: 'var(--page-bg)', border: '1px solid var(--card-border)',
    color: 'var(--text-heading)', fontFamily: 'Barlow',
  };

  const GenerateReceivablesModal = (isReceivableCycle && generateModalOpen) ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(10,15,46,0.6)', backdropFilter: 'blur(8px)' }}
      onClick={e => { if (e.target === e.currentTarget && !running) setGenerateModalOpen(false); }}
    >
      <div style={{
        width: '100%', maxWidth: 640, maxHeight: '90vh', overflowY: 'auto',
        background: 'var(--surface)',
        border: '1px solid var(--card-border)',
        borderRadius: 16, padding: 24,
        boxShadow: '0 24px 80px rgba(0,0,0,0.25)',
        position: 'relative',
      }}>
        {!running && (
          <button
            aria-label="Close Generate Receivables form"
            onClick={() => setGenerateModalOpen(false)}
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
            <Zap style={{ width: 18, height: 18, color: config.color }} />
          </div>
          <div>
            <h3 style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 16, color: 'var(--text-heading)', margin: 0 }}>
              Generate Receivables
            </h3>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', letterSpacing: '0.06em', marginTop: 2 }}>
              {config.slug}
            </p>
          </div>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 18px' }}>
          Upload the source files and pick the month (or month range) this run represents.
        </p>

        {/* File slots */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 22 }}>
          {activeFiles.map((f, idx) => (
            <React.Fragment key={f.key}>
              {f.multiple ? (
                <MultiFileDropzone
                  fileConfig={f} files={uploadedFiles[f.key] || []}
                  onChange={(arr) => handleFileChange(f.key, arr)}
                  disabled={running} stepIndex={idx}
                />
              ) : (
                <FileDropzone
                  fileConfig={f} file={uploadedFiles[f.key]}
                  onChange={(file) => handleFileChange(f.key, file)}
                  disabled={running} stepIndex={idx}
                />
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Period picker — single month or a month range. Metadata only: tags the
            job for history/idempotency, does not filter the uploaded rows. */}
        <div style={{ marginBottom: 22 }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'DM Sans' }}>
            <Calendar style={{ width: 12, height: 12, display: 'inline', marginRight: 5, verticalAlign: -1 }} />
            Period <span style={{ color: '#E11D48' }}>*</span>
          </p>

          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {[['single', 'Single Month'], ['range', 'Month Range']].map(([mode, label]) => (
              <button key={mode}
                onClick={() => setPeriodMode(mode)}
                disabled={running}
                style={{
                  padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                  fontFamily: 'Barlow', cursor: running ? 'not-allowed' : 'pointer',
                  background: periodMode === mode ? config.bg : 'var(--page-bg)',
                  border: `1px solid ${periodMode === mode ? config.border : 'var(--card-border)'}`,
                  color: periodMode === mode ? config.color : 'var(--text-muted)',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {periodMode === 'range' && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>From</span>
              )}
              <select value={periodMonth} onChange={e => setPeriodMonth(e.target.value)} disabled={running} style={periodSelectStyle}>
                <option value="">Month</option>
                {HISTORY_MONTHS_SHORT.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <input type="number" placeholder="Year" value={periodYear} min="2000" max="2100"
                onChange={e => setPeriodYear(e.target.value)} disabled={running}
                style={{ ...periodSelectStyle, width: 84 }} />
            </div>

            {periodMode === 'range' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>To</span>
                <select value={periodEndMonth} onChange={e => setPeriodEndMonth(e.target.value)} disabled={running} style={periodSelectStyle}>
                  <option value="">Month</option>
                  {HISTORY_MONTHS_SHORT.slice(1).map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <input type="number" placeholder="Year" value={periodEndYear} min="2000" max="2100"
                  onChange={e => setPeriodEndYear(e.target.value)} disabled={running}
                  style={{ ...periodSelectStyle, width: 84 }} />
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={() => setGenerateModalOpen(false)} disabled={running} style={{
            padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700,
            background: 'var(--page-bg)', border: '1px solid var(--card-border)',
            color: 'var(--text-muted)', cursor: running ? 'not-allowed' : 'pointer', fontFamily: 'Barlow',
          }}>
            Cancel
          </button>
          <button onClick={handleRun} disabled={running} className="btn-glow" style={{
            padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            {running
              ? <><Loader2 style={{ width: 15, height: 15 }} className="animate-spin" /> {
                  phase === 'uploading' ? `Uploading ${uploadProgress ?? 0}%`
                  : phase === 'reconciling' ? 'Reconciling…'
                  : phase === 'preparing' ? 'Preparing Excel…'
                  : 'Processing…'
                }</>
              : <><Zap style={{ width: 15, height: 15 }} /> Generate</>
            }
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      {BrandPickerOverlay}
      {GenerateReceivablesModal}
      <div style={{ padding: '24px 28px', maxWidth: 1200 }}>

        {/* Breadcrumb */}
        <button
          onClick={() => navigate(isAdminUser() ? '/admin/agents' : `/brands/${brandId}/agents`)}
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

        {/* Ephemeral-data note + reset — only for the "Other" catch-all brand */}
        <div style={{ marginBottom: 16 }}>
          <OtherBrandReset brandId={effectiveBrandId} onReset={() => setLedgerStatus(null)} />
        </div>

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

        {/* ── Previously Generated Files (Receivable Cycle only) ───────── */}
        {isReceivableCycle && (
          <div className="glass-card" style={{ padding: 20, marginBottom: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <History style={{ width: 15, height: 15, color: 'var(--text-muted)' }} />
                <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', fontFamily: 'Barlow', margin: 0 }}>
                  Previously Generated Files
                </p>
              </div>
              {historyLoading && <Loader2 style={{ width: 14, height: 14, color: 'var(--text-muted)' }} className="animate-spin" />}
            </div>

            {!historyLoading && recoHistory.length === 0 && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                No previous Receivable Cycle runs for this brand yet.
              </p>
            )}

            {recoHistory.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--text-muted)', borderBottom: '1px solid var(--card-border)' }}>
                      <th style={{ padding: '6px 8px', fontWeight: 600 }}>Run Date</th>
                      <th style={{ padding: '6px 8px', fontWeight: 600 }}>Period</th>
                      <th style={{ padding: '6px 8px', fontWeight: 600 }}>Total Rows</th>
                      <th style={{ padding: '6px 8px', fontWeight: 600 }}>Status</th>
                      <th style={{ padding: '6px 8px' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {recoHistory.map(job => (
                      <tr key={job.id} style={{ borderBottom: '1px solid var(--card-border)' }}>
                        <td style={{ padding: '8px', color: 'var(--text-heading)' }}>
                          {job.created_at ? new Date(job.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}
                        </td>
                        <td style={{ padding: '8px', color: 'var(--text-heading)' }}>
                          {formatJobPeriod(job)}
                        </td>
                        <td style={{ padding: '8px', color: 'var(--text-heading)' }}>
                          {(job.total_rows ?? 0).toLocaleString('en-IN')}
                        </td>
                        <td style={{ padding: '8px', color: 'var(--text-heading)', textTransform: 'capitalize' }}>
                          {job.status}
                        </td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <button
                              onClick={() => navigate(`/brands/${effectiveBrandId || brandId}/reco/receivable_cycle/results/${job.output_file_id || job.id}`)}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 5,
                                padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                                background: 'rgba(7,72,238,0.08)', border: '1px solid rgba(7,72,238,0.2)',
                                color: '#0748EE', cursor: 'pointer', fontFamily: 'Barlow',
                              }}
                            >
                              <Eye style={{ width: 12, height: 12 }} />
                              View
                            </button>
                            <button
                              onClick={() => handleDeleteHistoryJob(job)}
                              disabled={deletingJobId === job.id}
                              aria-label="Delete this generated file"
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 5,
                                padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                                background: 'rgba(225,29,72,0.08)', border: '1px solid rgba(225,29,72,0.2)',
                                color: '#E11D48', cursor: deletingJobId === job.id ? 'not-allowed' : 'pointer',
                                opacity: deletingJobId === job.id ? 0.6 : 1, fontFamily: 'Barlow',
                              }}
                            >
                              {deletingJobId === job.id
                                ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" />
                                : <Trash2 style={{ width: 12, height: 12 }} />}
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Upload Form ─────────────────────────────────────────────── */}
        {!result && isReceivableCycle && (
          <div className="glass-card" style={{ padding: 24, marginBottom: 28 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 24, alignItems: 'center' }}>
              <div>
                <p style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: 'var(--text-muted)',
                  fontFamily: 'DM Sans', marginBottom: 16,
                }}>Brand</p>
                <div style={{ maxWidth: 360 }}>{brandSelectorField}</div>
              </div>
              <button
                onClick={() => setGenerateModalOpen(true)}
                disabled={!selectedBrand}
                className="btn-glow"
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '13px 22px', whiteSpace: 'nowrap',
                  opacity: !selectedBrand ? 0.5 : 1,
                  cursor: !selectedBrand ? 'not-allowed' : 'pointer',
                }}
              >
                <Zap style={{ width: 15, height: 15 }} />
                Generate Receivables
              </button>
            </div>
            {!selectedBrand && (
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, marginBottom: 0 }}>
                Select a brand above to enable Generate Receivables.
              </p>
            )}
          </div>
        )}

        {!result && !isReceivableCycle && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, marginBottom: 28 }}>

            {/* Left: Files */}
            <div className="glass-card" style={{ padding: 24 }}>
              <p style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--text-muted)',
                fontFamily: 'DM Sans', marginBottom: 16,
              }}>Upload Files</p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {brandSelectorField}

                {/* File slots */}
                {isDriveMode ? (
                  <GoogleDriveFolderInput value={driveUrl} onChange={setDriveUrl} />
                ) : (
                  activeFiles.map((f, idx) => (
                  <React.Fragment key={f.key}>
                    {f.multiple ? (
                      <MultiFileDropzone
                        fileConfig={f} files={uploadedFiles[f.key] || []}
                        onChange={(arr) => handleFileChange(f.key, arr)}
                        disabled={running} stepIndex={idx}
                      />
                    ) : (
                      <FileDropzone
                        fileConfig={f} file={uploadedFiles[f.key]}
                        onChange={(file) => handleFileChange(f.key, file)}
                        disabled={running} stepIndex={idx}
                      />
                    )}
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
                  ))
                )}

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

                {agentType === 'gstr_3b_tally_entry' && !isDemo && ledgerStatus && (
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', borderRadius: 10,
                    background: ledgerStatus === 'loaded' ? 'rgba(15,118,110,0.06)' : 'rgba(100,116,139,0.05)',
                    border: `1px solid ${ledgerStatus === 'loaded' ? 'rgba(15,118,110,0.2)' : 'var(--card-border)'}`,
                  }}>
                    <Database style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1, color: ledgerStatus === 'loaded' ? '#0F766E' : 'var(--text-muted)' }} />
                    <div>
                      <p style={{ fontSize: 12, fontWeight: 700, fontFamily: 'Barlow', margin: '0 0 2px', color: ledgerStatus === 'loaded' ? '#0F766E' : 'var(--text-muted)' }}>
                        {ledgerStatus === 'loaded' ? '✓ COA saved — ledger names will be auto-matched' : 'No COA saved yet — upload optional COA above to enable ledger matching'}
                      </p>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
                        {ledgerStatus === 'loaded'
                          ? 'Tally ledger names will be matched to your saved Chart of Accounts.'
                          : 'Without COA, default generated ledger names are used (no matching).'}
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
                    background: uploadProgress < 100 ? config.color : '#059669',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
              )}

              {/* Phased progress — shows the user which stage is running and why a
                  large file takes time (the Excel is prepared up-front). */}
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
                              ? <Loader2 style={{ width: 15, height: 15, color: config.color, flexShrink: 0 }} className="animate-spin" />
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
                      Large files can take a minute — the Excel is built now so your download is instant.
                    </p>
                  </div>
                );
              })()}

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

        {/* ── GSTR-3B Tally Entry Results ─────────────────────────────── */}
        {result && is3b && (() => {
          const monthly = result.monthly_data || [];
          const stateSum = result.state_summary || [];
          const activeMon = monthly[active3bMonth] || monthly[0] || {};
          const allMonEntries = activeMon.entries || [];
          const fmt = (n) => typeof n === 'number' ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Download + Reset row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button onClick={handleDownload} disabled={downloading} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
                  borderRadius: 8, fontSize: 13, fontWeight: 700, fontFamily: 'Barlow',
                  background: '#0F766E', color: '#fff', border: 'none', cursor: 'pointer',
                }}>
                  {downloading ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : <Download style={{ width: 14, height: 14 }} />}
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
                  <div style={{ padding: '6px 14px', borderRadius: 8, background: 'rgba(15,118,110,0.06)', border: '1px solid rgba(15,118,110,0.18)', fontSize: 12, color: '#0F766E', fontWeight: 700, fontFamily: 'Barlow' }}>
                    {monthly.length} month{monthly.length !== 1 ? 's' : ''} processed
                  </div>
                  {result.coa_ledgers_parsed?.length > 0 && (
                    <div style={{ padding: '6px 14px', borderRadius: 8, background: 'rgba(5,150,105,0.06)', border: '1px solid rgba(5,150,105,0.18)', fontSize: 12, color: '#059669', fontWeight: 700, fontFamily: 'Barlow' }}>
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
                      padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                      fontFamily: 'Barlow', cursor: 'pointer',
                      background: active3bMonth === idx ? '#0F766E' : 'var(--surface)',
                      color: active3bMonth === idx ? '#fff' : 'var(--text-muted)',
                      border: `1px solid ${active3bMonth === idx ? '#0F766E' : 'var(--card-border)'}`,
                      transition: 'all 0.15s',
                    }}>
                      {m.period || `Month ${idx + 1}`}
                    </button>
                  ))}
                </div>
              )}

              {/* Active month info + stat cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
                {[
                  { label: 'GSTIN', value: activeMon.gstin || '—', raw: true },
                  { label: 'State', value: activeMon.state || '—', raw: true },
                  { label: 'Period', value: activeMon.period || '—', raw: true },
                  { label: 'Voucher Date', value: activeMon.voucher_date || '—', raw: true },
                  { label: 'Total Debit', value: `₹${fmt(activeMon.total_debit)}`, raw: true },
                  { label: 'Total Credit', value: `₹${fmt(activeMon.total_credit)}`, raw: true },
                ].map(({ label, value }) => (
                  <div key={label} style={{
                    background: 'var(--surface)', border: '1px solid var(--card-border)',
                    borderLeft: '4px solid #0F766E', borderRadius: 10, padding: '12px 16px',
                  }}>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#0F766E', fontFamily: 'DM Sans', margin: '0 0 4px' }}>{label}</p>
                    <p style={{ fontSize: 14, fontWeight: 800, fontFamily: 'Barlow', color: 'var(--text-heading)', margin: 0, wordBreak: 'break-all' }}>{value}</p>
                  </div>
                ))}
              </div>

              {/* Sub-tab bar */}
              <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--card-border)', paddingBottom: 0 }}>
                {[['entries', 'Journal Entries'], ['month', 'Month Summary'], ['state', 'State Summary']].map(([key, label]) => (
                  <button key={key} onClick={() => setActive3bSummaryTab(key)} style={{
                    padding: '8px 16px', fontSize: 12, fontWeight: 700, fontFamily: 'Barlow',
                    background: 'none', border: 'none', cursor: 'pointer',
                    borderBottom: `2px solid ${active3bSummaryTab === key ? '#0F766E' : 'transparent'}`,
                    color: active3bSummaryTab === key ? '#0F766E' : 'var(--text-muted)',
                    transition: 'all 0.15s',
                  }}>{label}</button>
                ))}
              </div>

              {/* Journal Entries tab */}
              {active3bSummaryTab === 'entries' && (
                <div className="glass-card" style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <colgroup>
                      <col style={{ width: 50 }} /><col /><col style={{ width: 160 }} />
                      <col style={{ width: 160 }} /><col style={{ width: 120 }} /><col style={{ width: 100 }} />
                    </colgroup>
                    <tbody>
                      {allMonEntries.map((entry, i) => {
                        if (entry._type === 'blank') return <tr key={i}><td colSpan={6} style={{ height: 8 }} /></tr>;
                        if (entry._type === 'section') return (
                          <tr key={i}>
                            <td colSpan={6} style={{ padding: '8px 16px', fontWeight: 800, fontFamily: 'Barlow', fontSize: 13, background: 'rgba(15,118,110,0.08)', color: '#0F766E', borderRadius: 6 }}>
                              {entry.particulars}
                            </td>
                          </tr>
                        );
                        if (entry._type === 'header') return (
                          <tr key={i} style={{ background: 'var(--page-bg)' }}>
                            {['sno', 'particulars', 'debit', 'credit', 'date', 'voucher_type'].map(k => (
                              <th key={k} style={{ padding: '8px 12px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textAlign: k === 'particulars' ? 'left' : 'right', borderBottom: '1px solid var(--card-border)', letterSpacing: '0.04em', textTransform: 'uppercase', fontFamily: 'DM Sans' }}>
                                {entry[k]}
                              </th>
                            ))}
                          </tr>
                        );
                        const isZero = entry.debit === 0 || entry.credit === 0;
                        return (
                          <tr key={i} style={{ opacity: isZero ? 0.5 : 1, borderBottom: '1px solid var(--card-border)' }}>
                            <td style={{ padding: '6px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>{entry.sno}</td>
                            <td style={{ padding: '6px 12px', color: 'var(--text-heading)', fontFamily: 'Barlow', fontWeight: 600 }}>{entry.particulars}</td>
                            <td style={{ padding: '6px 12px', textAlign: 'right', fontFamily: 'monospace', color: typeof entry.debit === 'number' && entry.debit > 0 ? '#059669' : 'var(--text-muted)' }}>
                              {typeof entry.debit === 'number' ? `₹${fmt(entry.debit)}` : ''}
                            </td>
                            <td style={{ padding: '6px 12px', textAlign: 'right', fontFamily: 'monospace', color: typeof entry.credit === 'number' && entry.credit > 0 ? '#E11D48' : 'var(--text-muted)' }}>
                              {typeof entry.credit === 'number' ? `₹${fmt(entry.credit)}` : ''}
                            </td>
                            <td style={{ padding: '6px 12px', textAlign: 'right', fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{entry.date || ''}</td>
                            <td style={{ padding: '6px 12px', textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>{entry.voucher_type || ''}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Month Summary tab */}
              {active3bSummaryTab === 'month' && (
                <div className="glass-card" style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: 'var(--page-bg)' }}>
                        {['Period', 'GSTIN', 'State', 'Total Debit', 'Total Credit', 'J1 Debit', 'J2 Debit', 'J3 Debit'].map(h => (
                          <th key={h} style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textAlign: h === 'GSTIN' || h === 'Period' || h === 'State' ? 'left' : 'right', borderBottom: '1px solid var(--card-border)', textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: 'DM Sans' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {monthly.map((m, idx) => (
                        <tr key={idx} style={{ borderBottom: '1px solid var(--card-border)', background: idx === active3bMonth ? 'rgba(15,118,110,0.04)' : 'transparent' }}>
                          <td style={{ padding: '8px 14px', fontWeight: 700, fontFamily: 'Barlow', color: '#0F766E' }}>{m.period}</td>
                          <td style={{ padding: '8px 14px', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>{m.gstin}</td>
                          <td style={{ padding: '8px 14px', color: 'var(--text-body)' }}>{m.state}</td>
                          {['total_debit', 'total_credit', 'j1_debit', 'j2_debit', 'j3_debit'].map(k => (
                            <td key={k} style={{ padding: '8px 14px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-heading)' }}>₹{fmt(m[k] || 0)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* State Summary tab */}
              {active3bSummaryTab === 'state' && (
                <div className="glass-card" style={{ overflowX: 'auto' }}>
                  {stateSum.length === 0
                    ? <p style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No state data available</p>
                    : (
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ background: 'var(--page-bg)' }}>
                            {['State', 'Code', 'Months', 'Total Debit', 'Total Credit'].map(h => (
                              <th key={h} style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textAlign: h === 'State' ? 'left' : 'right', borderBottom: '1px solid var(--card-border)', textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: 'DM Sans' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {stateSum.map((s, idx) => (
                            <tr key={idx} style={{ borderBottom: '1px solid var(--card-border)' }}>
                              <td style={{ padding: '8px 14px', fontWeight: 700, fontFamily: 'Barlow', color: 'var(--text-heading)' }}>{s.state}</td>
                              <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: '#0F766E', fontWeight: 700 }}>{s.state_short}</td>
                              <td style={{ padding: '8px 14px', textAlign: 'right', color: 'var(--text-body)' }}>{s.months}</td>
                              <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-heading)' }}>₹{fmt(s.total_debit || 0)}</td>
                              <td style={{ padding: '8px 14px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: 'var(--text-heading)' }}>₹{fmt(s.total_credit || 0)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Results ─────────────────────────────────────────────────── */}
        {result && !is3b && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

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

            {/* Action bar — corrections + download + analytics. KPIs, charts and
                status filters now live inside the dashboard below. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
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
                {/* GSTR-1 uses Gstr1Dashboard (no built-in download); every other
                    agent gets its Download Excel button inside ToolResultDashboard. */}
                {agentType === 'gstr_1_vs_books' && (
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
                )}
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
                {agentType === 'universal_bank_statement' && isFloBrand && (
                  <button
                    onClick={() => navigate(`/brands/${effectiveBrandId || brandId}/agents/${BANK_RECO_AGENT_ID}?source_job_id=${result?.job_id}`)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                      borderRadius: 8, fontSize: 12, fontWeight: 700,
                      background: '#0F9D58', color: '#fff', border: 'none', cursor: 'pointer',
                      fontFamily: 'Barlow',
                    }}
                  >
                    Reconcile with Tally
                    <ArrowRight style={{ width: 12, height: 12 }} />
                  </button>
                )}
              </div>
            </div>

            {/* GSTR-1 vs Books dashboard */}
            {agentType === 'gstr_1_vs_books' && (
              <div className="glass-card" style={{ padding: 16 }}>
                <Gstr1Dashboard result={result} />
              </div>
            )}

            {/* Premium tool-output dashboard — KPIs, charts, status filters and
                the row-level table for every non-GSTR-1 agent. The component owns
                filtering and the 200-row cap; we pass the FULL unfiltered rows so
                ledger-edit indices line up with result.results. */}
            {agentType !== 'gstr_1_vs_books' && (
              <ToolResultDashboard
                agentType={agentType}
                summary={result.summary}
                counts={result.counts}
                rows={dashboardRows}
                filter={filter}
                setFilter={setFilter}
                onDownload={handleDownload}
                downloading={downloading}
                isUniversal={isUniversal}
                editedLedgers={editedLedgers}
                setEditedLedgers={setEditedLedgers}
                brandId={effectiveBrandId || brandId}
                jobId={result?.job_id}
                agentLabel={config?.name}
                onSendFeedback={handleSendFeedback}
              />
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default RecoWorkspace;

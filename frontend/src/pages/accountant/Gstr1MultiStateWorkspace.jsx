import { useState, useRef, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LayoutDashboard, Bot, ArrowLeft, Upload, Download, Play, CheckCircle2, RotateCcw,
  FileSpreadsheet, FileText, Loader2, Layers, X, AlertTriangle, ShieldCheck, TrendingUp,
} from 'lucide-react';
import api from '../../lib/api';
import { sidebarFor, isAdminUser } from '../../lib/adminNav';
import { toast } from 'sonner';

// GSTR-1 vs Books — combined mode. One Sales Register for every state, plus any
// number of return files (GSTR-1 as OCTA Excel or GST-portal PDF, GSTR-3B PDF),
// one per state per month. The engine reads the GSTIN and month out of each file,
// so they can be dropped in all together. The single-file flow lives unchanged in
// RecoWorkspace; this page is reached with ?mode=combined.

const COLOR = '#D97706';
const GSTR1_AGENT_ID = '8b8d0876-3169-4511-96d8-2a7467478007';
const GSTIN_RE = /[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]/;
const STATE_CODES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh', '24': 'Gujarat', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};
const AMT = ['taxable', 'igst', 'cgst', 'sgst'];

const fmt = (n) => (n == null || n === '' ? '—'
  : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const tax = (o, p) => (o?.[`${p}_igst`] || 0) + (o?.[`${p}_cgst`] || 0) + (o?.[`${p}_sgst`] || 0);

const Diff = ({ v }) => {
  const abs = Math.abs(v || 0);
  return (
    <span style={{
      fontFamily: 'monospace', fontSize: 12, fontWeight: abs >= 1 ? 700 : 400,
      color: abs < 1 ? 'var(--text-muted)' : 'var(--danger, #DC2626)',
    }}>{fmt(v || 0)}</span>
  );
};

const th = { padding: '8px 10px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid var(--card-border)', fontFamily: 'DM Sans' };
const td = { padding: '7px 10px', fontSize: 12, textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-body)', borderBottom: '1px solid var(--card-border)', whiteSpace: 'nowrap' };
const tdL = { ...td, textAlign: 'left', fontFamily: 'DM Sans' };

// ── Multi-file dropzone ─────────────────────────────────────────────────────
const Drop = ({ label, hint, files, onChange, accept, required, icon: Icon = Upload }) => {
  const ref = useRef(null);
  const [drag, setDrag] = useState(false);
  const add = (list) => {
    const incoming = Array.from(list || []);
    const seen = new Set(files.map(f => `${f.name}|${f.size}`));
    onChange([...files, ...incoming.filter(f => !seen.has(`${f.name}|${f.size}`))]);
  };
  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => ref.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') ref.current?.click(); }}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
        style={{
          padding: '14px 16px', borderRadius: 10, cursor: 'pointer',
          background: files.length ? 'rgba(5,150,105,0.06)' : drag ? 'rgba(217,119,6,0.06)' : 'var(--surface)',
          border: `1px solid ${files.length ? 'rgba(5,150,105,0.25)' : drag ? 'rgba(217,119,6,0.35)' : 'var(--card-border)'}`,
          display: 'flex', alignItems: 'center', gap: 12,
        }}
      >
        <input ref={ref} type="file" multiple accept={accept} className="hidden"
          onChange={e => { add(e.target.files); e.target.value = ''; }} />
        <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--page-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {files.length ? <CheckCircle2 style={{ width: 16, height: 16, color: '#059669' }} /> : <Icon style={{ width: 15, height: 15, color: 'var(--text-muted)' }} />}
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, fontFamily: 'Barlow', color: files.length ? '#059669' : 'var(--text-heading)' }}>
            {files.length ? `${files.length} file${files.length > 1 ? 's' : ''} selected — drop more to add` : label}
            {!files.length && required && <span style={{ color: '#E11D48', marginLeft: 4 }}>*</span>}
          </p>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{hint}</p>
        </div>
      </div>
      {files.length > 0 && files.length <= 6 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {files.map((f, i) => (
            <div key={`${f.name}${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 7, background: 'var(--page-bg)', border: '1px solid var(--card-border)' }}>
              <span style={{ fontSize: 12, flex: 1, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <button onClick={() => onChange(files.filter((_, j) => j !== i))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#E11D48' }}>
                <X style={{ width: 12, height: 12 }} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Return files grouped by the GSTIN in their name (preview only — the engine
//    reads the GSTIN from inside each file) ────────────────────────────────────
const ReturnGroups = ({ files, onChange }) => {
  const groups = useMemo(() => {
    const g = {};
    files.forEach((f, i) => {
      const m = f.name.toUpperCase().match(GSTIN_RE);
      const key = m ? m[0] : 'Unknown';
      const kind = /GSTR[\s_-]?3B/i.test(f.name) ? 'GSTR-3B' : f.name.toLowerCase().endsWith('.pdf') ? 'GSTR-1 PDF' : 'Excel';
      (g[key] = g[key] || []).push({ f, i, kind });
    });
    return g;
  }, [files]);
  if (!files.length) return null;
  return (
    <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {Object.entries(groups).map(([gstin, list]) => {
        const kinds = list.reduce((a, x) => ({ ...a, [x.kind]: (a[x.kind] || 0) + 1 }), {});
        return (
          <div key={gstin} style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--page-bg)', border: '1px solid var(--card-border)', fontSize: 12 }}>
            <div style={{ fontWeight: 700, color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
              {gstin === 'Unknown' ? 'GSTIN read from inside the file' : `${STATE_CODES[gstin.slice(0, 2)] || gstin.slice(0, 2)} · ${gstin}`}
            </div>
            <div style={{ color: 'var(--text-muted)' }}>
              {Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(' · ')}
            </div>
          </div>
        );
      })}
      <button onClick={() => onChange([])} style={{ fontSize: 12, padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(225,29,72,0.2)', background: 'rgba(225,29,72,0.06)', color: '#E11D48', cursor: 'pointer' }}>
        Clear returns
      </button>
    </div>
  );
};

// ── Month table for one registration (or All States) ────────────────────────
const MonthTable = ({ sections, has3b }) => {
  const g1 = (sections?.books_all_vs_gstr1 || []);
  const b3 = Object.fromEntries((sections?.books_all_vs_gstr3b || []).map(r => [r.month, r]));
  const g13 = Object.fromEntries((sections?.gstr1_vs_gstr3b || []).map(r => [r.month, r]));
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Month</th>
            <th style={th}>Books taxable</th><th style={th}>GSTR-1 taxable</th><th style={th}>Diff</th>
            <th style={th}>Books tax</th><th style={th}>GSTR-1 tax</th><th style={th}>Diff</th>
            {has3b && <><th style={th}>GSTR-3B taxable</th><th style={th}>Books − 3B</th><th style={th}>GSTR-1 − 3B</th></>}
          </tr>
        </thead>
        <tbody>
          {g1.map(r => {
            const total = r.month === 'Total';
            const s = total ? { fontWeight: 800, background: 'var(--page-bg)' } : {};
            return (
              <tr key={r.month}>
                <td style={{ ...tdL, ...s }}>{r.month}</td>
                <td style={{ ...td, ...s }}>{fmt(r.books_taxable)}</td>
                <td style={{ ...td, ...s }}>{fmt(r.gstr1_taxable)}</td>
                <td style={{ ...td, ...s }}><Diff v={r.diff_taxable} /></td>
                <td style={{ ...td, ...s }}>{fmt(tax(r, 'books'))}</td>
                <td style={{ ...td, ...s }}>{fmt(tax(r, 'gstr1'))}</td>
                <td style={{ ...td, ...s }}><Diff v={tax(r, 'books') - tax(r, 'gstr1')} /></td>
                {has3b && <>
                  <td style={{ ...td, ...s }}>{b3[r.month] ? fmt(b3[r.month].gstr3b_taxable) : '—'}</td>
                  <td style={{ ...td, ...s }}>{b3[r.month] && b3[r.month].gstr3b_taxable ? <Diff v={b3[r.month].diff_taxable} /> : '—'}</td>
                  <td style={{ ...td, ...s }}>{g13[r.month] && g13[r.month].gstr3b_taxable ? <Diff v={g13[r.month].diff_taxable} /> : '—'}</td>
                </>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default function Gstr1MultiStateWorkspace() {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const resultKey = `reco_result_gstr1_combined_${brandId}`;

  const [sales, setSales] = useState([]);
  const [creditNotes, setCreditNotes] = useState([]);
  const [returns, setReturns] = useState([]);
  const [tolerance, setTolerance] = useState('1.0');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [tab, setTab] = useState('ALL');
  const [result, setResult] = useState(() => {
    try { const c = sessionStorage.getItem(resultKey); return c ? JSON.parse(c) : null; } catch { return null; }
  });

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  const singleMode = () => navigate(`${location.pathname}`);

  const handleRun = async () => {
    if (!sales.length) { toast.error('Add the Sales Register (all states).'); return; }
    if (!returns.length) { toast.error('Add the GSTR-1 / GSTR-3B return files.'); return; }
    setRunning(true); setResult(null); setProgress(0); setTab('ALL');
    try {
      const fd = new FormData();
      fd.append('reco_type', 'gstr_1_vs_books');
      fd.append('gstr1_mode', 'multistate');
      fd.append('tolerance', tolerance);
      fd.append('brand_id', brandId);
      fd.append('is_demo', localStorage.getItem('token') === 'demo-mode-token' ? 'true' : 'false');
      sales.forEach(f => fd.append('tally_sales', f));
      creditNotes.forEach(f => fd.append('credit_note', f));
      returns.forEach(f => fd.append('gstr1_returns', f));
      const res = await api.post('/api/reco/run', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => { if (e.total) setProgress(Math.round((e.loaded / e.total) * 100)); },
      });
      setResult(res.data);
      try {
        // The row-level B2B list can be large; the page does not need it after a refresh.
        const { b2b_ui_rows, ...slim } = res.data;
        sessionStorage.setItem(resultKey, JSON.stringify(slim));
      } catch (_) { /* quota — result stays in memory */ }
      toast.success('Reconciliation complete');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Reconciliation failed');
    } finally { setRunning(false); setProgress(null); }
  };

  const handleDownload = async () => {
    if (!result?.job_id) return;
    setDownloading(true);
    try {
      const r = await api.get(`/api/reco/export/${result.job_id}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement('a'); a.href = url;
      a.download = `GSTR1_vs_Books_All_States_${result.job_id.slice(0, 8)}.xlsx`; a.click();
      window.URL.revokeObjectURL(url);
    } catch { toast.error('Download failed'); } finally { setDownloading(false); }
  };

  const handleReset = () => {
    setResult(null);
    try { sessionStorage.removeItem(resultKey); } catch (_) {}
  };

  const states = result?.states || [];
  const current = tab === 'ALL' ? { sections: result?.gst_reco_sections, has3b: states.some(s => s.gstr3b_available) }
    : (() => { const s = states.find(x => (x.gstin || x.state) === tab); return { sections: s?.sections, has3b: s?.gstr3b_available }; })();
  const flags = (result?.status_grid || []).filter(g => g.flag);
  const remark3 = (result?.b2b_ui_rows || []).filter(r => r.remark3);

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div style={{ padding: '24px 28px', maxWidth: 1280 }}>
        <button onClick={() => navigate(isAdminUser() ? '/admin/agents' : `/brands/${brandId}/agents`)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 20, padding: 0 }}>
          <ArrowLeft style={{ width: 14, height: 14 }} /> All Agents
        </button>

        {/* Identity */}
        <div style={{ borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--card-border)', borderTop: `3px solid ${COLOR}`, padding: '22px 26px', marginBottom: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 14 }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(217,119,6,0.08)', border: '1.5px solid rgba(217,119,6,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <TrendingUp style={{ width: 22, height: 22, color: COLOR }} />
              </div>
              <div>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: COLOR, fontFamily: 'monospace', margin: 0, marginBottom: 4 }}>
                  GSTR-1 · GSTR-3B · BOOKS · ALL STATES · ALL MONTHS
                </p>
                <h1 style={{ fontFamily: 'Barlow', fontWeight: 900, fontSize: 24, color: 'var(--text-heading)', margin: 0, marginBottom: 6 }}>
                  GSTR-1 vs Books — Combined
                </h1>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0, maxWidth: 620, lineHeight: 1.5 }}>
                  One Sales Register for every state, plus every month's returns. Drop all GSTR-1 files
                  (OCTA Excel or GST-portal PDF) and GSTR-3B PDFs together — each is sorted by the GSTIN
                  and month printed inside it.
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {result && (
                <button onClick={handleReset} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: 'var(--page-bg)', border: '1px solid var(--card-border)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  <RotateCcw style={{ width: 13, height: 13 }} /> New run
                </button>
              )}
              <button onClick={singleMode} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: 'var(--page-bg)', border: '1px solid var(--card-border)', color: 'var(--text-body)', cursor: 'pointer' }}>
                Single-file mode
              </button>
            </div>
          </div>
        </div>

        {/* Upload */}
        {!result && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', gap: 18 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="glass-card" style={{ padding: 18 }}>
                <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0, marginBottom: 12 }}>
                  <Layers style={{ width: 14, height: 14, color: COLOR }} /> Books — All States
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Drop label="Tally Sales Register" hint=".xlsx / .xls — one register for every state" files={sales} onChange={setSales} accept=".xlsx,.xls" required icon={FileSpreadsheet} />
                  <Drop label="Credit Note Register (optional)" hint=".xlsx / .xls" files={creditNotes} onChange={setCreditNotes} accept=".xlsx,.xls" icon={FileSpreadsheet} />
                </div>
              </div>
              <div className="glass-card" style={{ padding: 18 }}>
                <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0, marginBottom: 12 }}>
                  <FileText style={{ width: 14, height: 14, color: COLOR }} /> Returns — every state, every month
                </h3>
                <Drop label="GSTR-1 and GSTR-3B files" hint="GSTR-1: OCTA .xlsx or portal .pdf · GSTR-3B: portal .pdf — drop them all at once"
                  files={returns} onChange={setReturns} accept=".xlsx,.xls,.pdf" required icon={FileText} />
                <ReturnGroups files={returns} onChange={setReturns} />
              </div>
            </div>
            <div className="glass-card" style={{ padding: 18, height: 'fit-content' }}>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-muted)', margin: 0, marginBottom: 8 }}>TOLERANCE (₹)</p>
              <input value={tolerance} onChange={e => setTolerance(e.target.value)} type="number" step="0.5"
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--card-border)', background: 'var(--page-bg)', color: 'var(--text-body)', fontFamily: 'monospace', marginBottom: 14 }} />
              <button onClick={handleRun} disabled={running} data-testid="run-gstr1-combined"
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 14px', borderRadius: 10, border: 'none', cursor: running ? 'wait' : 'pointer', background: COLOR, color: '#fff', fontWeight: 800, fontFamily: 'Barlow', fontSize: 15 }}>
                {running ? <Loader2 style={{ width: 16, height: 16 }} className="animate-spin" /> : <Play style={{ width: 16, height: 16 }} />}
                {running ? (progress != null && progress < 100 ? `Uploading ${progress}%` : 'Reconciling…') : 'Run Reconciliation'}
              </button>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.55 }}>
                Books rows are tied to a state from the register's State / Branch column, the voucher type,
                the invoice number, or state-tagged ledgers. Anything that cannot be tied is listed as
                Unassigned — never dropped.
              </p>
            </div>
          </div>
        )}

        {/* Results */}
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              {Object.entries(result.summary || {}).map(([k, v]) => (
                <div key={k} className="glass-card" style={{ padding: '10px 14px', minWidth: 150 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{k}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, fontFamily: 'Barlow', color: 'var(--text-heading)' }}>{typeof v === 'number' && Math.abs(v) > 999 ? fmt(v) : v}</div>
                </div>
              ))}
              <button onClick={handleDownload} disabled={downloading} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: 'none', background: '#0748EE', color: '#fff', fontWeight: 700, cursor: 'pointer', fontFamily: 'Barlow' }}>
                {downloading ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : <Download style={{ width: 14, height: 14 }} />} Download Excel
              </button>
            </div>

            {(result.warnings || []).length > 0 && (
              <div style={{ padding: '12px 16px', borderRadius: 10, background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.25)' }}>
                {(result.warnings || []).map((w, i) => (
                  <p key={i} style={{ display: 'flex', gap: 8, fontSize: 12.5, color: 'var(--text-body)', margin: '3px 0' }}>
                    <AlertTriangle style={{ width: 14, height: 14, color: COLOR, flexShrink: 0, marginTop: 2 }} /> {w}
                  </p>
                ))}
              </div>
            )}

            {/* Per-state summary */}
            <div className="glass-card" style={{ padding: 16 }}>
              <h3 style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0, marginBottom: 10 }}>By registration — full period</h3>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={{ ...th, textAlign: 'left' }}>Registration</th><th style={{ ...th, textAlign: 'left' }}>GSTR-1 source</th>
                    <th style={th}>Books taxable</th><th style={th}>GSTR-1 taxable</th><th style={th}>Diff</th>
                    <th style={th}>Books tax</th><th style={th}>GSTR-1 tax</th><th style={th}>Diff</th><th style={th}>GSTR-3B taxable</th>
                  </tr></thead>
                  <tbody>
                    {(result.state_summary || []).map(s => (
                      <tr key={s.gstin || s.state}>
                        <td style={tdL}><b>{s.state}</b> <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 11 }}>{s.gstin}</span></td>
                        <td style={tdL}>{s.gstr1_source}</td>
                        <td style={td}>{fmt(s.books_taxable)}</td><td style={td}>{fmt(s.gstr1_taxable)}</td><td style={td}><Diff v={s.diff_books_gstr1_taxable} /></td>
                        <td style={td}>{fmt(tax(s, 'books'))}</td><td style={td}>{fmt(tax(s, 'gstr1'))}</td><td style={td}><Diff v={tax(s, 'books') - tax(s, 'gstr1')} /></td>
                        <td style={td}>{s.gstr3b_available ? fmt(s.gstr3b_taxable) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Month-wise */}
            <div className="glass-card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {[{ key: 'ALL', label: 'All States' }, ...states.map(s => ({ key: s.gstin || s.state, label: s.state }))].map(t => (
                  <button key={t.key} onClick={() => setTab(t.key)} style={{
                    padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'Barlow',
                    border: `1px solid ${tab === t.key ? COLOR : 'var(--card-border)'}`,
                    background: tab === t.key ? 'rgba(217,119,6,0.1)' : 'var(--page-bg)',
                    color: tab === t.key ? COLOR : 'var(--text-body)',
                  }}>{t.label}</button>
                ))}
              </div>
              <MonthTable sections={current.sections} has3b={current.has3b} />
            </div>

            {flags.length > 0 && (
              <div className="glass-card" style={{ padding: 16 }}>
                <h3 style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0, marginBottom: 8 }}>Returns to look at</h3>
                {flags.map((g, i) => (
                  <p key={i} style={{ fontSize: 12.5, margin: '3px 0', color: 'var(--text-body)' }}>
                    <b>{g.state} · {g.month}</b> — {g.flag} <span style={{ color: 'var(--text-muted)' }}>(GSTR-1: {g.gstr1}; GSTR-3B: {g.gstr3b})</span>
                  </p>
                ))}
              </div>
            )}

            {remark3.length > 0 && (
              <div className="glass-card" style={{ padding: 16 }}>
                <h3 style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0, marginBottom: 8 }}>Remark 3 — filed under another state</h3>
                {remark3.slice(0, 50).map((r, i) => (
                  <p key={i} style={{ fontSize: 12.5, margin: '3px 0', color: 'var(--text-body)' }}>
                    <b>{r.inv_no || r.g1_inv}</b> ({r.state}) — {r.remark3}
                  </p>
                ))}
                {remark3.length > 50 && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>…and {remark3.length - 50} more in the Excel.</p>}
              </div>
            )}

            <div className="glass-card" style={{ padding: 16 }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0, marginBottom: 8 }}>
                <ShieldCheck style={{ width: 15, height: 15, color: '#059669' }} /> Checks
              </h3>
              {(result.checks || []).map((c, i) => (
                <p key={i} style={{ fontSize: 12.5, margin: '4px 0', color: 'var(--text-body)', display: 'flex', gap: 8 }}>
                  <span style={{ fontWeight: 800, color: c.ok ? '#059669' : '#DC2626', minWidth: 44 }}>{c.ok ? 'OK' : 'CHECK'}</span>
                  <span>{c.check}{c.note ? ` — ${c.note}` : ''}</span>
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

export { GSTR1_AGENT_ID };

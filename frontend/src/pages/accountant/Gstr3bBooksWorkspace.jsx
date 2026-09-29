import { useState, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LayoutDashboard, Bot, ArrowLeft, Upload, Download, Play, CheckCircle2, RotateCcw,
  FileSpreadsheet, FileText, Loader2, Layers, X, AlertTriangle, ShieldCheck, Scale,
} from 'lucide-react';
import api from '../../lib/api';
import { sidebarFor, isAdminUser } from '../../lib/adminNav';
import { toast } from 'sonner';

// GSTR-3B vs Books — one Sales Register for every state (+ optional Credit Note
// Register) against GSTR-3B table 3.1, every state, every month. GSTR-3B arrives as
// the GST-portal PDF (one per GSTIN per month) or an OCTA Excel with a GSTR3B sheet;
// the engine reads the GSTIN and month from inside each file.

const COLOR = '#0F766E';
const GSTIN_RE = /[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]/;
const STATE_CODES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '18': 'Assam',
  '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '32': 'Kerala', '33': 'Tamil Nadu',
  '36': 'Telangana', '37': 'Andhra Pradesh',
};
const STATUS_STYLE = {
  'Matched': { color: '#059669', bg: 'rgba(5,150,105,0.08)' },
  'Short in GSTR-3B': { color: '#DC2626', bg: 'rgba(220,38,38,0.08)' },
  'Excess in GSTR-3B': { color: '#D97706', bg: 'rgba(217,119,6,0.08)' },
};

const fmt = (n) => (n == null || n === '' ? '—'
  : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

const Diff = ({ v }) => {
  if (v == null) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const abs = Math.abs(v);
  return (
    <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: abs >= 1 ? 700 : 400,
      color: abs < 1 ? 'var(--text-muted)' : 'var(--danger, #DC2626)' }}>{fmt(v)}</span>
  );
};

const th = { padding: '8px 10px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid var(--card-border)', fontFamily: 'DM Sans' };
const td = { padding: '7px 10px', fontSize: 12, textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-body)', borderBottom: '1px solid var(--card-border)', whiteSpace: 'nowrap' };
const tdL = { ...td, textAlign: 'left', fontFamily: 'DM Sans' };

const Drop = ({ label, hint, files, onChange, accept, required, icon: Icon = Upload }) => {
  const ref = useRef(null);
  const [drag, setDrag] = useState(false);
  const add = (list) => {
    const seen = new Set(files.map(f => `${f.name}|${f.size}`));
    onChange([...files, ...Array.from(list || []).filter(f => !seen.has(`${f.name}|${f.size}`))]);
  };
  return (
    <div>
      <div role="button" tabIndex={0}
        onClick={() => ref.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') ref.current?.click(); }}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
        style={{
          padding: '14px 16px', borderRadius: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12,
          background: files.length ? 'rgba(5,150,105,0.06)' : drag ? 'rgba(15,118,110,0.06)' : 'var(--surface)',
          border: `1px solid ${files.length ? 'rgba(5,150,105,0.25)' : drag ? 'rgba(15,118,110,0.35)' : 'var(--card-border)'}`,
        }}>
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

const ReturnGroups = ({ files, onChange }) => {
  const groups = useMemo(() => {
    const g = {};
    files.forEach(f => {
      const m = f.name.toUpperCase().match(GSTIN_RE);
      const key = m ? m[0] : 'Unknown';
      g[key] = (g[key] || 0) + 1;
    });
    return g;
  }, [files]);
  if (!files.length) return null;
  return (
    <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {Object.entries(groups).map(([gstin, n]) => (
        <div key={gstin} style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--page-bg)', border: '1px solid var(--card-border)', fontSize: 12 }}>
          <div style={{ fontWeight: 700, color: 'var(--text-heading)', fontFamily: 'Barlow' }}>
            {gstin === 'Unknown' ? 'GSTIN read from inside the file' : `${STATE_CODES[gstin.slice(0, 2)] || gstin.slice(0, 2)} · ${gstin}`}
          </div>
          <div style={{ color: 'var(--text-muted)' }}>{n} file{n > 1 ? 's' : ''}</div>
        </div>
      ))}
      <button onClick={() => onChange([])} style={{ fontSize: 12, padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(225,29,72,0.2)', background: 'rgba(225,29,72,0.06)', color: '#E11D48', cursor: 'pointer' }}>
        Clear returns
      </button>
    </div>
  );
};

// ── The reconciliation, on screen — same eight lines as the Excel report ────────
const LINE_META = {
  'GTS': { title: 'GTS — Gross Total Sales (Books)', color: '#2E75B6' },
  'Returns': { title: '(−) Returns', color: '#C55A11' },
  'Credit Notes': { title: '(−) Credit Notes', color: '#7030A0' },
  'Net Sales': { title: 'Net Sales', color: '#548235', strong: true },
  'Return': { title: 'GSTR-1 / 3B', color: '#138D90' },
  'Difference': { title: 'Difference (GSTR-1/3B − Net Sales)', color: '#BF8F00', strong: true },
  'Inter Sales': { title: '(−) Inter Sales', color: '#767171' },
  'Net Difference': { title: 'Net Difference (Difference − Inter Sales)', color: '#C00000', strong: true },
};
const HEAD_OPTS = [['net', 'Taxable Value'], ['igst', 'IGST'], ['cgst', 'CGST'], ['sgst', 'SGST']];

const ReconCard = ({ report }) => {
  const [period, setPeriod] = useState('FY');
  const [head, setHead] = useState('net');
  const regs = report.registrations || [];
  const cols = [...regs.map(r => ({ key: r.key, label: r.label, gstin: r.gstin })), { key: 'Total', label: 'Total', gstin: 'all registrations' }];
  const valueOf = (line, reg) => {
    const byReg = reg === 'Total' ? report.values[line].Total : report.values[line][reg];
    return (byReg && byReg[period] && byReg[period][head]) ?? 0;
  };
  const isDiff = (line) => line === 'Difference' || line === 'Net Difference';
  const sel = { padding: '6px 10px', borderRadius: 8, border: '1px solid var(--card-border)', background: 'var(--page-bg)', color: 'var(--text-body)', fontSize: 12.5, fontFamily: 'DM Sans' };
  const src = (reg) => {
    if (reg === 'Total' || period === 'FY') return null;
    const d = (report.return_source[reg] || {})[period];
    return d ? `vs ${d}` : 'no return uploaded';
  };
  return (
    <div className="glass-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 15, color: 'var(--text-heading)', margin: 0, flex: 1 }}>
          GSTR-1 / 3B vs Books — Reconciliation{report.fy ? ` · FY ${report.fy}` : ''}
        </h3>
        <select value={period} onChange={e => setPeriod(e.target.value)} style={sel} aria-label="Period">
          <option value="FY">Full year (April–March)</option>
          {report.months.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={head} onChange={e => setHead(e.target.value)} style={sel} aria-label="Tax head">
          {HEAD_OPTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', minWidth: 230 }}>{HEAD_OPTS.find(h => h[0] === head)[1]} · {period === 'FY' ? 'Full year' : period}</th>
              {cols.map(c => (
                <th key={c.key} style={{ ...th, borderLeft: '2px solid var(--card-border)', minWidth: 150 }}>
                  <div style={{ color: 'var(--text-heading)', fontSize: 12 }}>{c.label}</div>
                  <div style={{ fontWeight: 500, fontFamily: 'monospace', fontSize: 10.5 }}>{c.gstin || '—'}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.lines.map(line => {
              const meta = LINE_META[line] || { title: line, color: '#7F7F7F' };
              return (
                <tr key={line} style={meta.strong ? { background: 'var(--page-bg)' } : undefined}>
                  <td style={{ ...tdL, fontWeight: meta.strong ? 800 : 600, borderLeft: `4px solid ${meta.color}` }}>{meta.title}</td>
                  {cols.map(c => {
                    const v = valueOf(line, c.key);
                    return (
                      <td key={c.key} style={{ ...td, borderLeft: '2px solid var(--card-border)', fontWeight: meta.strong || c.key === 'Total' ? 700 : 400 }}>
                        {isDiff(line) ? <Diff v={v} /> : fmt(v)}
                        {line === 'Return' && src(c.key) && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'DM Sans' }}>{src(c.key)}</div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '10px 0 0', lineHeight: 1.5 }}>
        Same figures as the "1-3B vs Books" tab in the Excel — download it to see every month × registration at once,
        with each figure linked to the rows it comes from.
        {!report.lines.includes('Inter Sales') && ' No inter-branch sales in this data, so Difference is the final gap.'}
      </p>
    </div>
  );
};

export default function Gstr3bBooksWorkspace() {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const resultKey = `reco_result_gstr3b_books_${brandId}`;

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

  const handleRun = async () => {
    if (!sales.length) { toast.error('Add the Sales Register (all states).'); return; }
    setRunning(true); setResult(null); setProgress(0); setTab('ALL');
    try {
      const fd = new FormData();
      fd.append('reco_type', 'gstr_3b_vs_books');
      fd.append('tolerance', tolerance);
      fd.append('brand_id', brandId);
      fd.append('is_demo', localStorage.getItem('token') === 'demo-mode-token' ? 'true' : 'false');
      sales.forEach(f => fd.append('tally_sales', f));
      creditNotes.forEach(f => fd.append('credit_note', f));
      returns.forEach(f => fd.append('gstr3b_returns', f));
      const res = await api.post('/api/reco/run', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => { if (e.total) setProgress(Math.round((e.loaded / e.total) * 100)); },
      });
      setResult(res.data);
      try { sessionStorage.setItem(resultKey, JSON.stringify(res.data)); } catch (_) { /* quota */ }
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
      a.download = `GSTR3B_vs_Books_${result.job_id.slice(0, 8)}.xlsx`; a.click();
      window.URL.revokeObjectURL(url);
    } catch { toast.error('Download failed'); } finally { setDownloading(false); }
  };

  const reset = () => { setResult(null); try { sessionStorage.removeItem(resultKey); } catch (_) {} };

  const regs = (result?.summary_rows || []).filter(s => s.gstin);
  const monthRows = (result?.results || []).filter(r => tab === 'ALL' ? true : r.gstin === tab);
  const flags = (result?.status_grid || []).filter(g => g.flag);
  const summaryCards = Object.entries(result?.summary || {}).filter(([k]) => !['total', 'matched', 'unmatched'].includes(k));

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div style={{ padding: '24px 28px', maxWidth: 1280 }}>
        <button onClick={() => navigate(isAdminUser() ? '/admin/agents' : `/brands/${brandId}/agents`)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 20, padding: 0 }}>
          <ArrowLeft style={{ width: 14, height: 14 }} /> All Agents
        </button>

        <div style={{ borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--card-border)', borderTop: `3px solid ${COLOR}`, padding: '22px 26px', marginBottom: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 14 }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: 'rgba(15,118,110,0.08)', border: '1.5px solid rgba(15,118,110,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Scale style={{ width: 22, height: 22, color: COLOR }} />
              </div>
              <div>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: COLOR, fontFamily: 'monospace', margin: 0, marginBottom: 4 }}>
                  GSTR-3B · TABLE 3.1 · BOOKS · ALL STATES · ALL MONTHS
                </p>
                <h1 style={{ fontFamily: 'Barlow', fontWeight: 900, fontSize: 24, color: 'var(--text-heading)', margin: 0, marginBottom: 6 }}>
                  GSTR-3B vs Books
                </h1>
                <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0, maxWidth: 640, lineHeight: 1.5 }}>
                  Compares GSTR-3B outward supplies (3.1(a)+(b), with nil/exempt 3.1(c)) against one Sales Register
                  for every state, month by month. Drop every month's GSTR-3B for every state at once — portal PDF
                  or OCTA Excel.
                </p>
              </div>
            </div>
            {result && (
              <button onClick={reset} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: 'var(--page-bg)', border: '1px solid var(--card-border)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                <RotateCcw style={{ width: 13, height: 13 }} /> New run
              </button>
            )}
          </div>
        </div>

        {!result && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', gap: 18 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="glass-card" style={{ padding: 18 }}>
                <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0, marginBottom: 12 }}>
                  <Layers style={{ width: 14, height: 14, color: COLOR }} /> Books — All States
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Drop label="Tally Sales Register" hint=".xlsx / .xls — every state; extra blocks (stores, credit notes) may follow after a blank line" files={sales} onChange={setSales} accept=".xlsx,.xls" required icon={FileSpreadsheet} />
                  <Drop label="Credit Note Register (optional)" hint=".xlsx / .xls" files={creditNotes} onChange={setCreditNotes} accept=".xlsx,.xls" icon={FileSpreadsheet} />
                </div>
              </div>
              <div className="glass-card" style={{ padding: 18 }}>
                <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0, marginBottom: 12 }}>
                  <FileText style={{ width: 14, height: 14, color: COLOR }} /> Returns — GSTR-3B (or GSTR-1), every state, every month
                </h3>
                <Drop label="GSTR-3B / GSTR-1 files (optional)" hint="GSTR-3B or GSTR-1 — portal .pdf or OCTA .xlsx, every state & month at once. A month with no 3B is compared with its GSTR-1"
                  files={returns} onChange={setReturns} accept=".pdf,.xlsx,.xls" icon={FileText} />
                <ReturnGroups files={returns} onChange={setReturns} />
              </div>
            </div>
            <div className="glass-card" style={{ padding: 18, height: 'fit-content' }}>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-muted)', margin: 0, marginBottom: 8 }}>TOLERANCE (₹)</p>
              <input value={tolerance} onChange={e => setTolerance(e.target.value)} type="number" step="0.5"
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--card-border)', background: 'var(--page-bg)', color: 'var(--text-body)', fontFamily: 'monospace', marginBottom: 14 }} />
              <button onClick={handleRun} disabled={running} data-testid="run-gstr3b-books"
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 14px', borderRadius: 10, border: 'none', cursor: running ? 'wait' : 'pointer', background: COLOR, color: '#fff', fontWeight: 800, fontFamily: 'Barlow', fontSize: 15 }}>
                {running ? <Loader2 style={{ width: 16, height: 16 }} className="animate-spin" /> : <Play style={{ width: 16, height: 16 }} />}
                {running ? (progress != null && progress < 100 ? `Uploading ${progress}%` : 'Reconciling…') : 'Run Reconciliation'}
              </button>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.55 }}>
                Months without a GSTR-3B are listed, not compared. Books rows for a state whose 3B was not uploaded
                are shown separately — never counted against another state.
              </p>
            </div>
          </div>
        )}

        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              {summaryCards.map(([k, v]) => (
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
                {result.warnings.map((w, i) => (
                  <p key={i} style={{ display: 'flex', gap: 8, fontSize: 12.5, color: 'var(--text-body)', margin: '3px 0' }}>
                    <AlertTriangle style={{ width: 14, height: 14, color: '#D97706', flexShrink: 0, marginTop: 2 }} /> {w}
                  </p>
                ))}
              </div>
            )}

            {result.report ? <ReconCard report={result.report} /> : (<>
            {result.books_sections && (
              <div className="glass-card" style={{ padding: 16 }}>
                <h3 style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0, marginBottom: 10 }}>
                  GST Summary — Books{result.fy ? ` FY ${result.fy}` : ''}
                </h3>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={{ ...th, textAlign: 'left' }}>Section</th><th style={{ ...th, textAlign: 'left' }}>State</th>
                      <th style={th}>Net Value</th><th style={th}>CGST</th><th style={th}>SGST</th><th style={th}>IGST</th><th style={th}>Total GST</th>
                    </tr></thead>
                    <tbody>
                      {[['sales', '1. Sales (excl. Interbranch)'], ['interbranch', '2. Interbranch Services'], ['returns', '3. Sales Returns'],
                        ['net', '4. Net Position'], ['total', '5. Total incl. Interbranch']].map(([key, title]) => (
                        (result.books_sections[key] || []).map((x, i) => (
                          <tr key={key + x.state} style={key === 'total' ? { background: 'var(--page-bg)' } : undefined}>
                            <td style={{ ...tdL, fontWeight: 700 }}>{i === 0 ? title : ''}</td><td style={tdL}>{x.state}</td>
                            <td style={td}>{fmt(x.net)}</td><td style={td}>{fmt(x.cgst)}</td><td style={td}>{fmt(x.sgst)}</td><td style={td}>{fmt(x.igst)}</td>
                            <td style={td}>{fmt((x.cgst || 0) + (x.sgst || 0) + (x.igst || 0))}</td>
                          </tr>
                        ))
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="glass-card" style={{ padding: 16 }}>
              <h3 style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0, marginBottom: 10 }}>By registration — months with a GSTR-3B</h3>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={{ ...th, textAlign: 'left' }}>Registration</th><th style={th}>Months</th><th style={th}>Matched</th>
                    <th style={th}>Books taxable</th><th style={th}>Return taxable</th><th style={th}>Diff</th>
                    <th style={th}>Books tax</th><th style={th}>Return tax</th><th style={th}>Diff</th>
                  </tr></thead>
                  <tbody>
                    {(result.summary_rows || []).map(s => {
                      const bt = s.books_cmp_igst + s.books_cmp_cgst + s.books_cmp_sgst;
                      const gt = s.gstr3b_igst + s.gstr3b_cgst + s.gstr3b_sgst;
                      return (
                        <tr key={s.gstin || s.state}>
                          <td style={tdL}><b>{s.state}</b> <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 11 }}>{s.gstin}</span></td>
                          <td style={td}>{s.months_with_3b}</td><td style={td}>{s.matched_months}</td>
                          <td style={td}>{fmt(s.books_cmp_taxable)}</td><td style={td}>{fmt(s.gstr3b_taxable)}</td><td style={td}><Diff v={s.diff_taxable} /></td>
                          <td style={td}>{fmt(bt)}</td><td style={td}>{fmt(gt)}</td><td style={td}><Diff v={s.diff_tax} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            </>)}

            <div className="glass-card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {[{ key: 'ALL', label: 'All registrations' }, ...regs.map(s => ({ key: s.gstin, label: s.state }))].map(t => (
                  <button key={t.key} onClick={() => setTab(t.key)} style={{
                    padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'Barlow',
                    border: `1px solid ${tab === t.key ? COLOR : 'var(--card-border)'}`,
                    background: tab === t.key ? 'rgba(15,118,110,0.1)' : 'var(--page-bg)',
                    color: tab === t.key ? COLOR : 'var(--text-body)',
                  }}>{t.label}</button>
                ))}
              </div>
              <div style={{ overflowX: 'auto', maxHeight: 520 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={{ ...th, textAlign: 'left' }}>Registration</th><th style={{ ...th, textAlign: 'left' }}>Month</th>
                    <th style={th}>Books taxable</th><th style={th}>Return taxable</th><th style={th}>Diff</th>
                    <th style={th}>Books tax</th><th style={th}>Return tax</th><th style={th}>Diff</th>
                    <th style={th}>Nil/Exempt (Books · 3B)</th><th style={{ ...th, textAlign: 'left' }}>Status</th>
                  </tr></thead>
                  <tbody>
                    {monthRows.map((r, i) => {
                      const st = r.status || '';
                      const s = st.startsWith('Matched') ? STATUS_STYLE['Matched']
                        : (st.startsWith('Short') || st.endsWith('filed Nil')) ? STATUS_STYLE['Short in GSTR-3B']
                        : st.startsWith('Excess') ? STATUS_STYLE['Excess in GSTR-3B'] : null;
                      return (
                        <tr key={i}>
                          <td style={tdL}>{r.state}</td><td style={tdL}>{r.month}</td>
                          <td style={td}>{fmt(r.books_taxable)}</td><td style={td}>{fmt(r.gstr3b_taxable)}</td><td style={td}><Diff v={r.diff_taxable} /></td>
                          <td style={td}>{fmt(r.books_tax)}</td><td style={td}>{fmt(r.gstr3b_tax)}</td><td style={td}><Diff v={r.diff_tax} /></td>
                          <td style={td}>{r.books_exempt ? fmt(r.books_exempt) : '—'} · {r.gstr3b_exempt != null ? fmt(r.gstr3b_exempt) : '—'}</td>
                          <td style={tdL}>
                            <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11.5, fontWeight: 700,
                              color: s ? s.color : 'var(--text-muted)', background: s ? s.bg : 'var(--page-bg)' }}>{r.status}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {flags.length > 0 && (
              <div className="glass-card" style={{ padding: 16 }}>
                <h3 style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0, marginBottom: 8 }}>
                  Months with sales but no GSTR-3B or GSTR-1 uploaded ({flags.length})
                </h3>
                <p style={{ fontSize: 12.5, color: 'var(--text-body)', margin: 0, lineHeight: 1.7 }}>
                  {flags.map(g => `${g.state} · ${g.month}`).join('  ·  ')}
                </p>
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

            {(result.notes || []).length > 0 && (
              <div className="glass-card" style={{ padding: 16 }}>
                <h3 style={{ fontFamily: 'Barlow', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)', margin: 0, marginBottom: 8 }}>Notes / Data-Quality Flags</h3>
                {result.notes.map((n, i) => (
                  <p key={i} style={{ fontSize: 12.5, margin: '4px 0', color: 'var(--text-body)', lineHeight: 1.55 }}>{i + 1}. {n}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

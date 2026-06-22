import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LayoutDashboard, Bot, ArrowLeft, Play, Download, ShoppingCart,
  CheckCircle2, AlertTriangle, XCircle, Loader2, Link as LinkIcon,
  FileSpreadsheet, FolderOpen, Copy, CheckSquare, Info, RotateCcw,
} from 'lucide-react';
import api, { API_URL } from '../../lib/api';
import { sidebarFor, isAdminUser } from '../../lib/adminNav';
import { toast } from 'sonner';

// API_URL resolves at runtime: localhost → http://localhost:8001; tunnel host → '' (same-origin).
// Never bake REACT_APP_BACKEND_URL — it breaks the ngrok tunnel.
const tokenParam = () => encodeURIComponent(localStorage.getItem('token') || 'demo-mode-token');

const MtrWorkspace = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();

  const [folderLink, setFolderLink] = useState('');
  const [config, setConfig] = useState(null);          // { configured, serviceAccount }
  const [status, setStatus] = useState('idle');        // idle | running | done | error
  const [jobId, setJobId] = useState(null);
  const [feed, setFeed] = useState([]);                // progress lines
  const [counts, setCounts] = useState({ b2c: 0, b2b: 0, vendors: 0, total: 0, scanned: 0 });
  const [summary, setSummary] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [needShare, setNeedShare] = useState(false);

  const esRef = useRef(null);
  const pollRef = useRef(null);
  const feedEndRef = useRef(null);

  useEffect(() => {
    api.get('/api/mtr/config').then(r => setConfig(r.data)).catch(() => setConfig({ configured: false }));
    return () => { if (esRef.current) esRef.current.close(); if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [feed]);

  const pushFeed = (line) => setFeed(prev => [...prev, { ...line, key: prev.length }]);

  const handleEvent = (evt) => {
    switch (evt.type) {
      case 'start':
        setCounts(c => ({ ...c, total: evt.vendors }));
        pushFeed({ kind: 'info', text: `Scanning “${evt.folderName}” — ${evt.vendors} vendor folders` });
        break;
      case 'vendor':
        setCounts(c => ({ ...c, scanned: evt.index }));
        pushFeed({ kind: 'vendor', text: `${evt.name}`, sub: `${evt.index}/${evt.total}` });
        break;
      case 'file':
        if (evt.rows > 0) {
          setCounts(c => ({
            ...c,
            b2c: c.b2c + (evt.dtype === 'B2C' ? evt.rows : 0),
            b2b: c.b2b + (evt.dtype === 'B2B' ? evt.rows : 0),
          }));
          pushFeed({ kind: 'ok', dtype: evt.dtype, text: `${evt.dtype} · ${evt.vendor} · ${evt.month}`, rows: evt.rows });
        }
        break;
      case 'skip':
        pushFeed({ kind: 'skip', text: `${evt.vendor}`, sub: evt.reason });
        break;
      case 'error':
        pushFeed({ kind: 'err', text: `${evt.vendor}${evt.file ? ' · ' + evt.file : ''}`, sub: evt.message });
        break;
      case 'complete':
        if (evt.status === 'done') {
          setStatus('done');
          setSummary(evt.summary);
          setCounts(c => ({ ...c, vendors: evt.summary.vendorsWithData }));
        } else {
          setStatus('error');
          setErrorMsg(evt.error || 'Processing failed');
        }
        if (esRef.current) esRef.current.close();
        break;
      default: break;
    }
  };

  const startRun = async () => {
    setErrorMsg(null); setNeedShare(false); setSummary(null);
    setFeed([]); setCounts({ b2c: 0, b2b: 0, vendors: 0, total: 0, scanned: 0 });

    let res;
    try {
      res = await api.post('/api/mtr/run', { folderLink });
    } catch (e) {
      const data = e.response?.data;
      if (e.response?.status === 403) {
        setNeedShare(true);
        setErrorMsg(data?.error || 'Cannot access that folder.');
      } else if (e.response?.status === 503) {
        setErrorMsg(data?.error || 'Google Drive is not configured on the server.');
      } else {
        setErrorMsg(data?.error || 'Could not start the run.');
      }
      setStatus('error');
      return;
    }

    const id = res.data.jobId;
    setJobId(id);
    setStatus('running');

    const es = new EventSource(`${API_URL}/api/mtr/stream/${id}?token=${tokenParam()}`);
    esRef.current = es;
    es.onmessage = (m) => { try { handleEvent(JSON.parse(m.data)); } catch { /* ignore */ } };
    es.onerror = () => {
      // SSE blocked/closed (e.g. ngrok). Fall back to polling status until the job finishes.
      es.close();
      if (pollRef.current) return; // already polling
      pollRef.current = setInterval(async () => {
        try {
          const r = await api.get(`/api/mtr/status/${id}`);
          if (r.data.status === 'done') { clearInterval(pollRef.current); pollRef.current = null; handleEvent({ type: 'complete', status: 'done', summary: r.data.summary }); }
          else if (r.data.status === 'error') { clearInterval(pollRef.current); pollRef.current = null; handleEvent({ type: 'complete', status: 'error', error: r.data.error }); }
        } catch { /* keep polling */ }
      }, 4000);
    };
  };

  const download = async () => {
    try {
      const res = await api.get(`/api/mtr/download/${jobId}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `MTR_${(summary?.folderName || 'Report').replace(/[^a-z0-9]+/gi, '_')}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { toast.error('Download failed'); }
  };

  const reset = async () => {
    if (jobId) { try { await api.delete(`/api/mtr/reset/${jobId}`); } catch { /* ignore */ } }
    if (esRef.current) esRef.current.close();
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setStatus('idle'); setJobId(null); setSummary(null); setErrorMsg(null);
    setNeedShare(false); setFeed([]); setCounts({ b2c: 0, b2b: 0, vendors: 0, total: 0, scanned: 0 });
    toast.success('Cleared — workbook removed from server');
  };

  const copyEmail = () => {
    if (config?.serviceAccount) {
      navigator.clipboard.writeText(config.serviceAccount);
      toast.success('Service account email copied');
    }
  };

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot },
    { path: '/tasks', label: 'Tasks', icon: CheckSquare },
  ]);

  const running = status === 'running';
  const progressPct = counts.total ? Math.round((counts.scanned / counts.total) * 100) : 0;

  const feedIcon = (k) => {
    if (k === 'ok') return <CheckCircle2 className="w-3.5 h-3.5" style={{ color: '#059669' }} />;
    if (k === 'skip') return <AlertTriangle className="w-3.5 h-3.5" style={{ color: '#D97706' }} />;
    if (k === 'err') return <XCircle className="w-3.5 h-3.5" style={{ color: '#E11D48' }} />;
    if (k === 'vendor') return <FolderOpen className="w-3.5 h-3.5" style={{ color: 'var(--blue-primary, #0748EE)' }} />;
    return <Info className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />;
  };

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6 max-w-5xl">

        <button onClick={() => navigate(isAdminUser() ? '/admin/agents' : `/brands/${brandId}/reco`)}
          className="flex items-center gap-1.5 text-sm mb-6 group transition-colors"
          style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
          Reconciliation Suite
        </button>

        {/* Header */}
        <div className="flex items-start gap-4 mb-8">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(217,119,6,0.10)', border: '1px solid rgba(217,119,6,0.25)' }}>
            <ShoppingCart className="w-6 h-6" style={{ color: '#D97706' }} />
          </div>
          <div>
            <h1 className="text-2xl font-black mb-1" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow', letterSpacing: '-0.02em' }}>
              Amazon MTR Consolidator
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-muted)', maxWidth: 560 }}>
              Pulls every reseller's B2B &amp; B2C Merchant Tax Reports from one Drive folder and merges
              them into a single workbook — Vendor Name and Month added so you can filter at will.
            </p>
          </div>
        </div>

        {/* Input card */}
        <div className="rounded-2xl p-5 mb-6"
          style={{ background: 'var(--surface)', border: '1px solid var(--card-border, var(--border))' }}>
          <label className="text-xs font-bold uppercase tracking-wide mb-2 block" style={{ color: 'var(--text-muted)' }}>
            Reseller Data — Google Drive folder link
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} />
              <input
                value={folderLink}
                onChange={e => setFolderLink(e.target.value)}
                disabled={running}
                placeholder="https://drive.google.com/drive/folders/…"
                className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm outline-none"
                style={{ background: 'var(--page-bg)', border: '1.5px solid var(--border)', color: 'var(--text-heading)' }}
              />
            </div>
            <button
              onClick={startRun}
              disabled={running || !folderLink.trim()}
              className="px-5 py-2.5 rounded-xl text-sm font-bold text-white flex items-center gap-2 transition-all disabled:opacity-50"
              style={{ background: running ? '#94A3B8' : '#D97706' }}>
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {running ? 'Running…' : 'Run Consolidation'}
            </button>
          </div>

          {/* Share hint */}
          {config && config.serviceAccount && (
            <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              <Info className="w-3.5 h-3.5 flex-shrink-0" />
              <span>Share the folder (Viewer) with</span>
              <code className="px-1.5 py-0.5 rounded" style={{ background: 'var(--page-bg)', border: '1px solid var(--border)' }}>
                {config.serviceAccount}
              </code>
              <button onClick={copyEmail} className="inline-flex items-center gap-1 hover:opacity-70">
                <Copy className="w-3 h-3" /> copy
              </button>
            </div>
          )}
          {config && !config.configured && (
            <p className="mt-3 text-xs" style={{ color: '#E11D48' }}>
              ⚠ Google Drive isn't configured on the server (missing service-account key).
            </p>
          )}
        </div>

        {/* Error / share-needed */}
        {errorMsg && (
          <div className="rounded-xl p-4 mb-6 text-sm"
            style={{ background: 'rgba(225,29,72,0.06)', border: '1px solid rgba(225,29,72,0.25)', color: '#E11D48' }}>
            <div className="font-semibold mb-1 flex items-center gap-2"><XCircle className="w-4 h-4" /> {errorMsg}</div>
            {needShare && config?.serviceAccount && (
              <div style={{ color: 'var(--text-muted)' }}>
                Open the folder in Drive → Share → add <strong>{config.serviceAccount}</strong> as Viewer, then run again.
              </div>
            )}
          </div>
        )}

        {/* Live counters */}
        {(running || status === 'done') && (
          <div className="grid grid-cols-3 gap-4 mb-6">
            {[
              { label: 'B2C rows', value: counts.b2c.toLocaleString(), color: '#0748EE' },
              { label: 'B2B rows', value: counts.b2b.toLocaleString(), color: '#D97706' },
              { label: status === 'done' ? 'Vendors with data' : 'Vendors scanned',
                value: status === 'done' ? counts.vendors : `${counts.scanned}/${counts.total || '…'}`, color: '#059669' },
            ].map(s => (
              <div key={s.label} className="rounded-2xl p-4"
                style={{ background: 'var(--surface)', border: '1px solid var(--card-border, var(--border))' }}>
                <div className="text-2xl font-black" style={{ color: s.color, fontFamily: 'Barlow' }}>{s.value}</div>
                <div className="text-xs font-semibold mt-0.5" style={{ color: 'var(--text-muted)' }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Progress bar */}
        {running && (
          <div className="h-1.5 rounded-full mb-4 overflow-hidden" style={{ background: 'var(--border)' }}>
            <div className="h-full rounded-full transition-all duration-300"
              style={{ width: `${progressPct}%`, background: 'linear-gradient(90deg,#D97706,#0748EE)' }} />
          </div>
        )}

        {/* Done summary + download */}
        {status === 'done' && summary && (
          <div className="rounded-2xl p-5 mb-6"
            style={{ background: 'rgba(5,150,105,0.06)', border: '1px solid rgba(5,150,105,0.25)' }}>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="flex items-center gap-2 font-bold mb-1" style={{ color: '#059669' }}>
                  <CheckCircle2 className="w-5 h-5" /> Consolidation complete
                </div>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {summary.b2cRows.toLocaleString()} B2C + {summary.b2bRows.toLocaleString()} B2B rows ·
                  {' '}{summary.filesProcessed} files · {summary.vendorsWithData} vendors with data · {summary.vendorsSkipped} skipped
                  {(summary.b2cSplit || summary.b2bSplit) ? ' · split into month tabs (size)' : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={download}
                  className="px-5 py-2.5 rounded-xl text-sm font-bold text-white flex items-center gap-2"
                  style={{ background: '#059669' }}>
                  <Download className="w-4 h-4" /> Download workbook
                </button>
                <button onClick={reset}
                  className="px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                  title="Remove the workbook from the server and clear this result">
                  <RotateCcw className="w-4 h-4" /> Reset
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Progress feed */}
        {feed.length > 0 && (
          <div className="rounded-2xl overflow-hidden"
            style={{ background: 'var(--surface)', border: '1px solid var(--card-border, var(--border))' }}>
            <div className="px-4 py-2.5 text-xs font-bold uppercase tracking-wide flex items-center gap-2"
              style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
              <FileSpreadsheet className="w-3.5 h-3.5" /> Live progress
            </div>
            <div className="max-h-96 overflow-y-auto p-2">
              {feed.map(f => (
                <div key={f.key} className="flex items-center gap-2.5 px-2 py-1.5 text-sm">
                  {feedIcon(f.kind)}
                  <span className="flex-1 truncate" style={{
                    color: f.kind === 'vendor' ? 'var(--text-heading)' : 'var(--text-muted)',
                    fontWeight: f.kind === 'vendor' ? 700 : 400,
                  }}>
                    {f.text}
                    {f.sub && <span className="ml-2 opacity-70">— {f.sub}</span>}
                  </span>
                  {f.rows != null && (
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0"
                      style={{ background: f.dtype === 'B2C' ? 'rgba(7,72,238,0.10)' : 'rgba(217,119,6,0.10)',
                        color: f.dtype === 'B2C' ? '#0748EE' : '#D97706' }}>
                      {f.rows.toLocaleString()} rows
                    </span>
                  )}
                </div>
              ))}
              <div ref={feedEndRef} />
            </div>
          </div>
        )}

      </div>
    </DashboardLayout>
  );
};

export default MtrWorkspace;

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Bot, Upload, FileText, X, Download, ChevronRight, ChevronDown,
  RotateCcw, AlertTriangle, CheckCircle2, Loader2, Link2, Trash2,
} from 'lucide-react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { sidebarFor } from '../../lib/adminNav';
import api, { API_URL } from '../../lib/api';
import OpenInSheetsButton from '../../components/OpenInSheetsButton';
import { toast } from 'sonner';

// red / yellow / green — mirrors InvoiceAgentWorkspace's status palette
const STATUS = {
  'Extracted':        { bg: '#ECFDF5', border: '#D1FAE5', color: '#065F46', dot: '#16A34A' },
  'Needs Review':     { bg: '#FFFBEB', border: '#FEF3C7', color: '#92400E', dot: '#D97706' },
  'Not an E-Invoice': { bg: '#FEF2F2', border: '#FEE2E2', color: '#991B1B', dot: '#DC2626' },
  'Invalid':          { bg: '#FEF2F2', border: '#FEE2E2', color: '#991B1B', dot: '#DC2626' },
};
const money = (n) => (n == null || n === '' ? '' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export default function EInvoiceWorkspace() {
  const { brandId, agentId } = useParams();
  const navigate = useNavigate();

  const [mode, setMode] = useState('upload');       // 'upload' | 'drive'
  const [files, setFiles] = useState([]);           // File[]
  const [driveUrl, setDriveUrl] = useState('');
  const [dragging, setDragging] = useState(false);

  const [processing, setProcessing] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);

  const [invoices, setInvoices] = useState(null);   // per-invoice groups (cards)
  const [jobId, setJobId] = useState(null);
  const [counts, setCounts] = useState(null);
  const [openIdx, setOpenIdx] = useState(null);     // expanded card
  const [previewUrl, setPreviewUrl] = useState(null);

  const sseAbortRef = useRef(null);
  const fileMapRef = useRef({});                    // filename -> File (for PDF preview)
  const inputRef = useRef(null);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  // ── live "X of N" counter via fetch-based SSE (Bearer token) ──────────────
  const connectSse = useCallback(() => {
    if (sseAbortRef.current) sseAbortRef.current.abort();
    const ac = new AbortController();
    sseAbortRef.current = ac;
    const token = localStorage.getItem('token');
    const url = `${API_URL}/api/brands/${brandId}/agents/${agentId}/einvoice/status`;
    (async () => {
      try {
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: ac.signal });
        if (!resp.ok || !resp.body) return;
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done: rdone, value } = await reader.read();
          if (rdone) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n'); buf = parts.pop();
          for (const line of parts) {
            if (!line.startsWith('data: ')) continue;
            try {
              const p = JSON.parse(line.slice(6));
              if (p.status === 'processing' || p.status === 'progress') {
                setProcessing(true);
                if (p.total != null) setTotal(p.total);
                if (p.done != null) setDone(p.done);
              } else if (p.status === 'cancelled') {
                setProcessing(false);
              }
            } catch (_) { /* ignore */ }
          }
        }
      } catch (_) { /* aborted / gone */ }
    })();
  }, [brandId, agentId]);

  // Load past extractions (history) on mount — like Invoice Process.
  const fetchHistory = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/brands/${brandId}/agents/${agentId}/einvoices`);
      if (Array.isArray(data) && data.length) {
        setInvoices(data);
        setCounts(null);   // counts derived from rows for the history view
      }
    } catch (_) { /* no history yet */ }
  }, [brandId, agentId]);
  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const addFiles = (list) => {
    const pdfs = [...list].filter((f) => /\.pdf$/i.test(f.name));
    if (!pdfs.length) { toast.error('Only PDF e-invoices are supported'); return; }
    pdfs.forEach((f) => { fileMapRef.current[f.name] = f; });
    setFiles((prev) => [...prev, ...pdfs]);
  };
  const removeFile = (name) => setFiles((prev) => prev.filter((f) => f.name !== name));

  const handleProcess = async () => {
    if (mode === 'upload' && !files.length) { toast.error('Add e-invoice PDF(s)'); return; }
    if (mode === 'drive' && !driveUrl.trim()) { toast.error('Paste a Google Drive folder link'); return; }
    setProcessing(true); setInvoices(null); setJobId(null); setOpenIdx(null); setCounts(null);
    setDone(0); setTotal(mode === 'upload' ? files.length : 0);
    connectSse();
    try {
      const fd = new FormData();
      if (mode === 'upload') files.forEach((f) => fd.append('files', f));
      else fd.append('drive_url', driveUrl.trim());
      const { data } = await api.post(
        `/api/brands/${brandId}/agents/${agentId}/einvoice/process`, fd,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 },
      );
      setJobId(data.job_id || null);
      setFiles([]); setDriveUrl('');   // clear inputs so the next run starts fresh
      await fetchHistory();            // reload the ACCUMULATED history (all runs), not just this one
      const c = data.counts || {};
      toast.success(`Done — ${c.approved || 0} extracted · ${c.review || 0} to review · ${c.invalid || 0} rejected`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Processing failed');
    } finally {
      setProcessing(false);
      if (sseAbortRef.current) sseAbortRef.current.abort();
    }
  };

  const handleCancel = async () => {
    try { await api.post(`/api/brands/${brandId}/agents/${agentId}/einvoice/cancel`, {}); } catch (_) { /* */ }
    setProcessing(false);
    if (sseAbortRef.current) sseAbortRef.current.abort();
    toast.info('Cancelled');
  };

  const handleDownload = async () => {
    if (!jobId) return;
    try {
      const res = await api.get(`/api/reco/export/${jobId}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = `e-invoice-register_${String(jobId).slice(0, 8)}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch (_) { toast.error('Download failed'); }
  };

  // Delete ONE e-invoice (row + PDF from DB) — removes it from the list.
  const handleDeleteOne = async (inv, idx, e) => {
    if (e) e.stopPropagation();
    if (!window.confirm('Delete this e-invoice? This removes it from history and cannot be undone.')) return;
    if (inv?.id) { try { await api.delete(`/api/brands/${brandId}/agents/${agentId}/einvoices/${inv.id}`); } catch (_) { /* */ } }
    setInvoices((prev) => (prev || []).filter((_, i) => i !== idx));
    if (openIdx === idx) { setOpenIdx(null); setPreviewUrl(null); }
  };

  // Delete All — like Reset (clears the view / frees the run) AND purges every
  // e-invoice for this brand+agent from the DB + disk.
  const handleDeleteAll = async () => {
    if (!window.confirm('Delete ALL extracted e-invoices? This clears the screen and permanently removes them from the database. This cannot be undone.')) return;
    try { await api.delete(`/api/brands/${brandId}/agents/${agentId}/einvoices`); } catch (_) { /* */ }
    setInvoices(null); setFiles([]); setDriveUrl(''); setJobId(null); setOpenIdx(null); setPreviewUrl(null); setCounts(null);
    toast.success('All e-invoices deleted');
  };

  const openCard = (idx) => {
    if (openIdx === idx) { setOpenIdx(null); setPreviewUrl(null); return; }
    setOpenIdx(idx);
    const inv = invoices[idx];
    const f = fileMapRef.current[inv?.filename];
    if (f) { setPreviewUrl(URL.createObjectURL(f)); return; }        // current run: local file
    if (inv?.id && inv?.has_pdf) {                                    // history: stored PDF
      const token = localStorage.getItem('token');
      setPreviewUrl(`${API_URL}/api/brands/${brandId}/agents/${agentId}/einvoice/pdf/${inv.id}?token=${token}`);
      return;
    }
    setPreviewUrl(null);
  };

  const stat = (label, value, color) => (
    <div className="stat-card" style={{ flex: '1 1 140px' }}>
      <div className="text-2xl font-black" style={{ color: color || '#0F172A', fontFamily: 'Barlow' }}>{value}</div>
      <div className="text-xs font-semibold" style={{ color: '#64748B' }}>{label}</div>
    </div>
  );

  const c = counts || (invoices ? {
    total: invoices.length,
    approved: invoices.filter((i) => i.status === 'Extracted').length,
    review: invoices.filter((i) => i.status === 'Needs Review').length,
    invalid: invoices.filter((i) => i.status === 'Not an E-Invoice' || i.status === 'Invalid').length,
  } : {});

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6 max-w-7xl">
        <button onClick={() => navigate(`/brands/${brandId}/agents`)} className="text-sm mb-4 hover:text-blue-600" style={{ color: '#64748B' }}>← All Agents</button>

        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="flex items-start gap-4 min-w-0">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg,#0748EE,#7C3AED)' }}>
              <FileText className="w-6 h-6" style={{ color: '#fff' }} />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-bold tracking-widest mb-0.5" style={{ color: '#94A3B8' }}>GST · E-INVOICE</div>
              <h1 className="text-2xl font-black leading-tight" style={{ color: '#0F172A', fontFamily: 'Barlow', letterSpacing: '-0.02em' }}>E-Invoice Extraction</h1>
              <p className="text-xs mt-1" style={{ color: '#64748B' }}>Upload GST e-invoice PDFs (or a Drive folder) → the 3-sheet e-Invoice Register, extracted deterministically.</p>
            </div>
          </div>
          {invoices && (
            <button onClick={handleDeleteAll}
              className="px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-1.5 flex-shrink-0"
              style={{ background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA' }}>
              <Trash2 className="w-3.5 h-3.5" /> Delete All
            </button>
          )}
        </div>

        {/* Input */}
        <div className="glass-card p-5 mb-6">
          <div className="flex items-center gap-1 mb-4">
            {[['upload', 'Upload files', Upload], ['drive', 'From Google Drive', Link2]].map(([m, label, Icon]) => (
              <button key={m} onClick={() => setMode(m)} className="px-3 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-1.5"
                style={mode === m ? { background: '#E8EFFE', color: '#0748EE' } : { color: '#64748B' }}>
                <Icon className="w-3.5 h-3.5" /> {label}
              </button>
            ))}
          </div>

          {mode === 'upload' ? (
            <>
              <div onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
                onClick={() => inputRef.current?.click()}
                className="rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors"
                style={{ borderColor: dragging ? '#0748EE' : '#CBD5E1', background: dragging ? '#F0F6FF' : '#F8FAFC' }}>
                <Upload className="w-6 h-6 mx-auto mb-2" style={{ color: '#0748EE' }} />
                <div className="text-sm font-semibold" style={{ color: '#334155' }}>Drop e-invoice PDFs here, or click to browse</div>
                <div className="text-xs mt-1" style={{ color: '#94A3B8' }}>Multiple files supported — one e-invoice per PDF</div>
                <input ref={inputRef} type="file" accept=".pdf" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
              </div>
              {files.length > 0 && (
                <div className="mt-3 flex flex-col gap-1.5 max-h-40 overflow-auto">
                  {files.map((f) => (
                    <div key={f.name} className="flex items-center justify-between text-xs px-3 py-1.5 rounded-lg" style={{ background: '#F1F5F9' }}>
                      <span className="flex items-center gap-1.5 truncate" style={{ color: '#334155' }}><FileText className="w-3.5 h-3.5 flex-shrink-0" /> {f.name}</span>
                      <button onClick={() => removeFile(f.name)}><X className="w-3.5 h-3.5" style={{ color: '#94A3B8' }} /></button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <input value={driveUrl} onChange={(e) => setDriveUrl(e.target.value)} placeholder="https://drive.google.com/drive/folders/…"
              className="w-full px-3 py-2 rounded-lg border text-sm" style={{ borderColor: '#CBD5E1' }} />
          )}

          <div className="flex items-center gap-2 mt-4">
            {!processing ? (
              <button onClick={handleProcess} className="px-5 py-2.5 rounded-lg text-sm font-bold text-white flex items-center gap-2" style={{ background: '#0748EE' }}>
                <FileText className="w-4 h-4" /> Process
              </button>
            ) : (
              <>
                <button disabled className="px-5 py-2.5 rounded-lg text-sm font-bold text-white flex items-center gap-2 opacity-80" style={{ background: '#0748EE' }}>
                  <Loader2 className="w-4 h-4 animate-spin" /> Processing {done} of {total || '…'}
                </button>
                <button onClick={handleCancel} className="px-4 py-2.5 rounded-lg text-sm font-bold text-white flex items-center gap-1.5" style={{ background: '#DC2626' }}>
                  <X className="w-4 h-4" /> Cancel
                </button>
              </>
            )}
          </div>
          {processing && total > 0 && (
            <div className="mt-3 h-2 rounded-full overflow-hidden" style={{ background: '#E2E8F0' }}>
              <div className="h-full transition-all" style={{ width: `${Math.round((done / total) * 100)}%`, background: '#0748EE' }} />
            </div>
          )}
        </div>

        {/* Results */}
        {invoices && (
          <>
            <div className="flex gap-3 mb-4 flex-wrap items-center">
              {stat('Total', c.total ?? invoices.length)}
              {stat('Extracted', c.approved ?? 0, '#16A34A')}
              {stat('Needs Review', c.review ?? 0, '#D97706')}
              {stat('Not E-Invoice', c.invalid ?? 0, '#DC2626')}
              <div className="ml-auto flex items-center gap-2">
                {jobId && <OpenInSheetsButton jobId={jobId} name="E-Invoice Register" />}
                {jobId && (
                  <button onClick={handleDownload} className="px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-1.5"
                    style={{ background: '#E8EFFE', color: '#0748EE', border: '1px solid #A3BFF8' }}>
                    <Download className="w-3.5 h-3.5" /> Download Excel
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2.5">
              {invoices.map((inv, idx) => {
                const st = STATUS[inv.status] || STATUS.Invalid;
                const open = openIdx === idx;
                return (
                  <div key={idx} className="rounded-xl border overflow-hidden" style={{ borderColor: st.border, background: '#fff' }}>
                    <div onClick={() => openCard(idx)} className="w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer">
                      <span style={{ width: 10, height: 10, borderRadius: 999, background: st.dot, flexShrink: 0 }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold truncate" style={{ color: '#0F172A' }}>
                          {inv.invoice_no || inv.filename}
                        </div>
                        <div className="text-xs truncate" style={{ color: '#64748B' }}>
                          {inv.ack_no ? `Ack ${inv.ack_no} · ` : ''}{inv.irn ? `IRN ${String(inv.irn).slice(0, 14)}… · ` : ''}
                          {inv.line_items?.length ? `${inv.line_items.length} line items` : (inv.error || '')}
                        </div>
                      </div>
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: st.bg, color: st.color, border: `1px solid ${st.border}` }}>{inv.status}</span>
                      <button onClick={(e) => handleDeleteOne(inv, idx, e)} title="Delete this e-invoice"
                        className="p-1 rounded flex-shrink-0" style={{ color: '#DC2626' }} data-testid={`einv-del-${idx}`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                      {open ? <ChevronDown className="w-4 h-4" style={{ color: '#94A3B8' }} /> : <ChevronRight className="w-4 h-4" style={{ color: '#94A3B8' }} />}
                    </div>

                    {open && (
                      <div className="px-4 pb-4 grid grid-cols-1 lg:grid-cols-5 gap-4">
                        {/* line items */}
                        <div className="lg:col-span-2 border rounded-lg overflow-auto" style={{ borderColor: '#E2E8F6', maxHeight: 680 }}>
                          {inv.line_items?.length ? (
                            <table className="w-full text-xs">
                              <thead><tr style={{ background: '#F8FAFC' }}>
                                {['#', 'Item', 'HSN', 'Qty', 'Rate', 'Taxable', 'GST%', 'Total'].map((h) => (
                                  <th key={h} className="px-2 py-1.5 text-left font-bold" style={{ color: '#64748B', whiteSpace: 'nowrap' }}>{h}</th>
                                ))}
                              </tr></thead>
                              <tbody>
                                {inv.line_items.map((it, i) => (
                                  <tr key={i} style={{ borderTop: '1px solid #EEF2F9' }}>
                                    <td className="px-2 py-1.5" style={{ color: '#94A3B8' }}>{it.slno}</td>
                                    <td className="px-2 py-1.5" style={{ color: '#334155', minWidth: 160 }}>{it.desc}</td>
                                    <td className="px-2 py-1.5" style={{ color: '#334155' }}>{it.hsn}</td>
                                    <td className="px-2 py-1.5" style={{ color: '#334155' }}>{it.qty} {it.unit}</td>
                                    <td className="px-2 py-1.5 text-right" style={{ color: '#334155' }}>{money(it.rate)}</td>
                                    <td className="px-2 py-1.5 text-right" style={{ color: '#334155' }}>{money(it.taxable)}</td>
                                    <td className="px-2 py-1.5 text-right" style={{ color: '#334155' }}>{it.gst_rate}%</td>
                                    <td className="px-2 py-1.5 text-right font-semibold" style={{ color: '#0F172A' }}>{money(it.total)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <div className="p-4 text-sm" style={{ color: '#991B1B' }}>{inv.error || 'No line items extracted.'}</div>
                          )}
                        </div>
                        {/* original PDF — large, so it's readable next to the line items */}
                        <div className="lg:col-span-3 border rounded-lg overflow-hidden flex flex-col" style={{ borderColor: '#E2E8F6', minHeight: 680 }}>
                          {previewUrl ? (
                            <>
                              <div className="flex items-center justify-between px-3 py-1.5 text-xs" style={{ background: '#F8FAFC', borderBottom: '1px solid #E2E8F6', color: '#64748B' }}>
                                <span className="truncate flex items-center gap-1.5"><FileText className="w-3.5 h-3.5" /> {inv.filename}</span>
                                <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="font-semibold" style={{ color: '#0748EE' }}>Open full ↗</a>
                              </div>
                              <iframe title="E-Invoice PDF" src={`${previewUrl}#view=FitH`} className="w-full flex-1" style={{ height: 640, border: 0 }} />
                            </>
                          ) : (
                            <div className="p-4 text-xs flex items-center gap-2" style={{ color: '#64748B' }}>
                              <FileText className="w-4 h-4" /> {inv.filename} — preview available for uploaded files.
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

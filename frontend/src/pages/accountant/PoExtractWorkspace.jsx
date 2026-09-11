import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  FileText, Sheet, Mail, UploadCloud, FolderOpen, RefreshCw, Loader2, X, Maximize2,
  Trash2, ChevronRight, ChevronDown, ExternalLink, Settings, Pencil, Check,
} from 'lucide-react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { sidebarFor } from '../../lib/adminNav';
import api, { API_URL } from '../../lib/api';
import { toast } from 'sonner';

// Same palette as Invoice Process (InvoiceAgentWorkspace.jsx) — this workspace is
// deliberately styled to match it, since it shares the same eventual input methods
// (Drive upload live now; Gmail intake planned — see the "Gmail Data Room" box below).
const T_BLUE = '#2563EB';
const T_BLUE_BG = '#EFF6FF';
const T_BORDER = '#E5E7EB';
const T_BORDER_LIGHT = '#F3F4F6';
const T_TEXT_PRIMARY = '#111827';
const T_TEXT_SECONDARY = '#6B7280';
const T_SUCCESS = '#10B981';
const T_DANGER = '#EF4444';
const T_WARNING = '#F59E0B';

const STATUS = {
  'Extracted':    { bg: '#ECFDF5', border: '#D1FAE5', color: '#065F46', dot: T_SUCCESS },
  'Needs Review': { bg: '#FFFBEB', border: '#FEF3C7', color: '#92400E', dot: T_WARNING },
  'Not a PO':     { bg: '#FEF2F2', border: '#FEE2E2', color: '#991B1B', dot: T_DANGER },
  'Invalid':      { bg: '#FEF2F2', border: '#FEE2E2', color: '#991B1B', dot: T_DANGER },
};
const money = (n) => (n == null || n === '' ? '' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// "Gmail Data Room" — sample preview only, same pattern as Invoice Process's DUMMY_GMAIL.
// Real Gmail intake (n8n Gmail Trigger, like the invoice workflow already has) is planned;
// this box exists now so it can be wired live without a UI reshuffle later.
const DUMMY_GMAIL_PO = [
  { from: 'orders@firstclub.in', subject: 'Purchase Order PO-141251-FRHHYDMDL01', received: '2h ago', status: 'processed', po: 'PO-141251', amount: '₹45,230' },
  { from: 'procurement@cloudretail.in', subject: 'New PO — JCEPO191389', received: '5h ago', status: 'review', po: 'JCEPO191389', amount: '₹28,900' },
  { from: 'po@zeptonow.com', subject: 'Purchase Order attached', received: 'Yesterday', status: 'processed', po: 'KOWPO293105', amount: '₹19,450' },
];
const GMAIL_STATUS = {
  processed: { label: 'Processed', dot: T_SUCCESS, color: '#065F46', bg: '#ECFDF5' },
  review: { label: 'Needs review', dot: T_WARNING, color: '#92400E', bg: '#FFFBEB' },
  invalid: { label: 'Not a PO', dot: T_DANGER, color: '#991B1B', bg: '#FEF2F2' },
};

// Every field n8n extracts is fixable from the UI — same "edit what the AI got
// wrong" idea as Invoice Process, minus its GST/TDS-specific sections.
const PO_LINE_FIELDS = [
  { key: 'po_number', label: 'PO number' },
  { key: 'po_date', label: 'PO date' },
  { key: 'supplier_gstin', label: 'Supplier GSTIN' },
  { key: 'buyer_gstin', label: 'Buyer GSTIN' },
  { key: 'billing_address', label: 'Billing address / Deliver to', wide: true },
  { key: 'product_description', label: 'Product description', wide: true },
  { key: 'unit_cost', label: 'Unit cost', number: true },
  { key: 'gst_rate', label: 'GST %', number: true },
];
// PO-level fields (repeated identically on every line item of the same PO) —
// edited once here and pushed to ALL of that PO's rows, instead of one at a time.
const PO_HEADER_FIELDS = PO_LINE_FIELDS.filter((f) =>
  ['po_number', 'po_date', 'supplier_gstin', 'buyer_gstin', 'billing_address'].includes(f.key));

const groupByPO = (rows) => {
  const map = new Map();
  for (const r of rows || []) {
    const k = r.po_number || r.source_file || r.id;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return [...map.entries()].map(([po, items]) => ({ po, items, head: items[0] }));
};

export default function PoExtractWorkspace() {
  const { brandId, agentId } = useParams();
  const navigate = useNavigate();

  const [processing, setProcessing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState([]);
  const [rowsLoading, setRowsLoading] = useState(true);
  const [sheetUrl, setSheetUrl] = useState(null);
  const [folderId, setFolderId] = useState(null);
  const [showSheet, setShowSheet] = useState(false);
  const [openPO, setOpenPO] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState({ driveFolderUrl: '', sheetUrl: '' });
  const [savingSettings, setSavingSettings] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [savingRow, setSavingRow] = useState(false);
  const [editingPO, setEditingPO] = useState(null);
  const [poEditForm, setPoEditForm] = useState({});
  const [savingPO, setSavingPO] = useState(false);
  const sseAbortRef = useRef(null);
  const fileInputRef = useRef(null);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: FileText, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: FileText, testId: 'nav-agents' },
  ]);

  const fetchRows = useCallback(async () => {
    setRowsLoading(true);
    try {
      const { data } = await api.get(`/api/brands/${brandId}/agents/${agentId}/po-rows`);
      if (Array.isArray(data)) setRows(data);
    } catch (_) { /* none yet */ } finally { setRowsLoading(false); }
  }, [brandId, agentId]);

  const fetchSheet = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/brands/${brandId}/agents/${agentId}/po/sheet-url`);
      setSheetUrl(data?.sheetUrl || null);
      setFolderId(data?.folderId || null);
      setSettingsForm({
        driveFolderUrl: data?.folderId ? `https://drive.google.com/drive/folders/${data.folderId}` : '',
        sheetUrl: data?.sheetUrl || '',
      });
    } catch (_) { /* */ }
  }, [brandId, agentId]);

  useEffect(() => { fetchRows(); fetchSheet(); }, [fetchRows, fetchSheet]);

  // live "X of N" via fetch-based SSE (Bearer token) — shares the invoiceEvents store
  const connectSse = useCallback(() => {
    if (sseAbortRef.current) sseAbortRef.current.abort();
    const ac = new AbortController();
    sseAbortRef.current = ac;
    const token = localStorage.getItem('token');
    const url = `${API_URL}/api/brands/${brandId}/agents/${agentId}/po/status`;
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
              } else if (p.status === 'done') {
                setProcessing(false);
                fetchRows();
                toast.success(`Done — ${p.count ?? ''} PO(s) processed`);
              } else if (p.status === 'cancelled') {
                setProcessing(false);
              }
            } catch (_) { /* ignore */ }
          }
        }
      } catch (_) { /* aborted / gone */ }
    })();
  }, [brandId, agentId, fetchRows]);

  const handleProcess = async () => {
    setProcessing(true); setDone(0); setTotal(0);
    connectSse();
    try {
      await api.post(`/api/brands/${brandId}/agents/${agentId}/po/process`, {});
      toast.info('Processing started — reading the Drive folder…');
      setTimeout(fetchRows, 20000); // safety re-poll if the "done" SSE is ever missed
    } catch (e) {
      setProcessing(false);
      if (sseAbortRef.current) sseAbortRef.current.abort();
      toast.error(e.response?.data?.error || 'Could not start processing');
    }
  };

  const handleCancel = async () => {
    try { await api.post(`/api/brands/${brandId}/agents/${agentId}/po/cancel`, {}); } catch (_) { /* */ }
    setProcessing(false);
    if (sseAbortRef.current) sseAbortRef.current.abort();
    toast.info('Cancelled');
  };

  // Drive-upload box: push the chosen PO PDFs into the brand's Drive input folder,
  // then auto-trigger a Process run — same UX as Invoice Process's upload box.
  const handleUploadFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    setIsUploading(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      const res = await api.post(`/api/brands/${brandId}/agents/${agentId}/po/upload`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const n = res.data?.count || files.length;
      toast.success(`${n} file${n !== 1 ? 's' : ''} uploaded to Drive — starting processing…`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setTimeout(() => { handleProcess(); }, 1800);
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteRow = async (id, e) => {
    if (e) e.stopPropagation();
    if (!window.confirm('Delete this line item from history?')) return;
    try { await api.delete(`/api/brands/${brandId}/agents/${agentId}/po-rows/${id}`); } catch (_) { /* */ }
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const handleDeleteAll = async () => {
    if (!window.confirm('Delete ALL extracted PO rows? This cannot be undone (the Google Sheet is not touched).')) return;
    try { await api.delete(`/api/brands/${brandId}/agents/${agentId}/po-rows`); } catch (_) { /* */ }
    setRows([]); setOpenPO(null);
    toast.success('All PO rows deleted');
  };

  // ── Settings: which Drive folder / Sheet this brand's PO Extractor points at ──
  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const { data } = await api.patch(`/api/brands/${brandId}/po/settings`, settingsForm);
      setSheetUrl(data?.sheetUrl || null);
      setFolderId(data?.folderId || null);
      toast.success('Saved. Note: the n8n workflow itself still needs repointing if you changed which folder/sheet it should use — ask to have that updated too.');
      setShowSettings(false);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  // ── Edit a wrongly/un-extracted line item — saves to the DB row AND, when
  //    possible, the matching row in the Google Sheet (best-effort). ──
  const startEdit = (row, e) => {
    if (e) e.stopPropagation();
    setEditingId(row.id);
    setEditForm({ ...row });
  };
  const cancelEdit = (e) => { if (e) e.stopPropagation(); setEditingId(null); setEditForm({}); };
  const handleSaveRow = async (id, e) => {
    if (e) e.stopPropagation();
    setSavingRow(true);
    try {
      const body = {};
      for (const f of PO_LINE_FIELDS) body[f.key] = f.number ? Number(editForm[f.key]) || 0 : (editForm[f.key] ?? '');
      const { data } = await api.patch(`/api/brands/${brandId}/agents/${agentId}/po-rows/${id}`, body);
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...data.data } : r)));
      setEditingId(null); setEditForm({});
      toast.success(data.sheetSynced ? 'Saved — DB and Google Sheet both updated.' : 'Saved to the database. Could not update the Sheet row (is it shared with the service account?).');
    } catch (e2) {
      toast.error(e2.response?.data?.error || 'Save failed');
    } finally {
      setSavingRow(false);
    }
  };

  // ── Edit the PO-level info (PO number/date, supplier/buyer GSTIN, billing
  //    address) — these are repeated on every line item of the same PO, so
  //    fixing them here applies the change to ALL of that PO's rows at once,
  //    instead of editing each line item separately. ──
  const startEditPO = (po, head, e) => {
    if (e) e.stopPropagation();
    setEditingPO(po);
    setPoEditForm({
      po_number: head.po_number, po_date: head.po_date,
      supplier_gstin: head.supplier_gstin, buyer_gstin: head.buyer_gstin,
      billing_address: head.billing_address,
    });
  };
  const cancelEditPO = (e) => { if (e) e.stopPropagation(); setEditingPO(null); setPoEditForm({}); };
  const handleSavePOHeader = async (po, items, e) => {
    if (e) e.stopPropagation();
    setSavingPO(true);
    try {
      const body = {};
      for (const f of PO_HEADER_FIELDS) body[f.key] = poEditForm[f.key] ?? '';
      const results = await Promise.allSettled(
        items.map((it) => api.patch(`/api/brands/${brandId}/agents/${agentId}/po-rows/${it.id}`, body))
      );
      const updatesById = new Map();
      let okCount = 0, sheetOkCount = 0;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          okCount++;
          if (r.value.data?.sheetSynced) sheetOkCount++;
          updatesById.set(items[i].id, r.value.data?.data);
        }
      });
      setRows((prev) => prev.map((row) => (updatesById.has(row.id) ? { ...row, ...updatesById.get(row.id) } : row)));
      setEditingPO(null); setPoEditForm({});
      if (okCount === items.length) {
        toast.success(`Saved — ${okCount} line item${okCount !== 1 ? 's' : ''} updated in the database`
          + (sheetOkCount === okCount ? ' and the Google Sheet.' : `; ${okCount - sheetOkCount} row(s) could not be synced to the Sheet.`));
      } else {
        toast.warning(`Saved ${okCount} of ${items.length} line items — some updates failed.`);
      }
    } catch (e2) {
      toast.error(e2.response?.data?.error || 'Save failed');
    } finally {
      setSavingPO(false);
    }
  };

  const driveFolderUrl = folderId ? `https://drive.google.com/drive/folders/${folderId}` : null;
  const groups = groupByPO(rows);
  const metrics = {
    total: rows.length,
    pos: groups.length,
    extracted: rows.filter((r) => r.status === 'Extracted').length,
    review: rows.filter((r) => r.status === 'Needs Review').length,
    invalid: rows.filter((r) => r.status === 'Not a PO' || r.status === 'Invalid').length,
  };

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <button onClick={() => navigate(`/brands/${brandId}/agents`)} className="text-sm hover:text-blue-600" style={{ color: T_TEXT_SECONDARY }}>← All Agents</button>

        {/* Header */}
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden" style={{ borderColor: T_BORDER }}>
          <div className="px-6 py-5 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
            <div className="flex items-center gap-5">
              <div className="w-14 h-14 rounded-xl flex items-center justify-center shadow-inner" style={{ background: T_BLUE_BG, color: T_BLUE }}>
                <FileText className="w-7 h-7" />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2 h-2 rounded-full" style={{ background: T_BLUE }} />
                  <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: T_BLUE }}>Record Automation</span>
                </div>
                <h1 className="text-2xl font-bold tracking-tight" style={{ color: T_TEXT_PRIMARY }}>PO Extractor</h1>
                <p className="text-sm mt-1" style={{ color: T_TEXT_SECONDARY }}>
                  Scan Purchase-Order PDFs, extract every line item with AI, and sync them to the brand's Google Sheet.
                </p>
              </div>
            </div>

            <div className="flex flex-col items-end gap-2">
              <div className="flex flex-wrap items-center gap-3">
                {sheetUrl && (
                  <button onClick={() => setShowSheet(true)}
                    className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all hover:bg-blue-50"
                    style={{ border: `1px solid ${T_BORDER}`, color: T_TEXT_SECONDARY }}>
                    <Sheet className="w-4 h-4" /> PO Sheet
                  </button>
                )}
                {driveFolderUrl && (
                  <button onClick={() => window.open(driveFolderUrl, '_blank')}
                    className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all hover:bg-blue-50"
                    style={{ border: `1px solid ${T_BORDER}`, color: T_TEXT_SECONDARY }}>
                    <FolderOpen className="w-4 h-4" /> Google Drive Folder
                  </button>
                )}
                <button onClick={fetchRows} disabled={rowsLoading}
                  className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-all hover:bg-slate-50 disabled:opacity-50"
                  style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
                  <RefreshCw className={`w-4 h-4 ${rowsLoading ? 'animate-spin' : ''}`} /> Refresh
                </button>
                <button onClick={() => setShowSettings(true)}
                  title="Set which Drive folder / Google Sheet this brand uses"
                  className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-all hover:bg-slate-50"
                  style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
                  <Settings className="w-4 h-4" /> Settings
                </button>
                {!processing ? (
                  <button onClick={handleProcess}
                    className="inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-bold text-white transition-all hover:brightness-110 active:scale-95"
                    style={{ background: T_BLUE, boxShadow: '0 4px 12px rgba(37,99,235,0.2)' }}>
                    ▶ Process POs
                  </button>
                ) : (
                  <>
                    <button disabled className="inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-bold text-white opacity-80" style={{ background: T_BLUE }}>
                      <Loader2 className="w-4 h-4 animate-spin" /> Processing {done} of {total || '…'}
                    </button>
                    <button onClick={handleCancel}
                      className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white transition-all hover:brightness-110 active:scale-95"
                      style={{ background: T_DANGER, boxShadow: '0 4px 12px rgba(239,68,68,0.25)' }}>
                      ✕ Cancel
                    </button>
                  </>
                )}
              </div>
              {processing && total > 0 && (
                <div className="w-64 h-1.5 rounded-full overflow-hidden" style={{ background: T_BORDER_LIGHT }}>
                  <div className="h-full transition-all" style={{ width: `${Math.round((done / total) * 100)}%`, background: T_BLUE }} />
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 border-t" style={{ borderColor: T_BORDER }}>
            {[
              { label: 'Purchase Orders', value: metrics.pos, color: T_TEXT_PRIMARY },
              { label: 'Line Items', value: metrics.total, color: T_BLUE },
              { label: 'Extracted', value: metrics.extracted, color: T_SUCCESS },
              { label: 'Needs Review', value: metrics.review, color: T_WARNING },
              { label: 'Not a PO', value: metrics.invalid, color: T_DANGER },
            ].map((item) => (
              <div key={item.label} className="px-6 py-4 border-r last:border-r-0" style={{ borderColor: T_BORDER }}>
                <div className="text-xl font-bold" style={{ color: item.color }}>{item.value}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider mt-1" style={{ color: T_TEXT_SECONDARY }}>{item.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Intake row: Gmail Data Room (preview) + Drive Upload (live) — mirrors Invoice Process */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Box 1 — Gmail Data Room (preview only, planned live intake) */}
          <div className="rounded-xl border bg-white shadow-sm overflow-hidden flex flex-col" style={{ borderColor: T_BORDER }}>
            <div className="px-5 py-3 border-b flex items-center justify-between bg-slate-50/50" style={{ borderColor: T_BORDER }}>
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4" style={{ color: '#EA4335' }} />
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>Gmail Data Room</span>
              </div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: '#FEF3C7', color: '#92400E' }}>Preview</span>
            </div>
            <div className="divide-y flex-1 max-h-[260px] overflow-y-auto" style={{ borderColor: T_BORDER_LIGHT }}>
              {DUMMY_GMAIL_PO.map((g, i) => {
                const st = GMAIL_STATUS[g.status] || GMAIL_STATUS.processed;
                return (
                  <div key={i} className="px-5 py-3 hover:bg-slate-50/60 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate" style={{ color: T_TEXT_PRIMARY }}>{g.subject}</p>
                        <p className="text-[11px] truncate" style={{ color: T_TEXT_SECONDARY }}>{g.from}</p>
                      </div>
                      <span className="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: st.bg, color: st.color }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: st.dot }} /> {st.label}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-[10px]" style={{ color: T_TEXT_SECONDARY }}>{g.received}</span>
                      <span className="text-[11px] font-semibold" style={{ color: T_TEXT_PRIMARY }}>{g.po} · {g.amount}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-5 py-2.5 border-t bg-slate-50/40" style={{ borderColor: T_BORDER_LIGHT }}>
              <span className="text-[10px] font-medium" style={{ color: T_TEXT_SECONDARY }}>Sample data — live Gmail intake coming soon.</span>
            </div>
          </div>

          {/* Box 2 — Drive Upload (live) */}
          <div className="rounded-xl border bg-white shadow-sm overflow-hidden flex flex-col" style={{ borderColor: T_BORDER }}>
            <div className="px-5 py-3 border-b flex items-center justify-between bg-slate-50/50" style={{ borderColor: T_BORDER }}>
              <div className="flex items-center gap-2">
                <UploadCloud className="w-4 h-4" style={{ color: T_BLUE }} />
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>Upload PO Invoices</span>
              </div>
              {driveFolderUrl && (
                <button onClick={() => window.open(driveFolderUrl, '_blank')} className="inline-flex items-center gap-1.5 text-[11px] font-bold hover:text-blue-700" style={{ color: T_BLUE }}>
                  <FolderOpen className="w-3.5 h-3.5" /> Open folder
                </button>
              )}
            </div>
            <div className="p-5 flex-1 flex items-center">
              <input ref={fileInputRef} type="file" multiple accept=".pdf,image/*" className="hidden" onChange={(e) => handleUploadFiles(e.target.files)} />
              <button
                type="button"
                onClick={() => { if (!isUploading && fileInputRef.current) fileInputRef.current.click(); }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); handleUploadFiles(e.dataTransfer.files); }}
                disabled={isUploading}
                className="w-full rounded-xl border-2 border-dashed py-10 px-6 text-center transition-all disabled:opacity-60"
                style={{ borderColor: dragOver ? T_BLUE : T_BORDER, background: dragOver ? T_BLUE_BG : '#FBFCFE' }}
              >
                {isUploading ? (
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="w-7 h-7 animate-spin" style={{ color: T_BLUE }} />
                    <span className="text-sm font-bold" style={{ color: T_BLUE }}>Uploading &amp; processing…</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <UploadCloud className="w-8 h-8" style={{ color: T_BLUE }} />
                    <span className="text-sm font-bold" style={{ color: T_TEXT_PRIMARY }}>Drop PO files here, or click to browse</span>
                    <span className="text-[11px]" style={{ color: T_TEXT_SECONDARY }}>PDF or images · uploaded to Drive, then processed automatically</span>
                  </div>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Results */}
        {groups.length > 0 ? (
          <div className="rounded-xl border bg-white shadow-sm overflow-hidden" style={{ borderColor: T_BORDER }}>
            <div className="px-5 py-3 border-b flex items-center justify-between bg-slate-50/50" style={{ borderColor: T_BORDER }}>
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>Extracted Purchase Orders</span>
              <button onClick={handleDeleteAll}
                className="inline-flex items-center gap-1.5 text-[11px] font-bold" style={{ color: T_DANGER }}>
                <Trash2 className="w-3.5 h-3.5" /> Delete All
              </button>
            </div>
            <div className="divide-y" style={{ borderColor: T_BORDER_LIGHT }}>
              {groups.map(({ po, items, head }) => {
                const st = STATUS[head.status] || STATUS.Extracted;
                const open = openPO === po;
                return (
                  <div key={po}>
                    <div onClick={() => setOpenPO(open ? null : po)} className="w-full flex items-center gap-3 px-5 py-3 text-left cursor-pointer hover:bg-slate-50/60 transition-colors">
                      <span style={{ width: 10, height: 10, borderRadius: 999, background: st.dot, flexShrink: 0 }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold truncate" style={{ color: T_TEXT_PRIMARY }}>{po || head.source_file}</div>
                        <div className="text-xs truncate" style={{ color: T_TEXT_SECONDARY }}>
                          {head.po_date ? `${head.po_date} · ` : ''}
                          {head.supplier_gstin ? `Supplier ${head.supplier_gstin} · ` : ''}
                          {head.buyer_gstin ? `Buyer ${head.buyer_gstin} · ` : ''}
                          {items.length} line item{items.length !== 1 ? 's' : ''}
                        </div>
                      </div>
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: st.bg, color: st.color, border: `1px solid ${st.border}` }}>{head.status}</span>
                      <button onClick={(e) => startEditPO(po, head, e)} title="Fix the PO number, date, GSTINs, or billing address (applies to every line item)" style={{ color: T_BLUE }}>
                        <Pencil className="w-4 h-4" />
                      </button>
                      {open ? <ChevronDown className="w-4 h-4" style={{ color: T_TEXT_SECONDARY }} /> : <ChevronRight className="w-4 h-4" style={{ color: T_TEXT_SECONDARY }} />}
                    </div>

                    {editingPO === po && (
                      <div className="px-5 pb-4" style={{ background: T_BLUE_BG }} onClick={(e) => e.stopPropagation()}>
                        <div className="pt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
                          {PO_HEADER_FIELDS.map((f) => (
                            <div key={f.key} className={f.wide ? 'col-span-2 md:col-span-2' : ''}>
                              <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: T_TEXT_SECONDARY }}>{f.label}</label>
                              <input
                                type="text"
                                value={poEditForm[f.key] ?? ''}
                                onChange={(e) => setPoEditForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                                className="w-full rounded-lg border px-2.5 py-1.5 text-xs"
                                style={{ borderColor: T_BORDER, background: '#fff' }}
                              />
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center gap-2 mt-3">
                          <button onClick={(e) => handleSavePOHeader(po, items, e)} disabled={savingPO}
                            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
                            style={{ background: T_SUCCESS }}>
                            {savingPO ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
                          </button>
                          <button onClick={cancelEditPO}
                            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold"
                            style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
                            <X className="w-3.5 h-3.5" /> Cancel
                          </button>
                          <span className="text-[10px]" style={{ color: T_TEXT_SECONDARY }}>Applies to all {items.length} line item{items.length !== 1 ? 's' : ''} of this PO — DB and Sheet.</span>
                        </div>
                      </div>
                    )}

                    {open && (
                      <div className="px-5 pb-4 overflow-auto">
                        <table className="w-full text-xs">
                          <thead><tr style={{ background: '#F8FAFC' }}>
                            {['Product description', 'Unit cost', 'GST %', 'Billing / Deliver-to', 'Source', ''].map((h) => (
                              <th key={h} className="px-2 py-1.5 text-left font-bold" style={{ color: T_TEXT_SECONDARY, whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr></thead>
                          <tbody>
                            {items.map((it) => (
                              <React.Fragment key={it.id}>
                                <tr style={{ borderTop: `1px solid ${T_BORDER_LIGHT}` }}>
                                  <td className="px-2 py-1.5" style={{ color: T_TEXT_PRIMARY, minWidth: 220 }}>{it.product_description}</td>
                                  <td className="px-2 py-1.5 text-right" style={{ color: T_TEXT_PRIMARY }}>{money(it.unit_cost)}</td>
                                  <td className="px-2 py-1.5 text-right" style={{ color: T_TEXT_PRIMARY }}>{it.gst_rate != null ? `${it.gst_rate}%` : ''}</td>
                                  <td className="px-2 py-1.5" style={{ color: T_TEXT_SECONDARY, maxWidth: 320 }}>{it.billing_address}</td>
                                  <td className="px-2 py-1.5" style={{ color: T_TEXT_SECONDARY }}>
                                    {it.po_pdf_link
                                      ? <a href={it.po_pdf_link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1" style={{ color: T_BLUE }}>{it.source_file || 'PDF'} <ExternalLink className="w-3 h-3" /></a>
                                      : (it.source_file || '')}
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <div className="flex items-center gap-2">
                                      <button onClick={(e) => startEdit(it, e)} title="Fix a wrong or missing value" style={{ color: T_BLUE }}>
                                        <Pencil className="w-3.5 h-3.5" />
                                      </button>
                                      <button onClick={(e) => handleDeleteRow(it.id, e)} title="Delete this line" style={{ color: T_DANGER }}>
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                                {editingId === it.id && (
                                  <tr style={{ background: T_BLUE_BG }}>
                                    <td colSpan={6} className="px-3 py-3">
                                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                        {PO_LINE_FIELDS.map((f) => (
                                          <div key={f.key} className={f.wide ? 'col-span-2 md:col-span-2' : ''}>
                                            <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: T_TEXT_SECONDARY }}>{f.label}</label>
                                            <input
                                              type={f.number ? 'number' : 'text'}
                                              value={editForm[f.key] ?? ''}
                                              onChange={(e) => setEditForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                                              onClick={(e) => e.stopPropagation()}
                                              className="w-full rounded-lg border px-2.5 py-1.5 text-xs"
                                              style={{ borderColor: T_BORDER, background: '#fff' }}
                                            />
                                          </div>
                                        ))}
                                      </div>
                                      <div className="flex items-center gap-2 mt-3">
                                        <button onClick={(e) => handleSaveRow(it.id, e)} disabled={savingRow}
                                          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
                                          style={{ background: T_SUCCESS }}>
                                          {savingRow ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
                                        </button>
                                        <button onClick={cancelEdit}
                                          className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold"
                                          style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
                                          <X className="w-3.5 h-3.5" /> Cancel
                                        </button>
                                        <span className="text-[10px]" style={{ color: T_TEXT_SECONDARY }}>Saves to the database and the Google Sheet row.</span>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : !processing && (
          <div className="rounded-xl border bg-white shadow-sm p-10 text-center" style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
            <FileText className="w-8 h-8 mx-auto mb-2" />
            <div className="text-sm font-semibold" style={{ color: T_TEXT_PRIMARY }}>No POs extracted yet</div>
            <div className="text-xs mt-1">Upload PO PDFs above, or drop them in the Drive folder, then click "Process POs".</div>
          </div>
        )}
      </div>

      {/* Sheet embed modal */}
      {showSheet && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-6xl h-[86vh] rounded-2xl bg-white overflow-hidden flex flex-col shadow-2xl">
            <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: T_BORDER }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: T_BLUE_BG, color: T_BLUE }}>
                  <Sheet className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-black" style={{ color: T_TEXT_PRIMARY }}>PO Sheet</h3>
                  <p className="text-xs" style={{ color: T_TEXT_SECONDARY }}>Live source sheet configured for this brand</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {sheetUrl && (
                  <a href={sheetUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-bold" style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
                    <Maximize2 className="w-4 h-4" /> Open
                  </a>
                )}
                <button onClick={() => setShowSheet(false)} className="rounded-xl border p-2" style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {sheetUrl ? (
              <iframe title="PO Google Sheet" src={sheetUrl} className="flex-1 w-full border-0" />
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm" style={{ color: T_TEXT_SECONDARY }}>No sheet URL configured for this brand.</div>
            )}
          </div>
        </div>
      )}

      {/* Settings modal — which Drive folder / Sheet this brand's PO Extractor uses */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-lg rounded-2xl bg-white overflow-hidden shadow-2xl">
            <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: T_BORDER }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: T_BLUE_BG, color: T_BLUE }}>
                  <Settings className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-black" style={{ color: T_TEXT_PRIMARY }}>PO Extractor Settings</h3>
                  <p className="text-xs" style={{ color: T_TEXT_SECONDARY }}>Drive folder + Sheet used by this brand</p>
                </div>
              </div>
              <button onClick={() => setShowSettings(false)} className="rounded-xl border p-2" style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wide mb-1.5" style={{ color: T_TEXT_SECONDARY }}>Google Drive folder (PO PDFs)</label>
                <input
                  value={settingsForm.driveFolderUrl}
                  onChange={(e) => setSettingsForm((p) => ({ ...p, driveFolderUrl: e.target.value }))}
                  placeholder="https://drive.google.com/drive/folders/…"
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  style={{ borderColor: T_BORDER }}
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wide mb-1.5" style={{ color: T_TEXT_SECONDARY }}>Google Sheet (extracted PO data)</label>
                <input
                  value={settingsForm.sheetUrl}
                  onChange={(e) => setSettingsForm((p) => ({ ...p, sheetUrl: e.target.value }))}
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  style={{ borderColor: T_BORDER }}
                />
              </div>
              <p className="text-[11px] leading-relaxed rounded-lg px-3 py-2" style={{ color: '#92400E', background: '#FFFBEB' }}>
                This changes what the <em>app</em> reads/writes to (uploads, the embedded Sheet, edit-sync). The n8n workflow's own
                nodes still scan/write whatever folder + sheet they're configured with — if you change these, say so and that gets repointed too.
              </p>
            </div>
            <div className="px-5 py-4 border-t flex items-center justify-end gap-2" style={{ borderColor: T_BORDER }}>
              <button onClick={() => setShowSettings(false)} className="rounded-lg border px-4 py-2 text-sm font-semibold" style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>Cancel</button>
              <button onClick={handleSaveSettings} disabled={savingSettings}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
                style={{ background: T_BLUE }}>
                {savingSettings && <Loader2 className="w-4 h-4 animate-spin" />} Save
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

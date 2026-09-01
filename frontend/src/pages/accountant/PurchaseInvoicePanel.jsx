import React, { useState, useCallback, useRef } from 'react';
import { Upload, FileText, Download, Check, AlertTriangle, Plus, Loader2, ArrowLeft, X } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';

// ── Purchase-Invoice → Tally panel ──────────────────────────────────────────
// Self-contained "Purchase Invoice" mode for Urban Plant. Upload vendor purchase
// invoices → the engine extracts + maps each line to a Tally stock item → the
// accountant resolves duplicates (dropdown) / adds missing items (form; auto-saved
// to the DB so they auto-map next time) → download the 109-col Excel-to-Tally file.
// Additive + isolated: does NOT touch the existing (n8n) Sales/Expense flow.

const STATUS_STYLE = {
  exact:     { bg: '#ECFDF5', fg: '#047857', label: 'Matched' },
  learned:   { bg: '#ECFDF5', fg: '#047857', label: 'Learned' },
  sku:       { bg: '#ECFDF5', fg: '#047857', label: 'SKU' },
  fuzzy:     { bg: '#EFF6FF', fg: '#1D4ED8', label: 'Fuzzy' },
  gemini:    { bg: '#F5F3FF', fg: '#6D28D9', label: 'AI' },
  suggested: { bg: '#FFFBEB', fg: '#B45309', label: 'Suggested' },
  ambiguous: { bg: '#FFFBEB', fg: '#B45309', label: 'Pick one' },
  unmatched: { bg: '#FEF2F2', fg: '#B91C1C', label: 'Add new' },
};
const money = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('en-IN'));

export default function PurchaseInvoicePanel({ brandId, onSwitchToSales }) {
  const [files, setFiles] = useState([]);
  const [invoices, setInvoices] = useState(null);   // null = not yet extracted
  const [skipped, setSkipped] = useState([]);
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  const base = `/api/brands/${brandId}/purchase-invoice`;

  const onPick = (fl) => {
    const arr = Array.from(fl || []).filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (arr.length) setFiles((prev) => [...prev, ...arr]);
  };

  const extract = useCallback(async () => {
    if (!files.length) { toast.error('Add at least one invoice PDF'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      const res = await api.post(`${base}/extract`, fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 600000 });
      if (!res.data.ok) throw new Error(res.data.error || 'Extract failed');
      setInvoices(res.data.invoices || []);
      setSkipped(res.data.skipped || []);
      const nLines = (res.data.invoices || []).reduce((a, i) => a + i.items.length, 0);
      toast.success(`Extracted ${res.data.invoices.length} invoice(s), ${nLines} lines`);
      if ((res.data.skipped || []).length) toast.warning(`${res.data.skipped.length} file(s) skipped (not Urban Plant)`);
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message || 'Extract failed');
    } finally { setBusy(false); }
  }, [files, base]);

  // set a line's stock item locally
  const setLine = (ii, li, patch) => setInvoices((prev) => {
    const next = prev.map((inv, a) => a !== ii ? inv : ({
      ...inv, items: inv.items.map((it, b) => b !== li ? it : ({ ...it, ...patch })),
    }));
    return next;
  });

  // duplicate resolution → set locally + learn to DB
  const choose = async (ii, li, cand) => {
    const inv = invoices[ii], it = inv.items[li];
    setLine(ii, li, { stock_item: cand.tally, sku: cand.sku, map_status: 'learned', needs_add: false });
    try {
      await api.post(`${base}/pick`, { vendor_gstin: inv.seller_gstin, description: it.desc, rate: it.rate, sku: cand.sku, tally_name: cand.tally });
    } catch (e) { /* non-fatal: local pick still applies to this run */ }
  };

  // add a missing product to the master → set locally
  const addNew = async (ii, li, tally_name, sku) => {
    if (!tally_name.trim()) { toast.error('Enter the Tally name'); return; }
    const inv = invoices[ii], it = inv.items[li];
    try {
      await api.post(`${base}/master`, { description: it.desc, sku: sku || null, tally_name });
      // also learn it for this vendor so it maps instantly next time
      await api.post(`${base}/pick`, { vendor_gstin: inv.seller_gstin, description: it.desc, rate: it.rate, sku, tally_name });
      setLine(ii, li, { stock_item: tally_name, sku, map_status: 'learned', needs_add: false, adding: false });
      toast.success('Added to master');
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not add'); }
  };

  const download = useCallback(async () => {
    setBuilding(true);
    try {
      // strip UI-only fields; keep what the builder needs
      const payload = invoices.map((inv) => ({
        seller_gstin: inv.seller_gstin, seller_name: inv.seller_name, buyer_gstin: inv.buyer_gstin,
        buyer_state: inv.buyer_state, intra_state: inv.intra_state, invoice_no: inv.invoice_no, date: inv.date,
        items: inv.items.map((it) => ({ desc: it.desc, hsn: it.hsn, qty: it.qty, unit: it.unit, rate: it.rate, amount: it.amount, gst_rate: it.gst_rate, stock_item: it.stock_item || '' })),
      }));
      const res = await api.post(`${base}/build`, { invoices: payload, narration: 'Excel to tally' }, { responseType: 'blob', timeout: 300000 });
      // use the server-provided brand+dated filename (Content-Disposition)
      const cd = res.headers?.['content-disposition'] || '';
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      const fname = m ? decodeURIComponent(m[1]) : `Purchase_Tally_${Date.now()}.xlsx`;
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a'); a.href = url; a.download = fname; a.click();
      window.URL.revokeObjectURL(url);
      toast.success('Tally workbook downloaded');
    } catch (e) { toast.error('Build failed'); }
    finally { setBuilding(false); }
  }, [invoices, base]);

  const totalLines = invoices ? invoices.reduce((a, i) => a + i.items.length, 0) : 0;
  const unresolved = invoices ? invoices.reduce((a, i) => a + i.items.filter((it) => !it.stock_item).length, 0) : 0;

  return (
    <div className="max-w-[1600px] space-y-5 animate-in fade-in duration-500">
      {/* header + explainer + toggle back */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden" style={{ borderColor: '#E5E7EB' }}>
        <div className="px-6 py-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: '#EEF2FF', color: '#4338CA' }}>
              <FileText className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight" style={{ color: '#111827', fontFamily: 'Space Grotesk' }}>Purchase Invoice → Tally</h1>
              <p className="text-sm mt-0.5" style={{ color: '#6B7280' }}>
                Upload vendor purchase invoices → auto-map to Tally stock items → download the Tally import file. Duplicates ask you to pick; missing items you add once and they’re remembered.
              </p>
            </div>
          </div>
          <button onClick={onSwitchToSales} className="text-sm px-3 py-2 rounded-lg border self-start flex items-center gap-1.5" style={{ borderColor: '#E5E7EB', color: '#374151' }}>
            <ArrowLeft className="w-4 h-4" /> Sales / Expense mode
          </button>
        </div>
      </div>

      {/* upload */}
      <div className="rounded-xl border bg-white shadow-sm p-5" style={{ borderColor: '#E5E7EB' }}>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); onPick(e.dataTransfer.files); }}
          onClick={() => fileRef.current?.click()}
          className="rounded-lg border-2 border-dashed px-6 py-8 text-center cursor-pointer transition"
          style={{ borderColor: dragOver ? '#4338CA' : '#D1D5DB', background: dragOver ? '#EEF2FF' : '#FAFAFA' }}
        >
          <Upload className="w-7 h-7 mx-auto mb-2" style={{ color: '#6B7280' }} />
          <div className="text-sm font-medium" style={{ color: '#374151' }}>Drop purchase-invoice PDFs here, or click to browse</div>
          <div className="text-xs mt-1" style={{ color: '#9CA3AF' }}>Only Urban Plant (Grandeur) invoices are accepted — others are skipped automatically.</div>
          <input ref={fileRef} type="file" accept="application/pdf" multiple hidden onChange={(e) => onPick(e.target.files)} />
        </div>
        {files.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {files.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border" style={{ borderColor: '#E5E7EB', background: '#F9FAFB', color: '#374151' }}>
                <FileText className="w-3.5 h-3.5" /> {f.name}
                <button onClick={(e) => { e.stopPropagation(); setFiles((p) => p.filter((_, j) => j !== i)); }}><X className="w-3.5 h-3.5" style={{ color: '#9CA3AF' }} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="mt-4 flex items-center gap-3">
          <button onClick={extract} disabled={busy || !files.length} className="px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-2 disabled:opacity-50" style={{ background: '#4338CA' }}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Extract & Map
          </button>
          {invoices && (
            <button onClick={download} disabled={building} className="px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 border disabled:opacity-50" style={{ borderColor: '#4338CA', color: '#4338CA' }}>
              {building ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download Tally Excel
            </button>
          )}
          {invoices && (
            <span className="text-xs ml-auto" style={{ color: unresolved ? '#B45309' : '#047857' }}>
              {totalLines} lines · {unresolved ? `${unresolved} need a Tally item` : 'all mapped ✓'}
            </span>
          )}
        </div>
        {skipped.length > 0 && (
          <div className="mt-3 text-xs rounded-md px-3 py-2" style={{ background: '#FEF2F2', color: '#B91C1C' }}>
            {skipped.map((s, i) => <div key={i}>⛔ {s.filename} — {s.reason}</div>)}
          </div>
        )}
      </div>

      {/* preview */}
      {invoices && invoices.map((inv, ii) => (
        <div key={ii} className="rounded-xl border bg-white shadow-sm overflow-hidden" style={{ borderColor: '#E5E7EB' }}>
          <div className="px-5 py-3 border-b flex flex-wrap items-center gap-x-4 gap-y-1" style={{ borderColor: '#F3F4F6', background: '#FCFCFD' }}>
            <span className="font-semibold text-sm" style={{ color: '#111827' }}>{inv.seller_name || inv.seller_gstin || 'Unknown vendor'}</span>
            <span className="text-xs" style={{ color: '#6B7280' }}>Invoice {inv.invoice_no || '—'} · {inv.date || '—'}</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: inv.intra_state ? '#ECFDF5' : '#EFF6FF', color: inv.intra_state ? '#047857' : '#1D4ED8' }}>
              {inv.intra_state ? 'Intra-state · CGST+SGST' : 'Inter-state · IGST'}
            </span>
            {!inv.known_vendor && <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: '#F5F3FF', color: '#6D28D9' }}>new vendor (AI-parsed)</span>}
          </div>
          <div className="overflow-x-auto">
            <table className="text-sm" style={{ width: '100%', tableLayout: 'fixed', minWidth: 900 }}>
              <colgroup>
                <col style={{ width: '34%' }} />
                <col style={{ width: '110px' }} />
                <col style={{ width: '96px' }} />
                <col style={{ width: 'auto' }} />
              </colgroup>
              <thead>
                <tr className="text-[11px] uppercase tracking-wider border-b" style={{ color: '#9CA3AF', borderColor: '#F3F4F6' }}>
                  <th className="text-left font-semibold px-4 py-2">Vendor line</th>
                  <th className="text-right font-semibold px-3 py-2">Qty × Rate</th>
                  <th className="text-right font-semibold px-3 py-2">Amount</th>
                  <th className="text-left font-semibold px-4 py-2">Tally stock item</th>
                </tr>
              </thead>
              <tbody>
                {inv.items.map((it, li) => (
                  <LineRow key={li} it={it} onChoose={(c) => choose(ii, li, c)}
                           onStartAdd={() => setLine(ii, li, { adding: true })}
                           onCancelAdd={() => setLine(ii, li, { adding: false })}
                           onAdd={(tn, sku) => addNew(ii, li, tn, sku)} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function LineRow({ it, onChoose, onStartAdd, onCancelAdd, onAdd }) {
  const [tally, setTally] = useState('');
  const [sku, setSku] = useState('');
  const [editing, setEditing] = useState(false);
  const st = STATUS_STYLE[it.map_status] || STATUS_STYLE.unmatched;
  const resolved = !!it.stock_item;
  const cellPad = 'px-4 py-2.5 align-top';
  const showPicker = !resolved || editing;

  const picker = (
    it.adding ? (
      <div className="flex items-center gap-2 flex-wrap">
        <input autoFocus value={tally} onChange={(e) => setTally(e.target.value)} placeholder="Name as per Tally" className="text-sm px-2 py-1 rounded border" style={{ borderColor: '#D1D5DB', flex: '1 1 220px', minWidth: 200 }} />
        <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU (optional)" className="text-sm px-2 py-1 rounded border" style={{ borderColor: '#D1D5DB', width: 130 }} />
        <button onClick={() => onAdd(tally, sku)} className="text-xs px-2 py-1 rounded text-white flex items-center gap-1 whitespace-nowrap" style={{ background: '#047857' }}><Check className="w-3 h-3" /> Save</button>
        <button onClick={() => { onCancelAdd(); setEditing(false); }} className="text-xs px-2 py-1 rounded border" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>Cancel</button>
      </div>
    ) : it.candidates && it.candidates.length ? (
      <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
        <select defaultValue="" onChange={(e) => { const c = it.candidates[Number(e.target.value)]; if (c) { onChoose(c); setEditing(false); } }} className="text-sm px-2 py-1 rounded border" style={{ borderColor: '#D1D5DB', flex: '1 1 auto', minWidth: 0, maxWidth: '100%' }}>
          <option value="" disabled>Pick the correct Tally item…</option>
          {it.candidates.map((c, i) => <option key={i} value={i}>{c.tally}{c.sku ? ` (${c.sku})` : ''}</option>)}
        </select>
        <button onClick={onStartAdd} className="text-xs px-2 py-1 rounded border flex items-center gap-1 whitespace-nowrap" style={{ borderColor: '#E5E7EB', color: '#4338CA' }}><Plus className="w-3 h-3" /> Add new</button>
        {editing && <button onClick={() => setEditing(false)} className="text-xs px-1.5 py-1 rounded" style={{ color: '#9CA3AF' }}><X className="w-3.5 h-3.5" /></button>}
      </div>
    ) : (
      <button onClick={onStartAdd} className="text-xs px-2 py-1 rounded border flex items-center gap-1 whitespace-nowrap" style={{ borderColor: '#E5E7EB', color: '#4338CA' }}><Plus className="w-3 h-3" /> Add to master</button>
    )
  );

  return (
    <tr className="border-t" style={{ borderColor: '#F3F4F6' }}>
      <td className={cellPad} style={{ color: '#374151' }}>
        <div className="break-words" style={{ lineHeight: 1.35 }}>{it.desc}</div>
        {it.hsn && <div className="text-[11px] mt-0.5" style={{ color: '#9CA3AF' }}>HSN {it.hsn}</div>}
      </td>
      <td className={`${cellPad} text-right tabular-nums whitespace-nowrap`} style={{ color: '#6B7280' }}>{it.qty} × {money(it.rate)}</td>
      <td className={`${cellPad} text-right font-medium tabular-nums whitespace-nowrap`} style={{ color: '#111827' }}>{money(it.amount)}</td>
      <td className={cellPad}>
        <div className="flex items-start gap-2" style={{ minWidth: 0 }}>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 mt-0.5" style={{ background: st.bg, color: st.fg }}>{st.label}</span>
          <div className="flex-1" style={{ minWidth: 0 }}>
            {showPicker ? picker : (
              <div className="flex items-start gap-2" style={{ minWidth: 0 }}>
                <span className="break-words flex-1" style={{ color: '#111827', minWidth: 0, lineHeight: 1.35 }}>{it.stock_item}</span>
                <button onClick={() => setEditing(true)} className="text-[11px] shrink-0 mt-0.5 underline" style={{ color: '#6B7280' }}>change</button>
              </div>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

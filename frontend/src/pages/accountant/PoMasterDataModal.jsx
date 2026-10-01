import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Database, X, Loader2, Pencil, Trash2, Check, Plus, UploadCloud, Download, RefreshCw, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import api from '../../lib/api';
import { toast } from 'sonner';

// PO Extractor master data — edited ONLY here. The backend stores it per brand
// and mirrors each master to the brand's PO Sheet (Vendor_Master / SKU_Master
// tabs), which the PO_Data XLOOKUP columns read.
const T_BLUE = '#2563EB';
const T_BLUE_BG = '#EFF6FF';
const T_BORDER = '#E5E7EB';
const T_BORDER_LIGHT = '#F3F4F6';
const T_TEXT_PRIMARY = '#111827';
const T_TEXT_SECONDARY = '#6B7280';
const T_SUCCESS = '#10B981';
const T_DANGER = '#EF4444';

const TABS = {
  vendor: {
    label: 'Vendor master',
    hint: 'Buyer GSTIN on the PO → the party (vendor) name exactly as in Tally. Fills "Vendor Name as per Tally".',
    keyField: 'buyer_gstin', valueField: 'vendor_name_tally',
    keyLabel: 'Buyer GSTIN', valueLabel: 'Vendor Name as per Tally',
    keyPlaceholder: '24AAICK4821A1Z1', valuePlaceholder: 'Zepto Limited (Gujarat)',
    file: 'PO_Vendor_Master.xlsx',
  },
  sku: {
    label: 'SKU master',
    hint: 'Material / SKU code printed on the buyer\'s PO → the FG item name exactly as in Tally. Fills "FG".',
    keyField: 'material_code', valueField: 'fg_name',
    keyLabel: 'Material Code / SKU Code', valueLabel: 'FG (Tally Item Name)',
    keyPlaceholder: '19738689', valuePlaceholder: 'Koparo Liquid Detergent 3L',
    file: 'PO_SKU_Master.xlsx',
  },
};

export default function PoMasterDataModal({ brandId, initialTab = 'vendor', prefillKey = '', onClose, onChanged }) {
  const [tab, setTab] = useState(initialTab);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [newRow, setNewRow] = useState({ key: prefillKey || '', value: '' });
  const [editId, setEditId] = useState(null);
  const [editRow, setEditRow] = useState({ key: '', value: '' });
  const [uploadMode, setUploadMode] = useState('merge');
  const fileRef = useRef(null);
  const valueInputRef = useRef(null);
  const cfg = TABS[tab];
  const base = `/api/brands/${brandId}/po/master/${tab}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(base);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load the master');
    } finally { setLoading(false); }
  }, [base]);

  useEffect(() => { load(); setEditId(null); setSearch(''); }, [load]);
  useEffect(() => { if (prefillKey && valueInputRef.current) valueInputRef.current.focus(); }, [prefillKey]);

  // Every mutation returns the full refreshed list + whether the Sheet tab was updated.
  const afterSave = (data, okMsg) => {
    if (Array.isArray(data?.rows)) setRows(data.rows);
    if (onChanged) onChanged();
    if (data?.sheetSynced) toast.success(`${okMsg} — Google Sheet updated.`);
    else toast.warning(`${okMsg} in the app, but the Google Sheet tab could not be updated${data?.sheetError ? `: ${data.sheetError}` : '.'} The sheet's lookup columns will lag until "Sync to Sheet" succeeds.`);
  };

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } catch (e) {
      toast.error(e.response?.data?.error || e.message || 'Something went wrong');
    } finally { setBusy(false); }
  };

  const handleAdd = () => run(async () => {
    const { data } = await api.post(base, { key: newRow.key, value: newRow.value });
    setNewRow({ key: '', value: '' });
    afterSave(data, 'Saved');
  });

  const handleUpdate = (id) => run(async () => {
    const { data } = await api.patch(`${base}/${id}`, { key: editRow.key, value: editRow.value });
    setEditId(null);
    afterSave(data, 'Updated');
  });

  const handleDelete = (r) => {
    if (!window.confirm(`Remove "${r[cfg.keyField]}" from the ${cfg.label.toLowerCase()}?`)) return;
    run(async () => {
      const { data } = await api.delete(`${base}/${r.id}`);
      afterSave(data, 'Removed');
    });
  };

  const handleUpload = (file) => {
    if (!file) return;
    if (uploadMode === 'replace' && !window.confirm(`Replace the WHOLE ${cfg.label.toLowerCase()} with this file? Rows not in the file will be removed.`)) {
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    run(async () => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mode', uploadMode);
      try {
        const { data } = await api.post(`${base}/upload`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        afterSave(data, `${data.saved} row${data.saved !== 1 ? 's' : ''} ${data.mode === 'replace' ? 'loaded (master replaced)' : 'added/updated'}`);
        if (data.skippedCount) {
          const eg = (data.skipped || []).slice(0, 3).map((s) => `row ${s.row}: ${s.reason}`).join('; ');
          toast.warning(`${data.skippedCount} row(s) skipped — ${eg}`);
        }
      } finally { if (fileRef.current) fileRef.current.value = ''; }
    });
  };

  // Download = template when empty, export of the current master otherwise —
  // same 2 columns the upload expects.
  const handleDownload = () => {
    const aoa = [[cfg.keyLabel, cfg.valueLabel], ...rows.map((r) => [r[cfg.keyField], r[cfg.valueField]])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 28 }, { wch: 48 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, tab === 'vendor' ? 'Vendor_Master' : 'SKU_Master');
    XLSX.writeFile(wb, cfg.file);
  };

  const handleSync = () => run(async () => {
    const { data } = await api.post(`/api/brands/${brandId}/po/master/sync`, {});
    if (data.sheetSynced) toast.success('Both masters pushed to the Google Sheet.');
    else toast.error(`Sheet sync failed: ${data.vendor?.sheetError || data.sku?.sheetError || 'unknown error'}`);
  });

  const q = search.trim().toLowerCase();
  const visible = q
    ? rows.filter((r) => `${r[cfg.keyField]} ${r[cfg.valueField]}`.toLowerCase().includes(q))
    : rows;

  const input = 'w-full rounded-lg border px-2.5 py-1.5 text-xs';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-4xl max-h-[90vh] rounded-2xl bg-white overflow-hidden flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: T_BORDER }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: T_BLUE_BG, color: T_BLUE }}>
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-black" style={{ color: T_TEXT_PRIMARY }}>PO Master Data</h3>
              <p className="text-xs" style={{ color: T_TEXT_SECONDARY }}>Feeds the Vendor Name as per Tally and FG columns</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleSync} disabled={busy} title="Re-push both masters to the Google Sheet tabs"
              className="inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold disabled:opacity-50"
              style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
              <RefreshCw className="w-3.5 h-3.5" /> Sync to Sheet
            </button>
            <button onClick={onClose} className="rounded-xl border p-2" style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 flex gap-2 border-b" style={{ borderColor: T_BORDER }}>
          {Object.entries(TABS).map(([k, t]) => (
            <button key={k} onClick={() => { setTab(k); setNewRow({ key: '', value: '' }); }}
              className="px-3 py-2 text-xs font-bold -mb-px border-b-2"
              style={{ borderColor: tab === k ? T_BLUE : 'transparent', color: tab === k ? T_BLUE : T_TEXT_SECONDARY }}>
              {t.label}{tab === k && !loading ? ` (${rows.length})` : ''}
            </button>
          ))}
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <p className="text-[11px]" style={{ color: T_TEXT_SECONDARY }}>{cfg.hint}</p>

          {/* Upload / download */}
          <div className="rounded-xl border p-3 flex flex-wrap items-center gap-3" style={{ borderColor: T_BORDER, background: '#FBFCFE' }}>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => handleUpload(e.target.files?.[0])} />
            <button onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
              style={{ background: T_BLUE }}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />} Upload Excel / CSV
            </button>
            <select value={uploadMode} onChange={(e) => setUploadMode(e.target.value)}
              className="rounded-lg border px-2 py-1.5 text-xs" style={{ borderColor: T_BORDER }}>
              <option value="merge">Add new + update existing</option>
              <option value="replace">Replace whole master</option>
            </select>
            <button onClick={handleDownload}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold"
              style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
              <Download className="w-3.5 h-3.5" /> {rows.length ? 'Download master' : 'Download template'}
            </button>
            <span className="text-[10px]" style={{ color: T_TEXT_SECONDARY }}>
              Two columns: <b>{cfg.keyLabel}</b>, <b>{cfg.valueLabel}</b> (header row optional).
            </span>
          </div>

          {/* Add one */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1.6fr_auto] gap-2 items-end">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: T_TEXT_SECONDARY }}>{cfg.keyLabel}</label>
              <input value={newRow.key} onChange={(e) => setNewRow((p) => ({ ...p, key: e.target.value }))}
                placeholder={cfg.keyPlaceholder} className={input} style={{ borderColor: T_BORDER }} />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: T_TEXT_SECONDARY }}>{cfg.valueLabel}</label>
              <input ref={valueInputRef} value={newRow.value} onChange={(e) => setNewRow((p) => ({ ...p, value: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && newRow.key && newRow.value) handleAdd(); }}
                placeholder={cfg.valuePlaceholder} className={input} style={{ borderColor: T_BORDER }} />
            </div>
            <button onClick={handleAdd} disabled={busy || !newRow.key.trim() || !newRow.value.trim()}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
              style={{ background: T_SUCCESS }}>
              <Plus className="w-3.5 h-3.5" /> Add / update
            </button>
          </div>

          {/* List */}
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: T_BORDER }}>
            <div className="px-3 py-2 border-b flex items-center gap-2" style={{ borderColor: T_BORDER_LIGHT }}>
              <Search className="w-3.5 h-3.5" style={{ color: T_TEXT_SECONDARY }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…"
                className="flex-1 text-xs outline-none" />
            </div>
            {loading ? (
              <div className="p-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" style={{ color: T_BLUE }} /></div>
            ) : !visible.length ? (
              <div className="p-6 text-center text-xs" style={{ color: T_TEXT_SECONDARY }}>
                {rows.length ? 'No matches.' : 'No rows yet — upload a file or add one above.'}
              </div>
            ) : (
              <div className="max-h-[40vh] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0"><tr style={{ background: '#F8FAFC' }}>
                    <th className="px-3 py-1.5 text-left font-bold" style={{ color: T_TEXT_SECONDARY }}>{cfg.keyLabel}</th>
                    <th className="px-3 py-1.5 text-left font-bold" style={{ color: T_TEXT_SECONDARY }}>{cfg.valueLabel}</th>
                    <th className="w-16" />
                  </tr></thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr key={r.id} style={{ borderTop: `1px solid ${T_BORDER_LIGHT}`, background: editId === r.id ? T_BLUE_BG : undefined }}>
                        {editId === r.id ? (
                          <>
                            <td className="px-3 py-1"><input value={editRow.key} onChange={(e) => setEditRow((p) => ({ ...p, key: e.target.value }))} className={input} style={{ borderColor: T_BORDER, background: '#fff' }} /></td>
                            <td className="px-3 py-1"><input value={editRow.value} onChange={(e) => setEditRow((p) => ({ ...p, value: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter') handleUpdate(r.id); }} className={input} style={{ borderColor: T_BORDER, background: '#fff' }} /></td>
                            <td className="px-3 py-1">
                              <div className="flex items-center gap-2">
                                <button onClick={() => handleUpdate(r.id)} disabled={busy} title="Save" style={{ color: T_SUCCESS }}><Check className="w-3.5 h-3.5" /></button>
                                <button onClick={() => setEditId(null)} title="Cancel" style={{ color: T_TEXT_SECONDARY }}><X className="w-3.5 h-3.5" /></button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-1.5 font-mono" style={{ color: T_TEXT_PRIMARY }}>{r[cfg.keyField]}</td>
                            <td className="px-3 py-1.5" style={{ color: T_TEXT_PRIMARY }}>{r[cfg.valueField]}</td>
                            <td className="px-3 py-1.5">
                              <div className="flex items-center gap-2">
                                <button onClick={() => { setEditId(r.id); setEditRow({ key: r[cfg.keyField], value: r[cfg.valueField] }); }} title="Edit" style={{ color: T_BLUE }}><Pencil className="w-3.5 h-3.5" /></button>
                                <button onClick={() => handleDelete(r)} disabled={busy} title="Remove" style={{ color: T_DANGER }}><Trash2 className="w-3.5 h-3.5" /></button>
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <p className="text-[10px]" style={{ color: T_TEXT_SECONDARY }}>
            Edit masters here only — the Sheet's Vendor_Master / SKU_Master tabs are overwritten from this list on every save.
          </p>
        </div>
      </div>
    </div>
  );
}

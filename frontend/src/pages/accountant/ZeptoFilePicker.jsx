import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import api from '../../lib/api';
import { Loader2, Search, X, Upload, FileText, FolderInput } from 'lucide-react';

// Zepto Receivables file slots. Paste a Drive folder → Scan auto-drops each
// detected file into its slot; anything unrecognized lands in "Unassigned".
// The user can move a file between slots, remove it, or upload files manually.
// The run uses EXACTLY what ends up in the slots.
const SLOTS = [
  { key: 'invoice_details', label: 'Invoice Details', accept: '.xlsx,.xls', hint: 'Tally export — all months (prior + new)' },
  { key: 'zepto_payment',   label: 'Zepto Payment Track', accept: '.xlsx,.xls', hint: 'PO / GRN / LRN sheet (latest, cumulative)' },
  { key: 'grn_list',        label: 'GRN List', accept: '.csv,.xlsx', hint: 'Monthly GRN_List (April–June…)' },
  { key: 'payment_advice',  label: 'Payment Advice', accept: '.pdf', hint: 'Zepto payment-advice PDFs (incl. subfolders)' },
  { key: 'credit_note',     label: 'Credit Notes', accept: '.xlsx,.xls', hint: 'Tally credit-note details — all months' },
  { key: 'lrn',             label: 'LRN / POD', accept: '.xlsx,.xls', hint: 'Drips / CLS LRN sheets (optional)' },
];
const SLOT_KEYS = SLOTS.map((s) => s.key);
const LABEL = Object.fromEntries(SLOTS.map((s) => [s.key, s.label]));
const UNASSIGNED = '_unassigned';

let _uid = 0;
const uid = () => `f${++_uid}`;

export default function ZeptoFilePicker({ onChange }) {
  const [driveUrl, setDriveUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  // items: { uid, kind:'drive'|'upload', id?, name, file?, slot }
  const [items, setItems] = useState([]);

  useEffect(() => {
    const assignments = {}, uploads = {};
    for (const it of items) {
      if (it.slot === UNASSIGNED) continue;
      if (it.kind === 'drive') (assignments[it.slot] = assignments[it.slot] || []).push({ id: it.id, name: it.name });
      else (uploads[it.slot] = uploads[it.slot] || []).push(it.file);
    }
    onChange && onChange({ assignments, uploads, driveUrl });
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    if (!driveUrl.trim()) { toast.error('Paste a Google Drive folder URL first'); return; }
    setScanning(true);
    try {
      const { data } = await api.post('/api/reco/detect-files', { folder_url: driveUrl.trim() });
      const next = [];
      for (const f of (data.files || []))
        next.push({ uid: uid(), kind: 'drive', id: f.id, name: f.name, slot: SLOT_KEYS.includes(f.type) ? f.type : UNASSIGNED });
      for (const f of (data.ignored || []))
        next.push({ uid: uid(), kind: 'drive', id: f.id, name: f.name, slot: UNASSIGNED });
      setItems((prev) => [...prev.filter((it) => it.kind === 'upload'), ...next]);   // keep manual uploads
      const un = next.filter((n) => n.slot === UNASSIGNED).length;
      toast.success(`Found ${data.files?.length || 0} recognized file(s)${un ? `, ${un} unassigned` : ''}`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not scan the folder');
    } finally { setScanning(false); }
  };

  const move = (u, slot) => setItems((p) => p.map((it) => (it.uid === u ? { ...it, slot } : it)));
  const remove = (u) => setItems((p) => p.filter((it) => it.uid !== u));
  const addUploads = (slot, list) => {
    const adds = Array.from(list || []).map((file) => ({ uid: uid(), kind: 'upload', name: file.name, file, slot }));
    if (adds.length) setItems((p) => [...p, ...adds]);
  };
  const bySlot = (slot) => items.filter((it) => it.slot === slot);

  const inp = {
    flex: 1, padding: '10px 12px', borderRadius: 10, fontSize: 13,
    border: '1.5px solid var(--card-border, #E2E8F6)', background: 'var(--card-bg, #fff)',
    color: 'var(--text-body, #334155)', fontFamily: 'DM Sans', outline: 'none',
  };
  const sel = {
    fontSize: 11, padding: '2px 4px', borderRadius: 6, border: '1px solid var(--card-border, #E2E8F6)',
    background: 'var(--card-bg, #fff)', color: 'var(--text-muted, #64748B)', cursor: 'pointer',
  };

  const Chip = ({ it }) => (
    <div title={it.name} style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 8,
      background: 'var(--page-bg, #F8FAFC)', border: '1px solid var(--card-border, #EEF2F9)', fontSize: 12,
    }}>
      <FileText style={{ width: 13, height: 13, color: it.kind === 'upload' ? '#0F9D58' : '#64748B', flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-body, #334155)' }} title={it.name}>{it.name}</span>
      {it.kind === 'upload' && <span style={{ fontSize: 9, fontWeight: 700, color: '#0F9D58' }}>UPLOAD</span>}
      <select value={it.slot} onChange={(e) => move(it.uid, e.target.value)} style={sel} title="Move to slot">
        {SLOTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        <option value={UNASSIGNED}>Unassigned</option>
      </select>
      <button onClick={() => remove(it.uid)} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
        <X style={{ width: 14, height: 14, color: '#DC2626' }} />
      </button>
    </div>
  );

  const unassigned = bySlot(UNASSIGNED);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Drive URL + Scan */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={driveUrl} onChange={(e) => setDriveUrl(e.target.value)} placeholder="Paste a Google Drive folder URL…"
          onKeyDown={(e) => e.key === 'Enter' && scan()} style={inp} />
        <button onClick={scan} disabled={scanning} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10,
          fontSize: 13, fontWeight: 700, fontFamily: 'Barlow', border: 'none', cursor: scanning ? 'default' : 'pointer',
          background: '#0748EE', color: '#fff', opacity: scanning ? 0.6 : 1, whiteSpace: 'nowrap',
        }}>
          {scanning ? <Loader2 style={{ width: 15, height: 15 }} className="animate-spin" /> : <Search style={{ width: 15, height: 15 }} />}
          {scanning ? 'Scanning…' : 'Scan folder'}
        </button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted, #64748B)', margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <FolderInput style={{ width: 13, height: 13 }} /> Scan auto-fills the slots below. Fix any misfiled file with its slot dropdown, or upload manually. The run uses exactly what's in the slots.
      </p>

      {/* Slots */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
        {SLOTS.map((s) => {
          const files = bySlot(s.key);
          return (
            <div key={s.key} style={{ border: '1.5px solid var(--card-border, #E2E8F6)', borderRadius: 12, padding: 12, background: 'var(--card-bg, #fff)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 800, fontFamily: 'Barlow', color: 'var(--text-heading, #0F172A)' }}>{s.label}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: files.length ? '#16A34A' : 'var(--text-muted, #94A3B8)' }}>{files.length} file{files.length === 1 ? '' : 's'}</span>
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted, #94A3B8)', marginTop: -4 }}>{s.hint}</span>
              {files.map((it) => <Chip key={it.uid} it={it} />)}
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start', fontSize: 12, fontWeight: 700, color: '#0748EE', cursor: 'pointer', fontFamily: 'Barlow' }}>
                <Upload style={{ width: 13, height: 13 }} /> Upload
                <input type="file" accept={s.accept} multiple style={{ display: 'none' }}
                  onChange={(e) => { addUploads(s.key, e.target.files); e.target.value = ''; }} />
              </label>
            </div>
          );
        })}
      </div>

      {/* Unassigned tray */}
      {unassigned.length > 0 && (
        <div style={{ border: '1.5px dashed #F59E0B', borderRadius: 12, padding: 12, background: 'rgba(245,158,11,0.06)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 800, fontFamily: 'Barlow', color: '#B45309' }}>
            Unassigned ({unassigned.length}) — pick a slot for each, or leave out
          </span>
          {unassigned.map((it) => <Chip key={it.uid} it={it} />)}
        </div>
      )}
    </div>
  );
}

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  Landmark, ChevronLeft, ChevronRight, Plus, X, Loader2, Building2,
  LayoutGrid, List as ListIcon, CalendarDays, Paperclip, Trash2, UploadCloud,
  HardDrive, Check, GripVertical, FileCheck2, Calendar, Tag, MapPin, AlignLeft, ExternalLink, ChevronDown, MessageCircle,
} from 'lucide-react';
import api, { API_URL } from '../../lib/api';
import { toast } from 'sonner';
import { sidebarFor } from '../../lib/adminNav';
import AdminChatPanel from '../../components/AdminChatPanel';
import {
  STATUTORY_CATEGORIES, CATEGORY_BY_KEY, STATUTORY_STATUS_COLUMNS,
  GST_STATES, PT_STATES, ALL_STATES,
} from '../../lib/statutoryMeta';
import StatutoryFilters, { applyStatutoryFilters } from '../../components/StatutoryFilters';

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const COLUMNS = STATUTORY_STATUS_COLUMNS;
const catColor = (r) => CATEGORY_BY_KEY[r.compliance_type]?.color || '#64748B';
const catName = (r) => CATEGORY_BY_KEY[r.compliance_type]?.name || r.compliance_type;
const nowMonth = () => new Date().getMonth() + 1;
const fmtDay = (d) => { try { return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); } catch { return ''; } };
const fmtSize = (b) => (b == null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const attHref = (a) => (a.url?.startsWith('http') || a.url?.startsWith('blob:')) ? a.url : `${API_URL}${a.url || ''}`;
const fileKind = (name = '', mime = '') => {
  const e = (name.split('.').pop() || '').toLowerCase();
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(e)) return { k: 'image', color: '#7C3AED', label: (e || 'IMG').toUpperCase() };
  if (e === 'pdf' || mime.includes('pdf')) return { k: 'pdf', color: '#E11D48', label: 'PDF' };
  if (['xlsx', 'xls'].includes(e) || mime.includes('sheet')) return { k: 'xls', color: '#059669', label: 'XLS' };
  if (e === 'csv') return { k: 'csv', color: '#0EA5E9', label: 'CSV' };
  return { k: 'file', color: '#64748B', label: (e || 'FILE').toUpperCase() };
};

/* ── filing card ──────────────────────────────────────────────────────────── */
function FilingCard({ row, onOpen, onDragStart, onDragEnd, dragging }) {
  const color = catColor(row);
  const canDrag = !!onDragStart;
  return (
    <div role="button" tabIndex={0}
      onClick={() => onOpen(row)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(row); }}
      draggable={canDrag} onDragStart={onDragStart} onDragEnd={onDragEnd}
      className="glass-card"
      style={{ width: '100%', textAlign: 'left', padding: '12px 13px', marginBottom: 10, borderLeft: `3px solid ${color}`, cursor: canDrag ? 'grab' : 'pointer', display: 'block', opacity: dragging ? 0.4 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        {canDrag && <GripVertical style={{ width: 13, height: 13, color: 'var(--text-muted)', opacity: 0.45, marginLeft: -3 }} />}
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', padding: '2px 8px', borderRadius: 999, background: `${color}18`, color, border: `1px solid ${color}33` }}>{catName(row)}</span>
        {row.state && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}><MapPin style={{ width: 11, height: 11 }} /> {row.state}</span>}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', lineHeight: 1.35, marginBottom: 6 }}>{row.title}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>{row.period_label || ''}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--text-muted)' }}>
        {row.due_date && <span>Due {fmtDay(row.due_date)}</span>}
        {row.status === 'filed' && row.filing_date && <span style={{ color: '#059669', fontWeight: 600 }}>Filed {fmtDay(row.filing_date)}</span>}
        {Number(row.attachment_count) > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Paperclip style={{ width: 12, height: 12 }} /> {row.attachment_count}</span>}
      </div>
    </div>
  );
}

/* ── attachments (upload + Drive), entity 'statutory_filing' ─────────────── */
function StatutoryAttachments({ filingId, brandId }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [showDrive, setShowDrive] = useState(false);
  const [driveFiles, setDriveFiles] = useState(null);
  const load = useCallback(() => {
    if (!filingId) return;
    api.get(`/api/attachments/statutory_filing/${filingId}`).then(r => setItems(r.data || [])).catch(() => {});
  }, [filingId]);
  useEffect(() => { load(); }, [load]);
  const onUpload = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    setBusy(true); const fd = new FormData(); fd.append('file', file);
    try { await api.post(`/api/attachments/statutory_filing/${filingId}/upload`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }); toast.success('File attached'); load(); }
    catch { toast.error('Upload failed'); } finally { setBusy(false); e.target.value = ''; }
  };
  const openDrive = async () => { setShowDrive(true); if (driveFiles) return; try { const r = await api.get(`/api/brands/${brandId}/drive`); setDriveFiles((r.data?.files || []).filter(f => !f.isFolder)); } catch { setDriveFiles([]); } };
  const linkDrive = async (f) => { try { await api.post(`/api/attachments/statutory_filing/${filingId}/drive`, { driveFileId: f.id, fileName: f.name, mimeType: f.mimeType, driveUrl: f.webViewLink }); toast.success('Drive file linked'); setShowDrive(false); load(); } catch { toast.error('Could not link'); } };
  const remove = async (id) => { try { await api.delete(`/api/attachments/${id}`); load(); } catch { toast.error('Remove failed'); } };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <label style={{ ...miniBtn, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> : <UploadCloud style={{ width: 13, height: 13 }} />} Upload
          <input type="file" accept=".pdf,.xlsx,.xls,.csv,image/*" hidden onChange={onUpload} disabled={busy} />
        </label>
        <button style={miniBtn} onClick={openDrive}><HardDrive style={{ width: 13, height: 13 }} /> From Drive</button>
      </div>
      {items.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No attachments yet.</div>}
      {items.map(a => {
        const kind = fileKind(a.fileName, a.mimeType); const href = attHref(a);
        return (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: 8, borderRadius: 12, border: '1px solid var(--card-border)', background: 'var(--surface)', marginBottom: 8 }}>
            <div style={{ width: 40, height: 40, borderRadius: 9, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${kind.color}14`, border: `1px solid ${kind.color}33` }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: kind.color }}>{kind.label}</span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.fileName}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{a.source === 'drive' ? 'Google Drive' : fmtSize(a.fileSize)}</div>
            </div>
            <a href={href} target="_blank" rel="noreferrer" style={{ width: 30, height: 30, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', border: '1px solid var(--card-border)' }}><ExternalLink style={{ width: 14, height: 14 }} /></a>
            <button onClick={() => remove(a.id)} style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid var(--card-border)', background: 'transparent', cursor: 'pointer', color: '#E11D48', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 style={{ width: 14, height: 14 }} /></button>
          </div>
        );
      })}
      {showDrive && (
        <div style={overlay} onClick={() => setShowDrive(false)}>
          <div className="glass-card" style={{ width: 460, maxHeight: '70vh', overflowY: 'auto', padding: 16 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontWeight: 700, color: 'var(--text-heading)' }}>Pick from Google Drive</span>
              <button onClick={() => setShowDrive(false)} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer' }}><X style={{ width: 16, height: 16 }} /></button>
            </div>
            {driveFiles === null && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading Drive…</div>}
            {driveFiles && driveFiles.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No files found. Set the brand's Drive folder under Integrations.</div>}
            {driveFiles && driveFiles.map(f => (
              <button key={f.id} onClick={() => linkDrive(f)} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', marginBottom: 4, border: '1px solid var(--card-border)', borderRadius: 10, background: 'var(--surface)', cursor: 'pointer', fontSize: 12, color: 'var(--text-heading)', fontWeight: 600 }}>
                <HardDrive style={{ width: 14, height: 14, color: '#0748EE' }} /> {f.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── create / detail slide-over ──────────────────────────────────────────── */
function FilingPanel({ mode, row, brandId, onClose, onSaved }) {
  const isCreate = mode === 'create';
  const [form, setForm] = useState(() => ({
    compliance_type: row?.compliance_type || 'gstr_1',
    title: row?.title || '',
    period_label: row?.period_label || '',
    period_type: row?.period_type || 'monthly',
    state: row?.state || '',
    status: row?.status || 'not_due',
    due_date: row?.due_date ? row.due_date.slice(0, 10) : '',
    filing_date: row?.filing_date ? row.filing_date.slice(0, 10) : '',
    ack_no: row?.ack_no || '',
    note: row?.note || '',
  }));
  const [saving, setSaving] = useState(false);
  const [createdId, setCreatedId] = useState(row?.id || null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const cat = CATEGORY_BY_KEY[form.compliance_type];
  const accent = cat?.color || '#0748EE';

  const save = async () => {
    if (!form.title.trim()) return toast.error('Title is required');
    setSaving(true);
    try {
      if (isCreate && !createdId) {
        const r = await api.post(`/api/brands/${brandId}/statutory`, { ...form, year: row?.year, month: row?.month });
        setCreatedId(r.data.id); toast.success('Filing created');
      } else {
        await api.patch(`/api/statutory/${createdId}`, form); toast.success('Saved');
      }
      onSaved();
    } catch { toast.error('Save failed'); } finally { setSaving(false); }
  };
  const quickStatus = async (status) => {
    setForm(f => ({ ...f, status }));
    if (createdId) { try { await api.patch(`/api/statutory/${createdId}`, { status }); onSaved(); } catch { toast.error('Update failed'); } }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <div style={{ height: 3, background: accent, flexShrink: 0 }} />
        <div style={{ display: 'flex', alignItems: 'center', padding: '18px 22px 14px', flexShrink: 0 }}>
          <span style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 15, color: 'var(--text-heading)' }}>{isCreate ? 'New Filing' : 'Filing details'}</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'var(--page-bg)', cursor: 'pointer', width: 30, height: 30, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><X style={{ width: 16, height: 16, color: 'var(--text-muted)' }} /></button>
        </div>
        <div style={{ padding: '0 22px 22px', overflowY: 'auto', flex: 1 }}>
          <input value={form.title} onChange={e => set('title', e.target.value)} placeholder="Filing title"
            style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'Manrope', fontSize: 19, fontWeight: 800, color: 'var(--text-heading)', padding: '2px 0 14px', borderBottom: '1px solid var(--card-border)', marginBottom: 6 }} />

          <MetaRow icon={Tag} label="Compliance">
            <select value={form.compliance_type} onChange={e => set('compliance_type', e.target.value)} style={ctrl}>
              {STATUTORY_CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.name}</option>)}
            </select>
          </MetaRow>
          {cat?.stateWise && (
            <MetaRow icon={MapPin} label="State">
              <select value={form.state} onChange={e => set('state', e.target.value)} style={ctrl}>
                <option value="">—</option>
                {(form.compliance_type === 'pt' ? PT_STATES : form.compliance_type.startsWith('gstr') ? GST_STATES : ALL_STATES).map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </MetaRow>
          )}
          <MetaRow icon={Calendar} label="Period">
            <input value={form.period_label} onChange={e => set('period_label', e.target.value)} placeholder="e.g. July 2026 / Q1 / FY 2025-26" style={ctrl} />
          </MetaRow>
          <MetaRow icon={Calendar} label="Due date"><input type="date" value={form.due_date} onChange={e => set('due_date', e.target.value)} style={{ ...ctrl, width: 180 }} /></MetaRow>
          {!isCreate && (
            <MetaRow icon={FileCheck2} label="Status" align="top">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {COLUMNS.map(c => (
                  <button key={c.key} onClick={() => quickStatus(c.key)} style={{ ...chip, borderColor: form.status === c.key ? c.color : 'var(--card-border)', color: form.status === c.key ? c.color : 'var(--text-muted)', background: form.status === c.key ? `${c.color}12` : 'transparent', fontWeight: 700 }}>{c.label}</button>
                ))}
              </div>
            </MetaRow>
          )}
          <MetaRow icon={Calendar} label="Filing date"><input type="date" value={form.filing_date} onChange={e => set('filing_date', e.target.value)} style={{ ...ctrl, width: 180 }} /></MetaRow>
          <MetaRow icon={FileCheck2} label="Ack / SRN"><input value={form.ack_no} onChange={e => set('ack_no', e.target.value)} placeholder="Acknowledgement / SRN / Challan / UDIN" style={ctrl} /></MetaRow>

          <div style={{ marginTop: 10, marginBottom: 16 }}>
            <div style={{ ...rowLabel, display: 'flex', alignItems: 'center', gap: 7 }}><AlignLeft style={{ width: 13, height: 13 }} /> Note</div>
            <textarea value={form.note} onChange={e => set('note', e.target.value)} placeholder="Applicability / remarks…" rows={3} style={{ ...ctrl, resize: 'vertical' }} />
          </div>
          {row?.applicability && (
            <div style={{ marginBottom: 16, padding: '11px 13px', borderRadius: 12, background: 'var(--page-bg)', border: '1px solid var(--card-border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 4 }}>Applicability</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-heading)', lineHeight: 1.45 }}>{row.applicability}</div>
            </div>
          )}
          <div style={{ marginTop: 4 }}>
            <div style={{ ...rowLabel, display: 'flex', alignItems: 'center', gap: 7 }}><Paperclip style={{ width: 13, height: 13 }} /> Attachments (acknowledgement / challan)</div>
            {createdId ? <StatutoryAttachments filingId={createdId} brandId={brandId} /> : <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Save the filing to attach files.</div>}
          </div>
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--card-border)', display: 'flex', gap: 10, flexShrink: 0 }}>
          <button onClick={save} disabled={saving} style={{ ...miniBtn, flex: 1, justifyContent: 'center', background: '#0748EE', color: '#fff', border: 'none', fontWeight: 700, padding: '11px 18px' }}>
            {saving ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : <Check style={{ width: 14, height: 14 }} />}
            {isCreate && !createdId ? 'Create filing' : 'Save changes'}
          </button>
          <button onClick={onClose} style={{ ...miniBtn, padding: '11px 18px' }}>Close</button>
        </div>
      </div>
    </div>
  );
}
const MetaRow = ({ icon: Icon, label, children, align = 'center' }) => (
  <div style={{ display: 'flex', alignItems: align === 'top' ? 'flex-start' : 'center', gap: 12, padding: '9px 0' }}>
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, width: 108, flexShrink: 0, color: 'var(--text-muted)', paddingTop: align === 'top' ? 5 : 0 }}>
      <Icon style={{ width: 15, height: 15 }} /><span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
  </div>
);

/* ── calendar (place by due_date) ─────────────────────────────────────────── */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function CalendarView({ rows, year, month, onOpen }) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();
  const today = new Date();
  const isToday = (d) => today.getFullYear() === year && (today.getMonth() + 1) === month && today.getDate() === d;
  const byDay = {};
  rows.forEach(r => { if (!r.due_date) return; const d = new Date(r.due_date); if (d.getFullYear() === year && (d.getMonth() + 1) === month) (byDay[d.getDate()] = byDay[d.getDate()] || []).push(r); });
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return (
    <div className="glass-card" style={{ padding: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6, marginBottom: 6 }}>
        {WEEKDAYS.map(w => <div key={w} style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'center', padding: '4px 0' }}>{w}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6 }}>
        {cells.map((d, i) => (
          <div key={i} style={{ minHeight: 98, borderRadius: 10, border: '1px solid var(--card-border)', background: d ? 'var(--surface)' : 'transparent', padding: d ? 6 : 0, display: 'flex', flexDirection: 'column', gap: 3, overflow: 'hidden' }}>
            {d && (<>
              <div style={{ fontSize: 11, fontWeight: 700, alignSelf: 'flex-start', color: isToday(d) ? '#fff' : 'var(--text-muted)', ...(isToday(d) ? { background: '#0748EE', borderRadius: 999, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' } : {}) }}>{d}</div>
              {(byDay[d] || []).slice(0, 3).map(r => (
                <button key={r.id} onClick={() => onOpen(r)} title={`${catName(r)} — ${r.title}${r.state ? ' — ' + r.state : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', textAlign: 'left', border: 'none', background: `${catColor(r)}14`, borderRadius: 6, padding: '3px 6px', cursor: 'pointer' }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: catColor(r), flexShrink: 0 }} />
                  <span style={{ fontSize: 10.5, color: 'var(--text-heading)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{catName(r)}{r.state ? ` · ${r.state}` : ''}</span>
                </button>
              ))}
              {(byDay[d] || []).length > 3 && <span style={{ fontSize: 10, color: 'var(--text-muted)', paddingLeft: 2 }}>+{byDay[d].length - 3} more</span>}
            </>)}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── whole-year calendar (12 mini months, plotted by due date) ───────────── */
/* Hover card listing a day's filings — category-colored border, meta, note, chip.
   Opens up/down and left/right based on the cell position so it never spills. */
function DayPopover({ rows, rect }) {
  const W = 250, MAXH = 264;
  let left = rect.left;
  if (left + W > window.innerWidth - 8) left = window.innerWidth - 8 - W; // keep on-screen (right)
  if (left < 8) left = 8;                                                 // keep on-screen (left)
  const estH = Math.min(MAXH, 42 + rows.length * 72);
  let top = rect.bottom + 6;
  if (top + estH > window.innerHeight - 8) top = Math.max(8, rect.top - estH - 6); // flip above
  return (
    <div className="glass-card" onClick={e => e.stopPropagation()}
      style={{ position: 'fixed', left, top, zIndex: 2000, width: W, maxHeight: MAXH, overflowY: 'auto', padding: 8, textAlign: 'left', cursor: 'default', background: 'var(--surface)', boxShadow: '0 16px 40px rgba(10,15,46,0.26)' }}>
      <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 6, position: 'sticky', top: 0, background: 'var(--surface)', paddingBottom: 2 }}>
        {rows.length} filing{rows.length > 1 ? 's' : ''}
      </div>
      {rows.map((r, idx) => {
        const color = catColor(r);
        return (
          <div key={r.id || idx} style={{ borderLeft: `3px solid ${color}`, background: 'var(--surface)', border: '1px solid var(--card-border)', borderLeftWidth: 3, borderRadius: 8, padding: '7px 9px', marginBottom: idx < rows.length - 1 ? 6 : 0 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-heading)', lineHeight: 1.3 }}>{r.title}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{[r.period_label, r.state, r.due_date ? `Due ${fmtDay(r.due_date)}` : ''].filter(Boolean).join(' · ')}</div>
            {r.note && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.35 }}>{r.note.length > 140 ? r.note.slice(0, 140) + '…' : r.note}</div>}
            <div style={{ marginTop: 6 }}>
              <span style={{ fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color, background: `${color}18`, border: `1px solid ${color}33`, borderRadius: 999, padding: '1px 7px' }}>{catName(r)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function YearCalendar({ rows, year, onOpenMonth }) {
  const today = new Date();
  const [hover, setHover] = useState(null);
  const byMonth = {};
  rows.forEach(r => { if (!r.due_date) return; const d = new Date(r.due_date); if (d.getFullYear() !== year) return; const m = d.getMonth(); byMonth[m] = byMonth[m] || {}; (byMonth[m][d.getDate()] = byMonth[m][d.getDate()] || []).push(r); });
  return (
    <>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
      {Array.from({ length: 12 }).map((_, m) => {
        const isCur = m === today.getMonth() && year === today.getFullYear();
        const days = new Date(year, m + 1, 0).getDate();
        const first = new Date(year, m, 1).getDay();
        const monthRows = byMonth[m] || {};
        const count = Object.values(monthRows).reduce((a, arr) => a + arr.length, 0);
        const cells = [];
        for (let i = 0; i < first; i++) cells.push(null);
        for (let d = 1; d <= days; d++) cells.push(d);
        return (
          <button key={m} onClick={() => onOpenMonth(m + 1)} className="glass-card"
            style={{ padding: 12, textAlign: 'left', cursor: 'pointer', border: isCur ? '1.5px solid #0748EE' : '1px solid var(--card-border)', boxShadow: isCur ? '0 0 0 3px #0748EE18' : undefined }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: isCur ? '#0748EE' : 'var(--text-heading)' }}>{MONTHS[m + 1]}</span>
              {isCur && <span style={{ fontSize: 9, fontWeight: 800, color: '#0748EE', background: '#0748EE14', borderRadius: 999, padding: '1px 6px', marginLeft: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>This month</span>}
              {count > 0 && <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: '#0748EE', background: '#0748EE12', borderRadius: 999, padding: '1px 7px' }}>{count}</span>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => <div key={`h${i}`} style={{ fontSize: 8.5, textAlign: 'center', color: 'var(--text-muted)', fontWeight: 700 }}>{w}</div>)}
              {cells.map((d, i) => {
                const has = d && monthRows[d];
                const isToday = isCur && d === today.getDate();
                return (
                  <div key={i}
                    onMouseEnter={has ? (e) => setHover({ rows: has, rect: e.currentTarget.getBoundingClientRect() }) : undefined}
                    onMouseLeave={has ? () => setHover(null) : undefined}
                    style={{
                      position: 'relative', height: 22, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: isToday ? 999 : 5,
                      fontSize: 9.5, fontWeight: (isToday || has) ? 700 : 400, cursor: has ? 'pointer' : 'default',
                      color: isToday ? '#fff' : d ? 'var(--text-heading)' : 'transparent',
                      background: isToday ? '#0748EE' : has ? `${catColor(has[0])}18` : 'transparent',
                    }}>
                    {d || ''}
                    {has && !isToday && <span style={{ width: 3, height: 3, borderRadius: 999, background: catColor(has[0]), marginTop: 1 }} />}
                  </div>
                );
              })}
            </div>
          </button>
        );
      })}
    </div>
    {hover && <DayPopover rows={hover.rows} rect={hover.rect} />}
    </>
  );
}

/* ── month/year calendar picker (jump to any period) ─────────────────────── */
function MonthYearPicker({ year, month, onStep, onPick }) {
  const [open, setOpen] = useState(false);
  const [vy, setVy] = useState(year);
  const ref = useRef(null);
  useEffect(() => { if (open) setVy(year); }, [open, year]);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return (
    <div ref={ref} style={{ marginLeft: 'auto', position: 'relative', display: 'flex', alignItems: 'center', gap: 4, background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 12, padding: '6px 8px' }}>
      <button onClick={() => onStep(-1)} style={iconBtn}><ChevronLeft style={{ width: 16, height: 16 }} /></button>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 122, justifyContent: 'center', border: 'none', background: 'transparent', cursor: 'pointer', fontWeight: 700, fontSize: 13, color: 'var(--text-heading)' }}>
        {MONTHS[month]} {year} <ChevronDown style={{ width: 13, height: 13, opacity: 0.6 }} />
      </button>
      <button onClick={() => onStep(1)} style={iconBtn}><ChevronRight style={{ width: 16, height: 16 }} /></button>
      {open && (
        <div className="glass-card" style={{ position: 'absolute', top: '118%', right: 0, zIndex: 60, padding: 12, width: 264 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <button onClick={() => setVy(y => y - 1)} style={iconBtn}><ChevronLeft style={{ width: 16, height: 16 }} /></button>
            <span style={{ fontWeight: 800, fontFamily: 'Manrope', fontSize: 15, color: 'var(--text-heading)' }}>{vy}</span>
            <button onClick={() => setVy(y => y + 1)} style={iconBtn}><ChevronRight style={{ width: 16, height: 16 }} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
            {M.map((m, i) => {
              const on = (i + 1) === month && vy === year;
              return (
                <button key={m} onClick={() => { onPick(vy, i + 1); setOpen(false); }} style={{ padding: '9px 0', borderRadius: 9, border: `1px solid ${on ? '#0748EE' : 'var(--card-border)'}`, background: on ? '#0748EE12' : 'var(--surface)', color: on ? '#0748EE' : 'var(--text-heading)', fontWeight: on ? 700 : 600, fontSize: 12.5, cursor: 'pointer' }}>{m}</button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── main page ───────────────────────────────────────────────────────────── */
export default function StatutoryTracker() {
  const { brandId } = useParams();
  const [brands, setBrands] = useState([]);
  const [allRows, setAllRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(nowMonth());
  const [view, setView] = useState(() => (typeof window !== 'undefined' && /[?&]view=calendar/.test(window.location.search) ? 'calendar' : 'kanban'));
  const [activeCat, setActiveCat] = useState('all');
  const [filters, setFilters] = useState({ quick: { state: '', periodType: '', status: '' }, conditions: [] });
  const [panel, setPanel] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [dragOverCol, setDragOverCol] = useState(null);
  const [showChat, setShowChat] = useState(false);
  const [calMode, setCalMode] = useState('year'); // 'month' | 'year' — Calendar opens on the whole year

  useEffect(() => { if (brandId) { try { localStorage.setItem('lastBrandId', brandId); } catch (_) {} } }, [brandId]);
  useEffect(() => { api.get('/api/brands/my-brands').then(r => setBrands(Array.isArray(r.data) ? r.data : [])).catch(() => {}); }, []);

  const load = useCallback(() => {
    setLoading(true); setDenied(false);
    api.get(`/api/brands/${brandId}/statutory`, { params: { year } })
      .then(r => setAllRows(r.data || []))
      .catch(err => { if (err.response?.status === 403) setDenied(true); setAllRows([]); })
      .finally(() => setLoading(false));
  }, [brandId, year]);
  useEffect(() => { load(); }, [load]);

  const brand = brands.find(b => b.id === brandId);
  const brandStates = ALL_STATES;

  // A custom Period range (from filters) spans months, so it overrides the
  // single-month scope. Otherwise: monthly items match the selected month;
  // quarterly/annual/event (no month) always show.
  const rangeActive = !!(filters.quick.dateFrom || filters.quick.dateTo);
  const scoped = useMemo(() => {
    let rows = allRows;
    if (!rangeActive) rows = rows.filter(r => r.month == null || r.month === month);
    if (activeCat !== 'all') rows = rows.filter(r => r.compliance_type === activeCat);
    return applyStatutoryFilters(rows, filters);
  }, [allRows, month, activeCat, filters, rangeActive]);

  // Calendar plots by DUE DATE, so it must not be scoped to the period-month
  // (e.g. a June GSTR-3B is due 20 July). Category + custom filters still apply.
  const calRows = useMemo(() => {
    let rows = allRows;
    if (activeCat !== 'all') rows = rows.filter(r => r.compliance_type === activeCat);
    return applyStatutoryFilters(rows, filters);
  }, [allRows, activeCat, filters]);

  const grouped = useMemo(() => {
    const g = { not_due: [], pending: [], filed: [], not_applicable: [] };
    scoped.forEach(r => { (g[r.status] || g.not_due).push(r); });
    return g;
  }, [scoped]);
  const filedCount = grouped.filed.length;
  const pct = scoped.length ? Math.round((filedCount / scoped.length) * 100) : 0;

  const stepMonth = (dir) => setMonth(m => { let nm = m + dir; if (nm < 1) { nm = 12; setYear(y => y - 1); } else if (nm > 12) { nm = 1; setYear(y => y + 1); } return nm; });

  const moveFiling = async (id, status) => {
    const r = allRows.find(x => x.id === id);
    if (!r || r.status === status) return;
    setAllRows(prev => prev.map(x => x.id === id ? { ...x, status, filing_date: status === 'filed' && !x.filing_date ? new Date().toISOString().slice(0, 10) : x.filing_date } : x));
    try { await api.patch(`/api/statutory/${id}`, { status }); } catch { toast.error('Could not move filing'); load(); }
  };
  const onDropCol = (colKey) => (e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); setDragOverCol(null); setDragId(null); if (id) moveFiling(id, colKey); };

  const sidebarItems = sidebarFor([{ path: `/brands/${brandId}/statutory-compliance`, label: 'Statutory Compliance', icon: Landmark }]);

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div style={{ padding: 24, maxWidth: 1500 }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
          <div style={{ width: 46, height: 46, borderRadius: 14, background: '#0748EE15', border: '1px solid #0748EE30', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Landmark style={{ width: 22, height: 22, color: '#0748EE' }} />
          </div>
          <div>
            <h1 style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 22, color: 'var(--text-heading)', lineHeight: 1.1 }}>Statutory Compliance</h1>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 13, color: 'var(--text-muted)' }}>
              <Building2 style={{ width: 14, height: 14, color: '#0748EE' }} /> {brand?.name || 'Brand'}
            </div>
          </div>
          <MonthYearPicker year={year} month={month} onStep={stepMonth} onPick={(y, m) => { setYear(y); setMonth(m); }} />
        </div>

        {/* view tabs + progress + new */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 12, padding: 4 }}>
            {[{ k: 'kanban', label: 'Kanban', icon: LayoutGrid }, { k: 'list', label: 'List', icon: ListIcon }, { k: 'calendar', label: 'Calendar', icon: CalendarDays }].map(v => (
              <button key={v.k} onClick={() => setView(v.k)} style={{ ...miniBtn, border: 'none', background: view === v.k ? '#0748EE' : 'transparent', color: view === v.k ? '#fff' : 'var(--text-muted)', fontWeight: 700 }}>
                <v.icon style={{ width: 14, height: 14 }} /> {v.label}
              </button>
            ))}
          </div>
          {scoped.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontFamily: 'Barlow', fontWeight: 900, fontSize: 18, color: 'var(--text-heading)', lineHeight: 1 }}>{filedCount}/{scoped.length}</div>
              <div>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-heading)', lineHeight: 1.15 }}>
                  {rangeActive
                    ? `${fmtDay(filters.quick.dateFrom) || '…'} – ${fmtDay(filters.quick.dateTo) || '…'}`
                    : `${MONTHS[month]} ${year}`}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>filings · {pct}% filed</div>
              </div>
            </div>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <button onClick={() => setShowChat(true)} style={{ ...miniBtn, fontWeight: 700, padding: '9px 14px' }}>
              <MessageCircle style={{ width: 15, height: 15 }} /> Chat with admin
            </button>
            <button onClick={() => setPanel({ mode: 'create', row: { year, month } })} style={{ ...miniBtn, background: '#0748EE', color: '#fff', border: 'none', fontWeight: 700, padding: '9px 16px' }}>
              <Plus style={{ width: 15, height: 15 }} /> New Filing
            </button>
          </div>
        </div>

        {/* category tabs */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <CatTab active={activeCat === 'all'} onClick={() => setActiveCat('all')} label="All" color="#0748EE" />
          {STATUTORY_CATEGORIES.map(c => <CatTab key={c.key} active={activeCat === c.key} onClick={() => setActiveCat(c.key)} label={c.name} color={c.color} />)}
        </div>

        {/* premium filter bar */}
        <div style={{ marginBottom: 18 }}>
          <StatutoryFilters value={filters} onChange={setFilters} brandStates={brandStates} />
        </div>

        {/* body */}
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Loader2 className="animate-spin" style={{ width: 30, height: 30, color: '#0748EE' }} /></div>
        ) : denied ? (
          <Empty title="Not available for this account" sub="The Statutory Compliance register is restricted." />
        ) : (view === 'calendar' ? calRows.length === 0 : scoped.length === 0) ? (
          <Empty title="No filings match" sub="Adjust the month, category or filters — or add a filing with New Filing." />
        ) : view === 'kanban' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(240px, 1fr))', gap: 14, overflowX: 'auto' }}>
            {COLUMNS.map(col => {
              const over = dragOverCol === col.key;
              return (
                <div key={col.key}
                  onDragOver={e => { e.preventDefault(); if (dragOverCol !== col.key) setDragOverCol(col.key); }}
                  onDragLeave={e => { if (e.currentTarget === e.target) setDragOverCol(null); }}
                  onDrop={onDropCol(col.key)}
                  style={{ borderRadius: 12, padding: 5, minHeight: 'calc(100vh - 360px)', transition: 'background .15s', background: over ? `${col.color}0f` : 'transparent', outline: over ? `2px dashed ${col.color}66` : '2px dashed transparent' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, paddingBottom: 8, borderBottom: `2px solid ${col.color}` }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: col.color }} />
                    <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-heading)' }}>{col.label}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>{grouped[col.key].length}</span>
                  </div>
                  {grouped[col.key].map(r => (
                    <FilingCard key={r.id} row={r} onOpen={(x) => setPanel({ mode: 'edit', row: x })} dragging={dragId === r.id}
                      onDragStart={(e) => { e.dataTransfer.setData('text/plain', r.id); e.dataTransfer.effectAllowed = 'move'; setDragId(r.id); }}
                      onDragEnd={() => { setDragId(null); setDragOverCol(null); }}
                      onDragOver={(e) => { e.preventDefault(); if (dragOverCol !== col.key) setDragOverCol(col.key); }}
                      onDrop={onDropCol(col.key)} />
                  ))}
                  {grouped[col.key].length === 0 && <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '18px 0', opacity: over ? 1 : 0.5 }}>{over ? 'Drop here' : '—'}</div>}
                </div>
              );
            })}
          </div>
        ) : view === 'list' ? (
          <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
            {scoped.map((r, i) => {
              const col = COLUMNS.find(c => c.key === r.status) || COLUMNS[0];
              return (
                <button key={r.id} onClick={() => setPanel({ mode: 'edit', row: r })} style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', borderTop: i ? '1px solid var(--card-border)' : 'none', borderLeft: `3px solid ${catColor(r)}`, background: 'var(--surface)', cursor: 'pointer' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '2px 8px', borderRadius: 999, background: `${catColor(r)}18`, color: catColor(r), whiteSpace: 'nowrap' }}>{catName(r)}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', flex: 1 }}>{r.title}{r.state ? ` · ${r.state}` : ''}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.period_label}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.due_date ? `Due ${fmtDay(r.due_date)}` : ''}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: col.color, minWidth: 90, textAlign: 'right' }}>{col.label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 10, padding: 3 }}>
                {[{ k: 'month', label: MONTHS[month] }, { k: 'year', label: `${year}` }].map(o => (
                  <button key={o.k} onClick={() => setCalMode(o.k)} style={{ ...miniBtn, border: 'none', padding: '6px 12px', background: calMode === o.k ? '#0748EE' : 'transparent', color: calMode === o.k ? '#fff' : 'var(--text-muted)', fontWeight: 700 }}>{o.label}</button>
                ))}
              </div>
            </div>
            {calMode === 'year'
              ? <YearCalendar rows={calRows} year={year} onOpenMonth={(m) => { setMonth(m); setCalMode('month'); }} />
              : <CalendarView rows={calRows} year={year} month={month} onOpen={(r) => setPanel({ mode: 'edit', row: r })} />}
          </div>
        )}
      </div>

      {panel && <FilingPanel mode={panel.mode} row={panel.row} brandId={brandId} onClose={() => setPanel(null)} onSaved={load} />}
      {showChat && <AdminChatPanel brandId={brandId} brandName={brand?.name || 'Brand'} onClose={() => setShowChat(false)} />}
    </DashboardLayout>
  );
}

const CatTab = ({ active, onClick, label, color }) => (
  <button onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${active ? color : 'var(--card-border)'}`, background: active ? `${color}14` : 'var(--surface)', color: active ? color : 'var(--text-muted)' }}>
    {active && <span style={{ width: 7, height: 7, borderRadius: 999, background: color }} />}{label}
  </button>
);
const Empty = ({ title, sub }) => (
  <div className="glass-card" style={{ padding: '56px 24px', textAlign: 'center' }}>
    <div style={{ width: 52, height: 52, borderRadius: 16, background: 'var(--page-bg)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}><Landmark style={{ width: 24, height: 24, color: 'var(--text-muted)' }} /></div>
    <div style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 16, color: 'var(--text-heading)', marginBottom: 6 }}>{title}</div>
    <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 420, margin: '0 auto' }}>{sub}</div>
  </div>
);

const overlay = { position: 'fixed', inset: 0, background: 'rgba(10,15,46,0.35)', zIndex: 60, display: 'flex', justifyContent: 'flex-end' };
const panel = { width: 'min(480px, 100%)', height: '100%', background: 'var(--surface)', display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 40px rgba(10,15,46,0.15)' };
const ctrl = { width: '100%', padding: '9px 12px', border: '1px solid var(--card-border)', borderRadius: 10, background: 'var(--page-bg)', color: 'var(--text-heading)', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const rowLabel = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 6 };
const chip = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 11px', borderRadius: 999, border: '1px solid var(--card-border)', background: 'transparent', fontSize: 12, cursor: 'pointer' };
const miniBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--card-border)', background: 'var(--surface)', color: 'var(--text-heading)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text-heading)', cursor: 'pointer' };

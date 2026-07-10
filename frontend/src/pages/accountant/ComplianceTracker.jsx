import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  CalendarCheck, ChevronLeft, ChevronRight, Plus, X, Loader2, Building2,
  LayoutGrid, List as ListIcon, ExternalLink, Paperclip, Trash2, UploadCloud,
  HardDrive, Check, Flag, ClipboardList, Tag, Calendar, TrendingUp, AlignLeft,
  ListChecks, MessageCircle, Send, CalendarDays, GripVertical,
} from 'lucide-react';
import api, { API_URL } from '../../lib/api';
import { toast } from 'sonner';
import { sidebarFor } from '../../lib/adminNav';

/* ── constants ───────────────────────────────────────────────────────────── */
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Kanban columns map to the DB status values.
const COLUMNS = [
  { key: 'todo',        label: 'To Do',       color: '#64748B' },
  { key: 'in_progress', label: 'In Progress', color: '#0748EE' },
  { key: 'review',      label: 'Review',      color: '#D97706' },
  { key: 'done',        label: 'Complete',    color: '#059669' },
];

const PRIORITY = {
  low:    { label: 'Low',    color: '#64748B' },
  medium: { label: 'Medium', color: '#0748EE' },
  high:   { label: 'High',   color: '#D97706' },
  urgent: { label: 'Urgent', color: '#E11D48' },
};

// Deep-link the 4 RECO agents from a linked task.
const AGENT_META = {
  '4e02cc5b-8fc8-4c79-8013-e7f510c850d5': 'GSTR-2B vs Books',
  'b2d3fad4-0d90-4b49-acdc-d243cfa9c8d5': 'GSTR-3B Tally Entry',
  '93d027ac-4333-403b-b448-9c637ebfc13c': 'Universal Bank Statement',
  '8b8d0876-3169-4511-96d8-2a7467478007': 'GSTR-1 vs Books',
};

const catColor = (t) => t.category_color || '#64748B';
const nowMonth = () => { const m = new Date().getMonth() + 1; return m; };

// Map the existing master-task statuses onto the tracker's Kanban columns
// (used by the Admin tab, which surfaces admin-assigned tasks from /api/tasks).
const MASTER_STATUS = { pending: 'todo', in_progress: 'in_progress', done: 'done', overdue: 'todo' };

/* ── completion ring ─────────────────────────────────────────────────────── */
function Ring({ pct, size = 34, color = '#0748EE' }) {
  const r = (size - 5) / 2;
  const c = 2 * Math.PI * r;
  const off = c - (pct / 100) * c;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--card-border)" strokeWidth="4" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="4"
        strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round" />
    </svg>
  );
}

/* ── one task card ───────────────────────────────────────────────────────── */
function TaskCard({ task, onOpen, onDragStart, onDragEnd, onDragOver, onDrop, dragging }) {
  const color = catColor(task);
  const prio = PRIORITY[task.priority] || PRIORITY.medium;
  const linked = task.agent_id && AGENT_META[task.agent_id];
  const canDrag = !!onDragStart;
  return (
    <div
      role="button" tabIndex={0}
      onClick={() => onOpen(task)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(task); }}
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="glass-card"
      style={{
        width: '100%', textAlign: 'left', padding: '12px 13px', marginBottom: 10,
        borderLeft: `3px solid ${color}`, cursor: canDrag ? 'grab' : 'pointer', display: 'block',
        opacity: dragging ? 0.4 : 1,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        {canDrag && <GripVertical style={{ width: 13, height: 13, color: 'var(--text-muted)', opacity: 0.45, marginLeft: -3 }} />}
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em',
          padding: '2px 8px', borderRadius: 999, background: `${color}18`, color, border: `1px solid ${color}33`,
        }}>{task.category_name || 'Uncategorised'}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: prio.color, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <Flag style={{ width: 11, height: 11 }} /> {prio.label}
        </span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', lineHeight: 1.35, marginBottom: 8 }}>
        {task.title}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
        {task.period ? `${task.period} · ` : ''}{task.data_source || '—'}{task.frequency ? ` · ${task.frequency}` : ''}
      </div>
      {/* progress bar */}
      <div style={{ height: 5, borderRadius: 999, background: 'var(--card-border)', overflow: 'hidden', marginBottom: 8 }}>
        <div style={{ height: '100%', width: `${task.progress || 0}%`, background: color, borderRadius: 999 }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--text-muted)' }}>
        <span>{task.progress || 0}%</span>
        {Number(task.attachment_count) > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Paperclip style={{ width: 12, height: 12 }} /> {task.attachment_count}
          </span>
        )}
        {linked && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3, color: '#0748EE', fontWeight: 600 }}>
            Open agent <ExternalLink style={{ width: 12, height: 12 }} />
          </span>
        )}
      </div>
    </div>
  );
}

/* ── file helpers ────────────────────────────────────────────────────────── */
const fmtSize = (b) => {
  if (b === null || b === undefined) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
};
const fileKind = (name = '', mime = '') => {
  const e = (name.split('.').pop() || '').toLowerCase();
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(e)) return { k: 'image', color: '#7C3AED', label: (e || 'IMG').toUpperCase() };
  if (e === 'pdf' || mime.includes('pdf')) return { k: 'pdf', color: '#E11D48', label: 'PDF' };
  if (['xlsx', 'xls'].includes(e) || mime.includes('sheet') || mime.includes('excel')) return { k: 'xls', color: '#059669', label: 'XLS' };
  if (e === 'csv' || mime.includes('csv')) return { k: 'csv', color: '#0EA5E9', label: 'CSV' };
  return { k: 'file', color: '#64748B', label: (e || 'FILE').toUpperCase() };
};
// Upload URLs are backend-relative (/api/files/...) → resolve against the API
// origin (localhost:8001 in dev), NOT the frontend origin. Drive URLs are absolute.
const attHref = (a) => (a.url?.startsWith('http') || a.url?.startsWith('blob:')) ? a.url : `${API_URL}${a.url || ''}`;

/* ── attachment box — rich cards, works staged (pre-save) or live (saved) ── */
function AttachmentBox({ items, brandId, onPickFile, onPickDrive, onRemove }) {
  const [busy, setBusy] = useState(false);
  const [showDrive, setShowDrive] = useState(false);
  const [driveFiles, setDriveFiles] = useState(null);

  const openDrive = async () => {
    setShowDrive(true);
    if (driveFiles) return;
    try {
      const r = await api.get(`/api/brands/${brandId}/drive`);
      setDriveFiles((r.data?.files || []).filter(f => !f.isFolder));
    } catch { setDriveFiles([]); }
  };
  const pickFile = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    setBusy(true);
    try { await onPickFile(f); } finally { setBusy(false); e.target.value = ''; }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <label style={{ ...miniBtn, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? <Loader2 className="animate-spin" style={{ width: 13, height: 13 }} /> : <UploadCloud style={{ width: 13, height: 13 }} />} Upload
          <input type="file" accept=".pdf,.xlsx,.xls,.csv,image/*" hidden onChange={pickFile} disabled={busy} />
        </label>
        <button style={miniBtn} onClick={openDrive}>
          <HardDrive style={{ width: 13, height: 13 }} /> From Drive
        </button>
      </div>

      {(!items || items.length === 0) && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No attachments yet.</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
        {(items || []).map((a, i) => {
          const kind = fileKind(a.fileName, a.mimeType);
          const href = attHref(a);
          return (
            <div key={a.id || i} style={{
              display: 'flex', alignItems: 'center', gap: 11, padding: 8, borderRadius: 12,
              border: '1px solid var(--card-border)', background: 'var(--surface)',
            }}>
              {/* preview / type badge */}
              {kind.k === 'image' ? (
                <img src={href} alt={a.fileName} style={{ width: 42, height: 42, borderRadius: 9, objectFit: 'cover', flexShrink: 0, border: '1px solid var(--card-border)' }} />
              ) : (
                <div style={{ width: 42, height: 42, borderRadius: 9, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${kind.color}14`, border: `1px solid ${kind.color}33` }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: kind.color, letterSpacing: '0.02em' }}>{kind.label}</span>
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.fileName}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {a.source === 'drive' ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#0748EE' }}><HardDrive style={{ width: 11, height: 11 }} /> Drive</span> : (a.fileSize != null ? fmtSize(a.fileSize) : 'File')}
                  {a._staged && <span style={{ color: '#D97706', fontWeight: 700 }}>· pending save</span>}
                </div>
              </div>
              <a href={href} target="_blank" rel="noreferrer" title="Open"
                style={{ width: 30, height: 30, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', border: '1px solid var(--card-border)' }}>
                <ExternalLink style={{ width: 14, height: 14 }} />
              </a>
              <button onClick={() => onRemove(a)} title="Remove" style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid var(--card-border)', background: 'transparent', cursor: 'pointer', color: '#E11D48', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <Trash2 style={{ width: 14, height: 14 }} />
              </button>
            </div>
          );
        })}
      </div>

      {showDrive && (
        <div style={overlay} onClick={() => setShowDrive(false)}>
          <div className="glass-card" style={{ width: 460, maxHeight: '70vh', overflowY: 'auto', padding: 16 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontWeight: 700, color: 'var(--text-heading)' }}>Pick from Google Drive</span>
              <button onClick={() => setShowDrive(false)} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer' }}>
                <X style={{ width: 16, height: 16 }} />
              </button>
            </div>
            {driveFiles === null && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading Drive…</div>}
            {driveFiles && driveFiles.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                No files found. An admin sets the brand's Drive folder under Integrations.
              </div>
            )}
            {driveFiles && driveFiles.map(f => (
              <button key={f.id} onClick={() => { setShowDrive(false); onPickDrive(f); }} style={{
                width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8,
                padding: '9px 10px', marginBottom: 4, border: '1px solid var(--card-border)',
                borderRadius: 10, background: 'var(--surface)', cursor: 'pointer', fontSize: 12,
                color: 'var(--text-heading)', fontWeight: 600,
              }}>
                <HardDrive style={{ width: 14, height: 14, color: '#0748EE' }} /> {f.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── detail / create slide-over ──────────────────────────────────────────── */
function TaskPanel({ mode, task, brandId, categories, onClose, onSaved, onCreateCategory, onOpenAgent }) {
  const isCreate = mode === 'create';
  const [form, setForm] = useState(() => ({
    title: task?.title || '',
    description: task?.description || '',
    category_id: task?.category_id || (categories[0]?.id || ''),
    priority: task?.priority || 'medium',
    status: task?.status || 'todo',
    progress: task?.progress ?? 0,
    due_date: task?.due_date ? task.due_date.slice(0, 10) : '',
  }));
  const [saving, setSaving] = useState(false);
  const [createdId, setCreatedId] = useState(task?.id || null);
  const [newCat, setNewCat] = useState('');
  const [showNewCat, setShowNewCat] = useState(false);
  const [atts, setAtts] = useState([]);   // live (saved) or staged (pre-save) attachments

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const linked = createdId && task?.agent_id && AGENT_META[task.agent_id];

  // Once the task exists, attachments are server-backed.
  const loadAtts = useCallback(() => {
    if (!createdId) return;
    api.get(`/api/attachments/compliance_task/${createdId}`).then(r => setAtts(r.data || [])).catch(() => {});
  }, [createdId]);
  useEffect(() => { loadAtts(); }, [loadAtts]);

  // Add a local file: upload now if saved, else stage for flush on create.
  const pickFile = async (file) => {
    if (createdId) {
      const fd = new FormData(); fd.append('file', file);
      try {
        await api.post(`/api/attachments/compliance_task/${createdId}/upload`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        toast.success('File attached'); loadAtts();
      } catch { toast.error('Upload failed'); }
    } else {
      setAtts(a => [...a, { _staged: true, _file: file, source: 'upload', fileName: file.name, mimeType: file.type, fileSize: file.size, url: URL.createObjectURL(file) }]);
    }
  };
  const pickDrive = async (f) => {
    if (createdId) {
      try {
        await api.post(`/api/attachments/compliance_task/${createdId}/drive`, { driveFileId: f.id, fileName: f.name, mimeType: f.mimeType, driveUrl: f.webViewLink });
        toast.success('Drive file linked'); loadAtts();
      } catch { toast.error('Could not link file'); }
    } else {
      setAtts(a => [...a, { _staged: true, source: 'drive', driveFileId: f.id, fileName: f.name, mimeType: f.mimeType, url: f.webViewLink }]);
    }
  };
  const removeAtt = async (item) => {
    if (item._staged) { setAtts(a => a.filter(x => x !== item)); return; }
    try { await api.delete(`/api/attachments/${item.id}`); loadAtts(); } catch { toast.error('Remove failed'); }
  };

  const save = async () => {
    if (!form.title.trim()) return toast.error('Title is required');
    setSaving(true);
    try {
      if (isCreate && !createdId) {
        const r = await api.post(`/api/brands/${brandId}/compliance`, {
          ...form, month: task?.month, year: task?.year,
        });
        const newId = r.data.id;
        // Flush any attachments staged before the task existed.
        for (const a of atts.filter(x => x._staged)) {
          try {
            if (a.source === 'upload') {
              const fd = new FormData(); fd.append('file', a._file);
              await api.post(`/api/attachments/compliance_task/${newId}/upload`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
            } else {
              await api.post(`/api/attachments/compliance_task/${newId}/drive`, { driveFileId: a.driveFileId, fileName: a.fileName, mimeType: a.mimeType, driveUrl: a.url });
            }
          } catch { /* keep going */ }
        }
        setCreatedId(newId);   // triggers loadAtts → server-backed list
        toast.success('Task created');
      } else {
        await api.patch(`/api/compliance/${createdId}`, form);
        toast.success('Saved');
      }
      onSaved();
    } catch { toast.error('Save failed'); }
    finally { setSaving(false); }
  };

  const quickStatus = async (status) => {
    setForm(f => ({ ...f, status, progress: status === 'done' ? 100 : (f.status === 'done' ? 0 : f.progress) }));
    if (createdId) {
      try { await api.patch(`/api/compliance/${createdId}`, { status }); onSaved(); }
      catch { toast.error('Update failed'); }
    }
  };

  const addCat = async () => {
    if (!newCat.trim()) return;
    const cat = await onCreateCategory(newCat.trim());
    if (cat) { set('category_id', cat.id); setNewCat(''); setShowNewCat(false); }
  };

  const accent = categories.find(c => c.id === form.category_id)?.color || '#0748EE';

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        {/* category accent strip */}
        <div style={{ height: 3, background: accent, flexShrink: 0 }} />

        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '18px 22px 14px', flexShrink: 0 }}>
          <span style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 15, color: 'var(--text-heading)' }}>
            {isCreate ? 'New Task' : 'Task details'}
          </span>
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'var(--page-bg)', cursor: 'pointer', width: 30, height: 30, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <X style={{ width: 16, height: 16, color: 'var(--text-muted)' }} />
          </button>
        </div>

        <div style={{ padding: '0 22px 22px', overflowY: 'auto', flex: 1 }}>
          {/* title */}
          <input value={form.title} onChange={e => set('title', e.target.value)} placeholder="Task title"
            style={{
              width: '100%', border: 'none', outline: 'none', background: 'transparent',
              fontFamily: 'Manrope', fontSize: 20, fontWeight: 800, color: 'var(--text-heading)',
              padding: '2px 0 14px', borderBottom: '1px solid var(--card-border)', marginBottom: 6,
            }} />

          {/* metadata list (icon · label · control) */}
          <MetaRow icon={Flag} label="Priority" align="top">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {Object.entries(PRIORITY).map(([k, p]) => (
                <button key={k} onClick={() => set('priority', k)} style={{
                  ...chip, borderColor: form.priority === k ? p.color : 'var(--card-border)',
                  color: form.priority === k ? p.color : 'var(--text-muted)',
                  background: form.priority === k ? `${p.color}12` : 'transparent', fontWeight: 700,
                }}>{p.label}</button>
              ))}
            </div>
          </MetaRow>

          <MetaRow icon={Tag} label="Category" align="top">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {categories.map(c => (
                <button key={c.id} onClick={() => set('category_id', c.id)} style={{
                  ...chip, borderColor: form.category_id === c.id ? c.color : 'var(--card-border)',
                  color: form.category_id === c.id ? c.color : 'var(--text-muted)',
                  background: form.category_id === c.id ? `${c.color}14` : 'transparent', fontWeight: 700,
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: c.color, marginRight: 5 }} />
                  {c.name}
                </button>
              ))}
              {!showNewCat ? (
                <button onClick={() => setShowNewCat(true)} style={{ ...chip, borderStyle: 'dashed', color: 'var(--text-muted)' }}>
                  <Plus style={{ width: 12, height: 12 }} /> New
                </button>
              ) : (
                <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="Category name"
                    onKeyDown={e => { if (e.key === 'Enter') addCat(); if (e.key === 'Escape') { setShowNewCat(false); setNewCat(''); } }}
                    style={{ ...field, width: 130, padding: '6px 9px', fontSize: 12 }} autoFocus />
                  <button onClick={addCat} title="Add" style={{ ...miniBtn, padding: '7px 8px', color: '#059669' }}><Check style={{ width: 14, height: 14 }} /></button>
                  <button onClick={() => { setShowNewCat(false); setNewCat(''); }} title="Cancel" style={{ ...miniBtn, padding: '7px 8px', color: '#E11D48' }}><X style={{ width: 14, height: 14 }} /></button>
                </span>
              )}
            </div>
          </MetaRow>

          <MetaRow icon={Calendar} label="Due date">
            <input type="date" value={form.due_date} onChange={e => set('due_date', e.target.value)}
              style={{ ...field, width: 180 }} />
          </MetaRow>

          <MetaRow icon={TrendingUp} label="Progress">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input type="range" min="0" max="100" step="5" value={form.progress}
                onChange={e => set('progress', +e.target.value)} style={{ flex: 1, accentColor: accent }} />
              <span style={{ fontFamily: 'Barlow', fontWeight: 900, fontSize: 15, width: 44, textAlign: 'right', color: 'var(--text-heading)' }}>
                {form.progress}%
              </span>
            </div>
          </MetaRow>

          {!isCreate && (
            <MetaRow icon={ListChecks} label="Status" align="top">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {COLUMNS.map(c => (
                  <button key={c.key} onClick={() => quickStatus(c.key)} style={{
                    ...chip, borderColor: form.status === c.key ? c.color : 'var(--card-border)',
                    color: form.status === c.key ? c.color : 'var(--text-muted)',
                    background: form.status === c.key ? `${c.color}12` : 'transparent', fontWeight: 700,
                  }}>{c.label}</button>
                ))}
              </div>
            </MetaRow>
          )}

          {/* description */}
          <div style={{ marginTop: 10, marginBottom: 16 }}>
            <div style={{ ...rowLabel, display: 'flex', alignItems: 'center', gap: 7 }}>
              <AlignLeft style={{ width: 13, height: 13 }} /> Description
            </div>
            <textarea value={form.description} onChange={e => set('description', e.target.value)}
              placeholder="Add notes…" rows={3} style={{ ...field, resize: 'vertical' }} />
          </div>

          {task?.remarks && (
            <div style={{ marginBottom: 16, padding: '11px 13px', borderRadius: 12, background: 'var(--page-bg)', border: '1px solid var(--card-border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 4 }}>From monthly workflow</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-heading)', lineHeight: 1.45 }}>{task.remarks}</div>
            </div>
          )}

          {linked && (
            <button onClick={() => onOpenAgent(task.agent_id)} style={{
              ...miniBtn, width: '100%', justifyContent: 'center', padding: '11px', marginBottom: 16,
              background: '#0748EE', color: '#fff', border: 'none', fontWeight: 700,
            }}>
              <ExternalLink style={{ width: 14, height: 14 }} /> Open {AGENT_META[task.agent_id]}
            </button>
          )}

          {/* attachments */}
          <div style={{ marginTop: 4 }}>
            <div style={{ ...rowLabel, display: 'flex', alignItems: 'center', gap: 7 }}>
              <Paperclip style={{ width: 13, height: 13 }} /> Attachments
            </div>
            <AttachmentBox items={atts} brandId={brandId} onPickFile={pickFile} onPickDrive={pickDrive} onRemove={removeAtt} />
            {!createdId && atts.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Files upload when you create the task.</div>
            )}
          </div>
        </div>

        {/* footer */}
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--card-border)', display: 'flex', gap: 10, flexShrink: 0 }}>
          <button onClick={save} disabled={saving} style={{
            ...miniBtn, flex: 1, justifyContent: 'center', background: '#0748EE', color: '#fff', border: 'none', fontWeight: 700, padding: '11px 18px',
          }}>
            {saving ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : <Check style={{ width: 14, height: 14 }} />}
            {isCreate && !createdId ? 'Create task' : 'Save changes'}
          </button>
          <button onClick={onClose} style={{ ...miniBtn, padding: '11px 18px' }}>Close</button>
        </div>
      </div>
    </div>
  );
}

const MetaRow = ({ icon: Icon, label, children, align = 'center' }) => (
  <div style={{ display: 'flex', alignItems: align === 'top' ? 'flex-start' : 'center', gap: 12, padding: '9px 0' }}>
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, width: 100, flexShrink: 0, color: 'var(--text-muted)', paddingTop: align === 'top' ? 5 : 0 }}>
      <Icon style={{ width: 15, height: 15 }} />
      <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
  </div>
);

/* ── chat-with-admin slide-over (accountant side) ────────────────────────── */
function ChatPanel({ brandId, brandName, onClose }) {
  const [msgs, setMsgs] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);

  const load = useCallback(() => {
    api.get(`/api/brands/${brandId}/admin-chat`).then(r => setMsgs(r.data || [])).catch(() => setMsgs([]));
  }, [brandId]);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  const send = async () => {
    const m = text.trim(); if (!m || sending) return;
    setSending(true); setText('');
    try { await api.post(`/api/brands/${brandId}/admin-chat`, { message: m }); load(); }
    catch { toast.error('Could not send'); setText(m); }
    finally { setSending(false); }
  };

  const fmt = (ts) => { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...panel, width: 'min(420px, 100%)' }} onClick={e => e.stopPropagation()}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '1px solid var(--card-border)', flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: '#0748EE15', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <MessageCircle style={{ width: 17, height: 17, color: '#0748EE' }} />
          </div>
          <div>
            <div style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 14, color: 'var(--text-heading)' }}>Chat with Admin</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{brandName} · Colonel admin team</div>
          </div>
          <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'var(--page-bg)', cursor: 'pointer', width: 30, height: 30, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <X style={{ width: 16, height: 16, color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--page-bg)' }}>
          {msgs === null ? (
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 30 }}><Loader2 className="animate-spin" style={{ width: 22, height: 22, color: '#0748EE' }} /></div>
          ) : msgs.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, paddingTop: 40 }}>
              <MessageCircle style={{ width: 28, height: 28, margin: '0 auto 10px', opacity: 0.5 }} />
              No messages yet. Start a conversation with the admin team.
            </div>
          ) : msgs.map(m => {
            const mine = m.sender_role === 'accountant';
            return (
              <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
                <div style={{
                  padding: '9px 13px', borderRadius: 14,
                  borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4,
                  background: mine ? '#0748EE' : 'var(--surface)',
                  color: mine ? '#fff' : 'var(--text-heading)',
                  border: mine ? 'none' : '1px solid var(--card-border)',
                  fontSize: 13, lineHeight: 1.4,
                }}>{m.message}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, textAlign: mine ? 'right' : 'left' }}>
                  {mine ? 'You' : (m.sender_name || 'Admin')} · {fmt(m.created_at)}
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>

        {/* composer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--card-border)', flexShrink: 0 }}>
          <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
            placeholder="Type a message…"
            style={{ ...field, borderRadius: 999, padding: '10px 16px' }} />
          <button onClick={send} disabled={sending} style={{
            width: 40, height: 40, borderRadius: 999, border: 'none', background: '#0748EE', color: '#fff',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
          }}>
            {sending ? <Loader2 className="animate-spin" style={{ width: 16, height: 16 }} /> : <Send style={{ width: 16, height: 16 }} />}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── calendar view ───────────────────────────────────────────────────────── */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function CalendarView({ tasks, year, month, onOpen }) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();
  const today = new Date();
  const isToday = (d) => today.getFullYear() === year && (today.getMonth() + 1) === month && today.getDate() === d;

  // Place a task on a day: explicit due date if in this month, else derive from
  // its workflow window ("1st – 5th" → 1, "Month End" → last day).
  const dayOf = (t) => {
    if (t.due_date) { const d = new Date(t.due_date); if (d.getFullYear() === year && (d.getMonth() + 1) === month) return d.getDate(); }
    if (t.period && /month\s*end/i.test(t.period)) return daysInMonth;
    const m = (t.period || '').match(/\d+/);
    return m ? Math.min(daysInMonth, parseInt(m[0], 10)) : null;
  };
  const byDay = {};
  tasks.forEach(t => { const d = dayOf(t); if (d) (byDay[d] = byDay[d] || []).push(t); });

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
          <div key={i} style={{
            minHeight: 98, borderRadius: 10, border: '1px solid var(--card-border)',
            background: d ? 'var(--surface)' : 'transparent', padding: d ? 6 : 0,
            display: 'flex', flexDirection: 'column', gap: 3, overflow: 'hidden',
          }}>
            {d && (
              <>
                <div style={{
                  fontSize: 11, fontWeight: 700, alignSelf: 'flex-start',
                  color: isToday(d) ? '#fff' : 'var(--text-muted)',
                  ...(isToday(d) ? { background: '#0748EE', borderRadius: 999, width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' } : {}),
                }}>{d}</div>
                {(byDay[d] || []).slice(0, 3).map(t => (
                  <button key={t.id} onClick={() => onOpen(t)} title={t.title} style={{
                    display: 'flex', alignItems: 'center', gap: 5, width: '100%', textAlign: 'left',
                    border: 'none', background: `${catColor(t)}14`, borderRadius: 6, padding: '3px 6px', cursor: 'pointer',
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: catColor(t), flexShrink: 0 }} />
                    <span style={{ fontSize: 10.5, color: 'var(--text-heading)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                  </button>
                ))}
                {(byDay[d] || []).length > 3 && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', paddingLeft: 2 }}>+{byDay[d].length - 3} more</span>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── main page ───────────────────────────────────────────────────────────── */
export default function ComplianceTracker() {
  const { brandId } = useParams();
  const navigate = useNavigate();

  const [brands, setBrands] = useState([]);
  const [categories, setCategories] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const [year] = useState(2026);
  const [month, setMonth] = useState(nowMonth() >= 1 && nowMonth() <= 12 ? nowMonth() : 7);
  const [view, setView] = useState('kanban');
  const [activeCat, setActiveCat] = useState('all');   // 'all' | 'admin' | categoryId
  const [panel, setPanel] = useState(null);            // { mode:'create'|'edit', task }
  const [showChat, setShowChat] = useState(false);
  const [dragId, setDragId] = useState(null);          // task being dragged
  const [dragOverCol, setDragOverCol] = useState(null);// column highlighted as drop target

  useEffect(() => { if (brandId) { try { localStorage.setItem('lastBrandId', brandId); } catch (_) {} } }, [brandId]);

  useEffect(() => {
    api.get('/api/brands/my-brands').then(r => setBrands(Array.isArray(r.data) ? r.data : [])).catch(() => {});
    api.get(`/api/brands/${brandId}/compliance/categories`).then(r => setCategories(r.data || [])).catch(() => {});
  }, [brandId]);

  const loadTasks = useCallback(async () => {
    setLoading(true); setDenied(false);
    try {
      const params = { year, month };
      if (activeCat === 'admin') params.tab = 'admin';
      else if (activeCat !== 'all') params.category = activeCat;
      const r = await api.get(`/api/brands/${brandId}/compliance`, { params });
      let list = r.data || [];
      // Admin tab also surfaces admin-assigned tasks from the existing Tasks
      // system (read-only here; click opens the full Tasks page).
      if (activeCat === 'admin') {
        try {
          const tr = await api.get('/api/tasks');
          const mapped = (tr.data || [])
            .filter(t => t.category !== 'feedback' && t.creator?.role === 'admin')
            .map(t => ({
              id: t.id, title: t.title,
              status: MASTER_STATUS[t.status] || 'todo',
              priority: t.priority || 'medium',
              progress: t.status === 'done' ? 100 : t.status === 'in_progress' ? 50 : 0,
              category_name: 'Admin', category_color: '#E11D48',
              data_source: t.creator?.name ? `From ${t.creator.name}` : 'Admin-assigned',
              frequency: null, period: null, agent_id: null, attachment_count: 0,
              description: t.description, _external: true,
            }));
          list = [...mapped, ...list];
        } catch (_) { /* Tasks endpoint optional */ }
      }
      setTasks(list);
    } catch (err) {
      if (err.response?.status === 403) setDenied(true);
      setTasks([]);
    } finally { setLoading(false); }
  }, [brandId, year, month, activeCat]);
  useEffect(() => { loadTasks(); }, [loadTasks]);

  const brand = brands.find(b => b.id === brandId);
  const grouped = useMemo(() => {
    const g = { todo: [], in_progress: [], review: [], done: [] };
    tasks.forEach(t => { (g[t.status] || g.todo).push(t); });
    return g;
  }, [tasks]);
  const doneCount = grouped.done.length;
  const pct = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;

  const createCategory = async (name) => {
    try {
      const palette = ['#0748EE', '#D97706', '#7C3AED', '#0EA5E9', '#059669', '#E11D48', '#DB2777'];
      const color = palette[categories.length % palette.length];
      const r = await api.post(`/api/brands/${brandId}/compliance/categories`, { name, color });
      setCategories(cs => [...cs.filter(c => c.id !== r.data.id), r.data]);
      toast.success(`Category "${name}" added`);
      return r.data;
    } catch { toast.error('Could not add category'); return null; }
  };

  const openAgent = (agentId) => navigate(`/brands/${brandId}/agents/${agentId}`);
  // Admin-assigned tasks from the existing Tasks system open there; tracker tasks
  // open the slide-over.
  const openCard = (t) => t._external ? navigate('/tasks') : setPanel({ mode: 'edit', task: t });

  // Drag a card to another column → change status (optimistic, then PATCH).
  const moveTask = async (taskId, status) => {
    const t = tasks.find(x => x.id === taskId);
    if (!t || t._external || t.status === status) return;
    setTasks(prev => prev.map(x => x.id === taskId
      ? {
          ...x, status,
          // to Done → 100%; leaving Done → reset to 0%; otherwise keep progress
          progress: status === 'done' ? 100 : (x.status === 'done' ? 0 : x.progress),
          completed_at: status === 'done' ? new Date().toISOString() : null,
        }
      : x));
    try { await api.patch(`/api/compliance/${taskId}`, { status }); }
    catch { toast.error('Could not move task'); loadTasks(); }
  };
  const onDropCol = (colKey) => (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    setDragOverCol(null); setDragId(null);
    if (id) moveTask(id, colKey);
  };

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/compliance-tracker`, label: 'Tracker', icon: CalendarCheck },
  ]);

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div style={{ padding: 24, maxWidth: 1400 }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
          <div style={{ width: 46, height: 46, borderRadius: 14, background: '#0748EE15', border: '1px solid #0748EE30', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CalendarCheck style={{ width: 22, height: 22, color: '#0748EE' }} />
          </div>
          <div>
            <h1 style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 22, color: 'var(--text-heading)', lineHeight: 1.1 }}>
              Tracker
            </h1>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 13, color: 'var(--text-muted)' }}>
              <Building2 style={{ width: 14, height: 14, color: '#0748EE' }} /> {brand?.name || 'Brand'}
            </div>
          </div>

          {/* month picker */}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 12, padding: '6px 8px' }}>
            <button onClick={() => setMonth(m => Math.max(1, m - 1))} disabled={month <= 1} style={iconBtn}>
              <ChevronLeft style={{ width: 16, height: 16 }} />
            </button>
            <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-heading)', minWidth: 118, textAlign: 'center' }}>
              {MONTHS[month]} {year}
            </span>
            <button onClick={() => setMonth(m => Math.min(12, m + 1))} disabled={month >= 12} style={iconBtn}>
              <ChevronRight style={{ width: 16, height: 16 }} />
            </button>
          </div>
        </div>

        {/* view tabs + new task + progress */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 12, padding: 4 }}>
            {[{ k: 'kanban', label: 'Kanban', icon: LayoutGrid }, { k: 'list', label: 'List', icon: ListIcon }, { k: 'calendar', label: 'Calendar', icon: CalendarDays }].map(v => (
              <button key={v.k} onClick={() => setView(v.k)} style={{
                ...miniBtn, border: 'none',
                background: view === v.k ? '#0748EE' : 'transparent',
                color: view === v.k ? '#fff' : 'var(--text-muted)', fontWeight: 700,
              }}>
                <v.icon style={{ width: 14, height: 14 }} /> {v.label}
              </button>
            ))}
          </div>

          {tasks.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Ring pct={pct} />
              <div>
                <div style={{ fontFamily: 'Barlow', fontWeight: 900, fontSize: 18, color: 'var(--text-heading)', lineHeight: 1 }}>
                  {doneCount}/{tasks.length}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>tasks complete</div>
              </div>
            </div>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <button onClick={() => setShowChat(true)} style={{ ...miniBtn, fontWeight: 700, padding: '9px 14px' }}>
              <MessageCircle style={{ width: 15, height: 15 }} /> Chat with admin
            </button>
            <button onClick={() => setPanel({ mode: 'create', task: { month, year } })} style={{
              ...miniBtn, background: '#0748EE', color: '#fff', border: 'none', fontWeight: 700, padding: '9px 16px',
            }}>
              <Plus style={{ width: 15, height: 15 }} /> New Task
            </button>
          </div>
        </div>

        {/* category tabs */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
          <CatTab active={activeCat === 'all'} onClick={() => setActiveCat('all')} label="All" color="#0748EE" />
          {categories.map(c => (
            <CatTab key={c.id} active={activeCat === c.id} onClick={() => setActiveCat(c.id)} label={c.name} color={c.color} />
          ))}
          <CatTab active={activeCat === 'admin'} onClick={() => setActiveCat('admin')} label="Admin" color="#E11D48" icon={ClipboardList} />
        </div>

        {/* body */}
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
            <Loader2 className="animate-spin" style={{ width: 30, height: 30, color: '#0748EE' }} />
          </div>
        ) : denied ? (
          <Empty title="No access to this brand" sub="You are not assigned to this brand. Ask an admin for access." />
        ) : tasks.length === 0 ? (
          <Empty
            title={activeCat === 'admin' ? 'No admin-assigned tasks' : 'No tracker set up for this brand yet'}
            sub={activeCat === 'admin' ? 'Tasks an admin assigns to you will appear here.'
              : 'This month has no tasks. Create one with New Task, or an admin can seed the monthly workflow.'} />
        ) : view === 'kanban' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(240px, 1fr))', gap: 14, overflowX: 'auto' }}>
            {COLUMNS.map(col => {
              const over = dragOverCol === col.key;
              return (
                <div key={col.key}
                  onDragOver={e => { e.preventDefault(); if (dragOverCol !== col.key) setDragOverCol(col.key); }}
                  onDragLeave={e => { if (e.currentTarget === e.target) setDragOverCol(null); }}
                  onDrop={onDropCol(col.key)}
                  style={{
                    borderRadius: 12, padding: 5, minHeight: 'calc(100vh - 300px)', transition: 'background .15s',
                    background: over ? `${col.color}0f` : 'transparent',
                    outline: over ? `2px dashed ${col.color}66` : '2px dashed transparent',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, paddingBottom: 8, borderBottom: `2px solid ${col.color}` }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: col.color }} />
                    <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-heading)' }}>{col.label}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>{grouped[col.key].length}</span>
                  </div>
                  {grouped[col.key].map(t => (
                    <TaskCard key={t.id} task={t} onOpen={openCard} dragging={dragId === t.id}
                      onDragStart={t._external ? undefined : (e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; setDragId(t.id); }}
                      onDragEnd={() => { setDragId(null); setDragOverCol(null); }}
                      onDragOver={(e) => { e.preventDefault(); if (dragOverCol !== col.key) setDragOverCol(col.key); }}
                      onDrop={onDropCol(col.key)} />
                  ))}
                  {grouped[col.key].length === 0 && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '18px 0', opacity: over ? 1 : 0.5 }}>
                      {over ? 'Drop here' : '—'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : view === 'list' ? (
          <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
            {tasks.map((t, i) => {
              const col = COLUMNS.find(c => c.key === t.status) || COLUMNS[0];
              return (
                <button key={t.id} onClick={() => openCard(t)} style={{
                  width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 16px', border: 'none', borderTop: i ? '1px solid var(--card-border)' : 'none',
                  borderLeft: `3px solid ${catColor(t)}`, background: 'var(--surface)', cursor: 'pointer',
                }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '2px 8px', borderRadius: 999, background: `${catColor(t)}18`, color: catColor(t) }}>
                    {t.category_name}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', flex: 1 }}>{t.title}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.period}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: col.color }}>{col.label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <CalendarView tasks={tasks} year={year} month={month} onOpen={openCard} />
        )}
      </div>

      {panel && (
        <TaskPanel
          mode={panel.mode} task={panel.task} brandId={brandId} categories={categories}
          onClose={() => setPanel(null)}
          onSaved={loadTasks}
          onCreateCategory={createCategory}
          onOpenAgent={openAgent}
        />
      )}

      {showChat && (
        <ChatPanel brandId={brandId} brandName={brand?.name || 'Brand'} onClose={() => setShowChat(false)} />
      )}
    </DashboardLayout>
  );
}

/* ── small presentational bits + shared inline styles ────────────────────── */
const CatTab = ({ active, onClick, label, color, icon: Icon }) => (
  <button onClick={onClick} style={{
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 999,
    fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
    border: `1px solid ${active ? color : 'var(--card-border)'}`,
    background: active ? `${color}14` : 'var(--surface)',
    color: active ? color : 'var(--text-muted)',
  }}>
    {Icon && <Icon style={{ width: 13, height: 13 }} />} {label}
  </button>
);

const Empty = ({ title, sub }) => (
  <div className="glass-card" style={{ padding: '56px 24px', textAlign: 'center' }}>
    <div style={{ width: 52, height: 52, borderRadius: 16, background: 'var(--page-bg)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
      <CalendarCheck style={{ width: 24, height: 24, color: 'var(--text-muted)' }} />
    </div>
    <div style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 16, color: 'var(--text-heading)', marginBottom: 6 }}>{title}</div>
    <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 420, margin: '0 auto' }}>{sub}</div>
  </div>
);

const overlay = { position: 'fixed', inset: 0, background: 'rgba(10,15,46,0.35)', zIndex: 60, display: 'flex', justifyContent: 'flex-end' };
const panel = { width: 'min(480px, 100%)', height: '100%', background: 'var(--surface)', display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 40px rgba(10,15,46,0.15)' };
const field = { width: '100%', padding: '9px 12px', border: '1px solid var(--card-border)', borderRadius: 10, background: 'var(--page-bg)', color: 'var(--text-heading)', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
const rowLabel = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 6 };
const chip = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 11px', borderRadius: 999, border: '1px solid var(--card-border)', background: 'transparent', fontSize: 12, cursor: 'pointer' };
const miniBtn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--card-border)', background: 'var(--surface)', color: 'var(--text-heading)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text-heading)', cursor: 'pointer' };

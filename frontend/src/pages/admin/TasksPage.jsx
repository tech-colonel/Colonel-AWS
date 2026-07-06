import React, { useState, useEffect, useRef } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { Building2, ClipboardList, Plus, Trash2, Send, X, Clock, CheckCircle2, AlertTriangle, Loader2, Paperclip, UploadCloud } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import api, { API_URL } from '../../lib/api';
import { toast } from 'sonner';
import { sidebarFor, isAdminUser } from '../../lib/adminNav';

/* Attachments for an existing task (local upload). Shares the polymorphic
   /api/attachments endpoint with the Compliance Tracker (entity_type 'task'). */
function TaskAttachments({ taskId }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/api/attachments/task/${taskId}`).then(r => setItems(r.data || [])).catch(() => {});
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [taskId]);
  const onUpload = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    setBusy(true);
    const fd = new FormData(); fd.append('file', file);
    try {
      await api.post(`/api/attachments/task/${taskId}/upload`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('File attached'); load();
    } catch { toast.error('Upload failed'); } finally { setBusy(false); e.target.value = ''; }
  };
  const remove = async (id) => { try { await api.delete(`/api/attachments/${id}`); load(); } catch { toast.error('Remove failed'); } };
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-400">Attachments</span>
        <label className="text-xs font-semibold px-2.5 py-1 rounded-lg border cursor-pointer flex items-center gap-1.5"
          style={{ borderColor: '#CBD5E1', color: '#0748EE' }}>
          <UploadCloud className="w-3.5 h-3.5" /> Upload
          <input type="file" accept=".pdf,.xlsx,.xls,.csv" hidden onChange={onUpload} disabled={busy} />
        </label>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">No files attached.</p>
      ) : items.map(a => (
        <div key={a.id} className="flex items-center gap-2 px-2.5 py-2 mb-1.5 rounded-lg border" style={{ borderColor: '#E2E8F0' }}>
          <Paperclip className="w-3.5 h-3.5 text-slate-400" />
          <a href={(a.url?.startsWith('http') ? a.url : `${API_URL}${a.url || ''}`)} target="_blank" rel="noreferrer" className="text-xs font-semibold text-slate-700 flex-1 truncate">{a.fileName}</a>
          <button onClick={() => remove(a.id)} style={{ color: '#E11D48' }}><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      ))}
    </div>
  );
}

const STATUS = {
  pending:     { label: 'Pending',     bg: '#F1F5F9', c: '#64748B' },
  in_progress: { label: 'In Progress', bg: '#E8EFFE', c: '#0748EE' },
  done:        { label: 'Done',        bg: '#ECFDF5', c: '#059669' },
  overdue:     { label: 'Overdue',     bg: '#FFF1F2', c: '#E11D48' },
};
const PRIORITY = {
  low:    { label: 'Low',    c: '#64748B' },
  medium: { label: 'Medium', c: '#0748EE' },
  high:   { label: 'High',   c: '#D97706' },
  urgent: { label: 'Urgent', c: '#E11D48' },
};
const STATUS_ORDER = ['pending', 'in_progress', 'done', 'overdue'];
const fmtDate = (s) => { try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); } catch { return ''; } };
const fmtTime = (s) => { try { return new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

const StatusBadge = ({ status }) => {
  const s = STATUS[status] || STATUS.pending;
  return <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: s.bg, color: s.c }}>{s.label}</span>;
};

const TasksPage = () => {
  const admin = isAdminUser();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [accountants, setAccountants] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', assigned_to: '', priority: 'medium', due_date: '' });
  const [openTask, setOpenTask] = useState(null);   // full task w/ messages
  const [msg, setMsg] = useState('');
  const pollRef = useRef(null);

  const sidebarItems = sidebarFor([
    { path: '/brands', label: 'Brands', icon: Building2 },
    { path: '/tasks', label: 'Tasks', icon: ClipboardList },
  ]);

  useEffect(() => {
    fetchTasks();
    if (admin) api.get('/api/users').then(r => setAccountants(r.data.filter(u => u.role === 'accountant'))).catch(() => {});
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchTasks = async () => {
    try { const r = await api.get('/api/tasks'); setTasks(r.data); }
    catch { toast.error('Failed to load tasks'); }
    finally { setLoading(false); }
  };

  const createTask = async (e) => {
    e.preventDefault();
    if (!form.title || !form.assigned_to) { toast.error('Title and assignee required'); return; }
    try {
      await api.post('/api/tasks', { ...form, due_date: form.due_date || null });
      toast.success('Task assigned');
      setShowNew(false);
      setForm({ title: '', description: '', assigned_to: '', priority: 'medium', due_date: '' });
      fetchTasks();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to create task'); }
  };

  const openDetail = async (taskId) => {
    try {
      const r = await api.get(`/api/tasks/${taskId}`);
      setOpenTask(r.data);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try { const rr = await api.get(`/api/tasks/${taskId}`); setOpenTask(rr.data); } catch { /* ignore */ }
      }, 4000); // live updates
    } catch { toast.error('Failed to open task'); }
  };

  const closeDetail = () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; setOpenTask(null); setMsg(''); };

  const changeStatus = async (status) => {
    try {
      await api.put(`/api/tasks/${openTask.id}`, { status });
      setOpenTask(t => ({ ...t, status }));
      setTasks(ts => ts.map(t => t.id === openTask.id ? { ...t, status } : t));
    } catch { toast.error('Could not update status'); }
  };

  const sendMessage = async () => {
    if (!msg.trim()) return;
    try {
      await api.post(`/api/tasks/${openTask.id}/messages`, { message: msg.trim() });
      setMsg('');
      const r = await api.get(`/api/tasks/${openTask.id}`); setOpenTask(r.data);
    } catch { toast.error('Could not send'); }
  };

  const removeTask = async (id) => {
    if (!window.confirm('Delete this task?')) return;
    try { await api.delete(`/api/tasks/${id}`); closeDetail(); fetchTasks(); toast.success('Task deleted'); }
    catch { toast.error('Could not delete'); }
  };

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="tasks-page">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Tasks</h1>
            <p className="text-slate-600 mt-1">{admin ? 'Assign tasks and track live progress' : 'Your assigned tasks'}</p>
          </div>
          {admin && <Button onClick={() => setShowNew(true)}><Plus className="mr-2 h-4 w-4" />New Task</Button>}
        </div>

        {loading ? (
          <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-16 rounded-2xl bg-slate-100 animate-pulse" />)}</div>
        ) : tasks.length === 0 ? (
          <div className="rounded-2xl border bg-white p-12 text-center" style={{ borderColor: '#E2E8F0' }}>
            <ClipboardList className="h-12 w-12 text-slate-300 mx-auto mb-3" />
            <p className="text-sm text-slate-500">{admin ? 'No tasks yet — assign one to get started.' : 'No tasks assigned to you yet.'}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map(t => {
              const p = PRIORITY[t.priority] || PRIORITY.medium;
              return (
                <button key={t.id} onClick={() => openDetail(t.id)}
                  className="w-full text-left rounded-2xl border bg-white p-4 transition-shadow hover:shadow-md flex items-center gap-4"
                  style={{ borderColor: '#E2E8F0' }}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-bold text-slate-900 truncate">{t.title}</span>
                      <span className="text-[10px] font-bold uppercase" style={{ color: p.c }}>{p.label}</span>
                    </div>
                    <div className="text-xs text-slate-400 truncate">
                      {admin && t.assignee ? `→ ${t.assignee.name || t.assignee.email}` : ''}
                      {t.due_date ? ` · due ${fmtDate(t.due_date)}` : ''}
                      {t.description ? ` · ${t.description.slice(0, 60)}` : ''}
                    </div>
                  </div>
                  <StatusBadge status={t.status} />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* New Task modal */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent onClose={() => setShowNew(false)}>
          <DialogHeader><DialogTitle>Assign New Task</DialogTitle></DialogHeader>
          <form onSubmit={createTask} className="space-y-4">
            <div>
              <Label htmlFor="t-title">Title *</Label>
              <Input id="t-title" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="e.g. Check all tools and give recommendations" required />
            </div>
            <div>
              <Label htmlFor="t-desc">Description</Label>
              <textarea id="t-desc" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                rows={3} placeholder="Details / checklist…"
                className="w-full px-3 py-2 rounded-lg border text-sm outline-none" style={{ borderColor: '#CBD5E1' }} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="t-assignee">Assign to *</Label>
                <select id="t-assignee" value={form.assigned_to} onChange={e => setForm({ ...form, assigned_to: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border text-sm outline-none bg-white" style={{ borderColor: '#CBD5E1' }} required>
                  <option value="">Select user…</option>
                  {accountants.map(u => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
                </select>
              </div>
              <div>
                <Label htmlFor="t-prio">Priority</Label>
                <select id="t-prio" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border text-sm outline-none bg-white" style={{ borderColor: '#CBD5E1' }}>
                  {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <Label htmlFor="t-due">Due date</Label>
              <Input id="t-due" type="date" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })} />
            </div>
            <div className="flex gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={() => setShowNew(false)} className="flex-1">Cancel</Button>
              <Button type="submit" className="flex-1">Assign Task</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Task detail drawer */}
      {openTask && (
        <div className="fixed inset-0 z-50 flex justify-end" style={{ background: 'rgba(0,0,0,0.4)' }} onClick={e => e.target === e.currentTarget && closeDetail()}>
          <div className="w-full max-w-md h-full bg-white shadow-2xl flex flex-col">
            <div className="px-5 py-4 border-b flex items-start justify-between" style={{ borderColor: '#E2E8F0' }}>
              <div className="flex-1 min-w-0 pr-3">
                <h2 className="text-lg font-bold text-slate-900">{openTask.title}</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  {openTask.assignee ? `Assigned to ${openTask.assignee.name || openTask.assignee.email}` : ''}
                  {openTask.due_date ? ` · due ${fmtDate(openTask.due_date)}` : ''}
                </p>
              </div>
              <button onClick={closeDetail} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="px-5 py-4 border-b space-y-3" style={{ borderColor: '#E2E8F0' }}>
              {openTask.description && <p className="text-sm text-slate-600 whitespace-pre-wrap">{openTask.description}</p>}
              <div className="flex items-center gap-2 flex-wrap">
                {STATUS_ORDER.map(s => (
                  <button key={s} onClick={() => changeStatus(s)}
                    className="text-xs font-bold px-2.5 py-1 rounded-full transition-all"
                    style={{
                      background: openTask.status === s ? STATUS[s].bg : 'transparent',
                      color: openTask.status === s ? STATUS[s].c : '#94A3B8',
                      border: `1px solid ${openTask.status === s ? STATUS[s].c : '#E2E8F0'}`,
                    }}>
                    {s === 'pending' && <Clock className="w-3 h-3 inline mr-1" />}
                    {s === 'in_progress' && <Loader2 className="w-3 h-3 inline mr-1" />}
                    {s === 'done' && <CheckCircle2 className="w-3 h-3 inline mr-1" />}
                    {s === 'overdue' && <AlertTriangle className="w-3 h-3 inline mr-1" />}
                    {STATUS[s].label}
                  </button>
                ))}
              </div>
            </div>

            {/* Attachments */}
            <div className="px-5 py-4 border-b" style={{ borderColor: '#E2E8F0' }}>
              <TaskAttachments taskId={openTask.id} />
            </div>

            {/* Messages / updates thread (live) */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              <div className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-1">Updates</div>
              {(openTask.messages || []).length === 0 ? (
                <p className="text-sm text-slate-400">No updates yet.</p>
              ) : (
                openTask.messages.map(m => (
                  <div key={m.id} className="rounded-xl px-3 py-2" style={{ background: m.sender_role === 'admin' ? '#FFF1F2' : '#F1F5F9' }}>
                    <div className="text-[10px] font-bold uppercase mb-0.5" style={{ color: m.sender_role === 'admin' ? '#E11D48' : '#64748B' }}>
                      {m.sender_role} · {fmtTime(m.createdAt || m.created_at)}
                    </div>
                    <div className="text-sm text-slate-700 whitespace-pre-wrap">{m.message}</div>
                  </div>
                ))
              )}
            </div>

            {/* Composer */}
            <div className="px-5 py-3 border-t flex items-center gap-2" style={{ borderColor: '#E2E8F0' }}>
              <input value={msg} onChange={e => setMsg(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendMessage()}
                placeholder="Post an update… (e.g. checked 2B vs Books ✓)"
                className="flex-1 px-3 py-2 rounded-xl border text-sm outline-none" style={{ borderColor: '#CBD5E1' }} />
              <button onClick={sendMessage} className="w-9 h-9 rounded-xl flex items-center justify-center text-white" style={{ background: '#0748EE' }}>
                <Send className="w-4 h-4" />
              </button>
              {admin && (
                <button onClick={() => removeTask(openTask.id)} className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: '#FFF1F2', color: '#E11D48' }} title="Delete task">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
};

export default TasksPage;

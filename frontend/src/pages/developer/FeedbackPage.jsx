import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { Flag, Workflow, Loader2, Send, RefreshCw, Building2 } from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';
import { sidebarFor, isAdminUser, isDeveloperUser } from '../../lib/adminNav';

const STATUS = {
  pending:     { label: 'Pending',     bg: '#F1F5F9', c: '#64748B' },
  in_progress: { label: 'In Progress', bg: '#E8EFFE', c: '#0748EE' },
  done:        { label: 'Resolved',    bg: '#ECFDF5', c: '#059669' },
  overdue:     { label: 'Overdue',     bg: '#FEF2F2', c: '#E11D48' },
};
const STATUS_FLOW = ['pending', 'in_progress', 'done'];
const fmt = (s) => { try { return new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

export default function FeedbackPage() {
  const navigate = useNavigate();
  const admin = isAdminUser();
  // Accountants get a read-only view of the feedback THEY raised (reply only).
  // Only admin/developer can change status or spin up a plan.
  const canManage = admin || isDeveloperUser();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [msg, setMsg] = useState('');
  const [makingPlan, setMakingPlan] = useState(false);
  const pollRef = useRef(null);

  const sidebarItems = sidebarFor([
    { path: '/feedback', label: 'Feedback', icon: Flag },
    { path: '/plans', label: 'Plans', icon: Workflow },
  ]);

  const fetchList = useCallback(async () => {
    try {
      const r = await api.get('/api/tasks', { params: { category: 'feedback' } });
      setTasks(Array.isArray(r.data) ? r.data : []);
    } catch { toast.error('Failed to load feedback'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);

  const loadDetail = useCallback(async (id) => {
    try { const r = await api.get(`/api/tasks/${id}`); setDetail(r.data); } catch { /* noop */ }
  }, []);

  // Poll the open task's messages every 4s.
  useEffect(() => {
    clearInterval(pollRef.current);
    if (openId) { loadDetail(openId); pollRef.current = setInterval(() => loadDetail(openId), 4000); }
    return () => clearInterval(pollRef.current);
  }, [openId, loadDetail]);

  const open = (t) => { setOpenId(t.id); setDetail(t); };

  const setStatus = async (status) => {
    if (!detail) return;
    try {
      await api.put(`/api/tasks/${detail.id}`, { status });
      toast.success(`Marked ${STATUS[status]?.label || status}`);
      fetchList(); loadDetail(detail.id);
    } catch { toast.error('Could not update status'); }
  };

  const send = async () => {
    if (!msg.trim() || !detail) return;
    try {
      await api.post(`/api/tasks/${detail.id}/messages`, { message: msg.trim() });
      setMsg(''); loadDetail(detail.id);
    } catch { toast.error('Could not send message'); }
  };

  const makePlan = async () => {
    if (!detail || makingPlan) return;
    setMakingPlan(true);
    try {
      const r = await api.post(`/api/plans/from-task/${detail.id}`);
      toast.success('Plan created from this feedback');
      navigate(admin ? `/admin/plans/${r.data.id}` : `/plans/${r.data.id}`);
    } catch { toast.error('Could not create plan'); }
    finally { setMakingPlan(false); }
  };

  const meta = detail?.source_meta || {};
  const rows = Array.isArray(meta.rows) ? meta.rows : [];
  const rowCols = rows.length ? Object.keys(rows[0]) : [];

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="feedback-page">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-3xl font-bold tracking-tight" style={{ color: 'var(--text-heading)' }}>Feedback</h1>
            <p style={{ color: 'var(--text-muted)' }} className="mt-1 text-sm">{canManage
              ? 'User-flagged reconciliation issues — triage, discuss, and turn into a plan.'
              : 'Track the issues you flagged — follow the status and the team’s replies here.'}</p>
          </div>
          <button onClick={() => { setLoading(true); fetchList(); }} className="flex items-center gap-2 text-sm font-semibold px-3 py-2 rounded-xl"
            style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}>
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>

        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 360px) minmax(0, 1fr)', gap: '16px' }}>
          {/* List */}
          <div className="glass-card" style={{ padding: '8px', maxHeight: '78vh', overflowY: 'auto' }}>
            {loading ? (
              <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin" style={{ color: '#94A3B8' }} /></div>
            ) : tasks.length === 0 ? (
              <div className="text-center py-16 text-sm" style={{ color: 'var(--text-muted)' }}>
                <Flag className="w-10 h-10 mx-auto mb-3" style={{ color: '#CBD5E1' }} />
                {canManage
                  ? 'No feedback yet. When an accountant flags rows on a reco result, it lands here.'
                  : 'You haven’t flagged anything yet. Flag rows on a reco result and it will show up here.'}
              </div>
            ) : tasks.map((t) => {
              const st = STATUS[t.status] || STATUS.pending;
              const active = t.id === openId;
              return (
                <button key={t.id} onClick={() => open(t)}
                  className="w-full text-left rounded-xl p-3 mb-1 transition-colors"
                  style={{ background: active ? '#EFF6FF' : 'transparent', border: `1px solid ${active ? '#BFDBFE' : 'transparent'}` }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold truncate" style={{ color: 'var(--text-heading)' }}>{t.title}</span>
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: st.bg, color: st.c }}>{st.label}</span>
                  </div>
                  <div className="text-xs mt-1 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{t.description}</div>
                  <div className="text-[11px] mt-1.5" style={{ color: '#94A3B8' }}>
                    {t.source_meta?.by?.name ? `by ${t.source_meta.by.name}` : ''} · {fmt(t.createdAt)}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Detail */}
          <div className="glass-card" style={{ padding: '18px', minHeight: '60vh' }}>
            {!detail ? (
              <div className="flex items-center justify-center h-full text-sm" style={{ color: 'var(--text-muted)' }}>Select a feedback item to view details</div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
                  <div>
                    <h2 className="text-xl font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow, sans-serif' }}>{detail.title}</h2>
                    <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {meta.brandName && <span className="inline-flex items-center gap-1"><Building2 className="w-3 h-3" />{meta.brandName}</span>}
                      {meta.by?.name && <span>raised by {meta.by.name}</span>}
                      <span>{fmt(detail.createdAt)}</span>
                    </div>
                  </div>
                  {canManage && (
                    <button onClick={makePlan} disabled={makingPlan} className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl text-white"
                      style={{ background: '#0748EE', opacity: makingPlan ? 0.6 : 1 }}>
                      {makingPlan ? <Loader2 className="w-4 h-4 animate-spin" /> : <Workflow className="w-4 h-4" />} Make a plan
                    </button>
                  )}
                </div>

                {/* status flow — admin/developer can change it; accountant sees current status only */}
                <div className="flex items-center gap-2 mb-4 flex-wrap">
                  {canManage ? STATUS_FLOW.map((s) => {
                    const cfg = STATUS[s]; const on = detail.status === s;
                    return (
                      <button key={s} onClick={() => setStatus(s)}
                        className="text-xs font-bold px-3 py-1.5 rounded-full"
                        style={{ background: on ? cfg.bg : 'transparent', color: on ? cfg.c : '#94A3B8', border: `1.5px solid ${on ? cfg.c : '#E2E8F0'}` }}>
                        {cfg.label}
                      </button>
                    );
                  }) : (() => {
                    const cfg = STATUS[detail.status] || STATUS.pending;
                    return <span className="text-xs font-bold px-3 py-1.5 rounded-full" style={{ background: cfg.bg, color: cfg.c, border: `1.5px solid ${cfg.c}` }}>{cfg.label}</span>;
                  })()}
                </div>

                {/* the comment */}
                <div className="rounded-xl p-3 mb-4" style={{ background: '#F8FAFC', border: '1px solid #E2E8F0' }}>
                  <div className="text-[11px] font-bold uppercase tracking-wide mb-1" style={{ color: '#64748B' }}>Issue</div>
                  <div className="text-sm whitespace-pre-wrap" style={{ color: '#334155' }}>{detail.description}</div>
                </div>

                {/* flagged rows */}
                {rows.length > 0 && (
                  <div className="mb-4">
                    <div className="text-[11px] font-bold uppercase tracking-wide mb-2" style={{ color: '#64748B' }}>Flagged rows ({rows.length})</div>
                    <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid #E2E8F0' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                        <thead>
                          <tr>{rowCols.map((c) => <th key={c} style={{ textAlign: 'left', padding: '6px 10px', background: '#F8FAFC', color: '#64748B', fontWeight: 700, textTransform: 'uppercase', fontSize: '10px', letterSpacing: '0.04em', borderBottom: '1px solid #E2E8F0', whiteSpace: 'nowrap' }}>{c.replace(/_/g, ' ')}</th>)}</tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={i} style={{ background: i % 2 ? '#FAFBFF' : '#fff' }}>
                              {rowCols.map((c) => <td key={c} style={{ padding: '6px 10px', color: '#334155', borderBottom: '1px solid #F1F5F9', whiteSpace: 'nowrap' }}>{r[c] == null || r[c] === '' ? '—' : String(r[c])}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* discussion */}
                <div className="text-[11px] font-bold uppercase tracking-wide mb-2" style={{ color: '#64748B' }}>Discussion</div>
                <div className="space-y-2 mb-3" style={{ maxHeight: '28vh', overflowY: 'auto' }}>
                  {(detail.messages || []).length === 0 ? (
                    <div className="text-xs" style={{ color: '#94A3B8' }}>No messages yet.</div>
                  ) : detail.messages.map((m) => (
                    <div key={m.id} className="rounded-lg p-2.5" style={{ background: '#F8FAFC', border: '1px solid #F1F5F9' }}>
                      <div className="text-[11px] font-semibold mb-0.5" style={{ color: '#0748EE' }}>{m.sender?.name || 'User'} <span style={{ color: '#94A3B8', fontWeight: 400 }}>· {m.sender?.role}</span></div>
                      <div className="text-sm" style={{ color: '#334155' }}>{m.message}</div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()}
                    placeholder="Reply…" className="flex-1 text-sm rounded-xl px-3 py-2" style={{ border: '1px solid #E2E8F0', outline: 'none', color: '#334155' }} />
                  <button onClick={send} className="p-2 rounded-xl text-white" style={{ background: '#0748EE' }}><Send className="w-4 h-4" /></button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

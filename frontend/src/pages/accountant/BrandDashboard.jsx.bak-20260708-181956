import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LayoutDashboard, Bot, BarChart3, Activity, Rows3, Clock, Sparkles,
  CalendarDays, Video, FileText, Search, ChevronRight, Plus, Flag,
  CheckCircle2, ArrowUpRight, Building2, Send,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import BrandLogo from '../../components/BrandLogos';
import MeetingDetailModal from '../../components/MeetingDetailModal';
import api from '../../lib/api';
import { toast } from 'sonner';
import { sidebarFor } from '../../lib/adminNav';
import { useAuth } from '../../context/AuthContext';
import { SAMPLE_EVENTS, isPastOf } from '../../lib/sampleCalendar';

const RECO_ROUTE_MAP = {
  'gstr_2b_books':            'gstr_2b_books',
  'GSTR-2B-Books':            'gstr_2b_books',
  'gstr_2b_books_multistate': 'gstr_2b_books_multistate',
  'GSTR-2B-Books-Multistate': 'gstr_2b_books_multistate',
  'gstr_1_vs_books':          'gstr_1_vs_books',
  'gstr_3b_tally_entry':      'gstr_3b_tally_entry',
  'GSTR-3B-Tally-Entry':      'gstr_3b_tally_entry',
  'universal_bank_statement': 'universal_bank_statement',
  'Universal-Bank-Statement': 'universal_bank_statement',
};

// Friendly labels for the tool-activity table.
const AGENT_LABELS = {
  gstr_2b_books: 'GSTR-2B vs Books', gstr_2b_books_multistate: 'GSTR-2B vs Books (Multi-State)',
  gstr_2a_vs_2b_vs_books: 'GSTR-2A vs 2B vs Books', gstr_2b_vs_purchase: 'GSTR-2B vs Purchase',
  gstr_2a_2b_books: 'GSTR-2A + 2B vs Books', gstr_3b_vs_2b: 'GSTR-3B vs 2B',
  gstr_3b_tally_entry: 'GSTR-3B Tally Entry', universal_bank_statement: 'Universal Bank Statement',
  bank_reco: 'Bank Statement', gstr_1_vs_books: 'GSTR-1 vs Books',
  amazon_mtr_consolidator: 'Amazon MTR Consolidator', pdf_bank_extract: 'PDF Bank Extract',
};
const agentLabel = (t) => AGENT_LABELS[t] || String(t || '').replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

const CONF_COLORS = { High: '#059669', Medium: '#D97706', Low: '#E11D48' };
const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
const fmtDate = (s) => { if (!s) return '—'; try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return '—'; } };
const fmtDay = (s) => { try { return new Date(s).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' }); } catch { return ''; } };

// Time-saved heuristic: manual reconciliation ≈ 0.5 min per processed row +
// ~10 min setup/review per run. Surface as a friendly "hours saved" figure.
const hoursSaved = (rows, runs) => {
  const mins = (Number(rows) || 0) * 0.5 + (Number(runs) || 0) * 10;
  const hrs = mins / 60;
  return hrs >= 10 ? Math.round(hrs) : Math.round(hrs * 10) / 10;
};

const PRIORITY = {
  urgent: { bg: '#FEF2F2', c: '#E11D48', label: 'Urgent' },
  high:   { bg: '#FFF7ED', c: '#EA580C', label: 'High' },
  medium: { bg: '#EFF6FF', c: '#0748EE', label: 'Medium' },
  low:    { bg: '#F1F5F9', c: '#64748B', label: 'Low' },
};
const TASK_STATUS = {
  pending:     { bg: '#F1F5F9', c: '#64748B', label: 'To do' },
  in_progress: { bg: '#E8EFFE', c: '#0748EE', label: 'In progress' },
  done:        { bg: '#ECFDF5', c: '#059669', label: 'Done' },
  overdue:     { bg: '#FEF2F2', c: '#E11D48', label: 'Overdue' },
};

// ─── Small presentational atoms ──────────────────────────────────────────────
const SECTION_TITLE = { fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px' };

function Panel({ children, style, className = '' }) {
  return <div className={`glass-card ${className}`} style={{ padding: '16px 18px', ...style }}>{children}</div>;
}

function KpiCard({ icon: Icon, label, value, sub, color, bg }) {
  return (
    <div className="glass-card" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>{label}</span>
        <span style={{ width: 30, height: 30, borderRadius: 9, background: bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon style={{ width: 16, height: 16, color }} />
        </span>
      </div>
      <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: '30px', lineHeight: 1, color: 'var(--text-heading)' }}>{value}</div>
      {sub && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

function Soon() {
  return <span style={{ fontSize: '10px', fontWeight: 700, color: '#7C3AED', background: '#F5F3FF', border: '1px solid #DDD6FE', padding: '2px 7px', borderRadius: '9999px' }}>Coming soon</span>;
}

const BrandDashboard = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [brand, setBrand] = useState(null);
  const [myBrands, setMyBrands] = useState([]);
  const [agents, setAgents] = useState([]);
  const [summary, setSummary] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [driveFiles, setDriveFiles] = useState([]);
  const [upcoming, setUpcoming] = useState([]);
  const [recentMeetings, setRecentMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [showRequest, setShowRequest] = useState(false);
  const [showBrandMenu, setShowBrandMenu] = useState(false);
  const [reqName, setReqName] = useState('');
  const [reqDesc, setReqDesc] = useState('');
  const [reqBusy, setReqBusy] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [srcTab, setSrcTab] = useState('All');
  const [srcQuery, setSrcQuery] = useState('');
  const [detail, setDetail] = useState(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [ntTitle, setNtTitle] = useState('');
  const [ntDesc, setNtDesc] = useState('');
  const [ntPriority, setNtPriority] = useState('medium');
  const [ntDue, setNtDue] = useState('');
  const [ntBusy, setNtBusy] = useState(false);

  // Remember this brand so global pages (Meetings/Tasks/…) can still link back
  // to its Dashboard/Agents in the sidebar.
  useEffect(() => { if (brandId) { try { localStorage.setItem('lastBrandId', brandId); } catch (_) {} } }, [brandId]);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [brandRes, agentsRes] = await Promise.all([
        api.get(`/api/brands/${brandId}`),
        api.get(`/api/brands/${brandId}/agents`),
      ]);
      setBrand(brandRes.data);
      setAgents(Array.isArray(agentsRes.data) ? agentsRes.data : []);
    } catch (error) {
      toast.error('Failed to load brand data');
    } finally {
      setLoading(false);
    }
    // Secondary data — never blocks the dashboard; failures degrade gracefully.
    api.get(`/api/dashboard/summary/${brandId}`).then((r) => setSummary(r.data)).catch(() => setSummary(null));
    api.get('/api/tasks').then((r) => setTasks(Array.isArray(r.data) ? r.data : [])).catch(() => setTasks([]));
    api.get('/api/brands/my-brands').then((r) => setMyBrands(Array.isArray(r.data) ? r.data : [])).catch(() => setMyBrands([]));
    api.get(`/api/brands/${brandId}/drive`).then((r) => setDriveFiles(Array.isArray(r.data?.files) ? r.data.files : [])).catch(() => setDriveFiles([]));
    api.get('/api/meetings/upcoming').then((r) => setUpcoming(Array.isArray(r.data?.events) ? r.data.events : [])).catch(() => setUpcoming([]));
    api.get('/api/meetings/recent').then((r) => setRecentMeetings(Array.isArray(r.data?.meetings) ? r.data.meetings : [])).catch(() => setRecentMeetings([]));
  }, [brandId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Derived data ──
  const s = summary?.summary || {};
  const byAgent = summary?.by_agent || [];
  const confDist = summary?.confidence_dist || [];
  const monthly = summary?.monthly_trend || [];

  const totalRuns = s.total_jobs || 0;
  const totalRows = s.total_rows || 0;
  const activeAgents = byAgent.length;
  const savedHrs = useMemo(() => hoursSaved(totalRows, totalRuns), [totalRows, totalRuns]);

  const myTasks = useMemo(
    () => tasks.filter((t) => t.category !== 'feedback').sort((a, b) => {
      const da = a.due_date ? new Date(a.due_date).getTime() : Infinity;
      const db = b.due_date ? new Date(b.due_date).getTime() : Infinity;
      return da - db;
    }),
    [tasks]
  );
  const openTasks = myTasks.filter((t) => t.status !== 'done');
  const nextTask = openTasks[0] || null;
  const myFeedback = useMemo(
    () => tasks.filter((t) => t.category === 'feedback').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [tasks]
  );

  const trendData = useMemo(
    () => monthly.map((m) => ({ label: m.label, runs: Number(m.jobs) || 0 })),
    [monthly]
  );
  const agentBars = useMemo(
    () => byAgent.slice(0, 8).map((a) => ({ name: agentLabel(a.agent_type), runs: Number(a.runs) || 0 })),
    [byAgent]
  );
  const confDonut = useMemo(() => {
    const order = ['High', 'Medium', 'Low'];
    return order.filter((o) => confDist.some((c) => c.confidence === o))
      .map((o) => ({ name: o, value: Number(confDist.find((c) => c.confidence === o)?.count) || 0 }))
      .concat(confDist.filter((c) => !order.includes(c.confidence)).map((c) => ({ name: c.confidence || 'Unknown', value: Number(c.count) || 0 })));
  }, [confDist]);
  const hasData = totalRuns > 0;
  // Only TIMED events are real meetings — all-day entries (birthdays/holidays,
  // which repeat and clutter the list) come back as a date with no "T".
  const realUpcoming = useMemo(() => upcoming.filter((e) => /T/.test(String(e.start || ''))), [upcoming]);
  // Same rule as the Meetings page: a "meeting" has a video link; everything
  // else (timed, no link) is an "event". Next Meeting = next real meeting.
  const nextMeeting = useMemo(() => realUpcoming.find((e) => e.joinLink) || null, [realUpcoming]);
  const restUpcoming = useMemo(() => realUpcoming.filter((e) => !e.joinLink), [realUpcoming]);
  const fmtTime = (s) => { if (!s) return ''; try { return new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  const srcFiltered = useMemo(() => {
    const isImg = (m) => /image\//.test(m || '');
    const isReport = (m) => /(spreadsheet|excel|pdf|csv)/i.test(m || '');
    let list = driveFiles;
    if (srcTab === 'Images') list = driveFiles.filter((f) => isImg(f.mimeType));
    else if (srcTab === 'Reports') list = driveFiles.filter((f) => isReport(f.mimeType));
    else if (srcTab === 'Documents') list = driveFiles.filter((f) => !isImg(f.mimeType) && !f.isFolder);
    const q = srcQuery.trim().toLowerCase();
    return q ? list.filter((f) => (f.name || '').toLowerCase().includes(q)) : list;
  }, [driveFiles, srcTab, srcQuery]);
  // Upcoming events on the dashboard = real link-less calendar events + sample
  // CA-firm events (so the section is never near-empty), soonest first.
  const dashEvents = useMemo(() => {
    const merged = [...restUpcoming, ...SAMPLE_EVENTS.filter((e) => !isPastOf(e))];
    return merged.sort((a, b) => (new Date(a.start) || 0) - (new Date(b.start) || 0)).slice(0, 6);
  }, [restUpcoming]);
  const prettySize = (b) => { if (b == null) return ''; if (b < 1024) return `${b} B`; if (b < 1048576) return `${Math.round(b / 1024)} KB`; return `${(b / 1048576).toFixed(1)} MB`; };

  const submitRequest = async () => {
    if (!reqName.trim() || reqBusy) return;
    setReqBusy(true);
    try {
      await api.post('/api/agents/request', {
        name: reqName.trim(), description: reqDesc.trim(),
        brandId, brandName: brand?.name,
      });
      toast.success('Request sent to the admin team');
      setReqName(''); setReqDesc(''); setShowRequest(false);
    } catch { toast.error('Could not submit the request'); }
    finally { setReqBusy(false); }
  };

  const askAI = () => {
    navigate('/chat', { state: aiPrompt.trim() ? { prompt: aiPrompt.trim() } : undefined });
  };

  const submitNewTask = async () => {
    if (!ntTitle.trim() || ntBusy) return;
    setNtBusy(true);
    try {
      await api.post('/api/tasks/self', {
        title: ntTitle.trim(), description: ntDesc.trim(),
        priority: ntPriority, due_date: ntDue || null,
      });
      toast.success('Task added');
      setNtTitle(''); setNtDesc(''); setNtPriority('medium'); setNtDue(''); setShowNewTask(false);
      api.get('/api/tasks').then((r) => setTasks(Array.isArray(r.data) ? r.data : [])).catch(() => {});
    } catch { toast.error('Could not add task'); }
    finally { setNtBusy(false); }
  };

  const openAgent = (agent) => {
    const recoSlug = RECO_ROUTE_MAP[agent.name];
    recoSlug
      ? navigate(`/brands/${brandId}/reco/${recoSlug}`)
      : navigate(`/brands/${brandId}/agents/${agent.id}`);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-slate-900" />
      </div>
    );
  }

  const firstName = (user?.name || 'there').split(' ')[0];

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="brand-dashboard" style={{ maxWidth: 1320, margin: '0 auto' }}>

        {/* ── Welcome banner + brand switcher ───────────────────────────── */}
        <div className="glass-card" style={{ padding: '22px 24px', marginBottom: '18px', background: 'linear-gradient(120deg, #EEF3FF 0%, #FFFFFF 60%)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '14px' }}>
            <div>
              <button onClick={() => navigate('/brands')} data-testid="back-to-brands"
                style={{ fontSize: '12px', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: '8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                ← Back to Brands
              </button>
              <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: '28px', color: 'var(--text-heading)', lineHeight: 1.1 }}>
                Welcome, {firstName} <span style={{ fontWeight: 400 }}>👋</span>
              </h1>
              <p style={{ color: 'var(--text-muted)', marginTop: '6px', fontSize: '14px' }}>
                Here's what's happening with <strong style={{ color: 'var(--text-heading)' }}>{brand?.name}</strong>{brand?.description ? ` · ${brand.description}` : ''}.
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', position: 'relative' }}>
              {/* Brand switcher */}
              <div style={{ position: 'relative' }}>
                <button onClick={() => setShowBrandMenu((v) => !v)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 12, padding: '9px 14px', fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', cursor: 'pointer' }}>
                  <Building2 style={{ width: 15, height: 15, color: '#0748EE' }} /> {brand?.name} <ChevronRight style={{ width: 14, height: 14, transform: 'rotate(90deg)', color: '#94A3B8' }} />
                </button>
                {showBrandMenu && myBrands.length > 0 && (
                  <div className="glass-card" style={{ position: 'absolute', top: '110%', right: 0, zIndex: 40, padding: 6, minWidth: 220, maxHeight: 280, overflowY: 'auto' }}>
                    {myBrands.map((b) => (
                      <button key={b.id} onClick={() => { setShowBrandMenu(false); if (b.id !== brandId) navigate(`/brands/${b.id}/dashboard`); }}
                        style={{ width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: b.id === brandId ? 700 : 500, color: b.id === brandId ? '#0748EE' : 'var(--text-heading)', background: b.id === brandId ? '#EFF6FF' : 'transparent' }}>
                        {b.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Button onClick={() => setShowRequest(true)} variant="default">
                <Plus className="mr-2 h-4 w-4" /> Request a new agent
              </Button>
            </div>
          </div>
        </div>

        {/* ── KPI row ───────────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '14px', marginBottom: '18px' }}>
          <KpiCard icon={Activity} label="Total Runs"     value={fmtNum(totalRuns)}   sub="across all tools" color="#0748EE" bg="#E8EFFE" />
          <KpiCard icon={Rows3}    label="Rows Processed" value={fmtNum(totalRows)}   sub="reconciled rows"  color="#7C3AED" bg="#F5F3FF" />
          <KpiCard icon={Clock}    label="Time Saved"     value={`≈ ${savedHrs} hrs`} sub="vs. manual work"  color="#059669" bg="#ECFDF5" />
          <KpiCard icon={Bot}      label="Active Agents"  value={fmtNum(activeAgents || agents.length)} sub={`${agents.length} assigned`} color="#EA580C" bg="#FFF7ED" />
        </div>

        {/* ── Row A: Today/Agenda · Next Meeting · Ask AI ───────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '14px', marginBottom: '18px' }}>
          {/* Today + Agenda */}
          <Panel>
            <div style={SECTION_TITLE}><CalendarDays style={{ width: 14, height: 14 }} /> Today</div>
            <div style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: '20px', color: 'var(--text-heading)' }}>
              {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
            </div>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {openTasks.slice(0, 3).length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No tasks due. Calendar agenda <Soon /></div>
              ) : openTasks.slice(0, 3).map((t) => (
                <div key={t.id} onClick={() => navigate('/tasks')} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: (PRIORITY[t.priority] || PRIORITY.medium).c }} />
                  <span style={{ fontSize: 13, color: 'var(--text-heading)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.due_date ? fmtDay(t.due_date) : ''}</span>
                </div>
              ))}
            </div>
            <button onClick={() => navigate('/tasks')} style={{ marginTop: 14, fontSize: 13, fontWeight: 600, color: '#0748EE', background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Open Calendar <ArrowUpRight style={{ width: 14, height: 14 }} />
            </button>
          </Panel>

          {/* Next Meeting */}
          <Panel>
            <div style={{ ...SECTION_TITLE, justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Video style={{ width: 14, height: 14 }} /> Next Meeting</span>
              {!nextMeeting && <Soon />}
            </div>
            {nextMeeting ? (
              <>
                <div onClick={() => setDetail({ ...nextMeeting, past: false })} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0 12px', cursor: 'pointer' }}>
                  <BrandLogo type={/zoom/i.test(nextMeeting.joinLink || '') ? 'zoom' : 'google_meet'} size={34} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nextMeeting.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtTime(nextMeeting.start)}</div>
                  </div>
                </div>
                {nextMeeting.joinLink && (
                  <a href={nextMeeting.joinLink} target="_blank" rel="noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', background: '#0748EE', color: '#fff', fontSize: 13, fontWeight: 600, borderRadius: 10, padding: '9px 0', textDecoration: 'none' }}>
                    <Video style={{ width: 15, height: 15 }} /> Join Now
                  </a>
                )}
              </>
            ) : recentMeetings.length > 0 ? (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94A3B8', marginBottom: 6 }}>Recent meetings</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {recentMeetings.slice(0, 3).map((m) => (
                    <a key={m.id} href={m.url || '#'} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
                      <BrandLogo type="fireflies" size={20} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtTime(m.date)}{m.duration ? ` · ${Math.round(m.duration)} min` : ''}</div>
                      </div>
                    </a>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0' }}>
                  <BrandLogo type="google_meet" size={34} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-heading)' }}>No upcoming meeting</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Connect a calendar to see your next call here.</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <BrandLogo type="zoom" size={20} />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>Zoom & Google Meet supported</span>
                </div>
              </>
            )}
          </Panel>

          {/* Ask Colonel AI */}
          <Panel>
            <div style={SECTION_TITLE}><Sparkles style={{ width: 14, height: 14, color: '#7C3AED' }} /> Ask Colonel AI</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
              <span style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #7C3AED 0%, #0748EE 100%)' }}>
                <Sparkles style={{ width: 19, height: 19, color: '#fff' }} />
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.35 }}>
                Your AI copilot — ask about reconciliations, ledgers, or this brand.
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && askAI()}
                placeholder="Ask anything…"
                style={{ flex: 1, fontSize: 13, borderRadius: 10, border: '1px solid var(--card-border)', padding: '9px 12px', outline: 'none', color: 'var(--text-heading)', background: 'var(--surface)' }} />
              <button onClick={askAI} style={{ background: '#0748EE', color: '#fff', border: 'none', borderRadius: 10, padding: '0 12px', cursor: 'pointer' }}>
                <Send style={{ width: 15, height: 15 }} />
              </button>
            </div>
          </Panel>
        </div>

        {/* ── Upcoming Events (Calendar — live in Phase 2) ──────────────── */}
        <Panel style={{ marginBottom: '18px' }}>
          <div style={{ ...SECTION_TITLE, justifyContent: 'space-between', marginBottom: 14 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><CalendarDays style={{ width: 14, height: 14 }} /> Upcoming Events</span>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <button onClick={() => navigate('/meetings')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700, color: '#7C3AED', background: 'none', border: 'none', cursor: 'pointer' }}>
                <Plus style={{ width: 14, height: 14 }} /> Schedule meeting
              </button>
            </div>
          </div>
          {dashEvents.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '22px 0', color: 'var(--text-muted)' }}>
              <Video style={{ width: 30, height: 30, margin: '0 auto 8px', color: '#CBD5E1' }} />
              <div style={{ fontSize: 13 }}>Nothing else coming up.</div>
              <div style={{ fontSize: 12, marginTop: 2 }}>Your next meeting is shown above; more upcoming events appear here.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {dashEvents.map((ev) => (
                <div key={ev.id} onClick={() => setDetail({ ...ev, past: isPastOf(ev) })} style={{ border: '1px solid var(--card-border)', borderRadius: 12, padding: '12px 14px', cursor: 'pointer' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFC'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    {ev.joinLink
                      ? <BrandLogo type={/zoom/i.test(ev.joinLink) ? 'zoom' : 'google_meet'} size={18} />
                      : <BrandLogo type="google_calendar" size={18} />}
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtTime(ev.start)}</div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* ── Row B: Sources to chat with · My Tasks ────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', gap: '14px', marginBottom: '18px' }}>
          {/* Sources to chat with (brand Drive — live in Phase 2) */}
          <Panel>
            <div style={{ ...SECTION_TITLE, justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><BrandLogo type="google_drive" size={16} /> Sources to chat with</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{driveFiles.length} files</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--page-bg, #F5F6FA)', border: '1px solid var(--card-border)', borderRadius: 10, padding: '8px 12px', marginBottom: 10 }}>
              <Search style={{ width: 15, height: 15, color: '#94A3B8' }} />
              <input value={srcQuery} onChange={(e) => setSrcQuery(e.target.value)} placeholder="Search this brand's shared Drive…" style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text-heading)' }} />
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {['All', 'Documents', 'Reports', 'Images'].map((t) => (
                <button key={t} onClick={() => setSrcTab(t)} style={{ fontSize: 12, fontWeight: 600, padding: '4px 11px', borderRadius: 9999, cursor: 'pointer', background: srcTab === t ? '#0748EE1A' : '#F8FAFC', border: `1.5px solid ${srcTab === t ? '#0748EE' : '#E2E8F0'}`, color: srcTab === t ? '#0748EE' : '#64748B' }}>{t}</button>
              ))}
            </div>
            {srcFiltered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)' }}>
                <FileText style={{ width: 30, height: 30, margin: '0 auto 8px', color: '#CBD5E1' }} />
                <div style={{ fontSize: 13 }}>{driveFiles.length === 0 ? "This brand's Drive folder isn't connected yet." : 'No files in this category.'}</div>
                {driveFiles.length === 0 && <div style={{ fontSize: 12, marginTop: 2 }}>An admin can link it so files appear here to chat with.</div>}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
                {srcFiltered.slice(0, 30).map((f) => (
                  <a key={f.id} href={f.webViewLink} target="_blank" rel="noreferrer"
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderRadius: 8, textDecoration: 'none' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFC'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                    {f.isFolder ? <BrandLogo type="google_drive" size={18} /> : <FileText style={{ width: 17, height: 17, color: '#0748EE' }} />}
                    <span style={{ flex: 1, fontSize: 13, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    {f.size != null && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{prettySize(f.size)}</span>}
                  </a>
                ))}
              </div>
            )}
            {driveFiles.length > 0 && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--card-border)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94A3B8', marginBottom: 8 }}>Previously viewed files</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {driveFiles.filter((f) => !f.isFolder).slice(0, 3).map((f) => (
                    <a key={`recent-${f.id}`} href={f.webViewLink} target="_blank" rel="noreferrer"
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 6px', borderRadius: 8, textDecoration: 'none' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFC'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                      <FileText style={{ width: 16, height: 16, color: '#0748EE' }} />
                      <span style={{ flex: 1, fontSize: 13, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      <ChevronRight style={{ width: 14, height: 14, color: '#CBD5E1' }} />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </Panel>

          {/* My Tasks */}
          <Panel style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ ...SECTION_TITLE, justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><CheckCircle2 style={{ width: 14, height: 14 }} /> My Tasks</span>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{openTasks.length} open</span>
                <button onClick={() => setShowNewTask(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 700, color: '#0748EE', background: 'none', border: 'none', cursor: 'pointer' }}>
                  <Plus style={{ width: 14, height: 14 }} /> New task
                </button>
              </div>
            </div>
            {nextTask && (
              <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 10, padding: '10px 12px', marginBottom: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#0748EE', marginBottom: 3 }}>Up next</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)' }}>{nextTask.title}</div>
                {nextTask.due_date && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Due {fmtDate(nextTask.due_date)}</div>}
              </div>
            )}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7, overflowY: 'auto', maxHeight: 180 }}>
              {myTasks.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>No tasks assigned yet.</div>
              ) : myTasks.slice(0, 6).map((t) => {
                const st = TASK_STATUS[t.status] || TASK_STATUS.pending;
                const pr = PRIORITY[t.priority] || PRIORITY.medium;
                return (
                  <div key={t.id} onClick={() => navigate('/tasks')} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '4px 0' }}>
                    <span style={{ fontSize: 13, color: 'var(--text-heading)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: pr.c, background: pr.bg, padding: '1px 7px', borderRadius: 9999 }}>{pr.label}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: st.c, background: st.bg, padding: '1px 7px', borderRadius: 9999 }}>{st.label}</span>
                  </div>
                );
              })}
            </div>
            <button onClick={() => navigate('/tasks')} style={{ marginTop: 10, fontSize: 13, fontWeight: 600, color: '#0748EE', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
              Manage tasks →
            </button>
          </Panel>
        </div>

        {/* ── Charts row ────────────────────────────────────────────────── */}
        {hasData && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: '14px', marginBottom: '18px' }}>
            <Panel>
              <div style={SECTION_TITLE}>Runs over time</div>
              <ResponsiveContainer width="100%" height={210}>
                <LineChart data={trendData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94A3B8' }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94A3B8' }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="runs" stroke="#0748EE" strokeWidth={2.5} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </Panel>
            <Panel>
              <div style={SECTION_TITLE}>Runs by tool</div>
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={agentBars} layout="vertical" margin={{ top: 5, right: 10, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#94A3B8' }} />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 10, fill: '#64748B' }} />
                  <Tooltip />
                  <Bar dataKey="runs" fill="#7C3AED" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>
            {confDonut.length > 0 && (
              <Panel>
                <div style={SECTION_TITLE}>Confidence distribution</div>
                <ResponsiveContainer width="100%" height={210}>
                  <PieChart>
                    <Pie data={confDonut} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={2}>
                      {confDonut.map((d, i) => <Cell key={d.name} fill={CONF_COLORS[d.name] || ['#0748EE', '#94A3B8', '#0F766E'][i % 3]} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [fmtNum(v), n]} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </Panel>
            )}
          </div>
        )}

        {/* ── Tool activity table ───────────────────────────────────────── */}
        {byAgent.length > 0 && (
          <Panel style={{ padding: 0, overflow: 'hidden', marginBottom: '18px' }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--card-border)' }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-heading)' }}>Tool activity</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>What you've run, how often, and when.</div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr>
                    {['Tool', 'Runs', 'Rows', 'Time Saved', 'Last Run'].map((h, i) => (
                      <th key={h} style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748B', background: '#F8FAFC', padding: '9px 14px', textAlign: i === 0 || i === 4 ? 'left' : 'right', borderBottom: '1.5px solid #E2E8F0', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {byAgent.map((a, i) => (
                    <tr key={a.agent_type} style={{ background: i % 2 ? '#FAFBFF' : undefined }}>
                      <td style={{ fontSize: 13, padding: '9px 14px', color: 'var(--text-heading)', fontWeight: 600 }}>{agentLabel(a.agent_type)}</td>
                      <td style={{ fontSize: 13, padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#334155' }}>{fmtNum(a.runs)}</td>
                      <td style={{ fontSize: 13, padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#334155' }}>{fmtNum(a.total_rows)}</td>
                      <td style={{ fontSize: 13, padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#059669', fontWeight: 600 }}>≈ {hoursSaved(a.total_rows, a.runs)} hrs</td>
                      <td style={{ fontSize: 13, padding: '9px 14px', color: '#64748B', whiteSpace: 'nowrap' }}>{fmtDate(a.last_run)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        {/* ── Row C: My Feedback · Connected tools ──────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', gap: '14px', marginBottom: '18px' }}>
          <Panel>
            <div style={{ ...SECTION_TITLE, justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Flag style={{ width: 14, height: 14 }} /> My Feedback</span>
              <button onClick={() => navigate('/feedback')} style={{ fontSize: 12, fontWeight: 600, color: '#0748EE', background: 'none', border: 'none', cursor: 'pointer' }}>View all →</button>
            </div>
            {myFeedback.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 0' }}>
                Nothing flagged yet. When you flag rows on a reco result, you'll see the status and replies here.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {myFeedback.slice(0, 4).map((f) => {
                  const st = TASK_STATUS[f.status] || TASK_STATUS.pending;
                  const lastMsg = (f.messages || [])[f.messages?.length - 1];
                  return (
                    <div key={f.id} onClick={() => navigate('/feedback')} style={{ cursor: 'pointer', border: '1px solid #F1F5F9', borderRadius: 10, padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: st.c, background: st.bg, padding: '2px 8px', borderRadius: 9999, whiteSpace: 'nowrap' }}>{st.label}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {lastMsg ? `${lastMsg.sender?.name || 'Reply'}: ${lastMsg.message}` : f.description}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel>
            <div style={SECTION_TITLE}>Connected tools</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {[
                { type: 'google', label: 'Google' },
                { type: 'gmail', label: 'Gmail' },
                { type: 'google_drive', label: 'Drive' },
                { type: 'fireflies', label: 'Fireflies' },
                { type: 'tally', label: 'Tally' },
                { type: 'slack', label: 'Slack' },
              ].map((it) => (
                <span key={it.type} title={it.label} style={{ width: 38, height: 38, borderRadius: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--card-border)' }}>
                  <BrandLogo type={it.type} size={22} />
                </span>
              ))}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>Integrations are managed by your admin.</div>
          </Panel>
        </div>

        {/* ── Assigned Agents + Request a new agent ─────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <h2 style={{ fontFamily: 'Manrope, sans-serif', fontSize: '18px', fontWeight: 800, color: 'var(--text-heading)' }}>Your Agents</h2>
          <button onClick={() => setShowRequest(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#0748EE', background: 'var(--surface)', border: '1px solid #A3BFF8', borderRadius: 10, padding: '8px 14px', cursor: 'pointer' }}>
            <Plus style={{ width: 15, height: 15 }} /> Request a new agent
          </button>
        </div>
        {agents.length === 0 ? (
          <Card><CardContent className="py-8 text-center"><Bot className="h-12 w-12 text-slate-400 mx-auto mb-4" /><p className="text-slate-600">No agents assigned to this brand yet</p></CardContent></Card>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px' }} data-testid="agents-grid">
            {agents.map((agent) => (
              <div key={agent.id} onClick={() => openAgent(agent)} data-testid={`agent-card-${agent.id}`}
                className="glass-card" style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6, transition: 'box-shadow 0.2s, transform 0.2s' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 30, height: 30, borderRadius: 8, background: '#E8EFFE', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Bot style={{ width: 16, height: 16, color: '#0748EE' }} /></span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-heading)' }}>{agent.name}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4, minHeight: 32, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{agent.description}</div>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#0748EE', marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 3 }}>Open agent <ChevronRight style={{ width: 13, height: 13 }} /></span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── CFO agent picker (unchanged) ─────────────────────────────────── */}
      <Dialog open={showAgentPicker} onOpenChange={setShowAgentPicker}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl text-center font-bold text-slate-900">Select Analytics Agent</DialogTitle>
            <p className="text-center text-slate-500 mt-2">Choose an agent to view its corresponding CFO Revenue Dashboard.</p>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-4 mt-4">
            {agents.map((agent) => (
              <Card key={agent.id} className="cursor-pointer hover:shadow-xl transition-all border-2 border-transparent hover:border-slate-800 bg-gradient-to-br from-slate-50 to-white"
                onClick={() => { setShowAgentPicker(false); navigate(`/brands/${brandId}/agents/${agent.id}`, { state: { openCfo: true } }); }}>
                <CardHeader className="text-center pb-2">
                  <div className="w-14 h-14 rounded-full bg-slate-200 flex items-center justify-center mx-auto mb-3 shadow-inner"><BarChart3 className="text-slate-700 w-7 h-7" /></div>
                  <CardTitle className="text-lg">{agent.name}</CardTitle>
                </CardHeader>
                <CardContent className="text-center text-sm text-slate-500"><p className="line-clamp-2">{agent.description || 'View financial analytics for this portal.'}</p></CardContent>
              </Card>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Request a new agent modal ────────────────────────────────────── */}
      <Dialog open={showRequest} onOpenChange={setShowRequest}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-slate-900">Request a new agent</DialogTitle>
            <p className="text-sm text-slate-500 mt-1">Tell us what you need. This goes straight to the admin team as a request.</p>
          </DialogHeader>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Agent name *</label>
              <input value={reqName} onChange={(e) => setReqName(e.target.value)} placeholder="e.g. Nykaa Settlement Reconciliation"
                style={{ width: '100%', marginTop: 5, fontSize: 14, borderRadius: 10, border: '1px solid #E2E8F0', padding: '9px 12px', outline: 'none', color: '#334155' }} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em' }}>What should it do?</label>
              <textarea value={reqDesc} onChange={(e) => setReqDesc(e.target.value)} rows={4} placeholder="Describe the inputs, the reconciliation/automation you need, and the expected output."
                style={{ width: '100%', marginTop: 5, fontSize: 14, borderRadius: 10, border: '1px solid #E2E8F0', padding: '9px 12px', outline: 'none', color: '#334155', resize: 'vertical', fontFamily: 'inherit' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setShowRequest(false)} style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', color: '#334155', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={submitRequest} disabled={!reqName.trim() || reqBusy}
                style={{ padding: '9px 18px', borderRadius: 10, border: 'none', background: (!reqName.trim() || reqBusy) ? '#94A3B8' : '#0748EE', color: '#fff', fontSize: 13, fontWeight: 600, cursor: (!reqName.trim() || reqBusy) ? 'not-allowed' : 'pointer' }}>
                {reqBusy ? 'Sending…' : 'Submit request'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── New task modal ───────────────────────────────────────────────── */}
      <Dialog open={showNewTask} onOpenChange={setShowNewTask}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-slate-900">New task</DialogTitle>
            <p className="text-sm text-slate-500 mt-1">Add a personal to-do for yourself.</p>
          </DialogHeader>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Title *</label>
              <input value={ntTitle} onChange={(e) => setNtTitle(e.target.value)} placeholder="e.g. Reconcile June bank statement"
                style={{ width: '100%', marginTop: 5, fontSize: 14, borderRadius: 10, border: '1px solid #E2E8F0', padding: '9px 12px', outline: 'none', color: '#334155' }} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Notes</label>
              <textarea value={ntDesc} onChange={(e) => setNtDesc(e.target.value)} rows={3} placeholder="Optional details…"
                style={{ width: '100%', marginTop: 5, fontSize: 14, borderRadius: 10, border: '1px solid #E2E8F0', padding: '9px 12px', outline: 'none', color: '#334155', resize: 'vertical', fontFamily: 'inherit' }} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Priority</label>
                <select value={ntPriority} onChange={(e) => setNtPriority(e.target.value)}
                  style={{ width: '100%', marginTop: 5, fontSize: 14, borderRadius: 10, border: '1px solid #E2E8F0', padding: '9px 12px', outline: 'none', color: '#334155', background: '#fff' }}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Due date</label>
                <input type="date" value={ntDue} onChange={(e) => setNtDue(e.target.value)}
                  style={{ width: '100%', marginTop: 5, fontSize: 14, borderRadius: 10, border: '1px solid #E2E8F0', padding: '9px 12px', outline: 'none', color: '#334155' }} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setShowNewTask(false)} style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', color: '#334155', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={submitNewTask} disabled={!ntTitle.trim() || ntBusy}
                style={{ padding: '9px 18px', borderRadius: 10, border: 'none', background: (!ntTitle.trim() || ntBusy) ? '#94A3B8' : '#0748EE', color: '#fff', fontSize: 13, fontWeight: 600, cursor: (!ntTitle.trim() || ntBusy) ? 'not-allowed' : 'pointer' }}>
                {ntBusy ? 'Adding…' : 'Add task'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <MeetingDetailModal detail={detail} onClose={() => setDetail(null)} />
    </DashboardLayout>
  );
};

export default BrandDashboard;

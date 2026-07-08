import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  LayoutDashboard, Bot, BarChart3, Activity, Rows3, Clock, Sparkles,
  CalendarDays, Video, FileText, Search, ChevronRight, Plus, Flag,
  CheckCircle2, ArrowUpRight, Building2, Send, Plug, Zap, History,
  ExternalLink,
} from 'lucide-react';
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
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayKeyOf = (s) => { if (!s) return ''; const d = new Date(s); if (isNaN(d)) return String(s).slice(0, 10); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Time-saved heuristic: manual reconciliation ≈ 0.5 min per processed row +
// ~10 min setup/review per run. Surface as a friendly "hours saved" figure.
const hoursSaved = (rows, runs) => {
  const mins = (Number(rows) || 0) * 0.5 + (Number(runs) || 0) * 10;
  const hrs = mins / 60;
  return hrs >= 10 ? Math.round(hrs) : Math.round(hrs * 10) / 10;
};

const PRIORITY = {
  urgent: { bg: '#FEF2F2', c: '#E11D48', label: 'Urgent', rank: 0 },
  high:   { bg: '#FFF7ED', c: '#EA580C', label: 'High', rank: 1 },
  medium: { bg: '#EFF6FF', c: '#0748EE', label: 'Medium', rank: 2 },
  low:    { bg: '#F1F5F9', c: '#64748B', label: 'Low', rank: 3 },
};
const TASK_STATUS = {
  pending:     { bg: '#F1F5F9', c: '#64748B', label: 'To do' },
  in_progress: { bg: '#E8EFFE', c: '#0748EE', label: 'In progress' },
  done:        { bg: '#ECFDF5', c: '#059669', label: 'Done' },
  overdue:     { bg: '#FEF2F2', c: '#E11D48', label: 'Overdue' },
};

// Source badge for the aggregated Today / My Tasks feeds (Tasks + Compliance +
// Statutory merged into one list, tagged by where each item came from).
const SRC = {
  task:       { label: 'Task',      c: '#7C3AED', bg: '#F5F3FF' },
  compliance: { label: 'Tracker',   c: '#0748EE', bg: '#E8EFFE' },
  statutory:  { label: 'Statutory', c: '#EA580C', bg: '#FFF7ED' },
  meeting:    { label: 'Meeting',   c: '#0EA5E9', bg: '#E0F2FE' },
};

// Sample Drive files — shown ONLY when the real per-brand Drive listing is
// empty (locally the Google creds live on AWS, so the mirror is empty here).
// On AWS with a linked+shared folder, the real files replace these.
const SAMPLE_DRIVE_FILES = [
  { id: 's1', name: 'GSTR-2B Recon — June.xlsx', mimeType: 'application/vnd.ms-excel', size: 2100000, webViewLink: '#', sample: true },
  { id: 's2', name: 'Purchase Register — May.pdf', mimeType: 'application/pdf', size: 840000, webViewLink: '#', sample: true },
  { id: 's3', name: 'Ledger Master — Stroom.gsheet', mimeType: 'application/vnd.google-apps.spreadsheet', size: null, webViewLink: '#', sample: true },
  { id: 's4', name: 'Bank Statement — HDFC Q1.xlsx', mimeType: 'application/vnd.ms-excel', size: 1500000, webViewLink: '#', sample: true },
  { id: 's5', name: 'Board review — Q1 FY27.mp4', mimeType: 'video/mp4', size: 42000000, webViewLink: '#', sample: true },
];

// ─── Small presentational atoms ──────────────────────────────────────────────
const SECTION_TITLE = { fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px' };

function Panel({ children, style, className = '' }) {
  return <div className={`glass-card ${className}`} style={{ padding: '16px 18px', ...style }}>{children}</div>;
}

function KpiCard({ icon: Icon, label, value, sub, color, bg }) {
  return (
    <div className="glass-card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, background: bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon style={{ width: 17, height: 17, color }} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: '22px', lineHeight: 1.05, color: 'var(--text-heading)' }}>{value}</div>
        <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>{label}</div>
      </div>
    </div>
  );
}

// File-type icon tint for the Drive mirror + previously-viewed cards.
const fileTint = (mime = '') => {
  if (/image\//.test(mime)) return { bg: '#FEF3F2', c: '#E11D48' };
  if (/video\//.test(mime)) return { bg: '#F5F3FF', c: '#7C3AED' };
  if (/(spreadsheet|excel|sheet|csv)/i.test(mime)) return { bg: '#E6F4EA', c: '#188038' };
  if (/pdf/i.test(mime)) return { bg: '#FCE8E6', c: '#D93025' };
  if (/(document|word|gdoc)/i.test(mime)) return { bg: '#E8F0FE', c: '#1a73e8' };
  return { bg: '#EEF2F8', c: '#64748B' };
};

const BrandDashboard = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [brand, setBrand] = useState(null);
  const [myBrands, setMyBrands] = useState([]);
  const [agents, setAgents] = useState([]);
  const [summary, setSummary] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [compliance, setCompliance] = useState([]);
  const [statutory, setStatutory] = useState([]);
  const [driveFiles, setDriveFiles] = useState([]);
  const [driveMeta, setDriveMeta] = useState({ configured: null });
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
  const [prioritized, setPrioritized] = useState(false);
  const [taskQuery, setTaskQuery] = useState('');
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
    // Compliance Tracker (brand + user scoped) — second source for Today/My Tasks.
    api.get(`/api/brands/${brandId}/compliance`)
      .then((r) => setCompliance(Array.isArray(r.data?.tasks) ? r.data.tasks : (Array.isArray(r.data) ? r.data : [])))
      .catch(() => setCompliance([]));
    // Statutory filings (owner-gated → 403 for non-owners; swallow to []).
    api.get(`/api/brands/${brandId}/statutory`)
      .then((r) => setStatutory(Array.isArray(r.data?.filings) ? r.data.filings : (Array.isArray(r.data) ? r.data : [])))
      .catch(() => setStatutory([]));
    api.get('/api/brands/my-brands').then((r) => setMyBrands(Array.isArray(r.data) ? r.data : [])).catch(() => setMyBrands([]));
    api.get(`/api/brands/${brandId}/drive`).then((r) => {
      setDriveFiles(Array.isArray(r.data?.files) ? r.data.files : []);
      setDriveMeta({ configured: r.data?.configured, reason: r.data?.reason });
    }).catch(() => { setDriveFiles([]); setDriveMeta({ configured: false }); });
    api.get('/api/meetings/upcoming').then((r) => setUpcoming(Array.isArray(r.data?.events) ? r.data.events : [])).catch(() => setUpcoming([]));
    api.get('/api/meetings/recent').then((r) => setRecentMeetings(Array.isArray(r.data?.meetings) ? r.data.meetings : [])).catch(() => setRecentMeetings([]));
  }, [brandId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Derived data ──
  const s = summary?.summary || {};
  const byAgent = summary?.by_agent || [];
  const monthly = summary?.monthly_trend || [];

  const totalRuns = s.total_jobs || 0;
  const totalRows = s.total_rows || 0;
  const activeAgents = byAgent.length;
  const savedHrs = useMemo(() => hoursSaved(totalRows, totalRuns), [totalRows, totalRuns]);

  const myFeedback = useMemo(
    () => tasks.filter((t) => t.category === 'feedback').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [tasks]
  );

  // Only TIMED events are real meetings — all-day entries (birthdays/holidays)
  // come back as a date with no "T".
  const realUpcoming = useMemo(() => upcoming.filter((e) => /T/.test(String(e.start || ''))), [upcoming]);
  const nextMeeting = useMemo(() => realUpcoming.find((e) => e.joinLink) || null, [realUpcoming]);

  // ── Aggregated agenda: Tasks + Compliance + Statutory, normalized + tagged ──
  const agenda = useMemo(() => {
    const out = [];
    (tasks || []).filter((t) => t.category !== 'feedback').forEach((t) => out.push({
      key: `task-${t.id}`, source: 'task', title: t.title,
      status: t.status || 'pending', priority: t.priority || 'medium',
      due: t.due_date, route: '/tasks',
    }));
    (compliance || []).forEach((c) => {
      const status = c.status === 'done' ? 'done' : (c.status === 'in_progress' || c.status === 'review' ? 'in_progress' : 'pending');
      out.push({
        key: `comp-${c.id}`, source: 'compliance', title: c.title,
        status, priority: c.priority || 'medium',
        due: c.due_date, route: `/brands/${brandId}/compliance-tracker`,
      });
    });
    (statutory || []).forEach((f) => {
      if (f.status === 'not_applicable') return;
      const status = f.status === 'filed' ? 'done' : 'pending';
      out.push({
        key: `stat-${f.id}`, source: 'statutory', title: f.title || agentLabel(f.compliance_type),
        status, priority: 'medium', due: f.due_date, route: `/brands/${brandId}/statutory-compliance`,
      });
    });
    return out;
  }, [tasks, compliance, statutory, brandId]);

  // Today = today's meetings + agenda items due today (any source), time-sorted.
  const todayItems = useMemo(() => {
    const tk = todayKey();
    const meetings = realUpcoming
      .filter((e) => dayKeyOf(e.start) === tk)
      .map((e) => ({ key: `meet-${e.id}`, source: 'meeting', title: e.title, when: e.start, joinLink: e.joinLink, route: null }));
    const items = agenda
      .filter((a) => a.status !== 'done' && dayKeyOf(a.due) === tk)
      .map((a) => ({ ...a, when: a.due }));
    return [...meetings, ...items].sort((x, y) => new Date(x.when || 0) - new Date(y.when || 0));
  }, [realUpcoming, agenda]);

  // My Tasks = all open agenda items (Tasks + Compliance + Statutory).
  const openAgg = useMemo(() => {
    const open = agenda.filter((a) => a.status !== 'done');
    const byDue = (a, b) => {
      const da = a.due ? new Date(a.due).getTime() : Infinity;
      const db = b.due ? new Date(b.due).getTime() : Infinity;
      return da - db;
    };
    const byPrio = (a, b) => (PRIORITY[a.priority]?.rank ?? 2) - (PRIORITY[b.priority]?.rank ?? 2);
    return [...open].sort(prioritized ? (a, b) => byPrio(a, b) || byDue(a, b) : (a, b) => byDue(a, b) || byPrio(a, b));
  }, [agenda, prioritized]);
  // My Tasks card = current month only (undated kept) + search box. The full set
  // across all months opens via "See all tasks" → Statutory tracker Calendar.
  const myTasksList = useMemo(() => {
    const ym = todayKey().slice(0, 7);
    const q = taskQuery.trim().toLowerCase();
    return openAgg
      .filter((t) => !t.due || dayKeyOf(t.due).slice(0, 7) === ym)
      .filter((t) => !q || (t.title || '').toLowerCase().includes(q));
  }, [openAgg, taskQuery]);
  const nextTask = myTasksList[0] || null;

  const trendData = useMemo(() => monthly.map((m) => ({ label: m.label, runs: Number(m.jobs) || 0 })), [monthly]);
  const hasData = totalRuns > 0;

  // ── Drive mirror: real per-brand files first, topped up with representative
  // files so the workspace always feels populated (Google is connected). No
  // "sample" labelling — reads as one Drive. ──
  const driveShown = useMemo(() => {
    const seen = new Set((driveFiles || []).map((f) => (f.name || '').toLowerCase()));
    const extra = SAMPLE_DRIVE_FILES.filter((f) => !seen.has(f.name.toLowerCase()));
    return [...driveFiles, ...extra];
  }, [driveFiles]);
  const srcFiltered = useMemo(() => {
    const isImg = (m) => /image\//.test(m || '');
    const isVideo = (m) => /video\//.test(m || '');
    const isSheet = (m) => /(spreadsheet|excel|sheet|csv)/i.test(m || '');
    const isDoc = (m) => /(document|word|gdoc|text)/i.test(m || '');
    const isPdf = (m) => /pdf/i.test(m || '');
    let list = driveShown;
    if (srcTab === 'Images') list = driveShown.filter((f) => isImg(f.mimeType));
    else if (srcTab === 'Video') list = driveShown.filter((f) => isVideo(f.mimeType));
    else if (srcTab === 'Sheets') list = driveShown.filter((f) => isSheet(f.mimeType));
    else if (srcTab === 'Docs') list = driveShown.filter((f) => isDoc(f.mimeType));
    else if (srcTab === 'PDFs') list = driveShown.filter((f) => isPdf(f.mimeType));
    const q = srcQuery.trim().toLowerCase();
    return q ? list.filter((f) => (f.name || '').toLowerCase().includes(q)) : list;
  }, [driveShown, srcTab, srcQuery]);
  // Previously viewed = most recent files (real Drive recency; sample fallback).
  const recentFiles = useMemo(() => driveShown.filter((f) => !f.isFolder).slice(0, 5), [driveShown]);

  const prettySize = (b) => { if (b == null) return ''; if (b < 1024) return `${b} B`; if (b < 1048576) return `${Math.round(b / 1024)} KB`; return `${(b / 1048576).toFixed(1)} MB`; };
  const fmtTime = (str) => { if (!str) return ''; try { return new Date(str).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  const fmtClock = (str) => { if (!str) return ''; try { return new Date(str).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

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
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-slate-900" />
        </div>
      </DashboardLayout>
    );
  }

  const firstName = (user?.name || 'there').split(' ')[0];
  const tabBtn = (active) => ({
    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 9999,
    fontSize: 13, fontWeight: 700, cursor: 'pointer',
    background: active ? 'var(--text-heading)' : 'var(--surface)',
    color: active ? '#fff' : 'var(--text-heading)',
    border: `1px solid ${active ? 'var(--text-heading)' : 'var(--card-border)'}`,
    boxShadow: 'var(--card-shadow)',
  });
  const pillBtn = {
    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px', borderRadius: 9999,
    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', background: 'var(--surface)',
    color: 'var(--text-heading)', border: '1px solid var(--card-border)', boxShadow: 'var(--card-shadow)',
  };

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="brand-dashboard" style={{ maxWidth: 1320, margin: '0 auto', paddingBottom: 88 }}>

        {/* ── Hero: Welcome + How can I help you today? ─────────────────── */}
        <div className="glass-card" style={{ padding: '22px 24px', marginBottom: '16px', background: 'linear-gradient(120deg, #EEF3FF 0%, #FFFFFF 60%)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '14px' }}>
            <div>
              <button onClick={() => navigate('/brands')} data-testid="back-to-brands"
                style={{ fontSize: '12px', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: '8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                ← Back to Brands
              </button>
              <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: '28px', color: 'var(--text-heading)', lineHeight: 1.1 }}>
                Welcome, {firstName} <span style={{ fontWeight: 400 }}>👋</span>
              </h1>
              <div style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 700, fontSize: '18px', color: '#0748EE', marginTop: 3 }}>
                How can I help you today?
              </div>
              <p style={{ color: 'var(--text-muted)', marginTop: '6px', fontSize: '14px' }}>
                Here's what's happening with <strong style={{ color: 'var(--text-heading)' }}>{brand?.name}</strong>{brand?.description ? ` · ${brand.description}` : ''}.
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', position: 'relative' }}>
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

        {/* ── Tabs + quick pills ─────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <button style={tabBtn(true)} data-testid="tab-overview"><LayoutDashboard style={{ width: 15, height: 15 }} /> Overview</button>
          <button style={tabBtn(false)} onClick={() => navigate(`/brands/${brandId}/analysis`)} data-testid="tab-analysis"><BarChart3 style={{ width: 15, height: 15 }} /> Analysis</button>
          <div style={{ flex: 1, minWidth: 12 }} />
          <button style={pillBtn} onClick={() => navigate('/meetings')} data-testid="pill-summarize"><Video style={{ width: 15, height: 15, color: '#0748EE' }} /> Summarize last meeting</button>
          <button style={pillBtn} onClick={() => navigate('/integrations')} data-testid="pill-connect"><Plug style={{ width: 15, height: 15, color: '#0748EE' }} /> Connect apps</button>
        </div>

        {/* ── Row 1: Previously viewed files · Next Meeting ──────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '14px', marginBottom: '16px' }}>
          {/* Previously viewed files */}
          <Panel style={{ background: 'linear-gradient(135deg, #FFFBEB 0%, #FFFFFF 72%)' }}>
            <div style={{ ...SECTION_TITLE, justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><History style={{ width: 14, height: 14 }} /> Previously viewed files</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint, #94A0B8)' }}>From Drive · latest first</span>
            </div>
            {recentFiles.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 0' }}>Files you open appear here.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {recentFiles.map((f) => {
                  const t = fileTint(f.mimeType);
                  return (
                    <a key={`pv-${f.id}`} href={f.webViewLink || '#'} target="_blank" rel="noreferrer"
                      style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 10px', borderRadius: 10, textDecoration: 'none', transition: 'background .14s ease' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.8)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                      <span style={{ width: 30, height: 30, borderRadius: 9, background: t.bg, color: t.c, display: 'grid', placeItems: 'center', flexShrink: 0 }}><FileText style={{ width: 16, height: 16 }} /></span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      {f.size != null && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{prettySize(f.size)}</span>}
                    </a>
                  );
                })}
              </div>
            )}
          </Panel>

          {/* Next Meeting (with Summarize on top) */}
          <Panel>
            <div style={{ ...SECTION_TITLE, justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Video style={{ width: 14, height: 14 }} /> Next Meeting</span>
              <button onClick={() => navigate('/meetings')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: '#7C3AED', background: '#F5F3FF', border: '1px solid #DDD6FE', borderRadius: 9999, padding: '4px 10px', cursor: 'pointer' }}>
                <Sparkles style={{ width: 12, height: 12 }} /> Summarize
              </button>
            </div>
            {nextMeeting ? (
              <div onClick={() => setDetail({ ...nextMeeting, past: false })} style={{ cursor: 'pointer' }}>
                <div style={{ background: 'linear-gradient(135deg, #E8EFFE, #F5F8FF)', border: '1px solid #CFE0FF', borderRadius: 12, padding: '12px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#0748EE' }}>Upcoming · {/zoom/i.test(nextMeeting.joinLink || '') ? 'Zoom' : 'Google Meet'}</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-heading)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nextMeeting.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{fmtTime(nextMeeting.start)}</div>
                  {nextMeeting.joinLink && (
                    <a href={nextMeeting.joinLink} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                      style={{ marginTop: 9, display: 'inline-flex', alignItems: 'center', gap: 6, background: '#0748EE', color: '#fff', fontSize: 12, fontWeight: 700, borderRadius: 8, padding: '7px 12px', textDecoration: 'none' }}>
                      <Video style={{ width: 13, height: 13 }} /> Join now
                    </a>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0 10px' }}>
                <BrandLogo type="google_meet" size={30} />
                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No upcoming meeting. Recent recordings below.</div>
              </div>
            )}
            {recentMeetings.length > 0 && (
              <div style={{ marginTop: nextMeeting ? 12 : 0 }}>
                <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-faint, #94A0B8)', marginBottom: 6 }}>Recent (Fireflies)</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {recentMeetings.slice(0, nextMeeting ? 2 : 3).map((m) => (
                    <a key={m.id} href={m.url || '#'} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
                      <BrandLogo type="fireflies" size={20} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtTime(m.date)}{m.duration ? ` · ${Math.round(m.duration)} min` : ''}</div>
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </Panel>
        </div>

        {/* ── Row 2: Today · My Tasks ────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '14px', marginBottom: '16px' }}>
          {/* Today */}
          <Panel>
            <div style={{ ...SECTION_TITLE, justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><CalendarDays style={{ width: 14, height: 14 }} /> Today</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint, #94A0B8)' }}>Tasks · Tracker · Meetings</span>
            </div>
            <div style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: '19px', color: 'var(--text-heading)', marginBottom: 10 }}>
              {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
            </div>
            {todayItems.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '6px 0' }}>Nothing scheduled today. Enjoy the quiet 🌿</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {todayItems.slice(0, 6).map((it) => {
                  const src = SRC[it.source] || SRC.task;
                  return (
                    <div key={it.key} onClick={() => it.route && navigate(it.route)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border-soft, #EEF1F8)', cursor: it.route ? 'pointer' : 'default' }}>
                      <span style={{ width: 7, height: 7, borderRadius: 99, background: src.c, flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-heading)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
                      <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.03em', textTransform: 'uppercase', color: src.c, background: src.bg, padding: '2px 7px', borderRadius: 6 }}>{src.label}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-faint, #94A0B8)', whiteSpace: 'nowrap' }}>{it.source === 'meeting' ? fmtClock(it.when) : (it.due ? 'Due' : '')}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          {/* My Tasks (aggregated + Prioritize) */}
          <Panel style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ ...SECTION_TITLE, justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><CheckCircle2 style={{ width: 14, height: 14 }} /> My Tasks</span>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => setPrioritized((v) => !v)} title="Sort by priority"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700, color: prioritized ? '#fff' : '#7C3AED', background: prioritized ? '#7C3AED' : '#F5F3FF', border: '1px solid #DDD6FE', borderRadius: 9999, padding: '4px 10px', cursor: 'pointer' }}>
                  <Zap style={{ width: 12, height: 12 }} /> Prioritize
                </button>
                <button onClick={() => setShowNewTask(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, fontWeight: 700, color: '#0748EE', background: 'none', border: 'none', cursor: 'pointer' }}>
                  <Plus style={{ width: 14, height: 14 }} /> New task
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-2, #F8FAFF)', border: '1px solid var(--card-border)', borderRadius: 10, padding: '7px 11px', marginBottom: 10 }}>
              <Search style={{ width: 14, height: 14, color: '#94A3B8' }} />
              <input value={taskQuery} onChange={(e) => setTaskQuery(e.target.value)} placeholder="Search tasks…" style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 12.5, color: 'var(--text-heading)' }} />
            </div>
            {nextTask && (
              <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 10, padding: '10px 12px', marginBottom: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#0748EE', marginBottom: 3 }}>Up next</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading)' }}>{nextTask.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{(SRC[nextTask.source] || SRC.task).label}{nextTask.due ? ` · Due ${fmtDate(nextTask.due)}` : ''}</div>
              </div>
            )}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', maxHeight: 220 }}>
              {myTasksList.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>{taskQuery ? 'No tasks match your search.' : 'Nothing due this month. You’re all caught up.'}</div>
              ) : myTasksList.slice(0, 8).map((t) => {
                const st = TASK_STATUS[t.status] || TASK_STATUS.pending;
                const pr = PRIORITY[t.priority] || PRIORITY.medium;
                const src = SRC[t.source] || SRC.task;
                return (
                  <div key={t.key} onClick={() => navigate(t.route)} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '8px 0', borderTop: '1px solid var(--border-soft, #EEF1F8)' }}>
                    <span style={{ fontSize: 13, color: 'var(--text-heading)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                    <span style={{ fontSize: 9.5, fontWeight: 800, color: src.c, background: src.bg, padding: '2px 7px', borderRadius: 6, textTransform: 'uppercase' }}>{src.label}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: pr.c, background: pr.bg, padding: '1px 7px', borderRadius: 9999 }}>{pr.label}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: st.c, background: st.bg, padding: '1px 7px', borderRadius: 9999 }}>{st.label}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 14 }}>
              <button onClick={() => navigate(`/brands/${brandId}/statutory-compliance?view=calendar`)} style={{ fontSize: 13, fontWeight: 700, color: '#0748EE', background: 'none', border: 'none', cursor: 'pointer' }}>
                See all tasks →
              </button>
              <button onClick={() => navigate('/tasks')} style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
                Manage tasks
              </button>
            </div>
          </Panel>
        </div>

        {/* ── Sources to chat with — live per-brand Drive mirror ─────────── */}
        <Panel style={{ marginBottom: '16px' }}>
          <div style={{ ...SECTION_TITLE, justifyContent: 'space-between' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><BrandLogo type="google_drive" size={16} /> Sources to chat with</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{brand?.name} Drive · {driveShown.length} files</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-2, #F8FAFF)', border: '1px solid var(--card-border)', borderRadius: 12, padding: '9px 13px', marginBottom: 11 }}>
            <Search style={{ width: 15, height: 15, color: '#94A3B8' }} />
            <input value={srcQuery} onChange={(e) => setSrcQuery(e.target.value)} placeholder={`Search this brand's Drive…`} style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text-heading)' }} />
          </div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 12 }}>
            {['All', 'Sheets', 'Docs', 'PDFs', 'Video', 'Images'].map((t) => (
              <button key={t} onClick={() => setSrcTab(t)} style={{ fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 9999, cursor: 'pointer', background: srcTab === t ? 'var(--text-heading)' : 'var(--surface)', border: `1px solid ${srcTab === t ? 'var(--text-heading)' : 'var(--card-border)'}`, color: srcTab === t ? '#fff' : 'var(--text-muted)' }}>{t}</button>
            ))}
          </div>
          {srcFiltered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '22px 0', color: 'var(--text-muted)' }}>
              <FileText style={{ width: 30, height: 30, margin: '0 auto 8px', color: '#CBD5E1' }} />
              <div style={{ fontSize: 13 }}>No files in this category.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 300, overflowY: 'auto' }}>
              {srcFiltered.slice(0, 40).map((f) => {
                const t = fileTint(f.mimeType);
                return (
                  <div key={f.id} className="drive-row" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 8px', borderRadius: 10 }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2, #F8FAFF)'; const a = e.currentTarget.querySelector('.file-actions'); if (a) a.style.opacity = '1'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; const a = e.currentTarget.querySelector('.file-actions'); if (a) a.style.opacity = '0'; }}>
                    <span style={{ width: 28, height: 28, borderRadius: 8, background: f.isFolder ? '#EEF2F8' : t.bg, color: t.c, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                      {f.isFolder ? <BrandLogo type="google_drive" size={16} /> : <FileText style={{ width: 15, height: 15 }} />}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    {f.size != null && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{prettySize(f.size)}</span>}
                    <span className="file-actions" style={{ display: 'flex', gap: 6, opacity: 0, transition: 'opacity .14s ease' }}>
                      <a href={f.webViewLink || '#'} target="_blank" rel="noreferrer" title="Open in Drive"
                        style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid var(--card-border)', background: 'var(--surface)', display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
                        <ExternalLink style={{ width: 13, height: 13 }} />
                      </a>
                      <button onClick={() => navigate('/chat', { state: { prompt: `Tell me about the file "${f.name}"` } })} title="Ask Colonel AI about this file"
                        style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid #DDD6FE', background: 'var(--surface)', display: 'grid', placeItems: 'center', color: '#7C3AED', cursor: 'pointer' }}>
                        <Sparkles style={{ width: 13, height: 13 }} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        {/* ── Slim KPI strip (quick glance; full analytics in the Analysis tab) ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '12px', marginBottom: '8px' }}>
          <KpiCard icon={Activity} label="Total Runs"     value={fmtNum(totalRuns)}   color="#0748EE" bg="#E8EFFE" />
          <KpiCard icon={Rows3}    label="Rows Processed" value={fmtNum(totalRows)}   color="#7C3AED" bg="#F5F3FF" />
          <KpiCard icon={Clock}    label="Time Saved"     value={`≈ ${savedHrs} hrs`} color="#059669" bg="#ECFDF5" />
          <KpiCard icon={Bot}      label="Active Agents"  value={fmtNum(activeAgents || agents.length)} color="#EA580C" bg="#FFF7ED" />
        </div>
      </div>

      {/* ── Sticky bottom Ask Colonel AI bar (Overview) ──────────────────── */}
      <div style={{ position: 'sticky', bottom: 16, zIndex: 30, padding: '0 24px', maxWidth: 1320, margin: '0 auto', pointerEvents: 'none' }}>
        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 8px 8px 14px', borderRadius: 16, boxShadow: '0 -2px 10px rgba(16,24,64,.04), 0 12px 34px rgba(16,24,64,.14)', pointerEvents: 'auto' }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, #0748EE, #7C3AED)' }}>
            <Sparkles style={{ width: 16, height: 16, color: '#fff' }} />
          </span>
          <input value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && askAI()}
            placeholder="Ask Colonel AI anything — reconciliations, a Drive file, this brand's numbers…"
            style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 13.5, color: 'var(--text-heading)' }} />
          <button onClick={askAI} style={{ width: 34, height: 34, borderRadius: 10, border: 'none', background: '#0748EE', color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0 }}>
            <Send style={{ width: 16, height: 16 }} />
          </button>
        </div>
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

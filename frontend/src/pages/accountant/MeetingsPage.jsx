import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { sidebarFor } from '../../lib/adminNav';
import BrandLogo from '../../components/BrandLogos';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import MeetingDetailModal from '../../components/MeetingDetailModal';
import api from '../../lib/api';
import { toast } from 'sonner';
import {
  Video, Clock, CalendarDays, RefreshCw, Loader2, MoreHorizontal, CalendarPlus,
  Copy, ExternalLink, Sparkles, FileText, Plus, MapPin, Check, ChevronRight, Pin, X,
} from 'lucide-react';
import {
  initials, AV, D, fmtDate, fmtDateShort, fmtTimeRange, fmtFF, platformOf, platformName,
  daysLabel, hashStr, isPastOf, deriveType, statusOf, readProgress, persistProgress,
} from '../../lib/sampleCalendar';

/* ── small UI ─────────────────────────────────────────────────────────────── */
function Avatars({ people = [], size = 26 }) {
  const shown = people.slice(0, 4); const extra = people.length - shown.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {shown.map((p, i) => (
        <span key={i} title={p.email || p.name || p} style={{ width: size, height: size, borderRadius: '50%', background: AV[(hashStr(p.name || p.email || String(p)) + i) % AV.length], color: '#fff', fontSize: size * 0.38, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginLeft: i ? -8 : 0, border: '2px solid #fff' }}>
          {initials(p.name || p.email || p)}
        </span>
      ))}
      {extra > 0 && <span style={{ marginLeft: 7, fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>+{extra}</span>}
    </div>
  );
}
function Pill({ t, style }) {
  return <span style={{ fontSize: 11.5, fontWeight: 700, color: t.fg, background: t.bg, padding: '4px 11px', borderRadius: 9999, whiteSpace: 'nowrap', ...style }}>{t.label}</span>;
}

function CardMenu({ items }) {
  const [open, setOpen] = useState(false); const ref = React.useRef(null);
  useEffect(() => { const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; if (open) document.addEventListener('mousedown', fn); return () => document.removeEventListener('mousedown', fn); }, [open]);
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', padding: 4, borderRadius: 6, lineHeight: 0 }}><MoreHorizontal style={{ width: 18, height: 18 }} /></button>
      {open && (
        <div className="glass-card" style={{ position: 'absolute', right: 0, top: '112%', zIndex: 40, padding: 6, minWidth: 220 }}>
          {items.filter(Boolean).map((it, i) => (
            <button key={i} onClick={(e) => { e.stopPropagation(); it.onClick(); setOpen(false); }}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13, color: 'var(--text-heading)', textAlign: 'left' }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#F4F7FB'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
              <it.icon style={{ width: 15, height: 15, color: '#64748B', flexShrink: 0 }} /> {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Meeting card — Stratify (cmio) ─────────────────────────────────────────── */
function MeetingCard({ m, past, onOpen, onCopy, onSummary, onSummarize, onJoin, onAttendance }) {
  const type = deriveType(m.title);
  return (
    <div className="glass-card" style={{ padding: 20, cursor: 'pointer', display: 'flex', flexDirection: 'column', borderRadius: 16 }} onClick={() => onOpen(m, past)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <h3 style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--text-heading)', margin: 0, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{m.title}</h3>
        <CardMenu items={[
          { icon: ExternalLink, label: 'View full meeting details', onClick: () => onOpen(m, past) },
          m.joinLink && !past && { icon: Video, label: 'Join meeting', onClick: () => onJoin(m) },
          { icon: FileText, label: 'Summarize meeting', onClick: () => onSummarize(m) },
          { icon: Check, label: 'Indicate my attendance', onClick: () => onAttendance(m) },
          m.htmlLink && { icon: CalendarPlus, label: 'Add to the Calendar', onClick: () => window.open(m.htmlLink, '_blank') },
          { icon: Copy, label: 'Copy meeting details', onClick: () => onCopy(m) },
          past && { icon: Sparkles, label: 'Draft summary email', onClick: () => onSummary(m) },
        ]} />
      </div>
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)' }}><CalendarDays style={{ width: 14, height: 14, color: '#94A3B8' }} /> {fmtDate(m.start)}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)' }}><Clock style={{ width: 14, height: 14, color: '#94A3B8' }} /> {fmtTimeRange(m.start, m.end)}</span>
      </div>
      {m.attendees?.length > 0 && <div style={{ marginTop: 14 }}><Avatars people={m.attendees} /></div>}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--card-border)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: '#475569' }}>
          <BrandLogo type={platformOf(m.joinLink)} size={18} /> {platformName(m.joinLink)}
        </span>
        <Pill t={type} />
      </div>
    </div>
  );
}

/* ── Recording card (Fireflies, per-user) ───────────────────────────────────── */
function RecordingCard({ m, onSummary, onSummarize, onUnpin }) {
  return (
    <div className="glass-card" style={{ padding: 20, borderRadius: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <BrandLogo type="fireflies" size={22} />
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-heading)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</h3>
          {m.pinned && <span title="Manually added" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: '#7C3AED', background: '#EDE9FE', padding: '2px 7px', borderRadius: 9999 }}><Pin style={{ width: 10, height: 10 }} /> Pinned</span>}
        </div>
        <CardMenu items={[
          m.url && { icon: ExternalLink, label: 'Open in Fireflies', onClick: () => window.open(m.url, '_blank') },
          { icon: FileText, label: 'Summarize meeting', onClick: () => onSummarize(m) },
          { icon: Sparkles, label: 'Draft summary email', onClick: () => onSummary(m) },
          m.pinned && { icon: X, label: 'Remove from recordings', onClick: () => onUnpin(m) },
        ]} />
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock style={{ width: 14, height: 14 }} /> {fmtFF(m.date)}{m.duration ? ` · ${Math.round(m.duration)} min` : ''}</div>
      {m.attendees?.length > 0 && <div style={{ marginTop: 12 }}><Avatars people={m.attendees} /></div>}
      {m.summary && <p style={{ fontSize: 13, color: '#475569', marginTop: 10, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{m.summary}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button onClick={() => onSummarize(m)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: '#fff', background: '#0748EE', padding: '8px 14px', borderRadius: 10, border: 'none', cursor: 'pointer' }}><FileText style={{ width: 14, height: 14 }} /> Summarize meeting</button>
        <button onClick={() => onSummary(m)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: '#0748EE', background: '#EFF6FF', padding: '8px 14px', borderRadius: 10, border: 'none', cursor: 'pointer' }}><Sparkles style={{ width: 14, height: 14 }} /> Draft email</button>
      </div>
    </div>
  );
}

/* ── Event card — MeetCraft (cnnl) ──────────────────────────────────────────── */
function EventGradientCard({ m, onOpen, progress }) {
  const type = deriveType(m.title);
  return (
    <div onClick={() => onOpen(m, isPastOf(m))} style={{ cursor: 'pointer', borderRadius: 18, background: `linear-gradient(150deg, ${type.fg}14, ${type.fg}06)`, border: '1px solid rgba(15,23,42,0.06)', padding: 18, boxShadow: '0 1px 2px rgba(10,15,46,0.04)', transition: 'transform 0.2s, box-shadow 0.2s' }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 12px 30px rgba(10,15,46,0.12)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 1px 2px rgba(10,15,46,0.04)'; }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: type.fg, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{type.label}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: type.fg, background: '#fff', padding: '4px 10px', borderRadius: 9999, whiteSpace: 'nowrap' }}>{m.allDay ? 'All day' : daysLabel(m.start)}</span>
      </div>
      <h3 style={{ fontSize: 15.5, fontWeight: 800, color: '#0F172A', margin: '12px 0 4px', lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: 40 }}>{m.title}</h3>
      <div style={{ fontSize: 12, color: '#64748B', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <CalendarDays style={{ width: 12, height: 12 }} /> {m.allDay ? fmtDateShort(m.start) : `${fmtDateShort(m.start)} · ${fmtTimeRange(m.start, m.end)}`}
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: '#64748B', marginBottom: 5 }}><span style={{ fontWeight: 600 }}>Progress</span><span style={{ fontWeight: 700, color: type.fg }}>{progress}%</span></div>
        <div style={{ height: 7, borderRadius: 9999, background: 'rgba(15,23,42,0.08)', overflow: 'hidden' }}><div style={{ width: `${progress}%`, height: '100%', borderRadius: 9999, background: type.fg }} /></div>
      </div>
      {m.attendees?.length > 0 && <div style={{ marginTop: 14 }}><Avatars people={m.attendees} size={24} /></div>}
    </div>
  );
}

/* ── "Manage Events" table — MeetCraft lower section ────────────────────────── */
function ManageEventsTable({ active, completed, onOpen }) {
  const [sub, setSub] = useState('active');
  const rows = sub === 'active' ? active : completed;
  const th = { textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94A3B8', padding: '10px 14px' };
  const td = { fontSize: 13.5, color: 'var(--text-heading)', padding: '13px 14px', borderTop: '1px solid var(--card-border)', verticalAlign: 'middle' };
  return (
    <div className="glass-card" style={{ padding: 0, borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px' }}>
        <h3 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-heading)', margin: 0 }}>Manage Events</h3>
        <div style={{ display: 'inline-flex', gap: 4, background: '#EEF2F7', borderRadius: 10, padding: 3 }}>
          {[{ k: 'active', l: 'Active', n: active.length }, { k: 'completed', l: 'Completed', n: completed.length }].map((t) => (
            <button key={t.k} onClick={() => setSub(t.k)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, padding: '6px 13px', borderRadius: 8, border: 'none', cursor: 'pointer', background: sub === t.k ? '#fff' : 'transparent', color: sub === t.k ? 'var(--text-heading)' : 'var(--text-muted)', boxShadow: sub === t.k ? '0 1px 3px rgba(10,15,46,0.10)' : 'none' }}>
              {t.l}<span style={{ fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 9999, background: sub === t.k ? '#EEF2F7' : '#E2E8F0', color: '#64748B' }}>{t.n}</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead><tr style={{ background: '#F8FAFC' }}>
            <th style={th}>Event Name</th><th style={th}>Date</th><th style={th}>Type</th><th style={th}>Assignees</th><th style={th}>Status</th><th style={{ ...th, width: 40 }}></th>
          </tr></thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: 'var(--text-muted)', padding: '28px 14px' }}>No {sub} events.</td></tr>
            ) : rows.map((m) => {
              const type = deriveType(m.title); const st = statusOf(m);
              return (
                <tr key={m.id} onClick={() => onOpen(m, isPastOf(m))} style={{ cursor: 'pointer' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFC'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                  <td style={{ ...td, fontWeight: 600 }}>{m.title}</td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{fmtDateShort(m.start)}</td>
                  <td style={td}><Pill t={type} /></td>
                  <td style={td}>{m.attendees?.length > 0 ? <Avatars people={m.attendees} size={24} /> : <span style={{ color: '#CBD5E1' }}>—</span>}</td>
                  <td style={td}><Pill t={st} /></td>
                  <td style={td}><ChevronRight style={{ width: 16, height: 16, color: '#CBD5E1' }} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function MeetingsPage() {
  const navigate = useNavigate();
  const sidebarItems = sidebarFor([]);
  const [tab, setTab] = useState('upcoming');
  const [cal, setCal] = useState({ past: [], upcoming: [] });
  const [conn, setConn] = useState({ composio: true, calendar: false, drive: false });
  const [connecting, setConnecting] = useState(false);
  const [recordings, setRecordings] = useState([]);
  const [allDay, setAllDay] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [ne, setNe] = useState({ title: '', date: '', startTime: '10:00', endTime: '10:30', attendees: '', addMeet: true });
  const [neBusy, setNeBusy] = useState(false);
  const [progMap, setProgMap] = useState({});
  const [pinUrl, setPinUrl] = useState('');
  const [pinBusy, setPinBusy] = useState(false);

  const addRecording = async () => {
    const link = pinUrl.trim();
    if (!link || pinBusy) return;
    setPinBusy(true);
    try {
      const r = await api.post('/api/meetings/pin', { link });
      if (r.data?.resolved) toast.success(`Added "${r.data.title || 'meeting'}" to your recordings`);
      else toast.success('Added — it will appear once Fireflies finishes processing it');
      setPinUrl('');
      load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not add — check the Fireflies link'); }
    finally { setPinBusy(false); }
  };
  const unpin = async (m) => {
    try { await api.delete(`/api/meetings/pin/${m.id}`); toast.success('Removed from recordings'); load(); }
    catch { toast.error('Could not remove'); }
  };

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get('/api/meetings/calendar').then((r) => r.data || {}).catch(() => ({})),
      api.get('/api/meetings/recent').then((r) => r.data?.meetings || []).catch(() => []),
      api.get('/api/meetings/upcoming').then((r) => (r.data?.events || []).filter((e) => e.allDay)).catch(() => []),
      api.get('/api/meetings/connection').then((r) => r.data || {}).catch(() => ({})),
    ]).then(([c, rec, ad, cn]) => { setCal({ past: c.past || [], upcoming: c.upcoming || [] }); setRecordings(rec); setAllDay(ad); setConn({ composio: cn.composio !== false, calendar: !!cn.calendar, drive: !!cn.drive }); }).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Connect the logged-in user's OWN Google (via Composio's verified OAuth — no
  // "unverified app" warning). No brandId → the connection is per-user.
  const connectGoogle = async (slug = 'googlecalendar') => {
    setConnecting(true);
    try {
      const r = await api.post(`/api/composio/${slug}/connect`, {});
      if (r.data?.redirectUrl) { window.location.href = r.data.redirectUrl; return; }
      toast.error('Could not start Google connection'); setConnecting(false);
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not start Google connection'); setConnecting(false); }
  };

  const withMeet = (a) => a.filter((m) => m.joinLink);
  const noMeet = (a) => a.filter((m) => !m.joinLink);
  const allMeet = [...withMeet(cal.upcoming), ...withMeet(cal.past)];
  const mUpcoming = allMeet.filter((m) => !isPastOf(m)).sort((a, b) => (D(a.start) || 0) - (D(b.start) || 0));
  const mPast = allMeet.filter((m) => isPastOf(m)).sort((a, b) => (D(b.start) || 0) - (D(a.start) || 0));
  const allEvents = [...noMeet(cal.upcoming), ...allDay, ...noMeet(cal.past)];
  const evUpcoming = allEvents.filter((m) => !isPastOf(m)).sort((a, b) => (D(a.start) || 0) - (D(b.start) || 0));
  const evPast = allEvents.filter((m) => isPastOf(m)).sort((a, b) => (D(b.start) || 0) - (D(a.start) || 0));
  const meetingCount = mUpcoming.length + mPast.length;
  const eventCount = evUpcoming.length + evPast.length;

  const onOpen = (m, past) => setDetail({ ...m, past });
  const onCopy = (m) => navigator.clipboard?.writeText(`${m.title}\n${fmtDate(m.start)} ${fmtTimeRange(m.start, m.end)}${m.joinLink ? `\n${m.joinLink}` : ''}`).then(() => toast.success('Copied'), () => {});
  const onJoin = (m) => {
    if (!m.joinLink) return;
    window.open(m.joinLink, '_blank');
    api.post('/api/meetings/fireflies/join', { meetingLink: m.joinLink, title: m.title })
      .then((r) => { if (r.data?.ok) toast.success('Fireflies notetaker is joining to record this meeting'); })
      .catch(() => {});
  };
  const onAttendance = () => toast.success('Attendance noted');
  const onSummary = (m) => {
    let extra = ' Write a concise recap with key takeaways, decisions and action items.';
    if (m.summary) extra = ` Notes: ${m.summary}`;
    else if (m.transcript) extra = ` Base it on this transcript:\n\n${m.transcript}`;
    navigate('/chat', { state: { prompt: `Draft a short, professional Gmail summary email for the meeting "${m.title}".${extra} Ready to send to the team.` } });
  };
  const onSummarize = (m) => {
    const body = m.transcript ? `Here is the transcript:\n\n${m.transcript}` : (m.summary ? `Here are the notes:\n\n${m.summary}` : 'Write a concise recap with the likely key points, decisions and action items.');
    navigate('/chat', { state: { prompt: `Summarize the meeting "${m.title}" into a short, clear brief: key points, decisions, and action items (with owners if mentioned).\n\n${body}` } });
  };
  const readProg = (m) => readProgress(m, progMap);
  const onProgressChange = (id, v) => setProgMap((p) => ({ ...p, [id]: v }));

  const createEvent = async () => {
    if (!ne.title.trim() || !ne.date || neBusy) return;
    setNeBusy(true);
    try {
      await api.post('/api/meetings/event', { title: ne.title.trim(), start: `${ne.date}T${ne.startTime}:00`, end: `${ne.date}T${ne.endTime}:00`, attendees: ne.attendees.split(',').map((s) => s.trim()).filter(Boolean), addMeet: ne.addMeet });
      toast.success('Created & synced to your Google Calendar');
      setShowNew(false); setNe({ title: '', date: '', startTime: '10:00', endTime: '10:30', attendees: '', addMeet: true }); load();
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not create event'); }
    finally { setNeBusy(false); }
  };

  const TABS = [
    { key: 'upcoming', label: 'Meetings', count: meetingCount },
    { key: 'recordings', label: 'Recordings', count: recordings.length },
    { key: 'events', label: 'Events', count: eventCount },
  ];

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="meetings-page" style={{ maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
          <div>
            <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 26, color: 'var(--text-heading)', margin: 0 }}>Meetings</h1>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 4 }}>Your Google Calendar meetings, recordings and events — all in one place.</p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setShowNew(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, padding: '9px 15px', borderRadius: 12, background: '#0748EE', color: '#fff', border: 'none', cursor: 'pointer' }}><Plus style={{ width: 15, height: 15 }} /> New event</button>
            <button onClick={load} disabled={loading} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, padding: '9px 14px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)', cursor: 'pointer' }}>{loading ? <Loader2 className="animate-spin" style={{ width: 15, height: 15 }} /> : <RefreshCw style={{ width: 15, height: 15 }} />} Refresh</button>
          </div>
        </div>

        <div style={{ display: 'inline-flex', gap: 4, background: '#EEF2F7', borderRadius: 12, padding: 4, marginBottom: 22 }}>
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 9, border: 'none', cursor: 'pointer', background: tab === t.key ? '#fff' : 'transparent', color: tab === t.key ? 'var(--text-heading)' : 'var(--text-muted)', boxShadow: tab === t.key ? '0 1px 3px rgba(10,15,46,0.10)' : 'none' }}>
              {t.label}<span style={{ fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 9999, background: tab === t.key ? '#EEF2F7' : '#E2E8F0', color: '#64748B' }}>{t.count}</span>
            </button>
          ))}
        </div>

        {!loading && !conn.calendar && (tab === 'upcoming' || tab === 'events') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', marginBottom: 18, borderRadius: 14, border: '1px solid var(--card-border)', background: 'var(--surface)' }}>
            <div style={{ width: 40, height: 40, borderRadius: 11, background: '#E8EFFE', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <CalendarDays style={{ width: 20, height: 20, color: '#0748EE' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-heading)' }}>Connect your Google Calendar</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>Sign in with your own Google account to see your meetings &amp; events here — secured via Composio (no “unverified app” warning).</div>
            </div>
            <button onClick={() => connectGoogle('googlecalendar')} disabled={connecting} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, padding: '9px 16px', borderRadius: 11, background: '#0748EE', color: '#fff', border: 'none', cursor: connecting ? 'wait' : 'pointer', flexShrink: 0 }}>
              {connecting ? <Loader2 className="animate-spin" style={{ width: 15, height: 15 }} /> : <ExternalLink style={{ width: 15, height: 15 }} />} Connect Google
            </button>
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#94A3B8' }}><Loader2 className="animate-spin" style={{ width: 28, height: 28, margin: '0 auto 12px' }} /><div>Loading meetings…</div></div>
        ) : (
          <>
            {tab === 'upcoming' && (
              meetingCount === 0 ? (
                <Empty icon={Video} title="No meetings yet" sub="Calendar events with a Meet/Zoom link show here. Create one with “New event” (enable a Meet link)." />
              ) : (
                <>
                  {mUpcoming.length > 0 && (<><SectionLabel>Upcoming</SectionLabel><Grid min={420}>{mUpcoming.map((m) => <MeetingCard key={m.id} m={m} past={false} onOpen={onOpen} onCopy={onCopy} onSummary={onSummary} onSummarize={onSummarize} onJoin={onJoin} onAttendance={onAttendance} />)}</Grid></>)}
                  {mPast.length > 0 && (<><SectionLabel style={{ marginTop: 26 }}>Past</SectionLabel><Grid min={420}>{mPast.map((m) => <MeetingCard key={m.id} m={m} past onOpen={onOpen} onCopy={onCopy} onSummary={onSummary} onSummarize={onSummarize} onJoin={onJoin} onAttendance={onAttendance} />)}</Grid></>)}
                </>
              )
            )}

            {tab === 'recordings' && (
              <>
                {/* Add a meeting Fireflies didn't tag you in, by pasting its link */}
                <div className="glass-card" style={{ padding: 14, borderRadius: 14, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, color: 'var(--text-heading)' }}><Pin style={{ width: 15, height: 15, color: '#7C3AED' }} /> Add a recording</span>
                  <input value={pinUrl} onChange={(e) => setPinUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addRecording()} placeholder="Paste a Fireflies meeting link (app.fireflies.ai/view/…)" style={{ flex: 1, minWidth: 220, fontSize: 13, borderRadius: 10, border: '1px solid var(--card-border)', padding: '9px 12px', outline: 'none', color: 'var(--text-heading)', background: 'var(--surface)' }} />
                  <button onClick={addRecording} disabled={!pinUrl.trim() || pinBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, padding: '9px 15px', borderRadius: 10, background: (!pinUrl.trim() || pinBusy) ? '#94A3B8' : '#0748EE', color: '#fff', border: 'none', cursor: 'pointer' }}>{pinBusy ? <Loader2 className="animate-spin" style={{ width: 15, height: 15 }} /> : <Plus style={{ width: 15, height: 15 }} />} Add</button>
                </div>
                {recordings.length === 0 ? (
                  <Empty icon={FileText} title="No recordings for you yet" sub="Fireflies records the whole workspace under team@colonel.co.in — meetings where you were tagged (by name/email) show automatically. If one is missing, paste its Fireflies link above to add it." />
                ) : (
                  <Grid min={360}>{recordings.map((m) => <RecordingCard key={m.id} m={m} onSummary={onSummary} onSummarize={onSummarize} onUnpin={unpin} />)}</Grid>
                )}
              </>
            )}

            {tab === 'events' && (
              eventCount === 0 ? (
                <Empty icon={CalendarDays} title="No events" sub="Calendar entries without a meeting link (appointments, bookings, all-day items) appear here." />
              ) : (
                <>
                  {evUpcoming.length > 0 && (<><SectionLabel>Upcoming Events</SectionLabel><Grid min={240} style={{ marginBottom: 28 }}>{evUpcoming.map((m) => <EventGradientCard key={m.id} m={m} onOpen={onOpen} progress={readProg(m)} />)}</Grid></>)}
                  <ManageEventsTable active={evUpcoming} completed={evPast} onOpen={onOpen} />
                </>
              )
            )}
          </>
        )}
      </div>

      <MeetingDetailModal detail={detail} onClose={() => setDetail(null)} onProgressChange={onProgressChange} />

      {/* New event */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="max-w-md" onClose={() => setShowNew(false)}>
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-slate-900">New event</DialogTitle>
            <p className="text-sm text-slate-500 mt-1">Creates the event on your connected Google Calendar (and a Meet link if enabled → it shows under Meetings).</p>
          </DialogHeader>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
            <Field label="Title *"><input value={ne.title} onChange={(e) => setNe({ ...ne, title: e.target.value })} placeholder="e.g. Koparo reco review" style={inp} /></Field>
            <Field label="Date *"><input type="date" value={ne.date} onChange={(e) => setNe({ ...ne, date: e.target.value })} style={inp} /></Field>
            <div style={{ display: 'flex', gap: 10 }}>
              <Field label="Start"><input type="time" value={ne.startTime} onChange={(e) => setNe({ ...ne, startTime: e.target.value })} style={inp} /></Field>
              <Field label="End"><input type="time" value={ne.endTime} onChange={(e) => setNe({ ...ne, endTime: e.target.value })} style={inp} /></Field>
            </div>
            <Field label="Guests (comma-separated emails)"><input value={ne.attendees} onChange={(e) => setNe({ ...ne, attendees: e.target.value })} placeholder="a@x.com, b@y.com" style={inp} /></Field>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#334155', cursor: 'pointer' }}><input type="checkbox" checked={ne.addMeet} onChange={(e) => setNe({ ...ne, addMeet: e.target.checked })} /> Add a Google Meet link (makes it a Meeting)</label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => setShowNew(false)} style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid #E2E8F0', background: '#fff', color: '#334155', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={createEvent} disabled={!ne.title.trim() || !ne.date || neBusy} style={{ padding: '9px 18px', borderRadius: 10, border: 'none', background: (!ne.title.trim() || !ne.date || neBusy) ? '#94A3B8' : '#0748EE', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>{neBusy ? 'Creating…' : 'Create & sync'}</button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

const inp = { width: '100%', marginTop: 5, fontSize: 14, borderRadius: 10, border: '1px solid #E2E8F0', padding: '9px 12px', outline: 'none', color: '#334155' };
function Field({ label, children }) { return (<div style={{ flex: 1 }}><label style={{ fontSize: 12, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</label>{children}</div>); }
function Grid({ children, min = 320, style }) { return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: 16, ...style }}>{children}</div>; }
function SectionLabel({ children, style }) { return <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 12, ...style }}>{children}</div>; }
function Empty({ icon: Icon, title, sub }) { return (<div className="glass-card" style={{ textAlign: 'center', padding: '54px 24px' }}><Icon style={{ width: 30, height: 30, color: '#CBD5E1', margin: '0 auto 12px' }} /><div style={{ fontWeight: 700, color: 'var(--text-heading)' }}>{title}</div><div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>{sub}</div></div>); }

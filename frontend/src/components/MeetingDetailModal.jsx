import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/modal';
import BrandLogo from './BrandLogos';
import api from '../lib/api';
import { toast } from 'sonner';
import { Clock, CalendarDays, Copy, ExternalLink, Sparkles, MapPin, Users, Check, FileText } from 'lucide-react';
import {
  initials, AV, hashStr, fmtDate, fmtTimeRange, platformOf, platformName,
  deriveType, readProgress, persistProgress,
} from '../lib/sampleCalendar';

/* Small local UI (kept here so the modal is fully self-contained). */
function Avatars({ people = [], size = 30 }) {
  const shown = people.slice(0, 5); const extra = people.length - shown.length;
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
function EventProgressEditor({ initial, fg, onSave }) {
  const [v, setV] = useState(initial);
  useEffect(() => { setV(initial); }, [initial]);
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748B', marginBottom: 10 }}>Progress</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <input type="range" min={0} max={100} step={5} value={v} onChange={(e) => { const n = Number(e.target.value); setV(n); onSave(n); }} style={{ flex: 1, accentColor: fg, cursor: 'pointer' }} />
        <span style={{ fontSize: 15, fontWeight: 800, color: fg, minWidth: 46, textAlign: 'right' }}>{v}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 9999, background: 'rgba(15,23,42,0.08)', marginTop: 8, overflow: 'hidden' }}><div style={{ width: `${v}%`, height: '100%', background: fg, borderRadius: 9999, transition: 'width 0.15s' }} /></div>
      <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 8 }}>Drag to set how far along this event is — saved automatically.</div>
    </div>
  );
}

/* Shared rich meeting/event detail popup — used by the Meetings page AND the
   accountant Dashboard. Self-contained: handles Join (+ Fireflies notetaker),
   Summarize / Draft-email (Colonel AI), Copy, and editable event progress. */
export default function MeetingDetailModal({ detail, onClose, onProgressChange }) {
  const navigate = useNavigate();
  if (!detail) return null;
  const type = deriveType(detail.title);
  const isMeeting = !!detail.joinLink;
  const past = typeof detail.past === 'boolean' ? detail.past : false;

  const onJoin = () => {
    if (!detail.joinLink) return;
    window.open(detail.joinLink, '_blank');
    api.post('/api/meetings/fireflies/join', { meetingLink: detail.joinLink, title: detail.title })
      .then((r) => { if (r.data?.ok) toast.success('Fireflies notetaker is joining to record this meeting'); })
      .catch(() => {});
  };
  const onCopy = () => navigator.clipboard?.writeText(`${detail.title}\n${fmtDate(detail.start)} ${fmtTimeRange(detail.start, detail.end)}${detail.joinLink ? `\n${detail.joinLink}` : ''}`).then(() => toast.success('Copied'), () => {});
  const onSummarize = () => {
    const body = detail.transcript
      ? `Here is the transcript:\n\n${detail.transcript}`
      : (detail.summary ? `Here are the notes:\n\n${detail.summary}` : 'Write a concise recap with the likely key points, decisions and action items.');
    navigate('/chat', { state: { prompt: `Summarize the meeting "${detail.title}" into a short, clear brief: key points, decisions, and action items (with owners if mentioned).\n\n${body}` } });
  };
  const onDraftEmail = () => {
    let extra = ' Write a concise recap with key takeaways, decisions and action items.';
    if (detail.summary) extra = ` Notes: ${detail.summary}`;
    else if (detail.transcript) extra = ` Base it on this transcript:\n\n${detail.transcript}`;
    navigate('/chat', { state: { prompt: `Draft a short, professional Gmail summary email for the meeting "${detail.title}".${extra} Ready to send to the team.` } });
  };
  const saveProg = (v) => { const n = persistProgress(detail.id, v); if (onProgressChange) onProgressChange(detail.id, n); };

  return (
    <Dialog open={!!detail} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" onClose={onClose}>
        <DialogHeader>
          <div style={{ marginBottom: 8 }}><Pill t={type} /></div>
          <DialogTitle className="text-xl font-bold text-slate-900" style={{ paddingRight: 24 }}>{detail.title}</DialogTitle>
          <div className="text-sm text-slate-500 mt-2" style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><CalendarDays style={{ width: 14, height: 14 }} /> {fmtDate(detail.start)}</span>
            {!detail.allDay && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Clock style={{ width: 14, height: 14 }} /> {fmtTimeRange(detail.start, detail.end)}</span>}
            {isMeeting && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><BrandLogo type={platformOf(detail.joinLink)} size={15} /> {platformName(detail.joinLink)}</span>}
            {!isMeeting && detail.location && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><MapPin style={{ width: 14, height: 14 }} /> {detail.location}</span>}
          </div>
        </DialogHeader>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 8 }}>
          {isMeeting && !past && (
            <button onClick={onJoin} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#059669', color: '#fff', fontSize: 14, fontWeight: 700, borderRadius: 10, padding: '11px', border: 'none', cursor: 'pointer' }}><BrandLogo type={platformOf(detail.joinLink)} size={18} /> Join {platformName(detail.joinLink)}</button>
          )}

          {!isMeeting && (
            <EventProgressEditor initial={readProgress(detail)} fg={type.fg} onSave={saveProg} />
          )}

          {detail.description && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748B', marginBottom: 6 }}>{/agenda|checklist/i.test(detail.description) ? 'Agenda' : 'Details'}</div>
              <div style={{ fontSize: 13, color: '#334155', whiteSpace: 'pre-wrap', lineHeight: 1.55, maxHeight: 170, overflowY: 'auto' }}>{detail.description}</div>
            </div>
          )}
          {!detail.description && detail.summary && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748B', marginBottom: 6 }}>Summary</div>
              <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.55 }}>{detail.summary}</div>
            </div>
          )}

          {detail.attendees?.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#64748B', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}><Users style={{ width: 13, height: 13 }} /> {isMeeting ? 'Participants' : 'Assignees'} ({detail.attendees.length})</div>
              <div style={{ marginBottom: 10 }}><Avatars people={detail.attendees} size={30} /></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>{detail.attendees.map((a, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span style={{ width: 26, height: 26, borderRadius: '50%', background: AV[(hashStr(a.name || a.email || '') + i) % AV.length], color: '#fff', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{initials(a.name || a.email)}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>{a.name || a.email}</div>
                    {a.name && a.email && <div style={{ fontSize: 11.5, color: '#94A3B8', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.email}</div>}
                  </div>
                  {a.status === 'accepted' && <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: '#059669' }}><Check style={{ width: 12, height: 12 }} /> Going</span>}
                </div>
              ))}</div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {isMeeting && <button onClick={onSummarize} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: '#fff', background: '#0748EE', padding: '8px 14px', borderRadius: 10, border: 'none', cursor: 'pointer' }}><FileText style={{ width: 14, height: 14 }} /> Summarize meeting</button>}
            {(past || isMeeting) && <button onClick={onDraftEmail} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: '#0748EE', background: '#EFF6FF', padding: '8px 14px', borderRadius: 10, border: 'none', cursor: 'pointer' }}><Sparkles style={{ width: 14, height: 14 }} /> Draft summary email</button>}
            {detail.htmlLink && <a href={detail.htmlLink} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#334155', border: '1px solid #E2E8F0', padding: '8px 14px', borderRadius: 10, textDecoration: 'none' }}>Open in Calendar <ExternalLink style={{ width: 13, height: 13 }} /></a>}
            <button onClick={onCopy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#334155', border: '1px solid #E2E8F0', padding: '8px 14px', borderRadius: 10, background: '#fff', cursor: 'pointer' }}><Copy style={{ width: 13, height: 13 }} /> Copy details</button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

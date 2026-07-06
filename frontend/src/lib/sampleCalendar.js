/* sampleCalendar.js
 * Shared calendar helpers + demo data used by BOTH the Meetings page and the
 * accountant Dashboard, so they show the same events/meetings and format dates
 * identically. Pure JS (no JSX) — safe to import anywhere.
 */

/* ── formatting / small helpers ─────────────────────────────────────────────── */
export const initials = (s = '') => s.trim().split(/[\s@.]+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
export const AV = ['#0748EE', '#7C3AED', '#059669', '#EA580C', '#0F766E', '#E11D48'];
export const D = (iso) => { try { return new Date(iso); } catch { return null; } };
export const fmtDate = (iso) => { const d = D(iso); return d ? d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
export const fmtDateShort = (iso) => { const d = D(iso); return d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
export const fmtTimeRange = (s, e) => {
  const ds = D(s); if (!ds) return '';
  const opt = { hour: 'numeric', minute: '2-digit', hour12: true };
  const de = D(e);
  return de ? `${ds.toLocaleTimeString('en-IN', opt)} – ${de.toLocaleTimeString('en-IN', opt)}` : ds.toLocaleTimeString('en-IN', opt);
};
export const fmtFF = (ms) => { if (!ms) return ''; try { return new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }); } catch { return ''; } };
export const platformOf = (link) => (/zoom/i.test(link || '') ? 'zoom' : 'google_meet');
export const platformName = (link) => (/zoom/i.test(link || '') ? 'Zoom' : 'Google Meet');
export const daysLabel = (iso) => {
  const d = D(iso); if (!d) return '';
  const days = Math.round((d - new Date()) / (864e5));
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1) return `in ${days} days`;
  if (days === -1) return 'Yesterday';
  return `${Math.abs(days)} days ago`;
};
export const hashStr = (s = '') => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
export const isPastOf = (m) => (typeof m.isPast === 'boolean' ? m.isPast : (D(m.start) ? D(m.start) < new Date() : false));

/* ── category (auto) → colored pill + event type ────────────────────────────── */
export const TYPE_STYLES = {
  gst:         { label: 'GST',         fg: '#B45309', bg: '#FEF3C7' },
  reco:        { label: 'Reco Review', fg: '#1D4ED8', bg: '#DBEAFE' },
  filing:      { label: 'Filing',      fg: '#BE185D', bg: '#FCE7F3' },
  onboarding:  { label: 'Onboarding',  fg: '#047857', bg: '#D1FAE5' },
  review:      { label: 'Review',      fg: '#6D28D9', bg: '#EDE9FE' },
  sync:        { label: 'Sync',        fg: '#7C3AED', bg: '#EDE9FE' },
  celebration: { label: 'Celebration', fg: '#DB2777', bg: '#FCE7F3' },
  general:     { label: 'Meeting',     fg: '#475569', bg: '#F1F5F9' },
};
export const deriveType = (title = '') => {
  const t = title.toLowerCase();
  if (/gst|3b|2b|gstr|tds|itc/.test(t)) return TYPE_STYLES.gst;
  if (/reco|reconc/.test(t)) return TYPE_STYLES.reco;
  if (/fil(e|ing)|roc|mca|return|payment|26q/.test(t)) return TYPE_STYLES.filing;
  if (/onboard|kickoff|kick-off/.test(t)) return TYPE_STYLES.onboarding;
  if (/review|board|quarter|\bq[1-4]\b|mis|executive/.test(t)) return TYPE_STYLES.review;
  if (/sync|standup|stand-up|weekly|catch|1[- ]?on[- ]?1/.test(t)) return TYPE_STYLES.sync;
  if (/birthday|anniversary|party|celebrat|holiday/.test(t)) return TYPE_STYLES.celebration;
  return TYPE_STYLES.general;
};

/* Synthesized progress default until an accountant sets a real value. */
export const progFallback = (m) => {
  if (isPastOf(m)) return 100;
  const att = m.attendees || [];
  const acc = att.filter((a) => a.status === 'accepted').length;
  if (att.length && acc) return Math.min(96, Math.round((100 * acc) / att.length));
  const d = D(m.start); if (!d) return 45;
  const days = Math.max(0, Math.round((d - new Date()) / 864e5));
  return Math.min(94, Math.max(22, 88 - days * 4));
};
export const statusOf = (m) => {
  if (isPastOf(m)) return { label: 'Done', fg: '#047857', bg: '#D1FAE5' };
  const d = D(m.start); const days = d ? Math.round((d - new Date()) / 864e5) : 99;
  if (days < 0) return { label: 'Overdue', fg: '#B91C1C', bg: '#FEE2E2' };
  if (days <= 2) return { label: 'Due soon', fg: '#B45309', bg: '#FEF3C7' };
  return { label: 'On track', fg: '#1D4ED8', bg: '#DBEAFE' };
};

/* localStorage-backed, accountant-editable event progress. */
export const readProgress = (m, override) => {
  if (override && override[m.id] != null) return override[m.id];
  try { const v = localStorage.getItem('evt_progress_' + m.id); if (v != null) return Number(v); } catch (_) {}
  return progFallback(m);
};
export const persistProgress = (id, v) => { const n = Math.max(0, Math.min(100, Math.round(v))); try { localStorage.setItem('evt_progress_' + id, String(n)); } catch (_) {} return n; };

/* ── demo data ───────────────────────────────────────────────────────────────── */
const relIso = (days, h = 11, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString(); };

/* Events = calendar entries WITHOUT a video link. */
export const SAMPLE_EVENTS = [
  { id: 'smpl-1', title: 'GSTR-3B filing — Koparo', start: relIso(1, 11, 0), end: relIso(1, 11, 30), attendees: [{ name: 'Jayesh' }, { name: 'Priya' }, { name: 'Rahul' }], description: 'Checklist\n• Confirm ITC eligible for the month\n• Cross-check with the 2B vs Books output\n• File 3B on the portal & save the challan', sample: true },
  { id: 'smpl-2', title: 'TDS payment (26Q)', start: relIso(3, 15, 0), end: relIso(3, 15, 30), attendees: [{ name: 'Varshita' }, { name: 'Amjad' }], description: 'Deposit Q1 TDS (26Q) and keep the challan for the return.', sample: true },
  { id: 'smpl-3', title: 'ROC annual filing — MCA', start: relIso(6, 12, 0), end: relIso(6, 13, 0), attendees: [{ name: 'Kunal' }, { name: 'Riya' }, { name: 'Shrikant' }], description: 'Prepare AOC-4 / MGT-7 documents for MCA filing.', sample: true },
  { id: 'smpl-4', title: 'Board review — Q1 FY27', start: relIso(9, 16, 0), end: relIso(9, 17, 0), attendees: [{ name: 'Dhaval' }, { name: 'Manisha' }], description: 'Quarterly board review — P&L, cash position and brand-wise MIS.', sample: true },
  { id: 'smpl-5', title: 'Client onboarding — Amama', start: relIso(13, 10, 0), end: relIso(13, 11, 0), attendees: [{ name: 'Prashant' }, { name: 'Akshat' }], description: 'Kick off Amama onboarding — data access and first reco cycle plan.', sample: true },
  { id: 'smpl-6', title: 'GSTR-1 filing — Stroom', start: relIso(-4, 11, 0), end: relIso(-4, 11, 30), attendees: [{ name: 'Shrikant' }], description: 'Filed GSTR-1 outward supplies for Stroom.', sample: true },
  { id: 'smpl-7', title: 'Bank reco — Nestroots', start: relIso(-9, 15, 0), end: relIso(-9, 16, 0), attendees: [{ name: 'Riya' }, { name: 'Prashant' }], description: 'Completed June bank statement reco for Nestroots.', sample: true },
];

/* Meetings = calendar entries WITH a Meet/Zoom link. Each carries a transcript
   so "Summarize meeting" produces a real summary. */
export const SAMPLE_MEETINGS = [
  { id: 'mtg-1', title: 'Stroom × Colonel — Monthly GST Review', start: relIso(0, 15, 0), end: relIso(0, 15, 45),
    joinLink: 'https://meet.google.com/lookup/stroom-gst-review',
    attendees: [{ name: 'Shrikant Rao', email: 'shrikant.colonel@gmail.com', status: 'accepted' }, { name: 'Akshat Jain', email: 'akshat.colonel@gmail.com', status: 'accepted' }, { name: 'Dhaval Chauhan', email: 'chauhandhaval932@gmail.com' }],
    description: 'Agenda\n• Walk through June GSTR-2B vs Books mismatches\n• Finalise the ITC to claim for the month\n• Sign-off on the reconciled output before filing',
    transcript: 'Shrikant: We have 42 invoices where 2B and Books don’t match this month.\nDhaval: How many are timing differences versus real mismatches?\nShrikant: About 30 are timing — vendors uploaded late. 12 are tax-value mismatches.\nAkshat: For the 12, I’ll raise them with the vendors and hold that ITC.\nDhaval: Good. Claim ITC only on the matched + timing ones. We finalise and file by the 18th.\nShrikant: Agreed. I’ll share the signed-off reco sheet by tomorrow EOD.', sample: true },
  { id: 'mtg-2', title: 'M Brands — MIS Walkthrough', start: relIso(1, 11, 30), end: relIso(1, 12, 30),
    joinLink: 'https://us02web.zoom.us/j/8891234567',
    attendees: [{ name: 'Varshita Rao', email: 'varshita.colonel@gmail.com', status: 'accepted' }, { name: 'Priya Sharma', email: 'priya@colonel.co.in' }, { name: 'Rahul Verma', email: 'rahul@colonel.co.in', status: 'accepted' }],
    description: 'Monthly MIS review for M Brands — revenue, marketplace settlements and ad-spend variance vs last month.',
    transcript: 'Varshita: Revenue is up 14% MoM, mostly from Amazon.\nRahul: Ad spend also rose — ACOS went from 18% to 22%.\nPriya: Settlements from Flipkart are delayed by a week again.\nVarshita: Let’s flag the Flipkart delay to the client and tighten ad spend next month.', sample: true },
  { id: 'mtg-3', title: 'Nestroots — Onboarding Kickoff', start: relIso(2, 10, 0), end: relIso(2, 11, 0),
    joinLink: 'https://meet.google.com/lookup/nestroots-kickoff',
    attendees: [{ name: 'Chhavi', email: 'chhavi@nestroots.com', status: 'accepted' }, { name: 'Shekhar Godiyal', email: 'shekhar.godiyal@nestroots.com' }, { name: 'Riya', email: 'riya.colonel@gmail.com', status: 'accepted' }],
    description: 'Kickoff\n• Introductions & scope of work\n• Data access — Tally, bank statements, GST portal\n• Timeline for the first reconciliation cycle',
    transcript: 'Riya: Welcome! We’ll handle GST reco, bank reco and monthly MIS for Nestroots.\nChhavi: Great. We’ll share Tally access and bank statements today.\nShekhar: GST portal credentials will come from our side by Friday.\nRiya: Perfect — first reco cycle target is the last week of the month.', sample: true },
  { id: 'mtg-4', title: 'Weekly Team Sync', start: relIso(-3, 17, 0), end: relIso(-3, 17, 30),
    joinLink: 'https://meet.google.com/lookup/colonel-weekly',
    attendees: [{ name: 'Ankit', email: 'ankit@colonel.co.in', status: 'accepted' }, { name: 'Anshul', email: 'anshul@colonel.co.in', status: 'accepted' }, { name: 'Musadiq', email: 'musadiq.colonel@gmail.com' }],
    description: 'Weekly team sync — brand statuses, blockers and priorities for the week.',
    summary: 'Reviewed brand statuses and set filing priorities for the week ahead.',
    transcript: 'Ankit: Koparo and Stroom recos are done; Nestroots starts this week.\nAnshul: Two brands are blocked on client data — chasing today.\nMusadiq: I’ll prioritise the GST filings due before the 20th.\nAnkit: Good — let’s clear the blockers first, then filings.', sample: true },
];

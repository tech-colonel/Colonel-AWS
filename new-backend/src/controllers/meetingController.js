/**
 * meetingController.js
 *
 * Two read-only meeting feeds for the accountant dashboard + My Meetings page:
 *   - GET /api/meetings/upcoming  → Google Calendar (next events)
 *   - GET /api/meetings/recent    → Fireflies (past meetings + AI summary)
 *
 * Both reuse the EXISTING Google service account + the stored Fireflies key.
 * Everything degrades gracefully ({ configured:false }) when the credential
 * isn't present — so locally (where the live integration is NOT configured;
 * it lives on AWS) the dashboard simply shows its empty state instead of 500.
 *
 * Calendar access model: share a Google Calendar with the service-account email
 * (colonel-drive@…) and set GOOGLE_CALENDAR_ID — no OAuth handshake required.
 */

const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const { getGoogleClient } = require('../services/googleClient');
const composio = require('../services/composioClient');
const { masterSequelize } = require('../config/database');

// Google Calendar / Drive are accessed PER-USER through Composio's verified
// OAuth app (no "unverified app" warning). The Composio entity = the app user id.
const CAL_TOOLKIT = 'googlecalendar';
const DRIVE_TOOLKIT = 'googledrive';
/* Pull raw Google-Calendar events for a user THROUGH Composio. Returns
   Google events.list-shaped items so dedupeRecurring/mapEvent work unchanged. */
const listUserCalendarEvents = async (userId, { timeMin, timeMax, maxResults = 50 }) => {
  const r = await composio.executeTool(userId, 'GOOGLECALENDAR_EVENTS_LIST', {
    calendarId: 'primary', timeMin, timeMax, maxResults, singleEvents: true, orderBy: 'startTime',
  });
  if (r && r.successful === false) throw new Error(typeof r.error === 'string' ? r.error : 'Composio calendar error');
  const d = (r && r.data) || r || {};
  return d.items || d.events || (d.data && (d.data.items || d.data.events)) || [];
};
const { QueryTypes } = require('sequelize');

const FIREFLIES_API = 'https://api.fireflies.ai/graphql';

// ── Manually-pinned recordings ──────────────────────────────────────────────
// Some meetings (esp. team@colonel bot recordings) don't list the user by name,
// so name-matching can't catch them. A user can PIN such a meeting by its
// Fireflies link so it always shows in their Recordings.
let _pinsReady = false;
const ensureMeetingPins = async () => {
  if (_pinsReady) return;
  await masterSequelize.query(`CREATE TABLE IF NOT EXISTS meeting_pins (
    user_id       TEXT NOT NULL,
    transcript_id TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, transcript_id)
  )`);
  _pinsReady = true;
};
// Pull the transcript id out of a Fireflies link or a raw id.
// e.g. https://app.fireflies.ai/view/Tech-discussion::01KWF3N9NZ2RH47HPWJMPCBBP5
const extractTranscriptId = (input) => {
  const s = String(input || '').trim();
  if (!s) return '';
  if (s.includes('::')) return s.split('::').pop().split(/[?#/]/)[0].trim();
  if (s.includes('/view/')) return s.split('/view/').pop().split(/[?#/]/)[0].trim();
  return s.split(/[?#/]/)[0].trim();
};
// Fetch one transcript by id (used for pinned meetings not in the recent 50).
const fetchTranscriptById = async (key, id) => {
  const query = `query($id: String!) { transcript(id: $id) {
    id title date duration transcript_url
    meeting_attendees { email displayName name }
    summary { overview action_items }
  } }`;
  try {
    const r = await fetch(FIREFLIES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, variables: { id } }),
    });
    const j = await r.json().catch(() => ({}));
    return j?.data?.transcript || null;
  } catch (_) { return null; }
};

const CREDENTIALS_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : path.join(__dirname, '../../config/google-credentials.json');

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || null;

// Recurring events (birthdays, weekly syncs) expand into many instances with
// singleEvents:true — collapse them to one card per series (recurringEventId).
const dedupeRecurring = (items) => {
  const seen = new Set(); const out = [];
  for (const e of items || []) {
    const k = e.recurringEventId || e.id;
    if (seen.has(k)) continue;
    seen.add(k); out.push(e);
  }
  return out;
};

// Service-account calendar (fallback only — used when a shared calendar id is
// set but Google OAuth isn't connected).
let _cal = null;
function getServiceCalendar() {
  if (_cal) return _cal;
  if (!fs.existsSync(CREDENTIALS_PATH)) return null;
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  _cal = google.calendar({ version: 'v3', auth });
  return _cal;
}

/** GET /api/meetings/upcoming — next Calendar events.
 *  Prefers the connected Google account (OAuth → the user's own 'primary'
 *  calendar); falls back to a service-account-shared GOOGLE_CALENDAR_ID. */
const getUpcomingMeetings = async (req, res) => {
  try {
    const userId = String(req.user?.id || '');
    if (!(await composio.hasConnection(userId, CAL_TOOLKIT)))
      return res.json({ configured: false, connected: false, reason: 'google_not_connected', events: [] });

    const raw = await listUserCalendarEvents(userId, { timeMin: new Date().toISOString(), maxResults: 30 });
    const events = dedupeRecurring(raw).slice(0, 15).map((e) => ({
      id: e.id,
      title: e.summary || '(no title)',
      start: e.start?.dateTime || e.start?.date || null,
      end: e.end?.dateTime || e.end?.date || null,
      allDay: !(e.start && e.start.dateTime),
      location: e.location || null,
      joinLink: e.hangoutLink || (e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri) || null,
      attendees: (e.attendees || []).map((a) => ({ email: a.email, name: a.displayName || '' })).filter((a) => a.email),
      organizer: e.organizer?.email || null,
      htmlLink: e.htmlLink || null,
      description: e.description || null,
    }));
    res.json({ configured: true, connected: true, events });
  } catch (err) {
    res.json({ configured: true, connected: true, error: err.message, events: [] });
  }
};

/** GET /api/meetings/recent — Fireflies past meetings + AI summaries.
 *
 *  The firm's Fireflies API key belongs to team@colonel.co.in, so EVERY meeting
 *  in the workspace is hosted under that mailbox — but each meeting carries the
 *  real attendees who joined with their OWN email IDs. So "per-user" means:
 *  fetch the whole workspace, then keep only meetings whose attendee list
 *  contains the logged-in user's connected Google email.
 *
 *  NOTE: the `participant_email` query arg is DEPRECATED and unreliable (it
 *  returned 0) — we filter server-side on the returned participant fields
 *  instead. See https://docs.fireflies.ai/graphql-api/query/transcripts */
const getRecentMeetings = async (req, res) => {
  try {
    const key = process.env.FIREFLIES_API_KEY;
    if (!key) return res.json({ configured: false, reason: 'no_fireflies_key', meetings: [] });
    const debug = req.query.debug === '1';

    // Identify the user by their CONNECTED Google account (their real meeting
    // identity); fall back to the app-login email if Google isn't connected.
    let email = String(req.user?.email || '').toLowerCase();
    try { const g = await getGoogleClient(); if (g?.email) email = String(g.email).toLowerCase(); } catch (_) { /* keep fallback */ }
    const myName = String(req.user?.name || '').trim().toLowerCase();
    // Local-only preview aid: ?as=<email> lets you preview any attendee's
    // recordings without OAuth-connecting that account (dev convenience only).
    if (req.query.as) email = String(req.query.as).trim().toLowerCase();

    // Pull the workspace transcripts WITH their attendee + speaker fields, then
    // filter here. Speakers matter because people join a Meet under a display
    // name (e.g. "TYIT_512_Dhaval chauhan") rather than their calendar email.
    const query = `query { transcripts(limit: 50) {
      id title date duration transcript_url
      host_email organizer_email
      participants
      meeting_attendees { email displayName name }
      speakers { name }
      summary { overview action_items }
    } }`;
    const r = await fetch(FIREFLIES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.errors) return res.json({ configured: true, error: j.errors[0]?.message || 'Fireflies error', meetings: [], filteredBy: email });

    const transcripts = j.data?.transcripts || [];

    // Build the lowercased attendee-email set for one transcript.
    const emailsOf = (t) => {
      const set = new Set();
      const add = (v) => { const s = String(v || '').trim().toLowerCase(); if (s && s.includes('@')) set.add(s); };
      (t.participants || []).forEach(add);
      (t.meeting_attendees || []).forEach((a) => add(a?.email));
      add(t.host_email); add(t.organizer_email);
      return set;
    };
    // Name match — Fireflies often has a display name (attendee or SPEAKER) but
    // not the person's email. Require every significant token of the user's name
    // (e.g. "dhaval","chauhan") to appear in a candidate name → matches
    // "TYIT_512_Dhaval chauhan" without over-matching on a lone first name.
    const myTokens = myName.split(/\s+/).filter((w) => w.length >= 3);
    const namesOf = (t) => {
      const out = [];
      (t.meeting_attendees || []).forEach((a) => { if (a?.displayName) out.push(a.displayName); if (a?.name) out.push(a.name); });
      (t.speakers || []).forEach((s) => { if (s?.name) out.push(s.name); });
      return out.map((n) => String(n).trim().toLowerCase()).filter(Boolean);
    };
    const nameMatch = (t) => myTokens.length > 0 && namesOf(t).some((n) => myTokens.every((tok) => n.includes(tok)));

    const mine = transcripts.filter((t) => (email && emailsOf(t).has(email)) || nameMatch(t));

    // Add manually-pinned meetings for this user (ones name-matching missed).
    let pinnedIds = [];
    try {
      await ensureMeetingPins();
      const rows = await masterSequelize.query(
        'SELECT transcript_id FROM meeting_pins WHERE user_id = :uid',
        { replacements: { uid: String(req.user?.id || '') }, type: QueryTypes.SELECT },
      );
      pinnedIds = rows.map((r) => r.transcript_id);
    } catch (_) { /* table may not exist yet */ }
    const pinnedSet = new Set(pinnedIds);
    const haveIds = new Set(mine.map((t) => t.id));
    for (const t of transcripts) { if (pinnedSet.has(t.id) && !haveIds.has(t.id)) { mine.push(t); haveIds.add(t.id); } }
    for (const pid of pinnedIds) { if (!haveIds.has(pid)) { const t = await fetchTranscriptById(key, pid); if (t) { mine.push(t); haveIds.add(pid); } } }

    const shape = (t) => ({
      id: t.id,
      title: t.title || 'Meeting',
      date: t.date || null,
      duration: t.duration || null,
      url: t.transcript_url || null,
      summary: t.summary?.overview || null,
      actionItems: t.summary?.action_items || null,
      attendees: (t.meeting_attendees || []).map((a) => ({ email: a?.email || null, name: a?.displayName || a?.name || null })).filter((a) => a.email || a.name),
      pinned: pinnedSet.has(t.id),
      ...(debug ? { _attendees: [...emailsOf(t)], _names: namesOf(t) } : {}),
    });

    const meetings = mine
      .sort((a, b) => (Number(b.date) || 0) - (Number(a.date) || 0))
      .slice(0, 20)
      .map(shape);
    const payload = { configured: true, meetings, filteredBy: email };
    if (debug) {
      const all = new Set(); const allNames = new Set();
      transcripts.forEach((t) => { emailsOf(t).forEach((e) => all.add(e)); namesOf(t).forEach((n) => allNames.add(n)); });
      const mineIds = new Set(mine.map((t) => t.id));
      const newestWorkspace = [...transcripts].sort((a, b) => (Number(b.date) || 0) - (Number(a.date) || 0)).slice(0, 8)
        .map((t) => ({ title: t.title, date: t.date, matched: mineIds.has(t.id), names: namesOf(t).slice(0, 6) }));
      payload.debug = { totalInWorkspace: transcripts.length, matched: mine.length, myName, myTokens, newestWorkspace, allParticipants: [...all].sort(), allNames: [...allNames].sort() };
    }
    res.json(payload);
  } catch (err) {
    res.json({ configured: true, error: err.message, meetings: [] });
  }
};

const mapEvent = (e, now) => ({
  id: e.id,
  title: e.summary || '(no title)',
  start: e.start.dateTime,
  end: e.end?.dateTime || null,
  location: e.location || null,
  joinLink: e.hangoutLink || (e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri) || null,
  attendees: (e.attendees || []).map((a) => ({ email: a.email, name: a.displayName || '', status: a.responseStatus })).filter((a) => a.email),
  organizer: e.organizer?.email || null,
  htmlLink: e.htmlLink || null,
  description: e.description || null,
  isPast: new Date(e.end?.dateTime || e.start.dateTime) < now,
});

/** GET /api/meetings/calendar — the connected account's TIMED meetings across a
 *  window (past 45d + next 60d), split into past + upcoming. Calendar + Meet. */
const getCalendarMeetings = async (req, res) => {
  try {
    const userId = String(req.user?.id || '');
    if (!(await composio.hasConnection(userId, CAL_TOOLKIT)))
      return res.json({ configured: false, connected: false, reason: 'google_not_connected', past: [], upcoming: [] });
    const now = new Date();
    const from = new Date(now.getTime() - 45 * 24 * 3600 * 1000);
    const to = new Date(now.getTime() + 60 * 24 * 3600 * 1000);
    const raw = await listUserCalendarEvents(userId, { timeMin: from.toISOString(), timeMax: to.toISOString(), maxResults: 100 });
    const timed = dedupeRecurring(raw).filter((e) => e.start && e.start.dateTime).map((e) => mapEvent(e, now));
    res.json({
      configured: true,
      connected: true,
      upcoming: timed.filter((m) => !m.isPast),
      past: timed.filter((m) => m.isPast).reverse(),  // most-recent first
    });
  } catch (err) {
    res.json({ configured: true, connected: true, error: err.message, past: [], upcoming: [] });
  }
};

/** POST /api/meetings/event — create an event on the connected Google Calendar
 *  (optionally with a Google Meet link). body: {title,start,end,description,attendees,addMeet} */
const createCalendarEvent = async (req, res) => {
  try {
    const userId = String(req.user?.id || '');
    if (!(await composio.hasConnection(userId, CAL_TOOLKIT)))
      return res.status(400).json({ error: 'Connect Google Calendar first.' });
    const { title, description, start, end, attendees, addMeet } = req.body;
    if (!title || !start) return res.status(400).json({ error: 'title and start are required' });

    const startDt = new Date(start);
    const endDt = end ? new Date(end) : new Date(startDt.getTime() + 30 * 60000);
    const r = await composio.executeTool(userId, 'GOOGLECALENDAR_CREATE_EVENT', {
      calendar_id: 'primary',
      summary: title,
      description: description || '',
      start_datetime: startDt.toISOString(),
      end_datetime: endDt.toISOString(),
      attendees: Array.isArray(attendees) ? attendees.filter(Boolean) : [],
      create_meeting_room: !!addMeet,
      send_updates: 'all',
    });
    if (r && r.successful === false) return res.status(502).json({ error: typeof r.error === 'string' ? r.error : 'Could not create event' });
    const d = (r && r.data) || {};
    res.status(201).json({ id: d.id || null, htmlLink: d.htmlLink || d.html_link || null, meetLink: d.hangoutLink || d.hangout_link || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** POST /api/meetings/fireflies/join — add the Fireflies notetaker bot to a
 *  live meeting so it gets recorded/transcribed. Rate-limited 3/20min by
 *  Fireflies; we surface a soft message rather than failing the UI. */
const firefliesJoin = async (req, res) => {
  try {
    const key = process.env.FIREFLIES_API_KEY;
    if (!key) return res.json({ ok: false, reason: 'no_fireflies_key' });
    const { meetingLink, title } = req.body;
    if (!meetingLink) return res.status(400).json({ error: 'meetingLink is required' });

    const mutation = `mutation Add($link: String!, $title: String) { addToLiveMeeting(meeting_link: $link, title: $title) { success } }`;
    const r = await fetch(FIREFLIES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: mutation, variables: { link: meetingLink, title: title || 'Meeting' } }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.errors) return res.json({ ok: false, reason: j.errors[0]?.message || 'Fireflies error' });
    res.json({ ok: !!j.data?.addToLiveMeeting?.success });
  } catch (err) {
    res.json({ ok: false, reason: err.message });
  }
};

/** POST /api/meetings/pin — add a meeting to the user's Recordings by Fireflies
 *  link (or raw transcript id). body: { link } */
const pinMeeting = async (req, res) => {
  try {
    const id = extractTranscriptId(req.body?.link || req.body?.url || req.body?.transcriptId);
    if (!id) return res.status(400).json({ error: 'Provide a Fireflies meeting link.' });
    await ensureMeetingPins();
    await masterSequelize.query(
      `INSERT INTO meeting_pins (user_id, transcript_id) VALUES (:uid, :tid) ON CONFLICT DO NOTHING`,
      { replacements: { uid: String(req.user?.id || ''), tid: id }, type: QueryTypes.INSERT },
    );
    // Best-effort fetch of the title so we can confirm it resolved.
    const key = process.env.FIREFLIES_API_KEY;
    let title = null;
    if (key) { const t = await fetchTranscriptById(key, id); title = t?.title || null; }
    res.json({ ok: true, transcript_id: id, title, resolved: !!title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** DELETE /api/meetings/pin/:transcriptId — remove a pinned recording. */
const unpinMeeting = async (req, res) => {
  try {
    await ensureMeetingPins();
    await masterSequelize.query(
      `DELETE FROM meeting_pins WHERE user_id = :uid AND transcript_id = :tid`,
      { replacements: { uid: String(req.user?.id || ''), tid: String(req.params.transcriptId) }, type: QueryTypes.DELETE },
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* GET /api/meetings/connection — which per-user Google apps this user has
   connected via Composio (drives the "Connect Google" CTAs). */
const getConnectionStatus = async (req, res) => {
  try {
    const userId = String(req.user?.id || '');
    if (!composio.isConfigured()) return res.json({ composio: false, calendar: false, drive: false });
    const [calendar, drive] = await Promise.all([
      composio.hasConnection(userId, CAL_TOOLKIT).catch(() => false),
      composio.hasConnection(userId, DRIVE_TOOLKIT).catch(() => false),
    ]);
    res.json({ composio: true, calendar, drive });
  } catch (err) { res.json({ composio: true, calendar: false, drive: false, error: err.message }); }
};

/* GET /api/meetings/drive-recent — the user's recently-viewed Google Drive files
   (via Composio). Powers the dashboard "Previously viewed files" — real, per-user. */
const getRecentDriveFiles = async (req, res) => {
  try {
    const userId = String(req.user?.id || '');
    if (!(await composio.hasConnection(userId, DRIVE_TOOLKIT)))
      return res.json({ connected: false, files: [] });
    const r = await composio.executeTool(userId, 'GOOGLEDRIVE_LIST_FILES', {
      orderBy: 'viewedByMeTime desc', pageSize: 10,
      fields: 'files(id,name,mimeType,size,webViewLink,viewedByMeTime,modifiedTime)',
    });
    if (r && r.successful === false) throw new Error(typeof r.error === 'string' ? r.error : 'Composio drive error');
    const d = (r && r.data) || r || {};
    const raw = d.files || (d.data && d.data.files) || [];
    const files = raw.map((f) => ({
      id: f.id, name: f.name, mimeType: f.mimeType,
      size: f.size ? Number(f.size) : null, url: f.webViewLink || null,
      viewedAt: f.viewedByMeTime || f.modifiedTime || null,
    }));
    res.json({ connected: true, files });
  } catch (err) { res.json({ connected: true, files: [], error: err.message }); }
};

module.exports = { getUpcomingMeetings, getRecentMeetings, getCalendarMeetings, createCalendarEvent, firefliesJoin, pinMeeting, unpinMeeting, getConnectionStatus, getRecentDriveFiles };

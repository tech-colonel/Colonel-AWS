/**
 * seed-stroom-meetings.js  (LOCAL, one-off)
 *
 * Creates a few REAL upcoming Google Calendar events (with Meet links) on the
 * connected Google account's primary calendar, so the accountant dashboard's
 * "Next Meeting" / "Upcoming" + the Meetings page show live, joinable meetings.
 *
 * Uses the SAME connected-Google OAuth client the app uses (getGoogleClient).
 * Idempotent: deletes previously-seeded events (extendedProperties.private
 * colonel_seed=stroom) before inserting, so re-running never duplicates.
 *
 *   node scripts/seed-stroom-meetings.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { google } = require('googleapis');
const { getGoogleClient } = require('../src/services/googleClient');

const TZ = 'Asia/Kolkata';
const at = (dayOffset, hour, min = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, min, 0, 0);
  return d;
};
const iso = (d) => d.toISOString();

// dayOffset, hour, durationMin, title
const PLAN = [
  [0, new Date().getHours() + 2, 45, 'Stroom · Weekly Ops Sync'],
  [1, 11, 60, 'Stroom · GST Filing Review — June'],
  [2, 15, 30, 'Stroom · Bank Reco Walkthrough — Koparo'],
  [5, 16, 60, 'Stroom · Board Review — Q1 FY27'],
];

(async () => {
  const g = await getGoogleClient();
  if (!g) {
    console.error('❌ Google is not connected on this backend (no OAuth token / client creds). Connect Google Workspace in /integrations first.');
    process.exit(1);
  }
  const cal = google.calendar({ version: 'v3', auth: g.client });
  console.log(`✓ Connected as ${g.email || '(unknown)'} — seeding Stroom meetings…`);

  // 1) Clean prior seeded events (idempotent re-run)
  try {
    const prior = await cal.events.list({
      calendarId: 'primary',
      privateExtendedProperty: 'colonel_seed=stroom',
      timeMin: new Date(Date.now() - 30 * 864e5).toISOString(),
      maxResults: 50,
      singleEvents: true,
    });
    for (const e of prior.data.items || []) {
      await cal.events.delete({ calendarId: 'primary', eventId: e.id });
      console.log(`  – removed old: ${e.summary}`);
    }
  } catch (e) { console.warn('  (cleanup skipped:', e.message, ')'); }

  // 2) Insert fresh events with Meet links
  let n = 0;
  for (const [off, hour, dur, title] of PLAN) {
    const start = at(off, hour);
    const end = new Date(start.getTime() + dur * 60000);
    try {
      const r = await cal.events.insert({
        calendarId: 'primary',
        conferenceDataVersion: 1,
        sendUpdates: 'none',
        requestBody: {
          summary: title,
          description: 'Auto-added by Colonel for the Stroom dashboard demo.',
          start: { dateTime: iso(start), timeZone: TZ },
          end: { dateTime: iso(end), timeZone: TZ },
          conferenceData: { createRequest: { requestId: `colonel-${off}-${hour}-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
          extendedProperties: { private: { colonel_seed: 'stroom' } },
        },
      });
      n++;
      console.log(`  + ${title}  →  ${start.toLocaleString('en-IN')}  ${r.data.hangoutLink || '(no meet link)'}`);
    } catch (e) {
      console.error(`  ! failed "${title}": ${e.message}`);
    }
  }
  console.log(`\n✅ Done. ${n} upcoming meeting(s) on ${g.email}. Refresh the dashboard → Next Meeting / Upcoming.`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

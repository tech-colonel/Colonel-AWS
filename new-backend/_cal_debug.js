require('dotenv').config();
const { google } = require('googleapis');
const { getGoogleClient } = require('./src/services/googleClient');
(async () => {
  const g = await getGoogleClient();
  if (!g) { console.log('no google client'); process.exit(0); }
  const cal = google.calendar({ version: 'v3', auth: g.client });
  const now = new Date();
  const past = new Date(now.getTime() - 30*24*3600*1000);
  const future = new Date(now.getTime() + 60*24*3600*1000);
  const r = await cal.events.list({ calendarId: 'primary', timeMin: past.toISOString(), timeMax: future.toISOString(), maxResults: 50, singleEvents: true, orderBy: 'startTime' });
  const items = r.data.items || [];
  const timed = items.filter(e => e.start && e.start.dateTime);
  console.log('total(±90d):', items.length, '| timed:', timed.length, '| all-day:', items.length - timed.length);
  console.log('--- timed events ---');
  timed.forEach(e => console.log('  •', (e.summary||'(no title)'), '|', (e.start.dateTime||''), '| meet:', !!e.hangoutLink, '| att:', (e.attendees||[]).length));
})().catch(e => console.log('ERR', e.message));

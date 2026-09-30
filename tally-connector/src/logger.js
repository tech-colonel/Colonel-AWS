/**
 * logger.js — every step goes to the console AND to a daily file in
 * <home>/logs/connector-YYYY-MM-DD.log, so a client can send us the file when
 * something breaks. With --debug the raw Tally XML (requests + responses) is
 * also saved under <home>/logs/raw/ for inspection.
 */

const fs = require('fs');
const path = require('path');

let logDir = null;
let debugOn = false;

// Local time: these logs are read by the person sitting at the Tally PC.
const pad = (n, w = 2) => String(n).padStart(w, '0');
const day = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d = new Date()) => `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

function init(home, { debug = false } = {}) {
  logDir = path.join(home, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  debugOn = debug;
  pruneOld();
}

function write(level, msg) {
  const line = `${stamp()} [${level}] ${msg}`;
  if (level !== 'DBG' || debugOn) (level === 'ERR' ? console.error : console.log)(line);
  if (!logDir) return;
  try { fs.appendFileSync(path.join(logDir, `connector-${day()}.log`), line + '\n'); } catch (_) { /* disk full etc. */ }
}

function raw(name, content) {
  if (!logDir || !debugOn) return;
  try {
    const dir = path.join(logDir, 'raw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${Date.now()}-${name}`), content);
  } catch (_) { /* best effort */ }
}

/* Keep 30 days of logs. */
function pruneOld() {
  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(logDir)) {
      const p = path.join(logDir, f);
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch (_) { /* ignore */ }
}

module.exports = {
  init, raw,
  info: (m) => write('INF', m),
  warn: (m) => write('WRN', m),
  error: (m) => write('ERR', m),
  debug: (m) => write('DBG', m),
  // debug lines are always written to the FILE; --debug only adds them to the console
  get debugEnabled() { return debugOn; },
};

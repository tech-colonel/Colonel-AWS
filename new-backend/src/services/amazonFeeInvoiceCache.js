'use strict';

/* Parse Amazon's fee-invoice PDFs once, not on every report run.

   Reading 430 PDFs with pdfplumber takes the better part of a minute, and the
   report is rebuilt far more often than the invoices change. So the parse is
   cached next to the files and keyed on what the folder actually CONTAINS -
   every file's relative path, size and mtime - rather than on a timestamp.
   Add a month, replace a corrected PDF, delete one: the key moves and the
   cache rebuilds. Touch nothing and it never re-reads.

   The parser is Python because pdfplumber has no usable Node equivalent, and
   because the two traps it handles were expensive to find: a credit note wraps
   its amount onto the next line and closes on TWO figures Amazon never adds,
   and a multi-page invoice repeats its body so scanning the service lines
   double-counts the tax. See scripts/amazon_fee_invoices.py. */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, '../../scripts/amazon_fee_invoices.py');
const CACHE_NAME = '.parsed-invoices.json';
/* 430 PDFs is ~40s cold on the dev Mac. Give it room, but not forever: a hung
   interpreter must not hold the whole report hostage. */
const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

async function listPdfs(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listPdfs(p)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) {
      const st = await fs.stat(p);
      out.push({ path: p, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    }
  }
  return out;
}

function fingerprint(root, files) {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(`${path.relative(root, f.path)}|${f.size}|${f.mtimeMs}\n`);
  return h.digest('hex');
}

function runParser(root) {
  return new Promise((resolve, reject) => {
    execFile('python3', [SCRIPT, root], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`fee-invoice parser failed: ${err.message}${stderr ? ` | ${String(stderr).slice(0, 300)}` : ''}`));
        try { resolve(JSON.parse(stdout)); }
        catch (e) { reject(new Error(`fee-invoice parser returned non-JSON: ${String(stdout).slice(0, 200)}`)); }
      });
  });
}

/* Returns { months, documents, fingerprint, parsedAt, fromCache } - or
   months: [] when the brand has no invoice folder at all. A parse failure is
   never fatal: the caller still has the settlement side, and the page says
   the documents could not be read. */
async function load(invoiceDir, { force = false } = {}) {
  const files = await listPdfs(invoiceDir);
  if (!files.length) {
    return { months: [], documents: 0, fingerprint: null, parsedAt: null,
             fromCache: false, error: null };
  }

  const fp = fingerprint(invoiceDir, files);
  const cacheFile = path.join(invoiceDir, CACHE_NAME);

  if (!force) {
    try {
      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (cached && cached.fingerprint === fp && Array.isArray(cached.months)) {
        return { ...cached, fromCache: true, error: null };
      }
    } catch { /* no cache, or unreadable - fall through and parse */ }
  }

  let months;
  try { months = await runParser(invoiceDir); }
  catch (e) {
    return { months: [], documents: files.length, fingerprint: fp, parsedAt: null,
             fromCache: false, error: e.message };
  }

  /* The script keeps every document's detail for the drill-down. That is the
     bulk of the payload and the report only ever needs the month roll-up plus
     the per-kind split, so `docs` stays in the cache on disk and is dropped
     from what goes back to the caller. */
  const payload = {
    months,
    documents: months.reduce((a, m) => a + (m.documents || 0), 0),
    fingerprint: fp,
    parsedAt: new Date().toISOString(),
  };
  try { await fs.writeFile(cacheFile, JSON.stringify(payload)); } catch { /* read-only dir: parse again next time */ }

  return { ...payload, fromCache: false, error: null };
}

/* What the report needs - no per-document detail. */
const slim = (months) => (months || []).map((m) => ({
  month: m.month,
  documents: m.documents,
  invoices: m.invoices,
  creditNotes: m.creditNotes,
  fee: m.fee,
  gst: m.gst,
  total: m.total,
  byKind: m.byKind || {},
}));

module.exports = { load, slim, CACHE_NAME };

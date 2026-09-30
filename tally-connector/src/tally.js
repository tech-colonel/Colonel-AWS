/**
 * tally.js — talks to Tally over its built-in XML server (Help → Settings →
 * Connectivity → "TallyPrime acts as: Both", Port 9002).
 *
 * Every request is an XML <ENVELOPE> POSTed to http://host:port. Instead of
 * installing a .tcp into Tally, each request carries its own inline TDL
 * (<TDL><TDLMESSAGE><COLLECTION …>) describing exactly what to return, and Tally
 * answers with the collection as XML. Tally only serves companies that are
 * OPEN in it, so Tally must be running with the company loaded.
 */

const { XMLParser } = require('fast-xml-parser');
const log = require('./logger');

const LIST_TAGS = new Set([
  'COMPANY', 'LEDGER', 'VOUCHER',
  'ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST', 'LEDGSTREGDETAILS.LIST',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,       // keep every value a string; we convert explicitly
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => LIST_TAGS.has(name),
});

// ── helpers ──────────────────────────────────────────────────────────────────

const xmlEsc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2024-04-01' → '1-Apr-2024' (the format Tally's SVFROMDATE accepts) */
const toTallyDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d}-${MONTHS[m - 1]}-${y}`;
};

/** Text of a parsed node, whether it came back as "x" or { '#text': 'x', '@_TYPE': … } */
const text = (v) => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return v['#text'] !== undefined ? String(v['#text']) : '';
  return String(v);
};

/** Tally dates arrive as '20240401' (or occasionally '1-Apr-2024') → '2024-04-01' */
const parseDate = (v) => {
  const s = text(v).trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) {
    const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (mi < 0) return null;
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
};

/** Tally amounts: '-1500.00', '1,500.00', or forex '$10 @ ₹83/$ = ₹830.00'.
    Sign convention (kept as-is): negative = Debit, positive = Credit. */
const parseAmount = (v) => {
  let s = text(v).trim();
  if (!s) return null;
  if (s.includes('=')) s = s.slice(s.lastIndexOf('=') + 1);
  const neg = /^\s*-/.test(s) || /\(-\)/.test(s);
  const digits = s.replace(/[^0-9.]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
};

const parseInt10 = (v) => { const n = parseInt(text(v), 10); return Number.isFinite(n) ? n : null; };
const yes = (v) => text(v).trim().toLowerCase() === 'yes';

/** Tally output can contain control characters (e.g. &#4;) that break XML parsers. */
const sanitize = (xml) => xml
  .replace(/&#(?:[0-8]|1[124-9]|2\d|3[01]);/g, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Tally may answer in UTF-16 (with or without BOM) or UTF-8. */
const decode = (buf) => {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[1] === 0x00 && buf[0] !== 0x00) return buf.toString('utf16le');
  return buf.toString('utf8');
};

// ── transport ────────────────────────────────────────────────────────────────

class TallyError extends Error {}

class TallyClient {
  constructor({ host, port, timeoutMs = 5 * 60 * 1000, dumpRaw = false }) {
    this.url = `http://${host}:${port}`;
    this.timeoutMs = timeoutMs;
    this.dumpRaw = dumpRaw;
  }

  async post(xml, label) {
    const started = Date.now();
    log.debug(`→ Tally ${label}: POST ${this.url} (${xml.length} bytes)`);
    if (this.dumpRaw) log.raw(`${label}-request.xml`, xml);
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8' },
        body: xml,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const why = e.name === 'TimeoutError' ? `timed out after ${this.timeoutMs / 1000}s`
        : (e.cause && e.cause.code) || e.message;
      throw new TallyError(`Cannot reach Tally at ${this.url} (${why}). Is Tally open with port ${this.url.split(':').pop()} enabled?`);
    }
    const body = decode(Buffer.from(await res.arrayBuffer()));
    log.debug(`← Tally ${label}: HTTP ${res.status}, ${body.length} chars in ${Date.now() - started}ms`);
    if (this.dumpRaw) log.raw(`${label}-response.xml`, body);
    if (!res.ok) throw new TallyError(`Tally returned HTTP ${res.status} for ${label}`);

    const doc = parser.parse(sanitize(body));
    const env = doc.ENVELOPE || doc.RESPONSE || doc;
    const lineErr = findKey(env, 'LINEERROR');
    if (lineErr) throw new TallyError(`Tally error for ${label}: ${text(lineErr)}`);
    return env;
  }

  /**
   * Export a collection with inline TDL.
   * @param {object} o
   * @param {string} o.id          collection name (also the request ID)
   * @param {string} o.type        Tally object type: Company | Ledger | Voucher
   * @param {string[]} o.fetch     fields/methods to return
   * @param {string} [o.company]   SVCURRENTCOMPANY (omit to list loaded companies)
   * @param {string[]} [o.filters] TDL formulae, all must be true
   * @param {string} [o.from]      ISO date → SVFROMDATE
   * @param {string} [o.to]        ISO date → SVTODATE
   */
  async exportCollection({ id, type, fetch, company, filters = [], from, to }) {
    const statics = [
      '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
      company ? `<SVCURRENTCOMPANY>${xmlEsc(company)}</SVCURRENTCOMPANY>` : '',
      from ? `<SVFROMDATE TYPE="Date">${toTallyDate(from)}</SVFROMDATE>` : '',
      to ? `<SVTODATE TYPE="Date">${toTallyDate(to)}</SVTODATE>` : '',
    ].join('');
    const filterNames = filters.map((_, i) => `${id}F${i}`);
    const xml = `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES>${statics}</STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <COLLECTION NAME="${id}" ISMODIFY="No">
    <TYPE>${type}</TYPE>
    <FETCH>${fetch.join(', ')}</FETCH>
    ${filterNames.length ? `<FILTER>${filterNames.join(', ')}</FILTER>` : ''}
   </COLLECTION>
   ${filters.map((f, i) => `<SYSTEM TYPE="Formulae" NAME="${filterNames[i]}">${xmlEsc(f)}</SYSTEM>`).join('\n   ')}
  </TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;
    const env = await this.post(xml, id);
    const coll = findKey(env, 'COLLECTION') || {};
    return coll[type.toUpperCase()] || [];
  }

  // ── what we read ──────────────────────────────────────────────────────────

  /** Companies currently open in Tally. */
  async listCompanies() {
    const rows = await this.exportCollection({
      id: 'ColonelCompanies', type: 'Company',
      fetch: ['Name', 'GUID', 'BooksFrom', 'StartingFrom', 'AltVchID', 'AltMstID'],
    });
    return rows.map((c) => ({
      name: text(c.NAME) || (c['@_NAME'] || ''),
      guid: text(c.GUID) || null,
      books_from: parseDate(c.BOOKSFROM) || parseDate(c.STARTINGFROM),
      alt_vch_id: parseInt10(c.ALTVCHID),
      alt_mst_id: parseInt10(c.ALTMSTID),
    })).filter((c) => c.name);
  }

  /** All ledgers of a company with balances as of `to`. */
  async ledgers(company, { from, to }) {
    const rows = await this.exportCollection({
      id: 'ColonelLedgers', type: 'Ledger', company, from, to,
      fetch: ['Name', 'Parent', 'OpeningBalance', 'ClosingBalance', 'PartyGSTIN', 'LedGSTRegDetails', 'GUID', 'AlterID'],
    });
    return rows.map((l) => {
      const reg = (l['LEDGSTREGDETAILS.LIST'] || []).map((r) => text(r.GSTIN)).find(Boolean);
      return {
        guid: text(l.GUID),
        name: text(l.NAME) || (l['@_NAME'] || ''),
        parent: text(l.PARENT),
        opening_balance: parseAmount(l.OPENINGBALANCE),
        closing_balance: parseAmount(l.CLOSINGBALANCE),
        gstin: text(l.PARTYGSTIN) || reg || null,
        alter_id: parseInt10(l.ALTERID),
      };
    }).filter((l) => l.guid);
  }

  /** Vouchers with minAlter < AlterID <= maxAlter (maxAlter optional). */
  async vouchers(company, { from, to, minAlter, maxAlter }) {
    const filters = [`$AlterID > ${Number(minAlter) || 0}`];
    if (maxAlter !== undefined && maxAlter !== null) filters.push(`$AlterID <= ${Number(maxAlter)}`);
    const rows = await this.exportCollection({
      id: 'ColonelVouchers', type: 'Voucher', company, from, to, filters,
      fetch: [
        'Date', 'VoucherTypeName', 'VoucherNumber', 'PartyLedgerName', 'Narration', 'GUID', 'AlterID',
        'IsCancelled', 'IsOptional',
        'AllLedgerEntries.LedgerName', 'AllLedgerEntries.Amount',
        'LedgerEntries.LedgerName', 'LedgerEntries.Amount',
      ],
    });
    return rows.map(toVoucher).filter((v) => v.guid);
  }

  /** Just the GUIDs of every voucher — used once a day to detect deletions. */
  async voucherGuids(company, { from, to }) {
    const rows = await this.exportCollection({
      id: 'ColonelVoucherGuids', type: 'Voucher', company, from, to, fetch: ['GUID'],
    });
    return rows.map((v) => text(v.GUID)).filter(Boolean);
  }
}

function toVoucher(v) {
  // Accounting vouchers list lines in ALLLEDGERENTRIES; invoice-mode vouchers
  // put the party/tax lines in LEDGERENTRIES. Use whichever Tally returned.
  const all = v['ALLLEDGERENTRIES.LIST'] || [];
  const lines = (all.length ? all : (v['LEDGERENTRIES.LIST'] || []))
    .map((e) => ({ ledger: text(e.LEDGERNAME), amount: parseAmount(e.AMOUNT) }))
    .filter((e) => e.ledger);
  const party = text(v.PARTYLEDGERNAME) || null;
  const partyLine = party && lines.find((e) => e.ledger === party);
  // Voucher value: the party's line if there is one, else total of the credit side.
  const credits = lines.reduce((s, e) => s + (e.amount > 0 ? e.amount : 0), 0);
  const amount = partyLine && partyLine.amount !== null ? Math.abs(partyLine.amount) : Math.round(credits * 100) / 100;
  return {
    guid: text(v.GUID),
    date: parseDate(v.DATE),
    voucher_type: text(v.VOUCHERTYPENAME) || v['@_VCHTYPE'] || null,
    voucher_number: text(v.VOUCHERNUMBER) || null,
    party_name: party,
    amount,
    narration: text(v.NARRATION) || null,
    is_cancelled: yes(v.ISCANCELLED),
    is_optional: yes(v.ISOPTIONAL),
    alter_id: parseInt10(v.ALTERID),
    ledger_entries: lines,
  };
}

/** Depth-first search for the first property named `key`. */
function findKey(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = findKey(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

module.exports = { TallyClient, TallyError, _test: { parseDate, parseAmount, toVoucher, sanitize, decode } };

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

/** Tally writes line breaks in narrations as numeric references (&#13;&#10;), which
    the XML parser leaves as literal text. Turn them into the characters they stand for. */
const decodeRefs = (s) => (s.includes('&#') ? s.replace(/&#(x[0-9a-fA-F]+|\d+);/g, (m, n) => {
  const code = n[0] === 'x' ? parseInt(n.slice(1), 16) : Number(n);
  try { return String.fromCodePoint(code); } catch (_) { return m; }
}) : s);

/** Text of a parsed node, whether it came back as "x" or { '#text': 'x', '@_TYPE': … } */
const text = (v) => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return v['#text'] !== undefined ? decodeRefs(String(v['#text'])) : '';
  return decodeRefs(String(v));
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
  async exportCollection({ id, type, fetch, company, filters = [], from, to, tag }) {
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
    // A single row comes back as an object, not a list; some types use another
    // tag than their name (Bills → BILL).
    const rows = coll[tag || type.toUpperCase()];
    return rows === undefined || rows === '' ? [] : [].concat(rows);
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

  /** All ledgers of a company with balances as of `to`, plus their master details. */
  async ledgers(company, { from, to }) {
    const rows = await this.exportCollection({
      id: 'ColonelLedgers', type: 'Ledger', company, from, to,
      fetch: ['Name', 'Parent', 'OpeningBalance', 'ClosingBalance', 'PartyGSTIN', 'LedGSTRegDetails', 'GUID', 'AlterID',
        'MailingName', 'Address', 'LedStateName', 'CountryName', 'PinCode', 'Email', 'LedgerPhone', 'LedgerMobile',
        'LedgerContact', 'IncomeTaxNumber', 'GSTRegistrationType', 'LedMailingDetails', 'BillCreditPeriod', 'CreditLimit',
        'IsBillWiseOn', 'BankDetails', 'IFSCode', 'BankName', 'BankAccHolderName', 'TaxType', 'GSTDutyHead', 'RateOfTaxCalculation'],
    });
    return rows.map((l) => {
      const reg = arr(l['LEDGSTREGDETAILS.LIST']).slice(-1)[0] || {};
      const mail = arr(l['LEDMAILINGDETAILS.LIST']).slice(-1)[0] || {};
      const address = addressOf(l) || addressOf(mail);
      return {
        guid: text(l.GUID),
        name: nameOf(l),
        parent: clean(l.PARENT) || '',
        opening_balance: parseAmount(l.OPENINGBALANCE),
        closing_balance: parseAmount(l.CLOSINGBALANCE),
        gstin: clean(l.PARTYGSTIN) || clean(reg.GSTIN),
        alter_id: parseInt10(l.ALTERID),
        details: compact({
          mailing_name: clean(l.MAILINGNAME) || clean(mail.MAILINGNAME),
          address,
          state: clean(l.LEDSTATENAME) || clean(mail.STATE),
          country: clean(l.COUNTRYNAME) || clean(mail.COUNTRY),
          pincode: clean(l.PINCODE) || clean(mail.PINCODE),
          email: clean(l.EMAIL), phone: clean(l.LEDGERPHONE), mobile: clean(l.LEDGERMOBILE), contact: clean(l.LEDGERCONTACT),
          pan: clean(l.INCOMETAXNUMBER),
          gst_registration_type: clean(l.GSTREGISTRATIONTYPE) || clean(reg.GSTREGISTRATIONTYPE),
          credit_period: clean(l.BILLCREDITPERIOD), credit_limit: parseAmount(l.CREDITLIMIT),
          is_bill_wise: yes(l.ISBILLWISEON) || null,
          bank_name: clean(l.BANKNAME), bank_account: clean(l.BANKDETAILS), bank_ifsc: clean(l.IFSCODE), bank_holder: clean(l.BANKACCHOLDERNAME),
          tax_type: clean(l.TAXTYPE) === 'Others' ? null : clean(l.TAXTYPE),
          gst_duty_head: clean(l.GSTDUTYHEAD), tax_rate: parseAmount(l.RATEOFTAXCALCULATION) || null,
        }),
      };
    }).filter((l) => l.guid);
  }

  /** Company profile: where it is, which features are on, and its GST registrations. */
  async companyProfile(company) {
    const rows = await this.exportCollection({
      id: 'ColonelCompanyProfile', type: 'Company',
      fetch: ['Name', 'MailingName', 'Address', 'StateName', 'CountryName', 'PinCode', 'PhoneNumber', 'MobileNo', 'Email', 'Website',
        'IncomeTaxNumber', 'BooksFrom', 'StartingFrom', 'EndingAt', 'LastVoucherDate',
        'IsInventoryOn', 'IsGSTOn', 'IsTDSOn', 'IsPayrollOn', 'IsCostCentresOn', 'IsBillWiseOn'],
    });
    const c = rows.find((r) => nameOf(r) === company) || {};
    let registrations = [];
    try {
      const units = await this.exportCollection({ id: 'ColonelTaxUnits', type: 'TaxUnit', company, fetch: ['Name', 'GSTRegNumber', 'StateName'] });
      registrations = units.map((u) => ({ name: nameOf(u), gstin: clean(u.GSTREGNUMBER) || u['@_TAXREGISTRATION'] || null, state: clean(u.STATENAME) }))
        .filter((u) => u.gstin);
    } catch (e) { log.warn(`[${company}] GST registrations not read: ${e.message}`); }
    return compact({
      mailing_name: clean(c.MAILINGNAME), address: addressOf(c), state: clean(c.STATENAME), country: clean(c.COUNTRYNAME),
      pincode: clean(c.PINCODE), phone: clean(c.PHONENUMBER) || clean(c.MOBILENO), email: clean(c.EMAIL), website: clean(c.WEBSITE),
      pan: clean(c.INCOMETAXNUMBER),
      books_from: parseDate(c.BOOKSFROM), fy_from: parseDate(c.STARTINGFROM), fy_to: parseDate(c.ENDINGAT),
      last_voucher_date: parseDate(c.LASTVOUCHERDATE),
      features: { inventory: yes(c.ISINVENTORYON), gst: yes(c.ISGSTON), tds: yes(c.ISTDSON), payroll: yes(c.ISPAYROLLON), cost_centres: yes(c.ISCOSTCENTRESON), bill_wise: yes(c.ISBILLWISEON) },
      gst_registrations: registrations,
    });
  }

  /**
   * One kind of master as generic rows { guid, name, parent, data }.
   * Kinds: group | voucher_type | stock_group | stock_item | godown | unit | currency | cost_centre
   */
  async masters(kind, company, { from, to }) {
    const spec = MASTER_KINDS[kind];
    if (!spec) throw new TallyError(`Unknown master kind ${kind}`);
    const rows = await this.exportCollection({
      id: `Colonel${spec.type}s`, type: spec.type, company, from, to, fetch: ['Name', 'Parent', 'GUID', 'AlterID', ...spec.fetch],
    });
    return rows.map((r) => ({
      guid: text(r.GUID) || `name:${nameOf(r)}`,
      name: nameOf(r),
      parent: clean(r.PARENT),
      data: compact({ reserved: decodeRefs(String(r['@_RESERVEDNAME'] || '')).trim() || null, ...spec.data(r) }),
    })).filter((r) => r.name);
  }

  /** Outstanding bills (bill-wise receivables and payables) as of `to`. Negative = receivable (Dr). */
  async bills(company, { from, to }) {
    const rows = await this.exportCollection({
      id: 'ColonelBills', type: 'Bills', tag: 'BILL', company, from, to,
      fetch: ['Name', 'Parent', 'BillDate', 'BillCreditPeriod', 'ClosingBalance', 'IsAdvance'],
    });
    return rows.map((b) => ({
      party: clean(b.PARENT), name: nameOf(b), bill_date: parseDate(b.BILLDATE),
      credit_period: clean(b.BILLCREDITPERIOD), closing: parseAmount(b.CLOSINGBALANCE), is_advance: yes(b.ISADVANCE),
    })).filter((b) => b.party && b.closing);
  }

  /** Vouchers with minAlter < AlterID <= maxAlter (maxAlter optional). */
  async vouchers(company, { from, to, minAlter, maxAlter }) {
    const filters = [`$AlterID > ${Number(minAlter) || 0}`];
    if (maxAlter !== undefined && maxAlter !== null) filters.push(`$AlterID <= ${Number(maxAlter)}`);
    const rows = await this.exportCollection({
      id: 'ColonelVouchers', type: 'Voucher', company, from, to, filters,
      fetch: [
        'Date', 'VoucherTypeName', 'VoucherNumber', 'PartyLedgerName', 'Narration', 'GUID', 'AlterID',
        'IsCancelled', 'IsOptional', 'IsInvoice', 'Reference', 'ReferenceDate', 'PartyGSTIN', 'PlaceOfSupply',
        'BasicBuyerName', 'IRN', 'EnteredBy',
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

// ── shared readers ───────────────────────────────────────────────────────────

/** A nested list that may be absent, a single object, or an array. */
const arr = (x) => (x === undefined || x === null || x === '' ? [] : [].concat(x));

/** Text with Tally's placeholders ("Not Applicable", "Any") treated as empty. */
const clean = (v) => {
  const s = text(v).trim();
  return !s || /^(not applicable|any)$/i.test(s) ? null : s;
};

const nameOf = (r) => text(r.NAME).trim() || decodeRefs(String(r['@_NAME'] || '')).trim();

/** Drop empty values so the stored JSON stays small. */
const compact = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
};

const addressOf = (r) => {
  const lines = arr(r['ADDRESS.LIST']).flatMap((a) => arr(a.ADDRESS)).map((x) => text(x).trim()).filter(Boolean);
  return lines.length ? lines.join(', ') : null;
};

/** ' 116 Nos' → { qty: 116, unit: 'Nos' } */
const parseQty = (v) => {
  const m = text(v).trim().match(/^(-?[\d,]*\.?\d+)\s*(.*)$/);
  if (!m) return { qty: null, unit: null };
  return { qty: Number(m[1].replace(/,/g, '')), unit: m[2].trim() || null };
};

/** '27.00/Nos' → 27 */
const parseRate = (v) => { const s = text(v).trim(); return s ? parseAmount(s.split('/')[0]) : null; };

/** The integrated (IGST) rate out of a list of RATEDETAILS — i.e. the item's GST %. */
const gstRateOf = (rateDetails) => {
  const rates = arr(rateDetails);
  const igst = rates.find((r) => /^igst$/i.test(text(r.GSTRATEDUTYHEAD).trim()));
  const n = igst ? parseAmount(igst.GSTRATE) : null;
  return n === null ? null : n;
};

const MASTER_KINDS = {
  group: {
    type: 'Group', fetch: ['IsRevenue', 'IsDeemedPositive', 'AffectsGrossProfit', 'OpeningBalance', 'ClosingBalance'],
    data: (r) => ({ is_revenue: yes(r.ISREVENUE), is_deemed_positive: yes(r.ISDEEMEDPOSITIVE), affects_gross_profit: yes(r.AFFECTSGROSSPROFIT),
      opening: parseAmount(r.OPENINGBALANCE), closing: parseAmount(r.CLOSINGBALANCE) }),
  },
  voucher_type: {
    type: 'VoucherType', fetch: ['NumberingMethod', 'IsActive', 'AffectsStock'],
    data: (r) => ({ numbering: clean(r.NUMBERINGMETHOD), is_active: yes(r.ISACTIVE), affects_stock: yes(r.AFFECTSSTOCK) }),
  },
  stock_group: { type: 'StockGroup', fetch: [], data: () => ({}) },
  stock_item: {
    type: 'StockItem',
    fetch: ['Category', 'BaseUnits', 'OpeningBalance', 'OpeningValue', 'ClosingBalance', 'ClosingValue', 'ClosingRate', 'GSTDetails', 'HSNDetails'],
    data: (r) => {
      const gst = arr(r['GSTDETAILS.LIST']).slice(-1)[0] || {};
      const hsn = arr(r['HSNDETAILS.LIST']).slice(-1)[0] || {};
      const state = arr(gst['STATEWISEDETAILS.LIST'])[0] || {};
      const open = parseQty(r.OPENINGBALANCE); const close = parseQty(r.CLOSINGBALANCE);
      return {
        category: clean(r.CATEGORY), unit: clean(r.BASEUNITS),
        opening_qty: open.qty, opening_value: parseAmount(r.OPENINGVALUE),
        closing_qty: close.qty, closing_value: parseAmount(r.CLOSINGVALUE), closing_rate: parseRate(r.CLOSINGRATE),
        hsn: clean(hsn.HSNCODE), hsn_description: clean(hsn.HSN),
        taxability: clean(gst.TAXABILITY), gst_rate: gstRateOf(state['RATEDETAILS.LIST']),
      };
    },
  },
  godown: { type: 'Godown', fetch: [], data: () => ({}) },
  unit: { type: 'Unit', fetch: ['OriginalName', 'IsSimpleUnit'], data: (r) => ({ formal_name: clean(r.ORIGINALNAME), is_simple: yes(r.ISSIMPLEUNIT) }) },
  currency: { type: 'Currency', fetch: ['OriginalName', 'ExpandedSymbol'], data: (r) => ({ formal_name: clean(r.ORIGINALNAME), symbol: clean(r.EXPANDEDSYMBOL) }) },
  cost_centre: { type: 'CostCentre', fetch: ['Category'], data: (r) => ({ category: clean(r.CATEGORY) }) },
};

function toVoucher(v) {
  // Accounting vouchers list lines in ALLLEDGERENTRIES; invoice-mode vouchers
  // put the party/tax lines in LEDGERENTRIES. Use whichever Tally returned.
  const all = arr(v['ALLLEDGERENTRIES.LIST']);
  const entries = all.length ? all : arr(v['LEDGERENTRIES.LIST']);
  const lines = entries
    .map((e) => ({ ledger: text(e.LEDGERNAME), amount: parseAmount(e.AMOUNT) }))
    .filter((e) => e.ledger);
  const party = text(v.PARTYLEDGERNAME) || null;
  const partyLine = party && lines.find((e) => e.ledger === party);
  // Voucher value: the party's line if there is one, else total of the credit side.
  const credits = lines.reduce((s, e) => s + (e.amount > 0 ? e.amount : 0), 0);
  const amount = partyLine && partyLine.amount !== null ? Math.abs(partyLine.amount) : Math.round(credits * 100) / 100;

  // Detail Tally sends inside each line: which bills it settles, how the bank was paid.
  const bills = []; const bank = [];
  for (const e of entries) {
    const ledger = text(e.LEDGERNAME);
    for (const b of arr(e['BILLALLOCATIONS.LIST'])) {
      const name = clean(b.NAME); const amt = parseAmount(b.AMOUNT);
      if (name || amt) bills.push(compact({ ledger, name, type: clean(b.BILLTYPE), amount: amt }));
    }
    for (const b of arr(e['BANKALLOCATIONS.LIST'])) {
      const amt = parseAmount(b.AMOUNT);
      if (amt === null && !clean(b.INSTRUMENTNUMBER)) continue;
      bank.push(compact({ ledger, type: clean(b.TRANSACTIONTYPE), instrument_no: clean(b.INSTRUMENTNUMBER),
        instrument_date: parseDate(b.INSTRUMENTDATE), favouring: clean(b.PAYMENTFAVOURING), bank: clean(b.BANKNAME),
        bank_date: parseDate(b.BANKERSDATE), amount: amt }));
    }
  }
  // Item lines of an invoice: what was sold or bought, at what rate, from which godown.
  const invAll = arr(v['ALLINVENTORYENTRIES.LIST']);
  const inventory = (invAll.length ? invAll : arr(v['INVENTORYENTRIES.LIST'])).map((i) => {
    const q = parseQty(i.BILLEDQTY || i.ACTUALQTY);
    const batch = arr(i['BATCHALLOCATIONS.LIST'])[0] || {};
    const acct = arr(i['ACCOUNTINGALLOCATIONS.LIST'])[0] || {};
    return compact({
      item: text(i.STOCKITEMNAME), qty: q.qty, unit: q.unit, rate: parseRate(i.RATE), amount: parseAmount(i.AMOUNT),
      discount: parseAmount(i.DISCOUNT) || null, hsn: clean(i.GSTHSNNAME), gst_rate: gstRateOf(i['RATEDETAILS.LIST']),
      godown: clean(batch.GODOWNNAME), ledger: clean(acct.LEDGERNAME),
    });
  }).filter((i) => i.item);

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
    details: compact({
      reference: clean(v.REFERENCE), reference_date: parseDate(v.REFERENCEDATE), is_invoice: yes(v.ISINVOICE) || null,
      party_gstin: clean(v.PARTYGSTIN), place_of_supply: clean(v.PLACEOFSUPPLY), buyer_name: clean(v.BASICBUYERNAME),
      irn: clean(v.IRN), entered_by: clean(v.ENTEREDBY),
      inventory, bills, bank,
    }),
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

module.exports = { TallyClient, TallyError, MASTER_KINDS, _test: { parseDate, parseAmount, parseQty, parseRate, toVoucher, sanitize, decode } };

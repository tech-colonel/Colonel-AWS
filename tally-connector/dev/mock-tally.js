/**
 * mock-tally.js — a fake Tally XML server for developing without Windows/Tally.
 * Answers the same inline-TDL collection requests the connector sends, in the
 * shape real TallyPrime returns (ENVELOPE › BODY › DATA › COLLECTION), honouring
 * the $AlterID filters and SVCURRENTCOMPANY.
 *
 *   node dev/mock-tally.js [port=9002]
 *
 * While it runs, type in its terminal:
 *   add      → add a new sales voucher (next sync should pick up exactly one)
 *   edit     → change the amount of the first voucher (bumps its AlterID)
 *   del      → delete the last voucher (disappears after the daily reconcile)
 */

const http = require('http');
const readline = require('readline');

const PORT = Number(process.argv[2]) || 9002;
let alterSeq = 100;
const nextAlter = () => ++alterSeq;
const guid = (p, n) => `${p}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const company = { name: 'Demo Traders Pvt Ltd', guid: 'c0ffee00-1111-4222-8333-444455556666', booksFrom: '20240401' };

const ledgers = [
  ['Cash', 'Cash-in-Hand', '-5000.00', '-18250.00', ''],
  ['HDFC Bank', 'Bank Accounts', '-250000.00', '-312400.00', ''],
  ['Sharma Retail', 'Sundry Debtors', '0', '-47200.00', '27AABCS1234F1Z5'],
  ['Gupta & Sons', 'Sundry Debtors', '-12000.00', '-12000.00', '07AAACG5678K1Z2'],
  ['Mehta Suppliers', 'Sundry Creditors', '30000.00', '52000.00', '24AAFCM9012L1ZX'],
  ['Sales @ 18%', 'Sales Accounts', '0', '240000.00', ''],
  ['Purchase @ 18%', 'Purchase Accounts', '0', '-150000.00', ''],
  ['Output IGST', 'Duties & Taxes', '0', '43200.00', ''],
  ['Input IGST', 'Duties & Taxes', '0', '-27000.00', ''],
  ['Rent', 'Indirect Expenses', '0', '-60000.00', ''],
].map(([name, parent, ob, cb, gstin], i) => ({ guid: guid('1ed6e700', i + 1), name, parent, ob, cb, gstin, alter: nextAlter() }));

let vchNo = 0;
const vouchers = [];
function addVoucher(date, type, party, lines, narration) {
  vchNo++;
  vouchers.push({ guid: guid('70c4e700', vchNo), date, type, number: String(vchNo), party, lines, narration, alter: nextAlter() });
}
const sale = (d, party, base) => addVoucher(d, 'Sales', party,
  [[party, -(base * 1.18)], ['Sales @ 18%', base], ['Output IGST', base * 0.18]], `Invoice to ${party}`);
sale('20240405', 'Sharma Retail', 20000);
sale('20240418', 'Gupta & Sons', 10000);
addVoucher('20240420', 'Purchase', 'Mehta Suppliers',
  [['Mehta Suppliers', 59000], ['Purchase @ 18%', -50000], ['Input IGST', -9000]], 'Stock purchase');
addVoucher('20240430', 'Payment', 'HDFC Bank', [['Rent', -20000], ['HDFC Bank', 20000]], 'Rent April');
addVoucher('20240502', 'Receipt', 'HDFC Bank', [['HDFC Bank', -23600], ['Sharma Retail', 23600]], 'NEFT from Sharma');
for (let i = 0; i < 40; i++) sale(`202406${String((i % 28) + 1).padStart(2, '0')}`, i % 2 ? 'Gupta & Sons' : 'Sharma Retail', 1000 + i * 250);

// ── request handling ─────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tag = (t, v, type = 'String') => `<${t} TYPE="${type}">${esc(v)}</${t}>`;
const wrap = (inner) => `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`;

function respond(xml) {
  const type = (xml.match(/<TYPE>(Company|Ledger|Voucher)<\/TYPE>/) || [])[1];
  const current = (xml.match(/<SVCURRENTCOMPANY>([^<]*)<\/SVCURRENTCOMPANY>/) || [])[1];
  const fetch = (xml.match(/<FETCH>([^<]*)<\/FETCH>/) || [])[1] || '';
  if (type !== 'Company' && current && current.replace(/&amp;/g, '&') !== company.name) {
    return `<RESPONSE><LINEERROR>Could not set 'SVCurrentCompany' to '${current}'</LINEERROR></RESPONSE>`;
  }
  if (type === 'Company') {
    const altVch = Math.max(0, ...vouchers.map((v) => v.alter));
    const altMst = Math.max(0, ...ledgers.map((l) => l.alter));
    return wrap(`<COMPANY NAME="${esc(company.name)}">${tag('NAME', company.name)}${tag('GUID', company.guid)}`
      + `${tag('BOOKSFROM', company.booksFrom, 'Date')}${tag('ALTVCHID', altVch, 'Number')}${tag('ALTMSTID', altMst, 'Number')}</COMPANY>`);
  }
  if (type === 'Ledger') {
    return wrap(ledgers.map((l) => `<LEDGER NAME="${esc(l.name)}">${tag('NAME', l.name)}${tag('PARENT', l.parent)}`
      + `${tag('OPENINGBALANCE', l.ob, 'Amount')}${tag('CLOSINGBALANCE', l.cb, 'Amount')}`
      + (l.gstin ? tag('PARTYGSTIN', l.gstin) : '') + `${tag('GUID', l.guid)}${tag('ALTERID', l.alter, 'Number')}</LEDGER>`).join(''));
  }
  if (type === 'Voucher') {
    const gt = xml.match(/\$AlterID &gt; (\d+)/); const le = xml.match(/\$AlterID &lt;= (\d+)/);
    const lo = gt ? Number(gt[1]) : -1; const hi = le ? Number(le[1]) : Infinity;
    const rows = vouchers.filter((v) => v.alter > lo && v.alter <= hi);
    if (fetch.trim() === 'GUID') return wrap(rows.map((v) => `<VOUCHER>${tag('GUID', v.guid)}</VOUCHER>`).join(''));
    return wrap(rows.map((v) => `<VOUCHER VCHTYPE="${v.type}">${tag('DATE', v.date, 'Date')}${tag('VOUCHERTYPENAME', v.type)}`
      + `${tag('VOUCHERNUMBER', v.number)}${tag('PARTYLEDGERNAME', v.party)}${tag('NARRATION', v.narration)}`
      + `${tag('GUID', v.guid)}${tag('ALTERID', v.alter, 'Number')}${tag('ISCANCELLED', 'No', 'Logical')}${tag('ISOPTIONAL', 'No', 'Logical')}`
      + v.lines.map(([ledger, amt]) => `<ALLLEDGERENTRIES.LIST>${tag('LEDGERNAME', ledger)}${tag('AMOUNT', amt.toFixed(2), 'Amount')}</ALLLEDGERENTRIES.LIST>`).join('')
      + '</VOUCHER>').join(''));
  }
  return '<RESPONSE>Unknown Request, cannot be processed</RESPONSE>';
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const out = respond(body);
    const what = (body.match(/<ID>([^<]*)<\/ID>/) || [])[1];
    console.log(`${new Date().toISOString().slice(11, 19)} ${what || '?'} → ${out.length} chars`);
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end(out);
  });
}).listen(PORT, () => console.log(`Mock Tally on :${PORT} — "${company.name}", ${ledgers.length} ledgers, ${vouchers.length} vouchers. Commands: add | edit | del`));

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const cmd = l.trim();
  if (cmd === 'add') { sale('20240715', 'Sharma Retail', 5000); console.log(`added voucher #${vchNo} (AlterID ${alterSeq})`); }
  else if (cmd === 'edit' && vouchers[0]) {
    const v = vouchers[0]; v.lines = v.lines.map(([n, a]) => [n, a * 2]); v.alter = nextAlter();
    console.log(`edited voucher #${v.number} → AlterID ${v.alter}`);
  } else if (cmd === 'del') { const v = vouchers.pop(); console.log(`deleted voucher #${v && v.number}`); }
});

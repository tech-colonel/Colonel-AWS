/* ──────────────────────────────────────────────────────────────────────────────
   offdutyReceivablesParser.js — read the four kinds of file the Receivables
   Summary agent lives on, and flatten them into ONE row shape.

   NOTHING HERE TOUCHES THE AMAZON SETTLEMENT AGENT. It borrows that agent's
   shape — parse, store flat, summarise with live formulas — but Amazon reads a
   single settlement report with a fixed header, and this reads a hand-kept
   workbook per GST registration plus a payment reconciliation. Different files,
   different code, so the Amazon agent keeps working exactly as it does today.

   WHAT THE FILES ARE
     • SALES workbook, one per GSTIN (HR / KAR / MH), with the three tabs that
       carry Shopify order ids:
           "<STATE> (excl cancel)" or "<STATE> (delivered)"  → DELIVERED
           "Refund"                                          → REFUND
           "RTO last month" / "RTO March" / "RTO-March"      → RTO
       Every other tab (Nykaa, Myntra, Slikk, B2B, stores, pivots) is a different
       sales channel and is deliberately SKIPPED — see SKIP below.
     • PAYMENT reconciliation, one per month, one row per Shopify order, holding
       the five collector columns and what was actually remitted.

   TWO THINGS THAT WOULD BREAK A NAIVE READER
     1. The header is never on row 1. These workbooks carry a title, a period
        and a row of SUBTOTAL() formulas above the header, and the number of
        those rows differs per tab and per month. So the header is found BY
        CONTENT — the row that contains the columns the tab must have — never by
        index. (Same lesson as the MTR files, where three months had a totals
        row pasted above the header and reading line 1 dropped 1,682 rows.)
     2. An order can appear in TWO state workbooks when its lines shipped from
        two warehouses — 1,714 of them in April alone. Rows are returned as they
        are read; de-duplication is the caller's job, at order level, once.
   ────────────────────────────────────────────────────────────────────────────── */

const XLSX = require('xlsx');

/* Tabs that belong to another sales channel. The agent is Shopify-only: these
   carry no Shopify order id, so they could never join to the payment sheet. */
const SKIP = /nykaa|myntra|slikk|sprintpro|blockpool|b2b|store|sales\s*summary|^final$|^reco$|^sheet\d*$|reverse|^hsn/i;

const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();

/* Which of the three tabs is this? Returns null for anything we do not read. */
function tabKind(name) {
  const n = norm(name);
  if (SKIP.test(n)) return null;
  if (/\(\s*excl\s*cancel\s*\)|\(\s*delivered\s*\)/.test(n)) return 'DELIVERED';
  if (/^refund/.test(n)) return 'REFUND';
  if (/\brto\b|^rto|rto$/.test(n)) return 'RTO';
  return null;
}

/* The columns a tab MUST have. Used to find the header row, and to refuse a tab
   whose shape we do not recognise rather than read it wrong. */
const REQUIRED = {
  DELIVERED: [['order id'], ['order total']],
  RTO:       [['order id'], ['order total']],
  REFUND:    [['order_number', 'order number'], ['refunded_amount', 'refunded amount']],
  PAYMENT:   [['order id'], ['remited amount', 'remitted amount']],
};

/* Find the header by content: the first row within the first 15 that carries
   every required column. Returns {headerRow, index} or null. */
function findHeader(rows, kind) {
  const need = REQUIRED[kind];
  const limit = Math.min(rows.length, 15);
  for (let r = 0; r < limit; r++) {
    const cells = (rows[r] || []).map(norm);
    const ok = need.every((alts) => alts.some((a) => cells.includes(a)));
    if (ok) {
      const index = {};      // first occurrence
      const last = {};       // last occurrence — see pickLast
      cells.forEach((c, i) => { if (c) { if (index[c] === undefined) index[c] = i; last[c] = i; } });
      return { at: r, index, last };
    }
  }
  return null;
}

/* Read a value by any of several header spellings. */
const pick = (row, index, ...names) => {
  for (const n of names) {
    const i = index[norm(n)];
    if (i !== undefined) {
      const v = row[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return null;
};

/* The delivered and RTO tabs carry TWO columns called "Order Total": an early
   one (net of shipping/discount, used for the courier) and a later one sitting
   immediately before Tax Rate / Taxable Value. Only the later one satisfies
   total = taxable + tax, and only it reconciles to the Sales Summary the
   workbook itself prints. Reading the first would understate every state by
   lakhs, silently. So these two tabs read the LAST occurrence, deliberately. */
const pickLast = (row, h, ...names) => {
  for (const n of names) {
    const i = h.last[norm(n)];
    if (i !== undefined) {
      const v = row[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return null;
};

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/* Order ids are integers everywhere, but arrive as 864312, "864312" and
   864312.0 depending on which tool last wrote the file. One canonical form. */
const orderId = (v) => {
  const n = num(v);
  if (n === null || !Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i > 0 ? String(i) : null;
};

const asDate = (v) => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (typeof v === 'number') {
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, Math.floor(d.S || 0)));
  }
  const s = text(v);
  if (!s || s === '-') return null;
  const d = new Date(s.replace(/(\d)(st|nd|rd|th)\b/gi, '$1'));
  return Number.isNaN(d.getTime()) ? null : d;
};

const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);
const period = (d) => (d ? d.toISOString().slice(0, 7) : null);

/* Which GST registration does this workbook belong to? The filename carries it
   ("...April 25_KAR.xlsx"); the rows carry it too, so the filename is only a
   fallback when a row does not say. */
function entityOf(filename) {
  /* "...April 25_KAR.xlsx" — the separator is an underscore, which IS a word
     character, so \b never fires there. Split on non-letters instead. */
  const parts = norm(filename).split(/[^a-z]+/).filter(Boolean);
  if (parts.includes('kar') || parts.includes('karnataka')) return 'KAR';
  if (parts.includes('mh') || parts.includes('maharashtra')) return 'MH';
  if (parts.includes('hr') || parts.includes('haryana')) return 'HR';
  return null;
}

const ENTITY_FROM_SELLER = (v) => {
  const n = norm(v);
  if (!n) return null;
  if (/har/.test(n)) return 'HR';
  if (/kar/.test(n)) return 'KAR';
  if (/mah|mh/.test(n)) return 'MH';
  return null;
};

/* ── the three sales tabs ──────────────────────────────────────────────────── */

function readDelivered(rows, h, entity, tab) {
  const out = [];
  for (let r = h.at + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const id = orderId(pick(row, h.index, 'order id'));
    if (!id) continue;
    const od = asDate(pick(row, h.index, 'order date'));
    out.push({
      source_kind: 'DELIVERED', source_tab: tab,
      entity: ENTITY_FROM_SELLER(pick(row, h.index, 'gstn seller')) || entity,
      order_id: id,
      order_date: iso(od),
      period: period(od) || period(asDate(pick(row, h.index, 'sales month'))),
      shipping_state: text(pick(row, h.index, 'shipping province', 'state')),
      sku: text(pick(row, h.index, 'sku')),
      product_name: text(pick(row, h.index, 'product name')),
      qty: num(pick(row, h.index, 'qty', 'quantity')),
      order_total: num(pickLast(row, h, 'order total')),
      tax_rate: num(pick(row, h.index, 'tax rate', 'rate')),
      taxable_value: num(pick(row, h.index, 'taxable value')),
      tax_amount: num(pick(row, h.index, 'tax amount')),
      cgst: num(pick(row, h.index, 'cgst')),
      sgst: num(pick(row, h.index, 'sgst')),
      igst: num(pick(row, h.index, 'igst')),
      order_status: text(pick(row, h.index, 'order status')),
    });
  }
  return out;
}

function readRefund(rows, h, entity, tab) {
  const out = [];
  for (let r = h.at + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const id = orderId(pick(row, h.index, 'order_number', 'order number'));
    if (!id) continue;
    const rd = asDate(pick(row, h.index, 'refunded_at', 'refunded at'));
    out.push({
      source_kind: 'REFUND', source_tab: tab, entity,
      order_id: id,
      refunded_at: iso(rd),
      period: period(rd),
      shipping_state: text(pick(row, h.index, 'state')),
      qty: num(pick(row, h.index, 'item_quantity', 'item quantity')),
      order_total: num(pick(row, h.index, 'item_price', 'item price')),
      refunded_amount: num(pick(row, h.index, 'refunded_amount', 'refunded amount')),
      refund_status: text(pick(row, h.index, 'refund_status', 'refund status')),
      refund_mode: text(pick(row, h.index, 'actual_refund_mode', 'actual refund mode')),
      tax_rate: num(pick(row, h.index, 'rate')),
      taxable_value: num(pick(row, h.index, 'taxable')),
      tax_amount: num(pick(row, h.index, 'tax')),
      cgst: num(pick(row, h.index, 'cgst')),
      sgst: num(pick(row, h.index, 'sgst')),
      igst: num(pick(row, h.index, 'igst')),
      order_status: text(pick(row, h.index, 'order status')),
      sales_month: text(pick(row, h.index, 'month')),
    });
  }
  return out;
}

function readRto(rows, h, entity, tab) {
  const out = [];
  for (let r = h.at + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const id = orderId(pick(row, h.index, 'order id'));
    if (!id) continue;
    const od = asDate(pick(row, h.index, 'order date'));
    const rd = asDate(pick(row, h.index, 'rto inititated/delivered date', 'rto inititated date',
                                        'rto initiated date', 'rto inititated/deliv'));
    out.push({
      source_kind: 'RTO', source_tab: tab, entity,
      order_id: id,
      order_date: iso(od),
      rto_date: iso(rd),
      /* An RTO belongs to the month it CAME BACK, not the month it was sold —
         that is the whole reason this tab exists in next month's workbook. */
      period: period(rd) || period(od),
      sales_month: text(pick(row, h.index, 'sales month')),
      rto_month: text(pick(row, h.index, 'month of rto')),
      shipping_state: text(pick(row, h.index, 'shipping province')),
      qty: num(pick(row, h.index, 'qty', 'quantity')),
      product_name: text(pick(row, h.index, 'product name')),
      order_total: num(pickLast(row, h, 'order total')),
      tax_rate: num(pick(row, h.index, 'tax rate')),
      taxable_value: num(pick(row, h.index, 'taxable value')),
      tax_amount: num(pick(row, h.index, 'tax amount')),
      cgst: num(pick(row, h.index, 'cgst')),
      sgst: num(pick(row, h.index, 'sgst')),
      igst: num(pick(row, h.index, 'igst')),
      order_status: text(pick(row, h.index, 'order status')),
      gst_status: text(pick(row, h.index, 'gst status')),
      shipping_aggregator: text(pick(row, h.index, 'payment reco')),
    });
  }
  return out;
}

/* ── the payment reconciliation ────────────────────────────────────────────── */

function readPayment(rows, h, tab) {
  const out = [];
  for (let r = h.at + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const id = orderId(pick(row, h.index, 'order id'));
    if (!id) continue;
    const od = asDate(pick(row, h.index, 'order date'));

    /* Five collectors. Rebuilding the remittance from these is the first of the
       two checks — the sheet never trusts the stated total on its own. */
    const cashfree  = num(pick(row, h.index, 'cashfree')) || 0;
    const billdesk  = num(pick(row, h.index, 'bill desk')) || 0;
    const bdExch    = num(pick(row, h.index, 'bill desk with exchange')) || 0;
    const rzpExch   = num(pick(row, h.index, 'razorpay with exchange')) || 0;
    const shiprocket = num(pick(row, h.index, 'shiprockt_apr__', 'shiprocket', 'shiprockt')) || 0;

    out.push({
      source_kind: 'PAYMENT', source_tab: tab, entity: null,
      order_id: id,
      order_date: iso(od),
      period: period(od),
      order_total: num(pick(row, h.index, 'order total')),
      financial_status: text(pick(row, h.index, 'financial status')),
      order_status: text(pick(row, h.index, 'order status')),
      shipping_state: text(pick(row, h.index, 'shipping state')),
      pickup_state: text(pick(row, h.index, 'pickup state')),
      payment_method: text(pick(row, h.index, 'payment method')),
      shipping_aggregator: text(pick(row, h.index, 'shipping aggregator')),
      collector: text(pick(row, h.index, 'actual as per sales')),
      cashfree, billdesk, billdesk_exchange: bdExch,
      razorpay_exchange: rzpExch, shiprocket,
      collectors_total: Number((cashfree + billdesk + bdExch + rzpExch + shiprocket).toFixed(2)),
      remitted_amount: num(pick(row, h.index, 'remited amount', 'remitted amount')),
      difference: num(pick(row, h.index, 'difference')),
      remarks: text(pick(row, h.index, 'remarks')),
      utr_id: text(pick(row, h.index, 'utr id')),
      payment_date: iso(asDate(pick(row, h.index, 'date of payment'))),
      deposit_date: iso(asDate(pick(row, h.index, 'date of deposit in bank'))),
      delivered_date: iso(asDate(pick(row, h.index, 'delivered date'))),
      rto_date: iso(asDate(pick(row, h.index, 'rto inititated date', 'rto initiated date'))),
      cancelled_at: iso(asDate(pick(row, h.index, 'cancelled at'))),
      discount_amount: num(pick(row, h.index, 'discount amount')),
    });
  }
  return out;
}

/* ── entry point ───────────────────────────────────────────────────────────── */

/**
 * Parse one uploaded workbook.
 * Returns { kind, entity, rows, tabs, skipped } — `tabs` says what was read and
 * how many rows came out of each, so the workspace can show it rather than the
 * user having to trust a single number.
 */
function parseReceivablesFile(buffer, filename) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const entity = entityOf(filename);
  const rows = [];
  const tabs = [];
  const skipped = [];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: true });
    /* sheet_to_json starts at the sheet's used range, not at row 1 — these
       workbooks all leave row 1 empty, so without this offset every header row
       we report would be one out, and an accountant checking it would not find
       it where we said. */
    const origin = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r : 0;
    const excelRow = (i) => origin + i + 1;
    if (!grid.length) { skipped.push({ tab: name, why: 'empty' }); continue; }
    /* blankrows:true is deliberate — it keeps grid index == Excel row - 1, so the
       header row we report is the row an accountant will actually find. */

    /* A payment file is recognised by its columns, not its name — the sheet is
       just called "Final", which says nothing. */
    const payHeader = findHeader(grid, 'PAYMENT');
    if (payHeader) {
      const got = readPayment(grid, payHeader, name);
      rows.push(...got);
      tabs.push({ tab: name, kind: 'PAYMENT', headerRow: excelRow(payHeader.at), rows: got.length });
      continue;
    }

    /* The raw Shopify order export is a reasonable thing to hand this agent,
       so say what it is rather than "unrecognised tab". It is not needed: the
       payment reconciliation already carries one row per Shopify order, and its
       Order Total column sums to the same rupee as Shopify's own Total. */
    const first = (grid[0] || []).map(norm);
    if (first.includes('lineitem sku') && first.includes('financial status')) {
      skipped.push({ tab: name, why: 'this is the raw Shopify order export — not needed, the payment '
                                   + 'reconciliation already carries every one of these orders' });
      continue;
    }

    const kind = tabKind(name);
    if (!kind) {
      const n = norm(name);
      const why = /sales\s*summary|^final$|^reco$|^sheet\d*$/.test(n)
        ? 'a summary or pivot of the tabs above, not a source of order rows'
        : 'belongs to another sales channel — no Shopify order id to join on';
      skipped.push({ tab: name, why });
      continue;
    }

    const h = findHeader(grid, kind);
    if (!h) { skipped.push({ tab: name, why: `no ${kind} header found in first 15 rows` }); continue; }

    const got = kind === 'DELIVERED' ? readDelivered(grid, h, entity, name)
              : kind === 'REFUND'    ? readRefund(grid, h, entity, name)
              :                        readRto(grid, h, entity, name);
    rows.push(...got);
    tabs.push({ tab: name, kind, headerRow: excelRow(h.at), rows: got.length });
  }

  const kinds = new Set(tabs.map((t) => t.kind));
  return {
    kind: kinds.has('PAYMENT') ? 'PAYMENT' : 'SALES',
    entity,
    rows,
    tabs,
    skipped,
  };
}

module.exports = { parseReceivablesFile, tabKind, findHeader, entityOf, orderId, asDate };

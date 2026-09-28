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
  PAYMENT:   [['order id'], ['remited amount', 'remitted amount']],   // both spellings seen
  /* the second format: All_Data, keyed on columns the subsets also carry — so
     the TAB NAME decides which one is read, see parseReceivablesFile */
  PAYMENT2:  [['order number'], ['selling price'], ['final status']],
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

/* Read a value by a REGEX over the header names. The payment file's COD column
   is named for its month — "Shiprockt_APR__" — so an exact match works for one
   month and silently returns zero for every other, which would make every COD
   order look unpaid. Anything whose header varies by month must be matched by
   pattern, never by spelling. */
const pickRe = (row, h, re) => {
  for (const [name, i] of Object.entries(h.index)) {
    if (!re.test(name)) continue;
    const v = row[i];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};

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

/* Excel writes an empty date cell as serial 0, which decodes to 1899-12-30, and
   some exports round-trip that through epoch as 1970-01-01. Both mean BLANK.
   7,571 rows of the April payment file carry one, and treating them as real
   dates would put a third of the book in the wrong period. */
const REAL_DATE_FLOOR = 2000;

const asDate = (v) => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.getFullYear() < REAL_DATE_FLOOR ? null : v;
  }
  if (typeof v === 'number') {
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d && d.y >= REAL_DATE_FLOOR) {
      return new Date(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, Math.floor(d.S || 0));
    }
    return null;
  }
  const s0 = text(v);
  if (!s0 || s0 === '-') return null;
  /* The refund tab writes dates as
       "Sat April 5th 2025, 10:00:39 (GMT+05:30) Asia/Kolkata"
     — ordinal suffix, and a trailing zone label that Date() cannot parse, so
     the whole value came back null and every refund fell out of its month. */
  const s = s0.replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/\s*\(GMT[^)]*\).*$/i, '').trim();

  /* DAY FIRST. 2,062 of August's delivery dates are text in DD-MM-YYYY, and
     Date() reads that as MM-DD: "07-09-2025" is 7 September and came back as
     9 July, while "16-09-2025" has no 16th month and came back as nothing at
     all. The 16 is what proves the format is day-first, so it is parsed
     explicitly rather than handed to Date(). */
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    const [, D, M, Y, hh, mm, ss] = dmy.map((x) => (x === undefined ? x : x));
    const day = Number(D), mon = Number(M);
    /* if the first number cannot be a month it is certainly the day; if both
       could be either, this data is day-first, which the 16-09 rows settle */
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      const dt = new Date(Number(Y), mon - 1, day,
                          Number(hh || 0), Number(mm || 0), Number(ss || 0));
      return Number.isNaN(dt.getTime()) || dt.getFullYear() < REAL_DATE_FLOOR ? null : dt;
    }
    return null;
  }

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.getFullYear() < REAL_DATE_FLOOR ? null : d;
};

/* DATES ARE READ AS SERIALS, NOT AS Date OBJECTS — see parseReceivablesFile,
   which deliberately does NOT pass cellDates. Asked for a Date, SheetJS converts
   the serial through UTC and lands ten seconds short: a payment stored as
   1 May 2025 came back as 2025-04-30T18:29:50Z, which is 23:59:50 on the 30th in
   IST. That moved 148 payments out of May into April and understated the April
   receivable by 2.6 lakh. SSF.parse_date_code reads the calendar fields straight
   off the serial with no timezone in the path at all.
   These formatters therefore work in local fields, matching how asDate builds. */
const pad2 = (n) => String(n).padStart(2, '0');
const iso = (d) => (d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : null);
const period = (d) => (d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` : null);

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
      /* The registration is the WORKBOOK's, not the row's. Each workbook is one
         registration's GSTR-1 working and its own Sales Summary is cast on that
         basis; reading the row-level "GSTN Seller" instead moved a handful of
         lines between registrations and put every state out by a few rupees
         against the accountant's own figures. The seller value is kept
         separately for reference. */
      entity,
      gstn_seller: text(pick(row, h.index, 'gstn seller')),
      seller_entity: ENTITY_FROM_SELLER(pick(row, h.index, 'gstn seller')),
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
      /* THE SALES TAB CARRIES RTO ROWS TOO, and says so in two columns.
         A month's sheet is named either "<STATE> (delivered)" — already
         filtered — or "<STATE> (excl cancel)", which holds every status.
         "GST status" marks the RTO rows and "Month Of RTO" says when they came
         back. An RTO that came back in the SAME month it was sold belongs to
         this month's RTO; one that came back later appears in the next month's
         "RTO <prev month>" tab instead. Reading the tab without these two
         columns understated March's RTO by 20 lakh a state. */
      gst_status: text(pick(row, h.index, 'gst status')),
      rto_month: text(pick(row, h.index, 'month of rto')),
      sales_month: text(pick(row, h.index, 'sales month')),
      delivered_date: iso(asDate(pick(row, h.index, 'delivered date'))),
    });
  }
  return out;
}

/* "april" -> "2025-04", using a nearby real date to fix the year. */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
                'august', 'september', 'october', 'november', 'december'];
function monthNameToPeriod(name, nearDate) {
  if (!name) return null;
  const i = MONTHS.indexOf(String(name).trim().toLowerCase());
  if (i < 0) return null;
  const y = nearDate ? nearDate.getFullYear() : new Date().getFullYear();
  /* a refund in January against a December order belongs to the NEXT year */
  const yr = (nearDate && nearDate.getMonth() === 11 && i === 0) ? y + 1 : y;
  return `${yr}-${String(i + 1).padStart(2, '0')}`;
}

function readRefund(rows, h, entity, tab) {
  const out = [];
  for (let r = h.at + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const id = orderId(pick(row, h.index, 'order_number', 'order number'));
    if (!id) continue;
    const rd = asDate(pick(row, h.index, 'refunded_at', 'refunded at'));
    const od0 = rd || asDate(pick(row, h.index, 'order date'));
    out.push({
      source_kind: 'REFUND', source_tab: tab, entity,
      order_id: id,
      refunded_at: iso(rd),
      /* The month the refund belongs to. The date first; the workbook's own
         "Month" column as a fallback, so a date format we have not met yet
         cannot silently drop a refund out of every month. */
      period: period(rd) || monthNameToPeriod(text(pickLast(row, h, 'month')), od0),
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
      /* TWO columns are headed "Month": the first is the month the order was
         placed, the second the month it was refunded. The refund belongs to the
         second — taking the first put every refund in the wrong period. */
      sales_month: text(pick(row, h.index, 'month')),
      refund_month: text(pickLast(row, h, 'month')),
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
    const cashfree  = num(pickRe(row, h, /^cashfree$/)) || 0;
    const billdesk  = num(pickRe(row, h, /^bill\s*desk$/)) || 0;
    const bdExch    = num(pickRe(row, h, /^bill\s*desk.*exchange/)) || 0;
    const rzpExch   = num(pickRe(row, h, /^razorpay.*exchange/)) || 0;
    /* Shiprockt_APR__, Shiprockt_MAY__, Shiprocket_JUN, and the correct
       spelling Shiprocket — month-suffixed AND inconsistently spelled. */
    const shiprocket = num(pickRe(row, h, /^shiproc/)) || 0;

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

/* ── the payment reconciliation, SECOND format ─────────────────────────────
   From July 2025 the payment file changed shape entirely. Instead of one
   "Final" sheet with a Remitted Amount per order, it carries "All_Data" (every
   line item) plus "Prepaid", "COD" and "Unfulfilled", which are SUBSETS of it,
   and a "Summary" pivot. Reading the subsets as well would count the same money
   two or three times, so only All_Data is read.

   There is no remittance amount in this format. Collection is stated as a
   STATUS per order — Prepaid Status (Success / Simpl / Failed / Not Found /
   Refunded / Partially Refunded) and COD Status (Received / Not Received) — so
   "collected" is the invoice value of the orders those columns mark as settled.

   Verified against the file's own Summary tab: August delivered 37,549 orders
   and Rs 6,20,79,896, to the rupee. And against the GSTR-1 workbooks for the
   same month, 0.1% apart, which is what says Selling Price is the invoice
   value — the same basis as the old format's Order Total. */

const WAREHOUSE_ENTITY = (v) => {
  const n = norm(v);
  if (!n) return null;
  if (/har|hr\b/.test(n)) return 'HR';
  if (/bangalore|bengaluru|\bka\b|kar/.test(n)) return 'KAR';
  if (/vasai|\bmh\b|mah/.test(n)) return 'MH';
  return null;
};

/* Which prepaid/COD statuses mean the money came in. "Refunded" and "Partially
   Refunded" ARE collected — the customer paid and was refunded; that is a
   return, not a sum still owed, and it is reported on the returns side. */
const PREPAID_SETTLED = /^(success|simpl|refunded|partially\s*refunded)$/;
const COD_SETTLED = /^received$/;

function readPaymentV2(rows, h, tab) {
  const out = [];
  for (let r = h.at + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const id = orderId(pick(row, h.index, 'order number'));
    if (!id) continue;
    const od = asDate(pick(row, h.index, 'order date'));
    const value = num(pick(row, h.index, 'selling price')) || 0;
    const prepaid = norm(pick(row, h.index, 'prepaid status'));
    const cod = norm(pick(row, h.index, 'cod status'));
    const settled = PREPAID_SETTLED.test(prepaid) || COD_SETTLED.test(cod);
    const method = text(pick(row, h.index, 'payment method'));

    out.push({
      source_kind: 'PAYMENT', source_tab: tab,
      entity: WAREHOUSE_ENTITY(pick(row, h.index, 'warehouse name')),
      order_id: id,
      order_date: iso(od),
      period: period(od),
      order_total: value,
      financial_status: text(pick(row, h.index, 'financial status')),
      /* Final Status is the settled one — Delivered / RTO / Cancelled / Lost /
         Pending. Refined Shipping Status collapses it to three, and its
         "Pending" is what tells us an order never arrived. */
      order_status: text(pick(row, h.index, 'final status'))
                 || text(pick(row, h.index, 'order status')),
      gst_status: text(pick(row, h.index, 'refined shipping status')),
      collector: method,
      sku: text(pick(row, h.index, 'product sku')),
      qty: num(pick(row, h.index, 'product quantity')),
      /* one bucket, named by the partner — the five fixed columns of the old
         format do not exist here */
      cashfree: /cashfree/.test(norm(method)) && settled ? value : 0,
      billdesk: /billdesk/.test(norm(method)) && settled ? value : 0,
      billdesk_exchange: 0,
      razorpay_exchange: /razorpay|simpl/.test(norm(method)) && settled ? value : 0,
      shiprocket: /cash on delivery|\bcod\b/.test(norm(method)) && settled ? value : 0,
      collectors_total: settled ? value : 0,
      remitted_amount: settled ? value : 0,
      difference: settled ? 0 : value,
      remarks: settled ? null : `${prepaid || cod || 'no status'}`,
      delivered_date: iso(asDate(pick(row, h.index, 'order delivered date'))),
      rto_date: iso(asDate(pick(row, h.index, 'rto delivered date', 'rto initiated date'))),
      payment_date: null,      // this format records none
      deposit_date: null,
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
  const wb = XLSX.read(buffer, { type: 'buffer' });   // NOT cellDates — see iso() above
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

    /* The second payment format: Prepaid, COD and Unfulfilled are SUBSETS of
       All_Data and carry the same columns, so the tab name — not the columns —
       has to decide. Reading all four would count the same money three times. */
    if (/^all[_\s]*data$/i.test(String(name).trim())) {
      const h2 = findHeader(grid, 'PAYMENT2');
      if (h2) {
        const got = readPaymentV2(grid, h2, name);
        rows.push(...got);
        tabs.push({ tab: name, kind: 'PAYMENT', headerRow: excelRow(h2.at), rows: got.length });
        continue;
      }
    }
    if (/^(prepaid|cod|unfulfilled|summary|sheet\d*)$/i.test(String(name).trim())
        && findHeader(grid, 'PAYMENT2')) {
      skipped.push({ tab: name, why: 'a subset of All_Data — reading it too would count the same '
                                   + 'money twice' });
      continue;
    }

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

/* ──────────────────────────────────────────────────────────────────────────────
   amazonReports.js — the SP-API Reports lifecycle, end to end.

   Almost everything an accountant needs from Amazon arrives as a REPORT, not as
   a list endpoint, and reports are asynchronous:

       createReport → poll getReport until DONE → getReportDocument → download
       from a presigned S3 URL → gunzip → parse TSV

   Two behaviours here exist because they are easy to get wrong and expensive to
   discover late:

   1. SETTLEMENT REPORTS ARE NOT CREATED. Amazon generates them on its own
      fortnightly schedule. Calling createReport for one fails. You LIST what
      already exists (listReports) and fetch those. This is the single most
      common SP-API mistake and it is why fetchSettlementReports() is a separate
      function rather than a report type passed to fetchReport().

   2. THE DOCUMENT URL IS PRESIGNED AND UNAUTHENTICATED. Sending our
      x-amz-access-token to it makes S3 reject the request. It is downloaded with
      no auth header at all, and it expires in ~5 minutes.

   Downloads are streamed to disk and gunzipped on the way through — Koparo-scale
   order reports run to hundreds of thousands of rows, and buffering one in memory
   is exactly the synchronous-work stall that has darkened the site before.
   ────────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const readline = require('readline');

const client = require('./amazonClient');

const API = '/reports/2021-06-30';

/* ── The reports we actually use ────────────────────────────────────────────────
   `role` records WHY a type might return 403, so a failure is self-explaining.
   The two GST types are listed but gated: they need the restricted Tax Invoicing
   role, which this app does not hold yet. They are here so that the day the role
   is granted, nothing needs to be written — only the gate flips. */
const REPORT_TYPES = {
  ORDERS_BY_ORDER_DATE: {
    type: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
    role: 'Inventory and Order Tracking',
    label: 'All orders by order date',
    maxWindowDays: 30,
  },
  ORDERS_BY_LAST_UPDATE: {
    type: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
    role: 'Inventory and Order Tracking',
    label: 'All orders by last update',
    maxWindowDays: 30,
  },
  SETTLEMENT_V2: {
    type: 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
    role: 'Finance and Accounting',
    label: 'Settlement report (flat file V2)',
    scheduledOnly: true,          // ← cannot be created; see fetchSettlementReports
  },
  FBA_REIMBURSEMENTS: {
    type: 'GET_FBA_REIMBURSEMENTS_DATA',
    role: 'Amazon Fulfillment',
    label: 'FBA reimbursements',
  },
  FBA_ESTIMATED_FEES: {
    type: 'GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA',
    role: 'Amazon Fulfillment',
    label: 'FBA estimated fees',
  },
  LEDGER_SUMMARY: {
    type: 'GET_LEDGER_SUMMARY_VIEW_DATA',
    role: 'Inventory and Order Tracking',
    label: 'Inventory ledger summary',
  },
  /* ── restricted: needs Tax Invoicing (not granted today) ── */
  GST_MTR_B2B: {
    type: 'GET_GST_MTR_B2B_CUSTOM',
    role: 'Tax Invoicing (RESTRICTED)',
    label: 'GST merchant tax report — B2B',
    restricted: true,
  },
  GST_MTR_B2C: {
    type: 'GET_GST_MTR_B2C_CUSTOM',
    role: 'Tax Invoicing (RESTRICTED)',
    label: 'GST merchant tax report — B2C',
    restricted: true,
  },
};

const TERMINAL_OK = 'DONE';
const TERMINAL_BAD = ['CANCELLED', 'FATAL'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── low-level calls ────────────────────────────────────────────────────────── */

/** Ask Amazon to build a report. Returns { reportId }. */
async function createReport(brandId, reportType, { dataStartTime, dataEndTime, marketplaceIds, conn } = {}) {
  const c = conn || await client.resolve(brandId);
  const body = {
    reportType,
    marketplaceIds: marketplaceIds || [c.marketplaceId],
  };
  if (dataStartTime) body.dataStartTime = new Date(dataStartTime).toISOString();
  if (dataEndTime)   body.dataEndTime   = new Date(dataEndTime).toISOString();
  const json = await client.request(brandId, `${API}/reports`, { method: 'POST', body, conn: c });
  return json;                                  // { reportId }
}

/** Current state of one report. */
async function getReport(brandId, reportId, conn = null) {
  return client.request(brandId, `${API}/reports/${encodeURIComponent(reportId)}`, { conn });
}

/**
 * List reports Amazon already holds. The only way to reach settlement reports,
 * and a cheap way to reuse a report someone else already generated.
 */
async function listReports(brandId, { reportTypes, processingStatuses, createdSince, createdUntil, pageSize = 100, nextToken, conn } = {}) {
  const query = nextToken
    ? { nextToken }
    : {
        reportTypes: Array.isArray(reportTypes) ? reportTypes : [reportTypes],
        processingStatuses: processingStatuses || ['DONE'],
        pageSize,
        ...(createdSince ? { createdSince: new Date(createdSince).toISOString() } : {}),
        ...(createdUntil ? { createdUntil: new Date(createdUntil).toISOString() } : {}),
      };
  return client.request(brandId, `${API}/reports`, { query, conn });
}

/** Metadata for a finished report's document: the presigned url + compression. */
async function getReportDocument(brandId, reportDocumentId, conn = null) {
  return client.request(brandId, `${API}/documents/${encodeURIComponent(reportDocumentId)}`, { conn });
}

/* ── polling ────────────────────────────────────────────────────────────────── */
/**
 * Wait for a report to finish.
 *
 * Amazon gives no completion signal, so this polls. The interval starts at 5s
 * and eases to 30s: most reports are ready inside a minute, but a year of orders
 * can take many minutes and hammering it just earns a 429.
 */
async function waitForReport(brandId, reportId, { timeoutMs = 15 * 60_000, conn = null, onTick = null } = {}) {
  const startedAt = Date.now();
  let interval = 5_000;

  for (;;) {
    const r = await getReport(brandId, reportId, conn);
    const status = r?.processingStatus;
    if (onTick) { try { onTick(status, r); } catch (_) {} }

    if (status === TERMINAL_OK) return r;                        // has reportDocumentId
    if (TERMINAL_BAD.includes(status)) {
      const err = new Error(
        status === 'CANCELLED'
          ? 'Amazon cancelled this report — usually means there is no data for the period requested.'
          : 'Amazon failed to generate this report (FATAL).'
      );
      err.status = 502;
      err.code = `AMAZON_REPORT_${status}`;
      throw err;
    }

    if (Date.now() - startedAt > timeoutMs) {
      const err = new Error(`Amazon report ${reportId} was still ${status} after ${Math.round(timeoutMs / 60000)} minutes.`);
      err.status = 504;
      err.code = 'AMAZON_REPORT_TIMEOUT';
      err.reportId = reportId;         // caller can resume later rather than re-create
      throw err;
    }

    await sleep(interval);
    interval = Math.min(interval * 1.5, 30_000);
  }
}

/* ── download ───────────────────────────────────────────────────────────────── */
/**
 * Stream a report document to a local file, gunzipping if needed.
 *
 * NOTE the missing auth header — the URL is presigned and S3 rejects the request
 * if x-amz-access-token is attached. It also expires in about five minutes, so
 * fetch the document metadata immediately before downloading, never earlier.
 */
async function downloadDocument(doc, destPath) {
  const res = await fetch(doc.url);           // deliberately unauthenticated
  if (!res.ok || !res.body) {
    const err = new Error(`Could not download the Amazon report document (HTTP ${res.status}).`);
    err.status = 502;
    throw err;
  }
  const source = Readable.fromWeb(res.body);
  const out = fs.createWriteStream(destPath);
  if (String(doc.compressionAlgorithm).toUpperCase() === 'GZIP') {
    await pipeline(source, zlib.createGunzip(), out);
  } else {
    await pipeline(source, out);
  }
  return destPath;
}

function tmpPath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tsv`);
}

/* ── parsing ────────────────────────────────────────────────────────────────── */
/**
 * Amazon's flat files are tab-separated with a header row. Read line by line so
 * a 500 MB order report never lands in memory whole.
 *
 * Encoding: India's reports come back as UTF-8 in practice, but Amazon has
 * historically served Cp1252 for some marketplaces. We read as UTF-8 and strip a
 * BOM; a mojibake column name is the tell if that ever changes.
 */
async function parseTsvFile(filePath, { limit = null, onRow = null } = {}) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let headers = null;
  const rows = [];
  let count = 0;

  for await (const raw of rl) {
    const line = headers === null ? raw.replace(/^﻿/, '') : raw;
    if (!line.trim()) continue;

    const cells = line.split('\t');
    if (headers === null) {
      headers = cells.map((h) => h.trim());
      continue;
    }

    const row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = cells[i] ?? '';

    count++;
    if (onRow) { await onRow(row, count); }
    else {
      rows.push(row);
      if (limit && rows.length >= limit) { rl.close(); break; }
    }
  }

  return { headers: headers || [], rows, count };
}

/* ── high-level: one call, one report ───────────────────────────────────────── */
/**
 * Create → wait → download → parse. The everyday entry point.
 *
 * Returns { reportId, headers, rows, count, filePath }. `filePath` is kept so a
 * caller processing a large report can stream it again rather than hold rows;
 * pass `onRow` to avoid materialising rows at all.
 */
async function fetchReport(brandId, reportType, {
  dataStartTime, dataEndTime, limit = null, onRow = null, keepFile = false,
  timeoutMs, onTick, marketplaceIds,
} = {}) {
  const meta = Object.values(REPORT_TYPES).find((r) => r.type === reportType);
  if (meta?.scheduledOnly) {
    const err = new Error(
      `${reportType} is generated by Amazon on a schedule and cannot be created on demand. Use fetchSettlementReports().`
    );
    err.status = 400;
    throw err;
  }

  const conn = await client.resolve(brandId);
  const { reportId } = await createReport(brandId, reportType, { dataStartTime, dataEndTime, marketplaceIds, conn });
  const done = await waitForReport(brandId, reportId, { conn, timeoutMs, onTick });

  const doc = await getReportDocument(brandId, done.reportDocumentId, conn);
  const file = tmpPath(`amz-${reportType.toLowerCase()}`);
  await downloadDocument(doc, file);

  try {
    const parsed = await parseTsvFile(file, { limit, onRow });
    return { reportId, filePath: keepFile ? file : null, ...parsed };
  } finally {
    if (!keepFile) fs.promises.unlink(file).catch(() => {});
  }
}

/**
 * Settlement reports — the ones Amazon builds for us on its own schedule.
 *
 * There is no way to ask for a settlement covering a chosen period: you take the
 * fortnightly reports Amazon has already produced and filter by when they were
 * created. `since` therefore filters CREATION time, not the settlement period.
 */
async function fetchSettlementReports(brandId, { since, until, limit = 5, parse = true, rowLimit = null, ledgerDir = null } = {}) {
  const conn = await client.resolve(brandId);
  const list = await listReports(brandId, {
    reportTypes: [REPORT_TYPES.SETTLEMENT_V2.type],
    processingStatuses: ['DONE'],
    createdSince: since || new Date(Date.now() - 90 * 24 * 3600 * 1000),
    createdUntil: until || undefined,
    conn,
  });

  const reports = (list?.reports || []).slice(0, limit);
  if (!parse) return { reports };

  const out = [];
  for (const r of reports) {
    if (!r.reportDocumentId) continue;
    const doc = await getReportDocument(brandId, r.reportDocumentId, conn);
    const file = tmpPath('amz-settlement');
    await downloadDocument(doc, file);
    try {
      const parsed = await parseTsvFile(file, { limit: rowLimit });

      /* Keep the raw ledger when asked. Amazon's document quota is one call a
         minute, so anything we might want to re-read — a re-mapping, an audit,
         a dispute — must come from disk, not from Amazon a second time. */
      let ledgerPath = null;
      if (ledgerDir) {
        await fs.promises.mkdir(ledgerDir, { recursive: true });
        ledgerPath = path.join(ledgerDir, `settlement_ledger_${r.reportId}.tsv`);
        await fs.promises.copyFile(file, ledgerPath);
      }

      out.push({
        reportId: r.reportId,
        dataStartTime: r.dataStartTime,
        dataEndTime: r.dataEndTime,
        createdTime: r.createdTime,
        headers: parsed.headers,
        rows: parsed.rows,
        count: parsed.count,
        ledgerPath,
      });
    } finally {
      fs.promises.unlink(file).catch(() => {});
    }
  }
  return { reports: out };
}

module.exports = {
  REPORT_TYPES,
  createReport, getReport, listReports, getReportDocument,
  waitForReport, downloadDocument, parseTsvFile,
  fetchReport, fetchSettlementReports,
};

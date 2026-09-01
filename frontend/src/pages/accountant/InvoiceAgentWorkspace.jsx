import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Database,
  ExternalLink, FileText, Loader2, Maximize2, Pencil, Play, RefreshCw,
  Save, Search, Sheet, Sparkles, ThumbsDown, ThumbsUp, Trash2, X, Zap,
  Mail, UploadCloud, Inbox, FolderOpen
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import api, { API_URL } from '../../lib/api';
import PurchaseInvoicePanel from './PurchaseInvoicePanel';

// API_URL comes from lib/api's resolveApiUrl(): same-origin in production
// (agent.accountant), http://localhost:8001 only on local dev. The old hardcoded
// `process.env.REACT_APP_BACKEND_URL || 'http://localhost:8001'` fallback made the
// SSE status stream point at localhost on the live build → the live progress
// counter never connected (mixed-content/blocked). Using the shared base fixes it.

// ─── Maintenance mode ───────────────────────────────────────────────────────
// Temporarily pause the Invoice Process RUN trigger (the n8n webhook). Viewing,
// editing and approving already-extracted invoices stays fully usable. Flip
// INVOICE_MAINTENANCE back to false to re-enable processing.
const INVOICE_MAINTENANCE_ENABLED = true;
const INVOICE_LIVE_BRAND_IDS = [
  '546976a5-6ca5-42d1-8b7d-2c6379ffa221', // Koparo
  '759fd169-8a39-4351-a58a-f59cb71c7f25', // Nestroots
  '91b89bb0-fb8c-477e-824d-a3136e6cbce6', // Shumee Playroom
  'dd0107f5-f36a-4244-b7e0-c298a65d4e6a', // Urban Plant
  'a882ea99-5650-40be-9b6b-c28d99db131a', // Stroom
  'b6993834-0d8b-474e-910d-939c64e606e2', // Plenaire
  '6419fcf0-b961-4f48-a726-15c111bda75d', // Dichika
  '0515b238-265f-4273-8ccb-c16b77039e7f', // Biglilpeople
  'bbd59c4f-c164-42bd-90b8-0325cbb4e1b6', // M Brands
  '1db31f67-8d3f-4037-ba49-57406731ff38', // Zyden
  '52c5cf6f-851f-4deb-9ddf-998c5c43f20a', // Nailinit
  '31c807fc-8b33-4527-b1af-097be4949e63', // SpatialAI
];
const INVOICE_SHUMEE_TOYS_ID = '91c1a721-4b1d-46de-9cd1-361e179c878e';
const INVOICE_DRIVE_FOLDER_URL = 'https://drive.google.com/drive/folders/1hsv4GVpNiG6eIS2j8OybkaqNzaNOWi-C';
const INVOICE_MAINTENANCE_MSG = 'Invoice Process is under maintenance. Please feel free to use the other tools — this agent will be back shortly.';
const INVOICE_TOYS_MSG = 'Go to Shumee Playroom for invoice processing';

const T_BLUE = '#2563EB';
const T_BLUE_BG = '#EFF6FF';
const T_BORDER = '#E5E7EB';
const T_BORDER_LIGHT = '#F3F4F6';
const T_TEXT_PRIMARY = '#111827';
const T_TEXT_SECONDARY = '#6B7280';
const T_SUCCESS = '#10B981';
const T_DANGER = '#EF4444';
const T_WARNING = '#F59E0B';

const formatDate = (dateStr) => {
  if (!dateStr) return '—';
  try { return format(new Date(dateStr), 'dd MMM yyyy'); }
  catch { return dateStr; }
};

const toInputDate = (dateStr) => {
  if (!dateStr) return '';
  try { return format(new Date(dateStr), 'yyyy-MM-dd'); }
  catch { return ''; }
};

const money = (value) => {
  const number = Number(value || 0);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number.isFinite(number) ? number : 0);
};

const blank = (value) => value === null || value === undefined || String(value).trim() === '';
const num = (value) => Number(value || 0);
// Placeholder tokens the extractor writes when a field is empty — treat as missing.
const NA_TOKENS = new Set(['n/a', 'na', 'n.a.', 'missing', 'none', 'nil', '-', '—', 'null', 'undefined']);
const missingVal = (value) => blank(value) || NA_TOKENS.has(String(value).trim().toLowerCase());

const FIELD_SECTIONS = [
  {
    title: 'Vendor',
    fields: [
      { key: 'company', label: 'Vendor / Company', type: 'text', required: true },
      { key: 'seller_gstin', label: 'Seller GSTIN', type: 'text', required: true },
      { key: 'buyer_gstin', label: 'Buyer GSTIN', type: 'text', required: true },
    ],
  },
  {
    title: 'Invoice',
    fields: [
      { key: 'invoice_number', label: 'Invoice Number', type: 'text', required: true },
      { key: 'invoice_date', label: 'Invoice Date', type: 'date', required: true, display: formatDate },
      { key: 'due_date', label: 'Due Date', type: 'date', display: formatDate },
      { key: 'category', label: 'Category', type: 'text' },
    ],
  },
  {
    title: 'Line Item',
    fields: [
      { key: 'product_name', label: 'Product / Service', type: 'text' },
      { key: 'hsn_code', label: 'HSN Code', type: 'text' },
      { key: 'batch_no', label: 'Batch No', type: 'text' },
      { key: 'quantity', label: 'Quantity', type: 'number' },
      { key: 'unit', label: 'Unit', type: 'text' },
      { key: 'rate', label: 'Rate', type: 'number', display: money },
    ],
  },
  {
    title: 'GST',
    fields: [
      { key: 'cgst_rate', label: 'CGST Rate', type: 'number', suffix: '%' },
      { key: 'sgst_rate', label: 'SGST Rate', type: 'number', suffix: '%' },
      { key: 'igst_rate', label: 'IGST Rate', type: 'number', suffix: '%' },
      { key: 'cgst_amount', label: 'CGST Amount', type: 'number', display: money },
      { key: 'sgst_amount', label: 'SGST Amount', type: 'number', display: money },
      { key: 'igst_amount', label: 'IGST Amount', type: 'number', display: money },
    ],
  },
  {
    title: 'TDS',
    fields: [
      { key: 'tds_section', label: 'TDS Section', type: 'text' },
      { key: 'tds_rate', label: 'TDS Rate', type: 'number', suffix: '%' },
      { key: 'tds_amount', label: 'TDS Amount', type: 'number', display: money },
    ],
  },
  {
    title: 'Amounts',
    fields: [
      { key: 'taxable_value', label: 'Taxable Value', type: 'number', required: true, display: money },
      { key: 'gst_amount', label: 'Total GST', type: 'number', required: true, display: money },
      { key: 'status', label: 'Status', type: 'text' },
      { key: 'invoice_link', label: 'Original Invoice Link', type: 'url' },
    ],
  },
];

const EDITABLE_KEYS = FIELD_SECTIONS.flatMap((section) => section.fields.map((field) => field.key));

const getReviewIssues = (invoice) => {
  if (!invoice) return [];
  const issues = [];
  if (blank(invoice.company)) issues.push('Vendor missing');
  if (blank(invoice.invoice_number)) issues.push('Invoice number missing');
  if (blank(invoice.invoice_date)) issues.push('Invoice date missing');
  if (blank(invoice.seller_gstin)) issues.push('Seller GSTIN missing');
  if (blank(invoice.buyer_gstin)) issues.push('Buyer GSTIN missing');
  if (num(invoice.taxable_value) === 0) issues.push('Taxable value missing');
  if (num(invoice.gst_amount) === 0 && (num(invoice.cgst_amount) + num(invoice.sgst_amount) + num(invoice.igst_amount)) === 0) {
    issues.push('GST amount missing');
  }
  return issues;
};

const getInvoiceStatus = (invoice) => {
  const status = String(invoice?.status || 'Processed').trim();
  if (getReviewIssues(invoice).length > 0 && !['Approved', 'Disapproved', 'Corrupted', 'Invalid'].includes(status)) return 'Needs Review';
  return status || 'Processed';
};

const statusStyle = (status) => {
  if (status === 'Approved') return { background: '#ECFDF5', border: `1px solid #D1FAE5`, color: '#065F46' };
  if (status === 'Disapproved') return { background: '#FEF2F2', border: `1px solid #FEE2E2`, color: '#991B1B' };
  if (status === 'Needs Review') return { background: '#FFFBEB', border: `1px solid #FEF3C7`, color: '#92400E' };
  if (status === 'Corrupted' || status === 'Invalid') return { background: '#FEF2F2', border: `1px solid #FEE2E2`, color: '#991B1B' };
  return { background: T_BLUE_BG, border: `1px solid #DBEAFE`, color: T_BLUE };
};

// ─── Invoice row classification (drives card color + filters) ─────────────────
// invalid → scanned/image PDF that n8n could not process (status "Invalid"/"Corrupted") → RED
// review  → accountant hasn't set the Tally vendor name + category in the vendor master → YELLOW
// done    → fully processed, nothing outstanding
const isInvalidInvoice = (invoice) => {
  const status = String(invoice?.status || '').trim().toLowerCase();
  return status === 'invalid' || status === 'corrupted';
};

const needsAccountantReview = (invoice) => {
  if (!invoice || isInvalidInvoice(invoice)) return false;
  // Once the accountant has explicitly acted (Approved/Disapproved), the row is no
  // longer "needs review" — respect that action even if the Tally vendor/category are
  // still blank, so Approve moves the row Needs Review → Done and the count decrements.
  const status = String(invoice.status || '').trim();
  if (status === 'Approved' || status === 'Disapproved') return false;
  // Otherwise it needs review until the Tally vendor name + category are filled.
  // vendor_name_tally isn't stored yet, so this reduces to "category missing" today,
  // and stays correct if a Tally-vendor column is added later. "N/A"/"Missing"
  // placeholders count as missing.
  return missingVal(invoice.vendor_name_tally) && missingVal(invoice.category);
};

const getRowKind = (invoice) => {
  if (isInvalidInvoice(invoice)) return 'invalid';
  if (needsAccountantReview(invoice)) return 'review';
  return 'done';
};

const KIND_META = {
  invalid: { dot: T_DANGER, bg: '#FEF2F2', accent: T_DANGER, label: 'Manual entries required', textColor: '#991B1B' },
  review: { dot: T_WARNING, bg: '#FFFBEB', accent: T_WARNING, label: 'Needs accountant review', textColor: '#92400E' },
  done: { dot: T_SUCCESS, bg: '#FFFFFF', accent: 'transparent', label: null, textColor: '#065F46' },
};

// ─── Invoice grouping (line-item rows → one card per invoice) ────────────────
// Rows are stored one-per-line-item; the queue shows one card per INVOICE that
// expands into its lines. Key MUST match the backend (invoiceGrouping.js
// groupKeyFor): invoice_number + company, with a blank/"Invalid" invoice number
// falling back to the source FILE so two different failed PDFs never merge.
const _gnorm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const groupKeyForRow = (r) => {
  const inv = _gnorm(r.invoice_number);
  if (!inv || inv === 'invalid' || inv === 'n/a' || inv === 'na') {
    return '__file__::' + (_gnorm(r.invoice_link) || _gnorm(r.filename) || ('id:' + r.id));
  }
  return inv + '::' + _gnorm(r.company);
};
// Worst-of status for a whole invoice: Invalid > Needs Review > Disapproved > Approved.
const _INV_RANK = { Approved: 1, Disapproved: 2, 'Needs Review': 3, Corrupted: 4, Invalid: 4 };
const groupStatusOf = (items) => {
  let worst = 0, out = 'Needs Review';
  for (const r of items) {
    const s = getInvoiceStatus(r);
    const rk = _INV_RANK[s] || 0;
    if (rk >= worst) { worst = rk; out = s === 'Corrupted' ? 'Invalid' : s; }
  }
  return out;
};
// Bucket for metrics + card colour: invalid | review | rejected | done.
const groupKindOf = (items) => {
  const s = groupStatusOf(items);
  if (s === 'Invalid' || s === 'Corrupted') return 'invalid';
  if (s === 'Needs Review') return 'review';
  if (s === 'Disapproved') return 'rejected';
  return 'done';
};
const _gnum = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
// Collapse flat rows into invoice groups (insertion-ordered, matching input order).
const buildGroups = (rows) => {
  const map = new Map();
  for (const r of rows || []) {
    const k = groupKeyForRow(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  const out = [];
  for (const [key, items] of map) {
    let taxable = 0, gst = 0;
    for (const r of items) { taxable += _gnum(r.taxable_value); gst += _gnum(r.gst_amount); }
    out.push({
      key, items, head: items[0],
      status: groupStatusOf(items),
      kind: groupKindOf(items),
      line_count: items.length,
      total_taxable: taxable, total_gst: gst, total_amount: taxable + gst,
    });
  }
  return out;
};

const buildForm = (invoice) => {
  const form = {};
  EDITABLE_KEYS.forEach((key) => {
    const field = FIELD_SECTIONS.flatMap((section) => section.fields).find((item) => item.key === key);
    form[key] = field?.type === 'date' ? toInputDate(invoice?.[key]) : (invoice?.[key] ?? '');
  });
  return form;
};

const FieldValue = ({ invoice, field, editing, editForm, onChange }) => {
  const value = editing ? editForm[field.key] : invoice?.[field.key];
  const missing = field.required && blank(value);

  if (editing) {
    return (
      <input
        type={field.type === 'url' ? 'text' : field.type}
        value={value ?? ''}
        step={field.type === 'number' ? 'any' : undefined}
        onChange={(event) => onChange(field.key, event.target.value)}
        className="w-full rounded-md border px-3 py-2 text-sm outline-none transition-all focus:ring-2 focus:ring-blue-500/20"
        style={{ borderColor: missing ? T_DANGER : T_BORDER, color: T_TEXT_PRIMARY, background: '#FFFFFF' }}
      />
    );
  }

  const displayValue = blank(value)
    ? 'Missing'
    : field.display
      ? field.display(value)
      : `${value}${field.suffix || ''}`;

  return (
    <div
      className="rounded-md border px-3 py-2 text-sm min-h-[38px] flex items-center transition-colors"
      style={{
        background: missing ? '#FEF2F2' : '#F9FAFB',
        borderColor: missing ? '#FCA5A5' : T_BORDER_LIGHT,
        color: missing ? T_DANGER : T_TEXT_PRIMARY,
      }}
    >
      <span className="truncate">{displayValue}</span>
    </div>
  );
};

// ─── Processing Status Banner ─────────────────────────────────────────────────
const ProcessingBanner = ({ status, count, done = 0, total = 0, review = 0, invalid = 0, wrongBrand = 0, wrongBrandName = null, onDismiss }) => {
  if (status === 'idle') return null;

  if (status === 'processing') {
    const hasProgress = total > 0;
    const pct = hasProgress ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return (
      <div className="invoice-processing-banner invoice-processing-banner--active">
        <div className="invoice-processing-banner__icon-wrap invoice-processing-banner__icon-wrap--spin">
          <Loader2 className="invoice-processing-banner__icon" />
        </div>
        <div className="invoice-processing-banner__body" style={{ flex: 1 }}>
          <p className="invoice-processing-banner__title">
            {hasProgress ? `Processing ${done} of ${total} invoices` : 'Sending invoices…'}
          </p>
          <p className="invoice-processing-banner__sub">
            {hasProgress
              ? `${total} invoice${total !== 1 ? 's' : ''} found. Adding them to your invoice sheet…`
              : "n8n is extracting and parsing your invoices. This may take a minute for large batches — we'll notify you when done."}
          </p>
          {hasProgress && (
            <div style={{ marginTop: 8, height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.35)', overflow: 'hidden', maxWidth: 420 }}>
              <div style={{ height: '100%', width: `${pct}%`, borderRadius: 999, background: '#FFFFFF', transition: 'width 0.25s ease' }} />
            </div>
          )}
        </div>
        <div className="invoice-processing-banner__pulse" />
      </div>
    );
  }

  if (status === 'done') {
    return (
      <div className="invoice-processing-banner invoice-processing-banner--done">
        <div className="invoice-processing-banner__icon-wrap invoice-processing-banner__icon-wrap--done">
          <CheckCircle2 className="invoice-processing-banner__icon" />
        </div>
        <div className="invoice-processing-banner__body" style={{ flex: 1 }}>
          <p className="invoice-processing-banner__title">
            {count === 0
              ? (wrongBrand > 0 ? (wrongBrand + ' invoice(s) skipped — wrong brand') : 'No new invoices to process')
              : review + invalid > 0
                ? `Completed — ${count} processed, ${review + invalid} need attention`
                : `Completed — all ${count} invoice${count !== 1 ? 's' : ''} approved!`}
          </p>
          <p className="invoice-processing-banner__sub">
            {count === 0 ? (
              <>All files in the folder were already processed. Add new invoices to the folder and run again.</>
            ) : review + invalid > 0 ? (
              <>
                ✓ {count - review - invalid} approved
                {review > 0 ? ` · ⚠ ${review} need review (vendor / category missing)` : ''}
                {invalid > 0 ? ` · ✕ ${invalid} invalid (manual entry needed)` : ''}. Please review the flagged invoices below.
              </>
            ) : (
              <><strong>{count}</strong> invoice{count !== 1 ? 's' : ''} processed successfully and added to your invoice sheet.</>
            )}
          </p>
          {wrongBrand > 0 && (
            <p className="invoice-processing-banner__sub" style={{ marginTop: 6, color: '#991B1B', fontWeight: 600 }}>
              🛑 {wrongBrand} invoice{wrongBrand !== 1 ? 's' : ''} skipped — {wrongBrandName ? ('they belong to ' + wrongBrandName + ', not this brand') : 'they belong to another brand'}. They were NOT saved here.
            </p>
          )}
        </div>
        <button className="invoice-processing-banner__close" onClick={onDismiss} aria-label="Dismiss">
          <X size={16} />
        </button>
      </div>
    );
  }

  return null;
};

// Placeholder feed for the Gmail Data Room (Box 1). Gmail auto-processing isn't
// wired yet — this shows the intended structure with dummy data.
const DUMMY_GMAIL = [
  { from: 'billing@vendorone.com', subject: 'Tax Invoice — INV-2291', received: '18m ago', status: 'processed', vendor: 'Vendor One Pvt Ltd', amount: '₹42,500' },
  { from: 'accounts@brightsupplies.in', subject: 'Your invoice for July', received: '1h ago', status: 'review', vendor: 'Bright Supplies', amount: '₹1,18,900' },
  { from: 'no-reply@cloudtools.com', subject: 'Subscription receipt', received: '3h ago', status: 'processed', vendor: 'CloudTools', amount: '₹7,999' },
  { from: 'ar@packmasters.co', subject: 'Invoice + GST breakup', received: 'Yesterday', status: 'invalid', vendor: '—', amount: '—' },
];
const GMAIL_STATUS = {
  processed: { label: 'Processed', dot: '#10B981', color: '#065F46', bg: '#ECFDF5' },
  review: { label: 'Needs review', dot: '#F59E0B', color: '#92400E', bg: '#FFFBEB' },
  invalid: { label: 'Not an invoice', dot: '#EF4444', color: '#991B1B', bg: '#FEF2F2' },
};

const InvoiceAgentWorkspace = ({ agent }) => {
  const { brandId, agentId } = useParams();
  // Purchase-Invoice mode — Urban Plant only for now. A brand-scoped toggle flips
  // this workspace to the Purchase Invoice → Tally flow (separate, additive panel).
  const PURCHASE_INVOICE_BRAND_IDS = ['dd0107f5-f36a-4244-b7e0-c298a65d4e6a']; // Urban Plant
  const isPurchaseCapable = PURCHASE_INVOICE_BRAND_IDS.includes(brandId);
  const [invModeState, setInvMode] = useState('sales'); // 'sales' | 'purchase'
  const invMode = isPurchaseCapable ? invModeState : 'sales';
  // Per-brand maintenance: LIVE only for allowlisted brand IDs. Shumee Toys is
  // routed to Shumee Playroom instead of the generic maintenance copy.
  const isShumeeToys = brandId === INVOICE_SHUMEE_TOYS_ID;
  const INVOICE_MAINTENANCE = INVOICE_MAINTENANCE_ENABLED && !INVOICE_LIVE_BRAND_IDS.includes(brandId);
  const INVOICE_MAINTENANCE_TITLE = isShumeeToys ? INVOICE_TOYS_MSG : 'Invoice Process is under maintenance';
  const INVOICE_MAINTENANCE_SUB = isShumeeToys
    ? 'Invoices for Shumee are processed under the Shumee Playroom brand — open Shumee Playroom to process invoices.'
    : 'Processing is paused right now. Please feel free to use the other tools — this agent will be back shortly.';
  const INVOICE_MAINTENANCE_TOAST = isShumeeToys ? INVOICE_TOYS_MSG : INVOICE_MAINTENANCE_MSG;
  const [isTriggering, setIsTriggering] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [sheetUrl, setSheetUrl] = useState(null);
  const [vendorFolderId, setVendorFolderId] = useState(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(null);
  const [expandedKey, setExpandedKey] = useState(null); // which invoice row is expanded
  const [viewMode, setViewMode] = useState('today');    // 'today' | 'history'
  const [isUploading, setIsUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const [dateFrom, setDateFrom] = useState('');         // history date filter (YYYY-MM-DD)
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [showSheet, setShowSheet] = useState(false);
  const [summaryModal, setSummaryModal] = useState({ open: false, total: 0, approved: 0, review: 0, invalid: 0 });
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const [actioning, setActioning] = useState(null);

  // Live processing status
  const [processingStatus, setProcessingStatus] = useState('idle'); // 'idle' | 'processing' | 'done'
  const [processedCount, setProcessedCount] = useState(0);
  const [totalToProcess, setTotalToProcess] = useState(0); // N invoices in the current batch (X of N)

  const [isProcessing, setIsProcessing] = useState(false);
  const [executionId, setExecutionId] = useState(null);
  const [processingSummary, setProcessingSummary] = useState(null);

  // #3 run history · #4 workflow on/off · #5 retry
  const [runs, setRuns] = useState([]);
  const [workflow, setWorkflow] = useState(null);
  const [showRuns, setShowRuns] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // SSE abort controller ref so we can cancel the stream
  const sseAbortRef = useRef(null);
  // True only after THIS session clicked Process — lets us ignore a stale
  // terminal state replayed when the SSE connects on mount.
  const startedRef = useRef(false);
  // Highest `done` count we've already pulled the list for — so a live progress
  // tick only refetches when a NEW invoice has actually landed.
  const lastLiveDoneRef = useRef(0);
  // Watchdog: poll run-status + refresh while processing so the banner ALWAYS
  // clears when the workflow finishes, even if the SSE 'done' never arrives.
  const processingStartRef = useRef(0);
  const watchdogRef = useRef(null);

  // `silent` = live/background refresh (no loading spinner) so the list can update
  // in place mid-run as each invoice lands, without flashing "Loading invoices…".
  const fetchInvoices = useCallback(async (silent = false) => {
    if (!silent) setInvoicesLoading(true);
    try {
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/invoices`);
      setInvoices(res.data || []);
      return res.data || [];
    } catch {
      setInvoices([]);
      return [];
    } finally {
      if (!silent) setInvoicesLoading(false);
    }
  }, [brandId, agentId]);

  const fetchSheetUrl = useCallback(async () => {
    try {
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/invoice/sheet-url`);
      setSheetUrl(res.data?.sheetUrl || null);
      setVendorFolderId(res.data?.vendorFolderId || null);
    } catch {
      setSheetUrl(null);
      setVendorFolderId(null);
    }
  }, [brandId, agentId]);

  // #3/#4 — fetch recent n8n runs + workflow on/off status
  const fetchRuns = useCallback(async () => {
    try {
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/invoice/runs`);
      setRuns(res.data?.runs || []);
      setWorkflow(res.data?.workflow || null);
    } catch {
      setRuns([]); setWorkflow(null);
    }
  }, [brandId, agentId]);

  // #5 — retry the last failed n8n run
  const handleRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await api.post(`/api/brands/${brandId}/agents/${agentId}/invoice/retry`, {});
      setProcessingStatus('processing'); setIsProcessing(true); startedRef.current = true;
    } catch { /* generic — no raw error surfaced */ }
    finally { setRetrying(false); setTimeout(fetchRuns, 1500); }
  }, [brandId, agentId, fetchRuns]);

  // Load runs on mount + refresh whenever the processing status changes.
  useEffect(() => { fetchRuns(); }, [fetchRuns, processingStatus]);

  useEffect(() => {
    fetchInvoices();
    fetchSheetUrl();
  }, [fetchInvoices, fetchSheetUrl]);

  // ─── SSE connection ───────────────────────────
  const startSseConnection = useCallback(() => {
    if (sseAbortRef.current) {
      sseAbortRef.current.abort();
    }

    const abortController = new AbortController();
    sseAbortRef.current = abortController;

    const token = localStorage.getItem('token');
    const sseUrl = `${API_URL}/api/brands/${brandId}/agents/${agentId}/invoice/status`;

    (async () => {
      try {
        const response = await fetch(sseUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
          },
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let firstMsg = true;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete last line

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const payload = JSON.parse(line.slice(6));

                if (payload.status === 'processing') {
                  setProcessingStatus('processing');
                  setIsTriggering(true);
                  setIsProcessing(true);
                  if (payload.total) setTotalToProcess(payload.total);
                  if (payload.done !== undefined) setProcessedCount(payload.done);
                } else if (payload.status === 'progress') {
                  setProcessingStatus('processing');
                  setIsTriggering(true);
                  setIsProcessing(true);
                  setTotalToProcess(payload.total || 0);
                  setProcessedCount(payload.done || 0);
                  // Live incremental: the moment a new invoice is saved (done went up),
                  // pull it into the list immediately — no waiting for the final 'done',
                  // no manual Refresh. Silent fetch = no loading-spinner flash.
                  if ((payload.done || 0) > lastLiveDoneRef.current) {
                    lastLiveDoneRef.current = payload.done || 0;
                    fetchInvoices(true);
                  }
                } else if (payload.status === 'cancelled') {
                  setProcessingStatus('idle');
                  setIsProcessing(false);
                  setIsTriggering(false);
                  setProcessedCount(0);
                  setTotalToProcess(0);
                  setProcessingSummary(null);
                  startedRef.current = false;
                } else if (payload.status === 'done') {
                  // Stale terminal state replayed on a fresh (mount) connection with
                  // nothing in flight for us → stay idle and keep listening.
                  if (firstMsg && !startedRef.current) {
                    firstMsg = false;
                    continue;
                  }
                  setProcessingStatus('done');
                  const approvedVal = payload.processed || 0;   // fully approved
                  const reviewVal = payload.review || 0;        // flagged Needs Review
                  const invalidVal = payload.corrupted || 0;    // invalid / scanned
                  const wrongBrandVal = payload.wrongBrand || 0;   // blocked — belong to another brand
                  const wrongBrandNm = payload.wrongBrandName || null;
                  const totalVal = approvedVal + reviewVal + invalidVal;
                  const flagged = reviewVal + invalidVal;
                  setProcessedCount(totalVal);
                  setTotalToProcess(totalVal);
                  setIsTriggering(false);

                  setIsProcessing(false);
                  setExecutionId(null);
                  startedRef.current = false;
                  setProcessingSummary({ approved: approvedVal, review: reviewVal, invalid: invalidVal, total: totalVal, wrongBrand: wrongBrandVal, wrongBrandName: wrongBrandNm });
                  if (wrongBrandVal > 0) toast.error(`${wrongBrandVal} invoice${wrongBrandVal !== 1 ? 's' : ''} skipped — ${wrongBrandNm ? `they belong to ${wrongBrandNm}` : 'they belong to another brand'}, not this brand. Not saved here.`);

                  // Notify — warn if anything needs attention
                  if (totalVal === 0) {
                    toast.info('No new invoices to process — all files in the folder were already processed.');
                  } else if (flagged > 0) {
                    toast.warning(
                      `Processed ${totalVal} — ${approvedVal} approved` +
                      `${reviewVal ? `, ${reviewVal} need review` : ''}` +
                      `${invalidVal ? `, ${invalidVal} invalid` : ''}. Please review the flagged invoices.`
                    );
                  } else {
                    toast.success(`Completed! All ${approvedVal} invoice${approvedVal !== 1 ? 's' : ''} approved.`);
                  }

                  // Refresh invoice list (the summary modal is opened by an effect
                  // watching processingStatus/processingSummary — robust to StrictMode).
                  await fetchInvoices();

                  // Close SSE — we got what we needed
                  abortController.abort();
                  break;
                }
                firstMsg = false;
              } catch (_) { /* ignore parse errors */ }
            }
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error('[SSE] Connection error:', err);
        }
      }
    })();
  }, [brandId, agentId, fetchInvoices]);

  // Connect the live-status stream on mount so progress is visible even if the
  // page is opened/refreshed while a run is in flight; clean up on unmount.
  useEffect(() => {
    startSseConnection();
    return () => {
      if (sseAbortRef.current) sseAbortRef.current.abort();
    };
  }, [startSseConnection]);

  // ─── Processing watchdog ──────────────────────────────────────────────────
  // While a run is in flight, poll the n8n run status + silently refresh the list
  // every 7s. This (a) makes invoices appear live even if the SSE stream hiccups,
  // and (b) reliably clears the "Processing…" banner the moment the workflow is
  // done — instead of waiting on the flaky SSE 'done' ping (which can stall ~90s).
  useEffect(() => {
    if (!isProcessing) {
      if (watchdogRef.current) { clearInterval(watchdogRef.current); watchdogRef.current = null; }
      processingStartRef.current = 0;
      return;
    }
    if (!processingStartRef.current) processingStartRef.current = Date.now();

    const finish = () => {
      setIsProcessing(false);
      setIsTriggering(false);
      setProcessingStatus('idle');
      startedRef.current = false;
      if (sseAbortRef.current) sseAbortRef.current.abort();
      fetchInvoices(true);
    };

    const tick = async () => {
      fetchInvoices(true); // keep the list fresh regardless of SSE
      const elapsed = Date.now() - (processingStartRef.current || Date.now());
      let runs = [];
      try {
        const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/invoice/runs`);
        runs = res.data?.runs || [];
      } catch { /* ignore */ }
      const latest = runs[0];
      const inFlight = latest && ['running', 'new', 'waiting'].includes(String(latest.status || '').toLowerCase());
      let startedAfter = true;
      try { if (latest?.startedAt) startedAfter = new Date(latest.startedAt).getTime() >= (processingStartRef.current - 15000); } catch { /* keep true */ }
      // Finish when the workflow is no longer running (a terminal run that began
      // at/after our trigger), after a short grace period — or a hard 3-min cap.
      if ((latest && !inFlight && startedAfter && elapsed > 12000) || elapsed > 180000) {
        finish();
      }
    };

    const id = setInterval(tick, 7000);
    watchdogRef.current = id;
    return () => { clearInterval(id); watchdogRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProcessing, brandId, agentId]);

  // NOTE: we intentionally do NOT auto-open the summary modal — the top completion
  // banner already shows the full breakdown ("Completed — X processed · …"), which
  // is the non-intrusive "summary at the end" the workflow calls for.

  // Auto-dismiss the completion banner so a finished run's summary doesn't linger as
  // stale "previous output" on the next visit/run.
  useEffect(() => {
    if (processingStatus !== 'done') return;
    const t = setTimeout(() => setProcessingStatus('idle'), 15000);
    return () => clearTimeout(t);
  }, [processingStatus]);

  const selectedInvoice = useMemo(
    () => invoices.find((invoice) => invoice.id === selectedInvoiceId) || null,
    [invoices, selectedInvoiceId]
  );

  useEffect(() => {
    if (invoices.length === 0) {
      setSelectedInvoiceId(null);
      setExpandedKey(null);
      return;
    }
    if (selectedInvoiceId && invoices.some((invoice) => invoice.id === selectedInvoiceId)) return;
    const firstPending = invoices.find((invoice) => !['Approved', 'Disapproved'].includes(getInvoiceStatus(invoice)));
    const pick = firstPending || invoices[0];
    setSelectedInvoiceId(pick.id);
    // NOTE: do NOT auto-expand — the table opens with every invoice collapsed;
    // a row expands only when the user clicks it.
  }, [invoices, selectedInvoiceId]);

  useEffect(() => {
    setIsEditing(false);
    setEditForm(selectedInvoice ? buildForm(selectedInvoice) : {});
  }, [selectedInvoiceId, selectedInvoice]);

  // Flat rows → one group per INVOICE (line items collapsed).
  const groupedInvoices = useMemo(() => buildGroups(invoices), [invoices]);

  // The date an invoice belongs to = the latest processed_on across its lines
  // (the "Processed …" date). Drives the Today panel + the History date filter.
  const groupDate = (g) => {
    let best = null;
    for (const r of g.items) {
      if (!r.processed_on) continue;
      const d = new Date(r.processed_on);
      if (!isNaN(d.getTime()) && (!best || d > best)) best = d;
    }
    return best;
  };

  // Stage 1 — VIEW filter. Today = only invoices processed today; History = all,
  // optionally narrowed to a [from, to] range.
  const viewGroups = useMemo(() => {
    const todayStr = new Date().toDateString();
    const from = dateFrom ? new Date(dateFrom) : null;
    const to = dateTo ? new Date(dateTo) : null;
    if (to) to.setHours(23, 59, 59, 999);
    return groupedInvoices.filter((g) => {
      const d = groupDate(g);
      if (viewMode === 'today') return !!d && d.toDateString() === todayStr;
      if (from && (!d || d < from)) return false;
      if (to && (!d || d > to)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedInvoices, viewMode, dateFrom, dateTo]);

  // Metrics reflect the CURRENT view (today's counts, or the filtered history).
  const metrics = useMemo(() => {
    const totals = { total: viewGroups.length, approved: 0, review: 0, invalid: 0, rejected: 0 };
    viewGroups.forEach((g) => {
      if (g.kind === 'invalid') totals.invalid += 1;
      else if (g.kind === 'review') totals.review += 1;
      else if (g.kind === 'rejected') totals.rejected += 1;
      else totals.approved += 1;
    });
    return totals;
  }, [viewGroups]);

  // Stage 2 — STATUS tab + search filter (what the table actually renders).
  const visibleGroups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return viewGroups.filter((g) => {
      const matchesStatus =
        statusFilter === 'All' ||
        (statusFilter === 'Done' && g.kind === 'done') ||
        (statusFilter === 'Needs Review' && g.kind === 'review') ||
        (statusFilter === 'Invalid' && g.kind === 'invalid');
      if (!matchesStatus) return false;
      if (!needle) return true;
      const h = g.head;
      const haystack = [h.company, h.invoice_number, h.seller_gstin, h.buyer_gstin, h.category,
        ...g.items.map((i) => i.product_name)].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [viewGroups, search, statusFilter]);

  // Flattened line items across visible groups — drives prev/next navigation.
  const selectableRows = useMemo(() => visibleGroups.flatMap((g) => g.items), [visibleGroups]);
  // The invoice group that owns the currently-selected line item.
  const selectedGroup = useMemo(
    () => groupedInvoices.find((g) => g.items.some((r) => r.id === selectedInvoiceId)) || null,
    [groupedInvoices, selectedInvoiceId]
  );

  const selectedIndex = selectableRows.findIndex((invoice) => invoice.id === selectedInvoiceId);

  // Switching the Today/History tab collapses everything (fresh, tidy view).
  useEffect(() => {
    setExpandedKey(null);
  }, [viewMode]);
  const reviewIssues = getReviewIssues(selectedInvoice);

  // Drive-upload box: push the chosen files into the brand's Drive input folder,
  // then auto-trigger a Process run (upload + auto-process).
  const handleUploadFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    if (INVOICE_MAINTENANCE) { toast.info(INVOICE_MAINTENANCE_TOAST); return; }
    setIsUploading(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      const res = await api.post(`/api/brands/${brandId}/agents/${agentId}/invoice/upload`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const n = res.data?.count || files.length;
      toast.success(`${n} file${n !== 1 ? 's' : ''} uploaded to Drive — starting processing…`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      // Give Drive a moment to index the new files, then auto-process.
      setTimeout(() => { handleProcessInvoices(); }, 1800);
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  const handleProcessInvoices = async () => {
    // Maintenance mode: never fire the n8n webhook; just tell the user.
    if (INVOICE_MAINTENANCE) {
      toast.info(INVOICE_MAINTENANCE_TOAST);
      return;
    }
    startedRef.current = true;
    setIsTriggering(true);
    setIsProcessing(true);
    setProcessingSummary(null);
    setProcessingStatus('processing');
    setProcessedCount(0);
    setTotalToProcess(0);
    lastLiveDoneRef.current = 0;

    // Start listening for SSE updates first
    startSseConnection();

    try {
      toast.info('Started processing invoices in the background...');
      const res = await api.post(`/api/brands/${brandId}/agents/${agentId}/invoice/process`, {
        brandId,
        agentId
      });
      if (res.data?.executionId) {
        setExecutionId(res.data.executionId);
      }
    } catch (error) {
      // A run is already in progress — don't spawn another; keep watching the live one.
      if (error.response?.status === 409) {
        toast.warning(error.response.data?.error || 'A run is already in progress. Please wait for it to finish.');
        return;
      }
      setIsTriggering(false);
      setIsProcessing(false);
      setProcessingStatus('idle');
      if (sseAbortRef.current) sseAbortRef.current.abort();
      toast.error(error.response?.data?.error || error.message || 'Failed to trigger invoice processing');
    }
  };

  const handleCancel = async () => {
    try {
      toast.info('Cancelling invoice processing...');
      await api.post(`/api/brands/${brandId}/agents/${agentId}/invoice/cancel`);
      toast.success('Processing cancelled and database rolled back');
    } catch (err) {
      console.error('Cancel failed:', err);
      toast.error(err.response?.data?.error || err.message || 'Failed to cancel processing');
    } finally {
      setIsTriggering(false);
      setIsProcessing(false);
      setProcessingStatus('idle');
      setExecutionId(null);
      setProcessingSummary(null);
      if (sseAbortRef.current) sseAbortRef.current.abort();
      fetchInvoices();
    }
  };

  const dismissBanner = () => {
    setProcessingStatus('idle');
  };

  const handleFieldChange = (key, value) => {
    setEditForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    if (!selectedInvoice) return;
    setIsSaving(true);
    try {
      const response = await api.patch(`/api/brands/${brandId}/agents/${agentId}/invoices/${selectedInvoice.id}`, editForm);
      const updated = response.data?.data || { ...selectedInvoice, ...editForm };
      setInvoices((prev) => prev.map((invoice) => invoice.id === selectedInvoice.id ? updated : invoice));
      setIsEditing(false);
      toast.success('Invoice updated');
    } catch {
      toast.error('Failed to update invoice');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (invoiceId) => {
    if (!window.confirm('Are you sure you want to delete this invoice? This action cannot be undone.')) return;
    try {
      await api.delete(`/api/brands/${brandId}/agents/${agentId}/invoices/${invoiceId}`);
      setInvoices((prev) => prev.filter((invoice) => invoice.id !== invoiceId));
      if (selectedInvoiceId === invoiceId) {
        setSelectedInvoiceId(null);
      }
      toast.success('Invoice deleted');
    } catch {
      toast.error('Failed to delete invoice');
    }
  };

  const handleStatusUpdate = async (status) => {
    if (!selectedInvoice) return;
    setActioning(status);
    try {
      const response = await api.patch(`/api/brands/${brandId}/agents/${agentId}/invoices/${selectedInvoice.id}`, { status });
      const updated = response.data?.data || { ...selectedInvoice, status };
      setInvoices((prev) => prev.map((invoice) => invoice.id === selectedInvoice.id ? updated : invoice));
      toast.success(status === 'Approved' ? 'Invoice approved' : 'Invoice disapproved');
    } catch {
      toast.error(`Failed to mark invoice as ${status.toLowerCase()}`);
    } finally {
      setActioning(null);
    }
  };

  const moveSelection = (direction) => {
    if (selectableRows.length === 0) return;
    const current = selectedIndex >= 0 ? selectedIndex : 0;
    const nextIndex = Math.min(Math.max(current + direction, 0), selectableRows.length - 1);
    const next = selectableRows[nextIndex];
    setSelectedInvoiceId(next.id);
    setExpandedKey(groupKeyForRow(next));
  };

  // Select an invoice card: expand it and jump to its first line item.
  const selectInvoiceGroup = (group) => {
    setExpandedKey((prev) => (prev === group.key ? prev : group.key));
    const firstPending = group.items.find((r) => !['Approved', 'Disapproved'].includes(getInvoiceStatus(r)));
    setSelectedInvoiceId((firstPending || group.items[0]).id);
  };

  // Whole-invoice action (approve / reject / delete) on the selected invoice.
  const handleGroupAction = async (action) => {
    if (!selectedGroup) return;
    if (action === 'delete' && !window.confirm('Delete this entire invoice (all its line items)? This cannot be undone.')) return;
    setActioning(action);
    try {
      await api.post(`/api/brands/${brandId}/agents/${agentId}/invoices/group-action`, { group_key: selectedGroup.key, action });
      toast.success(action === 'approve' ? 'Invoice approved' : action === 'reject' ? 'Invoice rejected' : 'Invoice deleted');
      if (action === 'delete') setSelectedInvoiceId(null);
      await fetchInvoices(true);
    } catch {
      toast.error(`Failed to ${action} invoice`);
    } finally {
      setActioning(null);
    }
  };

  const statusTabs = [
    { label: 'All', count: metrics.total },
    { label: 'Done', count: metrics.approved },
    { label: 'Needs Review', count: metrics.review },
    { label: 'Invalid', count: metrics.invalid },
  ];

  // The invoice detail (SOURCE DOC + METADATA + whole-invoice actions) for the
  // currently-selected LINE ITEM. Rendered INLINE beneath the expanded row.
  const renderDetail = () => {
    if (!selectedInvoice) return null;
    return (
      <>
        <div className="px-6 py-4 border-b flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4" style={{ borderColor: T_BORDER }}>
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider" style={statusStyle(getInvoiceStatus(selectedInvoice))}>
                {getInvoiceStatus(selectedInvoice)}
              </span>
              {reviewIssues.length > 0 && (
                <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider" style={{ background: '#FEF3C7', color: '#92400E' }}>
                  {reviewIssues.length} ISSUES
                </span>
              )}
            </div>
            <h2 className="text-xl font-bold tracking-tight" style={{ color: T_TEXT_PRIMARY, fontFamily: 'Space Grotesk' }}>
              {selectedInvoice.invoice_number || 'Unnamed Invoice'}
            </h2>
            <p className="text-sm font-medium" style={{ color: T_TEXT_SECONDARY }}>{selectedInvoice.company || 'Unknown Vendor'}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center border rounded-lg mr-2 overflow-hidden" style={{ borderColor: T_BORDER }}>
              <button onClick={() => moveSelection(-1)} disabled={selectedIndex <= 0} className="p-2 disabled:opacity-40 hover:bg-slate-50 transition-colors" style={{ color: T_TEXT_SECONDARY }}>
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="w-px h-4 bg-slate-200" />
              <button onClick={() => moveSelection(1)} disabled={selectedIndex === -1 || selectedIndex >= selectableRows.length - 1} className="p-2 disabled:opacity-40 hover:bg-slate-50 transition-colors" style={{ color: T_TEXT_SECONDARY }}>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <button
              onClick={() => { setIsEditing((prev) => !prev); setEditForm(buildForm(selectedInvoice)); }}
              className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-bold hover:bg-slate-50 transition-colors"
              style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}
            >
              {isEditing ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
              {isEditing ? 'Cancel' : 'Edit'}
            </button>
            {isEditing ? (
              <button onClick={handleSave} disabled={isSaving} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white shadow-sm" style={{ background: T_BLUE }}>
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save
              </button>
            ) : (
              <>
                <button onClick={() => handleGroupAction('reject')} disabled={!!actioning} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold border transition-colors hover:bg-red-50" style={{ borderColor: '#FCA5A5', color: T_DANGER, background: '#FEF2F2' }} title="Reject the whole invoice (all line items)">
                  {actioning === 'reject' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ThumbsDown className="w-4 h-4" />}
                  Reject
                </button>
                <button onClick={() => handleGroupAction('approve')} disabled={!!actioning} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white shadow-sm hover:brightness-110" style={{ background: T_SUCCESS }} title="Approve the whole invoice (all line items)">
                  {actioning === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ThumbsUp className="w-4 h-4" />}
                  Approve
                </button>
                <div className="w-px h-6 mx-2 bg-slate-200" />
                <button onClick={() => handleGroupAction('delete')} disabled={!!actioning} className="p-2 rounded-lg border hover:bg-red-50 hover:text-red-600 transition-all text-slate-400 hover:border-red-200" title="Delete the whole invoice (all line items)">
                  {actioning === 'delete' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_460px]">
          <div className="border-b 2xl:border-b-0 2xl:border-r min-h-[560px]" style={{ borderColor: T_BORDER }}>
            <div className="px-5 py-3 border-b flex items-center justify-between bg-slate-50/30" style={{ borderColor: T_BORDER }}>
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4" style={{ color: T_BLUE }} />
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>Source Document</span>
              </div>
              {selectedInvoice.invoice_link && (
                <a href={selectedInvoice.invoice_link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[11px] font-bold transition-colors hover:text-blue-700" style={{ color: T_BLUE }}>
                  EXTERNAL VIEW <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
            {(() => {
              let link = selectedInvoice.invoice_link;
              if (link && link.includes('drive.google.com')) {
                link = link.replace('/view', '/preview').replace('/edit', '/preview');
                if (!link.includes('usp=drive_sdk') && !link.includes('/preview')) {
                  link += link.includes('?') ? '&preview=1' : '/preview';
                }
              }
              if (link) {
                return (
                  <div className="h-[560px] bg-slate-100">
                    <iframe title="Original invoice" src={link} className="w-full h-full border-0 bg-white" allow="autoplay" />
                  </div>
                );
              }
              return (
                <div className="h-[560px] flex flex-col items-center justify-center px-8 text-center">
                  <AlertTriangle className="w-12 h-12 mb-4" style={{ color: '#D97706' }} />
                  <h3 className="font-black" style={{ color: '#111827', fontFamily: 'Space Grotesk' }}>No original invoice link</h3>
                  <p className="text-sm mt-2 max-w-sm" style={{ color: '#667085' }}>
                    N8N did not return an invoice link for this record. You can add one while editing the processed fields.
                  </p>
                </div>
              );
            })()}
          </div>

          <div className="min-h-[560px] flex flex-col">
            <div className="px-5 py-3 border-b flex items-center justify-between bg-slate-50/30" style={{ borderColor: T_BORDER }}>
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4" style={{ color: T_BLUE }} />
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>Metadata</span>
              </div>
              <span className="text-[10px] font-bold text-slate-400 uppercase">AI Extracted</span>
            </div>
            {reviewIssues.length > 0 && (
              <div className="m-4 rounded-xl border p-3" style={{ background: '#FFFBEB', borderColor: '#FDE68A' }}>
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5" style={{ color: '#A16207' }} />
                  <div>
                    <p className="text-sm font-bold" style={{ color: '#A16207' }}>Needs accountant review</p>
                    <p className="text-xs mt-1" style={{ color: '#854D0E' }}>{reviewIssues.join(', ')}</p>
                  </div>
                </div>
              </div>
            )}
            <div className="p-4 space-y-4 flex-1 overflow-y-auto bg-white">
              {FIELD_SECTIONS.map((section) => (
                <div key={section.title} className="rounded-lg border bg-white" style={{ borderColor: T_BORDER_LIGHT }}>
                  <div className="px-4 py-2 bg-slate-50/50 border-b" style={{ borderColor: T_BORDER_LIGHT }}>
                    <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: T_TEXT_SECONDARY }}>{section.title}</p>
                  </div>
                  <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                    {section.fields.map((field) => (
                      <div key={field.key} className={field.key === 'invoice_link' || field.key === 'product_name' ? 'sm:col-span-2' : ''}>
                        <label className="block text-[10px] font-bold uppercase tracking-tight mb-1" style={{ color: T_TEXT_SECONDARY }}>
                          {field.label}
                        </label>
                        <FieldValue invoice={selectedInvoice} field={field} editing={isEditing} editForm={editForm} onChange={handleFieldChange} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </>
    );
  };

  if (invMode === 'purchase') {
    return <PurchaseInvoicePanel brandId={brandId} onSwitchToSales={() => setInvMode('sales')} />;
  }

  return (
    <div className="max-w-[1600px] space-y-6 animate-in fade-in duration-500">
      <ProcessingBanner status={processingStatus} count={processedCount} done={processedCount} total={totalToProcess} review={processingSummary?.review || 0} invalid={processingSummary?.invalid || 0} wrongBrand={processingSummary?.wrongBrand || 0} wrongBrandName={processingSummary?.wrongBrandName || null} onDismiss={dismissBanner} />

      {isPurchaseCapable && (
        <div className="rounded-xl border bg-white shadow-[0_1px_3px_0_rgba(0,0,0,0.05)] px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2" style={{ borderColor: T_BORDER }}>
          <div className="text-sm" style={{ color: T_TEXT_SECONDARY }}>
            <span className="font-semibold" style={{ color: T_TEXT_PRIMARY }}>Purchase invoices?</span> Switch to Purchase Invoice mode to turn vendor bills into a Tally import file.
          </div>
          <button onClick={() => setInvMode('purchase')} className="text-sm px-3 py-2 rounded-lg font-semibold text-white self-start sm:self-auto" style={{ background: T_BLUE }}>
            Purchase Invoice → Tally
          </button>
        </div>
      )}

      <div className="rounded-xl border bg-white shadow-[0_1px_3px_0_rgba(0,0,0,0.05)] overflow-hidden" style={{ borderColor: T_BORDER }}>
        {INVOICE_MAINTENANCE && (
          <div className="px-6 py-3 flex items-center gap-3 border-b" style={{ background: '#FFF7ED', borderColor: '#FED7AA', color: '#9A3412' }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>🛠️</span>
            <div>
              <div className="text-sm font-bold">{INVOICE_MAINTENANCE_TITLE}</div>
              <div className="text-xs" style={{ opacity: 0.85 }}>{INVOICE_MAINTENANCE_SUB}</div>
            </div>
          </div>
        )}
        <div className="px-6 py-5 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
          <div className="flex items-center gap-5">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center shadow-inner" style={{ background: T_BLUE_BG, color: T_BLUE }}>
              <FileText className="w-7 h-7" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2 h-2 rounded-full" style={{ background: T_BLUE }} />
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: T_BLUE }}>Record Automation</span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight" style={{ color: T_TEXT_PRIMARY, fontFamily: 'Space Grotesk' }}>
                {agent?.name || 'Invoice Agent'}
              </h1>
              <p className="text-sm mt-1" style={{ color: T_TEXT_SECONDARY }}>
                Review AI-extracted invoices, verify metadata, and sync with your ledger.
              </p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1">
            <div className="flex flex-wrap items-center gap-3">
              {sheetUrl && (
                <button
                  onClick={() => setShowSheet(true)}
                  className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all hover:bg-blue-50"
                  style={{ border: `1px solid ${T_BORDER}`, color: T_TEXT_SECONDARY }}
                >
                  <Sheet className="w-4 h-4" /> Invoice Sheet
                </button>
              )}
              <button
                onClick={() => window.open(INVOICE_DRIVE_FOLDER_URL, '_blank')}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all hover:bg-blue-50"
                style={{ border: `1px solid ${T_BORDER}`, color: T_TEXT_SECONDARY }}
              >
                <Sheet className="w-4 h-4" /> Google Drive Folder
              </button>
              <button
                onClick={() => fetchInvoices()}
                disabled={invoicesLoading}
                className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-all hover:bg-slate-50 disabled:opacity-50"
                style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}
              >
                <RefreshCw className={`w-4 h-4 ${invoicesLoading ? 'animate-spin' : ''}`} /> Refresh
              </button>
              {workflow && (
                <span title={`n8n workflow: ${workflow.name}`} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold" style={{ border: `1px solid ${T_BORDER}`, color: workflow.active ? '#065F46' : '#991B1B', background: workflow.active ? '#ECFDF5' : '#FEF2F2' }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: workflow.active ? '#10B981' : '#EF4444' }} />
                  {workflow.active ? 'Workflow On' : 'Workflow Off'}
                </span>
              )}
              <button
                onClick={() => setShowRuns((v) => !v)}
                className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-all hover:bg-slate-50"
                style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}
              >
                ⟳ Runs
              </button>
              {runs[0] && runs[0].status === 'error' && (
                <button
                  onClick={handleRetry}
                  disabled={retrying}
                  className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white transition-all hover:brightness-110 disabled:opacity-60"
                  style={{ background: '#F59E0B', boxShadow: '0 4px 12px rgba(245,158,11,0.25)' }}
                >
                  {retrying ? 'Retrying…' : '↻ Retry last'}
                </button>
              )}
              <button
                onClick={handleProcessInvoices}
                disabled={isProcessing || processingStatus === 'processing'}
                className="process-btn inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-bold text-white transition-all disabled:opacity-60 hover:brightness-110 active:scale-95"
                style={{
                  background: INVOICE_MAINTENANCE ? '#9CA3AF' : T_BLUE,
                  boxShadow: INVOICE_MAINTENANCE ? 'none' : '0 4px 12px rgba(37,99,235,0.2)',
                  cursor: INVOICE_MAINTENANCE ? 'not-allowed' : undefined,
                }}
                title={INVOICE_MAINTENANCE ? INVOICE_MAINTENANCE_TOAST : undefined}
                data-testid="process-invoices-button"
              >
                {(isProcessing || processingStatus === 'processing') ? (
                  <>
                    <span className="spinner" /> Processing...
                  </>
                ) : INVOICE_MAINTENANCE ? (
                  <>🛠️ Under maintenance</>
                ) : (
                  <>▶ Process Invoices</>
                )}
              </button>
              {isProcessing && (
                <button
                  onClick={handleCancel}
                  className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white transition-all hover:brightness-110 active:scale-95"
                  style={{ background: T_DANGER, boxShadow: '0 4px 12px rgba(239,68,68,0.25)' }}
                >
                  ✕ Cancel
                </button>
              )}
            </div>
            {showRuns && (
              <div className="mt-2 w-72 rounded-lg border bg-white shadow-lg p-1.5" style={{ borderColor: T_BORDER }}>
                <div className="text-[10px] font-bold uppercase tracking-widest px-2 py-1" style={{ color: T_TEXT_SECONDARY }}>Recent runs</div>
                {runs.length === 0 ? (
                  <div className="text-xs px-2 py-2" style={{ color: T_TEXT_SECONDARY }}>No runs yet</div>
                ) : runs.map((r) => (
                  <div key={r.id} className="flex items-center justify-between px-2 py-1.5 text-xs">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full" style={{ background: r.status === 'success' ? '#10B981' : r.status === 'error' ? '#EF4444' : r.status === 'canceled' ? '#94A3B8' : '#F59E0B' }} />
                      <span style={{ color: T_TEXT_PRIMARY, fontWeight: 600, textTransform: 'capitalize' }}>{r.status || 'unknown'}</span>
                    </span>
                    <span style={{ color: T_TEXT_SECONDARY }}>{(() => { try { return format(new Date(r.startedAt), 'd MMM, h:mm a'); } catch { return ''; } })()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 border-t" style={{ borderColor: T_BORDER }}>
          {[
            { label: 'Total Records', value: metrics.total, color: T_TEXT_PRIMARY },
            { label: 'Approved', value: metrics.approved, color: T_SUCCESS },
            { label: 'Needs Review', value: metrics.review, color: T_WARNING },
            { label: 'Invalid', value: metrics.invalid, color: T_DANGER },
            { label: 'Rejected', value: metrics.rejected, color: T_TEXT_SECONDARY },
          ].map((item) => (
            <div key={item.label} className="px-6 py-4 border-r last:border-r-0" style={{ borderColor: T_BORDER }}>
              <div className="text-xl font-bold" style={{ color: item.color, fontFamily: 'Space Grotesk' }}>{item.value}</div>
              <div className="text-[10px] font-bold uppercase tracking-wider mt-1" style={{ color: T_TEXT_SECONDARY }}>{item.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Intake row: Gmail Data Room (preview) + Drive Upload (live) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Box 1 — Gmail Data Room (dummy for now) */}
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden flex flex-col" style={{ borderColor: T_BORDER }}>
          <div className="px-5 py-3 border-b flex items-center justify-between bg-slate-50/50" style={{ borderColor: T_BORDER }}>
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4" style={{ color: '#EA4335' }} />
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>Gmail Data Room</span>
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: '#FEF3C7', color: '#92400E' }}>Preview</span>
          </div>
          <div className="divide-y flex-1 max-h-[300px] overflow-y-auto" style={{ borderColor: T_BORDER_LIGHT }}>
            {DUMMY_GMAIL.map((g, i) => {
              const st = GMAIL_STATUS[g.status] || GMAIL_STATUS.processed;
              return (
                <div key={i} className="px-5 py-3 hover:bg-slate-50/60 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: T_TEXT_PRIMARY }}>{g.subject}</p>
                      <p className="text-[11px] truncate" style={{ color: T_TEXT_SECONDARY }}>{g.from}</p>
                    </div>
                    <span className="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: st.bg, color: st.color }}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: st.dot }} /> {st.label}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[10px]" style={{ color: T_TEXT_SECONDARY }}>{g.received}</span>
                    <span className="text-[11px] font-semibold" style={{ color: T_TEXT_PRIMARY }}>{g.vendor !== '—' ? `${g.vendor} · ${g.amount}` : g.amount}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="px-5 py-2.5 border-t bg-slate-50/40 flex items-center gap-2" style={{ borderColor: T_BORDER_LIGHT }}>
            <Inbox className="w-3.5 h-3.5" style={{ color: T_TEXT_SECONDARY }} />
            <span className="text-[10px] font-medium" style={{ color: T_TEXT_SECONDARY }}>Sample data — live Gmail intake coming soon.</span>
          </div>
        </div>

        {/* Box 2 — Drive Upload (live) */}
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden flex flex-col" style={{ borderColor: T_BORDER }}>
          <div className="px-5 py-3 border-b flex items-center justify-between bg-slate-50/50" style={{ borderColor: T_BORDER }}>
            <div className="flex items-center gap-2">
              <UploadCloud className="w-4 h-4" style={{ color: T_BLUE }} />
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>Upload Invoices</span>
            </div>
            <button onClick={() => window.open(INVOICE_DRIVE_FOLDER_URL, '_blank')} className="inline-flex items-center gap-1.5 text-[11px] font-bold hover:text-blue-700" style={{ color: T_BLUE }}>
              <FolderOpen className="w-3.5 h-3.5" /> Open folder
            </button>
          </div>
          <div className="p-5 flex-1 flex items-center">
            <input ref={fileInputRef} type="file" multiple accept=".pdf,image/*" className="hidden" onChange={(e) => handleUploadFiles(e.target.files)} />
            <button
              type="button"
              onClick={() => { if (!isUploading && fileInputRef.current) fileInputRef.current.click(); }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); handleUploadFiles(e.dataTransfer.files); }}
              disabled={isUploading || INVOICE_MAINTENANCE}
              className="w-full rounded-xl border-2 border-dashed py-10 px-6 text-center transition-all disabled:opacity-60"
              style={{ borderColor: dragOver ? T_BLUE : T_BORDER, background: dragOver ? T_BLUE_BG : '#FBFCFE' }}
            >
              {isUploading ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="w-7 h-7 animate-spin" style={{ color: T_BLUE }} />
                  <span className="text-sm font-bold" style={{ color: T_BLUE }}>Uploading &amp; processing…</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <UploadCloud className="w-8 h-8" style={{ color: T_BLUE }} />
                  <span className="text-sm font-bold" style={{ color: T_TEXT_PRIMARY }}>Drop invoice files here, or click to browse</span>
                  <span className="text-[11px]" style={{ color: T_TEXT_SECONDARY }}>PDF or images · uploaded to Drive, then processed automatically</span>
                </div>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Box 3 — vendor-wise processed folders (live Drive view) */}
      {vendorFolderId && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden" style={{ borderColor: T_BORDER }}>
          <div className="px-5 py-3 border-b flex items-center justify-between bg-slate-50/50" style={{ borderColor: T_BORDER }}>
            <div className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4" style={{ color: T_BLUE }} />
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>Processed Folders · Vendor-wise</span>
            </div>
            <a href={`https://drive.google.com/drive/folders/${vendorFolderId}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[11px] font-bold hover:text-blue-700" style={{ color: T_BLUE }}>
              Open in Drive <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
          <iframe
            title="Vendor-wise processed folders"
            src={`https://drive.google.com/embeddedfolderview?id=${vendorFolderId}#list`}
            className="w-full border-0 bg-white"
            style={{ height: 360 }}
          />
        </div>
      )}

      <div className="rounded-xl border bg-white shadow-sm p-3" style={{ borderColor: T_BORDER }}>
        <div className="flex flex-col xl:flex-row gap-3 xl:items-center xl:justify-between">
          {/* Today / History view toggle */}
          <div className="flex items-center gap-1 rounded-lg p-1 self-start" style={{ background: '#F1F5F9' }}>
            {[{ id: 'today', label: 'Today' }, { id: 'history', label: 'History' }].map((v) => {
              const on = viewMode === v.id;
              return (
                <button key={v.id} onClick={() => setViewMode(v.id)} className="px-3.5 py-1.5 rounded-md text-sm font-bold transition-all"
                  style={{ background: on ? '#FFFFFF' : 'transparent', color: on ? T_BLUE : T_TEXT_SECONDARY, boxShadow: on ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>
                  {v.label}
                </button>
              );
            })}
          </div>

          {/* Status pills (img-39 style) */}
          <div className="flex flex-wrap gap-1.5">
            {statusTabs.map((tab) => {
              const active = statusFilter === tab.label;
              const dot = tab.label === 'Needs Review' ? T_WARNING : tab.label === 'Invalid' ? T_DANGER : tab.label === 'Done' ? T_SUCCESS : T_BLUE;
              return (
                <button key={tab.label} onClick={() => setStatusFilter(tab.label)}
                  className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-semibold transition-all border"
                  style={{ background: active ? '#FFFFFF' : 'transparent', borderColor: active ? T_BORDER : 'transparent', color: active ? T_TEXT_PRIMARY : T_TEXT_SECONDARY, boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />
                  {tab.label}
                  <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-bold" style={{ background: active ? T_BLUE_BG : '#F1F5F9', color: active ? T_BLUE : T_TEXT_SECONDARY }}>{tab.count}</span>
                </button>
              );
            })}
          </div>

          {/* Search + (History) date filter */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search vendor, GSTIN, invoice #…"
                className="w-full rounded-lg border py-2 pl-10 pr-4 text-sm outline-none focus:ring-2 focus:ring-blue-500/10 transition-all"
                style={{ borderColor: T_BORDER, color: T_TEXT_PRIMARY }} />
            </div>
            {viewMode === 'history' && (
              <div className="flex items-center gap-1.5">
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-lg border py-1.5 px-2 text-xs outline-none" style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }} title="From date" />
                <span className="text-xs text-slate-400">–</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-lg border py-1.5 px-2 text-xs outline-none" style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }} title="To date" />
                {(dateFrom || dateTo) && (
                  <button onClick={() => { setDateFrom(''); setDateTo(''); }} className="text-xs font-semibold px-2 py-1.5 rounded-lg hover:bg-slate-100" style={{ color: T_TEXT_SECONDARY }}>Clear</button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="w-full">
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden" style={{ borderColor: T_BORDER }}>
          <div className="px-5 py-3 border-b flex items-center justify-between bg-slate-50/50" style={{ borderColor: T_BORDER }}>
            <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>
              {viewMode === 'today' ? "Today's Invoices" : 'All Invoices'}
            </span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: T_BLUE_BG, color: T_BLUE }}>
              {visibleGroups.length} {visibleGroups.length === 1 ? 'Invoice' : 'Invoices'}
            </span>
          </div>

          {!invoicesLoading && visibleGroups.length > 0 && (
            <div className="hidden md:grid gap-3 px-5 py-2.5 border-b bg-white text-[10px] font-bold uppercase tracking-wider" style={{ gridTemplateColumns: '120px 96px minmax(0,1fr) minmax(0,1.3fr) 160px 28px', borderColor: T_BORDER_LIGHT, color: T_TEXT_SECONDARY }}>
              <span>Status</span><span>Date</span><span>Number</span><span>Vendor</span><span className="text-right">Total</span><span></span>
            </div>
          )}

          {invoicesLoading ? (
            <div className="py-16 flex items-center justify-center text-sm" style={{ color: '#667085' }}>
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading invoices...
            </div>
          ) : visibleGroups.length === 0 ? (
            <div className="py-16 px-6 text-center">
              <FileText className="w-10 h-10 mx-auto mb-3" style={{ color: '#CBD5E1' }} />
              <p className="text-sm font-bold" style={{ color: '#475467' }}>No invoices found</p>
              <p className="text-xs mt-1" style={{ color: '#98A2B3' }}>{viewMode === 'today' ? 'No invoices processed today — switch to History to see earlier ones.' : 'Try another filter or run N8N processing.'}</p>
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: T_BORDER_LIGHT }}>
              {visibleGroups.map((g) => {
                const style = statusStyle(g.status);
                const isExpanded = expandedKey === g.key;
                const multi = g.line_count > 1;
                const d = groupDate(g);
                const accent = g.kind === 'invalid' ? T_DANGER : g.kind === 'review' ? T_WARNING : 'transparent';
                return (
                  <div key={g.key} style={{ borderColor: T_BORDER_LIGHT }}>
                    {/* Invoice row (img-39 table style) */}
                    <button
                      onClick={() => (expandedKey === g.key ? setExpandedKey(null) : selectInvoiceGroup(g))}
                      className="w-full grid gap-3 px-5 py-3.5 items-center text-left transition-colors hover:bg-slate-50/70"
                      style={{ gridTemplateColumns: '120px 96px minmax(0,1fr) minmax(0,1.3fr) 160px 28px', background: isExpanded ? '#F6F9FF' : 'transparent', borderLeft: `3px solid ${isExpanded ? T_BLUE : accent}` }}
                    >
                      <span><span className="inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide" style={style}>{g.status}</span></span>
                      <span className="text-xs font-medium" style={{ color: T_TEXT_SECONDARY }}>{d ? format(d, 'dd MMM yyyy') : formatDate(g.head.invoice_date)}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-bold truncate" style={{ color: T_TEXT_PRIMARY }}>#{g.head.invoice_number || 'N/A'}</span>
                        {multi && <span className="block text-[10px] font-medium" style={{ color: T_TEXT_SECONDARY }}>{g.line_count} line items</span>}
                      </span>
                      <span className="min-w-0 text-sm font-semibold truncate" style={{ color: T_TEXT_PRIMARY }}>{blank(g.head.company) ? 'Unknown Vendor' : g.head.company}</span>
                      <span className="text-right leading-tight">
                        <span className="block text-sm font-bold" style={{ color: T_TEXT_PRIMARY }}>{money(g.total_amount)}</span>
                        <span className="block text-[10px] font-medium" style={{ color: T_TEXT_SECONDARY }}>taxable {money(g.total_taxable)}</span>
                      </span>
                      <span className="flex justify-end">
                        <ChevronRight className="w-4 h-4 transition-transform" style={{ color: T_TEXT_SECONDARY, transform: isExpanded ? 'rotate(90deg)' : 'none' }} />
                      </span>
                    </button>

                    {/* Inline expanded detail — line-item selector + SOURCE/METADATA */}
                    {isExpanded && selectedInvoice && (
                      <div className="border-t" style={{ borderColor: T_BORDER_LIGHT, background: '#FBFCFE' }}>
                        {multi && (
                          <div className="flex items-center gap-1.5 px-5 py-2.5 overflow-x-auto border-b bg-white" style={{ borderColor: T_BORDER_LIGHT }}>
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 shrink-0 mr-1">Line items</span>
                            {g.items.map((li, idx) => {
                              const a = li.id === selectedInvoiceId;
                              const label = blank(li.product_name) ? 'item' : li.product_name;
                              return (
                                <button key={li.id} onClick={() => setSelectedInvoiceId(li.id)} title={label}
                                  className="shrink-0 rounded-md px-2.5 py-1 text-[11px] font-semibold border transition-colors"
                                  style={{ borderColor: a ? T_BLUE : T_BORDER, background: a ? T_BLUE_BG : '#fff', color: a ? T_BLUE : T_TEXT_SECONDARY }}>
                                  {idx + 1}. {label.length > 22 ? label.slice(0, 22) + '…' : label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {renderDetail()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {false && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden min-h-[800px]" style={{ borderColor: T_BORDER }}>
          {!selectedInvoice ? (
            <div className="h-[720px] flex flex-col items-center justify-center text-center px-6">
              <FileText className="w-14 h-14 mb-4" style={{ color: '#CBD5E1' }} />
              <h3 className="text-lg font-black" style={{ color: '#111827', fontFamily: 'Space Grotesk' }}>Select an invoice</h3>
              <p className="text-sm mt-1 max-w-sm" style={{ color: '#667085' }}>
                Pick an invoice from the queue to review the source document and AI processed fields side by side.
              </p>
            </div>
          ) : (
            <>
              <div className="px-6 py-4 border-b flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4" style={{ borderColor: T_BORDER }}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider" style={statusStyle(getInvoiceStatus(selectedInvoice))}>
                      {getInvoiceStatus(selectedInvoice)}
                    </span>
                    {reviewIssues.length > 0 && (
                      <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider" style={{ background: '#FEF3C7', color: '#92400E' }}>
                        {reviewIssues.length} ISSUES
                      </span>
                    )}
                  </div>
                  <h2 className="text-xl font-bold tracking-tight" style={{ color: T_TEXT_PRIMARY, fontFamily: 'Space Grotesk' }}>
                    {selectedInvoice.invoice_number || 'Unnamed Invoice'}
                  </h2>
                  <p className="text-sm font-medium" style={{ color: T_TEXT_SECONDARY }}>{selectedInvoice.company || 'Unknown Vendor'}</p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center border rounded-lg mr-2 overflow-hidden" style={{ borderColor: T_BORDER }}>
                    <button
                      onClick={() => moveSelection(-1)}
                      disabled={selectedIndex <= 0}
                      className="p-2 disabled:opacity-40 hover:bg-slate-50 transition-colors"
                      style={{ color: T_TEXT_SECONDARY }}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <div className="w-px h-4 bg-slate-200" />
                    <button
                      onClick={() => moveSelection(1)}
                      disabled={selectedIndex === -1 || selectedIndex >= selectableRows.length - 1}
                      className="p-2 disabled:opacity-40 hover:bg-slate-50 transition-colors"
                      style={{ color: T_TEXT_SECONDARY }}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                  <button
                    onClick={() => {
                      setIsEditing((prev) => !prev);
                      setEditForm(buildForm(selectedInvoice));
                    }}
                    className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-bold hover:bg-slate-50 transition-colors"
                    style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}
                  >
                    {isEditing ? <X className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
                    {isEditing ? 'Cancel' : 'Edit'}
                  </button>
                  {isEditing ? (
                    <button
                      onClick={handleSave}
                      disabled={isSaving}
                      className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white shadow-sm"
                      style={{ background: T_BLUE }}
                    >
                      {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      Save
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => handleGroupAction('reject')}
                        disabled={!!actioning}
                        className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold border transition-colors hover:bg-red-50"
                        style={{ borderColor: '#FCA5A5', color: T_DANGER, background: '#FEF2F2' }}
                        title="Reject the whole invoice (all line items)"
                      >
                        {actioning === 'reject' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ThumbsDown className="w-4 h-4" />}
                        Reject
                      </button>
                      <button
                        onClick={() => handleGroupAction('approve')}
                        disabled={!!actioning}
                        className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white shadow-sm hover:brightness-110"
                        style={{ background: T_SUCCESS }}
                        title="Approve the whole invoice (all line items)"
                      >
                        {actioning === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ThumbsUp className="w-4 h-4" />}
                        Approve
                      </button>
                      <div className="w-px h-6 mx-2 bg-slate-200" />
                      <button
                        onClick={() => handleGroupAction('delete')}
                        disabled={!!actioning}
                        className="p-2 rounded-lg border hover:bg-red-50 hover:text-red-600 transition-all text-slate-400 hover:border-red-200"
                        title="Delete the whole invoice (all line items)"
                      >
                        {actioning === 'delete' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_460px]">
                <div className="border-b 2xl:border-b-0 2xl:border-r min-h-[640px]" style={{ borderColor: T_BORDER }}>
                  <div className="px-5 py-3 border-b flex items-center justify-between bg-slate-50/30" style={{ borderColor: T_BORDER }}>
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4" style={{ color: T_BLUE }} />
                      <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>Source Document</span>
                    </div>
                    {selectedInvoice.invoice_link && (
                      <a
                        href={selectedInvoice.invoice_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-[11px] font-bold transition-colors hover:text-blue-700"
                        style={{ color: T_BLUE }}
                      >
                        EXTERNAL VIEW <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                  {(() => {
                    let link = selectedInvoice.invoice_link;
                    if (link && link.includes('drive.google.com')) {
                      link = link.replace('/view', '/preview').replace('/edit', '/preview');
                      if (!link.includes('usp=drive_sdk') && !link.includes('/preview')) {
                        link += link.includes('?') ? '&preview=1' : '/preview';
                      }
                    }

                    if (link) {
                      return (
                        <div className="h-[640px] bg-slate-100">
                          <iframe
                            title="Original invoice"
                            src={link}
                            className="w-full h-full border-0 bg-white"
                            allow="autoplay"
                          />
                        </div>
                      );
                    }

                    return (
                      <div className="h-[640px] flex flex-col items-center justify-center px-8 text-center">
                        <AlertTriangle className="w-12 h-12 mb-4" style={{ color: '#D97706' }} />
                        <h3 className="font-black" style={{ color: '#111827', fontFamily: 'Space Grotesk' }}>No original invoice link</h3>
                        <p className="text-sm mt-2 max-w-sm" style={{ color: '#667085' }}>
                          N8N did not return an invoice link for this record. You can add one while editing the processed fields.
                        </p>
                      </div>
                    );
                  })()}
                </div>

                <div className="min-h-[640px] flex flex-col">
                  <div className="px-5 py-3 border-b flex items-center justify-between bg-slate-50/30" style={{ borderColor: T_BORDER }}>
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4" style={{ color: T_BLUE }} />
                      <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>Metadata</span>
                    </div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase">AI Extracted</span>
                  </div>

                  {reviewIssues.length > 0 && (
                    <div className="m-4 rounded-xl border p-3" style={{ background: '#FFFBEB', borderColor: '#FDE68A' }}>
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 mt-0.5" style={{ color: '#A16207' }} />
                        <div>
                          <p className="text-sm font-bold" style={{ color: '#A16207' }}>Needs accountant review</p>
                          <p className="text-xs mt-1" style={{ color: '#854D0E' }}>{reviewIssues.join(', ')}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="p-4 space-y-4 flex-1 overflow-y-auto bg-white">
                    {FIELD_SECTIONS.map((section) => (
                      <div key={section.title} className="rounded-lg border bg-white" style={{ borderColor: T_BORDER_LIGHT }}>
                        <div className="px-4 py-2 bg-slate-50/50 border-b" style={{ borderColor: T_BORDER_LIGHT }}>
                          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: T_TEXT_SECONDARY }}>{section.title}</p>
                        </div>
                        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                          {section.fields.map((field) => (
                            <div key={field.key} className={field.key === 'invoice_link' || field.key === 'product_name' ? 'sm:col-span-2' : ''}>
                              <label className="block text-[10px] font-bold uppercase tracking-tight mb-1" style={{ color: T_TEXT_SECONDARY }}>
                                {field.label}
                              </label>
                              <FieldValue
                                invoice={selectedInvoice}
                                field={field}
                                editing={isEditing}
                                editForm={editForm}
                                onChange={handleFieldChange}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
        )}
      </div>

      {showSheet && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-6xl h-[86vh] rounded-2xl bg-white overflow-hidden flex flex-col shadow-2xl">
            <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: T_BORDER }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: T_BLUE_BG, color: T_BLUE }}>
                  <Sheet className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-black" style={{ color: '#111827', fontFamily: 'Space Grotesk' }}>Invoice Sheet</h3>
                  <p className="text-xs" style={{ color: '#667085' }}>Live source sheet configured for this brand</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {sheetUrl && (
                  <a href={sheetUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-bold" style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
                    <Maximize2 className="w-4 h-4" /> Open
                  </a>
                )}
                <button onClick={() => setShowSheet(false)} className="rounded-xl border p-2" style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {sheetUrl ? (
              <iframe title="Invoice Google Sheet" src={sheetUrl} className="flex-1 w-full border-0" />
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm" style={{ color: '#667085' }}>No sheet URL configured for this brand.</div>
            )}
          </div>
        </div>
      )}

      {summaryModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-xl p-8 w-full max-w-sm shadow-2xl border" style={{ borderColor: T_BORDER }}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-bold text-xl tracking-tight" style={{ color: T_TEXT_PRIMARY, fontFamily: 'Space Grotesk' }}>Processing Complete</h3>
              <button onClick={() => setSummaryModal((prev) => ({ ...prev, open: false }))} className="p-1 hover:bg-slate-100 rounded-md transition-colors">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Total Processed', value: summaryModal.total, color: T_BLUE, bg: T_BLUE_BG, border: '#DBEAFE' },
                { label: 'Approved', value: summaryModal.approved, color: T_SUCCESS, bg: '#ECFDF5', border: '#D1FAE5' },
                { label: 'Needs Review', value: summaryModal.review, color: T_WARNING, bg: '#FFFBEB', border: '#FEF3C7' },
                { label: 'Invalid', value: summaryModal.invalid, color: T_DANGER, bg: '#FEF2F2', border: '#FEE2E2' },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between px-5 py-4 rounded-lg border shadow-sm" style={{ background: item.bg, borderColor: item.border }}>
                  <span className="text-xs font-bold uppercase tracking-wider" style={{ color: item.color }}>{item.label}</span>
                  <span className="text-2xl font-bold" style={{ color: item.color, fontFamily: 'Space Grotesk' }}>{item.value}</span>
                </div>
              ))}
            </div>
            {(summaryModal.review > 0 || summaryModal.invalid > 0) && (
              <div className="mt-5 flex items-start gap-2 rounded-lg border px-4 py-3" style={{ background: '#FFFBEB', borderColor: '#FEF3C7' }}>
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: T_WARNING }} />
                <p className="text-xs font-semibold leading-relaxed" style={{ color: '#92400E' }}>
                  Out of {summaryModal.total} invoice{summaryModal.total !== 1 ? 's' : ''},{' '}
                  {summaryModal.review > 0 && <>{summaryModal.review} {summaryModal.review !== 1 ? 'are' : 'is'} missing the vendor Tally name / category</>}
                  {summaryModal.review > 0 && summaryModal.invalid > 0 && ' and '}
                  {summaryModal.invalid > 0 && <>{summaryModal.invalid} could not be read (scanned/invalid)</>}
                  . Please review the flagged invoices and complete the entries manually.
                </p>
              </div>
            )}
            <button onClick={() => setSummaryModal((prev) => ({ ...prev, open: false }))} className="w-full mt-8 rounded-lg py-3 text-sm font-bold text-white shadow-lg shadow-blue-500/20 transition-all hover:brightness-110 active:scale-[0.98]" style={{ background: T_BLUE }}>
              Continue Review
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default InvoiceAgentWorkspace;

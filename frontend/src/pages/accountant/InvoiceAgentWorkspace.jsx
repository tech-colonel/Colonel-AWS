import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Database,
  ExternalLink, FileText, Loader2, Maximize2, Pencil, Play, RefreshCw,
  Save, Search, Sheet, Sparkles, ThumbsDown, ThumbsUp, Trash2, X, Zap
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import api, { API_URL } from '../../lib/api';

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
const ProcessingBanner = ({ status, count, done = 0, total = 0, review = 0, invalid = 0, onDismiss }) => {
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
              ? 'No new invoices to process'
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
        </div>
        <button className="invoice-processing-banner__close" onClick={onDismiss} aria-label="Dismiss">
          <X size={16} />
        </button>
      </div>
    );
  }

  return null;
};

const InvoiceAgentWorkspace = ({ agent }) => {
  const { brandId, agentId } = useParams();
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
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(null);
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

  const fetchInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    try {
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/invoices`);
      setInvoices(res.data || []);
      return res.data || [];
    } catch {
      setInvoices([]);
      return [];
    } finally {
      setInvoicesLoading(false);
    }
  }, [brandId, agentId]);

  const fetchSheetUrl = useCallback(async () => {
    try {
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/invoice/sheet-url`);
      setSheetUrl(res.data?.sheetUrl || null);
    } catch {
      setSheetUrl(null);
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
                  const totalVal = approvedVal + reviewVal + invalidVal;
                  const flagged = reviewVal + invalidVal;
                  setProcessedCount(totalVal);
                  setTotalToProcess(totalVal);
                  setIsTriggering(false);

                  setIsProcessing(false);
                  setExecutionId(null);
                  startedRef.current = false;
                  setProcessingSummary({ approved: approvedVal, review: reviewVal, invalid: invalidVal, total: totalVal });

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
      return;
    }
    if (selectedInvoiceId && invoices.some((invoice) => invoice.id === selectedInvoiceId)) return;
    const firstPending = invoices.find((invoice) => !['Approved', 'Disapproved'].includes(getInvoiceStatus(invoice)));
    setSelectedInvoiceId((firstPending || invoices[0]).id);
  }, [invoices, selectedInvoiceId]);

  useEffect(() => {
    setIsEditing(false);
    setEditForm(selectedInvoice ? buildForm(selectedInvoice) : {});
  }, [selectedInvoiceId, selectedInvoice]);

  const metrics = useMemo(() => {
    // Disjoint 3-bucket model (+ rejected): approved + review + invalid + rejected = total.
    const totals = { total: invoices.length, approved: 0, review: 0, invalid: 0, rejected: 0 };
    invoices.forEach((invoice) => {
      const kind = getRowKind(invoice);
      if (kind === 'invalid') totals.invalid += 1;
      else if (kind === 'review') totals.review += 1;
      else if (getInvoiceStatus(invoice) === 'Disapproved') totals.rejected += 1;
      else totals.approved += 1; // fully done / approved (excludes rejected)
    });
    return totals;
  }, [invoices]);

  const filteredInvoices = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return invoices.filter((invoice) => {
      const kind = getRowKind(invoice);
      const matchesStatus =
        statusFilter === 'All' ||
        (statusFilter === 'Done' && kind === 'done' && getInvoiceStatus(invoice) !== 'Disapproved') ||
        (statusFilter === 'Needs Review' && kind === 'review') ||
        (statusFilter === 'Invalid' && kind === 'invalid');
      const haystack = [
        invoice.company,
        invoice.invoice_number,
        invoice.seller_gstin,
        invoice.buyer_gstin,
        invoice.category,
        invoice.product_name,
      ].join(' ').toLowerCase();
      return matchesStatus && (!needle || haystack.includes(needle));
    });
  }, [invoices, search, statusFilter]);

  const selectedIndex = filteredInvoices.findIndex((invoice) => invoice.id === selectedInvoiceId);
  const reviewIssues = getReviewIssues(selectedInvoice);

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
    if (filteredInvoices.length === 0) return;
    const current = selectedIndex >= 0 ? selectedIndex : 0;
    const nextIndex = Math.min(Math.max(current + direction, 0), filteredInvoices.length - 1);
    setSelectedInvoiceId(filteredInvoices[nextIndex].id);
  };

  const statusTabs = [
    { label: 'All', count: metrics.total },
    { label: 'Done', count: metrics.approved },
    { label: 'Needs Review', count: metrics.review },
    { label: 'Invalid', count: metrics.invalid },
  ];

  return (
    <div className="max-w-[1600px] space-y-6 animate-in fade-in duration-500">
      <ProcessingBanner status={processingStatus} count={processedCount} done={processedCount} total={totalToProcess} review={processingSummary?.review || 0} invalid={processingSummary?.invalid || 0} onDismiss={dismissBanner} />

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
                onClick={fetchInvoices}
                disabled={invoicesLoading || isProcessing}
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

      <div className="rounded-xl border bg-white shadow-sm p-3" style={{ borderColor: T_BORDER }}>
        <div className="flex flex-col lg:flex-row gap-3 lg:items-center lg:justify-between">
          <div className="relative flex-1 max-w-lg">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by vendor, GSTIN, or invoice #..."
              className="w-full rounded-lg border py-2 pl-10 pr-4 text-sm outline-none focus:ring-2 focus:ring-blue-500/10 transition-all"
              style={{ borderColor: T_BORDER, color: T_TEXT_PRIMARY }}
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {statusTabs.map((tab) => {
              const active = statusFilter === tab.label;
              const dot = tab.label === 'Needs Review' ? T_WARNING : tab.label === 'Invalid' ? T_DANGER : tab.label === 'Done' ? T_SUCCESS : null;
              return (
                <button
                  key={tab.label}
                  onClick={() => setStatusFilter(tab.label)}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all"
                  style={{
                    background: active ? T_BLUE : 'transparent',
                    color: active ? '#FFFFFF' : T_TEXT_SECONDARY,
                  }}
                >
                  {dot && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: active ? '#FFFFFF' : dot }} />}
                  {tab.label} <span className="opacity-60 ml-0.5">{tab.count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[340px_minmax(0,1fr)] gap-6 items-start">
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden" style={{ borderColor: T_BORDER }}>
          <div className="px-4 py-3 border-b flex items-center justify-between bg-slate-50/50" style={{ borderColor: T_BORDER }}>
            <div className="relative">
              <button
                onClick={() => setFilterMenuOpen((o) => !o)}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -ml-1 hover:bg-slate-100 transition-colors"
              >
                <Database className="w-3.5 h-3.5" style={{ color: T_BLUE }} />
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>{statusFilter}</span>
                <ChevronDown className="w-3.5 h-3.5" style={{ color: T_TEXT_SECONDARY, transform: filterMenuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
              </button>
              {filterMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setFilterMenuOpen(false)} />
                  <div className="absolute z-20 mt-1 left-0 w-56 rounded-lg border bg-white shadow-lg py-1" style={{ borderColor: T_BORDER }}>
                    {statusTabs.map((tab) => {
                      const dot = tab.label === 'Needs Review' ? T_WARNING : tab.label === 'Invalid' ? T_DANGER : tab.label === 'Done' ? T_SUCCESS : T_BLUE;
                      const active = statusFilter === tab.label;
                      return (
                        <button
                          key={tab.label}
                          onClick={() => { setStatusFilter(tab.label); setFilterMenuOpen(false); }}
                          className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold hover:bg-slate-50 transition-colors"
                          style={{ background: active ? T_BLUE_BG : 'transparent', color: active ? T_BLUE : T_TEXT_PRIMARY }}
                        >
                          <span className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ background: dot }} />
                            {tab.label === 'Done' ? 'Done / Approved' : tab.label === 'Needs Review' ? 'Needs Review (yellow)' : tab.label === 'Invalid' ? 'Invalid (red)' : 'All'}
                          </span>
                          <span style={{ color: T_TEXT_SECONDARY }}>{tab.count}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: T_BLUE_BG, color: T_BLUE }}>
              {filteredInvoices.length} Records
            </span>
          </div>

          {invoicesLoading ? (
            <div className="py-16 flex items-center justify-center text-sm" style={{ color: '#667085' }}>
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading invoices...
            </div>
          ) : filteredInvoices.length === 0 ? (
            <div className="py-16 px-6 text-center">
              <FileText className="w-10 h-10 mx-auto mb-3" style={{ color: '#CBD5E1' }} />
              <p className="text-sm font-bold" style={{ color: '#475467' }}>No invoices found</p>
              <p className="text-xs mt-1" style={{ color: '#98A2B3' }}>Try another filter or run N8N processing.</p>
            </div>
          ) : (
            <div className="max-h-[800px] overflow-y-auto divide-y divide-slate-100">
              {filteredInvoices.map((invoice) => {
                const status = getInvoiceStatus(invoice);
                const style = statusStyle(status);
                const kind = getRowKind(invoice);
                const meta = KIND_META[kind];
                const active = invoice.id === selectedInvoiceId;
                return (
                  <button
                    key={invoice.id}
                    onClick={() => setSelectedInvoiceId(invoice.id)}
                    className="w-full text-left p-4 transition-all hover:bg-slate-50/50 relative"
                    style={{
                      // Selected cards keep their status color (yellow/red) instead of turning blue;
                      // selection is shown by a stronger tint + a full outline in that same color.
                      background: active
                        ? (kind === 'invalid' ? '#FEE2E2' : kind === 'review' ? '#FEF3C7' : '#F0F7FF')
                        : meta.bg,
                      borderLeft: `3px solid ${kind === 'done' ? (active ? T_BLUE : 'transparent') : meta.accent}`,
                      boxShadow: active ? `inset 0 0 0 1.5px ${kind === 'done' ? T_BLUE : meta.accent}` : 'none',
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-bold text-sm truncate" style={{ color: T_TEXT_PRIMARY }}>
                          {blank(invoice.company) ? 'Unknown Vendor' : invoice.company}
                        </p>
                        <p className="text-[11px] font-medium mt-0.5 truncate" style={{ color: T_TEXT_SECONDARY }}>
                          #{invoice.invoice_number || 'N/A'}
                        </p>
                      </div>
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-tighter" style={style}>
                        {status}
                      </span>
                    </div>
                    {kind !== 'done' && (
                      <div className="flex items-center gap-1.5 mt-2">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.dot }} />
                        <span className="text-[10px] font-bold" style={{ color: meta.textColor }}>{meta.label}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between mt-3">
                      <span className="text-[10px] font-medium" style={{ color: T_TEXT_SECONDARY }}>{formatDate(invoice.invoice_date)}</span>
                      <span className="text-xs font-bold" style={{ color: T_TEXT_PRIMARY }}>{money(invoice.taxable_value)}</span>
                    </div>
                    {invoice.processed_on && (() => {
                      let dt = null;
                      try { dt = format(new Date(invoice.processed_on), 'd MMM yyyy, h:mm a'); } catch { dt = null; }
                      return dt ? (
                        <div className="mt-1.5 text-[9px] font-medium" style={{ color: T_TEXT_SECONDARY, opacity: 0.8 }}>
                          Processed {dt}
                        </div>
                      ) : null;
                    })()}
                  </button>
                );
              })}
            </div>
          )}
        </div>

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
                      disabled={selectedIndex === -1 || selectedIndex >= filteredInvoices.length - 1}
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
                        onClick={() => handleStatusUpdate('Disapproved')}
                        disabled={!!actioning}
                        className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold border transition-colors hover:bg-red-50"
                        style={{ borderColor: '#FCA5A5', color: T_DANGER, background: '#FEF2F2' }}
                      >
                        {actioning === 'Disapproved' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ThumbsDown className="w-4 h-4" />}
                        Reject
                      </button>
                      <button
                        onClick={() => handleStatusUpdate('Approved')}
                        disabled={!!actioning}
                        className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white shadow-sm hover:brightness-110"
                        style={{ background: T_SUCCESS }}
                      >
                        {actioning === 'Approved' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ThumbsUp className="w-4 h-4" />}
                        Approve
                      </button>
                      <div className="w-px h-6 mx-2 bg-slate-200" />
                      <button
                        onClick={() => handleDelete(selectedInvoice.id)}
                        className="p-2 rounded-lg border hover:bg-red-50 hover:text-red-600 transition-all text-slate-400 hover:border-red-200"
                        title="Delete Record"
                      >
                        <Trash2 className="w-4 h-4" />
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

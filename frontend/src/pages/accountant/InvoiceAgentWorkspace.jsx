import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Database,
  ExternalLink, FileText, Loader2, Maximize2, Pencil, Play, RefreshCw,
  Save, Search, Sheet, Sparkles, ThumbsDown, ThumbsUp, Trash2, X, Zap
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import api from '../../lib/api';

const API_URL = process.env.REACT_APP_BACKEND_URL || 'http://localhost:8001';

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
  if (getReviewIssues(invoice).length > 0 && !['Approved', 'Disapproved', 'Corrupted'].includes(status)) return 'Needs Review';
  return status || 'Processed';
};

const statusStyle = (status) => {
  if (status === 'Approved') return { background: '#ECFDF5', border: `1px solid #D1FAE5`, color: '#065F46' };
  if (status === 'Disapproved') return { background: '#FEF2F2', border: `1px solid #FEE2E2`, color: '#991B1B' };
  if (status === 'Needs Review') return { background: '#FFFBEB', border: `1px solid #FEF3C7`, color: '#92400E' };
  if (status === 'Corrupted') return { background: '#FEF2F2', border: `1px solid #FEE2E2`, color: '#991B1B' };
  return { background: T_BLUE_BG, border: `1px solid #DBEAFE`, color: T_BLUE };
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
const ProcessingBanner = ({ status, count, onDismiss }) => {
  if (status === 'idle') return null;

  if (status === 'processing') {
    return (
      <div className="invoice-processing-banner invoice-processing-banner--active">
        <div className="invoice-processing-banner__icon-wrap invoice-processing-banner__icon-wrap--spin">
          <Loader2 className="invoice-processing-banner__icon" />
        </div>
        <div className="invoice-processing-banner__body">
          <p className="invoice-processing-banner__title">Invoices are being processed</p>
          <p className="invoice-processing-banner__sub">
            n8n is extracting and parsing your invoices. This may take a minute for large batches — we'll notify you when done.
          </p>
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
        <div className="invoice-processing-banner__body">
          <p className="invoice-processing-banner__title">
            Invoices processed successfully!
          </p>
          <p className="invoice-processing-banner__sub">
            <strong>{count}</strong> invoice{count !== 1 ? 's' : ''} have been saved to the database and the list below has been updated.
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
  const [isTriggering, setIsTriggering] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [sheetUrl, setSheetUrl] = useState(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [showSheet, setShowSheet] = useState(false);
  const [summaryModal, setSummaryModal] = useState({ open: false, total: 0, valid: 0, corrupt: 0 });
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const [actioning, setActioning] = useState(null);

  // Live processing status
  const [processingStatus, setProcessingStatus] = useState('idle'); // 'idle' | 'processing' | 'done'
  const [processedCount, setProcessedCount] = useState(0);

  const [isProcessing, setIsProcessing] = useState(false);
  const [executionId, setExecutionId] = useState(null);
  const [processingSummary, setProcessingSummary] = useState(null);

  // SSE abort controller ref so we can cancel the stream
  const sseAbortRef = useRef(null);

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
                } else if (payload.status === 'done') {
                  setProcessingStatus('done');
                  const countVal = payload.processed !== undefined ? payload.processed : (payload.count || 0);
                  const corruptVal = payload.corrupted || 0;
                  setProcessedCount(countVal);
                  setIsTriggering(false);

                  setIsProcessing(false);
                  setExecutionId(null);
                  setProcessingSummary({
                    processed: countVal,
                    corrupted: corruptVal
                  });

                  // Show a popup notification
                  toast.success(`Invoices are processed successfully! (${countVal} processed, ${corruptVal} corrupted)`);

                  // Refresh invoice list
                  const updatedInvoices = await fetchInvoices();

                  // Open summary modal
                  const corruptCount = updatedInvoices.filter((inv) => getReviewIssues(inv).length > 0 || inv.status === 'Corrupted').length;
                  setSummaryModal({
                    open: true,
                    total: countVal + corruptVal || updatedInvoices.length,
                    valid: countVal || (updatedInvoices.length - corruptCount),
                    corrupt: corruptVal || corruptCount,
                  });

                  // Close SSE — we got what we needed
                  abortController.abort();
                  break;
                }
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

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      if (sseAbortRef.current) sseAbortRef.current.abort();
    };
  }, []);

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
    const totals = { total: invoices.length, pending: 0, approved: 0, disapproved: 0, needsReview: 0 };
    invoices.forEach((invoice) => {
      const status = getInvoiceStatus(invoice);
      if (status === 'Approved') totals.approved += 1;
      else if (status === 'Disapproved') totals.disapproved += 1;
      else totals.pending += 1;
      if (getReviewIssues(invoice).length > 0) totals.needsReview += 1;
    });
    return totals;
  }, [invoices]);

  const filteredInvoices = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return invoices.filter((invoice) => {
      const status = getInvoiceStatus(invoice);
      const matchesStatus =
        statusFilter === 'All' ||
        (statusFilter === 'Needs Review' && getReviewIssues(invoice).length > 0) ||
        (statusFilter === 'Pending' && !['Approved', 'Disapproved'].includes(status)) ||
        status === statusFilter;
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
    setIsTriggering(true);
    setIsProcessing(true);
    setProcessingSummary(null);
    setProcessingStatus('processing');
    setProcessedCount(0);

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
    { label: 'Pending', count: metrics.pending },
    { label: 'Needs Review', count: metrics.needsReview },
    { label: 'Approved', count: metrics.approved },
    { label: 'Disapproved', count: metrics.disapproved },
  ];

  return (
    <div className="max-w-[1600px] space-y-6 animate-in fade-in duration-500">
      <ProcessingBanner status={processingStatus} count={processedCount} onDismiss={dismissBanner} />

      <div className="rounded-xl border bg-white shadow-[0_1px_3px_0_rgba(0,0,0,0.05)] overflow-hidden" style={{ borderColor: T_BORDER }}>
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
                onClick={fetchInvoices}
                disabled={invoicesLoading || isProcessing}
                className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-all hover:bg-slate-50 disabled:opacity-50"
                style={{ borderColor: T_BORDER, color: T_TEXT_SECONDARY }}
              >
                <RefreshCw className={`w-4 h-4 ${invoicesLoading ? 'animate-spin' : ''}`} /> Refresh
              </button>
              <button
                onClick={handleProcessInvoices}
                disabled={isProcessing}
                className="process-btn inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-bold text-white transition-all disabled:opacity-60 hover:brightness-110 active:scale-95"
                style={{ background: T_BLUE, boxShadow: '0 4px 12px rgba(37,99,235,0.2)' }}
                data-testid="process-invoices-button"
              >
                {isProcessing ? (
                  <>
                    <span className="spinner" /> Processing...
                  </>
                ) : (
                  <>▶ Process Invoices</>
                )}
              </button>
              {isProcessing && (
                <button onClick={handleCancel} className="cancel-btn inline-flex items-center gap-2 font-bold transition-all hover:brightness-110 active:scale-95">
                  ✕ Cancel
                </button>
              )}
            </div>
            {processingSummary && (
              <div className="summary-banner">
                ✅ {processingSummary.processed} invoices processed
                {processingSummary.corrupted > 0 && (
                  <span className="corrupted-count">
                    &nbsp;· ⚠️ {processingSummary.corrupted} corrupted
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 border-t" style={{ borderColor: T_BORDER }}>
          {[
            { label: 'Total Records', value: metrics.total, color: T_TEXT_PRIMARY },
            { label: 'Pending', value: metrics.pending, color: T_BLUE },
            { label: 'Verified', value: metrics.approved, color: T_SUCCESS },
            { label: 'Rejected', value: metrics.disapproved, color: T_DANGER },
            { label: 'Issues Found', value: metrics.needsReview, color: T_WARNING },
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
              return (
                <button
                  key={tab.label}
                  onClick={() => setStatusFilter(tab.label)}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-all"
                  style={{
                    background: active ? T_BLUE : 'transparent',
                    color: active ? '#FFFFFF' : T_TEXT_SECONDARY,
                  }}
                >
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
            <div className="flex items-center gap-2">
              <Database className="w-3.5 h-3.5" style={{ color: T_BLUE }} />
              <span className="text-xs font-bold uppercase tracking-wider" style={{ color: T_TEXT_PRIMARY }}>Queue</span>
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
                const active = invoice.id === selectedInvoiceId;
                return (
                  <button
                    key={invoice.id}
                    onClick={() => setSelectedInvoiceId(invoice.id)}
                    className={`w-full text-left p-4 transition-all hover:bg-slate-50/50 relative ${invoice.status === 'Corrupted' ? 'row-corrupted' : ''
                      }`}
                    style={{
                      background: active ? '#F0F7FF' : undefined,
                    }}
                  >
                    {active && <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-600" />}
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
                    <div className="flex items-center justify-between mt-3">
                      <span className="text-[10px] font-medium" style={{ color: T_TEXT_SECONDARY }}>{formatDate(invoice.invoice_date)}</span>
                      <span className="text-xs font-bold" style={{ color: T_TEXT_PRIMARY }}>{money(invoice.taxable_value)}</span>
                    </div>
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
              <h3 className="font-bold text-xl tracking-tight" style={{ color: T_TEXT_PRIMARY, fontFamily: 'Space Grotesk' }}>Sync Complete</h3>
              <button onClick={() => setSummaryModal((prev) => ({ ...prev, open: false }))} className="p-1 hover:bg-slate-100 rounded-md transition-colors">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Total Sync', value: summaryModal.total, color: T_BLUE, bg: T_BLUE_BG, border: '#DBEAFE' },
                { label: 'Verified', value: summaryModal.valid, color: T_SUCCESS, bg: '#ECFDF5', border: '#D1FAE5' },
                { label: 'Needs Review', value: summaryModal.corrupt, color: T_WARNING, bg: '#FFFBEB', border: '#FEF3C7' },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between px-5 py-4 rounded-lg border shadow-sm" style={{ background: item.bg, borderColor: item.border }}>
                  <span className="text-xs font-bold uppercase tracking-wider" style={{ color: item.color }}>{item.label}</span>
                  <span className="text-2xl font-bold" style={{ color: item.color, fontFamily: 'Space Grotesk' }}>{item.value}</span>
                </div>
              ))}
            </div>
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

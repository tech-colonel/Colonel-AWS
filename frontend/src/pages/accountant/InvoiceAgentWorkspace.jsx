import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Badge } from '../../components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../components/ui/modal';
import {
  Loader2, Play, ExternalLink, FileText, RefreshCw,
  CheckCircle2, Pencil, Save, X, AlertTriangle, Sheet, Zap, Clock
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import api from '../../lib/api';

const API_URL = process.env.REACT_APP_BACKEND_URL || 'http://localhost:8001';

// ─── Helpers ─────────────────────────────────────────────────────────────────
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

// ─── All editable fields with labels and types ────────────────────────────────
const INVOICE_FIELDS = [
  {
    section: 'GST Details',
    fields: [
      { key: 'buyer_gstin', label: 'Buyer GSTIN', type: 'text' },
    ]
  },
  {
    section: 'Product / Classification',
    fields: [
      { key: 'category', label: 'Category', type: 'text' },
      { key: 'product_name', label: 'Product Name', type: 'text' },
      { key: 'hsn_code', label: 'HSN Code', type: 'text' },
      { key: 'quantity', label: 'Quantity', type: 'number' },
      { key: 'unit', label: 'Unit', type: 'text' },
      { key: 'rate', label: 'Rate (₹)', type: 'number' },
    ]
  },
  {
    section: 'GST Rates (%)',
    fields: [
      { key: 'cgst_rate', label: 'CGST Rate', type: 'number' },
      { key: 'sgst_rate', label: 'SGST Rate', type: 'number' },
      { key: 'igst_rate', label: 'IGST Rate', type: 'number' },
    ]
  },
  {
    section: 'GST Amounts (₹)',
    fields: [
      { key: 'cgst_amount', label: 'CGST Amount', type: 'number' },
      { key: 'sgst_amount', label: 'SGST Amount', type: 'number' },
      { key: 'igst_amount', label: 'IGST Amount', type: 'number' },
      { key: 'gst_amount', label: 'Total GST', type: 'number' },
      { key: 'taxable_value', label: 'Taxable Value', type: 'number' },
    ]
  },
  {
    section: 'Link & Status',
    fields: [
      { key: 'invoice_link', label: 'Invoice Link (URL)', type: 'url' },
      { key: 'status', label: 'Status', type: 'text' },
    ]
  },
];

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

// ─── Main Component ───────────────────────────────────────────────────────────
const InvoiceAgentWorkspace = ({ agent }) => {
  const { brandId, agentId } = useParams();

  const [isTriggering, setIsTriggering] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [sheetUrl, setSheetUrl] = useState(null);

  // Live processing status
  const [processingStatus, setProcessingStatus] = useState('idle'); // 'idle' | 'processing' | 'done'
  const [processedCount, setProcessedCount] = useState(0);

  // SSE abort controller ref so we can cancel the stream
  const sseAbortRef = useRef(null);

  // Edit modal state
  const [editingInvoice, setEditingInvoice] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [isSaving, setIsSaving] = useState(false);

  // ─── Fetch invoices ────────────────────────────────────────────────────────
  const fetchInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    try {
      const res = await api.get(`/api/brands/${brandId}/agents/${agentId}/invoices`);
      setInvoices(res.data || []);
    } catch (error) {
      console.error('Failed to fetch invoices:', error);
      setInvoices([]);
    } finally {
      setInvoicesLoading(false);
    }
  }, [brandId, agentId]);

  // ─── Fetch sheet URL ───────────────────────────────────────────────────────
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

  // ─── SSE connection (fetch-based, supports Authorization header) ───────────
  const startSseConnection = useCallback(() => {
    // Cancel any existing SSE connection
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
                } else if (payload.status === 'done') {
                  setProcessingStatus('done');
                  setProcessedCount(payload.count || 0);
                  setIsTriggering(false);
                  // Refresh invoice list
                  await fetchInvoices();
                  // Close SSE — we got what we needed
                  abortController.abort();
                  break;
                }
                // 'idle' — do nothing, initial state
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

  // ─── Process invoices ──────────────────────────────────────────────────────
  const handleTriggerWorkflow = async () => {
    setIsTriggering(true);
    setProcessingStatus('processing');
    setProcessedCount(0);

    // Start listening for SSE updates first
    startSseConnection();

    try {
      await api.post(`/api/brands/${brandId}/agents/${agentId}/invoice/process`, {
        brandId,
        agentId
      });
      // If the webhook returned quickly (small batch), SSE will have already set status to 'done'.
      // If it timed out (large batch), the banner stays 'processing' until n8n calls /api/n8n/feed.
    } catch (error) {
      setIsTriggering(false);
      setProcessingStatus('idle');
      if (sseAbortRef.current) sseAbortRef.current.abort();
      toast.error(error.response?.data?.error || error.message || 'Failed to trigger invoice processing');
    }
  };

  const dismissBanner = () => {
    setProcessingStatus('idle');
  };

  // ─── Edit modal ────────────────────────────────────────────────────────────
  const openEditModal = (invoice) => {
    setEditingInvoice(invoice);
    const formValues = {};
    INVOICE_FIELDS.forEach(section => {
      section.fields.forEach(({ key, type }) => {
        formValues[key] = (type === 'date') ? toInputDate(invoice[key]) : (invoice[key] ?? '');
      });
    });
    setEditForm(formValues);
  };

  const closeEditModal = () => {
    setEditingInvoice(null);
    setEditForm({});
  };

  const handleSave = async () => {
    if (!editingInvoice) return;
    setIsSaving(true);
    try {
      await api.patch(
        `/api/brands/${brandId}/agents/${agentId}/invoices/${editingInvoice.id}`,
        editForm
      );
      toast.success('Invoice updated successfully');
      closeEditModal();
      await fetchInvoices();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to update invoice');
    } finally {
      setIsSaving(false);
    }
  };

  // ─── Derived stats ─────────────────────────────────────────────────────────
  const corruptCount = invoices.filter(i => !i.product_name || i.product_name.trim() === '').length;
  const validCount = invoices.length - corruptCount;

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* Top controls row */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={handleTriggerWorkflow}
          disabled={isTriggering}
          data-testid="process-invoices-button"
        >
          {isTriggering
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            : <Play className="mr-2 h-4 w-4" />}
          {isTriggering ? 'Processing...' : 'Process Invoices'}
        </Button>

        <Button variant="outline" onClick={fetchInvoices} disabled={invoicesLoading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${invoicesLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>

        {sheetUrl ? (
          <Button
            variant="outline"
            asChild
            className="border-green-300 text-green-700 hover:bg-green-50 hover:text-green-800"
            data-testid="invoice-sheet-button"
          >
            <a href={sheetUrl} target="_blank" rel="noopener noreferrer">
              <Sheet className="mr-2 h-4 w-4" />
              Invoice Sheet
            </a>
          </Button>
        ) : null}
      </div>

      {/* ─── Live Processing Status Banner ──────────────────────────────── */}
      <ProcessingBanner
        status={processingStatus}
        count={processedCount}
        onDismiss={dismissBanner}
      />

      {/* Invoices Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Processed Invoices
            {!invoicesLoading && (
              <Badge variant="secondary" className="ml-1">{invoices.length}</Badge>
            )}
            {!invoicesLoading && validCount > 0 && (
              <Badge className="ml-1 bg-green-600 text-white">{validCount} valid</Badge>
            )}
            {!invoicesLoading && corruptCount > 0 && (
              <Badge variant="destructive" className="ml-1">{corruptCount} corrupt</Badge>
            )}
          </CardTitle>
          <CardDescription>
            All invoices processed and stored for {agent?.name}. Rows highlighted in red have a missing product name.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invoicesLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
              <span className="ml-3 text-slate-500 text-sm">Loading invoices...</span>
            </div>
          ) : invoices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-500">
              <FileText className="h-12 w-12 text-slate-300 mb-4" />
              <p className="text-base font-medium">No invoices yet</p>
              <p className="text-sm text-slate-400 mt-1">
                Click "Process Invoices" to fetch and store invoices from n8n
              </p>
            </div>
          ) : (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="font-semibold text-slate-700">Product Name</TableHead>
                    <TableHead className="font-semibold text-slate-700">Category</TableHead>
                    <TableHead className="font-semibold text-slate-700">Buyer GSTIN</TableHead>
                    <TableHead className="font-semibold text-slate-700">GST Amount</TableHead>
                    <TableHead className="font-semibold text-slate-700 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((invoice) => {
                    const missingCompany = !invoice.product_name || invoice.product_name.trim() === '';
                    return (
                      <TableRow
                        key={invoice.id}
                        className={
                          missingCompany
                            ? 'bg-red-50 border-l-4 border-l-red-400 hover:bg-red-100 transition-colors'
                            : 'hover:bg-slate-50 transition-colors'
                        }
                        data-testid={`invoice-row-${invoice.id}`}
                      >
                        <TableCell className="font-medium text-slate-900 max-w-[200px] truncate" title={invoice.product_name}>
                          {invoice.product_name || (
                            <span className="flex items-center gap-1 text-red-500 text-xs font-medium">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              Missing
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-slate-700 text-sm">
                          {invoice.category || '—'}
                        </TableCell>
                        <TableCell className="text-slate-600 text-sm">
                          {invoice.buyer_gstin || '—'}
                        </TableCell>
                        <TableCell className="text-slate-600 text-sm font-medium">
                          ₹{invoice.gst_amount || 0}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openEditModal(invoice)}
                              className="flex items-center gap-1.5"
                              data-testid={`edit-invoice-${invoice.id}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Edit
                            </Button>
                            {invoice.invoice_link ? (
                              <Button
                                size="sm"
                                variant="outline"
                                asChild
                                className="flex items-center gap-1.5 text-blue-600 border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                              >
                                <a href={invoice.invoice_link} target="_blank" rel="noopener noreferrer" data-testid={`view-invoice-${invoice.id}`}>
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  View Invoice
                                </a>
                              </Button>
                            ) : (
                              <span className="text-xs text-slate-400 italic">No link</span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Edit Invoice Modal ────────────────────────────────────────────── */}
      <Dialog open={!!editingInvoice} onOpenChange={(open) => { if (!open) closeEditModal(); }}>
        <DialogContent
          onClose={closeEditModal}
          className="max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
        >
          <DialogHeader>
            <DialogTitle>Edit Invoice</DialogTitle>
            <DialogDescription>
              {editingInvoice?.product_name
                ? `Editing: ${editingInvoice.product_name}`
                : 'Update invoice details below'}
            </DialogDescription>
          </DialogHeader>

          {/* Scrollable form body */}
          <div className="flex-1 overflow-y-auto pr-1 space-y-6 py-2">
            {INVOICE_FIELDS.map(({ section, fields }) => (
              <div key={section}>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3 border-b pb-1">
                  {section}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {fields.map(({ key, label, type }) => (
                    <div key={key} className={key === 'product_name' || key === 'invoice_link' ? 'sm:col-span-2' : ''}>
                      <Label htmlFor={`edit-${key}`} className="text-xs text-slate-600 mb-1 block">
                        {label}
                      </Label>
                      <Input
                        id={`edit-${key}`}
                        type={type === 'url' ? 'text' : type}
                        value={editForm[key] ?? ''}
                        onChange={(e) => setEditForm(prev => ({ ...prev, [key]: e.target.value }))}
                        className="h-9 text-sm"
                        step={type === 'number' ? 'any' : undefined}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Footer actions */}
          <div className="flex justify-end gap-3 pt-4 border-t mt-2">
            <Button variant="outline" onClick={closeEditModal} disabled={isSaving}>
              <X className="mr-2 h-4 w-4" />
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <Save className="mr-2 h-4 w-4" />}
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
};

export default InvoiceAgentWorkspace;

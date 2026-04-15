import React, { useState, useEffect, useCallback } from 'react';
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
  CheckCircle2, Pencil, Save, X, AlertTriangle, Sheet
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import api from '../../lib/api';

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
    section: 'Company Info',
    fields: [
      { key: 'company', label: 'Company', type: 'text' },
      { key: 'invoice_number', label: 'Invoice Number', type: 'text' },
      { key: 'invoice_date', label: 'Invoice Date', type: 'date' },
      { key: 'due_date', label: 'Due Date', type: 'date' },
    ]
  },
  {
    section: 'GST Details',
    fields: [
      { key: 'seller_gstin', label: 'Seller GSTIN', type: 'text' },
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

// ─── Main Component ───────────────────────────────────────────────────────────
const InvoiceAgentWorkspace = ({ agent }) => {
  const { brandId, agentId } = useParams();

  const [isTriggering, setIsTriggering] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [sheetUrl, setSheetUrl] = useState(null);

  // Processing summary popup state
  const [summaryModal, setSummaryModal] = useState({ open: false, total: 0, valid: 0, corrupt: 0 });

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

  // ─── Process invoices ──────────────────────────────────────────────────────
  const handleTriggerWorkflow = async () => {
    setIsTriggering(true);
    try {
      const response = await api.post(`/api/brands/${brandId}/agents/${agentId}/invoice/process`);
      const data = response.data;

      // Calculate valid vs corrupt from returned data
      const allSaved = data.data || [];
      const corruptCount = allSaved.filter(inv => !inv.company || inv.company.trim() === '').length;
      const validCount = allSaved.length - corruptCount;

      // Show summary popup
      setSummaryModal({
        open: true,
        total: data.count || allSaved.length,
        valid: validCount,
        corrupt: corruptCount
      });

      // Refresh list
      await fetchInvoices();
    } catch (error) {
      toast.error(error.response?.data?.error || error.message || 'Failed to trigger invoice processing');
    } finally {
      setIsTriggering(false);
    }
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

        {/* Invoice Sheet button — only shown when URL is configured */}
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

      {/* Invoices Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Processed Invoices
            {!invoicesLoading && (
              <Badge variant="secondary" className="ml-1">{invoices.length}</Badge>
            )}
            {/* Show corrupt count badge if any */}
            {!invoicesLoading && invoices.filter(i => !i.company || i.company.trim() === '').length > 0 && (
              <Badge variant="destructive" className="ml-1">
                {invoices.filter(i => !i.company || i.company.trim() === '').length} corrupt
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            All invoices processed and stored for {agent?.name}. Rows highlighted in red have a missing company name.
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
                    <TableHead className="font-semibold text-slate-700">Company</TableHead>
                    <TableHead className="font-semibold text-slate-700">Invoice Number</TableHead>
                    <TableHead className="font-semibold text-slate-700">Invoice Date</TableHead>
                    <TableHead className="font-semibold text-slate-700">Due Date</TableHead>
                    <TableHead className="font-semibold text-slate-700 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((invoice) => {
                    const missingCompany = !invoice.company || invoice.company.trim() === '';
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
                        <TableCell className="font-medium text-slate-900 max-w-[200px] truncate" title={invoice.company}>
                          {invoice.company || (
                            <span className="flex items-center gap-1 text-red-500 text-xs font-medium">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              Missing
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-slate-700 font-mono text-sm">
                          {invoice.invoice_number || '—'}
                        </TableCell>
                        <TableCell className="text-slate-600 text-sm">
                          {formatDate(invoice.invoice_date)}
                        </TableCell>
                        <TableCell className="text-slate-600 text-sm">
                          {formatDate(invoice.due_date)}
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

      {/* ─── Processing Summary Modal ──────────────────────────────────────── */}
      <Dialog open={summaryModal.open} onOpenChange={(open) => { if (!open) setSummaryModal(prev => ({ ...prev, open: false })); }}>
        <DialogContent
          onClose={() => setSummaryModal(prev => ({ ...prev, open: false }))}
          className="max-w-sm"
        >
          <DialogHeader>
            <DialogTitle>Processing Complete</DialogTitle>
            <DialogDescription>Summary of the invoice run</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Total */}
            <div className="flex items-center justify-between px-4 py-3 bg-slate-50 rounded-lg border border-slate-200">
              <span className="text-sm font-medium text-slate-600">Total Saved</span>
              <Badge variant="secondary" className="text-base font-bold px-3 py-1">
                {summaryModal.total}
              </Badge>
            </div>

            {/* Valid */}
            <div className="flex items-center justify-between px-4 py-3 bg-green-50 rounded-lg border border-green-200">
              <span className="text-sm font-medium text-green-700 flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                Valid Invoices
              </span>
              <Badge className="bg-green-600 text-white text-base font-bold px-3 py-1">
                {summaryModal.valid}
              </Badge>
            </div>

            {/* Corrupt */}
            <div className="flex items-center justify-between px-4 py-3 bg-red-50 rounded-lg border border-red-200">
              <span className="text-sm font-medium text-red-700 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4" />
                Corrupt (missing company)
              </span>
              <Badge className="bg-red-500 text-white text-base font-bold px-3 py-1">
                {summaryModal.corrupt}
              </Badge>
            </div>

            {summaryModal.corrupt > 0 && (
              <p className="text-xs text-slate-500 text-center">
                Corrupt entries are highlighted in red in the table. Use the <strong>Edit</strong> button to fix them.
              </p>
            )}
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={() => setSummaryModal(prev => ({ ...prev, open: false }))}>
              Got it
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Edit Invoice Modal ────────────────────────────────────────────── */}
      <Dialog open={!!editingInvoice} onOpenChange={(open) => { if (!open) closeEditModal(); }}>
        <DialogContent
          onClose={closeEditModal}
          className="max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
        >
          <DialogHeader>
            <DialogTitle>Edit Invoice</DialogTitle>
            <DialogDescription>
              {editingInvoice?.invoice_number
                ? `Editing: ${editingInvoice.invoice_number} — ${editingInvoice.company || 'No company'}`
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

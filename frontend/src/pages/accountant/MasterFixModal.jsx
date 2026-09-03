/* ──────────────────────────────────────────────────────────────────────────────
   MasterFixModal — fix an "N/A" on an invoice and teach it, so it never comes
   back as N/A again.

   An N/A has two causes and they need different answers, so the modal decides
   which one it is from the row rather than asking the accountant to know:

     Case A — the vendor's GSTIN isn't in the vendor sheet, so n8n returned N/A
              for the vendor, and the category then had nothing to work from
              either. BOTH fields are N/A. We ask for the Tally vendor name and
              its expense head, and fill both.

              Both are required together on purpose: a row is auto-approved
              unless the vendor AND category are missing, so saving a vendor on
              its own would silently mark the invoice Approved while its
              category was still unresolved.

     Case B — a marketplace (Amazon, Flipkart …) billed a fee type no rule
              covers. The vendor is fine; only the category is N/A. We ask for
              the ledger for this fee type and store it against the vendor NAME,
              so the one rule covers every state GSTIN of that marketplace.
   ────────────────────────────────────────────────────────────────────────────── */

import React, { useState, useMemo } from 'react';
import { X, Loader2, Sparkles, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';

const NA_TOKENS = new Set(['n/a', 'na', 'n.a.', 'missing', 'none', 'nil', '-', '—', 'null', 'undefined']);
const isMissing = (v) => v === null || v === undefined || String(v).trim() === ''
  || NA_TOKENS.has(String(v).trim().toLowerCase());

/** Mirrors the backend's normalize() closely enough to preview what will match.
 *  Display only — the server always recomputes it. */
const previewNorm = (text) => String(text || '').toLowerCase()
  .replace(/private limited|pvt ltd|pvt\. ltd\.|limited|ltd/g, '')
  .replace(/amazon|blinkit/g, '')
  .replace(/fee|fees|charges|charge/g, '')
  .replace(/[^a-z]/g, '')
  .trim();

const T_BORDER = '#E5E7EB';
const T_TEXT = '#111827';
const T_MUTED = '#6B7280';

export default function MasterFixModal({ open, invoice, brandId, onClose, onSaved }) {
  const vendorMissing = isMissing(invoice?.vendor_name_tally);
  const kind = vendorMissing ? 'A' : 'B';

  const [vendorName, setVendorName] = useState('');
  const [nature, setNature] = useState('');
  const [ledger, setLedger] = useState('');
  const [pattern, setPattern] = useState('');
  const [backfill, setBackfill] = useState(true);
  const [saving, setSaving] = useState(false);

  // Reset whenever a different row is opened.
  const rowId = invoice?.id;
  React.useEffect(() => {
    setVendorName('');
    setNature('');
    setLedger('');
    setPattern(invoice?.product_name || '');
    setBackfill(true);
  }, [rowId, invoice?.product_name]);

  const patternNorm = useMemo(() => previewNorm(pattern), [pattern]);
  const patternTooShort = kind === 'B' && patternNorm.length > 0 && patternNorm.length < 4;

  if (!open || !invoice) return null;

  const canSave = kind === 'A'
    ? vendorName.trim().length > 0 && nature.trim().length > 0
    : ledger.trim().length > 0 && patternNorm.length >= 4;

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const body = kind === 'A'
        ? {
          invoice_row_id: invoice.id,
          vendor_name_tally: vendorName.trim(),
          nature_of_expense: nature.trim(),
          backfill,
        }
        : {
          invoice_row_id: invoice.id,
          category: ledger.trim(),
          pattern: pattern.trim(),
          backfill,
        };
      const res = await api.post(`/api/brands/${brandId}/invoice/master/resolve`, body);
      const n = res.data?.applied_rows ?? 0;
      toast.success(
        n > 1
          ? `Saved — ${n} rows fixed across this brand`
          : 'Saved — this row is fixed and the rule is remembered',
      );
      if (res.data?.partial) {
        toast.info(`${res.data.remaining} more rows still to backfill — finishing in the background.`);
      }
      onSaved?.(res.data);
      onClose?.();
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message || 'Could not save the fix');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(17,24,39,0.55)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl shadow-2xl"
        style={{ background: '#FFFFFF' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-start justify-between border-b px-5 py-4" style={{ borderColor: T_BORDER }}>
          <div>
            <div className="flex items-center gap-2">
              <Sparkles size={16} style={{ color: '#B45309' }} />
              <h3 className="text-base font-semibold" style={{ color: T_TEXT }}>
                {kind === 'A' ? 'Add this vendor' : 'Add this fee type'}
              </h3>
            </div>
            <p className="mt-1 text-xs" style={{ color: T_MUTED }}>
              {kind === 'A'
                ? 'This vendor is not in the vendor master, so both the vendor and category came back N/A.'
                : 'This vendor is known, but no rule covers this fee type yet.'}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-gray-100" aria-label="Close">
            <X size={18} style={{ color: T_MUTED }} />
          </button>
        </div>

        {/* invoice context */}
        <div className="px-5 py-3 text-xs" style={{ background: '#F9FAFB', color: T_MUTED }}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div><span className="font-medium">Invoice:</span> {invoice.invoice_number || '—'}</div>
            <div><span className="font-medium">GSTIN:</span> {invoice.seller_gstin || '—'}</div>
            <div className="col-span-2"><span className="font-medium">Vendor:</span> {invoice.company || '—'}</div>
            <div className="col-span-2"><span className="font-medium">Line item:</span> {invoice.product_name || '—'}</div>
          </div>
        </div>

        {/* body */}
        <div className="space-y-4 px-5 py-4">
          {kind === 'A' ? (
            <>
              <Field
                label="Vendor name as per Tally"
                hint="Exactly as the ledger is named in Tally."
                value={vendorName}
                onChange={setVendorName}
                placeholder="e.g. Sharma Courier Services"
              />
              <Field
                label="Nature of expense (category)"
                hint="The expense head this vendor books to."
                value={nature}
                onChange={setNature}
                placeholder="e.g. Courier Expenses Local"
              />
              <p className="rounded-md px-3 py-2 text-xs" style={{ background: '#FFFBEB', color: '#92400E' }}>
                Both are needed. Saving only the vendor would mark this invoice approved while its
                category was still unresolved.
              </p>
            </>
          ) : (
            <>
              <Field
                label="Tally ledger for this fee"
                hint="Where this fee type should book."
                value={ledger}
                onChange={setLedger}
                placeholder="e.g. Seller Commission (Amazon)"
              />
              <Field
                label="Match on"
                hint="Any line item containing this text books to that ledger."
                value={pattern}
                onChange={setPattern}
                placeholder="e.g. Seller Commission"
              />
              {patternTooShort ? (
                <p className="flex items-start gap-2 rounded-md px-3 py-2 text-xs" style={{ background: '#FEF2F2', color: '#B91C1C' }}>
                  <AlertTriangle size={14} className="mt-[1px] shrink-0" />
                  Too short to match on safely — it would catch almost every line item. Use a longer phrase.
                </p>
              ) : (
                <p className="text-xs" style={{ color: T_MUTED }}>
                  Matches on <code style={{ background: '#F3F4F6', padding: '1px 4px', borderRadius: 3 }}>{patternNorm || '…'}</code>
                  {' '}— punctuation, case and the word “fee” are ignored, so “Seller Commission&nbsp;- short charged” matches too.
                </p>
              )}
              <p className="rounded-md px-3 py-2 text-xs" style={{ background: '#F0F9FF', color: '#075985' }}>
                Saved against the vendor’s <strong>name</strong>, so this one rule covers every state
                GSTIN of this marketplace.
              </p>
            </>
          )}

          <label className="flex items-center gap-2 text-sm" style={{ color: T_TEXT }}>
            <input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} />
            Also fix other invoices of this brand that match
          </label>
        </div>

        {/* footer */}
        <div className="flex justify-end gap-2 border-t px-5 py-3" style={{ borderColor: T_BORDER }}>
          <button
            onClick={onClose}
            className="rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: T_BORDER, color: T_TEXT }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!canSave || saving}
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: '#0748EE' }}
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? 'Saving…' : 'Save & apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

const Field = ({ label, hint, value, onChange, placeholder }) => (
  <div>
    <label className="mb-1 block text-xs font-medium" style={{ color: T_TEXT }}>{label}</label>
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/20"
      style={{ borderColor: T_BORDER, color: T_TEXT, background: '#FFFFFF' }}
    />
    {hint && <p className="mt-1 text-xs" style={{ color: T_MUTED }}>{hint}</p>}
  </div>
);

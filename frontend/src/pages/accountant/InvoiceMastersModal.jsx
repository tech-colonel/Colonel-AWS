/* ──────────────────────────────────────────────────────────────────────────────
   InvoiceMastersModal — the two masters behind Invoice Process, in one screen.

   They are deliberately shown from DIFFERENT sources, because they live in
   different places and we do not copy either of them:

     Vendor master  — the Google Sheet n8n's AI Agent reads, embedded as an
                      iframe. Always current, editable in place, and nothing can
                      drift because there is no second copy. Adding a row here
                      means n8n resolves that vendor natively on the next run.

     Category master — rules an accountant taught us, stored in our DB. This is
                      NOT a copy of n8n's hardcoded CATEGORY_MASTER array: we
                      only ever act on values n8n returned as "N/A", so
                      duplicating rules it already has would fill nothing. The
                      list starts empty and grows as N/As get fixed.
   ────────────────────────────────────────────────────────────────────────────── */

import React, { useState, useEffect, useCallback } from 'react';
import { X, Loader2, Trash2, ExternalLink, Table2, Sheet as SheetIcon, Info } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';

const T_BORDER = '#E5E7EB';
const T_TEXT = '#111827';
const T_MUTED = '#6B7280';
const T_BLUE = '#0748EE';

export default function InvoiceMastersModal({ open, brandId, vendorMasterUrl, onClose, onChanged }) {
  const [tab, setTab] = useState('category');
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    if (!brandId) return;
    setLoading(true);
    try {
      const res = await api.get(`/api/brands/${brandId}/invoice/category-master`);
      setRules(res.data?.rows || []);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not load the category master');
    } finally {
      setLoading(false);
    }
  }, [brandId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  if (!open) return null;

  const remove = async (row) => {
    if (!window.confirm(`Delete the rule "${row.pattern_raw || row.pattern_norm}" → ${row.ledger}?\n\nInvoices already booked keep their category; only future matching stops.`)) return;
    setBusyId(row.id);
    try {
      await api.delete(`/api/brands/${brandId}/invoice/category-master/${row.id}`);
      setRules((prev) => prev.filter((r) => r.id !== row.id));
      toast.success('Rule deleted');
      onChanged?.();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not delete the rule');
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (row) => {
    setBusyId(row.id);
    try {
      await api.patch(`/api/brands/${brandId}/invoice/category-master/${row.id}`, { is_active: !row.is_active });
      setRules((prev) => prev.map((r) => (r.id === row.id ? { ...r, is_active: !r.is_active } : r)));
      onChanged?.();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not update the rule');
    } finally {
      setBusyId(null);
    }
  };

  const filtered = q.trim()
    ? rules.filter((r) => `${r.vendor_key} ${r.pattern_raw} ${r.ledger}`.toLowerCase().includes(q.trim().toLowerCase()))
    : rules;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(17,24,39,0.55)' }} onClick={onClose}>
      <div className="flex h-[85vh] w-full max-w-5xl flex-col rounded-xl shadow-2xl"
        style={{ background: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>

        {/* header + tabs */}
        <div className="flex items-center justify-between border-b px-5 py-3" style={{ borderColor: T_BORDER }}>
          <div className="flex items-center gap-1">
            {[
              { id: 'category', label: 'Category Master', icon: Table2 },
              { id: 'vendor', label: 'Vendor Master', icon: SheetIcon },
            ].map((t) => {
              const Icon = t.icon;
              const on = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
                  style={{ background: on ? '#EEF2FF' : 'transparent', color: on ? T_BLUE : T_MUTED }}>
                  <Icon size={15} />
                  {t.label}
                  {t.id === 'category' && rules.length > 0 && (
                    <span className="rounded px-1.5 text-[11px]" style={{ background: on ? T_BLUE : '#E5E7EB', color: on ? '#FFF' : T_MUTED }}>
                      {rules.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-gray-100" aria-label="Close">
            <X size={18} style={{ color: T_MUTED }} />
          </button>
        </div>

        {/* body */}
        {tab === 'vendor' ? (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-2 text-xs" style={{ background: '#F0F9FF', color: '#075985' }}>
              <Info size={14} className="shrink-0" />
              <span>
                This is the live sheet n8n reads. Edits here take effect on the next run — add a vendor’s
                GSTIN and Tally name and it resolves automatically, with nothing to sync.
              </span>
              {vendorMasterUrl && (
                <a href={vendorMasterUrl} target="_blank" rel="noreferrer"
                  className="ml-auto flex shrink-0 items-center gap-1 font-medium hover:underline">
                  Open in Sheets <ExternalLink size={12} />
                </a>
              )}
            </div>
            {vendorMasterUrl ? (
              <iframe title="Vendor Master" src={vendorMasterUrl} className="flex-1 w-full border-0" />
            ) : (
              <div className="flex flex-1 items-center justify-center p-8 text-center text-sm" style={{ color: T_MUTED }}>
                <div>
                  <p className="font-medium" style={{ color: T_TEXT }}>No vendor master sheet configured for this brand.</p>
                  <p className="mt-1">
                    Set <code style={{ background: '#F3F4F6', padding: '1px 4px', borderRadius: 3 }}>&lt;Brand&gt;_vendor_master_sheet</code> in the backend .env
                    to the sheet n8n reads, then reopen this screen.
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-2 text-xs" style={{ background: '#FFFBEB', color: '#92400E' }}>
              <Info size={14} className="shrink-0" />
              <span>
                Fee types your team taught us. These fill in only where n8n returned <strong>N/A</strong> —
                they never override what it already resolved. Each rule is stored against the vendor’s
                name, so it covers every state GSTIN of that marketplace.
              </span>
            </div>

            <div className="px-5 py-2">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vendor, pattern or ledger…"
                className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/20"
                style={{ borderColor: T_BORDER, color: T_TEXT }} />
            </div>

            <div className="flex-1 overflow-auto px-5 pb-4">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm" style={{ color: T_MUTED }}>
                  <Loader2 size={16} className="animate-spin" /> Loading…
                </div>
              ) : filtered.length === 0 ? (
                <div className="py-12 text-center text-sm" style={{ color: T_MUTED }}>
                  {rules.length === 0 ? (
                    <>
                      <p className="font-medium" style={{ color: T_TEXT }}>Nothing taught yet.</p>
                      <p className="mt-1">
                        When an invoice line shows <strong>N/A</strong> for its category, click <strong>Fix</strong> on it —
                        the rule you enter appears here and applies to every future invoice.
                      </p>
                    </>
                  ) : 'No rules match that search.'}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ color: T_MUTED }} className="text-left text-xs uppercase">
                      <th className="py-2 font-medium">Vendor</th>
                      <th className="py-2 font-medium">Matches line items containing</th>
                      <th className="py-2 font-medium">Books to ledger</th>
                      <th className="py-2 font-medium text-center">Active</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.id} className="border-t" style={{ borderColor: T_BORDER, opacity: r.is_active ? 1 : 0.5 }}>
                        <td className="py-2 pr-3" style={{ color: T_TEXT }}>
                          {r.vendor_label || r.vendor_key}
                          <div className="text-xs" style={{ color: T_MUTED }}>{r.vendor_key}</div>
                        </td>
                        <td className="py-2 pr-3" style={{ color: T_TEXT }}>
                          {r.pattern_raw || '—'}
                          <div className="text-xs" style={{ color: T_MUTED }}>
                            <code>{r.pattern_norm}</code>
                          </div>
                        </td>
                        <td className="py-2 pr-3" style={{ color: T_TEXT }}>{r.ledger}</td>
                        <td className="py-2 text-center">
                          <input type="checkbox" checked={!!r.is_active} disabled={busyId === r.id}
                            onChange={() => toggleActive(r)} />
                        </td>
                        <td className="py-2 text-right">
                          <button onClick={() => remove(r)} disabled={busyId === r.id}
                            className="rounded p-1 hover:bg-red-50" title="Delete rule">
                            {busyId === r.id
                              ? <Loader2 size={15} className="animate-spin" style={{ color: T_MUTED }} />
                              : <Trash2 size={15} style={{ color: '#DC2626' }} />}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

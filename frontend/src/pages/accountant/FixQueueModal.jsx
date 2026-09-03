/* ──────────────────────────────────────────────────────────────────────────────
   FixQueueModal — every unresolved vendor / fee type for this brand, in one
   place, grouped by WHAT NEEDS TEACHING rather than by invoice.

   Why not a list of invoices: one unrecognised fee type ("Seller Commission")
   can appear on hundreds of invoices, and teaching it once fixes all of them.
   Listing invoices would send an accountant hunting row by row through what is
   really a handful of decisions. Each row here is one decision; the counts show
   exactly how much work it clears.

   Biggest group first, so the single most valuable fix is always on top.
   ────────────────────────────────────────────────────────────────────────────── */

import React, { useState, useEffect, useCallback } from 'react';
import { X, Loader2, AlertTriangle, CheckCircle2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import api from '../../lib/api';

const T_BORDER = '#E5E7EB';
const T_TEXT = '#111827';
const T_MUTED = '#6B7280';
const T_BLUE = '#0748EE';

export default function FixQueueModal({ open, brandId, onClose, onChanged }) {
  const [groups, setGroups] = useState([]);
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState({});   // key -> { ledger } | { vendor, nature }
  const [savingKey, setSavingKey] = useState(null);
  const [doneKeys, setDoneKeys] = useState({});   // key -> rows fixed

  const keyOf = (g, i) => `${g.kind}|${g.vendor}|${g.pattern_norm || g.seller_gstin || i}`;

  const load = useCallback(async () => {
    if (!brandId) return;
    setLoading(true);
    try {
      const res = await api.get(`/api/brands/${brandId}/invoice/na-summary`);
      setGroups(res.data?.groups || []);
      setTotals(res.data?.totals || null);
      setDoneKeys({});
      setDraft({});
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not load the fix queue');
    } finally {
      setLoading(false);
    }
  }, [brandId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  if (!open) return null;

  const save = async (g, key) => {
    const d = draft[key] || {};
    const body = g.kind === 'A'
      ? {
        invoice_row_id: g.sample_row_id,
        vendor_name_tally: (d.vendor || '').trim(),
        nature_of_expense: (d.nature || '').trim(),
        source: 'fix_queue',
      }
      : {
        invoice_row_id: g.sample_row_id,
        category: (d.ledger || '').trim(),
        pattern: g.pattern || '',
        source: 'fix_queue',
      };

    setSavingKey(key);
    try {
      const res = await api.post(`/api/brands/${brandId}/invoice/master/resolve`, body);
      const n = res.data?.applied_rows ?? 0;
      setDoneKeys((prev) => ({ ...prev, [key]: n }));
      toast.success(`Fixed ${n} line item${n !== 1 ? 's' : ''}`);
      onChanged?.();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Could not save');
    } finally {
      setSavingKey(null);
    }
  };

  const canSave = (g, key) => {
    const d = draft[key] || {};
    return g.kind === 'A'
      ? (d.vendor || '').trim() && (d.nature || '').trim()
      : (d.ledger || '').trim();
  };

  const pending = groups.filter((g, i) => doneKeys[keyOf(g, i)] === undefined);
  const fixedCount = Object.values(doneKeys).reduce((a, b) => a + b, 0);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(17,24,39,0.55)' }} onClick={onClose}>
      <div className="flex h-[85vh] w-full max-w-3xl flex-col rounded-xl shadow-2xl"
        style={{ background: '#FFFFFF' }} onClick={(e) => e.stopPropagation()}>

        <div className="flex items-start justify-between border-b px-5 py-4" style={{ borderColor: T_BORDER }}>
          <div>
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} style={{ color: '#B45309' }} />
              <h3 className="text-base font-semibold" style={{ color: T_TEXT }}>Fix unresolved ledgers</h3>
            </div>
            <p className="mt-1 text-xs" style={{ color: T_MUTED }}>
              {totals
                ? <>Grouped by what needs teaching — <strong>{totals.groups}</strong> {totals.groups === 1 ? 'thing' : 'things'} to
                  fix, covering <strong>{totals.lines}</strong> line item{totals.lines !== 1 ? 's' : ''} across{' '}
                  <strong>{totals.invoices}</strong> invoice{totals.invoices !== 1 ? 's' : ''}.</>
                : 'Every unresolved vendor and fee type for this brand.'}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-gray-100" aria-label="Close">
            <X size={18} style={{ color: T_MUTED }} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm" style={{ color: T_MUTED }}>
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : groups.length === 0 ? (
            <div className="py-16 text-center text-sm" style={{ color: T_MUTED }}>
              <CheckCircle2 size={28} style={{ color: '#059669' }} className="mx-auto mb-2" />
              <p className="font-medium" style={{ color: T_TEXT }}>Nothing unresolved.</p>
              <p className="mt-1">Every invoice for this brand has a vendor and a ledger.</p>
            </div>
          ) : pending.length === 0 ? (
            <div className="py-16 text-center text-sm" style={{ color: T_MUTED }}>
              <CheckCircle2 size={28} style={{ color: '#059669' }} className="mx-auto mb-2" />
              <p className="font-medium" style={{ color: T_TEXT }}>All done — {fixedCount} line items fixed.</p>
              <p className="mt-1">These rules now apply to every future invoice too.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map((g, i) => {
                const key = keyOf(g, i);
                const fixed = doneKeys[key];
                if (fixed !== undefined) {
                  return (
                    <div key={key} className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm"
                      style={{ borderColor: '#A7F3D0', background: '#ECFDF5', color: '#065F46' }}>
                      <CheckCircle2 size={15} />
                      <span><strong>{g.pattern || g.vendor}</strong> — {fixed} line item{fixed !== 1 ? 's' : ''} fixed</span>
                    </div>
                  );
                }
                const d = draft[key] || {};
                const set = (patch) => setDraft((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
                return (
                  <div key={key} className="rounded-lg border p-4" style={{ borderColor: T_BORDER }}>
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold"
                            style={g.kind === 'A'
                              ? { background: '#FEE2E2', color: '#991B1B' }
                              : { background: '#FEF3C7', color: '#92400E' }}>
                            {g.kind === 'A' ? 'VENDOR UNKNOWN' : 'FEE TYPE UNKNOWN'}
                          </span>
                          <span className="truncate text-sm font-semibold" style={{ color: T_TEXT }}>{g.vendor}</span>
                        </div>
                        {g.kind === 'B' && (
                          <p className="mt-1 truncate text-xs" style={{ color: T_MUTED }}>
                            Line items like “{g.pattern}”
                          </p>
                        )}
                        {g.kind === 'A' && g.seller_gstin && (
                          <p className="mt-1 text-xs" style={{ color: T_MUTED }}>GSTIN {g.seller_gstin}</p>
                        )}
                      </div>
                      <span className="shrink-0 text-right text-xs" style={{ color: '#B45309' }}>
                        <strong>{g.lines}</strong> line{g.lines !== 1 ? 's' : ''}
                        <br />{g.invoices} invoice{g.invoices !== 1 ? 's' : ''}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-end gap-2">
                      {g.kind === 'A' ? (
                        <>
                          <Inp label="Vendor name as per Tally" value={d.vendor || ''} onChange={(v) => set({ vendor: v })} />
                          <Inp label="Nature of expense" value={d.nature || ''} onChange={(v) => set({ nature: v })} />
                        </>
                      ) : (
                        <Inp label="Tally ledger for this fee" wide value={d.ledger || ''} onChange={(v) => set({ ledger: v })} />
                      )}
                      <button
                        onClick={() => save(g, key)}
                        disabled={!canSave(g, key) || savingKey === key}
                        className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                        style={{ background: T_BLUE }}
                      >
                        {savingKey === key ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                        Fix {g.lines}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t px-5 py-3" style={{ borderColor: T_BORDER }}>
          <span className="text-xs" style={{ color: T_MUTED }}>
            Each fix is remembered — it applies to every future invoice automatically.
          </span>
          <button onClick={onClose} className="rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: T_BORDER, color: T_TEXT }}>Close</button>
        </div>
      </div>
    </div>
  );
}

const Inp = ({ label, value, onChange, wide }) => (
  <div className={wide ? 'min-w-[260px] flex-1' : 'min-w-[180px] flex-1'}>
    <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide" style={{ color: T_MUTED }}>{label}</label>
    <input value={value} onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/20"
      style={{ borderColor: T_BORDER, color: T_TEXT }} />
  </div>
);

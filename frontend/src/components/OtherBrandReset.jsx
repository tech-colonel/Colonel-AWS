import React, { useState } from 'react';
import { RotateCcw, Info } from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';
import { OTHER_BRAND_ID } from '../lib/constants';

/**
 * Shown ONLY for the "Other" catch-all brand. Renders a note that its reference
 * data is temporary + a Reset button that purges Other's master data (COA, SKU /
 * Ledger master, learned bank corrections). Processed results are kept.
 * Renders nothing for any real brand.
 */
export default function OtherBrandReset({ brandId, onReset }) {
  const [busy, setBusy] = useState(false);
  if (brandId !== OTHER_BRAND_ID) return null;

  const reset = async () => {
    if (!window.confirm(
      'Clear temporary reference data (COA, SKU/Ledger master, learned corrections) for the "Other" brand?\n\nProcessed results are kept.'
    )) return;
    setBusy(true);
    try {
      const r = await api.post(`/api/brands/${brandId}/purge-session-master`);
      toast.success('Temporary data cleared for "Other"');
      onReset && onReset(r.data);
    } catch (e) {
      toast.error('Reset failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '8px 12px', borderRadius: 10, border: '1px dashed var(--card-border)',
      background: 'var(--page-bg)',
    }}>
      <Info style={{ width: 15, height: 15, color: 'var(--text-muted)', flexShrink: 0 }} />
      <span style={{ fontSize: 12.5, color: 'var(--text-muted)', flex: 1, minWidth: 180 }}>
        Reference data for <strong>Other</strong> is temporary — it is replaced on each new run and can be cleared anytime. Processed results are kept.
      </span>
      <button
        onClick={reset}
        disabled={busy}
        data-testid="other-reset-btn"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
          borderRadius: 8, border: '1px solid var(--card-border)', background: 'var(--surface)',
          cursor: busy ? 'default' : 'pointer', fontSize: 12.5, fontWeight: 600,
          color: '#E11D48', opacity: busy ? 0.6 : 1,
        }}
      >
        <RotateCcw style={{ width: 14, height: 14 }} />
        {busy ? 'Clearing…' : 'Reset session data'}
      </button>
    </div>
  );
}

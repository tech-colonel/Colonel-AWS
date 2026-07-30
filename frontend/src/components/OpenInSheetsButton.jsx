import React, { useState } from 'react';
import { Loader2, FileSpreadsheet } from 'lucide-react';
import { toast } from 'sonner';
import api from '../lib/api';

/* ──────────────────────────────────────────────────────────────────────────────
   OpenInSheetsButton — opens a reco job's output directly as a Google Sheet
   (POST /api/reco/open-in-sheets/:jobId → { url }), so users don't have to
   download the Excel every time. The Sheet is created in the connected Google
   account and shared "anyone with the link". Sits next to Download Excel.
   ────────────────────────────────────────────────────────────────────────────── */
export default function OpenInSheetsButton({ jobId, name, style }) {
  const [opening, setOpening] = useState(false);
  if (!jobId) return null;

  const open = async () => {
    setOpening(true);
    // Open the tab synchronously so the browser doesn't block the popup.
    const tab = window.open('', '_blank');
    try {
      const { data } = await api.post(`/api/reco/open-in-sheets/${jobId}`, {}, { params: { name: name || 'Reconciliation' } });
      if (tab) tab.location = data.url; else window.open(data.url, '_blank');
    } catch (e) {
      if (tab) tab.close();
      toast.error(e.response?.data?.error || 'Could not open in Google Sheets');
    } finally { setOpening(false); }
  };

  return (
    <button
      onClick={open} disabled={opening}
      title="Open the result as a Google Sheet"
      style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: '8px 16px',
        borderRadius: 8, fontSize: 13, fontWeight: 700, fontFamily: 'Barlow',
        background: 'var(--surface)', color: 'var(--text-heading)',
        border: '1px solid var(--card-border)', cursor: opening ? 'default' : 'pointer',
        opacity: opening ? 0.6 : 1,
        ...style,
      }}
    >
      {opening ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : <FileSpreadsheet style={{ width: 15, height: 15, color: '#0F9D58' }} />}
      {opening ? 'Opening…' : 'Open in Google Sheets'}
    </button>
  );
}

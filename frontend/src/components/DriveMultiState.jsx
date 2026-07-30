import React, { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import api from '../lib/api';
import BrandLogo from './BrandLogos';

/* ──────────────────────────────────────────────────────────────────────────────
   DriveMultiState — "From Google Drive" for the Multi-State 2B-vs-Books agent.

   Paste ONE folder with every state's files. The backend groups them per state
   by the GSTIN state code / state name in each filename (POST /api/drive/route
   returns { states:[{code,label,gstr2b,purchase,debit}], unassigned, files }).
   We show the detected states with editable per-slot dropdowns; on confirm we
   hand the parent a driveStates array:
       [{ gstr2b:{fileId,name}, purchase:{fileId,name}, debit:{fileId,name}|null }]
   which the parent sends as `drive_states` to /api/reco/run. Manual per-state
   upload stays untouched above this section.
   ────────────────────────────────────────────────────────────────────────────── */

const ACCENT = 'var(--accent, #0748EE)';
const AGENT_TYPE = 'gstr_2b_books_multistate';

export default function DriveMultiState({ onConfirmed }) {
  const [url, setUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [scan, setScan] = useState(null);   // { states, unassigned, files, serviceAccountEmail }
  const [sel, setSel] = useState([]);        // [{ gstr2b, purchase, debit }] fileIds, aligned to scan.states
  const [confirmed, setConfirmed] = useState(false);
  const [lastAnalyzed, setLastAnalyzed] = useState('');

  const files = scan?.files || [];
  const states = scan?.states || [];
  const nameOf = (id) => files.find((f) => f.fileId === id)?.name || id;

  const clearDrive = () => {
    setScan(null); setSel([]); setConfirmed(false); setUrl(''); setError(''); setLastAnalyzed('');
    onConfirmed && onConfirmed(null);
  };

  const buildDriveStates = (selArr, sts) =>
    sts.map((_, i) => {
      const s = selArr[i] || {};
      return {
        gstr2b: s.gstr2b ? { fileId: s.gstr2b, name: nameOf(s.gstr2b) } : null,
        purchase: s.purchase ? { fileId: s.purchase, name: nameOf(s.purchase) } : null,
        debit: s.debit ? { fileId: s.debit, name: nameOf(s.debit) } : null,
      };
    }).filter((st) => st.gstr2b && st.purchase);

  const runAnalyze = async (link) => {
    const target = String(link ?? url).trim();
    if (!target || scanning) return;
    setScanning(true); setError(''); setScan(null); setConfirmed(false);
    onConfirmed && onConfirmed(null);
    try {
      const { data } = await api.post('/api/drive/route', { folder_url: target, agent_type: AGENT_TYPE });
      const sts = data.states || [];
      const seed = sts.map((st) => ({
        gstr2b: st.gstr2b?.[0]?.fileId || '',
        purchase: st.purchase?.[0]?.fileId || '',
        debit: st.debit?.[0]?.fileId || '',
      }));
      setScan(data); setSel(seed); setLastAnalyzed(target);
      // Auto-confirm when every detected state has at least GSTR-2B + Purchase.
      const allReady = sts.length > 0 && seed.every((s) => s.gstr2b && s.purchase);
      if (allReady) {
        setConfirmed(true);
        onConfirmed && onConfirmed(buildDriveStates(seed, sts));
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Could not scan that Drive link.');
      setLastAnalyzed(target);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    const t = String(url || '').trim();
    if (!t || t === lastAnalyzed || confirmed) return;
    if (!/(drive\.google\.com|\/folders\/|\/file\/d\/)/.test(t)) return;
    const id = setTimeout(() => { runAnalyze(t); }, 700);
    return () => clearTimeout(id);
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  const setStateSlot = (i, key, fileId) => {
    setConfirmed(false); onConfirmed && onConfirmed(null);
    setSel((p) => p.map((s, idx) => idx === i ? { ...s, [key]: fileId } : s));
  };

  const missing = states.filter((_, i) => !(sel[i]?.gstr2b) || !(sel[i]?.purchase));
  const confirm = () => {
    if (missing.length) return;
    setConfirmed(true);
    onConfirmed && onConfirmed(buildDriveStates(sel, states));
  };

  const sectionStyle = {
    marginTop: 16, borderRadius: 14,
    border: `1px solid ${confirmed ? 'rgba(5,150,105,0.35)' : 'var(--card-border)'}`,
    background: 'var(--surface)', overflow: 'hidden',
  };
  const selectStyle = { padding: '8px 9px', borderRadius: 8, border: '1px solid var(--card-border)', background: 'var(--page-bg)', color: 'var(--text-heading)', fontSize: 12, width: '100%' };

  return (
    <div style={sectionStyle}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px',
        borderBottom: '1px solid var(--card-border)',
        background: 'linear-gradient(0deg, transparent, rgba(7,72,238,0.03))',
      }}>
        <BrandLogo type="google_drive" size={22} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-heading)' }}>From Google Drive</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            Paste one folder with every state's files — we group them by GSTIN state code.
          </div>
        </div>
        {confirmed && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: '#059669', background: 'rgba(5,150,105,0.10)', borderRadius: 9999, padding: '4px 10px' }}>
            <CheckCircle2 style={{ width: 13, height: 13 }} /> {states.length} state{states.length === 1 ? '' : 's'} ready
          </span>
        )}
      </div>

      <div style={{ padding: 16 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text" value={url} placeholder="https://drive.google.com/drive/folders/…"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runAnalyze(); }}
            style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--card-border)', background: 'var(--page-bg)', color: 'var(--text-heading)', fontSize: 13 }}
          />
          <button
            onClick={() => runAnalyze()} disabled={!url || scanning}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 18px', borderRadius: 8, border: 'none', background: ACCENT, color: '#fff', fontWeight: 700, fontSize: 13, cursor: (!url || scanning) ? 'default' : 'pointer', opacity: (!url || scanning) ? 0.6 : 1 }}
          >
            {scanning && <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />}
            {scanning ? 'Scanning…' : 'Analyze'}
          </button>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 11.5, margin: '7px 2px 0' }}>
          Share the folder with the service account first
          {scan?.serviceAccountEmail ? <> (<code style={{ fontSize: 11 }}>{scan.serviceAccountEmail}</code>)</> : ''}, then paste the link.
        </p>

        {error && (
          <p style={{ color: '#DC2626', fontSize: 12.5, marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle style={{ width: 14, height: 14 }} /> {error}
          </p>
        )}

        {scan && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ color: 'var(--text-heading)', fontWeight: 700, fontSize: 13 }}>
                {states.length > 0 ? `Detected ${states.length} state${states.length === 1 ? '' : 's'} — check each one` : 'No states detected'}
              </div>
              <button onClick={clearDrive} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
                <X style={{ width: 13, height: 13 }} /> Clear
              </button>
            </div>

            {states.map((st, i) => (
              <div key={st.code} style={{ border: '1px solid var(--card-border)', borderRadius: 10, padding: 12, marginBottom: 10 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-heading)', marginBottom: 8 }}>
                  State {i + 1} — {st.label} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({st.code})</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                  {[['gstr2b', 'GSTR-2B *'], ['purchase', 'Purchase *'], ['debit', 'Debit Note']].map(([key, label]) => (
                    <div key={key}>
                      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: 3 }}>{label}</label>
                      <select value={sel[i]?.[key] || ''} onChange={(e) => setStateSlot(i, key, e.target.value)} style={selectStyle}>
                        <option value="">— none —</option>
                        {files.map((f) => <option key={f.fileId} value={f.fileId}>{f.name}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {scan.unassigned?.length > 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: 11.5, marginTop: 4 }}>
                Couldn't place {scan.unassigned.length}: {scan.unassigned.slice(0, 4).map((u) => u.name).join(', ')}{scan.unassigned.length > 4 ? '…' : ''} — assign above if needed.
              </p>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
              <button
                onClick={confirm} disabled={missing.length > 0 || states.length === 0}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 8, border: 'none', background: (missing.length || !states.length) ? 'var(--card-border)' : '#059669', color: '#fff', fontWeight: 700, fontSize: 13, cursor: (missing.length || !states.length) ? 'default' : 'pointer' }}
              >
                <CheckCircle2 style={{ width: 15, height: 15 }} />
                {confirmed ? 'States ready' : 'Use these files'}
              </button>
              {missing.length > 0 && <span style={{ fontSize: 12, color: '#E11D48' }}>Each state needs a GSTR-2B + Purchase.</span>}
              {confirmed && <span style={{ fontSize: 12.5, color: '#059669', fontWeight: 600 }}>These Drive files will be used when you run ↑</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

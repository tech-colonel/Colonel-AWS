import React, { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import api from '../lib/api';
import BrandLogo from './BrandLogos';

/* ──────────────────────────────────────────────────────────────────────────────
   DriveOrUpload — keeps the agent's existing manual upload ALWAYS visible, and
   adds a distinct "From Google Drive" section BELOW it. Paste a Drive link
   (folder or file URL) → the system recognizes which file maps to which input
   slot → shows an EDITABLE mapping → on confirm hands the parent a
   { slotKey: [{fileId,name}] } selection. Clearing it returns to manual upload.

   Both paths coexist (no mode that hides upload). The parent decides at run time:
   if a Drive selection is confirmed, use it; otherwise use the manual uploads.

   Props:
     • uploadNode — the parent's current per-slot uploader (rendered as-is).
     • slots      — [{ key, label, required, multiple }] the agent consumes.
     • agentType  — used for POST /api/drive/route.
     • onDriveConfirmed(selection|null) — { slotKey:[{fileId,name}] } once confirmed, null when cleared.

   CSS variables only (light/dark safe); real Google Drive logo (BrandLogo).
   ────────────────────────────────────────────────────────────────────────────── */

const ACCENT = 'var(--accent, #0748EE)';

export default function DriveOrUpload({ slots = [], agentType, uploadNode, onDriveConfirmed }) {
  const [url, setUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [scan, setScan] = useState(null);      // { files, mapping, unmatched, ambiguous, usedLlm, serviceAccountEmail }
  const [sel, setSel] = useState({});          // { slotKey: [fileId,...] }
  const [confirmed, setConfirmed] = useState(false);
  const [lastAnalyzed, setLastAnalyzed] = useState('');

  const clearDrive = () => {
    setScan(null); setSel({}); setConfirmed(false); setUrl(''); setError(''); setLastAnalyzed('');
    onDriveConfirmed && onDriveConfirmed(null);
  };

  // Build the { slotKey:[{fileId,name}] } payload from a selection map + file list.
  const buildSelection = (meta, selMap, fileList) => {
    const nameOf = (id) => (fileList.find((f) => f.fileId === id)?.name) || id;
    const selection = {};
    for (const s of meta) {
      const ids = selMap[s.key] || [];
      if (ids.length) selection[s.key] = ids.map((id) => ({ fileId: id, name: nameOf(id) }));
    }
    return selection;
  };

  const runAnalyze = async (link) => {
    const target = String(link ?? url).trim();
    if (!target || scanning) return;
    setScanning(true); setError(''); setScan(null); setConfirmed(false);
    onDriveConfirmed && onDriveConfirmed(null);
    try {
      const { data } = await api.post('/api/drive/route', { folder_url: target, agent_type: agentType });
      const meta = data.slots || slots;
      const seed = {};
      for (const s of meta) {
        const guessed = (data.mapping?.[s.key] || []).map((x) => x.fileId);
        seed[s.key] = s.multiple ? guessed : guessed.slice(0, 1);
      }
      setScan(data); setSel(seed); setLastAnalyzed(target);
      // Auto-confirm when every required slot is matched and nothing is ambiguous,
      // so paste-link → Run just works. Otherwise the user resolves it below.
      const missing = meta.filter((s) => s.required && !(seed[s.key] || []).length);
      if (!missing.length && !(data.ambiguous || []).length) {
        setConfirmed(true);
        onDriveConfirmed && onDriveConfirmed(buildSelection(meta, seed, data.files || []));
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Could not scan that Drive link.');
      setLastAnalyzed(target); // don't loop on a failing link
    } finally {
      setScanning(false);
    }
  };

  // Auto-analyze shortly after a Drive link is pasted/typed (debounced), so the
  // user doesn't have to hunt for an "Analyze" button.
  useEffect(() => {
    const t = String(url || '').trim();
    if (!t || t === lastAnalyzed || confirmed) return;
    if (!/(drive\.google\.com|\/folders\/|\/file\/d\/)/.test(t)) return;
    const id = setTimeout(() => { runAnalyze(t); }, 700);
    return () => clearTimeout(id);
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  const files = scan?.files || [];
  const slotMeta = scan?.slots || slots;
  const fileName = (fileId) => files.find((f) => f.fileId === fileId)?.name || fileId;

  const setSingle = (slotKey, fileId) => {
    setConfirmed(false); onDriveConfirmed && onDriveConfirmed(null);
    setSel((p) => ({ ...p, [slotKey]: fileId ? [fileId] : [] }));
  };
  const toggleMulti = (slotKey, fileId) => {
    setConfirmed(false); onDriveConfirmed && onDriveConfirmed(null);
    setSel((p) => {
      const cur = p[slotKey] || [];
      return { ...p, [slotKey]: cur.includes(fileId) ? cur.filter((x) => x !== fileId) : [...cur, fileId] };
    });
  };

  const missingRequired = slotMeta.filter((s) => s.required && !(sel[s.key] || []).length);
  const totalSelected = Object.values(sel).reduce((n, arr) => n + (arr?.length || 0), 0);

  const confirm = () => {
    if (missingRequired.length) return;
    setConfirmed(true);
    onDriveConfirmed && onDriveConfirmed(buildSelection(slotMeta, sel, files));
  };

  const sectionStyle = {
    marginTop: 16, borderRadius: 14,
    border: `1px solid ${confirmed ? 'rgba(5,150,105,0.35)' : 'var(--card-border)'}`,
    background: 'var(--surface)', overflow: 'hidden',
  };

  return (
    <div>
      {/* Manual upload — always visible */}
      {uploadNode}

      {/* From Google Drive — a distinct section below */}
      <div style={sectionStyle}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px',
          borderBottom: '1px solid var(--card-border)',
          background: 'linear-gradient(0deg, transparent, rgba(7,72,238,0.03))',
        }}>
          <BrandLogo type="google_drive" size={22} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-heading)' }}>From Google Drive</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              Paste a link — we match each file to the right slot for you.
            </div>
          </div>
          {confirmed && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700,
              color: '#059669', background: 'rgba(5,150,105,0.10)', borderRadius: 9999, padding: '4px 10px',
            }}>
              <CheckCircle2 style={{ width: 13, height: 13 }} /> {totalSelected} file{totalSelected === 1 ? '' : 's'} ready
            </span>
          )}
        </div>

        <div style={{ padding: 16 }}>
          {/* Link + Analyze */}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text" value={url} placeholder="https://drive.google.com/drive/folders/…  (or a file link)"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runAnalyze(); }}
              style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--card-border)', background: 'var(--page-bg)', color: 'var(--text-heading)', fontSize: 13 }}
            />
            <button
              onClick={() => runAnalyze()} disabled={!url || scanning}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '10px 18px', borderRadius: 8, border: 'none', background: ACCENT, color: '#fff',
                fontWeight: 700, fontSize: 13, cursor: (!url || scanning) ? 'default' : 'pointer', opacity: (!url || scanning) ? 0.6 : 1,
              }}
            >
              {scanning && <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" />}
              {scanning ? 'Scanning…' : 'Analyze'}
            </button>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 11.5, margin: '7px 2px 0', lineHeight: 1.5 }}>
            First set the folder/file to <strong>“Anyone with the link → Viewer”</strong>
            {scan?.serviceAccountEmail ? <> (or share it with <code style={{ fontSize: 11 }}>{scan.serviceAccountEmail}</code>)</> : ''}, then paste the link.
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
                  Recognized {files.length} file{files.length === 1 ? '' : 's'} — check the mapping
                </div>
                <button onClick={clearDrive} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
                  <X style={{ width: 13, height: 13 }} /> Clear
                </button>
              </div>
              {scan.usedLlm && (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 8px' }}>AI helped resolve an ambiguous file — please verify.</p>
              )}

              {/* Editable mapping: one row per slot */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {slotMeta.map((s) => (
                  <div key={s.key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-heading)' }}>
                      {s.label} {s.required ? <span style={{ color: '#E11D48' }}>*</span> : <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(optional)</span>}
                    </label>
                    {s.multiple ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {files.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No files detected.</span>}
                        {files.map((f) => (
                          <label key={f.fileId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-body)', cursor: 'pointer' }}>
                            <input type="checkbox" checked={(sel[s.key] || []).includes(f.fileId)} onChange={() => toggleMulti(s.key, f.fileId)} />
                            {f.name}
                          </label>
                        ))}
                      </div>
                    ) : (
                      <select
                        value={(sel[s.key] || [])[0] || ''}
                        onChange={(e) => setSingle(s.key, e.target.value)}
                        style={{ padding: '9px 10px', borderRadius: 8, border: '1px solid var(--card-border)', background: 'var(--page-bg)', color: 'var(--text-heading)', fontSize: 12.5 }}
                      >
                        <option value="">— none —</option>
                        {files.map((f) => <option key={f.fileId} value={f.fileId}>{f.name}</option>)}
                      </select>
                    )}
                  </div>
                ))}
              </div>

              {scan.unmatched?.length > 0 && (
                <p style={{ color: 'var(--text-muted)', fontSize: 11.5, marginTop: 10 }}>
                  Not auto-assigned: {scan.unmatched.slice(0, 5).map((u) => u.name).join(', ')}{scan.unmatched.length > 5 ? '…' : ''} — pick them above if needed.
                </p>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
                <button
                  onClick={confirm} disabled={missingRequired.length > 0}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '9px 16px', borderRadius: 8, border: 'none',
                    background: missingRequired.length ? 'var(--card-border)' : '#059669', color: '#fff',
                    fontWeight: 700, fontSize: 13, cursor: missingRequired.length ? 'default' : 'pointer',
                  }}
                >
                  <CheckCircle2 style={{ width: 15, height: 15 }} />
                  {confirmed ? 'Files ready' : 'Use these files'}
                </button>
                {missingRequired.length > 0 && (
                  <span style={{ fontSize: 12, color: '#E11D48' }}>Assign: {missingRequired.map((s) => s.label).join(', ')}</span>
                )}
                {confirmed && <span style={{ fontSize: 12.5, color: '#059669', fontWeight: 600 }}>These Drive files will be used when you run ↑</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

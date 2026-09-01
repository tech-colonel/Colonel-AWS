import React, { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, X, FileSpreadsheet } from 'lucide-react';
import api from '../lib/api';
import BrandLogo from './BrandLogos';

/* ──────────────────────────────────────────────────────────────────────────────
   DriveFilePicker — "From Google Drive" for agents that parse IN THE BROWSER.

   Sibling of DriveOrUpload, not a replacement. DriveOrUpload previews a
   filename→slot mapping for agents whose engine runs on the server. This one is
   for client-side agents (Marketplace Ticket Generator): it lists the folder's files,
   lets the user tick the ones to load, downloads their bytes and hands them to
   the parent — which feeds them to the tool's own detector.

   Manual upload is untouched and stays above; both paths coexist.

   Props:
     • uploadNode  — the parent's existing uploader, rendered as-is above.
     • extensions  — e.g. ['.xlsx','.xls','.csv']; filters the listing.
     • onFiles(files) — async; called with [{ fileId, name, bytes:ArrayBuffer }].
     • title / subtitle / actionLabel — optional copy overrides.

   CSS variables only (light/dark safe); real Google Drive logo (BrandLogo).
   ────────────────────────────────────────────────────────────────────────────── */

const ACCENT = 'var(--accent, #0748EE)';

export default function DriveFilePicker({
  uploadNode,
  extensions,
  onFiles,
  title = 'From Google Drive',
  subtitle = 'Paste a folder link — we list the reports, you pick which to load.',
  actionLabel = 'Load selected files',
}) {
  const [url, setUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [scan, setScan] = useState(null);          // { files, skipped, serviceAccountEmail }
  const [picked, setPicked] = useState({});        // { fileId: true }
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, name: '' });
  const [loaded, setLoaded] = useState(0);
  const [lastAnalyzed, setLastAnalyzed] = useState('');

  const files = scan?.files || [];
  const pickedIds = files.filter((f) => picked[f.fileId]).map((f) => f.fileId);

  const clearDrive = () => {
    setScan(null); setPicked({}); setUrl(''); setError('');
    setLastAnalyzed(''); setLoaded(0); setProgress({ done: 0, total: 0, name: '' });
  };

  const runAnalyze = async (link) => {
    const target = String(link ?? url).trim();
    if (!target || scanning) return;
    setScanning(true); setError(''); setScan(null); setPicked({}); setLoaded(0);
    try {
      const { data } = await api.post('/api/drive/list', {
        folder_url: target,
        ...(extensions ? { extensions } : {}),
      });
      const seed = {};
      (data.files || []).forEach((f) => { seed[f.fileId] = true; });   // everything ticked by default
      setScan(data); setPicked(seed); setLastAnalyzed(target);
      if (!(data.files || []).length) setError('No spreadsheet files found in that link.');
    } catch (e) {
      setError(e.response?.data?.error || 'Could not scan that Drive link.');
      setLastAnalyzed(target);   // don't loop on a failing link
    } finally {
      setScanning(false);
    }
  };

  // Auto-scan shortly after a Drive link is pasted (debounced), same as DriveOrUpload.
  useEffect(() => {
    const t = String(url || '').trim();
    if (!t || t === lastAnalyzed) return;
    if (!/(drive\.google\.com|\/folders\/|\/file\/d\/)/.test(t)) return;
    const id = setTimeout(() => { runAnalyze(t); }, 700);
    return () => clearTimeout(id);
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (fileId) => setPicked((p) => ({ ...p, [fileId]: !p[fileId] }));
  const setAll = (on) => {
    const next = {};
    files.forEach((f) => { next[f.fileId] = on; });
    setPicked(next);
  };

  const load = async () => {
    const chosen = files.filter((f) => picked[f.fileId]);
    if (!chosen.length || loading) return;
    setLoading(true); setError(''); setLoaded(0);
    setProgress({ done: 0, total: chosen.length, name: '' });
    const out = [];
    try {
      for (let i = 0; i < chosen.length; i += 1) {
        const f = chosen[i];
        setProgress({ done: i, total: chosen.length, name: f.name });
        const res = await api.get(`/api/drive/file/${f.fileId}/content`, { responseType: 'arraybuffer' });
        const headerName = res.headers?.['x-drive-file-name'];
        let name = f.name;
        if (headerName) { try { name = decodeURIComponent(headerName); } catch (_) { /* keep listing name */ } }
        out.push({ fileId: f.fileId, name, bytes: res.data });
      }
      setProgress({ done: chosen.length, total: chosen.length, name: '' });
      if (onFiles) await onFiles(out);
      setLoaded(out.length);
    } catch (e) {
      // arraybuffer responses need decoding before the error message is readable
      let msg = 'Could not download those Drive files.';
      try {
        const d = e.response?.data;
        if (d && d.byteLength !== undefined) msg = JSON.parse(new TextDecoder().decode(new Uint8Array(d)))?.error || msg;
        else if (d?.error) msg = d.error;
      } catch (_) { /* keep the generic message */ }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const sectionStyle = {
    marginTop: 16, borderRadius: 14,
    border: `1px solid ${loaded ? 'rgba(5,150,105,0.35)' : 'var(--card-border)'}`,
    background: 'var(--surface)', overflow: 'hidden',
  };

  return (
    <div>
      {/* Manual upload — always visible */}
      {uploadNode}

      <div style={sectionStyle}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px',
          borderBottom: '1px solid var(--card-border)',
          background: 'linear-gradient(0deg, transparent, rgba(7,72,238,0.03))',
        }}>
          <BrandLogo type="google_drive" size={22} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-heading)' }}>{title}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{subtitle}</div>
          </div>
          {loaded > 0 && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700,
              color: '#059669', background: 'rgba(5,150,105,0.10)', borderRadius: 9999, padding: '4px 10px',
            }}>
              <CheckCircle2 style={{ width: 13, height: 13 }} /> {loaded} file{loaded === 1 ? '' : 's'} loaded
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

          {scan && files.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 10, flexWrap: 'wrap' }}>
                <div style={{ color: 'var(--text-heading)', fontWeight: 700, fontSize: 13 }}>
                  Found {files.length} file{files.length === 1 ? '' : 's'} — pick what to load
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button onClick={() => setAll(true)} style={{ background: 'transparent', border: 'none', color: ACCENT, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Select all</button>
                  <button onClick={() => setAll(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>None</button>
                  <button onClick={clearDrive} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
                    <X style={{ width: 13, height: 13 }} /> Clear
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 260, overflowY: 'auto', border: '1px solid var(--card-border)', borderRadius: 10, padding: 8 }}>
                {files.map((f) => (
                  <label key={f.fileId} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: 'var(--text-body)', cursor: 'pointer', padding: '5px 6px', borderRadius: 6 }}>
                    <input type="checkbox" checked={!!picked[f.fileId]} onChange={() => toggle(f.fileId)} />
                    <FileSpreadsheet style={{ width: 14, height: 14, color: 'var(--text-muted)', flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    {f.isGoogleSheet && <span style={{ fontSize: 10.5, color: 'var(--text-muted)', flexShrink: 0 }}>(Google Sheet)</span>}
                  </label>
                ))}
              </div>

              {scan.skipped > 0 && (
                <p style={{ color: 'var(--text-muted)', fontSize: 11.5, marginTop: 8 }}>
                  {scan.skipped} other file{scan.skipped === 1 ? '' : 's'} in that link {scan.skipped === 1 ? 'was' : 'were'} skipped (not a spreadsheet).
                </p>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                <button
                  onClick={load} disabled={!pickedIds.length || loading}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '9px 16px', borderRadius: 8, border: 'none',
                    background: (!pickedIds.length || loading) ? 'var(--card-border)' : '#059669', color: '#fff',
                    fontWeight: 700, fontSize: 13, cursor: (!pickedIds.length || loading) ? 'default' : 'pointer',
                  }}
                >
                  {loading ? <Loader2 style={{ width: 15, height: 15 }} className="animate-spin" /> : <CheckCircle2 style={{ width: 15, height: 15 }} />}
                  {loading ? `Loading ${progress.done + 1}/${progress.total}…` : `${actionLabel} (${pickedIds.length})`}
                </button>
                {loading && progress.name && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>
                    {progress.name}
                  </span>
                )}
                {!loading && loaded > 0 && (
                  <span style={{ fontSize: 12.5, color: '#059669', fontWeight: 600 }}>Loaded into the tool below ↓</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

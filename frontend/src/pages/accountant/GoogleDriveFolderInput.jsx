import React, { useState } from 'react';
import api from '../../lib/api';

export default function GoogleDriveFolderInput({ value, onChange, onDetected }) {
  const [scanning, setScanning] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');

  const analyze = async () => {
    setScanning(true); setError(''); setPreview(null);
    try {
      const { data } = await api.post('/api/reco/detect-files', { folder_url: value });
      setPreview(data);
      onDetected && onDetected(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not scan folder');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 12, padding: 16 }}>
      <label style={{ color: 'var(--text-heading)', fontWeight: 600 }}>Google Drive Folder URL</label>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input
          type="text" value={value} placeholder="https://drive.google.com/drive/folders/…"
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--card-border)', background: 'var(--surface)', color: 'var(--text-heading)' }}
        />
        <button onClick={analyze} disabled={!value || scanning}
          style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: '#6366F1', color: '#fff', fontWeight: 600, cursor: scanning ? 'default' : 'pointer', opacity: (!value || scanning) ? 0.6 : 1 }}>
          {scanning ? 'Scanning…' : 'Analyze'}
        </button>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6 }}>
        Share the folder with the service account first, then paste the link.
      </p>
      {error && <p style={{ color: '#DC2626', fontSize: 13 }}>{error}</p>}
      {preview && (
        <div style={{ marginTop: 12 }}>
          <div style={{ color: 'var(--text-heading)', fontWeight: 600, marginBottom: 6 }}>Detected files</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(preview.counts || {}).map(([k, v]) => (
              <span key={k} style={{ background: '#EEF2FF', color: '#4338CA', borderRadius: 999, padding: '4px 10px', fontSize: 12 }}>
                {k.replace(/_/g, ' ')}: {v}
              </span>
            ))}
          </div>
          {preview.ignored?.length > 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>
              Ignored {preview.ignored.length}: {preview.ignored.slice(0, 4).join(', ')}{preview.ignored.length > 4 ? '…' : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

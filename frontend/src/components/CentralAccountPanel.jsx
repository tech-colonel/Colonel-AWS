import React from 'react';
import { CheckCircle2, AlertTriangle, HardDrive, Mail, FolderCog, Loader2, Save } from 'lucide-react';
import api from '../lib/api';
import { toast } from 'sonner';

/* CentralAccountPanel — admin view of the firm's central Google account
   (team@colonel.co.in) health + per-brand "central Drive folder" mapping.

   Self-contained + additive: reads /api/google/status and
   /api/brands/:id/drive-config (GET/PUT). Bulk Drive reads use the service
   account; this panel just shows whether the pieces are wired and lets an admin
   save each brand's Drive folder link. */

function Chip({ ok, okText, badText, Icon }) {
  const cfg = ok
    ? { color: '#059669', bg: '#ECFDF5', border: '#A7F3D0', text: okText }
    : { color: '#D97706', bg: '#FFFBEB', border: '#FDE68A', text: badText };
  return (
    <span
      className="inline-flex items-center gap-1"
      style={{
        fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 9999,
        background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {Icon ? <Icon style={{ width: 12, height: 12 }} /> : null}
      {cfg.text}
    </span>
  );
}

export default function CentralAccountPanel() {
  const [status, setStatus] = React.useState(null);
  const [brands, setBrands] = React.useState([]);
  const [brandId, setBrandId] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [savedCfg, setSavedCfg] = React.useState(null);
  const [loadingCfg, setLoadingCfg] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    api.get('/api/google/status').then((r) => setStatus(r.data)).catch(() => setStatus(null));
    api.get('/api/brands').then((r) => setBrands(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  }, []);

  // Load the selected brand's saved folder config.
  React.useEffect(() => {
    if (!brandId) { setSavedCfg(null); setUrl(''); setLabel(''); return; }
    setLoadingCfg(true);
    api.get(`/api/brands/${brandId}/drive-config`)
      .then((r) => {
        const c = r.data && r.data.config;
        setSavedCfg(c || null);
        setUrl(c?.root_folder_url || '');
        setLabel(c?.label || '');
      })
      .catch(() => { setSavedCfg(null); })
      .finally(() => setLoadingCfg(false));
  }, [brandId]);

  const save = async () => {
    if (!brandId) { toast.error('Pick a brand first'); return; }
    if (!url.trim()) { toast.error('Paste the Drive folder link'); return; }
    setSaving(true);
    try {
      const r = await api.put(`/api/brands/${brandId}/drive-config`, { root_folder_url: url.trim(), label: label.trim() || null });
      setSavedCfg(r.data && r.data.config);
      toast.success('Drive folder saved');
    } catch (e) {
      const msg = e?.response?.data?.error || 'Could not save the folder';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const centralConnected = !!status?.central?.connected;
  const driveOk = !!status?.driveOk;
  const mailOk = !!status?.mailOk;
  const saEmail = status?.serviceAccountEmail;

  return (
    <div className="glass-card" style={{ padding: 20, marginTop: 28, border: '1px solid var(--card-border, #E2E8F0)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <FolderCog style={{ width: 18, height: 18, color: '#0748EE' }} />
        <h3 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-heading, #0F172A)' }}>Central Google account</h3>
        <span style={{ fontSize: 12, color: 'var(--text-muted, #64748B)' }}>team@colonel.co.in — the firm's shared Drive + mail account</span>
      </div>

      {/* Health chips */}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <Chip ok={centralConnected} okText="Central connected" badText="team@ not connected" Icon={centralConnected ? CheckCircle2 : AlertTriangle} />
        <Chip ok={driveOk} okText="Drive read ready" badText="Drive service account off" Icon={HardDrive} />
        <Chip ok={mailOk} okText="Mail send ready" badText="Mail not ready" Icon={Mail} />
      </div>
      {!centralConnected && (
        <p style={{ fontSize: 12, color: 'var(--text-muted, #64748B)', marginTop: 8 }}>
          Connect team@colonel.co.in from the profile menu (top-left) to enable sending mail as the firm account.
        </p>
      )}
      {saEmail && (
        <p style={{ fontSize: 12, color: 'var(--text-muted, #64748B)', marginTop: 6 }}>
          Share each brand's Drive folder (Viewer) with <strong style={{ color: '#0748EE' }}>{saEmail}</strong> so the app can read it.
        </p>
      )}

      {/* Per-brand folder mapping */}
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px dashed var(--card-border, #E2E8F0)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-heading, #0F172A)', marginBottom: 10 }}>
          Brand Drive folder
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Brand</span>
            <select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              style={{ padding: '9px 12px', borderRadius: 10, border: '1px solid var(--card-border, #E2E8F0)', background: 'var(--surface, #fff)', color: 'var(--text-heading, #0F172A)', fontSize: 13 }}
            >
              <option value="">Select a brand…</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 260 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Drive folder link</span>
            <input
              type="text"
              value={url}
              disabled={!brandId || loadingCfg}
              placeholder="https://drive.google.com/drive/folders/…"
              onChange={(e) => setUrl(e.target.value)}
              style={{ padding: '9px 12px', borderRadius: 10, border: '1px solid var(--card-border, #E2E8F0)', background: 'var(--surface, #fff)', color: 'var(--text-heading, #0F172A)', fontSize: 13 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Label (optional)</span>
            <input
              type="text"
              value={label}
              disabled={!brandId || loadingCfg}
              placeholder="e.g. GST files"
              onChange={(e) => setLabel(e.target.value)}
              style={{ padding: '9px 12px', borderRadius: 10, border: '1px solid var(--card-border, #E2E8F0)', background: 'var(--surface, #fff)', color: 'var(--text-heading, #0F172A)', fontSize: 13 }}
            />
          </label>
          <button
            onClick={save}
            disabled={!brandId || saving || loadingCfg}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              background: '#0748EE', color: '#fff', border: 'none', borderRadius: 10,
              padding: '10px 16px', fontSize: 13, fontWeight: 700,
              cursor: (!brandId || saving || loadingCfg) ? 'not-allowed' : 'pointer',
              opacity: (!brandId || saving || loadingCfg) ? 0.6 : 1, boxShadow: '0 2px 8px rgba(7,72,238,0.22)',
            }}
          >
            {saving ? <><Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> Saving…</> : <><Save style={{ width: 14, height: 14 }} /> Save</>}
          </button>
        </div>
        {brandId && !loadingCfg && (
          <p style={{ fontSize: 12, color: 'var(--text-muted, #64748B)', marginTop: 8 }}>
            {savedCfg?.root_folder_id
              ? <>Saved folder id: <code style={{ color: '#0748EE' }}>{savedCfg.root_folder_id}</code>{savedCfg.updated_at ? ` · updated ${new Date(savedCfg.updated_at).toLocaleDateString('en-IN')}` : ''}</>
              : 'No folder saved for this brand yet.'}
          </p>
        )}
      </div>
    </div>
  );
}

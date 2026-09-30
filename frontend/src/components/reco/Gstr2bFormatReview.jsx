import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import api from '../../lib/api';

// GSTR-2B vs Books: which layout each uploaded 2B file was read as.
//
// Known layouts (GST portal download, OCTA, Combined workbook) are read by fixed
// rules and only get a one-line note. A NEW layout was read with a column mapping
// the AI worked out and double-checked — so before that mapping is kept for future
// files, the accountant is asked whether the output is right:
//   Yes -> the layout is saved; later files in it are read directly (no AI).
//   No  -> they see which column was used for what, correct it, and re-run with
//          their columns (no AI). They can also discard the layout.

const FORMAT_NAME = { portal: 'GST portal download', combined: 'Combined workbook', octa: 'OCTA export' };
const KINDS = [
  ['invoices', 'Invoices'], ['notes', 'Credit / debit notes'], ['mixed', 'Invoices + notes (type column)'],
  ['amendments', 'Amended invoices'], ['note_amendments', 'Amended notes'],
];

const box = {
  background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 10,
  padding: '14px 16px',
};
const btn = (accent, filled) => ({
  padding: '8px 14px', fontSize: 12, fontWeight: 600, borderRadius: 8, cursor: 'pointer',
  border: `1px solid ${filled ? accent : 'var(--card-border)'}`,
  background: filled ? accent : 'var(--surface)', color: filled ? 'hsl(var(--primary-foreground))' : 'var(--text-heading)',
});

const toEditable = (fmt) => (fmt.sheets || []).map((s) => ({
  sheet: s.sheet, header_row: s.header_row, kind: s.kind, headers: s.headers || [],
  credit_values: s.credit_values || [], debit_values: s.debit_values || [],
  columns: Object.fromEntries((s.columns || []).map((c) => [c.field, c.index])),
  meta: s.columns || [],
}));

const NewLayoutCard = ({ fmt, accent, running, onRerunWithColumns }) => {
  const [status, setStatus] = useState(fmt.status);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sheets, setSheets] = useState(() => toEditable(fmt));

  useEffect(() => { setStatus(fmt.status); setSheets(toEditable(fmt)); setEditing(false); }, [fmt]);

  const answer = async (accept) => {
    setBusy(true);
    try {
      const { data } = await api.post('/api/reco/gstr2b-format/confirm', { signature: fmt.signature, accept });
      setStatus(data.status);
      toast.success(accept
        ? 'Layout saved — files in this layout will now be read directly.'
        : 'Layout discarded — the next run will work it out afresh.');
      if (!accept) setEditing(false);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not save your answer');
    } finally { setBusy(false); }
  };

  const setCol = (si, field, value) => setSheets((prev) => prev.map((s, i) => (i !== si ? s : {
    ...s, columns: { ...s.columns, [field]: value === '' ? null : Number(value) },
  })));
  const setKind = (si, kind) => setSheets((prev) => prev.map((s, i) => (i !== si ? s : { ...s, kind })));

  const rerun = () => onRerunWithColumns({
    signature: fmt.signature,
    sheets: sheets.map(({ sheet, header_row, kind, columns, credit_values, debit_values }) => ({
      sheet, header_row, kind, columns, credit_values, debit_values,
    })),
  });

  if (status === 'confirmed') {
    return (
      <div style={{ ...box, borderLeft: `3px solid ${accent}`, fontSize: 12, color: 'var(--text-muted)' }}>
        <b style={{ color: 'var(--text-heading)' }}>{fmt.file}</b> — read with a saved custom layout
        (not portal / OCTA / Combined). {fmt.source === 'user' ? 'Columns as you set them.' : ''}
      </div>
    );
  }
  if (status === 'discarded') {
    return (
      <div style={{ ...box, fontSize: 12, color: 'var(--text-muted)' }}>
        <b style={{ color: 'var(--text-heading)' }}>{fmt.file}</b> — layout discarded. Treat this output as unverified.
      </div>
    );
  }

  return (
    <div style={{ ...box, borderLeft: `3px solid ${accent}` }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-heading)', marginBottom: 4 }}>
        New GSTR-2B layout — is this output right?
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 10 }}>
        <b style={{ color: 'var(--text-heading)' }}>{fmt.file}</b> is not a GST portal, OCTA or Combined download.{' '}
        {fmt.source === 'user'
          ? 'It was read with the columns you set.'
          : 'The AI worked out its columns and then checked a sample of the output against the file.'}{' '}
        Look through the results below (or the Excel). If they're right, we'll remember this layout; if not, fix the columns.
      </div>

      {sheets.map((s, si) => (
        <div key={s.sheet} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
            color: 'var(--text-muted)', marginBottom: 6 }}>
            Sheet “{s.sheet}” · headings on row {Number(s.header_row) + 1}
            {editing ? (
              <select value={s.kind} onChange={(e) => setKind(si, e.target.value)}
                style={{ marginLeft: 8, fontSize: 11, padding: '2px 4px', background: 'var(--surface)',
                  color: 'var(--text-heading)', border: '1px solid var(--card-border)', borderRadius: 6 }}>
                {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            ) : <span style={{ textTransform: 'none', fontWeight: 500 }}> · {(KINDS.find(([k]) => k === s.kind) || [s.kind, s.kind])[1]}</span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '4px 16px' }}>
            {s.meta.filter((c) => editing || c.index !== null).map((c) => (
              <div key={c.field} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12,
                padding: '4px 0', borderBottom: '1px dashed var(--card-border)' }}>
                <span style={{ color: 'var(--text-muted)' }}>{c.label}{c.required ? ' *' : ''}</span>
                {editing ? (
                  <select value={s.columns[c.field] ?? ''} onChange={(e) => setCol(si, c.field, e.target.value)}
                    style={{ fontSize: 12, maxWidth: 130, background: 'var(--surface)', color: 'var(--text-heading)',
                      border: '1px solid var(--card-border)', borderRadius: 6 }}>
                    <option value="">— none —</option>
                    {s.headers.map((h) => <option key={h.index} value={h.index}>{h.label}</option>)}
                  </select>
                ) : (
                  <span style={{ color: 'var(--text-heading)', fontWeight: 600 }}>{c.header || `Column ${c.index + 1}`}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        {!editing ? (
          <>
            <button style={btn(accent, true)} disabled={busy || running} onClick={() => answer(true)}>
              Yes, output is right — remember this layout
            </button>
            <button style={btn(accent, false)} disabled={busy || running} onClick={() => setEditing(true)}>
              No, fix the columns
            </button>
          </>
        ) : (
          <>
            <button style={btn(accent, true)} disabled={busy || running} onClick={rerun}>
              {running ? 'Re-running…' : 'Re-run with these columns'}
            </button>
            <button style={btn(accent, false)} disabled={busy || running} onClick={() => { setSheets(toEditable(fmt)); setEditing(false); }}>
              Cancel
            </button>
            <button style={btn(accent, false)} disabled={busy || running} onClick={() => answer(false)}>
              Discard this layout
            </button>
          </>
        )}
      </div>
    </div>
  );
};

const Gstr2bFormatReview = ({ formats = [], accent = 'var(--text-heading)', running, onRerunWithColumns }) => {
  if (!formats || formats.length === 0) return null;
  const known = formats.filter((f) => FORMAT_NAME[f.format]);
  const fresh = formats.filter((f) => f.format === 'new');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {known.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          GSTR-2B read as:{' '}
          {known.map((f, i) => (
            <span key={`${f.file}-${i}`}>
              {i > 0 ? ' · ' : ''}<b style={{ color: 'var(--text-heading)' }}>{FORMAT_NAME[f.format]}</b>
              {known.length > 1 && f.file ? ` (${f.file})` : ''}
            </span>
          ))}
        </div>
      )}
      {fresh.map((f, i) => (
        <NewLayoutCard key={`${f.signature}-${i}`} fmt={f} accent={accent} running={running}
          onRerunWithColumns={onRerunWithColumns} />
      ))}
    </div>
  );
};

export default Gstr2bFormatReview;

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Cable, RefreshCw, Search, CircleAlert, Trash2, ChevronLeft, ChevronRight, Monitor } from 'lucide-react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';
import api from '../../lib/api';

/* Tally — data pushed by the Colonel Tally Connector (tally-connector/) running
   on the client's Tally PC. Backend: controllers/tallyController.js. */

const V = '#6D5AE6';
const INK = '#0F172A';
const MUTED = '#64748B';
const FAINT = '#94A3B8';
const PAGE = 50;

const cnt = (n) => Number(n || 0).toLocaleString('en-IN');
const money = (n) => (n === null || n === undefined ? '—'
  : Math.abs(Number(n)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
// Tally sign convention: negative = Debit, positive = Credit
const drcr = (n) => (n === null || n === undefined || Number(n) === 0 ? '' : Number(n) < 0 ? 'Dr' : 'Cr');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const ago = (d) => {
  if (!d) return 'never';
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

// A connector syncs every 15 min, so silence for 35+ min means it is not running.
const connectorState = (c) => {
  const silentMin = c.last_seen_at ? (Date.now() - new Date(c.last_seen_at).getTime()) / 60000 : Infinity;
  if (silentMin > 35) return { label: 'Offline', c: '#B91C1C', bg: '#FEF2F2' };
  if (c.last_status === 'tally_unreachable') return { label: 'Tally not reachable', c: '#B45309', bg: '#FFFBEB' };
  if (c.last_status === 'no_company') return { label: 'No company open', c: '#B45309', bg: '#FFFBEB' };
  if (c.last_status === 'error') return { label: 'Sync error', c: '#B91C1C', bg: '#FEF2F2' };
  return { label: 'Online', c: '#047857', bg: '#ECFDF5' };
};

const Pill = ({ c, bg, children }) => (
  <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: c, background: bg, padding: '3px 9px', borderRadius: 9999, whiteSpace: 'nowrap' }}>{children}</span>
);

const th = { textAlign: 'left', padding: '10px 12px', fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: FAINT, borderBottom: '1px solid #EEF1F8', whiteSpace: 'nowrap' };
const td = { padding: '10px 12px', fontSize: 13, color: INK, borderBottom: '1px solid #F3F5FA', verticalAlign: 'top' };
const num = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const inputStyle = { border: '1px solid #E2E8F0', borderRadius: 10, padding: '8px 12px', fontSize: 13, background: '#fff', color: INK, outline: 'none' };

function SetupSteps() {
  return (
    <div className="glass-card" style={{ padding: '22px 24px', marginBottom: 18 }}>
      <div style={{ fontWeight: 800, fontSize: 16, color: INK, marginBottom: 10 }}>Connect a Tally</div>
      <ol style={{ margin: 0, paddingLeft: 20, color: MUTED, fontSize: 13.5, lineHeight: 1.9 }}>
        <li>In Tally: <b>F1 Help → Settings → Connectivity → Client/Server configuration</b>, set <b>TallyPrime acts as = Both</b> and <b>Port = 9002</b>, then restart Tally.</li>
        <li>Keep Tally open with the company loaded.</li>
        <li>On the same PC, run the <b>Colonel Tally Connector</b> and log in with an admin account.</li>
        <li>Enter host <b>localhost</b> (or the Tally PC&apos;s IP) and port <b>9002</b>, then pick the companies to sync.</li>
      </ol>
      <div style={{ marginTop: 10, fontSize: 12.5, color: FAINT }}>The connector sends data every 15 minutes. It appears here after the first sync.</div>
    </div>
  );
}

function Pager({ total, offset, setOffset }) {
  if (total <= PAGE) return null;
  const btn = (disabled) => ({ ...inputStyle, padding: '6px 9px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1, display: 'inline-flex' });
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '12px 4px 0', fontSize: 12.5, color: MUTED }}>
      <span>{cnt(offset + 1)}–{cnt(Math.min(offset + PAGE, total))} of {cnt(total)}</span>
      <button type="button" style={btn(offset === 0)} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}><ChevronLeft size={15} /></button>
      <button type="button" style={btn(offset + PAGE >= total)} disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}><ChevronRight size={15} /></button>
    </div>
  );
}

function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function VouchersTab({ companyId, refreshKey }) {
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const q = useDebounced(search);

  useEffect(() => { setOffset(0); }, [q, type, companyId]);
  useEffect(() => {
    let live = true;
    api.get(`/api/tally/companies/${companyId}/vouchers`, { params: { search: q, type, limit: PAGE, offset } })
      .then((r) => { if (live) setData(r.data); })
      .catch(() => { if (live) toast.error('Failed to load vouchers'); });
    return () => { live = false; };
  }, [companyId, q, type, offset, refreshKey]);

  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 380 }}>
          <Search size={15} style={{ position: 'absolute', left: 11, top: 10, color: FAINT }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search party, voucher no., narration"
            style={{ ...inputStyle, width: '100%', paddingLeft: 32 }} />
        </div>
        <select value={type} onChange={(e) => setType(e.target.value)} style={inputStyle}>
          <option value="">All voucher types</option>
          {(data?.types || []).map((t) => <option key={t.voucher_type} value={t.voucher_type}>{`${t.voucher_type} (${cnt(t.count)})`}</option>)}
        </select>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={th}>Date</th><th style={th}>Type</th><th style={th}>No.</th><th style={th}>Party</th>
            <th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Narration</th>
          </tr></thead>
          <tbody>
            {(data?.rows || []).map((v) => (
              <React.Fragment key={v.id}>
                <tr onClick={() => setOpen(open === v.id ? null : v.id)} style={{ cursor: 'pointer', background: open === v.id ? '#F8F7FF' : undefined }}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(v.voucher_date)}</td>
                  <td style={td}>{v.voucher_type}{v.is_cancelled && <span style={{ marginLeft: 6 }}><Pill c="#B91C1C" bg="#FEF2F2">Cancelled</Pill></span>}</td>
                  <td style={td}>{v.voucher_number || '—'}</td>
                  <td style={td}>{v.party_name || '—'}</td>
                  <td style={num}>{money(v.amount)}</td>
                  <td style={{ ...td, color: MUTED, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.narration || ''}</td>
                </tr>
                {open === v.id && (
                  <tr><td colSpan={6} style={{ ...td, background: '#F8F7FF', padding: '6px 12px 14px 40px' }}>
                    <table style={{ borderCollapse: 'collapse', minWidth: 420 }}>
                      <tbody>
                        {(v.ledger_entries || []).map((e, i) => (
                          <tr key={i}>
                            <td style={{ padding: '4px 16px 4px 0', fontSize: 12.5, color: INK }}>{e.ledger}</td>
                            <td style={{ padding: '4px 0', fontSize: 12.5, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(e.amount)} <span style={{ color: FAINT }}>{drcr(e.amount)}</span></td>
                          </tr>
                        ))}
                        {!(v.ledger_entries || []).length && <tr><td style={{ fontSize: 12.5, color: FAINT }}>No ledger lines received</td></tr>}
                      </tbody>
                    </table>
                  </td></tr>
                )}
              </React.Fragment>
            ))}
            {data && !data.rows.length && <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: FAINT, padding: 28 }}>No vouchers match.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager total={data?.total || 0} offset={offset} setOffset={setOffset} />
    </>
  );
}

function LedgersTab({ companyId, refreshKey }) {
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const q = useDebounced(search);

  useEffect(() => { setOffset(0); }, [q, companyId]);
  useEffect(() => {
    let live = true;
    api.get(`/api/tally/companies/${companyId}/ledgers`, { params: { search: q, limit: PAGE, offset } })
      .then((r) => { if (live) setData(r.data); })
      .catch(() => { if (live) toast.error('Failed to load ledgers'); });
    return () => { live = false; };
  }, [companyId, q, offset, refreshKey]);

  return (
    <>
      <div style={{ position: 'relative', maxWidth: 380, marginBottom: 12 }}>
        <Search size={15} style={{ position: 'absolute', left: 11, top: 10, color: FAINT }} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ledger, group or GSTIN"
          style={{ ...inputStyle, width: '100%', paddingLeft: 32 }} />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={th}>Ledger</th><th style={th}>Group</th>
            <th style={{ ...th, textAlign: 'right' }}>Opening</th><th style={{ ...th, textAlign: 'right' }}>Closing</th><th style={th}>GSTIN</th>
          </tr></thead>
          <tbody>
            {(data?.rows || []).map((l) => (
              <tr key={l.id}>
                <td style={{ ...td, fontWeight: 600 }}>{l.name}</td>
                <td style={{ ...td, color: MUTED }}>{l.parent || '—'}</td>
                <td style={num}>{money(l.opening_balance)} <span style={{ color: FAINT, fontSize: 11.5 }}>{drcr(l.opening_balance)}</span></td>
                <td style={num}>{money(l.closing_balance)} <span style={{ color: FAINT, fontSize: 11.5 }}>{drcr(l.closing_balance)}</span></td>
                <td style={{ ...td, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{l.gstin || ''}</td>
              </tr>
            ))}
            {data && !data.rows.length && <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: FAINT, padding: 28 }}>No ledgers match.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager total={data?.total || 0} offset={offset} setOffset={setOffset} />
    </>
  );
}

function RunsTab({ companyId, refreshKey }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    api.get(`/api/tally/companies/${companyId}/runs`)
      .then((r) => { if (live) setRows(r.data); })
      .catch(() => { if (live) toast.error('Failed to load sync history'); });
    return () => { live = false; };
  }, [companyId, refreshKey]);
  const secs = (r) => (r.finished_at ? `${Math.max(0, Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000))}s` : '—');
  const statusPill = (s) => (s === 'ok' ? <Pill c="#047857" bg="#ECFDF5">OK</Pill>
    : s === 'running' ? <Pill c={V} bg="#F1EEFC">Running</Pill> : <Pill c="#B91C1C" bg="#FEF2F2">Error</Pill>);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={th}>Started</th><th style={th}>Status</th><th style={{ ...th, textAlign: 'right' }}>Ledgers</th>
          <th style={{ ...th, textAlign: 'right' }}>New / changed vouchers</th><th style={{ ...th, textAlign: 'right' }}>Removed</th>
          <th style={{ ...th, textAlign: 'right' }}>Took</th><th style={th}>Error</th>
        </tr></thead>
        <tbody>
          {(rows || []).map((r) => (
            <tr key={r.id}>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{new Date(r.started_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
              <td style={td}>{statusPill(r.status)}</td>
              <td style={num}>{cnt(r.counts?.ledgers)}</td>
              <td style={num}>{cnt(r.counts?.vouchers)}</td>
              <td style={num}>{cnt((r.counts?.removed_ledgers || 0) + (r.counts?.removed_vouchers || 0))}</td>
              <td style={num}>{secs(r)}</td>
              <td style={{ ...td, color: '#B91C1C', fontSize: 12.5 }}>{r.error || ''}</td>
            </tr>
          ))}
          {rows && !rows.length && <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: FAINT, padding: 28 }}>No syncs yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default function TallyPage() {
  const [overview, setOverview] = useState(null);
  const [companyId, setCompanyId] = useState(null);
  const [tab, setTab] = useState('vouchers');
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(() => {
    api.get('/api/tally/overview')
      .then((r) => {
        setOverview(r.data);
        setCompanyId((cur) => (cur && r.data.companies.some((c) => c.id === cur) ? cur : r.data.companies[0]?.id || null));
      })
      .catch(() => toast.error('Failed to load Tally data'));
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const refresh = () => { load(); setRefreshKey((k) => k + 1); };

  const revoke = async (c) => {
    if (!window.confirm(`Disconnect the connector on "${c.machine_name || 'this PC'}"? It will stop syncing until someone logs in on it again.`)) return;
    try { await api.delete(`/api/tally/connectors/${c.id}`); toast.success('Connector disconnected'); load(); }
    catch { toast.error('Failed to disconnect'); }
  };

  const connectors = overview?.connectors || [];
  const companies = overview?.companies || [];
  const company = companies.find((c) => c.id === companyId);

  return (
    <DashboardLayout sidebarItems={ADMIN_SIDEBAR}>
      <div style={{ padding: '28px 28px 48px', maxWidth: 1320, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 28, color: INK, letterSpacing: '-0.02em', margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              <Cable size={24} color={V} /> Tally
            </h1>
            <p style={{ fontSize: 14, color: MUTED, marginTop: 4, marginBottom: 18 }}>Books synced from Tally by the Colonel Tally Connector every 15 minutes.</p>
          </div>
          <button type="button" onClick={refresh} style={{ ...inputStyle, display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontWeight: 700 }}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {overview && !connectors.length && !companies.length && <SetupSteps />}

        {/* Connectors */}
        {connectors.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: 12, marginBottom: 18 }}>
            {connectors.map((c) => {
              const st = connectorState(c);
              return (
                <div key={c.id} className="glass-card" style={{ padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Monitor size={18} color={MUTED} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 14, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.machine_name || 'Connector'}</div>
                      <div style={{ fontSize: 12, color: FAINT }}>Tally at {c.tally_host || '?'}:{c.tally_port || '?'} · seen {ago(c.last_seen_at)}</div>
                    </div>
                    <Pill c={st.c} bg={st.bg}>{st.label}</Pill>
                    <button type="button" title="Disconnect this connector" onClick={() => revoke(c)}
                      style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: FAINT, padding: 4, display: 'inline-flex' }}><Trash2 size={15} /></button>
                  </div>
                  {c.last_error && c.last_status !== 'ok' && (
                    <div style={{ marginTop: 8, fontSize: 12, color: '#B45309', display: 'flex', gap: 6 }}><CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />{c.last_error}</div>
                  )}
                  <div style={{ marginTop: 6, fontSize: 11.5, color: FAINT }}>Logged in by {c.user_name || c.user_email || '—'}{c.connector_version ? ` · v${c.connector_version}` : ''}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* Company picker */}
        {companies.length > 1 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {companies.map((c) => (
              <button type="button" key={c.id} onClick={() => setCompanyId(c.id)}
                style={{ border: `1px solid ${c.id === companyId ? V : '#E2E8F0'}`, background: c.id === companyId ? '#F1EEFC' : '#fff', color: c.id === companyId ? V : INK, borderRadius: 9999, padding: '7px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                {c.name}
              </button>
            ))}
          </div>
        )}

        {company && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 14 }}>
              {[
                { l: 'Company', v: company.name, small: true },
                { l: 'Ledgers', v: cnt(company.ledger_count) },
                { l: 'Vouchers', v: cnt(company.voucher_count) },
                { l: 'Last sync', v: ago(company.last_sync_at), small: true, pill: company.last_sync_status },
                { l: 'Books from', v: fmtDate(company.books_from), small: true },
              ].map((m) => (
                <div key={m.l} className="glass-card" style={{ padding: '14px 16px' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: FAINT, marginBottom: 6 }}>{m.l}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: m.small ? 'inherit' : 'Barlow, sans-serif', fontWeight: m.small ? 800 : 900, fontSize: m.small ? 15 : 24, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.v}</span>
                    {m.pill === 'ok' && <Pill c="#047857" bg="#ECFDF5">OK</Pill>}
                    {m.pill === 'error' && <Pill c="#B91C1C" bg="#FEF2F2">Failed</Pill>}
                  </div>
                </div>
              ))}
            </div>

            {company.last_sync_status === 'error' && company.last_error && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: '#FEF2F2', color: '#B91C1C', borderRadius: 12, padding: '10px 14px', fontSize: 13, marginBottom: 14 }}>
                <CircleAlert size={16} style={{ flexShrink: 0, marginTop: 1 }} /> Last sync failed: {company.last_error}
              </div>
            )}

            <div className="glass-card" style={{ padding: '16px 18px' }}>
              <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #EEF1F8', marginBottom: 14 }}>
                {[['vouchers', 'Vouchers'], ['ledgers', 'Ledgers'], ['runs', 'Sync history']].map(([k, label]) => (
                  <button type="button" key={k} onClick={() => setTab(k)}
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '8px 14px', fontSize: 13.5, fontWeight: 700,
                      color: tab === k ? V : MUTED, borderBottom: `2px solid ${tab === k ? V : 'transparent'}`, marginBottom: -1 }}>{label}</button>
                ))}
              </div>
              {tab === 'vouchers' && <VouchersTab companyId={company.id} refreshKey={refreshKey} />}
              {tab === 'ledgers' && <LedgersTab companyId={company.id} refreshKey={refreshKey} />}
              {tab === 'runs' && <RunsTab companyId={company.id} refreshKey={refreshKey} />}
            </div>
          </>
        )}

        {overview && connectors.length > 0 && !companies.length && (
          <div className="glass-card" style={{ padding: '22px 24px', color: MUTED, fontSize: 13.5 }}>
            The connector is running but no company has synced yet. Make sure the company is open in Tally.
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

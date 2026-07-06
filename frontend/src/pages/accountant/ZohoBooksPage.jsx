import React, { useState, useEffect, useCallback } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { sidebarFor } from '../../lib/adminNav';
import BrandLogo from '../../components/BrandLogos';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import api from '../../lib/api';
import { toast } from 'sonner';
import { RefreshCw, Loader2, Building2, Users, Receipt, BookOpen, Package, ChevronRight, Search, Landmark } from 'lucide-react';

const money = (v, cur = 'INR') => { const n = Number(v); if (!Number.isFinite(n)) return '—'; return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n); };
const fmtDate = (s) => { if (!s) return '—'; try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return s; } };
const VTYPES = [
  { k: '', l: 'All vouchers' }, { k: 'invoice', l: 'Invoices' }, { k: 'bill', l: 'Bills' },
  { k: 'expense', l: 'Expenses' }, { k: 'vendor_payment', l: 'Vendor payments' }, { k: 'customer_payment', l: 'Customer payments' },
  { k: 'purchase_order', l: 'Purchase orders' }, { k: 'sales_order', l: 'Sales orders' }, { k: 'estimate', l: 'Estimates' },
  { k: 'credit_note', l: 'Credit notes' }, { k: 'vendor_credit', l: 'Vendor credits' }, { k: 'journal', l: 'Journals' },
];
const VLABEL = Object.fromEntries(VTYPES.map((v) => [v.k, v.l.replace(/s$/, '')]));
const STATUS_TINT = (s = '') => {
  const t = s.toLowerCase();
  if (/paid|closed|accepted|billed/.test(t)) return { fg: '#047857', bg: '#D1FAE5' };
  if (/overdue|rejected|declined/.test(t)) return { fg: '#B91C1C', bg: '#FEE2E2' };
  if (/draft|sent|open|pending|unpaid|partially/.test(t)) return { fg: '#B45309', bg: '#FEF3C7' };
  return { fg: '#475569', bg: '#F1F5F9' };
};

export default function ZohoBooksPage() {
  const sidebarItems = sidebarFor([]);
  const [status, setStatus] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [org, setOrg] = useState(null);
  const [tab, setTab] = useState('vendors');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState('');
  const [vtype, setVtype] = useState('');
  const [contact, setContact] = useState(null);   // drill-down: selected vendor/customer
  const [bankAcct, setBankAcct] = useState(null);  // drill-down: selected bank account
  const [detail, setDetail] = useState(null);

  const loadStatus = useCallback(() => {
    api.get('/api/zoho/status').then((r) => setStatus(r.data)).catch(() => {});
    api.get('/api/zoho/organizations').then((r) => { const o = r.data?.organizations || []; setOrgs(o); setOrg((cur) => cur || o[0]?.organization_id || null); }).catch(() => {});
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  const loadTab = useCallback(() => {
    if (!org) return;
    setLoading(true); setRows([]);
    const done = (arr) => { setRows(arr || []); setLoading(false); };
    if (tab === 'vendors') api.get(`/api/zoho/organizations/${org}/contacts?type=vendor`).then((r) => done(r.data?.contacts)).catch(() => done([]));
    else if (tab === 'customers') api.get(`/api/zoho/organizations/${org}/contacts?type=customer`).then((r) => done(r.data?.contacts)).catch(() => done([]));
    else if (tab === 'accounts') api.get(`/api/zoho/organizations/${org}/accounts`).then((r) => done(r.data?.accounts)).catch(() => done([]));
    else if (tab === 'items') api.get(`/api/zoho/organizations/${org}/items`).then((r) => done(r.data?.items)).catch(() => done([]));
    else if (tab === 'bank') {
      if (bankAcct) api.get(`/api/zoho/bank-accounts/${bankAcct.account_id}/transactions`).then((r) => done(r.data?.transactions)).catch(() => done([]));
      else api.get(`/api/zoho/organizations/${org}/bank-accounts`).then((r) => done(r.data?.bankAccounts)).catch(() => done([]));
    }
    else if (tab === 'vouchers') {
      const p = new URLSearchParams({ organization_id: org, limit: '500' });
      if (vtype) p.set('voucher_type', vtype);
      if (contact) p.set('contact_id', contact.contact_id);
      api.get(`/api/zoho/vouchers?${p.toString()}`).then((r) => done(r.data?.vouchers)).catch(() => done([]));
    }
  }, [org, tab, vtype, contact, bankAcct]);
  useEffect(() => { loadTab(); }, [loadTab]);

  const sync = async () => {
    setSyncing(true);
    try { await api.post('/api/zoho/sync'); toast.success('Zoho Books synced'); loadStatus(); loadTab(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Sync failed'); }
    finally { setSyncing(false); }
  };

  // vendor/customer → drill into their vouchers
  const drillContact = (c) => { setContact(c); setVtype(''); setTab('vouchers'); };

  const q = query.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (!q) return true;
    return JSON.stringify(r).toLowerCase().includes(q);
  });

  const TABS = [
    { k: 'vendors', l: 'Vendors', icon: Users, n: status?.counts?.vendors },
    { k: 'customers', l: 'Customers', icon: Users, n: status?.counts?.customers },
    { k: 'vouchers', l: 'Vouchers', icon: Receipt, n: status?.counts?.vouchers },
    { k: 'bank', l: 'Bank', icon: Landmark, n: status?.counts?.bank_accounts },
    { k: 'accounts', l: 'Chart of Accounts', icon: BookOpen, n: status?.counts?.accounts },
    { k: 'items', l: 'Items', icon: Package, n: status?.counts?.items },
  ];
  const cur = orgs.find((o) => o.organization_id === org)?.currency_code || 'INR';

  const card = { border: '1px solid var(--card-border)', borderRadius: 12, background: 'var(--surface)' };
  const th = { textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94A3B8', padding: '10px 14px' };
  const td = { fontSize: 13.5, color: 'var(--text-heading)', padding: '12px 14px', borderTop: '1px solid var(--card-border)' };

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" style={{ maxWidth: 1180, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <BrandLogo type="zoho_books" size={34} />
            <div>
              <h1 style={{ fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: 24, color: 'var(--text-heading)', margin: 0 }}>Zoho Books</h1>
              <p style={{ fontSize: 13.5, color: 'var(--text-muted)', marginTop: 3 }}>
                Read-only mirror of your Zoho Books — {status?.lastSync?.finished_at ? `last synced ${fmtDate(status.lastSync.finished_at)}` : 'not synced yet'}.
              </p>
            </div>
          </div>
          <button onClick={sync} disabled={syncing} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, padding: '10px 16px', borderRadius: 12, background: '#0748EE', color: '#fff', border: 'none', cursor: 'pointer', opacity: syncing ? 0.7 : 1 }}>
            {syncing ? <Loader2 className="animate-spin" style={{ width: 15, height: 15 }} /> : <RefreshCw style={{ width: 15, height: 15 }} />} {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>

        {/* Organization (brand) selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}><Building2 style={{ width: 14, height: 14 }} /> Organization</span>
          {orgs.map((o) => (
            <button key={o.organization_id} onClick={() => { setOrg(o.organization_id); setContact(null); setBankAcct(null); }}
              style={{ fontSize: 13, fontWeight: 700, padding: '7px 14px', borderRadius: 10, cursor: 'pointer', border: `1.5px solid ${org === o.organization_id ? '#0748EE' : 'var(--card-border)'}`, background: org === o.organization_id ? '#0748EE14' : 'var(--surface)', color: org === o.organization_id ? '#0748EE' : 'var(--text-heading)' }}>
              {o.name} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· {o.vouchers} vouchers</span>
            </button>
          ))}
          {orgs.length === 0 && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>No organizations yet — hit “Sync now”.</span>}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', background: '#EEF2F7', borderRadius: 12, padding: 4, marginBottom: 16, width: 'fit-content' }}>
          {TABS.map((t) => (
            <button key={t.k} onClick={() => { setTab(t.k); if (t.k !== 'vouchers') setContact(null); if (t.k !== 'bank') setBankAcct(null); }} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, padding: '8px 14px', borderRadius: 9, border: 'none', cursor: 'pointer', background: tab === t.k ? '#fff' : 'transparent', color: tab === t.k ? 'var(--text-heading)' : 'var(--text-muted)', boxShadow: tab === t.k ? '0 1px 3px rgba(10,15,46,0.10)' : 'none' }}>
              <t.icon style={{ width: 14, height: 14 }} /> {t.l}<span style={{ fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 9999, background: tab === t.k ? '#EEF2F7' : '#E2E8F0', color: '#64748B' }}>{t.n ?? 0}</span>
            </button>
          ))}
        </div>

        {/* Drill-down breadcrumb + filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          {tab === 'vouchers' && contact && (
            <span style={{ fontSize: 13, fontWeight: 700, color: '#0748EE', background: '#EFF6FF', padding: '6px 12px', borderRadius: 9999, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {contact.contact_name}
              <button onClick={() => setContact(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#0748EE', fontWeight: 800 }}>✕</button>
            </span>
          )}
          {tab === 'vouchers' && (
            <select value={vtype} onChange={(e) => setVtype(e.target.value)} style={{ fontSize: 13, padding: '7px 12px', borderRadius: 10, border: '1px solid var(--card-border)', background: 'var(--surface)', color: 'var(--text-heading)' }}>
              {VTYPES.map((v) => <option key={v.k} value={v.k}>{v.l}</option>)}
            </select>
          )}
          {tab === 'bank' && bankAcct && (
            <span style={{ fontSize: 13, fontWeight: 700, color: '#0748EE', background: '#EFF6FF', padding: '6px 12px', borderRadius: 9999, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Landmark style={{ width: 13, height: 13 }} /> {bankAcct.account_name} · statement
              <button onClick={() => setBankAcct(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#0748EE', fontWeight: 800 }}>✕</button>
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 10, padding: '7px 12px', flex: 1, minWidth: 200 }}>
            <Search style={{ width: 15, height: 15, color: '#94A3B8' }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text-heading)' }} />
          </div>
        </div>

        {/* Table */}
        <div style={{ ...card, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '50px 0', color: '#94A3B8' }}><Loader2 className="animate-spin" style={{ width: 26, height: 26, margin: '0 auto 10px' }} /><div>Loading…</div></div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-muted)' }}>No {tab} found{q ? ' for this search' : ''}.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                {tab === 'vouchers' ? (
                  <>
                    <thead><tr style={{ background: '#F8FAFC' }}><th style={th}>Type</th><th style={th}>Number</th><th style={th}>Date</th><th style={th}>Party</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Status</th></tr></thead>
                    <tbody>{filtered.map((v) => { const st = STATUS_TINT(v.status); return (
                      <tr key={v.id} onClick={() => { api.get(`/api/zoho/vouchers/${v.id}`).then((r) => setDetail(r.data?.voucher)).catch(() => {}); }} style={{ cursor: 'pointer' }} onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFC'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                        <td style={td}><span style={{ fontSize: 11.5, fontWeight: 700, color: '#4338CA', background: '#EEF2FF', padding: '3px 9px', borderRadius: 9999 }}>{VLABEL[v.voucher_type] || v.voucher_type}</span></td>
                        <td style={{ ...td, fontWeight: 600 }}>{v.number || '—'}</td>
                        <td style={{ ...td, color: 'var(--text-muted)' }}>{fmtDate(v.voucher_date)}</td>
                        <td style={td}>{v.contact_name || '—'}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(v.total, cur)}</td>
                        <td style={td}>{v.status ? <span style={{ fontSize: 11.5, fontWeight: 700, color: st.fg, background: st.bg, padding: '3px 9px', borderRadius: 9999, textTransform: 'capitalize' }}>{v.status}</span> : '—'}</td>
                      </tr>
                    ); })}</tbody>
                  </>
                ) : (tab === 'vendors' || tab === 'customers') ? (
                  <>
                    <thead><tr style={{ background: '#F8FAFC' }}><th style={th}>Name</th><th style={th}>Company</th><th style={th}>Email</th><th style={th}>Phone</th><th style={{ ...th, textAlign: 'right' }}>Outstanding</th><th style={{ ...th, width: 40 }}></th></tr></thead>
                    <tbody>{filtered.map((c) => (
                      <tr key={c.contact_id} onClick={() => drillContact(c)} style={{ cursor: 'pointer' }} onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFC'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                        <td style={{ ...td, fontWeight: 600 }}>{c.contact_name}</td>
                        <td style={{ ...td, color: 'var(--text-muted)' }}>{c.company_name || '—'}</td>
                        <td style={{ ...td, color: 'var(--text-muted)' }}>{c.email || '—'}</td>
                        <td style={{ ...td, color: 'var(--text-muted)' }}>{c.phone || '—'}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(c.outstanding, cur)}</td>
                        <td style={td}><ChevronRight style={{ width: 16, height: 16, color: '#CBD5E1' }} /></td>
                      </tr>
                    ))}</tbody>
                  </>
                ) : (tab === 'bank' && !bankAcct) ? (
                  <>
                    <thead><tr style={{ background: '#F8FAFC' }}><th style={th}>Account</th><th style={th}>Type</th><th style={th}>Bank</th><th style={{ ...th, textAlign: 'right' }}>Balance</th><th style={{ ...th, textAlign: 'right' }}>Txns</th><th style={{ ...th, width: 40 }}></th></tr></thead>
                    <tbody>{filtered.map((b) => (
                      <tr key={b.account_id} onClick={() => setBankAcct(b)} style={{ cursor: 'pointer' }} onMouseEnter={(e) => e.currentTarget.style.background = '#F8FAFC'} onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                        <td style={{ ...td, fontWeight: 600 }}>{b.account_name}</td>
                        <td style={{ ...td, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{(b.account_type || '').replace(/_/g, ' ')}</td>
                        <td style={{ ...td, color: 'var(--text-muted)' }}>{b.bank_name || '—'}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(b.balance, cur)}</td>
                        <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)' }}>{b.transactions}</td>
                        <td style={td}><ChevronRight style={{ width: 16, height: 16, color: '#CBD5E1' }} /></td>
                      </tr>
                    ))}</tbody>
                  </>
                ) : (tab === 'bank' && bankAcct) ? (
                  <>
                    <thead><tr style={{ background: '#F8FAFC' }}><th style={th}>Date</th><th style={th}>Type</th><th style={th}>Payee</th><th style={th}>Ref</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={{ ...th, textAlign: 'right' }}>Balance</th><th style={th}>Status</th></tr></thead>
                    <tbody>{filtered.map((t) => { const inflow = (t.debit_or_credit || '').toLowerCase() === 'debit'; return (
                      <tr key={t.transaction_id}>
                        <td style={{ ...td, color: 'var(--text-muted)' }}>{fmtDate(t.txn_date)}</td>
                        <td style={td}><span style={{ fontSize: 11.5, fontWeight: 700, color: '#4338CA', background: '#EEF2FF', padding: '3px 9px', borderRadius: 9999, textTransform: 'capitalize' }}>{(t.transaction_type || '').replace(/_/g, ' ') || '—'}</span></td>
                        <td style={{ ...td, fontWeight: 600 }}>{t.payee || t.description || '—'}</td>
                        <td style={{ ...td, color: 'var(--text-muted)' }}>{t.reference_number || '—'}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: inflow ? '#047857' : '#B91C1C' }}>{inflow ? '+' : '−'}{money(t.amount, cur)}</td>
                        <td style={{ ...td, textAlign: 'right', color: 'var(--text-muted)' }}>{t.running_balance != null ? money(t.running_balance, cur) : '—'}</td>
                        <td style={td}>{(() => { const s = (t.status || '').toLowerCase(); const tint = s === 'uncategorized' ? { fg: '#B45309', bg: '#FEF3C7' } : s === 'excluded' ? { fg: '#64748B', bg: '#F1F5F9' } : { fg: '#047857', bg: '#D1FAE5' }; return t.status ? <span style={{ fontSize: 11.5, fontWeight: 700, color: tint.fg, background: tint.bg, padding: '3px 9px', borderRadius: 9999, textTransform: 'capitalize' }}>{t.status.replace(/_/g, ' ')}</span> : '—'; })()}</td>
                      </tr>
                    ); })}</tbody>
                  </>
                ) : tab === 'accounts' ? (
                  <>
                    <thead><tr style={{ background: '#F8FAFC' }}><th style={th}>Account</th><th style={th}>Type</th><th style={th}>Active</th></tr></thead>
                    <tbody>{filtered.map((a) => (
                      <tr key={a.account_id}><td style={{ ...td, fontWeight: 600 }}>{a.account_name}</td><td style={{ ...td, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{(a.account_type || '').replace(/_/g, ' ')}</td><td style={td}>{a.is_active ? '✓' : '—'}</td></tr>
                    ))}</tbody>
                  </>
                ) : (
                  <>
                    <thead><tr style={{ background: '#F8FAFC' }}><th style={th}>Item</th><th style={{ ...th, textAlign: 'right' }}>Rate</th><th style={th}>Status</th></tr></thead>
                    <tbody>{filtered.map((it) => (
                      <tr key={it.item_id}><td style={{ ...td, fontWeight: 600 }}>{it.name}</td><td style={{ ...td, textAlign: 'right' }}>{money(it.rate, cur)}</td><td style={{ ...td, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{it.status || '—'}</td></tr>
                    ))}</tbody>
                  </>
                )}
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Voucher detail (raw) */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl" onClose={() => setDetail(null)}>
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="text-xl font-bold text-slate-900">{VLABEL[detail.voucher_type] || detail.voucher_type} {detail.number || ''}</DialogTitle>
                <div className="text-sm text-slate-500 mt-1">{detail.contact_name || ''} · {fmtDate(detail.voucher_date)} · {money(detail.total, cur)} · {detail.status || ''}</div>
              </DialogHeader>
              <pre style={{ marginTop: 10, background: '#0B1020', color: '#D6E2FF', fontSize: 12, lineHeight: 1.5, padding: 14, borderRadius: 10, maxHeight: 420, overflow: 'auto' }}>{JSON.stringify(detail.raw, null, 2)}</pre>
            </>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

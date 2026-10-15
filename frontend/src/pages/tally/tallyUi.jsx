import React, { createContext, useContext, useEffect, useState } from 'react';
import api from '../../lib/api';

/* Shared look + helpers for the Tally Dashboard.
   Tally's sign convention is kept in the data: negative = Debit, positive = Credit. */

export const C = {
  ink: '#0F172A', muted: '#64748B', faint: '#94A3B8', line: '#EEF1F8', hair: '#F3F5FA',
  v: '#6D5AE6', vbg: '#F1EEFC',
  // Chart series, in fixed order (validated colour-blind safe on a light surface).
  s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a',
  // One-hue ramp for ordered buckets (ageing): light = recent, dark = old.
  ramp: ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'],
  grid: '#e1e0d9', axis: '#898781', good: '#047857', goodBg: '#ECFDF5', bad: '#B91C1C', badBg: '#FEF2F2', warn: '#B45309', warnBg: '#FFFBEB',
};

const abs = (n) => Math.abs(Number(n) || 0);
export const inr = (n) => (n === null || n === undefined ? '—' : abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const num = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
/** ₹ 1.23 Cr / 45.60 L / 9.2 K — for headline figures and chart axes. */
export const compact = (n) => {
  const v = Number(n) || 0; const a = Math.abs(v); const sign = v < 0 ? '−' : '';
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${sign}₹${(a / 1e3).toFixed(1)} K`;
  return `${sign}₹${a.toFixed(0)}`;
};
/** Short axis label: ₹60 L, ₹1.5 Cr. */
export const axisMoney = (n) => {
  const v = Number(n) || 0; const a = Math.abs(v); const sign = v < 0 ? '−' : '';
  const trim = (x) => String(Math.round(x * 10) / 10);
  if (a >= 1e7) return `${sign}₹${trim(a / 1e7)} Cr`;
  if (a >= 1e5) return `${sign}₹${trim(a / 1e5)} L`;
  if (a >= 1e3) return `${sign}₹${trim(a / 1e3)} K`;
  return `${sign}₹${Math.round(a)}`;
};
/** Keep legend entries in the order the series are drawn (recharts sorts them A–Z otherwise). */
export const legendProps = { iconType: 'circle', wrapperStyle: { fontSize: 12 }, itemSorter: () => 0 };
export const drcr = (n) => (!Number(n) ? '' : Number(n) < 0 ? 'Dr' : 'Cr');
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const monthLabel = (m) => { const [y, mo] = String(m).split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }); };
/** '2025-01' → { from: '2025-01-01', to: '2025-01-31' } */
export const monthRange = (m) => { const [y, mo] = String(m).split('-').map(Number); const last = new Date(y, mo, 0).getDate(); return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` }; };
export const ago = (d) => {
  if (!d) return 'never';
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

export const th = { textAlign: 'left', padding: '9px 12px', fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.faint, borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap' };
export const thR = { ...th, textAlign: 'right' };
export const td = { padding: '9px 12px', fontSize: 13, color: C.ink, borderBottom: `1px solid ${C.hair}`, verticalAlign: 'top' };
export const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
export const input = { border: '1px solid #E2E8F0', borderRadius: 10, padding: '8px 12px', fontSize: 13, background: '#fff', color: C.ink, outline: 'none' };
export const linkBtn = { border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: C.v, fontWeight: 700, fontSize: 'inherit', textAlign: 'left', fontFamily: 'inherit' };

export const Pill = ({ c = C.muted, bg = '#F1F5F9', children }) => (
  <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: c, background: bg, padding: '3px 9px', borderRadius: 9999, whiteSpace: 'nowrap' }}>{children}</span>
);

export const Card = ({ title, sub, right, children, style, pad = '16px 18px' }) => (
  <div className="glass-card" style={{ padding: pad, ...style }}>
    {(title || right) && (
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 14.5, color: C.ink }}>{title}</div>
          {sub && <div style={{ fontSize: 12, color: C.faint, marginTop: 2 }}>{sub}</div>}
        </div>
        {right}
      </div>
    )}
    {children}
  </div>
);

/** A headline figure. Clickable ones lead somewhere — that is the drill-down entry point. */
export const Kpi = ({ label, value, sub, onClick, tone }) => (
  <button type="button" onClick={onClick} disabled={!onClick} className="glass-card"
    style={{ padding: '14px 16px', textAlign: 'left', border: 'none', cursor: onClick ? 'pointer' : 'default', font: 'inherit', display: 'block', width: '100%' }}>
    <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.faint, marginBottom: 6 }}>{label}</div>
    <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: 24, color: tone === 'bad' ? C.bad : C.ink, lineHeight: 1.15, whiteSpace: 'nowrap' }}>{value}</div>
    {sub && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{sub}{onClick && <span style={{ color: C.v, fontWeight: 700 }}> · view →</span>}</div>}
  </button>
);

export const Empty = ({ children }) => <div style={{ padding: 28, textAlign: 'center', color: C.faint, fontSize: 13 }}>{children}</div>;
export const Loading = () => <Empty>Loading…</Empty>;

/** GET with params; refetches when `deps` change. */
export function useFetch(url, params, deps = []) {
  const [state, setState] = useState({ data: null, loading: !!url, error: null });
  useEffect(() => {
    if (!url) { setState({ data: null, loading: false, error: null }); return undefined; }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get(url, { params })
      .then((r) => { if (live) setState({ data: r.data, loading: false, error: null }); })
      .catch((e) => { if (live) setState({ data: null, loading: false, error: e.response?.data?.error || 'Failed to load' }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  return state;
}

/** Drill-down: any panel can open another on top of the stack. */
export const DrillContext = createContext({ open: () => {}, cb: '', period: {} });
export const useDrill = () => useContext(DrillContext);

/** A ledger name that opens that ledger. */
export const LedgerLink = ({ id, name, children }) => {
  const { open } = useDrill();
  if (!name) return <>—</>;
  return <button type="button" style={linkBtn} onClick={(e) => { e.stopPropagation(); open({ type: 'ledger', id, name }); }}>{children || name}</button>;
};

/** Shared recharts styling. */
export const axisTick = { fontSize: 11, fill: C.axis };
export const tooltipStyle = { contentStyle: { borderRadius: 10, border: `1px solid ${C.line}`, fontSize: 12.5, boxShadow: '0 6px 20px rgba(15,23,42,0.08)' }, cursor: { fill: 'rgba(109,90,230,0.06)' } };

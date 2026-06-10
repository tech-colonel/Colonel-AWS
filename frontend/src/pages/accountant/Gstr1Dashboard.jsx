import React, { useState, useMemo } from 'react';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';

const REMARK_CFG = {
  'Match':                      { bg: '#C6EFCE', color: '#276221', border: '#A7D7A4' },
  'Diff':                       { bg: '#FFEB9C', color: '#9C5700', border: '#FFD700' },
  'Not in GSTR-1':              { bg: '#FFC7CE', color: '#9C0006', border: '#FF8080' },
  'Not in Books':               { bg: '#FFC7CE', color: '#9C0006', border: '#FF8080' },
  'Amazon Entry As per Tally':  { bg: '#DDEBF7', color: '#1F4E79', border: '#9DC3E6' },
  'Amazon Entry as per GSTR-1': { bg: '#E2EFDA', color: '#375623', border: '#9DC3A5' },
};

const SECTION_META = {
  gstr1_vs_gstr3b:    { title: 'Section 1 — GSTR-1 vs GSTR-3B',            left: 'GSTR-1',      right: 'GSTR-3B' },
  books_all_vs_gstr1: { title: 'Section 2 — Books (All Sales) vs GSTR-1',  left: 'Books (All)',  right: 'GSTR-1 All' },
  books_b2b_vs_gstr1: { title: 'Section 3 — Books B2B vs GSTR-1 B2B',      left: 'Books B2B',   right: 'GSTR-1 B2B' },
  books_b2c_vs_gstr1: { title: 'Section 4 — Books B2C vs GSTR-1 B2C',      left: 'Books B2C',   right: 'GSTR-1 B2C' },
};

const PAGE_SIZE = 100;

const fmt = (n) => {
  if (n == null || n === '') return '—';
  if (typeof n === 'number') return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return String(n);
};

const DiffCell = ({ v }) => {
  if (v == null) return <span style={{ color: '#94A3B8' }}>—</span>;
  const abs = Math.abs(v);
  const color = v > 0.5 ? '#059669' : v < -0.5 ? '#DC2626' : '#64748B';
  return <span style={{ color, fontWeight: abs > 0.5 ? 600 : 400 }}>{fmt(v)}</span>;
};

const RemarkBadge = ({ remark }) => {
  const cfg = REMARK_CFG[remark] || { bg: '#F1F5F9', color: '#64748B', border: '#CBD5E1' };
  return (
    <span className="inline-flex items-center text-xs px-2 py-0.5 rounded-full font-semibold whitespace-nowrap"
      style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}` }}>
      {remark}
    </span>
  );
};

// ─── GST Reco section table ───────────────────────────────────────────────────
function GstRecoSection({ sectionKey, rows }) {
  const meta = SECTION_META[sectionKey] || { title: sectionKey, left: 'Left', right: 'Right' };
  const dataRows = rows.filter(r => r.month !== 'Total');
  const totalRow = rows.find(r => r.month === 'Total');

  // Detect left/right prefixes from first row
  const firstRow = dataRows[0] || {};
  const prefixes = [...new Set(
    Object.keys(firstRow).filter(k => k.includes('_taxable') && k !== 'diff_taxable').map(k => k.replace('_taxable', ''))
  )];
  const lp = prefixes[0] || 'left';
  const rp = prefixes[1] || 'right';

  const amtStyle = { fontFamily: 'monospace', fontSize: '12px', textAlign: 'right', padding: '6px 10px', whiteSpace: 'nowrap' };
  const hStyle   = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '6px 10px', textAlign: 'right', color: '#fff', background: '#2E75B6', whiteSpace: 'nowrap' };
  const titleHStyle = { ...hStyle, textAlign: 'center', background: '#1F3864', fontSize: '12px', letterSpacing: '0.08em' };

  const renderAmtRow = (row, isTotal) => {
    const bg = isTotal ? '#D9D9D9' : undefined;
    const fw = isTotal ? 700 : 400;
    const months = ['April','May','June','July','August','September','October','November','December','January','February','March'];
    const isCurrent = !isTotal && months.indexOf(row.month) !== -1;
    const rowBg = isCurrent && !isTotal ? undefined : bg;

    const lv = (k) => row[`${lp}_${k}`] ?? 0;
    const rv = (k) => row[`${rp}_${k}`] ?? 0;
    const dv = (k) => row[`diff_${k}`]   ?? 0;

    return (
      <tr key={row.month} style={{ background: rowBg, borderBottom: '1px solid #F1F5F9' }}>
        <td style={{ padding: '6px 10px', fontSize: '12px', fontWeight: isTotal ? 700 : 500, whiteSpace: 'nowrap', color: isTotal ? '#1F3864' : '#334155' }}>
          {row.month}
        </td>
        {['taxable','igst','cgst','sgst'].map(k => (
          <td key={k} style={{ ...amtStyle, fontWeight: fw, color: '#334155' }}>{fmt(lv(k))}</td>
        ))}
        <td style={{ ...amtStyle, fontWeight: fw, color: '#334155' }}>{fmt(lv('taxable') + lv('igst') + lv('cgst') + lv('sgst'))}</td>
        <td style={{ padding: '6px 4px' }}></td>
        {['taxable','igst','cgst','sgst'].map(k => (
          <td key={k} style={{ ...amtStyle, fontWeight: fw, color: '#334155' }}>{fmt(rv(k))}</td>
        ))}
        <td style={{ ...amtStyle, fontWeight: fw, color: '#334155' }}>{fmt(rv('taxable') + rv('igst') + rv('cgst') + rv('sgst'))}</td>
        <td style={{ padding: '6px 4px' }}></td>
        {['taxable','igst','cgst','sgst'].map(k => (
          <td key={k} style={{ ...amtStyle, fontWeight: isTotal ? 700 : fw }}>
            <DiffCell v={dv(k)} />
          </td>
        ))}
        <td style={{ ...amtStyle, fontWeight: fw }}>
          <DiffCell v={dv('taxable') + dv('igst') + dv('cgst') + dv('sgst')} />
        </td>
      </tr>
    );
  };

  return (
    <div style={{ marginBottom: '32px' }}>
      <div style={{ background: '#1F3864', color: '#fff', fontWeight: 700, fontSize: '13px', padding: '8px 12px', borderRadius: '8px 8px 0 0', letterSpacing: '0.05em' }}>
        {meta.title}
      </div>
      <div style={{ overflowX: 'auto', borderRadius: '0 0 8px 8px', border: '1px solid #E2E8F0', borderTop: 'none' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
          <thead>
            <tr>
              <th colSpan={6} style={{ ...titleHStyle, background: '#2E75B6' }}>{meta.left}</th>
              <th style={{ width: '8px', background: '#fff' }}></th>
              <th colSpan={5} style={{ ...titleHStyle, background: '#2E75B6' }}>{meta.right}</th>
              <th style={{ width: '8px', background: '#fff' }}></th>
              <th colSpan={5} style={{ ...titleHStyle, background: '#C45911' }}>Difference ({meta.left} − {meta.right})</th>
            </tr>
            <tr style={{ background: '#2E75B6' }}>
              <th style={{ ...hStyle, textAlign: 'left' }}>Month</th>
              {['Taxable','IGST','CGST','SGST','Total'].map(h => <th key={h} style={hStyle}>{h}</th>)}
              <th style={{ background: '#fff', width: '8px' }}></th>
              {['Taxable','IGST','CGST','SGST','Total'].map(h => <th key={h} style={{ ...hStyle }}>{h}</th>)}
              <th style={{ background: '#fff', width: '8px' }}></th>
              {['Taxable','IGST','CGST','SGST','Total'].map(h => <th key={h} style={{ ...hStyle, background: '#C45911' }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {dataRows.map(row => renderAmtRow(row, false))}
            {totalRow && renderAmtRow(totalRow, true)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── B2B Reco table ───────────────────────────────────────────────────────────
function B2bRecoTab({ rows }) {
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const remarkCounts = useMemo(() => {
    const c = {};
    for (const r of rows) c[r.remark] = (c[r.remark] || 0) + 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    let r = rows;
    if (filter !== 'All') r = r.filter(x => x.remark === filter);
    if (search) {
      const q = search.toLowerCase();
      r = r.filter(x => (x.inv_no || '').toLowerCase().includes(q) || (x.party || '').toLowerCase().includes(q) || (x.gstin || '').toLowerCase().includes(q));
    }
    return r;
  }, [rows, filter, search]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleFilter = (f) => { setFilter(f); setPage(0); };
  const handleSearch = (v) => { setSearch(v); setPage(0); };

  const thStyle = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 10px', textAlign: 'right', color: '#64748B', background: '#F8FAFC', whiteSpace: 'nowrap', borderBottom: '1.5px solid #E2E8F0' };
  const tdStyle = { fontSize: '12px', padding: '6px 10px', textAlign: 'right', color: '#334155', whiteSpace: 'nowrap', fontFamily: 'monospace' };
  const tdTextStyle = { fontSize: '12px', padding: '6px 10px', textAlign: 'left', color: '#334155', whiteSpace: 'nowrap' };

  const ALL_REMARKS = Object.keys(REMARK_CFG);

  return (
    <div>
      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px', alignItems: 'center' }}>
        {['All', ...ALL_REMARKS].map(r => {
          const active = filter === r;
          const cfg = REMARK_CFG[r] || { bg: '#E8EFFE', color: '#0748EE', border: '#A3BFF8' };
          const count = r === 'All' ? rows.length : (remarkCounts[r] || 0);
          if (r !== 'All' && !count) return null;
          return (
            <button key={r} onClick={() => handleFilter(r)}
              style={{
                fontSize: '12px', fontWeight: 600, padding: '4px 12px', borderRadius: '20px', cursor: 'pointer',
                background: active ? (r === 'All' ? '#E8EFFE' : cfg.bg) : '#F8FAFC',
                border: `1.5px solid ${active ? (r === 'All' ? '#A3BFF8' : cfg.border) : '#E2E8F0'}`,
                color: active ? (r === 'All' ? '#0748EE' : cfg.color) : '#64748B',
              }}>
              {r} ({count})
            </button>
          );
        })}
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <Search style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', width: '14px', color: '#94A3B8' }} />
          <input value={search} onChange={e => handleSearch(e.target.value)} placeholder="Search invoice / party / GSTIN…"
            style={{ paddingLeft: '28px', paddingRight: '12px', paddingTop: '6px', paddingBottom: '6px', fontSize: '12px', borderRadius: '8px', border: '1px solid #E2E8F0', outline: 'none', width: '260px', background: '#F8FAFC', color: '#334155' }} />
        </div>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto', borderRadius: '8px', border: '1px solid #E2E8F0' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '1100px' }}>
          <thead>
            <tr>
              <th colSpan={4} style={{ ...thStyle, textAlign: 'left', borderRight: '2px solid #E2E8F0' }}>Tally (Books)</th>
              <th colSpan={5} style={{ ...thStyle, background: '#EBF3FB', borderRight: '2px solid #E2E8F0' }}>GSTR-1</th>
              <th colSpan={4} style={{ ...thStyle, background: '#FFF8F1' }}>Difference</th>
              <th style={{ ...thStyle, textAlign: 'center' }}>Remark</th>
            </tr>
            <tr>
              {/* Tally */}
              {['Date','Invoice No','Party Name','GSTIN'].map(h => <th key={h} style={{ ...thStyle, textAlign: 'left', borderRight: h === 'GSTIN' ? '2px solid #E2E8F0' : undefined }}>{h}</th>)}
              {/* GSTR-1 */}
              {['Invoice No','Taxable','IGST','CGST','SGST'].map(h => <th key={h} style={{ ...thStyle, background: '#EBF3FB', borderRight: h === 'SGST' ? '2px solid #E2E8F0' : undefined }}>{h}</th>)}
              {/* Diff */}
              {['Taxable','IGST','CGST','SGST'].map(h => <th key={h} style={{ ...thStyle, background: '#FFF8F1' }}>{h}</th>)}
              <th style={{ ...thStyle, textAlign: 'center' }}>Remark</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((row, i) => {
              const cfg = REMARK_CFG[row.remark] || {};
              const rowBg = i % 2 === 1 ? '#FAFBFF' : undefined;
              return (
                <tr key={i} style={{ borderBottom: '1px solid #F1F5F9', background: rowBg }}>
                  <td style={tdTextStyle}>{row.date || '—'}</td>
                  <td style={tdTextStyle}>{row.inv_no || '—'}</td>
                  <td style={{ ...tdTextStyle, maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.party || '—'}</td>
                  <td style={{ ...tdTextStyle, borderRight: '2px solid #E2E8F0', fontFamily: 'monospace', fontSize: '11px' }}>{row.gstin || '—'}</td>
                  {/* GSTR-1 */}
                  <td style={{ ...tdTextStyle, background: '#F5F9FF', fontFamily: 'monospace', fontSize: '12px' }}>{row.g1_inv || '—'}</td>
                  {['g1_taxable','g1_igst','g1_cgst','g1_sgst'].map((k, j) => (
                    <td key={k} style={{ ...tdStyle, background: '#F5F9FF', borderRight: j === 3 ? '2px solid #E2E8F0' : undefined }}>{fmt(row[k])}</td>
                  ))}
                  {/* Diff */}
                  {['diff_taxable','diff_igst','diff_cgst','diff_sgst'].map(k => (
                    <td key={k} style={{ ...tdStyle, background: '#FFFAF5' }}><DiffCell v={row[k]} /></td>
                  ))}
                  <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                    <RemarkBadge remark={row.remark} />
                  </td>
                </tr>
              );
            })}
            {paged.length === 0 && (
              <tr><td colSpan={14} style={{ padding: '24px', textAlign: 'center', color: '#94A3B8', fontSize: '13px' }}>No records match this filter</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
          <span style={{ fontSize: '12px', color: '#64748B' }}>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid #E2E8F0', background: '#F8FAFC', cursor: page === 0 ? 'not-allowed' : 'pointer', opacity: page === 0 ? 0.4 : 1 }}>
            <ChevronLeft style={{ width: '14px', color: '#64748B' }} />
          </button>
          {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
            const pg = totalPages <= 7 ? i : (page < 4 ? i : page > totalPages - 5 ? totalPages - 7 + i : page - 3 + i);
            return (
              <button key={pg} onClick={() => setPage(pg)}
                style={{ width: '28px', height: '28px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', border: `1px solid ${pg === page ? '#0748EE' : '#E2E8F0'}`, background: pg === page ? '#0748EE' : '#F8FAFC', color: pg === page ? '#fff' : '#64748B' }}>
                {pg + 1}
              </button>
            );
          })}
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
            style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid #E2E8F0', background: '#F8FAFC', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1 }}>
            <ChevronRight style={{ width: '14px', color: '#64748B' }} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── B2C Reco table ───────────────────────────────────────────────────────────
function B2cRecoTab({ rows }) {
  const thStyle = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 10px', textAlign: 'right', color: '#fff', whiteSpace: 'nowrap' };
  const tdAmt   = { fontSize: '12px', padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace', whiteSpace: 'nowrap', color: '#334155' };
  const tdText  = { fontSize: '12px', padding: '6px 10px', textAlign: 'left', color: '#334155', whiteSpace: 'nowrap' };

  return (
    <div style={{ overflowX: 'auto', borderRadius: '8px', border: '1px solid #E2E8F0' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
        <thead>
          <tr>
            <th colSpan={2} style={{ ...thStyle, textAlign: 'left', background: '#1F3864' }}>Classification</th>
            <th colSpan={4} style={{ ...thStyle, background: '#2E75B6' }}>GSTR-1</th>
            <th colSpan={4} style={{ ...thStyle, background: '#375623' }}>As per Books</th>
            <th colSpan={4} style={{ ...thStyle, background: '#C45911' }}>Difference (GSTR-1 − Books)</th>
          </tr>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left', background: '#1F3864', borderRight: '1px solid #374E8A' }}>State</th>
            <th style={{ ...thStyle, textAlign: 'right', background: '#1F3864', borderRight: '2px solid #E2E8F0' }}>Rate %</th>
            {['Taxable','IGST','CGST','SGST'].map(h => <th key={h} style={{ ...thStyle, background: '#2E75B6' }}>{h}</th>)}
            {['Taxable','IGST','CGST','SGST'].map(h => <th key={h} style={{ ...thStyle, background: '#375623' }}>{h}</th>)}
            {['Taxable','IGST','CGST','SGST'].map(h => <th key={h} style={{ ...thStyle, background: '#C45911' }}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #F1F5F9', background: i % 2 === 1 ? '#FAFBFF' : undefined }}>
              <td style={tdText}>{row.state}</td>
              <td style={{ ...tdAmt, borderRight: '2px solid #E2E8F0' }}>{row.rate}%</td>
              {['gstr1_taxable','gstr1_igst','gstr1_cgst','gstr1_sgst'].map(k => <td key={k} style={tdAmt}>{fmt(row[k])}</td>)}
              {['books_taxable','books_igst','books_cgst','books_sgst'].map(k => <td key={k} style={tdAmt}>{fmt(row[k])}</td>)}
              {['diff_taxable','diff_igst','diff_cgst','diff_sgst'].map(k => <td key={k} style={tdAmt}><DiffCell v={row[k]} /></td>)}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={14} style={{ padding: '24px', textAlign: 'center', color: '#94A3B8', fontSize: '13px' }}>No B2C data</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── State-wise summary ───────────────────────────────────────────────────────
function StateWiseTab({ b2cRows }) {
  const stateAgg = useMemo(() => {
    const m = {};
    for (const r of b2cRows) {
      const st = r.state || 'Unknown';
      if (!m[st]) m[st] = { state: st, g1_taxable: 0, g1_igst: 0, g1_cgst: 0, g1_sgst: 0, bk_taxable: 0, bk_igst: 0, bk_cgst: 0, bk_sgst: 0, d_taxable: 0, d_igst: 0, d_cgst: 0, d_sgst: 0 };
      m[st].g1_taxable += (r.gstr1_taxable || 0); m[st].g1_igst += (r.gstr1_igst || 0); m[st].g1_cgst += (r.gstr1_cgst || 0); m[st].g1_sgst += (r.gstr1_sgst || 0);
      m[st].bk_taxable += (r.books_taxable || 0); m[st].bk_igst += (r.books_igst || 0); m[st].bk_cgst += (r.books_cgst || 0); m[st].bk_sgst += (r.books_sgst || 0);
      m[st].d_taxable  += (r.diff_taxable  || 0); m[st].d_igst  += (r.diff_igst   || 0); m[st].d_cgst  += (r.diff_cgst  || 0); m[st].d_sgst  += (r.diff_sgst  || 0);
    }
    return Object.values(m).sort((a, b) => b.g1_taxable - a.g1_taxable);
  }, [b2cRows]);

  const thStyle = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '8px 10px', textAlign: 'right', color: '#fff', whiteSpace: 'nowrap' };
  const tdAmt   = { fontSize: '12px', padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace', whiteSpace: 'nowrap', color: '#334155' };

  return (
    <div style={{ overflowX: 'auto', borderRadius: '8px', border: '1px solid #E2E8F0' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '750px' }}>
        <thead>
          <tr>
            <th rowSpan={2} style={{ ...thStyle, textAlign: 'left', background: '#1F3864', borderRight: '2px solid #E2E8F0' }}>State</th>
            <th colSpan={4} style={{ ...thStyle, background: '#2E75B6' }}>GSTR-1</th>
            <th colSpan={4} style={{ ...thStyle, background: '#375623' }}>As per Books</th>
            <th colSpan={4} style={{ ...thStyle, background: '#C45911' }}>Difference</th>
          </tr>
          <tr>
            {['Taxable','IGST','CGST','SGST'].map(h => <th key={`g1${h}`} style={{ ...thStyle, background: '#2E75B6' }}>{h}</th>)}
            {['Taxable','IGST','CGST','SGST'].map(h => <th key={`bk${h}`} style={{ ...thStyle, background: '#375623' }}>{h}</th>)}
            {['Taxable','IGST','CGST','SGST'].map(h => <th key={`d${h}`} style={{ ...thStyle, background: '#C45911' }}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {stateAgg.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #F1F5F9', background: i % 2 === 1 ? '#FAFBFF' : undefined }}>
              <td style={{ fontSize: '12px', padding: '6px 10px', fontWeight: 500, color: '#1F3864', borderRight: '2px solid #E2E8F0' }}>{row.state}</td>
              {['g1_taxable','g1_igst','g1_cgst','g1_sgst'].map(k => <td key={k} style={tdAmt}>{fmt(row[k])}</td>)}
              {['bk_taxable','bk_igst','bk_cgst','bk_sgst'].map(k => <td key={k} style={tdAmt}>{fmt(row[k])}</td>)}
              {['d_taxable','d_igst','d_cgst','d_sgst'].map(k => <td key={k} style={tdAmt}><DiffCell v={row[k]} /></td>)}
            </tr>
          ))}
          {stateAgg.length === 0 && (
            <tr><td colSpan={13} style={{ padding: '24px', textAlign: 'center', color: '#94A3B8', fontSize: '13px' }}>No state data</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────
export default function Gstr1Dashboard({ result }) {
  const [activeTab, setActiveTab] = useState('gst_reco');

  const sections    = result?.gst_reco_sections || {};
  const b2bRows     = result?.b2b_ui_rows || [];
  const b2cRows     = result?.b2c_rows    || [];
  const counts      = result?.counts      || {};
  const summary     = result?.summary     || {};

  const remarkCounts = useMemo(() => {
    const c = {};
    for (const r of b2bRows) c[r.remark] = (c[r.remark] || 0) + 1;
    return c;
  }, [b2bRows]);

  const TABS = [
    { key: 'gst_reco',   label: 'GST Reco',                count: null },
    { key: 'b2b_reco',   label: 'B2B Reco',                count: counts.b2b_reco_rows },
    { key: 'b2c_reco',   label: 'B2C Reco',                count: counts.b2c_reco_rows },
    { key: 'state_wise', label: 'State-wise',              count: null },
  ];

  const statCards = [
    { label: 'Match',           count: remarkCounts['Match'] || 0,             bg: '#C6EFCE', color: '#276221', border: '#A7D7A4' },
    { label: 'Diff',            count: remarkCounts['Diff'] || 0,              bg: '#FFEB9C', color: '#9C5700', border: '#FFD700' },
    { label: 'Not in GSTR-1',   count: remarkCounts['Not in GSTR-1'] || 0,    bg: '#FFC7CE', color: '#9C0006', border: '#FF8080' },
    { label: 'Not in Books',    count: remarkCounts['Not in Books'] || 0,      bg: '#FFC7CE', color: '#9C0006', border: '#FF8080' },
    { label: 'Amazon (Tally)',  count: remarkCounts['Amazon Entry As per Tally'] || 0,  bg: '#DDEBF7', color: '#1F4E79', border: '#9DC3E6' },
    { label: 'Amazon (GSTR-1)', count: remarkCounts['Amazon Entry as per GSTR-1'] || 0, bg: '#E2EFDA', color: '#375623', border: '#9DC3A5' },
  ];

  return (
    <div style={{ marginTop: '8px' }}>
      {/* Summary stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '20px' }}>
        {statCards.filter(c => c.count > 0).map(c => (
          <div key={c.label} style={{ background: c.bg, border: `1.5px solid ${c.border}`, borderRadius: '10px', padding: '12px 14px' }}>
            <div style={{ fontSize: '22px', fontWeight: 900, color: c.color, fontFamily: 'Barlow, sans-serif', lineHeight: 1.1 }}>{c.count.toLocaleString('en-IN')}</div>
            <div style={{ fontSize: '11px', fontWeight: 700, color: c.color, marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '4px', borderBottom: '2px solid #E2E8F0', marginBottom: '16px', overflowX: 'auto', paddingBottom: '0' }}>
        {TABS.map(tab => {
          const active = activeTab === tab.key;
          return (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              style={{
                padding: '8px 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', border: 'none', outline: 'none',
                borderBottom: active ? '3px solid #0748EE' : '3px solid transparent',
                background: 'transparent', color: active ? '#0748EE' : '#64748B',
                marginBottom: '-2px', whiteSpace: 'nowrap', transition: 'all 0.15s',
              }}>
              {tab.label}{tab.count != null ? ` (${tab.count.toLocaleString('en-IN')})` : ''}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === 'gst_reco' && (
        <div>
          {Object.keys(SECTION_META).map(key => (
            sections[key]?.length > 0
              ? <GstRecoSection key={key} sectionKey={key} rows={sections[key]} />
              : <div key={key} style={{ color: '#94A3B8', fontSize: '12px', marginBottom: '16px' }}>No data for {SECTION_META[key].title}</div>
          ))}
        </div>
      )}

      {activeTab === 'b2b_reco' && <B2bRecoTab rows={b2bRows} />}
      {activeTab === 'b2c_reco' && <B2cRecoTab rows={b2cRows} />}
      {activeTab === 'state_wise' && <StateWiseTab b2cRows={b2cRows} />}
    </div>
  );
}

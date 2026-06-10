import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import {
  ArrowLeft, Download, CheckCircle2, AlertTriangle, HelpCircle,
  BarChart3, Loader2, TrendingUp, LayoutDashboard, Bot, Map,
} from 'lucide-react';
import api from '../../lib/api';
import { toast } from 'sonner';

const AGENT_META = {
  bank_reco:                  { label: 'Bank Statement Classifier',           color: '#E11D48' },
  universal_bank_statement:   { label: 'Universal Bank Statement',            color: '#E11D48' },
  bank_statement:             { label: 'Bank Statement Classifier',           color: '#E11D48' },
  gstr_2b_books:              { label: 'GSTR-2B vs Books',                    color: '#0748EE' },
  gstr_2a_vs_2b_vs_books:     { label: 'GSTR-2A vs 2B vs Books',             color: '#F115F8' },
  gstr_2b_vs_purchase:        { label: 'GSTR-2B vs Purchase',                 color: '#0748EE' },
  gstr_2a_2b_books:           { label: 'GSTR-2A + 2B vs Books',              color: '#F115F8' },
  gstr_3b_vs_2b:              { label: 'GSTR-3B vs 2B',                       color: '#059669' },
  gstr_1_vs_books:            { label: 'GSTR-1 vs Books',                     color: '#D97706' },
  gstr_2b_books_multistate:   { label: 'GSTR-2B vs Books (Multi-State)',      color: '#7C3AED' },
  gstr_3b_tally_entry:        { label: 'GSTR-3B Tally Entry',                 color: '#0F766E' },
};

const GST_STATE_CODES = {
  '01':'J&K','02':'H.P.','03':'Punjab','04':'Chandigarh','05':'Uttarakhand',
  '06':'Haryana','07':'Delhi','08':'Rajasthan','09':'U.P.','10':'Bihar',
  '11':'Sikkim','12':'Arunachal','13':'Nagaland','14':'Manipur','15':'Mizoram',
  '16':'Tripura','17':'Meghalaya','18':'Assam','19':'W.Bengal','20':'Jharkhand',
  '21':'Odisha','22':'C.G.','23':'M.P.','24':'Gujarat','25':'D&NH',
  '26':'Goa','27':'Maharashtra','28':'A.P.','29':'Karnataka','30':'Goa(U)',
  '31':'Lakshadweep','32':'Kerala','33':'Tamil Nadu','34':'Puducherry',
  '35':'A&N Islands','36':'Telangana','37':'A.P.(New)','38':'Ladakh',
};

const stateFromGstin = (gstin) => {
  const code = (gstin || '').slice(0, 2);
  return GST_STATE_CODES[code] || (code ? `State ${code}` : 'Unknown');
};

const MONTHS = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const CONFIDENCE_COLORS = {
  High: '#059669', Medium: '#D97706', Low: '#E11D48', Unknown: '#94A3B8',
};

const REMARK_COLORS = {
  'Matched': '#059669',
  'Showing in 2B but Not in Books': '#D97706',
  'Showing in Books but Not in 2B': '#E11D48',
};

const cardStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--card-border)',
  borderRadius: '1rem',
};

const fmt = (n) =>
  n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const ConfidenceBadge = ({ value }) => {
  const color = CONFIDENCE_COLORS[value] ?? CONFIDENCE_COLORS.Unknown;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
      style={{ background: `${color}18`, color, border: `1px solid ${color}40` }}
    >
      {value ?? 'Unknown'}
    </span>
  );
};

const RemarkBadge = ({ value }) => {
  const color = REMARK_COLORS[value] ?? '#64748B';
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap"
      style={{ background: `${color}18`, color, border: `1px solid ${color}40` }}
    >
      {value ?? '—'}
    </span>
  );
};

const StatCard = ({ label, value, icon: Icon, color }) => (
  <div className="p-5" style={cardStyle}>
    <div className="flex items-center justify-between mb-3">
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center"
        style={{ background: `${color}18`, border: `1px solid ${color}30` }}
      >
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <span
        className="text-2xl font-black"
        style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}
      >
        {value}
      </span>
    </div>
    <p className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>{label}</p>
  </div>
);

const FILTER_TABS_BANK = ['All', 'High', 'Medium', 'Low', 'Unknown'];
const FILTER_TABS_GST  = ['All', 'Matched', '2B not in Books', 'Books not in 2B'];

const RecoJobDashboard = () => {
  const { brandId, agentType, jobId } = useParams();
  const navigate = useNavigate();

  const [job, setJob] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [filter, setFilter] = useState('All');
  const [downloading, setDownloading] = useState(false);

  // Prefer the DB-stored agent_type (available after load), fall back to URL param
  const resolvedType = job?.agent_type || agentType;
  const meta = AGENT_META[resolvedType] ?? AGENT_META[agentType] ?? { label: agentType, color: '#64748B' };

  const sidebarItems = [
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard',  icon: LayoutDashboard },
    { path: `/brands/${brandId}/agents`,    label: 'All Agents', icon: Bot },
  ];

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await api.get(`/api/dashboard/reco/job/${jobId}?brandId=${brandId}`);
        if (res.data.job) {
          setJob(res.data.job);
          setRows(res.data.rows ?? []);
        } else {
          setLoadError('job_not_found');
        }
      } catch (err) {
        const isNetworkDown = !err.response;
        setLoadError(isNetworkDown ? 'server_down' : 'fetch_error');
        toast.error(isNetworkDown
          ? 'Cannot reach server — please check the backend is running'
          : (err.response?.data?.error ?? 'Failed to load job data'));
      } finally {
        setLoading(false);
      }
    };
    fetch();
  }, [jobId, brandId]);

  const handleDownload = async () => {
    if (!job?.output_file_id) return;
    setDownloading(true);
    try {
      const res = await api.get(`/api/reco/export/${job.output_file_id}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${agentType}_${job.output_file_id}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success('Excel downloaded!');
    } catch {
      toast.error('Download failed');
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin" style={{ color: meta.color }} />
        </div>
      </DashboardLayout>
    );
  }

  if (!job) {
    const errMsg = loadError === 'server_down'
      ? 'Backend server is not running — start it and refresh'
      : loadError === 'fetch_error'
      ? 'Failed to load job data — please refresh'
      : 'This job no longer exists';
    return (
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <HelpCircle className="w-10 h-10" style={{ color: '#94A3B8' }} />
          <p className="text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>{errMsg}</p>
          <button
            onClick={() => navigate(`/brands/${brandId}/reco`)}
            className="text-xs font-semibold px-4 py-2 rounded-xl"
            style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
          >
            Back to Reco Suite
          </button>
        </div>
      </DashboardLayout>
    );
  }

  const isBankReco    = job.agent_type === 'bank_reco';
  const isGst3b       = job.agent_type === 'gstr_3b_vs_2b';
  const isMultistate  = job.agent_type === 'gstr_2b_books_multistate';
  const isTallyEntry  = job.agent_type === 'gstr_3b_tally_entry';

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6 max-w-7xl space-y-6">

        {/* Back button */}
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-sm group transition-colors"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
          Back
        </button>

        {/* Page header */}
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center"
              style={{ background: `${meta.color}15`, border: `1px solid ${meta.color}30` }}
            >
              {isMultistate
                ? <Map className="w-5 h-5" style={{ color: meta.color }} />
                : <BarChart3 className="w-5 h-5" style={{ color: meta.color }} />}
            </div>
            <div>
              <h1
                className="text-xl font-black"
                style={{ color: 'var(--text-heading)', fontFamily: 'Barlow', letterSpacing: '-0.02em' }}
              >
                {meta.label}
              </h1>
              <div className="flex items-center gap-3 mt-0.5">
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {MONTHS[job.month]} {job.year}
                </span>
                <span
                  className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: '#DCFCE7', color: '#059669', border: '1px solid #A7F3D0' }}
                >
                  <CheckCircle2 className="w-3 h-3" />
                  Completed
                </span>
              </div>
            </div>
          </div>

          {job.output_file_id && (
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="flex items-center gap-2 text-sm font-semibold px-4 py-2 rounded-xl transition-all disabled:opacity-50"
              style={{ background: 'var(--surface)', border: '1px solid var(--card-border)', color: 'var(--text-heading)' }}
            >
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Download Excel
            </button>
          )}
        </div>

        {/* ── BANK RECO VIEW ── */}
        {isBankReco && <BankRecoView rows={rows} filter={filter} setFilter={setFilter} />}

        {/* ── GST 3B VIEW ── */}
        {isGst3b && <Gst3bView rows={rows} />}

        {/* ── MULTI-STATE VIEW ── */}
        {isMultistate && <GstMultistateView rows={rows} filter={filter} setFilter={setFilter} meta={meta} />}

        {/* ── TALLY ENTRY VIEW ── */}
        {isTallyEntry && <TallyEntryView rows={rows} meta={meta} />}

        {/* ── GST INVOICE VIEW ── */}
        {!isBankReco && !isGst3b && !isMultistate && !isTallyEntry && (
          <GstInvoiceView rows={rows} filter={filter} setFilter={setFilter} meta={meta} />
        )}
      </div>
    </DashboardLayout>
  );
};

/* ── Bank Reco sub-view ─────────────────────────────────────────────────────── */
const BankRecoView = ({ rows, filter, setFilter }) => {
  const high    = rows.filter(r => r.confidence === 'High').length;
  const medium  = rows.filter(r => r.confidence === 'Medium').length;
  const unknown = rows.filter(r => r.confidence !== 'High' && r.confidence !== 'Medium').length;

  const confidenceData = Object.entries(
    rows.reduce((acc, r) => {
      const k = r.confidence ?? 'Unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {})
  ).map(([name, value]) => ({ name, value }));

  const ledgerData = Object.entries(
    rows.reduce((acc, r) => {
      if (!r.ledger_name) return acc;
      acc[r.ledger_name] = (acc[r.ledger_name] || 0) + 1;
      return acc;
    }, {})
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({
      name: name.length > 22 ? name.slice(0, 20) + '…' : name,
      fullName: name,
      count,
    }));

  const filtered = filter === 'All'
    ? rows
    : rows.filter(r => (r.confidence ?? 'Unknown') === filter);

  return (
    <>
      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Records"    value={rows.length} icon={TrendingUp}    color="#0748EE" />
        <StatCard label="High Confidence"  value={high}        icon={CheckCircle2}  color="#059669" />
        <StatCard label="Medium"           value={medium}      icon={AlertTriangle} color="#D97706" />
        <StatCard label="Unknown / Low"    value={unknown}     icon={HelpCircle}    color="#94A3B8" />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-5" style={cardStyle}>
          <p className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: 'var(--text-muted)' }}>
            Confidence Distribution
          </p>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={confidenceData} dataKey="value" innerRadius={55} outerRadius={80} paddingAngle={3}>
                {confidenceData.map((entry) => (
                  <Cell key={entry.name} fill={CONFIDENCE_COLORS[entry.name] ?? '#94A3B8'} />
                ))}
              </Pie>
              <Tooltip formatter={(v) => [v, 'Transactions']} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="p-5" style={cardStyle}>
          <p className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: 'var(--text-muted)' }}>
            Top Ledger Categories
          </p>
          <ResponsiveContainer width="100%" height={Math.max(220, ledgerData.length * 34)}>
            <BarChart data={ledgerData} layout="vertical" margin={{ left: 4, right: 24, top: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--card-border)" />
              <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
              <YAxis
                type="category"
                dataKey="name"
                width={155}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip formatter={(v, _n, p) => [v, p.payload.fullName || p.payload.name]} />
              <Bar dataKey="count" fill="#0748EE" radius={[0, 4, 4, 0]} barSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {FILTER_TABS_BANK.map(tab => {
          const active = filter === tab;
          const color  = CONFIDENCE_COLORS[tab] ?? '#64748B';
          return (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className="text-xs font-semibold px-3 py-1.5 rounded-full transition-all"
              style={{
                background: active ? `${color}18` : 'var(--surface)',
                border: `1.5px solid ${active ? color : 'var(--card-border)'}`,
                color: active ? color : 'var(--text-muted)',
              }}
            >
              {tab}
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div style={{ ...cardStyle, overflow: 'hidden' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                {['TXN DATE','DESCRIPTION','DEBIT','CREDIT','BALANCE','LEDGER','CONFIDENCE'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider whitespace-nowrap"
                    style={{ color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 500).map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--card-border)' }}
                  className="transition-colors hover:opacity-80">
                  <td className="px-4 py-3 whitespace-nowrap font-mono text-xs" style={{ color: 'var(--text-heading)' }}>
                    {row.txn_date ?? '—'}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--text-heading)', maxWidth: 280 }}>
                    <span className="block truncate" style={{ maxWidth: 260 }}>
                      {row.description?.slice(0, 60) ?? '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-right" style={{ color: '#E11D48' }}>
                    {row.debit ? fmt(row.debit) : '—'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-right" style={{ color: '#059669' }}>
                    {row.credit ? fmt(row.credit) : '—'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-right" style={{ color: 'var(--text-heading)' }}>
                    {fmt(row.balance)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs" style={{ color: 'var(--text-heading)' }}>
                    {row.ledger_name ?? '—'}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <ConfidenceBadge value={row.confidence} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 500 && (
            <p className="text-xs text-center py-3" style={{ color: 'var(--text-muted)' }}>
              Showing 500 of {filtered.length} records — download Excel for full data
            </p>
          )}
          {filtered.length === 0 && (
            <div className="py-12 text-center">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No records match this filter</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

/* ── GST Invoice sub-view (2B, 2A+2B, 1 vs Books) ──────────────────────────── */
const GstInvoiceView = ({ rows, filter, setFilter, meta }) => {
  const matched = rows.filter(r => r.remark_1 === 'Matched').length;
  const issues  = rows.length - matched;

  const remarkData = Object.entries(
    rows.reduce((acc, r) => {
      const k = r.remark_1 ?? 'Unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {})
  ).map(([name, value]) => ({ name, value }));

  const supplierData = Object.entries(
    rows.reduce((acc, r) => {
      const k = r.supplier_name ?? r.customer_name ?? 'Unknown';
      acc[k] = (acc[k] || 0) + Number(r.taxable_value || 0);
      return acc;
    }, {})
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, value]) => ({
      name: name.length > 22 ? name.slice(0, 20) + '…' : name,
      fullName: name,
      value: Math.round(value),
    }));

  const filterMap = {
    'All': () => true,
    'Matched': r => r.remark_1 === 'Matched',
    '2B not in Books': r => r.remark_1 === 'Showing in 2B but Not in Books',
    'Books not in 2B': r => r.remark_1 === 'Showing in Books but Not in 2B',
  };

  const filtered = rows.filter(filterMap[filter] ?? (() => true));

  const remarkColor = (v) => REMARK_COLORS[v] ?? '#64748B';

  return (
    <>
      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total Rows" value={rows.length}  icon={TrendingUp}    color={meta.color} />
        <StatCard label="Matched"    value={matched}       icon={CheckCircle2}  color="#059669"    />
        <StatCard label="Issues"     value={issues}        icon={AlertTriangle} color="#E11D48"    />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-5" style={cardStyle}>
          <p className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: 'var(--text-muted)' }}>
            Remark Distribution
          </p>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={remarkData} dataKey="value" innerRadius={55} outerRadius={80} paddingAngle={3}>
                {remarkData.map((entry) => (
                  <Cell key={entry.name} fill={remarkColor(entry.name)} />
                ))}
              </Pie>
              <Tooltip formatter={(v) => [v, 'Invoices']} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="p-5" style={cardStyle}>
          <p className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: 'var(--text-muted)' }}>
            Top Suppliers by Taxable Value
          </p>
          <ResponsiveContainer width="100%" height={Math.max(220, supplierData.length * 34)}>
            <BarChart data={supplierData} layout="vertical" margin={{ left: 4, right: 24, top: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--card-border)" />
              <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
              <YAxis
                type="category"
                dataKey="name"
                width={155}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip formatter={(v, _n, p) => [`₹${v.toLocaleString('en-IN')}`, p.payload.fullName || p.payload.name]} />
              <Bar dataKey="value" fill={meta.color} radius={[0, 4, 4, 0]} barSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {FILTER_TABS_GST.map(tab => {
          const active = filter === tab;
          const color = tab === 'Matched' ? '#059669' : tab === '2B not in Books' ? '#D97706' : tab === 'Books not in 2B' ? '#E11D48' : meta.color;
          return (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className="text-xs font-semibold px-3 py-1.5 rounded-full transition-all"
              style={{
                background: active ? `${color}18` : 'var(--surface)',
                border: `1.5px solid ${active ? color : 'var(--card-border)'}`,
                color: active ? color : 'var(--text-muted)',
              }}
            >
              {tab}
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div style={{ ...cardStyle, overflow: 'hidden' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                {['SUPPLIER','GSTIN','INVOICE #','DATE','TAXABLE VALUE','IGST','CGST','SGST','REMARK 1','REMARK 2'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider whitespace-nowrap"
                    style={{ color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 500).map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--card-border)' }}
                  className="transition-colors hover:opacity-80">
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-heading)', maxWidth: 180 }}>
                    <span className="block truncate" style={{ maxWidth: 160 }}>
                      {row.supplier_name ?? row.customer_name ?? '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                    {row.supplier_gstin ?? '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                    {row.invoice_number ?? '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                    {row.invoice_date ?? '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-right whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                    {fmt(row.taxable_value)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-right whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                    {fmt(row.igst)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-right whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                    {fmt(row.cgst)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-right whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                    {fmt(row.sgst)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <RemarkBadge value={row.remark_1} />
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)', maxWidth: 200 }}>
                    <span className="block truncate" style={{ maxWidth: 180 }}>
                      {row.remark_2 ?? '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 500 && (
            <p className="text-xs text-center py-3" style={{ color: 'var(--text-muted)' }}>
              Showing 500 of {filtered.length} records — download Excel for full data
            </p>
          )}
          {filtered.length === 0 && (
            <div className="py-12 text-center">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No records match this filter</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

/* ── GSTR-3B vs 2B sub-view ─────────────────────────────────────────────────── */
const Gst3bView = ({ rows }) => (
  <div style={{ ...cardStyle, overflow: 'hidden' }}>
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
            {['ITC TYPE','CLAIMED','AVAILABLE','DIFFERENCE','REMARK'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider whitespace-nowrap"
                style={{ color: 'var(--text-muted)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const diff = Number(row.difference ?? 0);
            const diffColor = diff > 0 ? '#059669' : diff < 0 ? '#E11D48' : 'var(--text-heading)';
            return (
              <tr key={i} style={{ borderBottom: '1px solid var(--card-border)' }}
                className="transition-colors hover:opacity-80">
                <td className="px-4 py-3 text-xs font-semibold" style={{ color: 'var(--text-heading)' }}>
                  {row.itc_type ?? '—'}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-right" style={{ color: 'var(--text-heading)' }}>
                  {fmt(row.claimed_value)}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-right" style={{ color: 'var(--text-heading)' }}>
                  {fmt(row.available_value)}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-right font-bold" style={{ color: diffColor }}>
                  {diff !== 0 ? (diff > 0 ? '+' : '') + fmt(diff) : '—'}
                </td>
                <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {row.remark ?? '—'}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                No data available
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  </div>
);

/* ── GSTR-2B vs Books Multi-State sub-view ─────────────────────────────────── */
const GstMultistateView = ({ rows, filter, setFilter, meta }) => {
  const matched  = rows.filter(r => r.remark_1 === 'Matched').length;
  const issues   = rows.length - matched;

  // Group rows by state derived from supplier_gstin
  const stateMap = rows.reduce((acc, r) => {
    const state = stateFromGstin(r.supplier_gstin);
    if (!acc[state]) acc[state] = { state, total: 0, matched: 0, issues: 0 };
    acc[state].total++;
    if (r.remark_1 === 'Matched') acc[state].matched++;
    else acc[state].issues++;
    return acc;
  }, {});

  const stateData = Object.values(stateMap).sort((a, b) => b.total - a.total);

  const remarkData = Object.entries(
    rows.reduce((acc, r) => {
      const k = r.remark_1 ?? 'Unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {})
  ).map(([name, value]) => ({ name, value }));

  const COLORS = ['#7C3AED', '#059669', '#E11D48', '#D97706', '#0748EE', '#F115F8'];
  const remarkColor = (v) => REMARK_COLORS[v] ?? '#64748B';

  const filterMap = {
    'All': () => true,
    'Matched': r => r.remark_1 === 'Matched',
    '2B not in Books': r => r.remark_1 === 'Showing in 2B but Not in Books',
    'Books not in 2B': r => r.remark_1 === 'Showing in Books but Not in 2B',
  };
  const filtered = rows.filter(filterMap[filter] ?? (() => true));

  return (
    <>
      {/* Summary stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Rows"    value={rows.length}      icon={TrendingUp}    color={meta.color} />
        <StatCard label="Matched"       value={matched}           icon={CheckCircle2}  color="#059669"    />
        <StatCard label="Issues"        value={issues}            icon={AlertTriangle} color="#E11D48"    />
        <StatCard label="States"        value={stateData.length}  icon={Map}           color="#7C3AED"    />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* State-wise breakdown bar chart */}
        <div className="p-5" style={cardStyle}>
          <p className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: 'var(--text-muted)' }}>
            State-wise Breakdown
          </p>
          <ResponsiveContainer width="100%" height={Math.max(220, stateData.length * 44)}>
            <BarChart data={stateData} layout="vertical" margin={{ left: 4, right: 24, top: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--card-border)" />
              <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
              <YAxis
                type="category" dataKey="state" width={90}
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false}
              />
              <Tooltip
                formatter={(v, name) => [v, name === 'matched' ? 'Matched' : 'Issues']}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--card-border)', borderRadius: 8, fontSize: 11 }}
              />
              <Bar dataKey="matched" stackId="a" fill="#059669" radius={[0, 0, 0, 0]} barSize={20} name="matched" />
              <Bar dataKey="issues"  stackId="a" fill="#E11D48" radius={[0, 4, 4, 0]} barSize={20} name="issues"  />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Remark distribution pie */}
        <div className="p-5" style={cardStyle}>
          <p className="text-xs font-bold uppercase tracking-wider mb-4" style={{ color: 'var(--text-muted)' }}>
            Remark Distribution
          </p>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={remarkData} dataKey="value" innerRadius={55} outerRadius={80} paddingAngle={3}>
                {remarkData.map((entry, i) => (
                  <Cell key={entry.name} fill={remarkColor(entry.name) || COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(v) => [v, 'Invoices']} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* State detail cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stateData.map((s, i) => (
          <div key={s.state} className="p-4 rounded-2xl" style={{ background: `${COLORS[i % COLORS.length]}0D`, border: `1px solid ${COLORS[i % COLORS.length]}30` }}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold" style={{ color: COLORS[i % COLORS.length] }}>{s.state}</span>
              <span className="text-lg font-black" style={{ color: 'var(--text-heading)', fontFamily: 'Barlow' }}>{s.total}</span>
            </div>
            <div className="flex gap-3 text-xs">
              <span style={{ color: '#059669' }}>✓ {s.matched}</span>
              {s.issues > 0 && <span style={{ color: '#E11D48' }}>✗ {s.issues}</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Remark 3 note */}
      <div className="flex items-start gap-3 px-4 py-3 rounded-xl"
        style={{ background: '#FFF7ED', border: '1.5px solid #FDBA74' }}>
        <span className="text-lg">🗺️</span>
        <div>
          <p className="text-sm font-bold" style={{ color: '#C2410C' }}>Cross-state Remark 3</p>
          <p className="text-xs mt-0.5" style={{ color: '#9A3412' }}>
            Cross-state booking errors flagged by Remark 3 are stored in the downloaded Excel (column W).
            Download the Excel to see which entries were booked under the wrong state.
          </p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {FILTER_TABS_GST.map(tab => {
          const active = filter === tab;
          const color = tab === 'Matched' ? '#059669' : tab === '2B not in Books' ? '#D97706' : tab === 'Books not in 2B' ? '#E11D48' : meta.color;
          return (
            <button key={tab} onClick={() => setFilter(tab)}
              className="text-xs font-semibold px-3 py-1.5 rounded-full transition-all"
              style={{
                background: active ? `${color}18` : 'var(--surface)',
                border: `1.5px solid ${active ? color : 'var(--card-border)'}`,
                color: active ? color : 'var(--text-muted)',
              }}>
              {tab}
            </button>
          );
        })}
      </div>

      {/* Table with State column */}
      <div style={{ ...cardStyle, overflow: 'hidden' }}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                {['STATE','SUPPLIER','GSTIN','INVOICE #','DATE','TAXABLE VALUE','IGST','REMARK 1','REMARK 2'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider whitespace-nowrap"
                    style={{ color: h === 'STATE' ? meta.color : 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 500).map((row, i) => {
                const state = stateFromGstin(row.supplier_gstin);
                const stateIdx = stateData.findIndex(s => s.state === state);
                const stateColor = COLORS[stateIdx >= 0 ? stateIdx % COLORS.length : 0];
                return (
                  <tr key={i} style={{ borderBottom: '1px solid var(--card-border)' }}
                    className="transition-colors hover:opacity-80">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold"
                        style={{ background: `${stateColor}12`, color: stateColor, border: `1px solid ${stateColor}30` }}>
                        {state}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-heading)', maxWidth: 160 }}>
                      <span className="block truncate" style={{ maxWidth: 150 }}>{row.supplier_name ?? '—'}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                      {row.supplier_gstin ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                      {row.invoice_number ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                      {row.invoice_date ?? '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-right whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                      {fmt(row.taxable_value)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-right whitespace-nowrap" style={{ color: 'var(--text-heading)' }}>
                      {fmt(row.igst)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <RemarkBadge value={row.remark_1} />
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-muted)', maxWidth: 200 }}>
                      <span className="block truncate" style={{ maxWidth: 180 }}>{row.remark_2 ?? '—'}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length > 500 && (
            <p className="text-xs text-center py-3" style={{ color: 'var(--text-muted)' }}>
              Showing 500 of {filtered.length} — download Excel for full data
            </p>
          )}
          {filtered.length === 0 && (
            <div className="py-12 text-center">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No records match this filter</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

/* ── GSTR-3B Tally Entry sub-view ──────────────────────────────────────────── */
const TallyEntryView = ({ rows, meta }) => {
  const dataRows    = rows.filter(r => r.row_type === 'data');
  const totalDebit  = dataRows.reduce((s, r) => s + Number(r.debit  || 0), 0);
  const totalCredit = dataRows.reduce((s, r) => s + Number(r.credit || 0), 0);

  return (
    <>
      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Journal Entries" value={dataRows.length} icon={TrendingUp}   color={meta.color} />
        <StatCard label="Total Debit (₹)" value={fmt(totalDebit)}  icon={CheckCircle2} color="#059669"    />
        <StatCard label="Total Credit (₹)"value={fmt(totalCredit)} icon={AlertTriangle}color="#0748EE"    />
      </div>

      {/* Journal table */}
      <div style={cardStyle}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--page-bg)', borderBottom: '1.5px solid var(--card-border)' }}>
                {['S.No', 'Particulars', 'Debit (₹)', 'Credit (₹)'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider whitespace-nowrap"
                    style={{ color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                    Re-run the agent to populate analytics
                  </td>
                </tr>
              ) : rows.map((row, i) => {
                if (row.row_type === 'blank') return null;
                if (row.row_type === 'header') return null;
                if (row.row_type === 'section') {
                  return (
                    <tr key={i} style={{ background: `${meta.color}10`, borderBottom: `1.5px solid ${meta.color}30` }}>
                      <td colSpan={4} className="px-4 py-2 text-xs font-bold uppercase tracking-wider"
                        style={{ color: meta.color }}>
                        {row.particulars}
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={i} className="transition-colors hover:opacity-80"
                    style={{ borderBottom: '1px solid var(--card-border)' }}>
                    <td className="px-4 py-3 text-xs font-semibold w-12" style={{ color: 'var(--text-muted)' }}>
                      {row.sno || ''}
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-heading)', minWidth: '260px' }}>
                      {row.particulars || '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-right" style={{ color: row.debit ? '#059669' : 'var(--text-muted)' }}>
                      {row.debit ? fmt(row.debit) : '—'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-right" style={{ color: row.credit ? '#0748EE' : 'var(--text-muted)' }}>
                      {row.credit ? fmt(row.credit) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

export default RecoJobDashboard;
